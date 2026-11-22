import { assembly, check, mate, minClearance, motion, noCollision, noOverlap, revolute } from "vibecad";
import bracket from "./parts/bracket.cad.ts";
import horn from "./parts/horn.cad.ts";
import plate from "./parts/plate.cad.ts";
import servo from "./parts/servo.cad.ts";
import thickBracket from "./parts/thick-bracket.cad.ts";

export default assembly("PanTiltBase", () => {
  const left = bracket, right = thickBracket;
  const pan = revolute(servo.port("shaft"), horn.port("hub"), { min: -90, max: 90 });

  return {
    parts: { plate, left, right, servo, horn },
    mates: [
      mate(plate.port("left"), left.port("foot")),
      mate(plate.port("right"), right.port("foot")),
      mate(left.port("servoSeat"), servo.port("seat")),
    ],
    joints: { pan },
    // one full pan sweep, 3 s
    motions: { sweep: motion([{ t: 0, pose: { pan: -90 } }, { t: 1.5, pose: { pan: 90 } }, { t: 3, pose: { pan: -90 } }], { ease: "inOut" }) },
    checks: [
      minClearance(left, right, 5),
      noOverlap(left, servo),
      noCollision(horn, right, { joint: pan }),
      noCollision(horn, left, { joint: pan }),
      check("bracket stays under 25 cm3", (q) => q.volume(left) < 25_000),
    ],
  };
})();
