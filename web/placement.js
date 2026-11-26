// Where a PR's NEW files stand on the map, and the one rule that keeps it fair: the map is laid out WITH every tracked PR's new and
// moved-to files in it, whatever is focused, filtered or hovered. A new file is a plot in its district, as big as the file will be (a
// moved file's new plot is as big as the file it moves), drawn as an empty scaffold frame. Because nothing here depends on what you are
// looking at, a file never moves because you looked at another PR; it only moves when the set of tracked PRs changes.
//
//   ghostFiles(rows, baseByPath) -> files to lay out alongside the real ones: {path, loc, complexity, kind: 'added' | 'moved', from?}
//   placeGhosts(layout, rows)    -> { lots: Map("prId|path" -> {x, y, w, d, z0, plate}) } read off the ghost leaves of that layout
import { folderOf } from './changes.js';

/** Rows (from classifyChanges) -> the files the layout must make room for. A path is made room for once, at the biggest size any PR gives it. Pure. */
export function ghostFiles(rows, baseByPath = new Map()) {
  const out = new Map();
  for (const r of rows || []) {
    if (!r || typeof r.path !== 'string' || (r.kind !== 'added' && !(r.kind === 'renamed' && !r.toExists))) continue;
    const from = r.kind === 'renamed' ? baseByPath.get(r.from) : null;          // a moved file's new plot is as big as the file that is moving
    const loc = from ? Math.max(1, from.loc) : Math.max(1, Number.isFinite(r.add) ? r.add + (r.kind === 'renamed' ? r.del || 0 : 0) : 1), complexity = from ? from.complexity ?? 0 : Math.round(loc / 12);
    const old = out.get(r.path);
    if (!old || loc > old.loc) out.set(r.path, { path: r.path, loc, complexity, kind: from || r.kind === 'renamed' ? 'moved' : 'added', ...(r.kind === 'renamed' ? { from: r.from } : {}) });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

export function placeGhosts(layout, rows, ctx = {}) {
  const lots = new Map();
  for (const r of rows || []) {
    const leaf = layout?.byPath?.get(r.path); if (!leaf || !leaf.ghost) continue;
    lots.set(`${r.prId}|${r.path}`, { x: leaf.mx, y: leaf.my, w: Math.max(0.5, leaf.r.w), d: Math.max(0.5, leaf.r.h), z0: 0, plate: folderOf(r.path), folder: folderOf(r.path), path: r.path });
  }
  return { lots };
}
