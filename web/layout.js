// Pure, deterministic layout. Same file list in, same map out, regardless of input order.
export const WORLD = { w: 1000, h: 640 };

export function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

export function buildingHeight(loc, complexity) { return 3 + Math.sqrt(loc) * (0.5 + 0.7 * Math.min(1, complexity / 38)); }

function buildTree(files) {
  const root = { name: '', path: '', depth: 0, dirs: new Map(), files: [] };
  for (const f of [...files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const parts = f.path.split('/');
    let n = root;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!n.dirs.has(parts[i])) n.dirs.set(parts[i], { name: parts[i], path: parts.slice(0, i + 1).join('/'), dirs: new Map(), files: [] });
      n = n.dirs.get(parts[i]);
    }
    n.files.push({ ...f, name: parts[parts.length - 1] });
  }
  return root;
}

// a/b with a single child dir and no files collapses into one plate named "a/b"
function collapse(n) {
  for (const [k, d] of n.dirs) {
    let cur = d;
    while (cur.dirs.size === 1 && cur.files.length === 0) { const only = [...cur.dirs.values()][0]; only.name = cur.name + '/' + only.name; cur = only; }
    n.dirs.set(k, cur);
    collapse(cur);
  }
}

export function squarify(items, x, y, w, h, place) {
  const total = items.reduce((a, i) => a + i.value, 0);
  if (!(total > 0) || w <= 0 || h <= 0) return;
  const sc = (w * h) / total;
  items = items.slice().sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1));
  items.forEach((i) => { i._a = i.value * sc; });
  let cx = x, cy = y, cw = w, ch = h, row = [];
  const worst = (rw, side) => { const s = rw.reduce((a, i) => a + i._a, 0), mx = Math.max(...rw.map((i) => i._a)), mn = Math.min(...rw.map((i) => i._a)); return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn)); };
  const flush = () => {
    if (!row.length) return;
    const s = row.reduce((a, i) => a + i._a, 0);
    if (cw >= ch) { const rw = s / ch; let yy = cy; row.forEach((i) => { const hh = i._a / rw; place(i, cx, yy, rw, hh); yy += hh; }); cx += rw; cw -= rw; }
    else { const rh = s / cw; let xx = cx; row.forEach((i) => { const ww = i._a / rh; place(i, xx, cy, ww, rh); xx += ww; }); cy += rh; ch -= rh; }
    row = [];
  };
  const rest = items.slice();
  while (rest.length) {
    const side = Math.min(cw, ch), c = rest[0];
    if (!row.length || worst(row.concat(c), side) <= worst(row, side)) { row.push(c); rest.shift(); } else flush();
  }
  flush();
}

export function buildLayout(files, world = WORLD) {
  const root = buildTree(files);
  collapse(root);
  const plates = [], leaves = [];
  const sizeOf = (n) => n.files.reduce((a, f) => a + Math.max(1, f.loc), 0) + [...n.dirs.values()].reduce((a, d) => a + sizeOf(d), 0);

  function place(n, x, y, w, h, depth) {
    const pad = depth === 0 ? 0 : Math.max(1.5, 7 - depth * 1.5);
    const head = depth === 0 ? 0 : Math.max(5, 20 - depth * 4);
    if (depth > 0) plates.push({ name: n.name, path: n.path, depth, x, y, w, h, hue: 0 });
    const items = [
      ...[...n.dirs.values()].map((d) => ({ kind: 'dir', key: 'd:' + d.path, node: d, value: sizeOf(d) })),
      ...n.files.map((f) => ({ kind: 'file', key: 'f:' + f.path, file: f, value: Math.max(1, f.loc) })),
    ];
    squarify(items, x + pad, y + pad + head, w - pad * 2, h - pad * 2 - head, (it, ix, iy, iw, ih) => {
      if (it.kind === 'dir') place(it.node, ix, iy, iw, ih, depth + 1);
      else {
        const g = Math.min(1.4, iw / 4, ih / 4);
        const f = it.file;
        leaves.push({ path: f.path, name: f.name, loc: f.loc, complexity: f.complexity ?? 0, x: ix, y: iy, w: iw, h: ih, r: { x: ix + g, y: iy + g, w: Math.max(0.5, iw - g * 2), h: Math.max(0.5, ih - g * 2) } });
      }
    });
  }
  place(root, 0, 0, world.w, world.h, 0);
  // Hue by top-level plate (stable hash of its name), inherited by everything inside.
  const tops = plates.filter((p) => p.depth === 1);
  const hueOf = (path) => { const top = path.split('/')[0]; const t = tops.find((p) => p.path === top || p.path.startsWith(top + '/') || p.name.split('/')[0] === top); return (hash(t ? t.name : top) * 47) % 360; };
  for (const p of plates) p.hue = hueOf(p.path);
  const byPath = new Map();
  for (const l of leaves) { l.hue = hueOf(l.path); l.mx = l.r.x + l.r.w / 2; l.my = l.r.y + l.r.h / 2; l.height = buildingHeight(l.loc, l.complexity); byPath.set(l.path, l); }
  return { plates, leaves, byPath, world };
}
