import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint, draw, traits, indexCode, silhouette, roofGear, buildingFor, normaliseStyle, DEFAULT_STYLE } from '../web/building.js';
import { buildLayout, hash } from '../web/layout.js';
import { sampleFiles } from '../server/sample.js';
import { planSpires } from '../web/spires.js';

const style = (o = {}) => ({ ...DEFAULT_STYLE, ...o });
const RECT = { x: 10, y: 20, w: 20, h: 12 };

test('the fingerprint is FNV-1a over path:salt, so a salt changes it and nothing else does', () => {
  assert.equal(fingerprint('a/b.ts', 0), fingerprint('a/b.ts', 0));
  assert.notEqual(fingerprint('a/b.ts', 0), fingerprint('a/b.ts', 1));
  assert.equal(fingerprint('a/b.ts', 0), hash('a/b.ts:0'), 'FNV-1a over the path, a colon and the salt');
  assert.equal(hash(''), 2166136261, 'the FNV-1a offset basis');
  assert.equal(draw(fingerprint('x'), 3), draw(fingerprint('x'), 3));
});

test('draws are in [0,1), independent per trait, and roughly uniform', () => {
  const bins = new Array(10).fill(0); let same = 0;
  for (let i = 0; i < 5000; i++) { const h = fingerprint('f' + i); const a = draw(h, 1), b = draw(h, 2); assert.ok(a >= 0 && a < 1 && b >= 0 && b < 1); bins[Math.floor(a * 10)]++; if (Math.abs(a - b) < 0.01) same++; }
  assert.ok(bins.every((n) => n > 380 && n < 620), `uniform enough: ${bins}`);
  assert.ok(same < 150, 'two traits of one file do not move together');
});

test('same path and salt give the same traits; a new salt reshuffles them', () => {
  const a = traits('src/pricing.ts', style(), 200), b = traits('src/pricing.ts', style(), 200);
  assert.deepEqual(a, b);
  let changed = 0;
  for (let i = 0; i < 100; i++) { const p = `src/f${i}.ts`, x = traits(p, style(), 200), y = traits(p, style({ salt: 1 }), 200); if (x.code !== y.code) changed++; }
  assert.ok(changed > 90, 'almost every code changes with the salt');
});

test('traits stay in range and colour stays in the folder hue family', () => {
  for (let i = 0; i < 500; i++) {
    const t = traits(`d/f${i}.ts`, style({ spread: 22 }), 100);
    assert.ok(t.shape >= 0 && t.shape < 7 && t.material >= 0 && t.material < 4 && t.cell >= 3.2 && t.cell <= 6.5 && t.litRgb.every((c) => c >= 0 && c <= 1) && t.litRgb[0] >= t.litRgb[2] && t.lot.fx >= 0.72 && t.lot.fx <= 1 && t.window >= 0 && t.window < 3 && t.gear >= 0 && t.gear < 3);
    assert.ok(t.lit >= 0.25 && t.lit <= 0.85 && t.sat >= 48 && t.sat <= 62 && t.light >= 40 && t.light <= 54);
    assert.ok(Math.abs(t.hue - 100) <= 11.0001, `hue ${t.hue} within half the spread`);
    assert.match(t.code, /^[A-HJ-NP-Z]-\d\d$/);
  }
  assert.equal(traits('x', style({ spread: 0 }), 77).hue, 77, 'no spread: the folder hue exactly');
  assert.ok(traits('x', style({ spread: 50 }), 2).hue >= 0, 'wraps below zero');
  assert.ok(traits('x', style({ spread: 50 }), 359).hue < 360, 'and above 360');
});

test('shape variety limits the silhouettes: 1 is plain boxes, 4 uses all of them', () => {
  const seen = (variety) => new Set(Array.from({ length: 300 }, (_, i) => traits(`f${i}`, style({ variety }), 0).shape));
  assert.deepEqual([...seen(1)], [0]);
  assert.deepEqual([...seen(2)].sort(), [0, 1]);
  assert.deepEqual([...seen(4)].sort(), [0, 1, 2, 3]);
  assert.deepEqual([...seen(7)].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('index codes are letters without I and O, then two digits', () => {
  for (let i = 0; i < 300; i++) assert.match(indexCode(fingerprint('p' + i)), /^[ABCDEFGHJKLMNPQRSTUVWXYZ]-[1-9]\d$/);
});

test('silhouettes: parts stay inside the footprint, stack to the height, and have a roof on top', () => {
  const H = 30;
  for (const shape of [0, 1, 2, 3, 4, 5, 6]) for (const v of [0.1, 0.9]) {
    const { parts, roof } = silhouette(shape, RECT, H, v);
    for (const p of parts) {
      assert.ok(p.x >= RECT.x - 1e-9 && p.y >= RECT.y - 1e-9 && p.x + p.w <= RECT.x + RECT.w + 1e-9 && p.y + p.d <= RECT.y + RECT.h + 1e-9, `shape ${shape} stays in the footprint`);
      assert.ok(p.h > 0 && p.w > 0 && p.d > 0 && p.z >= 0);
    }
    assert.ok(Math.max(...parts.map((p) => p.z + p.h)) <= H + 1e-9, 'nothing taller than the building');
    assert.ok(Math.abs(roof.z - H) < 1e-9, 'toppers stand at the full height');
    assert.ok(roof.x >= RECT.x && roof.y >= RECT.y && roof.x + roof.w <= RECT.x + RECT.w + 1e-9 && roof.y + roof.h <= RECT.y + RECT.h + 1e-9);
    assert.ok(parts.some((p) => Math.abs(p.z + p.h - H) < 1e-9), 'some part really reaches the roof');
  }
  assert.equal(silhouette(0, RECT, H).parts.length, 1);
  assert.equal(silhouette(1, RECT, H).parts.length, 3);
  assert.equal(silhouette(2, RECT, H).parts.length, 2);
  assert.deepEqual(silhouette(3, RECT, H).roof, { x: 10, y: 20, w: 20, h: 6, z: 30 }, 'L: toppers use the taller half');
  assert.equal(silhouette(4, RECT, H).parts.length, 2); assert.equal(silhouette(6, RECT, H).parts.length, 3);
  assert.ok(silhouette(4, RECT, H).roof.w < RECT.w * 0.6, 'a tower is slim');
  const stepped = silhouette(1, RECT, H); assert.ok(Math.abs(stepped.parts.reduce((a, p) => a + p.h, 0) - H) < 1e-9);
});

test('roof gear sits on the roof and inside it', () => {
  const roof = { x: 10, y: 20, w: 20, h: 12, z: 30 };
  for (const kind of [0, 1, 2]) {
    const g = roofGear(kind, roof, 30);
    assert.equal(g.length, kind === 2 ? 2 : 1);
    for (const p of g) assert.ok(p.z === 30 && p.x >= roof.x && p.y >= roof.y && p.x + p.w <= roof.x + roof.w + 1e-9 && p.y + p.d <= roof.y + roof.h + 1e-9 && p.h > 0);
  }
});

test('buildingFor: plain boxes unless the full style is on, and gear can be left off', () => {
  const leaf = { path: 'a/b.ts', hue: 40, r: RECT, height: 20 };
  const tall = buildingFor(leaf, style({ height: 2 }), {}), flat = buildingFor(leaf, style({ height: 1 }), {});
  assert.ok(Math.abs(tall.roof.z - 2 * flat.roof.z) < 1e-9, 'the height multiplier scales every building by the same factor');
  for (let i = 0; i < 200; i++) { const b = buildingFor({ ...leaf, path: `p${i}.ts` }, style(), {}); for (const p of b.parts.filter((q) => !q.gear)) assert.ok(p.x >= RECT.x - 1e-9 && p.y >= RECT.y - 1e-9 && p.x + p.w <= RECT.x + RECT.w + 1e-9 && p.y + p.d <= RECT.y + RECT.h + 1e-9, 'a building stays on its lot'); }
  for (const mode of ['plain', 'colors']) { const b = buildingFor(leaf, style({ mode }), {}); assert.equal(b.parts.length, 1); assert.equal(b.roof.z, 20); assert.equal(b.roof.w, RECT.w); }
  const bare = buildingFor(leaf, style(), { gear: false }), dressed = buildingFor(leaf, style(), { gear: true });
  assert.ok(dressed.parts.length > bare.parts.length);
  assert.deepEqual(bare.roof, dressed.roof);
  assert.deepEqual(buildingFor(leaf, style(), {}), buildingFor(leaf, style(), {}));
});

test('normaliseStyle repairs whatever storage hands back', () => {
  assert.deepEqual(normaliseStyle(null), DEFAULT_STYLE);
  assert.deepEqual(normaliseStyle({ mode: 'neon', spread: 'x', density: 99, variety: -3, salt: -1, codes: 'yes', junk: 1 }), { ...DEFAULT_STYLE, density: 2, variety: 1 });
  assert.equal(normaliseStyle({ spread: 80 }).spread, 50);
  assert.equal(normaliseStyle({ mode: 'colors', salt: 4, codes: false }).salt, 4);
});

test('toppers pack onto each silhouette roof and every one stays on it', () => {
  const layout = buildLayout(sampleFiles());
  for (const variety of [1, 4]) {
    const st = style({ variety }), roofs = new Map();
    for (const l of layout.leaves) { const b = buildingFor(l, st, {}); roofs.set(l.path, { r: b.roof, height: b.roof.z }); }
    const prs = [{ id: '#1', status: 'review_requested', files: layout.leaves.slice(0, 12).map((l) => ({ path: l.path, add: 30, del: 4 })) }, { id: '#2', status: 'draft', files: layout.leaves.slice(0, 5).map((l) => ({ path: l.path, add: 9, del: 1 })) }];
    const cols = planSpires({ byPath: layout.byPath, prs, roofs });
    assert.equal(cols.length, 17);
    for (const c of cols) {
      const r = roofs.get(c.path).r;
      assert.ok(c.x - c.w / 2 >= r.x - 1e-6 && c.x + c.w / 2 <= r.x + r.w + 1e-6 && c.y - c.d / 2 >= r.y - 1e-6 && c.y + c.d / 2 <= r.y + r.h + 1e-6, 'topper footprint is on the roof');
      assert.equal(c.z0, roofs.get(c.path).height, 'and stands on the roof height');
    }
  }
});
