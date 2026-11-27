// The files as they stood somewhere else: a PR's branch point, or the branch it is stacked on. Read on demand, never cloned.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHub } from '../server/hub.js';
import { demoProvider } from '../server/demo.js';
import { fetchRepoTree, isTreeish, addSince, SyncError } from '../server/providers/github.js';

test('isTreeish: branch names and commits pass; anything that could be a path trick, an option or a URL piece does not', () => {
  for (const ok of ['main', 'release/2.x', 'you/filters', 'a'.repeat(40), 'feature/ENG-1_x.y']) assert.ok(isTreeish(ok), ok);
  for (const bad of ['', ' ', 'a b', '-x', '--help', 'a..b', 'a\nb', 'a\0b', 'x?y', 'a:b', 'a~1', 'a^', 'a*', 'a[', 'a\\b', 'a/', 'x.lock', 'x'.repeat(251), null, undefined, 5, {}]) assert.equal(isTreeish(bad), false, JSON.stringify(bad));
});

test('fetchRepoTree at a ref: the tree of that ref, one request, the name encoded, no repo lookup', async () => {
  const calls = [], exec = async (cmd, args) => { calls.push(args.join(' ')); return JSON.stringify({ truncated: false, tree: [{ path: 'a.ts', type: 'blob', size: 380 }, { path: 'package-lock.json', type: 'blob', size: 900 }] }); };
  const t = await fetchRepoTree({ repo: 'o/r', at: 'release/2.x', exec });
  assert.deepEqual(calls, ['api repos/o/r/git/trees/release%2F2.x?recursive=1']); assert.deepEqual(t.files.map((f) => f.path), ['a.ts']); assert.equal(t.branch, 'release/2.x');
  await assert.rejects(fetchRepoTree({ repo: 'o/r', at: '--hostname=evil', exec }), /not a branch name or a commit/); assert.equal(calls.length, 1, 'refused before asking anyone');
  calls.length = 0; await fetchRepoTree({ repo: 'o/r', exec: async (c, a) => { calls.push(a.join(' ')); return a[1].includes('git/trees') ? JSON.stringify({ tree: [] }) : '{"default_branch":"trunk"}'; } });
  assert.equal(calls.length, 2, 'without `at` it is as ever: the repo, then its default branch');
});

test('addSince records the commit where the PR and its target last agreed', async () => {
  const sha = 'c'.repeat(40), mb = 'd'.repeat(40), prs = [{ number: 1, base: { ref: 'main', behind: 3 }, headSha: sha, status: 'draft', files: [{ path: 'a' }] }];
  await addSince(prs, { repo: 'o/r', exec: async () => JSON.stringify({ mergeBase: mb, files: [] }) }); assert.equal(prs[0].base.mergeBase, mb);
  const p2 = [{ number: 1, base: { ref: 'main', behind: 3 }, headSha: sha, status: 'draft', files: [{ path: 'a' }] }]; await addSince(p2, { repo: 'o/r', exec: async () => JSON.stringify({ mergeBase: 'not a sha; rm', files: [] }) }); assert.equal(p2[0].base.mergeBase, undefined);
});

test('a city serves the tree at a base, caches it, and refuses what is not a ref', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-at-')), demo = demoProvider(); let asked = 0;
  const provider = { ...demo, tree: (ref, opts) => { if (opts?.at) asked++; return demo.tree(ref, opts); } };
  const hub = createHub({ dataDir: dir, provider, autoSync: false }), info = await hub.listen(0);
  try {
    await fetch(info.url + '/api/hub/add', { method: 'POST', headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'acme/storefront' }) });
    const base = info.url + '/r/acme--storefront', get = (p) => fetch(base + p).then(async (r) => ({ status: r.status, body: await r.json() }));
    const stale = (await demo.prs({ owner: 'acme', name: 'storefront' })).prs.find((p) => p.id === '#301').base;
    assert.match(stale.mergeBase, /^[0-9a-f]{40}$/, 'the PR says where it branched from');
    const old = await get(`/api/base-tree?at=${stale.mergeBase}`); assert.equal(old.status, 200);
    assert.ok(old.body.files.some((f) => f.path === 'src/cart/Cart.tsx') && !old.body.files.some((f) => f.path === 'src/checkout/cart/Cart.tsx'), 'the tree where #301 was written: its own paths are right in it');
    const again = await get(`/api/base-tree?at=${stale.mergeBase}`); assert.equal(asked, 1, 'asked once, then remembered'); assert.deepEqual(again.body.files, old.body.files);
    const stacked = await get(`/api/base-tree?at=${encodeURIComponent('you/filters')}`); assert.ok(stacked.body.files.some((f) => f.path === 'src/catalog/filters.ts'), 'a stacked PR\'s base has its parent\'s new file in it');
    for (const bad of ['', '--evil', 'a..b', 'x y']) assert.equal((await get(`/api/base-tree?at=${encodeURIComponent(bad)}`)).status, 400, JSON.stringify(bad));
    assert.equal((await get('/api/base-tree?at=nosuchbranch')).status, 502, 'a ref the remote does not have is an error, not a crash');
    assert.equal((await fetch(base + '/api/snapshot')).status, 200, 'and the city carries on');
  } finally { await hub.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
