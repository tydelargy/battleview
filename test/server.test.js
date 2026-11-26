import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ConfigStore } from '../server/config.js';
import { createApp } from '../server/server.js';
import { createMockJira } from '../server/jira/mock.js';
import { sampleFiles, samplePRs } from '../server/sample.js';
import { synthHunks } from '../server/hunks.js';
import { scanRepo } from '../server/localrepo.js';

async function boot({ mockOpts = {}, persist = false, file } = {}) {
  const mock = createMockJira(mockOpts); const mu = await mock.listen(0);
  const store = new ConfigStore({ file: file || path.join(os.tmpdir(), `bm-${Math.random()}.json`), env: {}, persist });
  store.runtimeOverride = persist ? null : { jira: { deployment: mockOpts.flavor || 'server', baseUrl: mu.url, token: 'mock-token', email: 'me@example.com', projectKeys: ['ENG'], boardId: '7' } };
  if (persist) store.updateJira({ baseUrl: mu.url, token: 'mock-token', projectKeys: 'ENG' });
  const app = createApp({ store, files: sampleFiles(), prs: samplePRs(), sampleMode: true });
  const info = await app.listen(0);
  const get = (p) => fetch(info.url + p).then((r) => r.json());
  const send = (m, p, body, h = {}) => fetch(info.url + p, { method: m, headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json', ...h }, body: JSON.stringify(body ?? {}) });
  return { app, mock, info, get, send, store, close: async () => { await app.close(); await mock.close(); } };
}
const until = async (fn, ms = 3000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); } throw new Error('timeout'); };

test('snapshot joins PRs to tickets and raises drift insights', async () => {
  const s = await boot();
  try {
    const snap = await until(async () => { const x = await s.get('/api/snapshot'); return x.jira.ok && x; });
    assert.equal(snap.jira.user.name, 'Jordan Lee');
    const pr = snap.prs.find((p) => p.id === '#2302');
    assert.equal(pr.ticketKey, 'ENG-431'); assert.equal(pr.ticket.assignee.name, 'Jordan Lee'); assert.equal(pr.epic, 'Billing v2');
    assert.ok(pr.needs, 'my red CI needs me');
    assert.deepEqual(snap.epics, ['Auth hardening', 'Billing v2', 'Infra cutover', 'Web onboarding']);
    const kinds = new Set(snap.insights.map((i) => i.kind));
    for (const k of ['pr_no_ticket', 'ticket_not_found', 'ticket_todo_pr_active', 'ticket_done_pr_open', 'ticket_review_no_pr', 'ticket_progress_no_pr', 'ticket_not_in_review', 'contested_file']) assert.ok(kinds.has(k), 'missing insight ' + k);
    assert.equal(snap.insights.find((i) => i.kind === 'ticket_done_pr_open').keys[0], 'ENG-472');
    assert.ok(snap.prs.every((p) => p.files.every((f) => f.hunks.reduce((a, h) => a + h.add, 0) === f.add && f.hunks.reduce((a, h) => a + h.del, 0) === f.del)), 'hunks sum to file totals');
  } finally { await s.close(); }
});

test('the token never reaches the browser and the API refuses forged writes', async () => {
  const s = await boot();
  try {
    const cfg = JSON.stringify(await s.get('/api/config'));
    const snap = JSON.stringify(await s.get('/api/snapshot'));
    assert.ok(!cfg.includes('mock-token') && !snap.includes('mock-token'));
    assert.equal((await s.get('/api/config')).jira.tokenSet, true);
    assert.equal((await fetch(s.info.url + '/api/prs', { method: 'POST', body: '[]' })).status, 403, 'needs X-Battlemap');
    assert.equal((await s.send('POST', '/api/prs', [], { Origin: 'http://evil.example' })).status, 403);
    const rawStatus = (host) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port: s.info.port, path: '/api/snapshot', headers: { Host: host } }, (r) => { r.resume(); res(r.statusCode); }); q.on('error', rej); q.end(); });
    assert.equal(await rawStatus('evil.example'), 421, 'DNS rebinding host refused');
    assert.equal(await rawStatus('localhost:' + s.info.port), 200)
    assert.equal((await fetch(s.info.url + '/..%2f..%2fpackage.json')).status, 404);
    assert.equal((await fetch(s.info.url + '/vendor/three/../../package.json')).status, 404);
  } finally { await s.close(); }
});

test('settings: test connection, detect fields, boards, bad token message', async () => {
  const s = await boot();
  try {
    const ok = await (await s.send('POST', '/api/jira/test', {})).json();
    assert.equal(ok.ok, true); assert.equal(ok.user, 'Jordan Lee');
    const bad = await (await s.send('POST', '/api/jira/test', { token: 'wrong' })).json();
    assert.equal(bad.ok, false); assert.match(bad.hint, /personal access token/i);
    const f = await (await s.send('POST', '/api/jira/detect-fields', {})).json();
    assert.deepEqual([f.epicLinkField, f.storyPointsField, f.sprintField], ['customfield_10014', 'customfield_10016', 'customfield_10020']);
    const b = await (await s.send('POST', '/api/jira/boards', {})).json();
    assert.equal(b.boards[0].name, 'Platform Board');
    const invalid = await s.send('PUT', '/api/config/jira', { baseUrl: 'not a url', keyPattern: '(' });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).errors.length, 2);
  } finally { await s.close(); }
});

test('moving a ticket from the app updates the snapshot and live clients hear about it', async () => {
  const s = await boot();
  try {
    await until(async () => (await s.get('/api/snapshot')).jira.ok);
    const events = []; const ac = new AbortController();
    const res = await fetch(s.info.url + '/api/events', { signal: ac.signal });
    (async () => { const r = res.body.getReader(); for (;;) { const { value, done } = await r.read(); if (done) break; events.push(Buffer.from(value).toString()); } })().catch(() => {});
    const { transitions } = await s.get('/api/jira/transitions/ENG-481');
    const tr = transitions.find((t) => t.to === 'In Review');
    const before = events.length;
    assert.equal((await (await s.send('POST', '/api/jira/transition', { key: 'ENG-481', transitionId: tr.id })).json()).ok, true);
    await until(() => events.length > before);
    const snap = await s.get('/api/snapshot');
    assert.equal(snap.prs.find((p) => p.id === '#2311').ticket.status.name, 'In Review');
    assert.ok(!snap.insights.some((i) => i.kind === 'ticket_todo_pr_active'));
    assert.equal((await (await s.send('POST', '/api/jira/comment', { key: 'ENG-481', text: 'from battlemap' })).json()).ok, true);
    assert.equal(s.mock.comments('ENG-481').length, 1);
    ac.abort();
  } finally { await s.close(); }
});

test('jira outage keeps last good data, marks error, recovers', async () => {
  const s = await boot();
  try {
    await until(async () => (await s.get('/api/snapshot')).jira.ok);
    await fetch(s.mock.server.address && `http://127.0.0.1:${s.mock.server.address().port}/__mock/chaos`, { method: 'POST', body: JSON.stringify({ mode: '500' }) });
    await s.send('POST', '/api/refresh');
    let snap = await s.get('/api/snapshot');
    assert.ok(snap.jira.error && snap.jira.ok, 'stale but still shown'); assert.ok(snap.prs[0].ticket, 'tickets still joined');
    await fetch(`http://127.0.0.1:${s.mock.server.address().port}/__mock/chaos`, { method: 'POST', body: JSON.stringify({ mode: 'off' }) });
    await s.send('POST', '/api/refresh');
    snap = await s.get('/api/snapshot'); assert.equal(snap.jira.error, null);
  } finally { await s.close(); }
});

test('ingest API validates PRs and falls back sensibly', async () => {
  const s = await boot();
  try {
    const r = await (await s.send('POST', '/api/prs', [{ id: 'x1', title: 'ENG-412 test', author: 'you', status: 'weird', files: [{ path: 'a/b.ts', add: 30, del: 5 }] }, { nope: 1 }])).json();
    assert.equal(r.count, 1); assert.equal(r.problems.length, 2);
    const snap = await s.get('/api/snapshot');
    assert.equal(snap.prs[0].status, 'draft'); assert.equal(snap.prs[0].mine, true); assert.equal(snap.sampleMode, false);
  } finally { await s.close(); }
});

test('saved config is 0600, env wins, runtime mock is not persisted', async () => {
  const file = path.join(os.tmpdir(), `bm-cfg-${Date.now()}.json`);
  const s = await boot({ persist: true, file });
  try {
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(file, 'utf8').includes('mock-token'), 'token is on disk, server side only');
    const envStore = new ConfigStore({ file, env: { BATTLEMAP_JIRA_TOKEN: 'from-env', BATTLEMAP_JIRA_URL: 'https://x.example/' }, persist: false });
    assert.equal(envStore.get().jira.token, 'from-env'); assert.equal(envStore.get().jira.baseUrl, 'https://x.example');
    const upd = new ConfigStore({ file, env: {}, persist: true });
    upd.updateJira({ token: '' }); assert.equal(upd.get().jira.token, 'mock-token', 'blank token keeps the stored one');
    upd.updateJira({ clearToken: true }); assert.equal(upd.get().jira.token, '');
  } finally { await s.close(); fs.rmSync(file, { force: true }); }
  const m = await boot();
  try { assert.equal(m.store.save(), false); } finally { await m.close(); }
});

test('synthHunks is deterministic and exact', () => {
  const a = synthHunks('x/y.ts', 420, 310), b = synthHunks('x/y.ts', 420, 310);
  assert.deepEqual(a, b);
  assert.equal(a.reduce((s, h) => s + h.add, 0), 420); assert.equal(a.reduce((s, h) => s + h.del, 0), 310);
  assert.ok(a.length > 3 && a.length <= 12);
  assert.deepEqual(synthHunks('z', 0, 0), []);
  assert.ok(synthHunks('only-add.ts', 50, 0).every((h) => h.del === 0));
});

test('scanRepo lists tracked text files with loc and a complexity proxy', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-repo-'));
  const g = (...a) => execFileSync('git', ['-C', d, ...a], { stdio: 'pipe' });
  g('init', '-q'); fs.mkdirSync(path.join(d, 'src'));
  fs.writeFileSync(path.join(d, 'src/a.js'), 'if (a && b) {\n  for (;;) {}\n}\n');
  fs.writeFileSync(path.join(d, 'package-lock.json'), '{}\n');
  fs.writeFileSync(path.join(d, 'logo.png'), Buffer.from([0, 1, 2]));
  g('add', '-A');
  const files = scanRepo(d);
  assert.deepEqual(files.map((f) => f.path), ['src/a.js']);
  assert.equal(files[0].loc, 3); assert.ok(files[0].complexity >= 3);
  fs.rmSync(d, { recursive: true });
});
