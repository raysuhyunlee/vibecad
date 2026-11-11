// Evaluates the feature graph on OCCT and tracks every face back to its source.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { BooleanOp, JoinType, OcctKernel, SweepMode, TransitionMode, type EvolutionData, type ShapeHandle } from "occt-wasm";
import {
  EdgeSel, Instance, isWorld, originOf, Solid, world,
  type CheckDef, type FaceRef, type Helix, type JointDef, type MateDef, type Plane, type PortDef, type PortRef, type Profile, type Query, type Spine, type Src, type Vec3,
} from "./lang.ts";

const HASH_BOUND = 2147483647;
const DEG = Math.PI / 180;
const vec = (v: readonly number[]) => ({ x: v[0]!, y: v[1]!, z: v[2]! });
const tuple = (v: { x: number; y: number; z: number }): Vec3 => [v.x, v.y, v.z];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

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
  /** The first sampled joint value where a sweep failed. */
  failedAt?: { joint: string; value: number };
}
/** A joint at this build's pose. From it, moving to another value needs no kernel:
 * a revolute turns `moves` about `axis` through `origin`, a slider translates them along `axis`. */
export interface JointResult {
  path: string;
  kind: JointDef["kind"];
  value: number;
  min: number;
  max: number;
  origin: Vec3;
  axis: Vec3;
  /** Part paths this joint carries, including parts further down the chain. */
  moves: string[];
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
/** A sub-assembly placed in the entry, at any depth; its parts' paths start with `path/`. */
export interface PlaceResult {
  path: string;
  type: string;
  src: Src;
}
export interface Model {
  type: string;
  parts: PartResult[];
  /** Sub-assembly places, parents before children. */
  assemblies: PlaceResult[];
  /** Ordered from the fixed part outward, so a joint comes after those that carry it. */
  joints: JointResult[];
  /** Path of the part fixed to the world by the entry's ground. */
  ground?: string;
  checks: CheckResult[];
  hash: string;
}
export interface BuildOutput {
  model: Model;
  meshes: MeshData[];
  /** Placed solids by instance path, for export, render and query. */
  shapes: Map<string, ShapeHandle>;
  /** Each feature's mesh, by part path and step id. */
  stepMeshes: Map<string, Map<number, MeshData>>;
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
      } else {
        face = "side";
      }
      tags.set(this.hash(f), { name: `${n.name}.${face}`, src: n.src });
    }
    return { shape, tags };
  }

  isCap(n: Solid, f: ShapeHandle) {
    return (n.op === "cylinder" || n.op === "cone") && this.k.surfaceType(f) === "plane";
  }

  /** Tags a swept profile through kernel history: each wall comes from one segment, so it takes that segment's name. */
  swept(n: Solid, p: Profile, caps: [string, string], sweep: (face: ShapeHandle) => EvolutionData): Evaluated {
    const k = this.k;
    const sources = this.segmentEdges(p);
    const face = this.face(n, p, sources);
    return this.tagWalls(n, p, caps, sweep(face), k.getSubShapes(face, "edge"), sources);
  }

  /** Names caps and walls from history. A wall the kernel does not trace to a segment is "side". */
  tagWalls(n: Solid, p: Profile, caps: [string, string], ev: EvolutionData, edges: ShapeHandle[], sources: ShapeHandle[]): Evaluated {
    const tags = new Map<number, Tag>();
    const tag = (h: number, name: string) => tags.set(h, { name: `${n.name}.${name}`, src: n.src });
    for (const h of ev.firstShape) tag(h, caps[0]);
    for (const h of ev.lastShape) tag(h, caps[1]);
    const segOf = new Map(edges.map((e) => [this.hash(e), this.segmentOf(e, sources)]));
    for (let i = 0; i < ev.edgeGenerated.length; ) {
      const seg = segOf.get(ev.edgeGenerated[i]!);
      const count = ev.edgeGenerated[i + 1]!;
      if (seg !== undefined) {
        const name = p.segments[seg]!.name ?? (p.segments.length > 1 ? `side[${seg}]` : "side");
        for (let j = 0; j < count; j++) tag(ev.edgeGenerated[i + 2 + j]!, name);
      }
      i += 2 + count;
    }
    for (const f of this.faces(ev.result)) if (!tags.has(this.hash(f))) tag(this.hash(f), "side");
    return { shape: ev.result, tags };
  }

  /** A sweep or loft can return a shape that looks right but is not a solid. */
  sound(n: Solid, shape: ShapeHandle, hint: string) {
    if (!this.k.isValid(shape) || this.k.getSubShapes(shape, "solid").length !== 1) {
      throw new CadError("BAD_SHAPE", `${n.op} "${n.name}" did not make one valid solid`, n.src, hint);
    }
  }

  /** Resolves a sketch on a named face to numbers, from the solid as it stands at that feature. */
  sketchPlane(n: Solid, on: Plane | FaceRef | undefined): Plane | undefined {
    if (!on || !("face" in on)) return on;
    const k = this.k;
    const e = this.eval(on.solid);
    const seen = new Map<string, number>();
    const listed = this.faces(e.shape).flatMap((f) => {
      const name = e.tags.get(this.hash(f))?.name;
      if (name === undefined) return [];
      const count = (seen.get(name) ?? 0) + 1;
      seen.set(name, count);
      return [{ f, name, id: count === 1 ? name : `${name}~${count}` }];
    });
    const found = listed.filter((x) => x.id === on.face || x.name === on.face);
    if (found.length === 0) throw this.noMatch(n, `face ${on.face}`, e);
    if (found.length > 1) {
      throw new CadError(
        "AMBIGUOUS_FACE", `${on.face} was split into ${found.length} faces`, n.src,
        `Pick one: ${found.map((x) => x.id).join(", ")}`,
      );
    }
    const f = found[0]!.f;
    if (k.surfaceType(f) !== "plane") {
      throw new CadError("FACE_NOT_FLAT", `${on.face} is a ${k.surfaceType(f)} face, so it cannot hold a sketch`, n.src, "Pick a flat face, or use plane() with numbers.");
    }
    const z = this.normalAt(f, tuple(k.getSurfaceCenterOfMass(f)));
    if (on.x && Math.hypot(...cross(z, on.x)) < 1e-9) {
      throw new CadError("BAD_PLANE", `x [${on.x}] is parallel to the normal of ${on.face}`, n.src, "Choose an x that lies along the face.");
    }
    // The outline's center, so a hole cut in the face does not move the sketch.
    const center = tuple(k.getSurfaceCenterOfMass(k.makeFace(k.outerWire(f))));
    const m = frame(center, z, on.x);
    const [u, v] = on.at ?? [0, 0];
    const at: Vec3 = [m[0]! * u + m[1]! * v + m[3]!, m[4]! * u + m[5]! * v + m[7]!, m[8]! * u + m[9]! * v + m[11]!];
    return { at, z, ...(on.x && { x: on.x }) };
  }

  /** The face's outward normal at the surface point nearest p. */
  normalAt(f: ShapeHandle, p: Vec3): Vec3 {
    const { u, v } = this.k.uvFromPoint(f, vec(p));
    return norm(tuple(this.k.surfaceNormal(f, u, v)));
  }

  spineWire(s: Spine | Helix) {
    const k = this.k;
    if ("radius" in s) {
      return k.makeHelixWireHanded(vec([0, 0, 0]), vec([0, 0, 1]), s.pitch, s.height, s.radius, s.left);
    }
    let at = s.start;
    const made: ShapeHandle[] = [];
    for (const seg of s.segments) {
      const end = seg.t === "spline" ? seg.through.at(-1)! : seg.to;
      if (seg.t === "line") made.push(k.makeLineEdge(vec(at), vec(end)));
      else if (seg.t === "arc") made.push(k.makeArcEdge(vec(at), vec(seg.through), vec(end)));
      else if (seg.t === "spline") made.push(k.interpolatePoints([at, ...seg.through].map(vec), false));
      else {
        const prev = made.at(-1)!;
        made.push(k.makeTangentArc(vec(at), k.curveTangent(prev, k.curveParameters(prev).last), vec(end)));
      }
      at = end;
    }
    return k.makeWire(made);
  }

  /** The profile starts square to the spine's start, then rides along it. */
  sweep(n: Solid, p: Profile, s: Spine | Helix, x: Vec3 | undefined) {
    const k = this.k;
    const spine = this.spineWire(s);
    const first = k.getSubShapes(spine, "edge")[0]!;
    const start = k.curveParameters(first).first;
    const z = norm(tuple(k.curveTangent(first, start)));
    if (x && Math.hypot(...cross(z, x)) < 1e-9) {
      throw new CadError("BAD_PLANE", `x [${x}] is parallel to the start of the spine`, n.src, "Choose an x across the spine.");
    }
    const on: Plane = { at: tuple(k.curvePointAtParam(first, start)), z, ...(x && { x }) };
    // Sweeps happen in the sketch's own frame, so the profile stays on XY and names work as in an extrude.
    const local = k.transform(spine, invert(frame(on.at, on.z, on.x)));
    // A helix has to turn its profile with it. Elsewhere the profile must not twist, and corners are mitered.
    const options = "radius" in s ? { mode: SweepMode.Frenet } : { mode: SweepMode.Fixed, transitionMode: TransitionMode.RightCorner };
    const made = this.swept(n, p, ["start", "end"], (f) => k.sweepWithHistory(k.outerWire(f), local, [], HASH_BOUND, options));
    this.sound(n, made.shape, "The profile may be too big for the spine's bends, or the sweep may run into itself.");
    return this.onPlane(n, made, on);
  }

  loft(n: Solid, sections: Array<{ profile: Profile; on: Plane | FaceRef }>, ruled: boolean) {
    const k = this.k;
    const placed = sections.map(({ profile, on }) => {
      const sources = this.segmentEdges(profile);
      const face = this.face(n, profile, sources);
      const plane = this.sketchPlane(n, on)!;
      const m = frame(plane.at, plane.z, plane.x);
      return { wire: k.transform(k.outerWire(face), m), sources: sources.map((e) => k.transform(e, m)) };
    });
    const ev = k.loftWithHistory(placed.map((s) => s.wire), true, ruled, [], HASH_BOUND);
    this.sound(n, ev.result, "Check that the sections do not cross, and that they run in the same direction around.");
    const head = placed[0]!;
    return this.tagWalls(n, sections[0]!.profile, ["start", "end"], ev, k.getSubShapes(head.wire, "edge"), head.sources);
  }

  /**
   * The profile segment an edge of its face came from: the one nearest a point on the edge.
   * An offset curve is the set of points at its distance from the nearest segment, so this also traces offsets.
   */
  segmentOf(edge: ShapeHandle, sources: ShapeHandle[]) {
    const { points } = this.k.wireframe(edge, 0.05);
    const count = points.length / 3;
    // A line samples only its ends; anything else has a sample on the curve near its middle.
    const at = count < 3
      ? [0, 1, 2].map((i) => (points[i]! + points[3 + i]!) / 2)
      : [0, 1, 2].map((i) => points[3 * (count >> 1) + i]!);
    const probe = this.k.makeVertex(at[0]!, at[1]!, at[2]!);
    let best = 0, bestDistance = Infinity;
    sources.forEach((source, i) => {
      const d = this.k.distanceBetween(source, probe);
      if (d < bestDistance) [best, bestDistance] = [i, d];
    });
    return best;
  }

  /** Moves a swept solid from the XY sketch onto its plane. */
  onPlane(n: Solid, e: Evaluated, on: Plane | undefined): Evaluated {
    if (!on) return e;
    const placed = this.k.transformWithHistory(e.shape, frame(on.at, on.z, on.x), [...e.tags.keys()], HASH_BOUND);
    return this.track(n, placed.result, placed, [e]);
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
        return this.onPlane(n, this.swept(n, a.profile, [a.height > 0 ? "bottom" : "top", a.height > 0 ? "top" : "bottom"], (f) =>
          k.extrudeWithHistory(f, 0, 0, a.height, [], HASH_BOUND)), this.sketchPlane(n, a.on));
      case "revolve":
        return this.onPlane(n, this.swept(n, a.profile, ["start", "end"], (f) =>
          k.revolveWithHistory(f, { point: vec([0, 0, 0]), direction: vec(a.axis) }, a.degrees * DEG, [], HASH_BOUND)), this.sketchPlane(n, a.on));
      case "sweep":
        return this.sweep(n, a.profile, a.spine, a.x);
      case "loft":
        return this.loft(n, a.sections, a.ruled);
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
        if (n.op === "chamfer") {
          const ev = k.chamferWithHistory(solid, es, a.distance, this.hashes(inputs), HASH_BOUND);
          return this.track(n, ev.result, ev, inputs);
        }
        let ev: EvolutionData;
        try {
          ev = k.filletWithHistory(solid, es, a.radius, this.hashes(inputs), HASH_BOUND);
          // On some runouts the kernel returns a broken solid instead of refusing.
          if (!k.isValid(ev.result)) throw new Error("the kernel's fillet is not a valid solid");
        } catch (e) {
          // OCCT cannot run a fillet out over a curved end. See runoutFillet.
          const made = this.runoutFillet(n, solid, es, a.radius, inputs);
          if (!made) throw e;
          return made;
        }
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

  /**
   * Builds the fillets the kernel refuses directly: material added to concave corners, and removed from convex ones.
   * Each tool spans its edge and is clipped to the outlines of both faces, so it ends where they do.
   * Returns undefined when an edge cannot be done exactly, so the caller reports the kernel's error.
   */
  runoutFillet(n: Solid, solid: ShapeHandle, es: ShapeHandle[], r: number, inputs: Evaluated[]): Evaluated | undefined {
    const k = this.k;
    const tools = { fill: [] as ShapeHandle[], remove: [] as ShapeHandle[] };
    for (const edge of es) {
      const tool = this.runoutTool(solid, edge, r);
      if (!tool) return undefined;
      tools[tool.concave ? "fill" : "remove"].push(tool.shape);
    }
    let result: Evaluated = { shape: solid, tags: new Map(inputs.flatMap((i) => [...i.tags])) };
    for (const [op, list] of [[BooleanOp.Fuse, tools.fill], [BooleanOp.Cut, tools.remove]] as const) {
      if (list.length === 0) continue;
      const ev = k.booleanOp(op, [result.shape], list, { inputFaceHashes: this.hashes([result]), hashUpperBound: HASH_BOUND });
      result = this.track(n, ev.result, ev, [result]);
    }
    return k.isValid(result.shape) && k.getSubShapes(result.shape, "solid").length === 1 ? result : undefined;
  }

  /**
   * A section of the fillet swept along one edge. The section is exact only while it keeps its shape, so each face
   * must be flat, or straight across the edge everywhere, as a wall extruded square to the edge's plane is.
   */
  runoutTool(solid: ShapeHandle, edge: ShapeHandle, r: number): { shape: ShapeHandle; concave: boolean } | undefined {
    const k = this.k;
    const eps = 1e-3, onFace = 1e-5;
    const point = (p: Vec3) => k.makeVertex(p[0], p[1], p[2]);
    const h = this.hash(edge);
    const sides = this.faces(solid).filter((f) => k.getSubShapes(f, "edge").some((x) => this.hash(x) === h));
    if (sides.length !== 2) return undefined;
    const { first, last } = k.curveParameters(edge);
    const station = (t: number) => {
      const u = first + (last - first) * t;
      const p = tuple(k.curvePointAtParam(edge, u)), dir = norm(tuple(k.curveTangent(edge, u)));
      return { p, dir, across: sides.map((f) => cross(dir, this.normalAt(f, p))) as [Vec3, Vec3] };
    };
    const inner = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => station(i / 10));
    const mid = inner[4]!;
    // Which way across the edge each face lies. It holds along the edge, and ends can sit on a curved outline.
    const signs = sides.map((f, i) =>
      k.distanceBetween(f, point(add(mid.p, scale(mid.across[i]!, eps)))) < eps / 1000 ? 1 : -1);
    const inward = (s: { across: [Vec3, Vec3] }, i: number) => scale(s.across[i]!, signs[i]!);
    const angleAt = (s: { across: [Vec3, Vec3] }) => Math.acos(Math.min(1, Math.max(-1, dot(inward(s, 0), inward(s, 1)))));
    const between = angleAt(mid);
    if (between < 1e-6 || Math.PI - between < 1e-6) return undefined;
    for (const s of inner) {
      if (Math.abs(angleAt(s) - between) > 1e-6) return undefined;
      for (let i = 0; i < 2; i++) {
        if (k.surfaceType(sides[i]!) === "plane") continue;
        if (Math.hypot(...sub(inward(s, i), inward(mid, i))) > 1e-6) return undefined;
      }
    }
    const reach = r / Math.tan(between / 2);
    // Too big a radius fits nowhere, and a face curved across the edge is off the tangent point everywhere.
    const fits = inner.find((s) => sides.every((f, i) => k.distanceBetween(f, point(add(s.p, scale(inward(s, i), reach)))) < onFace));
    if (!fits) return undefined;
    const bisector = norm(add(inward(fits, 0), inward(fits, 1)));
    // In a concave corner the space between the faces is empty; in a convex one it is the solid.
    const concave = !k.containsPoint(solid, vec(add(fits.p, scale(bisector, eps))));

    const start = station(0);
    const [a, b] = [inward(start, 0), inward(start, 1)] as [Vec3, Vec3];
    const onA = add(start.p, scale(a, reach)), onB = add(start.p, scale(b, reach));
    const arcMid = add(start.p, scale(norm(add(a, b)), r / Math.sin(between / 2) - r));
    const section = k.makeFace(k.makeWire([
      k.makeLineEdge(vec(start.p), vec(onA)),
      k.makeArcEdge(vec(onA), vec(arcMid), vec(onB)),
      k.makeLineEdge(vec(onB), vec(start.p)),
    ]));
    let shape = k.curveType(edge) === "line"
      ? k.extrude(section, ...scale(start.dir, k.curveLength(edge)))
      : k.pipe(section, k.makeWire([edge]));
    sides.forEach((f, i) => {
      const away = inward(fits, 1 - i);
      const normal = this.normalAt(f, fits.p);
      const size = dot(normal, away) > 0 ? reach + r : -(reach + r);
      const footprint = k.surfaceType(f) === "plane" ? k.extrude(f, ...scale(normal, size)) : k.thicken(f, size, 1e-3);
      shape = k.common(shape, footprint);
    });
    return this.faces(shape).length === 0 ? undefined : { shape, concave };
  }

  /** One edge per profile segment, in order. */
  segmentEdges(p: Profile) {
    const k = this.k;
    const on = (q: readonly number[]) => vec([q[0]!, q[1]!, 0]);
    return p.segments.map((s) => {
      if (s.t === "line") return k.makeLineEdge(on(s.a), on(s.b));
      if (s.t === "circle") return k.makeCircleEdge(on(s.c), vec([0, 0, 1]), s.r);
      if (s.t === "spline") return k.interpolatePointsWithTangents(s.through.map(on), on(s.start), on(s.end));
      if (s.t === "closedSpline") return k.interpolatePoints(s.through.map(on), true);
      return k.makeCircleArc(on(s.c), vec([0, 0, 1]), s.r, s.a0, s.a1);
    });
  }

  face(n: Solid, p: Profile, edges: ShapeHandle[]) {
    const k = this.k;
    let wire = k.makeWire(edges);
    for (const distance of p.offsets ?? []) {
      const wires = k.getSubShapes(k.offsetWire2D(wire, distance, JoinType.Intersection), "wire");
      if (wires.length !== 1 || wires[0] === undefined) {
        throw new CadError(
          "BAD_OFFSET",
          `offset by ${distance} leaves ${wires.length} outlines, not 1`,
          n.src,
          "An inward offset can use up or split the outline. Use a smaller distance.",
        );
      }
      wire = wires[0];
    }
    return k.makeFace(wire);
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

/** One place of an instance in the tree. An instance can be placed more than once, so links and checks resolve by place. */
interface Node {
  path: string;
  inst: Instance;
  children: Map<Instance, Node>;
}
const WORLD_NODE: Node = { path: "", inst: world.owner, children: new Map() };

function tree(inst: Instance, path: string): Node {
  const node: Node = { path, inst, children: new Map() };
  for (const [name, c] of Object.entries(inst.children)) {
    if (node.children.has(c)) {
      throw new CadError("PLACED_TWICE", `${c.typeName} is placed twice in ${inst.typeName}`, c.src, "Place it again with place(instance).");
    }
    node.children.set(c, tree(c, path ? `${path}/${name}` : name));
  }
  return node;
}
/** Where `inst` sits within `scope`: the scope itself, one of its children, or else the first match further down. */
function find(scope: Node, inst: Instance): Node | undefined {
  if (scope.inst === inst) return scope;
  const direct = scope.children.get(inst);
  if (direct) return direct;
  for (const c of scope.children.values()) {
    const n = find(c, inst);
    if (n) return n;
  }
  return undefined;
}

/** Resolves an exposed port down to its part and local frame. */
function resolvePort(ref: PortRef, scope: Node, src: Src): { leaf: Node; def: PortDef } {
  if (isWorld(ref.owner)) return { leaf: WORLD_NODE, def: ref.owner.ports[ref.name] as PortDef };
  const owner = find(scope, ref.owner);
  if (!owner) throw new CadError("BAD_MATE", `Mate references a part outside ${scope.inst.typeName}`, src);
  const p = ref.owner.ports[ref.name]!;
  return isRef(p) ? resolvePort(p, owner, src) : { leaf: owner, def: p };
}

type Pose = ReadonlyMap<string, number>; // joint path -> value
const isJoint = (m: MateDef): m is JointDef => "kind" in m;
const jointValue = (j: JointDef) => (j.kind === "revolute" ? j.angle : j.gap);
const childPath = (node: Node, name: string) => (node.path ? `${node.path}/${name}` : name);

/** A mate or joint, with the place it was written in. A joint has its path. */
interface Link {
  m: MateDef;
  scope: Node;
  path?: string;
}
function collectJoints(node: Node, out: Array<[string, JointDef]>) {
  for (const [name, j] of Object.entries(node.inst.joints)) out.push([childPath(node, name), j]);
  for (const c of node.children.values()) collectJoints(c, out);
}
function collectLinks(node: Node, out: Link[]) {
  const links: Link[] = [
    ...node.inst.mates.map((m) => ({ m, scope: node })),
    ...Object.entries(node.inst.joints).map(([name, m]) => ({ m, scope: node, path: childPath(node, name) })),
  ];
  for (const { m } of links) {
    if (resolvePort(m.a, node, m.src).leaf === WORLD_NODE || resolvePort(m.b, node, m.src).leaf === WORLD_NODE) {
      throw new CadError("BAD_MATE", "world can only be mated in an assembly's ground", m.src, "Move this mate to ground: mate(world, port).");
    }
  }
  out.push(...links);
  for (const c of node.children.values()) collectLinks(c, out);
}

/** Places every part as one tree of links, growing outward from the ground, or else the first part. */
function solve(root: Node, leaves: Node[], pose: Pose): { at: Map<Node, Mat>; joints: JointResult[]; ground?: string } {
  const pending: Link[] = [];
  collectLinks(root, pending);

  // The world frame is a part already placed at the origin; without a ground, the first part is.
  const ground = root.inst.ground;
  let fixed = leaves[0]!, grounded: string | undefined;
  if (ground) {
    const ends = [resolvePort(ground.a, root, ground.src).leaf, resolvePort(ground.b, root, ground.src).leaf];
    const own = ends.find((e) => e !== WORLD_NODE);
    grounded = own && leaves.includes(own) ? own.path : undefined;
    if (isJoint(ground) || ends.filter((e) => e === WORLD_NODE).length !== 1 || grounded === undefined) {
      throw new CadError("BAD_MATE", `The ground of ${root.inst.typeName} must be mate(world, port) with a port of its own part`, ground.src);
    }
    fixed = WORLD_NODE;
    pending.push({ m: ground, scope: root });
  }
  const placed = new Map<Node, Mat>([[fixed, IDENTITY]]);
  const parent = new Map<Node, Node>();
  const joints: Array<{ result: JointResult; moving: Node }> = [];

  const place = ({ m, scope, path }: Link) => {
    const a = resolvePort(m.a, scope, m.src), b = resolvePort(m.b, scope, m.src);
    const aAt = placed.get(a.leaf), bAt = placed.get(b.leaf);
    if (aAt && bAt) {
      throw new CadError(
        "OVER_CONSTRAINED",
        `${a.leaf.inst.typeName} and ${b.leaf.inst.typeName} are already placed by other mates or joints`,
        m.src,
        "Links must form a tree in this version, so closed loops are not supported. Remove the extra link.",
      );
    }
    if (!aAt && !bAt) return false;
    const [fixed, fixedAt, moving] = aAt ? [a, aAt, b] : [b, bAt!, a];

    let { gap, angle } = m;
    if (isJoint(m)) {
      const value = pose.get(path!) ?? jointValue(m);
      if (value < m.min - 1e-9 || value > m.max + 1e-9) {
        throw new CadError(
          "JOINT_OUT_OF_RANGE",
          `Joint "${path}" is at ${value}, outside ${m.min} to ${m.max}`,
          m.src,
          "Change the value or widen min and max.",
        );
      }
      if (m.kind === "revolute") angle = value;
      else gap = value;
    }
    const world = mul(fixedAt, frame(fixed.def.at, fixed.def.z, fixed.def.x));
    const offset = mul(world, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, gap]);
    // Facing: rotate 180 degrees about local X, then spin about the mated axis.
    // This relation is symmetric, so it holds whichever side is the moving one.
    const rad = angle * DEG, cs = Math.cos(rad), sn = Math.sin(rad);
    const facing = mul(offset, [1, 0, 0, 0, 0, -1, 0, 0, 0, 0, -1, 0]);
    const target = mul(facing, [cs, -sn, 0, 0, sn, cs, 0, 0, 0, 0, 1, 0]);
    placed.set(moving.leaf, mul(target, invert(frame(moving.def.at, moving.def.z, moving.def.x))));
    parent.set(moving.leaf, fixed.leaf);

    if (isJoint(m)) {
      const axisOf = (f: Mat): Vec3 => [f[2]!, f[6]!, f[10]!].map(round) as Vec3;
      joints.push({
        moving: moving.leaf,
        result: {
          path: path!, kind: m.kind, value: m.kind === "revolute" ? angle : gap,
          min: m.min, max: m.max,
          origin: [target[3]!, target[7]!, target[11]!].map(round) as Vec3,
          axis: axisOf(m.kind === "revolute" ? target : world),
          moves: [], src: m.src,
        },
      });
    }
    return true;
  };

  for (let progress = true; progress && pending.length > 0; ) {
    progress = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      if (place(pending[i]!)) {
        pending.splice(i, 1);
        progress = true;
      }
    }
  }
  for (const leaf of leaves) {
    if (!placed.has(leaf)) {
      throw new CadError(
        "UNPLACED_PART",
        `"${leaf.path}" (${leaf.inst.typeName}) in ${root.inst.typeName} is not connected to the ${ground ? "ground" : "first part"} by mates or joints`,
        leaf.inst.src,
      );
    }
  }
  for (const { result, moving } of joints) {
    result.moves = leaves
      .filter((leaf) => {
        for (let l: Node | undefined = leaf; l; l = parent.get(l)) if (l === moving) return true;
        return false;
      })
      .map((leaf) => leaf.path);
  }
  return { at: placed, joints: joints.map((j) => j.result), ...(grounded !== undefined && { ground: grounded }) };
}

// --- Build ------------------------------------------------------------------

function collectLeaves(node: Node, out: Node[]) {
  if (node.inst.solid) out.push(node);
  for (const c of node.children.values()) collectLeaves(c, out);
}
function collectAssemblies(node: Node, out: PlaceResult[]) {
  if (node.path && !node.inst.solid) out.push({ path: node.path, type: node.inst.typeName, src: node.inst.src });
  for (const c of node.children.values()) collectAssemblies(c, out);
}
function collectChecks(node: Node, out: Array<{ c: CheckDef; scope: Node }>) {
  out.push(...node.inst.checks.map((c) => ({ c, scope: node })));
  for (const c of node.children.values()) collectChecks(c, out);
}
function runCheck(c: CheckDef, q: Query, pathOf: (j: JointDef) => string | undefined): CheckResult {
  if (!c.sweep) return { name: c.name, pass: c.fn(q), src: c.src };
  const { joint, steps } = c.sweep;
  const last = Math.max(steps, 2) - 1;
  for (let i = 0; i <= last; i++) {
    const value = joint.min + ((joint.max - joint.min) * i) / last;
    if (!c.fn(q.at(joint, value))) {
      return { name: c.name, pass: false, src: c.src, failedAt: { joint: pathOf(joint)!, value: round(value) } };
    }
  }
  return { name: c.name, pass: true, src: c.src };
}

function toMesh(k: OcctKernel, shape: ShapeHandle, path: string, indexOf: (hash: number) => number): MeshData {
  const m = k.meshShape(shape, { linearDeflection: 0.05, angularDeflection: 0.3 });
  const groups: number[] = [];
  const g = m.faceGroups ?? new Int32Array();
  for (let i = 0; i < g.length; i += 3) groups.push(g[i]! / 3, g[i + 1]! / 3, indexOf(g[i + 2]!)); // kernel counts indices
  return { path, positions: m.positions, normals: m.normals, indices: m.indices, faceGroups: groups };
}

const apply = (m: Mat, v: Vec3, w = 1): Vec3 => [
  m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2] + m[3]! * w,
  m[4]! * v[0] + m[5]! * v[1] + m[6]! * v[2] + m[7]! * w,
  m[8]! * v[0] + m[9]! * v[1] + m[10]! * v[2] + m[11]! * w,
];
/** Moves a mesh by a rigid transform. */
function placeMesh(m: MeshData, mat: Mat, path: string): MeshData {
  const move = (src: Float32Array, w: number) => {
    const out = new Float32Array(src.length);
    for (let i = 0; i < src.length; i += 3) out.set(apply(mat, [src[i]!, src[i + 1]!, src[i + 2]!], w), i);
    return out;
  };
  return { path, positions: move(m.positions, 1), normals: move(m.normals, 0), indices: m.indices, faceGroups: m.faceGroups };
}

/** A part built in its own frame: all an assembly needs to place it without evaluating it again. */
export interface PartBuild {
  /** In the part's own frame, with path "". */
  part: PartResult;
  mesh: MeshData;
  /** Each feature's mesh by step id, or undefined when built without them. */
  steps?: Map<number, MeshData>;
  shape: ShapeHandle;
}
/** Keeps part builds between runs. `put` gets the part's build as if it were the entry. */
export interface PartStore {
  get(inst: Instance, steps: boolean): PartBuild | undefined;
  put(inst: Instance, part: PartBuild, solo: BuildOutput): void;
}

function evalPart(ev: Evaluator, inst: Instance, withSteps: boolean): PartBuild {
  const k = ev.k;
  const solid = inst.solid!;
  const e = ev.eval(solid);
  const seen = new Map<string, number>();
  const faceIndex = new Map<number, number>();
  const faces: FaceInfo[] = ev.faces(e.shape).map((f, i) => {
    const h = ev.hash(f);
    faceIndex.set(h, i);
    const t = e.tags.get(h)!;
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
  const stepMeshes = new Map<number, MeshData>();
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
    if (withSteps) stepMeshes.set(n.id, toMesh(k, r.shape, "", () => -1));
  };
  walk(solid);

  return {
    part: {
      path: "", type: inst.typeName, params: inst.params, src: inst.src,
      volume: round(k.getVolume(e.shape)), bbox: bboxOf(k, e.shape), faces, steps,
    },
    mesh: toMesh(k, e.shape, "", (h) => faceIndex.get(h) ?? -1),
    ...(withSteps && { steps: stepMeshes }),
    shape: e.shape,
  };
}

function hashOf(parts: PartResult[], meshes: MeshData[]) {
  const digest = createHash("sha256");
  parts.forEach((p, i) => {
    const mesh = meshes[i]!;
    digest.update(p.path);
    digest.update(p.faces.map((f) => f.id).join("\n"));
    digest.update(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength));
  });
  return digest.digest("hex").slice(0, 16);
}

export async function build(
  root: Instance,
  opts: { stepMeshes?: boolean; pose?: Record<string, number>; sweeps?: boolean; store?: PartStore } = {},
): Promise<BuildOutput> {
  const k = await getKernel();
  const ev = new Evaluator(k);
  const top = tree(root, "");
  const leaves: Node[] = [];
  collectLeaves(top, leaves);
  if (leaves.length === 0) throw new CadError("EMPTY_MODEL", `${root.typeName} has no parts`, root.src);

  const named: Array<[string, JointDef]> = [];
  collectJoints(top, named);
  const pose = new Map<string, number>();
  for (const [path, value] of Object.entries(opts.pose ?? {})) {
    if (!named.some(([p]) => p === path)) {
      throw new CadError("NO_SUCH_JOINT", `No joint "${path}"`, undefined, `Joints: ${named.map(([p]) => p).join(", ") || "none"}`);
    }
    pose.set(path, value);
  }
  /** The path of a joint as seen from a check's place. */
  const jointPathIn = (scope: Node, joint: JointDef) =>
    named.find(([p, j]) => j === joint && (scope.path === "" || p.startsWith(`${scope.path}/`)))?.[0];

  const query = (scope: Node, at: Pose, shapeOf: (n: Node) => ShapeHandle): Query => {
    const of = (i: Instance) => {
      const n = find(scope, i);
      if (!n?.inst.solid) throw new Error(`${i.typeName} is not a part of this build`);
      return shapeOf(n);
    };
    return {
      distance: (a, b) => round(k.distanceBetween(of(a), of(b))),
      volume: (a) => round(k.getVolume(of(a))),
      overlap: (a, b) => {
        const r = k.booleanOp(BooleanOp.Common, [of(a)], [of(b)]);
        return k.getSubShapes(r.result, "solid").length ? round(k.getVolume(r.result)) : 0;
      },
      bbox: (a) => bboxOf(k, of(a)),
      at: (joint, value) => {
        const path = jointPathIn(scope, joint);
        if (path === undefined) {
          throw new CadError("NO_SUCH_JOINT", "A check uses a joint that is not part of this build", joint.src);
        }
        const next = new Map(at).set(path, value);
        const moved = solve(top, leaves, next).at;
        const cache = new Map<Node, ShapeHandle>();
        return query(scope, next, (n) => {
          let s = cache.get(n);
          if (s === undefined) {
            s = k.transform(own.get(originOf(n.inst))!.shape, moved.get(n)!);
            cache.set(n, s);
          }
          return s;
        });
      },
    };
  };
  const checksOf = (node: Node, shapeOf: (n: Node) => ShapeHandle, at: Pose) => {
    const defs: Array<{ c: CheckDef; scope: Node }> = [];
    collectChecks(node, defs);
    return defs
      .filter(({ c }) => opts.sweeps || !c.sweep)
      .map(({ c, scope }) => runCheck(c, query(scope, at, shapeOf), (j) => jointPathIn(scope, j)));
  };

  // Each instance is built once, however often it is placed, and only when the store has no fresh build of it.
  const own = new Map<Instance, PartBuild>();
  const withSteps = !!opts.stepMeshes;
  for (const leaf of leaves) {
    const origin = originOf(leaf.inst);
    if (own.has(origin)) continue;
    let b = opts.store?.get(origin, withSteps);
    if (!b) {
      b = evalPart(ev, origin, withSteps);
      if (opts.store) {
        const solo = tree(origin, "");
        const checks = origin.checks.length ? checksOf(solo, () => b!.shape, new Map()) : [];
        opts.store.put(origin, b, {
          model: { type: origin.typeName, parts: [b.part], assemblies: [], joints: [], checks, hash: hashOf([b.part], [b.mesh]) },
          meshes: [b.mesh], shapes: new Map([["", b.shape]]), stepMeshes: new Map(b.steps ? [["", b.steps]] : []),
        });
      }
    }
    own.set(origin, b);
  }

  const solved = solve(top, leaves, pose);
  const parts: PartResult[] = [];
  const meshes: MeshData[] = [];
  const shapes = new Map<string, ShapeHandle>();
  const placedShapes = new Map<Node, ShapeHandle>();
  const stepMeshes = new Map<string, Map<number, MeshData>>();
  for (const leaf of leaves) {
    const b = own.get(originOf(leaf.inst))!;
    const mat = solved.at.get(leaf) ?? IDENTITY;
    const shape = k.transform(b.shape, mat);
    meshes.push(placeMesh(b.mesh, mat, leaf.path));
    if (withSteps && b.steps) {
      stepMeshes.set(leaf.path, new Map([...b.steps].map(([id, m]) => [id, placeMesh(m, mat, leaf.path)])));
    }
    shapes.set(leaf.path, shape);
    placedShapes.set(leaf, shape);
    parts.push({
      ...b.part,
      path: leaf.path, type: leaf.inst.typeName, params: leaf.inst.params, src: leaf.inst.src,
      bbox: bboxOf(k, shape),
      faces: b.part.faces.map((f) => ({ ...f, center: apply(mat, f.center).map(round) as Vec3 })),
    });
  }

  const checks = checksOf(top, (n) => placedShapes.get(n)!, pose);
  const assemblies: PlaceResult[] = [];
  collectAssemblies(top, assemblies);
  return {
    model: {
      type: root.typeName, parts, assemblies, joints: solved.joints, ...(solved.ground !== undefined && { ground: solved.ground }),
      checks, hash: hashOf(parts, meshes),
    },
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
