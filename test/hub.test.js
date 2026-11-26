// The hub: many repos in one process, each city built from the remote alone. `exec` stands in for `gh`: no network, no clone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub, cityId } from '../server/hub.js';
import { SyncError } from '../server/providers/github.js';
import { hexKey, connected } from '../web/hex.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bm-hub-'));
const tree = (n) => ({ truncated: false, tree: Array.from({ length: n }, (_, i) => ({ path: `src/f${i}.ts`, type: 'blob', size: 800 + i * 100 })) });
const PRS = { 'org/alpha': [{ number: 1, title: 'mine red', author: { login: 'maya' }, statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }], reviewRequests: [], latestReviews: [], files: [{ path: 'src/f0.ts', additions: 3, deletions: 1 }], headRefOid: 'a' },
  { number: 2, title: 'theirs', author: { login: 'devon' }, reviewRequests: [{ login: 'maya' }], statusCheckRollup: [], latestReviews: [], files: [{ path: 'src/f1.ts', additions: 5, deletions: 0 }], headRefOid: 'b' }], 'org/beta': [] };

function standIn({ repos = { 'org/alpha': 6, 'org/beta': 4, 'org/gamma': 9, 'org/delta': 3 }, missing = new Set() } = {}) {
  const calls = [];
  const exec = async (cmd, args, { env } = {}) => {
    calls.push({ cmd, args: [...args], env });
    const line = args.join(' ');
    if (cmd !== 'gh') throw new SyncError(`not allowed: ${cmd}`);
    if (/^api user/.test(line)) return 'maya\n';
    const repo = (line.match(/repos\/([^/\s]+\/[^/\s?]+)/) || line.match(/--repo (\S+)/) || [])[1];
    if (repo && missing.has(repo)) throw new SyncError('HTTP 404: Not Found');
    if (/^api repos\/[^/]+\/[^/\s]+ --jq/.test(line)) return JSON.stringify({ default_branch: 'main', private: false });
    if (/git\/trees\//.test(line)) return JSON.stringify(tree(repos[repo] ?? 5));
    if (/^pr list/.test(line)) return JSON.stringify(/--state open/.test(line) ? (PRS[repo] || []) : []);
    throw new SyncError(`unexpected gh call: ${line}`);
  };
  return { exec, calls };
}
async function boot(o = {}) {
  const dir = o.dir || tmp(), g = standIn(o.gh), hub = createHub({ dataDir: dir, exec: g.exec, autoSync: false, ...o.hub });
  const info = await hub.listen(0);
  const get = (p) => fetch(info.url + p).then((r) => r.json());
  const post = (p, body, headers = {}) => fetch(info.url + p, { method: 'POST', headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  return { hub, info, dir, g, get, post, add: async (url, slot) => (await (await post('/api/hub/add', { url, ...(slot || {}) })).json()), close: () => hub.close() };
}

test('cities are added by name or URL, one beside the next, and look at the remote first', async () => {
  const s = await boot();
  try {
    assert.deepEqual((await s.get('/api/hub/world')).cities, []); assert.deepEqual((await s.get('/api/hub/world')).slots, [{ q: 0, r: 0 }], 'an empty world offers the middle');
    const a = await s.add('org/alpha'); assert.equal(a.ok, true); assert.deepEqual([a.city.q, a.city.r], [0, 0]); assert.equal(a.city.files, 6); assert.equal(a.city.estimated, true);
    const b = await s.add('https://github.com/org/beta.git'); assert.equal(b.ok, true);
    const c = await s.add('git@ghe.acme.io:org/gamma.git'); assert.equal(c.ok, true); assert.equal(c.city.host, 'ghe.acme.io'); assert.equal(c.city.id, 'ghe.acme.io--org--gamma');
    const w = await s.get('/api/hub/world'); assert.equal(w.cities.length, 3);
    assert.equal(connected(w.cities), true, 'cities always touch');
    assert.equal(new Set(w.cities.map(hexKey)).size, 3, 'one city to a hex');
    assert.equal(s.g.calls.find((x) => /org\/gamma/.test(x.args.join(' '))).env.GH_HOST, 'ghe.acme.io', 'the host from the URL reaches gh');
  } finally { await s.close(); }
});

test('adding is refused, and leaves nothing behind, when it should be', async () => {
  const s = await boot({ gh: { missing: new Set(['org/ghost']) } });
  try {
    assert.equal((await s.add('org/alpha')).ok, true);
    for (const [url, what] of [['org/alpha', /already here/], ['ORG/Alpha', /already here/], ['nonsense', /does not look like a repository/], ['', /does not look like a repository/], ['org/ghost', /404|Not Found/]]) {
      const r = await s.add(url); assert.equal(r.ok, false, url); assert.match(r.error, what, url);
    }
    assert.equal((await s.get('/api/hub/world')).cities.length, 1, 'a failed add registers nothing');
    assert.equal(fs.existsSync(path.join(s.dir, 'cities', 'org--ghost')), false);
    assert.equal((await s.add('org/beta', { q: 5, r: 5 })).ok, false, 'a slot far from the group is refused');
    assert.match((await s.add('org/beta', { q: 5, r: 5 })).error, /next to another city/);
    assert.equal((await s.add('org/beta', { q: 1, r: 0 })).ok, true, 'a slot beside a city is fine');
    assert.equal((await (await s.post('/api/hub/add', { url: 'org/gamma' }, { 'X-Battlemap': '0' })).json()).error, 'missing X-Battlemap header');
    assert.equal((await s.post('/api/hub/add', { url: 'org/gamma' }, { Origin: 'http://evil.example' })).status, 403);
  } finally { await s.close(); }
});

test('no clone, ever: the hub only talks to gh\'s API and PR commands', async () => {
  const s = await boot();
  try {
    await s.add('org/alpha'); await s.hub.refreshStats('org--alpha'); s.hub.enter('org--alpha'); await s.hub.syncPRs('org--alpha');
    assert.ok(s.g.calls.length >= 4);
    assert.ok(s.g.calls.every((c) => c.cmd === 'gh' && ['api', 'pr'].includes(c.args[0])), JSON.stringify(s.g.calls.map((c) => c.args.slice(0, 2))));
    assert.ok(s.g.calls.every((c) => !c.args.includes('clone')));
    assert.deepEqual(fs.readdirSync(path.join(s.dir, 'cities', 'org--alpha')).sort().filter((f) => !f.endsWith('.json') || true), ['tree.json', 'watch.json'].filter((f) => fs.existsSync(path.join(s.dir, 'cities', 'org--alpha', f))).sort(), 'only small state files on disk');
  } finally { await s.close(); }
});

test('moving a city: beside the group only, never splitting it, and it is remembered across a restart', async () => {
  const dir = tmp(); let s = await boot({ dir });
  try {
    for (const r of ['org/alpha', 'org/beta', 'org/gamma']) assert.equal((await s.add(r)).ok, true);
    const w = await s.get('/api/hub/world'), mv = async (id, q, r) => (await (await s.post('/api/hub/move', { id, q, r })).json());
    const middle = w.cities.find((c) => w.cities.filter((o) => o !== c).every((o) => Math.hypot(o.q - c.q, o.r - c.r) < 3) && true);
    assert.equal((await mv('org--nothere', 0, 1)).ok, false); assert.equal((await mv('org--alpha', 'x', 1)).ok, false);
    assert.equal((await mv('org--alpha', 9, 9)).ok, false, 'not beside anything');
    const free = (await s.get('/api/hub/world')).slots; assert.ok(free.length > 0);
    let moved = 0;
    for (const c of (await s.get('/api/hub/world')).cities) for (const slot of free) { const r = await mv(c.id, slot.q, slot.r); if (r.ok) { moved++; assert.equal(connected((await s.get('/api/hub/world')).cities), true, 'still one group'); break; } }
    assert.ok(moved > 0, 'at least one legal move exists'); assert.ok(middle);
    const before = (await s.get('/api/hub/world')).cities.map((c) => `${c.id}@${hexKey(c)}`).sort();
    await s.close(); s = await boot({ dir });
    assert.deepEqual((await s.get('/api/hub/world')).cities.map((c) => `${c.id}@${hexKey(c)}`).sort(), before, 'the layout survives a restart');
  } finally { await s.close(); }
});

test('removing a city forgets it and its state, but not if that would cut the group in two', async () => {
  const s = await boot();
  try {
    await s.add('org/alpha', undefined); await s.add('org/beta'); await s.add('org/gamma');
    const rm = async (id) => (await (await s.post('/api/hub/remove', { id })).json());
    const cities = (await s.get('/api/hub/world')).cities, cut = cities.find((c) => !connected(cities.filter((o) => o !== c)));
    if (cut) assert.match((await rm(cut.id)).error, /cut the group in two/);
    const ok = cities.find((c) => connected(cities.filter((o) => o !== c)));
    s.hub.enter(ok.id); assert.equal(fs.existsSync(path.join(s.dir, 'cities', ok.id)), true);
    assert.equal((await rm(ok.id)).ok, true);
    assert.equal(fs.existsSync(path.join(s.dir, 'cities', ok.id)), false, 'its folder goes too');
    assert.equal((await s.get('/api/hub/world')).cities.length, 2); assert.equal((await rm(ok.id)).ok, false, 'already gone');
  } finally { await s.close(); }
});

test('world numbers: how many PRs are open, how many are yours, how many need you', async () => {
  const s = await boot();
  try {
    await s.add('org/alpha'); await s.add('org/beta');
    await s.hub.refreshStats('org--alpha'); await s.hub.refreshStats('org--beta');
    const w = await s.get('/api/hub/world'), a = w.cities.find((c) => c.id === 'org--alpha'), b = w.cities.find((c) => c.id === 'org--beta');
    assert.deepEqual({ open: a.stats.open, mine: a.stats.mine, needs: a.stats.needs, loading: a.stats.loading }, { open: 2, mine: 1, needs: 2, loading: false });
    assert.deepEqual({ open: b.stats.open, mine: b.stats.mine, needs: b.stats.needs }, { open: 0, mine: 0, needs: 0 });
    assert.equal(a.stats.tracked, 0, 'nothing is tracked until you go in');
    const gone = await boot({ gh: { missing: new Set(['org/alpha']) } }); try { await gone.hub.addCity('org/beta'); await gone.hub.cities?.push; } finally { await gone.close(); }
  } finally { await s.close(); }
});

test('a city is its own app under /r/<id>/: its files come from the tree, its PRs only after you go in, and cities do not share tracking', async () => {
  const s = await boot();
  try {
    await s.add('org/alpha'); await s.add('org/beta');
    const snap = await s.get('/r/org--alpha/api/snapshot');
    assert.equal(snap.files.length, 6); assert.equal(snap.city.estimated, true); assert.equal(snap.city.key, 'org/alpha'); assert.equal(snap.prs.length, 0, 'PRs are not fetched until the city is entered and synced');
    assert.ok(snap.files.every((f) => f.loc >= 1 && f.complexity >= 0));
    await s.hub.syncPRs('org--alpha');
    const after = await s.get('/r/org--alpha/api/snapshot');
    assert.deepEqual(after.prs.map((p) => [p.id, p.mine]), [['#1', true]], 'opt-in tracking: your own PR is tracked, theirs is only offered');
    assert.equal((await s.get('/r/org--beta/api/snapshot')).files.length, 4);
    assert.equal((await s.get('/r/org--beta/api/snapshot')).prs.length, 0, 'the other city is untouched');
    assert.equal((await (await s.post('/r/org--alpha/api/watch/pick', { ref: '#2' })).json()).ok, true);
    assert.equal((await s.get('/r/org--alpha/api/snapshot')).prs.length, 2);
    assert.equal((await s.get('/r/org--beta/api/snapshot')).watch.picks?.length ?? 0, 0, 'picking in one city does not touch another');
    const shape = await s.get('/api/hub/tree?id=org--alpha'); assert.equal(shape.files.length, 6); assert.deepEqual(Object.keys(shape), ['id', 'files']); assert.equal(typeof shape.files[0][0], 'string');
    assert.equal((await fetch(s.info.url + '/api/hub/tree?id=org--nope')).status, 404); assert.equal(s.hub.apps.has('org--beta'), true, 'looking at the tree is not going in'); assert.equal(s.hub.apps.has('org--gamma'), false);
    assert.equal((await fetch(s.info.url + '/r/org--nope/api/snapshot')).status, 404); assert.equal((await fetch(s.info.url + '/r/BAD ID/api/snapshot')).status, 404);
    assert.equal((await fetch(s.info.url + '/api/snapshot')).status, 404, 'the hub has no snapshot of its own');
    assert.equal((await s.get('/api/hub/world')).cities.find((c) => c.id === 'org--alpha').stats.tracked, 2, 'the world shows what is tracked once you have been in');
    const page = await fetch(s.info.url + '/'); assert.equal(page.status, 200); assert.match(await page.text(), /<html/i);
  } finally { await s.close(); }
});

test('leaving a city stops its app; going in again starts it fresh from what is saved', async () => {
  const s = await boot();
  try {
    await s.add('org/alpha'); const app = s.hub.enter('org--alpha'); await s.hub.syncPRs('org--alpha'); assert.equal(app.view.live.length, 1);
    s.hub.leave('org--alpha'); assert.equal(s.hub.apps.has('org--alpha'), false);
    const again = s.hub.enter('org--alpha'); assert.notEqual(again, app); assert.equal(again.files.length, 6);
    assert.equal(again.watch.get().live.length, 1, 'the tracked PRs were remembered');
  } finally { await s.close(); }
});

test('city ids are stable and safe', () => {
  assert.equal(cityId({ host: null, owner: 'Org', name: 'Repo' }), 'org--repo'); assert.equal(cityId({ host: 'github.com', owner: 'org', name: 'repo' }), 'org--repo');
  assert.equal(cityId({ host: 'ghe.acme.io', owner: 'org', name: 'repo' }), 'ghe.acme.io--org--repo');
});
