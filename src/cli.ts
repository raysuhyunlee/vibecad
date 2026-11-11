#!/usr/bin/env node
// Every command prints one JSON document to stdout, and exits non-zero on failure.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { registerHooks } from "node:module";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build, CadError, getKernel, type BuildOutput, type MeshData, type Model, type PartBuild, type PartStore } from "./eval.ts";
import { buildDir, digest, ensureDir, isFresh, toolDigest, type BuildInputs } from "./fs.ts";
import { isInstance, originOf, STEP_FILE, stepEntry, type Instance, type Solid } from "./lang.ts";

// The project's modules as they load: each file's content digest, and what each imports.
// vibecad's own source counts once, as the tool digest.
const OWN = new URL("./", import.meta.url).href;
const counted = (url: string) => url.startsWith("file:") && !url.startsWith(OWN) && !url.includes("/node_modules/");
const digests = new Map<string, string>();
const imports = new Map<string, Set<string>>();

// Projects anywhere on disk import the language as "vibecad".
registerHooks({
  resolve: (specifier, context, next) => {
    const r = specifier === "vibecad"
      ? { url: new URL("./index.ts", import.meta.url).href, shortCircuit: true }
      : next(specifier, context);
    const from = context.parentURL;
    if (from && counted(from) && counted(r.url)) imports.set(from, (imports.get(from) ?? new Set()).add(r.url));
    return r;
  },
  load: (url, context, next) => {
    const r = next(url, context);
    if (counted(url) && r.source != null) digests.set(url, digest(r.source as string | Uint8Array));
    return r;
  },
});

// The kernel prints transfer statistics to stdout. Keep stdout pure JSON.
process.stdout.write = ((chunk: unknown) => {
  const text = String(chunk);
  if (!/^\s*$|\*{5}/.test(text)) process.stderr.write(text);
  return true;
}) as typeof process.stdout.write;

const OUT_DIR = ".vibecad/out";
const DEV_FILE = ".vibecad/dev.json";
const USAGE = `vibecad <command> [entry=main.cad.ts]
An entry is a *.cad.ts file, whose default export is its one part or assembly,
or a STEP file.

Commands that build also take --pose joint=value,other/joint=value.

  build [entry] [--steps]        Build; writes .vibecad/builds/<file>/model.json and meshes.json
  test [entry]                   Build and fail if a design check fails, including joint sweeps
  query [entry] [--part p] [--face id] [--clearance a,b]
                                 Inspect parts and faces or measure between parts
  render [entry] [--part p] [--out file.png] [--labels]
                                 Write a multi-view PNG. --labels numbers each face
                                 in all six views and iso, and prints what each number is
  export [entry] [--part p] --out file.step|file.stl
  diff <git-ref> [entry]         Compare the model with another revision
  dev                            Start the app; open a project and file inside it.
                                 Settings: ~/.vibecad/config.json
  show --part p [--face id] [--message text]
                                 Point at geometry in the open preview`;

function print(value: unknown) {
  writeSync(1, JSON.stringify(value, null, 2) + "\n");
}
function fail(error: unknown): never {
  print({ ok: false, error: error instanceof CadError ? error.toJSON() : describe(error) });
  process.exit(1);
}
function describe(e: unknown) {
  if (!(e instanceof Error)) return { code: "ERROR", message: String(e) };
  const at = e.stack?.split("\n").find((l) => /\.ts:\d+/.test(l) && !l.includes("/vibecad/src/"));
  return { code: "ERROR", message: e.message, at: at?.trim() };
}

// --- Instances --------------------------------------------------------------

/** The `.cad.ts` or STEP file each loaded instance is, relative to the project. One file is one instance. */
const fileOf = new Map<Instance, string>();
const rel = (path: string) => relative(process.cwd(), path).split(sep).join("/");

/** A `.cad.ts` module's instance: its default export, and no other. */
function instanceOf(file: string, mod: Record<string, unknown>) {
  const d = mod.default;
  if (!isInstance(d)) {
    throw new CadError("BAD_ENTRY", `${file} must default-export one part or assembly`, undefined, "For example export default Plate({ ... }). Keep factories in plain .ts files.");
  }
  const other = Object.keys(mod).find((n) => n !== "default" && isInstance(mod[n]) && mod[n] !== d);
  if (other) {
    throw new CadError("MANY_INSTANCES", `${file} exports a second instance, "${other}"`, undefined, `A .cad.ts file is one instance. Move "${other}" to a .cad.ts file of its own.`);
  }
  if (!fileOf.has(d)) fileOf.set(d, file);
  return d;
}

/** Every placed instance must be a `.cad.ts` file's own, so each is built once and kept. */
function checkExported(inst: Instance) {
  for (const c of Object.values(inst.children)) {
    if (!fileOf.has(originOf(c))) {
      throw new CadError(
        "NOT_EXPORTED",
        `${c.typeName} in ${inst.typeName} is not the instance of a .cad.ts file`,
        c.src,
        "Give it a .cad.ts file whose default export it is, and import that. place(x) places it again.",
      );
    }
    checkExported(c);
  }
}

/** Loads an entry: a `.cad.ts` file's instance, or a STEP file as one part. */
async function load(entry: string): Promise<{ root: Instance; file: string }> {
  const file = rel(resolve(entry));
  if (STEP_FILE.test(file)) {
    const root = stepEntry(file);
    fileOf.set(root, file);
    return { root, file };
  }
  const url = pathToFileURL(resolve(file)).href;
  await import(url);
  for (const u of digests.keys()) if (u.endsWith(".cad.ts")) instanceOf(rel(fileURLToPath(u)), await import(u));
  const root = instanceOf(file, await import(url));
  checkExported(root);
  return { root, file };
}

/** What an instance's build read: its file and everything that file imports, and any STEP file it loads. */
function inputsOf(file: string, inst: Instance, steps: boolean): BuildInputs {
  const files: Record<string, string> = {};
  const seen = new Set<string>();
  const visit = (u: string) => {
    if (seen.has(u)) return;
    seen.add(u);
    const d = digests.get(u);
    if (d) files[rel(fileURLToPath(u))] = d;
    for (const next of imports.get(u) ?? []) visit(next);
  };
  if (!STEP_FILE.test(file)) visit(pathToFileURL(resolve(file)).href);
  const solids = new Set<Solid>();
  const walk = (s: Solid) => {
    if (solids.has(s)) return;
    solids.add(s);
    if (s.op === "importStep") {
      const path = String(s.args.path);
      if (existsSync(path)) files[rel(path)] = digest(readFileSync(path));
    }
    s.inputs.forEach(walk);
  };
  const parts = (i: Instance) => {
    if (i.solid) walk(i.solid);
    Object.values(i.children).forEach(parts);
  };
  parts(inst);
  return { tool: toolDigest(), steps, files };
}

/** Keeps each exported part's build in its own folder, so an assembly reuses it and its tab opens at once. */
function diskStore(k: Awaited<ReturnType<typeof getKernel>>): PartStore {
  const placeOf = (inst: Instance) => {
    const file = fileOf.get(inst);
    return file && !file.startsWith("../") ? file : undefined; // only parts inside the project are kept
  };
  return {
    get(inst, steps) {
      const file = placeOf(inst);
      if (!file) return undefined;
      const dir = buildDir(file);
      if (!existsSync(`${dir}/shape.brep`) || !isFresh(dir, steps)) return undefined;
      try {
        const model: Model = JSON.parse(readFileSync(`${dir}/model.json`, "utf8"));
        const meshes = JSON.parse(readFileSync(`${dir}/meshes.json`, "utf8"));
        const own = meshes.steps?.[""] as Record<string, EncodedMesh> | undefined;
        const b: PartBuild = {
          part: model.parts[0]!,
          mesh: decodeMesh(meshes.parts[0]),
          ...(own && { steps: new Map(Object.entries(own).map(([id, m]) => [Number(id), decodeMesh(m)])) }),
          shape: k.fromBREPBinary(new Uint8Array(readFileSync(`${dir}/shape.brep`))),
        };
        return steps && !b.steps ? undefined : b;
      } catch {
        return undefined;
      }
    },
    put(inst, b, solo) {
      const file = placeOf(inst);
      if (!file) return;
      writeOutputs(solo, buildDir(file), inputsOf(file, inst, !!b.steps), k.toBREPBinary(b.shape));
    },
  };
}

// --- Output -----------------------------------------------------------------

type EncodedMesh = ReturnType<typeof encodeMesh>;
function encode(a: Float32Array | Uint32Array) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
}
function encodeMesh(m: MeshData) {
  return {
    path: m.path, faceGroups: m.faceGroups,
    positions: encode(m.positions), normals: encode(m.normals), indices: encode(m.indices),
    faceGeom: m.faceGeom, edges: m.edges,
  };
}
function decodeMesh(m: EncodedMesh): MeshData {
  const bytes = (s: string) => {
    const b = Buffer.from(s, "base64");
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  return {
    path: m.path, faceGroups: m.faceGroups,
    positions: new Float32Array(bytes(m.positions)), normals: new Float32Array(bytes(m.normals)), indices: new Uint32Array(bytes(m.indices)),
    faceGeom: m.faceGeom, edges: m.edges,
  };
}

function summary(m: Model) {
  return {
    type: m.type, hash: m.hash,
    parts: m.parts.map((p) => ({
      path: p.path, type: p.type, src: p.src, volume: p.volume, size: p.bbox.size,
      faces: p.faces.length, steps: p.steps.length,
    })),
    joints: m.joints.map((j) => ({ path: j.path, kind: j.kind, value: j.value, min: j.min, max: j.max, src: j.src })),
    checks: m.checks,
  };
}

/** Writes a build, and last what it read, so a half-written build is never taken as fresh. */
function writeOutputs(out: BuildOutput, dir: string, inputs: BuildInputs, brep?: Uint8Array) {
  ensureDir(dir);
  rmSync(`${dir}/inputs.json`, { force: true });
  writeFileSync(`${dir}/model.json`, JSON.stringify(out.model, null, 2));
  writeFileSync(`${dir}/meshes.json`, JSON.stringify({
    parts: out.meshes.map(encodeMesh),
    steps: Object.fromEntries([...out.stepMeshes].map(([path, steps]) =>
      [path, Object.fromEntries([...steps].map(([id, m]) => [id, encodeMesh(m)]))])),
  }));
  if (brep) writeFileSync(`${dir}/shape.brep`, brep);
  writeFileSync(`${dir}/inputs.json`, JSON.stringify(inputs, null, 2));
}

function parsePose(text: string | undefined) {
  const pose: Record<string, number> = {};
  for (const item of text ? text.split(",") : []) {
    const at = item.indexOf("=");
    const value = at > 0 ? Number(item.slice(at + 1)) : NaN;
    if (!Number.isFinite(value) || item.slice(at + 1).trim() === "") {
      throw new CadError("BAD_POSE", `Cannot read "${item}" in --pose`, undefined, "Use --pose joint=value,other/joint=value");
    }
    pose[item.slice(0, at)] = value;
  }
  return pose;
}

/** Builds an entry, reusing kept part builds when `keep` is set. */
async function buildEntry(entry: string, opts: Omit<NonNullable<Parameters<typeof build>[1]>, "store"> = {}, keep = true) {
  const { root, file } = await load(entry);
  const out = await build(root, { ...opts, ...(keep && { store: diskStore(await getKernel()) }) });
  return { out, root, file };
}

function pick(out: BuildOutput, part?: string) {
  if (part) {
    const s = out.shapes.get(part);
    if (s === undefined) {
      throw new CadError("NO_SUCH_PART", `No part "${part}"`, undefined, `Parts: ${[...out.shapes.keys()].join(", ")}`);
    }
    return s;
  }
  return getKernel().then((k) => k.makeCompound([...out.shapes.values()]));
}

async function main() {
  const { values: o, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      steps: { type: "boolean" },
      part: { type: "string" },
      face: { type: "string" },
      clearance: { type: "string" },
      out: { type: "string" },
      message: { type: "string" },
      pose: { type: "string" },
      labels: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (!cmd || o.help) {
    writeSync(1, USAGE + "\n");
    return;
  }

  if (cmd === "diff") return diff(rest[0], rest[1] ?? "main.cad.ts");

  const entry = rest[0] ?? "main.cad.ts";
  if (cmd === "dev") {
    if (rest[0]) throw new CadError("DEV_TAKES_NO_FILE", "dev takes no file", undefined, "Run vibecad dev, then open the project in the app");
    const { loadConfig } = await import("./config.ts");
    const { serve } = await import("./server.ts");
    const config = loadConfig();
    return serve({
      ...config,
      print,
    });
  }
  if (cmd === "show") return show(o.part, o.face, o.message);

  const pose = parsePose(o.pose);
  const { out, root, file } = await buildEntry(entry, { stepMeshes: !!o.steps, pose, sweeps: cmd === "test" });
  const k = await getKernel();

  switch (cmd) {
    case "build": {
      // A posed build is not the instance as its source states it, so it is not kept.
      const dir = Object.keys(pose).length ? OUT_DIR : buildDir(file);
      writeOutputs(out, dir, inputsOf(file, root, !!o.steps));
      print({ ok: true, ...summary(out.model), artifacts: `${dir}/model.json` });
      return;
    }
    case "test": {
      const failed = out.model.checks.filter((c) => !c.pass);
      print({ ok: failed.length === 0, total: out.model.checks.length, failed, checks: out.model.checks });
      if (failed.length) process.exit(1);
      return;
    }
    case "query": {
      if (o.clearance) {
        const [a, b] = o.clearance.split(",");
        print({ ok: true, a, b, clearance: k.distanceBetween(await pick(out, a), await pick(out, b)) });
        return;
      }
      const parts = o.part ? out.model.parts.filter((p) => p.path === o.part) : out.model.parts;
      if (o.part && parts.length === 0) await pick(out, o.part);
      if (o.face) {
        const hits = parts.flatMap((p) =>
          p.faces.filter((f) => f.id === o.face || f.name === o.face).map((f) => ({ part: p.path, ...f })),
        );
        print({ ok: hits.length > 0, faces: hits });
        if (!hits.length) process.exit(1);
        return;
      }
      print({ ok: true, parts });
      return;
    }
    case "render": {
      const shape = await pick(out, o.part);
      const file = o.out ?? `${OUT_DIR}/render.png`;
      ensureDir(resolve(file, ".."));
      if (o.labels) {
        const { renderLabeled } = await import("./render.ts");
        const { png, labels, unseen } = await renderLabeled(k, shape, out, o.part);
        writeFileSync(file, png);
        print({ ok: true, file, labels, unseen });
        return;
      }
      writeFileSync(file, await k.toMultiviewPNG(shape));
      print({ ok: true, file });
      return;
    }
    case "export": {
      if (!o.out) throw new CadError("MISSING_OUT", "export needs --out file.step or file.stl");
      const shape = await pick(out, o.part);
      if (o.out.endsWith(".stl")) writeFileSync(o.out, k.exportStl(shape));
      else if (STEP_FILE.test(o.out)) writeFileSync(o.out, k.exportStep(shape));
      else throw new CadError("BAD_FORMAT", "Use a .step, .stp or .stl file name");
      print({ ok: true, file: o.out });
      return;
    }
    default:
      throw new CadError("UNKNOWN_COMMAND", `Unknown command "${cmd}"`, undefined, USAGE);
  }
}

/** Asks the running preview to highlight geometry for the human. */
async function show(part?: string, face?: string, message?: string) {
  if (!part) throw new CadError("MISSING_PART", "show needs --part");
  if (!existsSync(DEV_FILE)) throw new CadError("NO_PREVIEW", "No preview has this project open. Run vibecad dev and open it in the app");
  const { port } = JSON.parse(readFileSync(DEV_FILE, "utf8"));
  const res = await fetch(`http://127.0.0.1:${port}/show`, {
    method: "POST",
    body: JSON.stringify({ part, face, message }),
  });
  print({ ok: res.ok });
}

/** Builds the same entry from another revision and compares by semantic face name. */
async function diff(ref: string | undefined, entry: string) {
  if (!ref) throw new CadError("MISSING_REF", "diff needs a git ref");
  const tmp = `.vibecad/tmp/diff-${process.pid}`;
  ensureDir(".vibecad/tmp");
  execFileSync("git", ["worktree", "add", "--detach", "-q", tmp, ref], { stdio: "pipe" });
  try {
    const before = await buildEntry(`${tmp}/${entry}`, {}, false);
    const after = await buildEntry(entry);
    print({ ok: true, ref, ...compare(before.out.model, after.out.model) });
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", tmp], { stdio: "pipe" });
    rmSync(tmp, { recursive: true, force: true });
  }
}

function compare(a: Model, b: Model) {
  const before = new Map(a.parts.map((p) => [p.path, p]));
  const after = new Map(b.parts.map((p) => [p.path, p]));
  const changed = [];
  for (const [path, q] of after) {
    const p = before.get(path);
    if (!p) continue;
    const pf = new Set(p.faces.map((f) => f.id)), qf = new Set(q.faces.map((f) => f.id));
    const addedFaces = [...qf].filter((f) => !pf.has(f));
    const removedFaces = [...pf].filter((f) => !qf.has(f));
    const volumeDelta = Math.round((q.volume - p.volume) * 1e6) / 1e6;
    const sizeChanged = String(p.bbox.size) !== String(q.bbox.size);
    if (addedFaces.length || removedFaces.length || volumeDelta || sizeChanged) {
      changed.push({
        path, volumeDelta, addedFaces, removedFaces,
        ...(sizeChanged && { size: { before: p.bbox.size, after: q.bbox.size } }),
      });
    }
  }
  return {
    identical: a.hash === b.hash,
    addedParts: [...after.keys()].filter((p) => !before.has(p)),
    removedParts: [...before.keys()].filter((p) => !after.has(p)),
    changed,
  };
}

main().catch(fail);
