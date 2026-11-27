import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AgentRunner, INTRO, claudeCatalog, codexCatalog, codexHistory, installedAgents, mergePath, missingAgent, onPath, pickAgent } from "../src/agent.ts";

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

test("the model and thinking level go to each agent's own flags", () => {
  const args = (kind: string) => new AgentRunner(kind).adapter!.command("s", "m", "high").args.join(" ");
  assert.match(args("claude"), /--model m --effort high/);
  assert.match(args("codex"), /-m m -c model_reasoning_effort="high"/);
  assert.doesNotMatch(new AgentRunner("codex").adapter!.command("s").args.join(" "), /effort|-m /);
});

test("codex lists its cached models by priority, defaulting to its config, else the first", () => {
  const dir = bin();
  const cache = join(dir, "models_cache.json");
  const config = join(dir, "config.toml");
  writeFileSync(cache, JSON.stringify({ models: [
    { slug: "b", display_name: "B 2", visibility: "list", priority: 2, supported_reasoning_levels: [{ effort: "low" }], default_reasoning_level: "low" },
    { slug: "a", display_name: "A 1", visibility: "list", priority: 1, supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], default_reasoning_level: "high" },
    { slug: "hidden", visibility: "hide", priority: 0 },
  ] }));
  assert.deepEqual(codexCatalog(cache, config), {
    models: [
      { id: "a", name: "A 1", efforts: ["low", "high"], defaultEffort: "high" },
      { id: "b", name: "B 2", efforts: ["low"], defaultEffort: "low" },
    ],
    defaultModel: "a",
    defaultEffort: undefined,
  });
  writeFileSync(config, 'model = "b"\nmodel_reasoning_effort = "low"\n[profiles.x]\nmodel = "a"\n');
  const c = codexCatalog(cache, config);
  assert.deepEqual([c.defaultModel, c.defaultEffort], ["b", "low"]);
  assert.deepEqual(codexCatalog(join(dir, "none.json"), config).models, []);
});

test("claude's default names the alias it resolves to, with its version", () => {
  const c = claudeCatalog({ models: [
    { value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default (recommended)" },
    { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: ["low", "max"] },
    { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5" },
  ] }, { effortLevel: "medium" });
  assert.deepEqual(c.models.map((m) => [m.id, m.name]), [["opus", "Opus 5.5"], ["claude-opus-5-5", "Opus 5.5"]]);
  assert.deepEqual([c.defaultModel, c.defaultEffort], ["opus", "medium"]);
  assert.deepEqual(claudeCatalog({}, null), { models: [], defaultModel: undefined, defaultEffort: undefined });
});

test("codex lists this folder's vibecad sessions and loads their conversation", () => {
  const home = mkdtempSync(join(tmpdir(), "vibecad-codex-"));
  const day = join(home, "sessions/2026/11/27");
  mkdirSync(day, { recursive: true });
  const line = (v: unknown) => JSON.stringify(v) + "\n";
  const meta = (id: string, cwd: string) => line({ type: "session_meta", payload: { id, cwd } });
  const user = (text: string) => line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  writeFileSync(join(day, "rollout-a-s1.jsonl"),
    meta("s1", process.cwd()) +
    user("# AGENTS.md instructions") +
    user(`${INTRO} Etc.\n\nViewing: main.cad.ts\nPerson said: "make it taller"`) +
    line({ type: "event_msg", payload: { type: "item_completed", item: { type: "CommandExecution", command: ["/bin/zsh", "-lc", "cat main.cad.ts"] } } }) +
    line({ type: "event_msg", payload: { type: "item_completed", item: { type: "FileChange" } } }) +
    line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] } }));
  writeFileSync(join(day, "rollout-b-mine.jsonl"), meta("mine", process.cwd()) + user("a terminal session"));
  writeFileSync(join(day, "rollout-c-other.jsonl"), meta("other", "/elsewhere") + user(`${INTRO}\nPerson said: "x"`));
  const saved = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  try {
    assert.deepEqual(codexHistory.list().map((s) => [s.id, s.title]), [["s1", "make it taller"]]);
    assert.deepEqual(codexHistory.load("s1").map((m) => [m.role, m.kind, m.text]), [
      ["user", "text", "make it taller"], ["agent", "tool", "cat main.cad.ts"], ["agent", "tool", "Edit files"], ["agent", "text", "Done."],
    ]);
  } finally {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
  }
});
