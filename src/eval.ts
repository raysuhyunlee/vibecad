// Evaluates the feature graph on OCCT and tracks every face back to its source.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { BooleanOp, OcctKernel, type ShapeHandle } from "occt-wasm";
import {
  EdgeSel, Instance, Solid,
  type MateDef, type PortDef, type PortRef, type Profile, type Query, type Src, type Vec3,
} from "./lang.ts";

const HASH_BOUND = 2147483647;
const DEG = Math.PI / 180;
const vec = (v: readonly number[]) => ({ x: v[0]!, y: v[1]!, z: v[2]! });
const tuple = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];

export class CadError extends Error {
  readonly code: string;
  readonly src: Src | undefined;
  readonly hint: string | undefined;
  constructor(code: string, message: string, src?: Src, hint?: string) {
    super(message);
    this.code = code;
    this.src = src;
    this.hint = hint;
  }
  toJSON() {
    return { code: this.code, message: this.message, src: this.src, hint: this.hint };
  }
}

export interface FaceInfo {
  /** Unique within the part: "<name>" or "<name>~2" when a face was split. */
  id: string;
  /** Semantic name, e.g. "mount[2].side". */
  name: string;
  /** Source line of the feature that created the face. */
  src: Src;
  surface: string;
  area: number;
  center: Vec3;
}
export interface StepInfo {
  id: number;
  op: string;
  name: string;
  src: Src;
  inputs: number[];
  volume: number;
  faces: number;
}
export interface Bbox {
  min: Vec3;
  max: Vec3;
  size: Vec3;
}
export interface PartResult {
  path: string;
  type: string;
  params: unknown;
  src: Src;
  volume: number;
  bbox: Bbox;
  faces: FaceInfo[];
  steps: StepInfo[];
}
export interface CheckResult {
  name: string;
  pass: boolean;
  src: Src;
}
export interface MeshData {
  path: string;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
  /** [triangleStart, triangleCount, faceIndex] triples. */
  faceGroups: number[];
}
export interface Model {
  type: string;
  parts: PartResult[];
  checks: CheckResult[];
  hash: string;
}
export interface BuildOutput {
  model: Model;
  meshes: MeshData[];
  /** Placed solids by instance path, for export, render and query. */
  shapes: Map<string, ShapeHandle>;
  stepMeshes: Map<number, MeshData>;
}

interface Tag {
  name: string;
  src: Src;
}
interface Evaluated {
  shape: ShapeHandle;
  tags: Map<number, Tag>;
}

let kernelPromise: Promise<OcctKernel> | undefined;
export function getKernel() {
  return (kernelPromise ??= OcctKernel.init());
}

// --- Graph evaluation -------------------------------------------------------

class Evaluator {
  readonly k: OcctKernel;
  readonly memo = new Map<Solid, Evaluated>();
  constructor(k: OcctKernel) {
    this.k = k;
  }

  faces(s: ShapeHandle) {
    return this.k.getSubShapes(s, "face");
  }
  hash(s: ShapeHandle) {
    return this.k.hashCode(s, HASH_BOUND);
  }

  eval(n: Solid): Evaluated {
    const hit = this.memo.get(n);
    if (hit) return hit;
    const inputs = n.inputs.map((i) => this.eval(i));
    let r: Evaluated;
    try {
      r = this.apply(n, inputs);
    } catch (e) {
      if (e instanceof CadError) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      throw new CadError("OP_FAILED", `${n.op} "${n.name}" failed: ${msg}`, n.src, hintFor(n));
    }
    this.memo.set(n, r);
    return r;
  }

  /** Carries input tags across an operation using OCCT's history. New faces get this op's tag. */
  track(
    n: Solid,
    result: ShapeHandle,
    ev: { modified: number[]; generated: number[] } | null,
    inputs: Evaluated[],
  ): Evaluated {
    const present = new Set(this.faces(result).map((f) => this.hash(f)));
    const tags = new Map<number, Tag>();
    const all = new Map<number, Tag>();
    for (const i of inputs) for (const [h, t] of i.tags) if (!all.has(h)) all.set(h, t);
    for (const [h, t] of all) if (present.has(h)) tags.set(h, t);
    for (const list of ev ? [ev.modified, ev.generated] : []) {
      for (let i = 0; i < list.length; ) {
        const from = list[i]!, count = list[i + 1]!;
        const t = all.get(from);
        for (let j = 0; j < count; j++) {
          const to = list[i + 2 + j]!;
          if (t && present.has(to) && !tags.has(to)) tags.set(to, t);
        }
        i += 2 + count;
      }
    }
    for (const h of present) if (!tags.has(h)) tags.set(h, { name: n.name, src: n.src });
    return { shape: result, tags };
  }

  /** Tags for a fresh primitive: "<name>.<face>". */
  primitive(n: Solid, shape: ShapeHandle): Evaluated {
    const k = this.k;
    const tags = new Map<number, Tag>();
    const com = tuple(k.getCenterOfMass(shape));
    const fs = this.faces(shape);
    let sides = 0;
    const multiSide = n.op === "extrude" || n.op === "revolve";
    const sideCount = fs.filter((f) => !this.isCap(n, f)).length;
    for (const f of fs) {
      const c = tuple(k.getSurfaceCenterOfMass(f));
      let face: string;
      if (n.op === "box") {
        const d = [c[0] - com[0], c[1] - com[1], c[2] - com[2]];
        const axis = d.map(Math.abs).indexOf(Math.max(...d.map(Math.abs)));
        const pos = d[axis]! > 0;
        face = [pos ? "right" : "left", pos ? "back" : "front", pos ? "top" : "bottom"][axis]!;
      } else if (this.isCap(n, f)) {
        face = c[2] > com[2] ? "top" : "bottom";
      } else if (multiSide && sideCount > 1) {
        face = `side[${sides++}]`;
      } else {
        face = "side";
      }
      tags.set(this.hash(f), { name: `${n.name}.${face}`, src: n.src });
    }
    return { shape, tags };
  }

  isCap(n: Solid, f: ShapeHandle) {
    if (n.op === "cylinder" || n.op === "cone") return this.k.surfaceType(f) === "plane";
    if (n.op !== "extrude") return false;
    if (this.k.surfaceType(f) !== "plane") return false;
    const b = this.k.getBoundingBox(f);
    return Math.abs(b.zmax - b.zmin) < 1e-6;
  }

  hashes(inputs: Evaluated[]) {
    return inputs.flatMap((i) => [...i.tags.keys()]);
  }

  singleSolid(n: Solid, e: Evaluated) {
    const solids = this.k.getSubShapes(e.shape, "solid");
    if (solids.length !== 1 || solids[0] === undefined) {
      throw new CadError(
        "NOT_SINGLE_SOLID",
        `${n.op} needs one solid but its input has ${solids.length}`,
        n.src,
        "A previous boolean split or emptied the body. Check that the tools overlap as intended.",
      );
    }
    return solids[0];
  }

  apply(n: Solid, inputs: Evaluated[]): Evaluated {
    const k = this.k, a = n.args as any;
    const first = inputs[0]!;
    switch (n.op) {
      case "box":
        return this.primitive(
          n, k.translate(k.makeBox(a.width, a.depth, a.height), -a.width / 2, -a.depth / 2, 0),
        );
      case "cylinder":
        return this.primitive(n, k.makeCylinder(a.radius, a.height));
      case "cone":
        return this.primitive(n, k.makeCone(a.r1, a.r2, a.height));
      case "sphere":
        return this.primitive(n, k.makeSphere(a.radius));
      case "extrude":
        return this.primitive(n, k.extrude(this.face(a.profile), 0, 0, a.height));
      case "revolve":
        return this.primitive(
          n,
          k.revolve(this.face(a.profile), { point: vec([0, 0, 0]), direction: vec(a.axis) }, a.degrees * DEG),
        );
      case "importStep": {
        if (!existsSync(a.path)) {
          throw new CadError("STEP_NOT_FOUND", `No STEP file at ${a.path}`, n.src, "The path is relative to the source file that calls importStep.");
        }
        const shape = k.importStep(readFileSync(a.path, "utf8"));
        const faces = this.faces(shape);
        if (faces.length === 0) {
          throw new CadError("EMPTY_RESULT", `${a.path} has no faces`, n.src, hintFor(n));
        }
        const tags = new Map(faces.map((f, i): [number, Tag] => [this.hash(f), { name: `${n.name}.face[${i}]`, src: n.src }]));
        return { shape, tags };
      }
      case "cut":
      case "union":
      case "intersect": {
        const op = { cut: BooleanOp.Cut, union: BooleanOp.Fuse, intersect: BooleanOp.Common }[n.op];
        const ev = k.booleanOp(op, [first.shape], inputs.slice(1).map((i) => i.shape), {
          inputFaceHashes: this.hashes(inputs),
          hashUpperBound: HASH_BOUND,
        });
        if (this.faces(ev.result).length === 0) {
          throw new CadError("EMPTY_RESULT", `${n.op} produced no geometry`, n.src, hintFor(n));
        }
        return this.track(n, ev.result, ev, inputs);
      }
      case "fillet":
      case "chamfer": {
        const solid = this.singleSolid(n, first);
        const es = this.selectEdges(n, solid, first, a.sel);
        const ev = n.op === "fillet"
          ? k.filletWithHistory(solid, es, a.radius, this.hashes(inputs), HASH_BOUND)
          : k.chamferWithHistory(solid, es, a.distance, this.hashes(inputs), HASH_BOUND);
        return this.track(n, ev.result, ev, inputs);
      }
      case "shell": {
        const solid = this.singleSolid(n, first);
        const open = this.selectFaces(n, solid, first, a.openFaces);
        const ev = k.shellWithHistory(solid, open, a.thickness, 1e-3, this.hashes(inputs), HASH_BOUND);
        return this.track(n, ev.result, ev, inputs);
      }
      case "translate": {
        const ev = k.translateWithHistory(first.shape, a.x, a.y, a.z, this.hashes(inputs), HASH_BOUND);
        return this.track(n, ev.result, ev, inputs);
      }
      case "rotate": {
        const ev = k.rotateWithHistory(
          first.shape, { point: vec(a.origin), direction: vec(a.axis) }, a.degrees * DEG, this.hashes(inputs), HASH_BOUND,
        );
        return this.track(n, ev.result, ev, inputs);
      }
      case "mirror": {
        const ev = k.mirrorWithHistory(first.shape, vec(a.point), vec(a.normal), this.hashes(inputs), HASH_BOUND);
        return this.track(n, ev.result, ev, inputs);
      }
    }
  }

  face(p: Profile) {
    const k = this.k;
    const edges = p.segments.map((s) => {
      if (s.t === "line") return k.makeLineEdge(vec([...s.a, 0]), vec([...s.b, 0]));
      if (s.t === "circle") return k.makeCircleEdge(vec([...s.c, 0]), vec([0, 0, 1]), s.r);
      return k.makeCircleArc(vec([...s.c, 0]), vec([0, 0, 1]), s.r, s.a0, s.a1);
    });
    return k.makeFace(k.makeWire(edges));
  }

  selectFaces(n: Solid, shape: ShapeHandle, e: Evaluated, names: string[]) {
    const fs = this.faces(shape);
    const out = fs.filter((f) => {
      const t = e.tags.get(this.hash(f));
      return t && names.some((name) => matches(t.name, name));
    });
    if (out.length === 0) throw this.noMatch(n, `faces ${names.join(", ")}`, e);
    return out;
  }

  selectEdges(n: Solid, solid: ShapeHandle, e: Evaluated, sel: EdgeSel) {
    const k = this.k;
    const edgeFaces = new Map<number, string[]>();
    for (const f of this.faces(solid)) {
      const name = e.tags.get(this.hash(f))?.name ?? "";
      for (const edge of k.getSubShapes(f, "edge")) {
        const h = this.hash(edge);
        edgeFaces.set(h, [...(edgeFaces.get(h) ?? []), name]);
      }
    }
    const seen = new Set<number>();
    const out = k.getSubShapes(solid, "edge").filter((edge) => {
      const h = this.hash(edge);
      if (seen.has(h)) return false;
      seen.add(h);
      const names = edgeFaces.get(h) ?? [];
      return sel.filters.every((f) => {
        if (f.kind === "of") return names.some((name) => matches(name, f.face));
        if (f.kind === "curve") return k.curveType(edge) === f.curve;
        if (k.curveType(edge) !== "line") return false;
        const [v0, v1] = k.getSubShapes(edge, "vertex");
        if (v0 === undefined || v1 === undefined) return false;
        const p0 = tuple(k.vertexPosition(v0)), p1 = tuple(k.vertexPosition(v1));
        const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
        const len = Math.hypot(...d);
        return Math.abs(d["xyz".indexOf(f.axis)]!) / len > 1 - 1e-6;
      });
    });
    if (out.length === 0) throw this.noMatch(n, "edges", e);
    return out;
  }

  noMatch(n: Solid, what: string, e: Evaluated) {
    const names = [...new Set([...e.tags.values()].map((t) => t.name))].sort();
    return new CadError(
      "EMPTY_SELECTION",
      `${n.op} selected no ${what}`,
      n.src,
      `Available faces: ${names.join(", ")}`,
    );
  }
}

/** "mount" matches "mount[2].side"; "mount[2]" and "mount[2].side" match themselves. */
function matches(faceName: string, sel: string) {
  return faceName === sel || faceName.startsWith(sel + ".") || faceName.startsWith(sel + "[");
}

function hintFor(n: Solid) {
  if (n.op === "fillet" || n.op === "chamfer") {
    return "The radius may be too large for the adjacent faces, or the selection ends mid-edge.";
  }
  if (n.op === "cut" || n.op === "intersect") return "The tools may not overlap the body.";
  if (n.op === "importStep") return "Check that the file is a valid STEP file with solid geometry.";
  return undefined;
}

// --- Assembly solving -------------------------------------------------------

type Mat = number[]; // 3x4 row-major
const IDENTITY: Mat = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function mul(a: Mat, b: Mat): Mat {
  const o: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      let v = c === 3 ? a[r * 4 + 3]! : 0;
      for (let i = 0; i < 3; i++) v += a[r * 4 + i]! * b[i * 4 + c]!;
      o.push(v);
    }
  }
  return o;
}
function invert(m: Mat): Mat {
  const [a, b, c, x, d, e, f, y, g, h, i, z] = m as [number, number, number, number, number, number, number, number, number, number, number, number];
  return [a, d, g, -(a * x + d * y + g * z), b, e, h, -(b * x + e * y + h * z), c, f, i, -(c * x + f * y + i * z)];
}
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
function frame(o: Vec3, zIn: Vec3, xIn?: Vec3): Mat {
  const z = norm(zIn);
  const hint: Vec3 = xIn ?? (Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]);
  const y = norm(cross(z, hint));
  const x = cross(y, z);
  return [x[0], y[0], z[0], o[0], x[1], y[1], z[1], o[1], x[2], y[2], z[2], o[2]];
}

function isRef(p: PortDef | PortRef): p is PortRef {
  return "owner" in p;
}

/** Resolves an exposed port down to its part and local frame. */
function resolvePort(ref: PortRef): { leaf: Instance; def: PortDef } {
  const p = ref.owner.ports[ref.name]!;
  return isRef(p) ? resolvePort(p) : { leaf: ref.owner, def: p };
}

/** Transforms of every descendant, in the instance's own coordinates. */
function solve(inst: Instance): Map<Instance, Mat> {
  const out = new Map<Instance, Mat>([[inst, IDENTITY]]);
  const kids = Object.entries(inst.children);
  if (kids.length === 0) return out;

  const inner = new Map(kids.map(([, c]) => [c, solve(c)]));
  const childOf = (leaf: Instance) => {
    for (const [c, m] of inner) if (m.has(leaf)) return c;
    return undefined;
  };
  const placed = new Map<Instance, Mat>([[kids[0]![1], IDENTITY]]);
  const pending: MateDef[] = [...inst.mates];

  const portFrame = (r: PortRef) => {
    const { leaf, def } = resolvePort(r);
    const child = childOf(leaf);
    if (!child) return undefined;
    return { child, local: mul(inner.get(child)!.get(leaf)!, frame(def.at, def.z, def.x)) };
  };
  const solveOne = (m: MateDef) => {
    const a = portFrame(m.a), b = portFrame(m.b);
    if (!a || !b) {
      throw new CadError("BAD_MATE", `Mate references a part outside ${inst.typeName}`, m.src);
    }
    const aPlaced = placed.get(a.child), bPlaced = placed.get(b.child);
    if (aPlaced && bPlaced) {
      throw new CadError(
        "OVER_CONSTRAINED",
        `${a.child.typeName} and ${b.child.typeName} are already placed by other mates`,
        m.src,
        "Each child takes one mate in this version. Remove the extra mate.",
      );
    }
    if (!aPlaced && !bPlaced) return false;
    const [fixed, fixedAt, moving, flip] = aPlaced ? [a, aPlaced, b, 1] : [b, bPlaced!, a, -1];
    const world = mul(fixedAt, fixed.local);
    const offset = mul(world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, m.gap]);
    // Facing: rotate 180 degrees about local X, then spin about the mated axis.
    const rad = flip * m.angle * DEG, cs = Math.cos(rad), sn = Math.sin(rad);
    const facing = mul(offset, [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0]);
    const target = mul(facing, [cs, -sn, 0, 0, sn, cs, 0, 0, 0, 0, 1, 0]);
    placed.set(moving.child, mul(target, invert(moving.local)));
    return true;
  };

  for (let progress = true; progress && pending.length > 0; ) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (solveOne(pending[i]!)) {
        pending.splice(i, 1);
        progress = true;
      }
    }
  }
  for (const [name, c] of kids) {
    if (!placed.has(c)) {
      throw new CadError(
        "UNPLACED_PART",
        `"${name}" (${c.typeName}) in ${inst.typeName} is not connected to the first part by mates`,
        c.src,
      );
    }
  }
  for (const [c, at] of placed) {
    for (const [d, m] of inner.get(c)!) out.set(d, mul(at, m));
  }
  return out;
}

// --- Build ------------------------------------------------------------------

function collectLeaves(inst: Instance, path: string, out: Array<[string, Instance]>) {
  if (inst.solid) out.push([path, inst]);
  for (const [name, c] of Object.entries(inst.children)) {
    collectLeaves(c, path ? `${path}/${name}` : name, out);
  }
}
function collectChecks(inst: Instance, out: Array<Parameters<typeof runCheck>[0]>) {
  out.push(...inst.checks);
  for (const c of Object.values(inst.children)) collectChecks(c, out);
}
function runCheck(
  c: { name: string; fn: (q: Query) => boolean; src: Src },
  q: Query,
): CheckResult {
  return { name: c.name, pass: c.fn(q), src: c.src };
}

function toMesh(k: OcctKernel, shape: ShapeHandle, path: string, indexOf: (hash: number) => number): MeshData {
  const m = k.meshShape(shape, { linearDeflection: 0.05, angularDeflection: 0.3 });
  const groups: number[] = [];
  const g = m.faceGroups ?? new Int32Array();
  for (let i = 0; i < g.length; i += 3) groups.push(g[i]! / 3, g[i + 1]! / 3, indexOf(g[i + 2]!)); // kernel counts indices
  return { path, positions: m.positions, normals: m.normals, indices: m.indices, faceGroups: groups };
}

export async function build(root: Instance, opts: { stepMeshes?: boolean } = {}): Promise<BuildOutput> {
  const k = await getKernel();
  const ev = new Evaluator(k);
  const leaves: Array<[string, Instance]> = [];
  collectLeaves(root, "", leaves);
  if (leaves.length === 0) throw new CadError("EMPTY_MODEL", `${root.typeName} has no parts`, root.src);

  const transforms = solve(root);
  const parts: PartResult[] = [];
  const meshes: MeshData[] = [];
  const shapes = new Map<string, ShapeHandle>();
  const byInstance = new Map<Instance, ShapeHandle>();
  const stepMeshes = new Map<number, MeshData>();
  const digest = createHash("sha256");

  for (const [path, inst] of leaves) {
    const solid = inst.solid!;
    const e = ev.eval(solid);
    const mat = transforms.get(inst) ?? IDENTITY;
    const hs = [...e.tags.keys()];
    const placed = k.transformWithHistory(e.shape, mat, hs, HASH_BOUND);
    const tagged = ev.track(solid, placed.result, placed, [e]);

    const seen = new Map<string, number>();
    const faceIndex = new Map<number, number>();
    const faces: FaceInfo[] = ev.faces(tagged.shape).map((f, i) => {
      const h = ev.hash(f);
      faceIndex.set(h, i);
      const t = tagged.tags.get(h)!;
      const n = (seen.get(t.name) ?? 0) + 1;
      seen.set(t.name, n);
      return {
        id: n === 1 ? t.name : `${t.name}~${n}`,
        name: t.name,
        src: t.src,
        surface: k.surfaceType(f),
        area: round(k.getSurfaceArea(f)),
        center: tuple(k.getSurfaceCenterOfMass(f)).map(round) as Vec3,
      };
    });

    const steps: StepInfo[] = [];
    const visit = new Set<Solid>();
    const walk = (n: Solid) => {
      if (visit.has(n)) return;
      visit.add(n);
      n.inputs.forEach(walk);
      const r = ev.eval(n);
      steps.push({
        id: n.id, op: n.op, name: n.name, src: n.src,
        inputs: n.inputs.map((i) => i.id),
        volume: round(k.getVolume(r.shape)),
        faces: r.tags.size,
      });
      if (opts.stepMeshes) {
        const placedStep = k.transform(r.shape, mat);
        stepMeshes.set(n.id, toMesh(k, placedStep, path, () => -1));
      }
    };
    walk(solid);

    const mesh = toMesh(k, tagged.shape, path, (h) => faceIndex.get(h) ?? -1);
    meshes.push(mesh);
    digest.update(path);
    digest.update(faces.map((f) => f.id).join("\n"));
    digest.update(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
    shapes.set(path, tagged.shape);
    byInstance.set(inst, tagged.shape);
    parts.push({
      path, type: inst.typeName, params: inst.params, src: inst.src,
      volume: round(k.getVolume(tagged.shape)),
      bbox: bboxOf(k, tagged.shape),
      faces, steps,
    });
  }

  const shapeOf = (i: Instance) => {
    const s = byInstance.get(i);
    if (s === undefined) throw new Error(`${i.typeName} is not a part of this build`);
    return s;
  };
  const q: Query = {
    distance: (a, b) => round(k.distanceBetween(shapeOf(a), shapeOf(b))),
    volume: (a) => round(k.getVolume(shapeOf(a))),
    overlap: (a, b) => {
      const r = k.booleanOp(BooleanOp.Common, [shapeOf(a)], [shapeOf(b)]);
      return k.getSubShapes(r.result, "solid").length ? round(k.getVolume(r.result)) : 0;
    },
    bbox: (a) => bboxOf(k, shapeOf(a)),
  };
  const checkDefs: Array<Parameters<typeof runCheck>[0]> = [];
  collectChecks(root, checkDefs);
  const checks = checkDefs.map((c) => runCheck(c, q));

  return {
    model: { type: root.typeName, parts, checks, hash: digest.digest("hex").slice(0, 16) },
    meshes, shapes, stepMeshes,
  };
}

function round(v: number) {
  return Math.round(v * 1e6) / 1e6;
}
function bboxOf(k: OcctKernel, s: ShapeHandle): Bbox {
  const b = k.getBoundingBox(s);
  const min: Vec3 = [round(b.xmin), round(b.ymin), round(b.zmin)];
  const max: Vec3 = [round(b.xmax), round(b.ymax), round(b.zmax)];
  return { min, max, size: [round(max[0] - min[0]), round(max[1] - min[1]), round(max[2] - min[2])] };
}
