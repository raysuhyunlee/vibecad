import { edges, extrude, part, path } from "vibecad";

const params = {
  halfSpan: 32, // Half the distance between the arm centers.
  rise: 60, // Height from the bottom center to the arm centers.
  radius: 10, // Arm half-width and tangent end radius.
  valleyRadius: 2, // Inside corner blend in the V outline.
  thickness: 5.5, // Depth of the extruded mark.
  bevel: 1.3, // Equal-distance 45-degree front chamfer.
};

const Mark = part("VibecadMark", (p: typeof params) => {
  const length = Math.hypot(p.halfSpan, p.rise);
  const nx = p.rise / length, ny = p.halfSpan / length;
  const ox = p.radius * nx, oy = p.radius * ny;
  const bottom = -p.rise / 2, top = p.rise / 2;
  const start: [number, number] = [-p.halfSpan - ox, top - oy];
  const profile = path(start)
    .line([-ox, bottom - oy]).named("leftOuter")
    .arc([0, bottom], [ox, bottom - oy], true).named("bottomArc")
    .line([p.halfSpan + ox, top - oy]).named("rightOuter")
    .arc([p.halfSpan, top], [p.halfSpan - ox, top + oy], true).named("rightTip")
    .line([0, bottom + p.radius / ny]).round(p.valleyRadius).named("valley")
    .line([-p.halfSpan + ox, top + oy]).named("leftInner")
    .arc([-p.halfSpan, top], start, true).named("leftTip")
    .close();
  const blank = extrude(profile, p.thickness).named("blank");
  return { solid: blank.chamfer(p.bevel, edges.of("blank.top")).named("frontBevel") };
});

export default Mark(params);
