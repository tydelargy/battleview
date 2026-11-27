#!/usr/bin/env node
// Builds the installable forms of Battle Map into dist/. No dependencies beyond Node and a few system tools.
//
//   node packaging/build.mjs stage          the app, trimmed (dist/stage/app)
//   node packaging/build.mjs deb            dist/battlemap_<version>_all.deb          needs dpkg-deb (and fakeroot, if you are not root)
//   node packaging/build.mjs appimage       dist/Battle-Map-<version>-x86_64.AppImage  needs mksquashfs; bundles Node, so nothing to install
//   node packaging/build.mjs tarball        dist/battlemap-<version>-linux-x64.tar.gz  the one-click local install (install.sh inside)
//   node packaging/build.mjs win            dist/Battle-Map-<version>-win-x64.zip and a self-extracting Battle-Map-<version>-Setup.exe   needs 7z
//   node packaging/build.mjs all
//
// Downloads (Node's own binaries, the AppImage runtime, the 7-Zip SFX module) are cached in packaging/.cache and checked
// against pinned SHA-256 sums, so a build is the same wherever it runs. Nothing is cloned and nothing is installed.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..'), DIST = path.join(ROOT, 'dist'), CACHE = path.join(HERE, '.cache');
export const NODE_VERSION = '24.14.0';
export const PINNED = {
  [`node-v${NODE_VERSION}-linux-x64.tar.xz`]: { url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz`, sha256: '41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df' },
  [`node-v${NODE_VERSION}-win-x64.zip`]: { url: `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`, sha256: '313fa40c0d7b18575821de8cb17483031fe07d95de5994f6f435f3b345f85c66' },
  'runtime-x86_64': { url: 'https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-x86_64', sha256: '617aa77314d57c8b8e4fae9c3f0b35af7b30d5529cb69e98f64f92510ed98a46' },
  'lzma2301.7z': { url: 'https://www.7-zip.org/a/lzma2301.7z', sha256: '317dd834d6bbfd95433488b832e823cd3d4d420101436422c03af88507dd1370' },   // carries bin/7zS2.sfx
};

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], ...opts });
const have = (cmd) => { try { execFileSync('which', [cmd], { stdio: 'ignore' }); return true; } catch { return false; } };
export const version = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true });
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A pinned download, cached, and checked against its sum every time it is used. */
export async function fetchPinned(name, { dir = CACHE } = {}) {
  const pin = PINNED[name]; if (!pin) throw new Error(`no pinned download called ${name}`);
  mkdirp(dir); const file = path.join(dir, name);
  if (!(fs.existsSync(file) && sha256(file) === pin.sha256)) {
    await new Promise((resolve, reject) => {
      const get = (url, hops = 0) => https.get(url, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && hops < 6) { res.resume(); return get(new URL(res.headers.location, url).href, hops + 1); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url}: HTTP ${res.statusCode}`)); }
        const out = fs.createWriteStream(file + '.part'); res.pipe(out); out.on('finish', () => out.close(resolve)); out.on('error', reject);
      }).on('error', reject);
      get(pin.url);
    });
    if (sha256(file + '.part') !== pin.sha256) { rmrf(file + '.part'); throw new Error(`${name} does not match its pinned SHA-256: refusing to use it`); }
    fs.renameSync(file + '.part', file);
  }
  return file;
}

// ---- the app itself ----
/** The app and nothing else: server, web, the bits of three the page loads, and a package.json that says what it is. */
export function stage(dest, { root = ROOT } = {}) {
  rmrf(dest); mkdirp(dest);
  for (const d of ['bin', 'server', 'web']) fs.cpSync(path.join(root, d), path.join(dest, d), { recursive: true });
  const three = path.join(root, 'node_modules', 'three'), out = path.join(dest, 'node_modules', 'three');
  if (!fs.existsSync(path.join(three, 'build', 'three.module.js'))) throw new Error('three is not installed: run npm ci first');
  for (const f of ['package.json', 'LICENSE', 'build/three.module.js', 'build/three.core.js', 'examples/jsm/controls/OrbitControls.js']) { mkdirp(path.dirname(path.join(out, f))); fs.copyFileSync(path.join(three, f), path.join(out, f)); }
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, type: 'module', license: pkg.license, engines: pkg.engines, bin: pkg.bin }, null, 2) + '\n');
  for (const f of ['README.md']) if (fs.existsSync(path.join(root, f))) fs.copyFileSync(path.join(root, f), path.join(dest, f));
  fs.chmodSync(path.join(dest, 'bin', 'battlemap.js'), 0o755); fs.chmodSync(path.join(dest, 'bin', 'battlemap-sync.js'), 0o755);
  return dest;
}
const putLauncher = (home) => { fs.copyFileSync(path.join(HERE, 'launch.sh'), path.join(home, 'launch.sh')); fs.chmodSync(path.join(home, 'launch.sh'), 0o755); };
const dirSize = (p) => fs.readdirSync(p, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirSize(path.join(p, e.name)) : fs.lstatSync(path.join(p, e.name)).size), 0);   // lstat: the launcher link points at a path that only exists once installed

// ---- .deb: the app in /opt/battlemap, a command, a menu entry; needs the system's nodejs ----
export function buildDeb({ out = DIST, work = path.join(DIST, 'work'), appDir } = {}) {
  const v = version(), tree = path.join(work, 'deb'), opt = path.join(tree, 'opt', 'battlemap');
  rmrf(tree); mkdirp(opt);
  fs.cpSync(appDir || stage(path.join(work, 'stage')), path.join(opt, 'app'), { recursive: true }); putLauncher(opt);
  mkdirp(path.join(tree, 'usr', 'bin')); fs.symlinkSync('/opt/battlemap/launch.sh', path.join(tree, 'usr', 'bin', 'battlemap'));
  mkdirp(path.join(tree, 'usr', 'share', 'applications')); fs.copyFileSync(path.join(HERE, 'battlemap.desktop'), path.join(tree, 'usr', 'share', 'applications', 'battlemap.desktop'));
  mkdirp(path.join(tree, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps')); fs.copyFileSync(path.join(HERE, 'battlemap.svg'), path.join(tree, 'usr', 'share', 'icons', 'hicolor', 'scalable', 'apps', 'battlemap.svg'));
  mkdirp(path.join(tree, 'DEBIAN'));
  fs.writeFileSync(path.join(tree, 'DEBIAN', 'control'), [
    'Package: battlemap', `Version: ${v}`, 'Section: devel', 'Priority: optional', 'Architecture: all', 'Depends: nodejs (>= 20)', 'Recommends: gh',
    `Installed-Size: ${Math.ceil(dirSize(tree) / 1024)}`, 'Maintainer: Battle Map <battlemap@localhost>', 'Homepage: https://github.com/tydelargy/battleview',
    'Description: every repo as a city: open PRs and Jira tickets on a 3D map of your code', ' Reads GitHub through the gh command; nothing is ever cloned.', ' Run "battlemap" or open it from the menu.', ''].join('\n'));
  // permissions: dpkg-deb wants dirs 755; the launcher and the entry points executable
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const f = path.join(p, e.name); if (e.isSymbolicLink()) continue; if (e.isDirectory()) { fs.chmodSync(f, 0o755); walk(f); } else fs.chmodSync(f, /launch\.sh$|bin\/battlemap(-sync)?\.js$/.test(f) ? 0o755 : 0o644); } };
  fs.chmodSync(tree, 0o755); walk(tree);
  mkdirp(out); const file = path.join(out, `battlemap_${v}_all.deb`);
  const args = ['--build', '--root-owner-group', tree, file];
  if (process.getuid?.() === 0 || !have('fakeroot')) sh('dpkg-deb', args); else sh('fakeroot', ['dpkg-deb', ...args]);
  return file;
}

// ---- AppImage: one file, Node bundled, nothing to install ----
export function assembleAppDir({ dir, appDir, nodeBin, icon = path.join(HERE, 'battlemap.svg') }) {
  rmrf(dir); const home = path.join(dir, 'opt', 'battlemap'); mkdirp(path.join(home, 'node', 'bin'));
  fs.cpSync(appDir, path.join(home, 'app'), { recursive: true }); putLauncher(home);
  fs.copyFileSync(nodeBin, path.join(home, 'node', 'bin', 'node')); fs.chmodSync(path.join(home, 'node', 'bin', 'node'), 0o755);
  fs.writeFileSync(path.join(dir, 'AppRun'), '#!/bin/sh\nHERE="$(dirname "$(readlink -f "$0")")"\nexec "$HERE/opt/battlemap/launch.sh" "$@"\n'); fs.chmodSync(path.join(dir, 'AppRun'), 0o755);
  fs.copyFileSync(path.join(HERE, 'battlemap.desktop'), path.join(dir, 'battlemap.desktop'));
  fs.copyFileSync(icon, path.join(dir, 'battlemap.svg')); fs.copyFileSync(icon, path.join(dir, '.DirIcon'));
  return dir;
}
export function squashToAppImage({ dir, runtime, out }) {
  const sq = out + '.squashfs'; rmrf(sq);
  sh('mksquashfs', [dir, sq, '-root-owned', '-noappend', '-comp', 'zstd', '-Xcompression-level', '19', '-quiet']);
  fs.writeFileSync(out, Buffer.concat([fs.readFileSync(runtime), fs.readFileSync(sq)])); fs.chmodSync(out, 0o755); rmrf(sq);
  return out;
}
async function nodeLinux() {
  const tar = await fetchPinned(`node-v${NODE_VERSION}-linux-x64.tar.xz`), dir = path.join(DIST, 'work', 'node-linux'); rmrf(dir); mkdirp(dir);
  sh('tar', ['-xJf', tar, '-C', dir, '--strip-components=2', `node-v${NODE_VERSION}-linux-x64/bin/node`]); return path.join(dir, 'node');
}
export async function buildAppImage({ out = DIST } = {}) {
  const work = path.join(DIST, 'work'), app = stage(path.join(work, 'stage')), dir = assembleAppDir({ dir: path.join(work, 'AppDir'), appDir: app, nodeBin: await nodeLinux() });
  mkdirp(out); return squashToAppImage({ dir, runtime: await fetchPinned('runtime-x86_64'), out: path.join(out, `Battle-Map-${version()}-x86_64.AppImage`) });
}

// ---- tarball: the one-click local install (./install.sh), with the app, the launcher and a menu entry ----
export async function buildTarball({ out = DIST, bundleNode = false } = {}) {
  const v = version(), work = path.join(DIST, 'work'), top = path.join(work, 'tarball', `battlemap-${v}`);
  rmrf(top); mkdirp(top); fs.cpSync(stage(path.join(work, 'stage')), path.join(top, 'app'), { recursive: true });
  for (const f of ['launch.sh', 'install.sh', 'battlemap.desktop', 'battlemap.svg']) fs.copyFileSync(path.join(HERE, f), path.join(top, f));
  if (bundleNode) { mkdirp(path.join(top, 'node', 'bin')); fs.copyFileSync(await nodeLinux(), path.join(top, 'node', 'bin', 'node')); fs.chmodSync(path.join(top, 'node', 'bin', 'node'), 0o755); }
  fs.chmodSync(path.join(top, 'install.sh'), 0o755); fs.chmodSync(path.join(top, 'launch.sh'), 0o755);
  mkdirp(out); const file = path.join(out, `battlemap-${v}-linux-x64.tar.gz`);
  sh('tar', ['-czf', file, '-C', path.dirname(top), `battlemap-${v}`]); return file;
}

// ---- Windows: a folder with node.exe and the app, as a zip and as a self-extracting setup .exe ----
export function assembleWin({ dir, appDir, nodeExe }) {
  rmrf(dir); mkdirp(dir); fs.cpSync(appDir, path.join(dir, 'app'), { recursive: true });
  fs.copyFileSync(nodeExe, path.join(dir, 'node.exe'));
  for (const f of ['launch.vbs', 'Battle Map.cmd']) fs.copyFileSync(path.join(HERE, 'win', f), path.join(dir, f));
  return dir;
}
/** Setup .exe = the 7-Zip SFX stub + a small config + a .7z of the folder. It unpacks into %LOCALAPPDATA%\Battle Map and starts the app. */
export function sfxSetup({ dir, stub, out }) {
  const payload = out + '.7z'; rmrf(payload);
  sh('7z', ['a', '-t7z', '-m0=lzma2', '-mx=5', '-bd', payload, '.'], { cwd: dir });
  const config = ';!@Install@!UTF-8!\nTitle="Battle Map"\nBeginPrompt="Install Battle Map for this user? It needs the GitHub CLI (gh) to read your repos."\nInstallPath="%LOCALAPPDATA%\\\\Battle Map"\nRunProgram="wscript.exe \\"launch.vbs\\""\n;!@InstallEnd@!\n';
  fs.writeFileSync(out, Buffer.concat([fs.readFileSync(stub), Buffer.from(config, 'utf8'), fs.readFileSync(payload)])); rmrf(payload); return out;
}
export async function buildWin({ out = DIST } = {}) {
  const v = version(), work = path.join(DIST, 'work'), zip = await fetchPinned(`node-v${NODE_VERSION}-win-x64.zip`), nd = path.join(work, 'node-win'); rmrf(nd); mkdirp(nd);
  sh('7z', ['e', '-y', '-bd', `-o${nd}`, zip, `node-v${NODE_VERSION}-win-x64/node.exe`]);
  const dir = assembleWin({ dir: path.join(work, 'win', 'Battle Map'), appDir: stage(path.join(work, 'stage')), nodeExe: path.join(nd, 'node.exe') });
  mkdirp(out); const zipOut = path.join(out, `Battle-Map-${v}-win-x64.zip`); rmrf(zipOut);
  if (have('zip')) sh('zip', ['-qr', zipOut, 'Battle Map'], { cwd: path.dirname(dir) }); else sh('7z', ['a', '-tzip', '-bd', zipOut, 'Battle Map'], { cwd: path.dirname(dir) });
  const lz = await fetchPinned('lzma2301.7z'), sd = path.join(work, 'sfx'); rmrf(sd); mkdirp(sd); sh('7z', ['e', '-y', '-bd', `-o${sd}`, lz, 'bin/7zS2.sfx']);
  const exe = sfxSetup({ dir, stub: path.join(sd, '7zS2.sfx'), out: path.join(out, `Battle-Map-${v}-Setup.exe`) });
  return { zip: zipOut, exe };
}

async function main(argv) {
  const [cmd = 'help'] = argv, want = (c) => cmd === c || cmd === 'all';
  if (!['stage', 'deb', 'appimage', 'tarball', 'win', 'all'].includes(cmd)) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  mkdirp(DIST);
  if (cmd === 'stage') console.log(stage(path.join(DIST, 'stage')));
  if (want('deb')) { if (have('dpkg-deb')) console.log(buildDeb()); else if (cmd === 'deb') throw new Error('dpkg-deb is needed for the .deb'); else console.log('skipping the .deb: no dpkg-deb'); }
  if (want('tarball')) console.log(await buildTarball());
  if (want('appimage')) { if (have('mksquashfs')) console.log(await buildAppImage()); else if (cmd === 'appimage') throw new Error('mksquashfs is needed for the AppImage (squashfs-tools)'); else console.log('skipping the AppImage: no mksquashfs'); }
  if (want('win')) { if (have('7z')) { const r = await buildWin(); console.log(r.zip); console.log(r.exe); } else if (cmd === 'win') throw new Error('7z is needed for the Windows build (p7zip-full)'); else console.log('skipping Windows: no 7z'); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
