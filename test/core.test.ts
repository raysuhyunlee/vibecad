import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  assembly, box, check, cylinder, edges, importStep, mate, minClearance, part, port,
} from "../src/index.ts";
import { build, CadError, getKernel } from "../src/eval.ts";

const plate = part("Plate", (p: { hole?: number }) =>
  box(40, 20, 5).named("base").cut(cylinder(p.hole ?? 2, 10).named("bore").translate(0, 0, -1)),
);

test("faces keep their names through booleans, and point at source", async () => {
  const { model } = await build(plate());
  const faces = model.parts[0]!.faces;
  const bore = faces.find((f) => f.id === "bore.side");
  assert.equal(bore?.surface, "cylinder");
  assert.match(bore!.src.file, /core\.test\.ts$/);
  assert.equal(bore!.src.line, 11);
  assert.ok(faces.find((f) => f.id === "base.top"));
  assert.equal(new Set(faces.map((f) => f.id)).size, faces.length);
});

test("names survive a parameter change, so selectors stay stable", async () => {
  const a = await build(plate({ hole: 2 }));
  const b = await build(plate({ hole: 5 }));
  const ids = (m: typeof a) => m.model.parts[0]!.faces.map((f) => f.id).sort();
  assert.deepEqual(ids(a), ids(b));
  assert.notEqual(a.model.hash, b.model.hash);
});

test("fillet selects edges by meaning, and its faces get the feature name", async () => {
  const solid = box(20, 20, 20).named("b").fillet(2, edges.of("b.top").parallel("x")).named("round");
  const { model } = await build(part("F", () => solid)());
  assert.equal(model.parts[0]!.faces.filter((f) => f.name === "round").length, 2);
});

test("an empty selection reports the source line and the available faces", async () => {
  const solid = box(20, 20, 20).named("b").fillet(1, edges.of("nope"));
  await assert.rejects(build(part("F", () => solid)()), (e: CadError) => {
    assert.equal(e.code, "EMPTY_SELECTION");
    assert.match(e.src!.file, /core\.test\.ts$/);
    assert.match(e.hint!, /b\.top/);
    return true;
  });
});

test("mates place parts, nest through assemblies, and run checks", async () => {
  const block = part("Block", () => ({
    solid: box(10, 10, 10).named("b"),
    ports: { top: port([0, 0, 10]), bottom: port([0, 0, 0], [0, 0, -1]) },
  }));
  const stack = assembly("Stack", () => {
    const a = block(), b = block();
    return { parts: { a, b }, mates: [mate(a.port("top"), b.port("bottom"))], ports: { top: b.port("top") } };
  });
  const top = assembly("Top", () => {
    const s = stack(), c = block(), far = block();
    return {
      parts: { s, c, far },
      mates: [mate(s.port("top"), c.port("bottom")), mate(c.port("top"), far.port("bottom"), { gap: 3 })],
      checks: [
        minClearance(c, far, 3),
        check("impossible", () => false),
      ],
    };
  });
  const { model } = await build(top());
  const at = (path: string) => model.parts.find((p) => p.path === path)!.bbox;
  assert.deepEqual(at("s/b").min, [-5, -5, 10]);
  assert.deepEqual(at("c").min, [-5, -5, 20]);
  assert.deepEqual(at("far").min, [-5, -5, 33]);
  assert.deepEqual(model.checks.map((c) => c.pass), [true, false]);
});

test("an unconnected part is an error, not a part at the origin", async () => {
  const b = part("B", () => box(1, 1, 1));
  const top = assembly("T", () => ({ parts: { a: b(), loose: b() } }));
  await assert.rejects(build(top()), (e: CadError) => e.code === "UNPLACED_PART");
});

test("the CLI builds deterministically across processes and prints pure JSON", () => {
  const run = () =>
    JSON.parse(execFileSync(process.execPath, ["src/cli.ts", "build", "examples/servo-bracket/main.cad.ts"], { stdio: ["ignore", "pipe", "ignore"] }).toString());
  const a = run(), b = run();
  assert.equal(a.ok, true);
  assert.equal(a.hash, b.hash);
  assert.ok(a.checks.every((c: { pass: boolean }) => c.pass));
});

test("STEP export stays valid JSON on stdout despite kernel chatter", () => {
  const out = execFileSync(
    process.execPath,
    ["src/cli.ts", "export", "examples/servo-bracket/main.cad.ts", "--out", ".vibecad/out/test.step"],
    { stdio: ["ignore", "pipe", "ignore"] },
  ).toString();
  assert.equal(JSON.parse(out).ok, true);
});

test("an imported STEP solid keeps its geometry, takes features, and points at source", async () => {
  const k = await getKernel();
  const original = await build(plate());
  mkdirSync(".vibecad/out", { recursive: true });
  writeFileSync(".vibecad/out/plate.step", k.exportStep([...original.shapes.values()][0]!));

  const imported = () => importStep("../.vibecad/out/plate.step").named("plate");
  const { model } = await build(part("Imported", imported)());
  const p = model.parts[0]!;
  assert.ok(Math.abs(p.volume - original.model.parts[0]!.volume) < 1e-3);
  assert.equal(p.faces.length, original.model.parts[0]!.faces.length);
  assert.equal(p.faces[0]!.id, "plate.face[0]");
  assert.match(p.faces[0]!.src.file, /core\.test\.ts$/);

  const edited = imported().translate(0, 0, 5).cut(box(4, 4, 20).named("slot").translate(10, 0, 0));
  const after = (await build(part("Edited", () => edited)())).model.parts[0]!;
  assert.ok(after.faces.some((f) => f.name === "slot.left"));
  assert.ok(after.faces.some((f) => f.name.startsWith("plate.face[")));
  assert.equal(after.bbox.min[2], 5);
});

test("a bad STEP file reports its code and source line", async () => {
  await assert.rejects(build(part("Missing", () => importStep("nope.step"))()), (e: CadError) => {
    assert.equal(e.code, "STEP_NOT_FOUND");
    assert.match(e.src!.file, /core\.test\.ts$/);
    return true;
  });
  mkdirSync(".vibecad/out", { recursive: true });
  writeFileSync(".vibecad/out/bad.step", "not a step file");
  await assert.rejects(build(part("Bad", () => importStep("../.vibecad/out/bad.step"))()), (e: CadError) => {
    assert.ok(["OP_FAILED", "EMPTY_RESULT"].includes(e.code));
    assert.match(e.hint!, /valid STEP/);
    return true;
  });
});

test("mesh face groups cover every triangle exactly once", async () => {
  const { meshes } = await build(plate());
  const m = meshes[0]!;
  let next = 0;
  for (let i = 0; i < m.faceGroups.length; i += 3) {
    assert.equal(m.faceGroups[i], next);
    assert.ok(m.faceGroups[i + 2]! >= 0);
    next += m.faceGroups[i + 1]!;
  }
  assert.equal(next, m.indices.length / 3);
});
