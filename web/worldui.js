// The world view's page: the scene, the stats widget, the "+" on a free slot, the add-a-repo dialog and the polling.
// Everything that comes from outside (repo names, errors) is set as text, never as HTML.
import { createWorld } from './world.js';
import { biomeFor } from './biome.js';
import { hexKey } from './hex.js';

const get = (p) => fetch(p).then((r) => r.json());
const post = (p, body) => fetch(p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Battlemap': '1' }, body: JSON.stringify(body || {}) }).then((r) => r.json());
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

export function startWorld({ host, onEnter, toast = () => {} }) {
  const st = { world: null, cities: [], slots: [], files: new Map(), last: null, timer: null, plus: null, hover: null, confirm: null, adding: null, alive: true };
  const stage = el('div', 'world-stage'), widget = el('aside', 'wstats'), plus = el('button', 'wplus', '+');
  widget.id = 'wstats'; widget.setAttribute('aria-live', 'polite'); plus.id = 'wplus'; plus.hidden = true; plus.setAttribute('aria-label', 'Add a repository here');
  host.append(stage, widget, plus);

  const num = (v, loading) => (v == null ? (loading ? '…' : '–') : String(v));
  function renderWidget() {
    const c = st.cities.find((x) => x.id === (st.hover?.id || st.last)); widget.replaceChildren();
    if (!c) {
      widget.append(el('h2', null, 'ALL REPOS'), el('p', 'sub', st.cities.length ? 'Hover a city for its numbers, click it to go in, drag it to a free hex to move it. Hover a glowing hex and press + to add a repo.' : 'Hover the glowing hex and press + to add your first repo by its URL. Nothing is cloned: the map is built from GitHub.'));
      return;
    }
    const b = biomeFor(c.key), s = c.stats || {};
    widget.append(el('h2', null, c.key), el('p', 'sub', `${b.label} · ${c.files} files${c.branch ? ` · ${c.branch}` : ''} · sizes estimated`));
    const rows = el('div', 'wrows');
    for (const [id, label, v, hint] of [['tracking', 'Tracking', s.tracked, 'PRs tracked here (yours, picked and by rule). Opens when you go in.'], ['mine', 'Yours open', s.mine, 'Open PRs you wrote'], ['needs', 'Need action', s.needs, 'Reviews asked of you, and your own PRs with red CI, requested changes or ready to merge']]) {
      const r = el('div', 'wrow' + (id === 'needs' && s.needs ? ' hot' : '')); r.id = `ws-${id}`; r.title = hint; r.append(el('span', null, label), el('b', null, num(v, s.loading))); rows.append(r);
    }
    widget.append(rows);
    if (s.error) widget.append(el('p', 'sub err', `Could not read PRs: ${s.error}`));
    const act = el('div', 'wact'), go = el('button', 'btn', 'GO IN'); go.id = 'ws-go'; go.onclick = () => onEnter(c.id);
    const rm = el('button', 'btn', st.confirm === c.id ? 'SURE? FORGET IT' : 'FORGET'); rm.id = 'ws-forget';
    rm.onclick = async () => {
      if (st.confirm !== c.id) { st.confirm = c.id; renderWidget(); return; }
      st.confirm = null; const r = await post('/api/hub/remove', { id: c.id }); if (!r.ok) toast(r.error); st.last = null; await refresh();
    };
    act.append(go, rm); widget.append(act);
  }

  async function refresh() {
    if (!st.alive) return;
    let w; try { w = await get('/api/hub/world'); } catch { return; }
    st.cities = w.cities; st.slots = w.slots;
    await Promise.all(w.cities.filter((c) => !st.files.has(c.id)).map(async (c) => { try { const t = await get(`/api/hub/tree?id=${encodeURIComponent(c.id)}`); if (t.files) st.files.set(c.id, t.files); } catch { /* the plot stays empty */ } }));
    st.world.set(st.cities, st.slots, st.files); renderWidget();
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
      if (r.ok) { closeAdd(); toast(`Added ${r.city.key}${r.warnings?.length ? `. ${r.warnings[0]}` : ''}`); st.last = r.city.id; await refresh(); }
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
    onHover: (h) => { st.hover = h; if (h?.type === 'city') st.last = h.id; if (h?.id !== st.confirm) st.confirm = null; renderWidget(); },
    onFrame: ({ project, hover, toWorld }) => {
      const h = hover?.type === 'slot' && !st.adding ? hover.hex : null;
      plus.hidden = !h; if (h) { const w = toWorld(h), p = project(w.x, 2, w.z); plus.style.transform = `translate(${p.sx.toFixed(1)}px,${p.sy.toFixed(1)}px) translate(-50%,-50%)`; plus.dataset.hex = hexKey(h); }
    },
  });
  plus.onclick = () => { const k = plus.dataset.hex; const h = st.slots.find((s) => hexKey(s) === k); if (h) openAdd(h); };
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.adding) closeAdd(); });
  refresh();
  return { refresh, world: () => st.world, info: () => ({ ...st.world.info(), widget: widget.textContent }), dispose() { st.alive = false; clearTimeout(st.timer); closeAdd(); st.world.dispose(); host.replaceChildren(); } };
}
