// Which PRs does the map track? The feed (prs.json or POST /api/prs) is the pool of everything open;
// tracking is opt-in on top of it, so a monorepo with hundreds of PRs only shows the ones you care about.
//
// A PR is tracked when, and only when, one of these holds (and it has not been muted):
//   mine    its author is one of your handles
//   pick    you tracked it by link or from the list
//   author  an author rule matches ("everything maya opens")
//   path    a path rule matches any file it touches ("anything under packages/billing/")
//   all     mode is "all" (the default for the built-in sample, so the demo is not empty)
// Tracked PRs that leave the feed, or arrive merged or closed, are kept until you dismiss them.
import fs from 'node:fs';
import path from 'node:path';

export const ENDED_STATUSES = new Set(['merged', 'closed']);
export const isEnded = (pr) => ENDED_STATUSES.has(pr.status);
const MAX_ENDED = 200, MAX_LIVE = 500, MAX_PICKS = 500, MAX_RULES = 100, MAX_LEN = 300;

/** "https://github.com/o/r/pull/123", "#123", "PR 123" or "123" -> "123". Null when there is no number. */
export function parsePRRef(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const m = s.match(/\/pulls?\/(\d+)/i) || s.match(/\/merge_requests\/(\d+)/i) || s.match(/^(?:pr\s*)?#?\s*(\d+)$/i);
  return m ? m[1] : null;
}

/** Does a stored key ("123" or an exact id) point at this PR? */
export function refMatches(key, pr) {
  const k = String(key);
  return pr.id === k || pr.id === `#${k}` || (pr.number != null && String(pr.number) === k);
}

const esc = (c) => c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
/** Glob to RegExp. `**` crosses folders, `*` and `?` stay inside one. `**` then `/` also matches zero folders. */
export function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; out += '(?:.*/)?'; } else out += '.*'; } else out += '[^/]*';
    } else if (c === '?') out += '[^/]'; else out += esc(c);
  }
  return new RegExp(`^${out}$`);
}

export const normalisePattern = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.?\/+/, '');

/** A plain path matches that file and anything under it; a pattern with * or ? is a glob. */
export function matchPath(pattern, file) {
  const p = normalisePattern(pattern);
  if (!p) return false;
  if (/[*?]/.test(p)) return globToRegExp(p).test(file);
  const dir = p.replace(/\/+$/, '');
  return file === dir || file.startsWith(dir + '/');
}

export function trackedBy(pr, watch, mode) {
  if ((watch.muted || []).some((k) => refMatches(k, pr))) return [];
  const by = [];
  if (mode === 'all') by.push({ kind: 'all' });
  if (pr.mine) by.push({ kind: 'mine' });
  if ((watch.picked || []).some((p) => refMatches(p.key, pr))) by.push({ kind: 'pick' });
  for (const r of watch.rules || []) {
    if (r.type === 'author' && String(pr.author).toLowerCase() === r.value.toLowerCase()) by.push({ kind: 'author', value: r.value });
    else if (r.type === 'path') { const f = pr.files.find((x) => matchPath(r.value, x.path)); if (f) by.push({ kind: 'path', value: r.value, file: f.path }); }
  }
  return by;
}

/** Repo files covered by any path rule, for marking the map. Pure. */
export function watchedFiles(files, rules) {
  const pats = rules.filter((r) => r.type === 'path').map((r) => r.value);
  if (!pats.length) return [];
  return files.filter((f) => pats.some((p) => matchPath(p, f.path))).map((f) => f.path);
}

export const effectiveMode = (watch, sampleMode) => watch.mode ?? (sampleMode ? 'all' : 'picked');

const summary = (pr) => ({ id: pr.id, number: pr.number, title: pr.title, author: pr.author, status: pr.status, url: pr.url, updatedAt: pr.updatedAt, files: pr.files.length, adds: pr.adds, dels: pr.dels });

/**
 * Split the feed into tracked-and-open, tracked-but-ended, and available to track. Pure.
 * A PR the feed already lists as merged or closed only gets a card if you picked it or it was open and
 * tracked a moment ago (`prevLiveIds`). Otherwise an author or path rule would flood the tray with old merges.
 */
export function classify({ prs, watch, sampleMode = false, prevLiveIds = new Set(), availableLimit = 300 }) {
  const mode = effectiveMode(watch, sampleMode);
  const live = [], endedFromFeed = [], rest = [];
  for (const pr of prs) {
    let by = trackedBy(pr, watch, mode);
    if (isEnded(pr) && !prevLiveIds.has(pr.id)) by = by.filter((b) => b.kind === 'pick');
    if (!by.length) { if (!isEnded(pr)) rest.push(pr); continue; }
    (isEnded(pr) ? endedFromFeed : live).push({ ...pr, tracked: { by } });
  }
  const t = (p) => Date.parse(p.updatedAt || '') || 0;
  rest.sort((a, b) => t(b) - t(a) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return { mode, live, endedFromFeed, available: rest.slice(0, availableLimit).map(summary), availableTotal: rest.length };
}

/**
 * What stays on screen after the feed changes. A tracked PR that was open and is now gone from the feed
 * becomes "closed" (the feed does not say whether it merged), merged or closed PRs the feed still lists
 * are kept as sent, and a PR that comes back open is dropped from the kept list. Pure.
 */
export function reconcileEnded({ prevLive = [], feed, endedFromFeed, stored, muted = [], now = new Date().toISOString() }) {
  const feedById = new Map(feed.map((p) => [p.id, p]));
  const keep = new Map();
  const isMuted = (pr) => muted.some((k) => refMatches(k, pr));
  const reopened = (e) => { const f = feedById.get(e.id); return !!f && !isEnded(f); };
  for (const e of stored) if (!reopened(e) && !isMuted(e)) keep.set(e.id, e);
  for (const p of prevLive) if (!feedById.has(p.id) && !isMuted(p)) keep.set(p.id, { ...p, status: 'closed', endedAt: now, endedInferred: true });
  for (const p of endedFromFeed) keep.set(p.id, { ...p, endedAt: keep.get(p.id)?.endedAt || p.updatedAt || now });
  return [...keep.values()].sort((a, b) => String(b.endedAt).localeCompare(String(a.endedAt))).slice(0, MAX_ENDED);
}

const EMPTY = () => ({ mode: null, picked: [], rules: [], muted: [], ended: [], live: [] });

/** Tracking choices, kept in a small file next to the config so they survive restarts. */
export class WatchStore {
  constructor({ file = null, persist = true } = {}) {
    this.file = file; this.persist = persist && !!file; this.data = EMPTY(); this.load();
  }
  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')), d = EMPTY();
      if (raw.mode === 'all' || raw.mode === 'picked') d.mode = raw.mode;
      d.picked = (Array.isArray(raw.picked) ? raw.picked : []).filter((p) => p && p.key).map((p) => ({ key: String(p.key), addedAt: p.addedAt || null }));
      d.rules = (Array.isArray(raw.rules) ? raw.rules : []).filter((r) => r && ['author', 'path'].includes(r.type) && r.value).map((r) => ({ type: r.type, value: String(r.value), addedAt: r.addedAt || null }));
      d.muted = (Array.isArray(raw.muted) ? raw.muted : []).map(String);
      d.ended = (Array.isArray(raw.ended) ? raw.ended : []).filter((p) => p && p.id && Array.isArray(p.files));
      d.live = (Array.isArray(raw.live) ? raw.live : []).filter((p) => p && p.id && Array.isArray(p.files));
      this.data = d;
    } catch (e) { if (e.code !== 'ENOENT') console.warn(`battlemap: could not read ${this.file}: ${e.message}`); }
  }
  save() {
    if (!this.persist) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
    return true;
  }
  get() { return this.data; }
  setMode(mode) {
    if (mode !== null && mode !== 'all' && mode !== 'picked') return { ok: false, error: 'mode must be "all", "picked" or null' };
    this.data.mode = mode; this.save(); return { ok: true };
  }
  /** Track one PR. Accepts a link, "#123" or a number, or an exact id. */
  pick(ref) {
    const key = parsePRRef(ref) ?? (String(ref ?? '').trim() || null);
    if (!key || key.length > MAX_LEN) return { ok: false, error: 'Paste a pull request link or number' };
    if (!this.data.picked.some((p) => p.key === key)) {
      if (this.data.picked.length >= MAX_PICKS) return { ok: false, error: `At most ${MAX_PICKS} tracked PRs. Stop tracking some first` };
      this.data.picked.push({ key, addedAt: new Date().toISOString() });
    }
    this.data.muted = this.data.muted.filter((k) => k !== key && k !== `#${key}`);
    this.save(); return { ok: true, key };
  }
  /** Stop tracking a PR by exact id. Muting it keeps a rule from bringing it straight back. */
  unpick(id) {
    id = String(id ?? '');
    if (!id) return { ok: false, error: 'id required' };
    this.data.picked = this.data.picked.filter((p) => p.key !== id && `#${p.key}` !== id);
    if (!this.data.muted.includes(id)) this.data.muted.push(id);
    this.save(); return { ok: true };
  }
  /** Clear a mute, for when the user explicitly tracks something again by id. */
  unmute(id) { this.data.muted = this.data.muted.filter((k) => k !== id); }
  addRule(type, value) {
    if (!['author', 'path'].includes(type)) return { ok: false, error: 'rule type must be author or path' };
    value = type === 'path' ? normalisePattern(value) : String(value ?? '').trim().replace(/^@/, '');
    if (!value || value.length > MAX_LEN) return { ok: false, error: type === 'path' ? 'Enter a file, folder or glob such as packages/billing/**' : 'Enter an author handle' };
    if (this.data.rules.length >= MAX_RULES) return { ok: false, error: `At most ${MAX_RULES} rules` };
    if (!this.data.rules.some((r) => r.type === type && r.value.toLowerCase() === value.toLowerCase())) this.data.rules.push({ type, value, addedAt: new Date().toISOString() });
    this.save(); return { ok: true, value };
  }
  removeRule(type, value) {
    const before = this.data.rules.length;
    this.data.rules = this.data.rules.filter((r) => !(r.type === type && r.value.toLowerCase() === String(value).toLowerCase()));
    this.save(); return { ok: true, removed: before - this.data.rules.length };
  }
  /** Forget an ended PR for good. */
  dismiss(id) {
    id = String(id ?? '');
    if (!id) return { ok: false, error: 'id required' };
    this.data.ended = this.data.ended.filter((p) => p.id !== id);
    if (!this.data.muted.includes(id)) this.data.muted.push(id);
    this.save(); return { ok: true };
  }
  setEnded(list) {
    if (JSON.stringify(list) === JSON.stringify(this.data.ended)) return false;
    this.data.ended = list; this.save(); return true;
  }
  /**
   * Remember which PRs were open and tracked, so one that merges or closes while the server is down
   * still ends up as a card on the next start instead of silently vanishing.
   */
  setLive(list) {
    const slim = list.slice(0, MAX_LIVE).map(({ tracked, ...pr }) => pr);
    if (JSON.stringify(slim) === JSON.stringify(this.data.live)) return false;
    this.data.live = slim; this.save(); return true;
  }
}
