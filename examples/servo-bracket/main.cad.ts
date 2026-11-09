import { assembly, box, check, mate, minClearance, noCollision, noOverlap, part, port, revolute } from "vibecad";
import { ServoBracket } from "./parts/bracket.cad.ts";
import { ServoBody, ServoHorn, StandardServo } from "./parts/servo.cad.ts";

const BasePlate = part("BasePlate", (p: { width: number; depth: number; thickness: number }) => ({
  solid: box(p.width, p.depth, p.thickness).named("plate"),
  ports: {
    left: port([-p.width / 4, 0, p.thickness]),
    right: port([p.width / 4, 0, p.thickness]),
  },
}));

export default assembly("PanTiltBase", () => {
  const plate = BasePlate({ width: 220, depth: 80, thickness: 5 });
  const left = ServoBracket({ servo: StandardServo });
  const right = ServoBracket({ servo: StandardServo, wall: 4 });
  const servo = ServoBody({ mount: StandardServo });
  const horn = ServoHorn({});
  const pan = revolute(servo.port("shaft"), horn.port("hub"), { min: -90, max: 90 });

  return {
    parts: { plate, left, right, servo, horn },
    mates: [
      mate(plate.port("left"), left.port("foot")),
      mate(plate.port("right"), right.port("foot")),
      mate(left.port("servoSeat"), servo.port("seat")),
    ],
    joints: { pan },
    checks: [
      minClearance(left, right, 5),
      noOverlap(left, servo),
      noCollision(horn, right, { joint: pan }),
      noCollision(horn, left, { joint: pan }),
      check("bracket stays under 25 cm3", (q) => q.volume(left) < 25_000),
    ],
  };
});
