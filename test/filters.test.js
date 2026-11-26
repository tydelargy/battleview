import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyFilters, normaliseFilters, ageDays, formatAge, ageLift, AGE_LIFT, matches, applyFilters, sortPRs, attentionTier, compareAttention, waitingDays, ATTENTION_TIE_MS, activeCount, anyFilter, describeFilters, SORTS, SORT_HELP } from '../web/filters.js';
import { samplePRs } from '../server/sample.js';
import { normalisePRs } from '../server/snapshot.js';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const ago = (days) => new Date(NOW - days * 86400_000).toISOString();
const pr = (id, o = {}) => ({ id, number: Number(id.slice(1)), title: `Title ${id}`, author: 'maya', status: 'review_requested', needs: '', adds: 10, dels: 0, createdAt: ago(5), updatedAt: ago(1), ticketKey: null, branch: '', epic: null, ...o });
const ids = (list) => list.map((p) => p.id);
const F = (o) => ({ ...emptyFilters(), ...o });

const SET = [
  pr('#1', { author: 'maya', status: 'ci_failing', title: 'Billing rewrite', createdAt: ago(20), updatedAt: ago(0.1), adds: 500, dels: 100, needs: 'Your CI is red', epic: 'Billing v2', ticketKey: 'ENG-1' }),
  pr('#2', { author: 'Devon', status: 'review_requested', title: 'Invoice model', createdAt: ago(2), updatedAt: ago(2), adds: 50 }),
  pr('#3', { author: 'ines', status: 'draft', title: 'Onboarding checklist', createdAt: ago(9), updatedAt: ago(8), adds: 300, dels: 10, epic: 'Web onboarding' }),
  pr('#4', { author: 'maya', status: 'ready_to_merge', title: 'Session rotation', createdAt: ago(0.5), updatedAt: ago(0.2), adds: 70, needs: 'Approved and green. Merge it' }),
  pr('#5', { author: 'kofi', status: 're_review', title: 'Move API to Fargate', createdAt: null, updatedAt: null, adds: 400, dels: 90, branch: 'kofi/ENG-455-fargate' }),
  pr('#6', { author: 'maya', status: 'merged', ended: true, title: 'Old thing', createdAt: ago(40), updatedAt: ago(3), adds: 5 }),
];

test('normaliseFilters: any junk becomes a valid state', () => {
  assert.deepEqual(normaliseFilters(null), emptyFilters());
  assert.deepEqual(normaliseFilters('x'), emptyFilters());
  const f = normaliseFilters({ q: 5, needs: 'yes', epic: '', authors: ['a', 'a', 3, ''], statuses: 'draft', openDays: -4, quietDays: 'x', sort: 'nope', extra: 1 });
  assert.deepEqual(f, { ...emptyFilters(), authors: ['a'] }, 'junk is dropped, the one valid author kept once');
  const g = normaliseFilters({ q: 'x', needs: true, epic: 'E', authors: ['a', 'a', 'b'], statuses: ['draft'], openDays: 6.6, quietDays: 3, sort: 'oldest' });
  assert.deepEqual(g, { q: 'x', needs: true, epic: 'E', authors: ['a', 'b'], statuses: ['draft'], openDays: 7, quietDays: 3, sort: 'oldest' });
  assert.equal(normaliseFilters({ q: 'x'.repeat(500) }).q.length, 200);
});

test('ageDays and formatAge', () => {
  assert.equal(ageDays(ago(3), NOW), 3);
  assert.equal(ageDays(null, NOW), null); assert.equal(ageDays('garbage', NOW), null);
  assert.equal(ageDays(new Date(NOW + 5000).toISOString(), NOW), 0, 'a clock a little ahead never gives a negative age');
  assert.deepEqual([0.001, 0.2, 0.99, 1, 3.4, 13, 14, 20, 100].map(formatAge), ['now', '5h', '24h', '1d', '3d', '13d', '2w', '3w', '3mo']);
  assert.equal(formatAge(null), '');
});

test('ageLift grows with age, flattens, is capped, and is zero when unknown', () => {
  assert.equal(ageLift(null), 0); assert.equal(ageLift(0), 0);
  const xs = [0.5, 1, 4, 9, 30, 100, 1000].map(ageLift);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] >= xs[i - 1]);
  assert.ok(ageLift(4) - ageLift(1) > ageLift(104) - ageLift(101), 'square root: the same three days add less to an old PR');
  assert.equal(ageLift(1e6), AGE_LIFT.max);
  assert.ok(ageLift(7) !== ageLift(30), 'a week and a month are told apart');
});

test('filters: each dimension on its own', () => {
  const run = (o) => ids(applyFilters(SET, F(o), NOW));
  assert.deepEqual(run({}), ['#1', '#2', '#3', '#4', '#5', '#6']);
  assert.deepEqual(run({ needs: true }), ['#1', '#4']);
  assert.deepEqual(run({ epic: 'Billing v2' }), ['#1']);
  assert.deepEqual(run({ authors: ['maya'] }), ['#1', '#4', '#6']);
  assert.deepEqual(run({ authors: ['MAYA', 'devon'] }), ['#1', '#2', '#4', '#6'], 'authors: any of them, any case');
  assert.deepEqual(run({ statuses: ['draft', 're_review'] }), ['#3', '#5']);
  assert.deepEqual(run({ openDays: 7 }), ['#1', '#3', '#6'], 'a PR with no createdAt is not "open for 7 days"');
  assert.deepEqual(run({ quietDays: 3 }), ['#3', '#6'], 'not touched for 3 days');
  assert.deepEqual(run({ openDays: 1 }), ['#1', '#2', '#3', '#6']);
});

test('filters: search is case-insensitive, every word must match, and looks at title, author, id, ticket, branch and epic', () => {
  const run = (q) => ids(applyFilters(SET, F({ q }), NOW));
  assert.deepEqual(run('BILLING'), ['#1']);
  assert.deepEqual(run('maya session'), ['#4']);
  assert.deepEqual(run('maya session nope'), []);
  assert.deepEqual(run('eng-1'), ['#1'], 'ticket key');
  assert.deepEqual(run('fargate'), ['#5'], 'title and branch');
  assert.deepEqual(run('kofi/eng'), ['#5'], 'branch');
  assert.deepEqual(run('onboarding'), ['#3']);
  assert.deepEqual(run('#2'), ['#2']);
  assert.deepEqual(run('   '), ids(SET), 'blank means no filter');
});

test('filters: dimensions combine with AND', () => {
  assert.deepEqual(ids(applyFilters(SET, F({ authors: ['maya'], openDays: 7 }), NOW)), ['#1', '#6']);
  assert.deepEqual(ids(applyFilters(SET, F({ authors: ['maya'], openDays: 7, statuses: ['ci_failing'], q: 'billing', needs: true }), NOW)), ['#1']);
  assert.deepEqual(ids(applyFilters(SET, F({ authors: ['maya'], statuses: ['draft'] }), NOW)), []);
  assert.equal(matches(SET[0], F({ q: 'billing', quietDays: 1 }), NOW), false, '#1 was updated 2 hours ago');
});

test('sorts', () => {
  const order = (s) => ids(sortPRs(SET, s, NOW));
  assert.deepEqual(order('attention'), ['#5', '#1', '#4', '#2', '#3', '#6'], '#5 is in re-review (tier 0); #1 and #4 need you, oldest first; #2 is the rest; the draft is last; ended after that');
  assert.deepEqual(order('oldest'), ['#1', '#3', '#2', '#4', '#5', '#6'], 'open longest first; unknown age after the known; ended last');
  assert.deepEqual(order('newest'), ['#4', '#2', '#3', '#1', '#5', '#6']);
  assert.deepEqual(order('updated'), ['#1', '#4', '#2', '#3', '#5', '#6'], 'most recent activity first: 0.1d, 0.2d, 2d, 8d, unknown');
  assert.deepEqual(order('size'), ['#1', '#5', '#3', '#4', '#2', '#6']);
  assert.deepEqual(order('author'), ['#2', '#3', '#5', '#1', '#4', '#6'], 'Devon, ines, kofi, then maya (her two PRs that need you, the older first), ended last');
  assert.deepEqual(order('bogus'), order('attention'), 'an unknown sort is the default');
});

test('sorts: ended PRs sink in every order; ties never jitter; the input is not mutated', () => {
  const copy = SET.map((p) => p.id);
  for (const s of Object.keys(SORTS)) assert.equal(sortPRs(SET, s, NOW).at(-1).id, '#6', s);
  assert.deepEqual(SET.map((p) => p.id), copy);
  const ties = [pr('#10'), pr('#9'), pr('#2')];
  assert.deepEqual(ids(sortPRs(ties, 'oldest', NOW)), ['#2', '#9', '#10'], 'numeric-aware id tie-break');
  assert.deepEqual(ids(sortPRs([...ties].reverse(), 'oldest', NOW)), ['#2', '#9', '#10']);
});

test('quiet sort, explicitly: least recent activity first, unknown last', () => {
  assert.deepEqual(ids(sortPRs(SET, 'quiet', NOW)), ['#3', '#2', '#4', '#1', '#5', '#6'], '8d, 2d, 0.2d, 0.1d, unknown, then the ended one');
});

test('activeCount, anyFilter and describeFilters', () => {
  assert.equal(activeCount(emptyFilters()), 0); assert.equal(anyFilter(emptyFilters()), false);
  assert.equal(activeCount(F({ q: ' x ', authors: ['a', 'b'], statuses: ['draft'], openDays: 3, quietDays: 7 })), 5);
  assert.equal(activeCount(F({ q: '   ' })), 0);
  assert.equal(anyFilter(F({ needs: true })), true); assert.equal(anyFilter(F({ epic: 'E' })), true);
  assert.equal(anyFilter(F({ sort: 'oldest' })), false, 'sorting is not filtering');
  assert.equal(describeFilters(F({ q: 'bill', authors: ['maya', 'ines'], statuses: ['draft'], openDays: 7, needs: true, epic: 'E', quietDays: 3 }), (s) => s.toUpperCase()),
    'matching "bill", that need you, in epic E, by @maya or @ines, that are DRAFT, open for 7+ days, quiet for 3+ days');
  assert.equal(describeFilters(emptyFilters()), '');
});

test('the feed keeps createdAt and headSha, and the sample has ages that make sense', () => {
  const { prs } = normalisePRs([{ id: '#1', createdAt: '2026-01-01T00:00:00Z', headSha: 'abc', waitingSince: '2026-01-02T00:00:00Z', files: [] }, { id: '#2', files: [] }]);
  assert.deepEqual(prs.map((p) => [p.createdAt, p.headSha, p.waitingSince]), [['2026-01-01T00:00:00Z', 'abc', '2026-01-02T00:00:00Z'], [null, null, null]]);
  const sample = samplePRs();
  assert.ok(sample.every((p) => Date.parse(p.createdAt) < Date.parse(p.updatedAt)), 'opened before it was last updated');
  const days = sample.map((p) => ageDays(p.createdAt, Date.now()));
  assert.ok(Math.min(...days) < 1 && Math.max(...days) > 10, 'a spread of ages for the demo');
});

/* ---------- "Needs attention first" ---------- */
const NOW2 = Date.parse('2026-11-26T12:00:00Z');
const h2 = (hours) => new Date(NOW2 - hours * 3600_000).toISOString();
const q = (id, o = {}) => ({ id, number: Number(id.slice(1)), author: 'other', status: 'review_requested', mine: false, needs: '', adds: 1, dels: 0, createdAt: h2(100), updatedAt: h2(10), waitingSince: null, ...o });
const att = (list) => ids(sortPRs(list, 'attention', NOW2));

test('attention tiers: who goes where', () => {
  assert.equal(attentionTier(q('#1', { status: 're_review', needs: 'Author pushed. Re-review' })), 0, "someone else's PR in re-review");
  assert.equal(attentionTier(q('#1', { mine: true, status: 'changes_requested', needs: 'Address requested changes' })), 0, 'ours, changes requested');
  assert.equal(attentionTier(q('#1', { mine: true, waitingSince: h2(30) })), 0, 'ours, with unaddressed comments the feed knows about');
  assert.equal(attentionTier(q('#1', { mine: true, status: 'draft', waitingSince: h2(30) })), 0, 'unaddressed comments on our draft still count');
  assert.equal(attentionTier(q('#1', { waitingSince: h2(30), needs: 'Review requested' })), 1, "someone else's PR is tier 0 only when it is in re-review, whatever else is known about it");
  assert.equal(attentionTier(q('#1', { needs: 'Review requested' })), 1, 'a first review request');
  assert.equal(attentionTier(q('#1', { mine: true, status: 'ready_to_merge', needs: 'Approved and green. Merge it' })), 1, 'ours, ready to merge');
  assert.equal(attentionTier(q('#1', { mine: true, status: 'ci_failing', needs: 'Your CI is red' })), 1, 'our red CI is something we have to act on');
  assert.equal(attentionTier(q('#1', { status: 'ci_failing' })), 2, "someone else's red CI");
  assert.equal(attentionTier(q('#1')), 3);
  assert.equal(attentionTier(q('#1', { status: 'draft' })), 4);
  assert.equal(attentionTier(q('#1', { mine: true, status: 'draft' })), 4, 'a draft of ours with nothing waiting is still at the back');
});

test('attention: the re-review waited on longest, or the unaddressed comments on ours waiting longest, come first', () => {
  const list = [q('#1', { status: 're_review', waitingSince: h2(24) }), q('#2', { status: 're_review', waitingSince: h2(96) }), q('#3', { mine: true, status: 'changes_requested', waitingSince: h2(60) })];
  assert.deepEqual(att(list), ['#2', '#3', '#1'], '96h, 60h, 24h');
  assert.deepEqual(att([q('#1', { status: 're_review', updatedAt: h2(5) }), q('#2', { status: 're_review', updatedAt: h2(50) })]), ['#2', '#1'], 'with no waitingSince it falls back to the last update');
  assert.deepEqual(att([q('#1', { status: 're_review', updatedAt: null }), q('#2', { status: 're_review', waitingSince: h2(1) })]), ['#2', '#1'], 'an unknown wait goes last');
});

test('attention: on a close call (the same six hours) ours comes first; beyond it, the longer wait wins', () => {
  assert.equal(ATTENTION_TIE_MS, 6 * 3600_000);
  const own = q('#1', { mine: true, status: 'changes_requested', waitingSince: h2(48) });
  assert.deepEqual(att([q('#2', { status: 're_review', waitingSince: h2(50) }), own]), ['#1', '#2'], '48h vs 50h: close, ours first');
  assert.deepEqual(att([q('#2', { status: 're_review', waitingSince: h2(53) }), own]), ['#1', '#2'], '48h vs 53h: still the same six-hour window, so ours first');
  assert.deepEqual(att([q('#2', { status: 're_review', waitingSince: h2(55) }), own]), ['#2', '#1'], '48h vs 55h: theirs has waited clearly longer');
  const own2 = q('#3', { mine: true, status: 'changes_requested', waitingSince: h2(49) });
  assert.deepEqual(att([own2, own]), ['#3', '#1'], 'two of ours in one window: the longer wait first');
  assert.deepEqual(att([q('#4', { status: 're_review', waitingSince: h2(50) }), q('#5', { status: 're_review', waitingSince: h2(52) })]), ['#5', '#4'], 'two of theirs: the longer wait first');
});

test('attention: after the waits, the oldest PR that needs us comes first, not the one whose need is oldest', () => {
  const list = [
    q('#1', { needs: 'Review requested', createdAt: h2(24), updatedAt: h2(1) }),                       // opened a day ago
    q('#2', { needs: 'Review requested', createdAt: h2(24 * 20), updatedAt: h2(2) }),                  // opened 20 days ago, asked for review 2h ago
    q('#3', { mine: true, status: 'ready_to_merge', needs: 'Approved and green. Merge it', createdAt: h2(24 * 9) }),
    q('#4', { needs: 'Review requested', createdAt: null }),
  ];
  assert.deepEqual(att(list), ['#2', '#3', '#1', '#4'], '20 days, 9 days, 1 day, then the one with no date');
  const waiting = q('#9', { status: 're_review', needs: 'Author pushed. Re-review', waitingSince: h2(2), createdAt: h2(5) });
  assert.deepEqual(att([...list, waiting]).slice(0, 2), ['#9', '#2'], 'a re-review still beats an older PR that merely needs a first look');
});

test("attention: then red CI on other people's PRs, then the rest, then drafts at the very back; ties by PR number", () => {
  const list = [
    q('#10', { status: 'draft' }), q('#4', { status: 'draft', needs: '' }), q('#9'), q('#3'),
    q('#8', { status: 'ci_failing' }), q('#2', { status: 'ci_failing' }),
    q('#7', { needs: 'Review requested' }), q('#1', { mine: true, status: 'draft' }),
  ];
  assert.deepEqual(att(list), ['#7', '#2', '#8', '#3', '#9', '#1', '#4', '#10'], 'needs-us, red CI, the rest, drafts; each by number (numeric-aware: #9 before #10)');
  assert.deepEqual(att([...list].reverse()), att(list), 'the input order never matters');
  assert.ok(att([q('#1', { status: 'draft' }), q('#2', { status: 'ci_failing' })])[0] === '#2', 'a draft never outranks a red PR, so noisy draft CI stays at the back');
});

test('attention: every tier in one list, and ended PRs always last', () => {
  const list = [
    q('#1', { status: 'draft' }), q('#2'), q('#3', { status: 'ci_failing' }),
    q('#4', { needs: 'Review requested', createdAt: h2(500) }), q('#5', { status: 're_review', waitingSince: h2(5) }),
    q('#6', { mine: true, status: 'changes_requested', waitingSince: h2(80) }), q('#7', { status: 'merged', ended: true, waitingSince: h2(900) }),
  ];
  assert.deepEqual(att(list), ['#6', '#5', '#4', '#3', '#2', '#1', '#7']);
});

test('waitingDays only speaks for tier 0, and the help text exists for every sort', () => {
  assert.equal(waitingDays(q('#1', { status: 're_review', waitingSince: h2(72) }), NOW2), 3);
  assert.equal(waitingDays(q('#1', { status: 're_review', updatedAt: h2(48) }), NOW2), 2, 'falls back to the last update');
  assert.equal(waitingDays(q('#1', { status: 're_review', updatedAt: null }), NOW2), null);
  assert.equal(waitingDays(q('#1', { needs: 'Review requested', waitingSince: h2(72) }), NOW2), null, 'not in tier 0');
  assert.equal(waitingDays(q('#1', { mine: true, status: 'changes_requested', waitingSince: h2(24) }), NOW2), 1);
  for (const k of Object.keys(SORTS)) assert.ok(SORT_HELP[k], `help for ${k}`);
  assert.equal(compareAttention(q('#1'), q('#1'), NOW2), 0);
});
