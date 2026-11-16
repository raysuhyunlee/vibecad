# vibecad

A CAD for agents, and a feedback system for humans. Parts are typed TypeScript objects, dimensions are their interfaces, and you steer the agent by pointing at the live model and talking.

## Try it

Needs Node 24+. Feedback needs a logged-in `claude` or `codex` CLI.

```bash
npm install
node src/cli.ts dev   # open the printed URL
npm run app           # or run it as a desktop app
just build            # package the desktop app into dist/
```

Open a project folder in the app, for example `examples/servo-bracket`, and pick a file. Click faces or edges to measure them. Press `D` for the pen, click a face to pin it, then hold Space and talk, or type. `F` fits, `Esc` clears.

Settings live in `~/.vibecad/config.json`: `port`, `agent`, `model`.

## A part

A part or an assembly is one instance, something you produce. A factory is the code that makes them. A modeling file, `*.cad.ts`, is one instance: its default export. Other `.ts` files are plain code, such as factories several instances share. STEP files open directly in the app, and `importStep("motor.step")` brings one into a part.

```ts
const Plate = part("Plate", (p: { hole: number }) => ({
  solid: box(40, 20, 5).named("base")
    .cut(cylinder(p.hole, 10).named("bore").translate(0, 0, -1)),
  ports: { top: port([0, 0, 5]) },
}));
export default Plate({ hole: 3 });
```

Sketch on a named face, sweep along a spine, or loft through sections.

```ts
const base = box(40, 20, 5).named("base");
const post = extrude(circle(3), 10, onFace(base, "base.top")).named("post");
const pipe = sweep(circle(1), spine([0, 0, 0]).line([0, 0, 20]).tangentArc([0, 10, 30])).named("pipe");
const neck = loft([{ profile: rect(20, 20), on: plane([0, 0, 0]) }, { profile: circle(5), on: plane([0, 0, 30]) }]).named("neck");
```

Standard and shared parts come from libraries, folders of instances: `import bolt from "lib:std/bolt-m3x8"`. Factories that make them come from factory folders: `import { bearing } from "factory:std"`. Add your own as folders in the project's `libs/` or `factories/`, or in `~/.vibecad/`.

An assembly imports other files' instances, `import plate from "./plate.cad.ts"`, and `place(plate)` places one again. Each part is built once and kept in `.vibecad/builds`, so an assembly reuses it.

Joints make an assembly move. Drag a joint's slider in the app, or set a pose from the CLI with `--pose pan=30`. `vibecad test` checks `noCollision` across the joint's range.

```ts
const pan = revolute(servo.port("shaft"), horn.port("hub"), { min: -90, max: 90 });
return { parts: { servo, horn }, joints: { pan }, checks: [noCollision(horn, servo, { joint: pan })] };
```

## Directory Structure

```text
src/       language, evaluator, CLI, preview server, agent adapters
viewer/    live preview
libs/      built-in libraries of instances
factories/ built-in factories
examples/  sample projects
spec/      specifications
docs/      tutorials
test/      tests
```

## Spec Index

| Document | Ownership |
| --- | --- |
| `spec/overview.md` | Tech spec: principles, stack, language, feedback loop, sessions |
| `docs/tutorial.md` | Modeling tutorial for agents: project layout, instances and factories |
