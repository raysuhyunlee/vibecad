import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;
const root = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-lib-")));
const home = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-lib-home-")));
after(() => [root, home].forEach((d) => rmSync(d, { recursive: true, force: true })));

function cli(...args: string[]) {
  return cliIn(root, ...args);
}
function cliIn(cwd: string, ...args: string[]) {
  try {
    return JSON.parse(execFileSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, HOME: home }, encoding: "utf8" }));
  } catch (e: any) {
    return JSON.parse(e.stdout);
  }
}

writeFileSync(join(root, "main.cad.ts"), `import { assembly, mate, place } from "vibecad";
import bolt from "lib:std/bolt-m3x8";
import w from "./washer.cad.ts";
export default assembly("A", () => {
  const b2 = place(bolt);
  return { parts: { w, bolt, b2 }, mates: [mate(w.port("top"), bolt.port("seat")), mate(w.port("top"), b2.port("seat"))] };
})();
`);
writeFileSync(join(root, "washer.cad.ts"), `import { washer } from "factory:std";\nexport default washer({ size: "M3" });\n`);

test("an assembly places library instances, and a shared library's build is kept in the home folder", () => {
  const r = cli("build", "main.cad.ts");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.parts.map((p: any) => p.type), ["Washer", "Bolt", "Bolt"]);
  assert.ok(existsSync(join(home, ".vibecad/builds/lib/std/bolt-m3x8.cad.ts/shape.brep")));
  assert.ok(existsSync(join(root, ".vibecad/builds/washer.cad.ts/shape.brep")));
});

test("another project reuses a shared library's build", () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), "vibecad-lib-other-")));
  after(() => rmSync(other, { recursive: true, force: true }));
  cpSync(join(root, "main.cad.ts"), join(other, "main.cad.ts"));
  cpSync(join(root, "washer.cad.ts"), join(other, "washer.cad.ts"));
  const kept = join(home, ".vibecad/builds/lib/std/bolt-m3x8.cad.ts/shape.brep");
  const before = statSync(kept).mtimeMs;
  assert.equal(cliIn(other, "build", "main.cad.ts").ok, true);
  assert.equal(statSync(kept).mtimeMs, before);
});

test("a project's own library folder comes before the person's and vibecad's", () => {
  mkdirSync(join(home, ".vibecad/libs/mine"), { recursive: true });
  writeFileSync(join(home, ".vibecad/libs/mine/p.cad.ts"), `import { nut } from "factory:std";\nexport default nut({ size: "M5" });\n`);
  writeFileSync(join(root, "use.cad.ts"), `import p from "lib:mine/p";\nexport default p;\n`);
  const r = cli("build", "use.cad.ts");
  assert.equal(r.parts?.[0].size[2], 4.7, JSON.stringify(r));
  mkdirSync(join(root, "libs/mine"), { recursive: true });
  writeFileSync(join(root, "libs/mine/p.cad.ts"), `import { nut } from "factory:std";\nexport default nut({ size: "M3" });\n`);
  assert.equal(cli("build", "use.cad.ts").parts[0].size[2], 2.4);
});

test("a missing library or instance says where it looked", () => {
  writeFileSync(join(root, "bad.cad.ts"), `import x from "lib:nope/a";\nexport default x;\n`);
  assert.equal(cli("build", "bad.cad.ts").error.code, "NO_LIBRARY");
  writeFileSync(join(root, "bad.cad.ts"), `import x from "lib:std/m99";\nexport default x;\n`);
  assert.equal(cli("build", "bad.cad.ts").error.code, "NO_LIBRARY");
});
