import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { checksState, prStatus, normalisePR, waitingSinceFromTimeline, timelineQuery, fetchGithub, SyncError } from '../server/providers/github.js';
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
  assert.deepEqual(p, { id: '#7', number: 7, title: 'ENG-1 Do the thing', branch: 'maya/ENG-1', author: 'Maya', url: 'https://github.com/o/r/pull/7', status: 'review_requested', createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-02T10:00:00Z', headSha: 'abc123', waitingSince: null, mine: true, files: [{ path: 'a/b.ts', add: 3, del: 1 }] });
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
if (args[0] === 'api' && args[1] === 'user') { if (cfg.noUser) fail('HTTP 401: Bad credentials'); process.stdout.write(cfg.user + '\\n'); }
else if (args[0] === 'repo' && args[1] === 'view') process.stdout.write((cfg.repoView || 'o/r') + '\\n');
else if (args[0] === 'api' && args[1] === 'graphql') {
  if (cfg.failGraphql) fail('graphql failed');
  const q = args.find((a) => a.startsWith('query=')), repository = {};
  for (const m of q.matchAll(/pr(\\d+): pullRequest/g)) repository['pr' + m[1]] = (cfg.noTimeline || []).includes(m[1]) ? null : { timelineItems: { nodes: (cfg.timeline || {})[m[1]] || [] } };
  process.stdout.write(JSON.stringify({ data: { repository } }));
} else if (args[0] === 'pr' && args[1] === 'list') {
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
  const lists = s.calls().filter((c) => c.args[0] === 'pr' && c.args[1] === 'list').map((c) => c.args);
  assert.deepEqual(lists.map((a) => a[a.indexOf('--state') + 1]), ['open', 'merged', 'closed']);
  assert.ok(lists.every((a) => a[a.indexOf('--repo') + 1] === 'o/r'));
  assert.equal(lists[1][lists[1].indexOf('--search') + 1], 'merged:>=2026-11-24', 'two days back');
  assert.equal(lists[2][lists[2].indexOf('--search') + 1], 'closed:>=2026-11-24');
  const fields = lists[0][lists[0].indexOf('--json') + 1].split(',');
  for (const f of ['headRefOid', 'statusCheckRollup', 'createdAt', 'files', 'latestReviews', 'reviewRequests']) assert.ok(fields.includes(f), `asks gh for ${f}`);
});

test('fetchGithub: GitHub Enterprise sets GH_HOST for every call; no repo means "the checkout I am in"; ended-days 0 skips the extras', async () => {
  const s = setup({ open: [run({ author: { login: 'zed' } })] });                       // not ours, not in re-review: no second look
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

/* ---------- how long has it waited on us? Exact, from the timeline ---------- */
const T = (hours) => new Date(Date.parse('2026-11-20T00:00:00Z') + hours * 3600_000).toISOString();
const req = (login, h) => ({ __typename: 'ReviewRequestedEvent', createdAt: T(h), requestedReviewer: { __typename: 'User', login } });
const unreq = (login, h) => ({ __typename: 'ReviewRequestRemovedEvent', createdAt: T(h), requestedReviewer: { __typename: 'User', login } });
const rev = (login, state, h) => ({ __typename: 'PullRequestReview', author: { login }, state, submittedAt: T(h), createdAt: T(h) });
const com = (login, h) => ({ __typename: 'IssueComment', author: { login }, createdAt: T(h) });
const cm = (h) => ({ __typename: 'PullRequestCommit', commit: { committedDate: T(h) } });
const fp = (h) => ({ __typename: 'HeadRefForcePushedEvent', createdAt: T(h) });

test('waitingSinceFromTimeline, ours: the oldest unaddressed comment from someone else since our last push', () => {
  const ours = (nodes) => waitingSinceFromTimeline(run(), nodes, { viewer: 'maya', mine: true });
  assert.equal(ours([cm(0), cm(10), rev('ines', 'CHANGES_REQUESTED', 12), com('kofi', 15), rev('devon', 'COMMENTED', 20)]), T(12), 'three things since the push at 10h: the earliest, exactly 12h');
  assert.equal(ours([cm(10), rev('ines', 'CHANGES_REQUESTED', 5)]), null, 'it came before our last push: addressed');
  assert.equal(ours([cm(10), fp(30), com('ines', 20), com('kofi', 31)]), T(31), 'a force-push is a push: the comment at 20h was addressed by it');
  assert.equal(ours([cm(10), rev('ines', 'APPROVED', 12)]), null, 'an approval is not something to address');
  assert.equal(ours([cm(10), rev('ines', 'PENDING', 12)]), null, 'nor is someone else\'s unsubmitted draft review');
  assert.equal(ours([cm(10), com('maya', 12), com('dependabot[bot]', 13), com('ci-bot', 14), rev('maya', 'COMMENTED', 15)]), null, 'our own comments, our own reviews and bots do not count');
  assert.equal(ours([cm(10), rev('ines', 'COMMENTED', 30), com('kofi', 11)]), T(11), 'a plain comment counts as much as a review');
  assert.equal(ours([rev('ines', 'CHANGES_REQUESTED', 12)]), null, 'no push in the timeline: we cannot tell what is new, so we say nothing');
  assert.equal(ours([]), null); assert.equal(waitingSinceFromTimeline(run(), undefined, { viewer: 'maya', mine: true }), null);
});

const reRaw = (extra = {}) => run({ author: { login: 'devon' }, latestReviews: [{ author: { login: 'ines' }, state: 'CHANGES_REQUESTED', submittedAt: T(20) }, { author: { login: 'maya' }, state: 'COMMENTED', submittedAt: T(21) }], reviewRequests: [{ __typename: 'User', login: 'ines' }, { __typename: 'User', login: 'maya' }], ...extra });

test('waitingSinceFromTimeline, re-review: the exact time we were asked to review again', () => {
  assert.equal(prStatus(reRaw()), 're_review');
  const at = (nodes, viewer = 'maya') => waitingSinceFromTimeline(reRaw(), nodes, { viewer });
  assert.equal(at([req('maya', 1), rev('maya', 'COMMENTED', 21), req('maya', 40)]), T(40), 'we reviewed at 21h and were asked again at 40h');
  assert.equal(at([rev('maya', 'COMMENTED', 21), req('maya', 40), req('maya', 55)]), T(55), 'asked twice since: the latest request');
  assert.equal(at([req('maya', 40), rev('maya', 'APPROVED', 45)]), null, 'we answered it already');
  assert.equal(at([req('maya', 40), unreq('maya', 42)]), null, 'the request was withdrawn');
  assert.equal(at([req('maya', 40), unreq('maya', 42), req('maya', 50)]), T(50), 'withdrawn and asked again: the new one');
  assert.equal(at([req('maya', 40), rev('maya', 'PENDING', 45)]), T(40), 'an unsubmitted draft review is not an answer');
  assert.equal(at([{ __typename: 'ReviewRequestedEvent', createdAt: T(40), requestedReviewer: { __typename: 'Team' } }]), null, 'a team request has no login and is ignored');
  assert.equal(at([]), null);
});

test('waitingSinceFromTimeline, re-review: not us who was asked, so the longest-waiting request among those who were', () => {
  const nodes = [rev('ines', 'CHANGES_REQUESTED', 20), req('ines', 30), req('maya', 50)];
  assert.equal(waitingSinceFromTimeline(reRaw(), nodes, { viewer: 'zed' }), T(30), 'ines was asked at 30h and maya at 50h: the earlier wait');
  assert.equal(waitingSinceFromTimeline(reRaw(), nodes, { viewer: 'maya' }), T(50), 'but if we are maya, it is the request made of us');
  assert.equal(waitingSinceFromTimeline(reRaw(), nodes, { viewer: null }), T(30), 'with no viewer known, the same fallback');
  assert.equal(waitingSinceFromTimeline(run({ author: { login: 'devon' }, reviewRequests: [{ __typename: 'User', login: 'ines' }] }), [req('ines', 30)], { viewer: 'maya' }), null, 'not in re-review: nothing to say');
  assert.equal(waitingSinceFromTimeline({ ...reRaw(), state: 'MERGED' }, [req('maya', 40)], { viewer: 'maya' }), null);
});

test('timelineQuery: one alias per PR, only integers, and every event type we read', () => {
  const q = timelineQuery([7, 12, '1) { x } #', 3.5, null]);
  assert.deepEqual([...q.matchAll(/pr(\d+): pullRequest\(number: (\d+)\)/g)].map((m) => [m[1], m[2]]), [['7', '7'], ['12', '12']], 'a non-integer never reaches the query text');
  for (const t of ['ReviewRequestedEvent', 'ReviewRequestRemovedEvent', 'PullRequestReview', 'IssueComment', 'HeadRefForcePushedEvent', 'PullRequestCommit']) assert.ok(q.includes(t), t);
  assert.match(q, /\$owner: String!, \$name: String!/);
  assert.ok(!q.includes('x }'));
});

const own = (n, extra = {}) => run({ number: n, author: { login: 'maya' }, ...extra });
const reReview = (n) => run({ number: n, author: { login: 'devon' }, latestReviews: [{ author: { login: 'ines' }, state: 'COMMENTED', submittedAt: T(20) }], reviewRequests: [{ __typename: 'User', login: 'ines' }] });
const gql = (s) => s.calls().filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql');
const useEnv = (s) => { process.env.FAKE_GH_CFG = s.env.FAKE_GH_CFG; process.env.FAKE_GH_LOG = s.env.FAKE_GH_LOG; };

test('fetchGithub reads timelines in one request, only for our PRs and anyone\'s re-reviews, and puts exact times on them', async () => {
  const s = setup({
    open: [own(1), reReview(2), run({ number: 3, author: { login: 'zed' } })],
    timeline: { 1: [cm(10), rev('ines', 'CHANGES_REQUESTED', 14)], 2: [rev('ines', 'COMMENTED', 20), req('ines', 33)] },
  });
  useEnv(s);
  const r = await fetchGithub({ repo: 'o/r', gh: s.gh, endedDays: 0 });
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.prs.map((p) => [p.id, p.waitingSince]), [['#1', T(14)], ['#2', T(33)], ['#3', null]]);
  assert.equal(gql(s).length, 1, 'one request for both');
  const args = gql(s)[0].args, query = args.find((a) => a.startsWith('query='));
  assert.deepEqual([...query.matchAll(/pr(\d+): pullRequest/g)].map((m) => m[1]), ['1', '2'], '#3 is nobody\'s concern, so it is not in the query');
  assert.ok(args.includes('owner=o') && args.includes('name=r'));
});

test('fetchGithub: Enterprise host reaches the GraphQL call; owner and name come from host/owner/name, or from the checkout', async () => {
  const s = setup({ open: [own(1)], timeline: { 1: [cm(1), com('ines', 5)] } });
  useEnv(s);
  await fetchGithub({ repo: 'ghe.example.com/acme/widgets', host: 'ghe.example.com', gh: s.gh, endedDays: 0 });
  assert.ok(gql(s)[0].args.includes('owner=acme') && gql(s)[0].args.includes('name=widgets'));
  assert.equal(gql(s)[0].host, 'ghe.example.com');
  const t = setup({ open: [own(1)], timeline: { 1: [cm(1), com('ines', 5)] }, repoView: 'acme/gadgets' });
  useEnv(t);
  const r = await fetchGithub({ gh: t.gh, endedDays: 0 });
  assert.ok(t.calls().some((c) => c.args[0] === 'repo' && c.args[1] === 'view'), 'asked gh which repository this is');
  assert.ok(gql(t)[0].args.includes('owner=acme') && gql(t)[0].args.includes('name=gadgets'));
  assert.equal(r.prs[0].waitingSince, T(5));
});

test('fetchGithub: timelines are batched twenty to a request and capped at a hundred PRs, with a warning', async () => {
  const s = setup({ open: Array.from({ length: 105 }, (_, i) => own(i + 1)) });
  useEnv(s);
  const r = await fetchGithub({ repo: 'o/r', gh: s.gh, endedDays: 0 });
  assert.equal(gql(s).length, 5, '100 PRs at 20 a request');
  assert.match(r.warnings.join('|'), /looked at 100 of 105/);
  assert.equal(r.prs.length, 105);
});

test('fetchGithub: a failed timeline read is a warning and falls back; the rest still works', async () => {
  const s = setup({ open: [own(1), reReview(2)], failGraphql: true });
  useEnv(s);
  const r = await fetchGithub({ repo: 'o/r', gh: s.gh, endedDays: 0 });
  assert.deepEqual(r.prs.map((p) => p.waitingSince), [null, null]);
  assert.equal(r.warnings.length, 1); assert.match(r.warnings[0], /2 PRs.*falls back to the last update/);
  const t = setup({ open: [own(1), own(2)], timeline: { 1: [cm(1), com('ines', 5)] }, noTimeline: ['2'] });
  useEnv(t);
  const r2 = await fetchGithub({ repo: 'o/r', gh: t.gh, endedDays: 0 });
  assert.deepEqual(r2.prs.map((p) => p.waitingSince), [T(5), null]);
  assert.match(r2.warnings.join('|'), /1 PR\b/);
  const u = setup({ open: [own(1)], failGraphql: true });
  useEnv(u);
  assert.equal((await fetchGithub({ repo: 'o/r', gh: u.gh, endedDays: 0 })).prs.length, 1, 'the feed itself is still produced');
});

test('fetchGithub: without knowing who you are, only re-reviews are looked at', async () => {
  const s = setup({ open: [own(1), reReview(2)], noUser: true, timeline: { 2: [rev('ines', 'COMMENTED', 20), req('ines', 40)] } });
  useEnv(s);
  const r = await fetchGithub({ repo: 'o/r', gh: s.gh, endedDays: 0 });
  assert.deepEqual([...gql(s)[0].args.find((a) => a.startsWith('query=')).matchAll(/pr(\d+): pullRequest/g)].map((m) => m[1]), ['2']);
  assert.deepEqual(r.prs.map((p) => p.waitingSince), [null, T(40)]);
});
