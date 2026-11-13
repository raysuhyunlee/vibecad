import { cylinder, extrude, part, polygon, port, type Profile } from "vibecad";

// Standard parts at nominal size, without threads. Check the supplier's datasheet before fabricating.

/** A regular hexagon by its width across flats, with flats parallel to x. */
function hexagon(acrossFlats: number): Profile {
  const r = acrossFlats / Math.sqrt(3); // corner radius
  return polygon(Array.from({ length: 6 }, (_, i) => [r * Math.cos((i * Math.PI) / 3), r * Math.sin((i * Math.PI) / 3)] as [number, number]));
}

/** A flat ring from z=0 up, with `bottom` and `top` ports facing out of its faces. */
function ring(name: string, outer: number, inner: number, height: number) {
  return {
    solid: cylinder(outer / 2, height).named(name).cut(cylinder(inner / 2, height + 2).named("bore").translate(0, 0, -1)),
    ports: { bottom: port([0, 0, 0], [0, 0, -1]), top: port([0, 0, height]) },
  };
}

export type Metric = "M3" | "M4" | "M5";

// ISO 4762 socket head cap screw: head diameter, head height, hex key size, socket depth.
const SOCKET_HEAD: Record<Metric, { d: number; dk: number; k: number; s: number; t: number }> = {
  M3: { d: 3, dk: 5.5, k: 3, s: 2.5, t: 1.3 },
  M4: { d: 4, dk: 7, k: 4, s: 3, t: 2 },
  M5: { d: 5, dk: 8.5, k: 5, s: 4, t: 2.5 },
};
// ISO 4032 hex nut: width across flats, height.
const HEX_NUT: Record<Metric, { d: number; s: number; m: number }> = {
  M3: { d: 3, s: 5.5, m: 2.4 },
  M4: { d: 4, s: 7, m: 3.2 },
  M5: { d: 5, s: 8, m: 4.7 },
};
// ISO 7089 plain washer: inner and outer diameter, thickness.
const WASHER: Record<Metric, { d1: number; d2: number; h: number }> = {
  M3: { d1: 3.2, d2: 7, h: 0.5 },
  M4: { d1: 4.3, d2: 9, h: 0.8 },
  M5: { d1: 5.3, d2: 10, h: 1 },
};
// Deep groove ball bearings: bore, outer diameter, width.
const BEARING = {
  "625": { d: 5, D: 16, B: 5 },
  "608": { d: 8, D: 22, B: 7 },
  "6001": { d: 12, D: 28, B: 8 },
} as const;
export type BearingCode = keyof typeof BEARING;

/** ISO 4762 socket head cap screw. The head sits on z=0 with the shank down -z; `seat` is under the head, `tip` at the shank's end. */
export const bolt = part("Bolt", (p: { size: Metric; length: number }) => {
  const b = SOCKET_HEAD[p.size];
  const head = cylinder(b.dk / 2, b.k).named("head");
  const socket = extrude(hexagon(b.s), b.t + 1).named("socket").translate(0, 0, b.k - b.t);
  const shank = cylinder(b.d / 2, p.length).named("shank").translate(0, 0, -p.length);
  return {
    solid: head.cut(socket).union(shank),
    ports: { seat: port([0, 0, 0], [0, 0, -1]), tip: port([0, 0, -p.length], [0, 0, -1]) },
  };
});

/** ISO 4032 hex nut, from z=0 up. */
export const nut = part("Nut", (p: { size: Metric }) => {
  const n = HEX_NUT[p.size];
  return {
    solid: extrude(hexagon(n.s), n.m).named("nut").cut(cylinder(n.d / 2, n.m + 2).named("bore").translate(0, 0, -1)),
    ports: { bottom: port([0, 0, 0], [0, 0, -1]), top: port([0, 0, n.m]) },
  };
});

/** ISO 7089 plain washer, from z=0 up. */
export const washer = part("Washer", (p: { size: Metric }) => {
  const w = WASHER[p.size];
  return ring("washer", w.d2, w.d1, w.h);
});

/** Deep groove ball bearing as its envelope, from z=0 up. */
export const bearing = part("Bearing", (p: { code: BearingCode }) => {
  const b = BEARING[p.code];
  return ring("bearing", b.D, b.d, b.B);
});
