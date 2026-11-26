// Browser test of notifications and clearable alerts, against a real server fed by a prs.json that changes on disk
// (the way a cron job would), with a real config directory and a server restart in the middle.
// Not part of `npm test` (needs Playwright + Chrome); `npm run e2e` runs it last.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4797, base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-notify-e2e-'));
const feedFile = path.join(dir, 'prs.json'), cfgFile = path.join(dir, 'config.json');

// ---- the feed: #301 is yours (the default identity is "you"), the rest are other people's ----
const BASE = {
  301: { author: 'you', status: 'ready_to_merge', sha: 'a1' },
  302: { author: 'devon', status: 'review_requested', sha: 'b1' },
  303: { author: 'ines', status: 'draft', sha: 'c1' },
  304: { author: 'kofi', status: 'changes_requested', sha: 'd1' },
  305: { author: 'maya', status: 'review_requested', sha: 'e1' },
};
const pr = (n, o = {}) => { const b = { ...BASE[n], ...o }; return { id: `#${n}`, number: n, title: o.title || `Work item ${n}`, author: b.author, status: b.status, headSha: b.sha, branch: `${b.author}/w-${n}`, createdAt: new Date(Date.now() - 3 * 86400_000).toISOString(), updatedAt: new Date(Date.now() - 3600_000).toISOString(), files: [{ path: ['apps/api/routes/auth.ts', 'apps/api/routes/users.ts', 'apps/api/routes/billing.ts', 'apps/api/routes/orders.ts', 'apps/api/routes/webhooks.ts', 'apps/api/routes/search.ts'][n % 6], add: 10, del: 2 }] }; };
const feed = (over = {}) => Object.keys(BASE).map((n) => pr(Number(n), over[n] || {}));
// the feed as the earlier steps leave it, so later steps change one thing at a time (anything else that moved would be announced too)
const NOW_STATE = { 301: { sha: 'a2' }, 302: { sha: 'b3' }, 303: { status: 'review_requested' }, 304: { status: 're_review' }, 305: { sha: 'e3' } };
const writeFeed = (over) => fs.writeFileSync(feedFile, JSON.stringify({ prs: Array.isArray(over) ? over : feed(over) }));

let srv;
async function startServer() {
  srv = spawn('node', ['bin/battlemap.js', '--prs', feedFile, '--port', String(port), '--config', cfgFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
}
const stopServer = () => new Promise((r) => { srv.once('exit', r); srv.kill('SIGTERM'); });
const api = (method, p, body) => fetch(base + p, { method, headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());

writeFeed({});
await startServer();
process.on('exit', () => srv?.kill());
await api('PUT', '/api/watch/mode', { mode: 'all' });   // track everything: this test is about what is announced
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
let page, shots = 0;
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); }
  catch (e) {
    const shot = path.join(dir, `fail-${++shots}.png`); await page?.screenshot({ path: shot }).catch(() => {});
    results.push(['FAIL', `${name} :: ${e.message.split('\n').slice(0, 3).join(' | ')}  [screenshot ${shot}]`]);
    await page?.keyboard.press('Escape').catch(() => {});
  }
};

// ---- helpers ----
const texts = () => page.$$eval('#notifs .nt .nt-text', (e) => e.map((x) => x.textContent));
async function expectTexts(expected, what) {
  try { await page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll('#notifs .nt .nt-text')].map((x) => x.textContent)) === JSON.stringify(exp), expected, { timeout: 6000 }); }
  catch { throw new Error(`${what}: expected ${JSON.stringify(expected)} but the list shows ${JSON.stringify(await texts())}`); }
}
const bell = async () => ((await page.isVisible('#bellCount')) ? Number(await page.textContent('#bellCount')) : 0);
async function expectBell(n, what) {
  try { await page.waitForFunction((x) => { const b = document.getElementById('bellCount'); return (b.hidden ? 0 : Number(b.textContent)) === x; }, n, { timeout: 6000 }); }
  catch { throw new Error(`${what}: expected bell ${n} but it shows ${await bell()}`); }
}
const openBell = async () => { if (!(await page.isVisible('#notifs'))) { await page.click('#bellBtn'); await page.waitForSelector('#notifs', { state: 'visible' }); } };
const closeBell = async () => { if (await page.isVisible('#notifs')) { await page.click('#nt-close'); await page.waitForSelector('#notifs', { state: 'hidden' }); } };
async function expectCount(sel, n, what) {
  try { await page.waitForFunction(([q, x]) => document.querySelectorAll(q).length === x, [sel, n], { timeout: 6000 }); }
  catch { throw new Error(`${what}: expected ${n} of ${sel} but there are ${await page.$$eval(sel, (e) => e.length)}`); }
}
const quiet = (ms = 1200) => page.waitForTimeout(ms);   // long enough for the feed watcher and the browser to have reacted, to prove nothing happened

try {
  page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('#bellBtn');
  await page.waitForSelector('.card[data-id]');

  await step('at the start: nothing to report, and all three kinds are switched on', async () => {
    await expectBell(0, 'start');
    await openBell();
    assert.match(await page.textContent('#notifs .nt-empty'), /No notifications/);
    for (const k of ['pushed', 're_review', 'ci']) assert.equal(await page.isChecked(`#np-${k}`), true, k);
    await closeBell();
  });

  await step('new commits on someone else\'s PR: a notification, a badge and a toast; opening the list marks it seen', async () => {
    writeFeed({ 302: { sha: 'b2' } });
    await expectBell(1, 'after a push');
    await page.waitForFunction(() => /New commits on #302/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    await openBell();
    await expectTexts(['New commits on #302 Work item 302 (+10 −2)'], 'push');
    assert.match(await page.textContent('#notifs .nt .nt-kind'), /PUSH/);
    await expectBell(0, 'opening the list marks everything seen');
    await closeBell();
  });

  await step('re-review requested, CI going red and recovering: each is announced once, newest first', async () => {
    writeFeed({ 302: { sha: 'b2' }, 304: { status: 're_review' } });
    await expectBell(1, 're-review');
    writeFeed({ 302: { sha: 'b2' }, 304: { status: 're_review' }, 303: { status: 'ci_failing' } });
    await expectBell(2, 'CI red');
    writeFeed({ 302: { sha: 'b2' }, 304: { status: 're_review' }, 303: { status: 'review_requested' } });
    await expectBell(3, 'CI green again');
    await openBell();
    await expectTexts(['CI is green again on #303 Work item 303', 'CI failed on #303 Work item 303', 'Re-review requested on #304 Work item 304', 'New commits on #302 Work item 302 (+10 −2)'], 'newest first');
    const kinds = await page.$$eval('#notifs .nt .nt-kind', (e) => e.map((x) => x.textContent));
    assert.deepEqual(kinds, ['CI OK', 'CI RED', 'RE-REVIEW', 'PUSH']);
    await closeBell();
  });

  await step('an unchanged feed, and a PR that appears for the first time, announce nothing', async () => {
    const before = (await fetch(`${base}/api/snapshot`).then((r) => r.json())).notifications.inbox.length;
    writeFeed({ 302: { sha: 'b2' }, 304: { status: 're_review' }, 303: { status: 'review_requested' } });
    await quiet();
    writeFeed([...feed({ 302: { sha: 'b2' }, 304: { status: 're_review' }, 303: { status: 'review_requested' } }), { ...pr(305), id: '#306', number: 306, title: 'Brand new', headSha: 'f1' }]);
    await page.waitForSelector('.card[data-id="#306"]'); await quiet();
    assert.equal((await fetch(`${base}/api/snapshot`).then((r) => r.json())).notifications.inbox.length, before, 'no new notifications');
    await expectBell(0, 'quiet');
    writeFeed({ 302: { sha: 'b2' }, 304: { status: 're_review' }, 303: { status: 'review_requested' } });   // #306 leaves again
  });

  await step('your own PRs notify too, and have no per-PR mute to forget about', async () => {
    writeFeed({ 301: { sha: 'a2' }, 302: { sha: 'b2' }, 304: { status: 're_review' }, 303: { status: 'review_requested' } });
    await expectBell(1, 'own push');
    await page.click('.card[data-id="#301"]');
    assert.equal(await page.isVisible('#npr-mine'), true, 'a note instead of switches');
    assert.match(await page.textContent('#npr-mine'), /always notify/);
    assert.equal(await page.$('#npr-pushed'), null);
    await page.keyboard.press('Escape');
    await openBell(); assert.match((await texts())[0], /New commits on #301/); await closeBell();
  });

  await step('mute one PR for one kind, then for everything; other PRs are unaffected; unmute brings it back', async () => {
    const S = { 301: { sha: 'a2' }, 302: { sha: 'b2' }, 304: { status: 're_review' }, 303: { status: 'review_requested' } };
    await page.click('.card[data-id="#305"]');
    await page.uncheck('#npr-pushed');
    await page.waitForFunction(() => !document.getElementById('npr-pushed').checked);
    writeFeed({ ...S, 305: { sha: 'e2' } }); await quiet();
    await expectBell(0, 'a muted kind on a muted PR');
    writeFeed({ ...S, 305: { sha: 'e2' }, 302: { sha: 'b3' } });
    await expectBell(1, 'but #302 still notifies');
    await page.check('#npr-pushed'); await page.uncheck('#npr-all');
    writeFeed({ ...S, 305: { sha: 'e2', status: 'ci_failing' }, 302: { sha: 'b3' } }); await quiet();
    await expectBell(1, 'muted everything: even CI is quiet');
    await page.check('#npr-all');
    writeFeed({ ...S, 305: { sha: 'e3', status: 'ci_failing' }, 302: { sha: 'b3' } });
    await expectBell(2, 'unmuted: the push is announced again');
    await page.keyboard.press('Escape');
    writeFeed({ ...S, 305: { sha: 'e3' }, 302: { sha: 'b3' } });   // CI recovers
    await expectBell(3, 'CI recovered on #305');
  });

  await step('the global policy silences a kind for everyone, your own PRs included, and can be switched back', async () => {
    await openBell(); await page.uncheck('#np-ci');
    await page.waitForFunction(() => !document.getElementById('np-ci').checked);
    await closeBell();
    const S = { 301: { sha: 'a2' }, 302: { sha: 'b3' }, 304: { status: 're_review' }, 303: { status: 'review_requested' }, 305: { sha: 'e3' } };
    const before = await bell();
    writeFeed({ ...S, 301: { sha: 'a2', status: 'ci_failing' }, 302: { sha: 'b3', status: 'ci_failing' } }); await quiet();
    await expectBell(before, 'CI is off globally: your own red CI is quiet too');
    writeFeed({ ...S, 301: { sha: 'a2' }, 302: { sha: 'b3' } }); await quiet();
    await openBell(); await page.check('#np-ci'); await closeBell();
    writeFeed({ ...S, 302: { sha: 'b3', status: 'ci_failing' } });
    await expectBell(before + 1, 'switched back on: announced again');
    writeFeed(S);                                                              // CI recovers: one more, announced a moment later
    await expectBell(before + 2, 'and its recovery');
  });

  await step('clear one, then clear all', async () => {
    await openBell(); await quiet(500);
    const n = (await texts()).length; assert.ok(n >= 6, `${n} notifications`);
    await page.locator('#notifs .nt .nt-x').first().click();
    await page.waitForFunction((x) => document.querySelectorAll('#notifs .nt').length === x, n - 1);
    await page.click('#nt-clear-all');
    await page.waitForSelector('#notifs .nt-empty');
    assert.deepEqual(await texts(), []);
    await closeBell(); await expectBell(0, 'after clearing');
  });

  await step('hostile titles are text in notifications and toasts', async () => {
    const evil = '<img src=x onerror="window.__pwned=1">';
    writeFeed({ ...NOW_STATE, 302: { sha: 'b9', title: evil } });
    await expectBell(1, 'hostile push');
    await openBell();
    assert.match((await texts())[0], /<img src=x onerror=/);
    assert.equal(await page.$$eval('#notifs img, #toast img', (e) => e.length), 0);
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    await page.click('#nt-clear-all'); await closeBell();
    writeFeed({ ...NOW_STATE, 302: { sha: 'b9' } });
  });

  await step('restart: the list, the unread count, the policy and the per-PR mutes survive, and the restart itself announces nothing', async () => {
    writeFeed({ ...NOW_STATE, 302: { sha: 'b10' } }); await expectBell(1, 'one to keep');
    await openBell(); await page.uncheck('#np-re_review'); await closeBell();
    await page.click('.card[data-id="#305"]'); await page.uncheck('#npr-ci'); await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await stopServer();
    writeFeed({ ...NOW_STATE, 302: { sha: 'b10' }, 304: { status: 'ci_failing' } });          // a change while we were down: 304 goes red, 302 unchanged
    await startServer();
    await page.reload(); await page.waitForSelector('#bellBtn');
    await expectBell(1, 'only the CI failure that happened while the server was down is new: the push was seen before the restart, and stays seen');
    await openBell();
    await expectTexts(['CI failed on #304 Work item 304', 'New commits on #302 Work item 302 (+10 −2)'], 'after restart');
    assert.equal(await page.isChecked('#np-re_review'), false, 'policy persisted'); assert.equal(await page.isChecked('#np-pushed'), true);
    await page.check('#np-re_review'); await closeBell();
    await page.click('.card[data-id="#305"]'); assert.equal(await page.isChecked('#npr-ci'), false, 'per-PR mute persisted'); assert.equal(await page.isChecked('#npr-pushed'), true);
    await page.check('#npr-ci'); await page.keyboard.press('Escape');
    const snap = await fetch(`${base}/api/snapshot`).then((r) => r.json());
    assert.equal(snap.notifications.inbox.length, 2, 'the restart itself added nothing');
  });

  await step('alerts can be silenced one at a time or all at once, restored, and it persists', async () => {
    await page.click('#alertsBtn'); await page.waitForSelector('#alerts .alrow');
    const total = await page.$$eval('#alerts .alrow:not(.silenced)', (e) => e.length);
    assert.ok(total >= 4, `${total} alerts (each PR has no ticket key)`);
    assert.equal(Number(await page.textContent('#alertCount')), total);
    const first = await page.textContent('#alerts .alrow:not(.silenced) b');
    await page.click('#alerts .alrow:not(.silenced) .sil');
    await expectCount('#alerts .alrow:not(.silenced)', total - 1, 'after silencing one');
    assert.equal(Number(await page.textContent('#alertCount')), total - 1, 'the header count follows');
    await page.click('#al-toggle-silenced');
    assert.equal(await page.textContent('#alerts .alrow.silenced b'), first, 'it is in the silenced list');
    await page.reload(); await page.waitForSelector('.card[data-id]');
    await page.waitForFunction((n) => Number(document.getElementById('alertCount').textContent) === n, total - 1, { timeout: 6000 }).catch(async () => { throw new Error(`still silenced after a reload: expected ${total - 1} alerts in the header, got "${await page.textContent('#alertCount')}"`); });
    await page.click('#alertsBtn'); await page.click('#al-toggle-silenced');
    await page.click('#alerts .alrow.silenced .restore');
    await expectCount('#alerts .alrow:not(.silenced)', total, 'after restoring one');
    await page.click('#al-silence-all');
    await page.waitForFunction(() => !document.getElementById('alertCount') || document.getElementById('alertCount').hidden);
    assert.match(await page.textContent('#alerts'), /Nothing to fix|silenced/i);
    assert.equal(await page.getAttribute('#al-toggle-silenced', 'aria-expanded'), 'true', 'the silenced list is still open');
    await page.$$eval('#alerts .alrow.silenced .restore', (b) => b.forEach((x) => x.click()));
    await expectCount('#alerts .alrow:not(.silenced)', total, 'after restoring them all');
    await page.keyboard.press('Escape');
  });

  await step('no page errors', async () => assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`));
} finally { await browser.close(); srv.kill(); }
for (const [s, n] of results) console.log(s, n);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
