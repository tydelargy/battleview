#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../server/config.js';
import { createApp } from '../server/server.js';
import { createHub } from '../server/hub.js';
import { demoProvider } from '../server/demo.js';
import { createMockJira } from '../server/jira/mock.js';
import { sampleFiles, samplePRs } from '../server/sample.js';
import { scanRepo } from '../server/localrepo.js';
import { watchFeed } from '../server/feedwatch.js';

const HELP = `battlemap - tactical 3D map of your repo, PRs and Jira tickets

Usage: battlemap [options]

Battle Map opens on a world of cities, one per repo: add a repo by its URL, drag cities around, click one to go in.
Nothing is cloned; GitHub is read through the gh command.

  --data <dir>         Where cities and their settings are kept (default ~/.local/share/battlemap)
  --gh <path>          The GitHub CLI to use (default: gh from PATH)
  --demo               Try it with nothing connected: a pretend GitHub with acme/platform (already on the map),
                       acme/billing-api and acme/mobile-app (add them with the + on a free hex). Saves nothing.

Single map instead of the world (older, and handy for one local checkout):
  --sample             The built-in sample repo and PRs

  --port <n>           Port to serve on (default 4747)
  --host <addr>        Bind address (default 127.0.0.1)
  --repo <dir>         Map a local git checkout as a single map
  --prs <file.json>    Load PRs from a JSON file and reload when it changes (also when it is replaced atomically)
  --rescan <seconds>   With --repo: look at the checkout again every so often, so new and changed files appear (default off)
  --mock-jira          Start a fake Jira and point Battle Map at it (nothing is saved). npm run mock = --demo --mock-jira
  --mock-flavor <f>    server (default, PAT) or cloud (email + API token)
  --mock-port <n>      Port for the fake Jira (default 4748)
  --config <file>      Config file (default ~/.config/battlemap/config.json)
  --open               Open the browser
  -h, --help           Show this help

Environment: BATTLEMAP_JIRA_URL, BATTLEMAP_JIRA_TOKEN, BATTLEMAP_JIRA_EMAIL,
             BATTLEMAP_JIRA_DEPLOYMENT (server|cloud), BATTLEMAP_CONFIG
`;

function parse(argv) {
  const o = { port: 4747, host: '127.0.0.1', mockPort: 4748, mockFlavor: 'server' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--port') o.port = Number(next());
    else if (a === '--host') o.host = next();
    else if (a === '--hub') o.hub = true;                // the default now; still accepted
    else if (a === '--demo') o.demo = true;
    else if (a === '--sample') o.sample = true;
    else if (a === '--data') o.data = next();
    else if (a === '--gh') o.gh = next();
    else if (a === '--repo') o.repo = next();
    else if (a === '--prs') o.prs = next();
    else if (a === '--rescan') o.rescan = Number(next());
    else if (a === '--mock-jira') o.mock = true;
    else if (a === '--mock-flavor') o.mockFlavor = next();
    else if (a === '--mock-port') o.mockPort = Number(next());
    else if (a === '--config') o.config = next();
    else if (a === '--open') o.open = true;
    else { console.error(`Unknown option ${a}\n`); o.help = true; o.bad = true; }
  }
  return o;
}

const o = parse(process.argv.slice(2));
if (o.help) { process.stdout.write(HELP); process.exit(o.bad ? 1 : 0); }
if (o.rescan != null && (!Number.isFinite(o.rescan) || o.rescan < 10)) { console.error('--rescan needs a number of seconds, at least 10'); process.exit(1); }
if (o.rescan && !o.repo) { console.error('--rescan only makes sense with --repo'); process.exit(1); }
if ((o.repo || o.prs || o.sample) && (o.demo || o.data)) { console.error('--demo and --data belong to the world; --repo, --prs and --sample open a single map'); process.exit(1); }
if (!['server', 'cloud'].includes(o.mockFlavor)) { console.error('--mock-flavor must be server or cloud'); process.exit(1); }

const store = new ConfigStore({ file: o.config });
let mock;
if (o.mock) {
  mock = createMockJira({ flavor: o.mockFlavor });
  const { url } = await mock.listen(o.mockPort);
  const c = mock.credentials();
  store.runtimeOverride = { jira: { deployment: o.mockFlavor, baseUrl: url, token: c.token, email: c.email, projectKeys: ['ENG'], boardId: '7' } };
  console.log(`Mock Jira (${o.mockFlavor}) at ${url}  token: ${c.token}${o.mockFlavor === 'cloud' ? `  email: ${c.email}` : ''}`);
}

const single = o.repo || o.prs || o.sample;
if (!single) {
  // the app: a world of cities. (--hub is the old name for this.)
  const dataDir = o.demo ? fs.mkdtempSync(path.join(os.tmpdir(), 'battlemap-demo-')) : path.resolve(o.data || process.env.BATTLEMAP_DATA || path.join(process.env.XDG_DATA_HOME || (process.platform === 'win32' && process.env.LOCALAPPDATA) || path.join(os.homedir(), '.local', 'share'), 'battlemap'));
  const cleanup = () => { if (o.demo) fs.rmSync(dataDir, { recursive: true, force: true }); };
  const openIt = (u) => { if (!o.open) return; const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'; spawn(cmd, process.platform === 'win32' ? ['/c', 'start', '', u] : [u], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); };
  const provider = o.demo ? demoProvider() : null;
  const hub = createHub({ dataDir, store, gh: o.gh || process.env.BATTLEMAP_GH || 'gh', provider, log: (m) => console.warn(m) });
  if (provider) await hub.addCity('acme/platform');             // the demo starts with one city on the map, and two more to add
  let hi;
  try { hi = await hub.listen(o.port, o.host); }
  catch (e) {
    cleanup(); await mock?.close();
    if (e.code === 'EADDRINUSE') {   // a second launch (a desktop icon clicked twice): if it is Battle Map that has the port, just open it
      const there = `http://${o.host === '0.0.0.0' ? 'localhost' : o.host}:${o.port}`, running = await fetch(`${there}/api/hub/world`).then((r) => r.ok, () => false);
      if (running) { console.log(`Battle Map is already running at ${there}`); openIt(there); process.exit(0); }
      console.error(`Port ${o.port} is in use by something else. Try --port ${o.port + 1}.`); process.exit(1);
    }
    console.error(e.message); process.exit(1);
  }
  console.log(`Battle Map at ${hi.url}${o.demo ? '  (demo: add acme/billing-api or acme/mobile-app with the + on a free hex)' : `   data: ${dataDir}`}`);
  if (o.host !== '127.0.0.1' && o.host !== 'localhost') console.warn('Warning: bound to a non-local address. There is no login; anyone who can reach this port can see your PRs and use your Jira token.');
  openIt(hi.url);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await hub.close(); await mock?.close(); cleanup(); process.exit(0); });
  await new Promise(() => {});   // serve until signalled
}
let files, prs = [], sample = false;
if (o.repo) {
  try { files = scanRepo(o.repo); } catch (e) { console.error(`Could not scan ${o.repo}: ${e.stderr?.toString().trim() || e.message}`); process.exit(1); }
  console.log(`Scanned ${files.length} files in ${path.resolve(o.repo)}`);
} else { files = sampleFiles(); sample = true; }
const loadPRs = (file) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : j.prs || []; };
if (o.prs) { try { prs = loadPRs(o.prs); } catch (e) { console.error(`Could not read ${o.prs}: ${e.message}`); process.exit(1); } sample = false; }
else if (sample) prs = samplePRs();

const app = createApp({ store, files, prs, sampleMode: sample, log: (m) => console.warn(m) });
if (o.prs) {
  watchFeed(o.prs, () => { try { const r = app.setPRs(loadPRs(o.prs)); app.refreshJira(); console.log(`Reloaded ${r.count} PRs${r.problems.length ? ` (${r.problems.length} problems)` : ''}`); } catch (e) { console.warn(`PR file not reloaded: ${e.message}`); } });
}
if (o.repo && o.rescan) {
  // scanRepo is synchronous and reads every file, so keep the interval generous.
  setInterval(() => { try { if (app.setFiles(scanRepo(o.repo))) console.log('Repo changed, map updated'); } catch (e) { console.warn(`Rescan failed: ${e.message}`); } }, o.rescan * 1000).unref();
}
let info;
try { info = await app.listen(o.port, o.host); } catch (e) { console.error(e.code === 'EADDRINUSE' ? `Port ${o.port} is in use. Try --port ${o.port + 1}.` : e.message); process.exit(1); }
console.log(`Battle Map at ${info.url}${sample ? '  (sample repo and PRs)' : ''}`);
if (!app.threeInstalled) console.warn('three is not installed. Run `npm install` in the battlemap folder; the map will not render until you do.');
if (o.host !== '127.0.0.1' && o.host !== 'localhost') console.warn('Warning: bound to a non-local address. There is no login; anyone who can reach this port can see your PRs and use your Jira token.');
if (o.open) { const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'; spawn(cmd, process.platform === 'win32' ? ['/c', 'start', info.url] : [info.url], { stdio: 'ignore', detached: true }).unref(); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); await mock?.close(); process.exit(0); });
