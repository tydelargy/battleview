// The hub: many repos in one process. It keeps the list of "cities" (one per repo) and where each stands on the hex grid,
// builds a city from the remote alone (the file tree through `gh api`: no clone, ever), and hosts one isolated app per
// city under /r/<id>/ (its own tracking rules, notifications and PRs; Jira settings are shared). The world view is the
// same web page, served from "/".
//
// Cheap until you look: the world view only asks for three PR numbers per city. A city's PRs are fetched in full, and
// kept fresh, only while someone is in that city.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from './config.js';
import { WatchStore } from './watch.js';
import { NotifyStore } from './notify.js';
import { createApp, serveStatic } from './server.js';
import { parseRepoRef, repoKey, fetchRepoTree, fetchPRStats, fetchGithub } from './providers/github.js';
import { frontier, nextSlot, canMove, hexKey, connected } from '../web/hex.js';

export const cityId = (r) => repoKey(r).toLowerCase().replace(/\//g, '--');
const ID = /^[a-z0-9_.-]+(--[a-z0-9_.-]+){1,2}$/;
const MAX_CITIES = 60;

/** Where a hub gets its repos from: three calls (the file tree, three PR numbers, the PRs). GitHub through gh by default; the demo has its own. */
export const ghProvider = ({ gh = 'gh', exec } = {}) => { const o = { gh, ...(exec ? { exec } : {}) }; return {
  tree: (ref, opts = {}) => fetchRepoTree({ repo: ref, ...(opts.at ? { at: opts.at } : {}), ...o }), stats: (ref) => fetchPRStats({ repo: ref, ...o }), prs: (ref) => fetchGithub({ repo: `${ref.owner}/${ref.name}`, host: ref.host, ...o }) }; };

export function createHub({ dataDir, store = new ConfigStore({ persist: false }), gh = 'gh', exec, provider = null, now = () => Date.now(), log = () => {},
  statsTtl = 300_000, treeTtl = 3_600_000, prEvery = 120_000, idleAfter = 300_000, autoSync = true } = {}) {
  if (!dataDir) throw new Error('createHub needs a dataDir');
  const file = path.join(dataDir, 'hub.json'), source = provider || ghProvider({ gh, exec });
  const hub = { cities: [], apps: new Map(), stats: new Map(), seen: new Map(), watches: new Map(), notifies: new Map(), server: null, timers: [] };
  const cityDir = (id) => path.join(dataDir, 'cities', id);

  // ---- the list of cities ----
  function load() {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')), seen = new Set(), ids = new Set();
      for (const c of Array.isArray(raw.cities) ? raw.cities : []) {
        const ok = c && ID.test(c.id) && typeof c.owner === 'string' && typeof c.name === 'string' && Number.isInteger(c.q) && Number.isInteger(c.r);
        if (!ok || seen.has(`${c.q},${c.r}`) || ids.has(c.id)) continue;
        seen.add(`${c.q},${c.r}`); ids.add(c.id);
        hub.cities.push({ id: c.id, host: typeof c.host === 'string' ? c.host : null, owner: c.owner, name: c.name, q: c.q, r: c.r, addedAt: c.addedAt || null });
      }
    } catch (e) { if (e.code !== 'ENOENT') log(`could not read ${file}: ${e.message}`); }
  }
  function save() {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, cities: hub.cities }, null, 2), { mode: 0o600 });
  }
  load();

  const cityRepo = (c) => ({ host: c.host, owner: c.owner, name: c.name });
  const find = (id) => hub.cities.find((c) => c.id === id);
  const occupied = () => hub.cities.map((c) => ({ q: c.q, r: c.r }));
  const treeFile = (id) => path.join(cityDir(id), 'tree.json');
  const readTree = (id) => { try { return JSON.parse(fs.readFileSync(treeFile(id), 'utf8')); } catch { return null; } };
  function writeTree(id, tree) { fs.mkdirSync(cityDir(id), { recursive: true }); fs.writeFileSync(treeFile(id), JSON.stringify({ ...tree, fetchedAt: now() })); }
  const watchOf = (id) => { if (!hub.watches.has(id)) hub.watches.set(id, new WatchStore({ file: path.join(cityDir(id), 'watch.json'), persist: true })); return hub.watches.get(id); };
  const notifyOf = (id) => { if (!hub.notifies.has(id)) hub.notifies.set(id, new NotifyStore({ file: path.join(cityDir(id), 'notify.json'), persist: true })); return hub.notifies.get(id); };

  // ---- the numbers on the world view ----
  async function refreshStats(id) {
    const c = find(id); if (!c) return null;
    const slot = hub.stats.get(id) || {}; hub.stats.set(id, { ...slot, pending: true });
    try { const s = await source.stats(cityRepo(c)); hub.stats.set(id, { ...s, at: now(), error: null }); }
    catch (e) { hub.stats.set(id, { ...slot, pending: false, error: String(e.message || e).split('\n')[0], at: now() }); }
    return hub.stats.get(id);
  }
  const statsView = (c) => {
    const s = hub.stats.get(c.id) || {}, app = hub.apps.get(c.id);
    const tracked = app ? app.view.live.length : watchOf(c.id).get().live.length;
    return { open: s.open ?? null, mine: s.mine ?? null, needs: s.needs ?? null, tracked, error: s.error || null, loading: !!s.pending || (!s.at && !s.error), at: s.at || null };
  };
  function summary() {
    for (const c of hub.cities) { const s = hub.stats.get(c.id); if (!s || (!s.pending && now() - (s.at || 0) > statsTtl)) refreshStats(c.id); }
    return hub.cities.map((c) => {
      const t = readTree(c.id);
      return { id: c.id, key: repoKey(c), host: c.host, owner: c.owner, name: c.name, q: c.q, r: c.r, files: t?.files?.length ?? 0, branch: t?.branch || null, estimated: t?.estimated ?? true, stats: statsView(c) };
    });
  }
  const worldView = () => ({ cities: summary(), slots: frontier(occupied()), max: MAX_CITIES });

  // ---- adding, moving, removing ----
  async function addCity(input, slot = null) {
    const ref = parseRepoRef(input);
    if (!ref) return { ok: false, error: 'That does not look like a repository: use org/name or a URL' };
    const c = { id: cityId(ref), host: ref.host && ref.host !== 'github.com' ? ref.host : null, owner: ref.owner, name: ref.name };
    if (find(c.id)) return { ok: false, error: `${repoKey(ref)} is already here` };
    if (hub.cities.length >= MAX_CITIES) return { ok: false, error: `That is as many cities as the map holds (${MAX_CITIES})` };
    const open = frontier(occupied());
    if (slot && !open.some((h) => h.q === slot.q && h.r === slot.r)) return { ok: false, error: 'Cities have to sit next to another city' };
    let tree; try { tree = await source.tree(ref); } catch (e) { return { ok: false, error: String(e.message || e).split('\n')[0] }; }   // look before registering: a typo or a missing login never leaves an empty plot
    const at = slot || nextSlot(occupied());
    hub.cities.push({ ...c, q: at.q, r: at.r, addedAt: new Date(now()).toISOString() }); writeTree(c.id, tree); save();
    refreshStats(c.id);
    return { ok: true, city: summary().find((x) => x.id === c.id), warnings: tree.warnings };
  }
  function moveCity(id, to) {
    const c = find(id); if (!c) return { ok: false, error: 'No such city' };
    if (!Number.isInteger(to?.q) || !Number.isInteger(to?.r)) return { ok: false, error: 'q and r must be whole numbers' };
    if (!canMove(occupied(), { q: c.q, r: c.r }, to)) return { ok: false, error: 'A city can only move to a free hex that touches another city, and must not cut the group in two' };
    c.q = to.q; c.r = to.r; save(); return { ok: true };
  }
  function removeCity(id) {
    const c = find(id); if (!c) return { ok: false, error: 'No such city' };
    const rest = hub.cities.filter((x) => x !== c).map((x) => ({ q: x.q, r: x.r }));
    if (!connected(rest)) return { ok: false, error: 'Move the cities around first: removing this one would cut the group in two' };
    leave(id); hub.cities = hub.cities.filter((x) => x !== c); hub.stats.delete(id); hub.watches.delete(id); hub.notifies.delete(id); save();
    const dir = cityDir(id); if (dir.startsWith(path.join(dataDir, 'cities') + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
    return { ok: true };
  }

  // ---- the files as they stood somewhere else (a PR's branch point, or the branch it is stacked on) ----
  // Read on demand and remembered for a couple of minutes (a commit never changes; a branch moves). A handful at most.
  const atCache = new Map(), AT_TTL = 120_000, AT_MAX = 12;
  async function treeAt(id, at) {
    const c = find(id); if (!c) throw new Error('no such city');
    const key = `${id}|${at}`, hit = atCache.get(key); if (hit && now() - hit.t < AT_TTL) return hit.tree;
    const tree = await source.tree(cityRepo(c), { at });
    atCache.set(key, { t: now(), tree }); while (atCache.size > AT_MAX) atCache.delete(atCache.keys().next().value);
    return tree;
  }

  // ---- going into a city: its app, and its PRs, start now ----
  async function syncPRs(id) {
    const c = find(id), app = hub.apps.get(id); if (!c || !app) return;
    try { const r = await source.prs(cityRepo(c)); app.city.warnings = r.warnings; app.setPRs(r.prs); }
    catch (e) { app.city.error = String(e.message || e).split('\n')[0]; log(`${id}: PR sync failed: ${app.city.error}`); }
  }
  async function refreshTree(id) {
    const c = find(id), app = hub.apps.get(id); if (!c || !app) return;
    try { const t = await source.tree(cityRepo(c)); writeTree(id, t); app.city.warnings = t.warnings; app.setFiles(t.files); } catch (e) { log(`${id}: tree refresh failed: ${e.message}`); }
  }
  function enter(id) {
    const c = find(id); if (!c) return null;
    hub.seen.set(id, now());
    if (!hub.apps.has(id)) {
      const tree = readTree(id) || { files: [], warnings: [] };
      const app = createApp({ store, watch: watchOf(id), notify: notifyOf(id), files: tree.files, prs: null, sampleMode: false, log });   // no feed yet: what was tracked last time shows at once, the sync replaces it
      app.city = { id, key: repoKey(c), estimated: tree.estimated ?? true, branch: tree.branch || null, warnings: tree.warnings || [], error: null };
      app.treeAt = (at) => treeAt(id, at);
      hub.apps.set(id, app); app.start();
      if (autoSync) { syncPRs(id); if (!tree.fetchedAt || now() - tree.fetchedAt > treeTtl) refreshTree(id); }
    }
    return hub.apps.get(id);
  }
  function leave(id) { const app = hub.apps.get(id); if (app) { app.stop(); hub.apps.delete(id); } hub.seen.delete(id); }

  // ---- http ----
  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readJson = (req) => new Promise((resolve, reject) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > 100_000) { reject(new Error('body too large')); req.destroy(); } }); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid JSON')); } }); });
  const hostOk = (req) => ['localhost', '127.0.0.1', '[::1]'].includes((req.headers.host || '').toLowerCase().replace(/:\d+$/, ''));

  async function hubApi(req, res, url) {
    const p = url.pathname, m = req.method;
    if (m !== 'GET') {
      if (req.headers['x-battlemap'] !== '1') return json(res, 403, { error: 'missing X-Battlemap header' });
      const origin = req.headers.origin; if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' });
    }
    if (p === '/api/hub/world' && m === 'GET') return json(res, 200, worldView());
    if (p === '/api/hub/tree' && m === 'GET') {                              // a city's shape for the world view: just path, lines, complexity. Looking at it does not open the city
      const id = url.searchParams.get('id') || '', t = ID.test(id) && find(id) ? readTree(id) : null;
      const limit = Math.min(2000, Math.max(1, Number(url.searchParams.get('limit')) || 600));      // the world draws a few hundred buildings per city: send the biggest files, not all 6000
      const files = t ? (t.files.length > limit ? [...t.files].sort((a, b) => b.loc - a.loc || (a.path < b.path ? -1 : 1)).slice(0, limit) : t.files) : null;
      return t ? json(res, 200, { id, files: files.map((f) => [f.path, f.loc, f.complexity]), total: t.files.length }) : json(res, 404, { error: 'no such city' });
    }
    const b = m === 'GET' ? {} : await readJson(req);
    if (p === '/api/hub/add' && m === 'POST') return json(res, 200, await addCity(b.url, b.q === undefined ? null : { q: b.q, r: b.r }));
    if (p === '/api/hub/move' && m === 'POST') return json(res, 200, moveCity(b.id, { q: b.q, r: b.r }));
    if (p === '/api/hub/remove' && m === 'POST') return json(res, 200, removeCity(b.id));
    return json(res, 404, { error: 'no such endpoint' });
  }

  hub.handle = async (req, res) => {
    try {
      if (!hostOk(req)) { res.writeHead(421); return res.end('unrecognised Host header'); }
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/hub/')) return await hubApi(req, res, url);
      const m = url.pathname.match(/^\/r\/([^/]+)(\/.*)$/);
      if (m) {
        if (!ID.test(m[1]) || !find(m[1])) return json(res, 404, { error: 'no such city' });
        const app = enter(m[1]); req.url = m[2] + url.search;               // the city's app sees an ordinary request
        return await app.handle(req, res);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'this is the hub: cities are under /r/<id>/api/' });
      return serveStatic(res, url);
    } catch (e) { if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end(); }
  };

  hub.server = http.createServer(hub.handle);
  hub.listen = (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
    hub.server.once('error', reject);
    hub.server.listen(port, host, () => {
      const a = hub.server.address();
      if (autoSync) {
        // keep every city that someone is looking at fresh, and let the rest go quiet
        hub.timers.push(setInterval(() => { for (const id of hub.apps.keys()) { if (now() - (hub.seen.get(id) || 0) > idleAfter) leave(id); else syncPRs(id); } }, prEvery).unref());
      }
      resolve({ port: a.port, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${a.port}` });
    });
  });
  hub.close = () => new Promise((resolve) => {
    for (const t of hub.timers) clearInterval(t);
    for (const id of [...hub.apps.keys()]) leave(id);
    hub.server.closeAllConnections?.(); hub.server.close(() => resolve());
  });
  Object.assign(hub, { addCity, moveCity, removeCity, enter, leave, refreshStats, worldView, find, syncPRs, refreshTree });
  return hub;
}
