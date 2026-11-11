import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { measure } from "./measure.js";

const $ = (id) => document.getElementById(id);
const stage = $("stage"), viewport = $("viewport"), ink = $("ink"), input = $("input");
const accent = new THREE.Color("#e8590c");
const CLICK_SLOP = 4;
const EDGE_PX = 6; // how near the pointer an edge must pass to be picked over a face
const MAX_SHOT = 1400;

// --- Scene ------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(devicePixelRatio);
viewport.append(renderer.domElement);
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(35, 1, 1, 1e5);
camera.up.set(0, 0, 1);
camera.position.set(1, -1, 0.8);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
let world = new THREE.Group(); // the group of the view on screen
scene.add(world);
const raycaster = new THREE.Raycaster();

const dark = matchMedia("(prefers-color-scheme: dark)");
const partMaterial = new THREE.MeshStandardMaterial({
  color: 0xb4b8bf, metalness: 0.05, roughness: 0.65,
  polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
});
// A selected part takes the accent; a part row under the pointer, a lighter one.
const selectedMaterial = partMaterial.clone();
selectedMaterial.color.lerp(accent, 0.55);
const hoverPartMaterial = partMaterial.clone();
hoverPartMaterial.color.lerp(accent, 0.3);
const ghostMaterial = new THREE.MeshStandardMaterial({ color: 0xb4b8bf, transparent: true, opacity: 0.12, depthWrite: false });
const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x24262b });
const hoverMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
const pickedMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.6, depthWrite: false, side: THREE.DoubleSide });
const hoverEdgeMaterial = new THREE.LineBasicMaterial({ color: accent, transparent: true, opacity: 0.6 });
const pickedEdgeMaterial = new THREE.LineBasicMaterial({ color: accent });
const flashMaterial = new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide });

// --- State ------------------------------------------------------------------
let model = null;
let parts = new Map(); // path -> { info, mesh, edges, groups, geometry, matrix }
let pose = {}; // joint path -> value the person set; kept by tab, never written to the source
let stepMeshes = {};
let selectedPart = null;
let hoveredPart = null; // part or sub-assembly path of the row under the pointer
let previewStep = null;
let previewObject = null;
let previous = null; // last model, to flash what changed
let hoverOverlay = null;
let flashOverlays = [];
let flashUntil = 0;
const refs = []; // { n, part, face, point, overlay, el } | { n, stroke, faces }
let nextRef = 1;
const measured = []; // { key, part, face } | { key, part, edge }: what the person picked to measure
let drawMode = false;
let running = false;
let hoverKey = "";
let opened = { root: null, entry: null, files: [], truncated: false, tabs: [] };
const views = new Map(); // open file -> its kept build: { world, model, parts, stepMeshes, version }
const keptByTab = new Map(); // open file -> what outlives its build: { refs, nextRef, draft, pose, camera }
let buildPending = false; // the tab on screen is building
let loadToken = 0;
const collapsed = new Set();
const LAST_OPENED = "vibecad.lastOpened";

function decode(b64, Type) {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Type(bytes.buffer);
}
function geometryOf(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(decode(m.positions, Float32Array), 3));
  g.setAttribute("normal", new THREE.BufferAttribute(decode(m.normals, Float32Array), 3));
  g.setIndex(new THREE.BufferAttribute(decode(m.indices, Uint32Array), 1));
  return g;
}
/** Puts an object on a part's pose matrix, which applyPose changes in place. */
function bindPose(o, matrix) {
  o.matrixAutoUpdate = false;
  o.matrix = matrix;
  o.matrixWorldNeedsUpdate = true;
}
function disposeTree(o) {
  o.traverse((c) => c.geometry?.dispose());
}

async function loadModel() {
  const file = opened.entry;
  const token = ++loadToken;
  const res = await fetch(`/model?file=${encodeURIComponent(file)}`);
  if (!res.ok || token !== loadToken) return;
  const data = await res.json();
  if (token !== loadToken) return;
  previous = model;
  model = data.model;
  stepMeshes = data.meshes.steps;

  disposeTree(world);
  world.clear();
  parts = new Map();
  previewStep = null;
  previewObject = null;
  hoverOverlay = null;
  hoverKey = "";
  flashOverlays = [];
  measured.length = 0; // edge indices do not survive a rebuild
  renderMeasure();

  for (const m of data.meshes.parts) {
    const info = model.parts.find((p) => p.path === m.path);
    const geometry = geometryOf(m);
    const mesh = new THREE.Mesh(geometry, partMaterial);
    mesh.userData.path = m.path;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 28), edgeMaterial);
    const part = {
      info, mesh, edges, geometry, groups: m.faceGroups, matrix: new THREE.Matrix4(),
      faceGeom: m.faceGeom ?? [], edgeGeom: m.edges ?? [],
    };
    bindPose(mesh, part.matrix);
    bindPose(edges, part.matrix);
    world.add(mesh, edges);
    parts.set(m.path, part);
  }
  applyPose();
  if (selectedPart && !parts.has(selectedPart)) selectedPart = null;
  paintParts();

  // A tab's first build fits; a rebuild keeps the camera unless the model's
  // bounds moved, so the view stays centered as an assembly grows.
  const box = modelBox();
  const before = views.get(file)?.box;
  if (before ? !sameBox(before, box) : !keptByTab.get(file)?.camera) fit();
  views.set(file, { world, model, parts, stepMeshes, version: data.version, box });
  // Refs stay on the model through rebuilds when their face still exists.
  for (const r of [...refs]) {
    if (!r.part) continue;
    if (parts.get(r.part)?.info.faces.some((f) => f.id === r.face)) {
      r.overlay = overlayFor(r.part, r.face, pickedMaterial);
    } else removeRef(r);
  }
  flashChanges();
  renderDesign();
  renderRefs();
  renderEmpty();
}

/** Puts a tab on screen with its pins, draft and camera, and its scene once it has a build. */
function showView(file) {
  loadToken++;
  cancelListening();
  clearMeasure();
  selectedPart = hoveredPart = null;
  setPreview(null);
  dropOverlay(hoverOverlay);
  flashOverlays.forEach(dropOverlay);
  hoverOverlay = previous = null;
  flashOverlays = [];
  hoverKey = "";
  $("tip").hidden = true;
  $("source").hidden = true;

  if (opened.entry) {
    keptByTab.set(opened.entry, {
      refs: [...refs], nextRef, draft: input.value, pose,
      camera: views.has(opened.entry)
        ? { position: camera.position.clone(), target: controls.target.clone(), near: camera.near, far: camera.far }
        : keptByTab.get(opened.entry)?.camera,
    });
  }
  const kept = keptByTab.get(file);
  refs.length = 0;
  refs.push(...(kept?.refs ?? []));
  nextRef = kept?.nextRef ?? 1;
  input.value = kept?.draft ?? "";
  pose = kept?.pose ?? {};
  const view = views.get(file);
  scene.remove(world);
  world = view?.world ?? new THREE.Group();
  scene.add(world);
  model = view?.model ?? null;
  parts = view?.parts ?? new Map();
  stepMeshes = view?.stepMeshes ?? {};
  applyPose();
  paintParts();
  if (kept?.camera) {
    camera.position.copy(kept.camera.position);
    controls.target.copy(kept.camera.target);
    camera.near = kept.camera.near;
    camera.far = kept.camera.far;
    camera.updateProjectionMatrix();
  }
  renderDesign();
  renderRefs();
}
function dropView(file) {
  disposeTree(views.get(file).world);
  views.delete(file);
}

/** Faces whose semantic id is new, or whose geometry moved, glow for a moment. */
function flashChanges() {
  if (!previous) return;
  const before = new Map(previous.parts.map((p) => [p.path, new Map(p.faces.map((f) => [f.id, f]))]));
  for (const [path, part] of parts) {
    const old = before.get(path);
    const changed = part.info.faces.filter((f) => {
      const o = old?.get(f.id);
      return !o || o.area !== f.area || String(o.center) !== String(f.center);
    });
    for (const f of changed) flashOverlays.push(overlayFor(path, f.id, flashMaterial));
  }
  if (flashOverlays.length) flashUntil = performance.now() + 2500;
}

function faceIndexAtTriangle(groups, tri) {
  for (let i = 0; i < groups.length; i += 3) {
    if (tri >= groups[i] && tri < groups[i] + groups[i + 1]) return groups[i + 2];
  }
  return -1;
}

function overlayFor(path, faceId, material) {
  const part = parts.get(path);
  const faceIndex = part.info.faces.findIndex((f) => f.id === faceId);
  const source = part.geometry.index.array;
  const idx = [];
  for (let i = 0; i < part.groups.length; i += 3) {
    if (part.groups[i + 2] !== faceIndex) continue;
    const start = part.groups[i] * 3, end = start + part.groups[i + 1] * 3;
    for (let t = start; t < end; t++) idx.push(source[t]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", part.geometry.getAttribute("position"));
  g.setIndex(idx);
  const m = new THREE.Mesh(g, material);
  m.renderOrder = 2;
  bindPose(m, part.matrix);
  world.add(m);
  return m;
}
function dropOverlay(o) {
  if (!o) return;
  world.remove(o);
  o.geometry.deleteAttribute("position"); // shared with the part
  o.geometry.dispose();
}

function modelBox() {
  const box = new THREE.Box3();
  for (const p of parts.values()) box.expandByObject(p.mesh);
  return box;
}
/** True when two boxes match within 1% of their size. */
function sameBox(a, b) {
  if (a.isEmpty() || b.isEmpty()) return a.isEmpty() === b.isEmpty();
  const tol = 0.01 * a.getSize(new THREE.Vector3()).length();
  return a.min.distanceTo(b.min) <= tol && a.max.distanceTo(b.max) <= tol;
}
function fit() {
  const box = modelBox();
  if (box.isEmpty()) return;
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
  const dist = (radius * 1.15) / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-9) dir.set(1, -1, 0.8);
  camera.position.copy(center).add(dir.normalize().multiplyScalar(dist));
  camera.near = dist / 100;
  camera.far = dist * 20;
  camera.updateProjectionMatrix();
  controls.target.copy(center);
}

// --- View gizmo -------------------------------------------------------------
// A cube named like `render`'s views, and the world axes. Clicking a face, an
// edge or a corner turns the camera to look from that side, keeping target and
// distance.
const GIZMO_PX = 112;
const TURN_MS = 250;
const CUBE = 1.2; // cube size, in gizmo units
const RIM = 0.22; // width of the edge and corner regions
const gizmo = {
  el: $("gizmo"),
  scene: new THREE.Scene(),
  camera: new THREE.OrthographicCamera(-1.3, 1.3, 1.3, -1.3, 0.1, 10),
  regions: [], // faces, edges and corners, each with userData.dir
  tags: [], // axis labels, each with userData.dir
  hovered: null,
  turn: null, // { q, from, dist, t0 }
};
gizmo.renderer = new THREE.WebGLRenderer({ canvas: gizmo.el, antialias: true, alpha: true });
gizmo.renderer.setPixelRatio(devicePixelRatio);
gizmo.renderer.setSize(GIZMO_PX, GIZMO_PX, false);
gizmo.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8f99, 2.4));
{
  const label = (text, color, size) => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const ctx = c.getContext("2d");
    ctx.font = `600 ${size}px system-ui, sans-serif`;
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 132);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  // A region per direction in {-1, 0, 1}^3: 6 faces, 12 edges, 8 corners.
  const inner = CUBE - 2 * RIM;
  for (const x of [-1, 0, 1]) for (const y of [-1, 0, 1]) for (const z of [-1, 0, 1]) {
    const d = [x, y, z];
    if (!x && !y && !z) continue;
    const region = new THREE.Mesh(
      new THREE.BoxGeometry(...d.map((v) => (v ? RIM : inner))),
      new THREE.MeshLambertMaterial({ color: 0xf4f5f7 }),
    );
    region.position.set(...d.map((v) => (v * (CUBE - RIM)) / 2));
    region.userData.dir = new THREE.Vector3(...d).normalize();
    gizmo.scene.add(region);
    gizmo.regions.push(region);
  }
  gizmo.scene.add(new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(CUBE, CUBE, CUBE)),
    new THREE.LineBasicMaterial({ color: 0x8a8f99 }),
  ));
  // Side labels read upright with +Z up; top and bottom with +Y (back) up.
  const faces = [
    ["FRONT", [0, -1, 0], [0, 0, 1]], ["BACK", [0, 1, 0], [0, 0, 1]],
    ["RIGHT", [1, 0, 0], [0, 0, 1]], ["LEFT", [-1, 0, 0], [0, 0, 1]],
    ["TOP", [0, 0, 1], [0, 1, 0]], ["BOTTOM", [0, 0, -1], [0, 1, 0]],
  ];
  // One font size for every face: the longest name spans the cube.
  const measure = document.createElement("canvas").getContext("2d");
  measure.font = "600 100px system-ui, sans-serif";
  const longest = Math.max(...faces.map(([name]) => measure.measureText(name).width));
  const faceFont = Math.floor((100 * 244) / longest);
  for (const [name, n, u] of faces) {
    const normal = new THREE.Vector3(...n), up = new THREE.Vector3(...u);
    const tag = new THREE.Mesh(
      new THREE.PlaneGeometry(CUBE, CUBE),
      new THREE.MeshBasicMaterial({ map: label(name, "#3a3d44", faceFont), transparent: true, depthWrite: false }),
    );
    tag.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(up.clone().cross(normal), up, normal));
    tag.position.copy(normal).multiplyScalar(CUBE / 2 + 0.001);
    tag.raycast = () => {}; // clicks reach the face under it
    gizmo.scene.add(tag);
  }
  for (const [name, d, color] of [["X", [1, 0, 0], "#e03131"], ["Y", [0, 1, 0], "#2f9e44"], ["Z", [0, 0, 1], "#1c7ed6"]]) {
    const dir = new THREE.Vector3(...d);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(0.92)]),
      new THREE.LineBasicMaterial({ color }),
    );
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: label(name, color, 144), depthTest: false, transparent: true }));
    tag.position.copy(dir).multiplyScalar(1.06);
    tag.scale.setScalar(0.38);
    tag.userData.dir = dir;
    gizmo.scene.add(line, tag);
    gizmo.tags.push(tag);
  }
}

/** The cube region under a gizmo pointer event, or null. */
function gizmoHit(e) {
  const r = gizmo.el.getBoundingClientRect();
  const p = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(p, gizmo.camera);
  return raycaster.intersectObjects(gizmo.regions, false)[0]?.object ?? null;
}

function setGizmoHover(region) {
  if (region === gizmo.hovered) return;
  gizmo.hovered?.material.color.set(0xf4f5f7);
  region?.material.color.copy(accent).lerp(new THREE.Color(0xffffff), 0.45);
  gizmo.hovered = region;
  gizmo.el.style.cursor = region ? "pointer" : "";
}

/** Turns the camera around its target to look from `dir`. */
// The camera's orientation is slerped in one rotation; orbit controls would
// re-aim it with +Z up each frame and roll it late near the poles.
function viewFrom(dir) {
  // Settle leftover orbit damping now, so it does not add to the turn.
  controls.enableDamping = false;
  controls.update();
  controls.enableDamping = true;
  const dist = camera.position.distanceTo(controls.target) || 1;
  const to = dir.clone().normalize();
  // Top and bottom keep +Y (back) up, like their labels.
  if (Math.abs(to.z) > 0.999) to.set(0, -1e-4 * Math.sign(to.z), Math.sign(to.z)).normalize();
  // The orientation orbit controls will hold there, so the hand-over does not jump.
  const end = new THREE.Matrix4().lookAt(to, new THREE.Vector3(), camera.up);
  gizmo.turn = {
    from: camera.quaternion.clone(),
    to: new THREE.Quaternion().setFromRotationMatrix(end),
    dist,
    t0: performance.now(),
  };
}

/** Advances a gizmo turn; true while it owns the camera. */
function stepTurn(now) {
  const t = gizmo.turn;
  if (!t) return false;
  const k = Math.min(1, (now - t.t0) / TURN_MS);
  const ease = 1 - (1 - k) ** 3;
  camera.quaternion.slerpQuaternions(t.from, t.to, ease);
  // The camera looks down its -Z, so it sits on its +Z from the target.
  camera.position.set(0, 0, t.dist).applyQuaternion(camera.quaternion).add(controls.target);
  if (k === 1) gizmo.turn = null;
  return true;
}

gizmo.el.addEventListener("pointermove", (e) => setGizmoHover(gizmoHit(e)));
gizmo.el.addEventListener("pointerleave", () => setGizmoHover(null));
gizmo.el.addEventListener("click", (e) => {
  const region = gizmoHit(e);
  if (region) viewFrom(region.userData.dir);
});
controls.addEventListener("start", () => (gizmo.turn = null));

function renderGizmo() {
  const view = camera.position.clone().sub(controls.target).normalize();
  gizmo.camera.position.copy(view).multiplyScalar(4);
  gizmo.camera.quaternion.copy(camera.quaternion);
  // An axis pointing at the viewer would sit on the face label, so it fades out.
  for (const o of gizmo.tags) {
    o.material.opacity = THREE.MathUtils.clamp((0.95 - Math.abs(o.userData.dir.dot(view))) / 0.15, 0, 1);
  }
  gizmo.renderer.render(gizmo.scene, gizmo.camera);
}

function resize() {
  const { clientWidth: w, clientHeight: h } = stage;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  ink.width = w * devicePixelRatio;
  ink.height = h * devicePixelRatio;
}
new ResizeObserver(resize).observe(stage);

// --- Picking ----------------------------------------------------------------
function ndc(e) {
  const r = stage.getBoundingClientRect();
  return new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
}
function pick(e) {
  raycaster.setFromCamera(ndc(e), camera);
  const meshes = [...parts.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
  const hit = raycaster.intersectObjects(meshes, false)[0];
  if (!hit) return null;
  const path = hit.object.userData.path;
  const part = parts.get(path);
  const face = part.info.faces[faceIndexAtTriangle(part.groups, hit.faceIndex)];
  return face ? { part: path, face, point: hit.point } : null;
}
function worldAt(e) {
  const hit = pick(e);
  if (hit) return { point: hit.point, hit };
  raycaster.setFromCamera(ndc(e), camera);
  const n = camera.getWorldDirection(new THREE.Vector3());
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, controls.target);
  const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3());
  return point ? { point, hit: null } : null;
}


/** The visible edge nearest the pointer, within EDGE_PX on screen. */
function pickEdge(e) {
  if (previewStep !== null) return null;
  const r = stage.getBoundingClientRect();
  const mx = e.clientX - r.left, my = e.clientY - r.top;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), sa = new THREE.Vector3(), sb = new THREE.Vector3();
  const near = [];
  for (const [path, part] of parts) {
    if (!part.mesh.visible) continue;
    part.edgeGeom.forEach((edge, i) => {
      let best = null;
      for (let k = 3; k < edge.points.length; k += 3) {
        a.fromArray(edge.points, k - 3).applyMatrix4(part.matrix);
        b.fromArray(edge.points, k).applyMatrix4(part.matrix);
        sa.copy(a).project(camera);
        sb.copy(b).project(camera);
        if (Math.abs(sa.z) > 1 || Math.abs(sb.z) > 1) continue;
        const ax = ((sa.x + 1) / 2) * r.width, ay = ((1 - sa.y) / 2) * r.height;
        const dx = ((sb.x + 1) / 2) * r.width - ax, dy = ((1 - sb.y) / 2) * r.height - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? THREE.MathUtils.clamp(((mx - ax) * dx + (my - ay) * dy) / len2, 0, 1) : 0;
        const d = Math.hypot(ax + t * dx - mx, ay + t * dy - my);
        if (d <= EDGE_PX && (!best || d < best.d)) best = { d, point: a.clone().lerp(b, t) };
      }
      if (best) near.push({ part: path, edge: i, ...best });
    });
  }
  near.sort((x, y) => x.d - y.d);
  // An edge behind the model is hidden: a face lies between it and the camera.
  const meshes = [...parts.values()].filter((p) => p.mesh.visible).map((p) => p.mesh);
  for (const c of near.slice(0, 8)) {
    const dir = c.point.clone().sub(camera.position);
    const dist = dir.length();
    raycaster.set(camera.position, dir.normalize());
    const first = raycaster.intersectObjects(meshes, false)[0];
    if (!first || first.distance >= dist - (0.1 + dist * 1e-3)) return { part: c.part, edge: c.edge, point: c.point };
  }
  return null;
}
/** An edge near the pointer, else the face under it. */
function pickAny(e) {
  return pickEdge(e) ?? pick(e);
}
const keyOf = (hit) => (hit.edge !== undefined ? `${hit.part}|edge ${hit.edge}` : `${hit.part}|${hit.face.id ?? hit.face}`);
function labelOf(hit) {
  if (hit.edge === undefined) return `${hit.part}/${hit.face.id ?? hit.face}`;
  return `${hit.part}/${parts.get(hit.part).edgeGeom[hit.edge].kind} edge`;
}
function edgeOverlay(path, i, material) {
  const part = parts.get(path);
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(part.edgeGeom[i].points, 3));
  const line = new THREE.Line(g, material);
  line.renderOrder = 3;
  bindPose(line, part.matrix);
  world.add(line);
  return line;
}
function highlight(hit, faceMaterial, edgeMaterial) {
  return hit.edge !== undefined ? edgeOverlay(hit.part, hit.edge, edgeMaterial) : overlayFor(hit.part, hit.face.id ?? hit.face, faceMaterial);
}

function hover(e) {
  const hit = e ? (drawMode ? pick(e) : pickAny(e)) : null;
  const key = hit ? keyOf(hit) : "";
  const tip = $("tip");
  if (key !== hoverKey) {
    hoverKey = key;
    dropOverlay(hoverOverlay);
    hoverOverlay = hit ? highlight(hit, hoverMaterial, hoverEdgeMaterial) : null;
    if (hit) tip.textContent = labelOf(hit);
  }
  tip.hidden = !hit;
  if (hit) {
    const r = stage.getBoundingClientRect();
    tip.style.left = `${e.clientX - r.left + 12}px`;
    tip.style.top = `${e.clientY - r.top + 12}px`;
  }
}

// --- Pointing ---------------------------------------------------------------
function addPin(hit) {
  const r = {
    n: nextRef++, part: hit.part, face: hit.face.id, point: hit.point.clone(),
    base: hit.point.clone().applyMatrix4(parts.get(hit.part).matrix.clone().invert()),
    overlay: overlayFor(hit.part, hit.face.id, pickedMaterial),
  };
  refs.push(r);
  insertToken(r.n);
  showSource(hit.face.src);
  renderRefs();
}
function removeRef(r) {
  const i = refs.indexOf(r);
  if (i >= 0) refs.splice(i, 1);
  dropOverlay(r.overlay);
  input.value = input.value.replace(new RegExp(`\\s?\\[${r.n}\\]`), "");
  renderRefs();
}
function clearRefs() {
  for (const r of refs) dropOverlay(r.overlay);
  refs.length = 0;
  nextRef = 1;
  renderRefs();
}
function renderRefs() {
  const box = $("refs");
  box.replaceChildren(...refs.map((r) => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.title = `Remove [${r.n}]`;
    const b = document.createElement("b");
    b.textContent = r.n;
    const span = document.createElement("span");
    span.textContent = r.stroke ? (r.faces.length ? `${r.faces.length} faces` : "drawing") : `${r.part}/${r.face}`;
    chip.append(b, span);
    chip.insertAdjacentHTML("beforeend", '<svg><use href="#i-x"/></svg>');
    chip.onclick = () => removeRef(r);
    return chip;
  }));
  const pins = $("pins");
  pins.replaceChildren(...refs.map((r) => {
    const el = document.createElement("button");
    el.className = "pin";
    el.textContent = r.n;
    el.setAttribute("aria-label", `Remove reference ${r.n}`);
    el.onclick = () => removeRef(r);
    r.el = el;
    return el;
  }));
}

// --- Measuring --------------------------------------------------------------
/** A picked face or edge in world coordinates at the current pose, as measure.js takes it. */
function entityOf(m) {
  const part = parts.get(m.part);
  const at = (v) => new THREE.Vector3(...v).applyMatrix4(part.matrix);
  const along = (v) => new THREE.Vector3(...v).transformDirection(part.matrix);
  if (m.edge !== undefined) {
    const g = part.edgeGeom[m.edge];
    const points = [];
    for (let k = 0; k < g.points.length; k += 3) points.push(new THREE.Vector3().fromArray(g.points, k).applyMatrix4(part.matrix));
    const out = { type: "edge", kind: g.kind, length: g.length, points };
    if (g.kind === "circle") {
      const axis = along(g.axis), x = along(g.x);
      out.circle = { center: at(g.center), axis, x, y: axis.clone().cross(x), radius: g.radius, first: g.first, last: g.last };
    }
    return out;
  }
  const index = part.info.faces.findIndex((f) => f.id === m.face);
  const g = part.faceGeom[index] ?? { kind: part.info.faces[index].surface };
  const pos = part.geometry.getAttribute("position"), source = part.geometry.index.array;
  const tris = [], v = new THREE.Vector3();
  for (let i = 0; i < part.groups.length; i += 3) {
    if (part.groups[i + 2] !== index) continue;
    for (let t = part.groups[i] * 3, end = t + part.groups[i + 1] * 3; t < end; t++) {
      tris.push(...v.fromBufferAttribute(pos, source[t]).applyMatrix4(part.matrix).toArray());
    }
  }
  const out = { type: "face", kind: g.kind, area: part.info.faces[index].area, tris };
  if (g.normal) out.plane = { origin: at(g.origin), normal: along(g.normal) };
  if (g.axis) out.axis = { origin: at(g.origin), dir: along(g.axis), radius: g.radius };
  return out;
}
/** Adds a picked face or edge to the measurement, or takes it out when picked again; empty space clears it. */
function toggleMeasure(hit) {
  if (!hit) return clearMeasure();
  const key = keyOf(hit);
  const i = measured.findIndex((m) => m.key === key);
  if (i >= 0) dropOverlay(measured.splice(i, 1)[0].overlay);
  else {
    const m = hit.edge !== undefined ? { part: hit.part, edge: hit.edge } : { part: hit.part, face: hit.face.id };
    measured.push({ ...m, key, overlay: highlight(hit, pickedMaterial, pickedEdgeMaterial) });
  }
  renderMeasure();
}
function clearMeasure() {
  for (const m of measured) dropOverlay(m.overlay);
  measured.length = 0;
  renderMeasure();
}
function renderMeasure() {
  const box = $("measure");
  box.hidden = !measured.length;
  if (!measured.length) return;
  const head = document.createElement("div");
  head.className = "head";
  head.textContent = measured.length === 1 ? labelOf(measured[0]) : `${measured.length} selected`;
  box.replaceChildren(head, ...measure(measured.map(entityOf)).map((r) => {
    const row = document.createElement("div");
    row.className = "measure-row";
    const label = document.createElement("span");
    label.textContent = r.label;
    const value = document.createElement("b");
    value.textContent = r.value;
    row.append(label, value);
    return row;
  }));
}

// Pointer gestures: click measures, drag orbits; in draw mode, click pins a face and drag draws.
let down = null;
let stroke = null;
const canvas = renderer.domElement;
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.clientX, y: e.clientY };
  if (drawMode) {
    stroke = { points: [], faces: new Map() };
    canvas.setPointerCapture(e.pointerId);
    extendStroke(e);
  }
});
canvas.addEventListener("pointermove", (e) => {
  if (stroke) return extendStroke(e);
  if (!e.buttons) hover(e);
  else hover(null);
});
canvas.addEventListener("pointerleave", () => hover(null));
// Trackpad: two-finger scroll pans and pinch zooms; a mouse wheel zooms.
// Chrome and Safari report a trackpad's wheelDeltaY as -3x its deltaY.
stage.addEventListener("wheel", (e) => {
  if (!controls.enabled || e.ctrlKey || e.target !== canvas) return;
  const trackpad = e.wheelDeltaY ? e.wheelDeltaY === -3 * e.deltaY : e.deltaMode === 0 && e.deltaX !== 0;
  if (!trackpad) return;
  e.preventDefault();
  e.stopPropagation();
  gizmo.turn = null;
  controls._pan(-e.deltaX, -e.deltaY);
}, { capture: true, passive: false });
canvas.addEventListener("pointerup", (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (stroke) {
    if (moved > CLICK_SLOP) return finishStroke();
    stroke = null;
    const hit = pick(e);
    if (hit) addPin(hit);
    return;
  }
  if (moved <= CLICK_SLOP) toggleMeasure(pickAny(e));
});
function extendStroke(e) {
  const at = worldAt(e);
  if (!at) return;
  stroke.points.push(at.point.clone());
  if (at.hit) stroke.faces.set(`${at.hit.part}|${at.hit.face.id}`, { part: at.hit.part, face: at.hit.face.id, point: at.point.clone() });
}
function finishStroke() {
  const s = stroke;
  stroke = null;
  if (s.points.length < 2) return;
  const r = { n: nextRef++, stroke: s.points, faces: [...s.faces.values()].slice(0, 12), point: s.points[0] };
  refs.push(r);
  insertToken(r.n);
  renderRefs();
}
function setDraw(on) {
  drawMode = on;
  controls.enabled = !on;
  hover(null); // draw mode hovers faces only
  $("draw").setAttribute("aria-pressed", on);
  stage.classList.toggle("drawing", on);
}

// --- Frame ------------------------------------------------------------------
function project(v) {
  const p = v.clone().project(camera);
  return { x: ((p.x + 1) / 2) * stage.clientWidth, y: ((1 - p.y) / 2) * stage.clientHeight, front: p.z < 1 };
}
function drawInk(ctx, scale) {
  ctx.lineWidth = 3 * scale;
  ctx.lineJoin = ctx.lineCap = "round";
  ctx.strokeStyle = "#e8590c";
  const line = (points) => {
    ctx.beginPath();
    points.forEach((p, i) => {
      const s = project(p);
      ctx[i ? "lineTo" : "moveTo"](s.x * scale, s.y * scale);
    });
    ctx.stroke();
  };
  for (const r of refs) if (r.stroke) line(r.stroke);
  if (stroke) line(stroke.points);
}
function frame(now) {
  requestAnimationFrame(frame);
  if (!stepTurn(now)) controls.update();
  sun.position.copy(camera.position);
  if (flashOverlays.length) {
    const left = flashUntil - now;
    flashMaterial.opacity = Math.max(0, Math.min(1, left / 1200)) * 0.7;
    if (left <= 0) {
      flashOverlays.forEach(dropOverlay);
      flashOverlays = [];
    }
  }
  renderer.render(scene, camera);
  renderGizmo();
  const ctx = ink.getContext("2d");
  ctx.clearRect(0, 0, ink.width, ink.height);
  drawInk(ctx, devicePixelRatio);
  for (const r of refs) {
    if (!r.el) continue;
    const s = project(r.point);
    r.el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    r.el.style.visibility = s.front ? "visible" : "hidden";
  }
}
requestAnimationFrame(frame);

/** What the person sees, including their pins and strokes. */
function screenshot() {
  renderer.render(scene, camera);
  const src = renderer.domElement;
  const scale = Math.min(1, MAX_SHOT / Math.max(src.width, src.height));
  const out = document.createElement("canvas");
  out.width = src.width * scale;
  out.height = src.height * scale;
  const ctx = out.getContext("2d");
  ctx.fillStyle = getComputedStyle(document.body).backgroundColor;
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(src, 0, 0, out.width, out.height);
  const k = out.width / stage.clientWidth;
  drawInk(ctx, k);
  for (const r of refs) {
    const s = project(r.point);
    ctx.fillStyle = "#e8590c";
    ctx.beginPath();
    ctx.arc(s.x * k, s.y * k, 11 * k, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#fff";
    ctx.font = `600 ${12 * k}px system-ui`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(r.n), s.x * k, s.y * k);
  }
  return out.toDataURL("image/png");
}

// --- Joints: the model moves without a rebuild ------------------------------
const jointValue = (j) => Math.min(j.max, Math.max(j.min, pose[j.path] ?? j.value));
const jointUnit = (j) => (j.kind === "revolute" ? "°" : "mm");
const jointNumber = (v) => String(Math.round(v * 100) / 100);

/** Meshes hold the build's pose. Each part gets the joints that carry it, outermost first. */
function applyPose() {
  for (const p of parts.values()) p.matrix.identity();
  const pivot = new THREE.Matrix4(), turn = new THREE.Matrix4(), step = new THREE.Matrix4();
  for (const j of model?.joints ?? []) {
    const delta = jointValue(j) - j.value;
    if (delta === 0) continue;
    const [ox, oy, oz] = j.origin, axis = new THREE.Vector3(...j.axis);
    if (j.kind === "revolute") {
      step.makeTranslation(ox, oy, oz)
        .multiply(turn.makeRotationAxis(axis, THREE.MathUtils.degToRad(delta)))
        .multiply(pivot.makeTranslation(-ox, -oy, -oz));
    } else step.makeTranslation(axis.x * delta, axis.y * delta, axis.z * delta);
    for (const path of j.moves) parts.get(path).matrix.multiply(step);
  }
  world.updateMatrixWorld(true);
  for (const r of refs) {
    const part = r.base && parts.get(r.part);
    if (part) r.point.copy(r.base).applyMatrix4(part.matrix);
  }
  if (measured.length) renderMeasure();
}
/** The joints the person moved away from the source, for the agent. */
function movedJoints() {
  const moved = (model?.joints ?? []).filter((j) => jointValue(j) !== j.value);
  return Object.fromEntries(moved.map((j) => [j.path, jointValue(j)]));
}
function jointRow(j) {
  const el = document.createElement("div");
  el.className = "joint";
  const head = document.createElement("div");
  head.className = "joint-head";
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = j.path;
  name.title = j.path;
  const number = document.createElement("input");
  number.type = "number";
  number.step = "any";
  number.min = j.min;
  number.max = j.max;
  number.setAttribute("aria-label", `${j.path} value`);
  const unit = document.createElement("span");
  unit.className = "dim";
  unit.textContent = jointUnit(j);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "icon";
  reset.title = `Reset to ${jointNumber(j.value)}${jointUnit(j)}`;
  reset.setAttribute("aria-label", `Reset ${j.path}`);
  reset.innerHTML = '<svg><use href="#i-reset"/></svg>';
  head.append(name, number, unit, reset);
  const range = document.createElement("input");
  range.type = "range";
  range.min = j.min;
  range.max = j.max;
  range.step = j.kind === "revolute" ? 1 : (j.max - j.min) / 200;
  range.setAttribute("aria-label", j.path);
  el.append(head, range);

  const show = () => {
    const v = jointValue(j);
    range.value = v;
    if (document.activeElement !== number) number.value = jointNumber(v);
    reset.style.visibility = v === j.value ? "hidden" : "visible";
  };
  const set = (v) => {
    if (!Number.isFinite(v)) return;
    pose[j.path] = v;
    applyPose();
    show();
  };
  range.oninput = () => set(range.valueAsNumber);
  number.oninput = () => set(number.valueAsNumber);
  number.onblur = show;
  reset.onclick = () => {
    delete pose[j.path];
    applyPose();
    show();
  };
  show();
  return el;
}

// --- Design panel: parts, joints, feature history, source, checks --
function row(label, dim, current, onclick) {
  const b = document.createElement("button");
  b.className = "row";
  if (current) b.setAttribute("aria-current", "true");
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = label;
  const d = document.createElement("span");
  d.className = "dim spacer";
  d.textContent = dim;
  b.append(name, d);
  b.onclick = onclick;
  return b;
}
const openPlaces = new Set(); // sub-assembly paths unfolded in the parts list; folded by default
const leafName = (path) => path.slice(path.lastIndexOf("/") + 1);
/** The parts list as the instance tree: each sub-assembly folds over the parts placed under it. */
function partRows() {
  const types = new Map((model.assemblies ?? []).map((a) => [a.path, a.type]));
  const out = [], shown = new Set();
  for (const p of model.parts) {
    const segs = p.path.split("/");
    let hidden = false;
    for (let i = 1; i < segs.length && !hidden; i++) {
      const path = segs.slice(0, i).join("/");
      if (!shown.has(path)) {
        shown.add(path);
        out.push(placeRow(path, types.get(path) ?? "", i - 1));
      }
      hidden = !openPlaces.has(path);
    }
    if (hidden) continue;
    const b = row(p.path ? leafName(p.path) : p.type, p.type, selectedPart === p.path, () => {
      selectedPart = selectedPart === p.path ? null : p.path;
      setPreview(null);
      renderDesign();
    });
    b.title = p.path;
    b.style.paddingLeft = `calc(var(--s2) + ${(segs.length - 1) * 16}px)`;
    if (model.ground === p.path) {
      b.firstChild.insertAdjacentHTML("afterend", '<svg class="ground" role="img" aria-label="Ground"><title>Ground</title><use href="#i-pin"/></svg>');
    }
    b.onpointerenter = () => setHoveredPart(p.path);
    b.onpointerleave = () => setHoveredPart(null);
    out.push(b);
  }
  return out;
}
function placeRow(path, type, depth) {
  const open = openPlaces.has(path);
  const b = row(leafName(path), type, false, () => {
    if (open) openPlaces.delete(path);
    else openPlaces.add(path);
    renderDesign();
  });
  b.classList.add("place");
  b.title = path;
  b.style.paddingLeft = `calc(var(--s2) + ${depth * 16}px)`;
  b.setAttribute("aria-expanded", open);
  b.insertAdjacentHTML("afterbegin", '<svg aria-hidden="true"><use href="#i-chevron"/></svg>');
  b.onpointerenter = () => setHoveredPart(path);
  b.onpointerleave = () => setHoveredPart(null);
  return b;
}
function renderDesign() {
  $("parts").hidden = !model;
  if (!model) {
    $("joints").hidden = $("steps").hidden = $("checks").hidden = true;
    return;
  }
  if (selectedPart && !parts.has(selectedPart)) selectedPart = null;
  $("parts").replaceChildren(...partRows());
  $("joints").hidden = model.joints.length === 0;
  $("joints").replaceChildren(...model.joints.map(jointRow));
  const part = selectedPart !== null ? parts.get(selectedPart) : null;
  const steps = $("steps");
  steps.hidden = !part;
  if (part) {
    steps.replaceChildren(...spine(part.info.steps).map((s) =>
      row(stepLabel(s, part.info.steps), s.op, previewStep === s.id, () => {
        setPreview(previewStep === s.id ? null : s.id);
        showSource(s.src);
        renderDesign();
      }),
    ));
  }
  const checks = $("checks");
  checks.hidden = model.checks.length === 0;
  checks.replaceChildren(...model.checks.map((c) => {
    const el = document.createElement("div");
    el.className = `check ${c.pass ? "pass" : "fail"}`;
    el.textContent = `${c.pass ? "✓" : "✗"} ${c.name}`;
    return el;
  }));
}
/** The body's own history: from the result back along each feature's first input. */
function spine(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const out = [];
  for (let s = steps.at(-1); s; s = byId.get(s.inputs[0])) {
    if (!isTransform(s) || isNamed(s)) out.unshift(s);
  }
  return out;
}
const isTransform = (s) => ["translate", "rotate", "mirror"].includes(s.op);
const isNamed = (s) => !/^[a-z]+\d+$/.test(s.name) || !s.name.startsWith(s.op);
/** "cut pocket, mount[0], ..." reads better than "cut1". */
function stepLabel(s, steps) {
  if (isNamed(s) && !["union", "cut", "intersect"].includes(s.op)) return s.name;
  const byId = new Map(steps.map((x) => [x.id, x]));
  const root = (x) => (isTransform(x) && !isNamed(x) ? root(byId.get(x.inputs[0])) : x.name);
  const tools = s.inputs.slice(1).map((id) => root(byId.get(id)));
  return tools.length ? tools.join(", ") : s.name;
}
/** Shows the part as it was at one step of its feature history. */
function setPreview(id) {
  previewStep = id;
  if (previewObject) {
    world.remove(previewObject);
    disposeTree(previewObject);
    previewObject = null;
  }
  paintParts();
  if (id === null) return;
  const data = stepMeshes[selectedPart]?.[id];
  if (!data) return;
  const g = geometryOf(data);
  previewObject = new THREE.Group();
  previewObject.add(new THREE.Mesh(g, partMaterial), new THREE.LineSegments(new THREE.EdgesGeometry(g, 28), edgeMaterial));
  bindPose(previewObject, parts.get(selectedPart).matrix);
  world.add(previewObject);
}
function setHoveredPart(path) {
  hoveredPart = path;
  paintParts();
}
/** Colors each part: ghosted around a step preview, else by selection and row hover. */
function paintParts() {
  const previewing = previewStep !== null;
  for (const [path, p] of parts) {
    p.edges.visible = !previewing;
    p.mesh.visible = !previewing || path !== selectedPart;
    p.mesh.material = previewing ? ghostMaterial
      : path === selectedPart ? selectedMaterial
      : hoveredPart !== null && (path === hoveredPart || path.startsWith(`${hoveredPart}/`)) ? hoverPartMaterial
      : partMaterial;
  }
}
async function showSource(src) {
  const box = $("source");
  const res = await fetch(`/source?file=${encodeURIComponent(src.file)}`);
  if (!res.ok) {
    box.hidden = true;
    return;
  }
  const { lines } = await res.json();
  const from = Math.max(0, src.line - 4), to = Math.min(lines.length, src.line + 3);
  const file = document.createElement("div");
  file.className = "file";
  file.textContent = `${src.file}:${src.line}`;
  box.replaceChildren(file, ...lines.slice(from, to).map((text, i) => {
    const l = document.createElement("div");
    l.className = `line${from + i + 1 === src.line ? " at" : ""}`;
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = from + i + 1;
    const code = document.createElement("span");
    code.textContent = text;
    l.append(num, code);
    return l;
  }));
  box.hidden = false;
}

// --- Project: file tree, folder picker --------------------------------------
const post = (path, body) => fetch(path, { method: "POST", body: JSON.stringify(body) });

async function openFile(file) {
  if (file === opened.entry) return;
  const res = await post("/entry", { file });
  if (!res.ok) showBanner({ message: (await res.json()).error });
}
function treeOf(files) {
  const top = { dirs: new Map(), files: [] };
  for (const file of files) {
    const names = file.split("/");
    let at = top, path = "";
    for (const name of names.slice(0, -1)) {
      path += `${name}/`;
      if (!at.dirs.has(name)) at.dirs.set(name, { path, dirs: new Map(), files: [] });
      at = at.dirs.get(name);
    }
    at.files.push({ path: file, name: names.at(-1) });
  }
  return top;
}
function treeRow(name, depth) {
  const b = document.createElement("button");
  b.className = "row";
  b.style.paddingLeft = `calc(var(--s2) + ${depth * 16}px)`;
  const label = document.createElement("span");
  label.className = "name";
  label.textContent = name;
  b.append(label);
  return b;
}
function treeRows(node, depth = 0) {
  const out = [];
  for (const [name, dir] of [...node.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    const open = !collapsed.has(dir.path);
    const b = treeRow(name, depth);
    b.setAttribute("aria-expanded", open);
    b.insertAdjacentHTML("afterbegin", '<svg aria-hidden="true"><use href="#i-chevron"/></svg>');
    b.onclick = () => {
      if (open) collapsed.add(dir.path);
      else collapsed.delete(dir.path);
      renderTree();
    };
    out.push(b, ...(open ? treeRows(dir, depth + 1) : []));
  }
  for (const f of node.files) {
    const b = treeRow(f.name, depth);
    b.title = f.path;
    if (f.path === opened.entry) b.setAttribute("aria-current", "true");
    b.onclick = () => openFile(f.path);
    out.push(b);
  }
  return out;
}
function note(text) {
  const el = document.createElement("div");
  el.className = "note";
  el.textContent = text;
  return el;
}
function renderTree() {
  $("files").hidden = !opened.root;
  $("project-name").textContent = opened.name ?? "";
  $("project-name").title = opened.root ?? "";
  const rows = treeRows(treeOf(opened.files));
  if (!rows.length) rows.push(note("No .cad.ts or STEP files in this folder"));
  if (opened.truncated) rows.push(note(`Showing the first ${opened.files.length} files`));
  $("tree").replaceChildren(...rows);
}
function renderEmpty() {
  const text = !opened.root ? "" : !opened.entry ? "Select a file" : buildPending ? "Building..." : "";
  $("open-first").hidden = !!opened.root;
  $("empty-text").textContent = text;
  $("empty-text").hidden = !text;
  $("empty").hidden = !!opened.root && !text;
}
function renderTabs() {
  const bar = $("tabs");
  bar.hidden = !opened.tabs.length;
  bar.replaceChildren(...opened.tabs.map((t) => {
    const current = t.file === opened.entry;
    const name = t.file.split("/").at(-1);
    const tab = document.createElement("div");
    tab.className = `tab${t.failed ? " failed" : ""}`;
    if (current) tab.setAttribute("aria-current", "true");
    const open = document.createElement("button");
    open.className = "tab-name";
    open.setAttribute("role", "tab");
    open.setAttribute("aria-selected", current);
    open.title = t.file;
    open.textContent = name;
    open.onclick = () => openFile(t.file);
    const close = document.createElement("button");
    close.className = "icon";
    close.setAttribute("aria-label", `Close ${name}`);
    close.title = `Close ${name}`;
    close.innerHTML = '<svg><use href="#i-x"/></svg>';
    close.onclick = () => post("/tab/close", { file: t.file });
    tab.append(open, close);
    return tab;
  }));
  bar.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}
/** Applies the server's open tabs, and fetches the on-screen tab's build if it is newer. */
function applyEntry(e) {
  // A tab without a fresh build shows nothing, the one on screen too.
  const stale = (file) => !e.tabs.find((t) => t.file === file)?.version;
  if (e.entry !== opened.entry) showView(e.entry);
  opened = { ...opened, entry: e.entry, tabs: e.tabs };
  for (const file of [...views.keys()]) {
    if (!stale(file)) continue;
    const onScreen = views.get(file).world === world;
    dropView(file);
    if (onScreen) {
      scene.remove(world);
      world = new THREE.Group();
      scene.add(world);
      model = null;
      parts = new Map();
      stepMeshes = {};
      renderDesign();
    }
  }
  for (const file of [...keptByTab.keys()]) {
    if (!e.tabs.some((t) => t.file === file)) keptByTab.delete(file);
  }
  buildPending = !!e.entry && e.building === e.entry;
  input.disabled = $("mic").disabled = !e.entry;
  updateSend();
  renderTabs();
  renderTree();
  renderEmpty();
  showBanner(e.buildError);
  const tab = e.tabs.find((t) => t.file === e.entry);
  if (tab?.version && tab.version !== views.get(e.entry)?.version) loadModel();
  try {
    if (opened.root) {
      localStorage.setItem(LAST_OPENED, JSON.stringify({ path: opened.root, entry: e.entry, tabs: e.tabs.map((t) => t.file) }));
    }
  } catch {
    // Without storage the app just starts on the open-project screen.
  }
}
function applyProject(e) {
  if (e.root !== opened.root) {
    showView(null);
    for (const file of [...views.keys()]) dropView(file);
    keptByTab.clear();
    opened.entry = null;
  }
  opened = { ...opened, root: e.root, name: e.name, files: e.files, truncated: e.truncated };
  applyEntry(e);
  if (e.root) return;
  try {
    const last = localStorage.getItem(LAST_OPENED);
    if (last) post("/project", JSON.parse(last));
  } catch {
    // Same as above.
  }
}

let browseToken = 0;
async function browse(path) {
  const token = ++browseToken;
  const res = await fetch(path ? `/dirs?path=${encodeURIComponent(path)}` : "/dirs");
  const d = await res.json();
  if (token !== browseToken) return;
  pickerError(res.ok ? "" : d.error);
  if (!res.ok) return;
  $("picker-path").value = d.path;
  $("picker-up").disabled = !d.parent;
  $("picker-up").onclick = () => browse(d.parent);
  const list = $("picker-list");
  list.replaceChildren(...d.dirs.map((name) =>
    row(name, "", false, () => browse(`${d.path.replace(/[\\/]$/, "")}/${name}`)),
  ));
  if (!d.dirs.length) list.append(note("No folders here"));
  list.scrollTop = 0;
}
function pickerError(text) {
  $("picker-error").textContent = text;
  $("picker-error").hidden = !text;
}
function openPicker() {
  $("picker").showModal();
  browse();
}
$("open-project").onclick = $("open-first").onclick = openPicker;
$("picker-close").onclick = () => $("picker").close();
$("picker").addEventListener("click", (e) => {
  if (e.target === $("picker")) $("picker").close();
});
// A listing still on its way must not overwrite what the person is typing.
$("picker-path").addEventListener("input", () => browseToken++);
$("picker-form").addEventListener("submit", (e) => {
  e.preventDefault();
  browse($("picker-path").value);
});
$("picker-open").onclick = async () => {
  const open = $("picker-open");
  open.disabled = true;
  const res = await post("/project", { path: $("picker-path").value });
  open.disabled = false;
  pickerError(res.ok ? "" : (await res.json()).error);
  if (res.ok) $("picker").close();
};

// --- Conversation -----------------------------------------------------------
function addMessage(m) {
  const log = $("log");
  const el = document.createElement("div");
  el.className = `msg ${m.role === "user" ? "user" : m.kind}`;
  el.textContent = m.text;
  if (m.kind === "tool") el.title = m.text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
}
function setRunning(on, queued = 0) {
  running = on;
  updateSend();
  const q = $("queued");
  q.hidden = queued === 0;
  q.textContent = `${queued} waiting for the agent`;
  $("new-session").disabled = on || !opened.root;
}
function updateSend() {
  const send = $("send");
  const stop = running && !input.value.trim();
  send.className = `icon ${stop ? "danger" : "primary"}`;
  send.setAttribute("aria-label", stop ? "Stop agent" : "Send");
  send.title = stop ? "Stop agent" : "Send";
  send.querySelector("use").setAttribute("href", stop ? "#i-stop" : "#i-send");
  send.dataset.stop = stop ? "1" : "";
  send.disabled = !stop && !opened.entry;
}
function insertToken(n) {
  if (listening) {
    speechTokens.push({ n, at: speechText().length });
    renderSpeech();
    return;
  }
  const v = input.value;
  input.value = `${v}${v && !v.endsWith(" ") ? " " : ""}[${n}] `;
  updateSend();
}
function payload() {
  const out = [];
  for (const r of refs) {
    if (r.stroke) {
      for (const f of r.faces) out.push({ n: r.n, part: f.part, face: f.face, point: f.point.toArray() });
    } else out.push({ n: r.n, part: r.part, face: r.face, point: r.point.toArray() });
  }
  return out;
}
async function send() {
  const text = input.value.trim();
  if (!text || !opened.entry) return;
  const body = { text, refs: payload(), pose: movedJoints(), screenshot: screenshot() };
  input.value = "";
  clearRefs();
  updateSend();
  const res = await fetch("/feedback", { method: "POST", body: JSON.stringify(body) });
  if (!res.ok) {
    input.value = text;
    addMessage({ role: "agent", kind: "error", text: "Sending failed because the preview server did not accept it. Check that vibecad dev is running, then send again." });
    updateSend();
  }
}
$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  if ($("send").dataset.stop) fetch("/stop", { method: "POST" });
  else send();
});
input.addEventListener("input", updateSend);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});
$("draw").onclick = () => setDraw(!drawMode);
$("fit").onclick = fit;
$("new-session").onclick = () => fetch("/session/new", { method: "POST" });

// --- Voice: pins made while talking land where they were said ---------------
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let listening = false;
let speechBase = "";
let speechFinal = "";
let speechInterim = "";
let speechTokens = [];
function speechText() {
  return speechFinal + speechInterim;
}
function renderSpeech() {
  const text = speechText();
  let out = "", at = 0;
  for (const t of [...speechTokens].sort((a, b) => a.at - b.at)) {
    const cut = Math.min(t.at, text.length);
    out += `${text.slice(at, cut)} [${t.n}] `;
    at = cut;
  }
  out += text.slice(at);
  input.value = (speechBase + out).replace(/ {2,}/g, " ").trimStart();
  updateSend();
}
function setMic(on) {
  const mic = $("mic");
  mic.className = `icon${on ? " danger" : ""}`;
  mic.querySelector("use").setAttribute("href", on ? "#i-stop" : "#i-mic");
  mic.setAttribute("aria-label", on ? "Stop talking and send" : "Talk (hold Space)");
  mic.title = mic.getAttribute("aria-label");
  $("composer").classList.toggle("listening", on);
}
function startListening() {
  if (listening || !opened.entry) return;
  const err = $("mic-error");
  err.hidden = true;
  if (!Recognition) {
    err.textContent = "This browser has no speech recognition. Use Chrome or Safari, or type instead.";
    err.hidden = false;
    return;
  }
  recognizer = new Recognition();
  recognizer.lang = navigator.language;
  recognizer.continuous = true;
  recognizer.interimResults = true;
  speechBase = input.value;
  speechFinal = speechInterim = "";
  speechTokens = [];
  listening = true;
  setMic(true);
  recognizer.onresult = (e) => {
    speechInterim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) speechFinal += e.results[i][0].transcript;
      else speechInterim += e.results[i][0].transcript;
    }
    renderSpeech();
  };
  recognizer.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    err.textContent = e.error === "not-allowed"
      ? "Voice input failed because microphone access is blocked. Allow it in the browser, then try again."
      : `Voice input failed (${e.error}). Try again, or type instead.`;
    err.hidden = false;
  };
  recognizer.onend = () => {
    listening = false;
    setMic(false);
    send();
  };
  recognizer.start();
}
function stopListening() {
  if (listening) recognizer.stop();
}
/** Ends voice input without sending, keeping what was heard as the draft. */
function cancelListening() {
  if (!listening) return;
  recognizer.onend = null;
  recognizer.abort();
  listening = false;
  setMic(false);
}
$("mic").onclick = () => (listening ? stopListening() : startListening());

// --- Keyboard ---------------------------------------------------------------
const typing = () => document.activeElement === input || document.activeElement?.type === "number" || $("picker").open;
addEventListener("keydown", (e) => {
  if (typing()) {
    if (e.key === "Escape" && !$("picker").open) document.activeElement.blur();
    return;
  }
  if (e.code === "Space") {
    e.preventDefault();
    if (!e.repeat) startListening();
  } else if (e.key === "d" || e.key === "D") setDraw(!drawMode);
  else if (e.key === "f" || e.key === "F") fit();
  else if (e.key === "Escape") {
    clearRefs();
    clearMeasure();
    input.value = "";
    updateSend();
    setDraw(false);
  }
});
addEventListener("keyup", (e) => {
  if (e.code === "Space" && !typing()) stopListening();
});

// --- Server events ----------------------------------------------------------
function showBanner(error) {
  const b = $("banner");
  b.hidden = !error;
  if (!error) return;
  const msg = document.createElement("div");
  msg.textContent = error.hint ? `${error.message}. ${error.hint}` : error.message;
  b.replaceChildren(msg);
  if (error.src) {
    const w = document.createElement("div");
    w.className = "where";
    w.textContent = `${error.src.file}:${error.src.line}`;
    b.append(w);
  }
}
const events = new EventSource("/events");
events.onmessage = (ev) => {
  const e = JSON.parse(ev.data);
  if (e.type === "hello") {
    applyProject(e);
    $("log").replaceChildren();
    e.log.forEach(addMessage);
    setRunning(e.running, e.queued);
  } else if (e.type === "entry") {
    applyEntry(e);
  } else if (e.type === "files") {
    opened = { ...opened, files: e.files, truncated: e.truncated };
    renderTree();
  } else if (e.type === "message") {
    addMessage(e);
  } else if (e.type === "status") {
    setRunning(e.running, e.queued);
  } else if (e.type === "reset") {
    $("log").replaceChildren();
  } else if (e.type === "show") {
    const part = parts.get(e.part);
    if (!part) return;
    const faces = e.face ? part.info.faces.filter((f) => f.id === e.face || f.name === e.face) : part.info.faces;
    for (const f of faces) flashOverlays.push(overlayFor(e.part, f.id, flashMaterial));
    if (faces.length) flashUntil = performance.now() + 4000;
  }
};
window.vibecad = { parts: () => parts, refs, measured, camera, controls };
dark.addEventListener("change", () => {
  edgeMaterial.color.set(dark.matches ? 0x0d0e10 : 0x24262b);
});
edgeMaterial.color.set(dark.matches ? 0x0d0e10 : 0x24262b);
resize();
