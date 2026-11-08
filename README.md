# vibecad

A CAD for agents, and a feedback system for humans. Parts are typed TypeScript objects, dimensions are their interfaces, and you steer the agent by pointing at the live model and talking.

## Try it

Needs Node 24+. Feedback needs a logged-in `claude` or `codex` CLI.

```bash
npm install
node src/cli.ts dev examples/servo-bracket/main.ts   # open the printed URL
```

Click a face, hold Space and talk, or type. `D` draws, `F` fits, `Esc` clears.

## A part

```ts
export const Plate = part("Plate", (p: { hole: number }) => ({
  solid: box(40, 20, 5).named("base")
    .cut(cylinder(p.hole, 10).named("bore").translate(0, 0, -1)),
  ports: { top: port([0, 0, 5]) },
}));
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
