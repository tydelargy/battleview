#!/usr/bin/env node
// Turn a code host's open PRs into the feed file that `battlemap --prs` reads. Meant for cron or a systemd timer.
// It only ever replaces the feed with a complete, valid one: if the host cannot be reached the old file stays.
import fs from 'node:fs';
import path from 'node:path';
import { github, SyncError } from '../server/providers/github.js';

const PROVIDERS = { github };
const HELP = `battlemap-sync - write the PR feed for Battle Map from a code host

Usage: battlemap-sync <provider> [options]

Providers: ${Object.keys(PROVIDERS).join(', ')}

  --repo <owner/name>   Repository (default: the one in the current directory)
  --host <hostname>     GitHub Enterprise host, for example ghe.example.com (default: github.com)
  --out <file>          Where to write the feed (default: prs.json). Use - for stdout
  --limit <n>           Most open PRs to fetch (default 500)
  --ended-days <n>      Also include PRs merged or closed in the last n days, so they show as merged or closed
                        instead of just vanishing (default 2; 0 turns it off)
  --gh <path>           The gh executable (default: gh)
  --quiet               Print nothing unless something goes wrong
  -h, --help

Setup: install https://cli.github.com and run gh auth login (add --hostname <host> for Enterprise).
Then, for example:  battlemap-sync github --repo org/repo --out ~/.local/share/battlemap/prs.json
`;

function parse(argv) {
  const o = { limit: 500, endedDays: 2, out: 'prs.json', gh: process.env.BATTLEMAP_GH || 'gh' };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '--repo') o.repo = next();
    else if (a === '--host') o.host = next();
    else if (a === '--out') o.out = next();
    else if (a === '--limit') o.limit = Number(next());
    else if (a === '--ended-days') o.endedDays = Number(next());
    else if (a === '--gh') o.gh = next();
    else if (a === '--quiet') o.quiet = true;
    else if (a.startsWith('-')) { console.error(`Unknown option ${a}\n`); o.help = true; o.bad = true; }
    else rest.push(a);
  }
  o.provider = rest[0];
  return o;
}

const o = parse(process.argv.slice(2));
if (o.help || !o.provider) { process.stdout.write(HELP); process.exit(o.bad || (!o.help && !o.provider) ? 1 : 0); }
const provider = PROVIDERS[o.provider];
if (!provider) { console.error(`Unknown provider "${o.provider}". Known: ${Object.keys(PROVIDERS).join(', ')}`); process.exit(1); }
if (!Number.isInteger(o.limit) || o.limit < 1 || !Number.isFinite(o.endedDays) || o.endedDays < 0) { console.error('--limit must be a positive whole number and --ended-days zero or more'); process.exit(1); }

try {
  const { prs, warnings, counts } = await provider.fetch({ repo: o.repo, host: o.host, limit: o.limit, endedDays: o.endedDays, gh: o.gh });
  for (const w of warnings) console.error(`warning: ${w}`);
  const body = JSON.stringify({ prs });
  if (o.out === '-') process.stdout.write(body + '\n');
  else {
    const out = path.resolve(o.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, out);      // atomic: the server never reads a half-written feed
    if (!o.quiet) console.log(`wrote ${counts.open} open and ${counts.ended} recently ended PRs to ${out}`);
  }
} catch (e) {
  console.error(e instanceof SyncError ? `battlemap-sync: ${e.message}` : `battlemap-sync: ${e.stack || e}`);
  process.exit(1);
}
