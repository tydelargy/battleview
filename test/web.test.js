import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLayout, WORLD } from '../web/layout.js';
import { diffHeight, SCALES, placeColumns, columnParts, planSpires } from '../web/spires.js';
import { sampleFiles } from '../server/sample.js';
import { normalisePRs } from '../server/snapshot.js';
import { samplePRs } from '../server/sample.js';

const files = sampleFiles();
const L = buildLayout(files);
const overlap = (a, b) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

test('layout: every file placed, inside the world, no overlaps', () => {
  assert.equal(L.leaves.length, files.length);
  for (const l of L.leaves) { assert.ok(l.x >= -1e-6 && l.y >= -1e-6 && l.x + l.w <= WORLD.w + 1e-6 && l.y + l.h <= WORLD.h + 1e-6); assert.ok(l.r.w > 0 && l.r.h > 0); }
  for (let i = 0; i < L.leaves.length; i++) for (let j = i + 1; j < L.leaves.length; j++) assert.ok(!overlap(L.leaves[i], L.leaves[j]), `${L.leaves[i].path} overlaps ${L.leaves[j].path}`);
});

test('layout: deterministic and independent of input order', () => {
  const shuffled = buildLayout([...files].reverse());
  const key = (lay) => lay.leaves.map((l) => `${l.path}:${l.x.toFixed(3)},${l.y.toFixed(3)},${l.w.toFixed(3)},${l.h.toFixed(3)}`).sort().join('|');
  assert.equal(key(L), key(shuffled));
});

test('layout: area is proportional to LOC among siblings', () => {
  const sibs = L.leaves.filter((l) => l.path.startsWith('packages/core/domain/'));
  const per = sibs.map((l) => (l.w * l.h) / l.loc);
  assert.ok(Math.max(...per) / Math.min(...per) < 1.0001, 'cells share one scale');
  const big = sibs.find((l) => l.name === 'pricing.ts'), small = sibs.find((l) => l.name === 'inventory.ts');
  assert.ok(big.w * big.h > small.w * small.h);
});

test('layout: single-child folders collapse; unknown repos work', () => {
  const l = buildLayout([{ path: 'a/b/c/x.ts', loc: 10 }, { path: 'a/b/c/y.ts', loc: 30 }, { path: 'README.md', loc: 5 }]);
  assert.ok(l.plates.some((p) => p.name === 'a/b/c'));
  assert.equal(l.leaves.length, 3);
  assert.equal(buildLayout([]).leaves.length, 0);
});

test('spire height is monotonic in diff size for every scale', () => {
  for (const mode of Object.keys(SCALES)) {
    let prev = 0;
    for (const n of [1, 5, 20, 100, 400, 1000]) { const h = diffHeight(n, mode); assert.ok(h > prev, `${mode} ${n}`); prev = h; }
    assert.equal(diffHeight(0, mode), 0);
  }
  assert.ok(diffHeight(730, 'sqrt') > 25 && diffHeight(730, 'sqrt') < 40);
});

test('columns stay on their roof and do not overlap each other', () => {
  const roof = { x: 10, y: 20, w: 24, h: 9 };
  for (let n = 1; n <= 9; n++) {
    const cs = placeColumns(roof, n);
    assert.equal(cs.length, n);
    for (const c of cs) { assert.ok(c.x - c.side / 2 >= roof.x - 1e-9 && c.x + c.side / 2 <= roof.x + roof.w + 1e-9 && c.y - c.side / 2 >= roof.y - 1e-9 && c.y + c.side / 2 <= roof.y + roof.h + 1e-9, `n=${n}`); }
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) assert.ok(Math.abs(cs[i].x - cs[j].x) >= cs[i].side - 1e-9 || Math.abs(cs[i].y - cs[j].y) >= cs[i].side - 1e-9, `overlap n=${n}`);
  }
});

test('focus mode accounts for every added and deleted line, green and red', () => {
  const { prs } = normalisePRs(samplePRs());
  const pr = prs.find((p) => p.id === '#2291');
  const entry = { pr, f: pr.files[0] };       // pricing.ts +420 -310
  const over = columnParts(entry, 'sqrt', false);
  const focus = columnParts(entry, 'sqrt', true);
  assert.equal(over.parts.length, 1);
  assert.ok(focus.parts.length > 3);
  const sum = (k) => focus.parts.filter((p) => p.kind === k).reduce((a, p) => a + p.n, 0);
  assert.equal(sum('add'), 420); assert.equal(sum('del'), 310);
  // Heights are proportional to lines, so green and red are comparable.
  const gh = focus.parts.filter((p) => p.kind === 'add').reduce((a, p) => a + p.h, 0), rh = focus.parts.filter((p) => p.kind === 'del').reduce((a, p) => a + p.h, 0);
  assert.ok(Math.abs(gh / rh - 420 / 310) < 1e-6);
  // Same overall height as the overview column, give or take the seams.
  assert.ok(Math.abs(focus.total - over.total) < 0.12 * focus.parts.length + 1e-6, `${focus.total} vs ${over.total}`);
  // Parts stack without overlapping.
  for (let i = 1; i < focus.parts.length; i++) assert.ok(focus.parts[i].dz >= focus.parts[i - 1].dz + focus.parts[i - 1].h - 1e-9);
});

test('planSpires: one column per PR per file, contested files get several, focus dims the rest', () => {
  const { prs } = normalisePRs(samplePRs());
  const cols = planSpires({ byPath: L.byPath, prs, mode: 'sqrt' });
  assert.equal(cols.length, prs.reduce((a, p) => a + p.files.length, 0));
  const pricing = cols.filter((c) => c.path === 'packages/core/domain/pricing.ts');
  assert.equal(pricing.length, 2);
  assert.ok(pricing[0].x !== pricing[1].x || pricing[0].y !== pricing[1].y);
  assert.ok(cols.every((c) => c.z0 === L.byPath.get(c.path).height && c.total > 0));
  const foc = planSpires({ byPath: L.byPath, prs, mode: 'sqrt', focusId: '#2291' });
  assert.ok(foc.filter((c) => c.prId === '#2291').every((c) => c.focused && !c.dimmed));
  assert.ok(foc.filter((c) => c.prId !== '#2291').every((c) => c.dimmed && c.parts.length === 1));
  const vis = planSpires({ byPath: L.byPath, prs, visible: new Set(['#2291']) });
  assert.equal(vis.length, 4);
  // taller diff, taller spire
  const a = cols.find((c) => c.prId === '#2291' && c.path.endsWith('pricing.ts')), b = cols.find((c) => c.prId === '#2311' && c.path.endsWith('pricing.ts'));
  assert.ok(a.total > b.total);
});

import { packRoof, coverage, MIN_COVER } from '../web/spires.js';
test('packRoof tiles shared roofs without overlap and coverage has a floor', () => {
  const r = { x: 0, y: 0, w: 20, h: 10 };
  const m = packRoof(r, [{ key: 'a', weight: 0.5 }, { key: 'b', weight: 0.3 }]);
  const [a, b] = [m.get('a'), m.get('b')];
  assert.ok(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 - 1e-6 || Math.abs(a.y - b.y) >= (a.d + b.d) / 2 - 1e-6);
  assert.ok(a.w * a.d > b.w * b.d);
  assert.equal(coverage(1, 1000), MIN_COVER);
  assert.equal(coverage(2000, 1000), 1);
});

// A district's padding and name room are fixed sizes, so in a small district they used to be bigger than the district and swallowed
// every file in it: a repo with 3,000 files in 600 folders came out with no buildings at all.
const manyFolders = (files, dirs, depth = 2) => Array.from({ length: files }, (_, i) => ({ path: `${Array.from({ length: depth }, (_, d) => `${'dsx'[d % 3]}${Math.floor(i / (d ? 1 : 1)) % (d ? 7 : dirs)}`).join('/')}/f${i}.ts`, loc: 5 + ((i * 7919) % 700), complexity: i % 30 }));
test('layout: every file gets a place however many folders there are', () => {
  for (const [files, dirs, depth] of [[500, 100, 2], [3000, 600, 2], [6000, 2000, 2], [2000, 300, 4], [6000, 60, 2], [300, 300, 1], [1000, 1000, 3]]) {
    const F = manyFolders(files, dirs, depth), L = buildLayout(F);
    assert.equal(L.leaves.length, files, `${files} files in ${dirs} folders (depth ${depth}): ${L.leaves.length} placed`);
    for (const l of L.leaves) { assert.ok(l.r.w > 0 && l.r.h > 0 && Number.isFinite(l.mx + l.my), 'a real footprint'); assert.ok(l.x >= -1e-6 && l.y >= -1e-6 && l.x + l.w <= WORLD.w + 1e-6 && l.y + l.h <= WORLD.h + 1e-6, 'inside the world'); }
  }
});
test('layout: tiny folders beside a huge one, and a lone file in a lone folder, are all placed', () => {
  const skew = [{ path: 'big/a.ts', loc: 200000 }, ...Array.from({ length: 40 }, (_, i) => ({ path: `tiny${i}/x.ts`, loc: 3 }))]; assert.equal(buildLayout(skew).leaves.length, 41);
  assert.equal(buildLayout([{ path: 'only/one.ts', loc: 1 }]).leaves.length, 1); assert.equal(buildLayout([{ path: 'a/b/c/d/e/f/g/h.ts', loc: 1 }, { path: 'z.ts', loc: 100000 }]).leaves.length, 2);
});
test('layout: files in small folders do not overlap, and the layout stays the same for the same files in any order', () => {
  const F = manyFolders(400, 80, 2), L = buildLayout(F), R = buildLayout([...F].reverse()), ls = L.leaves;
  assert.deepEqual(L.leaves.map((l) => [l.path, l.x, l.y, l.w, l.h]), R.leaves.map((l) => [l.path, l.x, l.y, l.w, l.h]), 'order of input does not matter');
  for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) { const a = ls[i].r, b = ls[j].r; assert.ok(a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6, `${ls[i].path} overlaps ${ls[j].path}`); }
});
