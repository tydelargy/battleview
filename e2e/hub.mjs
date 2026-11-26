// The world view, end to end, in real Chrome against a real hub. `gh` is a stand-in script, so nothing touches the network
// and, as in real life, nothing is ever cloned.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const port = 4852, base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-hub-e2e-'));
const data = path.join(dir, 'data'), cfg = path.join(dir, 'config.json'), fake = path.join(dir, 'gh'), shots = process.env.SHOTS_DIR || null;
fs.writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2), line = a.join(' ');
const repo = (line.match(/repos\\/([^/\\s]+\\/[^/\\s?]+)/) || line.match(/--repo (\\S+)/) || [])[1];
const files = (n) => { const dirs = ['src/api', 'src/ui', 'lib/core', 'docs', 'tools', 'test']; return Array.from({ length: n }, (_, i) => ({ path: dirs[i % dirs.length] + '/file' + i + '.ts', type: 'blob', size: 600 + ((i * 7919) % 9000) })); };
const sizes = { 'org/alpha': 70, 'org/beta': 45, 'org/gamma': 90, 'org/delta': 30, 'org/epsilon': 55 };
if (/^api user/.test(line)) process.stdout.write('maya\\n');
else if (/^api graphql/.test(line)) { const nums = [...line.matchAll(/pr(\\d+):/g)].map((m) => m[1]); const r = {}; for (const n of nums) r['pr' + n] = { timelineItems: { nodes: [] } }; process.stdout.write(JSON.stringify({ data: { repository: r } })); }
else if (/^api repos\\/[^/]+\\/[^/\\s]+ --jq/.test(line)) { if (repo === 'org/ghost') { process.stderr.write('HTTP 404: Not Found'); process.exit(1); } process.stdout.write(JSON.stringify({ default_branch: 'main', private: false })); }
else if (/git\\/trees\\//.test(line)) process.stdout.write(JSON.stringify({ truncated: false, tree: files(sizes[repo] || 40) }));
else if (/^pr list/.test(line)) {
  const open = /--state open/.test(line), pr = (n, who, o = {}) => ({ number: n, title: 'Change ' + n, author: { login: who }, isDraft: false, reviewDecision: '', statusCheckRollup: [], reviewRequests: [], latestReviews: [], headRefOid: 'sha' + n, headRefName: 'b' + n, createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-20T00:00:00Z', url: 'https://github.com/' + repo + '/pull/' + n, files: [{ path: 'src/api/file0.ts', additions: 12, deletions: 3 }], ...o });
  const all = { 'org/alpha': [pr(1, 'maya', { statusCheckRollup: [{ conclusion: 'FAILURE', status: 'COMPLETED' }] }), pr(2, 'devon', { reviewRequests: [{ login: 'maya' }] }), pr(3, 'ines')], 'org/beta': [pr(7, 'maya')], 'org/gamma': [pr(9, 'kofi', { reviewRequests: [{ login: 'maya' }] })] };
  process.stdout.write(JSON.stringify(open ? (all[repo] || []) : []));
} else { process.stderr.write('unexpected: ' + line); process.exit(1); }
`);
fs.chmodSync(fake, 0o755);

const srv = spawn('node', ['bin/battlemap.js', '--port', String(port), '--data', data, '--config', cfg, '--gh', fake], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map/.test(String(d)) && r()));
process.on('exit', () => srv?.kill());
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = []; let page, n = 0;
const step = async (name, fn) => { try { await fn(); results.push(['ok', name]); } catch (e) { const shot = path.join(dir, `fail-${++n}.png`); await page?.screenshot({ path: shot }).catch(() => {}); results.push(['FAIL', `${name} :: ${e.message.split('\n').slice(0, 3).join(' | ')}  [screenshot ${shot}]`]); } };
// a hover only registers when the pointer actually moves, so approach the target from beside it
const hover = async (p) => { await page.mouse.move(p.sx + 30, p.sy + 30); await page.mouse.move(p.sx, p.sy, { steps: 3 }); };
const worldApi = () => fetch(`${base}/api/hub/world`).then((r) => r.json());
const info = () => page.evaluate(() => window.battlemap.world.info());
const screen = (hex) => page.evaluate((h) => window.battlemap.world.world().hexScreen(h), hex);
const waitFor = (fn, arg, what, ms = 8000) => page.waitForFunction(fn, arg, { timeout: ms }).catch(async () => { throw new Error(`timed out: ${what} (${JSON.stringify(await info().catch(() => null))})`); });
async function addAt(hex, repo) {
  const p = await screen(hex); await hover(p); await waitFor(() => !document.getElementById('wplus').hidden, null, 'the + appears on a hovered free hex');
  await page.click('#wplus'); await page.fill('#wadd-url', repo); await page.click('#wadd-go');
}

try {
  page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base + '/'); await page.waitForSelector('#world:not([hidden]) canvas'); await page.waitForTimeout(1200);

  await step('an empty world offers one glowing hex; hovering it shows a + and pressing it asks for a repo URL', async () => {
    assert.equal((await info()).cities, 0); assert.equal((await info()).slots, 1);
    assert.match(await page.textContent('#wtray'), /No repos yet[\s\S]*first repo/);
    const p = await screen({ q: 0, r: 0 }); await page.mouse.move(p.sx, p.sy);
    await waitFor(() => !document.getElementById('wplus').hidden, null, 'the + shows');
    await page.click('#wplus'); await page.waitForSelector('#wadd-url');
    await page.fill('#wadd-url', 'org/ghost'); await page.click('#wadd-go');
    await page.waitForFunction(() => /404|Not Found/.test(document.getElementById('wadd-msg').textContent), null, { timeout: 8000 });
    assert.equal((await worldApi()).cities.length, 0, 'a failed add leaves nothing behind');
    await page.click('#wadd-cancel'); assert.equal(await page.$('#wadd'), null);
  });

  await step('adding a repo by URL builds a city from the remote: no clone, with its numbers', async () => {
    await addAt({ q: 0, r: 0 }, 'https://github.com/org/alpha');
    await waitFor(() => window.battlemap.world.info().cities === 1, null, 'the city appears');
    assert.ok((await info()).boxes > 60, 'it has buildings');
    await waitFor(() => document.querySelector('.wcard[data-id="org--alpha"] .ws.needs b')?.textContent.includes('3'), null, 'needs-action shows once the numbers arrive');
    const w = await worldApi(), c = w.cities[0];
    assert.deepEqual([c.stats.open, c.stats.mine, c.stats.needs], [3, 1, 3], 'three open, one yours, and all three need you: your red CI, a review asked of you, and a review request nobody has answered');
    assert.equal(fs.existsSync(path.join(data, 'cities', 'org--alpha', 'tree.json')), true);
    assert.equal(fs.readdirSync(path.join(data, 'cities', 'org--alpha')).some((f) => f === '.git'), false, 'there is no checkout');
  });

  await step('more cities go on neighbouring hexes only, and every city keeps touching another', async () => {
    let w = await worldApi();
    await addAt(w.slots[0], 'org/beta'); await waitFor(() => window.battlemap.world.info().cities === 2, null, 'second city');
    w = await worldApi(); await addAt(w.slots[1], 'org/gamma'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'third city');
    w = await worldApi(); assert.equal(w.cities.length, 3);
    const keys = new Set(w.cities.map((c) => `${c.q},${c.r}`)); assert.equal(keys.size, 3);
    for (const c of w.cities) assert.ok(w.cities.some((o) => o !== c && Math.max(Math.abs(o.q - c.q), Math.abs(o.r - c.r), Math.abs(o.q + o.r - c.q - c.r)) === 1), `${c.id} touches another city`);
    assert.ok(w.slots.length >= 6);
  });

  await step('hovering a city shows its three numbers, a click goes in, and the back button returns', async () => {
    const w = await worldApi(), a = w.cities.find((c) => c.id === 'org--alpha'), p = await screen(a);
    await hover(p); await waitFor(() => document.querySelector('.wcard[data-id="org--alpha"]')?.classList.contains('hot'), null, 'pointing at a city lights up its card');
    assert.equal((await info()).cards, 3, 'every repo has a card, not just the last one touched');
    const t = await page.textContent('.wcard[data-id="org--alpha"]'); assert.match(t, /Tracking/); assert.match(t, /Yours/); assert.match(t, /Need action/);
    assert.equal(await page.textContent('.wcard[data-id="org--alpha"] .ws.mine b'), '1'); assert.equal(await page.textContent('.wcard[data-id="org--alpha"] .ws.needs b'), '3');
    assert.equal((await info()).selected, 'org--gamma', 'adding a repo opens its card'); await page.click('.wcard[data-id="org--gamma"] .whead'); assert.equal(await page.$('#ws-go'), null, 'a card closes again, back to compact');
    await page.click('.wcard[data-id="org--alpha"] .whead'); await page.waitForSelector('.wcard[data-id="org--alpha"].open #ws-go'); assert.equal((await info()).cards, 3, 'opening one keeps the others in reach');
    await page.click('.wcard[data-id="org--beta"] .whead'); await page.waitForSelector('.wcard[data-id="org--beta"].open'); assert.equal(await page.$('.wcard[data-id="org--alpha"].open'), null, 'one open at a time');
    await page.click('.wcard[data-id="org--beta"] .whead'); assert.equal(await page.$('#ws-go'), null, 'and it closes again');
    await page.mouse.move(p.sx + 30, p.sy + 30);
    await page.mouse.click(p.sx, p.sy);
    await page.waitForSelector('body.in-city .card', { timeout: 10000 });
    assert.match(await page.textContent('#sub'), /org\/alpha · sizes estimated/);
    assert.match(page.url(), /#\/r\/org--alpha$/);
    await waitFor(() => document.querySelectorAll('.card[data-id]').length >= 1, null, 'its own PR is tracked once you are in');
    assert.equal(await page.isVisible('#worldBtn'), true);
    await page.click('#worldBtn'); await page.waitForSelector('#world:not([hidden]) canvas'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'back in the world');
    const after = await worldApi(); assert.equal(after.cities.find((c) => c.id === 'org--alpha').stats.tracked >= 1, true, 'the world now knows it is tracking a PR there');
  });

  await step('dragging a city: onto a free hex beside the group it moves; anywhere else it springs back', async () => {
    let w = await worldApi();
    const mover = w.cities.find((c) => c.id === 'org--gamma'), legal = await page.evaluate((id) => window.battlemap.world.world().legal(id), mover.id);
    assert.ok(legal.length > 0, 'there is somewhere legal to go');
    const from = await screen(mover), to = await screen(legal[0]);
    await page.mouse.move(from.sx, from.sy); await page.mouse.down(); await page.mouse.move((from.sx + to.sx) / 2, (from.sy + to.sy) / 2, { steps: 5 }); await page.mouse.move(to.sx, to.sy, { steps: 6 }); await page.mouse.up();
    await waitFor(([id, q, r]) => fetch('/api/hub/world').then((x) => x.json()).then((w2) => { const c = w2.cities.find((y) => y.id === id); return c.q === q && c.r === r; }), [mover.id, legal[0].q, legal[0].r], 'the city moved');
    w = await worldApi(); const c2 = w.cities.find((c) => c.id === mover.id), before = `${c2.q},${c2.r}`;
    const f2 = await screen(c2); await page.mouse.move(f2.sx, f2.sy); await page.mouse.down(); await page.mouse.move(f2.sx + 600, f2.sy - 300, { steps: 8 }); await page.mouse.up(); await page.waitForTimeout(500);
    const c3 = (await worldApi()).cities.find((c) => c.id === mover.id); assert.equal(`${c3.q},${c3.r}`, before, 'dropped nowhere: it stays');
    assert.equal(await page.url().includes('#/r/'), false, 'a drag is not a click');
  });

  await step('the layout is remembered: after a reload and after the server restarts', async () => {
    const before = (await worldApi()).cities.map((c) => `${c.id}@${c.q},${c.r}`).sort();
    await page.reload(); await page.waitForSelector('#world:not([hidden]) canvas'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'reload');
    srv.kill('SIGTERM'); await new Promise((r) => srv.once('exit', r));
    const again = spawn('node', ['bin/battlemap.js', '--port', String(port), '--data', data, '--config', cfg, '--gh', fake], { stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((r) => again.stdout.on('data', (d) => /Battle Map/.test(String(d)) && r())); process.on('exit', () => again.kill());
    assert.deepEqual((await worldApi()).cities.map((c) => `${c.id}@${c.q},${c.r}`).sort(), before);
  });

  await step('forgetting a city asks twice and removes it and its saved state', async () => {
    await page.reload(); await page.waitForSelector('#world:not([hidden]) canvas'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'loaded');
    const w = await worldApi(), cities = w.cities, forgettable = cities.find((c) => cities.filter((o) => o !== c).every((o) => cities.filter((x) => x !== c).some((x) => x !== o && Math.max(Math.abs(o.q - x.q), Math.abs(o.r - x.r), Math.abs(o.q + o.r - x.q - x.r)) === 1))) || cities[0];
    await page.click(`.wcard[data-id="${forgettable.id}"] .whead`); await page.waitForSelector('#ws-forget');
    await page.click('#ws-forget'); assert.match(await page.textContent('#ws-forget'), /SURE/); await page.click('#ws-forget');
    await waitFor(() => window.battlemap.world.info().cities === 2, null, 'gone');
    assert.equal(fs.existsSync(path.join(data, 'cities', forgettable.id)), false);
  });

  await step('hostile repo names are text everywhere', async () => {
    const w = await worldApi(); const p = await screen(w.slots[0]); await page.mouse.move(p.sx, p.sy);
    await waitFor(() => !document.getElementById('wplus').hidden, null, 'plus');
    await page.click('#wplus'); await page.fill('#wadd-url', '<img src=x onerror="window.__pwned=1">/x'); await page.click('#wadd-go');
    await page.waitForFunction(() => /does not look like a repository/.test(document.getElementById('wadd-msg').textContent), null, { timeout: 6000 });
    assert.equal(await page.$$eval('#wadd img, #wtray img', (e) => e.length), 0); assert.equal(await page.evaluate(() => window.__pwned), undefined);
    await page.click('#wadd-cancel');
  });

  if (shots) await step('screenshot', async () => {
    const w = await worldApi(); for (const slot of w.slots.slice(0, 1)) await addAt(slot, 'org/delta'); await waitFor(() => window.battlemap.world.info().cities === 3, null, 'fourth');
    const w2 = await worldApi(); await addAt(w2.slots[2], 'org/epsilon'); await waitFor(() => window.battlemap.world.info().cities === 4, null, 'fifth');
    await page.waitForTimeout(1500); const a = (await worldApi()).cities.find((c) => c.stats.needs) || (await worldApi()).cities[0]; const p = await screen(a); await page.mouse.move(p.sx, p.sy); await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(shots, 'world.png') });
  });

  await step('no page errors', async () => assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`));
} finally { await browser.close(); srv.kill(); }
for (const [s, m] of results) console.log(s, m);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
