// Minimal Jira REST client. Works against Data Center/Server (PAT, Bearer, REST v2)
// and Cloud (email + API token, Basic, REST v3 search/jql). Uses global fetch.

export class JiraError extends Error {
  constructor(message, { status, hint, url } = {}) {
    super(message);
    this.name = 'JiraError';
    this.status = status;
    this.hint = hint;
    this.url = url;
  }
}

export function authHeader(j) {
  if (j.deployment === 'cloud') return 'Basic ' + Buffer.from(`${j.email}:${j.token}`).toString('base64');
  return 'Bearer ' + j.token;
}

const CATEGORY = { new: 'todo', indeterminate: 'progress', done: 'done' };

function hintFor(status, cloud) {
  if (status === 401) return cloud ? 'Jira rejected the email or API token. Create a token at id.atlassian.com > Security > API tokens.' : 'Jira rejected the personal access token. Create one under Profile > Personal Access Tokens and check it has not expired.';
  if (status === 403) return 'The token is valid but not allowed to do this. Check project permissions, or sign in to Jira in a browser once to clear a CAPTCHA lock.';
  if (status === 404) return 'Not found. Check the base URL, including any context path such as /jira, and that the key or board exists.';
  if (status === 429) return 'Jira is rate limiting this client. Raise the poll interval.';
  if (status >= 500) return 'Jira returned a server error. Try again in a moment.';
  return undefined;
}

export function createJiraClient(jira, { fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!jira.baseUrl) throw new JiraError('No Jira base URL configured', { hint: 'Open Settings > Jira and enter your base URL.' });
  if (!jira.token) throw new JiraError('No Jira token configured', { hint: 'Open Settings > Jira and paste a personal access token.' });
  const base = jira.baseUrl.replace(/\/+$/, '');
  const cloud = jira.deployment === 'cloud';
  const api = cloud ? '3' : '2';
  const timeoutMs = jira.timeoutMs || 15000;

  async function req(method, pathname, { query, body, retried = false } = {}) {
    const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== '')).toString() : '';
    const url = base + pathname + qs;
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers: { Authorization: authHeader(jira), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
    } catch (e) {
      const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
      throw new JiraError(timedOut ? `Jira did not answer within ${timeoutMs / 1000}s` : `Cannot reach ${base}`, { hint: timedOut ? 'Check VPN and the base URL.' : `Check the base URL and your network or VPN. (${e.cause?.code || e.message})`, url });
    }
    if (res.status >= 300 && res.status < 400) {
      throw new JiraError(`Jira redirected to ${res.headers.get('location') || 'another page'}`, { status: res.status, url, hint: 'Usually an SSO login page or http to https redirect. Use the exact https base URL.' });
    }
    if (res.status === 429 && !retried) {
      const wait = Math.min(5000, (Number(res.headers.get('retry-after')) || 1) * 1000);
      await sleep(wait);
      return req(method, pathname, { query, body, retried: true });
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = `Jira answered ${res.status}`;
      try { const j = JSON.parse(text); msg = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join('; ') || msg; } catch { /* html or empty */ }
      throw new JiraError(msg, { status: res.status, url, hint: hintFor(res.status, cloud) });
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch {
      throw new JiraError('Jira returned a page instead of JSON', { status: res.status, url, hint: 'The base URL probably points at a login or marketing page.' });
    }
  }

  const fieldList = () => ['summary', 'status', 'assignee', 'priority', 'issuetype', 'labels', 'updated', 'parent', jira.epicLinkField, jira.storyPointsField, jira.sprintField].filter(Boolean);

  function normalizeIssue(raw) {
    const f = raw.fields || {};
    const cat = f.status?.statusCategory?.key;
    let epic = null;
    if (f.parent && (f.parent.fields?.issuetype?.name || '').toLowerCase() === 'epic') epic = { key: f.parent.key, name: f.parent.fields.summary || null };
    else if (jira.epicLinkField && typeof f[jira.epicLinkField] === 'string') epic = { key: f[jira.epicLinkField], name: null };
    const sprints = Array.isArray(f[jira.sprintField]) ? f[jira.sprintField] : f.sprint ? [f.sprint] : [];
    const sp = sprints.find((s) => s.state === 'active') || sprints[sprints.length - 1] || null;
    return {
      key: raw.key,
      summary: f.summary || '',
      type: f.issuetype?.name || 'Task',
      status: { name: f.status?.name || 'Unknown', category: CATEGORY[cat] || 'todo' },
      assignee: f.assignee ? { name: f.assignee.displayName, email: f.assignee.emailAddress || null, id: f.assignee.accountId || f.assignee.name || null } : null,
      priority: f.priority?.name || null,
      points: typeof f[jira.storyPointsField] === 'number' ? f[jira.storyPointsField] : null,
      labels: f.labels || [],
      sprint: sp ? { id: sp.id, name: sp.name, state: sp.state } : null,
      epic,
      updated: f.updated || null,
      url: `${base}/browse/${raw.key}`,
    };
  }

  async function searchAll(jql, { max = 500 } = {}) {
    const fields = fieldList();
    const out = [];
    if (cloud) {
      let token;
      do {
        const r = await req('POST', '/rest/api/3/search/jql', { body: { jql, fields, maxResults: 100, ...(token ? { nextPageToken: token } : {}) } });
        out.push(...(r.issues || []));
        token = r.isLast === false ? r.nextPageToken : undefined;
      } while (token && out.length < max);
    } else {
      let startAt = 0, total = Infinity;
      while (startAt < total && out.length < max) {
        const r = await req('POST', '/rest/api/2/search', { body: { jql, fields, startAt, maxResults: 100 } });
        const got = r.issues || [];
        out.push(...got);
        total = r.total ?? out.length;
        if (!got.length) break;
        startAt += got.length;
      }
    }
    return out.map(normalizeIssue);
  }

  return {
    cloud,
    normalizeIssue,
    myself: () => req('GET', `/rest/api/${api}/myself`),
    serverInfo: () => req('GET', `/rest/api/${api}/serverInfo`),
    fields: () => req('GET', `/rest/api/${api}/field`),
    projects: () => req('GET', `/rest/api/${api}/project`),
    async boards(projectKeys = []) {
      const r = await req('GET', '/rest/agile/1.0/board', { query: { maxResults: 50, projectKeyOrId: projectKeys[0] } });
      return (r.values || []).map((b) => ({ id: b.id, name: b.name, type: b.type }));
    },
    searchAll,
    async activeSprintIssues(boardId) {
      const sprints = (await req('GET', `/rest/agile/1.0/board/${boardId}/sprint`, { query: { state: 'active' } })).values || [];
      const sprint = sprints[0] || null;
      if (!sprint) return { sprint: null, issues: [] };
      const raws = [];
      let startAt = 0, total = Infinity;
      while (startAt < total) {
        const r = await req('GET', `/rest/agile/1.0/sprint/${sprint.id}/issue`, { query: { fields: fieldList().join(','), startAt, maxResults: 100 } });
        const got = r.issues || [];
        raws.push(...got);
        total = r.total ?? raws.length;
        if (!got.length) break;
        startAt += got.length;
      }
      return { sprint: { id: sprint.id, name: sprint.name, state: sprint.state, endDate: sprint.endDate || null }, issues: raws.map(normalizeIssue) };
    },
    async issuesByKeys(keys) {
      const uniq = [...new Set(keys)];
      const out = [];
      for (let i = 0; i < uniq.length; i += 40) out.push(...(await searchAll(`key in (${uniq.slice(i, i + 40).join(',')})`)));
      return out;
    },
    async transitions(key) {
      const r = await req('GET', `/rest/api/${api}/issue/${encodeURIComponent(key)}/transitions`);
      return (r.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to?.name || null }));
    },
    transition: (key, id) => req('POST', `/rest/api/${api}/issue/${encodeURIComponent(key)}/transitions`, { body: { transition: { id: String(id) } } }),
    comment(key, text) {
      const body = cloud
        ? { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }
        : { body: text };
      return req('POST', `/rest/api/${api}/issue/${encodeURIComponent(key)}/comment`, { body });
    },
  };
}

export function defaultJql(jira) {
  if (jira.jql) return jira.jql;
  const base = jira.projectKeys?.length ? `project in (${jira.projectKeys.join(',')})` : 'assignee = currentUser()';
  return `${base} AND statusCategory != Done ORDER BY updated DESC`;
}

/** One full sync: ticket list + tickets referenced by PRs + epic names. */
export async function syncJira(jira, prKeys = [], deps) {
  const client = createJiraClient(jira, deps);
  const started = Date.now();
  const user = await client.myself();
  let sprint = null, issues;
  if (jira.jql) issues = await client.searchAll(jira.jql);
  else if (jira.boardId) ({ sprint, issues } = await client.activeSprintIssues(jira.boardId));
  else issues = await client.searchAll(defaultJql(jira));
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const missing = prKeys.filter((k) => !byKey.has(k));
  if (missing.length) for (const i of await client.issuesByKeys(missing)) byKey.set(i.key, i);
  const epicKeys = [...new Set([...byKey.values()].map((i) => i.epic?.key).filter(Boolean))];
  const needEpics = epicKeys.filter((k) => !byKey.get(k));
  const epics = new Map();
  if (needEpics.length) for (const e of await client.issuesByKeys(needEpics)) epics.set(e.key, e);
  for (const k of epicKeys) { const e = byKey.get(k) || epics.get(k); if (e) epics.set(k, e); }
  for (const i of byKey.values()) if (i.epic && !i.epic.name) i.epic.name = epics.get(i.epic.key)?.summary || i.epic.key;
  return {
    ok: true,
    user: { name: user.displayName, email: user.emailAddress || null, id: user.accountId || user.name || null },
    sprint,
    issues: byKey,
    epics,
    lastSync: new Date().toISOString(),
    tookMs: Date.now() - started,
  };
}
