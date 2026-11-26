// The outer view: every repo as a small city on its own hex of land (a hill whose biome comes from the repo's name),
// sitting beside the others. Look and drag only: no PRs, no diffs. Geometry and rules live in the pure modules
// (hex.js, biome.js, cityshape.js); this file is the Three.js glue and the little overlay of labels.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { toWorld, fromWorld, hexKey, canMove, frontier } from './hex.js';
import { biomeFor } from './biome.js';
import { cityBoxes } from './cityshape.js';

const S = 10;                                   // a hex's circumradius in world units
const CITY = 1.34 * S;                          // a city's footprint is about this wide
const PROP_COLORS = { pine: 0x2f6f48, tree: 0x4f9e3e, bush: 0x6fb057, flower: 0xf2c94c, cactus: 0x5aa05a, rock: 0x8d9299, dune: 0xe2c27a, lava: 0xff7a3d, reed: 0x9ccf8a };
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3(), _c = new THREE.Color(), _e = new THREE.Euler();

export function createWorld(host, handlers = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  host.appendChild(renderer.domElement);
  renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none';
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0a0f17); scene.fog = new THREE.Fog(0x0a0f17, 260, 700);
  const camera = new THREE.PerspectiveCamera(28, 1, 1, 3000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.1; controls.screenSpacePanning = false; controls.enableRotate = false;
  controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
  controls.touches = { ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }; controls.minDistance = 50; controls.maxDistance = 900;
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1b2434, 1.5));
  const sun = new THREE.DirectionalLight(0xfff0dc, 2.2); sun.position.set(-120, 220, 90); scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshStandardMaterial({ color: 0x0d1420, roughness: 1 })); ground.rotation.x = -Math.PI / 2; ground.position.y = -0.2; scene.add(ground);
  const grid = new THREE.GridHelper(1600, 80, 0x1a2638, 0x121b29); grid.position.y = -0.1; scene.add(grid);

  const hexGeo = (rt, rb, h) => { const g = new THREE.CylinderGeometry(rt, rb, h, 6); g.translate(0, h / 2, 0); return g; };
  const unit = new THREE.BoxGeometry(1, 1, 1); unit.translate(0, 0.5, 0);
  const overlay = document.createElement('div'); overlay.className = 'world-overlay'; overlay.style.cssText = 'position:absolute;inset:0;overflow:hidden;pointer-events:none'; host.appendChild(overlay);

  const st = { cities: [], slots: [], shapes: new Map(), byHex: new Map(), groups: [], slotMeshes: new Map(), labels: new Map(), hover: null, drag: null, size: { w: 1, h: 1 }, fitted: false };
  const world = new THREE.Group(); scene.add(world);
  const slotMat = () => new THREE.MeshBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.06, depthWrite: false });

  function resize() { const w = host.clientWidth || 1, h = host.clientHeight || 1; st.size = { w, h }; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  new ResizeObserver(resize).observe(host); resize();

  // ---- build the world from the list of cities ----
  function clearWorld() { for (const g of st.groups) { world.remove(g); g.traverse((o) => { if (o.geometry && o.geometry !== unit && !Object.values(propGeo).includes(o.geometry)) o.geometry.dispose?.(); o.material?.dispose?.(); if (o.isInstancedMesh) o.dispose?.(); }); } st.groups = []; for (const m of st.slotMeshes.values()) { world.remove(m); m.geometry.dispose(); m.material.dispose(); } st.slotMeshes.clear(); }
  const PROP = { pine: () => new THREE.ConeGeometry(0.5, 1.5, 6), tree: () => new THREE.IcosahedronGeometry(0.62, 0), bush: () => new THREE.IcosahedronGeometry(0.4, 0), flower: () => new THREE.BoxGeometry(0.18, 0.5, 0.18), cactus: () => new THREE.CylinderGeometry(0.2, 0.24, 1.2, 6), rock: () => new THREE.DodecahedronGeometry(0.5, 0), dune: () => new THREE.SphereGeometry(0.8, 8, 4), lava: () => new THREE.ConeGeometry(0.28, 0.8, 5), reed: () => new THREE.CylinderGeometry(0.06, 0.06, 1.1, 4) };
  const propGeo = {}; for (const k of Object.keys(PROP)) propGeo[k] = PROP[k]();          // shared by every city
  function build() {
    clearWorld(); st.byHex.clear();
    for (const c of st.cities) {
      st.byHex.set(hexKey(c), c.id);
      const b = biomeFor(c.key), at = toWorld(c, S), g = new THREE.Group(); g.position.set(at.x, 0, at.z); g.userData.id = c.id;
      const rim = new THREE.Mesh(hexGeo(S * 0.99, S * 0.99, 0.6), new THREE.MeshStandardMaterial({ color: b.rim, roughness: 1 }));
      const base = 0.6 + b.hill.height * S * 0.12, hill = new THREE.Mesh(hexGeo(S * 0.86, S * 0.96, base - 0.6), new THREE.MeshStandardMaterial({ color: b.ground, roughness: 0.95 })); hill.position.y = 0.6;
      const swell = b.hill.bulge * S * 0.5, cap = new THREE.Mesh(hexGeo(S * 0.7, S * 0.84, swell), new THREE.MeshStandardMaterial({ color: new THREE.Color(b.ground).offsetHSL(0, 0, 0.03), roughness: 0.95 })); cap.position.y = base;
      const top = base + swell; g.add(rim, hill, cap);
      // the city: every box in one instanced mesh that lives in this city's group, so it travels with the plot when dragged
      const shape = st.shapes.get(c.id);
      if (shape?.boxes.length) {
        const mesh = new THREE.InstancedMesh(unit, new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0.04 }), shape.boxes.length);
        shape.boxes.forEach((x, i) => { _m.compose(_p.set(x.x * CITY, top + x.y * CITY, x.z * CITY), _q.identity(), _s.set(x.w * CITY, Math.max(0.05, x.h * CITY * 3.2), x.d * CITY)); mesh.setMatrixAt(i, _m); mesh.setColorAt(i, _c.setHSL(x.hue / 360, (x.sat / 100) * 0.75, (x.light - 6) / 100)); });
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; mesh.frustumCulled = false; g.add(mesh);
      }
      // the land's own things: trees, cacti, rocks, dunes, lava, reeds, on the ring around the city
      const byType = {}; for (const p of b.props) (byType[p.type] ||= []).push(p);
      const accent = new THREE.Color(b.accent);
      for (const [type, list] of Object.entries(byType)) {
        const mesh = new THREE.InstancedMesh(propGeo[type], new THREE.MeshStandardMaterial({ roughness: 0.9, emissive: type === 'lava' ? 0x7a2a00 : 0x000000 }), list.length);
        list.forEach((p, i) => {
          const sc = p.scale * 0.9 * (type === 'dune' ? 1.3 : 1), lift = { dune: 0.1, rock: 0.15, pine: 0.7, tree: 0.8 }[type] ?? 0.45;
          _m.compose(_p.set(p.x * S * 0.98, top + lift * sc, p.z * S * 0.98), _q.setFromEuler(_e.set(0, p.turn, 0)), _s.set(sc, type === 'dune' ? sc * 0.45 : sc, sc));
          mesh.setMatrixAt(i, _m); mesh.setColorAt(i, _c.set(PROP_COLORS[type]).lerp(accent, type === 'flower' ? 0.6 : 0.12).offsetHSL((p.turn % 0.3) * 0.05, 0, (p.scale - 1) * 0.08));
        });
        mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true; mesh.frustumCulled = false; g.add(mesh);
      }
      world.add(g); st.groups.push(g);
    }
    // free slots beside the group: faint, and they glow when you hover them
    for (const h of st.slots) { const m = new THREE.Mesh(hexGeo(S * 0.94, S * 0.94, 0.35), slotMat()); const w = toWorld(h, S); m.position.set(w.x, 0.05, w.z); m.userData.hex = h; world.add(m); st.slotMeshes.set(hexKey(h), m); }
    // labels
    for (const [id, el] of st.labels) if (!st.cities.some((c) => c.id === id)) { el.remove(); st.labels.delete(id); }
    for (const c of st.cities) { if (!st.labels.has(c.id)) { const el = document.createElement('div'); el.className = 'wl'; el.dataset.id = c.id; el.append(Object.assign(document.createElement('b'), { className: 'wl-n' }), Object.assign(document.createElement('span'), { className: 'wl-x' })); overlay.appendChild(el); st.labels.set(c.id, el); } }
    if (!st.fitted && st.cities.length + st.slots.length) { fit(0); st.fitted = true; }
  }

  // ---- camera ----
  function bounds() { const pts = [...st.cities, ...st.slots].map((h) => toWorld(h, S)); if (!pts.length) return { cx: 0, cz: 0, r: S * 3 }; const xs = pts.map((p) => p.x), zs = pts.map((p) => p.z), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2; return { cx, cz, r: Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 + S * 1.6 }; }
  function fit() { const { cx, cz, r } = bounds(), dist = Math.max(90, (r / Math.tan((camera.fov * Math.PI) / 360 / 1.15)) * 0.95 * Math.max(1, 1.5 / camera.aspect * 0.8)); controls.target.set(cx, 0, cz); camera.position.set(cx + dist * 0.18, dist * 0.82, cz + dist * 0.62); controls.update(); }

  // ---- pointer: hover, click a city to go in, drag a city to another slot ----
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.5), hit = new THREE.Vector3();
  function groundAt(cx, cy) { const r = renderer.domElement.getBoundingClientRect(); ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera); return ray.ray.intersectPlane(plane, hit) ? { x: hit.x, z: hit.z } : null; }
  function target(cx, cy) {
    const g = groundAt(cx, cy); if (!g) return { type: null };
    const hex = fromWorld(g.x, g.z, S), k = hexKey(hex), id = st.byHex.get(k);
    if (id) return { type: 'city', id, hex };
    if (st.slotMeshes.has(k)) return { type: 'slot', hex };
    return { type: null, hex };
  }
  const legal = (id) => { const c = st.cities.find((x) => x.id === id); return c ? st.slots.filter((h) => canMove(st.cities.map((o) => ({ q: o.q, r: o.r })), c, h)) : []; };
  const el = renderer.domElement; let down = null;
  host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const t = target(e.clientX, e.clientY); down = { x: e.clientX, y: e.clientY, t, moved: false };
    if (t.type === 'city') { controls.enabled = false; e.stopPropagation(); }
  }, true);
  addEventListener('pointermove', (e) => {
    if (down?.t.type === 'city') {
      if (!down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6) { down.moved = true; st.drag = { id: down.t.id, ok: legal(down.t.id) }; handlers.onDragStart?.(down.t.id); }
      if (st.drag) { const g = groundAt(e.clientX, e.clientY); st.drag.at = g; const h = g ? fromWorld(g.x, g.z, S) : null; st.drag.over = h && st.drag.ok.some((s) => s.q === h.q && s.r === h.r) ? h : null; }
      return;
    }
    if (e.buttons) return;
    const r = el.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const t = target(e.clientX, e.clientY), prev = st.hover;
    st.hover = t.type ? t : null;
    if ((prev?.type !== st.hover?.type) || (prev?.id !== st.hover?.id) || (prev?.hex && st.hover?.hex && hexKey(prev.hex) !== hexKey(st.hover.hex))) handlers.onHover?.(st.hover);
    el.style.cursor = st.hover?.type === 'city' ? 'pointer' : st.hover?.type === 'slot' ? 'copy' : '';
  });
  addEventListener('pointerup', (e) => {
    const was = down; down = null; controls.enabled = true;
    if (st.drag) { const d = st.drag; st.drag = null; handlers.onDragEnd?.(); if (d.over) handlers.onMove?.(d.id, d.over); return; }
    if (!was || Math.hypot(e.clientX - was.x, e.clientY - was.y) > 6) return;
    const r = el.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    const t = target(e.clientX, e.clientY);
    if (t.type === 'city') handlers.onEnter?.(t.id); else if (t.type === 'slot') handlers.onAdd?.(t.hex);
  });

  // ---- frame ----
  function project(x, y, z) { _p.set(x, y, z).project(camera); return { sx: (_p.x * 0.5 + 0.5) * st.size.w, sy: (-_p.y * 0.5 + 0.5) * st.size.h, vis: _p.z < 1 }; }
  let running = true;
  function frame() {
    if (!running) return; requestAnimationFrame(frame);
    // slots glow: faint always, brighter when hovered, brightest as a legal drop target
    const hv = st.hover?.type === 'slot' ? hexKey(st.hover.hex) : null, dragging = !!st.drag, overKey = st.drag?.over ? hexKey(st.drag.over) : null, okKeys = new Set((st.drag?.ok || []).map(hexKey));
    for (const [k, m] of st.slotMeshes) { const want = k === overKey ? 0.5 : k === hv ? 0.3 : dragging && okKeys.has(k) ? 0.2 : dragging ? 0.02 : 0.06; m.material.opacity += (want - m.material.opacity) * 0.25; m.material.color.setHex(k === overKey ? 0x9be8ff : 0x66ccff); m.scale.setScalar(k === hv || k === overKey ? 1.03 : 1); }
    // a dragged city lifts and follows the pointer
    for (const g of st.groups) if (g.userData.id) { const base = toWorld(st.cities.find((c) => c.id === g.userData.id) || { q: 0, r: 0 }, S), d = st.drag?.id === g.userData.id && st.drag.at; g.position.x += ((d ? st.drag.at.x : base.x) - g.position.x) * 0.35; g.position.z += ((d ? st.drag.at.z : base.z) - g.position.z) * 0.35; g.position.y += ((d ? 3 : 0) - g.position.y) * 0.3; }
    controls.update(); renderer.render(scene, camera);
    // labels follow their city; the plus follows a hovered slot
    for (const c of st.cities) { const el2 = st.labels.get(c.id); if (!el2) continue; const w = toWorld(c, S), p = project(w.x, 9, w.z); el2.style.display = p.vis ? 'flex' : 'none'; el2.style.transform = `translate(${p.sx.toFixed(1)}px,${p.sy.toFixed(1)}px) translate(-50%,-100%)`; el2.classList.toggle('hot', st.hover?.id === c.id); }
    handlers.onFrame?.({ project, hover: st.hover, toWorld: (h) => toWorld(h, S) });
  }
  requestAnimationFrame(frame);

  return {
    /** cities: [{id, key, q, r, ...}], slots: [{q, r}], files: Map(id -> [[path, loc, complexity]]) */
    set(cities, slots, files) {
      st.cities = cities; st.slots = slots;
      for (const c of cities) if (files.has(c.id) && !st.shapes.has(c.id)) st.shapes.set(c.id, cityBoxes(files.get(c.id).map(([path, loc, complexity]) => ({ path, loc, complexity }))));
      build();
      for (const c of cities) { const el2 = st.labels.get(c.id); if (!el2) continue; el2.querySelector('.wl-n').textContent = c.name; const n = c.stats?.needs; const x = el2.querySelector('.wl-x'); x.textContent = n ? String(n) : ''; x.hidden = !n; x.title = n ? `${n} need${n === 1 ? 's' : ''} you` : ''; }
    },
    fit, project, info: () => ({ cities: st.cities.length, slots: st.slotMeshes.size, boxes: st.groups.reduce((a, g) => { let n = 0; g.traverse((o) => { if (o.isInstancedMesh && o.geometry === unit) n += o.count; }); return a + n; }, 0), labels: st.labels.size, hover: st.hover, dragging: !!st.drag }),
    legal, hexScreen: (h) => { const w = toWorld(h, S); return project(w.x, 2, w.z); },
    dispose() { running = false; clearWorld(); renderer.dispose(); host.removeChild(renderer.domElement); host.removeChild(overlay); },
  };
}
