// What a PR targets, and what GitHub says about merging it: from gh, through the feed, to the snapshot. Facts only; nothing is interpreted here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalisePR, FIELDS } from '../server/providers/github.js';
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
  assert.deepEqual(by(300), { ref: 'main', mergeable: 'MERGEABLE', mergeState: 'CLEAN', onDefault: true, stackedOn: null });
  assert.equal(by(301).mergeable, 'CONFLICTING'); assert.deepEqual([by(308).onDefault, by(308).stackedOn], [false, null]); assert.deepEqual([by(310).onDefault, by(310).stackedOn], [false, '#309']);
});
