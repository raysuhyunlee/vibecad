import { ServoBracket } from "./bracket.ts";
import { StandardServo } from "./servo.ts";

export default ServoBracket({ servo: StandardServo, wall: 4 }); // a stiffer bracket for the loaded side
