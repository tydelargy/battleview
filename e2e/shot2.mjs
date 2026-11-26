import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { chromium = createRequire('/home/claude/.npm-global/lib/node_modules/')('playwright').chromium; }
const port = 4812;
const srv = spawn('node', ['bin/battlemap.js', '--mock-jira', '--port', String(port), '--mock-port', '4813', '--config', '/tmp/shot2-cfg.json'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('.card'); await page.waitForTimeout(3000);
  for (const step of process.argv.slice(2)) {
    const [name, ...a] = step.split(':');
    if (name === 'click') await page.click(a.join(':'));
    else if (name === 'wait') await page.waitForTimeout(Number(a[0]));
    else if (name === 'file') await page.evaluate((p) => window.battlemap.state.scene.flyToFile(p), a.join(':'));
    else if (name === 'view') await page.evaluate((v) => window.battlemap.state.scene.setView(v), a[0]);
    else if (name === 'shot') await page.screenshot({ path: `/tmp/${a[0]}.png` });
    else if (name === 'info') console.log(JSON.stringify(await page.evaluate(() => window.battlemap.state.scene.info())));
  }
  console.log('errors:', errs.join('|') || 'none');
} finally { await browser.close(); srv.kill(); }
