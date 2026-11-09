import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  assembly, box, check, cylinder, edges, importStep, mate, minClearance, noCollision, part, port, revolute, slider,
} from "../src/index.ts";
import { build, CadError, getKernel } from "../src/eval.ts";
import type { Vec3 } from "../src/lang.ts";

const plate = part("Plate", (p: { hole?: number }) =>
  box(40, 20, 5).named("base").cut(cylinder(p.hole ?? 2, 10).named("bore").translate(0, 0, -1)),
);

test("faces keep their names through booleans, and point at source", async () => {
  const { model } = await build(plate());
  const faces = model.parts[0]!.faces;
  const bore = faces.find((f) => f.id === "bore.side");
  assert.equal(bore?.surface, "cylinder");
  assert.match(bore!.src.file, /core\.test\.ts$/);
  assert.equal(bore!.src.line, 12);
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

const bar = part("Bar", () => ({
  solid: box(20, 2, 2).named("b").translate(10, 0, 0),
  ports: {
    hub: port([0, 0, 0], [0, 0, -1]),
    tip: port([20, 0, 2]),
  },
}));

test("a revolute joint turns the moving part, and carries the parts after it", async () => {
  const arm = assembly("Arm", () => {
    const base = bar(), link = bar(), end = bar();
    return {
      parts: { base, link, end },
      mates: [mate(link.port("tip"), end.port("hub"))],
      joints: { pan: revolute(base.port("tip"), link.port("hub"), { min: -90, max: 90 }) },
    };
  });
  const rest = (await build(arm())).model;
  assert.deepEqual(rest.joints[0]!.moves, ["link", "end"]);
  const { model } = await build(arm(), { pose: { pan: 90 } });
  const at = (path: string) => model.parts.find((p) => p.path === path)!.bbox;
  assert.deepEqual(at("base"), rest.parts.find((p) => p.path === "base")!.bbox);
  assert.ok(Math.abs(at("link").size[1] - 20) < 1e-3);
  assert.equal(model.joints[0]!.value, 90);
});

test("a joint means the same whichever side is fixed", async () => {
  const relative = async (swap: boolean) => {
    const top = assembly("T", () => {
      const a = bar(), b = bar();
      const j = revolute(a.port("tip"), b.port("hub"), { angle: 30 });
      return { parts: swap ? { b, a } : { a, b }, joints: { j } };
    });
    const { model } = await build(top());
    const size = (path: string) => model.parts.find((p) => p.path === path)!.bbox.size;
    return [size("a"), size("b")].flat().map((v) => Math.round(v * 1e3)).sort();
  };
  assert.deepEqual(await relative(false), await relative(true));
});

test("the joint data reproduces a rebuilt pose, as the viewer uses it", async () => {
  const chain = assembly("Chain", () => {
    const base = bar(), one = bar(), two = bar();
    return {
      parts: { base, one, two },
      joints: {
        first: revolute(base.port("tip"), one.port("hub"), { angle: 10 }),
        second: revolute(one.port("tip"), two.port("hub"), { angle: -20 }),
      },
    };
  });
  const rest = (await build(chain())).model;
  const posed = (await build(chain(), { pose: { first: 55, second: 40 } })).model;
  const turn = (p: Vec3, o: Vec3, a: Vec3, deg: number): Vec3 => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]] as Vec3;
    const d = a[0] * v[0] + a[1] * v[1] + a[2] * v[2];
    const x: Vec3 = [a[1] * v[2] - a[2] * v[1], a[2] * v[0] - a[0] * v[2], a[0] * v[1] - a[1] * v[0]];
    return [0, 1, 2].map((i) => v[i]! * c + x[i]! * s + a[i]! * d * (1 - c) + o[i]!) as Vec3;
  };
  const values: Record<string, number> = { first: 55, second: 40 };
  for (const part of rest.parts) {
    for (const face of part.faces) {
      let p = face.center;
      // Innermost first, which is the matrix product the viewer builds from the outermost.
      for (const j of [...rest.joints].reverse()) {
        if (j.moves.includes(part.path)) p = turn(p, j.origin, j.axis, values[j.path]! - j.value);
      }
      const want = posed.parts.find((x) => x.path === part.path)!.faces.find((f) => f.id === face.id)!.center;
      p.forEach((v, i) => assert.ok(Math.abs(v - want[i]!) < 1e-3, `${part.path} ${face.id}`));
    }
  }
});

test("a slider moves along the fixed port, and out-of-range values are errors", async () => {
  const rail = assembly("Rail", () => {
    const a = bar(), b = bar();
    return { parts: { a, b }, joints: { lift: slider(a.port("tip"), b.port("hub"), { min: 0, max: 50, travel: 10 }) } };
  });
  const z = async (lift: number) => (await build(rail(), { pose: { lift } })).model.parts.find((p) => p.path === "b")!.bbox.min[2];
  assert.equal((await z(30)) - (await z(5)), 25);
  await assert.rejects(build(rail(), { pose: { lift: 51 } }), (e: CadError) => e.code === "JOINT_OUT_OF_RANGE");
  await assert.rejects(build(rail(), { pose: { nope: 1 } }), (e: CadError) => e.code === "NO_SUCH_JOINT" && /lift/.test(e.hint!));
});

test("a closed loop of joints is refused", async () => {
  const loop = assembly("Loop", () => {
    const a = bar(), b = bar();
    return { parts: { a, b }, mates: [mate(a.port("tip"), b.port("hub"))], joints: { j: revolute(a.port("tip"), b.port("hub")) } };
  });
  await assert.rejects(build(loop()), (e: CadError) => e.code === "OVER_CONSTRAINED");
});

test("sweeps run only when asked, and report the first colliding value", async () => {
  // The arm turns from +x toward -y, into a post standing at y = -15.
  const stand = part("Stand", () => ({
    solid: box(10, 10, 1).named("base").union(box(2, 2, 10).named("post").translate(0, -15, 0)),
    ports: { pivot: port([0, 0, 1]) },
  }));
  const swing = (max: number) => assembly("Swing", () => {
    const base = stand(), arm = bar();
    const pan = revolute(base.port("pivot"), arm.port("hub"), { min: 0, max });
    return {
      parts: { base, arm },
      joints: { pan },
      checks: [
        noCollision(arm, base, { joint: pan, steps: max / 10 + 1 }),
        check("query at a pose", (q) => q.at(pan, max).bbox(arm).size[1] > q.bbox(arm).size[1]),
      ],
    };
  })();
  const plain = await build(swing(90));
  assert.deepEqual(plain.model.checks.map((c) => c.name), ["query at a pose"]);
  assert.equal(plain.model.checks[0]!.pass, true);

  const hit = (await build(swing(90), { sweeps: true })).model.checks[0]!;
  assert.equal(hit.pass, false);
  assert.deepEqual(hit.failedAt, { joint: "pan", value: 90 });
  assert.equal((await build(swing(80), { sweeps: true })).model.checks[0]!.pass, true);
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
