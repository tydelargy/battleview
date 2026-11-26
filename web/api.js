export const api = {
  get: (p) => fetch(p).then((r) => r.json()),
  async send(method, p, body) {
    const r = await fetch(p, { method, headers: { 'Content-Type': 'application/json', 'X-Battlemap': '1' }, body: JSON.stringify(body || {}) });
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    return { httpStatus: r.status, ...j };
  },
};
