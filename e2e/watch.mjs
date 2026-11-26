// Browser test of opt-in PR tracking, end to end: the real server fed by a prs.json that changes on disk (the way a
// cron job would feed it), a real config directory, WebGL on, and a server restart in the middle. Not part of
// `npm test` (needs Playwright + Chrome). `npm run e2e` runs it after e2e/ui.mjs.
import { createRequire } from 'node:module';
let chromium;
try { ({ chromium } = await import('playwright')); }
catch { chromium = createRequire(process.env.PLAYWRIGHT_DIR || '/home/claude/.npm-global/lib/node_modules/')('playwright').chromium; }
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4795, base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-watch-e2e-'));
const feedFile = path.join(dir, 'prs.json'), cfgFile = path.join(dir, 'config.json');

// ---- the feed ----
const pr = (n, author, paths, extra = {}) => ({ id: `#${n}`, number: n, title: `PR ${n} by ${author}`, branch: `${author}/work-${n}`, author, status: 'review_requested', updatedAt: new Date(Date.now() - n * 60000).toISOString(), files: paths.map((p) => ({ path: p, add: 12, del: 3 })), ...extra });
const F0 = [
  pr(101, 'you', ['apps/web/pages/login.tsx']),                   // yours: always tracked
  pr(102, 'maya', ['packages/core/domain/tax.ts']),
  pr(103, 'maya', ['apps/api/routes/auth.ts']),
  pr(104, 'devon', ['packages/core/domain/ledger.ts']),
  pr(105, 'kofi', ['infra/terraform/ecs.tf']),
  pr(106, 'ines', ['docs/guides/auth.md']),
  pr(109, 'ines', ['apps/web/hooks/useAuth.ts']),
];
const writeFeed = (list) => fs.writeFileSync(feedFile, JSON.stringify({ prs: list }));

let srv;
async function startServer() {
  srv = spawn('node', ['bin/battlemap.js', '--prs', feedFile, '--port', String(port), '--config', cfgFile], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
}
const stopServer = () => new Promise((r) => { srv.once('exit', r); srv.kill('SIGTERM'); });

writeFeed(F0);
await startServer();
process.on('exit', () => srv?.kill());   // never leave the server behind, even if Chrome fails to launch
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
let page;
let shots = 0;
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); }
  catch (e) {
    const shot = path.join(dir, `fail-${++shots}.png`);
    await page?.screenshot({ path: shot }).catch(() => {});
    results.push(['FAIL', `${name} :: ${e.message.split('\n').slice(0, 3).join(' | ')}  [screenshot ${shot}]`]);
    await page?.keyboard.press('Escape').catch(() => {});   // do not let an open dialog sink the steps after it
  }
};

// ---- helpers ----
const liveIds = () => page.$$eval('.card[data-id]:not(.ended)', (els) => els.map((e) => e.dataset.id).sort());
const endedIds = () => page.$$eval('.card.ended', (els) => els.map((e) => e.dataset.id).sort());
async function expectLive(expected, what) {
  try { await page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll('.card[data-id]:not(.ended)')].map((e) => e.dataset.id).sort()) === JSON.stringify(exp), expected, { timeout: 8000 }); }
  catch { throw new Error(`${what}: expected tray ${JSON.stringify(expected)} but it shows ${JSON.stringify(await liveIds())}`); }
}
async function expectEnded(expected, what) {
  try { await page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll('.card.ended')].map((e) => e.dataset.id).sort()) === JSON.stringify(exp), expected, { timeout: 8000 }); }
  catch { throw new Error(`${what}: expected ended ${JSON.stringify(expected)} but it shows ${JSON.stringify(await endedIds())}`); }
}
const snapshot = () => fetch(`${base}/api/snapshot`).then((r) => r.json());
const openTrack = async () => { await page.click('#trackBtn'); await page.waitForSelector('#t-link'); };
const closeDialog = async () => { await page.click('.mhead .btn'); await page.waitForSelector('#t-link', { state: 'hidden' }); };   // closing hides the modal; it stays in the DOM
const row = (n) => page.locator('.arow', { hasText: `#${n} ` });
const sceneInfo = () => page.evaluate(() => window.battlemap.state.scene.info());
const toastText = () => page.textContent('#toast');
/** Fly to a file and click the middle of the map: a real pick of a real building. */
async function clickFile(file) {
  await page.evaluate((f) => window.battlemap.state.scene.flyToFile(f), file);
  await page.waitForTimeout(1500);
  const b = await page.locator('#stage').boundingBox();
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
  await page.waitForFunction((f) => !document.getElementById('filebar').hidden && document.getElementById('filebar').textContent.includes(f), file, { timeout: 4000 });
}

try {
  page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('#trackBtn');

  await step('opt-in start: only your own PR is tracked, the rest is waiting in the feed', async () => {
    await expectLive(['#101'], 'start');
    assert.match(await page.textContent('#sub'), /1 tracked of 7 PRs/);
    assert.match(await page.textContent('#trackBtn'), /6 more open in the feed/);
    assert.equal(await page.isVisible('#watchPill'), false, 'no rules, no pill');
    assert.equal((await sceneInfo()).flags, 1, 'only the tracked PR has a flag on the map');
  });

  await step('flags show the PR number', async () => {
    await page.waitForSelector('.flag .num');
    assert.deepEqual(await page.$$eval('.flag .num', (e) => e.map((x) => x.textContent)), ['#101']);
  });

  await step('track by pasting a link', async () => {
    await openTrack();
    await page.fill('#t-link', 'https://github.com/org/repo/pull/106');
    await page.click('#t-link-go');
    await page.waitForFunction(() => /Tracking #106/.test(document.getElementById('toast').textContent));
    await expectLive(['#101', '#106'], 'after link');
  });

  await step('track from the list; the list stops offering it', async () => {
    await row(105).locator('.btn').first().click();
    await expectLive(['#101', '#105', '#106'], 'after list pick');
    await page.waitForFunction(() => ![...document.querySelectorAll('.arow')].some((r) => r.textContent.includes('#105 ')));
  });

  await step('the list filters by text and by author', async () => {
    await page.fill('#t-q', 'maya');
    await page.waitForFunction(() => document.querySelectorAll('.arow').length === 2);
    await page.fill('#t-q', '');
    await page.selectOption('#t-sel', 'ines');
    await page.waitForFunction(() => document.querySelectorAll('.arow').length === 1 && document.querySelector('.arow').textContent.includes('#109 '));
    await page.selectOption('#t-sel', '');
  });

  await step('author rule from the list: tracks all their PRs, shows the pill and a via tag', async () => {
    await row(102).locator('.btn').nth(1).click();
    await expectLive(['#101', '#102', '#103', '#105', '#106'], 'after author rule');
    await page.waitForSelector('.rrow');
    assert.match(await page.textContent('.rrow'), /@maya.*2 open/s);
    await closeDialog();
    assert.match(await page.textContent('#watchPill'), /WATCHING @maya/);
    assert.match(await page.textContent('.card[data-id="#102"] .via'), /@maya/);
    assert.equal(await page.isVisible('.card[data-id="#105"] .via'), false, 'a PR you picked is not credited to a rule');
    assert.equal(await page.isVisible('.card[data-id="#101"] .via'), false);
  });

  await step('a PR that arrives later (the feed file changes) is tracked live, with a toast; others are only offered', async () => {
    writeFeed([...F0, pr(107, 'maya', ['apps/api/routes/users.ts']), pr(108, 'zed', ['apps/api/routes/orders.ts'])]);
    await expectLive(['#101', '#102', '#103', '#105', '#106', '#107'], 'after feed update');
    await page.waitForFunction(() => /new PR tracked by your rules: #107/.test(document.getElementById('toast').textContent), null, { timeout: 5000 });
    await openTrack();
    assert.ok(await row(108).count(), '#108 by zed is offered, not tracked');
    await closeDialog();
  });

  await step('click a file on the map, WATCH FOLDER: its PRs are tracked, rims appear on the whole folder', async () => {
    await clickFile('packages/core/domain/ledger.ts');
    assert.match(await page.textContent('#filebar'), /WATCH FILE.*WATCH FOLDER/s);
    await page.click('#fb-dir');
    await expectLive(['#101', '#102', '#103', '#104', '#105', '#106', '#107'], 'after folder rule');
    assert.match(await page.textContent('.card[data-id="#104"] .via'), /packages\/core\/domain\//);
    assert.match(await page.textContent('.card[data-id="#102"] .via'), /@maya \+1/, 'two rules cover #102');
    assert.match(await page.textContent('#fb-dir'), /STOP WATCHING FOLDER/);
    const snap = await snapshot();
    assert.ok(snap.watch.watchedPaths.length >= 4 && snap.watch.watchedPaths.every((p) => p.startsWith('packages/core/domain/')));
    assert.equal((await sceneInfo()).watched, snap.watch.watchedPaths.length, 'every covered file wears a rim');
    assert.match(await page.textContent('#watchPill'), /WATCHING @maya · packages\/core\/domain\//);
  });

  await step('WATCH FILE watches exactly that file, and the same button turns it off and on again', async () => {
    await clickFile('apps/web/hooks/useAuth.ts');
    await page.click('#fb-file');
    await expectLive(['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#109'], 'after file rule');
    assert.match(await page.textContent('.card[data-id="#109"] .via'), /apps\/web\/hooks\/useAuth\.ts/);
    const rules = (await snapshot()).watch.rules;
    assert.deepEqual(rules.at(-1).files, 1, 'one file, not its neighbours in the folder');
    assert.match(await page.textContent('#fb-file'), /STOP WATCHING FILE/);
    await page.click('#fb-file');
    await expectLive(['#101', '#102', '#103', '#104', '#105', '#106', '#107'], 'after switching the file rule off');
    await page.click('#fb-file');
    await expectLive(['#101', '#102', '#103', '#104', '#105', '#106', '#107', '#109'], 'after switching it on again');
    await page.keyboard.press('Escape');
  });

  await step('Layers: the watched-file rims can be hidden and shown', async () => {
    const on = (await sceneInfo()).watched; assert.ok(on > 0);
    await page.click('#layersBtn');
    await page.uncheck('#l-wmarks');
    assert.equal((await sceneInfo()).watched, 0);
    await page.check('#l-wmarks');
    assert.equal((await sceneInfo()).watched, on);
    await page.keyboard.press('Escape');
  });

  await step('stop tracking a rule-matched PR: it stays off, even when the feed is reloaded', async () => {
    await page.click('.card[data-id="#103"]');
    assert.match(await page.textContent('#focus'), /Author rule: everything by @maya/);
    await page.click('#untrackBtn');
    await expectLive(['#101', '#102', '#104', '#105', '#106', '#107', '#109'], 'after stop tracking');
    writeFeed([...F0, pr(107, 'maya', ['apps/api/routes/users.ts']), pr(108, 'zed', ['apps/api/routes/orders.ts'])]);   // same content, new write
    await page.waitForTimeout(1200);
    assert.ok(!(await liveIds()).includes('#103'));
    await openTrack(); assert.ok(await row(103).count(), 'it is offered again'); await closeDialog();
  });

  await step('PRs that merge, close or leave the feed stay as ended cards; old merges are not dragged in', async () => {
    const f = F0.filter((p) => p.id !== '#105').map((p) => (p.id === '#102' ? { ...p, status: 'merged' } : p));
    writeFeed([...f, pr(107, 'maya', ['apps/api/routes/users.ts']), pr(108, 'zed', ['apps/api/routes/orders.ts']),
      pr(110, 'maya', ['apps/api/routes/old.ts'], { status: 'merged' }), pr(111, 'maya', ['apps/api/routes/older.ts'], { status: 'closed' })]);
    await expectEnded(['#102', '#105'], 'after merge and leave');
    assert.match(await page.textContent('.card[data-id="#102"]'), /MERGED/);
    assert.match(await page.textContent('.card[data-id="#105"]'), /CLOSED/);
    await expectLive(['#101', '#104', '#106', '#107', '#109'], 'live after endings');
    assert.equal((await sceneInfo()).flags, 5, 'ended PRs have no flag on the map');
    assert.ok(!(await page.$('.card[data-id="#110"], .card[data-id="#111"]')), 'rules do not pull in PRs that were already finished');
    await openTrack(); assert.equal(await row(110).count() + await row(111).count(), 0, 'finished PRs are not offered either'); await closeDialog();
  });

  await step('dismiss an ended PR from its card', async () => {
    await page.click('.card[data-id="#105"] .dismiss');
    await expectEnded(['#102'], 'after dismiss');
  });

  await step('restart with the server down while #106 closes: rules, picks, mutes, dismissals and ended cards all survive', async () => {
    await stopServer();
    const f = F0.filter((p) => !['#105', '#106'].includes(p.id)).map((p) => (p.id === '#102' ? { ...p, status: 'merged' } : p));
    writeFeed([...f, pr(107, 'maya', ['apps/api/routes/users.ts']), pr(108, 'zed', ['apps/api/routes/orders.ts'])]);
    await startServer();
    await page.reload();
    await page.waitForSelector('#trackBtn');
    await expectLive(['#101', '#104', '#107', '#109'], 'after restart');
    await expectEnded(['#102', '#106'], 'after restart');
    assert.match(await page.textContent('.card[data-id="#106"]'), /CLOSED/, 'it closed while we were down, and we still noticed');
    assert.ok(!(await liveIds()).includes('#103'), 'the mute on #103 persisted');
    assert.match(await page.textContent('#watchPill'), /@maya/);
    const rules = (await snapshot()).watch.rules.map((r) => r.value);
    assert.deepEqual(rules, ['maya', 'packages/core/domain/', 'apps/web/hooks/useAuth.ts']);
    await page.waitForFunction(() => window.battlemap.state.scene.info().watched > 0);
  });

  await step('Everything in the feed turns opt-in off, and back (a PR you stopped tracking stays off)', async () => {
    await openTrack();
    await page.click('.seg button:has-text("Everything in the feed")');
    await expectLive(['#101', '#104', '#107', '#108', '#109'], 'all mode: the whole open feed, minus the muted #103');
    await page.click('.seg button:has-text("Only what I track")');
    await expectLive(['#101', '#104', '#107', '#109'], 'back to opt-in');
    await closeDialog();
  });

  await step('no page errors', async () => assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`));
} finally { await browser.close(); srv.kill(); }
for (const [s, n] of results) console.log(s, n);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
