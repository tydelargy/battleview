import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { checksState, prStatus, normalisePR, fetchGithub, SyncError } from '../server/providers/github.js';
import { normalisePRs } from '../server/snapshot.js';
import { watchFeed } from '../server/feedwatch.js';
import { createApp } from '../server/server.js';
import { ConfigStore } from '../server/config.js';
import { sampleFiles } from '../server/sample.js';

const run = (cmuts = {}) => ({ number: 7, title: 'ENG-1 Do the thing', headRefName: 'maya/ENG-1', headRefOid: 'abc123', author: { login: 'Maya' }, isDraft: false, reviewDecision: '', statusCheckRollup: [], createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', url: 'https://github.com/o/r/pull/7', files: [{ path: 'a/b.ts', additions: 3, deletions: 1 }], reviewRequests: [], latestReviews: [], state: 'OPEN', ...cmuts });
const check = (o) => ({ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', ...o });

test('checksState: failing beats pending beats passing; cancelled runs are not red', () => {
  assert.equal(checksState([]), 'none'); assert.equal(checksState(undefined), 'none');
  assert.equal(checksState([check({})]), 'passing');
  assert.equal(checksState([check({}), check({ conclusion: 'FAILURE' })]), 'failing');
  assert.equal(checksState([check({ conclusion: 'TIMED_OUT' })]), 'failing');
  assert.equal(checksState([check({ status: 'IN_PROGRESS', conclusion: null })]), 'pending');
  assert.equal(checksState([check({ status: 'QUEUED', conclusion: null }), check({ conclusion: 'FAILURE' })]), 'failing');
  assert.equal(checksState([check({ conclusion: 'CANCELLED' }), check({ conclusion: 'SKIPPED' }), check({ conclusion: 'NEUTRAL' })]), 'passing');
  assert.equal(checksState([{ __typename: 'StatusContext', state: 'ERROR' }]), 'failing');
  assert.equal(checksState([{ __typename: 'StatusContext', state: 'PENDING' }]), 'pending');
  assert.equal(checksState([{ __typename: 'StatusContext', state: 'SUCCESS' }]), 'passing');
});

test('prStatus: the order a reviewer would care about', () => {
  assert.equal(prStatus(run()), 'review_requested');
  assert.equal(prStatus(run({ state: 'MERGED' })), 'merged');
  assert.equal(prStatus(run({ state: 'CLOSED' })), 'closed');
  assert.equal(prStatus(run({ isDraft: true })), 'draft');
  assert.equal(prStatus(run({ isDraft: true, statusCheckRollup: [check({ conclusion: 'FAILURE' })] })), 'draft', 'a draft with red CI is still a draft');
  assert.equal(prStatus(run({ statusCheckRollup: [check({ conclusion: 'FAILURE' })], reviewDecision: 'APPROVED' })), 'ci_failing', 'red CI beats approval');
  assert.equal(prStatus(run({ reviewDecision: 'CHANGES_REQUESTED' })), 'changes_requested');
  assert.equal(prStatus(run({ reviewDecision: 'APPROVED', statusCheckRollup: [check({})] })), 'ready_to_merge');
  assert.equal(prStatus(run({ reviewDecision: 'APPROVED' })), 'ready_to_merge', 'no checks at all still counts as green');
  assert.equal(prStatus(run({ reviewDecision: 'APPROVED', statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: null })] })), 'review_requested', 'not ready while CI is still running');
});

test('prStatus: re-review means someone who already reviewed was asked again; teams do not count', () => {
  const reviewed = [{ author: { login: 'devon' }, state: 'COMMENTED' }];
  assert.equal(prStatus(run({ latestReviews: reviewed, reviewRequests: [{ __typename: 'User', login: 'devon' }] })), 're_review');
  assert.equal(prStatus(run({ latestReviews: reviewed, reviewRequests: [{ __typename: 'User', login: 'ines' }] })), 'review_requested');
  assert.equal(prStatus(run({ latestReviews: reviewed, reviewRequests: [{ __typename: 'Team', name: 'core', slug: 'core' }] })), 'review_requested');
  assert.equal(prStatus(run({ reviewRequests: [{ __typename: 'User', login: 'devon' }] })), 'review_requested', 'first request, no earlier review');
});

test('normalisePR: shape, timestamps, head sha, files, and who is you', () => {
  const p = normalisePR(run(), { viewer: 'maya' });
  assert.deepEqual(p, { id: '#7', number: 7, title: 'ENG-1 Do the thing', branch: 'maya/ENG-1', author: 'Maya', url: 'https://github.com/o/r/pull/7', status: 'review_requested', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', headSha: 'abc123', mine: true, files: [{ path: 'a/b.ts', add: 3, del: 1 }] });
  assert.equal(normalisePR(run(), { viewer: 'someone' }).mine, false);
  assert.ok(!('mine' in normalisePR(run())), 'with no viewer, mine is left to the identity setting');
  assert.equal(normalisePR(run({ author: null })).author, 'unknown');
  assert.deepEqual(normalisePR(run({ files: null })).files, []);
});

test('the feed gh produces is accepted by the server as is', () => {
  const feed = [normalisePR(run(), { viewer: 'maya' }), normalisePR(run({ number: 8, state: 'MERGED' }), { viewer: 'maya' })];
  const { prs, problems } = normalisePRs(feed);
  assert.deepEqual(problems, []);
  assert.deepEqual(prs.map((p) => [p.id, p.status, p.mine]), [['#7', 'review_requested', true], ['#8', 'merged', true]]);
});

/* ---------- the runner, with a stand-in gh ---------- */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, host: process.env.GH_HOST || null }) + '\\n');
const cfg = JSON.parse(fs.readFileSync(process.env.FAKE_GH_CFG, 'utf8'));
const fail = (m) => { process.stderr.write(m); process.exit(1); };
if (args[0] === 'api') { if (cfg.noUser) fail('HTTP 401: Bad credentials'); process.stdout.write(cfg.user + '\\n'); }
else if (args[0] === 'pr' && args[1] === 'list') {
  const state = args[args.indexOf('--state') + 1];
  if (cfg.fail && cfg.fail.includes(state)) fail(cfg.failMessage || 'boom');
  process.stdout.write(cfg.raw ?? JSON.stringify(cfg[state] || []));
} else fail('unexpected ' + args.join(' '));
`;
function setup(cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-gh-'));
  const gh = path.join(dir, 'gh'); fs.writeFileSync(gh, FAKE_GH, { mode: 0o755 });
  const cfgFile = path.join(dir, 'cfg.json'), log = path.join(dir, 'log.jsonl');
  fs.writeFileSync(cfgFile, JSON.stringify({ user: 'maya', ...cfg })); fs.writeFileSync(log, '');
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { dir, gh, env: { ...process.env, FAKE_GH_CFG: cfgFile, FAKE_GH_LOG: log }, calls, set: (c) => fs.writeFileSync(cfgFile, JSON.stringify({ user: 'maya', ...c })) };
}
const cli = (args, env) => new Promise((resolve) => execFile('node', ['bin/battlemap-sync.js', ...args], { env, cwd: path.resolve(import.meta.dirname, '..') }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

test('fetchGithub: open PRs plus recently ended ones, as you, with the right gh commands', async () => {
  const s = setup({ open: [run({ number: 1 }), run({ number: 2, author: { login: 'devon' } })], merged: [run({ number: 3, state: 'MERGED' })], closed: [run({ number: 4, state: 'CLOSED' }), run({ number: 1 })] });
  process.env.FAKE_GH_CFG = s.env.FAKE_GH_CFG; process.env.FAKE_GH_LOG = s.env.FAKE_GH_LOG;
  const r = await fetchGithub({ repo: 'o/r', gh: s.gh, now: Date.parse('2026-11-26T12:00:00Z') });
  assert.equal(r.viewer, 'maya'); assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.prs.map((p) => [p.id, p.status, p.mine]), [['#1', 'review_requested', true], ['#2', 'review_requested', false], ['#3', 'merged', true], ['#4', 'closed', true]], 'a PR in both lists is not duplicated');
  assert.deepEqual(r.counts, { open: 2, ended: 2 });
  const lists = s.calls().filter((c) => c.args[0] === 'pr').map((c) => c.args);
  assert.deepEqual(lists.map((a) => a[a.indexOf('--state') + 1]), ['open', 'merged', 'closed']);
  assert.ok(lists.every((a) => a[a.indexOf('--repo') + 1] === 'o/r'));
  assert.equal(lists[1][lists[1].indexOf('--search') + 1], 'merged:>=2026-11-24', 'two days back');
  assert.equal(lists[2][lists[2].indexOf('--search') + 1], 'closed:>=2026-11-24');
  const fields = lists[0][lists[0].indexOf('--json') + 1].split(',');
  for (const f of ['headRefOid', 'statusCheckRollup', 'createdAt', 'files', 'latestReviews', 'reviewRequests']) assert.ok(fields.includes(f), `asks gh for ${f}`);
});

test('fetchGithub: GitHub Enterprise sets GH_HOST for every call; no repo means "the checkout I am in"; ended-days 0 skips the extras', async () => {
  const s = setup({ open: [run()] });
  process.env.FAKE_GH_CFG = s.env.FAKE_GH_CFG; process.env.FAKE_GH_LOG = s.env.FAKE_GH_LOG;
  await fetchGithub({ host: 'ghe.example.com', gh: s.gh, endedDays: 0 });
  const calls = s.calls();
  assert.equal(calls.length, 2, 'only the user lookup and the open list');
  assert.ok(calls.every((c) => c.host === 'ghe.example.com'));
  assert.ok(!calls[1].args.includes('--repo'));
});

test('fetchGithub: trouble with the extras or the user lookup is a warning; trouble with the open list is an error', async () => {
  const s = setup({ open: [run()], noUser: true, fail: ['merged'] });
  process.env.FAKE_GH_CFG = s.env.FAKE_GH_CFG; process.env.FAKE_GH_LOG = s.env.FAKE_GH_LOG;
  const r = await fetchGithub({ repo: 'o/r', gh: s.gh });
  assert.equal(r.prs.length, 1); assert.equal(r.viewer, null); assert.ok(!('mine' in r.prs[0]));
  assert.equal(r.warnings.length, 2); assert.match(r.warnings.join('|'), /who you are/); assert.match(r.warnings.join('|'), /merged/);
  s.set({ fail: ['open'], failMessage: 'HTTP 401: Bad credentials' });
  await assert.rejects(fetchGithub({ repo: 'o/r', gh: s.gh, host: 'ghe.example.com' }), (e) => e instanceof SyncError && /gh auth login --hostname ghe\.example\.com/.test(e.message));
  s.set({ raw: 'not json' }); await assert.rejects(fetchGithub({ gh: s.gh }), /not JSON/);
  s.set({ raw: '{"a":1}' }); await assert.rejects(fetchGithub({ gh: s.gh }), /unexpected shape/);
  await assert.rejects(fetchGithub({ gh: path.join(s.dir, 'nope') }), /Install the GitHub CLI/);
});

test('battlemap-sync: writes the feed atomically and the server can read it', async () => {
  const s = setup({ open: [run({ number: 1 }), run({ number: 2, isDraft: true })], merged: [run({ number: 3, state: 'MERGED' })] });
  const out = path.join(s.dir, 'sub', 'prs.json');
  const r = await cli(['github', '--repo', 'o/r', '--out', out, '--gh', s.gh], s.env);
  assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /2 open and 1 recently ended/);
  const feed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(feed.prs.map((p) => [p.id, p.status]), [['#1', 'review_requested'], ['#2', 'draft'], ['#3', 'merged']]);
  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['prs.json'], 'no temp file left behind');
  assert.deepEqual(normalisePRs(feed.prs).problems, []);
});

test('battlemap-sync: when gh fails the existing feed is left exactly as it was', async () => {
  const s = setup({ open: [run({ number: 1 })] });
  const out = path.join(s.dir, 'prs.json');
  assert.equal((await cli(['github', '--out', out, '--gh', s.gh, '--quiet'], s.env)).code, 0);
  const before = fs.readFileSync(out, 'utf8');
  s.set({ fail: ['open'], failMessage: 'network is down' });
  const r = await cli(['github', '--out', out, '--gh', s.gh], s.env);
  assert.equal(r.code, 1); assert.match(r.stderr, /network is down/);
  assert.equal(fs.readFileSync(out, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(s.dir).filter((f) => f.endsWith('.tmp')), []);
});

test('battlemap-sync: stdout, quiet, and bad usage', async () => {
  const s = setup({ open: [run()] });
  const r = await cli(['github', '--out', '-', '--gh', s.gh], s.env);
  assert.equal(JSON.parse(r.stdout).prs.length, 1);
  assert.equal((await cli(['github', '--out', path.join(s.dir, 'q.json'), '--gh', s.gh, '--quiet'], s.env)).stdout, '');
  assert.equal((await cli([], s.env)).code, 1);
  assert.match((await cli(['gitlab'], s.env)).stderr, /Unknown provider/);
  assert.equal((await cli(['github', '--limit', 'ten'], s.env)).code, 1);
  assert.equal((await cli(['--help'], s.env)).code, 0);
});

test('the whole chain: a cron-style sync, a running server, and a second sync that replaces the file', async () => {
  const s = setup({ open: [run({ number: 1, author: { login: 'maya' } })] });
  const out = path.join(s.dir, 'prs.json');
  assert.equal((await cli(['github', '--out', out, '--gh', s.gh, '--quiet'], s.env)).code, 0);

  const loadPRs = () => JSON.parse(fs.readFileSync(out, 'utf8')).prs;
  const store = new ConfigStore({ file: path.join(s.dir, 'config.json'), env: {}, persist: false });
  const app = createApp({ store, files: sampleFiles(), prs: loadPRs(), sampleMode: false });
  const w = watchFeed(out, () => app.setPRs(loadPRs()), { debounceMs: 30 });
  const info = await app.listen(0);
  const snap = () => fetch(info.url + '/api/snapshot').then((r) => r.json());
  const until = async (fn) => { const t = Date.now(); while (Date.now() - t < 4000) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); } throw new Error('timeout'); };
  try {
    // "maya" is you (the stand-in gh says so), so her PR is tracked without any rule
    assert.deepEqual((await snap()).prs.map((p) => [p.id, p.status, p.mine]), [['#1', 'review_requested', true]]);
    for (const [round, cfg] of [[2, { open: [run({ number: 1, author: { login: 'maya' }, reviewDecision: 'APPROVED' }), run({ number: 2, author: { login: 'devon' } })] }],
                                [3, { open: [run({ number: 2, author: { login: 'devon' } })], merged: [run({ number: 1, author: { login: 'maya' }, state: 'MERGED' })] }]]) {
      s.set(cfg);
      assert.equal((await cli(['github', '--out', out, '--gh', s.gh, '--quiet'], s.env)).code, 0);
      if (round === 2) assert.equal((await until(async () => { const x = await snap(); return x.prs[0]?.status === 'ready_to_merge' && x; })).watch.availableTotal, 1, 'devon is offered, not tracked');
      else { const x = await until(async () => { const y = await snap(); return y.prs.find((p) => p.id === '#1')?.status === 'merged' && y; }); assert.ok(x.prs.find((p) => p.id === '#1').ended, 'merged while we watched: kept as an ended card'); }
    }
  } finally { w.close(); await app.close(); }
});
