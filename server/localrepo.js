// Scan a local git checkout for the file list. Fast and dependency free.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SKIP = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|Cargo\.lock|poetry\.lock|go\.sum)$|\.(png|jpe?g|gif|ico|svg|woff2?|ttf|pdf|zip|gz|mp4|mov|min\.js|map|snap)$/i;
const BRANCH = /\b(if|else if|for|while|case|catch|switch)\b|&&|\|\||\?\s|\bmatch\b/g;

export function scanRepo(dir, { maxFiles = 6000, maxBytes = 1_000_000 } = {}) {
  const root = path.resolve(dir);
  const listed = execFileSync('git', ['-C', root, 'ls-files', '-z'], { maxBuffer: 64 * 1024 * 1024 }).toString('utf8').split('\0').filter(Boolean);
  const files = [];
  for (const rel of listed) {
    if (files.length >= maxFiles) break;
    if (SKIP.test(rel)) continue;
    try {
      const abs = path.join(root, rel);
      const stat = fs.statSync(abs);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      const text = fs.readFileSync(abs, 'utf8');
      if (text.includes('\0')) continue;
      const loc = text.split('\n').filter((l) => l.trim()).length;
      if (!loc) continue;
      files.push({ path: rel.split(path.sep).join('/'), loc, complexity: (text.match(BRANCH) || []).length });
    } catch { /* unreadable, skip */ }
  }
  return files;
}
