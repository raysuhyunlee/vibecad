# vibecad tech spec

- summary: a CAD for agents, and a feedback system for humans

## key principles

- occt kernel, pinned as wasm: same binary and geometry on every OS
- declarative: code is pure TypeScript that returns a feature graph; only `src/eval.ts` touches the kernel
- object oriented: a part is a typed factory, params are its dimension interface, ports are its connections
- files are modules: parts and assemblies import each other
- everything is a function: built-in features and user functions have the same shape
- agent first: every capability is a CLI command that prints JSON; errors carry code, source line and hint
- select by meaning, never by index: `edges.of("base.top").parallel("x")`
- every face traces back to a name and a source line, through kernel history
- git is the source of truth: source and lockfile are tracked, build output in `.vibecad/` is not
- bring your own agent: vibecad never ships or embeds one

## tech stack

- cad language: TypeScript, run with Node type stripping (Node 24+)
- kernel: OCCT 8 via `occt-wasm` (exact version pinned, LGPL-2.1)
- renderer: three.js in a local web page, no build step; agents use `vibecad render` (hidden-line PNG)
- server: Node `http` with server-sent events, bound to 127.0.0.1
- voice: browser Web Speech API
- agents: `claude` and `codex` CLIs

## language

- primitives: `box cylinder cone sphere extrude revolve`
- profiles: `polygon rect circle roundedRect`
- features: `union cut intersect fillet chamfer shell translate rotate mirror`
- structure: `part assembly port mate named`
- rules: `check minClearance noOverlap`, run on every build
- face names: `<feature>.<face>`, for example `mount[2].side`; a split face gets `~2`

## cli

- `build test query render export diff dev show`, see `vibecad --help`

## friction-free human-agent feedback loop

- click a face to pin it, numbered, with its source line shown
- drag in draw mode to mark an area; the stroke resolves to the faces under it
- hold Space to talk; pins made while talking land in the sentence where they were said: "this [1] should match that [2]"
- sending carries text, face ids, source lines, 3D points and a screenshot
- the agent edits the source, the preview rebuilds on save, changed faces glow
- the agent points back with `vibecad show`
- a feature-history list replays any part step by step, next to its source

## agent sessions

- the preview starts one agent turn per message, prompt through stdin
- vibecad owns its sessions and never touches the person's open terminal sessions
- one session per agent per git branch, in gitignored `.vibecad/sessions.json`
- a session is a disposable cache: durable decisions live in code, commits and `AGENTS.md`
- messages sent during a turn queue and go in the next turn; stop is one button
- permissions are preset for the session: file edits and the vibecad CLI

## status

- wip: sketch constraint solver, sweep, loft, draft, drawings, sheet metal
- wip: per-feature build cache
- wip: face labels in `vibecad render`
- wip: isolating the agent from the person's global settings
- wip: npm distribution. Node will not strip types under `node_modules`, so vibecad runs from this repo today; a release needs compiled output
- wip: local speech recognition. Chrome's Web Speech sends audio to a cloud service
- not yet verified: identical geometry across macOS, Linux and Windows; large assemblies; real microphone input; a successful codex turn

## revision history

- 2026-11-09: initial spec
