// Screenshot helper: node e2e/shot.mjs <outprefix> [steps...]. Renders the real WebGL scene via SwiftShader.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
let chromium;
try { ({ chromium } = await import('playwright')); } catch { chromium = createRequire(process.env.PLAYWRIGHT_DIR || '/home/claude/.npm-global/lib/node_modules/')('playwright').chromium; }
const out = process.argv[2] || '/tmp/shot';
const port = 4810;
const srv = spawn('node', ['bin/battlemap.js', '--sample', '--mock-jira', '--port', String(port), '--mock-port', '4811', '--config', '/tmp/shot-cfg.json'], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => srv.stdout.on('data', (d) => /Battle Map at/.test(String(d)) && r()));
const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 840 } });
  const logs = []; page.on('console', (m) => ['error', 'warning'].includes(m.type()) && logs.push(m.text())); page.on('pageerror', (e) => logs.push('PAGEERR ' + e.message));
  await page.goto(`http://127.0.0.1:${port}/`); await page.waitForSelector('.card');
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${out}-overview.png` });
  if (process.argv.includes('focus')) { await page.click('.card[data-id="#2291"]'); await page.waitForTimeout(3500); await page.screenshot({ path: `${out}-focus.png` }); }
  console.log(JSON.stringify(await page.evaluate(() => ({ nogl: !document.getElementById('nogl').hidden, canvas: !!document.querySelector('#stage canvas') }))));
  console.log(logs.slice(0, 8).join('\n'));
} finally { await browser.close(); srv.kill(); }
