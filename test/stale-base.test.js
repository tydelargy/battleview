// What the map does TODAY with PRs whose base is not the default branch's head (acme/storefront in the demo). These tests record the
// current behaviour, wrong parts included, so that fixing it is a visible, deliberate change here. Lines marked WRONG are misreadings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { demoProvider } from '../server/demo.js';
import { classifyChanges } from '../web/changes.js';
import { buildLayout } from '../web/layout.js';
import { ghostFiles } from '../web/placement.js';

const ref = { owner: 'acme', name: 'storefront' }, d = demoProvider();
const { files } = await d.tree(ref), { prs } = await d.prs(ref), B = buildLayout(files);
const rows = classifyChanges(prs, B.byPath), of = (n) => rows.filter((r) => r.prId === `#${n}`), kinds = (n) => of(n).map((r) => `${r.kind}:${r.path}`);

test('the cases exist and say what GitHub would know about each base', () => {
  assert.equal(prs.length, 11); assert.ok(prs.every((p) => p.base?.ref && p.base.mergeState));
  assert.deepEqual(prs.filter((p) => p.base.ref !== 'main').map((p) => p.number), [308, 310], 'a release branch and a stacked PR');
});

test('control: an up-to-date PR reads right', () => { assert.deepEqual(kinds(300), ['modified:src/catalog/Product.tsx']); });

test('main moved a folder: edits of its files read as NEW files in a folder that no longer exists (WRONG)', () => {
  assert.deepEqual(kinds(301), ['added:src/cart/Cart.tsx', 'added:src/cart/totals.ts']);
  assert.equal(of(302).filter((r) => r.kind === 'added').length, 5, 'WRONG: 4 edits + 1 real new file, all drawn as new');
  const g = ghostFiles(rows, B.byPath).filter((x) => x.path.startsWith('src/cart/'));
  assert.equal(g.length, 5, 'WRONG: five phantom plots, which the layout makes room for, so a dead src/cart district appears and reshapes the map');
  assert.ok(!B.byPath.has('src/cart/Cart.tsx') && B.byPath.has('src/checkout/cart/Cart.tsx'), 'the real building has no column');
});

test('main deleted a file the PR edits: a NEW file (WRONG)', () => { assert.equal(of(303)[0].kind, 'added'); });

test('the PR deletes a file main already moved: the deletion vanishes (WRONG, silent)', () => { assert.deepEqual(kinds(304), ['modified:src/lib/http.ts']); });

test('competing and converging moves', () => {
  const [a] = of(305); assert.deepEqual([a.kind, a.fromExists, a.toExists], ['renamed', false, false], 'main moved promo.ts elsewhere: a frame with no old building and no arc (WRONG: it is a conflict)');
  const [b] = of(306); assert.deepEqual([b.kind, b.fromExists, b.toExists], ['renamed', false, true], 'main already made the same move: nothing to build; the file just sits there');
});

test('both sides added the same file: an edit, not a conflict (WRONG)', () => { assert.deepEqual(kinds(307), ['modified:src/lib/money.ts', 'modified:src/checkout/Payment.tsx']); });

test('another base: a release branch\'s own files look like new files on main (WRONG)', () => {
  assert.deepEqual(kinds(308), ['modified:src/catalog/search.ts', 'added:src/catalog/v2/search.ts', 'added:src/catalog/v2/index.ts']);
});

test('a stacked PR: its parent\'s new file is a new file for it too, so the two share one plot (the map cannot tell stacked from competing)', () => {
  assert.equal(of(309).find((r) => r.path === 'src/catalog/filters.ts').kind, 'added'); assert.equal(of(310).find((r) => r.path === 'src/catalog/filters.ts').kind, 'added');
  assert.equal(ghostFiles(rows, B.byPath).filter((x) => x.path === 'src/catalog/filters.ts').length, 1);
});

test('the same file under two names is not seen as contested: #301 edits src/cart/Cart.tsx, the building is src/checkout/cart/Cart.tsx', () => {
  const byPath = new Map(); for (const r of rows) if (r.kind === 'modified') byPath.set(r.path, (byPath.get(r.path) || 0) + 1);
  assert.ok(![...byPath.keys()].some((p) => p.includes('cart/Cart.tsx')), 'WRONG: nobody is on the real Cart.tsx, though three PRs mean to change it');
});
