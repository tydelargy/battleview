// A city seen from far away: its files as a few hundred boxes, in the same layout and with the same hashed looks as the
// map you get inside it, but without windows, labels or PRs. Pure. Coordinates are in "map units / 1000", so the whole
// city is about 1 wide and 0.64 deep, centred on 0: the caller scales it to fit a plot of land.
import { buildLayout, WORLD } from './layout.js';
import { buildingFor, DEFAULT_STYLE } from './building.js';

export const SHAPE_STYLE = { ...DEFAULT_STYLE, mode: 'full', height: 1.5, variety: 7 };

export function cityBoxes(files, { maxFiles = 350, style = SHAPE_STYLE } = {}) {
  if (!Array.isArray(files) || !files.length) return { boxes: [], extent: { w: 1, d: WORLD.h / WORLD.w }, count: 0 };
  // a huge repo would be thousands of boxes nobody can see: keep the biggest files, the layout keeps their proportions
  const kept = files.length > maxFiles ? [...files].sort((a, b) => b.loc - a.loc || (a.path < b.path ? -1 : 1)).slice(0, maxFiles) : files;
  const layout = buildLayout(kept), k = 1 / WORLD.w, cx = WORLD.w / 2, cy = WORLD.h / 2, boxes = [];
  for (const leaf of layout.leaves) {
    const b = buildingFor(leaf, style, { gear: false });
    for (const p of b.parts) boxes.push({ x: (p.x + p.w / 2 - cx) * k, z: (p.y + p.d / 2 - cy) * k, y: p.z * k, w: p.w * k, d: p.d * k, h: p.h * k, hue: b.t.hue, sat: b.t.sat, light: b.t.light });
  }
  return { boxes, extent: { w: 1, d: WORLD.h / WORLD.w }, count: kept.length };
}
