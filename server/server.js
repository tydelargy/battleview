import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore, redact, normaliseJiraPatch } from './config.js';
import { createJiraClient, syncJira, JiraError } from './jira/client.js';
import { buildSnapshot, normalisePRs, extractKey } from './snapshot.js';
import { WatchStore, classify, reconcileEnded, matchPath, watchedFiles } from './watch.js';
import { NotifyStore, eventsFor, resolveFor } from './notify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.map': 'application/json' };

function findThree() {
  for (let dir of [ROOT, process.cwd()]) {
    for (;;) {
      const cand = path.join(dir, 'node_modules', 'three');
      if (fs.existsSync(path.join(cand, 'build'))) return cand;
      const up = path.dirname(dir); if (up === dir) break; dir = up;
    }
  }
  return null;
}

let threeCache;
const threeDir = () => (threeCache === undefined ? (threeCache = findThree()) : threeCache);

function serveFile(res, root, rel) {
  const abs = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!abs.startsWith(root + path.sep) && abs !== root) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(abs, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

/** The web UI and the vendored three.js. Shared by one app and by the hub, which serves the same page for every city. */
export function serveStatic(res, url) {
  if (url.pathname.startsWith('/vendor/three/')) {
    const dir = threeDir();
    if (!dir) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('three is not installed. Run npm install in the battlemap folder.'); }
    const rel = url.pathname.slice('/vendor/three/'.length);
    if (!/^(build|examples\/jsm)\//.test(rel)) { res.writeHead(404); return res.end('not found'); }
    return serveFile(res, dir, rel);
  }
  return serveFile(res, WEB, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
}

export function createApp({ store = new ConfigStore(), watch, notify, files = [], prs = [], sampleMode = false, log = () => {} } = {}) {
  // Tracking choices sit next to the config. Mock Jira runs never write to disk, and neither do their picks.
  watch = watch || new WatchStore({ file: store.file.replace(/(\.json)?$/, '.watch.json'), persist: store.persist && !store.runtimeOverride });
  notify = notify || new NotifyStore({ file: store.file.replace(/(\.json)?$/, '.notify.json'), persist: store.persist && !store.runtimeOverride });
  const app = {
    store, files, sampleMode, problems: [], prs: [], jira: null, jiraError: null,
    sse: new Set(), version: 0, timer: null, server: null,
    // Seed with what was tracked last time, so PRs that ended while we were down are noticed. Not in sample mode.
    view: { mode: 'picked', live: sampleMode ? [] : watch.get().live.map((p) => ({ ...p, tracked: { by: [] } })), ended: [], available: [], availableTotal: 0 },
  };

  /** A real feed replaces the built-in sample. The sample's PRs are not "tracked work that ended", so forget them. */
  function leaveSample() { if (app.sampleMode) { app.sampleMode = false; app.view = { ...app.view, live: [] }; } }

  /** Re-derive what is tracked from the feed and the watch choices, and keep ended PRs around. */
  function reconcile() {
    const w = watch.get();
    const c = classify({ prs: app.prs, watch: w, sampleMode: app.sampleMode, prevLiveIds: new Set(app.view.live.map((p) => p.id)) });
    const ended = reconcileEnded({ prevLive: app.view.live, feed: app.prs, endedFromFeed: c.endedFromFeed, stored: w.ended, muted: w.muted });
    watch.setEnded(ended);
    if (!app.sampleMode) watch.setLive(c.live);
    // What happened to the PRs we were already tracking? (First sight, and a restart with nothing new, announce nothing.)
    let seq = notify.get().seq;
    notify.add(eventsFor(app.view.live, c.live, notify.get().policy, { nextId: () => `n${++seq}` }));
    app.view = { mode: c.mode, live: c.live, ended, available: c.available, availableTotal: c.availableTotal };
  }

  function setPRs(input) {
    const { prs: list, problems } = normalisePRs(input, store.get().identity);
    app.prs = list; app.problems = problems;
    reconcile();
    return { count: list.length, problems };
  }
  // prs: null means "no feed yet": the PRs remembered from last time stay as they are until the first real feed arrives (the hub does this for a city it has just opened)
  if (prs !== null) setPRs(prs);

  const prKeys = () => [...app.view.live, ...app.view.ended].map((p) => extractKey(p, store.get().jira.keyPattern)).filter(Boolean);
  const watchInfo = () => {
    const w = watch.get(), mode = app.view.mode;
    return {
      mode, explicitMode: w.mode, feedCount: app.prs.length, trackedCount: app.view.live.length, availableTotal: app.view.availableTotal,
      watchedPaths: watchedFiles(app.files, w.rules),
      rules: w.rules.map((r) => ({ ...r, files: r.type === 'path' ? app.files.filter((f) => matchPath(r.value, f.path)).length : null, matches: app.prs.filter((p) => !p.status.match(/^(merged|closed)$/) && (r.type === 'author' ? String(p.author).toLowerCase() === r.value.toLowerCase() : p.files.some((f) => matchPath(r.value, f.path)))).length })),
      pendingPicks: w.picked.filter((x) => !app.prs.some((p) => p.id === x.key || p.id === `#${x.key}` || String(p.number) === x.key)).map((x) => x.key),
      authors: [...new Set(app.prs.map((p) => p.author))].sort(),
    };
  };
  const snapshot = () => withNotifications({ ...buildSnapshot({ files: app.files, prs: app.view.live, ended: app.view.ended, jira: app.jira ? { ...app.jira, error: app.jiraError?.message, hint: app.jiraError?.hint } : (app.jiraError ? { ok: false, error: app.jiraError.message, hint: app.jiraError.hint } : null), cfg: store.get(), defaultBranch: app.city?.branch || null }), version: app.version, sampleMode: app.sampleMode, ...(app.city ? { city: app.city } : {}), problems: app.problems, mock: !!store.runtimeOverride, watch: watchInfo(), available: app.view.available });
  /** Alerts you have silenced move to their own list; the inbox goes to the browser newest first. */
  function withNotifications(snap) {
    const sil = notify.silencedIds(), n = notify.get();
    snap.silenced = snap.insights.filter((i) => sil.has(i.id));
    snap.insights = snap.insights.filter((i) => !sil.has(i.id));
    // what each PR will actually do, and whether that is its own choice or the default: the PR's bell menu shows it
    const byPR = Object.fromEntries(snap.prs.map((p) => [p.id, resolveFor(n.policy, p.id)]));
    snap.notifications = { policy: n.policy, byPR, inbox: [...n.inbox].reverse().slice(0, 100), total: n.inbox.length, unread: notify.unread(), lastSeen: n.lastSeen };
    return snap;
  }

  function broadcast() {
    app.version++;
    for (const res of app.sse) res.write(`event: snapshot\ndata: ${app.version}\n\n`);
  }

  async function refreshJira() {
    const cfg = store.get().jira;
    if (!cfg.baseUrl || !cfg.token) { app.jira = null; app.jiraError = null; broadcast(); return; }
    try {
      const r = await syncJira(cfg, prKeys());
      app.jira = r; app.jiraError = null;
    } catch (e) {
      // Keep the last good data on screen but flag it stale.
      app.jiraError = e instanceof JiraError ? e : new JiraError(String(e.message || e));
      if (app.jira) app.jira = { ...app.jira, ok: true, stale: true };
      log(`jira sync failed: ${app.jiraError.message}`);
    }
    broadcast();
  }

  function schedule() {
    clearTimeout(app.timer);
    const secs = store.get().jira.pollSeconds || 60;
    app.timer = setTimeout(async () => { await refreshJira(); schedule(); }, secs * 1000);
    app.timer.unref?.();
  }

  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const readJson = (req, limit = 5_000_000) => new Promise((resolve, reject) => {
    let b = '', n = 0;
    req.on('data', (c) => { n += c.length; if (n > limit) { reject(new Error('body too large')); req.destroy(); } else b += c; });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('invalid JSON')); } });
  });
  const clientFor = (jira) => createJiraClient(jira);
  const fail = (res, e) => {
    if (e instanceof JiraError) return json(res, 200, { ok: false, error: e.message, hint: e.hint || null, status: e.status || null });
    return json(res, 400, { ok: false, error: String(e.message || e) });
  };

  function hostOk(req) {
    const h = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    return ['localhost', '127.0.0.1', '[::1]', ...(app.allowHosts || [])].includes(h);
  }

  async function api(req, res, url) {
    const p = url.pathname, m = req.method;
    if (m !== 'GET') {
      // Browsers cannot add a custom header cross-origin without a preflight we never grant.
      if (req.headers['x-battlemap'] !== '1') return json(res, 403, { error: 'missing X-Battlemap header' });
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'cross-origin request refused' });
    }
    if (p === '/api/snapshot' && m === 'GET') return json(res, 200, snapshot());
    if (p === '/api/events' && m === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${app.version}\n\n`);
      app.sse.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); app.sse.delete(res); });
      return;
    }
    if (p === '/api/config' && m === 'GET') return json(res, 200, redact(store.get(), store));
    if (p === '/api/config/jira' && m === 'PUT') {
      const r = store.updateJira(await readJson(req));
      if (!r.ok) return json(res, 400, r);
      refreshJira().then(schedule);
      return json(res, 200, { ...r, config: redact(store.get(), store) });
    }
    if (p === '/api/config/display' && m === 'PUT') { const r = store.update('display', await readJson(req)); return json(res, r.ok ? 200 : 400, r); }
    if (p === '/api/config/identity' && m === 'PUT') {
      const b = await readJson(req);
      const authors = (Array.isArray(b.prAuthors) ? b.prAuthors : String(b.prAuthors || '').split(/[\s,]+/)).map((s) => s.trim()).filter(Boolean);
      const r = store.update('identity', { prAuthors: authors });
      setPRs(app.prs.map((x) => ({ ...x, mine: undefined })));   // re-derive "mine"
      broadcast();
      return json(res, 200, r);
    }
    if (p === '/api/prs' && m === 'POST') {
      const b = await readJson(req);
      leaveSample();      // before setPRs: real data means opt-in tracking, not the demo's track-everything
      const r = setPRs(Array.isArray(b) ? b : b.prs);
      refreshJira();
      return json(res, 200, { ok: true, ...r });
    }
    // Choosing what to track. Every change re-derives the tracked set, then Jira is asked about any new tickets.
    if (p.startsWith('/api/watch/')) {
      const b = await readJson(req);
      let r;
      if (p === '/api/watch/pick' && m === 'POST') r = watch.pick(b.ref);
      else if (p === '/api/watch/unpick' && m === 'POST') r = watch.unpick(b.id);
      else if (p === '/api/watch/rule' && m === 'POST') r = watch.addRule(b.type, b.value);
      else if (p === '/api/watch/unrule' && m === 'POST') r = watch.removeRule(b.type, b.value);
      else if (p === '/api/watch/dismiss' && m === 'POST') r = watch.dismiss(b.id);
      else if (p === '/api/watch/mode' && m === 'PUT') r = watch.setMode(b.mode ?? null);
      else return json(res, 404, { error: 'no such endpoint' });
      if (!r.ok) return json(res, 400, r);
      reconcile();
      if (p === '/api/watch/pick' && r.key) r.matched = app.view.live.find((x) => x.id === r.key || x.id === `#${r.key}` || String(x.number) === r.key)?.id ?? null;
      refreshJira();
      return json(res, 200, r);
    }
    // Notification policy, the inbox, and silenced alerts. Nothing here touches PRs or Jira, so a change just tells the browser.
    if (p.startsWith('/api/notify/') || p.startsWith('/api/alerts/')) {
      const b = await readJson(req);
      let r;
      if (p === '/api/notify/policy' && m === 'PUT') r = notify.setGlobal(b.kind, b.enabled);
      else if (p === '/api/notify/pr' && m === 'PUT') r = notify.setPR(b.id, b.kind, b.enabled === undefined ? null : b.enabled);
      else if (p === '/api/notify/clear' && m === 'POST') r = notify.clear(b.id);
      else if (p === '/api/notify/seen' && m === 'POST') { notify.markSeen(); r = { ok: true }; }
      else if (p === '/api/alerts/silence' && m === 'POST') r = notify.silence(Array.isArray(b.ids) ? b.ids : []);
      else if (p === '/api/alerts/restore' && m === 'POST') r = notify.restore(Array.isArray(b.ids) ? b.ids : []);
      else return json(res, 404, { error: 'no such endpoint' });
      if (!r.ok) return json(res, 400, r);
      broadcast();
      return json(res, 200, r);
    }
    if (p === '/api/refresh' && m === 'POST') { await refreshJira(); return json(res, 200, { ok: true }); }

    // Jira helpers. Overrides in the body let the settings form test unsaved values.
    if (p === '/api/jira/test' && m === 'POST') {
      const b = await readJson(req);
      const cur = store.get().jira;
      const { value, errors } = normaliseJiraPatch(cur, b);
      if (errors.length) return json(res, 200, { ok: false, error: errors.join('. ') });
      try {
        const t0 = Date.now();
        const c = clientFor(value);
        const me = await c.myself();
        let info = {};
        try { info = await c.serverInfo(); } catch { /* some proxies hide it */ }
        let sprint = null;
        if (value.boardId) { try { sprint = (await c.activeSprintIssues(value.boardId)).sprint; } catch (e) { return json(res, 200, { ok: true, user: me.displayName, warning: `Signed in, but board ${value.boardId} failed: ${e.message}`, hint: e.hint || null, version: info.version || null }); } }
        return json(res, 200, { ok: true, user: me.displayName, email: me.emailAddress || null, version: info.version || null, deployment: info.deploymentType || null, sprint, latencyMs: Date.now() - t0 });
      } catch (e) { return fail(res, e); }
    }
    if (p === '/api/jira/detect-fields' && m === 'POST') {
      try {
        const { value } = normaliseJiraPatch(store.get().jira, await readJson(req));
        const list = await clientFor(value).fields();
        const find = (re) => list.find((f) => f.custom && re.test(f.name))?.id || null;
        return json(res, 200, { ok: true, epicLinkField: find(/^epic link$/i), storyPointsField: find(/^story points?$|^story point estimate$/i), sprintField: find(/^sprint$/i) });
      } catch (e) { return fail(res, e); }
    }
    if (p === '/api/jira/boards' && m === 'POST') {
      try {
        const { value } = normaliseJiraPatch(store.get().jira, await readJson(req));
        return json(res, 200, { ok: true, boards: await clientFor(value).boards(value.projectKeys) });
      } catch (e) { return fail(res, e); }
    }
    let mm;
    if ((mm = p.match(/^\/api\/jira\/transitions\/([A-Za-z0-9-]+)$/)) && m === 'GET') {
      try { return json(res, 200, { ok: true, transitions: await clientFor(store.get().jira).transitions(mm[1]) }); } catch (e) { return fail(res, e); }
    }
    if (p === '/api/jira/transition' && m === 'POST') {
      try {
        const b = await readJson(req);
        if (!/^[A-Za-z0-9-]+$/.test(b.key || '') || !b.transitionId) return json(res, 400, { ok: false, error: 'key and transitionId required' });
        await clientFor(store.get().jira).transition(b.key, b.transitionId);
        await refreshJira();
        return json(res, 200, { ok: true });
      } catch (e) { return fail(res, e); }
    }
    if (p === '/api/jira/comment' && m === 'POST') {
      try {
        const b = await readJson(req);
        if (!/^[A-Za-z0-9-]+$/.test(b.key || '') || !String(b.text || '').trim()) return json(res, 400, { ok: false, error: 'key and text required' });
        await clientFor(store.get().jira).comment(b.key, String(b.text));
        return json(res, 200, { ok: true });
      } catch (e) { return fail(res, e); }
    }
    return json(res, 404, { error: 'no such endpoint' });
  }

  /** One request. The hub calls this directly for a city (with the city's prefix already stripped); a standalone app serves it itself. */
  app.handle = async (req, res) => {
    try {
      if (!hostOk(req)) { res.writeHead(421); return res.end('unrecognised Host header'); }
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      return serveStatic(res, url);
    } catch (e) {
      if (!res.headersSent) json(res, 500, { error: String(e.message || e) }); else res.end();
    }
  };
  app.server = http.createServer(app.handle);

  app.threeInstalled = !!threeDir();
  app.setPRs = (x) => { leaveSample(); const r = setPRs(x); broadcast(); return r; };
  app.watch = watch; app.notify = notify;
  /** Swap in a fresh file list (a rescan of the checkout). Returns whether anything changed. */
  const filesKey = (list) => list.map((f) => `${f.path}:${f.loc}:${f.complexity ?? 0}`).join('|');
  let currentFilesKey = filesKey(app.files);
  app.setFiles = (list) => { const k = filesKey(list); if (k === currentFilesKey) return false; currentFilesKey = k; app.files = list; broadcast(); return true; };
  app.refreshJira = refreshJira;
  app.snapshot = snapshot;
  app.listen = (port, host = '127.0.0.1') => new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(port, host, async () => {
      const a = app.server.address();
      app.start();
      resolve({ port: a.port, url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${a.port}` });
    });
  });
  /** Begin refreshing Jira on a timer. A city hosted by the hub starts when you go into it and stops when you leave. */
  app.start = () => { refreshJira().then(schedule); };
  app.stop = () => { clearTimeout(app.timer); app.timer = null; for (const r of app.sse) r.end(); app.sse.clear(); };
  app.close = () => new Promise((resolve) => {
    app.stop();
    app.server.closeAllConnections?.();
    app.server.close(() => resolve());
  });
  return app;
}
