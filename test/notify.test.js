import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectEvents, shouldNotify, eventsFor, pushed, NotifyStore, DEFAULT_POLICY, KINDS } from '../server/notify.js';

const pr = (id, o = {}) => ({ id, number: Number(id.slice(1)), title: `Title ${id}`, author: 'maya', status: 'review_requested', mine: false, headSha: 'aaa', adds: 10, dels: 2, files: [{ path: 'a.ts', add: 10, del: 2 }], ...o });
const pol = (o = {}) => ({ ...DEFAULT_POLICY(), ...o });
const NOW = '2026-11-26T12:00:00.000Z';

test('pushed: the head sha decides when both sides have one; otherwise the files and sizes do', () => {
  assert.equal(pushed(pr('#1'), pr('#1')), false);
  assert.equal(pushed(pr('#1'), pr('#1', { headSha: 'bbb' })), true);
  assert.equal(pushed(pr('#1', { headSha: 'aaa' }), pr('#1', { headSha: 'aaa', files: [{ path: 'z.ts', add: 1, del: 1 }] })), false, 'same sha: nothing pushed, whatever the files say');
  const nosha = (files) => pr('#1', { headSha: null, files });
  assert.equal(pushed(nosha([{ path: 'a.ts', add: 1, del: 0 }]), nosha([{ path: 'a.ts', add: 1, del: 0 }])), false);
  assert.equal(pushed(nosha([{ path: 'a.ts', add: 1, del: 0 }]), nosha([{ path: 'a.ts', add: 2, del: 0 }])), true, 'a size changed');
  assert.equal(pushed(nosha([{ path: 'a.ts', add: 1, del: 0 }, { path: 'b.ts', add: 1, del: 0 }]), nosha([{ path: 'b.ts', add: 1, del: 0 }, { path: 'a.ts', add: 1, del: 0 }])), false, 'file order does not matter');
  assert.equal(pushed(pr('#1', { headSha: 'aaa' }), pr('#1', { headSha: null })), false, 'a feed that stops sending shas is not a push when the files are the same');
});

test('detectEvents: each kind, once per transition', () => {
  const ev = (a, b) => detectEvents(a, b).map((e) => e.event);
  assert.deepEqual(ev(pr('#1'), pr('#1')), []);
  assert.deepEqual(ev(null, pr('#1')), [], 'first sight is silent');
  assert.deepEqual(ev(undefined, pr('#1')), []);
  assert.deepEqual(ev(pr('#1'), pr('#1', { headSha: 'bbb' })), ['pushed']);
  assert.deepEqual(ev(pr('#1'), pr('#1', { status: 're_review' })), ['re_review']);
  assert.deepEqual(ev(pr('#1', { status: 're_review' }), pr('#1', { status: 're_review' })), [], 'already in re-review: not again');
  assert.deepEqual(ev(pr('#1'), pr('#1', { status: 'ci_failing' })), ['ci_failed']);
  assert.deepEqual(ev(pr('#1', { status: 'ci_failing' }), pr('#1', { status: 'ci_failing' })), [], 'still red: not again');
  assert.deepEqual(ev(pr('#1', { status: 'ci_failing' }), pr('#1', { status: 'review_requested' })), ['ci_passed']);
  assert.deepEqual(ev(pr('#1', { status: 'ci_failing' }), pr('#1', { status: 'ready_to_merge' })), ['ci_passed']);
  assert.deepEqual(ev(pr('#1', { status: 'draft' }), pr('#1', { status: 'ci_failing' })), ['ci_failed'], 'from any state');
});

test('detectEvents: a push that turns CI red or asks for re-review is two events; ended PRs make none', () => {
  assert.deepEqual(detectEvents(pr('#1'), pr('#1', { headSha: 'bbb', status: 'ci_failing' })).map((e) => e.event), ['pushed', 'ci_failed']);
  assert.deepEqual(detectEvents(pr('#1', { status: 'changes_requested' }), pr('#1', { headSha: 'bbb', status: 're_review' })).map((e) => e.event), ['pushed', 're_review'], 'the usual "author pushed and re-requested"');
  assert.deepEqual(detectEvents(pr('#1', { status: 'ci_failing' }), pr('#1', { status: 'merged' })), [], 'merging a PR whose CI was red is not "CI recovered"');
  assert.deepEqual(detectEvents(pr('#1'), pr('#1', { status: 'closed', headSha: 'zzz' })), []);
  assert.deepEqual(detectEvents(pr('#1', { status: 'merged' }), pr('#1')), []);
});

test('shouldNotify: global switches cover everyone; per-PR mutes cover only other people', () => {
  const ev = (kind) => ({ kind });
  assert.equal(shouldNotify(ev('ci'), pr('#1'), pol()), true);
  const off = pol(); off.global.ci = false;
  assert.equal(shouldNotify(ev('ci'), pr('#1'), off), false);
  assert.equal(shouldNotify(ev('ci'), pr('#1', { mine: true }), off), false, 'a global switch silences your own PRs too');
  assert.equal(shouldNotify(ev('pushed'), pr('#1'), off), true, 'other kinds are unaffected');

  const muted = pol({ perPR: { '#1': { pushed: false }, '#2': { all: false }, '#3': { ci: true, all: false } } });
  assert.equal(shouldNotify(ev('pushed'), pr('#1'), muted), false);
  assert.equal(shouldNotify(ev('ci'), pr('#1'), muted), true, 'only the muted kind');
  assert.equal(shouldNotify(ev('re_review'), pr('#2'), muted), false, 'mute everything for a PR');
  assert.equal(shouldNotify(ev('ci'), pr('#3'), muted), false, '"all" beats a per-kind yes');
  assert.equal(shouldNotify(ev('pushed'), pr('#1', { mine: true }), muted), true, 'your own PR ignores a per-PR mute');
  assert.equal(shouldNotify(ev('re_review'), pr('#2', { mine: true }), muted), true);
});

test('eventsFor: only PRs that were already tracked, honouring the policy, with readable text', () => {
  const prev = [pr('#1'), pr('#2'), pr('#3', { mine: true, status: 'ci_failing' })];
  const next = [pr('#1', { headSha: 'bbb', adds: 20, dels: 5 }), pr('#2'), pr('#3', { mine: true, status: 'review_requested' }), pr('#4', { headSha: 'new' })];
  const evs = eventsFor(prev, next, pol(), { now: NOW });
  assert.deepEqual(evs.map((e) => [e.prId, e.event, e.mine]), [['#1', 'pushed', false], ['#3', 'ci_passed', true]], '#4 is new to us, #2 did not change');
  assert.equal(evs[0].text, 'New commits on #1 Title #1 (+20 −5)');
  assert.equal(evs[1].text, 'CI is green again on #3 Title #3');
  assert.ok(evs.every((e) => e.ts === NOW && e.id && e.title));
  assert.equal(new Set(evs.map((e) => e.id)).size, evs.length, 'ids are unique');
  const quiet = pol(); quiet.global.pushed = false;
  assert.deepEqual(eventsFor(prev, next, quiet, { now: NOW }).map((e) => e.event), ['ci_passed']);
  assert.deepEqual(eventsFor([], next, pol()), [], 'nothing was tracked before: nothing to report');
  assert.deepEqual(eventsFor(prev, [], pol()), []);
  assert.equal(eventsFor([pr('#1', { status: 'ci_failing' })], [pr('#1', { status: 'review_requested' })], pol(), { now: NOW })[0].text, 'CI is green again on #1 Title #1');
});

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-notify-')), 'n.json');
const ev = (id, kind = 'pushed', ts = NOW) => ({ id, ts, kind, event: kind, prId: '#1', title: 't', text: `text ${id}`, mine: false });

test('NotifyStore: policy changes are validated and removing the last override tidies up', () => {
  const s = new NotifyStore({ persist: false });
  assert.equal(s.setGlobal('nope', true).ok, false); assert.equal(s.setGlobal('ci', 'yes').ok, false);
  assert.equal(s.setGlobal('ci', false).ok, true); assert.equal(s.get().policy.global.ci, false);
  assert.equal(s.setPR('#1', 'pushed', false).ok, true); assert.deepEqual(s.get().policy.perPR, { '#1': { pushed: false } });
  assert.equal(s.setPR('#1', 'all', false).ok, true);
  assert.equal(s.setPR('#1', 'pushed', null).ok, true); assert.deepEqual(s.get().policy.perPR, { '#1': { all: false } });
  assert.equal(s.setPR('#1', 'all', null).ok, true); assert.deepEqual(s.get().policy.perPR, {}, 'no empty entries left behind');
  assert.equal(s.setPR('', 'ci', true).ok, false); assert.equal(s.setPR('#1', 'bogus', true).ok, false); assert.equal(s.setPR('#1', 'ci', 'maybe').ok, false);
});

test('NotifyStore: inbox, unread, clear one, clear all, and the cap', () => {
  const s = new NotifyStore({ persist: false });
  assert.equal(s.add([]), 0);
  s.add([ev('a', 'pushed', '2026-11-26T10:00:00Z'), ev('b', 'ci', '2026-11-26T11:00:00Z')]);
  assert.equal(s.unread(), 2);
  s.markSeen('2026-11-26T10:30:00Z'); assert.equal(s.unread(), 1, 'only what arrived after you looked');
  s.markSeen('2026-11-26T12:00:00Z'); assert.equal(s.unread(), 0);
  s.add([ev('c', 'ci', '2026-11-26T12:30:00Z')]); assert.equal(s.unread(), 1);
  assert.equal(s.clear('b').removed, 1); assert.deepEqual(s.get().inbox.map((e) => e.id), ['a', 'c']);
  assert.equal(s.clear('nope').removed, 0);
  assert.equal(s.clear().removed, 2); assert.deepEqual(s.get().inbox, []);
  s.add(Array.from({ length: 260 }, (_, i) => ev(`e${i}`)));
  assert.equal(s.get().inbox.length, 200); assert.equal(s.get().inbox[0].id, 'e60', 'the oldest are dropped');
});

test('NotifyStore: silencing alerts is idempotent, restorable and capped', () => {
  const s = new NotifyStore({ persist: false });
  s.silence(['pr_no_ticket|#1', 'pr_no_ticket|#1', 5, '']);
  assert.deepEqual([...s.silencedIds()], ['pr_no_ticket|#1']);
  s.silence(['x']); s.restore(['pr_no_ticket|#1', 'unknown']);
  assert.deepEqual([...s.silencedIds()], ['x']);
  s.silence(Array.from({ length: 600 }, (_, i) => `id${i}`));
  assert.equal(s.get().silenced.length, 500);
});

test('NotifyStore: persists with mode 0600, survives a restart, shrugs off a corrupt file', () => {
  const file = tmp();
  const a = new NotifyStore({ file });
  a.setGlobal('pushed', false); a.setPR('#9', 'ci', false); a.add([ev('x')]); a.markSeen(NOW); a.silence(['alert1']);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = new NotifyStore({ file });
  assert.equal(b.get().policy.global.pushed, false); assert.deepEqual(b.get().policy.perPR, { '#9': { ci: false } });
  assert.deepEqual(b.get().inbox.map((e) => e.id), ['x']); assert.equal(b.get().lastSeen, NOW); assert.deepEqual([...b.silencedIds()], ['alert1']);
  fs.writeFileSync(file, '{ not json'); assert.deepEqual(new NotifyStore({ file }).get().policy.global, { pushed: true, re_review: true, ci: true });
  fs.writeFileSync(file, JSON.stringify({ policy: { global: { ci: 'x', bogus: false }, perPR: { '#1': { ci: 'x', pushed: false }, '#2': {} } }, inbox: [{ nope: 1 }, ev('ok')], silenced: [1, { id: 's' }] }));
  const c = new NotifyStore({ file }).get();
  assert.deepEqual(c.policy.global, { pushed: true, re_review: true, ci: true }, 'junk values ignored');
  assert.deepEqual(c.policy.perPR, { '#1': { pushed: false } });
  assert.deepEqual(c.inbox.map((e) => e.id), ['ok']); assert.deepEqual(c.silenced.map((s) => s.id), ['s']);
  assert.deepEqual(KINDS, ['pushed', 're_review', 'ci']);
});
