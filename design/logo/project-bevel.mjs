import { readFileSync, writeFileSync } from 'node:fs';

// Project the CAD kernel's chamfered mesh; no offset silhouettes are used.
const mesh = JSON.parse(readFileSync('.vibecad/builds/design/logo/v-mark.cad.ts/meshes.json')).parts[0];
const decode = (s, Type) => {
  const b = Buffer.from(s, 'base64');
  return new Type(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
};
const positions = decode(mesh.positions, Float32Array);
const normals = decode(mesh.normals, Float32Array);
const indices = decode(mesh.indices, Uint32Array);
const model = JSON.parse(readFileSync('.vibecad/builds/design/logo/v-mark.cad.ts/model.json'));
const unit = (a) => { const l = Math.hypot(...a); return a.map(v => v / l); };
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const view = unit([0.10, -0.10, 1]);
const right = unit([view[2], 0, -view[0]]);
const up = [view[1] * right[2], view[2] * right[0] - view[0] * right[2], -view[1] * right[0]];
const light = unit([-0.45, 0.70, 1]);
const half = unit(light.map((v, i) => v + view[i]));
const scale = 410 / 84;
const triangles = [];
for (let t = 0; t < indices.length / 3; t++) {
  const ids = Array.from(indices.slice(t * 3, t * 3 + 3));
  const xyz = ids.map(i => Array.from(positions.slice(i * 3, i * 3 + 3)));
  const n = unit([0, 1, 2].map(j => ids.reduce((s, i) => s + normals[i * 3 + j], 0)));
  if (dot(n, view) <= 0.001) continue;
  const diffuse = Math.max(0, dot(n, light));
  const specular = Math.pow(Math.max(0, dot(n, half)), 30) * 0.32;
  const face = mesh.faceGroups.findIndex((v, j, a) => j % 3 === 0 && t >= v && t < v + a[j + 1]);
  const faceId = model.parts[0].faces[mesh.faceGroups[face + 2]].id;
  const isTop = faceId === 'blank.top';
  const color = [244, 108, 7].map((v, j) => Math.round(Math.min(255, v * (0.42 + 0.65 * diffuse) + [255, 211, 140][j] * specular)));
  const fill = '#' + color.map(v => v.toString(16).padStart(2, '0')).join('');
  const xy = xyz.map(p => [320 + dot(p, right) * scale, 320 - dot(p, up) * scale]);
  const geometry = xy.map((p, j) => `${j ? 'L' : 'M'}${p.map(v => v.toFixed(3)).join(' ')}`).join('') + 'Z';
  triangles.push({ depth: xyz.reduce((s, p) => s + dot(p, view), 0) / 3, faceId, fill, geometry, xy, isTop });
}
triangles.sort((a, b) => a.depth - b.depth);
// Merge adjacent mesh triangles on the same physical face and with the same light response.
const groups = new Map();
for (const t of triangles) {
  const key = t.faceId;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(t);
}
const paths = [...groups.values()].map(ts => {
  const edges = new Map();
  for (const t of ts) {
    const pts = t.xy.map(p => p.map(v => v.toFixed(3)).join(' '));
    for (let i = 0; i < 3; i++) {
      const a = pts[i], b = pts[(i + 1) % 3];
      const key = [a, b].sort().join('|');
      if (edges.has(key)) edges.delete(key);
      else edges.set(key, [a, b]);
    }
  }
  let geometry = '';
  while (edges.size) {
    const [key, [start, next]] = edges.entries().next().value;
    edges.delete(key);
    geometry += 'M' + start + 'L' + next;
    let end = next;
    while (end !== start) {
      const match = [...edges.entries()].find(([, [a, b]]) => a === end || b === end);
      if (!match) break;
      const [k, [a, b]] = match;
      edges.delete(k);
      end = a === end ? b : a;
      geometry += 'L' + end;
    }
    geometry += 'Z';
  }
  const surface = model.parts[0].faces.find(f => f.id === ts[0].faceId).surface;
  const byX = [...ts].sort((a, b) => a.xy.reduce((s, p) => s + p[0], 0) - b.xy.reduce((s, p) => s + p[0], 0));
  const fill = surface === 'plane' ? ts[0].fill : {
    type: 'gradient', gradientType: 'linear', rotation: 270,
    colors: [0, 0.25, 0.5, 0.75, 1].map(position => ({ position, color: byX[Math.round(position * (byX.length - 1))].fill })),
  };
  return { ...ts[0], fill, depth: ts.reduce((s, t) => s + t.depth, 0) / ts.length, geometry };
}).sort((a, b) => a.depth - b.depth);
const nodes = paths.map((p, i) => ({ type: 'path', name: `${p.faceId} / projected surface ${i + 1}`, x: 0, y: 0, width: 640, height: 640, viewBox: [0, 0, 640, 640], geometry: p.geometry, fill: p.fill }));
const script = '/** @schema 2.11 */\nreturn ' + JSON.stringify([{ type: 'frame', layout: 'none', width: 640, height: 640, name: 'OCCT chamfered V - projected real surfaces', effect: { type: 'shadow', shadowType: 'outer', offset: { x: 4, y: 12 }, blur: 15, color: '#00000065' }, children: nodes }]) + ';\n';
writeFileSync('design/logo/assets/beveled-v.js', script);
console.log(JSON.stringify({ triangles: triangles.length, paths: paths.length, bevel: 1.3, thickness: 5.5 }));
