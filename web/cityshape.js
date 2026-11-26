// A city seen from far away: its files as a bounded number of boxes, in the same layout and with the same hashed looks as
// the map you get inside it, but without windows, labels or PRs. Pure. Coordinates are in "map units / 1000", so the whole
// city is about 1 wide and 0.64 deep, centred on 0; the caller scales it to fit a plot of land (see terrain.js).
//
// This has to hold for any repo GitHub can describe, so it is defensive on purpose:
//   * input is untrusted: odd paths, duplicates, NaN or negative sizes, non-objects are cleaned or dropped, never thrown on
//   * work is bounded: only the biggest files are laid out (the number shrinks as more cities share the world), so ten
//     files and a hundred thousand files cost about the same, and the same repo always gives the same city
//   * the result is bounded: no tower past MAX_HEIGHT however big a file is (a soft cap that keeps the order), nothing
//     outside the footprint, nothing too small to see, never more than MAX_BOXES boxes
import { buildLayout, WORLD } from './layout.js';
import { buildingFor, DEFAULT_STYLE } from './building.js';

export const SHAPE_STYLE = { ...DEFAULT_STYLE, mode: 'full', height: 1.5, variety: 7 };
export const EXTENT = { w: 1, d: WORLD.h / WORLD.w };
export const MAX_HEIGHT = 0.1;         // tallest a building may stand, in city units (the city is 1 wide)
export const MIN_SIDE = 0.0012;        // a box thinner than this is under a pixel at any sensible zoom: dropped
export const MAX_BOXES = 1400;

/** How many files each city may lay out, by how many cities share the world: a crowded world gets lighter cities. */
export const maxFilesFor = (cities) => (cities <= 8 ? 350 : cities <= 20 ? 220 : cities <= 40 ? 130 : 80);

/** What a file list really is once we stop trusting it: unique paths, sane sizes. */
export function cleanFiles(files) {
  if (!Array.isArray(files)) return [];
  const seen = new Map();
  for (const f of files) {
    if (!f || typeof f !== 'object' || typeof f.path !== 'string') continue;
    const path = f.path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/{2,}/g, '/').slice(0, 400);
    if (!path || path.endsWith('/') || path.split('/').some((s) => s === '..' || s === '.')) continue;
    const loc = Number.isFinite(+f.loc) ? Math.max(1, Math.min(1e7, Math.round(+f.loc))) : 1, complexity = Number.isFinite(+f.complexity) ? Math.max(0, Math.min(1e5, Math.round(+f.complexity))) : 0;
    const old = seen.get(path); if (!old || loc > old.loc) seen.set(path, { path, loc, complexity });
  }
  return [...seen.values()];
}

/** A soft ceiling: close to the true height for small buildings, flattening towards `cap`, never decreasing. */
const soften = (h, cap = MAX_HEIGHT) => cap * (1 - Math.exp(-h / cap));

export function cityBoxes(files, { maxFiles = 350, style = SHAPE_STYLE, maxBoxes = MAX_BOXES } = {}) {
  const clean = cleanFiles(files);
  if (!clean.length) return { boxes: [], extent: EXTENT, count: 0, dropped: 0 };
  // the biggest files, ties broken by path so the choice never depends on the order they arrived in
  const kept = clean.length > maxFiles ? clean.sort((a, b) => b.loc - a.loc || (a.path < b.path ? -1 : 1)).slice(0, Math.max(1, maxFiles)) : clean;
  const layout = buildLayout(kept), k = 1 / WORLD.w, cx = WORLD.w / 2, cy = WORLD.h / 2, hx = EXTENT.w / 2, hz = EXTENT.d / 2;
  const boxes = []; let dropped = 0;
  for (const leaf of [...layout.leaves].sort((a, b) => b.r.w * b.r.h - a.r.w * a.r.h || (a.path < b.path ? -1 : 1))) {      // biggest buildings first, so a cap on boxes only loses the smallest
    const b = buildingFor(leaf, style, { gear: false }), top = Math.max(...b.parts.map((p) => p.z + p.h)) * k, f = top > 0 ? soften(top) / top : 1;   // one factor per building: its silhouette stays itself
    for (const p of b.parts) {
      // clip to the footprint: a tiny lot's minimum width must not push a box out of the city
      let x0 = (p.x - cx) * k, x1 = (p.x + p.w - cx) * k, z0 = (p.y - cy) * k, z1 = (p.y + p.d - cy) * k;
      x0 = Math.max(-hx, x0); x1 = Math.min(hx, x1); z0 = Math.max(-hz, z0); z1 = Math.min(hz, z1);
      const w = x1 - x0, d = z1 - z0, h = p.h * k * f;
      if (!(w >= MIN_SIDE && d >= MIN_SIDE && h > 0) || boxes.length >= maxBoxes) { dropped++; continue; }
      boxes.push({ x: (x0 + x1) / 2, z: (z0 + z1) / 2, y: p.z * k * f, w, d, h, hue: b.t.hue, sat: b.t.sat, light: b.t.light });
    }
  }
  return { boxes, extent: EXTENT, count: kept.length, dropped };
}
