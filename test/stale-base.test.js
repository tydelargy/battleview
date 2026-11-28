// PRs on old or different bases (acme/storefront in the demo): which map each is drawn on, and how.
//   master  up to date, or behind with no conflict: the latest default branch, edits put where main moved the files, ghost shells for the old places
//   base    stacked or aimed at another branch (forced), or behind with a conflict and the viewer asked for it: the PR's own base
//   blind   behind, and what main changed is too long to read: nothing drawn, only a message
import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProvider } from '../server/demo.js';
import { normalisePRs, withBaseFacts } from '../server/snapshot.js';
import { viewPlan, forMaster, staleFiles, CHOICES } from '../web/baseview.js';
import { classifyChanges } from '../web/changes.js';
import { buildLayout } from '../web/layout.js';

const ref = { owner: 'acme', name: 'storefront' }, d = demoProvider();
const { files } = await d.tree(ref), B = buildLayout(files);
const prs = withBaseFacts(normalisePRs((await d.prs(ref)).prs).prs, 'main'), pr = (n) => prs.find((p) => p.number === n);
const plan = (n, c) => viewPlan(pr(n), c), mine = (n) => forMaster(pr(n), B.byPath), rows = (n) => classifyChanges([mine(n)], B.byPath).map((r) => `${r.kind}:${r.path}`);

test('which map: up to date or behind-but-clean lives on master, with no choice', () => {
  for (const n of [300, 309, 311]) { const p = plan(n); assert.deepEqual([p.mode, p.forced, p.choices, p.at], ['master', false, null, null], `#${n}`); }
  assert.deepEqual(viewPlan({ id: '#1' }), { mode: 'master', forced: false, choices: null, at: null }, 'no base information: as ever');
});

test('which map: a stacked PR, or one aimed at another branch, is ALWAYS drawn on its own base, and cannot be switched', () => {
  const s = plan(310, 'master'); assert.deepEqual([s.mode, s.forced, s.choices, s.at], ['base', true, null, 'you/filters'], 'whatever the viewer asked for'); assert.match(s.detail, /stacked on #309/); assert.match(s.headline, /own base/);
  assert.equal(plan(310, 'own').mode, 'base'); assert.equal(plan(310, 'anything').at, 'you/filters');
  const r = plan(308); assert.deepEqual([r.mode, r.forced, r.at], ['base', true, 'release/2.x']); assert.match(r.detail, /not the default branch/);
});

test('which map: behind with a conflict gives the viewer a choice, master (with ghost shells) first', () => {
  for (const n of [301, 302, 303, 304, 305, 306, 307]) {
    const m = plan(n); assert.deepEqual([m.mode, m.forced, m.choices, m.at], ['master', false, CHOICES, null], `#${n} starts on master`);
    const o = plan(n, 'own'); assert.deepEqual([o.mode, o.forced], ['base', false]); assert.equal(o.at, pr(n).base.mergeBase); assert.match(o.at, /^[0-9a-f]{40}$/); assert.match(o.detail, /commits? behind main/);
  }
  const nomb = { ...pr(301), base: { ...pr(301).base, mergeBase: undefined } }; assert.deepEqual([viewPlan(nomb, 'own').mode, viewPlan(nomb).choices], ['master', null], 'without a branch point there is nothing to choose');
});

test('which map: behind and too much to read (list cut, or not read at all) draws nothing and says so, tracked as ever', () => {
  const b = plan(312); assert.deepEqual([b.mode, b.forced, b.at, b.choices], ['blind', true, null, null]); assert.equal(b.headline, 'This PR can not be visualized'); assert.match(b.detail, /900 commits behind main/); assert.match(b.detail, /too long to read/); assert.match(b.detail, /still tracked/);
  const u = viewPlan({ id: '#9', base: { ref: 'main', behind: 3, mergeable: 'MERGEABLE', sinceUnknown: true } }); assert.equal(u.mode, 'blind'); assert.match(u.detail, /could not be read/);
  assert.equal(viewPlan({ id: '#9', base: { ref: 'main', behind: 3, sinceCut: true, mergeable: 'MERGEABLE' } }).mode, 'blind', 'clean or not: a cut list is a guess');
  assert.equal(viewPlan({ id: '#9', base: { ref: 'main', behind: 0, sinceCut: true } }).mode, 'master', 'up to date: nothing to read');
  assert.equal(viewPlan({ id: '#9', base: { ref: 'x', onDefault: false, behind: 4, sinceCut: true } }).mode, 'base', 'another branch is drawn on that branch even when far behind');
  assert.equal(viewPlan({ id: '#9', base: { ref: 'main', behind: 3 } }).mode, 'master', 'a PR that merges and has no cut list is plain master');
});

test('master: main moved the folder, so the edits stand on the real buildings and the old places are ghosts; nothing is a phantom "new file"', () => {
  assert.deepEqual(rows(301), ['modified:src/checkout/cart/Cart.tsx', 'modified:src/checkout/cart/totals.ts']);
  assert.deepEqual(mine(301).stale.map((s) => [s.path, s.kind, s.to]), [['src/cart/Cart.tsx', 'moved', 'src/checkout/cart/Cart.tsx'], ['src/cart/totals.ts', 'moved', 'src/checkout/cart/totals.ts']]);
  assert.deepEqual(rows(302), ['modified:src/checkout/cart/Cart.tsx', 'modified:src/checkout/cart/CartItem.tsx', 'modified:src/checkout/cart/totals.ts', 'modified:src/checkout/cart/promo.ts', 'added:src/cart/Coupons.tsx'], 'the one genuinely new file is still new');
  assert.equal(mine(302).stale.length, 4);
  assert.deepEqual(rows(311), ['modified:src/checkout/cart/promo.ts', 'modified:src/account/Login.tsx'], 'behind but clean: the same, and the file main deleted is only a ghost');
  assert.deepEqual(mine(311).stale.map((s) => [s.path, s.kind]), [['src/cart/promo.ts', 'moved'], ['src/legacy/oldCheckout.ts', 'removed']]);
});

test('master: a file main deleted is a ghost, not a new file; a file both sides deleted shows nothing', () => {
  assert.deepEqual(rows(303), ['modified:src/checkout/Checkout.tsx']); assert.deepEqual(mine(303).stale.map((s) => [s.path, s.kind, s.add, s.del]), [['src/legacy/oldCheckout.ts', 'removed', 18, 7]]);
  const both = forMaster({ id: '#1', files: [{ path: 'gone.ts', add: 0, del: 9, change: 'removed', since: { change: 'removed' } }] }, B.byPath); assert.deepEqual([both.files, both.stale], [[], []]);
});

test('master: the PR deletes a file main moved: the building at its new home is condemned, the old place a ghost; moves follow main', () => {
  assert.deepEqual(rows(304), ['removed:src/lib/format.ts', 'modified:src/lib/http.ts']); assert.deepEqual(mine(304).stale.map((s) => s.path), ['src/utils/format.ts']);
  const c = classifyChanges([mine(305)], B.byPath)[0]; assert.deepEqual([c.kind, c.from, c.fromExists, c.toExists], ['renamed', 'src/checkout/cart/promo.ts', true, false], 'a competing move starts from where the building is now');
  assert.deepEqual(rows(306), ['modified:src/lib/format.ts'], 'the same move main already made: nothing to build, nothing wrong');
});

test('master: a file main changed too is marked as a conflict candidate; the PR is otherwise untouched; inputs are never mutated', () => {
  assert.equal(mine(303).files.find((f) => f.path === 'src/checkout/Checkout.tsx').conflict, true); assert.equal(mine(307).files.find((f) => f.path === 'src/lib/money.ts').conflict, true, 'both added it');
  assert.equal(mine(300).files[0].conflict, undefined); assert.deepEqual(mine(300).files, pr(300).files);
  const before = JSON.stringify(pr(301)); mine(301); assert.equal(JSON.stringify(pr(301)), before);
  assert.deepEqual(forMaster({ id: '#2', files: [{ path: 'a', add: 1, del: 0, since: { change: 'moved', to: 'src/lib/http.ts' } }, { path: 'b', add: 2, del: 1, since: { change: 'moved', to: 'src/lib/http.ts' } }] }, B.byPath).files.map((f) => [f.path, f.add, f.del]), [['src/lib/http.ts', 3, 1]], 'two files moved into one place: one column');
  assert.deepEqual(forMaster({ id: '#2', files: [{ path: 'a', add: 1, del: 0, since: { change: 'moved', to: 'not/on/the/map.ts' } }] }, B.byPath).stale.map((s) => s.kind), ['removed'], 'moved somewhere we cannot see: treated as gone');
});

test('the layout makes room for every old place, sized by the lines the PR touches there, and never for a place that exists', () => {
  const all = prs.filter((p) => viewPlan(p).mode === 'master').map((p) => forMaster(p, B.byPath)), f = staleFiles(all, B.byPath);
  assert.deepEqual(f.map((x) => x.path), ['src/cart/CartItem.tsx', 'src/cart/Cart.tsx', 'src/cart/promo.ts', 'src/cart/totals.ts', 'src/legacy/oldCheckout.ts', 'src/utils/format.ts'].sort());
  assert.ok(f.every((x) => x.kind === 'stale' && x.loc >= 12 && Number.isFinite(x.complexity))); assert.ok(f.find((x) => x.path === 'src/cart/Cart.tsx').loc >= 180, 'the biggest touch of that file in any PR');
  assert.deepEqual(staleFiles([{ stale: [{ path: 'src/lib/http.ts', add: 5, del: 5 }] }], B.byPath), [], 'it exists: no ghost'); assert.deepEqual(staleFiles(null, B.byPath), []);
  const L = buildLayout([...files, ...f]); assert.equal(L.leaves.length, files.length + f.length, 'every one has a place');
  assert.equal(JSON.stringify(buildLayout([...files, ...[...f].reverse()]).leaves.map((l) => [l.path, l.x, l.y])), JSON.stringify(L.leaves.map((l) => [l.path, l.x, l.y])), 'and the order it arrives in changes nothing');
});
