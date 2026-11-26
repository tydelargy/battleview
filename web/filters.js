// Which PRs the tray and the map show, and in what order. Pure: the clock comes in as `now`, so it is all testable.
// One filter model covers everything (search, authors, status, age, "needs me", epic), so the chips, the panel and
// the map can never disagree about what is hidden.

const DAY = 86400_000;

export const SORTS = {
  attention: 'Needs attention first',
  oldest: 'Open longest',
  newest: 'Newest',
  updated: 'Recent activity',
  quiet: 'Quiet longest',
  size: 'Biggest change',
  author: 'Author A to Z',
};
/** One line under the sort menu saying what the current order means. */
export const SORT_HELP = {
  attention: 'Re-reviews waiting longest and unaddressed comments on your PRs first (yours first on a close call), then the oldest PRs that need you, then red CI, then the rest. Drafts go last.',
  oldest: 'Longest since the PR was opened comes first.',
  newest: 'Most recently opened comes first.',
  updated: 'Most recent activity comes first.',
  quiet: 'Longest without any activity comes first.',
  size: 'Most lines changed comes first.',
  author: 'By author name; within an author, needs-attention order.',
};
/** Choices for the two age filters, in days. 0 means no filter. */
export const AGE_STEPS = [[0, 'Any'], [1, '1 day'], [3, '3 days'], [7, '1 week'], [14, '2 weeks'], [30, '1 month']];

export const emptyFilters = () => ({ q: '', needs: false, epic: null, authors: [], statuses: [], openDays: 0, quietDays: 0, sort: 'attention' });

/** Whatever came out of storage becomes a valid filter state: unknown keys dropped, bad values reset. */
export function normaliseFilters(raw) {
  const f = emptyFilters();
  if (!raw || typeof raw !== 'object') return f;
  if (typeof raw.q === 'string') f.q = raw.q.slice(0, 200);
  f.needs = raw.needs === true;
  if (typeof raw.epic === 'string' && raw.epic) f.epic = raw.epic;
  const strs = (a) => (Array.isArray(a) ? [...new Set(a.filter((x) => typeof x === 'string' && x))].slice(0, 100) : []);
  f.authors = strs(raw.authors); f.statuses = strs(raw.statuses);
  const days = (n) => (Number.isFinite(n) && n > 0 && n <= 3650 ? Math.round(n) : 0);
  f.openDays = days(raw.openDays); f.quietDays = days(raw.quietDays);
  if (Object.hasOwn(SORTS, raw.sort)) f.sort = raw.sort;
  return f;
}

/** Days since an ISO timestamp, or null when there is none (or it is not a date). */
export function ageDays(iso, now) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY) : null;
}

/** "5h", "3d", "6w", or "" when unknown. */
export function formatAge(days) {
  if (days == null) return '';
  if (days < 1 / 24) return 'now';
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}h`;
  if (days < 14) return `${Math.round(days)}d`;
  if (days < 90) return `${Math.round(days / 7)}w`;
  return `${Math.round(days / 30)}mo`;
}

/** How high (map units) an old PR's flag is raised. Square root so a week and a month are both visible, capped so the old never leave the screen. */
export const AGE_LIFT = { k: 7, max: 60 };
export const ageLift = (days) => (days == null ? 0 : Math.min(AGE_LIFT.max, Math.sqrt(days) * AGE_LIFT.k));

const haystack = (p) => `${p.id} ${p.number ?? ''} ${p.title} ${p.author} ${p.ticketKey || ''} ${p.branch || ''} ${p.epic || ''}`.toLowerCase();

/** Every active condition must hold (AND); within authors, or within statuses, any one will do (OR). */
export function matches(p, f, now) {
  if (f.needs && !p.needs) return false;
  if (f.epic && p.epic !== f.epic) return false;
  if (f.authors.length && !f.authors.some((a) => a.toLowerCase() === String(p.author).toLowerCase())) return false;
  if (f.statuses.length && !f.statuses.includes(p.status)) return false;
  if (f.openDays) { const d = ageDays(p.createdAt, now); if (d == null || d < f.openDays) return false; }       // unknown age cannot be "at least" anything
  if (f.quietDays) { const d = ageDays(p.updatedAt, now); if (d == null || d < f.quietDays) return false; }
  const terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) { const h = haystack(p); if (!terms.every((t) => h.includes(t))) return false; }
  return true;
}
export const applyFilters = (prs, f, now) => prs.filter((p) => matches(p, f, now));

/**
 * "Needs attention first". Every PR falls in one tier, and the tiers go in this order:
 *   0  waiting on us: someone else's PR in re-review, or one of ours with unaddressed comments
 *      (most waited-on first; on a close call, ours come first)
 *   1  everything else that needs us (a review request, our own PR ready to merge or with red CI):
 *      the oldest PR first, so the ones we ought to have closed by now lead
 *   2  someone else's PR with red CI
 *   3  the rest
 *   4  drafts, which are allowed to be broken, at the back
 * Ties then fall to the PR number. Ended PRs are handled by the caller.
 */
export const ATTENTION_TIE_MS = 6 * 3600_000;   // waits within the same six-hour window are a "close call"
const waitingStart = (p) => { const t = Date.parse(p.waitingSince || p.updatedAt || ''); return Number.isFinite(t) ? t : null; };
const ownWithComments = (p) => p.mine && (p.status === 'changes_requested' || !!p.waitingSince);

export function attentionTier(p) {
  if ((!p.mine && p.status === 're_review') || ownWithComments(p)) return 0;
  if (p.status === 'draft') return 4;
  if (p.needs) return 1;
  if (p.status === 'ci_failing') return 2;
  return 3;
}
/** How long a tier-0 PR has been waiting on us, in days, or null when we cannot say. Shown on the card so the order explains itself. */
export function waitingDays(p, now) { const t = waitingStart(p); return attentionTier(p) === 0 && t != null ? Math.max(0, (now - t) / DAY) : null; }

/** Negative when `a` should come first. Needs `now` for the waits. */
export function compareAttention(a, b, now) {
  const ta = attentionTier(a), tb = attentionTier(b);
  if (ta !== tb) return ta - tb;
  if (ta === 0) {
    const wa = waitingStart(a), wb = waitingStart(b);
    const ba = wa == null ? -1 : Math.floor((now - wa) / ATTENTION_TIE_MS), bb = wb == null ? -1 : Math.floor((now - wb) / ATTENTION_TIE_MS);
    if (ba !== bb) return bb - ba;                                          // longer wait first (an unknown wait is last)
    if (!!a.mine !== !!b.mine) return a.mine ? -1 : 1;                      // a close call: ours first
    if (wa !== wb && wa != null && wb != null) return wa - wb;              // then the exact wait
  }
  if (ta <= 1) {                                                            // the oldest PR first: "we have got to close this one"
    const ca = Date.parse(a.createdAt || ''), cb = Date.parse(b.createdAt || '');
    const fa = Number.isFinite(ca), fb = Number.isFinite(cb);
    if (fa !== fb) return fa ? -1 : 1;
    if (fa && ca !== cb) return ca - cb;
  }
  return 0;                                                                  // the caller falls back to the PR number
}

/** Sorted copy. Ended PRs (merged, closed) always sink to the bottom; ties fall back to the PR id so the order never jitters. */
export function sortPRs(prs, sort, now) {
  const t = (iso) => { const v = Date.parse(iso || ''); return Number.isFinite(v) ? v : null; };
  const byId = (a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
  // null timestamps go last in both directions
  const asc = (get) => (a, b) => { const x = get(a), y = get(b); return x == null ? (y == null ? 0 : 1) : y == null ? -1 : x - y; };
  const desc = (get) => (a, b) => { const x = get(a), y = get(b); return x == null ? (y == null ? 0 : 1) : y == null ? -1 : y - x; };
  const cmp = {
    attention: (a, b) => compareAttention(a, b, now),
    oldest: asc((p) => t(p.createdAt)),
    newest: desc((p) => t(p.createdAt)),
    updated: desc((p) => t(p.updatedAt)),
    quiet: asc((p) => t(p.updatedAt)),
    size: (a, b) => (b.adds + b.dels) - (a.adds + a.dels),
    author: (a, b) => String(a.author).localeCompare(String(b.author)) || compareAttention(a, b, now),
  }[Object.hasOwn(SORTS, sort) ? sort : 'attention'];
  return [...prs].sort((a, b) => !!a.ended - !!b.ended || cmp(a, b) || byId(a, b));
}

/** How many of the panel's conditions are on (the sort, "needs me" and epic chips have their own controls). */
export const activeCount = (f) => (f.q.trim() ? 1 : 0) + (f.authors.length ? 1 : 0) + (f.statuses.length ? 1 : 0) + (f.openDays ? 1 : 0) + (f.quietDays ? 1 : 0);
export const anyFilter = (f) => activeCount(f) > 0 || f.needs || !!f.epic;

/** Plain-language description of what is filtering, for the "nothing matches" message. */
export function describeFilters(f, statusLabel = (s) => s) {
  const parts = [];
  if (f.q.trim()) parts.push(`matching "${f.q.trim()}"`);
  if (f.needs) parts.push('that need you');
  if (f.epic) parts.push(`in epic ${f.epic}`);
  if (f.authors.length) parts.push(`by ${f.authors.map((a) => '@' + a).join(' or ')}`);
  if (f.statuses.length) parts.push(`that are ${f.statuses.map(statusLabel).join(' or ')}`);
  if (f.openDays) parts.push(`open for ${f.openDays}+ days`);
  if (f.quietDays) parts.push(`quiet for ${f.quietDays}+ days`);
  return parts.join(', ');
}
