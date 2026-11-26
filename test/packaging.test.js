// Packaging, without downloads: the trimmed app really runs on its own, and each package has the layout it promises.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { stage, buildDeb, assembleAppDir, squashToAppImage, assembleWin, sfxSetup, buildTarball, PINNED, NODE_VERSION, version } from '../packaging/build.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bm-pack-'));
const have = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
const list = (dir, base = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name))]));
const fakeNode = (dir) => { const f = path.join(dir, 'node'); fs.copyFileSync(process.execPath, f); return f; };

test('the staged app is small, has no tests or docs, and carries only the three.js files the page loads', () => {
  const s = stage(path.join(tmp(), 'stage')), files = list(s);
  for (const need of ['bin/battlemap.js', 'bin/battlemap-sync.js', 'server/hub.js', 'web/index.html', 'web/world.js', 'package.json', 'node_modules/three/build/three.module.js', 'node_modules/three/build/three.core.js', 'node_modules/three/examples/jsm/controls/OrbitControls.js']) assert.ok(files.includes(need), need);
  assert.ok(!files.some((f) => /^(test|e2e|docs|deploy|packaging|\.jj|\.git)\//.test(f)), 'no tests, docs or tooling');
  assert.ok(!files.some((f) => f.startsWith('node_modules/') && !f.startsWith('node_modules/three/')), 'no other dependencies');
  const size = files.reduce((n, f) => n + fs.statSync(path.join(s, f)).size, 0); assert.ok(size < 6_000_000, `${size} bytes`);
  const pkg = JSON.parse(fs.readFileSync(path.join(s, 'package.json'), 'utf8')); assert.equal(pkg.version, version()); assert.equal(pkg.type, 'module'); assert.ok(!pkg.devDependencies && !pkg.scripts);
});

test('the staged app runs on its own: the hub starts, serves the page and the vendored three.js, and answers', async () => {
  const dir = tmp(), s = stage(path.join(dir, 'stage')), srv = spawn(process.execPath, [path.join(s, 'bin', 'battlemap.js'), '--hub', '--port', '0', '--data', path.join(dir, 'data'), '--config', path.join(dir, 'config.json')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const url = await new Promise((resolve, reject) => { let out = ''; const t = setTimeout(() => reject(new Error('did not start: ' + out)), 10000); srv.stdout.on('data', (d) => { out += d; const m = out.match(/at (http:\/\/\S+)/); if (m) { clearTimeout(t); resolve(m[1]); } }); srv.stderr.on('data', (d) => { out += d; }); });
    assert.equal((await fetch(url + '/')).status, 200);
    for (const p of ['/vendor/three/build/three.module.js', '/vendor/three/build/three.core.js', '/vendor/three/examples/jsm/controls/OrbitControls.js', '/world.js', '/main.js']) assert.equal((await fetch(url + p)).status, 200, p);
    assert.deepEqual(Object.keys(await (await fetch(url + '/api/hub/world')).json()), ['cities', 'slots', 'max']);
  } finally { srv.kill(); }
});

test('a second launch of a running hub opens it instead of failing', async () => {
  const dir = tmp(), s = stage(path.join(dir, 'stage')), args = (port) => [path.join(s, 'bin', 'battlemap.js'), '--hub', '--port', String(port), '--data', path.join(dir, 'data'), '--config', path.join(dir, 'config.json')];
  const first = spawn(process.execPath, args(4879), { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((r) => first.stdout.on('data', (d) => /Battle Map/.test(String(d)) && r()));
    const second = spawn(process.execPath, args(4879), { cwd: dir, stdio: ['ignore', 'pipe', 'inherit'] }); let out = ''; second.stdout.on('data', (d) => { out += d; });
    const code = await new Promise((r) => second.on('exit', r)); assert.equal(code, 0); assert.match(out, /already running at http:\/\/127\.0\.0\.1:4879/);
    const other = createBlocker(4878); try { const third = spawn(process.execPath, args(4878), { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); let err = ''; third.stderr.on('data', (d) => { err += d; }); assert.equal(await new Promise((r) => third.on('exit', r)), 1); assert.match(err, /in use by something else/); } finally { other.close(); }
  } finally { first.kill(); }
});
function createBlocker(port) { const s = net.createServer((c) => c.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')); s.listen(port, '127.0.0.1'); return s; }   // something else that owns a port

test('.deb: the app in /opt, a command, a menu entry and an icon, root-owned, needing the system nodejs', { skip: !have('dpkg-deb') && 'dpkg-deb is not installed' }, () => {
  const dir = tmp(), file = buildDeb({ out: dir, work: path.join(dir, 'work'), appDir: stage(path.join(dir, 'stage')) });
  assert.equal(path.basename(file), `battlemap_${version()}_all.deb`);
  const info = execFileSync('dpkg-deb', ['--info', file]).toString(), contents = execFileSync('dpkg-deb', ['--contents', file]).toString();
  assert.match(info, /Package: battlemap/); assert.match(info, /Depends: nodejs \(>= 20\)/); assert.match(info, /Recommends: gh/); assert.match(info, /Architecture: all/);
  for (const p of ['./opt/battlemap/launch.sh', './opt/battlemap/app/bin/battlemap.js', './usr/share/applications/battlemap.desktop', './usr/share/icons/hicolor/scalable/apps/battlemap.svg', './usr/bin/battlemap -> /opt/battlemap/launch.sh']) assert.ok(contents.includes(p), p);
  assert.match(contents.split('\n').find((l) => l.includes('opt/battlemap/launch.sh')), /^-rwxr-xr-x root\/root/); assert.ok(!/tdelargy|\b1000\//.test(contents), 'owned by root, not by whoever built it');
});

test('AppImage: AppDir has a runnable AppRun, a bundled Node, the launcher, the app, a desktop file and an icon; squashing puts the runtime first', { skip: !have('mksquashfs') && 'mksquashfs is not installed' }, () => {
  const dir = tmp(), appDir = stage(path.join(dir, 'stage')), AppDir = assembleAppDir({ dir: path.join(dir, 'AppDir'), appDir, nodeBin: fakeNode(dir) });
  for (const f of ['AppRun', 'battlemap.desktop', 'battlemap.svg', '.DirIcon', 'opt/battlemap/launch.sh', 'opt/battlemap/node/bin/node', 'opt/battlemap/app/bin/battlemap.js']) assert.ok(fs.existsSync(path.join(AppDir, f)), f);
  for (const f of ['AppRun', 'opt/battlemap/launch.sh', 'opt/battlemap/node/bin/node']) assert.ok(fs.statSync(path.join(AppDir, f)).mode & 0o100, `${f} is executable`);
  assert.match(fs.readFileSync(path.join(AppDir, 'battlemap.desktop'), 'utf8'), /^Exec=battlemap$/m); assert.match(fs.readFileSync(path.join(AppDir, 'AppRun'), 'utf8'), /launch\.sh/);
  const runtime = path.join(dir, 'runtime'); fs.writeFileSync(runtime, Buffer.from('FAKE-RUNTIME-BYTES'));
  const out = squashToAppImage({ dir: AppDir, runtime, out: path.join(dir, 'x.AppImage') }), bytes = fs.readFileSync(out);
  assert.equal(bytes.subarray(0, 18).toString(), 'FAKE-RUNTIME-BYTES'); assert.equal(bytes.subarray(18, 22).toString(), 'hsqs', 'a squashfs image follows the runtime'); assert.ok(fs.statSync(out).mode & 0o100);
  assert.ok(!fs.existsSync(out + '.squashfs'), 'no scratch file left behind');
});

test('the launcher, from the tarball: install.sh puts the app, the command, the menu entry in a prefix, and the command starts and stops the hub', { skip: process.platform === 'win32' }, async () => {
  const dir = tmp(), tgz = await buildTarball({ out: dir }), home = path.join(dir, 'home'); fs.mkdirSync(home);
  execFileSync('tar', ['-xzf', tgz, '-C', dir]); const top = path.join(dir, `battlemap-${version()}`);
  const env = { ...process.env, HOME: home, XDG_STATE_HOME: path.join(home, 'state'), BATTLEMAP_DATA: path.join(home, 'data'), BATTLEMAP_PORT: '4877', PATH: process.env.PATH };
  const out = execFileSync(path.join(top, 'install.sh'), ['--no-service'], { env, cwd: top }).toString(); assert.match(out, /installed to/);
  for (const f of ['.local/bin/battlemap', '.local/opt/battlemap/launch.sh', '.local/opt/battlemap/app/bin/battlemap.js', '.local/share/applications/battlemap.desktop', '.local/share/icons/hicolor/scalable/apps/battlemap.svg']) assert.ok(fs.existsSync(path.join(home, f)), f);
  assert.match(fs.readFileSync(path.join(home, '.local/share/applications/battlemap.desktop'), 'utf8'), /^Exec=.*\/\.local\/opt\/battlemap\/launch\.sh$/m, 'the menu entry points at the installed launcher');
  const bm = path.join(home, '.local/bin/battlemap');
  try {
    execFileSync(bm, ['--no-open'], { env, timeout: 30000 });
    assert.equal((await fetch('http://127.0.0.1:4877/api/hub/world')).status, 200, 'the command started the hub');
    execFileSync(bm, ['--no-open'], { env, timeout: 30000 });                         // already running: fine
  } finally { execFileSync(bm, ['--stop'], { env }); }
  await new Promise((r) => setTimeout(r, 600)); await assert.rejects(fetch('http://127.0.0.1:4877/api/hub/world'), 'and --stop stopped it');
  assert.throws(() => execFileSync(path.join(top, 'install.sh'), ['--bogus'], { env, stdio: 'pipe' }), /unknown option/);
});

test('Windows: the folder has node.exe, the app and the two launchers; the setup .exe is the SFX stub, a config and the archive', { skip: !have('7z') && '7z is not installed' }, () => {
  const dir = tmp(), exe = path.join(dir, 'node.exe'); fs.writeFileSync(exe, 'MZ-fake-node');
  const w = assembleWin({ dir: path.join(dir, 'Battle Map'), appDir: stage(path.join(dir, 'stage')), nodeExe: exe });
  for (const f of ['node.exe', 'launch.vbs', 'Battle Map.cmd', 'app/bin/battlemap.js', 'app/node_modules/three/build/three.module.js']) assert.ok(fs.existsSync(path.join(w, f)), f);
  assert.match(fs.readFileSync(path.join(w, 'launch.vbs'), 'utf8'), /--hub --open/);
  const stub = path.join(dir, 'stub.sfx'); fs.writeFileSync(stub, 'MZ-STUB'); const out = sfxSetup({ dir: w, stub, out: path.join(dir, 'Setup.exe') }), bytes = fs.readFileSync(out);
  assert.equal(bytes.subarray(0, 7).toString(), 'MZ-STUB'); assert.match(bytes.toString('latin1'), /;!@Install@!UTF-8!\nTitle="Battle Map"[\s\S]*RunProgram="wscript\.exe[\s\S]*;!@InstallEnd@!/);
  assert.ok(bytes.includes(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])), 'a 7z archive follows the config');
  assert.match(execFileSync('7z', ['l', out]).toString(), /launch\.vbs/);
});

test('downloads are pinned: every one has a URL and a SHA-256, from a host we expect', () => {
  assert.ok(Object.keys(PINNED).length >= 4); assert.match(NODE_VERSION, /^\d+\.\d+\.\d+$/);
  for (const [name, p] of Object.entries(PINNED)) { assert.match(p.sha256, /^[0-9a-f]{64}$/, name); assert.match(p.url, /^https:\/\/(nodejs\.org|github\.com|www\.7-zip\.org)\//, name); }
});
