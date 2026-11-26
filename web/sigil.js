// How a PR flag says who and what it is, so it can be recognised from far away.
// Pure and tested. Each channel carries one fact, so they never fight over colour:
//   ring colour -> status        fill colour -> author        text -> PR number
//   emblem shape + hue -> epic   (PRs with no epic get no emblem)

/** FNV-1a, 32 bit. Stable across runs and machines. */
export function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export const EMBLEMS = ['circle', 'diamond', 'triangle', 'square', 'hexagon', 'star'];
const EMBLEM_HUES = 12;   // 30 degree steps: far enough apart to tell at a glance

/** The PR number as a string, or null. Prefers `number`, falls back to a trailing "#123" style id. */
export function prNumber(pr) {
  if (pr.number != null && pr.number !== '') return String(pr.number);
  const m = String(pr.id || '').match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

/** Short text for the collapsed flag: "#2291", or the start of the id when there is no number. */
export function flagLabel(pr) {
  const n = prNumber(pr);
  return n ? `#${n}` : String(pr.id || '?').slice(0, 7);
}

export function authorHue(author) {
  let x = 0; for (const c of String(author || '')) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}
export const authorColor = (author) => `hsl(${authorHue(author)} 60% 70%)`;

/** Shape and hue for an epic name, or null when the PR has none. Case and spacing do not matter. */
export function epicEmblem(epic) {
  const key = String(epic || '').trim().toLowerCase();
  if (!key) return null;
  const h = hash32(key);
  return { shape: EMBLEMS[h % EMBLEMS.length], hue: (Math.floor(h / EMBLEMS.length) % EMBLEM_HUES) * (360 / EMBLEM_HUES) };
}
