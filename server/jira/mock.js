// A believable Jira you can point Battle Map at without a Jira. Implements the
// subset of REST the client uses, enforces auth, paginates, and can misbehave.
import http from 'node:http';

const STATUSES = [
  { id: '10000', name: 'To Do', cat: 'new' },
  { id: '10001', name: 'In Progress', cat: 'indeterminate' },
  { id: '10002', name: 'In Review', cat: 'indeterminate' },
  { id: '10003', name: 'Done', cat: 'done' },
];
const USERS = {
  me: { accountId: 'u-me', name: 'jlee', displayName: 'Jordan Lee', emailAddress: 'me@example.com' },
  maya: { accountId: 'u-maya', name: 'maya', displayName: 'Maya Okafor', emailAddress: 'maya@example.com' },
  devon: { accountId: 'u-devon', name: 'devon', displayName: 'Devon Park', emailAddress: 'devon@example.com' },
  ines: { accountId: 'u-ines', name: 'ines', displayName: 'Ines Duarte', emailAddress: 'ines@example.com' },
  kofi: { accountId: 'u-kofi', name: 'kofi', displayName: 'Kofi Mensah', emailAddress: 'kofi@example.com' },
  agent: { accountId: 'u-agent', name: 'agent', displayName: 'Claude Agent', emailAddress: 'agent@example.com' },
};
const F = { epicLink: 'customfield_10014', points: 'customfield_10016', sprint: 'customfield_10020' };

// Tickets are chosen so that, next to the sample PRs, several disagree on purpose.
function seed(flavor) {
  const issues = new Map();
  const comments = new Map();
  const epicDefs = [['ENG-300', 'Billing v2'], ['ENG-301', 'Auth hardening'], ['ENG-302', 'Infra cutover'], ['ENG-303', 'Web onboarding']];
  const mk = (key, summary, status, user, points, epic, type = 'Story', priority = 'Medium', labels = []) =>
    issues.set(key, { key, id: String(10000 + issues.size), summary, status, user, points, epic, type, priority, labels, updated: new Date(Date.now() - issues.size * 3.6e6).toISOString() });
  for (const [k, n] of epicDefs) mk(k, n, 'In Progress', 'me', null, null, 'Epic', 'High');
  mk('ENG-412', 'Rewrite proration engine for mid-cycle plan changes', 'In Progress', 'maya', 8, 'ENG-300', 'Story', 'High');
  mk('ENG-418', 'Invoice model and migration', 'In Review', 'devon', 5, 'ENG-300');
  mk('ENG-431', 'Billing page redesign', 'In Progress', 'me', 5, 'ENG-300');
  mk('ENG-481', 'Fix tax rounding on multi-line invoices', 'To Do', 'agent', 2, 'ENG-300', 'Bug', 'High');
  mk('ENG-433', 'Export invoices to CSV', 'In Progress', 'me', 3, 'ENG-300');
  mk('ENG-377', 'Rate limit login attempts', 'In Review', 'ines', 3, 'ENG-301', 'Story', 'High');
  mk('ENG-380', 'Rotate sessions on privilege change', 'In Review', 'me', 3, 'ENG-301');
  mk('ENG-390', 'SDK silent token refresh', 'In Progress', 'agent', 5, 'ENG-301');
  mk('ENG-440', 'Audit log for admin actions', 'In Review', 'devon', 5, 'ENG-301');
  mk('ENG-455', 'Move API to ECS Fargate', 'In Review', 'kofi', 8, 'ENG-302', 'Story', 'Highest');
  mk('ENG-460', 'CDN cache rules', 'To Do', 'kofi', 2, 'ENG-302');
  mk('ENG-470', 'Onboarding checklist', 'In Progress', 'ines', 5, 'ENG-303');
  mk('ENG-472', 'Webhooks guide', 'Done', 'maya', 2, 'ENG-303', 'Task');
  mk('ENG-445', 'Spike: usage-based billing', 'To Do', null, 3, 'ENG-300', 'Spike');
  return { issues, comments, flavor, sprint: { id: 42, name: 'Sprint 42', state: 'active', startDate: new Date(Date.now() - 6 * 864e5).toISOString(), endDate: new Date(Date.now() + 8 * 864e5).toISOString() } };
}

const statusByName = (n) => STATUSES.find((s) => s.name === n);

function toRaw(st, i, base) {
  const s = statusByName(i.status);
  const isEpic = i.type === 'Epic';
  const epic = i.epic ? st.issues.get(i.epic) : null;
  const fields = {
    summary: i.summary,
    status: { id: s.id, name: s.name, statusCategory: { key: s.cat } },
    assignee: i.user ? USERS[i.user] : null,
    priority: { name: i.priority },
    issuetype: { name: i.type },
    labels: i.labels,
    updated: i.updated,
    [F.points]: i.points,
    [F.sprint]: isEpic ? null : [{ id: st.sprint.id, name: st.sprint.name, state: st.sprint.state }],
  };
  if (epic) {
    if (st.flavor === 'cloud') fields.parent = { key: epic.key, fields: { summary: epic.summary, issuetype: { name: 'Epic' } } };
    else fields[F.epicLink] = epic.key;
  }
  return { id: i.id, key: i.key, self: `${base}/rest/api/2/issue/${i.id}`, fields };
}

/** Very small JQL subset. Unknown clauses are ignored, which keeps tests forgiving. */
export function filterByJql(st, jql, currentUser = 'me') {
  const body = (jql || '').replace(/\border\s+by\b[\s\S]*$/i, '').trim();
  let list = [...st.issues.values()];
  if (!body) return list;
  for (const clause of body.split(/\s+and\s+/i)) {
    let m;
    if ((m = clause.match(/^project\s*(?:=|in)\s*\(?\s*([A-Za-z0-9_,\s"]+?)\s*\)?$/i))) {
      const keys = m[1].replace(/"/g, '').split(/[\s,]+/).filter(Boolean).map((s) => s.toUpperCase());
      list = list.filter((i) => keys.some((k) => i.key.startsWith(k + '-')));
    } else if ((m = clause.match(/^key\s+in\s*\(([^)]*)\)$/i))) {
      const keys = m[1].split(',').map((s) => s.trim().replace(/"/g, ''));
      list = list.filter((i) => keys.includes(i.key));
    } else if ((m = clause.match(/^statusCategory\s*(!=|=)\s*"?([\w ]+?)"?$/i))) {
      const want = m[2].toLowerCase(); const neg = m[1] === '!=';
      const catName = { done: 'done', 'to do': 'new', 'in progress': 'indeterminate' }[want];
      list = list.filter((i) => (statusByName(i.status).cat === catName) !== neg);
    } else if ((m = clause.match(/^status\s*(!=|=)\s*"?([\w ]+?)"?$/i))) {
      const neg = m[1] === '!=';
      list = list.filter((i) => (i.status.toLowerCase() === m[2].toLowerCase()) !== neg);
    } else if (/^assignee\s*=\s*currentUser\(\)$/i.test(clause)) {
      list = list.filter((i) => i.user === currentUser);
    } else if ((m = clause.match(/^(?:parent|"Epic Link")\s*=\s*"?([A-Z0-9-]+)"?$/i))) {
      list = list.filter((i) => i.epic === m[1].toUpperCase());
    }
    // sprint in openSprints() and anything else: accepted, not filtered.
  }
  return list;
}

export function createMockJira({ flavor = 'server', token = 'mock-token', email = 'me@example.com', pageCap = 100, latencyMs = 0 } = {}) {
  let st = seed(flavor);
  let chaos = 'off';
  let base = '';

  const send = (res, status, obj, headers = {}) => {
    const body = obj === undefined ? '' : JSON.stringify(obj);
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
  const authed = (req) => {
    const h = req.headers.authorization || '';
    if (st.flavor === 'cloud') return h === 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    return h === 'Bearer ' + token;
  };
  const page = (list, startAt, max) => ({ startAt, maxResults: Math.min(max, pageCap), total: list.length, slice: list.slice(startAt, startAt + Math.min(max, pageCap)) });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));

    // Control plane for tests and manual poking.
    if (p === '/__mock/state') return send(res, 200, { flavor: st.flavor, chaos, issues: st.issues.size });
    if (p === '/__mock/chaos' && req.method === 'POST') { chaos = (await readBody(req)).mode || 'off'; return send(res, 200, { chaos }); }
    if (p === '/__mock/reset' && req.method === 'POST') { st = seed(st.flavor); chaos = 'off'; return send(res, 200, { ok: true }); }
    if (!p.startsWith('/rest/')) { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<h1>Mock Jira</h1>'); }

    if (chaos === '500') return send(res, 500, { errorMessages: ['Mock internal error'] });
    if (chaos === '429') return send(res, 429, { errorMessages: ['Rate limited'] }, { 'Retry-After': '0' });
    if (chaos === '429-once') { chaos = 'off'; return send(res, 429, { errorMessages: ['Rate limited'] }, { 'Retry-After': '0' }); }
    if (!authed(req)) return send(res, 401, { errorMessages: ['You are not authenticated. Authentication required to perform this operation.'] });

    base = `http://${req.headers.host}`;
    let m;
    const me = USERS.me;
    if ((m = p.match(/^\/rest\/api\/[23]\/serverInfo$/))) return send(res, 200, { baseUrl: base, version: st.flavor === 'cloud' ? '1001.0.0-SNAPSHOT' : '9.12.4', deploymentType: st.flavor === 'cloud' ? 'Cloud' : 'Server', serverTitle: 'Mock Jira' });
    if ((m = p.match(/^\/rest\/api\/[23]\/myself$/))) return send(res, 200, me);
    if ((m = p.match(/^\/rest\/api\/[23]\/project$/))) return send(res, 200, [{ id: '1', key: 'ENG', name: 'Engineering' }]);
    if ((m = p.match(/^\/rest\/api\/[23]\/field$/))) return send(res, 200, [
      { id: 'summary', name: 'Summary', custom: false },
      { id: F.epicLink, name: 'Epic Link', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-epic-link' } },
      { id: F.points, name: 'Story Points', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' } },
      { id: F.sprint, name: 'Sprint', custom: true, schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } },
    ]);
    if (p === '/rest/agile/1.0/board') return send(res, 200, { values: [{ id: 7, name: 'Platform Board', type: 'scrum' }, { id: 9, name: 'Infra Kanban', type: 'kanban' }] });
    if ((m = p.match(/^\/rest\/agile\/1\.0\/board\/(\d+)\/sprint$/))) return send(res, 200, { values: m[1] === '7' ? [st.sprint] : [] });
    if ((m = p.match(/^\/rest\/agile\/1\.0\/sprint\/42\/issue$/))) {
      const list = [...st.issues.values()].filter((i) => i.type !== 'Epic');
      const pg = page(list, Number(url.searchParams.get('startAt') || 0), Number(url.searchParams.get('maxResults') || 50));
      return send(res, 200, { startAt: pg.startAt, maxResults: pg.maxResults, total: pg.total, issues: pg.slice.map((i) => toRaw(st, i, base)) });
    }
    if (p === '/rest/api/2/search' && req.method === 'POST' && st.flavor !== 'cloud') {
      const b = await readBody(req);
      const list = filterByJql(st, b.jql);
      const pg = page(list, b.startAt || 0, b.maxResults || 50);
      return send(res, 200, { startAt: pg.startAt, maxResults: pg.maxResults, total: pg.total, issues: pg.slice.map((i) => toRaw(st, i, base)) });
    }
    if (p === '/rest/api/3/search/jql' && req.method === 'POST' && st.flavor === 'cloud') {
      const b = await readBody(req);
      const list = filterByJql(st, b.jql);
      const start = b.nextPageToken ? Number(Buffer.from(b.nextPageToken, 'base64').toString()) : 0;
      const size = Math.min(b.maxResults || 50, pageCap);
      const slice = list.slice(start, start + size);
      const more = start + size < list.length;
      return send(res, 200, { issues: slice.map((i) => toRaw(st, i, base)), isLast: !more, ...(more ? { nextPageToken: Buffer.from(String(start + size)).toString('base64') } : {}) });
    }
    if ((m = p.match(/^\/rest\/api\/[23]\/issue\/([A-Z0-9-]+)(\/transitions|\/comment)?$/))) {
      const i = st.issues.get(m[1]);
      if (!i) return send(res, 404, { errorMessages: ['Issue Does Not Exist'], errors: {} });
      if (!m[2] && req.method === 'GET') return send(res, 200, toRaw(st, i, base));
      if (m[2] === '/transitions' && req.method === 'GET') {
        return send(res, 200, { transitions: STATUSES.filter((s) => s.name !== i.status).map((s) => ({ id: 't' + s.id, name: `Move to ${s.name}`, to: { id: s.id, name: s.name, statusCategory: { key: s.cat } } })) });
      }
      if (m[2] === '/transitions' && req.method === 'POST') {
        const b = await readBody(req);
        const s = STATUSES.find((x) => 't' + x.id === b.transition?.id);
        if (!s) return send(res, 400, { errorMessages: ['Transition is not valid for this issue'] });
        i.status = s.name; i.updated = new Date().toISOString();
        return send(res, 204);
      }
      if (m[2] === '/comment' && req.method === 'POST') {
        const b = await readBody(req);
        const text = typeof b.body === 'string' ? b.body : b.body?.content?.[0]?.content?.[0]?.text || '';
        const list = st.comments.get(i.key) || []; list.push({ id: String(list.length + 1), body: text, author: me.displayName });
        st.comments.set(i.key, list);
        return send(res, 201, { id: String(list.length), body: text });
      }
    }
    return send(res, 404, { errorMessages: [`Mock Jira has no route for ${req.method} ${p}`] });
  });

  return {
    server,
    get state() { return st; },
    credentials: () => ({ token, email }),
    comments: (key) => st.comments.get(key) || [],
    listen(port = 0) {
      return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
        const a = server.address(); base = `http://127.0.0.1:${a.port}`;
        resolve({ port: a.port, url: base });
      }));
    },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
