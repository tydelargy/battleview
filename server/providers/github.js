// GitHub and GitHub Enterprise, through the `gh` CLI. gh already knows how to log in to either, so there is no
// token handling here: `gh auth login` (add `--hostname ghe.example.com` for Enterprise) is the whole setup.
//
// The mapping from gh's JSON to the feed is pure (normalisePR) and tested with fixtures. The runner takes `exec`
// so tests can stand in for gh. Another host (GitLab, say) is another file here with the same `fetch` shape.
import { execFile } from 'node:child_process';

import { SKIP } from '../localrepo.js';
import { needsReason } from '../snapshot.js';

export class SyncError extends Error {}

export const FIELDS = ['number', 'title', 'headRefName', 'headRefOid', 'author', 'isDraft', 'reviewDecision', 'statusCheckRollup',
  'createdAt', 'updatedAt', 'url', 'files', 'reviewRequests', 'latestReviews', 'state', 'mergedAt', 'closedAt', 'baseRefName', 'mergeable', 'mergeStateStatus'];

const DETAIL_LIMIT = 100, CHUNK = 20;   // timelines are read twenty PRs to a request; cap how many so a huge repo cannot make a sync crawl
const FAILING_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED']);

/** 'failing' | 'pending' | 'passing' | 'none' from the checks and commit statuses on the head commit. Cancelled runs do not count as red. */
export function checksState(rollup) {
  let failing = false, pending = false, any = false;
  for (const c of Array.isArray(rollup) ? rollup : []) {
    any = true;
    if (c.__typename === 'StatusContext') {
      if (c.state === 'FAILURE' || c.state === 'ERROR') failing = true; else if (c.state === 'PENDING' || c.state === 'EXPECTED') pending = true;
    } else if (c.status && c.status !== 'COMPLETED') pending = true;
    else if (FAILING_CONCLUSIONS.has(c.conclusion)) failing = true;
  }
  return failing ? 'failing' : pending ? 'pending' : any ? 'passing' : 'none';
}

/**
 * One status for the map, in the order a reviewer would care:
 * ended, draft, red CI, changes requested, approved and green, re-review (someone who already reviewed is asked again), review.
 */
export function prStatus(raw) {
  if (raw.state === 'MERGED') return 'merged';
  if (raw.state === 'CLOSED') return 'closed';
  if (raw.isDraft) return 'draft';
  const checks = checksState(raw.statusCheckRollup);
  if (checks === 'failing') return 'ci_failing';
  if (raw.reviewDecision === 'CHANGES_REQUESTED') return 'changes_requested';
  if (raw.reviewDecision === 'APPROVED' && checks !== 'pending') return 'ready_to_merge';
  const reviewed = new Set((raw.latestReviews || []).map((r) => r.author?.login).filter(Boolean));
  if ((raw.reviewRequests || []).some((r) => r.login && reviewed.has(r.login))) return 're_review';   // teams have no login: ignored
  return 'review_requested';
}

const isBot = (login) => /\[bot\]$|-bot$/i.test(login || '');
const maxIso = (xs) => xs.reduce((a, b) => (a == null || b > a ? b : a), null);
const minIso = (xs) => xs.reduce((a, b) => (a == null || b < a ? b : a), null);

// ---- exact times from the GraphQL timeline ----
const TIMELINE_TYPES = 'REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, PULL_REQUEST_REVIEW, ISSUE_COMMENT, HEAD_REF_FORCE_PUSHED_EVENT, PULL_REQUEST_COMMIT';
const USER = 'requestedReviewer { __typename ... on User { login } }';
const NODE = `__typename
      ... on ReviewRequestedEvent { createdAt ${USER} }
      ... on ReviewRequestRemovedEvent { createdAt ${USER} }
      ... on PullRequestReview { createdAt submittedAt state author { login } }
      ... on IssueComment { createdAt author { login } }
      ... on HeadRefForcePushedEvent { createdAt }
      ... on PullRequestCommit { commit { committedDate } }`;
/** One query for many PRs: each is an alias (pr7) of the same selection. `numbers` are integers from gh, never user text. */
export const timelineQuery = (numbers) => `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
${numbers.filter(Number.isInteger).map((n) => `  pr${n}: pullRequest(number: ${n}) { timelineItems(last: 100, itemTypes: [${TIMELINE_TYPES}]) { nodes { ${NODE} } } }`).join('\n')}
} }`;

/**
 * Since when has this PR been waiting on us? Exact, from the PR's timeline, or null when the timeline cannot say.
 *   ours: the oldest review or comment from someone else (not a bot, not us, not an approval or a draft) that came in
 *         after our last push: the longest-unaddressed new comment. The last push is the latest force-push event or commit.
 *   someone else's PR in re-review: when we (or, if we are not the one, whoever was asked to look again) were re-requested:
 *         the time of that review request, so long as it was not withdrawn and has not been answered since.
 * Only the most recent 100 timeline events are read, which is plenty for "since when"; a longer history just yields null.
 */
export function waitingSinceFromTimeline(raw, nodes, { viewer = null, mine = false } = {}) {
  const of = (type) => (nodes || []).filter((n) => n && n.__typename === type);
  if (mine) {
    const lastPush = maxIso([...of('PullRequestCommit').map((n) => n.commit?.committedDate), ...of('HeadRefForcePushedEvent').map((n) => n.createdAt)].filter(Boolean));
    if (!lastPush) return null;
    const stranger = (n) => n.author?.login && n.author.login !== viewer && !isBot(n.author.login);
    const reviews = of('PullRequestReview').filter((n) => stranger(n) && ['COMMENTED', 'CHANGES_REQUESTED'].includes(n.state)).map((n) => n.submittedAt || n.createdAt);
    const comments = of('IssueComment').filter(stranger).map((n) => n.createdAt);
    return minIso([...reviews, ...comments].filter((t) => t && t > lastPush));
  }
  if (raw.state !== 'OPEN' || prStatus(raw) !== 're_review') return null;
  const reviewed = (login) => maxIso(of('PullRequestReview').filter((n) => n.author?.login === login && n.state !== 'PENDING').map((n) => n.submittedAt || n.createdAt));
  const lastAt = (type, login) => maxIso(of(type).filter((n) => n.requestedReviewer?.login === login).map((n) => n.createdAt));
  /** The time `login` was last asked to review, if that request is still waiting: not withdrawn, not answered since. */
  const pendingRequest = (login) => {
    const asked = lastAt('ReviewRequestedEvent', login);
    if (!asked) return null;
    const withdrawn = lastAt('ReviewRequestRemovedEvent', login), answered = reviewed(login);
    return (withdrawn && withdrawn > asked) || (answered && answered > asked) ? null : asked;
  };
  if (viewer) { const mineAsked = pendingRequest(viewer); if (mineAsked) return mineAsked; }
  // We were not the one asked: use the people who were (those who had reviewed and were asked again); the longest-waiting request
  const askedAgain = (raw.reviewRequests || []).map((r) => r.login).filter(Boolean).filter((l) => (raw.latestReviews || []).some((r) => r.author?.login === l));
  return minIso(askedAgain.map(pendingRequest).filter(Boolean));
}

/** gh's PR JSON to one feed entry. `viewer` is the logged-in user, so your own PRs are marked as yours. */
export function normalisePR(raw, { viewer = null, waitingSince = null } = {}) {
  const author = raw.author?.login || 'unknown';
  return {
    id: `#${raw.number}`, number: raw.number, title: raw.title || `#${raw.number}`, branch: raw.headRefName || '', author, url: raw.url || null,
    ...(raw.baseRefName ? { base: { ref: String(raw.baseRefName), mergeable: raw.mergeable || 'UNKNOWN', mergeState: raw.mergeStateStatus || 'UNKNOWN' } } : {}),   // what it targets, and whether GitHub can merge it as it stands
    status: prStatus(raw), createdAt: raw.createdAt || null, updatedAt: raw.updatedAt || null, headSha: raw.headRefOid || null, waitingSince,
    ...(viewer ? { mine: author.toLowerCase() === viewer.toLowerCase() } : {}),
    files: (raw.files || []).map((f) => ({ path: f.path, add: f.additions || 0, del: f.deletions || 0 })),
  };
}

const defaultExec = (cmd, args, { env } = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 512 * 1024 * 1024, timeout: 180_000 }, (err, stdout, stderr) => {
    if (!err) return resolve(stdout);
    if (err.code === 'ENOENT') return reject(new SyncError(`Could not run "${cmd}". Install the GitHub CLI (https://cli.github.com) or pass --gh with its path.`));
    const text = String(stderr || err.message).trim();
    reject(new SyncError(/auth|login|credentials|401/i.test(text) ? `${text}\nRun: gh auth login${env?.GH_HOST ? ` --hostname ${env.GH_HOST}` : ''}` : text));
  });
});

/** owner and name from "owner/name" or "host/owner/name"; with no --repo, from the checkout gh is run in. */
async function repoParts(repo, { exec, gh, env }) {
  let full = repo;
  if (!full) full = (await exec(gh, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { env })).trim();
  const parts = String(full).split('/').filter(Boolean);
  if (parts.length < 2) throw new SyncError(`cannot read owner and name from "${full}"`);
  return { owner: parts.at(-2), name: parts.at(-1) };
}

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Open PRs, plus (so the map can say "merged" instead of guessing) the ones that merged or closed in the last `endedDays` days.
 * Rejects if the open PRs cannot be fetched, so a cron job never replaces a good feed with a bad one. Trouble with the
 * extras or with finding out who you are only adds a warning.
 */
export async function fetchGithub({ repo = null, host = null, limit = 500, endedDays = 2, changes = true, gh = 'gh', exec = defaultExec, now = Date.now() } = {}) {
  const env = host ? { GH_HOST: host } : {};
  const warnings = [];
  const list = async (extra) => {
    const out = await exec(gh, ['pr', 'list', ...(repo ? ['--repo', repo] : []), '--limit', String(limit), '--json', FIELDS.join(','), ...extra], { env });
    let json; try { json = JSON.parse(out || '[]'); } catch { throw new SyncError('gh returned something that is not JSON'); }
    if (!Array.isArray(json)) throw new SyncError('gh returned an unexpected shape');
    return json;
  };

  let viewer = null;
  try { viewer = (await exec(gh, ['api', 'user', '--jq', '.login'], { env })).trim() || null; }
  catch (e) { warnings.push(`could not tell who you are (${e.message.split('\n')[0]}); "mine" falls back to your identity setting`); }

  const open = await list(['--state', 'open']);
  const ended = [];
  if (endedDays > 0) {
    const since = isoDay(now - endedDays * 86400_000);
    for (const [state, field] of [['merged', 'merged'], ['closed', 'closed']]) {
      try { ended.push(...await list(['--state', state, '--search', `${field}:>=${since}`])); }
      catch (e) { warnings.push(`could not list recently ${state} PRs (${e.message.split('\n')[0]}); they will show as "closed" when they leave`); }
    }
  }
  // "How long has it waited on us?" needs each candidate's timeline, which a list call cannot give. Only the PRs where it
  // matters get a second look (ours, and anyone's in re-review), and one GraphQL request covers twenty of them.
  const waiting = new Map();
  const candidates = open.filter((p) => (viewer && p.author?.login?.toLowerCase() === viewer.toLowerCase()) || prStatus(p) === 're_review');
  const looked = candidates.slice(0, DETAIL_LIMIT);
  if (candidates.length > looked.length) warnings.push(`looked at ${looked.length} of ${candidates.length} PRs for how long they have waited on you; the rest fall back to their last update`);
  if (looked.length) {
    let failed = 0;
    try {
      const { owner, name } = await repoParts(repo, { exec, gh, env });
      for (let i = 0; i < looked.length; i += CHUNK) {
        const chunk = looked.slice(i, i + CHUNK);
        try {
          const out = JSON.parse(await exec(gh, ['api', 'graphql', '-f', `query=${timelineQuery(chunk.map((p) => p.number))}`, '-F', `owner=${owner}`, '-F', `name=${name}`], { env }));
          const repoData = out?.data?.repository;
          if (!repoData) throw new SyncError('no repository in the answer');
          for (const p of chunk) {
            const nodes = repoData[`pr${p.number}`]?.timelineItems?.nodes;
            if (!nodes) { failed++; continue; }
            const mine = !!viewer && p.author?.login?.toLowerCase() === viewer.toLowerCase();
            const since = waitingSinceFromTimeline(p, nodes, { viewer, mine });
            if (since) waiting.set(p.number, since);
          }
        } catch { failed += chunk.length; }
      }
    } catch { failed = looked.length; }
    if (failed) warnings.push(`could not read the timeline of ${failed} PR${failed > 1 ? 's' : ''}; their "waiting since" falls back to the last update`);
  }
  const seen = new Set(open.map((p) => p.number));
  const prs = [...open, ...ended.filter((p) => !seen.has(p.number))].map((p) => normalisePR(p, { viewer, waitingSince: waiting.get(p.number) ?? null }));
  if (changes) { warnings.push(...await addFileChanges(prs, { repo, host, gh, exec }), ...await addBehind(prs, { repo, host, gh, exec }), ...await addSince(prs, { repo, host, gh, exec })); }
  return { prs, viewer, warnings, counts: { open: open.length, ended: prs.length - open.length } };
}


// ---- what happened to each file: added, removed, renamed (and from where) or changed ----
// `gh pr list --json files` only has paths and counts. GraphQL's changeType says added / deleted / renamed for twenty PRs
// a request; it cannot say what a renamed file was called, so only the PRs that rename something get one REST call.
const CHANGE_TYPES = { ADDED: 'added', COPIED: 'added', DELETED: 'removed', RENAMED: 'renamed', MODIFIED: 'modified', CHANGED: 'modified' };
export const changesQuery = (numbers) => `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
${numbers.filter(Number.isInteger).map((n) => `  pr${n}: pullRequest(number: ${n}) { files(first: 100) { nodes { path changeType } } }`).join('\n')}
} }`;
/** Map of PR number -> Map(path -> 'added' | 'removed' | 'renamed' | 'modified'), and the numbers that rename something. Pure. */
export function changesFromGraphql(data, numbers) {
  const out = new Map(), renamers = [];
  for (const n of numbers) {
    const nodes = data?.[`pr${n}`]?.files?.nodes; if (!Array.isArray(nodes)) continue;
    const m = new Map(); for (const f of nodes) if (f?.path) m.set(f.path, CHANGE_TYPES[f.changeType] || 'modified');
    out.set(n, m); if ([...m.values()].includes('renamed')) renamers.push(n);
  }
  return { out, renamers };
}
/** REST `pulls/N/files` lines (one JSON array per page) -> Map(new path -> previous path). Pure. */
export function previousNames(text) {
  const m = new Map();
  for (const line of String(text || '').split('\n').filter(Boolean)) { let a; try { a = JSON.parse(line); } catch { continue; } for (const f of Array.isArray(a) ? a : []) if (f?.filename && f.previous_filename) m.set(f.filename, f.previous_filename); }
  return m;
}
/** Add `change` (and `from`) to the files of these PRs. Trouble only costs detail, never the feed: it returns warnings. */
export async function addFileChanges(prs, { repo, host = null, gh = 'gh', exec = defaultExec, limit = DETAIL_LIMIT } = {}) {
  const warnings = [], env = host ? { GH_HOST: host } : {}, open = prs.filter((p) => p.files?.length && !['merged', 'closed'].includes(p.status));
  const looked = open.slice(0, limit); if (open.length > looked.length) warnings.push(`file changes (added, removed, moved) were read for ${looked.length} of ${open.length} PRs; the rest show every file as changed`);
  if (!looked.length) return warnings;
  let owner, name; try { ({ owner, name } = await repoParts(repo, { exec, gh, env })); } catch (e) { return [...warnings, `could not read file changes: ${e.message.split('\n')[0]}`]; }
  let failed = 0;
  for (let i = 0; i < looked.length; i += CHUNK) {
    const chunk = looked.slice(i, i + CHUNK), numbers = chunk.map((p) => p.number);
    try {
      const out = JSON.parse(await exec(gh, ['api', 'graphql', '-f', `query=${changesQuery(numbers)}`, '-F', `owner=${owner}`, '-F', `name=${name}`], { env }));
      const { out: byPr, renamers } = changesFromGraphql(out?.data?.repository, numbers);
      for (const p of chunk) { const m = byPr.get(p.number); if (m) for (const f of p.files) { const c = m.get(f.path); if (c) f.change = c; } }
      for (const n of renamers) {
        const p = chunk.find((x) => x.number === n);
        try { const prev = previousNames(await exec(gh, ['api', `repos/${owner}/${name}/pulls/${n}/files`, '--paginate', '--jq', '[.[] | {filename, previous_filename}]'], { env })); for (const f of p.files) if (f.change === 'renamed' && prev.get(f.path)) f.from = prev.get(f.path); }
        catch { failed++; }
      }
    } catch { failed += chunk.length; }
  }
  if (failed) warnings.push(`could not read file changes for ${failed} PR${failed > 1 ? 's' : ''}; their new, removed and moved files show as plain changes`);
  return warnings;
}

// ---- how far behind its target each PR is ----
// GraphQL can compare a branch with a commit, so twenty PRs are one request. Names go in as variables (a branch name is outside text),
// the commit is a hex sha from gh. A PR whose target branch is gone answers null and just has no count.
const SHA = /^[0-9a-f]{7,64}$/i;
export const behindQuery = (n) => `query($owner: String!, $name: String!${Array.from({ length: n }, (_, i) => `, $b${i}: String!, $h${i}: String!`).join('')}) { repository(owner: $owner, name: $name) {
${Array.from({ length: n }, (_, i) => `  c${i}: ref(qualifiedName: $b${i}) { compare(headRef: $h${i}) { behindBy } }`).join('\n')}
} }`;
/** The answer -> an array of how far behind each asked-for PR is (a whole number) or null. Pure. */
export function behindFromGraphql(data, n) {
  return Array.from({ length: n }, (_, i) => { const v = data?.[`c${i}`]?.compare?.behindBy; return Number.isInteger(v) && v >= 0 ? v : null; });
}
/** Add `base.behind` to the open PRs. Trouble only costs the count, never the feed. */
export async function addBehind(prs, { repo, host = null, gh = 'gh', exec = defaultExec, limit = DETAIL_LIMIT } = {}) {
  const warnings = [], env = host ? { GH_HOST: host } : {}, open = prs.filter((p) => p.base?.ref && SHA.test(p.headSha || '') && !['merged', 'closed'].includes(p.status));
  const looked = open.slice(0, limit); if (open.length > looked.length) warnings.push(`how far behind they are was read for ${looked.length} of ${open.length} PRs`);
  if (!looked.length) return warnings;
  let owner, name; try { ({ owner, name } = await repoParts(repo, { exec, gh, env })); } catch (e) { return [...warnings, `could not read how far PRs are behind: ${e.message.split('\n')[0]}`]; }
  let failed = 0;
  for (let i = 0; i < looked.length; i += CHUNK) {
    const chunk = looked.slice(i, i + CHUNK), args = ['api', 'graphql', '-f', `query=${behindQuery(chunk.length)}`, '-f', `owner=${owner}`, '-f', `name=${name}`];
    chunk.forEach((p, j) => args.push('-f', `b${j}=refs/heads/${p.base.ref}`, '-f', `h${j}=${p.headSha}`));
    try {
      const counts = behindFromGraphql(JSON.parse(await exec(gh, args, { env }))?.data?.repository, chunk.length);
      chunk.forEach((p, j) => { if (counts[j] != null) p.base.behind = counts[j]; });
    } catch { failed += chunk.length; }
  }
  if (failed) warnings.push(`could not read how far ${failed} PR${failed > 1 ? 's' : ''} are behind their target`);
  return warnings;
}

// ---- what the target did to each file since the PR branched ----
// REST compare, from the PR's head to its target, is the diff of the target's own work since the two last agreed: a file it removed,
// moved (previous_filename) or changed. It lists at most 300 files, so a long-running target can cut it short: that is recorded
// (`base.sinceCut`), and a file with no entry then means "not seen", not "untouched". One request per PR that is behind, a few at a time.
const SINCE_LIMIT = 40, SINCE_PARALLEL = 4, SINCE_FILES = 300;
/** Compare's files -> Map(path -> {change: 'removed' | 'moved' | 'modified' | 'added', to?}) for the paths asked about. Pure. */
export function sinceFromCompare(files, paths) {
  const want = new Set(paths), out = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    if (!f || typeof f.filename !== 'string') continue;
    if (f.previous_filename && want.has(f.previous_filename)) out.set(f.previous_filename, { change: 'moved', to: f.filename });   // the file the PR means is now called something else
    else if (want.has(f.filename)) out.set(f.filename, { change: f.status === 'removed' ? 'removed' : f.status === 'added' ? 'added' : 'modified' });
  }
  return out;
}
/** Add `since` to each file of the PRs that are behind, and `base.sinceCut` when compare may have left files out. Trouble only costs detail. */
export async function addSince(prs, { repo, host = null, gh = 'gh', exec = defaultExec, limit = SINCE_LIMIT } = {}) {
  const warnings = [], env = host ? { GH_HOST: host } : {}, behind = prs.filter((p) => p.base?.behind > 0 && SHA.test(p.headSha || '') && p.files?.length && !['merged', 'closed'].includes(p.status));
  const looked = behind.slice(0, limit); if (behind.length > looked.length) warnings.push(`what the target changed since the branch point was read for ${looked.length} of ${behind.length} PRs that are behind`);
  // a PR that is behind and whose list we did not read (past the cap, a failed call, no commit to ask about) is marked: the map must not guess for it
  const read = new Set(), unknown = () => { for (const p of prs) if (p.base?.behind > 0 && p.files?.length && !['merged', 'closed'].includes(p.status) && !read.has(p)) p.base.sinceUnknown = true; };
  if (!looked.length) { unknown(); return warnings; }
  let owner, name; try { ({ owner, name } = await repoParts(repo, { exec, gh, env })); } catch (e) { unknown(); return [...warnings, `could not read what targets changed: ${e.message.split('\n')[0]}`]; }
  let failed = 0, next = 0;
  const one = async (p) => {
    const text = await exec(gh, ['api', `repos/${owner}/${name}/compare/${p.headSha}...${encodeURIComponent(p.base.ref)}`, '--jq', '{mergeBase: .merge_base_commit.sha, files: [.files[]? | {filename, status, previous_filename}]}'], { env });
    const out = JSON.parse(text), files = out?.files; if (!Array.isArray(files)) throw new SyncError('no files in the answer');
    if (SHA.test(out.mergeBase || '')) p.base.mergeBase = out.mergeBase;                // where the PR and its target last agreed: the tree to look at to see the PR as its author did
    const since = sinceFromCompare(files, p.files.map((f) => f.from || f.path));
    for (const f of p.files) { const s = since.get(f.from || f.path); if (s) f.since = s; }
    if (files.length >= SINCE_FILES) p.base.sinceCut = true;
    read.add(p);
  };
  await Promise.all(Array.from({ length: Math.min(SINCE_PARALLEL, looked.length) }, async () => { while (next < looked.length) { const p = looked[next++]; try { await one(p); } catch { failed++; } } }));
  unknown();
  if (failed) warnings.push(`could not read what the target changed for ${failed} PR${failed > 1 ? 's' : ''}`);
  return warnings;
}

export const github = { name: 'github', fetch: fetchGithub };

// ---- a repo with no clone: its shape and its numbers, straight from the remote ----------------------------------------

/** "owner/name", "host/owner/name" or a URL (https, ssh or scp style) into {host, owner, name}. null if it is none of those. */
export function parseRepoRef(input) {
  let s = String(input || '').trim().replace(/\/+$/, '').replace(/\.git$/, '');
  if (!s) return null;
  let m = s.match(/^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+)/) || s.match(/^[^@/\s]+@([^:/\s]+):([^/]+)\/([^/]+)$/);
  if (m) return { host: m[1], owner: m[2], name: m[3].replace(/\.git$/, '') };
  const parts = s.split('/').filter(Boolean);
  if (parts.length === 2 && !parts[0].includes('.')) return { host: null, owner: parts[0], name: parts[1] };
  if (parts.length === 3 && parts[0].includes('.')) return { host: parts[0], owner: parts[1], name: parts[2] };
  return null;
}
const isSafeName = (x) => /^[A-Za-z0-9_.-]+$/.test(x) && x !== '.' && x !== '..';
export const repoKey = (r) => `${r.host && r.host !== 'github.com' ? r.host + '/' : ''}${r.owner}/${r.name}`;

// A file's size in bytes is all the tree API gives. About 38 bytes make a line of code, and a branchy line is roughly
// one in nine, so these are estimates, and the city says so. Real counts need the content, which would mean a clone.
const BYTES_PER_LINE = 38, LINES_PER_BRANCH = 9;
export const estimateFile = (size) => { const loc = Math.max(1, Math.round(size / BYTES_PER_LINE)); return { loc, complexity: Math.round(loc / LINES_PER_BRANCH) }; };

/** A branch name or a commit sha, safe to put in a URL path (encoded) and never an option for gh: no control characters, no `..`, not empty or huge. */
export const isTreeish = (s) => typeof s === 'string' && s.length > 0 && s.length <= 250 && !/[\0-\x1f\x7f\s~^:?*[\\]/.test(s) && !s.includes('..') && !s.startsWith('-') && !s.endsWith('/') && !s.endsWith('.lock');

/**
 * The file list of a repo's default branch (or, with `at`, another branch or a commit) without cloning it: two `gh api` calls (the default branch, then its whole
 * tree). Sizes are estimates (see above). A tree GitHub had to cut short is reported as a warning, not an error.
 */
export async function fetchRepoTree({ repo, host = null, at = null, gh = 'gh', exec = defaultExec, maxFiles = 6000, maxBytes = 1_000_000 } = {}) {
  const ref = typeof repo === 'string' ? parseRepoRef(repo) : repo;
  if (!ref || !isSafeName(ref.owner) || !isSafeName(ref.name)) throw new SyncError(`cannot read owner and name from "${repo}"`);
  const h = host || ref.host, env = h && h !== 'github.com' ? { GH_HOST: h } : {}, base = `repos/${ref.owner}/${ref.name}`;
  if (at != null && !isTreeish(at)) throw new SyncError('that is not a branch name or a commit');
  const info = at ? {} : JSON.parse(await exec(gh, ['api', base, '--jq', '{default_branch, private, description}'], { env }) || '{}');   // `at`: the tree as it stood on another branch or at a commit; nothing else about the repo is needed
  const branch = at || info.default_branch || 'HEAD';
  const out = JSON.parse(await exec(gh, ['api', `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`], { env }) || '{}');
  if (!Array.isArray(out.tree)) throw new SyncError('gh returned no file tree');
  const warnings = [];
  if (out.truncated) warnings.push('GitHub cut this repository\'s file tree short (it is very large), so the city shows only part of it');
  let blobs = out.tree.filter((t) => t.type === 'blob' && !SKIP.test(t.path) && t.size > 0 && t.size <= maxBytes);
  if (blobs.length > maxFiles) { warnings.push(`${blobs.length} files: showing the ${maxFiles} biggest`); blobs = blobs.sort((a, b) => b.size - a.size).slice(0, maxFiles); }
  const files = blobs.map((t) => ({ path: t.path, ...estimateFile(t.size) })).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { files, branch, warnings, estimated: true, description: info.description || '', private: !!info.private };
}

/**
 * Three numbers for the world view, from one cheap `gh pr list` (no files, no timelines): how many PRs are open, how many are
 * yours, and how many need you. Same rules as the map: "needs you" is `needsReason`.
 */
export async function fetchPRStats({ repo, host = null, gh = 'gh', exec = defaultExec, limit = 300 } = {}) {
  const ref = typeof repo === 'string' ? parseRepoRef(repo) : repo;
  if (!ref || !isSafeName(ref.owner) || !isSafeName(ref.name)) throw new SyncError(`cannot read owner and name from "${repo}"`);
  const h = host || ref.host, env = h && h !== 'github.com' ? { GH_HOST: h } : {};
  let viewer = null;
  try { viewer = (await exec(gh, ['api', 'user', '--jq', '.login'], { env })).trim() || null; } catch { /* mine stays 0 */ }
  const fields = FIELDS.filter((f) => f !== 'files');                      // the files are what makes a PR list slow, and the counts do not need them
  const raw = JSON.parse(await exec(gh, ['pr', 'list', '--repo', `${ref.owner}/${ref.name}`, '--state', 'open', '--limit', String(limit), '--json', fields.join(',')], { env }) || '[]');
  if (!Array.isArray(raw)) throw new SyncError('gh returned an unexpected shape');
  const prs = raw.map((p) => normalisePR({ ...p, files: [] }, { viewer }));
  return { open: prs.length, mine: prs.filter((p) => p.mine).length, needs: prs.filter((p) => needsReason(p)).length, viewer, capped: raw.length >= limit };
}
