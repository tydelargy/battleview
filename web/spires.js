// Pure planning of the vertical diff layer. No Three.js in here, so it can be tested.
//
// Every PR that touches a file raises one column on that building's roof.
// Column height is a monotonic function of lines changed (adds + dels), with one
// global scale so any two columns on the map can be compared by eye.
// In focus mode the focused PR's columns are drawn hunk by hunk: red for deleted
// lines, green for added lines, heights summing to the same overview height.

import { squarify } from './layout.js';

export const SCALES = {
  sqrt:   { label: 'Square root', k: 1.15,  f: (n) => Math.sqrt(n) },
  linear: { label: 'Linear',      k: 0.045, f: (n) => n },
  log:    { label: 'Logarithmic', k: 4.2,   f: (n) => Math.log2(1 + n) },
};
export const DIFF_COLORS = { add: '#3ddc97', del: '#ff5d6c' };

export function diffHeight(lines, mode = 'sqrt') { const s = SCALES[mode] || SCALES.sqrt; return lines > 0 ? s.k * s.f(lines) : 0; }
export function scaleTicks(mode = 'sqrt', lines = [10, 100, 500, 1000]) { return lines.map((n) => ({ lines: n, height: diffHeight(n, mode) })); }

/** Place n columns on a roof rect. Returns [{x, y, side}] in world coordinates, all inside the rect. */
export function placeColumns(r, n, { maxSide = 5, boost = 1 } = {}) {
  const m = Math.min(r.w, r.h) * 0.1;
  const iw = Math.max(0.2, r.w - m * 2), ih = Math.max(0.2, r.h - m * 2);
  const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * (iw / ih)))));
  const rows = Math.ceil(n / cols);
  const cw = iw / cols, ch = ih / rows;
  const side = Math.max(0.3, Math.min(cw, ch) * 0.72 * boost, 0.3);
  const s = Math.min(side, maxSide, cw, ch);
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, rw = Math.floor(i / cols);
    out.push({ x: r.x + m + cw * (c + 0.5), y: r.y + m + ch * (rw + 0.5), side: s });
  }
  return out;
}

export const TOPPERS = {
  share: { label: 'Share of file' },
  slim:  { label: 'Slim' },
};
export const MIN_COVER = 0.2;

/** Fraction of a file a PR changes, floored so a one-line edit is still a visible topper. */
export function coverage(lines, loc) { return Math.min(1, Math.max(MIN_COVER, lines / Math.max(1, loc))); }

/**
 * Pack toppers onto a roof. Each item's area is proportional to its weight (its share of the
 * file it changes); weights summing past 1 are normalised so everything fits, weights summing
 * under 1 leave bare roof. Returns Map(key -> {x, y, w, d}) with centres in world coordinates.
 */
export function packRoof(r, items) {
  const m = Math.max(0.15, Math.min(r.w, r.h) * 0.07);
  const iw = Math.max(0.3, r.w - m * 2), ih = Math.max(0.3, r.h - m * 2);
  const total = items.reduce((a, i) => a + i.weight, 0);
  const k = Math.sqrt(Math.min(1, total));
  const gw = iw * k, gh = ih * k, gx = r.x + (r.w - gw) / 2, gy = r.y + (r.h - gh) / 2;
  const gap = items.length > 1 ? Math.min(0.3, Math.min(gw, gh) * 0.05) : 0;
  const out = new Map();
  squarify(items.map((i) => ({ key: i.key, value: i.weight })), gx, gy, gw, gh, (it, x, y, w, h) => {
    out.set(it.key, { x: x + w / 2, y: y + h / 2, w: Math.max(0.3, w - gap * 2), d: Math.max(0.3, h - gap * 2) });
  });
  return out;
}

const gap = 0.12;

/** Column parts for one PR/file. overview => one solid block, focus => hunk stack. */
export function columnParts(entry, mode, focused) {
  const lines = entry.f.add + entry.f.del;
  const total = diffHeight(lines, mode);
  if (!focused || !entry.f.hunks?.length) return { total, parts: [{ dz: 0, h: total, kind: 'pr' }] };
  const segs = [];
  for (const h of entry.f.hunks) { if (h.del > 0) segs.push({ kind: 'del', n: h.del }); if (h.add > 0) segs.push({ kind: 'add', n: h.add }); }
  const gaps = Math.max(0, segs.length - 1) * gap;
  const usable = Math.max(total * 0.4, total - gaps);
  const sumN = segs.reduce((a, s) => a + s.n, 0) || 1;
  let dz = 0;
  const parts = segs.map((s) => { const h = (usable * s.n) / sumN; const p = { dz, h, kind: s.kind, n: s.n }; dz += h + (segs.length > 1 ? gap : 0); return p; });
  const realTotal = parts.length ? parts[parts.length - 1].dz + parts[parts.length - 1].h : total;
  return { total: realTotal, parts };
}

/**
 * planSpires({ byPath, prs, mode, focusId, visible, topper }) ->
 *   columns: [{ x, y, w, d, z0, total, parts, prId, path, focused, dimmed, status, add, del, lines, pct }]
 * x/y is the centre of the topper's footprint, w/d its size, z0 the roof height it stands on.
 * topper 'share': footprint area follows the share of the file the PR changes.
 * topper 'slim':  small fixed-size columns in a grid, as before.
 */
export function planSpires({ byPath, prs, mode = 'sqrt', focusId = null, visible = null, topper = 'share' }) {
  const perFile = new Map();
  for (const p of prs) {
    if (visible && !visible.has(p.id)) continue;
    for (const f of p.files) {
      if (!byPath.has(f.path)) continue;
      if (!perFile.has(f.path)) perFile.set(f.path, []);
      perFile.get(f.path).push({ pr: p, f });
    }
  }
  const columns = [];
  for (const [path, entries] of perFile) {
    entries.sort((a, b) => (a.pr.id < b.pr.id ? -1 : 1));          // stable slots
    const leaf = byPath.get(path);
    let boxes;
    if (topper === 'slim') {
      const slots = placeColumns(leaf.r, entries.length);
      const big = entries.some((e) => e.pr.id === focusId) ? placeColumns(leaf.r, entries.length, { boost: 1.35, maxSide: 6.5 }) : slots;
      boxes = entries.map((e, i) => { const s = e.pr.id === focusId ? big[i] : slots[i]; return { x: s.x, y: s.y, w: s.side, d: s.side }; });
    } else {
      const packed = packRoof(leaf.r, entries.map((e) => ({ key: e.pr.id, weight: coverage(e.f.add + e.f.del, leaf.loc) })));
      boxes = entries.map((e) => packed.get(e.pr.id));
    }
    entries.forEach((e, i) => {
      const focused = e.pr.id === focusId;
      const { total, parts } = columnParts(e, mode, focused);
      const lines = e.f.add + e.f.del;
      columns.push({ ...boxes[i], z0: leaf.height, total, parts, prId: e.pr.id, path, focused, dimmed: !!focusId && !focused, status: e.pr.status, add: e.f.add, del: e.f.del, lines, pct: lines / Math.max(1, leaf.loc), sharedWith: entries.length - 1 });
    });
  }
  return columns;
}
