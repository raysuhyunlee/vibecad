import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const PORT = 4300 + (process.pid % 500);
const URL_BASE = `http://127.0.0.1:${PORT}`;
const root = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-app-")));
const bare = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-bare-")));

mkdirSync(join(root, "parts"));
writeFileSync(join(root, "main.cad.ts"), `import { box, part } from "vibecad";\nexport default part("A", () => ({ solid: box(1, 2, 3).named("a"), ports: {} }))({});\n`);
writeFileSync(join(root, "parts/other.cad.ts"), `import { box, part } from "vibecad";\nexport default part("B", () => ({ solid: box(4, 4, 4).named("b"), ports: {} }))({});\n`);
writeFileSync(join(root, "parts/helper.ts"), "export const size = 1;\n");
mkdirSync(join(root, "node_modules/x"), { recursive: true });
writeFileSync(join(root, "node_modules/x/skip.cad.ts"), "export default 1;\n");

/** Starts the app with its own home folder, and so its own config file. */
function startApp(config: unknown) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-home-")));
  mkdirSync(join(home, ".vibecad"));
  writeFileSync(join(home, ".vibecad/config.json"), JSON.stringify(config));
  const child = spawn(process.execPath, [CLI, "dev"], {
    cwd: bare,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.on("close", () => rmSync(home, { recursive: true, force: true }));
  return child;
}
const app = startApp({ port: PORT });
await new Promise((ok) => app.stdout.once("data", ok));
after(() => {
  app.kill();
  rmSync(root, { recursive: true, force: true });
  rmSync(bare, { recursive: true, force: true });
});

const post = (path: string, body: unknown) => fetch(URL_BASE + path, { method: "POST", body: JSON.stringify(body) });

/** Reads server events until `until` matches, and returns that event. */
async function nextEvent(until: (e: any) => boolean) {
  const res = await fetch(`${URL_BASE}/events`);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      assert.ok(!done, "event stream ended");
      text += value;
      for (const block of text.split("\n\n").slice(0, -1)) {
        const e = JSON.parse(block.slice(6));
        if (until(e)) return e;
      }
      text = text.slice(text.lastIndexOf("\n\n") + 2);
    }
  } finally {
    await reader.cancel();
  }
}
async function waitBuilt(entry: string) {
  for (let i = 0; i < 300; i++) {
    const e = await nextEvent((x) => x.type === "hello");
    assert.equal(e.buildError, undefined);
    if (e.entry === entry && e.built) return e;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  assert.fail(`${entry} did not build`);
}

test("the app starts with nothing open", async () => {
  const hello = await nextEvent((e) => e.type === "hello");
  assert.equal(hello.root, undefined);
  assert.equal(hello.entry, undefined);
  assert.equal((await post("/feedback", { text: "hi" })).status, 409);
});

test("dev refuses a file argument", async () => {
  const child = spawn(process.execPath, [CLI, "dev", "main.cad.ts"], { stdio: ["ignore", "pipe", "ignore"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  const code = await new Promise((ok) => child.on("close", ok));
  assert.equal(code, 1);
  assert.equal(JSON.parse(out).error.code, "DEV_TAKES_NO_FILE");
});

test("the folder picker lists folders and reports bad paths", async () => {
  const dirs: any = await (await fetch(`${URL_BASE}/dirs?path=${encodeURIComponent(root)}`)).json();
  assert.deepEqual(dirs.dirs, ["parts"]);
  assert.equal((await fetch(`${URL_BASE}/dirs?path=${encodeURIComponent(join(root, "nope"))}`)).status, 400);
  assert.equal((await post("/project", { path: join(root, "main.ts") })).status, 400);
});

test("a project outside this repo opens, lists files and builds main.cad.ts", async () => {
  assert.equal((await post("/project", { path: root })).status, 200);
  const hello = await waitBuilt("main.cad.ts");
  assert.equal(hello.root, root);
  assert.deepEqual(hello.files, ["main.cad.ts", "parts/other.cad.ts"]);
  const { model }: any = await (await fetch(`${URL_BASE}/model`)).json();
  assert.equal(model.parts[0].type, "A");
});

test("switching files rebuilds the new entry and stays inside the root", async () => {
  assert.equal((await post("/entry", { file: "parts/other.cad.ts" })).status, 200);
  await waitBuilt("parts/other.cad.ts");
  const { model }: any = await (await fetch(`${URL_BASE}/model`)).json();
  assert.equal(model.parts[0].type, "B");

  assert.equal((await post("/entry", { file: "parts/helper.ts" })).status, 400);
  assert.equal((await post("/entry", { file: join(bare, "x.cad.ts") })).status, 400);
  assert.equal((await post("/entry", { file: "../outside.cad.ts" })).status, 400);
  assert.equal((await fetch(`${URL_BASE}/source?file=${encodeURIComponent("../outside.ts")}`)).status, 404);
  const src: any = await (await fetch(`${URL_BASE}/source?file=parts/helper.ts`)).json();
  assert.equal(src.lines[0], "export const size = 1;");
});

test("new files appear in the list", async () => {
  const added = nextEvent((e) => e.type === "files" && e.files.includes("added.cad.ts"));
  await new Promise((ok) => setTimeout(ok, 100));
  writeFileSync(join(root, "added.cad.ts"), "export default 1;\n");
  await added;
});

test("a tab keeps its build, and rebuilds only after a save", async () => {
  // The file added by the last test made both tabs stale, so bring both up to date first.
  await new Promise((ok) => setTimeout(ok, 400));
  const settle = async (file: string) => {
    assert.equal((await post("/entry", { file })).status, 200);
    for (let i = 0; ; i++) {
      const e: any = await nextEvent((x) => x.type === "hello");
      if (!e.building) return;
      assert.ok(i < 100, `${file} did not settle`);
      await new Promise((ok) => setTimeout(ok, 100));
    }
  };
  await settle("parts/other.cad.ts");
  await settle("main.cad.ts");
  assert.equal((await post("/entry", { file: "parts/other.cad.ts" })).status, 200);
  assert.equal((await post("/entry", { file: "main.cad.ts" })).status, 200);
  const before: any = await nextEvent((e) => e.type === "hello");
  assert.deepEqual(before.tabs.map((t: any) => t.file), ["main.cad.ts", "parts/other.cad.ts"]);
  assert.equal(before.building, undefined, "an up-to-date tab does not rebuild");
  assert.equal(before.built, true);
  const { model }: any = await (await fetch(`${URL_BASE}/model?file=parts/other.cad.ts`)).json();
  assert.equal(model.parts[0].type, "B");

  const version = before.tabs[1].version;
  // A save to a file the tab's build read makes it stale.
  writeFileSync(join(root, "parts/other.cad.ts"), `import { box, part } from "vibecad";\nexport default part("B", () => ({ solid: box(4, 4, 5).named("b"), ports: {} }))({});\n`);
  await new Promise((ok) => setTimeout(ok, 400));
  await waitBuilt("main.cad.ts");
  assert.equal((await post("/entry", { file: "parts/other.cad.ts" })).status, 200);
  const shown: any = await nextEvent((e) => e.type === "hello");
  assert.equal(shown.built, false, "an out-of-date build is not shown");
  for (let i = 0; ; i++) {
    const e: any = await nextEvent((x) => x.type === "hello");
    if (!e.building && e.tabs[1].version > version) break;
    assert.ok(i < 100, "stale tab did not rebuild");
    await new Promise((ok) => setTimeout(ok, 100));
  }
});

test("closing a tab shows its neighbour and forgets its build", async () => {
  assert.equal((await post("/tab/close", { file: "parts/other.cad.ts" })).status, 200);
  const e: any = await nextEvent((x) => x.type === "hello");
  assert.equal(e.entry, "main.cad.ts");
  assert.equal(e.tabs.length, 1);
  assert.equal((await fetch(`${URL_BASE}/model?file=parts/other.cad.ts`)).status, 404);
});

test("a STEP file opens directly, has no source panel, and rebuilds on save", async () => {
  const exportTo = (entry: string) =>
    assert.equal(spawnSync(process.execPath, [CLI, "export", entry, "--out", "Part One.STEP"], { cwd: root }).status, 0);
  const listed = nextEvent((e) => e.type === "files" && e.files.includes("Part One.STEP"));
  await new Promise((ok) => setTimeout(ok, 100));
  exportTo("main.cad.ts");
  await listed;

  const file = encodeURIComponent("Part One.STEP");
  const part = async () => {
    const res = await fetch(`${URL_BASE}/model?file=${file}`);
    return res.ok ? ((await res.json()) as any).model.parts[0] : undefined;
  };
  assert.equal((await post("/entry", { file: "Part One.STEP" })).status, 200);
  await waitBuilt("Part One.STEP");
  const first = await part();
  assert.equal(first.type, "Part One");
  assert.equal(first.faces[0].id, "Part One.face[0]");
  assert.deepEqual(first.bbox.size, [1, 2, 3]);
  assert.equal((await fetch(`${URL_BASE}/source?file=${file}`)).status, 404);

  exportTo("parts/other.cad.ts");
  for (let i = 0; String((await part())?.bbox.size) !== "4,4,5"; i++) {
    assert.ok(i < 100, "saving the STEP file did not rebuild");
    await new Promise((ok) => setTimeout(ok, 100));
  }
  assert.equal((await post("/tab/close", { file: "Part One.STEP" })).status, 200);
});

test("a build stays on disk, and shows at once after a restart while it is fresh", async () => {
  const small = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-keep-")));
  const source = (name: string) => `import { box, part } from "vibecad";\nexport default part("${name}", () => ({ solid: box(1, 1, 1).named("a"), ports: {} }))({});\n`;
  writeFileSync(join(small, "a.cad.ts"), source("A"));
  writeFileSync(join(small, "b.cad.ts"), source("B"));
  const port = PORT + 1;
  const base = `http://127.0.0.1:${port}`;
  const postTo = (path: string, body: unknown) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  const shown = async (file: string) => {
    for (let i = 0; i < 100; i++) {
      const res = await fetch(`${base}/model?file=${file}`);
      if (res.ok) return ((await res.json()) as any).model.parts[0].type;
      await new Promise((ok) => setTimeout(ok, 100));
    }
    assert.fail(`${file} did not build`);
  };
  /** Starts the app, opens the project on `file`, and returns the status of /model right after. */
  const reopen = async (file: string, run: () => Promise<void>) => {
    const app = startApp({ port });
    await new Promise((ok) => app.stdout.once("data", ok));
    try {
      await postTo("/project", { path: small, entry: file, tabs: ["a.cad.ts", "b.cad.ts"] });
      await run();
    } finally {
      const gone = new Promise((ok) => app.once("close", ok));
      app.kill();
      await gone;
    }
  };
  try {
    await reopen("a.cad.ts", async () => {
      assert.equal(await shown("a.cad.ts"), "A");
      await postTo("/entry", { file: "b.cad.ts" });
      assert.equal(await shown("b.cad.ts"), "B");
      assert.equal(await shown("a.cad.ts"), "A", "a tab off screen serves its build from disk");
    });
    writeFileSync(join(small, "b.cad.ts"), source("C"));
    await reopen("a.cad.ts", async () => {
      assert.equal((await fetch(`${base}/model?file=a.cad.ts`)).status, 200, "a fresh build shows at once");
      await postTo("/entry", { file: "b.cad.ts" });
      assert.equal((await fetch(`${base}/model?file=b.cad.ts`)).status, 404, "an out-of-date build is not shown");
      assert.equal(await shown("b.cad.ts"), "C");
    });
  } finally {
    rmSync(small, { recursive: true, force: true });
  }
});

test("stopping the app stops its running build", { skip: process.platform === "win32" }, async () => {
  const slow = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-slow-")));
  writeFileSync(join(slow, "main.cad.ts"), `import { box, part } from "vibecad";
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
export default part("S", () => box(1, 1, 1))();
`);
  const port = PORT + 7;
  const running = startApp({ port });
  await new Promise((ok) => running.stdout.once("data", ok));
  try {
    await fetch(`http://127.0.0.1:${port}/project`, { method: "POST", body: JSON.stringify({ path: slow, entry: "main.cad.ts" }) });
    const children = () => spawnSync("pgrep", ["-P", String(running.pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean).map(Number);
    let build: number | undefined;
    for (let i = 0; i < 100 && build === undefined; i++) {
      build = children()[0];
      if (build === undefined) await new Promise((ok) => setTimeout(ok, 50));
    }
    assert.ok(build, "the build started");
    const gone = new Promise((ok) => running.once("close", ok));
    running.kill();
    await gone;
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(build, 0);
        await new Promise((ok) => setTimeout(ok, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "the build outlived the app");
  } finally {
    running.kill();
    rmSync(slow, { recursive: true, force: true });
  }
});

test("a bad setting stops the app and names the file", async () => {
  for (const [config, text] of [[{ port: -1 }, "port"], [{ typo: 1 }, "typo"]] as const) {
    const child = startApp(config);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    assert.equal(await new Promise((ok) => child.on("close", ok)), 1);
    const { error } = JSON.parse(out);
    assert.equal(error.code, "BAD_CONFIG");
    assert.match(error.message, new RegExp(text));
    assert.match(error.message, /config\.json/);
  }
});

test("settings are not CLI flags", () => {
  const r = spawnSync(process.execPath, [CLI, "dev", "--port", "1"], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.equal(JSON.parse(r.stdout).ok, false);
});

test("a file is one instance; an assembly places only files' instances, builds each part once, and keeps its build", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-cascade-")));
  try {
    const block = `import { box, part, port } from "vibecad";\n` +
      `const Block = part("Block", (p: { h: number }) => ({ solid: box(10, 10, p.h).named("b"), ports: { top: port([0, 0, p.h]), bottom: port([0, 0, 0], [0, 0, -1]) } }));\n`;
    writeFileSync(join(dir, "block.cad.ts"), block + `export default Block({ h: 2 });\n`);
    writeFileSync(join(dir, "main.cad.ts"),
      `import { assembly, mate, place } from "vibecad";\nimport block from "./block.cad.ts";\n` +
      `export default assembly("Stack", () => {\n  const a = block, b = place(block);\n` +
      `  return { parts: { a, b }, mates: [mate(a.port("top"), b.port("bottom"))] };\n})();\n`);
    const cli = (...args: string[]) => JSON.parse(spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: "utf8" }).stdout);
    const built = cli("build", "main.cad.ts");
    assert.equal(built.ok, true);
    assert.deepEqual(built.parts.map((p: any) => p.size[2]), [2, 2]);
    assert.ok(existsSync(join(dir, ".vibecad/builds/block.cad.ts/shape.brep")), "the part's own build is kept");
    assert.equal(cli("build", "block.cad.ts").ok, true);

    writeFileSync(join(dir, "loose.cad.ts"),
      `import { assembly, box, part } from "vibecad";\n` +
      `export default assembly("Loose", () => ({ parts: { a: part("A", () => box(1, 1, 1))() } }))();\n`);
    assert.equal(cli("build", "loose.cad.ts").error.code, "NOT_EXPORTED");
    writeFileSync(join(dir, "twice.cad.ts"),
      `import { assembly } from "vibecad";\nimport block from "./block.cad.ts";\n` +
      `export default assembly("Twice", () => ({ parts: { a: block, b: block } }))();\n`);
    assert.equal(cli("build", "twice.cad.ts").error.code, "PLACED_TWICE");
    writeFileSync(join(dir, "two.cad.ts"), block + `export const low = Block({ h: 1 });\nexport default Block({ h: 2 });\n`);
    assert.equal(cli("build", "two.cad.ts").error.code, "MANY_INSTANCES");
    writeFileSync(join(dir, "none.cad.ts"), block + `export const low = Block({ h: 1 });\n`);
    assert.equal(cli("build", "none.cad.ts").error.code, "BAD_ENTRY");

    // A changed part rebuilds; the assembly picks it up.
    writeFileSync(join(dir, "block.cad.ts"), block + `export default Block({ h: 3 });\n`);
    assert.deepEqual(cli("build", "main.cad.ts").parts.map((p: any) => p.size[2]), [3, 3]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
