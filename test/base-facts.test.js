// What a PR targets, and what GitHub says about merging it: from gh, through the feed, to the snapshot. Facts only; nothing is interpreted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePR, FIELDS, behindQuery, behindFromGraphql, addBehind, sinceFromCompare, addSince } from '../server/providers/github.js';
import { normalisePRs, normaliseBase, withBaseFacts, buildSnapshot } from '../server/snapshot.js';
import { demoProvider } from '../server/demo.js';
import { DEFAULTS } from '../server/config.js';

test('gh is asked for the target branch and the merge verdicts, and they land on the feed entry', () => {
  for (const f of ['baseRefName', 'mergeable', 'mergeStateStatus']) assert.ok(FIELDS.includes(f), f);
  const p = normalisePR({ number: 7, baseRefName: 'release/2.x', mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', files: [] });
  assert.deepEqual(p.base, { ref: 'release/2.x', mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  assert.deepEqual(normalisePR({ number: 8, baseRefName: 'main' }).base, { ref: 'main', mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' }, 'GitHub has not worked it out yet');
  assert.equal('base' in normalisePR({ number: 9 }), false, 'an older gh or feed with no target says nothing');
});

test('the target is checked on the way in: junk becomes unknown or nothing, never a surprise', () => {
  assert.deepEqual(normaliseBase({ ref: 'main', mergeable: 'WHATEVER', mergeState: '<script>' }), { ref: 'main', mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' });
  for (const bad of [null, undefined, {}, { ref: '' }, { ref: 5 }, { ref: 'a\nb' }, { ref: 'x'.repeat(251) }, 'main']) assert.equal(normaliseBase(bad), null, JSON.stringify(bad));
  const { prs } = normalisePRs([{ id: '#1', status: 'draft', files: [], base: { ref: 'main', mergeable: 'MERGEABLE', mergeState: 'CLEAN', extra: 'x' } }, { id: '#2', status: 'draft', files: [], base: { ref: 7 } }]);
  assert.deepEqual(prs[0].base, { ref: 'main', mergeable: 'MERGEABLE', mergeState: 'CLEAN' }); assert.equal('base' in prs[1], false);
});

test('onDefault and stackedOn are worked out from the whole set of PRs', () => {
  const prs = [{ id: '#1', branch: 'feat/a', base: { ref: 'main' } }, { id: '#2', branch: 'feat/b', base: { ref: 'feat/a' } }, { id: '#3', branch: 'rel', base: { ref: 'release/1' } }, { id: '#4', branch: 'x' }, { id: '#5', branch: 'self', base: { ref: 'self' } }];
  const [a, b, c, d, e] = withBaseFacts(prs, 'main');
  assert.deepEqual([a.base.onDefault, a.base.stackedOn], [true, null]); assert.deepEqual([b.base.onDefault, b.base.stackedOn], [false, '#1'], 'targets the branch of #1: stacked on it');
  assert.deepEqual([c.base.onDefault, c.base.stackedOn], [false, null], 'a release branch is another base, but not a stack'); assert.equal('base' in d, false); assert.equal(e.base.stackedOn, null, 'never stacked on itself');
  assert.equal(withBaseFacts(prs, null)[0].base.onDefault, null, 'unknown when the default branch is not known');
});

test('the snapshot of the storefront carries every fact', async () => {
  const d = demoProvider(), ref = { owner: 'acme', name: 'storefront' }, { prs } = await d.prs(ref), { files } = await d.tree(ref);
  const snap = buildSnapshot({ files, prs: normalisePRs(prs).prs, cfg: DEFAULTS, defaultBranch: 'main' }), by = (n) => snap.prs.find((p) => p.id === `#${n}`).base;
  assert.deepEqual(by(300), { ref: 'main', mergeable: 'MERGEABLE', mergeState: 'CLEAN', behind: 0, onDefault: true, stackedOn: null });
  assert.equal(by(301).mergeable, 'CONFLICTING'); assert.deepEqual([by(308).onDefault, by(308).stackedOn], [false, null]); assert.deepEqual([by(310).onDefault, by(310).stackedOn], [false, '#309']);
});

test('how far behind: one request for twenty PRs; names go in as variables, never into the query text', async () => {
  const q = behindQuery(2); assert.match(q, /\$b0: String!, \$h0: String!, \$b1: String!, \$h1: String!/); assert.match(q, /c1: ref\(qualifiedName: \$b1\) \{ compare\(headRef: \$h1\)/);
  assert.deepEqual(behindFromGraphql({ c0: { compare: { behindBy: 12 } }, c1: null, c2: { compare: { behindBy: -1 } }, c3: { compare: { behindBy: 'x' } } }, 5), [12, null, null, null, null]);
  assert.deepEqual(behindFromGraphql(undefined, 2), [null, null]);
  const evil = 'x") { a } } { evil: viewer { login } } #', sha = 'a'.repeat(40), calls = [];
  const prs = [{ number: 1, base: { ref: 'main' }, headSha: sha, status: 'review_requested' }, { number: 2, base: { ref: evil }, headSha: sha, status: 'draft' }, { number: 3, base: { ref: 'main' }, headSha: 'not-hex', status: 'draft' }, { number: 4, base: { ref: 'main' }, headSha: sha, status: 'merged' }, { number: 5, headSha: sha, status: 'draft' }];
  const exec = async (cmd, args) => { calls.push(args); return JSON.stringify({ data: { repository: { c0: { compare: { behindBy: 3 } }, c1: { compare: { behindBy: 0 } } } } }); };
  assert.deepEqual(await addBehind(prs, { repo: 'o/r', exec }), []);
  assert.equal(calls.length, 1, 'one request for all of them'); const query = calls[0].find((a) => a.startsWith('query='));
  assert.ok(!query.includes('evil') && !query.includes('main'), 'no outside text in the query'); assert.ok(calls[0].includes(`b1=refs/heads/${evil}`), 'it travels as a variable, as a plain string (-f, so a leading @ is never read as a file)');
  assert.deepEqual([prs[0].base.behind, prs[1].base.behind, prs[2].base.behind, prs[3].base.behind], [3, 0, undefined, undefined], 'only open PRs with a target and a real commit are asked about');
  const bad = await addBehind([{ number: 1, base: { ref: 'main' }, headSha: sha, status: 'draft' }], { repo: 'o/r', exec: async () => { throw new Error('boom'); } });
  assert.match(bad[0], /could not read how far 1 PR are behind|could not read how far 1 PRs? are behind/, 'trouble is a warning, never an error');
  assert.deepEqual(await addBehind([], { repo: 'o/r', exec }), []);
});

test('behind survives the feed and is dropped when it is not a count', () => {
  const { prs } = normalisePRs([{ id: '#1', status: 'draft', files: [], base: { ref: 'main', behind: 41 } }, { id: '#2', status: 'draft', files: [], base: { ref: 'main', behind: -3 } }, { id: '#3', status: 'draft', files: [], base: { ref: 'main', behind: '7' } }]);
  assert.deepEqual(prs.map((p) => p.base.behind), [41, undefined, undefined]);
});

test('what the target did to a file since the PR branched: removed, moved (and where), changed, added', () => {
  const compare = [{ filename: 'lib/new.ts', status: 'renamed', previous_filename: 'old/a.ts' }, { filename: 'gone.ts', status: 'removed' }, { filename: 'edited.ts', status: 'modified' }, { filename: 'both.ts', status: 'added' }, { filename: 'other.ts', status: 'modified' }, null, { status: 'x' }];
  const m = sinceFromCompare(compare, ['old/a.ts', 'gone.ts', 'edited.ts', 'both.ts', 'untouched.ts']);
  assert.deepEqual([...m], [['old/a.ts', { change: 'moved', to: 'lib/new.ts' }], ['gone.ts', { change: 'removed' }], ['edited.ts', { change: 'modified' }], ['both.ts', { change: 'added' }]], 'untouched files and files nobody asked about are left out');
  assert.equal(sinceFromCompare(undefined, ['a']).size, 0); assert.equal(sinceFromCompare([], ['a']).size, 0);
});

test('addSince asks once per PR that is behind (and only those), keys a move by the file the PR means, and flags a cut list', async () => {
  const sha = 'b'.repeat(40), calls = [];
  const prs = [
    { number: 1, base: { ref: 'release/2.x', behind: 5 }, headSha: sha, status: 'draft', files: [{ path: 'a.ts' }, { path: 'new/b.ts', change: 'renamed', from: 'old/b.ts' }] },
    { number: 2, base: { ref: 'main', behind: 0 }, headSha: sha, status: 'draft', files: [{ path: 'a.ts' }] },
    { number: 3, base: { ref: 'main' }, headSha: sha, status: 'draft', files: [{ path: 'a.ts' }] },
    { number: 4, base: { ref: 'main', behind: 9 }, headSha: sha, status: 'merged', files: [{ path: 'a.ts' }] },
    { number: 5, base: { ref: 'main', behind: 9 }, headSha: sha, status: 'draft', files: [] },
  ];
  const exec = async (cmd, args) => { calls.push(args[1]); const big = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}` })); return JSON.stringify({ files: [{ filename: 'a.ts', status: 'removed' }, { filename: 'moved/b.ts', status: 'renamed', previous_filename: 'old/b.ts' }, ...big] }); };
  assert.deepEqual(await addSince(prs, { repo: 'o/r', exec }), []);
  assert.deepEqual(calls, [`repos/o/r/compare/${sha}...release%2F2.x`], 'one request, with the branch name encoded');
  assert.deepEqual(prs[0].files, [{ path: 'a.ts', since: { change: 'removed' } }, { path: 'new/b.ts', change: 'renamed', from: 'old/b.ts', since: { change: 'moved', to: 'moved/b.ts' } }]);
  assert.equal(prs[0].base.sinceCut, true, 'compare lists 300 files at most: a full list may be cut short'); assert.equal(prs[1].files[0].since, undefined);
  const bad = await addSince([{ number: 1, base: { ref: 'main', behind: 2 }, headSha: sha, status: 'draft', files: [{ path: 'a' }] }], { repo: 'o/r', exec: async () => 'not json' }); assert.match(bad[0], /could not read what the target changed for 1 PR/);
});

test('since survives the feed only when it is a known change; a move needs a place', () => {
  const f = (since) => ({ path: 'a.ts', add: 1, del: 0, since });
  const { prs } = normalisePRs([{ id: '#1', status: 'draft', files: [f({ change: 'moved', to: 'b.ts' }), f({ change: 'moved' }), f({ change: 'removed', to: 'ignored' }), f({ change: 'bogus' }), f('x'), f(undefined)], base: { ref: 'main', sinceCut: true } }]);
  assert.deepEqual(prs[0].files.map((x) => x.since), [{ change: 'moved', to: 'b.ts' }, undefined, { change: 'removed' }, undefined, undefined, undefined]); assert.equal(prs[0].base.sinceCut, true);
});

test('the storefront says what main did to each file its stale PRs touch', async () => {
  const { prs } = await demoProvider().prs({ owner: 'acme', name: 'storefront' }), since = (n) => prs.find((p) => p.number === n).files.map((f) => f.since?.change || '-');
  assert.deepEqual(since(300), ['-']); assert.deepEqual(since(301), ['moved', 'moved']); assert.deepEqual(since(302), ['moved', 'moved', 'moved', 'moved', '-']); assert.deepEqual(since(303), ['removed', 'modified']); assert.deepEqual(since(307), ['added', '-']);
});
