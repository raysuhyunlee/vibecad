// The declarative language: pure functions that build a feature graph.
// Nothing here touches the kernel. eval.ts turns the graph into geometry.
import { basename, dirname, resolve } from "node:path";

export type Vec3 = [number, number, number];
export interface Src {
  file: string;
  line: number;
  col: number;
}

Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 40);
const LIB_DIR = new URL(".", import.meta.url).href;

/** The first stack frame outside this library: the user's line of CAD code. */
export function callerSrc(): Src {
  const stack = new Error().stack?.split("\n") ?? [];
  for (const line of stack.slice(1)) {
    const m = /(file:\/\/[^\s)]+|\/[^\s)]+|[A-Za-z]:\\[^\s)]+):(\d+):(\d+)\)?$/.exec(line);
    if (!m) continue;
    const file = m[1]!;
    if (file.startsWith(LIB_DIR) || file.includes("node:")) continue;
    const abs = file.startsWith("file://") ? decodeURIComponent(new URL(file).pathname) : file;
    const cwd = process.cwd().replaceAll("\\", "/");
    const rel = abs.startsWith(cwd + "/") ? abs.slice(cwd.length + 1) : abs;
    return { file: rel, line: Number(m[2]), col: Number(m[3]) };
  }
  return { file: "<unknown>", line: 0, col: 0 };
}

// --- Selectors --------------------------------------------------------------

export type Axis = "x" | "y" | "z";

/** Edge selection by meaning, never by index. Filters combine with AND. */
export class EdgeSel {
  readonly filters: ReadonlyArray<EdgeFilter>;
  constructor(filters: ReadonlyArray<EdgeFilter> = []) {
    this.filters = filters;
  }
  of(face: string) {
    return new EdgeSel([...this.filters, { kind: "of", face }]);
  }
  between(a: string, b: string) {
    return this.of(a).of(b);
  }
  parallel(axis: Axis) {
    return new EdgeSel([...this.filters, { kind: "parallel", axis }]);
  }
  curve(kind: "line" | "circle") {
    return new EdgeSel([...this.filters, { kind: "curve", curve: kind }]);
  }
}
export type EdgeFilter =
  | { kind: "of"; face: string }
  | { kind: "parallel"; axis: Axis }
  | { kind: "curve"; curve: string };

export const edges = new EdgeSel();

// --- Profiles ---------------------------------------------------------------

type Pt = [number, number];
/** `name` becomes the name of the wall this segment sweeps into. */
export type Segment = (
  | { t: "line"; a: Pt; b: Pt }
  | { t: "arc"; c: Pt; r: number; a0: number; a1: number }
  | { t: "circle"; c: Pt; r: number }
  /** Passes through every point, with these unit tangents at its ends. */
  | { t: "spline"; through: Pt[]; start: Pt; end: Pt }
  | { t: "closedSpline"; through: Pt[] }
) & { name?: string };
/** A closed 2D outline in its sketch plane's x and y. */
export interface Profile {
  segments: Segment[];
  /** Applied in order after the segments. See offset. */
  offsets?: number[];
}

/** A smooth closed outline through the points, with no seam. Its wall is "side". */
export function closedSpline(points: Pt[]): Profile {
  if (points.length < 3) throw new Error(`closedSpline: needs at least 3 points, got ${points.length}`);
  checkSteps(points, "closedSpline");
  return { segments: [{ t: "closedSpline", through: points }] };
}
/**
 * The outline moved outward by distance, or inward when it is negative, whichever way it was drawn.
 * Corners stay sharp, and each wall keeps the name of the segment it came from.
 */
export function offset(profile: Profile, distance: number): Profile {
  if (!Number.isFinite(distance) || distance === 0) throw new Error(`offset: distance must be a non-zero number, got ${distance}`);
  return { ...profile, offsets: [...(profile.offsets ?? []), distance] };
}
function checkSteps(points: Pt[], where: string) {
  points.forEach((p, i) => {
    const prev = points[(i + points.length - 1) % points.length]!;
    if (dist(prev, p) < TOL) throw new Error(`${where}: repeated point [${p}]`);
  });
}

export function polygon(points: Pt[]): Profile {
  return {
    segments: points.map((a, i) => ({ t: "line", a, b: points[(i + 1) % points.length]! })),
  };
}
export function circle(r: number, c: Pt = [0, 0]): Profile {
  return { segments: [{ t: "circle", c, r }] };
}
export function rect(w: number, h: number): Profile {
  return polygon([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]);
}
export function roundedRect(w: number, h: number, r: number): Profile {
  const x = w / 2, y = h / 2, q = Math.PI / 2;
  return {
    segments: [
      { t: "line", a: [-x + r, -y], b: [x - r, -y] },
      { t: "arc", c: [x - r, -y + r], r, a0: -q, a1: 0 },
      { t: "line", a: [x, -y + r], b: [x, y - r] },
      { t: "arc", c: [x - r, y - r], r, a0: 0, a1: q },
      { t: "line", a: [x - r, y], b: [-x + r, y] },
      { t: "arc", c: [-x + r, y - r], r, a0: q, a1: 2 * q },
      { t: "line", a: [-x, y - r], b: [-x, -y + r] },
      { t: "arc", c: [-x + r, -y + r], r, a0: 2 * q, a1: 3 * q },
    ],
  };
}

// A path segment while building. An arc keeps its direction as a signed sweep.
type PathLine = { t: "line"; a: Pt; b: Pt; name?: string };
type PathArc = { t: "arc"; c: Pt; r: number; from: number; sweep: number; name?: string };
type PathSpline = { t: "spline"; through: Pt[]; start: Pt; end: Pt; name?: string };
type PathSeg = PathLine | PathArc | PathSpline;
type Round = { r: number; name?: string };

const TOL = 1e-7; // OCCT's own wire tolerance, mm
const TAU = 2 * Math.PI;
const RESERVED_FACES = ["top", "bottom", "start", "end", "side"];

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const onCircle = (c: Pt, r: number, angle: number): Pt => [c[0] + r * Math.cos(angle), c[1] + r * Math.sin(angle)];
const angleOf = (c: Pt, p: Pt) => Math.atan2(p[1] - c[1], p[0] - c[0]);

function segPoint(s: PathSeg, t: number): Pt {
  if (s.t === "spline") return t < 0.5 ? s.through[0]! : s.through.at(-1)!;
  if (s.t === "line") return [s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t];
  return onCircle(s.c, s.r, s.from + s.sweep * t);
}
/** Unit travel direction at parameter t. */
function segDir(s: PathSeg, t: number): Pt {
  if (s.t === "spline") return t < 0.5 ? s.start : s.end;
  if (s.t === "line") {
    const l = dist(s.a, s.b);
    return [(s.b[0] - s.a[0]) / l, (s.b[1] - s.a[1]) / l];
  }
  const angle = s.from + s.sweep * t, sign = Math.sign(s.sweep);
  return [-sign * Math.sin(angle), sign * Math.cos(angle)];
}
/** The parameter of the point on s nearest q, or undefined when it falls outside s. */
function segParam(s: PathLine | PathArc, q: Pt): number | undefined {
  let t: number;
  if (s.t === "line") {
    const l = dist(s.a, s.b), d = segDir(s, 0);
    t = ((q[0] - s.a[0]) * d[0] + (q[1] - s.a[1]) * d[1]) / l;
  } else {
    const along = (Math.sign(s.sweep) * (angleOf(s.c, q) - s.from)) % TAU;
    const a = along < 0 ? along + TAU : along;
    const size = Math.abs(s.sweep);
    t = a > size && a > (size + TAU) / 2 ? (a - TAU) / size : a / size;
  }
  const eps = 1e-9;
  if (t < -eps || t > 1 + eps) return undefined;
  return Math.min(1, Math.max(0, t));
}

type Curve = { p: Pt; d: Pt } | { c: Pt; r: number };

/** The curve r away from s, on its left (side 1) or right (side -1). */
function offsetCurve(s: PathLine | PathArc, r: number, side: number): Curve | undefined {
  if (s.t === "line") {
    const d = segDir(s, 0);
    return { p: [s.a[0] - d[1] * r * side, s.a[1] + d[0] * r * side], d };
  }
  const radius = s.r - side * Math.sign(s.sweep) * r;
  return radius > 0 ? { c: s.c, r: radius } : undefined;
}
function intersect(a: Curve, b: Curve): Pt[] {
  if ("p" in a && "p" in b) {
    const cross = a.d[0] * b.d[1] - a.d[1] * b.d[0];
    if (Math.abs(cross) < 1e-12) return [];
    const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / cross;
    return [[a.p[0] + a.d[0] * t, a.p[1] + a.d[1] * t]];
  }
  if ("p" in a) return intersect(b, a);
  if ("p" in b) {
    const fx = b.p[0] - a.c[0], fy = b.p[1] - a.c[1];
    const along = fx * b.d[0] + fy * b.d[1];
    const h2 = a.r ** 2 - (fx ** 2 + fy ** 2 - along ** 2);
    if (h2 < 0) return [];
    const h = Math.sqrt(h2);
    return [-along - h, -along + h].map((t) => [b.p[0] + b.d[0] * t, b.p[1] + b.d[1] * t]);
  }
  const d = dist(a.c, b.c);
  if (d < 1e-12) return [];
  const x = (d ** 2 + a.r ** 2 - b.r ** 2) / (2 * d);
  const h2 = a.r ** 2 - x ** 2;
  if (h2 < 0) return [];
  const h = Math.sqrt(h2), ux = (b.c[0] - a.c[0]) / d, uy = (b.c[1] - a.c[1]) / d;
  const m: Pt = [a.c[0] + ux * x, a.c[1] + uy * x];
  return [[m[0] - uy * h, m[1] + ux * h], [m[0] + uy * h, m[1] - ux * h]];
}

/** The unit direction at p0 of the parabola through p0, p1 and p2, spaced by their distances. */
function endTangent(p0: Pt, p1: Pt, p2: Pt): Pt {
  const h0 = dist(p0, p1), h1 = dist(p1, p2);
  const v = [0, 1].map((i) => {
    const near = (p1[i]! - p0[i]!) / h0, far = (p2[i]! - p1[i]!) / h1;
    return (near * (2 * h0 + h1) - far * h0) / (h0 + h1);
  }) as Pt;
  return unit(v, "spline");
}
function unit(v: Pt, where: string): Pt {
  const l = Math.hypot(v[0], v[1]);
  if (l < 1e-12) throw new Error(`${where}: a tangent has no direction`);
  return [v[0] / l, v[1] / l];
}

/** Builds a closed outline from lines, arcs and splines. Each step continues from the last point. */
export class Path {
  readonly #start: Pt;
  readonly #segs: PathSeg[] = [];
  /** Corner rounds, by the index of the segment after the corner. */
  readonly #rounds = new Map<number, Round>();
  #at: Pt;
  #last: { name?: string } | undefined;

  constructor(start: Pt) {
    this.#start = start;
    this.#at = start;
  }

  #push(s: PathSeg, end: Pt) {
    this.#segs.push(s);
    this.#at = end;
    this.#last = s;
    return this;
  }
  #dir(step: string): Pt {
    const prev = this.#segs.at(-1);
    if (!prev) throw new Error(`path: ${step} needs a segment before it to be tangent to`);
    return segDir(prev, 1);
  }

  /** A straight line to a point. */
  line(to: Pt) {
    if (dist(this.#at, to) < TOL) throw new Error(`path: line to [${to}] has no length`);
    return this.#push({ t: "line", a: this.#at, b: to }, to);
  }
  /** A line continuing tangent to the previous segment. */
  forward(length: number) {
    const d = this.#dir("forward");
    return this.line([this.#at[0] + d[0] * length, this.#at[1] + d[1] * length]);
  }
  /** An arc around c to a point, counter-clockwise unless ccw is false. Ending where it starts makes a full circle. */
  arc(c: Pt, to: Pt, ccw = true) {
    const r = dist(c, this.#at);
    if (r < TOL) throw new Error(`path: arc center [${c}] is on the start point`);
    if (Math.abs(dist(c, to) - r) > 1e-6) {
      throw new Error(`path: arc end [${to}] is ${dist(c, to)} from center [${c}], but the start is ${r} from it`);
    }
    const from = angleOf(c, this.#at), end = angleOf(c, to), sign = ccw ? 1 : -1;
    let size = (sign * (end - from)) % TAU;
    if (size < 0) size += TAU;
    if (size < 1e-9 || TAU - size < 1e-9) size = TAU;
    return this.#push({ t: "arc", c, r, from, sweep: sign * size }, onCircle(c, r, end));
  }
  /** An arc to a point, tangent to the previous segment. */
  tangentArc(to: Pt) {
    const d = this.#dir("tangentArc");
    const v: Pt = [to[0] - this.#at[0], to[1] - this.#at[1]];
    const n: Pt = [-d[1], d[0]];
    const across = v[0] * n[0] + v[1] * n[1];
    if (Math.abs(across) < 1e-9) throw new Error(`path: [${to}] lies straight ahead, so tangentArc has no curve; use line`);
    const signed = (v[0] ** 2 + v[1] ** 2) / (2 * across);
    return this.arc([this.#at[0] + n[0] * signed, this.#at[1] + n[1] * signed], to, signed > 0);
  }
  /**
   * A smooth curve through the points, ending at the last one. An end with no tangent takes the
   * direction the nearby points suggest, so two points or fewer after the start need both tangents.
   */
  spline(through: Pt[], tangents: { start?: Pt; end?: Pt } = {}) {
    const all = [this.#at, ...through];
    if (through.length === 0) throw new Error("path: spline needs a point to go through");
    for (let i = 1; i < all.length; i++) {
      if (dist(all[i - 1]!, all[i]!) < TOL) throw new Error(`path: spline repeats the point [${all[i]}]`);
    }
    if (all.length < 3 && !(tangents.start && tangents.end)) {
      throw new Error("path: a spline to one point needs both tangents; add a point, or use line");
    }
    const n = all.length - 1;
    const start = tangents.start ? unit(tangents.start, "spline") : endTangent(all[0]!, all[1]!, all[2]!);
    const backward = () => endTangent(all[n]!, all[n - 1]!, all[n - 2]!);
    const end = tangents.end ? unit(tangents.end, "spline") : ((b) => [-b[0], -b[1]] as Pt)(backward());
    return this.#push({ t: "spline", through: all, start, end }, all[n]!);
  }
  /** A spline starting tangent to the previous segment. */
  tangentSpline(through: Pt[], end?: Pt) {
    const start = this.#dir("tangentSpline");
    return this.spline(through, end ? { start, end } : { start });
  }
  /** Rounds the corner at the current point, between the previous and the next segment. */
  round(r: number) {
    if (this.#segs.length === 0) throw new Error("path: round needs a segment before it");
    if (!(r > 0)) throw new Error(`path: round radius must be positive, got ${r}`);
    const round: Round = { r };
    this.#rounds.set(this.#segs.length, round);
    this.#last = round;
    return this;
  }
  /** Names the last segment or round. Its wall becomes "<feature>.<name>". */
  named(name: string) {
    if (!this.#last) throw new Error("path: named needs a segment before it");
    if (!/^[A-Za-z_][\w-]*$/.test(name) || RESERVED_FACES.includes(name)) {
      throw new Error(`path: bad segment name "${name}". Use a plain word other than ${RESERVED_FACES.join(", ")}`);
    }
    this.#last.name = name;
    return this;
  }
  /** Closes the outline, with a line back to the start if it is not there yet. */
  close(): Profile {
    if (this.#segs.length === 0) throw new Error("path: close needs a segment before it");
    if (dist(this.#at, this.#start) >= TOL) this.line(this.#start);
    return { segments: resolveRounds(this.#segs, this.#rounds) };
  }
}

/** Starts an outline at a point. See Path. */
export function path(start: Pt) {
  return new Path(start);
}

/** Trims the segments at each round, and emits the outline in order. */
function resolveRounds(segs: PathSeg[], rounds: Map<number, Round>): Segment[] {
  const n = segs.length;
  const starts: number[] = segs.map(() => 0), ends: number[] = segs.map(() => 1);
  const arcs = new Map<number, PathArc>();
  for (const [at, round] of rounds) {
    const i = at % n, prevI = (i + n - 1) % n;
    const prev = segs[prevI]!, next = segs[i]!;
    if (prev.t === "spline" || next.t === "spline") {
      throw new Error(`path: round cannot touch a spline, at [${segPoint(next, 0)}]; put a line or arc between them`);
    }
    const u = segDir(prev, 1), v = segDir(next, 0);
    const turn = u[0] * v[1] - u[1] * v[0];
    const corner = segPoint(next, 0);
    if (prevI === i || Math.abs(turn) < 1e-9) {
      throw new Error(`path: no corner to round at [${corner}]; the segments there are already tangent`);
    }
    const side = Math.sign(turn);
    const a = offsetCurve(prev, round.r, side), b = offsetCurve(next, round.r, side);
    const fits = (a && b ? intersect(a, b) : []).flatMap((c) => {
      const t0 = segParam(prev, c), t1 = segParam(next, c);
      return t0 === undefined || t1 === undefined ? [] : [{ c, t0, t1 }];
    }).sort((p, q) => dist(p.c, corner) - dist(q.c, corner));
    const fit = fits[0];
    if (!fit) throw new Error(`path: round radius ${round.r} does not fit the corner at [${corner}]`);
    ends[prevI] = fit.t0;
    starts[i] = fit.t1;
    const from = angleOf(fit.c, segPoint(prev, fit.t0));
    let size = (side * (angleOf(fit.c, segPoint(next, fit.t1)) - from)) % TAU;
    if (size < 0) size += TAU;
    arcs.set(i, { t: "arc", c: fit.c, r: round.r, from, sweep: side * size, name: round.name });
  }
  const out: Segment[] = [];
  segs.forEach((s, i) => {
    const arc = arcs.get(i);
    if (arc) out.push(toSegment(arc));
    if (s.t === "spline") {
      out.push(s);
      return;
    }
    const t0 = starts[i]!, t1 = ends[i]!;
    if (t0 > t1 + 1e-9) throw new Error(`path: rounds overlap on the segment from [${segPoint(s, 0)}] to [${segPoint(s, 1)}]`);
    if (t1 - t0 < 1e-9) return; // Two rounds used up this segment.
    if (s.t === "line") out.push({ t: "line", a: segPoint(s, t0), b: segPoint(s, t1), name: s.name });
    else out.push(toSegment({ ...s, from: s.from + s.sweep * t0, sweep: s.sweep * (t1 - t0) }));
  });
  return out;
}
function toSegment(s: PathArc): Segment {
  const [a0, a1] = s.sweep > 0 ? [s.from, s.from + s.sweep] : [s.from + s.sweep, s.from];
  return { t: "arc", c: s.c, r: s.r, a0, a1, name: s.name };
}

/** Touch points of the line tangent to two circles on the same side, left or right of travel from c1 to c2. */
export function outerTangent(c1: Pt, r1: number, c2: Pt, r2: number, side: "left" | "right" = "right"): [Pt, Pt] {
  const d = dist(c1, c2);
  if (d <= Math.abs(r1 - r2)) throw new Error("outerTangent: one circle is inside the other");
  const a = angleOf(c1, c2) + (side === "left" ? 1 : -1) * Math.acos((r1 - r2) / d);
  return [onCircle(c1, r1, a), onCircle(c2, r2, a)];
}

// --- Solids: the feature graph ----------------------------------------------

let nextId = 1;
let opCounts = new Map<string, number>();

export type OpName =
  | "box" | "cylinder" | "cone" | "sphere" | "extrude" | "revolve" | "sweep" | "loft" | "importStep"
  | "union" | "cut" | "intersect"
  | "fillet" | "chamfer" | "shell"
  | "translate" | "rotate" | "mirror";

/** An immutable graph node. Every method returns a new Solid. */
export class Solid {
  readonly id: number;
  readonly op: OpName;
  readonly args: Record<string, unknown>;
  readonly inputs: readonly Solid[];
  readonly src: Src;
  readonly name: string;
  readonly named_: boolean;

  constructor(
    op: OpName,
    args: Record<string, unknown>,
    inputs: readonly Solid[],
    src?: Src,
    name?: string,
  ) {
    this.id = nextId++;
    this.op = op;
    this.args = args;
    this.inputs = inputs;
    this.src = src ?? callerSrc();
    this.named_ = name !== undefined;
    if (name !== undefined) {
      this.name = name;
    } else {
      const n = (opCounts.get(op) ?? 0) + 1;
      opCounts.set(op, n);
      this.name = `${op}${n}`;
    }
  }

  /** Names this feature. Faces become selectable as "<name>.<face>". */
  named(name: string): Solid {
    return new Solid(this.op, this.args, this.inputs, this.src, name);
  }
  cut(...tools: Array<Solid | Solid[]>): Solid {
    return new Solid("cut", {}, [this, ...tools.flat()]);
  }
  union(...others: Array<Solid | Solid[]>): Solid {
    return new Solid("union", {}, [this, ...others.flat()]);
  }
  intersect(other: Solid): Solid {
    return new Solid("intersect", {}, [this, other]);
  }
  fillet(radius: number, sel: EdgeSel): Solid {
    return new Solid("fillet", { radius, sel }, [this]);
  }
  chamfer(distance: number, sel: EdgeSel): Solid {
    return new Solid("chamfer", { distance, sel }, [this]);
  }
  /** Hollows the solid, opening the selected faces. */
  shell(thickness: number, openFaces: string[]): Solid {
    return new Solid("shell", { thickness, openFaces }, [this]);
  }
  translate(x: number, y: number, z: number): Solid {
    return new Solid("translate", { x, y, z }, [this]);
  }
  rotate(axis: Axis | Vec3, degrees: number, origin: Vec3 = [0, 0, 0]): Solid {
    return new Solid("rotate", { axis: toVec(axis), degrees, origin }, [this]);
  }
  mirror(normal: Axis | Vec3, point: Vec3 = [0, 0, 0]): Solid {
    return new Solid("mirror", { normal: toVec(normal), point }, [this]);
  }
}

function toVec(a: Axis | Vec3): Vec3 {
  if (a === "x") return [1, 0, 0];
  if (a === "y") return [0, 1, 0];
  if (a === "z") return [0, 0, 1];
  return a;
}

/** Faces: top, bottom, left, right, front, back. Centered on XY, base at z=0. */
export function box(width: number, depth: number, height: number): Solid {
  return new Solid("box", { width, depth, height }, []);
}
/** Faces: side, top, bottom. Axis on Z, base at z=0. */
export function cylinder(radius: number, height: number): Solid {
  return new Solid("cylinder", { radius, height }, []);
}
export function cone(r1: number, r2: number, height: number): Solid {
  return new Solid("cone", { r1, r2, height }, []);
}
export function sphere(radius: number): Solid {
  return new Solid("sphere", { radius }, []);
}
/** A sketch plane. The sketch's x lies along x, its y along z cross x, and sweeps go along +z. */
export interface Plane {
  at: Vec3;
  z: Vec3;
  x?: Vec3;
}
/** Without x, the sketch's x is world X projected onto the plane, or world Y when z is near X. */
export function plane(at: Vec3, z: Axis | Vec3 = "z", x?: Axis | Vec3): Plane {
  const zv = toVec(z), xv = x && toVec(x);
  const length = (v: Vec3) => Math.hypot(...v);
  if (length(zv) < TOL) throw new Error("plane: z has no direction");
  if (xv) {
    const c: Vec3 = [zv[1] * xv[2] - zv[2] * xv[1], zv[2] * xv[0] - zv[0] * xv[2], zv[0] * xv[1] - zv[1] * xv[0]];
    if (length(c) < TOL * length(zv) * length(xv)) throw new Error(`plane: x [${xv}] must not be parallel to z [${zv}]`);
  }
  return xv ? { at, z: zv, x: xv } : { at, z: zv };
}

/** A sketch plane on a flat face of a solid, resolved when the model builds. */
export interface FaceRef {
  solid: Solid;
  face: string;
  x?: Vec3;
  at?: Pt;
}
/**
 * Sketches on a named flat face. +z points out of the solid and the origin is the center of the face's outline.
 * `at` moves the origin in sketch units, and x works as in plane. A sweep into the solid has a negative height.
 */
export function onFace(solid: Solid, face: string, opts: { x?: Axis | Vec3; at?: Pt } = {}): FaceRef {
  return { solid, face, ...(opts.x && { x: toVec(opts.x) }), ...(opts.at && { at: opts.at }) };
}
const refInputs = (on: Plane | FaceRef | undefined) => (on && "face" in on ? [on.solid] : []);

/** Faces: top, bottom, and per profile segment its name or side[i]. Extrudes along the plane's +z, by default world Z from z=0. */
export function extrude(profile: Profile, height: number, on?: Plane | FaceRef): Solid {
  return new Solid("extrude", { profile, height, on }, refInputs(on));
}
/** Faces: start, end when not a full turn, and per profile segment its name or side[i]. The axis is in the sketch's own axes. */
export function revolve(profile: Profile, axis: Axis = "y", degrees = 360, on?: Plane | FaceRef): Solid {
  return new Solid("revolve", { profile, axis: toVec(axis), degrees, on }, refInputs(on));
}

export type SpineSegment =
  | { t: "line"; to: Vec3 }
  | { t: "arc"; through: Vec3; to: Vec3 }
  | { t: "tangentArc"; to: Vec3 }
  | { t: "spline"; through: Vec3[] };
/** An open 3D curve for a sweep to follow. Each step continues from the last point. */
export class Spine {
  readonly start: Vec3;
  readonly segments: SpineSegment[] = [];
  constructor(start: Vec3) {
    this.start = start;
  }
  line(to: Vec3) {
    this.segments.push({ t: "line", to });
    return this;
  }
  /** An arc through one point to another. */
  arc(through: Vec3, to: Vec3) {
    this.segments.push({ t: "arc", through, to });
    return this;
  }
  /** An arc to a point, tangent to the previous segment. */
  tangentArc(to: Vec3) {
    if (this.segments.length === 0) throw new Error("spine: tangentArc needs a segment before it to be tangent to");
    this.segments.push({ t: "tangentArc", to });
    return this;
  }
  /** A smooth curve through the points, ending at the last one. */
  spline(through: Vec3[]) {
    if (through.length < 2) throw new Error("spine: spline needs at least 2 points; use line for one");
    this.segments.push({ t: "spline", through });
    return this;
  }
}
/** Starts a spine at a point. See Spine. */
export function spine(start: Vec3) {
  return new Spine(start);
}
export interface Helix {
  radius: number;
  pitch: number;
  height: number;
  left: boolean;
}
/** A helix about +z, starting at [radius, 0, 0]. Right-handed unless left is set. */
export function helix(radius: number, pitch: number, height: number, opts: { left?: boolean } = {}): Helix {
  if (!(radius > 0 && pitch > 0 && height > 0)) throw new Error("helix: radius, pitch and height must be positive");
  return { radius, pitch, height, left: opts.left ?? false };
}
/**
 * Sweeps a profile along a spine. The sketch's origin sits on the spine's start, with +z along the spine,
 * and x works as in plane. Faces: start, end, and per profile segment its name or side[i], with ~2 for each further spine segment.
 */
export function sweep(profile: Profile, along: Spine | Helix, opts: { x?: Axis | Vec3 } = {}): Solid {
  if (along instanceof Spine && along.segments.length === 0) throw new Error("sweep: the spine has no segments");
  return new Solid("sweep", { profile, spine: along, x: opts.x && toVec(opts.x) }, []);
}
/**
 * Blends through two or more sections, smoothly unless ruled is set, which makes straight walls between sections.
 * Faces: start, end, and per segment of the first section its name or side[i].
 */
export function loft(sections: Array<{ profile: Profile; on: Plane | FaceRef }>, opts: { ruled?: boolean } = {}): Solid {
  if (sections.length < 2) throw new Error(`loft: needs at least 2 sections, got ${sections.length}`);
  return new Solid("loft", { sections, ruled: opts.ruled ?? false }, sections.flatMap((s) => refInputs(s.on)));
}
/** Loads a STEP file, relative to the calling source file. Faces: face[i], in file order. */
export function importStep(file: string): Solid {
  const src = callerSrc();
  return new Solid("importStep", { path: resolve(dirname(src.file), file) }, [], src);
}
export const STEP_FILE = /\.(step|stp)$/i;
/** A STEP file opened directly as an entry: one part named after the file. */
export function stepEntry(file: string): Instance {
  const src: Src = { file, line: 1, col: 1 };
  const name = basename(file).replace(STEP_FILE, "");
  const solid = new Solid("importStep", { path: resolve(file) }, [], src, name);
  return new Instance({ typeName: name, params: {}, src, solid });
}
/** Fuses solids into one. */
export function union(first: Solid, ...rest: Array<Solid | Solid[]>): Solid {
  return first.union(...rest);
}

// --- Parts, assemblies, ports -----------------------------------------------

/** A connection frame in a part's local coordinates. +z points out of the part. */
export interface PortDef {
  at: Vec3;
  z: Vec3;
  x?: Vec3;
}
export function port(at: Vec3, z: Vec3 = [0, 0, 1], x?: Vec3): PortDef {
  return x ? { at, z, x } : { at, z };
}

export interface PortRef {
  owner: Instance;
  name: string;
}

export interface MateDef {
  a: PortRef;
  b: PortRef;
  /** Separation along a's port normal. */
  gap: number;
  /** Rotation of b around the mated axis, in degrees. */
  angle: number;
  src: Src;
}
/** Places b's port against a's port, facing it. */
export function mate(a: PortRef, b: PortRef, opts: { gap?: number; angle?: number } = {}): MateDef {
  return { a, b, gap: opts.gap ?? 0, angle: opts.angle ?? 0, src: callerSrc() };
}

/** A mate that can move. Its value is an angle in degrees, or a travel in model units. */
export interface JointDef extends MateDef {
  kind: "revolute" | "slider";
  min: number;
  max: number;
}
const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
/** Turns the moving part about its own port's +z. The value is `angle`, -180 to 180 by default. */
export function revolute(
  a: PortRef,
  b: PortRef,
  opts: { angle?: number; min?: number; max?: number; gap?: number } = {},
): JointDef {
  const min = opts.min ?? -180, max = opts.max ?? 180;
  return {
    kind: "revolute", a, b, min, max, gap: opts.gap ?? 0,
    angle: opts.angle ?? clamp(0, min, max), src: callerSrc(),
  };
}
/** Slides the ports apart along the fixed port's +z. The value is `travel`. */
export function slider(
  a: PortRef,
  b: PortRef,
  opts: { min: number; max: number; travel?: number; angle?: number },
): JointDef {
  return {
    kind: "slider", a, b, min: opts.min, max: opts.max,
    gap: opts.travel ?? clamp(0, opts.min, opts.max), angle: opts.angle ?? 0, src: callerSrc(),
  };
}

export interface Query {
  /** Minimum distance between two solids, 0 when touching or overlapping. */
  distance(a: Instance, b: Instance): number;
  volume(a: Instance): number;
  /** Volume shared by two solids. */
  overlap(a: Instance, b: Instance): number;
  bbox(a: Instance): { min: Vec3; max: Vec3; size: Vec3 };
  /** The same queries with one joint moved. Other joints keep their values. */
  at(joint: JointDef, value: number): Query;
}
export interface CheckDef {
  name: string;
  fn: (q: Query) => boolean;
  src: Src;
  /** Runs fn across a joint's range, only in `vibecad test`. */
  sweep?: { joint: JointDef; steps: number };
}
/** A design rule, evaluated on every build. */
export function check(name: string, fn: (q: Query) => boolean): CheckDef {
  return { name, fn, src: callerSrc() };
}
export function minClearance(a: Instance, b: Instance, min: number): CheckDef {
  return {
    name: `clearance(${a.typeName}, ${b.typeName}) >= ${min}`,
    fn: (q) => q.distance(a, b) >= min,
    src: callerSrc(),
  };
}
export function noOverlap(a: Instance, b: Instance): CheckDef {
  return {
    name: `no overlap(${a.typeName}, ${b.typeName})`,
    fn: (q) => q.overlap(a, b) < 1e-6,
    src: callerSrc(),
  };
}

/** Fails if the parts overlap at any sampled value of the joint. Collisions between samples can be missed. */
export function noCollision(a: Instance, b: Instance, opts: { joint: JointDef; steps?: number }): CheckDef {
  return {
    name: `no collision(${a.typeName}, ${b.typeName}) across joint range`,
    fn: (q) => q.overlap(a, b) < 1e-6,
    src: callerSrc(),
    sweep: { joint: opts.joint, steps: opts.steps ?? 13 },
  };
}

const INSTANCE = Symbol.for("vibecad.instance");
/** Works across copies of this module, such as a revision checked out by `diff`. */
export function isInstance(v: unknown): v is Instance {
  return typeof v === "object" && v !== null && INSTANCE in v;
}

export class Instance<P extends string = string> {
  readonly [INSTANCE] = true;
  readonly typeName: string;
  readonly params: unknown;
  readonly src: Src;
  readonly solid?: Solid;
  readonly ports: Record<string, PortDef | PortRef>;
  readonly children: Record<string, Instance>;
  readonly mates: MateDef[];
  readonly joints: Record<string, JointDef>;
  readonly checks: CheckDef[];
  readonly ground?: MateDef;

  constructor(init: {
    typeName: string;
    params: unknown;
    src: Src;
    solid?: Solid;
    ports?: Record<string, PortDef | PortRef>;
    children?: Record<string, Instance>;
    mates?: MateDef[];
    joints?: Record<string, JointDef>;
    checks?: CheckDef[];
    ground?: MateDef;
  }) {
    this.typeName = init.typeName;
    if (init.ground) this.ground = init.ground;
    this.params = init.params;
    this.src = init.src;
    if (init.solid) this.solid = init.solid;
    this.ports = init.ports ?? {};
    this.children = init.children ?? {};
    this.mates = init.mates ?? [];
    this.joints = init.joints ?? {};
    this.checks = init.checks ?? [];
  }

  port(name: P): PortRef {
    if (!(name in this.ports)) {
      throw new Error(
        `${this.typeName} has no port "${name}". Ports: ${Object.keys(this.ports).join(", ") || "none"}`,
      );
    }
    return { owner: this, name };
  }
}

const WORLD = Symbol.for("vibecad.world");
/** True for the world frame's owner, across copies of this module. */
export function isWorld(inst: Instance): boolean {
  return WORLD in inst;
}
/** The world frame as a port: the origin, +z up, x along +X. Use it only in an assembly's `ground`. */
export const world: PortRef = {
  owner: Object.assign(new Instance({ typeName: "world", params: {}, src: { file: "vibecad", line: 0, col: 0 }, ports: { origin: port([0, 0, 0], [0, 0, 1], [1, 0, 0]) } }), { [WORLD]: true }),
  name: "origin",
};

type Args<P> = {} extends P ? [params?: P] : [params: P];

/** Defines a part type. Params are its dimension interface; ports its connections. */
export function part<P extends object, K extends string = never>(
  typeName: string,
  build: (params: P) => Solid | { solid: Solid; ports?: Record<K, PortDef>; checks?: CheckDef[] },
) {
  return (...args: Args<P>): Instance<K> => {
    const params = (args[0] ?? {}) as P;
    const src = callerSrc();
    const saved = opCounts;
    opCounts = new Map();
    try {
      const r = build(params);
      return r instanceof Solid
        ? new Instance<K>({ typeName, params, src, solid: r })
        : new Instance<K>({
            typeName, params, src, solid: r.solid,
            ...(r.ports && { ports: r.ports }),
            ...(r.checks && { checks: r.checks }),
          });
    } finally {
      opCounts = saved;
    }
  };
}

const OPTIONS = Symbol.for("vibecad.options");
export type OptionList = Record<string, readonly string[]>;
type Chosen<C extends OptionList> = { [K in keyof C]: C[K][number] };

/** An entry's default export with choices the app and `--option` can switch. The first value of each is the default. */
export function options<const C extends OptionList>(choices: C, make: (chosen: Chosen<C>) => Instance<any>) {
  return Object.assign((chosen: Partial<Chosen<C>> = {}) => make({ ...defaultOptions(choices), ...chosen } as Chosen<C>), { [OPTIONS]: choices });
}
/** The choices an entry's default export declares, across copies of this module. */
export function optionsOf(v: unknown): OptionList | undefined {
  return typeof v === "function" && OPTIONS in v ? (v as any)[OPTIONS] : undefined;
}
export function defaultOptions(choices: OptionList): Record<string, string> {
  return Object.fromEntries(Object.entries(choices).map(([k, vs]) => [k, vs[0]!]));
}

/** Defines an assembly type: named child instances joined by mates and joints. */
export function assembly<P extends object, K extends string = never>(
  typeName: string,
  build: (params: P) => {
    parts: Record<string, Instance<any>>;
    mates?: MateDef[];
    joints?: Record<string, JointDef>;
    ports?: Record<K, PortRef>;
    checks?: CheckDef[];
    /** `mate(world, port)`: fixes that part to the world frame, used only when this assembly is the entry. */
    ground?: MateDef;
  },
) {
  return (...args: Args<P>): Instance<K> => {
    const params = (args[0] ?? {}) as P;
    const src = callerSrc();
    const r = build(params);
    return new Instance<K>({
      typeName, params, src,
      children: r.parts,
      ...(r.ground && { ground: r.ground }),
      ...(r.mates && { mates: r.mates }),
      ...(r.joints && { joints: r.joints }),
      ...(r.ports && { ports: r.ports }),
      ...(r.checks && { checks: r.checks }),
    });
  };
}
