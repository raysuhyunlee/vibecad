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

- primitives: `box cylinder cone sphere extrude revolve sweep loft`
- import: `importStep(file)` loads a STEP file as a solid, with its path relative to the calling source file
- an imported file has no feature names, so its faces are `<feature>.face[i]` in file order; replacing the file can renumber them, so prefer selecting the whole feature, `edges.of("motor").curve("circle")`
- STEP files are tracked in git, because `diff` builds revisions from git; saving one in the project rebuilds
- a STEP file is also an entry: every command and the app open it directly as one part named after the file, with no ports and no TypeScript source
- profiles: `polygon rect circle roundedRect path closedSpline offset`
- `path(start)` builds a closed outline: `line(to) arc(center, to, ccw) forward(length) tangentArc(to) spline(through, { start, end }) tangentSpline(through, end) round(r) named(name) close()`
- a spline passes through its points as one curve; an end with no given tangent takes the direction of a parabola through the nearest three points, and a spline to one point needs both tangents
- `round` cannot touch a spline; put a line or arc between them
- `closedSpline(points)` is a smooth closed outline with no seam, and one wall, `side`
- `offset(profile, distance)` moves an outline outward, or inward when negative, whichever way it was drawn; corners stay sharp, and offsets chain
- an offset wall keeps the name of its nearest segment; the kernel can split an offset spline, so its wall gets `~2` and so on
- an offset that leaves anything but one outline is `BAD_OFFSET`
- sketch planes: `plane(at, z, x)`; `extrude(profile, height, on)` and `revolve(profile, axis, degrees, on)` sketch on it and sweep along its +z, or turn about the sketch's own axis
- a plane's sketch y is z cross x; without x, the sketch's x is world X projected onto the plane, or world Y when z is near X
- face names are the same on any plane
- sketching on a face: `onFace(solid, face, { x, at })` works wherever a plane does, and stays on the face when the solid's dimensions change
- `face` is a face id of that solid at that feature; +z points out of the solid, and the origin is the center of the face's outline, moved by `at` in sketch units, so a hole does not move it
- x follows the plane rule; a sketch going into the solid has a negative height
- a curved face is `FACE_NOT_FLAT`; a face split in pieces is `AMBIGUOUS_FACE`, and its hint lists the ids such as `base.top~2`
- `spine(start)` builds an open 3D curve: `line(to) arc(through, to) tangentArc(to) spline(through)`; `helix(radius, pitch, height, { left })` runs about +z from `[radius, 0, 0]`
- `sweep(profile, spine, { x })` puts the sketch's origin on the spine's start, with +z along the spine, and x follows the plane rule; to place a helix, move the solid
- a sweep keeps its profile from twisting and miters sharp corners; on a helix the profile turns with the curve
- each further spine segment repeats the wall names with `~2` and so on
- `loft([{ profile, on }, ...], { ruled })` blends two or more sections, each on a plane or a face; `ruled` makes straight walls between them
- loft walls are named from the first section's segments, and a section with fewer or more segments can split them with `~2`
- a sweep or loft that is not one valid solid is `BAD_SHAPE`
- `round(r)` rounds the corner at the current point, against lines or arcs; to round the start, end on it with an explicit `line(start)`
- bad geometry stops at the call: an arc end off its circle, a round that does not fit or has no corner
- `outerTangent(c1, r1, c2, r2, side)` gives the touch points of a line tangent to two circles
- features: `union cut intersect fillet chamfer shell translate rotate mirror`
- structure: `part assembly port mate revolute slider named`
- links: mates and joints join parts into one tree, growing from the ground, or else the first part; a closed loop is `OVER_CONSTRAINED`
- ground: an assembly's `ground: mate(world, port)` fixes that part facing the world frame (origin, +z up, x along +X), with `gap` and `angle` as in a mate; only the entry's ground counts, and `world` anywhere else is `BAD_MATE`
- joints: `revolute(a, b, { angle, min, max, gap })`, default range -180 to 180; `slider(a, b, { min, max, travel, angle })`; both are named in an assembly's `joints`
- a joint's value lives in the source; `--pose` and the viewer only override it. Its path is `sub/name`, and a value outside its range is an error
- a positive angle turns the moving part about its own port's +z; a positive travel separates the ports along the fixed port's +z
- default export: an instance, or a function returning one; a part with required params exports a preview, `export default () => Part({ ... })`
- options: `export default options({ side: ["left", "right"] }, (o) => Leg(o))` declares choices the app and `--option` can switch; the first value is the default, and an unknown name or value is `BAD_OPTION`
- rules: `check minClearance noOverlap`, run on every build
- sweeps: `noCollision(a, b, { joint, steps })` samples a joint's range, only in `vibecad test`, and reports the first failing value; collisions between samples can be missed
- a check reads other poses with `q.at(joint, value)`
- face names: `<feature>.<face>`, for example `mount[2].side`; a split face gets `~2`
- a swept profile's wall takes its segment's name, or else `side[i]`, its place in the outline counting rounds; an outline of one segment gives `side`
- caps are `top` and `bottom` on an extrude, `start` and `end` on a partial revolve, a sweep and a loft; these and `side` are reserved as segment names
- `fillet` and `chamfer` follow the kernel: they carry on along edges tangent to the selection
- when the kernel refuses a fillet or returns a broken solid, vibecad builds it directly: the fillet's section is swept along each edge, clipped to both faces' outlines, then added to a concave corner or removed from a convex one
- this works for line and planar curved edges where each face is flat, or straight across the edge, such as an extruded wall meeting a plane square to it
- each edge is built alone: only selected edges are filleted, with no carrying on along tangent edges, and a fillet stops flat at the end of its edge
- a refused fillet stays an error when its section would change along the edge, a face curves across the edge, or the radius fits nowhere along the edge

## cli

- `build test query render export diff dev show`, see `vibecad --help`
- `--pose joint=value,...` sets joint values for any command that builds, except `diff` and `dev`; `--option name=value,...` picks the entry's options the same way
- `render --labels` draws all six views and iso with a number on each face, and prints each number's part, face id and views, plus the faces no view can see
- each face is tagged in the view that shows it best, moved aside with a leader line when crowded, and in other views where its tag fits
- the PNG holds only numbers because the kernel's bitmap font lacks many letters; it reads the kernel package's layout and font files, so a kernel upgrade must recheck this

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
- stopping the app stops its running build; a build whose working directory is gone fails with `NO_WORKING_DIR`
- preview builds write to `.vibecad/preview`, so an agent's own build in `.vibecad/out` cannot land in a tab
- other `.ts` files are plain code: not listed, but saving one rebuilds
- the left panel has a slider per joint; moving one changes the view without a rebuild, using the joint data in `model.json`, and never writes the source
- the viewer's pose stays with its tab through rebuilds; a message carries the joints moved away from the source
- the left panel has a select per entry option; picking one rebuilds the tab with it and never writes the source; the selects are locked with a spinner while the tab builds; the pick stays with its tab, a message carries it, and a pick the source no longer has falls back to the defaults
- while the tab on screen builds, the view says so, the same for a first build and a rebuild over the kept model
- a tab's first build fits the camera to the model; a rebuild keeps the camera unless the model's bounds change, then fits again keeping the view direction
- drag orbits; right drag or shift-drag pans; on a trackpad two-finger scroll pans and pinch zooms, and a mouse wheel zooms
- a view cube in the corner turns with the camera and shows the world axes; side labels read upright with +Z up, top and bottom with +Y up, and the camera matches; clicking a face, named like `render`'s views, an edge or a corner turns the camera to look from that side, keeping target and distance
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
- selecting a part in the parts list tints it in the view; hovering its row tints it lighter
- the parts list marks the grounded part with a pin icon
- a feature-history list replays any part step by step, next to its source

## agent sessions

- the preview starts one agent turn per message, prompt through stdin
- vibecad owns its sessions and never touches the person's open terminal sessions
- one session per agent per git branch, in gitignored `.vibecad/sessions.json`
- a session is a disposable cache: durable decisions live in code, commits and `AGENTS.md`
- messages sent during a turn queue and go in the next turn; stop is one button
- permissions are preset for the session: file edits and the vibecad CLI

## status

- modeling priority, draft: constraint solver is next
- wip: fillet runout where a face curves across the edge or the section changes along it, such as on a cone or sphere
- wip: closed-loop linkages and more joint kinds (cylindrical, ball, planar)
- wip: drawn strokes stay in place when a joint moves; pins follow their part
- wip: sketch constraint solver, draft, drawings, sheet metal
- wip: per-feature build cache
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
- 2026-11-09: fill refused fillets on straight concave edges between flat faces
- 2026-11-09: builds stop with the app and fail when their working directory is gone
- 2026-11-09: add sketch planes, sketch offset and splines; add face labels to `render`
- 2026-11-09: add `onFace`, `sweep` and `loft`; build refused fillets on convex edges and curved walls
- 2026-11-10: tint the selected and hovered part from the parts list
- 2026-11-10: ground an assembly on the world frame
- 2026-11-10: add entry options, switched from the app or `--option`
