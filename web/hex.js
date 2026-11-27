// A hex grid for the world view: pure maths, no DOM, no three. Axial coordinates {q, r}, pointy-top hexes.
// The placement rules live here so they can be tested: cities sit on hexes, they must stay together (every city touches
// another), a new city goes on an empty hex next to the group, and a city can only be moved onto such a hex without
// splitting the group in two.

export const DIRS = [{ q: 1, r: 0 }, { q: 1, r: -1 }, { q: 0, r: -1 }, { q: -1, r: 0 }, { q: -1, r: 1 }, { q: 0, r: 1 }];
export const hexKey = (h) => `${h.q},${h.r}`;
export const parseKey = (k) => { const [q, r] = String(k).split(',').map(Number); return { q, r }; };
export const sameHex = (a, b) => a.q === b.q && a.r === b.r;
export const neighbors = (h) => DIRS.map((d) => ({ q: h.q + d.q, r: h.r + d.r }));
export const distance = (a, b) => (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;

const S3 = Math.sqrt(3);
/** The centre of a hex in the world (x across, z down) for hexes of circumradius `size`. */
export const toWorld = (h, size = 1) => ({ x: size * S3 * (h.q + h.r / 2), z: size * 1.5 * h.r });
/** The hex a world point falls in (cube rounding). */
export function fromWorld(x, z, size = 1) {
  const q = ((S3 / 3) * x - (1 / 3) * z) / size, r = ((2 / 3) * z) / size;
  let rq = Math.round(q), rr = Math.round(r), rs = Math.round(-q - r);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs + q + r);
  if (dq > dr && dq > ds) rq = -rr - rs; else if (dr > ds) rr = -rq - rs;
  return { q: rq + 0, r: rr + 0 };
}

/** The first `n` hexes from the origin outward, ring by ring, always in the same order. */
export function spiral(n) {
  const out = [{ q: 0, r: 0 }];
  for (let ring = 1; out.length < n; ring++) {
    let h = { q: -ring, r: ring };                       // the ring's corner in direction 3... then walk round it
    for (const d of [DIRS[0], DIRS[1], DIRS[2], DIRS[3], DIRS[4], DIRS[5]]) for (let i = 0; i < ring && out.length < n; i++) { out.push({ ...h }); h = { q: h.q + d.q, r: h.r + d.r }; }
  }
  return out.slice(0, Math.max(1, n));
}

const toSet = (cells) => new Set([...cells].map((c) => (typeof c === 'string' ? c : hexKey(c))));

/** Empty hexes that touch at least one city: the only places a city may be added or moved to. With no cities, just the origin. */
export function frontier(occupied) {
  const occ = toSet(occupied); if (!occ.size) return [{ q: 0, r: 0 }];
  const seen = new Set(), out = [];
  for (const k of occ) for (const n of neighbors(parseKey(k))) { const nk = hexKey(n); if (!occ.has(nk) && !seen.has(nk)) { seen.add(nk); out.push(n); } }
  return out.sort((a, b) => distance(a, { q: 0, r: 0 }) - distance(b, { q: 0, r: 0 }) || a.r - b.r || a.q - b.q);
}

/** Is every city connected to the others through neighbouring hexes? Zero or one city counts. */
export function connected(cells) {
  const occ = toSet(cells); if (occ.size < 2) return true;
  const start = [...occ][0], seen = new Set([start]), todo = [start];
  while (todo.length) for (const n of neighbors(parseKey(todo.pop()))) { const k = hexKey(n); if (occ.has(k) && !seen.has(k)) { seen.add(k); todo.push(k); } }
  return seen.size === occ.size;
}

/** May the city on `from` move to `to`? `to` must be empty, touch a city that is not the one moving, and leave the group in one piece. */
export function canMove(occupied, from, to) {
  const occ = toSet(occupied), f = hexKey(from), t = hexKey(to);
  if (!occ.has(f) || occ.has(t) || f === t) return false;
  const rest = new Set(occ); rest.delete(f);
  if (!neighbors(to).some((n) => rest.has(hexKey(n)))) return false;
  rest.add(t);
  return connected(rest);
}

/** Where the next city goes by itself: the first free hex next to the group in spiral order, so a group fills outward evenly. */
export function nextSlot(occupied) {
  const occ = toSet(occupied), free = new Set(frontier(occupied).map(hexKey));
  for (const h of spiral(occ.size + 40)) if (free.has(hexKey(h))) return h;
  return frontier(occupied)[0];
}
