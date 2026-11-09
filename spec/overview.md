# vibecad tech spec

- summary: a CAD for agents, and a feedback system for humans

## key principles

- occt kernel, pinned as wasm: same binary and geometry on every OS
- declarative: code is pure TypeScript that returns a feature graph; only `src/eval.ts` touches the kernel
- object oriented: a part is a typed factory, params are its dimension interface, ports are its connections
- files are modules: parts and assemblies import each other
- `*.cad.ts` marks a modeling file and needs a default export, so every one can be built and viewed alone
- everything is a function: built-in features and user functions have the same shape
- agent first: every capability is a CLI command that prints JSON; errors carry code, source line and hint
- the CLI takes actions; settings live in `~/.vibecad/config.json`
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
- import: `importStep(file)` loads a STEP file as a solid, with its path relative to the calling source file
- an imported file has no feature names, so its faces are `<feature>.face[i]` in file order; replacing the file can renumber them, so prefer selecting the whole feature, `edges.of("motor").curve("circle")`
- STEP files are tracked in git, because `diff` builds revisions from git; saving one in the project rebuilds
- a STEP file is also an entry: every command and the app open it directly as one part named after the file, with no ports and no TypeScript source
- profiles: `polygon rect circle roundedRect path`
- `path(start)` builds a closed outline: `line(to) arc(center, to, ccw) forward(length) tangentArc(to) round(r) named(name) close()`
- `round(r)` rounds the corner at the current point, against lines or arcs; to round the start, end on it with an explicit `line(start)`
- bad geometry stops at the call: an arc end off its circle, a round that does not fit or has no corner
- `outerTangent(c1, r1, c2, r2, side)` gives the touch points of a line tangent to two circles
- features: `union cut intersect fillet chamfer shell translate rotate mirror`
- structure: `part assembly port mate revolute slider named`
- links: mates and joints join parts into one tree, growing from the first part; a closed loop is `OVER_CONSTRAINED`
- joints: `revolute(a, b, { angle, min, max, gap })`, default range -180 to 180; `slider(a, b, { min, max, travel, angle })`; both are named in an assembly's `joints`
- a joint's value lives in the source; `--pose` and the viewer only override it. Its path is `sub/name`, and a value outside its range is an error
- a positive angle turns the moving part about its own port's +z; a positive travel separates the ports along the fixed port's +z
- default export: an instance, or a function returning one; a part with required params exports a preview, `export default () => Part({ ... })`
- rules: `check minClearance noOverlap`, run on every build
- sweeps: `noCollision(a, b, { joint, steps })` samples a joint's range, only in `vibecad test`, and reports the first failing value; collisions between samples can be missed
- a check reads other poses with `q.at(joint, value)`
- face names: `<feature>.<face>`, for example `mount[2].side`; a split face gets `~2`
- a swept profile's wall takes its segment's name, or else `side[i]`, its place in the outline counting rounds; an outline of one segment gives `side`
- caps are `top` and `bottom` on an extrude, `start` and `end` on a partial revolve; these and `side` are reserved as segment names
- `fillet` and `chamfer` follow the kernel: they carry on along edges tangent to the selection

## cli

- `build test query render export diff dev show`, see `vibecad --help`
- `--pose joint=value,...` sets joint values for any command that builds, except `diff` and `dev`

## settings

- `~/.vibecad/config.json`, per user because the app starts before any project opens; read when the app starts
- `port` (4173), `agent` (`claude`), `model` (agent default), `keepMb` (512)
- every key is optional; an unknown key or a bad value stops the app with an error

## app and projects

- `vibecad dev` starts the app with nothing open; it takes no file
- the person opens a project root with an in-app folder picker, served by the local server so it works on every OS
- opening a project runs its TypeScript in a build process, so only the person's own action opens one
- one app serves one project: the server's working directory is the root, and builds, agents and `.vibecad/` resolve against it
- the left panel lists the root's `*.cad.ts` and STEP files, skipping dot folders and `node_modules`, and updates as files change
- selecting a file opens it in a tab; a project opens on `main.cad.ts` when it has one
- a tab keeps its last good build until it closes, so switching tabs renders at once
- kept builds have a limit, `keepMb`, measured on build output; over it, the longest unseen build is dropped, and that tab rebuilds when shown; the tab on screen is never dropped
- pins, the draft message, the pose and the camera stay with their tab until it closes, even when its build is dropped; a pin goes when its face no longer exists
- a message carries only the pins of the tab it is sent from
- only the tab on screen builds; saving any `.ts` marks the others stale, and they rebuild behind the kept model when shown
- preview builds write to `.vibecad/preview`, so an agent's own build in `.vibecad/out` cannot land in a tab
- other `.ts` files are plain code: not listed, but saving one rebuilds
- the left panel has a slider per joint; moving one changes the view without a rebuild, using the joint data in `model.json`, and never writes the source
- the viewer's pose stays with its tab through rebuilds; a message carries the joints moved away from the source
- the agent session survives a file switch, and each message names the file being viewed
- opening another project is refused while the agent runs
- the browser remembers the last project and its tabs, and reopens them on start; a reopened tab builds when first shown
- projects anywhere on disk import the language as `"vibecad"`; the CLI resolves it

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

- modeling priority, draft: (1) fillet runout; (2) sketches on any plane; (3) sketch offset; (4) spline; (5) constraint solver
- wip: closed-loop linkages and more joint kinds (cylindrical, ball, planar)
- wip: drawn strokes stay in place when a joint moves; pins follow their part
- wip: sketch constraint solver, sweep, loft, draft, drawings, sheet metal
- wip: per-feature build cache
- wip: face labels in `vibecad render`
- wip: isolating the agent from the person's global settings
- wip: npm distribution. Node will not strip types under `node_modules`, so vibecad runs from this repo today; a release needs compiled output
- wip: local speech recognition. Chrome's Web Speech sends audio to a cloud service
- not yet verified: identical geometry across macOS, Linux and Windows; large assemblies; real microphone input; a successful codex turn

## revision history

- 2026-11-09: initial spec
- 2026-11-09: separate app start from loading; add project root and file browser
- 2026-11-09: `*.cad.ts` is the modeling file standard, with a required default export
- 2026-11-09: open files stay in tabs and keep their last build
- 2026-11-09: limit kept builds; pins and drafts stay with their tab
- 2026-11-09: move app settings from CLI flags to a config file
- 2026-11-09: import STEP files as solids
- 2026-11-09: open STEP files directly as entries
- 2026-11-09: add revolute and slider joints, poses, and range sweeps in `test`
- 2026-11-09: add the path builder; walls take their segment's name through kernel history
