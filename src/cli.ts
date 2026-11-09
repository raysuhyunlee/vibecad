#!/usr/bin/env node
// Every command prints one JSON document to stdout, and exits non-zero on failure.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { build, CadError, getKernel, type BuildOutput, type Model } from "./eval.ts";
import { isInstance, STEP_FILE, stepEntry, type Instance } from "./lang.ts";

// Projects anywhere on disk import the language as "vibecad".
registerHooks({
  resolve: (specifier, context, next) =>
    specifier === "vibecad"
      ? { url: new URL("./index.ts", import.meta.url).href, shortCircuit: true }
      : next(specifier, context),
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
An entry is a *.cad.ts or STEP file.

Commands that build also take --pose joint=value,other/joint=value.

  build [entry] [--steps] [--out-dir dir]
                                 Build; writes ${OUT_DIR}/model.json and meshes.json
  test [entry]                   Build and fail if a design check fails, including joint sweeps
  query [entry] [--part p] [--face id] [--clearance a,b]
                                 Inspect parts and faces or measure between parts
  render [entry] [--part p] [--out file.png]
                                 Write a multi-view PNG
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

async function load(entry: string): Promise<Instance> {
  if (STEP_FILE.test(entry)) return stepEntry(entry);
  const mod = await import(pathToFileURL(resolve(entry)).href);
  const value = typeof mod.default === "function" ? mod.default() : mod.default;
  if (!isInstance(value)) {
    throw new CadError(
      "BAD_ENTRY",
      `${entry} must default-export a part or assembly instance, or a factory with default params`,
      undefined,
      "For a part with required params, export a preview: export default () => Part({ ... })",
    );
  }
  return value;
}

function encode(a: Float32Array | Uint32Array) {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString("base64");
}
function encodeMesh(m: BuildOutput["meshes"][number]) {
  return {
    path: m.path, faceGroups: m.faceGroups,
    positions: encode(m.positions), normals: encode(m.normals), indices: encode(m.indices),
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

async function writeOutputs(out: BuildOutput, dir: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/model.json`, JSON.stringify(out.model, null, 2));
  writeFileSync(`${dir}/meshes.json`, JSON.stringify({
    parts: out.meshes.map(encodeMesh),
    steps: Object.fromEntries([...out.stepMeshes].map(([id, m]) => [id, encodeMesh(m)])),
  }));
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
      "out-dir": { type: "string" },
      message: { type: "string" },
      pose: { type: "string" },
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
    const { keepMb, ...config } = loadConfig();
    return serve({
      ...config,
      print,
      keepBytes: keepMb * 1024 * 1024,
    });
  }
  if (cmd === "show") return show(o.part, o.face, o.message);

  const out = await build(await load(entry), {
    stepMeshes: !!o.steps,
    pose: parsePose(o.pose),
    sweeps: cmd === "test",
  });
  const k = await getKernel();

  switch (cmd) {
    case "build": {
      const dir = o["out-dir"] ?? OUT_DIR;
      await writeOutputs(out, dir);
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
      const png = await k.toMultiviewPNG(await pick(out, o.part));
      const file = o.out ?? `${OUT_DIR}/render.png`;
      mkdirSync(resolve(file, ".."), { recursive: true });
      writeFileSync(file, png);
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
  mkdirSync(".vibecad/tmp", { recursive: true });
  execFileSync("git", ["worktree", "add", "--detach", "-q", tmp, ref], { stdio: "pipe" });
  try {
    const before = await build(await load(`${tmp}/${entry}`));
    const after = await build(await load(entry));
    print({ ok: true, ref, ...compare(before.model, after.model) });
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
