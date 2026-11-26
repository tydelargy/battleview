// Construction-site look for the diff layer in the "Buildings" style. Pure: numbers in, boxes out. No DOM, no three.
//
//   additions, overview   a tower crane on the roof, in the PR's status colour (one per PR, so shared roofs get several)
//   additions, focused    scaffolding up the facade, green, with a ring in the PR's colour at the top
//   deletions             a floor that has been cleared out: open frame, posts, a rail and an X of red tape on every face
//
// A part is a box: {x, y} the centre on the ground plane, {z} its bottom, {w, d, h} its size, `tone` says what colour it
// takes. A diagonal (tape) is {diag: true, x, y, z (its centre height), len, t, along: 'x' | 'y', angle}. The scene
// turns tones into colours and diagonals into rotated boxes. Heights follow the diff scale already in spires.js.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * A tower crane whose size is the diff and nothing else. The whole crane is one model scaled by `h` (its mast height,
 * which the caller takes from the global diff scale), so a 9-line crane is a small crane wherever it stands and two
 * cranes compare by eye. The roof slot only says where it stands: its pad is flat and its area is the share of the
 * file changed, so that second fact is still there without bending the first. A big crane may overhang a small roof.
 * Mast and jib take the status colour, the counterweight a darker one, the hook line and hook are metal.
 */
export function craneParts({ x, y, w, d }, z0, h) {
  const longX = w >= d, s = clamp(h * 0.055, 0.22, 1.3), L = clamp(h * 0.85, 2.2, 40);
  const at = (o) => (longX ? { x: x + o, y } : { x, y: y + o });   // a point along the jib, o from the mast
  const box = (p, bw, bd, z, bh, tone) => ({ x: p.x, y: p.y, w: bw, d: bd, z, h: bh, tone });
  const along = (len, thick) => (longX ? [len, thick] : [thick, len]);
  const jibZ = z0 + h - s * 1.1, parts = [];                      // the jib's top is the crane's height
  parts.push(box({ x, y }, w, d, z0, 0.2, 'pad'));                                                                       // the pad: the share of the file
  parts.push(box({ x, y }, s, s, z0, Math.max(0.1, jibZ - z0), 'status'));                                               // mast
  const jibLen = L * 0.72, [jw, jd] = along(jibLen, s * 0.9);
  parts.push(box(at(L * 0.5 - jibLen / 2), jw, jd, jibZ, s * 1.1, 'status'));
  const [cw, cd] = along(L * 0.26, s * 0.9);                                                                            // counter-jib
  parts.push(box(at(-L * 0.5 + L * 0.13), cw, cd, jibZ, s * 1.1, 'status'));
  const [bw, bd] = along(s * 2.2, s * 1.8);                                                                             // counterweight
  parts.push(box(at(-L * 0.5 + s * 1.1), bw, bd, jibZ - s * 1.1, s * 1.4, 'statusDark'));
  const hang = clamp(h * 0.38, 0.6, 12), hookAt = at(L * 0.32);
  parts.push(box(hookAt, s * 0.22, s * 0.22, jibZ - hang, hang, 'metal'));                                               // cable
  parts.push(box(hookAt, s * 1.3, s * 1.3, jibZ - hang - s * 0.9, s * 0.9, 'metal'));                                    // hook block
  return parts;
}

/**
 * A cleared-out floor on a roof: corner posts, a thin slab, a red rail around the top and a red X on each face.
 * `h` is the floor height. Nothing fills the faces, so it reads as an emptied floor under tape.
 */
export function tapeFloor({ x, y, w, d }, z0, h) {
  const p = clamp(Math.min(w, d) * 0.07, 0.22, 0.5), hw = w / 2, hd = d / 2, parts = [];
  parts.push({ x, y, w, d, z: z0, h: 0.28, tone: 'floor' });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push({ x: x + sx * (hw - p / 2), y: y + sy * (hd - p / 2), w: p, d: p, z: z0, h, tone: 'post' });
  const rail = Math.min(0.32, h * 0.18), rz = z0 + h - rail;
  parts.push({ x, y: y - hd + p / 2, w, d: p * 0.7, z: rz, h: rail, tone: 'tape' }, { x, y: y + hd - p / 2, w, d: p * 0.7, z: rz, h: rail, tone: 'tape' });
  parts.push({ x: x - hw + p / 2, y, w: p * 0.7, d, z: rz, h: rail, tone: 'tape' }, { x: x + hw - p / 2, y, w: p * 0.7, d, z: rz, h: rail, tone: 'tape' });
  const t = clamp(h * 0.09, 0.14, 0.34), inner = h - rail;
  const diag = (cx, cy, len, along, sign) => ({ diag: true, x: cx, y: cy, z: z0 + inner / 2, len: Math.hypot(len, inner), t, along, angle: sign * Math.atan2(inner, len), tone: 'tape' });
  for (const sy of [-1, 1]) for (const sign of [1, -1]) parts.push(diag(x, y + sy * (hd - p / 2), w - p * 2, 'x', sign));
  for (const sx of [-1, 1]) for (const sign of [1, -1]) parts.push(diag(x + sx * (hw - p / 2), y, d - p * 2, 'y', sign));
  return parts;
}

/**
 * Scaffolding around a building's footprint rect from the ground up to `top`: a pole every few units and a ledger
 * ring at every lift, with the top ring in the PR's colour. Capped so a huge building costs a bounded number of boxes.
 */
export function scaffoldParts(rect, top, { pad = 0.5, lift = 3.2, maxPoles = 28 } = {}) {
  const x0 = rect.x - pad, y0 = rect.y - pad, x1 = rect.x + rect.w + pad, y1 = rect.y + rect.h + pad, W = x1 - x0, D = y1 - y0;
  const per = 2 * (W + D), step = Math.max(2.6, per / maxPoles), t = clamp(Math.max(W, D) * 0.014, 0.4, 1.1), parts = [];
  const nx = Math.max(1, Math.round(W / step)), ny = Math.max(1, Math.round(D / step));
  const pole = (px, py) => parts.push({ x: px, y: py, w: t, d: t, z: 0, h: top, tone: 'add', ground: true });
  for (let i = 0; i <= nx; i++) { pole(x0 + (W * i) / nx, y0); pole(x0 + (W * i) / nx, y1); }
  for (let j = 1; j < ny; j++) { pole(x0, y0 + (D * j) / ny); pole(x1, y0 + (D * j) / ny); }
  const levels = Math.max(1, Math.round(top / lift));
  for (let k = 1; k <= levels; k++) {
    const th = k === levels ? t * 1.4 : t, z = (top * k) / levels - th, tone = k === levels ? 'status' : 'add';
    parts.push({ x: (x0 + x1) / 2, y: y0, w: W, d: th, z, h: th, tone, ground: true }, { x: (x0 + x1) / 2, y: y1, w: W, d: th, z, h: th, tone, ground: true },
      { x: x0, y: (y0 + y1) / 2, w: th, d: D, z, h: th, tone, ground: true }, { x: x1, y: (y0 + y1) / 2, w: th, d: D, z, h: th, tone, ground: true });
  }
  // diagonal braces, one per lift on each face, alternating direction, so it reads as scaffolding and not a fence
  const lh = top / levels, bt = t * 0.6;
  for (let k = 0; k < Math.min(levels, 8); k++) {
    const z = lh * (k + 0.5), sign = k % 2 ? -1 : 1, brace = (cx, cy, len, along) => ({ x: cx, y: cy, z, len: Math.hypot(len, lh), t: bt, along, angle: sign * Math.atan2(lh, len), tone: 'add', diag: true, ground: true });
    parts.push(brace((x0 + x1) / 2, y0, W, 'x'), brace((x0 + x1) / 2, y1, W, 'x'), brace(x0, (y0 + y1) / 2, D, 'y'), brace(x1, (y0 + y1) / 2, D, 'y'));
  }
  return parts;
}

/** One floor of the red-taped stack. Floors are all this tall, and there are as many as the deleted lines need. */
export const FLOOR_H = 2.4, MAX_FLOORS = 10;
const defaultHeight = (n) => 1.15 * Math.sqrt(n);
const floorsFor = (n, heightOf) => (n > 0 ? clamp(Math.round(heightOf(n) / FLOOR_H), 1, MAX_FLOORS) : 0);

/**
 * What one column (one PR on one file) is made of, sized on the diff scale `heightOf(lines)` (the same one the toppers
 * use) and nothing else. Returns {parts, top}: the boxes, and the height of the tallest thing, for flags and labels.
 *   overview   a crane as tall as the additions, standing on one taped floor per FLOOR_H of deleted lines
 *   focused    scaffolding as tall as the additions (never past the walled part of the building), and the deleting
 *              hunks as taped floors on the roof, each hunk as many floors as its lines need
 * So height always reads in lines: adds on the crane or scaffold, deletes on the floors, one scale for both.
 */
export function siteParts(col, shell, { heightOf = defaultHeight } = {}) {
  const slot = { x: col.x, y: col.y, w: col.w, d: col.d }, parts = [];
  const delHunks = col.parts.filter((p) => p.kind === 'del').map((p) => p.n);
  const counts = col.focused && delHunks.length ? delHunks.map((n) => floorsFor(n, heightOf)) : [floorsFor(col.del, heightOf)];
  let z = col.z0, used = 0;
  for (const n of counts) for (let i = 0; i < n && used < MAX_FLOORS; i++, used++) { parts.push(...tapeFloor(slot, z, FLOOR_H)); z += FLOOR_H; }
  let top = z;
  if (col.focused) {
    if (col.add > 0 && shell) { const t = clamp(heightOf(col.add), Math.min(2, shell.h), shell.h); parts.push(...scaffoldParts(shell.rect, t)); }   // the scaffold is on the walls, below the roof: it does not change the top
  } else if (col.add > 0) {
    const h = Math.max(0.8, heightOf(col.add));
    parts.push(...craneParts(slot, z, h)); top = z + h;
  } else if (!used) { parts.push(...craneParts(slot, z, 0.8)); top = z + 0.8; }
  return { parts, top };
}
