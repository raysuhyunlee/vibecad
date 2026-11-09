import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { CadError } from "./eval.ts";

/** Creates a folder. Node's recursive mkdir on a relative path never returns once the working directory is gone. */
export function ensureDir(dir: string) {
  const cwd = process.cwd();
  if (!existsSync(cwd)) throw new CadError("NO_WORKING_DIR", `The working directory ${cwd} no longer exists`);
  mkdirSync(resolve(cwd, dir), { recursive: true });
}
