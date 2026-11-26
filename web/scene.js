// Three.js renderer for the battle map. Geometry decisions live in layout.js and
// spires.js (pure, tested); this file only turns them into meshes, a camera and an overlay.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildLayout, WORLD } from './layout.js';
import { planSpires, DIFF_COLORS } from './spires.js';
import { ageDays, ageLift } from './filters.js';
import { buildingFor, DEFAULT_STYLE, SHAPES } from './building.js';
import { siteParts } from './sites.js';

const CX = WORLD.w / 2, CY = WORLD.h / 2;
const FLAG_W = { collapsed: 78, expanded: 214 }, FLAG_H = 34;
const SVGNS = 'http://www.w3.org/2000/svg';
const ease = (t) => 1 - Math.pow(1 - t, 3);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _b = new THREE.Color(), _v = new THREE.Vector3();
const QID = new THREE.Quaternion();
// Per-instance data for the building shader (see the comment above WINDOW_VERT). Reused arrays: Pool.push copies them.
const EX = { a: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], set(t, fogged) {
  const [a, b, c] = this.a; a[0] = t.window; a[1] = t.lit; a[2] = t.hf % 65521; a[3] = fogged ? 0.25 : 1;   // which windows are lit never depends on fog, hover or selection; only how brightly they glow
  b[0] = t.cell; b[1] = t.material; const k = fogged ? 0.6 : 1; c[0] = t.litRgb[0] * k; c[1] = t.litRgb[1] * k; c[2] = t.litRgb[2] * k; return this.a; } }, EX_NONE = [[-1, 0, 0, 0], [1, 0, 0, 0], [0, 0, 0, 0]];

// Three ways to look at the map. Isometric and 2D use a very narrow field of view
// from far away, which is visually parallel projection but keeps one camera type.
const VIEWS = {
  '3d': { fov: 42, polar: 0.93, az: Math.PI / 4, rotate: true },
  iso: { fov: 10, polar: 0.9553, az: Math.PI / 4, rotate: false },   // 54.74 degrees from vertical = true isometric
  '2d': { fov: 10, polar: 0.0008, az: 0, rotate: false },
};
const rangeScale = (kind) => Math.tan((VIEWS['3d'].fov * Math.PI) / 360) / Math.tan((VIEWS[kind].fov * Math.PI) / 360);

/** A growable InstancedMesh with parallel metadata, so picks map back to PRs and files. */
class Pool {
  constructor(scene, geometry, material, { cast = false, attrs = [] } = {}) {
    this.scene = scene; this.geometry = geometry; this.material = material; this.cast = cast; this.attrs = attrs; this.extra = [];
    this.cap = 0; this.n = 0; this.meta = []; this.mesh = null; this.alloc(512);
  }
  alloc(cap) {
    if (this.mesh) { this.scene.remove(this.mesh); this.mesh.dispose(); }
    this.cap = cap;
    this.extra = this.attrs.map((name) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); a.setUsage(THREE.DynamicDrawUsage); this.geometry.setAttribute(name, a); return a; });
    const mesh = new THREE.InstancedMesh(this.geometry, this.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false; mesh.castShadow = this.cast; mesh.receiveShadow = true; mesh.count = 0;
    mesh.userData.pool = this;
    this.mesh = mesh; this.scene.add(mesh);
  }
  begin(expected) { if (expected > this.cap) this.alloc(Math.ceil(expected * 1.5)); this.n = 0; this.meta.length = 0; }
  push(pos, scale, color, meta, extra, quat) {
    const i = this.n++;
    if (extra) extra.forEach((v, k) => this.extra[k].array.set(v, i * 4));
    _m.compose(pos, quat || QID, scale);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.setColorAt(i, color);
    this.meta[i] = meta;
  }
  end() {
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    for (const a of this.extra) a.needsUpdate = true;
    this.mesh.boundingSphere = null;       // so raycasts see the new instances
  }
}

// Walls and windows are painted by the building material, not by meshes: each instance carries a few vec4s
//   aWin  = (window style or -1, lit fraction, seed, glow)   aWin2 = (window cell size, wall material, 0, 0)   aLit = lit window colour
// and the fragment shader cuts each facade into a whole number of cells from the box's world size, so a block costs
// the same as a wall and windows tile whatever the building's size. Everything is anti-aliased and fades to an average
// colour when a cell is smaller than a couple of pixels, so nothing shimmers when you zoom or orbit.
const WINDOW_VERT = `
attribute vec4 aWin; attribute vec4 aWin2; attribute vec4 aLit;
flat varying vec4 vWin; flat varying vec4 vWin2; flat varying vec4 vLit; varying vec3 vObj; flat varying vec3 vNrm; flat varying vec3 vDim;`;
const WINDOW_VERT_BODY = `
  vWin = aWin; vWin2 = aWin2; vLit = aLit; vObj = position; vNrm = normal;
  #ifdef USE_INSTANCING
  vDim = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
  #else
  vDim = vec3(1.0);
  #endif`;
const WINDOW_FRAG = `
uniform float uDens; uniform float uTex;
flat varying vec4 vWin; flat varying vec4 vWin2; flat varying vec4 vLit; varying vec3 vObj; flat varying vec3 vNrm; flat varying vec3 vDim;
float winRnd(float seed, float k) {
  uint x = (uint(seed + 0.5) * 2654435761u) ^ (uint(abs(k) + 0.5) * 2654435769u);
  x ^= x >> 16; x *= 2246822507u; x ^= x >> 13; x *= 3266489909u; x ^= x >> 16;
  return float(x) / 4294967296.0;
}
// coverage of [a, b] at x for a pixel that spans w (box filter), so edges are smooth instead of stair-stepped
float span(float x, float a, float b, float w) { w = max(w, 1e-4); return clamp((x - a) / w + 0.5, 0.0, 1.0) * clamp((b - x) / w + 0.5, 0.0, 1.0); }`;
const WINDOW_FRAG_BODY = `
  #include <color_fragment>
  float winGlow = 0.0;
  // Everything that needs screen-space derivatives is computed here, before any branch: fwidth() inside a branch that
  // neighbouring pixels do not all take is undefined, which shows up as pixels that change from frame to frame.
  vec3 an = abs(vNrm);
  bool spanX = an.z > an.x;
  float lu = spanX ? vDim.x : vDim.z, lh = vDim.y;
  float u = (spanX ? vObj.x : vObj.z) + 0.5, v = vObj.y;
  float wu = u * lu, wv = v * lh;                           // world units across and up the wall
  float dwu = fwidth(wu), dwv = fwidth(wv);                 // how many world units one pixel covers
  if (vWin.x > -0.5) {
    if (an.y < 0.5) {
      float face = spanX ? (vNrm.z > 0.0 ? 1.0 : 2.0) : (vNrm.x > 0.0 ? 3.0 : 4.0);
      vec3 base = diffuseColor.rgb, wall = base;
      // ---- wall material: brick, stone, steel (concrete is the plain colour) ----
      float mat = vWin2.y;
      if (uTex > 0.5 && mat > 0.5) {
        if (mat < 1.5) {                                    // brick: running bond
          float rows = wv / 1.5, row = floor(rows), x = wu / 3.6 + mod(row, 2.0) * 0.5, fx = fract(x), fy = fract(rows);
          float dx = dwu / 3.6, dy = dwv / 1.5, px = max(dx, dy), body = span(fx, 0.04, 0.96, dx) * span(fy, 0.1, 0.92, dy);
          float tint = 0.9 + 0.2 * winRnd(vWin.z, row * 53.0 + floor(x) * 17.0 + 5.0);
          vec3 brick = wall * vec3(1.25, 0.85, 0.72) * tint, mortar = wall * 0.62 + 0.07;
          vec3 near = mix(mortar, brick, body), far = brick * 0.93 + mortar * 0.07;
          wall = mix(near, far, smoothstep(0.15, 0.4, px));
        } else if (mat < 2.5) {                             // stone: big blocks with their own tone
          float rows = wv / 2.8, row = floor(rows), x = wu / 5.5 + winRnd(vWin.z, row + 90.0), fx = fract(x), fy = fract(rows);
          float dx = dwu / 5.5, dy = dwv / 2.8, px = max(dx, dy), body = span(fx, 0.03, 0.97, dx) * span(fy, 0.05, 0.95, dy);
          float tint = 0.82 + 0.3 * winRnd(vWin.z, row * 31.0 + floor(x) * 13.0 + 11.0);
          vec3 block = mix(wall, vec3(dot(wall, vec3(0.3, 0.59, 0.11))), 0.55) * 1.12 * tint + 0.03, joint = wall * 0.5;
          vec3 near = mix(joint, block, body), far = block * 0.96 + joint * 0.04;
          wall = mix(near, far, smoothstep(0.15, 0.4, px));
        } else {                                            // steel: tall panels with seams and a faint sheen
          float x = wu / 2.6, fx = fract(x), rows = wv / 9.0, fy = fract(rows);
          float dx = dwu / 2.6, dy = dwv / 9.0, px = max(dx, dy), body = span(fx, 0.04, 0.96, dx) * span(fy, 0.015, 1.0, dy);
          float tint = 0.96 + 0.08 * winRnd(vWin.z, floor(x) * 7.0 + 3.0);
          vec3 panel = wall * vec3(0.82, 0.96, 1.22) * tint * (1.0 + 0.12 * v), seam = wall * 0.55;
          vec3 near = mix(seam, panel, body), far = panel * 0.97 + seam * 0.03;
          wall = mix(near, far, smoothstep(0.15, 0.4, px));
        }
      }
      // ---- windows: a whole number of cells per face, so they tile whatever the size ----
      float cell = vWin2.x / uDens, nc, nr, u0 = 0.2, u1 = 0.8, v0 = 0.25, v1 = 0.7;
      if (vWin.x < 0.5) { nc = max(1.0, floor(lu / cell + 0.5)); nr = max(1.0, floor(lh / cell + 0.5)); }
      else if (vWin.x < 1.5) { nc = 1.0; nr = max(1.0, floor(lh / (cell * 1.5) + 0.5)); u0 = 0.07; u1 = 0.93; }
      else { nc = max(1.0, floor(lu / (cell * 1.1) + 0.5)); nr = 1.0; v0 = 0.1; v1 = 0.88; }
      float fu = u * nc, fv = v * nr, wpx = dwu * nc / lu, hpx = dwv * nr / lh;
      float i = min(floor(fu), nc - 1.0), j = min(floor(fv), nr - 1.0);
      float cu = fu - i, cv = fv - j;
      float cover = span(cu, u0, u1, wpx) * span(cv, v0, v1, hpx);
      float fade = 1.0 - smoothstep(0.1, 0.3, max(wpx, hpx));   // cells under about three pixels become their average
      bool on = winRnd(vWin.z, face * 1000.0 + i * 31.0 + j * 7.0 + 200.0) < vWin.y;
      vec3 dark = base * vec3(0.38, 0.42, 0.52), lit = vLit.rgb;   // unlit glass is its own colour: nothing of the wall texture shows through
      float wf = (u1 - u0) * (v1 - v0);
      vec3 near = mix(wall, on ? lit : dark, cover);
      vec3 far = mix(wall, mix(dark, lit, vWin.y), wf);
      diffuseColor.rgb = mix(far, near, fade);
      winGlow = mix(vWin.w * vWin.y * wf, on ? vWin.w * cover : 0.0, fade);
    }
  }`;
function windowMaterial(uDens, uTex) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.78, metalness: 0.05 });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.uDens = uDens; sh.uniforms.uTex = uTex;
    sh.vertexShader = sh.vertexShader.replace('void main() {', WINDOW_VERT + '\nvoid main() {').replace('#include <begin_vertex>', '#include <begin_vertex>' + WINDOW_VERT_BODY);
    sh.fragmentShader = sh.fragmentShader.replace('void main() {', WINDOW_FRAG + '\nvoid main() {').replace('#include <color_fragment>', WINDOW_FRAG_BODY)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += vLit.rgb * winGlow * 0.32;');
  };
  return m;
}

export function createScene(host, handlers = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
  host.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080b10);
  scene.fog = new THREE.FogExp2(0x080b10, 0.00055);

  const camera = new THREE.PerspectiveCamera(VIEWS['3d'].fov, 1, 5, 20000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.09; controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI / 2 - 0.04; controls.zoomToCursor = true;

  function applyViewLimits(kind) {
    const v = VIEWS[kind], r = rangeScale(kind);
    controls.minDistance = 14 * r; controls.maxDistance = 2400 * r;
    controls.enableRotate = v.rotate;
    controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: v.rotate ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN };
    controls.touches = { ONE: THREE.TOUCH.PAN, TWO: v.rotate ? THREE.TOUCH.DOLLY_ROTATE : THREE.TOUCH.DOLLY_PAN };
  }
  applyViewLimits('3d');

  scene.add(new THREE.HemisphereLight(0xc2d2ff, 0x1a2230, 1.15));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.3);
  sun.position.set(-380, 620, 260); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.6;
  Object.assign(sun.shadow.camera, { left: -640, right: 640, top: 640, bottom: -640, near: 10, far: 1600 });
  scene.add(sun);

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.MeshStandardMaterial({ color: 0x0b1018, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.4; ground.receiveShadow = true; scene.add(ground);
  const grid = new THREE.GridHelper(1400, 28, 0x1d2b3d, 0x131c29); grid.position.y = -0.3; scene.add(grid);

  const unitBox = new THREE.BoxGeometry(1, 1, 1); unitBox.translate(0, 0.5, 0);
  const cone = new THREE.ConeGeometry(1, 1, 4, 1); cone.rotateY(Math.PI / 4); cone.translate(0, 0.5, 0);
  const solid = () => new THREE.MeshStandardMaterial({ roughness: 0.45, metalness: 0.12, emissive: 0x1a1a1a });
  const glassMat = () => new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.0, transparent: true, opacity: 0.24, depthWrite: false });
  const plateMesh = new Pool(scene, unitBox, new THREE.MeshStandardMaterial({ roughness: 0.95 }));
  const uDens = { value: DEFAULT_STYLE.density }, uTex = { value: 1 };
  const buildings = new Pool(scene, unitBox.clone(), windowMaterial(uDens, uTex), { cast: true, attrs: ['aWin', 'aWin2', 'aLit'] });
  const rims = new Pool(scene, unitBox, new THREE.MeshStandardMaterial({ color: 0xffb347, roughness: 0.6, emissive: 0x3a2400 }));
  // Cyan frame on every file a path rule covers, so what you are watching stays visible even with no PR on it.
  const watchRims = new Pool(scene, unitBox, new THREE.MeshStandardMaterial({ color: 0x4cc9f0, roughness: 0.4, emissive: 0x1f7a9e }));
  const boxes = new Pool(scene, unitBox, solid(), { cast: true });
  const caps = new Pool(scene, cone, solid(), { cast: true });
  const gBoxes = new Pool(scene, unitBox, glassMat());
  const gCaps = new Pool(scene, cone, glassMat());
  const pickables = () => [boxes.mesh, caps.mesh, gBoxes.mesh, gCaps.mesh, buildings.mesh];

  // ---- HTML/SVG overlay (labels, flags, poles, supply lines) ----
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none';
  host.appendChild(overlay);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'bm-svg'); svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none';
  overlay.appendChild(svg);
  const gPoles = document.createElementNS(SVGNS, 'g'), gLines = document.createElementNS(SVGNS, 'g');
  svg.append(gPoles, gLines);
  const poles = new Map(), lines = [];
  const svgEl = (name, cls) => { const e = document.createElementNS(SVGNS, name); e.setAttribute('class', cls); return e; };
  const pool = (cls, max) => { const els = []; for (let i = 0; i < max; i++) { const e = document.createElement('div'); e.className = cls; e.style.display = 'none'; overlay.appendChild(e); els.push(e); } return els; };
  const plateLabels = pool('lbl plate', 70), fileLabels = pool('lbl file', 48), diffLabels = pool('lbl diff', 40);

  // ---- state ----
  const S = {
    layout: null, filesKey: '', prs: [], opts: { mode: 'sqrt', topper: 'share', focusId: null, visible: null, fog: true, statusColors: {}, view: '3d' },
    ui: { labels: true, flags: true, lines: 'selected', watched: true }, watched: new Set(),
    style: { ...DEFAULT_STYLE }, styled: new Map(), occupied: new Set(),
    columns: [], growth: { t0: 0, dur: 520, active: false, p: 1 }, flags: new Map(), hover: null, highlight: new Set(), touched: new Set(), contested: new Set(), tween: null, size: { w: 1, h: 1 }, focusLabels: [],
  };

  function resize() {
    const w = host.clientWidth || 1, h = host.clientHeight || 1;
    S.size = { w, h }; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host); resize();

  // ---- static city ----
  function setFiles(files) {
    let hsh = 2166136261;
    for (const f of files) { const t = f.path + ':' + f.loc + ':' + (f.complexity ?? 0); for (let i = 0; i < t.length; i++) { hsh ^= t.charCodeAt(i); hsh = Math.imul(hsh, 16777619); } }
    const key = files.length + ':' + (hsh >>> 0);
    S.layout = buildLayout(files);
    restyle();
    if (key === S.filesKey) { refreshBuildings(); drawWatch(); return; }
    S.filesKey = key;
    const L = S.layout;
    plateMesh.begin(L.plates.length);
    for (const p of L.plates) {
      const hgt = 0.25 * p.depth;
      _c.setHSL(p.hue / 360, p.depth === 1 ? 0.3 : 0.24, p.depth === 1 ? 0.13 : 0.16 + 0.01 * p.depth);
      plateMesh.push(_p.set(p.x + p.w / 2 - CX, 0, p.y + p.h / 2 - CY), _s.set(p.w, hgt, p.h), _c, p);
    }
    plateMesh.end();
    refreshBuildings(); drawWatch();
  }

  // ---- building style (hashed looks; see web/building.js) ----
  // Which boxes and roof each file gets. Roofs matter outside this file too: toppers and rims stand on them.
  function restyle() {
    S.styled = new Map();
    for (const l of S.layout?.leaves || []) S.styled.set(l.path, buildingFor(l, S.style, { gear: !S.occupied.has(l.path) }));
  }
  const roofOf = (l) => { const b = S.styled.get(l.path); const r = b ? b.roof : { ...l.r, z: l.height }; return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, w: r.w, h: r.h, top: r.z }; };
  const roofMap = () => new Map([...S.styled].map(([path, b]) => [path, { r: b.roof, height: b.roof.z }]));
  function setStyle(next) {
    const st = { ...S.style, ...next }, geometry = st.mode !== S.style.mode || st.spread !== S.style.spread || st.variety !== S.style.variety || st.salt !== S.style.salt || st.height !== S.style.height;
    S.style = st; uDens.value = st.density; uTex.value = st.texture ? 1 : 0;
    if (!S.layout) return;
    if (geometry) { restyle(); setPRs(S.prs, {}); drawWatch(); } else refreshBuildings();
  }

  const statusColor = (st) => S.opts.statusColors[st] || '#8792a2';
  function refreshBuildings() {
    const L = S.layout; if (!L) return;
    const full = S.style.mode === 'full', hashed = S.style.mode !== 'plain';
    buildings.begin(L.leaves.length * (full ? 6 : 1));
    L.leaves.forEach((l, i) => {
      const touched = S.touched.has(l.path), lit = S.highlight.has(l.path) || (S.hover && S.hover.path === l.path);
      const fogged = S.opts.fog && !touched && !lit;
      const b = S.styled.get(l.path), t = b?.t;
      // plain: the folder hue with a little jitter. hashed: this file's own hue, saturation and lightness inside the folder's family.
      if (!hashed) { const jitter = ((i * 2654435761) % 1000) / 1000; _c.setHSL(l.hue / 360, fogged ? 0.14 : 0.42, (fogged ? 0.21 : 0.33) + jitter * 0.06 + (lit ? 0.22 : 0)); }
      else if (fogged) _c.setHSL(t.hue / 360, 0.12 + ((t.sat - 48) / 14) * 0.1, 0.16 + ((t.light - 40) / 14) * 0.1);   // dim, but still this file's own shade
      else _c.setHSL(t.hue / 360, t.sat / 100 * 0.8, (t.light - 8) / 100 + (lit ? 0.22 : 0));
      _b.copy(_c);
      for (const part of b.parts) {
        const col = _c.copy(_b); if (part.dl) col.offsetHSL(0, 0, part.dl / 100);
        buildings.push(_p.set(part.x + part.w / 2 - CX, part.z, part.y + part.d / 2 - CY), _s.set(part.w, part.h, part.d), col, l,
          full && !part.gear ? EX.set(t, fogged) : EX_NONE);
      }
    });
    buildings.end();
  }

  function drawWatch() {
    const L = S.layout, shown = S.ui.watched && L ? [...S.watched].filter((p) => L.byPath.has(p)) : [];
    watchRims.begin(shown.length * 4);
    for (const path of shown) {
      const r = roofOf(L.byPath.get(path)), t = 0.75, y = r.top - 0.3, x = r.cx - CX, z = r.cy - CY;
      watchRims.push(_p.set(x, y, z - r.h / 2 - t / 2), _s.set(r.w + t * 2, 0.9, t), _c.set(0xffffff), { path });
      watchRims.push(_p.set(x, y, z + r.h / 2 + t / 2), _s.set(r.w + t * 2, 0.9, t), _c, { path });
      watchRims.push(_p.set(x - r.w / 2 - t / 2, y, z), _s.set(t, 0.9, r.h), _c, { path });
      watchRims.push(_p.set(x + r.w / 2 + t / 2, y, z), _s.set(t, 0.9, r.h), _c, { path });
    }
    watchRims.end();
    S.watchedShown = shown.length;
  }

  // ---- diff layer ----
  function setPRs(prs, opts = {}) {
    const next = { ...S.opts, ...opts };
    const regrow = (next.focusId ?? null) !== (S.opts.focusId ?? null) || next.mode !== S.opts.mode || next.topper !== S.opts.topper;
    S.prs = prs; S.opts = next;
    S.columns = S.layout ? planSpires({ byPath: S.layout.byPath, prs, mode: S.opts.mode, focusId: S.opts.focusId, visible: S.opts.visible, topper: S.opts.topper, roofs: roofMap() }) : [];
    // roof gear (antennas, tanks) would poke through toppers, so buildings that carry a PR keep a clear roof
    const occ = new Set(S.columns.map((c) => c.path));
    if (occ.size !== S.occupied.size || [...occ].some((p) => !S.occupied.has(p))) { S.occupied = occ; restyle(); }
    planSites();
    S.touched = new Set(S.columns.filter((c) => !c.dimmed || !S.opts.focusId).map((c) => c.path));
    S.contested = new Set(S.columns.filter((c) => c.sharedWith > 0 && !c.dimmed).map((c) => c.path));
    refreshBuildings();
    S.growth = { t0: performance.now(), dur: regrow || !S.growth.active ? 520 : 280, active: true, p: 0 };
    syncFlags(); drawSpires(0);
  }

  const capHeight = (c) => Math.min(2.4, 0.5 + Math.min(c.w, c.d) * 0.18);

  // ---- construction sites (the Buildings style): cranes, scaffolding and red-taped floors instead of plain toppers ----
  // Planned once per set of columns (the shapes are pure, see web/sites.js), then drawn every frame while they grow.
  function planSites() {
    S.sites = S.style.mode !== 'full' ? null : S.columns.map((c) => ({ c, parts: siteParts(c, S.styled.get(c.path)?.shell, { loc: S.layout.byPath.get(c.path).loc }) }));
  }
  const siteColor = (tone, st) => {
    switch (tone) {
      case 'status': return _c.copy(st);
      case 'statusDark': return _c.copy(st).offsetHSL(0, 0, -0.16);
      case 'metal': return _c.set(0x9aa5b1);
      case 'add': return _c.set(DIFF_COLORS.add);
      case 'tape': return _c.set(DIFF_COLORS.del);
      case 'post': return _c.set(0xd7dbe2);
      default: return _c.set(0x6b6670);            // the emptied floor
    }
  };
  const _qa = new THREE.Quaternion(), AX = new THREE.Vector3(1, 0, 0), AZ = new THREE.Vector3(0, 0, 1);
  function drawSites(p) {
    const sites = S.sites;
    let n = 0; for (const s of sites) n += s.parts.length;
    const solid = sites.filter((s) => !s.c.dimmed), glass = sites.filter((s) => s.c.dimmed);
    const count = (list) => list.reduce((a, s) => a + s.parts.length, 0);
    boxes.begin(count(solid)); gBoxes.begin(count(glass)); caps.begin(0); gCaps.begin(0);
    for (const { c, parts } of sites) {
      const st = new THREE.Color(statusColor(c.status)), bp = c.dimmed ? gBoxes : boxes;
      const base = { prId: c.prId, path: c.path, lines: c.lines, pct: c.pct, add: c.add, del: c.del };
      for (const q of parts) {
        const ground = q.ground ? 0 : c.z0, kind = q.tone === 'add' || q.ground ? 'add' : q.tone === 'tape' || q.tone === 'post' || q.tone === 'floor' ? 'del' : 'pr';
        const meta = { ...base, kind, n: kind === 'add' ? c.add : kind === 'del' ? c.del : undefined };
        const col = siteColor(q.tone, st);
        if (q.diag) {                                // a diagonal of tape: a thin box turned in the plane of its wall
          const z = ground + (q.z - ground) * p, len = q.len * p;
          if (q.along === 'x') { _qa.setFromAxisAngle(AZ, q.angle); bp.push(_p.set(q.x - CX, z, q.y - CY), _s.set(len, q.t, q.t), col, meta, undefined, _qa); }
          else { _qa.setFromAxisAngle(AX, -q.angle); bp.push(_p.set(q.x - CX, z, q.y - CY), _s.set(q.t, q.t, len), col, meta, undefined, _qa); }
        } else bp.push(_p.set(q.x - CX, ground + (q.z - ground) * p, q.y - CY), _s.set(q.w, Math.max(0.02, q.h * p), q.d), col, meta);
      }
    }
    return n;
  }
  // Amber frame around any roof that two or more PRs share. Static on purpose.
  function drawRims() {
    rims.begin(S.contested.size * 4);
    for (const path of S.contested) {
      const r = roofOf(S.layout.byPath.get(path)), t = 0.55, y = r.top - 0.3, x = r.cx - CX, z = r.cy - CY;
      rims.push(_p.set(x, y, z - r.h / 2 - t / 2), _s.set(r.w + t * 2, 0.75, t), _c.set(0xffffff), { path });
      rims.push(_p.set(x, y, z + r.h / 2 + t / 2), _s.set(r.w + t * 2, 0.75, t), _c, { path });
      rims.push(_p.set(x - r.w / 2 - t / 2, y, z), _s.set(t, 0.75, r.h), _c, { path });
      rims.push(_p.set(x + r.w / 2 + t / 2, y, z), _s.set(t, 0.75, r.h), _c, { path });
    }
    rims.end();
  }
  function drawSpires(progress) {
    const p = ease(Math.min(1, Math.max(0, progress)));
    S.growth.p = p;
    if (S.sites) {
      drawSites(p);
      [boxes, caps, gBoxes, gCaps].forEach((x) => x.end());
      drawRims();
      S.focusLabels = S.columns.filter((c) => c.focused).slice(0, diffLabels.length).map((c) => ({ c, top: c.z0 + (c.total + capHeight(c)) * p + 1.5 }));
      return;
    }
    const solidCols = S.columns.filter((c) => !c.dimmed), glassCols = S.columns.filter((c) => c.dimmed);
    boxes.begin(solidCols.reduce((a, c) => a + c.parts.length, 0)); caps.begin(solidCols.length);
    gBoxes.begin(glassCols.reduce((a, c) => a + c.parts.length, 0)); gCaps.begin(glassCols.length);
    for (const c of S.columns) {
      const st = new THREE.Color(statusColor(c.status));
      const bp = c.dimmed ? gBoxes : boxes, cp = c.dimmed ? gCaps : caps;
      const meta = { prId: c.prId, path: c.path, lines: c.lines, pct: c.pct, add: c.add, del: c.del };
      for (const part of c.parts) {
        const f = part.kind === 'del' ? 0.86 : 1;
        const col = part.kind === 'add' ? _c.set(DIFF_COLORS.add) : part.kind === 'del' ? _c.set(DIFF_COLORS.del) : _c.copy(st);
        bp.push(_p.set(c.x - CX, c.z0 + part.dz * p, c.y - CY), _s.set(c.w * f, Math.max(0.02, part.h * p), c.d * f), col, { ...meta, kind: part.kind, n: part.n });
      }
      cp.push(_p.set(c.x - CX, c.z0 + c.total * p, c.y - CY), _s.set(c.w * 0.7071, Math.max(0.02, capHeight(c) * p), c.d * 0.7071), _c.copy(st).offsetHSL(0, 0, 0.07), { ...meta, kind: 'cap' });
    }
    [boxes, caps, gBoxes, gCaps].forEach((x) => x.end());
    drawRims();
    S.focusLabels = S.columns.filter((c) => c.focused).slice(0, diffLabels.length).map((c) => ({ c, top: c.z0 + (c.total + capHeight(c)) * p + 1.5 }));
  }

  // ---- flags (PR banners, owned by the UI, positioned here) ----
  function syncFlags() {
    const want = new Map();
    for (const pr of S.prs) {
      if (S.opts.visible && !S.opts.visible.has(pr.id)) continue;
      const cols = S.columns.filter((c) => c.prId === pr.id);
      if (!cols.length) continue;
      const x = cols.reduce((a, c) => a + c.x, 0) / cols.length, y = cols.reduce((a, c) => a + c.y, 0) / cols.length;
      // Optionally the pole grows with the PR's age, so what has been open longest stands tallest.
      const lift = S.opts.ageLift ? ageLift(ageDays(pr.createdAt, Date.now())) : 0;
      const top = Math.max(...cols.map((c) => c.z0 + c.total + capHeight(c))) + 6 + lift;
      want.set(pr.id, { pr, x, y, top });
    }
    for (const [id, f] of S.flags) if (!want.has(id)) { f.el.remove(); S.flags.delete(id); }
    for (const [id, w] of want) {
      let f = S.flags.get(id);
      if (!f) { f = { el: handlers.makeFlag(w.pr), pr: w.pr }; f.el.style.position = 'absolute'; f.el.style.left = '0'; f.el.style.top = '0'; f.el.style.pointerEvents = 'auto'; f.el.addEventListener('click', (e) => { e.stopPropagation(); handlers.onPickPR?.(id); }); overlay.appendChild(f.el); S.flags.set(id, f); }
      else { handlers.updateFlag?.(f.el, w.pr); f.pr = w.pr; }
      Object.assign(f, { x: w.x, y: w.y, top: w.top });
    }
  }

  function project(x, y, z) {
    _v.set(x - CX, z, y - CY).project(camera);
    return { sx: (_v.x * 0.5 + 0.5) * S.size.w, sy: (-_v.y * 0.5 + 0.5) * S.size.h, vis: _v.z < 1 && _v.z > -1 };
  }
  const pxPerUnit = (x, y) => { const d = camera.position.distanceTo(_v.set(x - CX, 0, y - CY)); return S.size.h / (2 * Math.tan((camera.fov * Math.PI) / 360) * d); };

  function updateOverlay() {
    const { w, h } = S.size;
    const place = (el, x, y, tx = '-50%', ty = '-100%', display = 'block') => { el.style.display = display; el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) translate(${tx},${ty})`; };
    const hide = (arr, from = 0) => { for (let i = from; i < arr.length; i++) arr[i].style.display = 'none'; };
    const L = S.layout; if (!L) return;
    // plate labels
    let n = 0;
    for (const p of L.plates) {
      if (n >= plateLabels.length) break;
      const ppu = pxPerUnit(p.x + p.w / 2, p.y + p.h / 2);
      if (p.depth > 1 && p.w * ppu < 84) continue;
      if (p.depth > 4) continue;
      const a = project(p.x + 3, p.y + 3, 0.4);
      if (!a.vis || a.sx < -120 || a.sx > w + 120 || a.sy < -40 || a.sy > h + 40) continue;
      const el = plateLabels[n++]; el.textContent = p.name; el.dataset.depth = p.depth; el.style.setProperty('--h', p.hue);
      place(el, a.sx, a.sy + 2, '0', '0');
    }
    hide(plateLabels, n);
    // file labels: files with PRs first, others only when there is room
    n = 0;
    if (S.ui.labels) {
      const cand = [];
      for (const l of L.leaves) { const ppu = pxPerUnit(l.mx, l.my), hot = S.touched.has(l.path); if (l.r.w * ppu > (hot ? 56 : 96) && l.r.h * ppu > 16) cand.push({ l, hot, d: ppu + (hot ? 1000 : 0) }); }
      cand.sort((a, b) => b.d - a.d);
      for (const { l, hot } of cand) {
        if (n >= fileLabels.length) break;
        const a = project(l.mx, l.r.y + l.r.h, hot ? 0.6 : roofOf(l).top + 0.2);
        if (!a.vis || a.sx < -80 || a.sx > w + 80 || a.sy < -20 || a.sy > h + 20) continue;
        const el = fileLabels[n++]; el.textContent = S.style.codes ? `${l.name} \u00b7 ${S.styled.get(l.path).t.code}` : l.name; el.classList.toggle('hot', hot);
        place(el, a.sx, a.sy, '-50%', '0');
      }
    }
    hide(fileLabels, n);
    // focus diff numbers
    n = 0;
    for (const { c, top } of S.focusLabels || []) {
      const a = project(c.x, c.y, top); if (!a.vis) continue;
      const el = diffLabels[n++];
      el.innerHTML = `<i>${c.path.split('/').pop()}</i><b class="a">+${c.add}</b><b class="d">−${c.del}</b>`;
      place(el, a.sx, a.sy, '-50%', '-100%', 'flex');
    }
    hide(diffLabels, n);

    // flags with simple overlap avoidance
    const placed = [];
    const list = [...S.flags.values()].map((f) => ({ f, a: project(f.x, f.y, f.top) })).filter((q) => q.a.vis).sort((a, b) => a.a.sy - b.a.sy);
    const selected = S.opts.focusId;
    const near = camera.position.distanceTo(controls.target) < 260 * rangeScale(S.opts.view);
    const shown = new Set();
    for (const q of list) {
      const f = q.f, expanded = near || f.pr.id === selected;
      if (!S.ui.flags) { f.el.style.display = 'none'; continue; }
      f.el.classList.toggle('expanded', expanded); f.el.classList.toggle('dim', !!selected && f.pr.id !== selected);
      const fw = expanded ? FLAG_W.expanded : FLAG_W.collapsed;
      let x = q.a.sx - FLAG_W.collapsed / 2, y = q.a.sy - FLAG_H - 4;
      for (let i = 0; i < 12; i++) { if (placed.some((r) => x < r.x + r.w + 3 && x + fw + 3 > r.x && y < r.y + r.h + 3 && y + FLAG_H + 3 > r.y)) y -= FLAG_H + 4; else break; }
      placed.push({ x, y, w: fw, h: FLAG_H });
      f.el.style.display = 'flex'; f.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px)`;
      f.el.style.zIndex = f.pr.id === selected ? 5 : 1;
      f.sx = x + FLAG_W.collapsed / 2; f.sy = y + FLAG_H; shown.add(f);
    }
    for (const f of S.flags.values()) if (!shown.has(f)) f.el.style.display = 'none';

    // poles: ground anchor to flag
    const keep = new Set();
    for (const f of shown) {
      let el = poles.get(f.pr.id);
      if (!el) { el = svgEl('g', 'bm-pole'); el.append(svgEl('line', 'bm-pole-l'), svgEl('circle', 'bm-pole-d')); gPoles.appendChild(el); poles.set(f.pr.id, el); }
      const g = project(f.x, f.y, 0.6), col = statusColor(f.pr.status);
      const ln = el.firstChild, dot = el.lastChild;
      ln.setAttribute('x1', f.sx.toFixed(1)); ln.setAttribute('y1', f.sy.toFixed(1)); ln.setAttribute('x2', g.sx.toFixed(1)); ln.setAttribute('y2', g.sy.toFixed(1)); ln.setAttribute('stroke', col);
      dot.setAttribute('cx', g.sx.toFixed(1)); dot.setAttribute('cy', g.sy.toFixed(1)); dot.setAttribute('fill', col);
      el.style.display = ''; el.style.opacity = selected && f.pr.id !== selected ? '0.25' : '1'; keep.add(f.pr.id);
    }
    for (const [id, el] of poles) if (!keep.has(id)) el.style.display = 'none';

    // moving dotted supply lines from the flag to every file the PR touches
    let li = 0;
    if (S.ui.lines !== 'off') {
      const mine = S.ui.lines === 'all' ? [...shown] : [...shown].filter((f) => f.pr.id === selected);
      for (const f of mine) {
        const col = statusColor(f.pr.status), p = S.growth.p;
        for (const c of S.columns) {
          if (c.prId !== f.pr.id || c.dimmed && S.ui.lines !== 'all') continue;
          const t = project(c.x, c.y, c.z0 + (c.total + capHeight(c)) * p);
          if (!t.vis) continue;
          let el = lines[li]; if (!el) { el = svgEl('path', 'bm-line'); gLines.appendChild(el); lines[li] = el; }
          const ax = f.sx, ay = f.sy - FLAG_H / 2;
          el.setAttribute('d', `M${ax.toFixed(1)},${ay.toFixed(1)} Q${((ax + t.sx) / 2).toFixed(1)},${(Math.min(ay, t.sy) - 36).toFixed(1)} ${t.sx.toFixed(1)},${t.sy.toFixed(1)}`);
          el.setAttribute('stroke', col); el.style.display = ''; el.style.opacity = S.ui.lines === 'all' && f.pr.id !== selected ? '0.45' : '1';
          li++;
        }
      }
    }
    for (let i = li; i < lines.length; i++) lines[i].style.display = 'none';
  }

  // ---- camera ----
  function viewOffset(kind, dist) {
    const v = VIEWS[kind];
    return new THREE.Vector3(Math.sin(v.polar) * Math.cos(v.az), Math.cos(v.polar), Math.sin(v.polar) * Math.sin(v.az)).multiplyScalar(dist);
  }
  function flyTo(cx, cy, cz, radius, view = S.opts.view, ms = 750) {
    const v = VIEWS[view];
    const dist = Math.max(14 * rangeScale(view) + 2, (radius / Math.sin((v.fov * Math.PI) / 360)) * 1.12);
    const toTarget = new THREE.Vector3(cx - CX, cz, cy - CY);
    const toPos = toTarget.clone().add(viewOffset(view, dist));
    controls.enableRotate = v.rotate;
    if (ms === 0) {
      camera.fov = v.fov; camera.updateProjectionMatrix(); camera.position.copy(toPos); controls.target.copy(toTarget); applyViewLimits(view); S.tween = null; controls.update(); return;
    }
    controls.minDistance = 1; controls.maxDistance = 60000;       // wide open while flying between very different distances
    S.tween = { t0: performance.now(), dur: ms, fromPos: camera.position.clone(), fromTarget: controls.target.clone(), toTarget, toPos, fromFov: camera.fov, toFov: v.fov, view };
  }
  const homeRadius = () => Math.hypot(WORLD.w, WORLD.h) * 0.3;
  function flyHome(ms) { flyTo(CX, CY, 4, homeRadius(), S.opts.view, ms); }
  function flyToPR(id) {
    const cols = S.columns.filter((c) => c.prId === id); if (!cols.length) return;
    const xs = cols.flatMap((c) => [c.x - c.w / 2, c.x + c.w / 2]), ys = cols.flatMap((c) => [c.y - c.d / 2, c.y + c.d / 2]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const r = Math.max(26, Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) / 2 + 18);
    flyTo(cx, cy, Math.max(...cols.map((c) => c.z0 + c.total)) / 2, r);
  }
  function flyToFile(path) { const l = S.layout?.byPath.get(path); if (l) flyTo(l.mx, l.my, roofOf(l).top / 2, Math.max(22, Math.hypot(l.r.w, l.r.h) / 2 + 14)); }
  function setView(kind, { instant = false } = {}) {
    if (!VIEWS[kind]) return;
    const t = controls.target, cur = Math.sin((camera.fov * Math.PI) / 360);
    const d = camera.position.distanceTo(t);
    S.opts.view = kind;
    flyTo(t.x + CX, t.z + CY, t.y, (d * cur) / 1.12, kind, instant ? 0 : 700);
  }
  flyTo(CX, CY, 4, homeRadius(), '3d', 0);

  // ---- picking ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function pick(clientX, clientY) {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(pickables(), false);
    for (const h of hits) {
      const meta = h.object.userData.pool?.meta[h.instanceId]; if (!meta) continue;
      if (h.object === buildings.mesh) return { type: 'file', path: meta.path, leaf: meta };
      return { type: 'spire', prId: meta.prId, path: meta.path, kind: meta.kind, n: meta.n, lines: meta.lines, pct: meta.pct, add: meta.add, del: meta.del };
    }
    return null;
  }
  const el = renderer.domElement; let down = null;
  el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  el.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) { down = null; return; }
    down = null; const h = pick(e.clientX, e.clientY);
    if (!h) handlers.onPickNothing?.(); else if (h.type === 'spire') handlers.onPickPR?.(h.prId, h); else handlers.onPickFile?.(h.path, h.leaf);
  });
  let hoverT = 0;
  el.addEventListener('pointermove', (e) => {
    if (e.buttons || e.pointerType === 'touch') return;
    const now = performance.now(); if (now - hoverT < 50) return; hoverT = now;
    const h = pick(e.clientX, e.clientY); const prev = S.hover?.path;
    S.hover = h ? { path: h.path } : null;
    if ((S.hover?.path) !== prev) refreshBuildings();
    handlers.onHover?.(h, e.clientX, e.clientY);
  });
  el.addEventListener('pointerleave', () => { if (S.hover) { S.hover = null; refreshBuildings(); } handlers.onHover?.(null); });

  // ---- loop ----
  let running = true;
  function frame() {
    if (!running) return;
    requestAnimationFrame(frame);
    if (S.growth.active) { const t = (performance.now() - S.growth.t0) / S.growth.dur; drawSpires(t); if (t >= 1) S.growth.active = false; }
    if (S.tween) {
      const T = S.tween, t = Math.min(1, (performance.now() - T.t0) / T.dur), e = ease(t);
      camera.position.lerpVectors(T.fromPos, T.toPos, e); controls.target.lerpVectors(T.fromTarget, T.toTarget, e);
      camera.fov = T.fromFov + (T.toFov - T.fromFov) * e;
      if (t >= 1) { S.tween = null; applyViewLimits(T.view); }
    }
    // keep depth precision and fog sensible whether we are 700 or 4000 units away
    const dist = camera.position.distanceTo(controls.target);
    camera.near = Math.max(2, dist * 0.2); camera.far = dist * 6 + 3000; camera.updateProjectionMatrix();
    scene.fog.density = 0.00055 * Math.min(1, 900 / Math.max(dist, 1));
    controls.update(); renderer.render(scene, camera); updateOverlay();
  }
  controls.addEventListener('start', () => { S.tween = null; });
  requestAnimationFrame(frame);

  return {
    setFiles, setPRs, setStyle, flyHome, flyToPR, flyToFile, setView,
    setUI(u) { const was = S.ui.watched; S.ui = { ...S.ui, ...u }; if (S.ui.watched !== was) drawWatch(); },
    setWatched(paths) { S.watched = new Set(paths || []); drawWatch(); },
    setHighlight(paths) { S.highlight = new Set(paths || []); refreshBuildings(); },
    info: () => ({ columns: S.columns.length, buildings: S.layout?.leaves.length || 0, flags: S.flags.size, view: S.opts.view, contested: S.contested.size, watched: S.watchedShown || 0, fov: camera.fov }),
    layout: () => S.layout,
    /** Hash identity of one file: its index code, silhouette and window style. */
    buildingInfo(path) { const b = S.styled.get(path); return b ? { code: b.t.code, shape: S.style.mode === 'full' ? SHAPES[b.t.shape] : 'block', parts: b.parts.length } : null; },
    flagHeights: () => Object.fromEntries([...S.flags].map(([id, f]) => [id, f.top])),
    dispose() { running = false; renderer.dispose(); host.removeChild(renderer.domElement); host.removeChild(overlay); },
  };
}
