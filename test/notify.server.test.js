import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/server.js';
import { ConfigStore } from '../server/config.js';
import { WatchStore } from '../server/watch.js';
import { NotifyStore } from '../server/notify.js';
import { sampleFiles, samplePRs } from '../server/sample.js';

const raw = (n, author, status = 'review_requested', sha = `s${n}`, o = {}) => ({ id: `#${n}`, number: n, title: `Work ${n}`, author, status, headSha: sha, files: [{ path: 'apps/api/routes/auth.ts', add: 5, del: 1 }], ...o });
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bm-nsrv-'));

async function boot(feed, { dir = null, sample = false } = {}) {
  const store = new ConfigStore({ file: path.join(dir || tmpDir(), 'config.json'), env: {}, persist: !!dir });
  const app = createApp({ store, files: sampleFiles(), prs: feed, sampleMode: sample });
  if (!sample) { app.watch.setMode('all'); app.setPRs(feed); }                       // track everything: these tests are about what is announced
  const info = await app.listen(0);
  const get = (p) => fetch(info.url + p).then((r) => r.json());
  const send = (m, p, body) => fetch(info.url + p, { method: m, headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const inbox = async () => (await get('/api/snapshot')).notifications.inbox;
  return { app, info, get, send, inbox, texts: async () => (await inbox()).map((e) => e.text), close: () => app.close() };
}

test('a push is announced once, newest first, and opening the list marks everything seen', async () => {
  const s = await boot([raw(1, 'devon'), raw(2, 'ines')]);
  try {
    assert.deepEqual(await s.inbox(), [], 'nothing at the start');
    s.app.setPRs([raw(1, 'devon', 'review_requested', 'new1'), raw(2, 'ines')]);
    let n = (await s.get('/api/snapshot')).notifications;
    assert.deepEqual(n.inbox.map((e) => [e.kind, e.event, e.prId, e.mine]), [['pushed', 'pushed', '#1', false]]);
    assert.equal(n.unread, 1); assert.equal(n.total, 1);
    s.app.setPRs([raw(1, 'devon', 'review_requested', 'new1'), raw(2, 'ines', 'ci_failing')]);   // same feed again for #1: nothing more
    n = (await s.get('/api/snapshot')).notifications;
    assert.deepEqual(n.inbox.map((e) => e.event), ['ci_failed', 'pushed'], 'newest first');
    assert.equal(n.unread, 2);
    assert.equal((await (await s.send('POST', '/api/notify/seen')).json()).ok, true);
    assert.equal((await s.get('/api/snapshot')).notifications.unread, 0);
    assert.equal(new Set((await s.inbox()).map((e) => e.id)).size, 2, 'ids are unique');
  } finally { await s.close(); }
});

test('first sight, an unchanged feed and re-deriving "mine" announce nothing', async () => {
  const s = await boot([raw(1, 'devon')]);
  try {
    s.app.setPRs([raw(1, 'devon'), raw(2, 'ines', 'ci_failing', 'x')]);                    // #2 is new to us
    s.app.setPRs([raw(1, 'devon'), raw(2, 'ines', 'ci_failing', 'x')]);                    // nothing changed
    assert.equal((await s.send('PUT', '/api/config/identity', { prAuthors: 'devon' })).status, 200);   // "mine" is re-derived and the feed re-read
    assert.deepEqual(await s.inbox(), []);
  } finally { await s.close(); }
});

test('re-review, CI red and CI recovered; merging a PR with red CI is not "CI recovered"', async () => {
  const s = await boot([raw(1, 'devon', 'changes_requested'), raw(2, 'ines', 'ci_failing')]);
  try {
    s.app.setPRs([raw(1, 'devon', 're_review'), raw(2, 'ines', 'review_requested')]);
    assert.deepEqual((await s.texts()).sort(), ['CI is green again on #2 Work 2', 'Re-review requested on #1 Work 1']);
    s.app.setPRs([raw(1, 'devon', 're_review'), raw(2, 'ines', 'ci_failing')]);
    s.app.setPRs([raw(1, 'devon', 're_review'), raw(2, 'ines', 'merged')]);
    assert.deepEqual((await s.inbox()).filter((e) => e.prId === '#2').map((e) => e.event), ['ci_failed', 'ci_passed'], 'green, then red; merging it adds nothing');
  } finally { await s.close(); }
});

const putPR = (s, id, kind, enabled) => s.send('PUT', '/api/notify/pr', { id, kind, enabled });
const putGlobal = (s, kind, enabled) => s.send('PUT', '/api/notify/policy', { kind, enabled });
const feedOf = (o) => Object.entries(o).map(([n, v]) => raw(Number(n), v.author || 'devon', v.status || 'review_requested', v.sha || `s${n}`));
const notifications = async (s) => (await s.get('/api/snapshot')).notifications;

test('rules through the API: one rule for every PR, yours included; an override wins over the global switch either way', async () => {
  const s = await boot([raw(1, 'you'), raw(2, 'devon'), raw(3, 'ines')]);
  try {
    const mine = (await s.get('/api/snapshot')).prs.find((p) => p.id === '#1').mine;
    assert.equal(mine, true, 'the test needs #1 to be yours');
    assert.equal((await putPR(s, '#1', 'pushed', false)).status, 200, 'you can override your own PR');
    assert.equal((await putPR(s, '#2', 'pushed', false)).status, 200);
    s.app.setPRs(feedOf({ 1: { author: 'you', sha: 'n1' }, 2: { sha: 'n2' }, 3: { author: 'ines', sha: 'n3' } }));
    assert.deepEqual((await s.inbox()).map((e) => e.prId), ['#3'], 'a mute silences your own PR and others alike; only #3 follows the default');
    // global ci off, then a positive override on one PR
    assert.equal((await putGlobal(s, 'ci', false)).status, 200);
    assert.equal((await putPR(s, '#2', 'ci', true)).status, 200);
    s.app.setPRs(feedOf({ 1: { author: 'you', sha: 'n1', status: 'ci_failing' }, 2: { sha: 'n2', status: 'ci_failing' }, 3: { author: 'ines', sha: 'n3', status: 'ci_failing' } }));
    assert.deepEqual((await s.inbox()).filter((e) => e.kind === 'ci').map((e) => e.prId), ['#2'], 'CI is off for everyone except the PR that asked to hear it');
    // null puts a PR back on the default
    assert.equal((await putPR(s, '#2', 'ci', null)).status, 200); assert.equal((await putPR(s, '#2', 'pushed', null)).status, 200);
    assert.equal((await notifications(s)).policy.perPR['#2'], undefined, 'no empty entry left behind');
  } finally { await s.close(); }
});

test('rules through the API: adjust one PR, change a global, change it back: nothing is rewritten and nothing is lost', async () => {
  const s = await boot([raw(1, 'devon'), raw(2, 'ines')]);
  try {
    await putPR(s, '#1', 'pushed', false);                                        // 1. one PR adjusted
    const before = JSON.stringify((await notifications(s)).policy.perPR);
    await putGlobal(s, 'ci', false);                                             // 2. a global change
    let n = await notifications(s);
    assert.equal(JSON.stringify(n.policy.perPR), before, 'per-PR settings untouched by the global change');
    assert.deepEqual(n.byPR['#1'], { pushed: { on: false, overridden: true, inherited: true }, re_review: { on: true, overridden: false, inherited: true }, ci: { on: false, overridden: false, inherited: false } }, 'what the PR menu will show for the adjusted PR');
    assert.deepEqual(n.byPR['#2'], { pushed: { on: true, overridden: false, inherited: true }, re_review: { on: true, overridden: false, inherited: true }, ci: { on: false, overridden: false, inherited: false } }, 'and for one nobody touched: it just follows the new default');
    await putGlobal(s, 'ci', true);                                              // 3. changed back
    n = await notifications(s);
    assert.equal(JSON.stringify(n.policy.perPR), before);
    assert.equal(n.byPR['#1'].ci.on, true); assert.equal(n.byPR['#1'].pushed.on, false, 'the PR kept its own mute');
  } finally { await s.close(); }
});

test('rules through the API: events that happen while a kind is off are dropped, not saved up, and switching it on again announces nothing old', async () => {
  const s = await boot([raw(1, 'devon'), raw(2, 'ines')]);
  try {
    await putGlobal(s, 'ci', false);
    s.app.setPRs(feedOf({ 1: { status: 'ci_failing' }, 2: {} }));
    assert.deepEqual(await s.inbox(), [], 'dropped while off');
    await putGlobal(s, 'ci', true);
    s.app.setPRs(feedOf({ 1: { status: 'ci_failing' }, 2: {} }));                 // the same feed again
    assert.deepEqual(await s.inbox(), [], 'switching it back on does not replay what was missed');
    s.app.setPRs(feedOf({ 1: { status: 'review_requested' }, 2: {} }));            // new news after that is announced
    assert.deepEqual((await s.inbox()).map((e) => e.event), ['ci_passed']);
    await putGlobal(s, 'pushed', false);
    s.app.setPRs(feedOf({ 1: { status: 'review_requested', sha: 'x1' }, 2: { sha: 'x2' } }));
    assert.deepEqual((await s.inbox()).map((e) => e.event), ['ci_passed'], 'earlier notifications are untouched by a policy change');
  } finally { await s.close(); }
});

test('rules through the API: nothing by default, everything for one PR', async () => {
  const s = await boot([raw(1, 'devon'), raw(2, 'ines')]);
  try {
    for (const k of ['pushed', 're_review', 'ci']) await putGlobal(s, k, false);
    assert.equal((await putPR(s, '#1', 'all', true)).status, 200, 'the shortcut');
    assert.deepEqual((await notifications(s)).policy.perPR['#1'], { pushed: true, re_review: true, ci: true });
    s.app.setPRs(feedOf({ 1: { status: 're_review', sha: 'z1' }, 2: { status: 're_review', sha: 'z2' } }));
    assert.deepEqual((await s.inbox()).map((e) => [e.prId, e.event]).sort(), [['#1', 're_review'], ['#1', 'pushed']].sort());
  } finally { await s.close(); }
});

test('the snapshot says what every PR will do and whether that is its own choice', async () => {
  const s = await boot([raw(1, 'devon'), raw(2, 'ines')]);
  try {
    const n = await notifications(s);
    assert.deepEqual(Object.keys(n.byPR).sort(), ['#1', '#2'], 'every tracked PR');
    assert.ok(Object.values(n.byPR).every((r) => Object.values(r).every((k) => k.on && !k.overridden)), 'by default: all on, none overridden');
    await putPR(s, '#2', 'ci', false);
    assert.deepEqual((await notifications(s)).byPR['#2'].ci, { on: false, overridden: true, inherited: true });
  } finally { await s.close(); }
});

test('policy endpoints validate, need the header, and clear works one at a time and all at once', async () => {
  const s = await boot([raw(1, 'devon')]);
  try {
    assert.equal((await fetch(s.info.url + '/api/notify/clear', { method: 'POST', body: '{}' })).status, 403, 'needs X-Battlemap');
    assert.equal((await s.send('PUT', '/api/notify/policy', { kind: 'nope', enabled: true })).status, 400);
    assert.equal((await s.send('PUT', '/api/notify/policy', { kind: 'ci', enabled: 'yes' })).status, 400);
    assert.equal((await s.send('PUT', '/api/notify/pr', { id: '', kind: 'ci', enabled: true })).status, 400);
    assert.equal((await s.send('PUT', '/api/notify/pr', { id: '#1', kind: 'bogus', enabled: true })).status, 400);
    assert.equal((await s.send('POST', '/api/notify/bogus')).status, 404);
    for (let i = 1; i <= 3; i++) s.app.setPRs([raw(1, 'devon', 'review_requested', `v${i}`)]);
    const ids = (await s.inbox()).map((e) => e.id); assert.equal(ids.length, 3);
    assert.equal((await (await s.send('POST', '/api/notify/clear', { id: ids[1] })).json()).removed, 1);
    assert.deepEqual((await s.inbox()).map((e) => e.id), [ids[0], ids[2]]);
    assert.equal((await (await s.send('POST', '/api/notify/clear', {})).json()).removed, 2);
    assert.deepEqual(await s.inbox(), []);
  } finally { await s.close(); }
});

test('replacing the built-in sample with a real feed announces nothing; the sample itself never does', async () => {
  const s = await boot(samplePRs(), { sample: true });
  try {
    s.app.setPRs(samplePRs().map((p) => ({ ...p, status: 'ci_failing' })));      // leaves sample mode: a different world, not "everything went red"
    assert.deepEqual(await s.inbox(), []);
    s.app.setPRs([raw(900, 'zed')]);
    assert.deepEqual(await s.inbox(), []);
  } finally { await s.close(); }
});

test('restart: inbox, unread, policy and mutes persist; a change while the server was down is announced; an unchanged restart is silent', async () => {
  const dir = tmpDir();
  let s = await boot([raw(1, 'devon'), raw(2, 'ines')], { dir });
  s.app.setPRs([raw(1, 'devon', 'review_requested', 'p1'), raw(2, 'ines')]);                    // one event
  await s.send('PUT', '/api/notify/policy', { kind: 're_review', enabled: false });
  await s.send('PUT', '/api/notify/pr', { id: '#2', kind: 'pushed', enabled: false });
  await s.send('POST', '/api/notify/seen');
  await s.close();

  // unchanged restart
  s = await boot([raw(1, 'devon', 'review_requested', 'p1'), raw(2, 'ines')], { dir });
  let n = (await s.get('/api/snapshot')).notifications;
  assert.equal(n.total, 1, 'the restart itself added nothing'); assert.equal(n.unread, 0, 'and what you had seen stays seen');
  assert.equal(n.policy.global.re_review, false); assert.equal(n.policy.perPR['#2'].pushed, false);
  await s.close();

  // while it was down: #1 went red, and #2 was pushed (but its pushes are muted)
  s = await boot([raw(1, 'devon', 'ci_failing', 'p1'), raw(2, 'ines', 'review_requested', 'changed')], { dir });
  n = (await s.get('/api/snapshot')).notifications;
  assert.deepEqual(n.inbox.map((e) => e.event), ['ci_failed', 'pushed'], 'the CI failure that happened while we were down, and the earlier push; #2\'s push is muted');
  assert.equal(n.total, 2); assert.equal(n.unread, 1);
  await s.close();
});

test('alerts: ids are unique and stable; silencing moves one to the silenced list, restoring brings it back, and it persists', async () => {
  const dir = tmpDir();
  // #1 and #2 both change the same two files: two contested files with the same first PR, which the old id scheme could not tell apart
  const both = { files: [{ path: 'apps/api/routes/auth.ts', add: 1, del: 1 }, { path: 'apps/api/routes/users.ts', add: 1, del: 1 }] };
  const feed = [raw(1, 'devon', 'review_requested', 's1', both), raw(2, 'ines', 'review_requested', 's2', both), raw(3, 'kofi')];
  let s = await boot(feed, { dir });
  try {
    let snap = await s.get('/api/snapshot');
    const ids = snap.insights.map((i) => i.id);
    assert.ok(ids.length >= 4 && new Set(ids).size === ids.length, `unique ids: ${ids.join(' ')}`);
    const contested = snap.insights.filter((i) => i.kind === 'contested_file');
    assert.equal(contested.length, 3 - 1, 'two contested files, two alerts, two different ids');
    assert.equal((await s.get('/api/snapshot')).insights.map((i) => i.id).join(), ids.join(), 'stable across refreshes');
    const [one, two] = ids;
    assert.equal((await (await s.send('POST', '/api/alerts/silence', { ids: [one, one, 'unknown-id'] })).json()).ok, true);
    snap = await s.get('/api/snapshot');
    assert.deepEqual(snap.silenced.map((i) => i.id), [one], 'unknown ids are harmless');
    assert.ok(!snap.insights.some((i) => i.id === one));
    assert.equal(snap.insights.length, ids.length - 1);
    await s.close();
    s = await boot(feed, { dir });
    snap = await s.get('/api/snapshot');
    assert.deepEqual(snap.silenced.map((i) => i.id), [one], 'persists');
    await s.send('POST', '/api/alerts/silence', { ids: ids.filter((x) => x !== one) });
    assert.equal((await s.get('/api/snapshot')).insights.length, 0, 'silence them all');
    await s.send('POST', '/api/alerts/restore', { ids: [one, two] });
    snap = await s.get('/api/snapshot');
    assert.deepEqual(snap.insights.map((i) => i.id).sort(), [one, two].sort());
    assert.equal((await s.send('POST', '/api/alerts/silence', { ids: 'nope' })).status, 200, 'a bad body is treated as nothing to do');
  } finally { await s.close(); }
});

test('a PR that is not tracked produces no notifications and no alerts', async () => {
  const s = await boot([raw(1, 'devon')]);
  try {
    await s.send('PUT', '/api/watch/mode', { mode: 'picked' });                          // back to opt-in: nothing tracked
    s.app.setPRs([raw(1, 'devon', 'ci_failing', 'zz')]);
    assert.deepEqual(await s.inbox(), []);
    assert.equal((await s.get('/api/snapshot')).insights.length, 0);
  } finally { await s.close(); }
});
