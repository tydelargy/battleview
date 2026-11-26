import test from 'node:test';
import assert from 'node:assert/strict';
import { craneParts, tapeFloor, scaffoldParts, siteParts, lineBands, FLOOR_H, MAX_FLOORS } from '../web/sites.js';
import { buildLayout } from '../web/layout.js';
import { buildingFor, DEFAULT_STYLE } from '../web/building.js';
import { planSpires } from '../web/spires.js';
import { sampleFiles } from '../server/sample.js';

const SLOT = { x: 50, y: 30, w: 12, d: 6 };
const inside = (p, r, e = 1e-6) => p.x - p.w / 2 >= r.x - r.w / 2 - e && p.x + p.w / 2 <= r.x + r.w / 2 + e && p.y - p.d / 2 >= r.y - r.d / 2 - e && p.y + p.d / 2 <= r.y + r.d / 2 + e;

const height = (n) => 1.15 * Math.sqrt(n);
const top = (parts) => Math.max(...parts.filter((p) => !p.diag).map((p) => p.z + p.h));
const bbox = (parts) => { const q = parts.filter((p) => p.tone !== 'pad'), xs = q.flatMap((p) => [p.x - p.w / 2, p.x + p.w / 2]), ys = q.flatMap((p) => [p.y - p.d / 2, p.y + p.d / 2]); return { w: Math.max(...xs) - Math.min(...xs), d: Math.max(...ys) - Math.min(...ys) }; };

test('a crane is exactly as tall as the diff scale says, wherever it stands', () => {
  for (const slot of [SLOT, { x: 10, y: 10, w: 4, d: 9 }, { x: 0, y: 0, w: 1.2, d: 1.2 }, { x: 0, y: 0, w: 90, d: 60 }]) for (const h of [3.4, 11.5, 23]) {
    const parts = craneParts(slot, 20, h);
    assert.ok(Math.abs(top(parts) - (20 + h)) < 1e-9, `height ${top(parts) - 20} for ${h}`);
    assert.ok(parts.every((p) => p.z >= 20 - 1e-9 && p.h > 0));
    assert.ok(parts.some((p) => p.tone === 'status') && parts.some((p) => p.tone === 'statusDark') && parts.some((p) => p.tone === 'pad'));
  }
});

test('the crane is one model scaled by the diff, never by the roof: same lines, same crane on any slot', () => {
  const a = craneParts({ x: 0, y: 0, w: 4, d: 4 }, 0, 6), b = craneParts({ x: 0, y: 0, w: 80, d: 50 }, 0, 6);
  assert.deepEqual(bbox(a), bbox(b), 'the pad changes with the file, the crane does not');
  const small = bbox(craneParts({ x: 0, y: 0, w: 60, d: 40 }, 0, 3.4)), big = bbox(craneParts({ x: 0, y: 0, w: 5, d: 4 }, 0, 23));
  assert.ok(big.w > small.w * 3, 'a 400-line crane on a tiny roof is still much bigger than a 9-line crane on a huge one');
  let last = 0; for (const h of [2, 5, 10, 20, 30]) { const w = bbox(craneParts(SLOT, 0, h)).w; assert.ok(w > last, 'bigger diff, bigger crane'); last = w; }
});

test('the pad is the share of the file, and flat', () => {
  const pad = craneParts({ x: 5, y: 5, w: 14, d: 7 }, 10, 8).find((p) => p.tone === 'pad');
  assert.deepEqual([pad.w, pad.d, pad.z], [14, 7, 10]); assert.ok(pad.h < 0.5);
});

test('the jib runs along the longer side of the slot', () => {
  const wide = craneParts({ x: 0, y: 0, w: 12, d: 4 }, 0, 10).filter((p) => p.tone === 'status').sort((a, b) => b.w - a.w)[0];
  const deep = craneParts({ x: 0, y: 0, w: 4, d: 12 }, 0, 10).filter((p) => p.tone === 'status').sort((a, b) => b.d - a.d)[0];
  assert.ok(wide.w > wide.d * 3 && deep.d > deep.w * 3);
});

test('a taped floor is an open frame: slab, four posts, a rail and an X on every face', () => {
  const slot = { x: 5, y: 5, w: 10, d: 8 }, parts = tapeFloor(slot, 30, 3);
  assert.equal(parts.filter((p) => p.tone === 'floor').length, 1);
  assert.equal(parts.filter((p) => p.tone === 'post').length, 4);
  assert.equal(parts.filter((p) => p.tone === 'tape' && !p.diag).length, 4, 'the rail');
  const diags = parts.filter((p) => p.diag);
  assert.equal(diags.length, 8, 'two diagonals on each of four faces');
  assert.equal(diags.filter((p) => p.angle > 0).length, 4); assert.equal(diags.filter((p) => p.angle < 0).length, 4, 'they cross');
  for (const p of parts.filter((q) => !q.diag)) assert.ok(inside(p, slot, 0.2) && p.z >= 30 - 1e-9 && p.z + p.h <= 33 + 1e-9);
  for (const p of diags) assert.ok(p.z > 30 && p.z < 33 && p.len > 0 && (p.along === 'x' || p.along === 'y'));
});

test('scaffolding wraps the footprint from the ground to the top, with the top ring in the PR colour', () => {
  const parts = scaffoldParts({ x: 10, y: 10, w: 30, h: 20 }, 16);
  assert.ok(parts.filter((p) => !p.diag).every((p) => p.x - p.w / 2 >= 10 - 1 && p.x + p.w / 2 <= 41 && p.y - p.d / 2 >= 10 - 1 && p.y + p.d / 2 <= 31), 'outside the wall by a margin, not wandering');
  assert.ok(parts.filter((p) => p.tone === 'add' && p.z === 0 && p.h > 16 * 0.9 && p.h < 16).length >= 8, 'poles go nearly all the way up, stopping inside the top ring');
  assert.ok(parts.some((p) => p.tone === 'status' && Math.abs(p.z + p.h - 16) < 1e-9), 'and the top ring ends exactly at the top');
  assert.ok(parts.some((p) => p.tone === 'status') && Math.max(...parts.filter((p) => !p.diag).map((p) => p.z + p.h)) <= 16 + 1e-6)
  assert.ok(parts.filter((p) => p.diag).every((p) => p.z > 0 && p.z < 16 && p.tone === 'add'), 'braces sit between the ground and the top');
  assert.ok(scaffoldParts({ x: 0, y: 0, w: 900, h: 900 }, 60).length < 250, 'bounded however big the building');
});

const column = (o = {}) => ({ x: 20, y: 20, w: 8, d: 5, z0: 12, total: 9, parts: [{ dz: 0, h: 9, kind: 'pr' }], add: 40, del: 6, focused: false, ...o });
const SHELL = { rect: { x: 10, y: 10, w: 20, h: 15 }, h: 12 };
const floors = (parts) => parts.filter((p) => p.tone === 'floor').length;
test('overview: a crane as tall as the additions, on one taped floor per FLOOR_H of deletions', () => {
  const both = siteParts(column({ add: 100, del: 30 }), SHELL, { heightOf: height });
  assert.ok(both.parts.some((p) => p.tone === 'status') && both.parts.some((p) => p.tone === 'tape') && !both.parts.some((p) => p.tone === 'add'));
  const nf = floors(both.parts); assert.equal(nf, Math.round(height(30) / FLOOR_H));
  assert.ok(Math.abs(both.top - (12 + nf * FLOOR_H + height(100))) < 1e-9, 'floors, then a crane of exactly the additions');
  const only = siteParts(column({ del: 0 }), SHELL, { heightOf: height }); assert.equal(floors(only.parts), 0); assert.ok(Math.abs(only.top - (12 + height(40))) < 1e-9);
  const del = siteParts(column({ add: 0, del: 30 }), SHELL, { heightOf: height }); assert.ok(del.parts.some((p) => p.tone === 'tape') && !del.parts.some((p) => p.tone === 'status'), 'pure deletion: just the floors');
  assert.equal(floors(siteParts(column({ del: 1 }), SHELL, { heightOf: height }).parts), 1, 'any deletion is at least one floor');
  assert.equal(floors(siteParts(column({ del: 1e6 }), SHELL, { heightOf: height }).parts), MAX_FLOORS, 'and there is a ceiling');
});

test('the same lines are the same size in every column: two columns with 9 added lines match, however big their files and roofs', () => {
  const a = siteParts(column({ add: 9, del: 0, w: 3, d: 3 }), SHELL, { heightOf: height }), b = siteParts(column({ add: 9, del: 0, w: 70, d: 40 }), SHELL, { heightOf: height });
  assert.equal(a.top, b.top); assert.deepEqual(bbox(a.parts), bbox(b.parts));
  assert.ok(siteParts(column({ add: 400, del: 0, w: 3, d: 3 }), SHELL, { heightOf: height }).top - 12 > (a.top - 12) * 4, 'and 400 lines stand several times taller than 9');
});

test('focused, facade style: scaffolding as tall as the additions, floors for the deleting hunks, no crane', () => {
  const parts = [{ dz: 0, h: 3, kind: 'add', n: 30 }, { dz: 3, h: 1, kind: 'del', n: 4 }, { dz: 4, h: 2, kind: 'add', n: 10 }, { dz: 6, h: 1, kind: 'del', n: 150 }];
  const s = siteParts(column({ focused: true, parts, add: 40, del: 154 }), SHELL, { heightOf: height, focusStyle: 'facade' });
  assert.ok(s.parts.some((p) => p.tone === 'add') && !s.parts.some((p) => p.tone === 'statusDark'), 'scaffolding, no crane');
  assert.equal(floors(s.parts), 1 + Math.round(height(150) / FLOOR_H), 'a 4-line hunk is one floor, a 150-line hunk several');
  const tops = s.parts.filter((p) => p.tone === 'floor').map((p) => p.z); assert.ok(tops[0] === 12 && tops.every((z, i) => !i || z > tops[i - 1]), 'stacked on the roof');
  const scaf = s.parts.filter((p) => (p.tone === 'add' || p.tone === 'status') && !p.diag), tall = Math.max(...scaf.map((p) => p.z + p.h));
  assert.ok(Math.abs(tall - Math.min(SHELL.h, height(40))) < 1e-6, 'as tall as 40 added lines, up to the walled part');
  const huge = siteParts(column({ focused: true, add: 5000, del: 0, parts: [{ dz: 0, h: 5, kind: 'add', n: 5000 }] }), SHELL, { heightOf: height, focusStyle: 'facade' });
  assert.ok(Math.max(...huge.parts.filter((p) => (p.tone === 'add' || p.tone === 'status') && !p.diag).map((p) => p.z + p.h)) <= SHELL.h + 1e-6, 'never past the walled part');
  const small = siteParts(column({ focused: true, add: 2, del: 0, parts: [{ dz: 0, h: 1, kind: 'add', n: 2 }] }), SHELL, { heightOf: height, focusStyle: 'facade' });
  assert.ok(Math.max(...small.parts.filter((p) => (p.tone === 'add' || p.tone === 'status') && !p.diag).map((p) => p.z + p.h)) >= 2 - 1e-6, 'a tiny change still gets a visible scaffold');
});

test('crates and rubble: additions left, deletions right, one layer per level, as solid stacks', () => {
  const col = column({ focused: true, add: 420, del: 310, w: 12, d: 6, parts: [] }), lv = (n) => Math.round(height(n) / FLOOR_H);
  const { parts, top: t } = siteParts(col, SHELL, { heightOf: height, focusStyle: 'crates' });
  const crates = parts.filter((p) => p.tone === 'add' || p.tone === 'crateDark'), rubble = parts.filter((p) => p.tone === 'rubble' || p.tone === 'rubble2');
  const levelsOf = (list) => new Set(list.map((p) => Math.round((p.z - 12.5) / FLOOR_H))).size;
  assert.equal(levelsOf(crates), lv(420), 'one layer of crates per level'); assert.equal(levelsOf(rubble), lv(310), 'one layer of rubble per level');
  assert.ok(parts.some((p) => p.tone === 'pallet') && parts.some((p) => p.tone === 'skip') && parts.some((p) => p.tone === 'addPad'));
  assert.ok(Math.max(...crates.map((p) => p.z + p.h)) <= 12.5 + lv(420) * FLOOR_H + 1e-6 && Math.max(...rubble.map((p) => p.z + p.h)) <= 12.5 + lv(310) * FLOOR_H + 1e-6, 'no taller than the levels say');
  const pad = (tone) => parts.find((p) => p.tone === tone); assert.ok(pad('addPad').x < pad('delPad').x, 'adds left, deletes right');
  for (const p of parts) assert.ok(p.x - p.w / 2 >= col.x - 6.01 && p.x + p.w / 2 <= col.x + 6.01 && p.y - p.d / 2 >= col.y - 3.01 && p.y + p.d / 2 <= col.y + 3.01, 'inside the slot');
  assert.ok(parts.length < 500 && t > 12);
  assert.deepEqual(siteParts(col, SHELL, { heightOf: height, focusStyle: 'crates' }), { parts, top: t }, 'the rubble is the same every time');
  assert.ok(!siteParts(column({ focused: true, add: 50, del: 0, parts: [] }), SHELL, { heightOf: height, focusStyle: 'crates' }).parts.some((p) => p.tone === 'skip' || p.tone === 'rubble'), 'no deletions: no skip');
});

test('every column in the sample turns into a bounded number of boxes', () => {
  const layout = buildLayout(sampleFiles()), st = { ...DEFAULT_STYLE }, b = new Map(), roofs = new Map();
  for (const l of layout.leaves) { const x = buildingFor(l, st, { gear: false }); b.set(l.path, x); roofs.set(l.path, { r: x.roof, height: x.roof.z }); }
  const prs = [{ id: '#1', status: 'review_requested', files: layout.leaves.map((l) => ({ path: l.path, add: 25, del: 5, hunks: [{ add: 25, del: 5 }] })) }];
  for (const style of ['lines', 'crates', 'facade']) for (const focusId of [null, '#1']) for (const col of planSpires({ byPath: layout.byPath, prs, roofs, focusId })) {
    const { parts, top: t } = siteParts(col, b.get(col.path).shell, { heightOf: height, focusStyle: focusId ? style : 'facade' });
    assert.ok(parts.length > 0 && parts.length < 220, `${parts.length} boxes`);
    assert.ok(parts.every((p) => Number.isFinite(p.x + p.y + p.z) && (p.diag ? p.len > 0 : p.w > 0 && p.d > 0 && p.h > 0)) && t >= col.z0);
  }
});

// ---- layering: no two surfaces in one plane (CLAUDE.md, "Layering") ----
import { coplanarOverlaps } from './coplanar.js';
import { silhouette, roofGear } from '../web/building.js';
const show = (bad) => bad.slice(0, 3).map((x) => `${x.a.tone || 'wall'}/${x.b.tone || 'wall'} axis ${x.axis} side ${x.side}`).join('; ');

test('layering: no visible coplanar faces in any building shape', () => {
  for (const shape of [0, 1, 2, 3, 4, 5, 6]) for (const v of [0.1, 0.9]) {
    const { parts, roof } = silhouette(shape, { x: 10, y: 20, w: 20, h: 12 }, 30, v);
    for (const k of [0, 1, 2]) assert.deepEqual(coplanarOverlaps([...parts, ...roofGear(k, roof, 30)]), [], `shape ${shape} gear ${k}`);
  }
});

test('layering: belts, rails, scaffolding, crates, floors and cranes never put two faces in one plane', () => {
  const shell = { rect: { x: 10, y: 10, w: 24, h: 14 }, h: 12, H: 20, profile: silhouette(1, { x: 10, y: 10, w: 24, h: 14 }, 20, 0.5).parts };
  const hunks = Array.from({ length: 12 }, (_, i) => ({ add: 30 + i, del: i % 3 ? 10 : 40 }));   // more changed lines than the file has, so belts want to overlap
  const col = (o = {}) => column({ focused: true, x: 20, y: 17, w: 14, d: 8, z0: 20, add: 300, del: 200, loc: 120, hunks, parts: hunks.flatMap((h) => [{ kind: 'del', n: h.del }, { kind: 'add', n: h.add }]), ...o });
  for (const focusStyle of ['lines', 'crates', 'facade']) for (const [add, del] of [[300, 200], [300, 0], [0, 200], [5, 5], [4000, 4000]]) {
    const { parts } = siteParts(col({ add, del }), shell, { heightOf: height, focusStyle });
    assert.deepEqual(coplanarOverlaps(parts), [], `${focusStyle} +${add} -${del}: ${show(coplanarOverlaps(parts))}`);
  }
  for (const h of [1, 4, 12, 30]) for (const slot of [{ x: 0, y: 0, w: 14, d: 6 }, { x: 0, y: 0, w: 5, d: 11 }]) assert.deepEqual(coplanarOverlaps(craneParts(slot, 5, h)), [], `crane ${h}`);
  assert.deepEqual(coplanarOverlaps(tapeFloor({ x: 0, y: 0, w: 12, d: 7 }, 0, 2.4)), [], 'taped floor');
  assert.deepEqual(coplanarOverlaps(scaffoldParts({ x: 0, y: 0, w: 20, h: 12 }, 15)), [], 'scaffold');
  assert.deepEqual(coplanarOverlaps(scaffoldParts({ x: 0, y: 0, w: 6, h: 6 }, 7, { pad: 0, lift: 2.4, z0: 4, ground: false, t: 0.3 })), [], 'small scaffold tower');
});
