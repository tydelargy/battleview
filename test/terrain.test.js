import test from 'node:test';
import assert from 'node:assert/strict';
import { PLOT, PROP_FIT, PROP_BAND, hexNorm, plotGeometry, surfaceHeight, cityScale, placeProps } from '../web/terrain.js';
import { biomeFor, BIOME_NAMES } from '../web/biome.js';

const S = 10, N = 2000;

test('hexNorm is the hexagon\'s own distance: 1 at the corners and the edge middles are nearer', () => {
  assert.ok(Math.abs(hexNorm(0, 1) - 1) < 1e-12, 'the top corner');
  assert.ok(Math.abs(hexNorm(Math.sqrt(3) / 2, 0.5) - 1) < 1e-12, 'the side corner');
  assert.ok(Math.abs(hexNorm(Math.sqrt(3) / 2, 0) - Math.sqrt(3) / 2 * 2 / Math.sqrt(3)) < 1e-12);
  assert.ok(Math.abs(hexNorm(Math.sqrt(3) / 2, 0) - 1) < 1e-12, 'the middle of a side: the hexagon boundary there is at x = sqrt(3)/2');
  assert.equal(hexNorm(0, 0), 0);
  for (let i = 0; i < 360; i += 7) { const a = (i * Math.PI) / 180, n = hexNorm(Math.cos(a), Math.sin(a)); assert.ok(n >= 1 - 1e-12 && n <= 2 / Math.sqrt(3) + 1e-12, 'a unit circle point is between the boundary and 1.155 hex-units out'); }
});

test('the surface: flat on the summit, falling through the swell and skirt to the rim, nothing beyond', () => {
  const g = plotGeometry(S, { hill: { height: 1, bulge: 0.2 } });
  assert.equal(surfaceHeight(0, g), g.top); assert.equal(surfaceHeight(PLOT.capTop, g), g.top);
  assert.ok(Math.abs(surfaceHeight(PLOT.capBottom, g) - g.base) < 1e-9); assert.ok(Math.abs(surfaceHeight(PLOT.skirtTop, g) - g.base) < 1e-9);
  assert.ok(Math.abs(surfaceHeight(PLOT.skirtBottom, g) - PLOT.rimH) < 1e-9); assert.equal(surfaceHeight(PLOT.rim, g), PLOT.rimH); assert.equal(surfaceHeight(PLOT.rim + 0.001, g), -Infinity);
  let prev = Infinity; for (let n = 0; n <= PLOT.rim; n += 0.005) { const h = surfaceHeight(n, g); assert.ok(h <= prev + 1e-9, `never rises going outward (${n})`); prev = h; }
  for (const b of BIOME_NAMES.map((x, i) => biomeFor(`k${i}/x`))) { const q = plotGeometry(S, b); assert.ok(q.top > q.base && q.base > PLOT.rimH); }
});

test('a city always fits on the summit: its farthest corner is inside 90% of it, whatever its shape', () => {
  for (const [w, d] of [[0.5, 0.32], [0.5, 0.05], [0.05, 0.5], [0.001, 0.001], [1, 1], [0.5, 0.32]]) {
    const k = cityScale(w, d); assert.ok(k > 0);
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) assert.ok(hexNorm(sx * w * k, sz * d * k) <= PLOT.capTop * 0.9 + 1e-9, `${w}x${d}`);
    assert.ok(Math.abs(hexNorm(w * k, d * k) - PLOT.capTop * 0.9) < 1e-9, 'and it uses the room: the farthest corner is exactly at the limit');
  }
  assert.ok(Number.isFinite(cityScale(0, 0)), 'an empty city does not divide by zero');
});

test('props: every one is on the ground, inside the hexagon, in the band outside the city, whatever the biome and the repo', () => {
  for (let i = 0; i < 400; i++) {
    const b = biomeFor(`acme/repo-${i}`), g = plotGeometry(S, b);
    for (const p of placeProps(b.props, g)) {
      const fit = PROP_FIT[p.type], feet = p.y - fit.half * p.scale, sunk = fit.sink * 2 * fit.half * p.scale;         // the prop's lowest point, and how far its base is pressed into the ground
      assert.ok(Math.abs(p.n - hexNorm(p.x, p.z)) < 1e-9, 'n is its real hex-distance');
      assert.ok(p.n >= PROP_BAND.inner - 1e-9 && p.n <= PROP_BAND.outer + 1e-9, `band ${p.n}`);
      assert.ok(p.n + p.reach < PLOT.skirtBottom, 'its whole width is inside the skirt, never over the rim');
      assert.ok(Number.isFinite(p.ground) && p.ground >= PLOT.rimH, 'it stands on real ground');
      assert.ok(Math.abs(feet - (p.ground - sunk)) < 1e-9, 'its base is at the ground, less a little sink');
      assert.ok(sunk >= 0 && sunk <= 0.6 * fit.half * p.scale + 1e-9, 'pressed in a little, never hovering and never buried');
      assert.ok(Math.hypot(p.x, p.z) <= 1.16, 'in S units, inside the hexagon');
    }
  }
});

test('props follow the slope: one further out sits lower than one nearer the summit', () => {
  const g = plotGeometry(S, { hill: { height: 1, bulge: 0.2 } }), mk = (r) => ({ type: 'rock', x: r, z: 0, scale: 1, turn: 0 });
  const near = placeProps([mk(0.62)], g)[0], far = placeProps([mk(0.92)], g)[0];
  assert.ok(far.ground < near.ground, `${far.ground} < ${near.ground}`); assert.ok(far.y < near.y);
  assert.equal(placeProps([{ type: 'unknown', x: 0.7, z: 0, scale: 1, turn: 0 }], g).length, 0, 'an unknown kind is skipped, not placed somewhere');
});

test('props keep clear of the city: the band starts beyond the summit the city stands on', () => {
  assert.ok(PROP_BAND.inner > PLOT.capTop * 0.9, 'outside the farthest a city corner can reach');
  assert.ok(PROP_BAND.outer < PLOT.skirtBottom);
});
