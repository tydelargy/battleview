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
 * A tower crane that fits a roof slot. Its height is `h`; the jib runs along the longer side of the slot.
 * Mast and jib take the status colour, the counterweight a darker one, the hook line and hook are metal.
 */
export function craneParts({ x, y, w, d }, z0, h) {
  const longX = w >= d, L = Math.max(w, d) * 0.96, s = clamp(Math.min(w, d) * 0.2, 0.45, 1.3);
  const at = (o) => (longX ? { x: x + o, y } : { x, y: y + o });   // a point along the jib, o from the mast
  const box = (p, bw, bd, z, bh, tone) => ({ x: p.x, y: p.y, w: bw, d: bd, z, h: bh, tone });
  const along = (len, thick) => (longX ? [len, thick] : [thick, len]);
  const jibZ = z0 + Math.max(h - s, h * 0.9), parts = [];
  parts.push(box({ x, y }, Math.min(w, d) * 0.7, Math.min(w, d) * 0.7, z0, Math.min(0.4, h * 0.1), 'metal'));        // base
  parts.push(box({ x, y }, s, s, z0, Math.max(0.1, jibZ - z0), 'status'));                                               // mast
  const jibLen = L * 0.72;                                                                                       // jib: from just past the mast out to the far end
  const [jw, jd] = along(jibLen, s * 0.9);
  parts.push(box(at(L * 0.5 - jibLen / 2), jw, jd, jibZ, s * 1.1, 'status'));
  const [cw, cd] = along(L * 0.26, s * 0.9);                                                                            // counter-jib
  parts.push(box(at(-L * 0.5 + L * 0.13), cw, cd, jibZ, s * 1.1, 'status'));
  const [bw, bd] = along(s * 2.2, s * 1.8);                                                                             // counterweight
  parts.push(box(at(-L * 0.5 + s * 1.1), bw, bd, jibZ - s * 1.1, s * 1.4, 'statusDark'));
  parts.push(box({ x, y }, s * 1.7, s * 1.7, jibZ + s, s * 1.2, 'statusDark'));                                          // cab
  const hang = clamp(h * 0.38, 1, 12), hookAt = at(L * 0.32);
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

/**
 * Everything one column (one PR on one file) becomes. `col` is a column from planSpires, `shell` is
 * {rect, h}: the building's footprint and how high that footprint is fully walled (scaffolding stops there).
 * Overview: crane (+ one taped floor if lines were deleted). Focused: scaffolding for the additions (as tall as the square root of the share of the file added, so a small change is still visible), and one taped
 * floor per deleting hunk (the last ones merged, at most three), stacked on the roof.
 */
export function siteParts(col, shell, { loc = 1, floorH = (n) => clamp(0.5 + n * 0.05, 1.2, 5) } = {}) {
  const slot = { x: col.x, y: col.y, w: col.w, d: col.d }, parts = [];
  let z = col.z0;
  const delHunks = col.parts.filter((p) => p.kind === 'del').map((p) => p.n);
  const floors = col.focused && delHunks.length ? mergeTail(delHunks, 3) : col.del > 0 ? [col.del] : [];
  for (const n of floors) { const h = floorH(n); parts.push(...tapeFloor(slot, z, h)); z += h; }
  if (col.focused) {
    if (col.add > 0 && shell) parts.push(...scaffoldParts(shell.rect, clamp(shell.h * clamp(Math.sqrt(col.add / Math.max(1, loc)), 0.3, 1), Math.min(3, shell.h), shell.h)));
  } else if (col.add > 0 || !floors.length) {
    const h = Math.max(1.5, col.total - (z - col.z0));
    parts.push(...craneParts(slot, z, h));
  }
  return parts;
}

function mergeTail(list, max) {
  if (list.length <= max) return list;
  return [...list.slice(0, max - 1), list.slice(max - 1).reduce((a, b) => a + b, 0)];
}
