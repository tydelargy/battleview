// `base.prefix` is empty for a single map, and "/r/<id>" when the hub is showing one of its cities: the same page and the same
// calls, pointed at that city's own app.
export const base = { prefix: '' };
export const url = (p) => base.prefix + p;
export const api = {
  get: (p) => fetch(url(p)).then((r) => r.json()),
  async send(method, p, body) {
    const r = await fetch(url(p), { method, headers: { 'Content-Type': 'application/json', 'X-Battlemap': '1' }, body: JSON.stringify(body || {}) });
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    return { httpStatus: r.status, ...j };
  },
};
