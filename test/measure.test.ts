import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
// @ts-expect-error the viewer is plain JavaScript
import { measure } from "../viewer/measure.js";
import { build } from "../src/eval.ts";
import { box, cylinder, part } from "../src/index.ts";

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const circle = (c: THREE.Vector3, r: number) => ({
  type: "edge", kind: "circle", length: 2 * Math.PI * r, points: [],
  circle: { center: c, axis: v(0, 0, 1), x: v(1, 0, 0), y: v(0, 1, 0), radius: r, first: 0, last: 2 * Math.PI },
});
const line = (a: THREE.Vector3, b: THREE.Vector3) => ({ type: "edge", kind: "line", length: a.distanceTo(b), points: [a, b] });
const rows = (items: unknown[]) => Object.fromEntries(measure(items).map((r: { label: string; value: string }) => [r.label, r.value]));

test("one circle gives its diameter, one line its length", () => {
  assert.deepEqual(rows([circle(v(0, 0, 0), 2)]), { Diameter: "4 mm" });
  assert.deepEqual(rows([line(v(0, 0, 0), v(3, 4, 0))]), { Length: "5 mm" });
});

test("two circles give center, min and max distance", () => {
  assert.deepEqual(rows([circle(v(0, 0, 0), 2), circle(v(10, 0, 0), 3)]), {
    "Center distance": "10 mm", "Min distance": "5 mm", "Max distance": "15 mm",
  });
});

test("two lines give their shortest distance, and the distance between them when parallel", () => {
  assert.deepEqual(rows([line(v(0, 0, 0), v(10, 0, 0)), line(v(20, 3, 0), v(30, 3, 0))]), {
    "Min distance": "10.44 mm", Distance: "3 mm",
  });
  assert.deepEqual(rows([line(v(0, 0, 0), v(10, 0, 0)), line(v(5, -5, 2), v(5, 5, 2))]), { "Min distance": "2 mm", Angle: "90°" });
});

test("a build carries each edge once, with exact circles, and each face's surface", async () => {
  const { meshes } = await build(part("P", () => box(20, 10, 5).named("b").cut(cylinder(2, 10).named("h")))());
  const m = meshes[0]!;
  assert.equal(m.edges!.filter((e) => e.kind === "line").length, 12);
  assert.deepEqual(m.edges!.filter((e) => e.kind === "circle").map((e) => e.radius), [2, 2]);
  assert.equal(m.faceGeom!.filter((f) => f.kind === "cylinder" && f.radius === 2).length, 1);
});
