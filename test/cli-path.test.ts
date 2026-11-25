import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-ignore: the app is plain JavaScript.
import { installCli } from "../app/cli-path.js";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

test("the launcher runs the CLI, and PATH is added once", { skip: process.platform === "win32" }, () => {
  const home = mkdtempSync(join(tmpdir(), "vibecad-home-"));
  const opts = { platform: "darwin", shell: "/bin/zsh", home, exe: process.execPath, cli: CLI };
  const file = installCli(opts);
  installCli(opts);
  const rc = readFileSync(join(home, ".zshrc"), "utf8");
  assert.equal(rc.match(/\.vibecad\/bin/g)?.length, 1);
  const r = spawnSync(file, ["--help"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /vibecad <command>/);
});
