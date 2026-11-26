// GitHub and GitHub Enterprise, through the `gh` CLI. gh already knows how to log in to either, so there is no
// token handling here: `gh auth login` (add `--hostname ghe.example.com` for Enterprise) is the whole setup.
//
// The mapping from gh's JSON to the feed is pure (normalisePR) and tested with fixtures. The runner takes `exec`
// so tests can stand in for gh. Another host (GitLab, say) is another file here with the same `fetch` shape.
import { execFile } from 'node:child_process';

export class SyncError extends Error {}

export const FIELDS = ['number', 'title', 'headRefName', 'headRefOid', 'author', 'isDraft', 'reviewDecision', 'statusCheckRollup',
  'createdAt', 'updatedAt', 'url', 'files', 'reviewRequests', 'latestReviews', 'state', 'mergedAt', 'closedAt'];

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

/** gh's PR JSON to one feed entry. `viewer` is the logged-in user, so your own PRs are marked as yours. */
export function normalisePR(raw, { viewer = null } = {}) {
  const author = raw.author?.login || 'unknown';
  return {
    id: `#${raw.number}`, number: raw.number, title: raw.title || `#${raw.number}`, branch: raw.headRefName || '', author, url: raw.url || null,
    status: prStatus(raw), createdAt: raw.createdAt || null, updatedAt: raw.updatedAt || null, headSha: raw.headRefOid || null,
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
  const seen = new Set(open.map((p) => p.number));
  const prs = [...open, ...ended.filter((p) => !seen.has(p.number))].map((p) => normalisePR(p, { viewer }));
  return { prs, viewer, warnings, counts: { open: open.length, ended: prs.length - open.length } };
}

export const github = { name: 'github', fetch: fetchGithub };
