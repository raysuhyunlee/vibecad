import { box, part, port } from "vibecad";

const BasePlate = part("BasePlate", (p: { width: number; depth: number; thickness: number }) => ({
  solid: box(p.width, p.depth, p.thickness).named("plate"),
  ports: {
    left: port([-p.width / 4, 0, p.thickness]),
    right: port([p.width / 4, 0, p.thickness]),
  },
}));

export default BasePlate({ width: 220, depth: 80, thickness: 5 });
