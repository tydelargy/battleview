import test from 'node:test';
import assert from 'node:assert/strict';
import { placeGhosts, ghostFiles } from '../web/placement.js';
import { classifyChanges } from '../web/changes.js';
import { buildLayout } from '../web/layout.js';
import { sampleFiles } from '../server/sample.js';

const base = sampleFiles(), B = buildLayout(base);
const add = (prId, path, n = 40) => ({ prId, path, add: n, del: 0, kind: 'added' });
const mv = (prId, path, from, n = 0, d = 0) => ({ prId, path, from, add: n, del: d, kind: 'renamed', fromExists: B.byPath.has(from), toExists: false });
const lay = (rows) => { const extra = ghostFiles(rows, B.byPath), L = buildLayout([...base, ...extra]); for (const l of L.leaves) if (extra.some((e) => e.path === l.path)) l.ghost = true; return { L, extra }; };

test('a new file is as big as the lines it adds; a moved file\'s new plot is as big as the file that moves', () => {
  const from = B.byPath.get('packages/core/domain/tax.ts');
  const f = ghostFiles([add('#1', 'a/new.ts', 300), mv('#2', 'packages/core/new-home/tax.ts', 'packages/core/domain/tax.ts', 12, 4)], B.byPath);
  const n = f.find((x) => x.path === 'a/new.ts'), m = f.find((x) => x.path === 'packages/core/new-home/tax.ts');
  assert.deepEqual([n.loc, n.kind], [300, 'added']); assert.deepEqual([m.loc, m.complexity, m.kind, m.from], [from.loc, from.complexity, 'moved', 'packages/core/domain/tax.ts'], 'a move is the file it moves, not the few lines it edits');
});

test('a path is made room for once, at the biggest size any PR gives it; junk and finished work are ignored', () => {
  const f = ghostFiles([add('#1', 'x/new.ts', 30), add('#2', 'x/new.ts', 500), add('#3', 'x/new.ts', 5), add('#1', 'y.ts', 0), add('#1', 'z.ts', NaN), add('#1', 'w.ts', -9), { prId: '#1', path: 'm.ts', kind: 'modified', add: 9 }, { prId: '#1', path: 'r.ts', kind: 'renamed', toExists: true, from: 'q', add: 1 }, null, { kind: 'added' }]);
  assert.deepEqual(f.map((x) => [x.path, x.loc]), [['w.ts', 1], ['x/new.ts', 500], ['y.ts', 1], ['z.ts', 1]], 'sorted by path; a modified file or a rename onto an existing file needs no plot');
  assert.ok(f.every((x) => x.loc >= 1 && Number.isFinite(x.loc) && x.complexity >= 0)); assert.deepEqual(ghostFiles([]), []); assert.deepEqual(ghostFiles(null), []);
  const unknown = ghostFiles([mv('#1', 'n/new.ts', 'not/on/map.ts', 20, 5)], B.byPath)[0]; assert.deepEqual([unknown.loc, unknown.kind], [25, 'moved'], 'a move whose old home is not on the map is sized by the lines it carries');
});

test('the lot is the new file\'s own plot in the map that has room made for it: a real footprint, in its own district, clear of every real building', () => {
  const rows = [add('#1', 'packages/core/domain/proration.ts', 500), add('#1', 'apps/api/routes/extra.ts', 60), mv('#2', 'packages/core/new-home/tax.ts', 'packages/core/domain/tax.ts')], { L } = lay(rows), { lots } = placeGhosts(L, rows);
  assert.equal(lots.size, 3);
  const big = lots.get('#1|packages/core/domain/proration.ts'), small = lots.get('#1|apps/api/routes/extra.ts'), leaf = L.byPath.get('packages/core/domain/proration.ts');
  assert.deepEqual([big.x, big.y], [leaf.mx, leaf.my]); assert.ok(big.w * big.d > small.w * small.d, 'a bigger file gets a bigger plot, like any other'); assert.equal(big.z0, 0);
  const plate = L.plates.find((p) => p.path === 'packages/core/domain'); assert.ok(big.x >= plate.x && big.x <= plate.x + plate.w && big.y >= plate.y && big.y <= plate.y + plate.h, 'inside its own district');
  for (const lot of lots.values()) for (const l of L.leaves) { if (l.ghost) continue; assert.ok(Math.abs(lot.x - l.mx) >= (lot.w + l.r.w) / 2 - 0.01 || Math.abs(lot.y - l.my) >= (lot.d + l.r.h) / 2 - 0.01, `${l.path} overlaps a plot`); }
});

test('FLAT AND FAIR: the layout depends only on which PRs are tracked, never on order, focus or anything you look at', () => {
  const rows = [add('#2', 'apps/web/pages/a.tsx', 80), add('#1', 'apps/web/pages/b.tsx', 120), mv('#3', 'apps/web/new/Modal.tsx', 'apps/web/components/Modal.tsx')];
  const a = lay(rows), b = lay([...rows].reverse());
  assert.deepEqual(a.extra, b.extra, 'the files to make room for do not depend on the order PRs arrive in');
  assert.deepEqual(a.L.leaves.map((l) => [l.path, l.x, l.y, l.w, l.h]), b.L.leaves.map((l) => [l.path, l.x, l.y, l.w, l.h]), 'so neither does a single building');
  const solo = lay([rows[0]]).L, all = a.L;
  assert.notDeepEqual(solo.byPath.get('apps/web/pages/a.tsx').x + solo.byPath.get('apps/web/pages/a.tsx').y, all.byPath.get('apps/web/pages/a.tsx').x + all.byPath.get('apps/web/pages/a.tsx').y, 'tracking another PR with new files DOES move things: that is a change of state, and the only thing that does');
});

test('every ghost leaf is placed; only ghost leaves get lots; an empty or odd input is safe', () => {
  const rows = [add('#1', 'packages/core/domain/in.ts'), add('#2', 'packages/core/domain/out.ts')], { L } = lay([rows[0]]), { lots } = placeGhosts(L, rows);
  assert.equal(lots.size, 1); assert.ok(lots.has('#1|packages/core/domain/in.ts'));
  assert.equal(placeGhosts(L, []).lots.size, 0); assert.equal(placeGhosts({ byPath: new Map() }, rows).lots.size, 0); assert.equal(placeGhosts({}, rows).lots.size, 0); assert.equal(placeGhosts(null, null).lots.size, 0);
  assert.equal(placeGhosts(L, [add('#9', 'packages/core/domain/in.ts'), add('#1', 'packages/core/domain/in.ts')]).lots.size, 2, 'two PRs adding the same file share one plot');
});

test('a repo full of new folders and many files still places every one (the layout never drops a file)', () => {
  const rows = Array.from({ length: 150 }, (_, i) => add(`#${i % 5}`, `new${i % 40}/dir${i % 9}/f${i}.ts`, 10 + i)), { L } = lay(rows), { lots } = placeGhosts(L, rows);
  assert.equal(lots.size, 150); for (const lot of lots.values()) assert.ok(lot.w > 0 && lot.d > 0 && Number.isFinite(lot.x + lot.y));
  assert.equal(L.leaves.length, base.length + new Set(rows.map((r) => r.path)).size);
});

test('through the classification the scene uses: new files and move-ins get plots, edits to existing files do not', () => {
  const prs = [{ id: '#7', files: [{ path: 'infra/terraform/new.tf', add: 90, del: 0, change: 'added' }, { path: 'docs/guides/more/deep/x.md', add: 10, del: 0 }, { path: 'infra/terraform/vpc.tf', add: 3, del: 1 }, { path: 'infra/moved/ecs.tf', add: 0, del: 0, change: 'renamed', from: 'infra/terraform/ecs.tf' }] }];
  const want = classifyChanges(prs, B.byPath).filter((r) => r.kind === 'added' || (r.kind === 'renamed' && !r.toExists)); assert.equal(want.length, 3);
  const { L } = lay(want); assert.ok(want.every((r) => placeGhosts(L, want).lots.has(`${r.prId}|${r.path}`)));
});
