// The world view's page: the scene, the stats widget, the "+" on a free slot, the add-a-repo dialog and the polling.
// Everything that comes from outside (repo names, errors) is set as text, never as HTML.
import { createWorld } from './world.js';
import { biomeFor } from './biome.js';
import { hexKey } from './hex.js';

const get = (p) => fetch(p).then((r) => r.json());
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Battlemap': '1' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function startWorld({ host, onEnter, toast = () => {} }) {
  const st = { world: null, cities: [], slots: [], files: new Map(), selected: null, hover: null, timer: null, confirm: null, adding: null, alive: true, sig: '' };
  const stage = el('div', 'world-stage'), plus = el('button', 'wplus', '+'), tray = el('div', 'wtray'), help = el('div', 'whelp', 'Click a city to go in · drag it to a free hex to move it · press + on a glowing hex to add a repo');
  tray.id = 'wtray'; tray.setAttribute('role', 'list'); tray.setAttribute('aria-label', 'Repositories'); plus.id = 'wplus'; plus.hidden = true; plus.setAttribute('aria-label', 'Add a repository here');
  host.append(stage, help, tray, plus);

  const num = (v, loading) => (v == null ? (loading ? '…' : '–') : String(v));
  const stat = (cls, label, v, loading, hint, hot) => { const d = el('div', `ws ${cls}${hot ? ' hot' : ''}`); d.title = hint; d.append(el('span', null, label), el('b', null, num(v, loading))); return d; };
  const HINTS = { tracking: 'PRs tracked here (yours, picked and by rule). Opens when you go in.', mine: 'Open PRs you wrote', needs: 'Reviews asked of you, and your own PRs with red CI, requested changes or ready to merge' };

  /** One card per repo, like the PR cards: the selected one expands in place, the rest stay compact so every repo is in reach. */
  function renderTray() {
    const keep = tray.scrollLeft; tray.replaceChildren();
    if (!st.cities.length) { const e = el('div', 'wcard wempty'); e.append(el('b', null, 'No repos yet'), el('span', null, 'Hover the glowing hex and press + to add your first repo by URL. Nothing is cloned: the map is built from GitHub.')); tray.append(e); return; }
    for (const c of st.cities) {
      const b = biomeFor(c.key), s = c.stats || {}, open = st.selected === c.id;
      const card = el('div', `wcard${open ? ' open' : ''}${st.hover === c.id ? ' hot' : ''}`); card.dataset.id = c.id; card.style.setProperty('--st', b.accent); card.setAttribute('role', 'listitem');
      const head = el('button', 'whead'); head.setAttribute('aria-pressed', String(open)); head.setAttribute('aria-label', `${c.key}: ${open ? 'collapse' : 'expand'}`);
      head.append(el('b', 'wname', c.key), s.needs ? el('i', 'wbadge', String(s.needs)) : el('i', 'wbadge zero', ''));
      head.onclick = () => { st.selected = open ? null : c.id; st.confirm = null; renderTray(); st.world.highlight(st.selected); };
      card.append(head, el('div', 'wmeta', `${b.label} · ${c.files} files${c.branch ? ` · ${c.branch}` : ''}`));
      const rows = el('div', 'wstats'); rows.append(stat('tracking', 'Tracking', s.tracked, s.loading, HINTS.tracking), stat('mine', 'Yours', s.mine, s.loading, HINTS.mine), stat('needs', 'Need action', s.needs, s.loading, HINTS.needs, s.needs));
      card.append(rows);
      if (open) {
        card.append(el('div', 'wmore', `${c.estimated ? 'File sizes are estimated from GitHub (nothing is cloned). ' : ''}${s.error ? `Could not read PRs: ${s.error}` : 'Click the city, or GO IN, to see its PRs and track some.'}`));
        const act = el('div', 'wact'), go = el('button', 'btn', 'GO IN'); go.id = 'ws-go'; go.onclick = () => onEnter(c.id);
        const rm = el('button', 'btn', st.confirm === c.id ? 'SURE? FORGET IT' : 'FORGET'); rm.id = 'ws-forget';
        rm.onclick = async () => { if (st.confirm !== c.id) { st.confirm = c.id; renderTray(); return; } st.confirm = null; const r = await post('/api/hub/remove', { id: c.id }); if (!r.ok) toast(r.error); st.selected = null; await refresh(); };
        act.append(go, rm); card.append(act);
      }
      tray.append(card);
    }
    tray.scrollLeft = keep;
  }
  const signature = () => JSON.stringify([st.cities.map((c) => [c.id, c.q, c.r, c.files, c.branch, c.estimated, c.stats]), st.selected, st.confirm, st.hover]);
  const rerender = () => { const sg = signature(); if (sg !== st.sig) { st.sig = sg; renderTray(); } };

  async function refresh() {
    if (!st.alive) return;
    let w; try { w = await get('/api/hub/world'); } catch { return; }
    st.cities = w.cities; st.slots = w.slots; if (st.selected && !st.cities.some((c) => c.id === st.selected)) st.selected = null;
    await Promise.all(w.cities.filter((c) => !st.files.has(c.id)).map(async (c) => { try { const t = await get(`/api/hub/tree?id=${encodeURIComponent(c.id)}&limit=600`); if (t.files) st.files.set(c.id, t.files); } catch { /* the plot stays empty */ } }));
    st.world.set(st.cities, st.slots, st.files); st.sig = ''; rerender();
    clearTimeout(st.timer); st.timer = setTimeout(refresh, st.cities.some((c) => c.stats.loading) ? 2500 : 20000);
  }

  // ---- add a repo ----
  function openAdd(hex) {
    closeAdd();
    const box = el('div', 'wadd'); box.id = 'wadd'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Add a repository');
    const input = el('input'); input.id = 'wadd-url'; input.placeholder = 'https://github.com/org/repo  or  org/repo'; input.setAttribute('aria-label', 'Repository URL'); input.autocomplete = 'off';
    const msg = el('p', 'sub'), go = el('button', 'btn', 'ADD'), cancel = el('button', 'btn', 'CANCEL'); go.id = 'wadd-go'; msg.id = 'wadd-msg'; cancel.id = 'wadd-cancel';
    const run = async () => {
      if (!input.value.trim()) return; go.disabled = true; msg.className = 'sub'; msg.textContent = 'Reading the repo from GitHub… (nothing is cloned)';
      const r = await post('/api/hub/add', { url: input.value, q: hex.q, r: hex.r });
      if (r.ok) { closeAdd(); toast(`Added ${r.city.key}${r.warnings?.length ? `. ${r.warnings[0]}` : ''}`); st.selected = r.city.id; await refresh(); }
      else { msg.className = 'sub err'; msg.textContent = r.error || 'Could not add that repo'; go.disabled = false; }
    };
    go.onclick = run; cancel.onclick = closeAdd; input.onkeydown = (e) => { if (e.key === 'Enter') run(); else if (e.key === 'Escape') closeAdd(); };
    box.append(el('h2', null, 'ADD A REPO'), el('p', 'sub', 'A city will grow on this hex. It is built from the repo\'s file list on GitHub; no clone, no checkout. PRs are only read once you go in.'), input, msg, el('div', 'wact'));
    box.lastChild.append(go, cancel); host.append(box); st.adding = box; input.focus();
  }
  function closeAdd() { st.adding?.remove(); st.adding = null; }

  st.world = createWorld(stage, {
    onEnter, onAdd: openAdd,
    onMove: async (id, hex) => { const r = await post('/api/hub/move', { id, q: hex.q, r: hex.r }); if (!r.ok) toast(r.error); await refresh(); },
    onHover: (h) => {                                         // pointing at a city lights up its card and brings it into view; it never moves the cards
      st.hover = h?.type === 'city' ? h.id : null; rerender();
      if (st.hover) tray.querySelector(`.wcard[data-id="${CSS.escape(st.hover)}"]`)?.scrollIntoView({ inline: 'nearest', block: 'nearest', behavior: 'smooth' });
    },
    onFrame: ({ project, hover, toWorld }) => {
      const h = hover?.type === 'slot' && !st.adding ? hover.hex : null;
      plus.hidden = !h; if (h) { const w = toWorld(h), p = project(w.x, 2, w.z); plus.style.transform = `translate(${p.sx.toFixed(1)}px,${p.sy.toFixed(1)}px) translate(-50%,-50%)`; plus.dataset.hex = hexKey(h); }
    },
  });
  plus.onclick = () => { const k = plus.dataset.hex; const h = st.slots.find((s) => hexKey(s) === k); if (h) openAdd(h); };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.adding) closeAdd(); });
  refresh();
  return { refresh, world: () => st.world, info: () => ({ ...st.world.info(), cards: tray.querySelectorAll('.wcard[data-id]').length, selected: st.selected }), dispose() { st.alive = false; clearTimeout(st.timer); closeAdd(); st.world.dispose(); host.replaceChildren(); } };
}
