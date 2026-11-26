#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../server/config.js';
import { createApp } from '../server/server.js';
import { createMockJira } from '../server/jira/mock.js';
import { sampleFiles, samplePRs } from '../server/sample.js';
import { scanRepo } from '../server/localrepo.js';

const HELP = `battlemap - tactical 3D map of your repo, PRs and Jira tickets

Usage: battlemap [options]

  --port <n>           Port to serve on (default 4747)
  --host <addr>        Bind address (default 127.0.0.1)
  --repo <dir>         Map a local git checkout instead of the sample repo
  --prs <file.json>    Load PRs from a JSON file and reload when it changes
  --mock-jira          Start a fake Jira and point Battle Map at it (nothing is saved)
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
    else if (a === '--repo') o.repo = next();
    else if (a === '--prs') o.prs = next();
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
if (!['server', 'cloud'].includes(o.mockFlavor)) { console.error('--mock-flavor must be server or cloud'); process.exit(1); }

const store = new ConfigStore({ file: o.config });
let files, prs = [], sample = false;
if (o.repo) {
  try { files = scanRepo(o.repo); } catch (e) { console.error(`Could not scan ${o.repo}: ${e.stderr?.toString().trim() || e.message}`); process.exit(1); }
  console.log(`Scanned ${files.length} files in ${path.resolve(o.repo)}`);
} else { files = sampleFiles(); sample = true; }
const loadPRs = (file) => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j) ? j : j.prs || []; };
if (o.prs) { try { prs = loadPRs(o.prs); } catch (e) { console.error(`Could not read ${o.prs}: ${e.message}`); process.exit(1); } sample = false; }
else if (sample) prs = samplePRs();

let mock;
if (o.mock) {
  mock = createMockJira({ flavor: o.mockFlavor });
  const { url } = await mock.listen(o.mockPort);
  const c = mock.credentials();
  store.runtimeOverride = { jira: { deployment: o.mockFlavor, baseUrl: url, token: c.token, email: c.email, projectKeys: ['ENG'], boardId: '7' } };
  console.log(`Mock Jira (${o.mockFlavor}) at ${url}  token: ${c.token}${o.mockFlavor === 'cloud' ? `  email: ${c.email}` : ''}`);
}

const app = createApp({ store, files, prs, sampleMode: sample, log: (m) => console.warn(m) });
if (o.prs) {
  let t; fs.watch(o.prs, () => { clearTimeout(t); t = setTimeout(() => { try { const r = app.setPRs(loadPRs(o.prs)); app.refreshJira(); console.log(`Reloaded ${r.count} PRs${r.problems.length ? ` (${r.problems.length} problems)` : ''}`); } catch (e) { console.warn(`PR file not reloaded: ${e.message}`); } }, 150); });
}
let info;
try { info = await app.listen(o.port, o.host); } catch (e) { console.error(e.code === 'EADDRINUSE' ? `Port ${o.port} is in use. Try --port ${o.port + 1}.` : e.message); process.exit(1); }
console.log(`Battle Map at ${info.url}${sample ? '  (sample repo and PRs)' : ''}`);
if (!app.threeInstalled) console.warn('three is not installed. Run `npm install` in the battlemap folder; the map will not render until you do.');
if (o.host !== '127.0.0.1' && o.host !== 'localhost') console.warn('Warning: bound to a non-local address. There is no login; anyone who can reach this port can see your PRs and use your Jira token.');
if (o.open) { const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'; spawn(cmd, process.platform === 'win32' ? ['/c', 'start', info.url] : [info.url], { stdio: 'ignore', detached: true }).unref(); }
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { await app.close(); await mock?.close(); process.exit(0); });
