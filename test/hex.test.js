import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRS, hexKey, parseKey, neighbors, distance, toWorld, fromWorld, spiral, frontier, connected, canMove, nextSlot } from '../web/hex.js';
import { BIOMES, BIOME_NAMES, PROP_RING, biomeFor } from '../web/biome.js';

const H = (q, r) => ({ q, r });

test('hex basics: six neighbours at distance one, keys round trip, world coordinates round trip', () => {
  assert.equal(DIRS.length, 6); assert.equal(new Set(DIRS.map(hexKey)).size, 6);
  const n = neighbors(H(2, -1)); assert.equal(n.length, 6); assert.ok(n.every((x) => distance(x, H(2, -1)) === 1));
  assert.deepEqual(parseKey(hexKey(H(-3, 4))), H(-3, 4));
  assert.equal(distance(H(0, 0), H(2, -1)), 2); assert.equal(distance(H(0, 0), H(3, 0)), 3); assert.equal(distance(H(1, 1), H(-1, -1)), 4);
  for (const size of [1, 7.5]) for (let q = -4; q <= 4; q++) for (let r = -4; r <= 4; r++) {
    const w = toWorld(H(q, r), size); assert.deepEqual(fromWorld(w.x, w.z, size), H(q, r), `${q},${r}`);
    assert.deepEqual(fromWorld(w.x + size * 0.3, w.z + size * 0.2, size), H(q, r), 'a point near the centre is in the same hex');
  }
  const a = toWorld(H(0, 0), 1), b = toWorld(H(1, 0), 1), c = toWorld(H(0, 1), 1);
  assert.ok(Math.abs(Math.hypot(b.x - a.x, b.z - a.z) - Math.sqrt(3)) < 1e-9, 'neighbouring centres are sqrt(3) radii apart (pointy-top)');
  assert.ok(Math.abs(Math.hypot(c.x - a.x, c.z - a.z) - Math.sqrt(3)) < 1e-9);
});

test('spiral: starts at the origin, never repeats, fills ring by ring', () => {
  const s = spiral(19); assert.deepEqual(s[0], H(0, 0)); assert.equal(new Set(s.map(hexKey)).size, 19);
  assert.deepEqual(s.map((h) => distance(h, H(0, 0))), [0, 1, 1, 1, 1, 1, 1, ...Array(12).fill(2)], 'one centre, six in ring one, twelve in ring two');
  assert.deepEqual(spiral(5), spiral(30).slice(0, 5), 'a longer spiral starts the same way');
  assert.deepEqual(spiral(1), [H(0, 0)]); assert.deepEqual(spiral(0).length, 1, 'never empty');
});

test('frontier: the origin when empty, otherwise exactly the empty hexes touching a city', () => {
  assert.deepEqual(frontier([]), [H(0, 0)]);
  assert.equal(frontier([H(0, 0)]).length, 6);
  const two = [H(0, 0), H(1, 0)], f = frontier(two);
  assert.equal(f.length, 8, 'two touching hexes have eight free neighbours between them');
  assert.ok(f.every((h) => !two.some((t) => hexKey(t) === hexKey(h)) && two.some((t) => distance(t, h) === 1)));
  assert.equal(new Set(f.map(hexKey)).size, f.length, 'no duplicates');
  assert.deepEqual(frontier(['0,0']).length, 6, 'keys work too');
});

test('connected: cities must touch; a gap or an island is not allowed', () => {
  assert.equal(connected([]), true); assert.equal(connected([H(5, 5)]), true);
  assert.equal(connected([H(0, 0), H(1, 0), H(1, -1)]), true);
  assert.equal(connected([H(0, 0), H(2, 0)]), false, 'one hex apart');
  assert.equal(connected([H(0, 0), H(1, 0), H(5, 5)]), false);
});

test('canMove: onto an empty hex beside the group, never splitting it, never onto a city', () => {
  const row = [H(0, 0), H(1, 0), H(2, 0)];                                        // a line of three
  assert.equal(canMove(row, H(2, 0), H(1, -1)), true, 'the end city swings round to the next hex');
  assert.equal(canMove(row, H(2, 0), H(0, 1)), true);
  assert.equal(canMove(row, H(1, 0), H(1, -1)), false, 'moving the middle one would split the other two');
  assert.equal(canMove(row, H(0, 0), H(5, 5)), false, 'far away');
  assert.equal(canMove(row, H(0, 0), H(1, 0)), false, 'occupied');
  assert.equal(canMove(row, H(0, 0), H(0, 0)), false, 'not a move');
  assert.equal(canMove(row, H(9, 9), H(0, 1)), false, 'there is no city there');
  assert.equal(canMove([H(0, 0), H(1, 0)], H(1, 0), H(-1, 0)), true, 'the other end');
  assert.equal(canMove([H(0, 0), H(1, 0)], H(1, 0), H(2, 0)), false, 'beside only the city that is moving');
  assert.equal(canMove([H(0, 0)], H(0, 0), H(1, 0)), false, 'a lone city has nothing to be beside');
  for (const to of frontier(row)) for (const from of row) if (canMove(row, from, to)) { const next = row.filter((h) => hexKey(h) !== hexKey(from)).concat([to]); assert.equal(connected(next), true, 'every allowed move keeps the group whole'); }
});

test('nextSlot: fills outward evenly, always beside the group', () => {
  const placed = [];
  for (let i = 0; i < 19; i++) { const s = nextSlot(placed); assert.ok(frontier(placed).some((f) => hexKey(f) === hexKey(s)), `city ${i} touches the group`); placed.push(s); assert.equal(connected(placed), true); }
  assert.deepEqual(placed[0], H(0, 0)); assert.equal(new Set(placed.map(hexKey)).size, 19);
  assert.ok(placed.every((h) => distance(h, H(0, 0)) <= 2), '19 cities fit in two rings');
  assert.deepEqual(nextSlot([H(0, 0)]), nextSlot([H(0, 0)]), 'deterministic');
});

test('biomes: the same repo always gets the same plot, every biome gets used, props stay off the city', () => {
  assert.deepEqual(biomeFor('org/repo'), biomeFor('org/repo')); assert.deepEqual({ ...biomeFor('Org/Repo'), key: '' }, { ...biomeFor('org/repo'), key: '' }, 'case does not matter');
  assert.notDeepEqual(biomeFor('org/repo'), biomeFor('org/repo2'));
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const b = biomeFor(`acme/project-${i}`); seen.add(b.name);
    assert.ok(BIOME_NAMES.includes(b.name) && b.ground === BIOMES[b.name].ground && /^#[0-9a-f]{6}$/i.test(b.ground));
    assert.ok(b.hill.height >= 0.5 && b.hill.height <= 1.4 && b.hill.bulge >= 0.12 && b.hill.bulge <= 0.28);
    assert.ok(b.props.length >= 7 && b.props.length <= 15);
    for (const p of b.props) { const rad = Math.hypot(p.x, p.z); assert.ok(rad >= PROP_RING.inner - 1e-9 && rad <= PROP_RING.outer + 1e-9, `prop at ${rad}`); assert.ok(BIOMES[b.name].props.includes(p.type)); assert.ok(p.scale >= 0.7 && p.scale <= 1.4); }
  }
  assert.equal(seen.size, BIOME_NAMES.length, 'all eight biomes show up across 400 repos');
  assert.equal(biomeFor('a/b').key, 'a/b');
});
