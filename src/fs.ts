import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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

export const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/** What a build read: vibecad's own source and each file with its content digest. `steps` is true when it has feature meshes. */
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
      Object.entries(r.files).every(([file, d]) => digest(readFileSync(file)) === d);
  } catch {
    return false; // no record, or a file it read is gone
  }
}
