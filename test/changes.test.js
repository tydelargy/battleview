import test from 'node:test';
import assert from 'node:assert/strict';
import { changesQuery, changesFromGraphql, previousNames, addFileChanges, fetchGithub, SyncError } from '../server/providers/github.js';
import { normalisePRs } from '../server/snapshot.js';
import { classifyChanges, only, folderOf } from '../web/changes.js';

const gqlAnswer = (spec) => JSON.stringify({ data: { repository: Object.fromEntries(Object.entries(spec).map(([n, files]) => [`pr${n}`, { files: { nodes: files.map(([path, changeType]) => ({ path, changeType })) } }])) } });
const pr = (n, files, o = {}) => ({ number: n, status: 'review_requested', files: files.map((p) => ({ path: p, add: 5, del: 1 })), ...o });

test('the change query asks for twenty PRs at once, with only integers from gh in it', () => {
  const q = changesQuery([7, 8, '9; drop', 3.5, 10]);
  assert.match(q, /pr7: pullRequest\(number: 7\) \{ files\(first: 100\) \{ nodes \{ path changeType \} \} \}/); assert.match(q, /pr8:/); assert.match(q, /pr10:/);
  assert.ok(!/drop|3\.5/.test(q), 'only integers become part of the query');
});

test('changeType maps to added / removed / renamed / modified, and the PRs that rename something are found', () => {
  const { out, renamers } = changesFromGraphql({ pr1: { files: { nodes: [{ path: 'a.ts', changeType: 'ADDED' }, { path: 'b.ts', changeType: 'DELETED' }, { path: 'c.ts', changeType: 'RENAMED' }, { path: 'd.ts', changeType: 'MODIFIED' }, { path: 'e.ts', changeType: 'COPIED' }, { path: 'f.ts', changeType: 'CHANGED' }, { path: 'g.ts', changeType: 'SOMETHING_NEW' }, null, { changeType: 'ADDED' }] } }, pr2: { files: { nodes: [{ path: 'x', changeType: 'ADDED' }] } }, pr3: null }, [1, 2, 3, 4]);
  assert.deepEqual([...out.get(1)], [['a.ts', 'added'], ['b.ts', 'removed'], ['c.ts', 'renamed'], ['d.ts', 'modified'], ['e.ts', 'added'], ['f.ts', 'modified'], ['g.ts', 'modified']]);
  assert.deepEqual(renamers, [1]); assert.equal(out.has(3), false); assert.equal(out.has(4), false, 'a PR GitHub did not answer for is left alone');
  assert.deepEqual(changesFromGraphql(undefined, [1]).renamers, []);
});

test('previous names come from the REST pages, one JSON array per line, and junk is skipped', () => {
  const m = previousNames('[{"filename":"b.ts","previous_filename":"a.ts"},{"filename":"c.ts","previous_filename":null}]\nnot json\n[{"filename":"z.ts","previous_filename":"y.ts"}]\n');
  assert.deepEqual([...m], [['b.ts', 'a.ts'], ['z.ts', 'y']] .map(([a, b]) => [a, b === 'y' ? 'y.ts' : b]));
  assert.equal(previousNames('').size, 0); assert.equal(previousNames(undefined).size, 0);
});

function ghStub({ graphql, rest, repoView = 'o/r' } = {}) {
  const calls = [];
  const exec = async (cmd, args, { env } = {}) => { calls.push({ args: [...args], env }); const line = args.join(' ');
    if (/^api graphql/.test(line)) { if (graphql instanceof Error) throw graphql; return typeof graphql === 'function' ? graphql(line) : graphql; }
    if (/^api repos\/o\/r\/pulls\/\d+\/files/.test(line)) { if (rest instanceof Error) throw rest; return typeof rest === 'function' ? rest(line) : rest; }
    if (/^repo view/.test(line)) return repoView; throw new SyncError('unexpected: ' + line); };
  return { exec, calls };
}

test('addFileChanges: types land on the files; a renamed file also learns its old name from one REST call; nothing else is touched', async () => {
  const prs = [pr(1, ['new.ts', 'gone.ts', 'moved/b.ts', 'kept.ts']), pr(2, ['only.ts'])];
  const s = ghStub({ graphql: gqlAnswer({ 1: [['new.ts', 'ADDED'], ['gone.ts', 'DELETED'], ['moved/b.ts', 'RENAMED'], ['kept.ts', 'MODIFIED']], 2: [['only.ts', 'MODIFIED']] }), rest: '[{"filename":"moved/b.ts","previous_filename":"a.ts"},{"filename":"kept.ts","previous_filename":null}]\n' });
  const warnings = await addFileChanges(prs, { repo: 'o/r', exec: s.exec });
  assert.deepEqual(warnings, []); assert.deepEqual(prs[0].files.map((f) => [f.path, f.change, f.from]), [['new.ts', 'added', undefined], ['gone.ts', 'removed', undefined], ['moved/b.ts', 'renamed', 'a.ts'], ['kept.ts', 'modified', undefined]]);
  assert.equal(prs[1].files[0].change, 'modified');
  assert.equal(s.calls.filter((c) => c.args[0] === 'api' && c.args[1] === 'graphql').length, 1, 'one request for both PRs'); assert.equal(s.calls.filter((c) => /pulls\/1\/files/.test(c.args.join(' '))).length, 1, 'REST only for the PR that renames'); assert.equal(s.calls.filter((c) => /pulls\/2\/files/.test(c.args.join(' '))).length, 0);
});

test('addFileChanges: twenty to a request, a hundred at most (with a warning), ended PRs and PRs with no files skipped, a host reaches gh', async () => {
  const many = Array.from({ length: 130 }, (_, i) => pr(i + 1, [`f${i}.ts`])); many.push(pr(500, ['x.ts'], { status: 'merged' }), pr(501, []));
  const s = ghStub({ graphql: (line) => gqlAnswer(Object.fromEntries([...line.matchAll(/pr(\d+):/g)].map((m) => [m[1], [[`f${Number(m[1]) - 1}.ts`, 'ADDED']]]))) });
  const warnings = await addFileChanges(many, { repo: 'o/r', host: 'ghe.acme.io', exec: s.exec });
  const gq = s.calls.filter((c) => c.args[1] === 'graphql'); assert.equal(gq.length, 5, 'a hundred PRs, twenty a time'); assert.ok(gq.every((c) => c.env.GH_HOST === 'ghe.acme.io'));
  assert.equal(many[99].files[0].change, 'added'); assert.equal(many[100].files[0].change, undefined, 'past the hundred: left as plain changes'); assert.equal(many[130].files[0].change, undefined, 'a merged PR is not asked about');
  assert.match(warnings[0], /read for 100 of 130 PRs/);
});

test('addFileChanges: trouble is a warning and leaves the files as they were; it never throws', async () => {
  const prs = [pr(1, ['a.ts']), pr(2, ['b.ts'])];
  const bad = await addFileChanges(prs, { repo: 'o/r', exec: ghStub({ graphql: new SyncError('rate limited') }).exec });
  assert.match(bad[0], /could not read file changes for 2 PRs/); assert.ok(prs.every((p) => p.files[0].change === undefined));
  const rename = [pr(1, ['n.ts'])]; const w = await addFileChanges(rename, { repo: 'o/r', exec: ghStub({ graphql: gqlAnswer({ 1: [['n.ts', 'RENAMED']] }), rest: new SyncError('boom') }).exec });
  assert.equal(rename[0].files[0].change, 'renamed'); assert.equal(rename[0].files[0].from, undefined); assert.match(w[0], /could not read file changes for 1 PR/);
  assert.deepEqual(await addFileChanges([], { repo: 'o/r', exec: ghStub().exec }), []); assert.match((await addFileChanges([pr(1, ['a'])], { repo: null, exec: ghStub({ repoView: 'justone' }).exec }))[0], /could not read file changes/);
});

test('the snapshot keeps change and from only when they make sense', () => {
  const { prs } = normalisePRs([{ id: '#1', status: 'draft', files: [{ path: 'a', add: 1, del: 0, change: 'added' }, { path: 'b', add: 0, del: 4, change: 'removed' }, { path: 'c', add: 1, del: 1, change: 'renamed', from: 'old/c' }, { path: 'd', add: 1, del: 1, change: 'renamed' }, { path: 'e', add: 1, del: 1, change: 'renamed', from: 'e' }, { path: 'f', add: 1, del: 1, change: 'weird', from: 'x' }, { path: 'g', add: 1, del: 1, change: 'modified', from: 'nope' }, { path: 'h', add: 1, del: 1 }] }]);
  const f = Object.fromEntries(prs[0].files.map((x) => [x.path, x]));
  assert.equal(f.a.change, 'added'); assert.equal(f.b.change, 'removed'); assert.deepEqual([f.c.change, f.c.from], ['renamed', 'old/c']);
  assert.deepEqual([f.d.change, f.d.from], ['renamed', undefined], 'a rename with no old name is kept as a rename, but has no from'); assert.equal(f.e.from, undefined, 'moved onto itself is not a move');
  assert.deepEqual([f.f.change, f.f.from], [undefined, undefined]); assert.deepEqual([f.g.change, f.g.from], ['modified', undefined], 'from means nothing unless it is a rename'); assert.equal(f.h.change, undefined);
});

test('fetchGithub reads the changes by default and says so if it could not', async () => {
  const open = [{ number: 4, title: 'T', author: { login: 'maya' }, headRefOid: 'a', reviewRequests: [], latestReviews: [], statusCheckRollup: [], isDraft: false, files: [{ path: 'src/new.ts', additions: 9, deletions: 0 }] }];
  const exec = async (cmd, args) => { const line = args.join(' '); if (/^api user/.test(line)) return 'maya\n'; if (/^pr list/.test(line)) return JSON.stringify(/--state open/.test(line) ? open : []);
    if (/^api graphql/.test(line) && /files\(first/.test(line)) return gqlAnswer({ 4: [['src/new.ts', 'ADDED']] }); if (/^api graphql/.test(line)) return JSON.stringify({ data: { repository: { pr4: { timelineItems: { nodes: [] } } } } }); throw new SyncError(line); };
  const r = await fetchGithub({ repo: 'o/r', exec, endedDays: 0 }); assert.equal(r.prs[0].files[0].change, 'added');
  const off = await fetchGithub({ repo: 'o/r', exec, endedDays: 0, changes: false }); assert.equal(off.prs[0].files[0].change, undefined, 'and it can be switched off');
});

const tree = new Map(['src/keep.ts', 'src/old.ts', 'src/gone.ts', 'docs/a.md'].map((p) => [p, { path: p }]));
test('classifyChanges: what each PR file means against the map', () => {
  const rows = classifyChanges([{ id: '#1', files: [
    { path: 'src/keep.ts', add: 5, del: 1, change: 'modified' }, { path: 'src/gone.ts', add: 0, del: 90, change: 'removed' }, { path: 'src/new.ts', add: 120, del: 0, change: 'added' },
    { path: 'src/moved/old.ts', add: 0, del: 0, change: 'renamed', from: 'src/old.ts' }, { path: 'nowhere/x.ts', add: 0, del: 3, change: 'removed' }, { path: 'src/keep.ts', add: 2, del: 0, change: 'added' }, { path: 'src/odd.ts', add: 3, del: 0, change: 'renamed' }] }], tree);
  const by = (k) => only(rows, k).map((r) => r.path);
  assert.deepEqual(by('modified'), ['src/keep.ts', 'src/keep.ts'], 'a file that is on the map is a change to it, even if the feed says added');
  assert.deepEqual(by('removed'), ['src/gone.ts'], 'deleting what the map never had shows nothing');
  assert.deepEqual(by('added'), ['src/new.ts', 'src/odd.ts'], 'a rename with no old name is just a new file');
  assert.deepEqual(only(rows, 'renamed').map((r) => [r.path, r.from, r.fromExists, r.toExists]), [['src/moved/old.ts', 'src/old.ts', true, false]]);
  assert.equal(only(rows, 'added', '#2').length, 0);
});

test('classifyChanges: a feed with no change types still shows new files; junk is ignored', () => {
  const rows = classifyChanges([{ id: '#1', files: [{ path: 'src/keep.ts', add: 1, del: 1 }, { path: 'src/brandnew.ts', add: 40, del: 0 }, null, { path: 5 }, {}] }, null, { id: '#2' }], tree);
  assert.deepEqual(rows.map((r) => [r.path, r.kind]), [['src/keep.ts', 'modified'], ['src/brandnew.ts', 'added']]);
  assert.deepEqual(classifyChanges(null, tree), []); assert.deepEqual(classifyChanges([], tree), []);
  assert.equal(folderOf('a/b/c.ts'), 'a/b'); assert.equal(folderOf('c.ts'), ''); assert.equal(folderOf(''), '');
  const moved = classifyChanges([{ id: '#1', files: [{ path: 'src/old.ts', add: 0, del: 0, change: 'renamed', from: 'src/old.ts' }] }], tree); assert.equal(moved[0].kind, 'modified', 'moved onto itself is nothing special');
  assert.equal(classifyChanges([{ id: '#1', files: [{ path: 'new/dir/x.ts', change: 'renamed', from: 'elsewhere/y.ts' }] }], tree)[0].fromExists, false, 'the old home may not be on the map either');
});
