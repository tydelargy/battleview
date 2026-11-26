import test from 'node:test';
import assert from 'node:assert/strict';
import { craneParts, tapeFloor, scaffoldParts, siteParts } from '../web/sites.js';
import { buildLayout } from '../web/layout.js';
import { buildingFor, DEFAULT_STYLE } from '../web/building.js';
import { planSpires } from '../web/spires.js';
import { sampleFiles } from '../server/sample.js';

const SLOT = { x: 50, y: 30, w: 12, d: 6 };
const inside = (p, r, e = 1e-6) => p.x - p.w / 2 >= r.x - r.w / 2 - e && p.x + p.w / 2 <= r.x + r.w / 2 + e && p.y - p.d / 2 >= r.y - r.d / 2 - e && p.y + p.d / 2 <= r.y + r.d / 2 + e;

test('a crane stands on its roof, inside its slot, as tall as asked, in status colours', () => {
  for (const slot of [SLOT, { x: 10, y: 10, w: 4, d: 9 }, { x: 0, y: 0, w: 1.2, d: 1.2 }]) {
    const parts = craneParts(slot, 20, 14);
    assert.ok(parts.length >= 7 && parts.length <= 12);
    for (const p of parts) assert.ok(inside(p, slot, 1e-6) || p.tone === 'metal', 'nothing hangs past the slot'), assert.ok(p.z >= 20 - 1e-9 && p.h > 0);
    const top = Math.max(...parts.map((p) => p.z + p.h));
    assert.ok(top >= 20 + 14 * 0.9 && top <= 20 + 14 + 2.5, `the crane is about as tall as the diff (${top - 20})`);
    assert.ok(parts.some((p) => p.tone === 'status') && parts.some((p) => p.tone === 'statusDark'));
  }
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
  for (const p of parts.filter((q) => !q.diag)) assert.ok(inside(p, slot) && p.z >= 30 - 1e-9 && p.z + p.h <= 33 + 1e-9);
  for (const p of diags) assert.ok(p.z > 30 && p.z < 33 && p.len > 0 && (p.along === 'x' || p.along === 'y'));
});

test('scaffolding wraps the footprint from the ground to the top, with the top ring in the PR colour', () => {
  const parts = scaffoldParts({ x: 10, y: 10, w: 30, h: 20 }, 16);
  assert.ok(parts.filter((p) => !p.diag).every((p) => p.x - p.w / 2 >= 10 - 1 && p.x + p.w / 2 <= 41 && p.y - p.d / 2 >= 10 - 1 && p.y + p.d / 2 <= 31), 'outside the wall by a margin, not wandering');
  assert.ok(parts.filter((p) => p.tone === 'add' && p.z === 0 && p.h === 16).length >= 8, 'poles go all the way up');
  assert.ok(parts.some((p) => p.tone === 'status') && Math.max(...parts.filter((p) => !p.diag).map((p) => p.z + p.h)) <= 16 + 1e-6)
  assert.ok(parts.filter((p) => p.diag).every((p) => p.z > 0 && p.z < 16 && p.tone === 'add'), 'braces sit between the ground and the top');
  assert.ok(scaffoldParts({ x: 0, y: 0, w: 900, h: 900 }, 60).length < 250, 'bounded however big the building');
});

const column = (o = {}) => ({ x: 20, y: 20, w: 8, d: 5, z0: 12, total: 9, parts: [{ dz: 0, h: 9, kind: 'pr' }], add: 40, del: 6, focused: false, ...o });
test('overview: a crane for additions, plus one taped floor when lines were deleted', () => {
  const shell = { rect: { x: 10, y: 10, w: 20, h: 15 }, h: 12 };
  const both = siteParts(column(), shell, { loc: 200 });
  assert.ok(both.some((p) => p.tone === 'status') && both.some((p) => p.tone === 'tape') && !both.some((p) => p.tone === 'add'), 'crane and tape, no scaffolding');
  const crane = both.filter((p) => p.tone !== 'tape' && p.tone !== 'post' && p.tone !== 'floor'); assert.ok(crane.every((p) => p.z >= 12));
  const only = siteParts(column({ del: 0 }), shell, { loc: 200 }); assert.ok(!only.some((p) => p.tone === 'tape' || p.tone === 'floor'));
  const del = siteParts(column({ add: 0, del: 30 }), shell, { loc: 200 }); assert.ok(del.some((p) => p.tone === 'tape') && !del.some((p) => p.tone === 'status'), 'pure deletion: just the taped floor');
  const top = Math.max(...both.filter((p) => !p.diag).map((p) => p.z + p.h)); assert.ok(top <= 12 + 9 + 2.6, 'about as tall as the diff says');
});

test('focused: scaffolding for the additions, a taped floor per deleting hunk, no crane', () => {
  const shell = { rect: { x: 10, y: 10, w: 20, h: 15 }, h: 12 };
  const parts = [{ dz: 0, h: 3, kind: 'add', n: 30 }, { dz: 3, h: 1, kind: 'del', n: 4 }, { dz: 4, h: 2, kind: 'add', n: 10 }, { dz: 6, h: 1, kind: 'del', n: 8 }, { dz: 7, h: 1, kind: 'del', n: 9 }, { dz: 8, h: 1, kind: 'del', n: 9 }, { dz: 9, h: 1, kind: 'del', n: 9 }];
  const s = siteParts(column({ focused: true, parts, add: 40, del: 39 }), shell, { loc: 100 });
  assert.ok(s.some((p) => p.tone === 'add') && !s.some((p) => p.tone === 'statusDark'), 'scaffolding, no crane');
  assert.equal(s.filter((p) => p.tone === 'floor').length, 3, 'one floor per deleting hunk, the rest merged, at most three');
  const floors = s.filter((p) => p.tone === 'floor').map((p) => p.z); assert.ok(floors[0] === 12 && floors[1] > floors[0] && floors[2] > floors[1], 'stacked on the roof');
  const scaf = s.filter((p) => p.tone === 'add'); assert.ok(Math.max(...scaf.filter((p) => !p.diag).map((p) => p.z + p.h)) <= shell.h + 1e-6, 'scaffolding never rises past the walled part');
  const small = siteParts(column({ focused: true, add: 2, del: 0, parts: [{ dz: 0, h: 1, kind: 'add', n: 2 }] }), shell, { loc: 1000 });
  assert.ok(Math.max(...small.filter((p) => p.tone === 'add' && !p.diag).map((p) => p.z + p.h)) >= 3 - 1e-6, 'a tiny change still gets a visible scaffold');
});

test('every column in the sample turns into a bounded number of boxes that stay on its roof', () => {
  const layout = buildLayout(sampleFiles()), st = { ...DEFAULT_STYLE }, b = new Map(), roofs = new Map();
  for (const l of layout.leaves) { const x = buildingFor(l, st, { gear: false }); b.set(l.path, x); roofs.set(l.path, { r: x.roof, height: x.roof.z }); }
  const prs = [{ id: '#1', status: 'review_requested', files: layout.leaves.map((l) => ({ path: l.path, add: 25, del: 5, hunks: [{ add: 25, del: 5 }] })) }];
  for (const focusId of [null, '#1']) for (const col of planSpires({ byPath: layout.byPath, prs, roofs, focusId })) {
    const parts = siteParts(col, b.get(col.path).shell, { loc: layout.byPath.get(col.path).loc });
    assert.ok(parts.length > 0 && parts.length < 120, `${parts.length} boxes`);
    assert.ok(parts.every((p) => Number.isFinite(p.x + p.y + p.z) && (p.diag ? p.len > 0 : p.w > 0 && p.d > 0 && p.h > 0)));
  }
});
