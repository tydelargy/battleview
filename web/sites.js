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
 * Layering (CLAUDE.md): the mast stands on the pad, the counterweight is inset from the jib's end, the hook stays above the pad.
 */
export function craneParts({ x, y, w, d }, z0, h) {
  const longX = w >= d, s = clamp(h * 0.055, 0.22, 1.3), L = clamp(h * 0.85, 2.2, 40);
  const at = (o) => (longX ? { x: x + o, y } : { x, y: y + o });   // a point along the jib, o from the mast
  const box = (p, bw, bd, z, bh, tone) => ({ x: p.x, y: p.y, w: bw, d: bd, z, h: bh, tone });
  const along = (len, thick) => (longX ? [len, thick] : [thick, len]);
  const jibZ = z0 + h - s * 1.1, parts = [];                      // the jib's top is the crane's height
  parts.push(box({ x, y }, w, d, z0, 0.2, 'pad'));                                                                       // the pad: the share of the file
  parts.push(box({ x, y }, s, s, z0 + 0.2, Math.max(0.1, jibZ - z0 - 0.2), 'status'));                                   // mast, standing on the pad
  const jibLen = L * 0.72, [jw, jd] = along(jibLen, s * 0.9);
  parts.push(box(at(L * 0.5 - jibLen / 2), jw, jd, jibZ, s * 1.1, 'status'));
  const [cw, cd] = along(L * 0.26, s * 0.9);                                                                            // counter-jib
  parts.push(box(at(-L * 0.5 + L * 0.13), cw, cd, jibZ, s * 1.1, 'status'));
  const [bw, bd] = along(Math.max(0.1, Math.min(s * 2.2, L * 0.26 - 0.3)), s * 1.8);   // inset 0.15 from both ends of the counter-jib                                                                             // counterweight
  parts.push(box(at(-L * 0.5 + L * 0.13), bw, bd, jibZ - s * 1.1, s * 1.4, 'statusDark'));
  const hang = clamp(Math.min(h * 0.38, jibZ - z0 - 0.4 - s * 0.9), 0.1, 12), hookAt = at(L * 0.32);
  parts.push(box(hookAt, s * 0.22, s * 0.22, jibZ - hang, hang, 'metal'));                                               // cable
  parts.push(box(hookAt, s * 1.3, s * 1.3, jibZ - hang - s * 0.9, s * 0.9, 'metal'));                                    // hook block
  return parts;
}

/**
 * A cleared-out floor on a roof: corner posts, a thin slab, a red rail around the top and a red X on each face.
 * `h` is the floor height. Nothing fills the faces, so it reads as an emptied floor under tape.
 * Layering (see CLAUDE.md): no two faces share a plane. The slab is inset from the posts, the posts start on the slab
 * and stop below the rail, and the rail is thicker than the posts and runs past them, with its corners butted, not overlapped.
 */
export const SLAB = 0.28;
export function tapeFloor({ x, y, w, d }, z0, h) {
  const p = clamp(Math.min(w, d) * 0.07, 0.22, 0.5), hw = w / 2, hd = d / 2, parts = [];
  const rail = Math.min(0.32, h * 0.18), rz = z0 + h - rail, tr = p + 0.25;
  parts.push({ x, y, w: Math.max(0.3, w - 0.3), d: Math.max(0.3, d - 0.3), z: z0, h: SLAB, tone: 'floor' });
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) parts.push({ x: x + sx * (hw - p / 2), y: y + sy * (hd - p / 2), w: p, d: p, z: z0 + SLAB, h: h - SLAB - rail * 0.5, tone: 'post' });
  const ey = hd - p / 2, ex = hw - p / 2;                                  // the rail runs along the post centre lines
  parts.push({ x, y: y - ey, w: w + 0.25, d: tr, z: rz, h: rail, tone: 'tape' }, { x, y: y + ey, w: w + 0.25, d: tr, z: rz, h: rail, tone: 'tape' });
  const sideLen = Math.max(0.1, 2 * ey - tr);                              // between the front and back rails: corners butt, never overlap
  parts.push({ x: x - ex, y, w: tr, d: sideLen, z: rz, h: rail, tone: 'tape' }, { x: x + ex, y, w: tr, d: sideLen, z: rz, h: rail, tone: 'tape' });
  const t = clamp(h * 0.09, 0.14, 0.34), inner = h - rail - SLAB;
  const diag = (cx, cy, len, along, sign) => ({ diag: true, x: cx, y: cy, z: z0 + SLAB + inner / 2, len: Math.hypot(len, inner), t, along, angle: sign * Math.atan2(inner, len), tone: 'tape' });
  for (const sy of [-1, 1]) for (const sign of [1, -1]) parts.push(diag(x, y + sy * ey, w - p * 2, 'x', sign));
  for (const sx of [-1, 1]) for (const sign of [1, -1]) parts.push(diag(x + sx * ex, y, d - p * 2, 'y', sign));
  return parts;
}

/**
 * Scaffolding around a building's footprint rect from the ground up to `top`: a pole every few units and a ledger
 * ring at every lift, with the top ring in the PR's colour. Capped so a huge building costs a bounded number of boxes.
 * Layering (see CLAUDE.md): ledgers are thicker than poles, the top ring thicker still and ending exactly at `top` with
 * the poles stopping inside it, and ring corners butt instead of overlapping, so no two faces ever share a plane.
 */
export function scaffoldParts(rect, top, { pad = 0.5, lift = 3.2, maxPoles = 28, z0 = 0, ground = true, t: thick = null, braces = 8 } = {}) {
  const x0 = rect.x - pad, y0 = rect.y - pad, x1 = rect.x + rect.w + pad, y1 = rect.y + rect.h + pad, W = x1 - x0, D = y1 - y0;
  const per = 2 * (W + D), step = Math.max(2.6, per / maxPoles), t = thick ?? clamp(Math.max(W, D) * 0.014, 0.4, 1.1), parts = [];
  const nx = Math.max(1, Math.round(W / step)), ny = Math.max(1, Math.round(D / step));
  const thL = t + Math.max(0.2, t * 0.3), thT = t + Math.max(0.4, t * 0.9);       // ledger, top ring
  const poleH = Math.max(0.1, top - thT * 0.6);                                  // stops inside the top ring
  const pole = (px, py) => parts.push({ x: px, y: py, w: t, d: t, z: z0, h: poleH, tone: 'add', ground });
  for (let i = 0; i <= nx; i++) { pole(x0 + (W * i) / nx, y0); pole(x0 + (W * i) / nx, y1); }
  for (let j = 1; j < ny; j++) { pole(x0, y0 + (D * j) / ny); pole(x1, y0 + (D * j) / ny); }
  const levels = Math.max(1, Math.round(top / lift));
  for (let k = 1; k <= levels; k++) {
    const th = k === levels ? thT : thL, z = z0 + (top * k) / levels - th, tone = k === levels ? 'status' : 'add', sideLen = Math.max(0.1, D - th);
    parts.push({ x: (x0 + x1) / 2, y: y0, w: W + th, d: th, z, h: th, tone, ground }, { x: (x0 + x1) / 2, y: y1, w: W + th, d: th, z, h: th, tone, ground },
      { x: x0, y: (y0 + y1) / 2, w: th, d: sideLen, z, h: th, tone, ground }, { x: x1, y: (y0 + y1) / 2, w: th, d: sideLen, z, h: th, tone, ground });
  }
  // diagonal braces, one per lift on each face, alternating direction, so it reads as scaffolding and not a fence
  const lh = top / levels, bt = t * 0.6;
  for (let k = 0; k < Math.min(levels, braces); k++) {
    const z = z0 + lh * (k + 0.5), sign = k % 2 ? -1 : 1, brace = (cx, cy, len, along) => ({ x: cx, y: cy, z, len: Math.hypot(len, lh), t: bt, along, angle: sign * Math.atan2(lh, len), tone: 'add', diag: true, ground });
    parts.push(brace((x0 + x1) / 2, y0, W, 'x'), brace((x0 + x1) / 2, y1, W, 'x'), brace(x0, (y0 + y1) / 2, D, 'y'), brace(x1, (y0 + y1) / 2, D, 'y'));
  }
  return parts;
}

/** One floor of the red-taped stack. Floors are all this tall, and there are as many as the deleted lines need. */
export const FLOOR_H = 2.4, MAX_FLOORS = 24;
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
export function siteParts(col, shell, { heightOf = defaultHeight, focusStyle = 'side' } = {}) {
  const slot = { x: col.x, y: col.y, w: col.w, d: col.d }, parts = [];
  if (col.focused && focusStyle === 'side') return sideBySide(col, slot, heightOf);
  if (col.focused && focusStyle === 'lines' && shell) return lineBands(col, shell);
  if (col.focused && focusStyle === 'crates') return crates(col, slot, heightOf);
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

/**
 * A focused PR, the two halves of the change standing next to each other on the roof: additions as a scaffold tower on
 * the left, deletions as a taped-floor tower on the right. Same footprint, same baseline, same level height (FLOOR_H),
 * and each side is as many levels as its lines need on the one diff scale, so "how much added against how much deleted"
 * is two stacks you can count. The sides are fixed (adds left, deletes right, along the longer side of the slot), and
 * a side with nothing in it is just its flat pad, so an absence is visible too.
 */
const PAD = 0.2;                                          // the flat pad under a focused side
function halves(slot) {
  const longX = slot.w >= slot.d, gap = Math.min(1, Math.max(0.6, (longX ? slot.w : slot.d) * 0.08)), half = ((longX ? slot.w : slot.d) - gap) / 2;
  return longX ? [{ ...slot, x: slot.x - (half + gap) / 2, w: half }, { ...slot, x: slot.x + (half + gap) / 2, w: half }]
    : [{ ...slot, y: slot.y - (half + gap) / 2, d: half }, { ...slot, y: slot.y + (half + gap) / 2, d: half }];
}
function sideBySide(col, slot, heightOf) {
  const [a, b] = halves(slot), parts = [], na = col.add > 0 ? floorsFor(col.add, heightOf) : 0, nd = col.del > 0 ? floorsFor(col.del, heightOf) : 0;
  const z = col.z0 + PAD;                                  // both stacks stand on their pad, never in its plane
  parts.push({ x: a.x, y: a.y, w: a.w, d: a.d, z: col.z0, h: PAD, tone: 'addPad' }, { x: b.x, y: b.y, w: b.w, d: b.d, z: col.z0, h: PAD, tone: 'delPad' });
  if (na) parts.push(...scaffoldParts({ x: a.x - a.w / 2, y: a.y - a.d / 2, w: a.w, h: a.d }, na * FLOOR_H, { pad: 0, lift: FLOOR_H, z0: z, ground: false, t: clamp(Math.min(a.w, a.d) * 0.06, 0.2, 0.5), braces: na, maxPoles: 12 }));
  for (let i = 0; i < nd; i++) parts.push(...tapeFloor(b, z + i * FLOOR_H, FLOOR_H));
  return { parts, top: z + Math.max(na, nd, 1) * FLOOR_H };
}

/**
 * The file's lines laid onto its building: the walled height is the whole file, line 1 at the top and the last line
 * at the bottom, and every hunk is a belt around the building at its place in the file. A belt is as thick as the
 * share of the file it covers (green for lines added, red for lines deleted, the red under the green), so how much
 * of the file changed, and where, is read straight off the building. A thin ruler runs up one corner with a tick
 * every quarter of the file. Hunks without a `start` line are spread evenly in file order (the caller can say so).
 * This view is relative to the file; the global diff scale is the overview's job.
 */
export function lineBands(col, shell) {
  const { rect } = shell, H = shell.H ?? shell.h, o = 0.3, GAP = 0.06, FRONT = 0.14, loc = Math.max(1, col.loc || 1), parts = [];
  const hunks = col.hunks?.length ? col.hunks : [{ add: col.add, del: col.del }], n = hunks.length;
  // the outline of the building at height z: the tier (or tiers) the belt crosses, so belts follow the silhouette
  const outline = (z) => {
    const at = (shell.profile || []).filter((p) => p.z <= z + 1e-9 && z <= p.z + p.h + 1e-9);
    if (!at.length) return rect;
    const x0 = Math.min(...at.map((p) => p.x)), y0 = Math.min(...at.map((p) => p.y));
    return { x: x0, y: y0, w: Math.max(...at.map((p) => p.x + p.w)) - x0, h: Math.max(...at.map((p) => p.y + p.d)) - y0 };
  };
  // Layering (CLAUDE.md): a belt is a ring whose four boxes butt at the corners, deleted (red) rings stand a little
  // proud of added (green) ones, and belts are packed top to bottom so none ever overlaps another in height.
  const ring = (z, h, tone) => {
    const out = o + (tone === 'tape' ? FRONT : 0), r = outline(z + h / 2), x0 = r.x - out, y0 = r.y - out, W = r.w + 2 * out, D = r.h + 2 * out;
    parts.push({ x: x0 + W / 2, y: y0, w: W, d: o, z, h, tone, ground: true }, { x: x0 + W / 2, y: y0 + D, w: W, d: o, z, h, tone, ground: true },
      { x: x0, y: y0 + D / 2, w: o, d: Math.max(0.1, D - o), z, h, tone, ground: true }, { x: x0 + W, y: y0 + D / 2, w: o, d: Math.max(0.1, D - o), z, h, tone, ground: true });
  };
  const belts = [];                                                                                // wanted belts, in file order
  hunks.forEach((hk, i) => {
    const at = hk.start != null ? clamp((hk.start - 1) / loc, 0, 1) : (i + 0.5) / n;            // where in the file this hunk starts
    let top = H * (1 - at);
    if (hk.add > 0) { const t = Math.max(0.35, (hk.add / loc) * H); belts.push({ top, t, tone: 'add' }); top -= t + GAP; }
    if (hk.del > 0) belts.push({ top, t: Math.max(0.35, (hk.del / loc) * H), tone: 'tape' });
  });
  let ceiling = H;                                                                                 // the lowest edge placed so far
  for (const bt of belts.sort((p, q) => q.top - p.top)) {
    const top = Math.min(bt.top, ceiling), bottom = Math.max(0, top - bt.t);
    if (top - bottom < 0.12) continue;                                                             // no room left: the file is covered
    ring(bottom, top - bottom, bt.tone); ceiling = bottom - GAP;
  }
  const ruler = { x: rect.x - 3.5 * o, y: rect.y - 3.5 * o };                                     // clear of every belt, including the proud red ones
  parts.push({ ...ruler, w: 0.18, d: 0.18, z: 0, h: H - 0.2, tone: 'metal', ground: true });       // the tick caps sit above the pole
  for (let k = 1; k <= 4; k++) parts.push({ x: ruler.x, y: ruler.y, w: 0.6, d: 0.6, z: Math.min(H - 0.1, (H * k) / 4 - 0.05), h: 0.1, tone: 'metal', ground: true });
  return { parts, top: col.z0 };
}

// A small deterministic jitter in [0, 1) for rubble, so a pile looks the same every time and the module stays pure.
const jitter = (a, b, c) => { let h = (Math.imul(a + 1, 73856093) ^ Math.imul(b + 1, 19349663) ^ Math.imul(c + 1, 83492791)) >>> 0; h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; return (h ^ (h >>> 13)) % 1000 / 1000; };

/**
 * The side-by-side view as a building site's yard instead of empty frames. Same layout and the same sizing rule
 * (a level is FLOOR_H, and each side is as many levels as its lines need on the one diff scale): additions are
 * crates delivered, a solid stack on a pallet on the left; deletions are debris hauled away, a rubble heap in a
 * red skip on the right, as tall as the stack beside it. Stacks are solid, so the volumes read, not just the lines.
 */
function crates(col, slot, heightOf) {
  const [a, b] = halves(slot), parts = [], na = col.add > 0 ? floorsFor(col.add, heightOf) : 0, nd = col.del > 0 ? floorsFor(col.del, heightOf) : 0;
  const pz = col.z0 + PAD, base = pz + 0.3, cells = (r) => [clamp(Math.round(r.w / FLOOR_H), 1, 4), clamp(Math.round(r.d / FLOOR_H), 1, 4)];
  parts.push({ x: a.x, y: a.y, w: a.w, d: a.d, z: col.z0, h: PAD, tone: 'addPad' }, { x: b.x, y: b.y, w: b.w, d: b.d, z: col.z0, h: PAD, tone: 'delPad' });
  if (na) {
    parts.push({ x: a.x, y: a.y, w: a.w - 0.3, d: a.d - 0.3, z: pz, h: 0.3, tone: 'pallet' });
    const [nx, ny] = cells(a), cw = a.w / nx, cd = a.d / ny;
    for (let k = 0; k < na; k++) for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++)
      parts.push({ x: a.x - a.w / 2 + cw * (i + 0.5), y: a.y - a.d / 2 + cd * (j + 0.5), w: cw * 0.94, d: cd * 0.94, z: base + k * FLOOR_H, h: FLOOR_H * 0.94, tone: (i + j + k) % 2 ? 'crateDark' : 'add' });
  }
  if (nd) {
    const wall = Math.min(1.3, nd * FLOOR_H * 0.5), t = clamp(Math.min(b.w, b.d) * 0.05, 0.2, 0.45);
    parts.push({ x: b.x, y: b.y, w: b.w - 0.3, d: b.d - 0.3, z: pz, h: 0.3, tone: 'skip' });
    parts.push({ x: b.x, y: b.y - b.d / 2 + t / 2, w: b.w, d: t, z: base, h: wall, tone: 'skip' }, { x: b.x, y: b.y + b.d / 2 - t / 2, w: b.w, d: t, z: base, h: wall, tone: 'skip' },
      { x: b.x - b.w / 2 + t / 2, y: b.y, w: t, d: Math.max(0.1, b.d - 2 * t), z: base, h: wall, tone: 'skip' }, { x: b.x + b.w / 2 - t / 2, y: b.y, w: t, d: Math.max(0.1, b.d - 2 * t), z: base, h: wall, tone: 'skip' });   // the side walls butt against the end walls
    const [nx, ny] = cells(b), iw = Math.max(0.3, b.w - 2 * t - 0.3), id = Math.max(0.3, b.d - 2 * t - 0.3);   // the heap keeps clear of the skip's walls
    for (let k = 0; k < nd; k++) {                         // a heap: every level a little narrower than the one under it
      const f = 1 - 0.45 * (k / Math.max(1, nd)), w = iw * f, d = id * f, cw = w / nx, cd = d / ny;
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const r = jitter(i, j, k), hgt = FLOOR_H * (0.78 + 0.2 * jitter(j, k, i));
        parts.push({ x: b.x - w / 2 + cw * (i + 0.5) + (r - 0.5) * cw * 0.1, y: b.y - d / 2 + cd * (j + 0.5), w: cw * (0.8 + 0.18 * r), d: cd * (0.8 + 0.18 * jitter(k, i, j)), z: base + k * FLOOR_H, h: hgt, tone: r > 0.55 ? 'rubble2' : 'rubble' });
      }
    }
  }
  return { parts, top: base + Math.max(na, nd, 1) * FLOOR_H };
}
