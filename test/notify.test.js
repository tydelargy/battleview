import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectEvents, shouldNotify, effective, resolveFor, eventsFor, pushed, NotifyStore, DEFAULT_POLICY, KINDS } from '../server/notify.js';

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

// ---- the notification rules, as a specification ----------------------------------------------------------------
// Two layers: a global switch per kind, and an override per kind per PR (on, off or unset). One rule for every PR.
//   an override wins over the global switch, in both directions; unset follows the global switch right now.
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bm-notify-')), 'n.json');
const kindEv = (kind) => ({ kind });
const policy = (global, perPR = {}) => ({ global: { pushed: true, re_review: true, ci: true, ...global }, perPR });

test('rule: unset follows the global switch; an override of either kind beats it (the full truth table, every kind, mine or not)', () => {
  for (const kind of KINDS) for (const global of [true, false]) for (const override of [undefined, true, false]) for (const mine of [false, true]) {
    const p = policy({ [kind]: global }, override === undefined ? {} : { '#1': { [kind]: override } });
    const want = override === undefined ? global : override;
    assert.equal(shouldNotify(kindEv(kind), pr('#1', { mine }), p), want, `${kind}: global ${global}, override ${override}, mine ${mine}`);
  }
});

test('rule: your own PRs follow exactly the same rules as everyone else\'s', () => {
  const p = policy({ ci: false }, { '#1': { pushed: false }, '#2': { ci: true } });
  for (const mine of [false, true]) {
    assert.equal(shouldNotify(kindEv('ci'), pr('#9', { mine }), p), false, 'a global off silences it');
    assert.equal(shouldNotify(kindEv('pushed'), pr('#1', { mine }), p), false, 'a per-PR mute silences it');
    assert.equal(shouldNotify(kindEv('ci'), pr('#2', { mine }), p), true, 'a per-PR yes brings it back');
  }
});

test('rule: kinds are independent; an override for one never touches the others', () => {
  const p = policy({ pushed: false, re_review: false, ci: false }, { '#1': { ci: true } });
  assert.deepEqual(KINDS.map((k) => shouldNotify(kindEv(k), pr('#1'), p)), [false, false, true]);
  assert.deepEqual(KINDS.map((k) => shouldNotify(kindEv(k), pr('#2'), p)), [false, false, false], 'other PRs still follow the global switches');
});

test('rule: nothing by default, but tell me everything about this one PR', () => {
  const p = policy({ pushed: false, re_review: false, ci: false }, { '#7': { pushed: true, re_review: true, ci: true } });
  const evs = eventsFor([pr('#7'), pr('#8')], [pr('#7', { headSha: 'bbb', status: 're_review' }), pr('#8', { headSha: 'bbb', status: 're_review' })], p, { now: NOW });
  assert.deepEqual(evs.map((e) => [e.prId, e.event]), [['#7', 'pushed'], ['#7', 're_review']], 'only #7 is heard, #8 follows the silent default');
  const ci = eventsFor([pr('#7'), pr('#8')], [pr('#7', { status: 'ci_failing' }), pr('#8', { status: 'ci_failing' })], p, { now: NOW });
  assert.deepEqual(ci.map((e) => [e.prId, e.event]), [['#7', 'ci_failed']]);
});

test('effective and resolveFor say what will happen and why', () => {
  const p = policy({ ci: false }, { '#1': { pushed: false, ci: true } });
  assert.deepEqual(effective(p, '#1', 'pushed'), { on: false, overridden: true, inherited: true }, 'muted here, though the default is on');
  assert.deepEqual(effective(p, '#1', 'ci'), { on: true, overridden: true, inherited: false }, 'on here, though the default is off');
  assert.deepEqual(effective(p, '#1', 're_review'), { on: true, overridden: false, inherited: true }, 'no override: follows the default');
  assert.deepEqual(effective(p, '#2', 'ci'), { on: false, overridden: false, inherited: false }, 'a PR with no entry at all follows the defaults');
  assert.deepEqual(Object.keys(resolveFor(p, '#1')), KINDS);
  assert.deepEqual(resolveFor(p, '#2'), { pushed: { on: true, overridden: false, inherited: true }, re_review: { on: true, overridden: false, inherited: true }, ci: { on: false, overridden: false, inherited: false } });
});

test('store: changing a global switch never touches any PR\'s overrides, and unsetting follows the global switch as it is now', () => {
  const s = new NotifyStore({ persist: false });
  s.setPR('#A', 'pushed', false);                                              // 1. adjust one PR
  const overrides = JSON.stringify(s.get().policy.perPR);
  s.setGlobal('ci', false);                                                    // 2. then change a global
  assert.equal(JSON.stringify(s.get().policy.perPR), overrides, 'the per-PR settings are exactly as they were');
  const now = (id, k) => effective(s.get().policy, id, k).on;
  assert.deepEqual([now('#A', 'pushed'), now('#A', 'ci'), now('#A', 're_review')], [false, false, true], 'A: its own mute, the new global off, the untouched default');
  assert.deepEqual([now('#B', 'pushed'), now('#B', 'ci'), now('#B', 're_review')], [true, false, true], 'B never touched: only the global change applies');
  s.setGlobal('ci', true);                                                     // 3. and back
  assert.deepEqual([now('#A', 'pushed'), now('#A', 'ci')], [false, true], 'A keeps its mute, and CI returns with the default');
  assert.equal(JSON.stringify(s.get().policy.perPR), overrides);
  s.setPR('#A', 'ci', true); s.setGlobal('ci', false);                         // an override outlives a global change in the other direction too
  assert.equal(now('#A', 'ci'), true, 'a positive override survives the global going off');
  s.setPR('#A', 'ci', null);
  assert.equal(now('#A', 'ci'), false, 'unset: back on the default, whatever it is now, not what it was');
});

test('store: overrides are per kind, null removes one, the "all" shortcut writes every kind and is never stored itself', () => {
  const s = new NotifyStore({ persist: false });
  assert.equal(s.setGlobal('nope', true).ok, false); assert.equal(s.setGlobal('ci', 'yes').ok, false);
  assert.equal(s.setGlobal('ci', false).ok, true); assert.equal(s.get().policy.global.ci, false);
  assert.equal(s.setPR('#1', 'pushed', false).ok, true); assert.deepEqual(s.get().policy.perPR, { '#1': { pushed: false } });
  assert.equal(s.setPR('#1', 'ci', true).ok, true); assert.deepEqual(s.get().policy.perPR, { '#1': { pushed: false, ci: true } }, 'positive overrides are stored too');
  assert.equal(s.setPR('#1', 'all', true).ok, true); assert.deepEqual(s.get().policy.perPR, { '#1': { pushed: true, re_review: true, ci: true } }, 'hear everything about this PR');
  assert.equal(s.setPR('#1', 'all', false).ok, true); assert.deepEqual(s.get().policy.perPR, { '#1': { pushed: false, re_review: false, ci: false } }, 'mute everything about it');
  assert.equal(s.setPR('#1', 'pushed', null).ok, true); assert.deepEqual(s.get().policy.perPR, { '#1': { re_review: false, ci: false } });
  assert.equal(s.setPR('#1', 'all', null).ok, true); assert.deepEqual(s.get().policy.perPR, {}, 'reset to the defaults leaves no empty entry behind');
  assert.equal(s.setPR('', 'ci', true).ok, false); assert.equal(s.setPR('#1', 'bogus', true).ok, false); assert.equal(s.setPR('#1', 'ci', 'maybe').ok, false);
});

test('store: an "all" override saved by an older version keeps its meaning (it fills the kinds that PR did not set)', () => {
  const file = tmp();
  fs.writeFileSync(file, JSON.stringify({ policy: { global: {}, perPR: { '#1': { all: false }, '#2': { all: false, ci: true }, '#3': { all: true, pushed: false } } } }));
  const p = new NotifyStore({ file }).get().policy;
  assert.deepEqual(p.perPR['#1'], { pushed: false, re_review: false, ci: false });
  assert.deepEqual(p.perPR['#2'], { pushed: false, re_review: false, ci: true }, 'the more specific setting wins, as it does everywhere now');
  assert.deepEqual(p.perPR['#3'], { pushed: false, re_review: true, ci: true });
  assert.ok(!Object.values(p.perPR).some((o) => 'all' in o), '"all" is not a stored setting any more');
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

const ev = (id, kind = 'pushed', ts = NOW) => ({ id, ts, kind, event: kind, prId: '#1', title: 't', text: `text ${id}`, mine: false });

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
