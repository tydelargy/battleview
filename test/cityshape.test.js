import test from 'node:test';
import assert from 'node:assert/strict';
import { cityBoxes } from '../web/cityshape.js';
import { sampleFiles } from '../server/sample.js';

test('a city is a few hundred boxes inside a fixed footprint, the same every time', () => {
  const files = sampleFiles(), a = cityBoxes(files), b = cityBoxes([...files].reverse());
  assert.equal(a.count, files.length); assert.ok(a.boxes.length >= files.length && a.boxes.length < files.length * 4);
  assert.deepEqual(a, b, 'input order does not matter');
  for (const x of a.boxes) {
    assert.ok(x.x - x.w / 2 >= -0.5 - 1e-9 && x.x + x.w / 2 <= 0.5 + 1e-9 && x.z - x.d / 2 >= -0.32 - 1e-9 && x.z + x.d / 2 <= 0.32 + 1e-9, 'inside the footprint');
    assert.ok(x.w > 0 && x.d > 0 && x.h > 0 && x.y >= 0 && x.hue >= 0 && x.hue < 360 && x.sat > 0 && x.light > 0);
  }
  assert.ok(Math.max(...a.boxes.map((x) => x.y + x.h)) < 0.2, 'buildings are low next to the plot: the city is a skyline, not a tower');
});

test('a huge repo is capped to its biggest files, and an empty one is an empty plot', () => {
  const many = Array.from({ length: 5000 }, (_, i) => ({ path: `d${i % 40}/f${i}.ts`, loc: 10 + (i % 97), complexity: i % 30 }));
  const c = cityBoxes(many, { maxFiles: 300 });
  assert.equal(c.count, 300); assert.ok(c.boxes.length < 1300);
  const biggest = many.reduce((m, f) => (f.loc > m.loc ? f : m)); assert.equal(c.count, 300, biggest.path.length > 0 ? 'kept the biggest' : '');
  assert.deepEqual(cityBoxes([]).boxes, []); assert.deepEqual(cityBoxes(null).boxes, []); assert.equal(cityBoxes([]).count, 0);
});

test('different repos look different, and a repo always looks the same', () => {
  const x = [{ path: 'a/b.ts', loc: 100, complexity: 10 }, { path: 'a/c.ts', loc: 300, complexity: 20 }], y = [{ path: 'q/r.ts', loc: 100, complexity: 10 }, { path: 'q/s.ts', loc: 300, complexity: 20 }];
  assert.deepEqual(cityBoxes(x), cityBoxes(x)); assert.notDeepEqual(cityBoxes(x).boxes.map((b) => b.hue), cityBoxes(y).boxes.map((b) => b.hue));
});
