// The declarative language: pure functions that build a feature graph.
// Nothing here touches the kernel. eval.ts turns the graph into geometry.

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
export type Segment =
  | { t: "line"; a: Pt; b: Pt }
  | { t: "arc"; c: Pt; r: number; a0: number; a1: number }
  | { t: "circle"; c: Pt; r: number };
/** A closed 2D outline on the XY plane. */
export interface Profile {
  segments: Segment[];
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

// --- Solids: the feature graph ----------------------------------------------

let nextId = 1;
let opCounts = new Map<string, number>();

export type OpName =
  | "box" | "cylinder" | "cone" | "sphere" | "extrude" | "revolve"
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
/** Faces: top, bottom, side[i]. Extrudes along +Z from z=0. */
export function extrude(profile: Profile, height: number): Solid {
  return new Solid("extrude", { profile, height }, []);
}
export function revolve(profile: Profile, axis: Axis = "y", degrees = 360): Solid {
  return new Solid("revolve", { profile, axis: toVec(axis), degrees }, []);
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

export interface Query {
  /** Minimum distance between two solids, 0 when touching or overlapping. */
  distance(a: Instance, b: Instance): number;
  volume(a: Instance): number;
  /** Volume shared by two solids. */
  overlap(a: Instance, b: Instance): number;
  bbox(a: Instance): { min: Vec3; max: Vec3; size: Vec3 };
}
export interface CheckDef {
  name: string;
  fn: (q: Query) => boolean;
  src: Src;
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
  readonly checks: CheckDef[];

  constructor(init: {
    typeName: string;
    params: unknown;
    src: Src;
    solid?: Solid;
    ports?: Record<string, PortDef | PortRef>;
    children?: Record<string, Instance>;
    mates?: MateDef[];
    checks?: CheckDef[];
  }) {
    this.typeName = init.typeName;
    this.params = init.params;
    this.src = init.src;
    if (init.solid) this.solid = init.solid;
    this.ports = init.ports ?? {};
    this.children = init.children ?? {};
    this.mates = init.mates ?? [];
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

/** Defines an assembly type: named child instances joined by mates. */
export function assembly<P extends object, K extends string = never>(
  typeName: string,
  build: (params: P) => {
    parts: Record<string, Instance<any>>;
    mates?: MateDef[];
    ports?: Record<K, PortRef>;
    checks?: CheckDef[];
  },
) {
  return (...args: Args<P>): Instance<K> => {
    const params = (args[0] ?? {}) as P;
    const src = callerSrc();
    const r = build(params);
    return new Instance<K>({
      typeName, params, src,
      children: r.parts,
      ...(r.mates && { mates: r.mates }),
      ...(r.ports && { ports: r.ports }),
      ...(r.checks && { checks: r.checks }),
    });
  };
}
