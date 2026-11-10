# vibecad

A CAD for agents, and a feedback system for humans. Parts are typed TypeScript objects, dimensions are their interfaces, and you steer the agent by pointing at the live model and talking.

## Try it

Needs Node 24+. Feedback needs a logged-in `claude` or `codex` CLI.

```bash
npm install
node src/cli.ts dev   # open the printed URL
```

Open a project folder in the app, for example `examples/servo-bracket`, and pick a file. Click a face, hold Space and talk, or type. `D` draws, `F` fits, `Esc` clears.

Settings live in `~/.vibecad/config.json`: `port`, `agent`, `model`, `keepMb`.

## A part

Modeling files are named `*.cad.ts` and default-export what they show. A part with required params exports a preview, for example `export default () => Plate({ hole: 3 })`. Other `.ts` files are plain code. STEP files open directly in the app, and `importStep("motor.step")` brings one into a part.

```ts
export const Plate = part("Plate", (p: { hole: number }) => ({
  solid: box(40, 20, 5).named("base")
    .cut(cylinder(p.hole, 10).named("bore").translate(0, 0, -1)),
  ports: { top: port([0, 0, 5]) },
}));
```

Sketch on a named face, sweep along a spine, or loft through sections.

```ts
const base = box(40, 20, 5).named("base");
const post = extrude(circle(3), 10, onFace(base, "base.top")).named("post");
const pipe = sweep(circle(1), spine([0, 0, 0]).line([0, 0, 20]).tangentArc([0, 10, 30])).named("pipe");
const neck = loft([{ profile: rect(20, 20), on: plane([0, 0, 0]) }, { profile: circle(5), on: plane([0, 0, 30]) }]).named("neck");
```

Joints make an assembly move. Drag a joint's slider in the app, or set a pose from the CLI with `--pose pan=30`. `vibecad test` checks `noCollision` across the joint's range.

```ts
const pan = revolute(servo.port("shaft"), horn.port("hub"), { min: -90, max: 90 });
return { parts: { servo, horn }, joints: { pan }, checks: [noCollision(horn, servo, { joint: pan })] };
```

## Directory Structure

```text
src/       language, evaluator, CLI, preview server, agent adapters
viewer/    live preview
examples/  sample projects
spec/      specifications
test/      tests
```

## Spec Index

| Document | Ownership |
| --- | --- |
| `spec/overview.md` | Tech spec: principles, stack, language, feedback loop, sessions |
