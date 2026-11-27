// What each file of a PR means on the map. Pure. The map's buildings come from the default branch, so a file a PR adds is not on
// the map yet, a file it moves has an old home that is, and a file it deletes is a building that is about to go.
//
//   modified  the file is on the map and the PR changes it: a column on its roof, as ever
//   removed   the PR deletes a file that is on the map: the building is condemned
//   added     the PR creates a file that is not on the map yet: a building to be built (it has no place until something gives it one)
//   renamed   the PR moves a file: the old building is on the map (`from`), the new place is not. `fromExists` says whether we can find the old one
// The feed says which (`change`, `from`); a feed that does not still gets the one safe reading: a file that is not on the map is new.

export const KINDS = ['modified', 'removed', 'added', 'renamed'];

export function classifyChanges(prs, byPath) {
  const rows = [];
  for (const pr of prs || []) for (const f of (pr && pr.files) || []) {
    if (!f || typeof f.path !== 'string') continue;
    const exists = byPath.has(f.path), declared = f.change, base = { prId: pr.id, path: f.path, add: f.add || 0, del: f.del || 0 };
    let kind;
    if (declared === 'removed') kind = exists ? 'removed' : null;                                   // deleting something the map never had: nothing to show
    else if (declared === 'renamed' && f.from && f.from !== f.path) kind = 'renamed';
    else if (declared === 'added' || declared === undefined || declared === 'renamed') kind = exists ? 'modified' : 'added';
    else kind = exists ? 'modified' : 'added';
    if (kind === 'renamed') { rows.push({ ...base, kind, from: f.from, fromExists: byPath.has(f.from), toExists: exists }); continue; }
    if (kind) rows.push({ ...base, kind });
  }
  return rows;
}

/** The rows of one kind, for one PR or all. */
export const only = (rows, kind, prId = null) => rows.filter((r) => r.kind === kind && (prId == null || r.prId === prId));

/** "src/a/b.ts" -> "src/a": the folder a path lives in ("" for the root). */
export const folderOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Where a new file's flag and lines should point when it has no place of its own: the middle of the nearest district that exists. */
export function anchorFor(layout, path) {
  const dir = folderOf(path); let best = null;
  for (const p of layout.plates || []) if (dir === p.path || dir.startsWith(p.path + '/')) if (!best || p.path.length > best.path.length) best = p;
  const w = layout.world || { w: 1000, h: 640 };
  return best ? { x: best.x + best.w / 2, y: best.y + best.h / 2, plate: best } : { x: w.w / 2, y: w.h / 2, plate: null };
}
