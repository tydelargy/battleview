import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve(import.meta.dirname, '../deploy/install-systemd.sh');
const install = (args) => spawnSync('bash', [script, ...args], { encoding: 'utf8' });

test('install-systemd.sh renders units with absolute paths, for github.com', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-units-'));
  const r = install(['--repo', 'org/repo', '--checkout', '/data/repo', '--feed', path.join(dest, 'data/prs.json'), '--dest', dest, '--no-enable']);
  assert.equal(r.status, 0, r.stderr);
  const sync = fs.readFileSync(path.join(dest, 'battlemap-sync.service'), 'utf8'), svc = fs.readFileSync(path.join(dest, 'battlemap.service'), 'utf8');
  assert.match(sync, /ExecStart=\S+ .*battlemap-sync\.js github --repo org\/repo --gh \/\S+gh --out \S+prs\.json --quiet/s);
  assert.match(sync, /ExecStartPre=-\/\S+git -C \/data\/repo pull --ff-only/);
  assert.ok(!sync.includes('--host'), 'no host flag for github.com');
  assert.match(sync, /from github\.com/);
  assert.match(svc, /ExecStart=.* --repo \/data\/repo --prs \S+prs\.json --rescan 600/);
  assert.ok(!/@\w+@/.test(sync + svc), 'no placeholder left over');
  assert.match(fs.readFileSync(path.join(dest, 'battlemap-sync.timer'), 'utf8'), /OnUnitInactiveSec=2min/);
  assert.match(r.stdout, /not enabled/);
  assert.ok(fs.existsSync(path.join(dest, 'data')), 'feed directory created');
});

test('install-systemd.sh passes the Enterprise host through', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-units-'));
  assert.equal(install(['--repo', 'org/repo', '--host', 'ghe.example.com', '--feed', path.join(dest, 'p.json'), '--dest', dest, '--no-enable']).status, 0);
  const sync = fs.readFileSync(path.join(dest, 'battlemap-sync.service'), 'utf8');
  assert.match(sync, /--repo org\/repo --host ghe\.example\.com --gh /);
  assert.match(sync, /from ghe\.example\.com/);
});

test('install-systemd.sh refuses bad usage and never touches systemd with --no-enable', () => {
  assert.notEqual(install([]).status, 0);
  assert.match(install(['--repo', 'noslash']).stderr, /owner\/name/);
  assert.notEqual(install(['--bogus']).status, 0);
  assert.equal(install(['--help']).status, 0);
});

test('the unit templates and crontab example have no stray placeholders and the timer is valid ini', () => {
  const dir = path.resolve(import.meta.dirname, '../deploy');
  for (const f of ['battlemap.service.in', 'battlemap-sync.service.in', 'battlemap-sync.timer.in']) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.match(text, /^\[Unit\]/m); for (const m of text.matchAll(/@(\w+)@/g)) assert.ok(['BATTLEMAP', 'SYNC', 'GH', 'GIT', 'CHECKOUT', 'FEED', 'REPO', 'HOSTNAME', 'HOSTARG'].includes(m[1]), `${f} uses @${m[1]}@`);
  }
  assert.match(fs.readFileSync(path.join(dir, 'crontab.example'), 'utf8'), /^\*\/2 \* \* \* \* .*battlemap-sync github/m);
});
