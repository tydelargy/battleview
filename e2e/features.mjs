// Browser test of filtering, sorting and age in the PR tray and on the map, against a real server fed by a prs.json.
// Not part of `npm test` (needs Playwright + Chrome); `npm run e2e` runs it after the others.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = 4796, base = `http://127.0.0.1:${port}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-features-e2e-'));
const feedFile = path.join(dir, 'prs.json'), cfgFile = path.join(dir, 'config.json');

// ---- the feed: known ages, sizes, authors and statuses, so every expected order below can be worked out by hand ----
const H = 3600_000, D = 24 * H;
// each PR changes one real file of the sample repo, so it has a building to stand on and a flag on the map
const FILES = ['apps/api/routes/auth.ts', 'apps/api/routes/users.ts', 'apps/api/routes/billing.ts', 'apps/api/routes/orders.ts', 'apps/api/routes/webhooks.ts', 'apps/api/routes/search.ts', 'apps/api/models/user.ts'];
const pr = (n, author, status, openMs, quietMs, add, del, title) => ({
  id: `#${n}`, number: n, title, author, status, branch: `${author}/work-${n}`, createdAt: new Date(Date.now() - openMs).toISOString(), updatedAt: new Date(Date.now() - quietMs).toISOString(),
  files: [{ path: FILES[(n - 201) % FILES.length], add, del }],
});
const FEED = [
  pr(201, 'you', 'ci_failing', 20 * D, 1 * H, 500, 100, 'Billing rewrite'),            // yours, red: needs you
  pr(202, 'devon', 'review_requested', 2 * D, 2 * D, 50, 0, 'Invoice model'),
  pr(203, 'ines', 'draft', 9 * D, 8 * D, 300, 10, 'Onboarding checklist'),
  pr(204, 'you', 'ready_to_merge', 12 * H, 5 * H, 70, 0, 'Session rotation'),           // yours, approved: needs you
  pr(205, 'kofi', 're_review', 3 * D, 1 * D, 400, 90, 'Move API to Fargate'),
  pr(206, 'maya', 'changes_requested', 15 * D, 6 * D, 120, 30, 'Tax rounding fix'),
  pr(207, 'maya', 'review_requested', 1 * D, 3 * H, 20, 5, 'Docs typo'),
];
const writeFeed = (list) => fs.writeFileSync(feedFile, JSON.stringify({ prs: list }));

writeFeed(FEED);
const srv = spawn('node', ['bin/battlemap.js', '--prs', feedFile, '--port', String(port), '--config', cfgFile], { stdio: ['ignore', 'pipe', 'inherit'] });
process.on('exit', () => srv.kill());
await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
await fetch(`${base}/api/watch/mode`, { method: 'PUT', headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'all' }) });   // track everything: this test is about what is shown

const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
let page, shots = 0;
const step = async (name, fn) => {
  try { await fn(); results.push(['ok', name]); }
  catch (e) {
    const shot = path.join(dir, `fail-${++shots}.png`); await page?.screenshot({ path: shot }).catch(() => {});
    results.push(['FAIL', `${name} :: ${e.message.split('\n').slice(0, 3).join(' | ')}  [screenshot ${shot}]`]);
    await page?.keyboard.press('Escape').catch(() => {});
    // start the next step from a clean slate: no stored filters, a fresh page
    await page?.evaluate(() => localStorage.removeItem('bm.filters')).catch(() => {});
    await page?.reload().catch(() => {}); await page?.waitForSelector('.card[data-id]').catch(() => {});
  }
};

// ---- helpers ----
const order = () => page.$$eval('.card[data-id]', (els) => els.map((e) => e.dataset.id));
async function expectOrder(expected, what) {
  try { await page.waitForFunction((exp) => JSON.stringify([...document.querySelectorAll('.card[data-id]')].map((e) => e.dataset.id)) === JSON.stringify(exp), expected, { timeout: 6000 }); }
  catch { throw new Error(`${what}: expected ${JSON.stringify(expected)} but the tray shows ${JSON.stringify(await order())}`); }
}
const openPanel = async () => { if (!(await page.isVisible('#filters'))) { await page.click('#filterBtn'); await page.waitForSelector('#filters', { state: 'visible' }); } };
const closePanel = async () => { if (await page.isVisible('#filters')) { await page.keyboard.press('Escape'); await page.waitForSelector('#filters', { state: 'hidden' }); } };
const chip = (text) => page.locator('#filters .chip', { hasText: text });
// "Needs attention first", worked out by hand from the feed above:
//   tier 0, waiting on us:   #205 (kofi's PR in re-review)
//   tier 1, needs us, the oldest PR first:  #201 (20 days), #202 (2 days), #207 (1 day), #204 (12 hours)
//   tier 3, the rest:  #206 (changes requested: waiting on its author, not on us)
//   tier 4, drafts last:  #203
const DEFAULT = ['#205', '#201', '#202', '#207', '#204', '#206', '#203'];
const NEEDS = ['#205', '#201', '#202', '#207', '#204'];            // everything the "Needs me" chip keeps, in that same order
const sceneInfo = () => page.evaluate(() => window.battlemap.state.scene.info());

try {
  page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(base);
  await page.waitForSelector('.card[data-id]');

  await step('default order: re-reviews waiting on us, then the oldest PRs that need us, then the rest, drafts last; cards show ages and how long a PR has waited', async () => {
    await expectOrder(DEFAULT, 'default');
    assert.match(await page.textContent('.card[data-id="#205"] .why'), /waiting 1d · Author pushed. Re-review/, 'a card in tier 0 says how long it has waited on us, before the reason so it is never cut off');
    assert.doesNotMatch(await page.textContent('.card[data-id="#202"] .why'), /waiting/, 'the others do not');
    assert.match(await page.textContent('.card[data-id="#201"] .m'), /@you · 3w · /, '20 days old shows as 3w');
    assert.match(await page.textContent('.card[data-id="#204"] .m'), /@you · 12h · /);
    assert.match(await page.textContent('.card[data-id="#207"] .m'), /@maya · 1d · /);
    assert.equal(await page.isVisible('#filters'), false);
    assert.match(await page.textContent('#filterBtn'), /^FILTER$/);
  });

  await step('the panel opens from the chip and from "/", lists authors and statuses with counts, and closes with Escape', async () => {
    await page.click('#filterBtn');
    await page.waitForSelector('#filters', { state: 'visible' });
    assert.equal(await page.getAttribute('#filterBtn', 'aria-expanded'), 'true');
    assert.deepEqual(await page.$$eval('#filters .fchips', (boxes) => [...boxes[0].children].map((x) => x.textContent)), ['@devon 1', '@ines 1', '@kofi 1', '@maya 2', '@you 2']);
    assert.deepEqual(await page.$$eval('#filters .fchips', (boxes) => [...boxes[1].children].map((x) => x.textContent)), ['REVIEW 2', 'RE-REVIEW 1', 'CHANGES 1', 'CI RED 1', 'READY 1', 'DRAFT 1']);
    assert.match(await page.textContent('#filters'), /Showing 7 of 7 \(no filters on\)/);
    await page.keyboard.press('Escape'); await page.waitForSelector('#filters', { state: 'hidden' });
    await page.keyboard.press('/');
    await page.waitForSelector('#filters', { state: 'visible' });
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'f-q', '/ puts the cursor in the search box');
    await page.keyboard.press('Escape');
  });

  await step('every sort order', async () => {
    await openPanel();
    const cases = {
      oldest: ['#201', '#206', '#203', '#205', '#202', '#207', '#204'],
      newest: ['#204', '#207', '#202', '#205', '#203', '#206', '#201'],
      updated: ['#201', '#207', '#204', '#205', '#202', '#206', '#203'],
      quiet: ['#203', '#206', '#202', '#205', '#204', '#207', '#201'],
      size: ['#201', '#205', '#203', '#206', '#204', '#202', '#207'],
      author: ['#202', '#203', '#205', '#207', '#206', '#201', '#204'],      // maya: #207 needs you, #206 does not; you: #201 is the older PR
      attention: DEFAULT,
    };
    for (const [sort, expected] of Object.entries(cases)) { await page.selectOption('#f-sort', sort); await expectOrder(expected, `sort ${sort}`); }
    await page.selectOption('#f-sort', 'oldest');
    assert.match(await page.textContent('#filterBtn'), /FILTER · OPEN LONGEST/, 'the chip says how it is sorted');
    assert.match(await page.textContent('#f-sort-help'), /Longest since the PR was opened/, 'and the panel says what that means');
    await page.selectOption('#f-sort', 'attention');
    assert.match(await page.textContent('#f-sort-help'), /Re-reviews waiting longest.*oldest PRs that need you.*Drafts go last/);
    await page.selectOption('#f-sort', 'oldest');
    await closePanel();
  });

  await step('the sort survives a reload; filters hide nothing until chosen', async () => {
    await page.reload(); await page.waitForSelector('.card[data-id]');
    await expectOrder(['#201', '#206', '#203', '#205', '#202', '#207', '#204'], 'sorted after reload');
    await openPanel(); assert.equal(await page.inputValue('#f-sort'), 'oldest');
    await page.selectOption('#f-sort', 'attention'); await closePanel();
    await expectOrder(DEFAULT, 'back to default');
  });

  await step('search: every word must match, in the title, author, number or branch; the box keeps focus while you type', async () => {
    await openPanel();
    await page.focus('#f-q'); await page.keyboard.type('tax', { delay: 20 });
    await expectOrder(['#206'], 'tax');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'f-q', 'typing was not interrupted by a re-render');
    await page.fill('#f-q', 'MAYA docs'); await expectOrder(['#207'], 'two words, any case');
    await page.fill('#f-q', 'kofi/work'); await expectOrder(['#205'], 'branch');
    await page.fill('#f-q', '#203'); await expectOrder(['#203'], 'number');
    assert.match(await page.textContent('#filterBtn'), /FILTER · 1/); assert.match(await page.textContent('#sub'), /showing 1/);
    await page.fill('#f-q', ''); await expectOrder(DEFAULT, 'cleared');
    await closePanel();
  });

  await step('authors: pick one or several; clicking a chosen author again clears it', async () => {
    await openPanel();
    await chip('@maya').click(); await expectOrder(['#207', '#206'], 'maya: #207 needs you, #206 does not');
    await chip('@ines').click(); await expectOrder(['#207', '#206', '#203'], 'maya or ines: the draft goes last');
    assert.equal(await chip('@maya').getAttribute('aria-pressed'), 'true');
    await chip('@maya').click(); await expectOrder(['#203'], 'ines only');
    await chip('@ines').click(); await expectOrder(DEFAULT, 'none');
    await closePanel();
  });

  await step('status chips', async () => {
    await openPanel();
    await chip('CI RED').click(); await expectOrder(['#201'], 'red CI');
    await chip('DRAFT').click(); await expectOrder(['#201', '#203'], 'red CI or draft');
    await chip('CI RED').click(); await chip('DRAFT').click();
    await closePanel();
  });

  await step('age: open for at least, quiet for at least', async () => {
    await openPanel();
    await page.selectOption('#f-open', '7'); await expectOrder(['#201', '#206', '#203'], 'open 1 week+ (the draft last)');
    await page.selectOption('#f-open', '0'); await page.selectOption('#f-quiet', '3'); await expectOrder(['#206', '#203'], 'quiet 3 days+ (the draft last)');
    await page.selectOption('#f-open', '14'); await expectOrder(['#206'], 'open 2 weeks+ AND quiet 3 days+: #201 is 20 days old but was updated an hour ago; only #206 passes both');
    await page.selectOption('#f-open', '0'); await page.selectOption('#f-quiet', '0');
    await closePanel();
  });

  await step('filters combine, an empty result says why and offers a way out, and one click clears everything', async () => {
    await openPanel();
    await chip('@maya').click(); await page.selectOption('#f-open', '7');
    await expectOrder(['#206'], 'maya AND open a week+');
    await chip('@maya').click(); await chip('@kofi').click(); await chip('DRAFT').click();
    await expectOrder([], 'kofi AND draft');
    const msg = await page.textContent('#cards .empty');
    assert.match(msg, /Nothing matches/); assert.match(msg, /@kofi/); assert.match(msg, /draft/); assert.match(msg, /open for 7\+ days/);
    assert.equal((await sceneInfo()).flags, 0, 'the map is empty too');
    await page.click('#clearFilters');
    await expectOrder(DEFAULT, 'after Clear filters');
    assert.equal(await page.inputValue('#f-open'), '0');
    await closePanel();
  });

  await step('"Needs me" is the same model: it combines with the panel and shows in the header', async () => {
    await page.click('.chip:has-text("Needs me")'); await expectOrder(NEEDS, 'needs me');
    assert.match(await page.textContent('#sub'), /showing 5/);
    await openPanel(); await chip('@you').click(); await page.selectOption('#f-sort', 'oldest'); await expectOrder(['#201', '#204'], 'needs me, by you, oldest first');
    await chip('@you').click(); await page.selectOption('#f-sort', 'attention'); await closePanel();
    await page.click('.chip:has-text("Needs me")'); await expectOrder(DEFAULT, 'off again');
  });

  await step('the map shows exactly what the tray shows', async () => {
    assert.equal((await sceneInfo()).flags, 7);
    await openPanel(); await chip('@maya').click();
    await page.waitForFunction(() => window.battlemap.state.scene.info().flags === 2);
    await chip('@maya').click(); await page.waitForFunction(() => window.battlemap.state.scene.info().flags === 7);
    await closePanel();
  });

  await step('raising flags by age: the old PR stands taller, the new one hardly moves, and it can be switched off', async () => {
    const top = (n) => page.evaluate((id) => [...document.querySelectorAll('.flag')].find((f) => f.getAttribute('aria-label').startsWith(id))?.getBoundingClientRect().top, `#${n}`);
    await page.waitForTimeout(600);
    const [old0, fresh0] = [await top(201), await top(204)];
    await page.click('#layersBtn'); await page.check('#l-agelift'); await page.click('#layersBtn');
    await page.waitForTimeout(900);
    const [old1, fresh1] = [await top(201), await top(204)];
    assert.ok(old0 - old1 > 15, `the 20-day-old PR's flag rose (${old0} to ${old1})`);
    assert.ok(old0 - old1 > (fresh0 - fresh1) + 8, 'more than the 12-hour-old one did');
    await page.click('#layersBtn'); await page.uncheck('#l-agelift'); await page.click('#layersBtn');
    await page.waitForTimeout(900);
    assert.ok(Math.abs((await top(201)) - old0) < 3, 'back where it was');
    await page.keyboard.press('Escape');
  });

  await step('from a PR, one click shows only its author', async () => {
    await page.click('.card[data-id="#206"]');
    await page.click('#onlyAuthor');
    await expectOrder(['#207', '#206'], 'maya only');
    await page.keyboard.press('Escape');
    await openPanel(); await page.click('#f-clear'); await closePanel();
    await expectOrder(DEFAULT, 'cleared');
  });

  await step('filters persist across a reload, and a chosen filter is visible on the chip', async () => {
    await openPanel(); await chip('@devon').click(); await page.selectOption('#f-quiet', '1'); await closePanel();
    await expectOrder(['#202'], 'devon, quiet a day+');
    await page.reload(); await page.waitForSelector('#filterBtn');
    await expectOrder(['#202'], 'after reload');
    assert.match(await page.textContent('#filterBtn'), /FILTER · 2/);
    await openPanel(); await page.click('#f-clear'); await closePanel();
  });

  await step('needs attention: unaddressed comments on our own PR rank with re-reviews; ours first on a close call, the longer wait first beyond it', async () => {
    const withWaits = (w204, w205) => FEED.map((p) => (p.id === '#204' ? { ...p, waitingSince: new Date(Date.now() - w204 * H).toISOString() } : p.id === '#205' ? { ...p, waitingSince: new Date(Date.now() - w205 * H).toISOString() } : p));
    // #204 is ours and has unaddressed comments (waiting 72h); #205 is kofi's re-review (waiting 74h): inside the same six hours, so ours comes first
    writeFeed(withWaits(72, 74));
    await expectOrder(['#204', '#205', '#201', '#202', '#207', '#206', '#203'], 'close call: ours first');
    assert.match(await page.textContent('.card[data-id="#204"] .why'), /waiting 3d/, 'our own PR now says how long its comments have waited');
    // the re-review has waited five days against our three: clearly longer, so it goes first
    writeFeed(withWaits(72, 120));
    await expectOrder(['#205', '#204', '#201', '#202', '#207', '#206', '#203'], 'beyond the window: the longer wait first');
    assert.match(await page.textContent('.card[data-id="#205"] .why'), /waiting 5d/);
    writeFeed(FEED);
    await expectOrder(DEFAULT, 'back to the plain feed');
  });

  await step('hostile author names and titles are text everywhere in the filter UI', async () => {
    const evilAuthor = '<img src=x onerror="window.__pwned=1">', evilTitle = '<b>bold</b>';
    writeFeed([...FEED, pr(208, evilAuthor, 'review_requested', 1 * D, 1 * D, 5, 5, evilTitle)]);
    await page.waitForSelector('.card[data-id="#208"]');
    await openPanel();
    await page.waitForFunction((a) => [...document.querySelectorAll('#filters .chip')].some((c) => c.textContent.includes(a)), evilAuthor);
    await chip(evilAuthor).click();
    await expectOrder(['#208'], 'the hostile author, as a filter');
    assert.match(await page.textContent('#cards .t'), /<b>bold<\/b>/);
    await page.fill('#f-q', 'zzzz-nothing');
    await expectOrder([], 'no match');
    assert.match(await page.textContent('#cards .empty'), /<img src=x/, 'the explanation shows the author as text');
    assert.equal(await page.evaluate(() => window.__pwned), undefined);
    assert.equal(await page.$$eval('#filters img, #cards img, #chips img, #filters b, #cards .empty b', (e) => e.length), 0);
    await page.click('#f-clear'); await page.fill('#f-q', ''); await closePanel();
  });

  await step('building styles: Plain, Colours and Buildings; reshuffle changes codes; saved across a reload; codes show in the file bar', async () => {
    const info = () => page.evaluate(() => window.battlemap.state.scene.buildingInfo('apps/api/routes/auth.ts'));
    await page.click('#layersBtn'); await page.waitForSelector('#l-buildings');
    const style = (t) => page.locator('#l-buildings .seg button', { hasText: t });
    assert.equal(await style('Buildings').getAttribute('aria-pressed'), 'true', 'the full style is the default');
    const code = (await info()).code; assert.match(code, /^[A-Z]-\d\d$/);
    await style('Plain').click(); assert.equal(await page.locator('#b-spread').count(), 0, 'plain has no tuning');
    await style('Colours').click(); await page.waitForSelector('#b-spread'); assert.equal(await page.locator('#b-dens').count(), 0, 'windows only in the full style');
    await style('Buildings').click(); await page.waitForSelector('#b-dens');
    await page.click('#b-shuffle'); const after = (await info()).code; assert.notEqual(after, code, 'a new shuffle re-rolls the code');
    await page.reload(); await page.waitForSelector('.card'); await page.waitForTimeout(1500);
    assert.equal((await info()).code, after, 'the shuffle survives a reload');
    await page.click('#layersBtn'); await page.waitForSelector('#l-buildings');
    await page.locator('#l-buildings .seg button', { hasText: 'Plain' }).click();
    assert.equal((await info()).shape, 'block', 'plain is all blocks');
    await page.locator('#l-buildings .seg button', { hasText: 'Buildings' }).click();
    // the focused-PR diff view: four choices, Crates by default, remembered across a reload
    const focus = (t) => page.locator('#l-buildings .seg[aria-label="Focused PR diff style"] button', { hasText: t });
    await page.waitForSelector('#l-buildings');   // the panel is still open from the steps above
    assert.equal(await focus('Crates').getAttribute('aria-pressed'), 'true', 'crates by default');
    for (const t of ['File', 'Frames', 'Facade', 'Crates']) { await focus(t).click(); assert.equal(await focus(t).getAttribute('aria-pressed'), 'true', t); await page.waitForTimeout(150); }
    await focus('File').click(); await page.reload(); await page.waitForSelector('.card'); await page.waitForTimeout(1200);
    await page.click('#layersBtn'); await page.waitForSelector('#l-buildings');
    assert.equal(await focus('File').getAttribute('aria-pressed'), 'true', 'the choice survives a reload');
    await focus('Crates').click();
    await page.click('#layersBtn'); await page.waitForSelector('#layers', { state: 'hidden' });
  });

  await step('no page errors', async () => assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`));
} finally { await browser.close(); srv.kill(); }
for (const [s, n] of results) console.log(s, n);
process.exit(results.some(([s]) => s === 'FAIL') ? 1 : 0);
