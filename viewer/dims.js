// Lays out dimensions over a reference image, CAD style. Everything is in screen pixels.
//
// A dim: { kind: "length" | "diameter" | "radius" | "angle", a, b, c?, w, h } where w and h are its label's size.
//   length and diameter span a to b; radius runs from the center a to b on the circle; angle opens at c from ray c-a to ray c-b.
// Its layout: { label: { c, t, up, w, h, deg }, lines, ext, arrows, arc? }
//   the label is centered at c and reads along t; lines are the dim line, ext the extension lines,
//   arrows are { at, dir } with dir pointing into the tip, and arc is { c, r, from, to } in radians.

const GAP = 4; // label to its dim line
export const ARROW = 9;
const STEP = 26; // each try moves a dim line this much further off its points
const EXT = 5; // extension lines run past the dim line
const HANDLE = 9;
const TURNS = [0, 30, -30, 60, -60, 90].map((d) => (d * Math.PI) / 180); // tries for a diameter or radius line

const add = (p, q) => [p[0] + q[0], p[1] + q[1]];
const sub = (p, q) => [p[0] - q[0], p[1] - q[1]];
const mul = (p, k) => [p[0] * k, p[1] * k];
const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
const len = (p) => Math.hypot(p[0], p[1]);
const unit = (p) => (len(p) > 1e-9 ? mul(p, 1 / len(p)) : [1, 0]);
const turn = (p, a) => [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a)];
const polar = (a) => [Math.cos(a), Math.sin(a)];

/** Text reads left to right along t, or bottom to top when upright; up is t turned a quarter left on screen. */
function textFrame(u) {
  const t = u[0] < -1e-6 || (Math.abs(u[0]) <= 1e-6 && u[1] > 0) ? mul(u, -1) : u;
  return { t, up: [t[1], -t[0]] };
}
function label(c, f, w, h) {
  return { c, t: f.t, up: f.up, w, h, deg: (Math.atan2(f.t[1], f.t[0]) * 180) / Math.PI };
}
function corners(r) {
  const hw = mul(r.t, r.w / 2), hh = mul(r.up, r.h / 2);
  return [add(add(r.c, hw), hh), add(sub(r.c, hw), hh), sub(sub(r.c, hw), hh), sub(add(r.c, hw), hh)];
}
const grow = (r, m) => ({ ...r, w: r.w + 2 * m, h: r.h + 2 * m });
function overlap(a, b) {
  const ca = corners(a), cb = corners(b);
  for (const axis of [a.t, a.up, b.t, b.up]) {
    const pa = ca.map((p) => dot(p, axis)), pb = cb.map((p) => dot(p, axis));
    if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
  }
  return true;
}
const local = (r, p) => [dot(sub(p, r.c), r.t), dot(sub(p, r.c), r.up)];
const holds = (r, p) => {
  const l = local(r, p);
  return Math.abs(l[0]) <= r.w / 2 && Math.abs(l[1]) <= r.h / 2;
};
/** Whether segment pq crosses label r (Liang-Barsky in the label's frame). */
function crosses(r, [p, q]) {
  const a = local(r, p), b = local(r, q);
  const d = sub(b, a);
  let t0 = 0, t1 = 1;
  for (const [pp, qq] of [[-d[0], a[0] + r.w / 2], [d[0], r.w / 2 - a[0]], [-d[1], a[1] + r.h / 2], [d[1], r.h / 2 - a[1]]]) {
    if (pp === 0) {
      if (qq < 0) return false;
      continue;
    }
    const t = qq / pp;
    if (pp < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}
function arcPoints(arc, n = 12) {
  const out = [];
  for (let i = 0; i <= n; i++) out.push(add(arc.c, mul(polar(arc.from + ((arc.to - arc.from) * i) / n), arc.r)));
  return out;
}
function segmentsOf(g) {
  const out = [...g.lines, ...g.ext];
  if (g.arc) {
    const pts = arcPoints(g.arc);
    for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
  }
  return out;
}

/**
 * A length dim line between p and q, `off` across, with its label `side` up or down,
 * between the arrows or beyond either end. A radius has one arrow, at q.
 */
function linear(p, q, off, side, place, w, h, radius) {
  const f = textFrame(unit(sub(q, p)));
  const shift = mul(f.up, off);
  const P = add(p, shift), Q = add(q, shift);
  const [lo, hi] = dot(P, f.t) <= dot(Q, f.t) ? [P, Q] : [Q, P];
  const span = len(sub(Q, P));
  const lift = mul(f.up, side * (h / 2 + GAP));
  const out = mul(f.t, ARROW + 4 + w);
  let c, line = [P, Q];
  if (place === "in") c = add(mul(add(P, Q), 0.5), lift);
  else if (place === "hi") {
    c = add(add(hi, mul(f.t, ARROW + 4 + w / 2)), lift);
    line = [lo, add(hi, out)];
  } else {
    c = add(sub(lo, mul(f.t, ARROW + 4 + w / 2)), lift);
    line = [sub(lo, out), hi];
  }
  const dir = unit(sub(Q, P));
  const arrows = radius ? [{ at: Q, dir }] : [{ at: P, dir: mul(dir, -1) }, { at: Q, dir }];
  const ext = off === 0 ? [] : [[p, add(P, mul(unit(shift), EXT))], [q, add(Q, mul(unit(shift), EXT))]];
  return { label: label(c, f, w, h), lines: [line], ext, arrows, fits: span >= w + 2 * ARROW + 6 };
}

/** An angle's arc at radius r, with its label outside the arc: at its middle, or beyond either end. */
function angular(d, r, place, w, h) {
  const from = Math.atan2(d.a[1] - d.c[1], d.a[0] - d.c[0]);
  let sweep = Math.atan2(d.b[1] - d.c[1], d.b[0] - d.c[0]) - from;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  const to = from + sweep, s = Math.sign(sweep) || 1;
  const reach = (ARROW + 4 + w / 2) / r; // the label's half length past an end, as an angle
  const at = place === "in" ? from + sweep / 2 : place === "hi" ? to + s * reach : from - s * reach;
  const radial = polar(at);
  const f = textFrame([-radial[1], radial[0]]);
  const e = Math.abs(dot(radial, f.t)) * w / 2 + Math.abs(dot(radial, f.up)) * h / 2;
  const c = add(d.c, mul(radial, r + GAP + e));
  const arc = { c: d.c, r, from: place === "lo" ? from - s * 2 * reach : from, to: place === "hi" ? to + s * 2 * reach : to };
  const tangent = (a, k) => mul([-Math.sin(a), Math.cos(a)], k);
  const arrows = [{ at: add(d.c, mul(polar(from), r)), dir: tangent(from, -s) }, { at: add(d.c, mul(polar(to), r)), dir: tangent(to, s) }];
  const ext = [];
  for (const [p, a] of [[d.a, from], [d.b, to]]) if (len(sub(p, d.c)) < r) ext.push([p, add(d.c, mul(polar(a), r + EXT))]);
  return { label: label(c, f, w, h), lines: [], ext, arrows, arc, fits: r * Math.abs(sweep) >= w + 2 * ARROW + 6 };
}

/** Every way to draw one dim, each with a cost for straying from the plainest drawing. */
function* options(d) {
  const { w, h } = d;
  const places = [["in", 0], ["hi", 0.4], ["lo", 0.5]];
  if (d.kind === "angle") {
    const r0 = Math.max(28, 0.5 * Math.min(len(sub(d.a, d.c)), len(sub(d.b, d.c))));
    for (let k = 0; k < 8; k++) for (const [place, p] of places) yield { place, g: angular(d, r0 + k * STEP, place, w, h), pref: k * 0.6 + p };
    return;
  }
  if (d.kind === "diameter" || d.kind === "radius") {
    const pivot = d.kind === "radius" ? d.a : mul(add(d.a, d.b), 0.5);
    for (const [i, a] of TURNS.entries()) {
      const p = add(pivot, turn(sub(d.a, pivot), a)), q = add(pivot, turn(sub(d.b, pivot), a));
      for (const side of [1, -1]) for (const [place, pp] of places) {
        yield { place, g: linear(p, q, 0, side, place, w, h, d.kind === "radius"), pref: i * 0.5 + pp + (side < 0 ? 0.1 : 0) };
      }
    }
    return;
  }
  for (let k = 0; k < 13; k++) {
    const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * STEP;
    for (const side of [1, -1]) for (const [place, p] of places) {
      yield { place, g: linear(d.a, d.b, off, side, place, w, h, false), pref: Math.ceil(k / 2) * 0.6 + p + (side < 0 ? 0.1 : 0) };
    }
  }
}

/** Lays out every dim in turn, each where it covers the least of what is already there. */
export function layoutDims(dims, W, H) {
  const view = { c: [W / 2, H / 2], t: [1, 0], up: [0, -1], w: W, h: H };
  const handles = dims.flatMap((d) => [d.a, d.b, ...(d.c ? [d.c] : [])]);
  const features = dims.map((d) => (d.kind === "angle" ? [[d.c, d.a], [d.c, d.b]] : [[d.a, d.b]]));
  const labels = [], drawn = [];
  return dims.map((d, i) => {
    let best = null;
    for (const o of options(d)) {
      const { g } = o;
      if (o.place === "in" && !g.fits) continue; // a label that does not fit between the arrows goes outside
      const box = grow(g.label, GAP);
      let cost = o.pref;
      if (!corners(g.label).every((p) => holds(view, p))) cost += 20;
      cost += labels.filter((l) => overlap(box, l)).length * 12;
      cost += handles.filter((p) => holds(grow(g.label, HANDLE), p)).length * 3;
      cost += features.filter((s, j) => j !== i).flat().filter((s) => crosses(box, s)).length * 2;
      cost += drawn.filter((s) => crosses(box, s)).length * 2;
      cost += segmentsOf(g).reduce((n, s) => n + labels.filter((l) => crosses(l, s)).length, 0) * 4;
      if (!best || cost < best.cost) best = { g, cost };
    }
    labels.push(best.g.label);
    drawn.push(...segmentsOf(best.g));
    return best.g;
  });
}
