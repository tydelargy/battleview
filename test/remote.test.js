// A repo with no clone: its tree and its PR numbers come from `gh` alone. These use a stand-in `exec`, never the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRepoRef, repoKey, estimateFile, fetchRepoTree, fetchPRStats, SyncError } from '../server/providers/github.js';

test('parseRepoRef reads names, hosts and every kind of URL, and refuses anything else', () => {
  assert.deepEqual(parseRepoRef('org/repo'), { host: null, owner: 'org', name: 'repo' });
  assert.deepEqual(parseRepoRef('https://github.com/org/repo'), { host: 'github.com', owner: 'org', name: 'repo' });
  assert.deepEqual(parseRepoRef('https://github.com/org/repo.git/'), { host: 'github.com', owner: 'org', name: 'repo' });
  assert.deepEqual(parseRepoRef('https://ghe.acme.io/org/repo/pull/12'), { host: 'ghe.acme.io', owner: 'org', name: 'repo' });
  assert.deepEqual(parseRepoRef('git@ghe.acme.io:org/repo.git'), { host: 'ghe.acme.io', owner: 'org', name: 'repo' });
  assert.deepEqual(parseRepoRef('ssh://git@github.com/org/repo.git'), { host: 'github.com', owner: 'org', name: 'repo' });
  assert.deepEqual(parseRepoRef('ghe.acme.io/org/repo'), { host: 'ghe.acme.io', owner: 'org', name: 'repo' });
  for (const bad of ['', '   ', 'repo', 'a/b/c/d', 'https://github.com/org', null, undefined]) assert.equal(parseRepoRef(bad), null, String(bad));
  assert.equal(repoKey({ host: 'github.com', owner: 'o', name: 'r' }), 'o/r'); assert.equal(repoKey({ host: null, owner: 'o', name: 'r' }), 'o/r');
  assert.equal(repoKey({ host: 'ghe.acme.io', owner: 'o', name: 'r' }), 'ghe.acme.io/o/r', 'a different host is a different repo');
});

test('size estimates: about 38 bytes a line, one branch in nine lines, never zero', () => {
  assert.deepEqual(estimateFile(3800), { loc: 100, complexity: 11 });
  assert.deepEqual(estimateFile(1), { loc: 1, complexity: 0 });
  assert.ok(estimateFile(380000).loc === 10000);
});

const gh = (answers) => { const calls = []; const exec = async (cmd, args, { env } = {}) => { calls.push({ cmd, args, env }); for (const [re, out] of answers) if (re.test(args.join(' '))) return typeof out === 'function' ? out() : out; throw new SyncError(`unexpected: ${args.join(' ')}`); }; return { exec, calls }; };
const TREE = { truncated: false, tree: [
  { path: 'src', type: 'tree' }, { path: 'src/a.ts', type: 'blob', size: 3800 }, { path: 'src/b.ts', type: 'blob', size: 760 }, { path: 'README.md', type: 'blob', size: 1900 },
  { path: 'logo.png', type: 'blob', size: 99999 }, { path: 'package-lock.json', type: 'blob', size: 500000 }, { path: 'empty.txt', type: 'blob', size: 0 }, { path: 'huge.sql', type: 'blob', size: 5_000_000 }, { path: 'vendor', type: 'commit', size: 0 } ] };

test('fetchRepoTree: default branch, then the tree; only real text-ish files, sizes estimated, sorted, and no clone', async () => {
  const { exec, calls } = gh([[/^api repos\/org\/repo --jq/, JSON.stringify({ default_branch: 'main', private: true, description: 'Billing' })], [/git\/trees\/main\?recursive=1/, JSON.stringify(TREE)]]);
  const r = await fetchRepoTree({ repo: 'https://github.com/org/repo.git', exec });
  assert.deepEqual(r.files.map((f) => f.path), ['README.md', 'src/a.ts', 'src/b.ts'], 'no directories, images, lock files, empty or huge files');
  assert.deepEqual(r.files.find((f) => f.path === 'src/a.ts'), { path: 'src/a.ts', loc: 100, complexity: 11 });
  assert.equal(r.branch, 'main'); assert.equal(r.estimated, true); assert.equal(r.private, true); assert.equal(r.description, 'Billing'); assert.deepEqual(r.warnings, []);
  assert.deepEqual(calls.map((c) => c.cmd), ['gh', 'gh'], 'two gh calls');
  assert.ok(calls.every((c) => c.args[0] === 'api'), 'only the API: nothing like git clone or gh repo clone');
  assert.ok(calls.every((c) => !c.env.GH_HOST), 'github.com needs no host');
});

test('fetchRepoTree: an Enterprise host is passed to gh; a truncated tree and an oversize repo warn; bad input is refused', async () => {
  const { exec, calls } = gh([[/--jq/, JSON.stringify({ default_branch: 'dev/x' })], [/git\/trees\/dev%2Fx/, JSON.stringify({ truncated: true, tree: Array.from({ length: 50 }, (_, i) => ({ path: `f${i}.ts`, type: 'blob', size: 100 + i })) })]]);
  const r = await fetchRepoTree({ repo: 'ghe.acme.io/org/repo', exec, maxFiles: 10 });
  assert.equal(calls[0].env.GH_HOST, 'ghe.acme.io'); assert.equal(r.files.length, 10);
  assert.equal(r.warnings.length, 2); assert.match(r.warnings[0], /cut this repository's file tree short/); assert.match(r.warnings[1], /50 files: showing the 10 biggest/);
  assert.equal((await fetchRepoTree({ repo: 'org/repo', host: 'other.io', exec })).files.length > 0, true); assert.equal(calls.at(-1).env.GH_HOST, 'other.io', 'an explicit host wins');
  await assert.rejects(fetchRepoTree({ repo: 'not a repo', exec }), /cannot read owner and name/);
  await assert.rejects(fetchRepoTree({ repo: 'org/re;po', exec }), /cannot read owner and name/, 'nothing odd reaches the command line');
  await assert.rejects(fetchRepoTree({ repo: 'org/repo', exec: gh([[/--jq/, '{}'], [/trees/, '{"nope":1}']]).exec }), /no file tree/);
});

const PR = (n, author, o = {}) => ({ number: n, title: `t${n}`, author: { login: author }, isDraft: false, reviewDecision: '', statusCheckRollup: [], reviewRequests: [], latestReviews: [], state: 'OPEN', headRefOid: 'a', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', ...o });
test('fetchPRStats: open, yours and needing you, from one light list (no files)', async () => {
  const { exec, calls } = gh([[/^api user/, 'maya\n'], [/^pr list/, JSON.stringify([
    PR(1, 'maya', { statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }),    // yours, red CI: needs you
    PR(2, 'maya'),                                                                          // yours, nothing to do
    PR(3, 'devon', { reviewRequests: [{ login: 'maya' }] }),                                // review requested of you
    PR(4, 'ines', { isDraft: true }),                                                       // someone's draft
  ])]]);
  const s = await fetchPRStats({ repo: 'org/repo', exec });
  assert.deepEqual({ open: s.open, mine: s.mine, needs: s.needs, viewer: s.viewer }, { open: 4, mine: 2, needs: 2, viewer: 'maya' });
  const list = calls.find((c) => c.args[0] === 'pr'); assert.ok(!list.args.join(' ').includes('files'), 'files are what makes a PR list slow'); assert.ok(list.args.includes('--repo'));
  const none = await fetchPRStats({ repo: 'org/repo', exec: gh([[/^api user/, () => { throw new SyncError('no auth'); }], [/^pr list/, '[]']]).exec });
  assert.deepEqual({ open: none.open, mine: none.mine, needs: none.needs }, { open: 0, mine: 0, needs: 0 }, 'without a login, mine is 0 rather than an error');
  await assert.rejects(fetchPRStats({ repo: 'x', exec }), /cannot read owner and name/);
});
