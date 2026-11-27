// The mock, the way you would try it: `npm run mock` opens the world, you add a second fake repo to a free hex, go into that
// city and track some work, and the world remembers. Real Chrome, the real app with the demo GitHub and the mock Jira.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const port = 4861, base = `http://127.0.0.1:${port}`, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-demo-e2e-'));
const srv = spawn('node', ['bin/battlemap.js', '--demo', '--mock-jira', '--port', String(port), '--mock-port', '4862', '--config', path.join(dir, 'config.json')], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
process.on('exit', () => srv?.kill());
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = []; let page, n = 0;
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (e) { const shot = path.join(dir, `fail-${++n}.png`); await page?.screenshot({ path: shot }).catch(() => {}); results.push(['FAIL', `${name} :: ${e.message.split('\n').slice(0, 3).join(' | ')}  [screenshot ${shot}]`]); } };
const world = () => fetch(`${base}/api/hub/world`).then((r) => r.json());
const info = () => page.evaluate(() => window.battlemap.world.info());
const screen = (hex) => page.evaluate((h) => window.battlemap.world.world().hexScreen(h), hex);
const waitFor = (fn, arg, what, ms = 9000) => page.waitForFunction(fn, arg, { timeout: ms }).catch(() => { throw new Error(`timed out: ${what}`); });
async function addAt(hex, repo) {
  const p = await screen(hex); await page.mouse.move(p.sx, p.sy); await waitFor(() => !document.getElementById('wplus').hidden, null, 'the + shows on a free hex');
  await page.click('#wplus'); await page.fill('#wadd-url', repo); await page.click('#wadd-go');
}

try {
  page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/'); await page.waitForSelector('#world:not([hidden]) canvas'); await page.waitForTimeout(1500);

  await step('the mock opens on the world: one city (acme/platform) is already there, with free hexes beside it', async () => {
    assert.equal((await info()).cities, 1); const w = await world(); assert.equal(w.cities[0].key, 'acme/platform'); assert.ok(w.slots.length >= 6);
    assert.match(await page.textContent('#wtray'), /acme\/platform/, 'it has a card');
    await waitFor(() => /\d/.test(document.querySelector('.wcard[data-id="acme--platform"] .ws.needs b')?.textContent || ''), null, 'numbers arrive');
    assert.equal(await page.isVisible('#worldBtn'), false, 'the back button is only inside a city');
  });

  await step('adding the second fake repo to a free hex; a made-up repo is refused with a hint', async () => {
    let w = await world(), p = await screen(w.slots[0]); await page.mouse.move(p.sx, p.sy);
    await waitFor(() => !document.getElementById('wplus').hidden, null, 'plus'); await page.click('#wplus'); await page.fill('#wadd-url', 'acme/nope'); await page.click('#wadd-go');
    await page.waitForFunction(() => /try acme\/platform or acme\/billing-api or acme\/mobile-app or acme\/storefront/.test(document.getElementById('wadd-msg').textContent), null, { timeout: 8000 });
    await page.click('#wadd-cancel');
    await addAt(w.slots[0], 'https://github.com/acme/billing-api');
    await waitFor(() => window.battlemap.world.info().cities === 2, null, 'billing-api appears');
    w = await world(); const b = w.cities.find((c) => c.key === 'acme/billing-api'); assert.ok(b); assert.equal(b.files, 25); assert.equal(b.estimated, true);
    await addAt(w.slots[1], 'acme/mobile-app'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'mobile-app appears');
  });

  await step('going into the new city: its own map, its own PRs, your PRs tracked, the mock Jira linked', async () => {
    const b = (await world()).cities.find((c) => c.key === 'acme/billing-api'), p = await screen(b);
    assert.equal((await info()).cards, 3, 'all three repos have a card');
    await waitFor(() => document.querySelector('.wcard[data-id="acme--billing-api"] .ws.mine b')?.textContent === '3', null, 'its numbers are on its card');
    await page.mouse.click(p.sx, p.sy); await page.waitForSelector('body.in-city .card[data-id]', { timeout: 12000 });
    assert.match(await page.textContent('#sub'), /acme\/billing-api · sizes estimated/);
    await waitFor(() => document.querySelectorAll('.card[data-id]').length === 3, null, 'only your three PRs are tracked at first');
    const ids = await page.$$eval('.card[data-id]', (c) => c.map((x) => x.dataset.id).sort()); assert.deepEqual(ids, ['#121', '#127', '#136']);
    await waitFor(() => /ENG-433 · In Progress/.test(document.querySelector('.card[data-id="#121"] .tk')?.textContent || ''), null, 'the mock Jira ticket on #121', 12000);
  });

  await step('tracking some work: a teammate\'s PR by number, then the cards, the count and the map follow', async () => {
    await page.click('#trackBtn'); await page.waitForSelector('#t-link'); await page.fill('#t-link', '#118'); await page.keyboard.press('Enter');
    await waitFor(() => !!document.querySelector('.card[data-id="#118"]'), null, '#118 is tracked');
    await page.keyboard.press('Escape');
    const snap = await fetch(`${base}/r/acme--billing-api/api/snapshot`).then((r) => r.json()); assert.deepEqual(snap.prs.map((p) => p.id).sort(), ['#118', '#121', '#127', '#136']);
    assert.equal(snap.files.length, 25); assert.ok(snap.watch.availableTotal >= 4, 'the other PRs are offered, not tracked');
    await page.click('.card[data-id="#118"]'); await page.waitForSelector('#focus .files .frow'); assert.match(await page.textContent('#focus'), /src\/tax\/round\.ts/);
    await page.keyboard.press('Escape');
  });

  await step('back in the world, the city knows what is tracked, and the other cities are untouched', async () => {
    await page.click('#worldBtn'); await page.waitForSelector('#world:not([hidden]) canvas'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'world');
    const w = await world(), b = w.cities.find((c) => c.key === 'acme/billing-api'), m = w.cities.find((c) => c.key === 'acme/mobile-app');
    const card = '.wcard[data-id="acme--billing-api"]';
    await waitFor(() => document.querySelector('.wcard[data-id="acme--billing-api"] .ws.tracking b')?.textContent === '4', null, 'tracking 4');
    assert.equal(await page.textContent(`${card} .ws.mine b`), '3'); assert.equal(await page.textContent(`${card} .ws.needs b`), '5');
    await page.click(`${card} .whead`); await page.waitForSelector(`${card}.open #ws-go`); assert.match(await page.textContent(card), /sizes are estimated/i, 'the card says the sizes are estimates');
    assert.equal(m.stats.tracked, 0, 'mobile-app has not been opened'); let got = 0; for (let i = 0; i < 40 && got !== 1; i++) { got = (await fetch(`${base}/r/acme--mobile-app/api/snapshot`).then((r) => r.json())).prs.length; if (got !== 1) await new Promise((r) => setTimeout(r, 200)); }
    assert.equal(got, 1, 'going into it shows its own PRs, with only yours tracked');
  });

  await step('the demo saves nothing it should not: the layout is kept while it runs, and a reload shows the same world', async () => {
    const before = (await world()).cities.map((c) => `${c.key}@${c.q},${c.r}`).sort();
    await page.reload(); await page.waitForSelector('#world:not([hidden]) canvas'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'reload');
    assert.deepEqual((await world()).cities.map((c) => `${c.key}@${c.q},${c.r}`).sort(), before);
  });

  await step('a PR on an old base says so, quietly: how far behind, that it conflicts, and what the target did to its files', async () => {
    const w = await world(); await addAt(w.slots[0], 'acme/storefront'); await waitFor(() => window.battlemap.world.info().cities === 4, null, 'storefront appears');
    const c = (await world()).cities.find((x) => x.key === 'acme/storefront'), p = await screen(c);
    await page.mouse.click(p.sx, p.sy); await page.waitForSelector('body.in-city', { timeout: 12000 });
    let n = 0; for (let i = 0; i < 40 && n !== 16; i++) { n = (await fetch(`${base}/r/acme--storefront/api/snapshot`).then((r) => r.json())).files.length; if (n !== 16) await new Promise((r) => setTimeout(r, 200)); } assert.equal(n, 16, 'its map');
    await fetch(`${base}/r/acme--storefront/api/watch/pick`, { method: 'POST', headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: '#301' }) });
    await page.waitForSelector('.card[data-id="#301"]', { timeout: 12000 }); await page.click('.card[data-id="#301"]'); await page.waitForSelector('#focus [data-base-note]');
    const notes = await page.$$eval('#focus [data-base-note]', (n) => n.map((x) => x.textContent)); assert.deepEqual(notes, ['41 commits behind main', 'Conflicts with main']);
    assert.deepEqual(await page.$$eval('#focus .chg.warn', (n) => n.map((x) => x.textContent)), ['MOVED ON BASE', 'MOVED ON BASE']);
    await page.keyboard.press('Escape'); await page.click('.card[data-id="#301"]'); await page.keyboard.press('Escape');
  });

  await step('no page errors', async () => assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`));
} finally { await browser.close(); srv.kill(); }
for (const [s, m] of results) console.log(s, m);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
