// Which map a PR is drawn on, and how. Pure: facts in (pr.base, file.since from the feed), a plan out. Nothing is guessed about a rebase;
// it only decides which tree to look at, and says so in words.
//
//   master   the latest default branch. A PR that is up to date, or behind with no conflict, lives here. Where main has moved or deleted a
//            file the PR touches, the PR's edit stands on the building's new home and a ghost shell outlined in the PR's colour stands where
//            the file used to be (forMaster below).
//   base     the PR's own base: stacked PRs and PRs aimed at another branch (forced: there is no sensible other view), and, by choice, a
//            PR behind with conflicts (the tree where it branched). Everything else on the map is hidden.
//   blind    behind, and the list of what main changed is too long or could not be read: nothing is drawn, only a message.
//
// A conflicted PR can be viewed either way (choices); everything else has one view.

export const CHOICES = ['master', 'own'];

/** The plan for one PR. `choice` is the viewer's pick for a PR that has one ('master' by default). Pure. */
export function viewPlan(pr, choice = 'master') {
  const b = pr && pr.base, none = { mode: 'master', forced: false, choices: null, at: null };
  if (!b || !b.ref) return none;
  const behind = Number.isInteger(b.behind) && b.behind > 0, name = b.ref;
  if (b.stackedOn) return { mode: 'base', forced: true, choices: null, at: name, headline: `Viewing ${pr.id} from its own base`, detail: `It is stacked on ${b.stackedOn}, so it is drawn on ${name}: the map as ${b.stackedOn} leaves it. Everything else is hidden.`, tag: `Stacked on ${b.stackedOn}` };
  if (b.onDefault === false) return { mode: 'base', forced: true, choices: null, at: name, headline: `Viewing ${pr.id} from its own base`, detail: `It targets ${name}, not the default branch, so it is drawn on ${name}. Everything else is hidden.`, tag: `Targets ${name}` };
  if (behind && (b.sinceCut || b.sinceUnknown)) return { mode: 'blind', forced: true, choices: null, at: null, headline: 'This PR can not be visualized', detail: `It is ${b.behind} commit${b.behind > 1 ? 's' : ''} behind ${name}, and ${b.sinceCut ? 'the list of what ' + name + ' changed since is too long to read in full' : 'what ' + name + ' changed since could not be read'}. It is still tracked, and you still get its notifications.`, tag: 'Can not be visualized' };
  if (behind && b.mergeable === 'CONFLICTING' && b.mergeBase) {
    const own = choice === 'own';
    return { mode: own ? 'base' : 'master', forced: false, choices: CHOICES, at: own ? b.mergeBase : null, headline: `Viewing ${pr.id} from its own base`, detail: `Where it branched, ${b.behind} commit${b.behind > 1 ? 's' : ''} behind ${name} (${b.mergeBase.slice(0, 7)}). Everything else is hidden.`, tag: 'Conflicts with ' + name };
  }
  return none;
}

const LOC_OF_STALE = 12;
/**
 * A PR for the latest-master map: where main has moved or deleted a file the PR touches, put the edit where the file is now and keep a
 * record of where it used to be (`stale`: a ghost shell for the old place). Files main changed too stay as they are, marked `conflict`
 * (a quiet cue on the focused PR). Returns a new PR; the input is untouched. Pure.
 */
export function forMaster(pr, byPath) {
  const files = new Map(), stale = new Map();
  const keep = (f) => { const o = files.get(f.path); if (o) files.set(f.path, { ...o, add: o.add + f.add, del: o.del + f.del }); else files.set(f.path, f); };
  const ghost = (path, f, kind, to) => { const o = stale.get(path); stale.set(path, { path, kind, add: (o?.add || 0) + (f.add || 0), del: (o?.del || 0) + (f.del || 0), ...(to ? { to } : {}) }); };
  for (const f of pr.files || []) {
    const s = f.since, old = f.from || f.path;
    if (!s) { keep(f); continue; }
    if (s.change === 'modified' || s.change === 'added') { keep({ ...f, conflict: true }); continue; }                // the target touched it too: a candidate for a conflict
    const to = s.change === 'moved' && s.to && byPath.has(s.to) ? s.to : null;                                      // where the file lives now, when we can see it
    if (to) {
      if (f.change === 'renamed') { keep({ ...f, from: to }); ghost(old, f, 'moved', to); }
      else if (f.change === 'removed') { keep({ ...f, path: to }); ghost(old, f, 'moved', to); }
      else { const { from, ...rest } = f; keep({ ...rest, path: to, ...(f.change === 'added' ? { change: undefined } : {}) }); ghost(old, f, 'moved', to); }
    } else if (f.change === 'removed') { /* both sides deleted it: nothing left to show */ }
    else if (f.change === 'renamed') { keep(f); ghost(old, f, 'removed'); }
    else ghost(old, f, 'removed');                                                                                  // an edit of a file main deleted: no building to stand on, only the ghost
  }
  return { ...pr, files: [...files.values()], stale: [...stale.values()] };
}

/** Ghost files for the layout, from prepared PRs: each old place gets a plot sized by the lines the PR touches there. Pure. */
export function staleFiles(prs, byPath) {
  const out = new Map();
  for (const p of prs || []) for (const s of p.stale || []) {
    if (byPath.has(s.path)) continue;
    const loc = Math.max(LOC_OF_STALE, s.add + s.del), o = out.get(s.path);
    if (!o || loc > o.loc) out.set(s.path, { path: s.path, loc, complexity: Math.round(loc / 12), kind: 'stale' });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}
