import { box, cylinder, extrude, part, port, roundedRect } from "vibecad";

/** The dimension interface every standard-size servo shares. */
export interface ServoMount {
  bodyWidth: number; // along the long axis
  bodyDepth: number;
  flangeHoleSpacingX: number; // between the hole columns, across the body
  flangeHoleSpacingY: number; // between the holes of one column
  holeDiameter: number;
  shaftOffset: number; // output shaft from the body center, along the long axis
}

// Approximate standard-size servo. Confirm against the datasheet before fabricating.
export const StandardServo: ServoMount = {
  bodyWidth: 40.5,
  bodyDepth: 20,
  flangeHoleSpacingX: 49.5,
  flangeHoleSpacingY: 10,
  holeDiameter: 4.2,
  shaftOffset: 10,
};

/** Hole centers of a servo flange, on the plane z=0. */
export function flangeHoles(m: ServoMount): Array<[number, number]> {
  const x = m.flangeHoleSpacingX / 2, y = m.flangeHoleSpacingY / 2;
  return [[-x, -y], [-x, y], [x, -y], [x, y]];
}

/** A simplified servo body, used for clearance checks. */
export const ServoBody = part("ServoBody", (p: { mount: ServoMount; height?: number }) => {
  const height = p.height ?? 36;
  const body = box(p.mount.bodyWidth, p.mount.bodyDepth, height).named("body");
  const flange = box(p.mount.flangeHoleSpacingX + 10, p.mount.bodyDepth, 2.5)
    .named("flange")
    .translate(0, 0, height - 8);
  const holes = flangeHoles(p.mount).map(([x, y], i) =>
    cylinder(p.mount.holeDiameter / 2, 10).named(`hole[${i}]`).translate(x, y, height - 12),
  );
  return {
    solid: body.union(flange).cut(holes),
    // The underside of the flange seats on the bracket.
    ports: {
      seat: port([0, 0, height - 8], [0, 0, -1]),
      shaft: port([p.mount.shaftOffset, 0, height]),
    },
  };
});

/** A two-arm horn. The shaft sits at its center. */
export const ServoHorn = part("ServoHorn", (p: { span?: number; width?: number; thickness?: number; tipRadius?: number }) => {
  const span = p.span ?? 40; // tip to tip
  const width = p.width ?? 8;
  const thickness = p.thickness ?? 3;
  const tipRadius = p.tipRadius ?? 3; // outline corners of the arm tips
  return {
    solid: extrude(roundedRect(span, width, tipRadius), thickness).named("arm"),
    ports: { hub: port([0, 0, 0], [0, 0, -1]) },
  };
});

export default () => ServoBody({ mount: StandardServo });
