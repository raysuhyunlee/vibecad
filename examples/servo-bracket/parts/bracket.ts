import { box, cylinder, edges, extrude, part, port, roundedRect } from "vibecad";
import { flangeHoles, type ServoMount } from "./servo.ts";

export const ServoBracket = part(
  "ServoBracket",
  (p: {
    servo: ServoMount;
    wall?: number; // plate and flange thickness
    bendFillet?: number; // inside radius where the wall meets the base
    cornerRadius?: number; // outline corners of the top plate
    clearance?: number; // gap around the servo body
    baseHoleDiameter?: number;
    standoff?: number; // height of the top plate above the base
  }) => {
    const wall = p.wall ?? 3;
    const bendFillet = p.bendFillet ?? 3;
    const cornerRadius = p.cornerRadius ?? 4;
    const clearance = p.clearance ?? 0.5;
    const baseHoleDiameter = p.baseHoleDiameter ?? 3.2;
    const standoff = p.standoff ?? 30;

    const width = p.servo.flangeHoleSpacingX + 12;
    const depth = p.servo.bodyDepth + 12;
    const pocketW = p.servo.bodyWidth + 2 * clearance;
    const pocketD = p.servo.bodyDepth + 2 * clearance;

    // Top plate: seats the servo flange. Outline flows through tangent arcs.
    const plate = extrude(roundedRect(width, depth, cornerRadius), wall)
      .named("plate")
      .translate(0, 0, standoff);
    const pocket = box(pocketW, pocketD, wall + 2).named("pocket").translate(0, 0, standoff - 1);
    const mount = flangeHoles(p.servo).map(([x, y], i) =>
      cylinder(p.servo.holeDiameter / 2, wall + 2).named(`mount[${i}]`).translate(x, y, standoff - 1),
    );

    // Side walls carry the plate down to a flat base.
    const wallAt = (name: string, y: number) =>
      box(width - 2 * cornerRadius, wall, standoff - wall).named(name).translate(0, y, wall);
    const wallY = depth / 2 - wall / 2;
    const base = box(width + 24, depth, wall).named("base");
    const baseHoles = [-1, 1].map((s, i) =>
      cylinder(baseHoleDiameter / 2, wall + 2).named(`baseHole[${i}]`).translate((s * (width + 12)) / 2, 0, -1),
    );

    const solid = base
      .union(wallAt("wallFront", -wallY), wallAt("wallBack", wallY), plate)
      .cut(pocket, mount, baseHoles)
      // Inside corners at the bends carry the load. Mating faces and holes stay sharp.
      .fillet(bendFillet, edges.between("wallFront.back", "base.top").parallel("x"))
      .named("bendFront")
      .fillet(bendFillet, edges.between("wallBack.front", "base.top").parallel("x"))
      .named("bendBack");

    return {
      solid,
      ports: {
        servoSeat: port([0, 0, standoff + wall], [0, 0, 1]),
        foot: port([0, 0, 0], [0, 0, -1]),
      },
    };
  },
);
