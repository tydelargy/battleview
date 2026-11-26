import test from 'node:test';
import assert from 'node:assert/strict';
import { hash32, prNumber, flagLabel, authorColor, epicEmblem, EMBLEMS } from '../web/sigil.js';
import { samplePRs } from '../server/sample.js';

test('prNumber prefers number, falls back to the id, and may be absent', () => {
  assert.equal(prNumber({ id: '#2291', number: 2291 }), '2291');
  assert.equal(prNumber({ id: 'x', number: 7 }), '7');
  assert.equal(prNumber({ id: '#88' }), '88');
  assert.equal(prNumber({ id: 'org/repo#412' }), '412');
  assert.equal(prNumber({ id: 'feature-branch' }), null);
});

test('flagLabel is the PR number, never the ticket', () => {
  assert.equal(flagLabel({ id: '#2291', number: 2291, ticketKey: 'ENG-412' }), '#2291');
  assert.equal(flagLabel({ id: 'feature-branch' }), 'feature');
});

test('epic emblems are stable, case-insensitive and absent without an epic', () => {
  assert.equal(hash32('billing v2'), hash32('billing v2'));
  assert.deepEqual(epicEmblem('Billing v2'), epicEmblem('  billing V2 '));
  assert.equal(epicEmblem(''), null);
  assert.equal(epicEmblem(null), null);
  const e = epicEmblem('Billing v2');
  assert.ok(EMBLEMS.includes(e.shape));
  assert.ok(e.hue >= 0 && e.hue < 360 && e.hue % 30 === 0);
});

test('different epics mostly look different (shape or hue)', () => {
  const names = ['Billing v2', 'Auth hardening', 'Infra cutover', 'Web onboarding', 'Search', 'Mobile', 'Payments', 'Observability'];
  const looks = new Set(names.map((n) => { const e = epicEmblem(n); return `${e.shape}/${e.hue}`; }));
  assert.ok(looks.size >= names.length - 1, `too many collisions: ${[...looks].join(' ')}`);
});

test('author colour is deterministic and distinguishes the sample authors', () => {
  assert.equal(authorColor('maya'), authorColor('maya'));
  const authors = [...new Set(samplePRs().map((p) => p.author))];
  assert.equal(new Set(authors.map(authorColor)).size, authors.length);
});
