import { api } from './api.js';
import { SCALES, TOPPERS, scaleTicks, DIFF_COLORS, MIN_COVER } from './spires.js';
import { authorColor, epicEmblem, flagLabel, EMBLEMS } from './sigil.js';
import { STYLE_MODES, normaliseStyle } from './building.js';
import { SORTS, SORT_HELP, AGE_STEPS, waitingDays, emptyFilters, normaliseFilters, applyFilters, sortPRs, activeCount, anyFilter, describeFilters, ageDays, formatAge } from './filters.js';

const STATUS = {
  review_requested: { label: 'REVIEW', color: '#5ab0ff', glyph: '?' },
  re_review: { label: 'RE-REVIEW', color: '#b794ff', glyph: '↻' },
  changes_requested: { label: 'CHANGES', color: '#ffb347', glyph: '✎' },
  ci_failing: { label: 'CI RED', color: '#ff5d6c', glyph: '✕' },
  ready_to_merge: { label: 'READY', color: '#3ddc97', glyph: '✓' },
  draft: { label: 'DRAFT', color: '#8792a2', glyph: '…' },
  merged: { label: 'MERGED', color: '#7b8cde', glyph: 'M', ended: true },
  closed: { label: 'CLOSED', color: '#6b7686', glyph: '–', ended: true },
};
const statusColors = Object.fromEntries(Object.entries(STATUS).map(([k, v]) => [k, v.color]));
const $ = (id) => document.getElementById(id);
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem('bm.' + k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem('bm.' + k, JSON.stringify(v)); } catch { /* private mode */ } } };

/** DOM builder. Everything from Jira or GitHub goes in as text nodes, never HTML. */
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v; else if (k === 'style') el.style.cssText = v; else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') { if (/^https?:\/\//i.test(v)) { el.setAttribute('href', v); el.target = '_blank'; el.rel = 'noopener noreferrer'; } else if (v === '#') el.setAttribute('href', '#'); }
    else if (k in el && k !== 'list') el[k] = v; else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
/** replaceChildren that skips null/false and flattens arrays (the native one prints "null"). */
function fill(el, ...kids) {
  const out = [];
  const walk = (k) => { if (Array.isArray(k)) k.forEach(walk); else if (k != null && k !== false) out.push(k.nodeType ? k : document.createTextNode(String(k))); };
  kids.forEach(walk); el.replaceChildren(...out);
}
const initials = (a) => (a.replace(/[^A-Za-z0-9 ._-]/g, '').split(/[ ._-]+/).filter(Boolean).map((s) => s[0]).join('').slice(0, 2) || a.slice(0, 2)).toUpperCase();

const state = { snap: null, sel: null, filters: normaliseFilters(ls.get('filters', null)), ageLift: ls.get('ageLift', false), filterRefresh: null, fog: ls.get('fog', true), scale: ls.get('scale', 'sqrt'), topper: ls.get('topper', 'share'), lines: ls.get('lines', 'selected'), labels: ls.get('labels', true), flags: ls.get('flags', true), view: ['2d', 'iso', '3d'].includes(ls.get('view', 'iso')) ? ls.get('view', 'iso') : 'iso', scene: null, transitions: null, cfg: null, trackRefresh: null, known: null, wmarks: ls.get('wmarks', true), bstyle: normaliseStyle(ls.get('bstyle', null)) };

/* ---------- scene (optional: the UI still works if WebGL or three is unavailable) ---------- */
async function startScene() {
  try {
    const { createScene } = await import('./scene.js');
    state.scene = createScene($('stage'), { makeFlag, updateFlag, onPickPR: (id) => selectPR(state.sel === id ? null : id), onPickFile, onPickNothing: () => { if (state.sel) selectPR(null); hideTip(); $('filebar').hidden = true; }, onHover });
    state.scene.setView(state.view, { instant: true });
    state.scene.setUI({ labels: state.labels, flags: state.flags, lines: state.lines });
  } catch (e) {
    console.error(e);
    const box = $('nogl'); box.hidden = false;
    const missing = /three|Failed to fetch dynamically|module/i.test(String(e.message));
    fill(box, h('div', null, h('b', null, missing ? 'Three.js is not installed.' : '3D view unavailable.'), h('br'),
      missing ? ['Run ', h('code', null, 'npm install'), ' in the battlemap folder, then reload. The panels still work.'] : [String(e.message), ' The panels still work.']));
  }
}

function makeFlag(pr) {
  const el = h('div', { class: 'flag', role: 'button', tabindex: 0 }, h('span', { class: 'av' }), h('span', { class: 'num' }), h('span', { class: 'tx' }), h('span', { class: 'bd' }), h('span', { class: 'em', hidden: true }));
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.click(); });
  updateFlag(el, pr); return el;
}
function updateFlag(el, pr) {
  const s = STATUS[pr.status];
  el.style.setProperty('--st', s.color); el.style.setProperty('--au', authorColor(pr.author));
  el.classList.toggle('needs', !!pr.needs);
  const em = epicEmblem(pr.epic), emEl = el.querySelector('.em');
  emEl.hidden = !em; if (em) { emEl.dataset.shape = em.shape; emEl.style.setProperty('--eh', em.hue); }
  el.setAttribute('aria-label', `${flagLabel(pr)} ${pr.ticketKey || ''} ${pr.title}, ${s.label}${pr.epic ? ', epic ' + pr.epic : ''}`);
  el.title = `${flagLabel(pr)} ${pr.title}\n@${pr.author}${pr.epic ? ' · ' + pr.epic : ''}`;
  el.querySelector('.av').textContent = initials(pr.author);
  el.querySelector('.num').textContent = flagLabel(pr);
  const tx = el.querySelector('.tx'); tx.replaceChildren(pr.ticketKey || pr.id, h('em', null, pr.title.replace(pr.ticketKey || '', '').trim()));
  el.querySelector('.bd').textContent = s.glyph;
}

/* ---------- data ---------- */
let pending = null;
async function refresh() {
  const snap = await api.get('/api/snapshot');
  state.snap = snap;
  const open = snap.prs.filter((p) => !p.ended), fresh = state.known ? open.filter((p) => !state.known.has(p.id) && viaRulesOnly(p)) : [];
  state.known = new Set(open.map((p) => p.id));
  if (state.filters.epic && !snap.epics.includes(state.filters.epic)) { state.filters = { ...state.filters, epic: null }; ls.set('filters', state.filters); }
  if (fresh.length) toast(`${fresh.length} new PR${fresh.length > 1 ? 's' : ''} tracked by your rules: ${fresh.slice(0, 3).map((p) => p.number != null ? '#' + p.number : p.id).join(', ')}${fresh.length > 3 ? '…' : ''}`);
  if (state.sel && !snap.prs.some((p) => p.id === state.sel)) state.sel = null;
  renderAll(); applyScene(); state.trackRefresh?.();
}
/** What the tray and the map show, in order: the filter model decides both. */
function visiblePRs() {
  const s = state.snap; if (!s) return [];
  const now = Date.now();
  return sortPRs(applyFilters(s.prs, state.filters, now), state.filters.sort, now);
}
function setFilters(patch) {
  state.filters = normaliseFilters({ ...state.filters, ...patch });
  ls.set('filters', state.filters);
  if (state.sel && !visiblePRs().some((p) => p.id === state.sel)) state.sel = null;
  renderAll(); applyScene(); state.filterRefresh?.();
}
const clearFilters = () => setFilters({ ...emptyFilters(), sort: state.filters.sort });
function applyScene() {
  const sc = state.scene, s = state.snap; if (!sc || !s) return;
  sc.setStyle(state.bstyle);
  sc.setFiles(s.files);
  sc.setUI({ labels: state.labels, flags: state.flags, lines: state.lines, watched: state.wmarks });
  sc.setWatched(s.watch.watchedPaths);
  const selPR = s.prs.find((p) => p.id === state.sel), live = visiblePRs().filter((p) => !p.ended);
  sc.setPRs(s.prs, { mode: state.scale, topper: state.topper, focusId: selPR && !selPR.ended ? state.sel : null, ageLift: state.ageLift, visible: new Set(live.map((p) => p.id)), fog: state.fog, statusColors, view: state.view });
}
function connectEvents() {
  const es = new EventSource('/api/events');
  es.addEventListener('snapshot', () => { clearTimeout(pending); pending = setTimeout(() => refresh().catch(() => { /* server restarting: the reconnect sends a fresh snapshot event */ }), 120); });
  es.onerror = () => { /* the browser retries by itself */ };
}

/* ---------- rendering ---------- */
function renderAll() { renderHeader(); renderChips(); renderCards(); renderFocus(); renderAlerts(); renderLayers(); }

function renderHeader() {
  const s = state.snap;
  const w = s.watch, open = s.prs.filter((p) => !p.ended).length;
  $('sub').textContent = `${s.sampleMode ? 'sample repo · ' : ''}${s.files.length} files · ${w.mode === 'all' ? `${open} PRs` : `${open} tracked of ${w.feedCount} PRs`}${anyFilter(state.filters) ? ` · showing ${visiblePRs().filter((p) => !p.ended).length}` : ''}${s.mock ? ' · MOCK JIRA' : ''}`;
  const n = s.prs.filter((p) => p.needs).length, red = s.prs.filter((p) => p.status === 'ci_failing').length, rdy = s.prs.filter((p) => p.status === 'ready_to_merge').length;
  $('counters').replaceChildren(...[['NEEDS YOU', n, 'var(--accent)'], ['CI RED', red, 'var(--del)'], ['READY', rdy, 'var(--add)']].map(([l, v, c]) => h('div', { class: 'ctr' }, h('b', { style: `color:${c}` }, v), h('span', null, l))));
  const j = s.jira, dot = $('jiraDot'), txt = $('jiraTxt');
  dot.className = 'dot' + (!j.configured ? '' : j.error ? (j.ok ? ' warn' : ' bad') : j.ok ? ' ok' : ' warn');
  txt.textContent = !j.configured ? 'Connect Jira' : j.error ? (j.ok ? 'Jira stale' : 'Jira error') : j.ok ? (j.sprint?.name || 'Jira') : 'Jira…';
  $('jiraPill').title = !j.configured ? 'Jira is not configured' : j.error ? `${j.error}${j.hint ? ' — ' + j.hint : ''}` : `Connected to ${j.baseUrl} as ${j.user?.name || '?'} · ${j.ticketCount} tickets`;
  const warns = s.insights.filter((i) => i.severity === 'warn').length, b = $('alertCount');
  b.hidden = !s.insights.length; b.textContent = warns || s.insights.length; b.style.background = warns ? 'var(--warn)' : 'var(--info)';
}

function renderChips() {
  const s = state.snap, box = $('chips');
  const chip = (label, on, fn) => h('button', { class: 'chip', 'aria-pressed': String(on), onclick: fn }, label);
  const rules = s.watch.rules, label = (r) => (r.type === 'author' ? '@' + r.value : r.value);
  const pill = rules.length ? h('button', { class: 'chip watch', id: 'watchPill', title: `Watching, so matching PRs are tracked automatically:\n${rules.map((r) => `${r.type === 'author' ? 'author' : 'path'}  ${label(r)}  (${r.matches} open)`).join('\n')}\nClick to edit`, onclick: openTrack },
    `◉ WATCHING ${rules.slice(0, 2).map(label).join(' · ')}${rules.length > 2 ? ` +${rules.length - 2}` : ''}`) : null;
  const nf = activeCount(state.filters), sorted = state.filters.sort !== 'attention';
  const filterBtn = h('button', { class: 'chip', id: 'filterBtn', 'aria-pressed': String(nf > 0 || sorted), 'aria-expanded': String(!$('filters').hidden), title: 'Filter and sort the PRs (press / to search)',
    onclick: (e) => { e.stopPropagation(); toggleFilters(); } }, `FILTER${nf ? ` · ${nf}` : ''}${sorted ? ` · ${SORTS[state.filters.sort].toUpperCase()}` : ''}`);
  fill(box,
    pill,
    filterBtn,
    chip('Needs me', state.filters.needs, () => setFilters({ needs: !state.filters.needs })),
    ...s.epics.map((e) => chip(e, state.filters.epic === e, () => setFilters({ epic: state.filters.epic === e ? null : e }))));
}

const ruleBy = (p) => (p.tracked?.by || []).filter((b) => b.kind === 'author' || b.kind === 'path');
/** True when only watch rules, not you, put this PR on the map. */
const viaRulesOnly = (p) => { const by = p.tracked?.by || []; return by.length > 0 && by.every((b) => b.kind === 'author' || b.kind === 'path'); };
function viaChip(p) {
  const r = !p.ended && viaRulesOnly(p) ? ruleBy(p) : []; if (!r.length) return null;
  const name = (b) => (b.kind === 'author' ? '@' + b.value : b.value);
  return h('span', { class: 'via', title: `Tracked because of your watch rule${r.length > 1 ? 's' : ''}: ${r.map(name).join(', ')}` }, `◉ ${name(r[0])}${r.length > 1 ? ` +${r.length - 1}` : ''}`);
}
function ticketLine(pr, s) {
  if (!pr.ticketKey) return h('div', { class: 'tk none' }, 'No ticket key');
  if (pr.ticket) return h('div', { class: 'tk' }, `${pr.ticketKey} · ${pr.ticket.status.name} · ${pr.ticket.assignee?.name || 'Unassigned'}`);
  return h('div', { class: 'tk none' }, s.jira.ok ? `${pr.ticketKey} (not found in Jira)` : `${pr.ticketKey} (Jira offline)`);
}
function renderCards() {
  const s = state.snap, box = $('cards'), list = visiblePRs(), now = Date.now();
  const more = s.watch.availableTotal;
  const add = h('button', { class: 'card add', id: 'trackBtn', onclick: openTrack }, h('span', { class: 'plus' }, '+'), h('b', null, 'TRACK PRS'),
    h('span', { class: 'm' }, more ? `${more} more open in the feed` : 'Add by link, author or path'));
  const none = s.prs.length ? h('span', null, `Nothing matches: PRs ${describeFilters(state.filters, (x) => STATUS[x]?.label.toLowerCase() || x) || 'as filtered'}. `, h('button', { class: 'btn', id: 'clearFilters', onclick: clearFilters }, 'CLEAR FILTERS')) : s.watch.mode === 'all' ? 'No pull requests yet. Feed some in with --prs or POST /api/prs (Settings > Data).' : s.watch.feedCount ? 'Nothing tracked yet. Your own PRs are tracked automatically; add others with + TRACK PRS.' : 'No pull requests yet. Feed some in with --prs or POST /api/prs (Settings > Data).';
  box.replaceChildren(...(list.length ? list : [h('div', { class: 'empty' }, none)]).map((p) => {
    if (p.nodeType) return p;
    const st = STATUS[p.status];
    return h('button', { class: 'card' + (p.ended ? ' ended' : ''), 'data-id': p.id, style: `--st:${st.color}`, 'aria-pressed': String(state.sel === p.id), onclick: () => selectPR(state.sel === p.id ? null : p.id) },
      h('div', { class: 'r1' }, h('span', { class: 'pill' }, st.label), h('b', null, p.ticketKey || p.id), p.needs ? h('span', { class: 'need' }, 'NEEDS YOU') : null,
        p.ended ? h('span', { class: 'dismiss', role: 'button', tabindex: 0, title: 'Forget this PR', onclick: (e) => { e.stopPropagation(); dismissPR(p); }, onkeydown: (e) => { if (e.key === 'Enter') { e.stopPropagation(); dismissPR(p); } } }, 'DISMISS') : null),
      h('div', { class: 't' }, p.title),
      (() => { const age = formatAge(ageDays(p.createdAt, now)); return h('div', { class: 'm', title: p.createdAt ? `opened ${ago(p.createdAt)}${p.updatedAt ? `, updated ${ago(p.updatedAt)}` : ''}` : '' }, `@${p.author}${age ? ' · ' + age : ''} · ${p.files.length} files · +${p.adds} −${p.dels}${p.epic ? ' · ' + p.epic : ''}`); })(),
      p.ended ? h('div', { class: 'tk none' }, p.endedInferred ? 'Left the feed: merged or closed' : `${st.label.toLowerCase()} ${ago(p.endedAt || p.updatedAt)}`) : ticketLine(p, s), h('div', { class: 'why' }, h('span', null, (() => { const w = waitingDays(p, now); return w == null ? p.needs : `waiting ${formatAge(w)}${p.needs ? ' · ' + p.needs : ''}`; })()), viaChip(p)));
  }), add);
}

function selectPR(id, fly = true) {
  state.sel = id; state.transitions = null;
  renderCards(); renderFocus(); applyScene();
  if (id && fly) state.scene?.flyToPR(id); else if (!id && fly) state.scene?.flyHome();
  const c = id && document.querySelector(`.card[data-id="${CSS.escape(id)}"]`); if (c) c.scrollIntoView({ inline: 'center', block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if (id) loadTransitions(id);
}

async function loadTransitions(prId) {
  const pr = state.snap.prs.find((p) => p.id === prId); if (!pr?.ticket) return;
  const r = await api.get('/api/jira/transitions/' + encodeURIComponent(pr.ticketKey));
  if (state.sel !== prId) return;
  state.transitions = r.ok ? r.transitions : { error: r.error || 'Could not load transitions' };
  renderFocus();
}

function renderFocus() {
  const box = $('focus'), s = state.snap, pr = s.prs.find((p) => p.id === state.sel);
  if (!pr) { box.hidden = true; return; }
  const draft = document.getElementById('cmt')?.value || '', hadFocus = document.activeElement?.id === 'cmt';
  const st = STATUS[pr.status], t = pr.ticket;
  box.hidden = false; box.style.setProperty('--st', st.color);
  const total = pr.adds + pr.dels || 1, maxFile = Math.max(1, ...pr.files.map((f) => f.add + f.del));
  const hunks = pr.files.reduce((a, f) => a + f.hunks.length, 0), synth = pr.files.some((f) => f.syntheticHunks);
  const ticket = !pr.ticketKey
    ? h('p', { class: 'sub' }, 'No Jira key in the title or branch.')
    : t ? h('div', { class: 'kv' },
        h('span', null, 'Ticket'), h('span', null, h('a', { href: t.url }, t.key), ' ', h('span', { class: `chipmini ${t.status.category}` }, t.status.name.toUpperCase())),
        h('span', null, 'Summary'), h('span', null, t.summary),
        h('span', null, 'Assignee'), h('span', null, t.assignee?.name || 'Unassigned'),
        t.epic ? [h('span', null, 'Epic'), h('span', null, t.epic.name || t.epic.key)] : null,
        t.sprint ? [h('span', null, 'Sprint'), h('span', null, t.sprint.name)] : null,
        t.points != null ? [h('span', null, 'Points'), h('span', null, t.points)] : null)
    : h('p', { class: 'sub' }, `${pr.ticketKey}: ${s.jira.ok ? 'not found in Jira.' : s.jira.configured ? 'Jira is unreachable.' : 'Jira is not connected.'}`, ' ', !s.jira.configured ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openSettings('jira'); } }, 'Connect it') : null);

  let actions = null;
  if (t && s.jira.ok) {
    const tr = state.transitions;
    const sel = h('select', { id: 'trSel', 'aria-label': 'Move ticket to' }, Array.isArray(tr) ? [h('option', { value: '' }, 'Move ticket to…'), ...tr.map((x) => h('option', { value: x.id }, x.to || x.name))] : h('option', null, tr?.error || 'Loading…'));
    const note = h('textarea', { id: 'cmt', placeholder: 'Comment on the ticket', rows: 2 });
    actions = h('div', { class: 'blk' }, h('h3', null, 'TICKET ACTIONS'),
      h('div', { class: 'act' }, sel, h('button', { class: 'btn', id: 'trGo', onclick: async (e) => {
        if (!sel.value) return; e.target.disabled = true;
        const r = await api.send('POST', '/api/jira/transition', { key: t.key, transitionId: sel.value });
        toast(r.ok ? `${t.key} moved` : `${r.error}${r.hint ? '. ' + r.hint : ''}`); e.target.disabled = false;
      } }, 'MOVE')),
      h('div', { class: 'act' }, note, h('button', { class: 'btn', id: 'cmtGo', onclick: async (e) => {
        if (!note.value.trim()) return; e.target.disabled = true;
        const r = await api.send('POST', '/api/jira/comment', { key: t.key, text: note.value });
        if (r.ok) note.value = ''; toast(r.ok ? 'Comment added' : `${r.error}${r.hint ? '. ' + r.hint : ''}`); e.target.disabled = false;
      } }, 'SEND')));
  }
  fill(box,
    h('button', { class: 'x', 'aria-label': 'Exit focus', onclick: () => selectPR(null) }, 'ESC'),
    h('span', { class: 'pill', style: `--st:${st.color}` }, st.label), ' ', h('span', { class: 'sub' }, `${pr.id} · `, h('button', { class: 'linkish', id: 'onlyAuthor', title: `Show only @${pr.author}`, onclick: () => setFilters({ authors: [pr.author] }) }, `@${pr.author}`)),
    h('h2', null, pr.title),
    pr.needs ? h('div', { style: 'color:var(--accent)' }, pr.needs) : null,
    pr.ended ? trackingBlock(pr) : null,      // an ended PR's only action is dismissing it, so it goes first
    h('div', { class: 'blk' }, h('h3', null, 'DIFF'),
      h('div', { class: 'sum' }, h('span', { class: 'a' }, `+${pr.adds}`), h('span', { class: 'd' }, `−${pr.dels}`), h('span', { class: 'sub' }, `${pr.files.length} files · ${hunks} hunks${synth ? ' (estimated)' : ''}`)),
      h('div', { class: 'bar' }, h('i', { class: 'a', style: `width:${(pr.adds / total) * 100}%` }), h('i', { class: 'd', style: `width:${(pr.dels / total) * 100}%` })),
      h('div', { class: 'files' }, pr.files.slice().sort((a, b) => b.add + b.del - (a.add + a.del)).map((f) => {
        const name = f.path.split('/').pop(), dir = f.path.slice(0, f.path.length - name.length);
        return h('button', { class: 'frow', onclick: () => state.scene?.flyToFile(f.path), onmouseenter: () => state.scene?.setHighlight([f.path]), onmouseleave: () => state.scene?.setHighlight([]), onfocus: () => state.scene?.setHighlight([f.path]), onblur: () => state.scene?.setHighlight([]) },
          h('span', { class: 'nm' }, h('small', null, dir), name), h('span', { class: 'ct' }, h('span', { class: 'a' }, `+${f.add}`), h('span', { class: 'd' }, `−${f.del}`)),
          h('div', { class: 'bar', style: `width:${((f.add + f.del) / maxFile) * 100}%` }, h('i', { class: 'a', style: `width:${(f.add / (f.add + f.del || 1)) * 100}%` }), h('i', { class: 'd', style: `width:${(f.del / (f.add + f.del || 1)) * 100}%` })));
      }))),
    h('div', { class: 'blk' }, h('h3', null, 'JIRA'), ticket),
    actions,
    pr.ended ? null : trackingBlock(pr),
    pr.url ? h('div', { class: 'blk' }, h('a', { href: pr.url }, 'Open pull request')) : null);
  const cm = document.getElementById('cmt'); if (cm && draft) { cm.value = draft; if (hadFocus) cm.focus(); }
}

function renderAlerts() {
  const s = state.snap, box = $('alerts'); if (box.hidden) return;
  fill(box,
    h('h2', null, `ALERTS (${s.insights.length})`, h('button', { class: 'btn', onclick: () => { box.hidden = true; } }, 'CLOSE')),
    !s.insights.length ? h('p', { class: 'sub' }, s.jira.ok ? 'PRs and tickets agree. Nothing to fix.' : 'Connect Jira to compare tickets with PRs.') : null,
    ...s.insights.map((i) => h('button', { class: `al ${i.severity}`, onclick: () => { box.hidden = true; if (i.prIds[0]) selectPR(i.prIds[0]); else if (i.files?.[0]) state.scene?.flyToFile(i.files[0]); } }, h('b', null, i.title), h('span', null, i.detail))));
}

/* ---------- layers (view + spire options) ---------- */
const VIEW_LABEL = { '2d': '2D', iso: 'Isometric', '3d': '3D' };
function seg(options, current, onPick, label) {
  return h('div', { class: 'seg', role: 'group', 'aria-label': label }, options.map(([val, text]) => h('button', { 'aria-pressed': String(current === val), onclick: () => onPick(val) }, text)));
}
function toggle(label, on, onChange, id) {
  return h('label', { class: 'tgl' }, h('input', { type: 'checkbox', id, checked: on, onchange: (e) => onChange(e.target.checked) }), label);
}
const BSTYLE_HELP = {
  plain: 'Every file is a plain block in its folder\u2019s colour.',
  colors: 'Every file gets its own shade inside its folder\u2019s colour, from a hash of its path. Same file, same colour, every time.',
  full: 'Colours, plus a silhouette, wall material, windows and a rooftop detail per file, all from a hash of its path. Footprint still follows lines, height follows complexity.',
};
/** Per-file looks: hashed colour, or the full hashed buildings. One state object, saved as one setting. */
function buildingsSection() {
  const b = state.bstyle, set = (patch, redraw = false) => { state.bstyle = normaliseStyle({ ...state.bstyle, ...patch }); ls.set('bstyle', state.bstyle); applyScene(); if (redraw) renderLayers(); };
  const slider = (id, label, key, min, max, step, fmt) => {
    const out = h('span', { class: 'rv' }, fmt(b[key]));
    return h('label', { class: 'rng' }, h('span', null, label),
      h('input', { type: 'range', id, min, max, step, value: b[key], 'aria-label': label, oninput: (e) => { out.textContent = fmt(Number(e.target.value)); set({ [key]: Number(e.target.value) }); } }), out);
  };
  const full = b.mode === 'full';
  return h('div', { class: 'lyr', id: 'l-buildings' }, h('h3', null, 'BUILDINGS'),
    h('div', { class: 'fl' }, h('span', null, 'Style'), seg(Object.entries(STYLE_MODES), b.mode, (v) => set({ mode: v }, true), 'Building style')),
    h('small', null, BSTYLE_HELP[b.mode]),
    b.mode === 'plain' ? null : [
      slider('b-spread', 'Hue spread', 'spread', 0, 50, 1, (v) => `${v}\u00b0`),
      full ? h('div', { class: 'fl' }, h('span', null, 'Focused PR'), seg([['side', 'Side by side'], ['facade', 'Facade']], b.focus, (v) => set({ focus: v }, true), 'Focused PR diff style')) : null,
      full ? h('small', null, b.focus === 'side' ? 'Additions (green scaffold) and deletions (taped floors) stand next to each other on the roof: same footprint, same level height, so count the levels.' : 'Additions climb the walls as scaffolding; deletions stack as taped floors on the roof.') : null,
      full ? slider('b-dens', 'Window density', 'density', 0.6, 2, 0.1, (v) => `${v.toFixed(1)}x`) : null,
      full ? slider('b-var', 'Shape variety', 'variety', 1, 7, 1, (v) => String(v)) : null,
      full ? slider('b-height', 'Height boost', 'height', 1, 3, 0.1, (v) => `${v.toFixed(1)}x`) : null,
      full ? toggle('Wall textures (brick, stone, steel)', b.texture, (v) => set({ texture: v }), 'l-texture') : null,
      h('div', { class: 'act' }, h('button', { class: 'btn', id: 'b-shuffle', onclick: () => set({ salt: b.salt + 1 }, true) }, 'RESHUFFLE HASH'), h('small', null, b.salt ? `Shuffle ${b.salt}` : 'Original shuffle'))],
    toggle('Show index codes (C-14)', b.codes, (v) => set({ codes: v }), 'l-codes'));
}
function renderLayers() {
  const box = $('layers'); if (box.hidden) return;
  const save = (k, v) => { state[k] = v; ls.set(k, v); applyScene(); renderLayers(); };
  const ticks = scaleTicks(state.scale, [10, 100, 500, 1000]);
  fill(box,
    h('div', { class: 'lyr' }, h('h3', null, 'VIEW'),
      seg([['2d', '2D'], ['iso', 'Isometric'], ['3d', '3D']], state.view, (v) => { state.view = v; ls.set('view', v); state.scene?.setView(v); renderLayers(); }, 'View'),
      h('small', null, state.view === '3d' ? 'Drag to pan, right-drag to rotate.' : state.view === 'iso' ? 'Fixed angle, drag to pan.' : 'Straight down, drag to pan.')),
    h('div', { class: 'lyr' }, h('h3', null, 'SPIRES'),
      h('div', { class: 'fl' }, h('span', null, 'Topper width'), seg(Object.entries(TOPPERS).map(([k, v]) => [k, v.label]), state.topper, (v) => save('topper', v), 'Topper width')),
      h('small', null, state.topper === 'share' ? `Footprint area is the share of the file a PR changes (at least ${Math.round(MIN_COVER * 100)}%). Height is lines changed.` : 'Small fixed-size columns. Height is lines changed.'),
      h('div', { class: 'fl' }, h('span', null, 'Height scale'), seg(Object.entries(SCALES).map(([k, v]) => [k, v.label.replace('Square root', 'Sqrt').replace('Logarithmic', 'Log')]), state.scale, (v) => save('scale', v), 'Height scale')),
      h('small', null, ticks.map((t) => `${t.lines} lines = ${t.height.toFixed(1)}`).join(' \u00b7 ')),
      h('div', { class: 'fl' }, h('span', null, 'Dotted lines'), seg([['selected', 'Selected PR'], ['all', 'All'], ['off', 'Off']], state.lines, (v) => save('lines', v), 'Dotted lines'))),
    buildingsSection(),
    h('div', { class: 'lyr' }, h('h3', null, 'MAP'),
      toggle('Fog of war (dim idle files)', state.fog, (v) => save('fog', v), 'l-fog'),
      toggle('File names', state.labels, (v) => save('labels', v), 'l-labels'),
      toggle('Mark watched files (cyan rim)', state.wmarks, (v) => save('wmarks', v), 'l-wmarks'),
      toggle('PR flags', state.flags, (v) => save('flags', v), 'l-flags'),
      toggle('Raise flags by age (older = taller)', state.ageLift, (v) => save('ageLift', v), 'l-agelift')));
}
function toggleLayers(force) {
  const box = $('layers'), open = force ?? box.hidden;
  box.hidden = !open; $('layersBtn').setAttribute('aria-expanded', String(open));
  if (open) toggleFilters(false);
  if (open) renderLayers();
}

/* ---------- key ---------- */
function openKey() {
  const sw = (c, t) => h('li', null, h('span', { class: 'sw', style: `--c:${c}` }), t);
  const ticks = scaleTicks(state.scale, [10, 100, 500, 1000]);
  modal.hidden = false;
  fill(sheet,
    h('div', { class: 'mhead' }, h('h2', null, 'KEY'), h('button', { class: 'btn', onclick: closeModal }, 'CLOSE')),
    h('div', { class: 'mpane keyp' },
      h('h3', null, 'THE MAP (from your files)'),
      h('ul', null, h('li', null, 'Each building is a file. Footprint is its lines of code, height is its complexity.'), h('li', null, 'Plates are folders; colour is the top-level package.'), h('li', null, 'The layout is a pure function of the file list, so the map never reshuffles.')),
      h('h3', null, 'TOPPERS (one per PR per file)'),
      h('ul', null,
        h('li', null, h('b', null, 'Width'), ` = the share of the file the PR changes: lines changed divided by the file's lines, at least ${Math.round(MIN_COVER * 100)}% so small edits show. Two PRs on one file split the roof.`),
        h('li', null, h('b', null, 'Height'), ` = lines changed (adds + deletes), one scale for the whole map. Now: ${SCALES[state.scale].label.toLowerCase()}; ${ticks.map((t) => `${t.lines} lines = ${t.height.toFixed(1)}`).join(', ')}.`),
        h('li', null, h('b', null, 'Colour'), ' = PR status:')),
      h('ul', { class: 'sw2' }, Object.values(STATUS).filter((v) => !v.ended).map((v) => sw(v.color, `${v.label} ${v.glyph}`))),
      h('h3', null, 'CONSTRUCTION SITES (Layers > Buildings > Buildings)'),
      h('ul', null,
        h('li', null, h('b', null, 'Crane'), ' on a roof = a PR is adding code to this file. Its colour is the PR\u2019s status, so it matches the flag. The whole crane is scaled by lines added on the same scale as the toppers, whatever the file or roof, so the same lines are the same crane anywhere. The flat pad under it is the share of the file changed. Two PRs on one roof, two cranes.'),
        h('li', null, h('b', null, 'Scaffolding'), ' (green, with a ring in the PR colour at the top) = you focused a PR and this is what it adds. By default it is a tower on the left of the roof, next to the taped floors for the deletions: same footprint, same baseline, same level height, so count the levels to compare added with deleted. Layers > Focused PR > Facade puts it up the walls instead, as high as lines added (never past the fully walled part).'),
        h('li', null, h('b', null, 'Red-taped floor'), ' = lines were deleted. An emptied floor with red tape in an X on every face. The stack is as tall as lines deleted on that same scale (one floor is 2.4 of it, up to 24 floors); focused, it is one tower on the right of the roof, the same size as the additions tower.'),
        h('li', null, 'The Plain and Colours styles keep the plain toppers described above.')),
      h('h3', null, 'FOCUSED PR'),
      h('ul', null, sw(DIFF_COLORS.add, 'Added lines, one block per hunk'), sw(DIFF_COLORS.del, 'Deleted lines, one block per hunk (slightly narrower)'), h('li', null, 'Block heights are proportional to line counts. Other PRs turn to glass.'), h('li', null, 'Moving dotted lines run from the flag to every file the PR touches.')),
      h('h3', null, 'FLAGS AND MARKERS'),
      h('ul', null, h('li', null, 'Flag = one PR. Ring colour is status, fill is the author, the glyph repeats the status, the number is the PR number.'), h('li', null, 'Emblem on the flag corner = epic. The shape and hue come from the epic name, so every PR in one epic wears the same emblem. No emblem means no epic:'), h('ul', { class: 'sw2 emb' }, EMBLEMS.map((shape) => h('li', null, h('span', { class: 'em', 'data-shape': shape, style: '--eh:200' })))), h('li', null, 'Gold pulse around a flag = needs you.'), h('li', null, 'Layers > Raise flags by age lifts old PRs on taller poles, so the ones that have been open longest stand out. The number on a card (3d, 2w) is its age.'), sw('#ffb347', 'Amber rim around a roof = two or more PRs touch this file.'), sw('#4cc9f0', 'Cyan rim around a roof = a watch rule covers this file, so any PR that touches it is tracked. The WATCHING pill at the top lists your rules; a cyan tag on a card names the rule that tracked it.'), h('li', null, 'Fog of war dims files nobody is working on.'), h('li', null, 'Layers > Buildings: each file\u2019s shade, silhouette (block, stepped, crown, L, tower, terraced, twin towers), wall material (concrete, brick, stone, steel), windows (their size, how many are lit and their warm glow) and rooftop detail come from a hash of its path, so a file always looks the same and neighbours are easy to tell apart. Size still means what it did: footprint is lines of code (each building keeps a margin of its own inside its lot), height is complexity (times the Height boost). The code on a roof (C-14) is a short name for the file; say \u201clook at C-14\u201d. A rooftop antenna or tank disappears under a topper, so toppers stay the loudest thing on the map.')),
      h('h3', null, 'ALERTS (flag icon, top right)'),
      h('ul', null, h('li', null, 'Places where Jira and the PRs disagree: ticket Done but PR open, ticket To Do but PR up, ticket in review with no PR, PR with no ticket, unknown ticket key.'))));
}

/* ---------- hover / pick ---------- */
function hideTip() { $('tip').hidden = true; }
function onHover(hit, x, y) {
  const tip = $('tip'); if (!hit) { tip.hidden = true; return; }
  const s = state.snap; tip.hidden = false;
  if (hit.type === 'spire') {
    const pr = s.prs.find((p) => p.id === hit.prId);
    fill(tip, h('b', null, pr?.ticketKey || hit.prId), ' ', pr?.title || '', h('br'), hit.path.split('/').pop(),
      hit.kind === 'add' ? h('span', { class: 'a' }, `  +${hit.n} added`) : hit.kind === 'del' ? h('span', { class: 'd' }, `  −${hit.n} deleted`) : '');
  } else {
    const l = state.scene.layout().byPath.get(hit.path), bi = state.scene.buildingInfo(hit.path), touching = s.prs.filter((p) => p.files.some((f) => f.path === hit.path));
    fill(tip, h('b', null, hit.path), h('br'), `${l.loc} LOC · complexity ${l.complexity}`, bi && state.bstyle.codes ? [h('br'), `${bi.code}${bi.shape !== 'block' ? ' · ' + bi.shape : ''}`] : '', touching.length ? [h('br'), `${touching.length} open PR${touching.length > 1 ? 's' : ''}: ${touching.map((p) => p.ticketKey || p.id).join(', ')}`] : '');
  }
  tip.style.left = Math.min(innerWidth - 310, x + 14) + 'px'; tip.style.top = Math.min(innerHeight - 90, y + 14) + 'px';
}
function onPickFile(path) {
  showFileBar(path);
  const prs = state.snap.prs.filter((p) => p.files.some((f) => f.path === path));
  if (prs.length === 1) selectPR(prs[0].id, false); else if (prs.length > 1) toast(`${path.split('/').pop()}: ${prs.map((p) => p.ticketKey || p.id).join(', ')}. Tap a crane or topper to focus one.`);
}

/* ---------- toast ---------- */
let toastT;
function toast(msg) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 3800); }

/* ---------- settings ---------- */
const modal = $('modal'), sheet = $('msheet');
const closeModal = () => { modal.hidden = true; state.trackRefresh = null; };
modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

async function openSettings(section = 'jira') {
  state.cfg = await api.get('/api/config');
  modal.hidden = false; renderSettings(section);
}
function renderSettings(section) {
  const nav = (id, label, disabled) => h('button', { 'aria-current': section === id ? 'page' : null, disabled, onclick: () => renderSettings(id) }, label);
  const panes = { jira: jiraPane, display: displayPane, data: dataPane };
  const pane = h('div', { class: 'mpane' });
  const foot = h('div', { class: 'foot' });
  (panes[section] || jiraPane)(pane, foot);
  fill(sheet,
    h('div', { class: 'mhead' }, h('h2', null, 'SETTINGS'), h('button', { class: 'btn', onclick: closeModal }, 'CLOSE')),
    h('div', { class: 'mbody' }, h('nav', { class: 'mnav' }, nav('jira', 'JIRA'), nav('display', 'DISPLAY'), nav('data', 'DATA SOURCES'), nav('teams', 'TEAMS (SOON)', true)), pane),
    foot);
}
const fld = (label, input, hint) => h('div', { class: 'fld' }, h('label', null, label), input, hint ? h('small', null, hint) : null);

function jiraPane(pane, foot) {
  const c = state.cfg.jira, lock = state.cfg.envLocked || {};
  const cloud = () => dep.value === 'cloud';
  const dep = h('select', { id: 'f-dep', disabled: lock.deployment, onchange: sync }, h('option', { value: 'server', selected: c.deployment === 'server' }, 'Data Center / Server (personal access token)'), h('option', { value: 'cloud', selected: c.deployment === 'cloud' }, 'Cloud (email + API token)'));
  const url = h('input', { id: 'f-url', type: 'url', value: c.baseUrl, placeholder: 'https://jira.yourcompany.com', disabled: lock.baseUrl });
  const email = h('input', { id: 'f-email', type: 'email', value: c.email, placeholder: 'you@yourcompany.com', disabled: lock.email });
  const token = h('input', { id: 'f-token', type: 'password', autocomplete: 'off', placeholder: c.tokenSet ? 'Saved. Leave blank to keep it' : 'Paste token', disabled: lock.token });
  const keys = h('input', { id: 'f-keys', value: c.projectKeys.join(', '), placeholder: 'ENG, PLAT' });
  const boardSel = h('select', { id: 'f-board' }, h('option', { value: '' }, 'No board (use project query)'), c.boardId ? h('option', { value: c.boardId, selected: true }, `Board #${c.boardId}`) : null);
  const jql = h('textarea', { id: 'f-jql', rows: 2, placeholder: 'Optional. Overrides the board and project query' }); jql.value = c.jql;
  const epic = h('input', { id: 'f-epic', value: c.epicLinkField }), pts = h('input', { id: 'f-pts', value: c.storyPointsField }), spr = h('input', { id: 'f-spr', value: c.sprintField });
  const pat = h('input', { id: 'f-pat', value: c.keyPattern }), poll = h('input', { id: 'f-poll', type: 'number', min: 15, max: 3600, value: c.pollSeconds });
  const out = h('div');
  const emailBox = fld('Account email', email, 'Cloud only. The email you sign in to Atlassian with.');
  function sync() { emailBox.hidden = !cloud(); token.parentElement.querySelector('label').textContent = cloud() ? 'API token' : 'Personal access token'; }
  const collect = (withToken = true) => ({ deployment: dep.value, baseUrl: url.value, email: email.value, ...(withToken && token.value ? { token: token.value } : {}), projectKeys: keys.value, boardId: boardSel.value, jql: jql.value, epicLinkField: epic.value, storyPointsField: pts.value, sprintField: spr.value, keyPattern: pat.value, pollSeconds: Number(poll.value) });
  const show = (cls, ...kids) => out.replaceChildren(h('div', { class: `res ${cls}` }, ...kids));
  const busy = async (btn, fn) => { btn.disabled = true; try { await fn(); } finally { btn.disabled = false; } };

  const test = h('button', { class: 'btn', id: 'b-test', onclick: (e) => busy(e.target, async () => {
    show('', 'Testing…');
    const r = await api.send('POST', '/api/jira/test', collect());
    if (!r.ok) return show('bad', h('b', null, r.error), r.hint ? h('span', { class: 'hint' }, r.hint) : null);
    show(r.warning ? 'warn' : 'ok', h('b', null, `Signed in as ${r.user}`), ` · ${r.deployment || ''} ${r.version || ''} · ${r.latencyMs ?? '?'}ms`, r.sprint ? h('span', { class: 'hint' }, `Active sprint: ${r.sprint.name}`) : null, r.warning ? h('span', { class: 'hint' }, `${r.warning}${r.hint ? ' ' + r.hint : ''}`) : null);
  }) }, 'TEST CONNECTION');
  const boards = h('button', { class: 'btn', id: 'b-boards', onclick: (e) => busy(e.target, async () => {
    const r = await api.send('POST', '/api/jira/boards', collect());
    if (!r.ok) return show('bad', h('b', null, r.error), r.hint ? h('span', { class: 'hint' }, r.hint) : null);
    const cur = boardSel.value;
    boardSel.replaceChildren(h('option', { value: '' }, 'No board (use project query)'), ...r.boards.map((b) => h('option', { value: String(b.id), selected: String(b.id) === cur }, `${b.name} (#${b.id}, ${b.type})`)));
    show('ok', `${r.boards.length} boards found`);
  }) }, 'LOAD BOARDS');
  const detect = h('button', { class: 'btn', id: 'b-detect', onclick: (e) => busy(e.target, async () => {
    const r = await api.send('POST', '/api/jira/detect-fields', collect());
    if (!r.ok) return show('bad', h('b', null, r.error), r.hint ? h('span', { class: 'hint' }, r.hint) : null);
    if (r.epicLinkField) epic.value = r.epicLinkField; if (r.storyPointsField) pts.value = r.storyPointsField; if (r.sprintField) spr.value = r.sprintField;
    show('ok', 'Field ids filled in', h('span', { class: 'hint' }, `Epic Link ${r.epicLinkField || 'not found'} · Story Points ${r.storyPointsField || 'not found'} · Sprint ${r.sprintField || 'not found'}`));
  }) }, 'DETECT FIELDS');

  fill(pane,
    state.cfg.mock ? h('div', { class: 'res warn' }, 'Mock Jira is active. Edits apply to this session only and are not written to disk.') : null,
    h('h3', null, 'CONNECTION'), fld('Jira type', dep), fld('Base URL', url, 'Include any context path, for example https://host/jira. No trailing slash needed.'), emailBox,
    fld(cloud() ? 'API token' : 'Personal access token', token, c.tokenSet ? 'A token is stored on this machine. It is never sent to the browser.' : 'Stored on this machine in a file only you can read. Create one in Jira under Profile > Personal Access Tokens.'),
    Object.values(lock).some(Boolean) ? h('small', { class: 'sub' }, 'Fields set by BATTLEMAP_JIRA_* environment variables are locked.') : null,
    h('div', { class: 'act' }, test), out,
    h('h3', null, 'WHICH TICKETS'), fld('Project keys', keys, 'Comma separated. Used when no board or JQL is set.'),
    fld('Board', boardSel, 'With a board, tickets come from its active sprint.'), h('div', { class: 'act' }, boards),
    fld('JQL override', jql, 'Beats board and project keys when set.'),
    h('h3', null, 'FIELDS'), h('div', { class: 'two' }, fld('Epic Link field', epic), fld('Story Points field', pts)), fld('Sprint field', spr), h('div', { class: 'act' }, detect),
    h('h3', null, 'LINKING'), fld('Ticket key pattern', pat, 'Regex matched against PR titles and branch names.'), fld('Refresh every (seconds)', poll));
  sync();
  const msg = h('span', { class: 'msg' });
  const save = h('button', { class: 'btn primary', id: 'b-save', onclick: (e) => busy(e.target, async () => {
    const r = await api.send('PUT', '/api/config/jira', collect());
    if (!r.ok) { msg.textContent = ''; return show('bad', h('b', null, 'Not saved'), h('span', { class: 'hint' }, (r.errors || [r.error]).join('. '))); }
    state.cfg = r.config; token.value = ''; msg.textContent = r.persisted ? `Saved to ${r.config.configFile}` : 'Applied for this session';
    toast('Jira settings applied'); setTimeout(refresh, 600);
  }) }, 'SAVE');
  foot.append(msg, h('button', { class: 'btn', onclick: closeModal }, 'CLOSE'), save);
}

function displayPane(pane) {
  const sel = h('select', { id: 'd-scale', onchange: (e) => { state.scale = e.target.value; ls.set('scale', state.scale); applyScene(); renderLayers(); } }, Object.entries(SCALES).map(([k, v]) => h('option', { value: k, selected: k === state.scale }, v.label)));
  const fog = h('input', { id: 'd-fog', type: 'checkbox', checked: state.fog, onchange: (e) => { state.fog = e.target.checked; ls.set('fog', state.fog); applyScene(); renderLayers(); } });
  const me = h('input', { id: 'd-me', value: (state.cfg.identity?.prAuthors || []).join(', ') });
  fill(pane, h('h3', null, 'SPIRES'), fld('Height scale', sel, 'Every spire on the map uses the same scale. Square root keeps small diffs visible next to huge ones; linear is honest but makes tiny diffs invisible.'),
    h('div', { class: 'fld' }, h('label', null, 'Fog of war'), h('label', null, fog, ' Dim files nobody is working on')),
    h('h3', null, 'IDENTITY'), fld('Your PR author handles', me, 'PRs by these authors are "mine". Comma separated.'),
    h('div', { class: 'act' }, h('button', { class: 'btn', id: 'd-save', onclick: async () => { const r = await api.send('PUT', '/api/config/identity', { prAuthors: me.value }); toast(r.ok ? 'Saved' : 'Could not save'); refresh(); } }, 'SAVE IDENTITY')));
}

function dataPane(pane) {
  const s = state.snap;
  const sample = JSON.stringify({ prs: [{ id: '#123', title: 'ENG-412 Fix proration', branch: 'maya/ENG-412-proration', author: 'maya', status: 'review_requested', url: 'https://github.com/org/repo/pull/123', files: [{ path: 'src/pricing.ts', add: 42, del: 7, hunks: [{ add: 30, del: 2 }, { add: 12, del: 5 }] }] }] }, null, 2);
  fill(pane, h('h3', null, 'CURRENT SOURCE'), h('p', null, s.sampleMode ? 'Built-in sample repo and PRs.' : `${s.files.length} files, ${s.prs.length} PRs.`),
    h('h3', null, 'FEED PRS'), h('p', null, 'Point your existing integration at either of these. status is one of review_requested, re_review, changes_requested, ci_failing, ready_to_merge, draft, merged, closed. hunks are optional; without them focus mode estimates them. Send every open PR: the map only draws the ones you track, and a tracked PR that disappears from the feed is kept as closed until you dismiss it.'),
    h('pre', { class: 'code' }, 'battlemap --prs prs.json            # reloads when the file changes\ncurl -X POST localhost:4747/api/prs \\\n  -H "X-Battlemap: 1" -H "Content-Type: application/json" -d @prs.json'),
    h('pre', { class: 'code' }, sample),
    h('h3', null, 'MAP A REAL REPO'), h('pre', { class: 'code' }, 'battlemap --repo ~/code/my-project'),
    s.problems?.length ? [h('h3', null, 'LAST INGEST PROBLEMS'), h('pre', { class: 'code' }, s.problems.join('\n'))] : null);
}

/* ---------- filter and sort panel ---------- */
function toggleFilters(force) {
  const box = $('filters'), open = force ?? box.hidden;
  box.hidden = !open; if (open) { toggleLayers(false); buildFilters(); } else state.filterRefresh = null;
  $('filterBtn')?.setAttribute('aria-expanded', String(open));
}
/** Built once per opening, so typing in the search box is never interrupted by a re-render. */
function buildFilters() {
  const q = h('input', { id: 'f-q', type: 'search', placeholder: 'Search title, author, ticket, branch', 'aria-label': 'Search', value: state.filters.q, oninput: (e) => setFilters({ q: e.target.value }) });
  const sort = h('select', { id: 'f-sort', 'aria-label': 'Sort by', onchange: (e) => setFilters({ sort: e.target.value }) }, Object.entries(SORTS).map(([k, v]) => h('option', { value: k }, v)));
  const age = (id, label, key) => h('select', { id, 'aria-label': label, onchange: (e) => setFilters({ [key]: Number(e.target.value) }) }, AGE_STEPS.map(([d, t]) => h('option', { value: d }, t)));
  const open = age('f-open', 'Open for at least', 'openDays'), quiet = age('f-quiet', 'Quiet for at least', 'quietDays');
  const sortHelp = h('small', { class: 'sub', id: 'f-sort-help' });
  const authors = h('div', { class: 'fchips' }), statuses = h('div', { class: 'fchips' }), summary = h('small', { class: 'sub' });
  const toggleIn = (key, v) => () => { const cur = state.filters[key]; setFilters({ [key]: cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v] }); };
  state.filterRefresh = () => {
    const s = state.snap, f = state.filters, liveP = s.prs.filter((p) => !p.ended);
    sort.value = f.sort; sortHelp.textContent = SORT_HELP[f.sort]; open.value = String(f.openDays); quiet.value = String(f.quietDays);
    const count = (get) => { const m = new Map(); for (const p of liveP) m.set(get(p), (m.get(get(p)) || 0) + 1); return m; };
    const byAuthor = count((p) => p.author);
    for (const a of f.authors) if (!byAuthor.has(a)) byAuthor.set(a, 0);       // a chosen author with no PRs right now can still be un-chosen
    fill(authors, [...byAuthor].sort((a, b) => a[0].localeCompare(b[0])).map(([a, n]) => h('button', { class: 'chip', 'aria-pressed': String(f.authors.includes(a)), onclick: toggleIn('authors', a) }, `@${a} ${n}`)));
    const byStatus = count((p) => p.status);
    fill(statuses, Object.entries(STATUS).filter(([, v]) => !v.ended).map(([k, v]) => h('button', { class: 'chip', style: `--st:${v.color}`, 'aria-pressed': String(f.statuses.includes(k)), onclick: toggleIn('statuses', k) }, `${v.label} ${byStatus.get(k) || 0}`)));
    summary.textContent = `Showing ${visiblePRs().length} of ${s.prs.length}${anyFilter(f) ? '' : ' (no filters on)'}`;
  };
  fill($('filters'),
    h('div', { class: 'fhead' }, h('h3', null, 'FILTER & SORT'), h('button', { class: 'btn', id: 'f-clear', onclick: clearFilters }, 'CLEAR')),
    q,
    h('div', { class: 'lyr' }, h('h3', null, 'SORT'), sort, sortHelp),
    h('div', { class: 'lyr' }, h('h3', null, 'AUTHORS'), authors),
    h('div', { class: 'lyr' }, h('h3', null, 'STATUS'), statuses),
    h('div', { class: 'lyr' }, h('h3', null, 'AGE'), h('div', { class: 'two' }, h('div', { class: 'fld' }, h('label', null, 'Open for at least'), open), h('div', { class: 'fld' }, h('label', null, 'Quiet for at least'), quiet)),
      h('small', { class: 'sub' }, 'Open is time since the PR was created; quiet is time since its last update. A PR with no date never matches an age filter.')),
    summary);
  state.filterRefresh();
}

/* ---------- tracking: which PRs from the feed get a place on the map ---------- */
const ago = (iso) => {
  const t = Date.parse(iso || ''); if (!t) return 'unknown';
  const m = Math.max(0, Math.round((Date.now() - t) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};
const WHY = { mine: () => 'It is yours, so it is always tracked.', pick: () => 'You are tracking it.', all: () => 'Tracking everything in the feed.', author: (b) => `Author rule: everything by @${b.value}.`, path: (b) => `Path rule ${b.value} (touches ${b.file.split('/').pop()}).` };
async function watchCall(method, path, body) {
  const r = await api.send(method, path, body);
  if (!r.ok) toast(r.error || 'Could not update tracking');
  await refresh();
  return r;
}
async function dismissPR(pr) { if (state.sel === pr.id) selectPR(null); await watchCall('POST', '/api/watch/dismiss', { id: pr.id }); }

function trackingBlock(pr) {
  if (pr.ended) return h('div', { class: 'blk' }, h('h3', null, 'TRACKING'),
    h('p', { class: 'sub' }, pr.endedInferred ? 'This PR left the feed, so it was merged or closed. It stays here until you dismiss it.' : `This PR is ${pr.status}. It stays here until you dismiss it.`),
    h('div', { class: 'act' }, h('button', { class: 'btn', id: 'dismissBtn', onclick: () => dismissPR(pr) }, 'DISMISS')));
  const by = pr.tracked?.by || [], onlyMine = by.length > 0 && by.every((b) => b.kind === 'mine');
  return h('div', { class: 'blk' }, h('h3', null, 'TRACKING'),
    by.map((b) => h('p', { class: 'sub' }, WHY[b.kind](b))),
    onlyMine ? null : h('div', { class: 'act' }, h('button', { class: 'btn', id: 'untrackBtn', onclick: async () => { selectPR(null); await watchCall('POST', '/api/watch/unpick', { id: pr.id }); toast(`Stopped tracking ${pr.id}`); } }, 'STOP TRACKING')));
}

function openTrack() {
  modal.hidden = false;
  const f = { q: '', author: '' };
  const authorList = h('datalist', { id: 't-authors' });
  const link = h('input', { id: 't-link', placeholder: 'Paste a pull request link or number', onkeydown: (e) => { if (e.key === 'Enter') linkGo.click(); } });
  const linkGo = h('button', { class: 'btn primary', id: 't-link-go', onclick: async () => {
    const r = await watchCall('POST', '/api/watch/pick', { ref: link.value });
    if (r.ok) { link.value = ''; toast(r.matched ? `Tracking ${r.matched}` : `Waiting for PR ${r.key} to appear in the feed`); }
  } }, 'TRACK');
  const authIn = h('input', { id: 't-author', list: 't-authors', placeholder: 'Author handle, for example maya', onkeydown: (e) => { if (e.key === 'Enter') authGo.click(); } });
  const authGo = h('button', { class: 'btn', id: 't-author-go', onclick: async () => { const r = await watchCall('POST', '/api/watch/rule', { type: 'author', value: authIn.value }); if (r.ok) authIn.value = ''; } }, 'ADD RULE');
  const pathIn = h('input', { id: 't-path', placeholder: 'File, folder or glob: packages/billing/**', onkeydown: (e) => { if (e.key === 'Enter') pathGo.click(); } });
  const pathGo = h('button', { class: 'btn', id: 't-path-go', onclick: async () => { const r = await watchCall('POST', '/api/watch/rule', { type: 'path', value: pathIn.value }); if (r.ok) pathIn.value = ''; } }, 'ADD RULE');
  const q = h('input', { id: 't-q', type: 'search', placeholder: 'Filter by title, number or author', oninput: (e) => { f.q = e.target.value.toLowerCase(); renderLists(); } });
  const sel = h('select', { id: 't-sel', 'aria-label': 'Author', onchange: (e) => { f.author = e.target.value; renderLists(); } });
  const modeBox = h('div'), rulesBox = h('div'), listBox = h('div');

  function renderLists() {
    const s = state.snap, w = s.watch;
    fill(modeBox, seg([['picked', 'Only what I track'], ['all', 'Everything in the feed']], w.mode, (v) => watchCall('PUT', '/api/watch/mode', { mode: v }), 'What to show'),
      h('small', { class: 'sub' }, `${w.trackedCount} tracked of ${w.feedCount} open in the feed. Your own PRs are always tracked.`));
    fill(authorList, w.authors.map((a) => h('option', { value: a })));
    const rows = [...w.rules.map((r) => h('div', { class: 'rrow' }, h('span', { class: 'rk' }, r.type === 'author' ? 'AUTHOR' : 'PATH'), h('b', null, r.type === 'author' ? '@' + r.value : r.value),
      h('span', { class: 'sub' }, `${r.matches} open${r.files != null ? ` · ${r.files} file${r.files === 1 ? '' : 's'}` : ''}`), h('button', { class: 'btn', 'aria-label': `Remove rule ${r.value}`, onclick: () => watchCall('POST', '/api/watch/unrule', { type: r.type, value: r.value }) }, 'REMOVE'))),
      ...w.pendingPicks.map((k) => h('div', { class: 'rrow' }, h('span', { class: 'rk' }, 'WAITING'), h('b', null, `PR ${k}`), h('span', { class: 'sub' }, 'not in the feed yet'), h('button', { class: 'btn', onclick: () => watchCall('POST', '/api/watch/unpick', { id: k }) }, 'FORGET')))];
    fill(rulesBox, rows.length ? rows : h('p', { class: 'sub' }, 'No rules yet. A rule tracks every PR that matches, now and when new ones are opened.'));
    const authors = [...new Set(s.available.map((p) => p.author))].sort(), keep = f.author;
    fill(sel, h('option', { value: '' }, 'All authors'), authors.map((a) => h('option', { value: a, selected: a === keep }, a)));
    const hits = s.available.filter((p) => (!f.author || p.author === f.author) && (!f.q || `${p.id} ${p.title} ${p.author}`.toLowerCase().includes(f.q))), shown = hits.slice(0, 40);
    fill(listBox,
      shown.map((p) => h('div', { class: 'arow' },
        h('div', { class: 'ainfo' }, h('div', null, h('b', null, p.number != null ? `#${p.number}` : p.id), ' ', p.title), h('small', { class: 'sub' }, `@${p.author} · ${p.files} files · +${p.adds} −${p.dels} · ${p.updatedAt ? ago(p.updatedAt) : STATUS[p.status]?.label.toLowerCase()}`)),
        h('div', { class: 'act' }, h('button', { class: 'btn', onclick: () => watchCall('POST', '/api/watch/pick', { ref: p.id }) }, 'TRACK'),
          h('button', { class: 'btn', title: `Track everything @${p.author} opens`, onclick: () => watchCall('POST', '/api/watch/rule', { type: 'author', value: p.author }) }, `+ @${p.author}`)))),
      !shown.length ? h('p', { class: 'sub' }, s.available.length ? 'Nothing matches this filter.' : 'Every open PR in the feed is already tracked.') : null,
      hits.length > shown.length ? h('p', { class: 'sub' }, `Showing ${shown.length} of ${hits.length}. Narrow the filter to see the rest.`) : null,
      w.availableTotal > s.available.length ? h('p', { class: 'sub' }, `The feed has ${w.availableTotal} untracked PRs; the list holds the ${s.available.length} most recently updated.`) : null);
  }
  state.trackRefresh = renderLists;
  fill(sheet,
    h('div', { class: 'mhead' }, h('h2', null, 'TRACK PRS'), h('button', { class: 'btn', onclick: closeModal }, 'CLOSE')),
    h('div', { class: 'mpane' },
      modeBox,
      h('h3', null, 'BY LINK'), h('div', { class: 'act' }, link, linkGo),
      h('h3', null, 'RULES'), authorList,
      h('div', { class: 'act' }, authIn, authGo), h('div', { class: 'act' }, pathIn, pathGo),
      h('small', { class: 'sub' }, 'Path rules match any file a PR touches. A plain path covers that file or folder; * stays in one folder, ** crosses folders. You can also click a file on the map.'),
      rulesBox,
      h('h3', null, 'OPEN IN THE FEED, MOST RECENTLY UPDATED FIRST'), h('div', { class: 'act' }, q, sel), listBox));
  renderLists();
}

function showFileBar(path) {
  const bar = $('filebar'), w = state.snap.watch, dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : null;
  const rule = (v) => w.rules.some((r) => r.type === 'path' && r.value === v);
  const toggleRule = (v) => async () => { await watchCall('POST', rule(v) ? '/api/watch/unrule' : '/api/watch/rule', { type: 'path', value: v }); showFileBar(path); };
  const bi = state.scene?.buildingInfo(path);
  fill(bar, h('b', null, path), bi && state.bstyle.codes ? h('span', { class: 'bcode', title: 'Index code: a short name for this file' }, bi.code) : null,
    h('button', { class: 'btn', id: 'fb-file', onclick: toggleRule(path) }, rule(path) ? 'STOP WATCHING FILE' : 'WATCH FILE'),
    dir ? h('button', { class: 'btn', id: 'fb-dir', onclick: toggleRule(dir) }, rule(dir) ? 'STOP WATCHING FOLDER' : 'WATCH FOLDER') : null,
    h('button', { class: 'btn', 'aria-label': 'Close', onclick: () => { bar.hidden = true; } }, '✕'));
  bar.title = 'Any PR that touches a watched path is tracked automatically';
  bar.hidden = false;
}

/* ---------- wiring ---------- */
$('alertsBtn').onclick = () => { const a = $('alerts'); a.hidden = !a.hidden; renderAlerts(); };
$('jiraPill').onclick = () => openSettings('jira');
$('layersBtn').onclick = (e) => { e.stopPropagation(); toggleLayers(); };
$('keyBtn').onclick = openKey;
$('homeBtn').onclick = () => { const p = state.sel; p ? state.scene?.flyToPR(p) : state.scene?.flyHome(); };
// "Click outside closes". The path is read from the event, not the target: clicking a chip re-renders the list, so by the time
// the click reaches here the clicked element has been detached and target.closest() would wrongly say it was outside.
const clickedIn = (e, ...ids) => e.composedPath().some((n) => ids.includes(n.id));
addEventListener('click', (e) => { if (!$('layers').hidden && !clickedIn(e, 'layers')) toggleLayers(false); if (!$('filters').hidden && !clickedIn(e, 'filters', 'filterBtn')) toggleFilters(false); });
$('settingsBtn').onclick = () => openSettings('jira');
addEventListener('keydown', (e) => {
  if (e.key === '/' && modal.hidden && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) { e.preventDefault(); toggleFilters(true); $('f-q')?.focus(); return; }
  if (e.key !== 'Escape') return;
  if (!$('filebar').hidden) $('filebar').hidden = true; else if (!$('filters').hidden) toggleFilters(false); else if (!$('layers').hidden) toggleLayers(false); else if (!modal.hidden) closeModal(); else if (!$('alerts').hidden) $('alerts').hidden = true; else if (state.sel) selectPR(null);
});
window.battlemap = { state, selectPR, refresh, openSettings, openTrack, showFileBar };   // handy in the console and in tests

await startScene();
await refresh();
connectEvents();
