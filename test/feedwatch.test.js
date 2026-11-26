import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { watchFeed } from '../server/feedwatch.js';
import { createApp } from '../server/server.js';
import { ConfigStore } from '../server/config.js';
import { sampleFiles } from '../server/sample.js';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bm-feed-'));

async function counter(file) {
  let n = 0; const w = watchFeed(file, () => { n++; }, { debounceMs: 30 });
  return { w, count: () => n };
}

test('watchFeed fires for an in-place write', async () => {
  const d = dir(), f = path.join(d, 'prs.json'); fs.writeFileSync(f, '{}');
  const c = await counter(f);
  fs.writeFileSync(f, '{"prs":[]}'); await wait(200);
  c.w.close(); assert.ok(c.count() >= 1);
});

test('watchFeed keeps firing when the file is replaced by a rename, again and again (the way battlemap-sync writes)', async () => {
  const d = dir(), f = path.join(d, 'prs.json'); fs.writeFileSync(f, '{}');
  const c = await counter(f);
  for (let i = 1; i <= 3; i++) {
    const before = c.count();
    fs.writeFileSync(f + '.tmp', JSON.stringify({ prs: [], i })); fs.renameSync(f + '.tmp', f);
    await wait(200);
    assert.ok(c.count() > before, `replacement #${i} was noticed`);
  }
  c.w.close();
});

test('watchFeed ignores other files in the directory, and stops when closed', async () => {
  const d = dir(), f = path.join(d, 'prs.json'); fs.writeFileSync(f, '{}');
  const c = await counter(f);
  fs.writeFileSync(path.join(d, 'other.json'), '1'); fs.writeFileSync(f + '.123.tmp', '2'); await wait(200);
  assert.equal(c.count(), 0);
  c.w.close(); fs.writeFileSync(f, '3'); await wait(200);
  assert.equal(c.count(), 0, 'nothing after close');
});

test('app.setFiles swaps the file list only when it changed, and tells the browser', async () => {
  const store = new ConfigStore({ file: path.join(os.tmpdir(), `bm-${Math.random()}.json`), env: {}, persist: false });
  const files = sampleFiles();
  const app = createApp({ store, files, prs: [], sampleMode: false });
  const info = await app.listen(0);
  try {
    const v0 = app.version;
    assert.equal(app.setFiles(sampleFiles()), false, 'same files, no change');
    assert.equal(app.version, v0);
    assert.equal(app.setFiles([...files, { path: 'new/file.ts', loc: 50, complexity: 2 }]), true);
    assert.equal(app.version, v0 + 1);
    const snap = await fetch(info.url + '/api/snapshot').then((r) => r.json());
    assert.ok(snap.files.some((x) => x.path === 'new/file.ts'));
    assert.equal(app.setFiles(files.map((f, i) => (i ? f : { ...f, loc: f.loc + 1 }))), true, 'a changed size counts');
  } finally { await app.close(); }
});
