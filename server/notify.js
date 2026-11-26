// Notifications: things that happened to PRs you track, and which of them you want to hear about.
//
// Detection compares a PR's previous and current state (so it works while the browser is closed and survives a
// restart: the previous state is the "was open" memory the watch store already keeps). Three kinds, as asked for:
//   pushed      new commits (the head sha changed; without a sha, the files or their sizes changed)
//   re_review   the PR went into "re-review": someone who had reviewed was asked to look again
//   ci          CI went red (ci_failed) or recovered (ci_passed)
// A PR seen for the first time produces nothing, so starting up or tracking a PR never floods you.
//
// Policy, two layers and one rule for every PR (yours included):
//   global     one switch per kind, the default for every PR
//   per PR     each kind can be overridden on or off for one PR; unset means "follow the global switch"
// An override wins over the global switch in both directions, so "nothing by default, but tell me everything about
// this PR" works. Changing a global switch never touches a PR's overrides, and unsetting an override puts the PR
// back on whatever the global switch says at that moment. Nothing is ever copied from one layer into the other.
import fs from 'node:fs';
import path from 'node:path';

export const KINDS = ['pushed', 're_review', 'ci'];
export const KIND_LABEL = { pushed: 'New commits', re_review: 'Re-review requests', ci: 'CI status' };
const MAX_INBOX = 200, MAX_SILENCED = 500, MAX_PR_RULES = 500;

const filesSig = (pr) => (pr.files || []).map((f) => `${f.path}:${f.add}:${f.del}`).sort().join('|');
/** Did the code change? Head sha when both sides have one, otherwise the files and their sizes. */
export const pushed = (prev, next) => (prev.headSha && next.headSha ? prev.headSha !== next.headSha : filesSig(prev) !== filesSig(next));

const ENDED = new Set(['merged', 'closed']);

/** What happened between two states of the same PR. Pure. `prev` missing means first sight: nothing. */
export function detectEvents(prev, next) {
  if (!prev || ENDED.has(next.status) || ENDED.has(prev.status)) return [];
  const out = [];
  if (pushed(prev, next)) out.push({ kind: 'pushed', event: 'pushed' });
  if (prev.status !== 're_review' && next.status === 're_review') out.push({ kind: 're_review', event: 're_review' });
  if (prev.status !== 'ci_failing' && next.status === 'ci_failing') out.push({ kind: 'ci', event: 'ci_failed' });
  else if (prev.status === 'ci_failing' && next.status !== 'ci_failing') out.push({ kind: 'ci', event: 'ci_passed' });
  return out;
}

const subject = (pr) => `${pr.number != null ? '#' + pr.number : pr.id} ${pr.title}`;
const TEXT = {
  pushed: (pr) => `New commits on ${subject(pr)}${pr.adds || pr.dels ? ` (+${pr.adds} −${pr.dels})` : ''}`,
  re_review: (pr) => `Re-review requested on ${subject(pr)}`,
  ci_failed: (pr) => `CI failed on ${subject(pr)}`,
  ci_passed: (pr) => `CI is green again on ${subject(pr)}`,
};

export const DEFAULT_POLICY = () => ({ global: { pushed: true, re_review: true, ci: true }, perPR: {} });

/** One kind for one PR: `on` is what will happen, `overridden` says whether the PR sets it itself, `inherited` is the global switch (what it would follow). */
export function effective(policy, prId, kind) {
  const o = policy.perPR[prId]?.[kind], inherited = !!policy.global[kind];
  return typeof o === 'boolean' ? { on: o, overridden: true, inherited } : { on: inherited, overridden: false, inherited };
}
/** All three kinds for one PR, for the PR's notification menu. */
export const resolveFor = (policy, prId) => Object.fromEntries(KINDS.map((k) => [k, effective(policy, prId, k)]));

/** Should this event reach the inbox? The PR's own override if it has one for this kind, otherwise the global switch. Mine or not makes no difference. */
export const shouldNotify = (ev, pr, policy) => effective(policy, pr.id, ev.kind).on;

/** Events for every tracked PR that was already tracked before. `prevLive` and `nextLive` are arrays of PRs; pure. */
export function eventsFor(prevLive, nextLive, policy, { now = new Date().toISOString(), nextId = (() => { let n = 0; return () => `${now}-${++n}`; })() } = {}) {
  const prev = new Map(prevLive.map((p) => [p.id, p]));
  const out = [];
  for (const pr of nextLive) {
    for (const ev of detectEvents(prev.get(pr.id), pr)) {
      if (!shouldNotify(ev, pr, policy)) continue;
      out.push({ id: nextId(), ts: now, kind: ev.kind, event: ev.event, prId: pr.id, prNumber: pr.number ?? null, title: pr.title, text: TEXT[ev.event](pr), mine: !!pr.mine });
    }
  }
  return out;
}

const EMPTY = () => ({ policy: DEFAULT_POLICY(), inbox: [], silenced: [], lastSeen: null, seq: 0 });

/** Policy, inbox and silenced alerts, in a small file next to the config. */
export class NotifyStore {
  constructor({ file = null, persist = true } = {}) { this.file = file; this.persist = persist && !!file; this.data = EMPTY(); this.load(); }
  load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')), d = EMPTY();
      for (const k of KINDS) if (raw.policy?.global && typeof raw.policy.global[k] === 'boolean') d.policy.global[k] = raw.policy.global[k];
      for (const [id, o] of Object.entries(raw.policy?.perPR || {})) {
        const clean = {};
        // an older version stored an "all" override as well; fold it into the kinds it did not set itself, so nothing changes meaning
        for (const k of KINDS) { if (o && typeof o[k] === 'boolean') clean[k] = o[k]; else if (o && typeof o.all === 'boolean') clean[k] = o.all; }
        if (Object.keys(clean).length) d.policy.perPR[id] = clean;
      }
      d.inbox = (Array.isArray(raw.inbox) ? raw.inbox : []).filter((e) => e && e.id && e.kind && e.text).slice(-MAX_INBOX);
      d.silenced = (Array.isArray(raw.silenced) ? raw.silenced : []).filter((s) => s && typeof s.id === 'string').slice(-MAX_SILENCED);
      d.lastSeen = typeof raw.lastSeen === 'string' ? raw.lastSeen : null;
      d.seq = Number.isFinite(raw.seq) ? raw.seq : 0;
      this.data = d;
    } catch (e) { if (e.code !== 'ENOENT') console.warn(`battlemap: could not read ${this.file}: ${e.message}`); }
  }
  save() {
    if (!this.persist) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try { fs.chmodSync(this.file, 0o600); } catch { /* windows */ }
    return true;
  }
  get() { return this.data; }

  setGlobal(kind, enabled) {
    if (!KINDS.includes(kind) || typeof enabled !== 'boolean') return { ok: false, error: `kind must be one of ${KINDS.join(', ')} and enabled true or false` };
    this.data.policy.global[kind] = enabled; this.save(); return { ok: true };
  }
  /** Override one kind for one PR: true (always tell me), false (never) or null (back to the global switch). kind 'all' writes all three kinds at once; it is not stored as a setting of its own. */
  setPR(id, kind, enabled) {
    if (!id || ![...KINDS, 'all'].includes(kind) || ![true, false, null].includes(enabled)) return { ok: false, error: 'id, a kind (or "all") and true, false or null are required' };
    const o = { ...(this.data.policy.perPR[id] || {}) };
    for (const k of kind === 'all' ? KINDS : [kind]) { if (enabled === null) delete o[k]; else o[k] = enabled; }
    if (Object.keys(o).length) { this.data.policy.perPR[id] = o; } else delete this.data.policy.perPR[id];
    const ids = Object.keys(this.data.policy.perPR);
    if (ids.length > MAX_PR_RULES) delete this.data.policy.perPR[ids[0]];
    this.save(); return { ok: true };
  }
  add(events) {
    if (!events.length) return 0;
    this.data.inbox = [...this.data.inbox, ...events].slice(-MAX_INBOX);
    this.data.seq += events.length; this.save(); return events.length;
  }
  /** Clear one notification, or all of them (no id). */
  clear(id) {
    const before = this.data.inbox.length;
    this.data.inbox = id ? this.data.inbox.filter((e) => e.id !== id) : [];
    this.save(); return { ok: true, removed: before - this.data.inbox.length };
  }
  markSeen(now = new Date().toISOString()) { this.data.lastSeen = now; this.save(); }
  unread() { const t = this.data.lastSeen; return this.data.inbox.filter((e) => !t || e.ts > t).length; }

  silence(ids) {
    const have = new Set(this.data.silenced.map((s) => s.id)), now = new Date().toISOString();
    for (const id of ids) if (typeof id === 'string' && id && !have.has(id)) { this.data.silenced.push({ id, at: now }); have.add(id); }
    this.data.silenced = this.data.silenced.slice(-MAX_SILENCED); this.save(); return { ok: true };
  }
  restore(ids) { const drop = new Set(ids); this.data.silenced = this.data.silenced.filter((s) => !drop.has(s.id)); this.save(); return { ok: true }; }
  silencedIds() { return new Set(this.data.silenced.map((s) => s.id)); }
}
