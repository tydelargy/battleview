// Joins repo files, PRs and Jira into the one object the browser renders, and
// derives "drift" insights: places where PR reality and ticket state disagree.
import { synthHunks } from './hunks.js';

export const STATUSES = ['review_requested', 're_review', 'changes_requested', 'ci_failing', 'ready_to_merge', 'draft', 'merged', 'closed'];

export function needsReason(p) {
  if (p.mine) {
    if (p.status === 'ci_failing') return 'Your CI is red';
    if (p.status === 'changes_requested') return 'Address requested changes';
    if (p.status === 'ready_to_merge') return 'Approved and green. Merge it';
    return '';
  }
  if (p.status === 'review_requested') return 'Review requested';
  if (p.status === 're_review') return 'Author pushed. Re-review';
  return '';
}

/** Coerce provider input into the PR shape the app expects. Returns {prs, problems}. */
export function normalisePRs(input, identity = { prAuthors: ['you'] }) {
  const problems = [];
  const prs = [];
  for (const [i, raw] of (Array.isArray(input) ? input : []).entries()) {
    if (!raw || typeof raw !== 'object' || !raw.id) { problems.push(`prs[${i}] has no id`); continue; }
    const status = STATUSES.includes(raw.status) ? raw.status : (problems.push(`${raw.id}: unknown status "${raw.status}", using draft`), 'draft');
    const files = (Array.isArray(raw.files) ? raw.files : []).filter((f) => f && f.path).map((f) => {
      const add = Math.max(0, Number(f.add) || 0), del = Math.max(0, Number(f.del) || 0);
      const real = Array.isArray(f.hunks) && f.hunks.length;
      return { path: f.path, add, del, hunks: real ? f.hunks.map((h) => ({ add: Math.max(0, +h.add || 0), del: Math.max(0, +h.del || 0), ...(Number.isFinite(+h.start) && +h.start >= 1 ? { start: Math.floor(+h.start) } : {}) })) : synthHunks(f.path, add, del), syntheticHunks: !real };
    });
    prs.push({
      id: String(raw.id), number: raw.number ?? null, title: String(raw.title || raw.id), branch: raw.branch || '', author: raw.author || 'unknown',
      url: raw.url || null, ticket: raw.ticket || null, status, files, updatedAt: raw.updatedAt || null, createdAt: raw.createdAt || null, headSha: raw.headSha || null, waitingSince: raw.waitingSince || null,
      mine: raw.mine ?? identity.prAuthors.includes(raw.author),
      adds: files.reduce((a, f) => a + f.add, 0), dels: files.reduce((a, f) => a + f.del, 0),
    });
  }
  return { prs, problems };
}

export function extractKey(pr, pattern) {
  if (pr.ticket) return String(pr.ticket).toUpperCase();
  let re; try { re = new RegExp(pattern, 'i'); } catch { re = /[A-Z][A-Z0-9]+-\d+/i; }
  const m = `${pr.title} ${pr.branch}`.match(re);
  return m ? m[0].toUpperCase() : null;
}

const PR_ACTIVE = new Set(['review_requested', 're_review', 'changes_requested', 'ci_failing', 'ready_to_merge']);
const PR_REVIEWABLE = new Set(['review_requested', 're_review', 'ready_to_merge']);

export function buildSnapshot({ files, prs, ended = [], jira, cfg }) {
  const pattern = cfg.jira.keyPattern;
  const issues = jira?.issues || new Map();
  const jiraOn = !!jira?.ok;
  const join = (p) => {
    const key = extractKey(p, pattern);
    const issue = key ? issues.get(key) || null : null;
    return { ...p, ticketKey: key, ticket: issue ? { ...issue } : null, needs: needsReason(p), epic: issue?.epic?.name || null };
  };
  const outPRs = prs.map(join);
  const endedOut = ended.map((p) => ({ ...join(p), ended: true }));   // shown as cards, kept out of the drift checks

  const insights = [];
  const add = (kind, severity, title, detail, extra = {}) => insights.push({ id: `${kind}|${[...(extra.prIds || []), ...(extra.keys || []), ...(extra.files || [])].join(',')}`, kind, severity, title, detail, prIds: [], keys: [], ...extra });
  const prByKey = new Map();
  for (const p of outPRs) if (p.ticketKey) { (prByKey.get(p.ticketKey) || prByKey.set(p.ticketKey, []).get(p.ticketKey)).push(p); }

  for (const p of outPRs) {
    if (!p.ticketKey) { add('pr_no_ticket', 'warn', `${p.id} has no ticket`, `"${p.title}" does not mention a Jira key in its title or branch.`, { prIds: [p.id] }); continue; }
    if (!jiraOn) continue;
    const t = p.ticket;
    if (!t) { add('ticket_not_found', 'warn', `${p.ticketKey} not found in Jira`, `${p.id} references ${p.ticketKey}, but Jira does not return it. Typo, or no access?`, { prIds: [p.id], keys: [p.ticketKey] }); continue; }
    if (t.status.category === 'done' && PR_ACTIVE.has(p.status)) add('ticket_done_pr_open', 'warn', `${t.key} is Done but ${p.id} is still open`, `Ticket says ${t.status.name}. The PR is ${p.status.replace(/_/g, ' ')}.`, { prIds: [p.id], keys: [t.key] });
    else if (t.status.category === 'todo' && p.status !== 'draft') add('ticket_todo_pr_active', 'warn', `${t.key} is ${t.status.name} but ${p.id} is up`, 'Move the ticket forward so the board matches reality.', { prIds: [p.id], keys: [t.key] });
    else if (t.status.category === 'progress' && !/review/i.test(t.status.name) && PR_REVIEWABLE.has(p.status)) add('ticket_not_in_review', 'info', `${t.key} could move to review`, `${p.id} is ${p.status.replace(/_/g, ' ')} while the ticket is ${t.status.name}.`, { prIds: [p.id], keys: [t.key] });
  }
  if (jiraOn) {
    for (const t of issues.values()) {
      if (t.type === 'Epic' || t.status.category === 'done' || prByKey.has(t.key)) continue;
      if (/review/i.test(t.status.name)) add('ticket_review_no_pr', 'warn', `${t.key} is ${t.status.name} with no PR`, 'Nothing in the repo points at this ticket. Missing key in a PR title, or unpushed work?', { keys: [t.key] });
      else if (t.status.category === 'progress') add('ticket_progress_no_pr', 'info', `${t.key} in progress, no PR yet`, `${t.assignee?.name || 'Unassigned'} is on it.`, { keys: [t.key] });
    }
  }
  // Same file, different tickets: merge-order problem waiting to happen.
  const byFile = new Map();
  for (const p of outPRs) for (const f of p.files) (byFile.get(f.path) || byFile.set(f.path, []).get(f.path)).push(p);
  for (const [path, list] of byFile) if (list.length > 1) add('contested_file', 'info', `${path.split('/').pop()} is touched by ${list.length} PRs`, `${list.map((p) => p.id).join(', ')} all change ${path}.`, { prIds: list.map((p) => p.id), files: [path] });

  const order = { warn: 0, info: 1 };
  insights.sort((a, b) => order[a.severity] - order[b.severity]);

  const epicNames = new Set(outPRs.map((p) => p.epic).filter(Boolean));
  return {
    generatedAt: new Date().toISOString(),
    files,
    prs: [...outPRs, ...endedOut],
    epics: [...epicNames].sort(),
    insights,
    jira: {
      configured: !!(cfg.jira.baseUrl && cfg.jira.token),
      ok: jiraOn, error: jira?.error || null, hint: jira?.hint || null,
      user: jira?.user || null, sprint: jira?.sprint || null, lastSync: jira?.lastSync || null,
      baseUrl: cfg.jira.baseUrl || null, deployment: cfg.jira.deployment,
      ticketCount: issues.size,
    },
    display: cfg.display,
  };
}
