import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installedAgents, mergePath, missingAgent, onPath, pickAgent } from "../src/agent.ts";

const bin = () => mkdtempSync(join(tmpdir(), "vibecad-path-"));

test("an agent is on PATH only as an executable file", () => {
  const dir = bin();
  writeFileSync(join(dir, "codex"), "#!/bin/sh\n");
  writeFileSync(join(dir, "claude"), "#!/bin/sh\n");
  chmodSync(join(dir, "codex"), 0o755);
  const env = { PATH: `/nowhere:${dir}` };
  assert.equal(onPath("codex", env, "darwin"), true);
  assert.equal(onPath("claude", env, "darwin"), false, "not executable");
  assert.deepEqual(installedAgents(env, "darwin"), ["codex"]);
});

test("on Windows an agent is found through PATHEXT, as npm's .cmd shim", () => {
  const dir = bin();
  writeFileSync(join(dir, "claude.cmd"), "@echo off\r\n");
  assert.equal(onPath("claude", { PATH: dir, PATHEXT: ".EXE;.CMD" }, "win32"), true);
  assert.equal(onPath("claude", { PATH: dir, PATHEXT: ".EXE" }, "win32"), false);
});

test("the setting wins while installed; else the first installed agent; else none", () => {
  assert.equal(pickAgent("codex", ["claude", "codex"]), "codex");
  assert.equal(pickAgent("claude", ["codex"]), "codex", "a missing configured agent gives way");
  assert.equal(pickAgent("codex", []), null);
  assert.equal(pickAgent(undefined, ["codex"]), "codex");
  assert.equal(pickAgent(undefined, ["claude", "codex"]), "claude");
  assert.equal(pickAgent(undefined, []), null);
});

test("a missing agent says what to install, or which one is there", () => {
  assert.match(missingAgent("claude", []), /No agent CLI found.*claude.*codex/);
  assert.match(missingAgent(null, ["codex"]), /No agent CLI found/);
  assert.match(missingAgent("claude", ["codex"]), /Could not find claude.*"agent": "codex"/);
});

test("a reloaded PATH only adds folders, so what resolved before still does", () => {
  assert.equal(mergePath("/a:/b", "/b/:/c:/a", "darwin"), "/a:/b:/c");
  assert.equal(mergePath("C:\\Tools;C:\\Node", "c:\\node\\;C:\\Users\\홍길동\\AppData\\Roaming\\npm", "win32"), "C:\\Tools;C:\\Node;C:\\Users\\홍길동\\AppData\\Roaming\\npm");
  assert.equal(mergePath("", "/a", "linux"), "/a");
});
