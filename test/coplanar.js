// Test helper: finds visible z-fighting between axis-aligned boxes. Two faces that point the same way, lie in the same
// plane (within `eps`) and overlap are drawn on top of each other, and which one wins changes with the camera and the
// frame: that is the flicker. Faces that point opposite ways (touching boxes) are never both visible, so they are fine.
// Boxes are the {x, y, w, d, z, h} parts of web/sites.js and web/building.js (x, y the centre on the ground, z the bottom).
export function coplanarOverlaps(parts, eps = 0.08) {
  const boxes = parts.filter((p) => !p.diag).map((p, i) => ({ i, p, lo: [p.x - p.w / 2, p.y - p.d / 2, p.z], hi: [p.x + p.w / 2, p.y + p.d / 2, p.z + p.h] }));
  const bad = [];
  for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
    const A = boxes[a], B = boxes[b];
    if ([0, 1, 2].some((k) => A.lo[k] > B.hi[k] + eps || B.lo[k] > A.hi[k] + eps)) continue;   // far apart: nothing to check
    for (let axis = 0; axis < 3; axis++) for (const side of [0, 1]) {
      const fa = side ? A.hi[axis] : A.lo[axis], fb = side ? B.hi[axis] : B.lo[axis];
      if (Math.abs(fa - fb) > eps) continue;
      // the two faces overlap if the boxes overlap in both other axes
      const others = [0, 1, 2].filter((k) => k !== axis);
      if (others.every((k) => Math.min(A.hi[k], B.hi[k]) - Math.max(A.lo[k], B.lo[k]) > 1e-6)) bad.push({ a: A.p, b: B.p, axis, side, gap: Math.abs(fa - fb) });
    }
  }
  return bad;
}
