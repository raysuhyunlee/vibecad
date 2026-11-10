import { assembly, check, mate, minClearance, noCollision, noOverlap, revolute } from "vibecad";
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
    checks: [
      minClearance(left, right, 5),
      noOverlap(left, servo),
      noCollision(horn, right, { joint: pan }),
      noCollision(horn, left, { joint: pan }),
      check("bracket stays under 25 cm3", (q) => q.volume(left) < 25_000),
    ],
  };
})();
