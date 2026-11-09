// Numbered face tags over the kernel's multi-view drawing, so an agent can name what it sees.
import { crc32, deflateSync, inflateSync } from "node:zlib";
import type { OcctKernel, ShapeHandle } from "occt-wasm";
import type * as ViewsModule from "../node_modules/occt-wasm/dist/views.js";
import type * as FontModule from "../node_modules/occt-wasm/dist/font5x7.js";
import type { BuildOutput } from "./eval.ts";

// The package does not export its layout or font. Using them keeps tags aligned with the
// drawing by construction, and the kernel version is pinned exactly.
const inKernel = (file: string) => new URL(file, import.meta.resolve("occt-wasm")).href;
const views: typeof ViewsModule = await import(inKernel("./views.js"));
const { FONT_5X7, GLYPH_H, GLYPH_W }: typeof FontModule = await import(inKernel("./font5x7.js"));

type ViewName = ViewsModule.ViewName;
// Every side, so only faces enclosed by the model go unseen.
const VIEWS: ViewName[] = ["front", "back", "left", "right", "top", "bottom", "iso"];
const OPTIONS = { views: VIEWS, columns: 4, width: 360, height: 360 };
const SCALE = 2; // pixels per font pixel
const TAG_H = GLYPH_H * SCALE + 4;
const TAG_INK: Rgb = [20, 70, 200];

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

/** Which face owns each panel pixel, nearest the camera. -1 where there is none. */
function faceBuffer(
  meshes: BuildOutput["meshes"],
  faceBase: Map<string, number>,
  basis: ViewsModule.ViewBasis,
  t: ViewsModule.PanelTransform,
) {
  const w = t.panelW, h = t.panelH;
  const ids = new Int32Array(w * h).fill(-1);
  const depth = new Float64Array(w * h).fill(Infinity);
  const along = (p: Float32Array, i: number, a: { x: number; y: number; z: number }) =>
    p[3 * i]! * a.x + p[3 * i + 1]! * a.y + p[3 * i + 2]! * a.z;
  for (const m of meshes) {
    const base = faceBase.get(m.path)!;
    const sx: number[] = [], sy: number[] = [], sz: number[] = [];
    for (let i = 0; i < m.positions.length / 3; i++) {
      sx.push(along(m.positions, i, basis.sx) * t.scale + t.offsetX);
      sy.push(-along(m.positions, i, basis.sy) * t.scale + t.offsetY);
      sz.push(along(m.positions, i, basis.dir));
    }
    for (let g = 0; g < m.faceGroups.length; g += 3) {
      const first = m.faceGroups[g]!, count = m.faceGroups[g + 1]!, face = base + m.faceGroups[g + 2]!;
      for (let tri = first; tri < first + count; tri++) {
        const a = m.indices[3 * tri]!, b = m.indices[3 * tri + 1]!, c = m.indices[3 * tri + 2]!;
        const area = (sx[b]! - sx[a]!) * (sy[c]! - sy[a]!) - (sy[b]! - sy[a]!) * (sx[c]! - sx[a]!);
        if (Math.abs(area) < 1e-9) continue;
        const x0 = Math.max(0, Math.floor(Math.min(sx[a]!, sx[b]!, sx[c]!)));
        const x1 = Math.min(w - 1, Math.ceil(Math.max(sx[a]!, sx[b]!, sx[c]!)));
        const y0 = Math.max(0, Math.floor(Math.min(sy[a]!, sy[b]!, sy[c]!)));
        const y1 = Math.min(h - 1, Math.ceil(Math.max(sy[a]!, sy[b]!, sy[c]!)));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const px = x + 0.5, py = y + 0.5;
            const u = ((sx[b]! - px) * (sy[c]! - py) - (sy[b]! - py) * (sx[c]! - px)) / area;
            const v = ((sx[c]! - px) * (sy[a]! - py) - (sy[c]! - py) * (sx[a]! - px)) / area;
            const r = 1 - u - v;
            if (u < 0 || v < 0 || r < 0) continue;
            const z = u * sz[a]! + v * sz[b]! + r * sz[c]!;
            const i = y * w + x;
            if (z < depth[i]!) {
              depth[i] = z;
              ids[i] = face;
            }
          }
        }
      }
    }
  }
  return ids;
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

function decodePng(png: Uint8Array) {
  const data = Buffer.from(png);
  const idat: Buffer[] = [];
  let w = 0, h = 0;
  for (let at = 8; at < data.length; ) {
    const size = data.readUInt32BE(at), type = data.toString("latin1", at + 4, at + 8);
    if (type === "IHDR") {
      w = data.readUInt32BE(at + 8);
      h = data.readUInt32BE(at + 12);
      if (data[at + 16] !== 8 || data[at + 17] !== 2) throw new Error("render: expected an 8-bit RGB drawing");
    }
    if (type === "IDAT") idat.push(data.subarray(at + 8, at + 8 + size));
    at += 12 + size;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = 3 * w;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * (stride + 1);
    if (raw[row] !== 0) throw new Error("render: expected unfiltered rows");
    px.set(raw.subarray(row + 1, row + 1 + stride), y * stride);
  }
  return { w, h, px };
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

type Img = { w: number; h: number; px: Uint8Array };
type Box = { x: number; y: number; w: number; h: number };

const tagSize = (n: number) => ({ w: String(n).length * (GLYPH_W + 1) * SCALE + 2, h: TAG_H });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w + 1 && b.x < a.x + a.w + 1 && a.y < b.y + b.h + 1 && b.y < a.y + a.h + 1;
function fill(img: Img, x0: number, y0: number, x1: number, y1: number, c: Rgb) {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) img.px.set(c, 3 * (y * img.w + x));
  }
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

function drawLeader(img: Img, x0: number, y0: number, box: Box) {
  const x1 = box.x + box.w / 2, y1 = box.y + box.h / 2;
  const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps), y = Math.round(y0 + ((y1 - y0) * i) / steps);
    fill(img, x, y, x + 1, y + 1, TAG_INK);
  }
  fill(img, x0 - 1, y0 - 1, x0 + 2, y0 + 2, TAG_INK);
}

function drawTag(img: Img, n: number, box: Box) {
  fill(img, box.x, box.y, box.x + box.w, box.y + box.h, TAG_INK);
  fill(img, box.x + 1, box.y + 1, box.x + box.w - 1, box.y + box.h - 1, [255, 255, 255]);
  [...String(n)].forEach((ch, i) => {
    FONT_5X7[ch]!.forEach((bits, row) => {
      for (let col = 0; col < GLYPH_W; col++) {
        if (!(bits & (1 << (GLYPH_W - 1 - col)))) continue;
        const x = box.x + 2 + i * (GLYPH_W + 1) * SCALE + col * SCALE, y = box.y + 2 + row * SCALE;
        fill(img, x, y, x + SCALE, y + SCALE, TAG_INK);
      }
    });
  });
}

/**
 * Draws a multi-view PNG with a number on each face. A face is always tagged in the view that shows
 * it best, moved aside with a leader line if tags crowd it. It is also tagged in other views that
 * have room, so the same number links the views together.
 */
export async function renderLabeled(k: OcctKernel, shape: ShapeHandle, out: BuildOutput, part?: string): Promise<LabeledRender> {
  const parts = out.model.parts.filter((p) => !part || p.path === part);
  const meshes = out.meshes.filter((m) => !part || m.path === part);
  const faceBase = new Map<string, number>();
  let total = 0;
  for (const p of parts) {
    faceBase.set(p.path, total);
    total += p.faces.length;
  }

  const deflection = views.deflectionFor(k, shape, OPTIONS);
  const bases = VIEWS.map(views.basisFor);
  const extents = bases.map((b) => views.extentOf([views.collectEdges(k, shape, b, deflection)]));
  const layout = views.gridLayout(extents, views.resolved(OPTIONS), OPTIONS.columns, true);
  const spots = layout.panels.map(({ t }, v) => openSpots(faceBuffer(meshes, faceBase, bases[v]!, t), t.panelW, t.panelH));

  const labels: FaceLabel[] = [];
  const unseen: LabeledRender["unseen"] = [];
  const img = decodePng(await k.toMultiviewPNG(shape, OPTIONS));
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
    if (Math.hypot(center.x - cx, center.y - cy) > TAG_H) drawLeader(img, cx, cy, box);
  }
  for (const { tag, box } of placed) drawTag(img, tag.label.n, box);
  for (const label of labels) {
    label.views = VIEWS.filter((_, view) => placed.some((p) => p.tag.label === label && p.tag.view === view));
  }
  return { png: encodePng(img.w, img.h, img.px), labels, unseen };
}
