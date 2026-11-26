// Where a PR's NEW files stand on the map. A new file is not in the default branch, so the map has no place for it: something has
// to decide. This is the one function that decides (the rest of the code only asks), so different ideas can be tried by replacing
// it. This base gives no place (the files are listed in the PR panel and the flag still finds the right district).
//
//   placeGhosts(layout, rows, ctx) -> { lots: Map("prId|path" -> {x, y, w, d, z0?}) }
//     layout  the map's layout (plates and leaves, in map units: x across, y down)
//     rows    the added / moved-in files to place: {prId, path, kind, add, del, from?}
//     ctx     {focusId}
//   x, y, w, d are a lot's centre and size on the ground; z0 lifts the site off the ground (the hovering variants).
export function placeGhosts(layout, rows, ctx = {}) {
  return { lots: new Map() };
}
