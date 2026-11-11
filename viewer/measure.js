// Measures picked faces and edges. Everything is in world coordinates.
//
// A face: { type: "face", kind, area, tris: number[] (9 per triangle), plane?: { origin, normal }, axis?: { origin, dir, radius } }
// An edge: { type: "edge", kind, length, points: Vector3[], circle?: { center, axis, x, y, radius, first, last } }
import * as THREE from "three";

const V = () => new THREE.Vector3();
const PARALLEL = 1e-6; // 1 - |cos| below this is parallel
const TAU = 2 * Math.PI;

const fmt = (v) => String(Number(v.toFixed(3)));
const mm = (v) => `${fmt(v)} mm`;
const deg = (v) => `${fmt(THREE.MathUtils.radToDeg(v))}°`;

/** Rows of { label, value } for one, two or more picked entities. */
export function measure(items) {
  if (items.length === 1) return single(items[0]);
  if (items.length === 2) return pair(items[0], items[1]);
  if (items.every((i) => i.type === "edge")) return [{ label: "Total length", value: mm(items.reduce((s, i) => s + i.length, 0)) }];
  if (items.every((i) => i.type === "face")) return [{ label: "Total area", value: `${fmt(items.reduce((s, i) => s + i.area, 0))} mm²` }];
  return [];
}

function single(i) {
  if (i.type === "face") {
    const area = { label: "Area", value: `${fmt(i.area)} mm²` };
    return i.axis?.radius ? [{ label: "Diameter", value: mm(2 * i.axis.radius) }, area] : [area];
  }
  if (i.circle) {
    return full(i.circle)
      ? [{ label: "Diameter", value: mm(2 * i.circle.radius) }]
      : [{ label: "Radius", value: mm(i.circle.radius) }, { label: "Length", value: mm(i.length) }];
  }
  return [{ label: "Length", value: mm(i.length) }];
}

function pair(a, b) {
  if (a.circle && b.circle) {
    const r = circleRange(a.circle, b.circle);
    return [
      { label: "Center distance", value: mm(a.circle.center.distanceTo(b.circle.center)) },
      { label: "Min distance", value: mm(r.min) },
      { label: "Max distance", value: mm(r.max) },
    ];
  }
  const rows = [{ label: "Min distance", value: mm(minDistance(a, b)) }];
  const la = lineOf(a), lb = lineOf(b), pa = a.plane, pb = b.plane;
  if (la && lb) rows.push(...between(la.dir, lb.dir, () => la.point.clone().sub(lb.point).cross(lb.dir).length()));
  else if (pa && pb) rows.push(...between(pa.normal, pb.normal, () => Math.abs(pb.origin.clone().sub(pa.origin).dot(pa.normal))));
  else if ((la && pb) || (pa && lb)) {
    const l = la ?? lb, p = pa ?? pb;
    const c = Math.abs(l.dir.dot(p.normal));
    rows.push(c < PARALLEL
      ? { label: "Distance", value: mm(Math.abs(l.point.clone().sub(p.origin).dot(p.normal))) }
      : { label: "Angle", value: deg(Math.PI / 2 - Math.acos(Math.min(1, c))) });
  } else if (a.axis?.radius && b.axis?.radius && a.kind === "cylinder" && b.kind === "cylinder") {
    if (1 - Math.abs(a.axis.dir.dot(b.axis.dir)) < PARALLEL) {
      rows.push({ label: "Axis distance", value: mm(b.axis.origin.clone().sub(a.axis.origin).cross(a.axis.dir).length()) });
    }
  }
  return rows;
}
/** Distance when two directions are parallel, else the angle between them. */
function between(d1, d2, distance) {
  const c = Math.abs(d1.dot(d2));
  return 1 - c < PARALLEL ? [{ label: "Distance", value: mm(distance()) }] : [{ label: "Angle", value: deg(Math.acos(Math.min(1, c))) }];
}
function lineOf(i) {
  if (i.type !== "edge" || i.kind !== "line") return null;
  const [p, q] = [i.points[0], i.points.at(-1)];
  return { point: p, dir: q.clone().sub(p).normalize() };
}

// --- Circles: exact, from the curve's own parameters ------------------------
const full = (c) => c.last - c.first >= TAU - 1e-9;
function circlePoint(c, u, out = V()) {
  return out.copy(c.center).addScaledVector(c.x, c.radius * Math.cos(u)).addScaledVector(c.y, c.radius * Math.sin(u));
}
/** The angle of the arc nearest to angle t. */
function clampAngle(c, t) {
  if (full(c)) return t;
  const s = c.first + THREE.MathUtils.euclideanModulo(t - c.first, TAU);
  if (s <= c.last) return s;
  return s - c.last < c.first + TAU - s ? c.last : c.first;
}
/** Nearest and farthest distance from point p to circle c. Distance grows with the angle away from p's own. */
function pointCircle(p, c) {
  const v = p.clone().sub(c.center);
  const h = v.dot(c.axis);
  v.addScaledVector(c.axis, -h);
  const q = v.length(), phi = Math.atan2(v.dot(c.y), v.dot(c.x));
  const at = (t) => Math.sqrt(Math.max(0, h * h + q * q + c.radius * c.radius - 2 * q * c.radius * Math.cos(t - phi)));
  return { min: at(clampAngle(c, phi)), max: at(clampAngle(c, phi + Math.PI)) };
}
function circleRange(a, b) {
  const p = V();
  const f = (u, key) => pointCircle(circlePoint(a, u, p), b)[key];
  return { min: extreme(a, (u) => f(u, "min")), max: -extreme(a, (u) => -f(u, "max")) };
}
/** The least of f over the arc: a fine scan, then golden-section search around the best sample. */
function extreme(c, f) {
  const n = 720, span = c.last - c.first;
  let best = 0, bv = Infinity;
  for (let i = 0; i <= n; i++) {
    const v = f(c.first + (span * i) / n);
    if (v < bv) [best, bv] = [i, v];
  }
  let lo = c.first + (span * Math.max(0, best - 1)) / n, hi = c.first + (span * Math.min(n, best + 1)) / n;
  const g = (Math.sqrt(5) - 1) / 2;
  for (let k = 0; k < 60; k++) {
    const m1 = hi - g * (hi - lo), m2 = lo + g * (hi - lo);
    if (f(m1) < f(m2)) hi = m2;
    else lo = m1;
  }
  return Math.min(bv, f((lo + hi) / 2));
}

// --- Minimum distance between polylines and triangle meshes -----------------
/** Each entity as segments [a, b] and triangles [a, b, c], with a bounding sphere for each. */
function primitives(i) {
  const out = [];
  const add = (pts) => {
    const center = V();
    pts.forEach((p) => center.add(p));
    center.divideScalar(pts.length);
    out.push({ pts, center, radius: Math.max(...pts.map((p) => p.distanceTo(center))) });
  };
  if (i.type === "edge") for (let k = 1; k < i.points.length; k++) add([i.points[k - 1], i.points[k]]);
  else {
    for (let k = 0; k < i.tris.length; k += 9) {
      add([0, 3, 6].map((o) => V().fromArray(i.tris, k + o)));
    }
  }
  return out;
}
export function minDistance(a, b) {
  const pa = primitives(a), pb = primitives(b);
  let best = Infinity;
  for (const x of pa) {
    for (const y of pb) {
      if (x.center.distanceTo(y.center) - x.radius - y.radius >= best) continue;
      best = Math.min(best, primDistance(x.pts, y.pts));
      if (best === 0) return 0;
    }
  }
  return best;
}
function primDistance(x, y) {
  if (x.length === 2 && y.length === 2) return segSeg(x[0], x[1], y[0], y[1]);
  if (x.length === 2) return segTri(x[0], x[1], y);
  if (y.length === 2) return segTri(y[0], y[1], x);
  let d = Infinity;
  for (let k = 0; k < 3; k++) {
    d = Math.min(d, segTri(x[k], x[(k + 1) % 3], y), segTri(y[k], y[(k + 1) % 3], x));
  }
  return d;
}

/** Closest distance between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segSeg(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s, t;
  if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(p2);
  if (a <= 1e-12) {
    s = 0;
    t = THREE.MathUtils.clamp(f / e, 0, 1);
  } else {
    const c = d1.dot(r);
    if (e <= 1e-12) {
      t = 0;
      s = THREE.MathUtils.clamp(-c / a, 0, 1);
    } else {
      const b = d1.dot(d2), denom = a * e - b * b;
      s = denom > 1e-12 ? THREE.MathUtils.clamp((b * f - c * e) / denom, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = THREE.MathUtils.clamp(-c / a, 0, 1);
      } else if (t > 1) {
        t = 1;
        s = THREE.MathUtils.clamp((b - c) / a, 0, 1);
      }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}
const tri = new THREE.Triangle(), closest = V(), ray = new THREE.Ray(), hit = V();
function segTri(p, q, [a, b, c]) {
  tri.set(a, b, c);
  const len = p.distanceTo(q);
  if (len > 0) {
    ray.set(p, q.clone().sub(p).normalize());
    const at = ray.intersectTriangle(a, b, c, false, hit);
    if (at && p.distanceTo(at) <= len) return 0;
  }
  return Math.min(
    tri.closestPointToPoint(p, closest).distanceTo(p),
    tri.closestPointToPoint(q, closest).distanceTo(q),
    segSeg(p, q, a, b), segSeg(p, q, b, c), segSeg(p, q, c, a),
  );
}
