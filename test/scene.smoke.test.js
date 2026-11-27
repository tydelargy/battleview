// Smoke test for web/scene.js using a tiny stand-in for three. It checks MY wiring
// (instance counts, capacity growth, flags, camera flights). It cannot check what
// real three draws; do that by eye with `npm install && npm start`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sampleFiles, samplePRs } from '../server/sample.js';
import { normalisePRs } from '../server/snapshot.js';
import { ageLift } from '../web/filters.js';

const FAKE_THREE = `
export const DynamicDrawUsage = 35048, ACESFilmicToneMapping = 4, PCFSoftShadowMap = 2;
export const MOUSE = { PAN: 2, DOLLY: 1, ROTATE: 0 }, TOUCH = { PAN: 1, DOLLY_ROTATE: 3 };
export class Vector3 { constructor(x=0,y=0,z=0){this.x=x;this.y=y;this.z=z}
  set(x,y,z){this.x=x;this.y=y;this.z=z;return this} copy(v){return this.set(v.x,v.y,v.z)} clone(){return new Vector3(this.x,this.y,this.z)}
  add(v){this.x+=v.x;this.y+=v.y;this.z+=v.z;return this} multiplyScalar(k){this.x*=k;this.y*=k;this.z*=k;return this}
  lerpVectors(a,b,t){return this.set(a.x+(b.x-a.x)*t,a.y+(b.y-a.y)*t,a.z+(b.z-a.z)*t)}
  distanceTo(v){return Math.hypot(this.x-v.x,this.y-v.y,this.z-v.z)}
  project(){ const z=this.z; this.x=this.x/1000; this.y=this.y/1000; this.z=0.5; return this } }
export class Vector2 { constructor(){this.x=0;this.y=0} set(x,y){this.x=x;this.y=y;return this} }
export class Quaternion { setFromAxisAngle(){return this} }
export class Matrix4 { compose(p,q,s){ this.p=p.clone(); this.s=s.clone(); return this } }
export class Color { constructor(c){this.c=c} set(c){this.c=c;return this} copy(o){this.c=o.c;return this} setHSL(){return this} offsetHSL(){return this} }
export class FogExp2 {}
export class Scene { constructor(){this.children=[]} add(o){this.children.push(o)} remove(o){this.children=this.children.filter(c=>c!==o)} }
export class PerspectiveCamera { constructor(fov){this.fov=fov;this.position=new Vector3();this.aspect=1} updateProjectionMatrix(){} }
export class HemisphereLight {}
export class DirectionalLight { constructor(){this.position=new Vector3();this.shadow={mapSize:{set(){}},camera:{}}} }
export class PlaneGeometry {} export class GridHelper { constructor(){this.position=new Vector3()} }
export class BoxGeometry { translate(){return this} clone(){return new BoxGeometry()} setAttribute(n,a){(this.attrs ||= {})[n]=a} }
export class InstancedBufferAttribute { constructor(a,n){this.array=a;this.itemSize=n} setUsage(){} } export class ConeGeometry { translate(){return this} rotateY(){return this} }
export class MeshStandardMaterial { constructor(o){Object.assign(this,o)} }
export class Mesh { constructor(g,m){this.geometry=g;this.material=m;this.rotation={};this.position=new Vector3()} }
export class InstancedMesh { constructor(g,m,cap){ this.geometry=g;this.material=m;this.cap=cap;this.count=0;this.mats=[];this.cols=[];this.instanceColor=null;this.instanceMatrix={setUsage(){}};this.userData={}; (globalThis.__meshes ||= []).push(this) }
  setMatrixAt(i,m){ if(i>=this.cap) throw new Error('instance index '+i+' beyond capacity '+this.cap); this.mats[i]=m }
  setColorAt(i,c){ if(i>=this.cap) throw new Error('color index beyond capacity'); this.instanceColor ||= {}; this.cols[i]=c }
  dispose(){ this.disposed=true } }
export class Raycaster { setFromCamera(){} intersectObjects(){ return [] } }
export class WebGLRenderer { constructor(){ this.domElement=globalThis.__el(); this.shadowMap={}; } setPixelRatio(){} setSize(){} render(){ globalThis.__renders=(globalThis.__renders||0)+1 } dispose(){} }
`;
const FAKE_ORBIT = `import { Vector3 } from 'three';
export class OrbitControls { constructor(cam){ this.object=cam; this.target=new Vector3(); this.listeners={} } update(){} addEventListener(n,f){ this.listeners[n]=f } }`;

function el() {
  const e = { style: {}, dataset: {}, children: [], _l: {}, textContent: '', innerHTML: '', clientWidth: 1200, clientHeight: 800,
    classList: { toggle(){}, add(){}, remove(){} }, appendChild(c){ e.children.push(c); return c }, removeChild(c){ e.children = e.children.filter((x)=>x!==c) },
    append(...c){ e.children.push(...c) }, setAttribute(){}, firstChild: { setAttribute(){} }, lastChild: { setAttribute(){} }, remove(){}, addEventListener(n, f){ e._l[n] = f }, setProperty(){}, getBoundingClientRect(){ return { left: 0, top: 0, width: 1200, height: 800 } } };
  e.style.setProperty = () => {}; return e;
}

test('scene wiring with a stand-in three', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bm-scene-'));
  const tdir = path.join(dir, 'node_modules/three'); fs.mkdirSync(path.join(tdir, 'examples/jsm/controls'), { recursive: true });
  fs.writeFileSync(path.join(tdir, 'package.json'), JSON.stringify({ name: 'three', type: 'module', exports: { '.': './index.js', './addons/*': './examples/jsm/*' } }));
  fs.writeFileSync(path.join(tdir, 'index.js'), FAKE_THREE); fs.writeFileSync(path.join(tdir, 'examples/jsm/controls/OrbitControls.js'), FAKE_ORBIT);
  fs.mkdirSync(path.join(dir, 'web')); for (const f of ['scene.js', 'layout.js', 'spires.js', 'filters.js', 'building.js', 'sites.js', 'changes.js', 'placement.js']) fs.copyFileSync(path.join(import.meta.dirname, '../web', f), path.join(dir, 'web', f));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');

  const frames = []; globalThis.requestAnimationFrame = (f) => { frames.push(f); return frames.length; };
  globalThis.window = { devicePixelRatio: 2 }; globalThis.ResizeObserver = class { observe() {} };
  globalThis.document = { createElement: () => el(), createElementNS: () => el() }; globalThis.__el = el; globalThis.__meshes = [];
  const run = async (n, t0 = 1000) => { for (let i = 0; i < n; i++) { const f = frames.shift(); if (f) f(t0 + i * 700); } };

  const { createScene } = await import(pathToFileURL(path.join(dir, 'web/scene.js')).href);
  const host = el(), flags = [];
  const sc = createScene(host, { makeFlag: (pr) => { const f = el(); f.pr = pr; flags.push(f); return f; }, updateFlag() {} });
  const { prs } = normalisePRs(samplePRs());
  const files = sampleFiles();
  sc.setFiles(files); sc.setStyle({ mode: 'plain' });
  const meshes = () => { const m = globalThis.__meshes.filter((x) => !x.disposed); return m; };
  const count = (geo, glass) => meshes().filter((m) => m.geometry.constructor.name === geo && !!m.material.transparent === glass).reduce((a, m) => a + m.count, 0);
  assert.equal(sc.info().buildings, files.length);

  sc.setPRs(prs, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: { ci_failing: '#f00' } });
  await run(4);
  const nCols = prs.reduce((a, p) => a + p.files.length, 0);
  const focus0 = () => prs.find((p) => p.id === '#2291');
  assert.equal(sc.info().columns, nCols); assert.equal(sc.info().flags, prs.length);
  assert.equal(count('BoxGeometry', false) >= nCols, true);        // buildings + plates + spires, all solid
  assert.equal(count('ConeGeometry', false), nCols, 'one cap per column');
  assert.equal(count('ConeGeometry', true), 0);

  // building style: plain is one box per file; the full style adds silhouettes and roof gear; toppers follow the roofs
  const bld = () => meshes().find((m) => m.geometry.attrs?.aWin);
  const winAttr = () => bld().geometry.attrs.aWin.array;
  sc.setStyle({ mode: 'plain' }); assert.equal(bld().count, files.length, 'plain: one box per file');
  assert.equal(winAttr()[0], -1, 'plain has no windows');
  sc.setStyle({ mode: 'colors' }); assert.equal(bld().count, files.length);
  sc.setStyle({ mode: 'full', variety: 1, salt: 0 });
  const plainBoxes = bld().count; assert.ok(plainBoxes >= files.length && plainBoxes <= files.length * 2, 'variety 1: plain boxes, plus roof gear');
  sc.setStyle({ variety: 4 }); const four = bld().count; sc.setStyle({ variety: 7 }); assert.ok(bld().count >= four, 'more silhouettes, more parts');
  sc.setStyle({ variety: 7 }); assert.ok(bld().count > plainBoxes, 'silhouettes add parts');
  sc.setStyle({ height: 2.5 }); sc.setStyle({ height: 1.5 });
  assert.ok(Array.from({ length: bld().count }, (_, i) => winAttr()[i * 4]).some((w) => w >= 0), 'facades get a window style');
  const info = sc.buildingInfo('packages/core/domain/pricing.ts'); assert.match(info.code, /^[A-Z]-\d\d$/);
  // which windows are lit is part of a building's identity: hover, highlight and fog must not change it
  const litPattern = () => Array.from({ length: bld().count }, (_, i) => [winAttr()[i * 4], winAttr()[i * 4 + 1], winAttr()[i * 4 + 2]].join()).join('|');
  const before = litPattern();
  sc.setHighlight(['packages/core/domain/pricing.ts']); assert.equal(litPattern(), before, 'highlight leaves the lit windows alone');
  sc.setHighlight([]); sc.setPRs(prs, { mode: 'sqrt', focusId: '#2291', visible: null, fog: false, statusColors: {} }); assert.equal(litPattern(), before, 'so do focus and fog');
  sc.setPRs(prs, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {} });
  sc.setStyle({ salt: 1 }); assert.notEqual(sc.buildingInfo('packages/core/domain/pricing.ts').code, info.code, 'a new salt reshuffles');
  sc.setStyle({ salt: 0 }); assert.equal(sc.buildingInfo('packages/core/domain/pricing.ts').code, info.code, 'and the old one brings it back');
  assert.equal(sc.buildingInfo('no/such'), null);
  sc.setStyle({ density: 1.6 }); sc.setStyle({ mode: 'full', variety: 4, salt: 0 });
  sc.setPRs(prs, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {} });
  assert.equal(sc.info().columns, nCols, 'every topper still finds a roof');

  // construction sites: cranes (and taped floors) in the overview, scaffolding for the focused PR, glass for the rest; no cone caps
  const solidBoxN = () => meshes().filter((m) => m.geometry.constructor.name === 'BoxGeometry' && !m.material.transparent).reduce((a, m) => a + m.count, 0);
  const glassBoxN = () => meshes().filter((m) => m.geometry.constructor.name === 'BoxGeometry' && m.material.transparent).reduce((a, m) => a + m.count, 0);
  sc.setStyle({ mode: 'full', variety: 7 });
  sc.setPRs(prs, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {} }); await run(4);
  assert.equal(count('ConeGeometry', false), 0, 'cranes have no cone cap');
  const craneBoxes = glassBoxN() + solidBoxN();
  sc.setPRs(prs, { mode: 'sqrt', focusId: '#2291', visible: null, fog: true, statusColors: {} }); await run(4);
  assert.ok(glassBoxN() >= (nCols - focus0().files.length) * 7, 'other PRs keep their cranes, as glass');
  assert.ok(solidBoxN() > 0 && craneBoxes > nCols * 7, 'a crane is several boxes');
  assert.equal(sc.info().columns, nCols);
  sc.setStyle({ mode: 'plain' });

  // the focus views also work on the simple styles: a focused PR's columns become sites, the others stay toppers
  sc.setPRs(prs, { mode: 'sqrt', focusId: '#2291', visible: null, fog: true, statusColors: {} }); await run(4);
  assert.equal(sc.info().sites, 0, 'plain, default focus view (hunks): toppers only');
  const topperCaps = count('ConeGeometry', false) + count('ConeGeometry', true);
  sc.setStyle({ mode: 'plain', focus: 'crates' }); sc.setPRs(prs, { mode: 'sqrt', focusId: '#2291', visible: null, fog: true, statusColors: {} }); await run(4);
  assert.equal(sc.info().sites, focus0().files.length, 'only the focused PR is drawn as sites on plain blocks');
  assert.equal(count('ConeGeometry', false), 0, 'its columns have no cone caps'); assert.equal(count('ConeGeometry', true), nCols - focus0().files.length, 'the other PRs stay glass toppers');
  sc.setStyle({ mode: 'colors', focus: 'lines' }); assert.equal(sc.info().sites, focus0().files.length); sc.setStyle({ mode: 'plain', focus: null });
  assert.ok(topperCaps >= 0);

  // focus: the focused PR's columns become hunk stacks, everything else turns to glass
  const focus = prs.find((p) => p.id === '#2291');
  sc.setPRs(prs, { mode: 'sqrt', focusId: '#2291', visible: null, fog: true, statusColors: {} });
  await run(4);
  const hunkParts = focus.files.reduce((a, f) => a + f.hunks.reduce((s, h) => s + (h.add > 0) + (h.del > 0), 0), 0);
  assert.equal(count('ConeGeometry', false), focus.files.length, 'solid caps only for the focused PR');
  assert.equal(count('ConeGeometry', true), nCols - focus.files.length, 'others are glass');
  assert.equal(count('BoxGeometry', true), nCols - focus.files.length, 'glass columns are single blocks');
  const solidBoxes = meshes().filter((m) => m.geometry.constructor.name === 'BoxGeometry' && !m.material.transparent);
  assert.ok(solidBoxes.some((m) => m.count >= hunkParts), 'hunk segments drawn');

  // growing past initial capacity must reallocate instead of overflowing
  const many = Array.from({ length: 220 }, (_, i) => ({ ...prs[i % prs.length], id: 'x' + i }));
  sc.setPRs(many, { mode: 'linear', focusId: 'x1', visible: null, fog: false, statusColors: {} });
  await run(4);
  assert.ok(sc.info().columns > 512, 'beyond the initial instance capacity');
  assert.ok(meshes().some((m) => m.cap > 512), 'pools were reallocated');

  // watched files get a four-piece frame each; unknown paths are ignored; the layer can be switched off
  sc.setWatched(['apps/web/pages/billing.tsx', 'packages/core/domain/pricing.ts', 'no/such/file.ts']);
  assert.equal(sc.info().watched, 2);
  const frames4 = () => meshes().filter((m) => m.geometry.constructor.name === 'BoxGeometry' && m.material.emissive === 0x1f7a9e).reduce((a, m) => a + m.count, 0);
  assert.equal(frames4(), 8, 'four edges per watched file');
  sc.setUI({ watched: false }); assert.equal(sc.info().watched, 0); assert.equal(frames4(), 0);
  sc.setUI({ watched: true }); assert.equal(sc.info().watched, 2);
  sc.setFiles(files); assert.equal(sc.info().watched, 2, 'survives a snapshot refresh');
  sc.setWatched([]); assert.equal(frames4(), 0);

  // flags can be raised by age: older PRs get taller poles, by the same amount the pure model says; off means no lift
  const aged = prs.map((p, i) => ({ ...p, createdAt: new Date(Date.now() - (i === 0 ? 30 : 0.1) * 86400_000).toISOString() }));
  sc.setPRs(aged, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {}, ageLift: false });
  const flat = sc.flagHeights();
  sc.setPRs(aged, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {}, ageLift: true });
  const lifted = sc.flagHeights();
  assert.ok(Math.abs(lifted[aged[0].id] - flat[aged[0].id] - ageLift(30)) < 1e-6, 'a month-old PR is lifted by ageLift(30)');
  assert.ok(lifted[aged[1].id] - flat[aged[1].id] < ageLift(30) / 5, 'a fresh one barely moves');
  sc.setPRs(aged, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {}, ageLift: false });
  assert.deepEqual(sc.flagHeights(), flat, 'switching it off puts them back');
  sc.setPRs(prs, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {}, ageLift: true });   // no createdAt at all: no lift, no crash
  assert.ok(Object.values(sc.flagHeights()).every(Number.isFinite));

  // filter by visibility
  sc.setPRs(prs, { mode: 'log', focusId: null, visible: new Set(['#2302']), fog: true, statusColors: {} });
  await run(3);
  assert.equal(sc.info().columns, 4); assert.equal(sc.info().flags, 1);
  assert.ok(flags.some((f) => f.style.transform), 'flags were positioned');

  sc.setPRs(prs, { mode: 'sqrt', focusId: '#2302', visible: null, fog: true, statusColors: {} });
  sc.flyToPR('#2302'); sc.flyToFile('apps/web/pages/billing.tsx'); sc.setView('2d'); sc.flyHome(); sc.setHighlight(['apps/web/pages/billing.tsx']);
  await run(6, 5000);
  assert.ok(globalThis.__renders > 10);

  // files that come, go and move: a new file has no building (a ghost, and its PR still gets a flag); a deleted one is a taped building; a move arcs once something places it
  sc.setStyle({ mode: 'full', variety: 7 });
  const { prs: ch } = normalisePRs([
    { id: '#9001', title: 'adds a file', author: 'x', status: 'review_requested', files: [{ path: 'brand/new/thing.ts', add: 50, del: 0, change: 'added' }] },
    { id: '#9002', title: 'deletes one', author: 'y', status: 'review_requested', files: [{ path: 'packages/core/domain/pricing.ts', add: 0, del: 400, change: 'removed' }] },
    { id: '#9003', title: 'moves one', author: 'z', status: 'review_requested', files: [{ path: 'packages/core/new-home/tax.ts', add: 0, del: 0, change: 'renamed', from: 'packages/core/domain/tax.ts' }] }]);
  sc.setPRs(ch, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {} }); await run(4);
  const baseLeaves = 64;
  assert.equal(sc.info().ghosts, 2, 'the new file and the moved-in file each have a plot, with nothing focused'); assert.equal(sc.info().placed, 2); assert.equal(sc.info().moves, 1, 'and the move has its arc');
  const where = () => JSON.stringify(sc.layout().leaves.map((l) => [l.path, l.x, l.y, l.w, l.h]));
  assert.equal(sc.layout().leaves.length, baseLeaves + 2, 'the map has room made for both'); assert.ok(sc.layout().leaves.filter((l) => l.ghost).length === 2);
  const still = where();
  for (const focusId of ['#9001', '#9002', '#9003', null]) { sc.setPRs(ch, { mode: 'sqrt', focusId, visible: null, fog: true, statusColors: {} }); await run(3); assert.equal(where(), still, `focusing ${focusId} moves nothing`); assert.equal(sc.info().placed, 2); }
  sc.setPRs(ch, { mode: 'sqrt', focusId: null, visible: new Set(['#9002']), fog: true, statusColors: {} }); await run(3); assert.equal(where(), still, 'filtering PRs out moves nothing either'); assert.equal(sc.info().ghosts, 0, 'though their plots are not drawn');
  sc.setPRs(ch, { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {} }); await run(3);
  assert.equal(sc.info().columns, 2, 'the deleted file and the old home of the move are columns on real buildings'); assert.equal(sc.info().flags, 3, 'every PR is on the map somewhere, including the one that only adds a file');
  sc.setPRs(ch.slice(1), { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {} }); await run(3); assert.equal(sc.layout().leaves.length, baseLeaves + 1, 'untrack the PR that adds a file and its plot goes: the only thing that changes the map');
  sc.setPRs([], { mode: 'sqrt', focusId: null, visible: null, fog: true, statusColors: {} }); assert.equal(sc.info().ghosts, 0); assert.equal(sc.info().flags, 0);
  sc.dispose();
});
