// Multi-view drawings of the build's meshes, optionally with numbered face tags so an agent can name what it sees.
// The meshes are shaded with a z-buffer rather than drawn by exact hidden-line removal, which can take
// minutes on swept helices; hidden edges are not drawn.
import { crc32, deflateSync } from "node:zlib";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type * as ViewsModule from "../node_modules/occt-wasm/dist/views.js";
import type * as FontModule from "../node_modules/occt-wasm/dist/font5x7.js";
import type { BuildOutput, MeshData } from "./eval.ts";

// The package does not export its layout or font. Using them keeps the views, gnomon and labels as the
// kernel's own drawing had them, and the kernel version is pinned exactly.
const inKernel = (file: string) => new URL(file, import.meta.resolve("occt-wasm")).href;
const views: typeof ViewsModule = await import(inKernel("./views.js"));
const { FONT_5X7, GLYPH_H, GLYPH_W }: typeof FontModule = await import(inKernel("./font5x7.js"));

type ViewName = ViewsModule.ViewName;
interface Options {
  views: ViewName[];
  columns: number;
  width: number;
  height: number;
}
const PLAIN: Options = { views: ["front", "top", "right", "iso"], columns: 2, width: 240, height: 240 };
// Every side, so only faces enclosed by the model go unseen.
const LABELED: Options = { views: ["front", "back", "left", "right", "top", "bottom", "iso"], columns: 4, width: 360, height: 360 };
const SS = 2; // supersampling, for smooth edges
const DEPTH_GAP = 0.02; // a depth jump this share of the model's size draws an edge within one face
const SCALE = 2; // pixels per font pixel in tags
const TAG_H = GLYPH_H * SCALE + 4;
const TAG_INK: Rgb = [20, 70, 200];
const EDGE: Rgb = [17, 17, 17];

type Rgb = [number, number, number];
export interface FaceLabel {
  n: number;
  part: string;
  face: string;
  views: ViewName[];
}
export interface LabeledRender {
  png: Uint8Array;
  labels: FaceLabel[];
  /** Faces no view can see, such as those inside a closed cavity. */
  unseen: Array<{ part: string; face: string }>;
}
interface Spot {
  x: number;
  y: number;
  /** Pixels from here to the face's nearest edge in this view. */
  clearance: number;
}
type Img = { w: number; h: number; px: Uint8Array };
type Box = { x: number; y: number; w: number; h: number };
type Vec = { x: number; y: number; z: number };
type Raster = { ids: Int32Array; depth: Float64Array; light: Float32Array };

const dot = (p: Float32Array, i: number, a: Vec) => p[3 * i]! * a.x + p[3 * i + 1]! * a.y + p[3 * i + 2]! * a.z;

/** Each mesh's vertices in view coordinates: u right, v up, z away from the camera. */
function project(meshes: MeshData[], b: ViewsModule.ViewBasis) {
  return meshes.map((m) => {
    const n = m.positions.length / 3;
    const u = new Float64Array(n), v = new Float64Array(n), z = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      u[i] = dot(m.positions, i, b.sx);
      v[i] = dot(m.positions, i, b.sy);
      z[i] = dot(m.positions, i, b.dir);
    }
    return { u, v, z };
  });
}

/** Rasterizes a panel at `s` pixels per panel pixel: the nearest face, its depth and its lighting at each pixel. */
function rasterize(
  meshes: MeshData[],
  proj: ReturnType<typeof project>,
  faceBase: Map<string, number>,
  b: ViewsModule.ViewBasis,
  t: ViewsModule.PanelTransform,
  s: number,
): Raster {
  const w = t.panelW * s, h = t.panelH * s;
  const ids = new Int32Array(w * h).fill(-1);
  const depth = new Float64Array(w * h).fill(Infinity);
  const light = new Float32Array(w * h);
  // A key light above and left of the camera, so faces of a box read apart.
  const toCam = { x: -b.dir.x, y: -b.dir.y, z: -b.dir.z };
  const l = { x: toCam.x + 0.5 * b.sy.x - 0.3 * b.sx.x, y: toCam.y + 0.5 * b.sy.y - 0.3 * b.sx.y, z: toCam.z + 0.5 * b.sy.z - 0.3 * b.sx.z };
  const ln = Math.hypot(l.x, l.y, l.z);
  meshes.forEach((m, mi) => {
    const base = faceBase.get(m.path) ?? 0;
    const { u, v, z } = proj[mi]!;
    const n = u.length;
    const sx = new Float64Array(n), sy = new Float64Array(n), lit = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      sx[i] = (u[i]! * t.scale + t.offsetX) * s;
      sy[i] = (-v[i]! * t.scale + t.offsetY) * s;
      // Lit as if the normal faced the camera, since a mesh's normals may point either way.
      const facing = dot(m.normals, i, toCam) < 0 ? -1 : 1;
      lit[i] = Math.max(0, (facing * dot(m.normals, i, l)) / ln);
    }
    for (let g = 0; g < m.faceGroups.length; g += 3) {
      const first = m.faceGroups[g]!, count = m.faceGroups[g + 1]!, face = base + m.faceGroups[g + 2]!;
      for (let tri = first; tri < first + count; tri++) {
        const a = m.indices[3 * tri]!, bb = m.indices[3 * tri + 1]!, c = m.indices[3 * tri + 2]!;
        const area = (sx[bb]! - sx[a]!) * (sy[c]! - sy[a]!) - (sy[bb]! - sy[a]!) * (sx[c]! - sx[a]!);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.floor(Math.min(sx[a]!, sx[bb]!, sx[c]!)));
        const x1 = Math.min(w - 1, Math.ceil(Math.max(sx[a]!, sx[bb]!, sx[c]!)));
        const y0 = Math.max(0, Math.floor(Math.min(sy[a]!, sy[bb]!, sy[c]!)));
        const y1 = Math.min(h - 1, Math.ceil(Math.max(sy[a]!, sy[bb]!, sy[c]!)));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const wa = ((sx[bb]! - px) * (sy[c]! - py) - (sy[bb]! - py) * (sx[c]! - px)) / area;
            const wb = ((sx[c]! - px) * (sy[a]! - py) - (sy[c]! - py) * (sx[a]! - px)) / area;
            const wc = 1 - wa - wb;
            if (wa < 0 || wb < 0 || wc < 0) continue;
            const d = wa * z[a]! + wb * z[bb]! + wc * z[c]!;
            const i = y * w + x;
            if (d < depth[i]!) {
              depth[i] = d;
              ids[i] = face;
              light[i] = wa * lit[a]! + wb * lit[bb]! + wc * lit[c]!;
            }
          }
        }
      }
    }
  });
  return { ids, depth, light };
}

/** Paints a supersampled panel into the image: shaded faces, and edges where the face or depth changes. */
function paint(img: Img, r: Raster, w: number, h: number, px: number, py: number, gap: number) {
  const edge = new Uint8Array(w * h);
  const differs = (i: number, j: number) =>
    r.ids[i] !== r.ids[j] || (r.ids[i]! >= 0 && Math.abs(r.depth[i]! - r.depth[j]!) > gap);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Both sides of a change, so a line stays a full pixel wide after downsampling.
      if (x + 1 < w && differs(i, i + 1)) edge[i] = edge[i + 1] = 1;
      if (y + 1 < h && differs(i, i + w)) edge[i] = edge[i + w] = 1;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (r.ids[i]! < 0 && !edge[i]) continue;
      const g = Math.round(120 + 115 * r.light[i]!);
      img.px.set(edge[i] ? EDGE : [g, g, g], 3 * ((py + y) * img.w + px + x));
    }
  }
}

function downsample(img: Img, s: number): Img {
  const w = Math.floor(img.w / s), h = Math.floor(img.h / s);
  const px = new Uint8Array(3 * w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < s; dy++) {
          for (let dx = 0; dx < s; dx++) sum += img.px[3 * ((y * s + dy) * img.w + x * s + dx) + c]!;
        }
        px[3 * (y * w + x) + c] = Math.round(sum / (s * s));
      }
    }
  }
  return { w, h, px };
}

/** Each visible face's most open pixel, by distance to the nearest other face or the background. */
function openSpots(ids: Int32Array, w: number, h: number) {
  const d = new Int32Array(w * h);
  const relax = (i: number, x: number, y: number, dx: number, dy: number) => {
    const nx = x + dx, ny = y + dy;
    const same = nx >= 0 && ny >= 0 && nx < w && ny < h && ids[ny * w + nx] === ids[i];
    d[i] = Math.min(d[i]!, same ? d[ny * w + nx]! + 1 : 1);
  };
  d.fill(w + h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      relax(y * w + x, x, y, -1, 0);
      relax(y * w + x, x, y, 0, -1);
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      relax(y * w + x, x, y, 1, 0);
      relax(y * w + x, x, y, 0, 1);
    }
  }
  const spots = new Map<number, Spot>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = ids[y * w + x]!;
      if (id < 0) continue;
      const hit = spots.get(id);
      if (!hit || d[y * w + x]! > hit.clearance) spots.set(id, { x, y, clearance: d[y * w + x]! });
    }
  }
  return spots;
}

function encodePng(w: number, h: number, px: Uint8Array) {
  const stride = 3 * w;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (type: string, body: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length);
    head.write(type, 4, "latin1");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(body, crc32(head.subarray(4))));
    return Buffer.concat([head, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", new Uint8Array()),
  ]);
}

const hex = (c: string): Rgb => {
  const h = c.length === 4 ? [...c.slice(1)].map((d) => d + d).join("") : c.slice(1);
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
};
const tagSize = (n: number) => ({ w: String(n).length * (GLYPH_W + 1) * SCALE + 2, h: TAG_H });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w + 1 && b.x < a.x + a.w + 1 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1;
function fill(img: Img, x0: number, y0: number, x1: number, y1: number, c: Rgb) {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) img.px.set(c, 3 * (y * img.w + x));
  }
}
function line(img: Img, x0: number, y0: number, x1: number, y1: number, c: Rgb, width = 1) {
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  const lo = Math.floor((width - 1) / 2), hi = lo + width;
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / (steps || 1)), y = Math.round(y0 + ((y1 - y0) * i) / (steps || 1));
    fill(img, x - lo, y - lo, x - lo + hi - lo, y - lo + hi - lo, c);
  }
}
/** Text in the kernel's 5x7 face, vertically centred on y. Glyphs the face lacks are skipped. */
function text(img: Img, s: string, x: number, y: number, size: number, c: Rgb, middle = false) {
  const px = Math.max(1, Math.round(size / GLYPH_H)), advance = (GLYPH_W + 1) * px;
  let cx = Math.round(middle ? x - (s.length * advance) / 2 : x);
  const top = Math.round(y - (GLYPH_H * px) / 2);
  for (const ch of s) {
    FONT_5X7[ch]?.forEach((bits, row) => {
      for (let col = 0; col < GLYPH_W; col++) {
        if (bits & (1 << (GLYPH_W - 1 - col))) fill(img, cx + col * px, top + row * px, cx + (col + 1) * px, top + (row + 1) * px, c);
      }
    });
    cx += advance;
  }
}

/** Draws the views of the meshes on one sheet, and reports which face owns each panel pixel. */
function draw(k: OcctKernel, shape: ShapeHandle, meshes: MeshData[], faceBase: Map<string, number>, opts: Options) {
  const o = views.resolved(opts);
  const bases = opts.views.map(views.basisFor);
  const projs = bases.map((b) => project(meshes, b));
  const extents = projs.map((p) => {
    const e = { minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity };
    for (const { u, v } of p) {
      for (let i = 0; i < u.length; i++) {
        e.minU = Math.min(e.minU, u[i]!), e.maxU = Math.max(e.maxU, u[i]!);
        e.minV = Math.min(e.minV, v[i]!), e.maxV = Math.max(e.maxV, v[i]!);
      }
    }
    return Number.isFinite(e.minU) ? e : { minU: 0, maxU: 0, minV: 0, maxV: 0 };
  });
  const layout = views.gridLayout(extents, o, opts.columns, true);
  const size = Math.max(...extents.flatMap((e) => [e.maxU - e.minU, e.maxV - e.minV]), 1e-9);
  const big: Img = { w: layout.totalW * SS, h: layout.totalH * SS, px: new Uint8Array(3 * layout.totalW * layout.totalH * SS * SS).fill(255) };
  const ids = layout.panels.map(({ px, py, t }, view) => {
    const r = rasterize(meshes, projs[view]!, faceBase, bases[view]!, t, SS);
    paint(big, r, t.panelW * SS, t.panelH * SS, px * SS, py * SS, DEPTH_GAP * size);
    // The face at each panel pixel's centre, for placing tags.
    const one = new Int32Array(t.panelW * t.panelH);
    for (let y = 0; y < t.panelH; y++) {
      for (let x = 0; x < t.panelW; x++) one[y * t.panelW + x] = r.ids[(y * SS + SS / 2) * t.panelW * SS + x * SS + SS / 2]!;
    }
    return one;
  });
  const img = downsample(big, SS);
  layout.panels.forEach(({ px, py, t }, view) => {
    const border = hex("#e0e0e0"), x1 = px + t.panelW - 1, y1 = py + t.panelH - 1;
    line(img, px, py, x1, py, border);
    line(img, px, y1, x1, y1, border);
    line(img, px, py, px, y1, border);
    line(img, x1, py, x1, y1, border);
    for (const arm of views.gnomonArms(bases[view]!, t)) {
      line(img, arm.x0 + px, arm.y0 + py, arm.x1 + px, arm.y1 + py, hex(arm.color), 2);
      text(img, arm.label, arm.lx + px, arm.ly + py, 9, hex(arm.color), true);
    }
    text(img, views.VIEW_LABEL[opts.views[view]!], t.pad + px, t.pad + py, 11, hex("#333"));
  });
  const dims = views.dimensionsText(k, shape, (n) => Math.round(n * 100) / 100);
  text(img, dims, layout.totalW / 2, layout.rows * o.height + 11, 11, hex("#444"), true);
  return { img, layout, ids };
}

function faceBases(out: BuildOutput, part?: string) {
  const parts = out.model.parts.filter((p) => !part || p.path === part);
  const faceBase = new Map<string, number>();
  let total = 0;
  for (const p of parts) {
    faceBase.set(p.path, total);
    total += p.faces.length;
  }
  return { parts, faceBase, meshes: out.meshes.filter((m) => !part || m.path === part) };
}

/** Draws front, top, right and iso views of the build, or of one part. */
export function render(k: OcctKernel, shape: ShapeHandle, out: BuildOutput, part?: string): Uint8Array {
  const { meshes, faceBase } = faceBases(out, part);
  const { img } = draw(k, shape, meshes, faceBase, PLAIN);
  return encodePng(img.w, img.h, img.px);
}

function drawTag(img: Img, n: number, box: Box) {
  fill(img, box.x, box.y, box.x + box.w, box.y + box.h, TAG_INK);
  fill(img, box.x + 1, box.y + 1, box.x + box.w - 1, box.y + box.h - 1, [255, 255, 255]);
  text(img, String(n), box.x + 2, box.y + 2 + GLYPH_H, GLYPH_H * SCALE, TAG_INK);
}

/** The free spot nearest (cx, cy) for a tag, searching outward inside the panel. */
function freeSpot(size: { w: number; h: number }, cx: number, cy: number, panel: Box, taken: Box[]): Box | undefined {
  const reach = Math.max(panel.w, panel.h);
  for (let r = 0; r < reach; r += 4) {
    const tries = r === 0 ? 1 : 24;
    for (let i = 0; i < tries; i++) {
      const a = (i / tries) * 2 * Math.PI;
      const x = Math.round(cx - size.w / 2 + r * Math.cos(a)), y = Math.round(cy - size.h / 2 + r * Math.sin(a));
      const box = { x, y, ...size };
      const inside = x >= panel.x && y >= panel.y && x + size.w <= panel.x + panel.w && y + size.h <= panel.y + panel.h;
      if (inside && !taken.some((t) => overlaps(t, box))) return box;
    }
  }
  return undefined;
}

/**
 * Draws all six views and iso with a number on each face. A face is always tagged in the view that shows
 * it best, moved aside with a leader line if tags crowd it. It is also tagged in other views that
 * have room, so the same number links the views together.
 */
export async function renderLabeled(k: OcctKernel, shape: ShapeHandle, out: BuildOutput, part?: string): Promise<LabeledRender> {
  const { parts, meshes, faceBase } = faceBases(out, part);
  const VIEWS = LABELED.views;
  const { img, layout, ids } = draw(k, shape, meshes, faceBase, LABELED);
  const spots = layout.panels.map(({ t }, v) => openSpots(ids[v]!, t.panelW, t.panelH));

  const labels: FaceLabel[] = [];
  const unseen: LabeledRender["unseen"] = [];
  type Tag = { label: FaceLabel; view: number; spot: Spot };
  const best: Tag[] = [], extra: Tag[] = [];
  for (const p of parts) {
    p.faces.forEach((f, i) => {
      const id = faceBase.get(p.path)! + i;
      const seen = VIEWS.flatMap((_, view) => {
        const spot = spots[view]!.get(id);
        return spot ? [{ view, spot }] : [];
      });
      if (seen.length === 0) {
        unseen.push({ part: p.path, face: f.id });
        return;
      }
      const label: FaceLabel = { n: labels.length + 1, part: p.path, face: f.id, views: [] };
      labels.push(label);
      const top = seen.reduce((a, b) => (b.spot.clearance > a.spot.clearance ? b : a));
      for (const s of seen) {
        if (s === top) best.push({ label, ...s });
        else if (s.spot.clearance >= TAG_H / 2) extra.push({ label, ...s });
      }
    });
  }

  // Cramped faces choose first, since a roomy face's tag can sit almost anywhere on it.
  best.sort((a, b) => a.spot.clearance - b.spot.clearance || a.label.n - b.label.n);
  extra.sort((a, b) => b.spot.clearance - a.spot.clearance || a.label.n - b.label.n);
  const taken: Box[][] = VIEWS.map(() => []);
  const placed: Array<{ tag: Tag; box: Box }> = [];
  const panelBox = (view: number): Box => {
    const { px, py, t } = layout.panels[view]!;
    return { x: px, y: py, w: t.panelW, h: t.panelH };
  };
  const at = ({ view, spot }: Tag) => ({ cx: panelBox(view).x + spot.x, cy: panelBox(view).y + spot.y });
  for (const tag of best) {
    const { cx, cy } = at(tag);
    const box = freeSpot(tagSize(tag.label.n), cx, cy, panelBox(tag.view), taken[tag.view]!);
    if (!box) throw new Error(`render: no room for tag ${tag.label.n}; render one part with --part`);
    taken[tag.view]!.push(box);
    placed.push({ tag, box });
  }
  for (const tag of extra) {
    const { cx, cy } = at(tag);
    const size = tagSize(tag.label.n);
    const box = { x: Math.round(cx - size.w / 2), y: Math.round(cy - size.h / 2), ...size };
    if (taken[tag.view]!.some((t) => overlaps(t, box))) continue;
    taken[tag.view]!.push(box);
    placed.push({ tag, box });
  }
  for (const { tag, box } of placed) {
    const { cx, cy } = at(tag);
    const center = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    if (Math.hypot(center.x - cx, center.y - cy) > TAG_H) {
      line(img, cx, cy, center.x, center.y, TAG_INK);
      fill(img, cx - 1, cy - 1, cx + 2, cy + 2, TAG_INK);
    }
  }
  for (const { tag, box } of placed) drawTag(img, tag.label.n, box);
  for (const label of labels) {
    label.views = VIEWS.filter((_, view) => placed.some((p) => p.tag.label === label && p.tag.view === view));
  }
  return { png: encodePng(img.w, img.h, img.px), labels, unseen };
}
