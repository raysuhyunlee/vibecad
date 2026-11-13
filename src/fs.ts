import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CadError } from "./eval.ts";

/** Creates a folder. Node's recursive mkdir on a relative path never returns once the working directory is gone. */
export function ensureDir(dir: string) {
  const cwd = process.cwd();
  if (!existsSync(cwd)) throw new CadError("NO_WORKING_DIR", `The working directory ${cwd} no longer exists`);
  mkdirSync(resolve(cwd, dir), { recursive: true });
}

/** Where a file's build is kept, until someone deletes it. A file is one instance. */
export const buildDir = (file: string) => `.vibecad/builds/${file}`;

// --- Libraries and factories --------------------------------------------------

/** A library is a folder of `.cad.ts` instances; a factory folder holds plain `.ts` code that makes them. */
export type Shelf = "libs" | "factories";
const PREFIX: Record<string, Shelf> = { "lib:": "libs", "factory:": "factories" };

/** Where a shelf's folders are looked up, first match wins: the project, the person's home, then vibecad's own. */
export const shelfRoots = (shelf: Shelf) => [
  resolve(shelf),
  join(homedir(), ".vibecad", shelf),
  fileURLToPath(new URL(`../${shelf}`, import.meta.url)),
];

/**
 * The file a `lib:` or `factory:` specifier names, or undefined for any other specifier.
 * `lib:std/m3x10` is `<root>/std/m3x10.cad.ts`; `factory:std` is `<root>/std/index.ts`, `factory:std/x` is `<root>/std/x.ts`.
 */
export function resolveShelf(specifier: string): string | undefined {
  const prefix = Object.keys(PREFIX).find((p) => specifier.startsWith(p));
  if (!prefix) return undefined;
  const shelf = PREFIX[prefix]!;
  const [name = "", ...rest] = specifier.slice(prefix.length).split("/");
  const sub = rest.join("/");
  const roots = shelfRoots(shelf);
  const dirs = roots.map((r) => join(r, name));
  const dir = dirs.find((d) => name && existsSync(d));
  const kind = shelf === "libs" ? "library" : "factory";
  if (!dir) {
    throw new CadError("NO_" + kind.toUpperCase(), `No ${kind} "${name}" for "${specifier}"`, undefined, `Put it in a folder named ${name} in one of: ${roots.join(", ")}`);
  }
  const file = shelf === "libs"
    ? join(dir, sub.endsWith(".cad.ts") ? sub : `${sub}.cad.ts`)
    : join(dir, !sub ? "index.ts" : sub.endsWith(".ts") ? sub : `${sub}.ts`);
  if ((shelf === "libs" && !sub) || !existsSync(file)) {
    throw new CadError("NO_" + kind.toUpperCase(), `"${specifier}" names no file in ${dir}`, undefined, shelf === "libs" ? `Name an instance, like lib:${name}/<file>` : undefined);
  }
  shadows.set(file, dirs.slice(0, dirs.indexOf(dir)));
  return file;
}

/** For each file a `lib:` or `factory:` import resolved to, the folders before it that would win if they appeared. */
export const shadows = new Map<string, string[]>();
/** The digest an input records for a folder that must stay absent. */
export const ABSENT = "absent";

/**
 * Where a shared library's instance is kept: `~/.vibecad/builds/lib/<name>/<file>`, for a library in the person's home
 * or vibecad's own, so every project reuses one build. A home folder hides vibecad's of the same name, so they share keys.
 * Undefined for other files; a project's own `libs/` files are kept in the project, like its other files.
 */
export function sharedBuildDir(path: string): string | undefined {
  const abs = resolve(path);
  for (const root of shelfRoots("libs").slice(1)) {
    const r = relative(root, abs);
    if (r && !r.startsWith("..") && !isAbsolute(r) && r.includes(sep)) return join(homedir(), ".vibecad", "builds", "lib", r);
  }
  return undefined;
}

export const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** What a build read: vibecad's own source and each file with its content digest, or `ABSENT` for a folder that must not appear. `steps` is true when it has feature meshes. */
export interface BuildInputs {
  tool: string;
  steps: boolean;
  files: Record<string, string>;
}

/** A digest of vibecad's source, so a build from another version is never fresh. */
export function toolDigest() {
  const dir = dirname(fileURLToPath(import.meta.url));
  const h = createHash("sha256");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) h.update(f).update(readFileSync(join(dir, f)));
  return h.digest("hex").slice(0, 16);
}

/** True when the build in `dir` has feature meshes if asked, and nothing it read has changed since. */
export function isFresh(dir: string, steps: boolean) {
  try {
    const r: BuildInputs = JSON.parse(readFileSync(`${dir}/inputs.json`, "utf8"));
    return r.tool === toolDigest() && (r.steps || !steps) &&
      Object.entries(r.files).every(([file, d]) => d === ABSENT ? !existsSync(file) : digest(readFileSync(file)) === d);
  } catch {
    return false; // no record, or a file it read is gone
  }
}
