# Modeling tutorial

How to lay out a vibecad project, from a real case: a four-legged robot whose legs share parts. Read `spec/overview.md` for the exact rules.

## Instances and factories

- A part or an assembly is an instance: one thing you produce. A project has a finite set of them.
- A factory is code that makes instances: `part(...)` and `assembly(...)` return one.
- A `*.cad.ts` file is one instance, its default export. It opens alone in the app and with every command.
- A factory that one instance uses stays unexported in that file. A factory several instances share goes in a plain `.ts` file.

## Layout

```text
params.ts                  shared dimensions
parts/
  ax12.cad.ts              vendor motor, a STEP import
  foot.cad.ts              one foot, used on both sides
  pelvis.ts                Pelvis factory
  pelvis-left.cad.ts       export default Pelvis({ side: "left" })
  pelvis-right.cad.ts      export default Pelvis({ side: "right" })
assembly/
  leg.ts                   Leg factory
  leg-front-left.cad.ts    export default Leg({ end: "front", side: "left", pelvis })
  leg-front-right.cad.ts
  leg-hind-left.cad.ts
  leg-hind-right.cad.ts
```

## Steps

1. Make one file per thing you produce. Name it after what it is, `pelvis-left.cad.ts`, not after a parameter value.
2. When several instances have the same structure, write a factory and keep each instance file to one call. The four legs differ only in side and end, so a `Leg` factory keeps them from drifting apart.
3. Pass instances into a factory instead of importing every variant into it. `Leg` takes the pelvis of its side, so a leg file reads only its own parts, and editing the right pelvis leaves the left legs' builds fresh.

   ```ts
   // assembly/leg-hind-right.cad.ts
   import pelvis from "../parts/pelvis-right.cad.ts";
   import { Leg } from "./leg.ts";

   export default Leg({ end: "hind", side: "right", pelvis });
   ```

4. An assembly places only `.cad.ts` instances. To use one twice, `place` it: `const footMotor = place(ax12)`.
5. Before making left and right versions, check whether the part is mirror-symmetric. If it is, it is one part: make one instance, and give it a port per side where the two differ.

   ```ts
   ports: {
     motorSeatLeft: port(at, [0, -1, 0], [-1, 0, 0]),
     motorSeatRight: port(at, [0, 1, 0], [1, 0, 0]),
   },
   ```

   To check, intersect the two solids: they are the same part when the common volume equals each volume. The foot was symmetric; the pelvis was not, so it keeps two files.

6. Build and test every file you touched, parts first:

   ```bash
   vibecad build parts/foot.cad.ts && vibecad test parts/foot.cad.ts
   vibecad build assembly/leg-front-left.cad.ts && vibecad test assembly/leg-front-left.cad.ts
   ```

   An assembly reuses each part's kept build, so later builds only redo what changed.
