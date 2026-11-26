// Deterministic hunk synthesis. When a PR provider only knows per-file totals,
// we split them into plausible hunks so focus mode has something to draw.
// Real providers should send `hunks: [{add, del}]` in file order and skip this.
export function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function rng(seed) { return () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

export function synthHunks(path, add, del) {
  add = Math.max(0, Math.round(add)); del = Math.max(0, Math.round(del));
  const total = add + del;
  if (!total) return [];
  const r = rng(hash(path + ':' + add + ':' + del));
  const n = Math.max(1, Math.min(12, Math.round(Math.sqrt(total / 10))));
  const split = (sum) => {
    const w = Array.from({ length: n }, () => 0.15 + r());
    const ws = w.reduce((a, b) => a + b, 0);
    const parts = w.map((x) => Math.floor((x / ws) * sum));
    let rest = sum - parts.reduce((a, b) => a + b, 0);
    for (let i = 0; rest > 0; i = (i + 1) % n, rest--) parts[i]++;
    return parts;
  };
  const a = split(add), d = split(del);
  const out = [];
  for (let i = 0; i < n; i++) {
    let h = { add: a[i], del: d[i] };
    // Some hunks are pure additions or pure deletions, like real diffs.
    if (add && del && r() < 0.3) { if (r() < 0.5) { a[(i + 1) % n] += h.add; h = { add: 0, del: h.del }; } else { d[(i + 1) % n] += h.del; h = { add: h.add, del: 0 }; } }
    out.push(h);
  }
  const sum = out.reduce((s, h) => ({ add: s.add + h.add, del: s.del + h.del }), { add: 0, del: 0 });
  out[out.length - 1].add += add - sum.add; out[out.length - 1].del += del - sum.del;   // keep totals exact
  return out.filter((h) => h.add + h.del > 0);
}
