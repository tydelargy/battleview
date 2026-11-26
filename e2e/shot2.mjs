// Renders the README screenshots against the mock Jira. Needs Playwright + Chrome with software WebGL.
//   SHOTS_DIR=docs/screenshots node e2e/shot2.mjs shot:overview
// Steps run in order:
//   click:<selector>   wait:<ms>   view:<2d|iso|3d>   file:<path> (fly to a file)   eval:<js>
//   feed:<sample|sample-without-#id>   post the sample PRs as a real feed (switches the map to opt-in tracking)
//   rule:<author|path>:<value>   pick:<ref>   shot:<name>   info
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { samplePRs } from '../server/sample.js';

const port = 4812, base = `http://127.0.0.1:${port}`;
const out = path.resolve(process.env.SHOTS_DIR || os.tmpdir());
const srv = spawn('node', ['bin/battlemap.js', '--mock-jira', '--port', String(port), '--mock-port', '4813', '--config', path.join(os.tmpdir(), `shot2-cfg-${process.pid}.json`)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'X-Battlemap': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`${base}/`); await page.waitForSelector('.card'); await page.waitForTimeout(3000);
  for (const step of process.argv.slice(2)) {
    const [name, ...a] = step.split(':');
    if (name === 'click') await page.click(a.join(':'));
    else if (name === 'wait') await page.waitForTimeout(Number(a[0]));
    else if (name === 'file') await page.evaluate((p) => window.battlemap.state.scene.flyToFile(p), a.join(':'));
    else if (name === 'view') await page.evaluate((v) => window.battlemap.state.scene.setView(v), a[0]);
    else if (name === 'eval') await page.evaluate(a.join(':'));
    else if (name === 'feed') { const drop = a.join(':').startsWith('sample-without-') ? a.join(':').slice('sample-without-'.length) : null; await post('/api/prs', { prs: samplePRs().filter((p) => p.id !== drop) }); await page.waitForTimeout(800); }
    else if (name === 'rule') { await post('/api/watch/rule', { type: a[0], value: a.slice(1).join(':') }); await page.waitForTimeout(500); }
    else if (name === 'pick') { await post('/api/watch/pick', { ref: a.join(':') }); await page.waitForTimeout(500); }
    else if (name === 'shot') { await page.screenshot({ path: path.join(out, `${a[0]}.png`) }); console.log('wrote', path.join(out, `${a[0]}.png`)); }
    else if (name === 'info') console.log(JSON.stringify(await page.evaluate(() => window.battlemap.state.scene.info())));
  }
  console.log('errors:', errs.join('|') || 'none');
} finally { await browser.close(); srv.kill(); }
