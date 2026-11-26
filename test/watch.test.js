import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePRRef, refMatches, matchPath, globToRegExp, trackedBy, classify, reconcileEnded, watchedFiles, WatchStore } from '../server/watch.js';
import { normalisePRs } from '../server/snapshot.js';
import { ConfigStore } from '../server/config.js';
import { createApp } from '../server/server.js';
import { sampleFiles, samplePRs } from '../server/sample.js';

const f = (p, add = 1, del = 0) => ({ path: p, add, del });
const mk = (id, author, files, extra = {}) => ({ id, number: Number(id.replace(/\D/g, '')) || null, title: `PR ${id}`, author, status: 'review_requested', files: files.map((x) => ({ ...x, hunks: [{ add: x.add, del: x.del }] })), adds: 0, dels: 0, mine: false, ...extra });
const W = (o = {}) => ({ mode: null, picked: [], rules: [], muted: [], ended: [], ...o });

test('parsePRRef understands links, #n, "PR n" and bare numbers', () => {
  assert.equal(parsePRRef('https://github.com/org/repo/pull/2291'), '2291');
  assert.equal(parsePRRef('https://github.com/org/repo/pull/2291/files#diff-abc'), '2291');
  assert.equal(parsePRRef('https://gitlab.com/o/r/-/merge_requests/17'), '17');
  assert.equal(parsePRRef('#2291'), '2291');
  assert.equal(parsePRRef('PR 2291'), '2291');
  assert.equal(parsePRRef(' 2291 '), '2291');
  assert.equal(parsePRRef('nonsense'), null);
  assert.equal(parsePRRef(''), null);
});

test('refMatches by number, #number or exact id', () => {
  const pr = { id: '#2291', number: 2291 };
  assert.ok(refMatches('2291', pr) && refMatches('#2291', pr));
  assert.ok(!refMatches('229', pr));
  assert.ok(refMatches('feature-x', { id: 'feature-x', number: null }));
});

test('matchPath: files, folders and globs', () => {
  assert.ok(matchPath('packages/core/domain/pricing.ts', 'packages/core/domain/pricing.ts'));
  assert.ok(matchPath('packages/core', 'packages/core/domain/pricing.ts'), 'folder prefix');
  assert.ok(matchPath('packages/core/', 'packages/core/domain/pricing.ts'), 'trailing slash');
  assert.ok(!matchPath('packages/co', 'packages/core/domain/pricing.ts'), 'not a partial segment');
  assert.ok(matchPath('./packages/core', 'packages/core/x.ts'), 'leading ./');
  assert.ok(matchPath('packages/*/domain/*.ts', 'packages/core/domain/tax.ts'));
  assert.ok(!matchPath('packages/*/domain/*.ts', 'packages/core/domain/deep/tax.ts'), '* stays in one folder');
  assert.ok(matchPath('packages/**/*.ts', 'packages/core/domain/deep/tax.ts'));
  assert.ok(matchPath('**/billing.ts', 'billing.ts'), '**/ matches zero folders');
  assert.ok(matchPath('**/billing.ts', 'apps/api/routes/billing.ts'));
  assert.ok(matchPath('infra/**', 'infra/terraform/ecs.tf'));
  assert.ok(!matchPath('', 'a.ts'));
  assert.ok(!matchPath('a.b', 'aXb'), 'dots are literal');
  assert.ok(globToRegExp('a?c').test('abc') && !globToRegExp('a?c').test('a/c'));
});

test('trackedBy: each reason, muting, and the all mode', () => {
  const pr = mk('#1', 'Maya', [f('infra/ecs.tf')]);
  assert.deepEqual(trackedBy(pr, W(), 'picked'), []);
  assert.deepEqual(trackedBy({ ...pr, mine: true }, W(), 'picked'), [{ kind: 'mine' }]);
  assert.deepEqual(trackedBy(pr, W({ picked: [{ key: '1' }] }), 'picked'), [{ kind: 'pick' }]);
  assert.deepEqual(trackedBy(pr, W({ rules: [{ type: 'author', value: 'maya' }] }), 'picked'), [{ kind: 'author', value: 'maya' }], 'author rules ignore case');
  assert.deepEqual(trackedBy(pr, W({ rules: [{ type: 'path', value: 'infra/' }] }), 'picked'), [{ kind: 'path', value: 'infra/', file: 'infra/ecs.tf' }]);
  assert.deepEqual(trackedBy(pr, W(), 'all'), [{ kind: 'all' }]);
  assert.deepEqual(trackedBy({ ...pr, mine: true }, W({ muted: ['#1'], picked: [{ key: '1' }] }), 'all'), [], 'muted beats everything');
});

test('classify: opt-in hides the rest, lists it as available, newest first', () => {
  const prs = [
    mk('#1', 'a', [f('x.ts')], { updatedAt: '2026-01-01T00:00:00Z' }),
    mk('#2', 'b', [f('y.ts')], { updatedAt: '2026-03-01T00:00:00Z' }),
    mk('#3', 'c', [f('z.ts')], { updatedAt: '2026-02-01T00:00:00Z' }),
    mk('#4', 'c', [f('q.ts')], { status: 'merged' }),
  ];
  const c = classify({ prs, watch: W({ picked: [{ key: '1' }] }) });
  assert.equal(c.mode, 'picked');
  assert.deepEqual(c.live.map((p) => p.id), ['#1']);
  assert.deepEqual(c.available.map((p) => p.id), ['#2', '#3'], 'sorted by recent activity; merged ones are not offered');
  assert.equal(c.availableTotal, 2);
  assert.equal(classify({ prs, watch: W(), sampleMode: true }).live.length, 3, 'sample mode tracks everything');
  assert.equal(classify({ prs, watch: W({ mode: 'picked' }), sampleMode: true }).live.length, 0, 'an explicit mode beats the sample default');
  assert.deepEqual(classify({ prs, watch: W({ picked: [{ key: '4' }] }) }).endedFromFeed.map((p) => p.id), ['#4']);
});

test('reconcileEnded keeps vanished tracked PRs, drops reopened and muted ones', () => {
  const a = mk('#1', 'a', [f('x.ts')]), b = mk('#2', 'b', [f('y.ts')]);
  const now = '2026-05-01T00:00:00Z';
  let ended = reconcileEnded({ prevLive: [a, b], feed: [b], endedFromFeed: [], stored: [], now });
  assert.deepEqual(ended.map((p) => [p.id, p.status, p.endedInferred]), [['#1', 'closed', true]]);
  ended = reconcileEnded({ prevLive: [], feed: [b], endedFromFeed: [], stored: ended, now });
  assert.equal(ended.length, 1, 'stays until dismissed even when nothing else changed');
  ended = reconcileEnded({ prevLive: [], feed: [a, b], endedFromFeed: [], stored: ended, now });
  assert.equal(ended.length, 0, 'a PR that is open in the feed again is not "ended"');
  const merged = { ...a, status: 'merged', updatedAt: '2026-04-01T00:00:00Z' };
  ended = reconcileEnded({ prevLive: [], feed: [merged], endedFromFeed: [merged], stored: [], now });
  assert.deepEqual(ended.map((p) => [p.id, p.status]), [['#1', 'merged']]);
  assert.equal(reconcileEnded({ prevLive: [a], feed: [], endedFromFeed: [], stored: [], muted: ['#1'], now }).length, 0, 'dismissed ones do not come back');
});

test('WatchStore: pick, unpick, rules, dismiss, validation, persistence', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-watch-')), 'w.json');
  const w = new WatchStore({ file });
  assert.equal(w.pick('https://github.com/o/r/pull/9').key, '9');
  assert.equal(w.pick('9').ok, true); assert.equal(w.get().picked.length, 1, 'no duplicates');
  assert.equal(w.pick('???').ok === true, true, 'an unparseable string is kept as an exact id');
  assert.equal(w.pick('').ok, false);
  assert.equal(w.addRule('author', '@Maya').value, 'Maya');
  assert.equal(w.addRule('author', 'maya').ok, true); assert.equal(w.get().rules.length, 1, 'rules dedupe case-insensitively');
  assert.equal(w.addRule('path', './packages/core//').ok, true);
  assert.equal(w.addRule('path', '   ').ok, false);
  assert.equal(w.addRule('colour', 'red').ok, false);
  assert.equal(w.setMode('nope').ok, false);
  w.unpick('#9');
  assert.deepEqual(w.get().picked.map((p) => p.key), ['???']); assert.ok(w.get().muted.includes('#9'));
  w.pick('9'); assert.ok(!w.get().muted.includes('#9'), 'tracking again clears the mute');
  w.dismiss('#5'); assert.ok(w.get().muted.includes('#5'));
  assert.equal(w.removeRule('author', 'MAYA').removed, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = new WatchStore({ file });
  assert.deepEqual(again.get().picked.map((p) => p.key), w.get().picked.map((p) => p.key));
  assert.deepEqual(again.get().rules.map((r) => r.value), ['packages/core/']);
  assert.equal(new WatchStore({ file: path.join(os.tmpdir(), 'bm-none', 'x.json') }).get().picked.length, 0, 'missing file is fine');
  fs.writeFileSync(file, '{ not json');
  assert.equal(new WatchStore({ file }).get().picked.length, 0, 'corrupt file is ignored, not fatal');
});

/* ---------- through the real server ---------- */
async function boot({ sample = false } = {}) {
  const store = new ConfigStore({ file: path.join(os.tmpdir(), `bm-${Math.random()}.json`), env: {}, persist: false });
  const app = createApp({ store, files: sampleFiles(), prs: samplePRs(), sampleMode: sample });
  const info = await app.listen(0);
  const get = (p) => fetch(info.url + p).then((r) => r.json());
  const send = (m, p, body) => fetch(info.url + p, { method: m, headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const post = async (p, body) => (await send('POST', p, body)).json();
  return { app, get, send, post, info, close: () => app.close() };
}
const ids = (snap) => snap.prs.map((p) => p.id).sort();

test('server: real feeds are opt-in; your own PRs are always tracked; the rest is offered', async () => {
  const s = await boot();
  try {
    const snap = await s.get('/api/snapshot');
    assert.equal(snap.watch.mode, 'picked');
    assert.deepEqual(ids(snap), ['#2284', '#2302'], 'only the two PRs by "you"');
    assert.equal(snap.watch.feedCount, 13);
    assert.equal(snap.available.length, 11);
    assert.ok(snap.prs.every((p) => p.tracked.by[0].kind === 'mine'));
  } finally { await s.close(); }
});

test('server: sample mode tracks everything until a real feed arrives', async () => {
  const s = await boot({ sample: true });
  try {
    assert.equal((await s.get('/api/snapshot')).prs.length, 13);
    await s.send('POST', '/api/prs', { prs: [{ id: '#1', title: 'x', author: 'zed', status: 'draft', files: [] }] });
    const snap = await s.get('/api/snapshot');
    assert.equal(snap.watch.mode, 'picked'); assert.equal(snap.prs.length, 0); assert.equal(snap.available.length, 1);
  } finally { await s.close(); }
});

test('server: track by link, by author rule, by path rule, then stop', async () => {
  const s = await boot();
  try {
    let r = await s.post('/api/watch/pick', { ref: 'https://github.com/org/repo/pull/2279' });
    assert.equal(r.ok, true); assert.equal(r.matched, '#2279');
    assert.ok(ids(await s.get('/api/snapshot')).includes('#2279'));

    await s.post('/api/watch/rule', { type: 'author', value: 'kofi' });
    let snap = await s.get('/api/snapshot');
    assert.ok(['#2305', '#2308'].every((i) => ids(snap).includes(i)));
    assert.equal(snap.watch.rules[0].matches, 2);
    assert.deepEqual(snap.prs.find((p) => p.id === '#2305').tracked.by, [{ kind: 'author', value: 'kofi' }]);

    await s.post('/api/watch/rule', { type: 'path', value: 'packages/sdk/**' });
    snap = await s.get('/api/snapshot');
    assert.ok(ids(snap).includes('#2299') && ids(snap).includes('#2284'));
    assert.deepEqual(snap.prs.find((p) => p.id === '#2284').tracked.by.map((b) => b.kind).sort(), ['mine', 'path']);

    await s.post('/api/watch/unpick', { id: '#2305' });
    snap = await s.get('/api/snapshot');
    assert.ok(!ids(snap).includes('#2305'), 'unpicking beats the author rule that matched it');
    assert.ok(snap.available.some((p) => p.id === '#2305'));

    await s.post('/api/watch/unrule', { type: 'author', value: 'kofi' });
    assert.ok(!ids(await s.get('/api/snapshot')).includes('#2308'));
  } finally { await s.close(); }
});

test('server: a pick for a PR that is not in the feed yet waits for it', async () => {
  const s = await boot();
  try {
    await s.post('/api/watch/pick', { ref: '#7000' });
    assert.deepEqual((await s.get('/api/snapshot')).watch.pendingPicks, ['7000']);
    await s.send('POST', '/api/prs', { prs: [{ id: '#7000', number: 7000, title: 'late', author: 'zed', status: 'draft', files: [] }] });
    const snap = await s.get('/api/snapshot');
    assert.deepEqual(snap.prs.filter((p) => !p.ended).map((p) => p.id), ['#7000']); assert.deepEqual(snap.watch.pendingPicks, []);
    assert.deepEqual(snap.prs.filter((p) => p.ended).map((p) => p.id).sort(), ['#2284', '#2302'], 'your own PRs that left the feed are kept, not silently lost');
  } finally { await s.close(); }
});

test('server: tracked PRs that leave the feed stay as closed until dismissed', async () => {
  const s = await boot();
  try {
    await s.post('/api/watch/pick', { ref: '#2279' });
    await s.post('/api/watch/pick', { ref: '#2316' });
    const feed = samplePRs().filter((p) => p.id !== '#2279').map((p) => (p.id === '#2316' ? { ...p, status: 'merged' } : p));
    await s.send('POST', '/api/prs', { prs: feed });
    let snap = await s.get('/api/snapshot');
    const gone = snap.prs.find((p) => p.id === '#2279'), merged = snap.prs.find((p) => p.id === '#2316');
    assert.equal(gone.status, 'closed'); assert.ok(gone.ended && gone.endedInferred);
    assert.equal(merged.status, 'merged'); assert.ok(merged.ended);
    assert.equal(gone.needs, '', 'ended PRs never need you');
    assert.ok(!snap.insights.some((i) => i.prIds.includes('#2279') || i.prIds.includes('#2316')), 'no drift alerts for ended PRs');
    assert.equal(snap.watch.trackedCount, 2, 'only the two open PRs of yours count as live');

    await s.send('POST', '/api/prs', { prs: feed });             // an unchanged feed must not lose them
    assert.ok((await s.get('/api/snapshot')).prs.some((p) => p.id === '#2279'));

    assert.equal((await s.post('/api/watch/dismiss', { id: '#2279' })).ok, true);
    await s.post('/api/watch/dismiss', { id: '#2316' });
    snap = await s.get('/api/snapshot');
    assert.ok(!snap.prs.some((p) => ['#2279', '#2316'].includes(p.id)));
    assert.ok(!snap.available.some((p) => p.id === '#2316'), 'a dismissed merged PR is not offered again');
  } finally { await s.close(); }
});

test('server: watch endpoints validate input and need the same-origin header', async () => {
  const s = await boot();
  try {
    assert.equal((await fetch(s.info.url + '/api/watch/pick', { method: 'POST', body: '{"ref":"1"}' })).status, 403);
    assert.equal((await s.send('POST', '/api/watch/pick', { ref: '' })).status, 400);
    assert.equal((await s.send('POST', '/api/watch/rule', { type: 'path', value: '' })).status, 400);
    assert.equal((await s.send('PUT', '/api/watch/mode', { mode: 'sideways' })).status, 400);
    assert.equal((await s.send('POST', '/api/watch/nope', {})).status, 404);
    assert.equal((await s.send('PUT', '/api/watch/mode', { mode: 'all' })).status, 200);
    assert.equal((await s.get('/api/snapshot')).prs.length, 13, 'mode all shows the whole feed');
    await s.send('PUT', '/api/watch/mode', { mode: null });
    assert.equal((await s.get('/api/snapshot')).watch.mode, 'picked', 'null returns to the automatic default');
  } finally { await s.close(); }
});

test('normalisePRs accepts merged and closed statuses', () => {
  const { prs, problems } = normalisePRs([{ id: '#1', status: 'merged', files: [] }, { id: '#2', status: 'closed', files: [] }]);
  assert.deepEqual(prs.map((p) => p.status), ['merged', 'closed']); assert.equal(problems.length, 0);
});

/* ============ watch rules, case by case ============ */
const raw = (id, author, paths, extra = {}) => ({ id, number: Number(id.replace(/\D/g, '')), title: `PR ${id}`, author, status: 'review_requested', files: paths.map((p) => ({ path: p, add: 5, del: 1 })), ...extra });
async function bootFeed(feed, { file = null } = {}) {
  const store = new ConfigStore({ file: path.join(os.tmpdir(), `bm-${Math.random()}.json`), env: {}, persist: false });
  const watch = file ? new WatchStore({ file }) : undefined;
  const app = createApp({ store, watch, files: sampleFiles(), prs: feed, sampleMode: false });
  const info = await app.listen(0);
  const get = (p) => fetch(info.url + p).then((r) => r.json());
  const send = (m, p, body) => fetch(info.url + p, { method: m, headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const post = async (p, body) => (await send('POST', p, body)).json();
  const feedTo = (list) => send('POST', '/api/prs', { prs: list });
  const live = async () => (await get('/api/snapshot')).prs.filter((p) => !p.ended).map((p) => p.id).sort();
  return { app, get, post, send, feedTo, live, snap: () => get('/api/snapshot'), close: () => app.close() };
}
const rule = (s, type, value) => s.post('/api/watch/rule', { type, value });

test('author rule: tracks everything by that author, any case, with or without @', async () => {
  const s = await bootFeed([raw('#1', 'Maya', ['a.ts']), raw('#2', 'maya', ['b.ts']), raw('#3', 'devon', ['c.ts'])]);
  try {
    assert.deepEqual(await s.live(), []);
    assert.equal((await rule(s, 'author', '@MAYA')).value, 'MAYA');
    assert.deepEqual(await s.live(), ['#1', '#2'], 'both spellings of the author');
    await rule(s, 'author', 'devon');
    assert.deepEqual(await s.live(), ['#1', '#2', '#3'], 'a second author rule adds to the first');
    assert.equal((await s.snap()).available.length, 0);
  } finally { await s.close(); }
});

test('author rule keeps working for PRs opened after it was added', async () => {
  const s = await bootFeed([raw('#1', 'maya', ['a.ts'])]);
  try {
    await rule(s, 'author', 'maya');
    await s.feedTo([raw('#1', 'maya', ['a.ts']), raw('#9', 'maya', ['z.ts']), raw('#10', 'zed', ['z.ts'])]);
    assert.deepEqual(await s.live(), ['#1', '#9'], 'new PR by maya is tracked, new PR by zed is only offered');
    assert.deepEqual((await s.snap()).available.map((p) => p.id), ['#10']);
  } finally { await s.close(); }
});

test('removing a rule untracks what only it tracked, and keeps picked and own PRs', async () => {
  const s = await bootFeed([raw('#1', 'maya', ['a.ts']), raw('#2', 'maya', ['b.ts']), raw('#3', 'you', ['c.ts'], { mine: undefined })]);
  try {
    await rule(s, 'author', 'maya');
    await s.post('/api/watch/pick', { ref: '#2' });
    await s.post('/api/watch/unrule', { type: 'author', value: 'maya' });
    assert.deepEqual(await s.live(), ['#2', '#3'], '#1 only had the rule; #2 was picked; #3 is mine');
    assert.deepEqual((await s.snap()).available.map((p) => p.id), ['#1']);
  } finally { await s.close(); }
});

test('a PR that merged before the rule ever saw it open is not dragged in; one that was open is kept', async () => {
  const s = await bootFeed([raw('#1', 'maya', ['a.ts'])]);
  try {
    await rule(s, 'author', 'maya');
    assert.deepEqual(await s.live(), ['#1']);
    await s.feedTo([raw('#1', 'maya', ['a.ts'], { status: 'merged' }), raw('#50', 'maya', ['old.ts'], { status: 'merged' }), raw('#51', 'maya', ['older.ts'], { status: 'closed' })]);
    const snap = await s.snap();
    assert.deepEqual(snap.prs.filter((p) => p.ended).map((p) => [p.id, p.status]), [['#1', 'merged']], 'only the one you were watching');
    assert.ok(!snap.available.some((p) => ['#50', '#51'].includes(p.id)), 'finished PRs are never offered');
    await s.post('/api/watch/pick', { ref: '#50' });
    assert.deepEqual((await s.snap()).prs.filter((p) => p.ended).map((p) => p.id).sort(), ['#1', '#50'], 'but you can pick a finished PR on purpose');
  } finally { await s.close(); }
});

test('file rule: that file only, not its neighbours', async () => {
  const s = await bootFeed([raw('#1', 'a', ['src/pricing.ts']), raw('#2', 'b', ['src/pricing.test.ts']), raw('#3', 'c', ['other/pricing.ts'])]);
  try {
    await rule(s, 'path', 'src/pricing.ts');
    assert.deepEqual(await s.live(), ['#1']);
    assert.deepEqual((await s.snap()).prs[0].tracked.by, [{ kind: 'path', value: 'src/pricing.ts', file: 'src/pricing.ts' }]);
  } finally { await s.close(); }
});

test('folder rule: everything underneath, with or without the trailing slash, never a lookalike folder', async () => {
  const feed = [raw('#1', 'a', ['packages/core/domain/tax.ts']), raw('#2', 'b', ['packages/core/x.ts']), raw('#3', 'c', ['packages/core-utils/x.ts']), raw('#4', 'd', ['packages/coreish.ts']), raw('#5', 'e', ['apps/api/x.ts'])];
  for (const value of ['packages/core', 'packages/core/', './packages/core/']) {
    const s = await bootFeed(feed);
    try {
      await rule(s, 'path', value);
      assert.deepEqual(await s.live(), ['#1', '#2'], `rule "${value}"`);
    } finally { await s.close(); }
  }
});

test('glob rules: * stays in a folder, ** crosses folders, ? is one character', async () => {
  const feed = [raw('#1', 'a', ['apps/api/routes/billing.ts']), raw('#2', 'b', ['apps/web/pages/billing.tsx']), raw('#3', 'c', ['docs/billing.md']), raw('#4', 'd', ['apps/api/routes/deep/er/billing.ts']), raw('#5', 'e', ['billing.ts'])];
  const live = async (pattern) => { const s = await bootFeed(feed); try { await rule(s, 'path', pattern); return await s.live(); } finally { await s.close(); } };
  assert.deepEqual(await live('**/billing.*'), ['#1', '#2', '#3', '#4', '#5'], '** also matches a file at the root');
  assert.deepEqual(await live('apps/*/routes/*.ts'), ['#1'], '* does not cross folders');
  assert.deepEqual(await live('apps/**/*.ts'), ['#1', '#4']);
  assert.deepEqual(await live('apps/**'), ['#1', '#2', '#4']);
  assert.deepEqual(await live('billing.t?'), ['#5']);
  assert.deepEqual(await live('**/*.md'), ['#3']);
});

test('path rule matches on ANY file a PR touches, and says which', async () => {
  const s = await bootFeed([raw('#1', 'a', ['unrelated/one.ts', 'unrelated/two.ts', 'infra/terraform/ecs.tf', 'unrelated/three.ts'])]);
  try {
    await rule(s, 'path', 'infra/');
    const [pr] = (await s.snap()).prs;
    assert.equal(pr.id, '#1'); assert.deepEqual(pr.tracked.by, [{ kind: 'path', value: 'infra/', file: 'infra/terraform/ecs.tf' }]);
  } finally { await s.close(); }
});

test('path rule follows a PR as it changes: new PRs match, and a push that moves away from the path un-tracks it', async () => {
  const s = await bootFeed([raw('#1', 'a', ['infra/a.tf'])]);
  try {
    await rule(s, 'path', 'infra/');
    assert.deepEqual(await s.live(), ['#1']);
    await s.feedTo([raw('#1', 'a', ['infra/a.tf']), raw('#2', 'b', ['infra/b.tf'])]);
    assert.deepEqual(await s.live(), ['#1', '#2'], 'a PR opened later is picked up');
    await s.feedTo([raw('#1', 'a', ['app/moved.ts']), raw('#2', 'b', ['infra/b.tf'])]);
    const snap = await s.snap();
    assert.deepEqual(snap.prs.map((p) => p.id), ['#2']);
    assert.ok(snap.available.some((p) => p.id === '#1'), 'it is still open, so it is offered again, not "closed"');
  } finally { await s.close(); }
});

test('overlapping rules: every reason is listed; the PR stays until the last one goes', async () => {
  const s = await bootFeed([raw('#1', 'maya', ['infra/a.tf'])]);
  try {
    await rule(s, 'author', 'maya'); await rule(s, 'path', 'infra/');
    assert.deepEqual((await s.snap()).prs[0].tracked.by.map((b) => b.kind), ['author', 'path']);
    await s.post('/api/watch/unrule', { type: 'author', value: 'maya' });
    assert.deepEqual(await s.live(), ['#1'], 'the path rule still covers it');
    await s.post('/api/watch/unrule', { type: 'path', value: 'infra/' });
    assert.deepEqual(await s.live(), []);
  } finally { await s.close(); }
});

test('stop tracking beats a matching rule until you track it again', async () => {
  const s = await bootFeed([raw('#1', 'maya', ['a.ts']), raw('#2', 'maya', ['b.ts'])]);
  try {
    await rule(s, 'author', 'maya');
    await s.post('/api/watch/unpick', { id: '#1' });
    assert.deepEqual(await s.live(), ['#2']);
    await s.feedTo([raw('#1', 'maya', ['a.ts', 'more.ts']), raw('#2', 'maya', ['b.ts'])]);
    assert.deepEqual(await s.live(), ['#2'], 'a new push does not bring it back');
    await s.post('/api/watch/pick', { ref: '#1' });
    assert.deepEqual(await s.live(), ['#1', '#2']);
  } finally { await s.close(); }
});

test('watched files on the map follow the path rules only', async () => {
  const s = await bootFeed([raw('#1', 'maya', ['a.ts'])]);
  try {
    assert.deepEqual((await s.snap()).watch.watchedPaths, []);
    await rule(s, 'author', 'maya');
    assert.deepEqual((await s.snap()).watch.watchedPaths, [], 'an author rule marks no files');
    await rule(s, 'path', 'packages/sdk/client/auth.ts');
    await rule(s, 'path', 'infra/ci/');
    await rule(s, 'path', 'docs/**/*.md');
    const w = (await s.snap()).watch;
    assert.deepEqual(w.watchedPaths.sort(), ['docs/guides/auth.md', 'docs/guides/billing.md', 'docs/guides/quickstart.md', 'docs/guides/webhooks.md', 'infra/ci/build.yml', 'infra/ci/deploy.yml', 'infra/ci/lint.yml', 'packages/sdk/client/auth.ts']);
    assert.deepEqual(w.rules.map((r) => [r.type, r.files]), [['author', null], ['path', 1], ['path', 3], ['path', 4]], 'files each rule covers');
    await s.post('/api/watch/unrule', { type: 'path', value: 'infra/ci/' });
    assert.ok(!(await s.snap()).watch.watchedPaths.some((p) => p.startsWith('infra/')));
  } finally { await s.close(); }
});

test('rule counts only count open PRs', async () => {
  const s = await bootFeed([raw('#1', 'maya', ['a.ts']), raw('#2', 'maya', ['b.ts'], { status: 'merged' })]);
  try {
    await rule(s, 'author', 'maya');
    assert.equal((await s.snap()).watch.rules[0].matches, 1);
  } finally { await s.close(); }
});

test('everything mode still honours stop-tracking', async () => {
  const s = await bootFeed([raw('#1', 'a', ['a.ts']), raw('#2', 'b', ['b.ts'])]);
  try {
    await s.send('PUT', '/api/watch/mode', { mode: 'all' });
    assert.deepEqual(await s.live(), ['#1', '#2']);
    await s.post('/api/watch/unpick', { id: '#2' });
    assert.deepEqual(await s.live(), ['#1']);
  } finally { await s.close(); }
});

test('pure: watchedFiles and ended-PR filtering in classify', () => {
  const files = [{ path: 'a/x.ts' }, { path: 'a/y.ts' }, { path: 'b/z.ts' }];
  assert.deepEqual(watchedFiles(files, [{ type: 'path', value: 'a/' }, { type: 'author', value: 'q' }]), ['a/x.ts', 'a/y.ts']);
  assert.deepEqual(watchedFiles(files, [{ type: 'author', value: 'q' }]), []);
  const merged = mk('#9', 'maya', [f('a/x.ts')], { status: 'merged' });
  const w = W({ rules: [{ type: 'author', value: 'maya' }] });
  assert.equal(classify({ prs: [merged], watch: w }).endedFromFeed.length, 0, 'rules alone do not keep an already-finished PR');
  assert.equal(classify({ prs: [merged], watch: w, prevLiveIds: new Set(['#9']) }).endedFromFeed.length, 1, 'but they do when it was open a moment ago');
  assert.equal(classify({ prs: [merged], watch: W({ picked: [{ key: '9' }] }) }).endedFromFeed.length, 1, 'and a pick always does');
});

/* ---------- restarts ---------- */
const tmpWatch = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-restart-')), 'w.json');

test('restart: rules and picks survive, and so does the memory of what was open', async () => {
  const file = tmpWatch();
  const feed = [raw('#1', 'maya', ['a.ts']), raw('#2', 'zed', ['infra/b.tf']), raw('#3', 'ine', ['c.ts'])];
  let s = await bootFeed(feed, { file });
  await rule(s, 'author', 'maya'); await rule(s, 'path', 'infra/'); await s.post('/api/watch/pick', { ref: '#3' });
  assert.deepEqual(await s.live(), ['#1', '#2', '#3']);
  await s.close();

  // down for a while: #1 merged, #2 was closed (gone from the feed), #3 is still open
  s = await bootFeed([raw('#1', 'maya', ['a.ts'], { status: 'merged' }), raw('#3', 'ine', ['c.ts']), raw('#4', 'maya', ['d.ts'])], { file });
  try {
    const snap = await s.snap();
    assert.deepEqual(snap.prs.filter((p) => p.ended).map((p) => [p.id, p.status]).sort(), [['#1', 'merged'], ['#2', 'closed']], 'what ended while we were down is not lost');
    assert.deepEqual(snap.prs.filter((p) => !p.ended).map((p) => p.id).sort(), ['#3', '#4'], 'the pick persisted and the author rule caught the new PR');
    assert.deepEqual(snap.watch.rules.map((r) => r.value), ['maya', 'infra/']);
    await s.post('/api/watch/dismiss', { id: '#1' });
  } finally { await s.close(); }

  s = await bootFeed([raw('#3', 'ine', ['c.ts'])], { file });
  try {
    const ended = (await s.snap()).prs.filter((p) => p.ended).map((p) => p.id).sort();
    assert.deepEqual(ended, ['#2', '#4'], '#4 left the feed meanwhile; #1 was dismissed and stays gone');
  } finally { await s.close(); }
});

test('restart: the built-in sample never writes tracking state', async () => {
  const file = tmpWatch();
  const store = new ConfigStore({ file: path.join(os.tmpdir(), `bm-${Math.random()}.json`), env: {}, persist: false });
  const app = createApp({ store, watch: new WatchStore({ file }), files: sampleFiles(), prs: samplePRs(), sampleMode: true });
  try { assert.equal(app.snapshot().prs.length, 13); } finally { await app.close(); }
  assert.ok(!fs.existsSync(file) || JSON.parse(fs.readFileSync(file, 'utf8')).live.length === 0, 'sample PRs are not remembered as "tracked work"');
});
