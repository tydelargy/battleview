import test from 'node:test';
import assert from 'node:assert/strict';
import { createMockJira } from '../server/jira/mock.js';
import { createJiraClient, syncJira, JiraError } from '../server/jira/client.js';

const cfg = (url, over = {}) => ({ deployment: 'server', baseUrl: url, token: 'mock-token', email: 'me@example.com', projectKeys: ['ENG'], boardId: '', jql: '', epicLinkField: 'customfield_10014', storyPointsField: 'customfield_10016', sprintField: 'customfield_10020', timeoutMs: 3000, ...over });
async function withMock(opts, fn) {
  const m = createMockJira(opts); const { url } = await m.listen(0);
  try { await fn(url, m); } finally { await m.close(); }
}

test('server flavor: PAT auth, search, normalisation, epics', async () => {
  await withMock({}, async (url) => {
    const c = createJiraClient(cfg(url));
    assert.equal((await c.myself()).displayName, 'Jordan Lee');
    const r = await syncJira(cfg(url), ['ENG-412']);
    const t = r.issues.get('ENG-412');
    assert.equal(t.status.name, 'In Progress'); assert.equal(t.status.category, 'progress');
    assert.equal(t.epic.key, 'ENG-300'); assert.equal(t.epic.name, 'Billing v2');
    assert.equal(t.points, 8); assert.equal(t.assignee.name, 'Maya Okafor'); assert.equal(t.sprint.name, 'Sprint 42');
    assert.ok(!r.issues.has('ENG-472'), 'done tickets are outside the default JQL');
  });
});

test('PR-referenced tickets outside the query are fetched by key', async () => {
  await withMock({}, async (url) => {
    const r = await syncJira(cfg(url), ['ENG-472', 'ENG-999']);
    assert.equal(r.issues.get('ENG-472').status.category, 'done');
    assert.ok(!r.issues.has('ENG-999'));
  });
});

test('board mode reads the active sprint and excludes epics', async () => {
  await withMock({}, async (url) => {
    const r = await syncJira(cfg(url, { boardId: '7' }), []);
    assert.equal(r.sprint.name, 'Sprint 42');
    assert.ok(r.issues.has('ENG-472'), 'sprint issues include Done tickets');
    assert.ok(![...r.issues.values()].some((i) => i.type === 'Epic' && i.key === 'ENG-300' && false));
  });
});

test('pagination follows startAt when the server caps page size', async () => {
  await withMock({ pageCap: 4 }, async (url) => {
    const c = createJiraClient(cfg(url));
    const all = await c.searchAll('project = ENG');
    assert.equal(all.length, 18);
    const sprint = await c.activeSprintIssues(7);
    assert.equal(sprint.issues.length, 14);
  });
});

test('cloud flavor: basic auth, parent epics, nextPageToken pagination', async () => {
  await withMock({ flavor: 'cloud', pageCap: 5 }, async (url) => {
    const j = cfg(url, { deployment: 'cloud' });
    const c = createJiraClient(j);
    const all = await c.searchAll('project = ENG');
    assert.equal(all.length, 18);
    assert.equal(all.find((i) => i.key === 'ENG-418').epic.name, 'Billing v2');
    await c.comment('ENG-418', 'hello');
  });
});

test('bad token yields a readable 401 with a hint', async () => {
  await withMock({}, async (url) => {
    await assert.rejects(createJiraClient(cfg(url, { token: 'nope' })).myself(), (e) => e instanceof JiraError && e.status === 401 && /personal access token/i.test(e.hint));
  });
  await withMock({ flavor: 'cloud' }, async (url) => {
    await assert.rejects(createJiraClient(cfg(url, { deployment: 'cloud', token: 'nope' })).myself(), (e) => e.status === 401 && /API token/i.test(e.hint));
  });
});

test('unreachable host and html responses are explained', async () => {
  await assert.rejects(createJiraClient(cfg('http://127.0.0.1:1')).myself(), (e) => /Cannot reach/.test(e.message) && !!e.hint);
  await withMock({}, async (url) => {
    await assert.rejects(createJiraClient(cfg(url + '/nothing-here')).myself(), (e) => e.status === 200 || e.status === 404);
  });
});

test('429 is retried once, persistent 500 surfaces', async () => {
  await withMock({}, async (url, m) => {
    await fetch(url + '/__mock/chaos', { method: 'POST', body: JSON.stringify({ mode: '429-once' }) });
    assert.ok(await createJiraClient(cfg(url), { sleep: async () => {} }).myself());
    await fetch(url + '/__mock/chaos', { method: 'POST', body: JSON.stringify({ mode: '500' }) });
    await assert.rejects(createJiraClient(cfg(url)).myself(), (e) => e.status === 500);
  });
});

test('transitions move a ticket and comments are stored', async () => {
  await withMock({}, async (url, m) => {
    const c = createJiraClient(cfg(url));
    const ts = await c.transitions('ENG-481');
    assert.ok(ts.some((t) => t.to === 'In Review'));
    await c.transition('ENG-481', ts.find((t) => t.to === 'In Review').id);
    assert.equal((await c.issuesByKeys(['ENG-481']))[0].status.name, 'In Review');
    await c.comment('ENG-481', 'Ready for eyes');
    assert.equal(m.comments('ENG-481')[0].body, 'Ready for eyes');
    await assert.rejects(c.transition('ENG-481', 'bogus'), (e) => e.status === 400);
    await assert.rejects(c.transitions('ENG-000'), (e) => e.status === 404);
  });
});
