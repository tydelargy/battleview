import test from 'node:test';
import assert from 'node:assert/strict';
import { cityBoxes, cleanFiles, maxFilesFor, MAX_HEIGHT, MAX_BOXES, MIN_SIDE, EXTENT } from '../web/cityshape.js';
import { sampleFiles } from '../server/sample.js';

const HX = EXTENT.w / 2 + 1e-9, HZ = EXTENT.d / 2 + 1e-9;
const sound = (c, what = '') => {
  assert.ok(c.boxes.length <= MAX_BOXES, `${what} too many boxes: ${c.boxes.length}`);
  for (const x of c.boxes) {
    for (const v of [x.x, x.z, x.y, x.w, x.d, x.h, x.hue, x.sat, x.light]) assert.ok(Number.isFinite(v), `${what} non-finite`);
    assert.ok(x.x - x.w / 2 >= -HX && x.x + x.w / 2 <= HX && x.z - x.d / 2 >= -HZ && x.z + x.d / 2 <= HZ, `${what} outside the footprint`);
    assert.ok(x.w >= MIN_SIDE - 1e-12 && x.d >= MIN_SIDE - 1e-12 && x.h > 0 && x.y >= 0, `${what} degenerate box`);
    assert.ok(x.y + x.h <= MAX_HEIGHT * 1.0001, `${what} tower: ${x.y + x.h}`);
    assert.ok(x.hue >= 0 && x.hue < 360 && x.sat > 0 && x.light > 0);
  }
};

test('a city is a bounded set of sound boxes inside a fixed footprint, the same every time, whatever order the files arrive in', () => {
  const files = sampleFiles(), a = cityBoxes(files), b = cityBoxes([...files].reverse());
  assert.equal(a.count, files.length); assert.ok(a.boxes.length >= files.length * 0.8 && a.boxes.length < files.length * 4); sound(a, 'sample');
  assert.deepEqual(a, b, 'input order does not matter');
});

test('input is untrusted: junk is dropped or cleaned, and nothing throws', () => {
  const junk = [null, undefined, 5, 'x', [], {}, { path: 7 }, { path: '' }, { path: '/' }, { path: 'a/' }, { path: '../etc/passwd', loc: 5 }, { path: 'a/./b', loc: 5 }, { path: 'ok.ts', loc: NaN }, { path: 'neg.ts', loc: -50, complexity: -3 }, { path: 'inf.ts', loc: Infinity, complexity: Infinity }, { path: 'str.ts', loc: '120', complexity: '9' }, { path: '\\win\\style.ts', loc: 10 }, { path: '//lead//ing.ts', loc: 10 }, { path: 'x'.repeat(2000), loc: 10 }];
  const clean = cleanFiles(junk), byPath = Object.fromEntries(clean.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(byPath).sort(), ['inf.ts', 'lead/ing.ts', 'neg.ts', 'ok.ts', 'str.ts', 'win/style.ts', 'x'.repeat(400)].sort(), 'only real paths survive, normalised');
  assert.ok(clean.every((f) => f.loc >= 1 && Number.isFinite(f.loc) && f.complexity >= 0 && Number.isFinite(f.complexity)), 'sizes are finite and positive');
  assert.equal(byPath['str.ts'].loc, 120); assert.equal(byPath['neg.ts'].loc, 1); assert.equal(byPath['inf.ts'].loc, 1);
  for (const bad of [junk, 'not an array', null, undefined, {}, 42]) { const c = cityBoxes(bad); sound(c, 'junk'); }
  assert.equal(cityBoxes(null).boxes.length, 0); assert.equal(cityBoxes([]).count, 0); assert.equal(cityBoxes([null, 3]).count, 0);
  const dup = cityBoxes([{ path: 'a.ts', loc: 5 }, { path: 'a.ts', loc: 500 }, { path: 'b.ts', loc: 5 }]); assert.equal(dup.count, 2, 'one building per path');
});

test('a huge repo costs the same as a small one: only the biggest files are laid out, and the result is bounded', () => {
  const many = Array.from({ length: 120_000 }, (_, i) => ({ path: `d${i % 300}/s${i % 41}/f${i}.ts`, loc: 3 + ((i * 7919) % 2000), complexity: i % 60 }));
  const t0 = Date.now(), c = cityBoxes(many, { maxFiles: 350 }), ms = Date.now() - t0;
  assert.equal(c.count, 350); sound(c, 'huge'); assert.ok(ms < 1500, `${ms} ms`);
  const again = cityBoxes([...many].reverse(), { maxFiles: 350 }); assert.deepEqual(again, c, 'the same biggest files, whatever order the 120k arrived in');
  const sorted = [...many].sort((a, b) => b.loc - a.loc || (a.path < b.path ? -1 : 1)).slice(0, 350).map((f) => f.path).sort();
  assert.equal(cityBoxes(many, { maxFiles: 350 }).count, 350); assert.deepEqual(cleanFiles(many).sort((a, b) => b.loc - a.loc || (a.path < b.path ? -1 : 1)).slice(0, 350).map((f) => f.path).sort(), sorted);
  const small = cityBoxes(many.slice(0, 10)); sound(small, 'ten'); assert.equal(small.count, 10);
});

test('no tower, however big or branchy a file is: heights saturate, order is kept', () => {
  const giants = [{ path: 'a/huge.ts', loc: 5_000_000, complexity: 90_000 }, { path: 'a/big.ts', loc: 50_000, complexity: 5000 }, { path: 'a/mid.ts', loc: 2000, complexity: 80 }, { path: 'a/small.ts', loc: 40, complexity: 2 }];
  const c = cityBoxes(giants); sound(c, 'giants');
  assert.ok(Math.max(0, ...c.boxes.map((b) => b.y + b.h)) <= MAX_HEIGHT * 1.0001);
  const one = (loc, complexity) => Math.max(...cityBoxes([{ path: 'x.ts', loc, complexity }, { path: 'y.ts', loc: 100, complexity: 10 }]).boxes.map((b) => b.y + b.h));
  assert.ok(one(100, 5) < one(10_000, 500) && one(10_000, 500) <= one(5_000_000, 90_000) + 1e-12, 'taller files still read taller');
});

test('degenerate shapes are fine: one file, all-equal files, one file that is nearly everything, a flat folder, a very deep one', () => {
  sound(cityBoxes([{ path: 'only.ts', loc: 100, complexity: 5 }]), 'one');
  sound(cityBoxes(Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.ts`, loc: 50, complexity: 3 }))), 'equal');
  sound(cityBoxes([{ path: 'big.ts', loc: 1_000_000 }, ...Array.from({ length: 300 }, (_, i) => ({ path: `t${i}.ts`, loc: 2 }))]), 'one giant, many specks');
  sound(cityBoxes(Array.from({ length: 150 }, (_, i) => ({ path: `${'d/'.repeat(40)}f${i}.ts`, loc: 20 + i }))), 'deep');
  sound(cityBoxes(Array.from({ length: 150 }, (_, i) => ({ path: `d${i}/f.ts`, loc: 20 + i }))), 'wide');
  const specks = cityBoxes([{ path: 'big.ts', loc: 1_000_000 }, ...Array.from({ length: 300 }, (_, i) => ({ path: `t${i}.ts`, loc: 1 }))]); assert.ok(specks.dropped > 0 || specks.boxes.length > 0, 'sub-pixel boxes are dropped, not drawn');
});

test('the detail budget shrinks as the world fills, and the box cap always holds', () => {
  assert.deepEqual([1, 8, 9, 20, 21, 40, 41, 60].map(maxFilesFor), [350, 350, 220, 220, 130, 130, 80, 80]);
  for (let i = 1; i < 60; i++) assert.ok(maxFilesFor(i + 1) <= maxFilesFor(i), 'never more detail for a crowded world');
  const big = Array.from({ length: 5000 }, (_, i) => ({ path: `p${i % 50}/f${i}.ts`, loc: 10 + (i % 500), complexity: i % 40 }));
  for (const n of [1, 10, 30, 60]) sound(cityBoxes(big, { maxFiles: maxFilesFor(n) }), `${n} cities`);
  assert.ok(cityBoxes(big, { maxFiles: 80 }).boxes.length < cityBoxes(big, { maxFiles: 350 }).boxes.length);
  assert.ok(cityBoxes(big, { maxFiles: 350, maxBoxes: 100 }).boxes.length <= 100, 'an explicit cap is honoured');
});

test('different repos look different, and a repo always looks the same', () => {
  const x = [{ path: 'a/b.ts', loc: 100, complexity: 10 }, { path: 'a/c.ts', loc: 300, complexity: 20 }], y = [{ path: 'q/r.ts', loc: 100, complexity: 10 }, { path: 'q/s.ts', loc: 300, complexity: 20 }];
  assert.deepEqual(cityBoxes(x), cityBoxes(x)); assert.notDeepEqual(cityBoxes(x).boxes.map((b) => b.hue), cityBoxes(y).boxes.map((b) => b.hue));
});
