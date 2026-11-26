// Hash-derived building identity. Pure: a path and a salt in, a stable look out. No DOM, no three.
// The same path and salt always give the same building; changing the salt reshuffles every trait.
// Sizes are not decided here: footprint comes from the treemap (lines of code) and height from complexity,
// so hashing never changes what a building says about the file. This only decides how it looks.
import { hash } from './layout.js';

/** How a focused PR's change is drawn on the map. 'hunks' is the classic stack of green and red hunks. */
export const FOCUS_VIEWS = ['hunks', 'lines', 'crates', 'facade'];
export const focusView = (style) => style.focus || (style.mode === 'full' ? 'crates' : 'hunks');
export const SHAPES = ['block', 'stepped', 'crown', 'L-shape', 'tower', 'terraced', 'twin towers'];
export const MATERIALS = ['concrete', 'brick', 'stone', 'steel'];
export const WINDOW_STYLES = ['grid', 'bands', 'slits'];
export const ROOF_GEAR = ['antenna', 'water tank', 'vents'];
export const STYLE_MODES = { plain: 'Plain', colors: 'Colours', full: 'Buildings' };
export const DEFAULT_STYLE = { mode: 'full', spread: 22, density: 1.1, variety: 7, height: 1.5, texture: true, focus: null, salt: 0, codes: true };   // focus null = automatic: crates in Buildings, hunks in the simple styles

/** Fingerprint of a file: FNV-1a 32 bit over "path:salt". */
export const fingerprint = (path, salt = 0) => hash(`${path}:${salt | 0}`);

/** Independent draw in [0,1) for trait `k` (murmur-style finalizer), so traits do not correlate. */
export function draw(h, k) {
  let x = Math.imul(h ^ Math.imul(k + 1, 0x9e3779b1), 0x85ebca6b);
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35); x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const num = (v, lo, hi, d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** Whatever came out of storage becomes a valid style: unknown keys dropped, numbers clamped. */
export function normaliseStyle(raw) {
  const s = { ...DEFAULT_STYLE };
  if (!raw || typeof raw !== 'object') return s;
  if (Object.hasOwn(STYLE_MODES, raw.mode)) s.mode = raw.mode;
  s.spread = Math.round(num(raw.spread, 0, 50, s.spread));
  s.density = Math.round(num(raw.density, 0.6, 2, s.density) * 10) / 10;
  s.variety = Math.round(num(raw.variety, 1, SHAPES.length, s.variety));
  s.height = Math.round(num(raw.height, 1, 3, s.height) * 10) / 10;
  if (typeof raw.texture === 'boolean') s.texture = raw.texture;
  if (FOCUS_VIEWS.includes(raw.focus)) s.focus = raw.focus;
  s.salt = Number.isInteger(raw.salt) && raw.salt >= 0 && raw.salt < 1e9 ? raw.salt : 0;
  if (typeof raw.codes === 'boolean') s.codes = raw.codes;
  return s;
}

/** h in degrees, s and l in 0..1, result [r, g, b] in 0..1. */
export function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l), f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0), f(8), f(4)];
}

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** "C-14": short enough to say out loud ("look at C-14"). Stable per path and salt. */
export function indexCode(h) { return `${LETTERS[Math.floor(draw(h, 50) * 24)]}-${10 + Math.floor(draw(h, 51) * 90)}`; }

/**
 * Every trait of one file's look. `hue` is the folder's hue; the colour varies inside its family.
 * Colour is in percent (sat, light) as in the sketch; `light` is the lit-side lightness.
 */
export function traits(path, style, hue) {
  const hf = fingerprint(path, style.salt), r = (k) => draw(hf, k);
  return {
    hf,
    shape: Math.floor(r(2) * Math.max(1, Math.min(SHAPES.length, style.variety))),
    window: Math.floor(r(3) * 3),
    lit: 0.25 + 0.6 * r(4),
    // Window size is rolled once per building (3.2 to 6.5 units before the density slider); the facade then tiles
    // a whole number of windows, so they scale with the building instead of being cut off at its edges.
    cell: 3.2 + 3.3 * r(10),
    // A narrow, warm range for the lit windows: enough to tell buildings apart, not enough to look like confetti.
    litRgb: hslToRgb(38 + (r(11) - 0.5) * 26, 0.55 + 0.4 * r(12), 0.62 + 0.14 * r(13)),
    material: Math.floor(r(14) * MATERIALS.length),
    shapeV: r(16),
    lot: { fx: 0.72 + 0.28 * r(9), fy: 0.72 + 0.28 * r(18), ox: r(19), oy: r(20) },
    hue: (((hue + (r(5) - 0.5) * style.spread) % 360) + 360) % 360,
    sat: 48 + 14 * r(6),
    light: 40 + 14 * r(7),
    gear: Math.floor(r(8) * 3),
    code: indexCode(hf),
  };
}

/**
 * The boxes a building is made of, and its roof. `rect` is the footprint {x, y, w, h} (top-left corner),
 * `H` the height. Each part is {x, y, w, d, z, h, dl}: a box on the ground plane from (x, y), `z` up from the
 * ground, `dl` a lightness nudge. `shell` is how high the whole footprint is walled (scaffolding stops there). `roof` is where toppers stand ({x, y, w, h} and `z`, the height of that roof).
 * Silhouettes: block; stepped (three tiers); crown (wide base, narrower top); L (a tall half and a lower half;
 * toppers stand on the tall half).
 */
export function silhouette(shape, rect, H, v = 0.5) {
  const { x, y, w: W, h: D } = rect;
  const box = (bx, by, bw, bd, z, h, dl = 0) => ({ x: bx, y: by, w: bw, d: bd, z, h, dl });
  if (shape === 1) {
    const parts = []; let z = 0, top = null;
    for (const [ins, frac] of [[0, 0.5], [0.15, 0.3], [0.3, 0.2]]) {
      const a = W * ins, b = D * ins;
      parts.push(box(x + a, y + b, W - 2 * a, D - 2 * b, z, H * frac));
      top = { x: x + a, y: y + b, w: W - 2 * a, h: D - 2 * b }; z += H * frac;
    }
    return { parts, roof: { ...top, z: H }, shell: H * 0.5 };
  }
  if (shape === 2) {
    const top = { x: x + W * 0.22, y: y + D * 0.22, w: W * 0.56, h: D * 0.56 };
    return { parts: [box(x, y, W, D, 0, H * 0.68), box(top.x, top.y, top.w, top.h, H * 0.68, H * 0.32, 3)], roof: { ...top, z: H }, shell: H * 0.68 };
  }
  if (shape === 3) {
    const tall = { x, y, w: W, h: D * 0.5 };
    return { parts: [box(x, y, W, D * 0.5, 0, H), box(x, y + D * 0.5, W, D * 0.5, 0, H * 0.55, -2)], roof: { ...tall, z: H }, shell: H * 0.55 };
  }
  if (shape === 4) {                                  // tower: a low podium with one slim tower rising from it
    const ins = 0.26 + 0.12 * v, tw = { x: x + W * ins, y: y + D * ins, w: W * (1 - 2 * ins), h: D * (1 - 2 * ins) }, ph = H * (0.25 + 0.15 * v);
    return { parts: [box(x, y, W, D, 0, ph, -3), box(tw.x, tw.y, tw.w, tw.h, ph, H - ph)], roof: { ...tw, z: H }, shell: ph };
  }
  if (shape === 5) {                                  // terraced: three slabs stepping up along the longer side
    const alongX = W >= D, flip = v > 0.5, parts = [];
    let roof = null;
    [0.5, 0.75, 1].forEach((f, i) => {
      const k = flip ? 2 - i : i, r = alongX ? { x: x + (W / 3) * k, y, w: W / 3, h: D } : { x, y: y + (D / 3) * k, w: W, h: D / 3 };
      parts.push(box(r.x, r.y, r.w, r.h, 0, H * f, i === 2 ? 0 : -2)); if (f === 1) roof = { ...r, z: H };
    });
    return { parts, roof, shell: H * 0.5 };
  }
  if (shape === 6) {                                  // twin towers on a shared base; the roof is the taller one
    const alongX = W >= D, bh = H * 0.25, first = v > 0.5, L = alongX ? W : D;
    const t = (o) => (alongX ? { x: x + L * o, y, w: L * 0.38, h: D } : { x, y: y + L * o, w: W, h: L * 0.38 });
    const a = t(0), b = t(0.62), tall = first ? b : a, low = first ? a : b;
    return { parts: [box(x, y, W, D, 0, bh, -3), box(tall.x, tall.y, tall.w, tall.h, bh, H - bh), box(low.x, low.y, low.w, low.h, bh, H * 0.78 - bh, -2)], roof: { ...tall, z: H }, shell: bh };
  }
  return { parts: [box(x, y, W, D, 0, H)], roof: { x, y, w: W, h: D, z: H }, shell: H };
}

/** The small thing on the roof: an antenna, a water tank or two vents, as boxes in the same format. */
export function roofGear(kind, roof, H) {
  const { x, y, w, h, z } = roof, cx = x + w / 2, cy = y + h / 2, box = (bx, by, bw, bd, bh) => ({ x: bx, y: by, w: bw, d: bd, z, h: bh, dl: -6, gear: true });
  if (kind === 0) { const s = Math.max(0.25, Math.min(w, h) * 0.05); return [box(cx - s / 2, cy - s / 2, s, s, Math.min(10, H * 0.3))]; }
  if (kind === 1) { const a = w * 0.36, b = h * 0.36; return [box(cx - a / 2, cy - b / 2, a, b, H * 0.14)]; }
  return [box(x + w * 0.15, y + h * 0.15, w * 0.2, h * 0.2, H * 0.07), box(x + w * 0.6, y + h * 0.55, w * 0.2, h * 0.2, H * 0.07)];
}

/**
 * Everything the scene needs for one leaf of the layout: its traits, its boxes and its roof.
 * Plain and colour-only styles are one box (the roof is the whole footprint); only "full" has silhouettes.
 */
export function buildingFor(leaf, style, { gear = true } = {}) {
  const t = traits(leaf.path, style, leaf.hue);
  if (style.mode !== 'full') return { t, parts: [{ x: leaf.r.x, y: leaf.r.y, w: leaf.r.w, d: leaf.r.h, z: 0, h: leaf.height, dl: 0 }], roof: { ...leaf.r, z: leaf.height }, shell: { rect: leaf.r, h: leaf.height, H: leaf.height, profile: null } };
  // Each building stands on its lot with a margin of its own (up to 28% a side), so neighbours differ in width and
  // depth and there are gaps between them, like blocks of a city. Height is complexity times one global multiplier.
  const { fx, fy, ox, oy } = t.lot, r = leaf.r, w = Math.max(0.5, r.w * fx), h = Math.max(0.5, r.h * fy);
  const rect = { x: r.x + (r.w - w) * ox, y: r.y + (r.h - h) * oy, w, h }, H = leaf.height * style.height;
  const { parts, roof, shell } = silhouette(t.shape, rect, H, t.shapeV);
  return { t, parts: gear ? [...parts, ...roofGear(t.gear, roof, H)] : parts, roof, shell: { rect, h: shell, H, profile: parts } };
}
