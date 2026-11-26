// GitHub and GitHub Enterprise, through the `gh` CLI. gh already knows how to log in to either, so there is no
// token handling here: `gh auth login` (add `--hostname ghe.example.com` for Enterprise) is the whole setup.
//
// The mapping from gh's JSON to the feed is pure (normalisePR) and tested with fixtures. The runner takes `exec`
// so tests can stand in for gh. Another host (GitLab, say) is another file here with the same `fetch` shape.
import { execFile } from 'node:child_process';

export class SyncError extends Error {}

export const FIELDS = ['number', 'title', 'headRefName', 'headRefOid', 'author', 'isDraft', 'reviewDecision', 'statusCheckRollup',
  'createdAt', 'updatedAt', 'url', 'files', 'reviewRequests', 'latestReviews', 'state', 'mergedAt', 'closedAt'];

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
export async function fetchGithub({ repo = null, host = null, limit = 500, endedDays = 2, gh = 'gh', exec = defaultExec, now = Date.now() } = {}) {
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
  return { prs, viewer, warnings, counts: { open: open.length, ended: prs.length - open.length } };
}

export const github = { name: 'github', fetch: fetchGithub };
