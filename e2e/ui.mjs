// Browser test of the panels and Jira flows against the mock. Not part of `npm test`
// (needs Playwright + Chrome). Runs without WebGL: the 3D scene is optional in the UI.
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { chromium = createRequire(process.env.PLAYWRIGHT_DIR || '/home/claude/.npm-global/lib/node_modules/')('playwright').chromium; }
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const port = 4790, cfgFile = path.join(os.tmpdir(), `bm-ui-${Date.now()}.json`);
const srv = spawn('node', ['bin/battlemap.js', '--mock-jira', '--port', String(port), '--mock-port', '4791', '--config', cfgFile], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (e) { results.push(['FAIL', name + ' :: ' + e.message.split('\n')[0]]); } };
try {
  const page = await browser.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForSelector('.card');
  await page.waitForFunction(() => document.getElementById('jiraTxt').textContent === 'Sprint 42', null, { timeout: 8000 });

  await step('header, counters and Jira pill', async () => {
    assert.match(await page.textContent('#sub'), /MOCK JIRA/);
    assert.equal((await page.$$('.ctr')).length, 3);
    assert.equal(await page.textContent('#jiraTxt'), 'Sprint 42');
  });
  await step('needs-me PRs sort first; ticket line shows Jira status and assignee', async () => {
    const first = await page.textContent('.card:first-child');
    assert.match(first, /NEEDS YOU/);
    assert.match(await page.textContent('.card[data-id="#2302"]'), /ENG-431 · In Progress · Jordan Lee/);
    assert.match(await page.textContent('.card[data-id="#2320"]'), /No ticket key/);
  });
  await step('alerts drawer lists drift and clicking focuses the PR', async () => {
    assert.ok(Number(await page.textContent('#alertCount')) >= 3);
    await page.click('#alertsBtn');
    const t = await page.textContent('#alerts');
    assert.match(t, /ENG-472 is Done but #2316 is still open/); assert.match(t, /ENG-481 is To Do but #2311 is up/);
    await page.click('.al:has-text("ENG-472 is Done")');
    assert.equal(await page.isVisible('#focus'), true);
    assert.match(await page.textContent('#focus h2'), /Webhooks guide/);
  });
  await step('focus panel: diff accounting and ticket block', async () => {
    await page.click('.card[data-id="#2291"]');
    const t = await page.textContent('#focus');
    assert.ok(!/null/.test(t), 'no stringified nulls'); assert.match(t, /\+598/); assert.match(t, /−370/); assert.match(t, /4 files/);
    assert.match(t, /Rewrite proration engine/); assert.match(t, /Billing v2/); assert.match(t, /Sprint 42/);
    assert.equal((await page.$$('.frow')).length, 4);
    assert.match(await page.textContent('.frow'), /pricing\.ts/);
  });
  await step('move ticket from the app, board updates', async () => {
    await page.click('.card[data-id="#2311"]');
    await page.waitForSelector('#trSel option[value]:not([value=""])', { state: 'attached' });
    const val = await page.$eval('#trSel', (s) => [...s.options].find((o) => /In Review/.test(o.textContent)).value);
    await page.selectOption('#trSel', val); await page.click('#trGo');
    await page.waitForFunction(() => /ENG-481 · In Review/.test(document.querySelector('.card[data-id="#2311"]').textContent), null, { timeout: 5000 });
    await page.click('#alertsBtn');
    assert.ok(!/ENG-481 is To Do/.test(await page.textContent('#alerts')), 'drift alert cleared');
    await page.click('#alerts .btn');
  });
  await step('comment on a ticket keeps working through a refresh', async () => {
    await page.fill('#cmt', 'looks good'); await page.click('#cmtGo');
    await page.waitForFunction(() => /Comment added/.test(document.getElementById('toast').textContent));
  });
  await step('Needs me and epic chips filter the tray', async () => {
    await page.keyboard.press('Escape');
    const total = (await page.$$('.card[data-id]')).length;
    await page.click('.chip:has-text("Needs me")');
    const n = (await page.$$('.card[data-id]')).length; assert.ok(n < total && n >= 4, `needs ${n}/${total}`);
    await page.click('.chip:has-text("Needs me")');
    await page.click('.chip:has-text("Infra cutover")');
    assert.equal((await page.$$('.card[data-id]')).length, 2);
    await page.click('.chip:has-text("Infra cutover")');
  });
  await step('settings: wrong token explains itself; right token and detect fields work', async () => {
    await page.click('#settingsBtn');
    await page.waitForSelector('#f-token');
    assert.match(await page.textContent('.res.warn'), /Mock Jira is active/);
    await page.fill('#f-token', 'wrong'); await page.click('#b-test');
    await page.waitForSelector('.res.bad');
    assert.match(await page.textContent('.res.bad'), /not authenticated/i); assert.match(await page.textContent('.res.bad'), /personal access token/i);
    await page.fill('#f-token', ''); await page.click('#b-test');
    await page.waitForSelector('.res.ok'); assert.match(await page.textContent('.res.ok'), /Signed in as Jordan Lee/);
    await page.fill('#f-epic', 'customfield_0'); await page.click('#b-detect');
    await page.waitForFunction(() => document.getElementById('f-epic').value === 'customfield_10014');
    await page.click('#b-boards'); await page.waitForFunction(() => document.querySelectorAll('#f-board option').length === 3);
  });
  await step('settings panes never print "null"', async () => {
    for (const tab of ['DISPLAY', 'DATA SOURCES', 'JIRA']) { await page.click(`.mnav button:has-text("${tab}")`); assert.ok(!/\bnull\b/.test(await page.textContent('.mpane')), tab); }
  });
  await step('settings: invalid input is rejected with reasons, cloud toggles the email field', async () => {
    await page.fill('#f-url', 'not a url'); await page.click('#b-save');
    await page.waitForSelector('.res.bad'); assert.match(await page.textContent('.res.bad'), /Base URL must start with http/);
    await page.selectOption('#f-dep', 'cloud'); assert.equal(await page.isVisible('#f-email'), true);
    await page.selectOption('#f-dep', 'server'); assert.equal(await page.isVisible('#f-email'), false);
  });
  await step('settings: valid save applies and reports it was not persisted (mock)', async () => {
    await page.fill('#f-url', await page.$eval('#f-url', (e) => e.defaultValue)); // restore
    const url = (await (await fetch(`http://127.0.0.1:${port}/api/config`)).json()).jira.baseUrl;
    await page.fill('#f-url', url); await page.fill('#f-poll', '30'); await page.click('#b-save');
    await page.waitForFunction(() => /Applied for this session/.test(document.querySelector('.foot .msg').textContent));
  });
  // desktop layout screenshot with a focused PR
  await page.screenshot({ path: path.join(os.tmpdir(), 'ui-shot.png') });
  const d = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await d.goto(`http://127.0.0.1:${port}/`); await d.waitForSelector('.card'); await d.waitForTimeout(800);
  await d.click('.card[data-id="#2291"]'); await d.waitForTimeout(400); await d.screenshot({ path: path.join(os.tmpdir(), 'ui-desktop.png') });
  await d.click('#settingsBtn'); await d.waitForTimeout(300); await d.screenshot({ path: path.join(os.tmpdir(), 'ui-settings.png') });
  await step('XSS: hostile PR titles and handles render as text, including in the track dialog and rule UI', async () => {
    await page.keyboard.press('Escape');
    const evil = '<img src=x onerror="window.__pwned=1">';
    await fetch(`http://127.0.0.1:${port}/api/prs`, { method: 'POST', headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify([{ id: '#9', title: evil, author: '<b>x</b>', status: 'ready_to_merge', files: [{ path: 'apps/api/routes/auth.ts', add: 1, del: 1 }] }]) });
    // Not yours, so it is offered in the track dialog rather than drawn. The dialog must show it as text.
    await page.click('#trackBtn');
    await page.waitForFunction((t) => [...document.querySelectorAll('.arow .ainfo')].some((e) => e.textContent.includes(t)), evil, { timeout: 5000 });
    assert.equal(await page.$$eval('#msheet img, #msheet b > b', (e) => e.length), 0);
    // Track everything by that (hostile) author: the rule row, the WATCHING pill and the card tag all carry the handle.
    await page.click('.arow .act .btn:nth-child(2)');
    await page.waitForSelector('.rrow');
    assert.equal(await page.$$eval('#msheet img, .rrow b b', (e) => e.length), 0);
    await page.click('.mhead .btn');
    await page.waitForFunction((t) => document.querySelector('.card .t')?.textContent === t, evil, { timeout: 5000 });
    assert.match(await page.textContent('#watchPill'), /<b>x<\/b>/, 'the pill shows the handle as text');
    assert.match(await page.textContent('.card .via'), /<b>x<\/b>/);
    await page.click('.card'); await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(await page.$$eval('#cards img, #focus img, #chips img, #chips b b, #cards .via b', (e) => e.length), 0);
  });
  await step('no page errors', async () => assert.deepEqual(errors.filter((e) => !/three|dynamically|module/i.test(e)), []));
} finally { await browser.close(); srv.kill(); }
for (const [s, n] of results) console.log(s, n);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
