# vibecad tech spec

- summary: a CAD for agents, and a feedback system for humans

## key principles

- occt kernel, pinned as wasm: same binary and geometry on every OS
- declarative: code is pure TypeScript that returns a feature graph; only `src/eval.ts` touches the kernel
- a part or an assembly is one instance, made to be produced, so a project has a finite set of them; a factory is the code that makes them
- object oriented: a factory is typed, params are its dimension interface, ports are its connections
- one file, one instance: a `*.cad.ts` file default-exports one part or assembly, so every one can be built and viewed alone
- files are modules: assemblies import the instances of other `*.cad.ts` files; factories live in plain `.ts` files
- libraries and factories are shelves anyone can add to: a library is a folder of instances, a factory folder holds code that makes them; built-in features like `extrude` are factories too
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
- renderer: three.js in a local web page, no build step; agents use `vibecad render` (shaded PNG of the build's meshes)
- server: Node `http` with server-sent events, bound to 127.0.0.1
- voice: browser Web Speech API
- agents: `claude` and `codex` CLIs

## language

- primitives: `box cylinder cone sphere knurl thread extrude revolve sweep loft`
- placement: `box` is centered on XY with its base at z=0, not centered on z; `cylinder` and `cone` stand on z=0 about +z; `sphere` is centered on the origin
- cost: each boolean is a full kernel operation, so hundreds of cuts one by one can take minutes or run out of memory; combine tool bodies into one first, or build a pattern another way
- `knurl(radius, height, { pitch, depth, pattern, angle })` is a knurled cylinder placed like `cylinder`, with `radius` over the crests and faces `side top bottom`; `pattern` is `diamond` (grooves at +-`angle` from the axis, default 30), `pyramid` (grooves along and around the axis) or `straight`
- a knurl is built from flat faces between crests and groove crossings, with no booleans, so it takes well under a second; the tooth count around and the row count up are rounded to whole numbers, so the pitch and a diamond's angle shift slightly to fit, and a pyramid's ends lie on a ring groove
- `thread(radius, height, { pitch, depth, left })` is a threaded rod with 60 degree flanks placed like `cylinder`, with `radius` over the crests, flat ends and faces `side top bottom`; `depth` defaults to 0.5413 x `pitch`; cut it from a part to tap a hole, with `radius` the hole's major radius
- a thread is built from flat triangles like a knurl, because the kernel silently fails to cut a swept helix where it crosses a coaxial cylinder; renders draw every triangle edge, so a thread looks dark
- a `cut` that removes no volume fails with `CUT_NO_EFFECT`
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
- structure: `part assembly port mate revolute slider named place`; `part` and `assembly` define factories, and each call makes one instance
- links: mates and joints join parts into one tree, growing from the ground, or else the first part; a closed loop is `OVER_CONSTRAINED`
- ground: an assembly's `ground: mate(world, port)` fixes that part facing the world frame (origin, +z up, x along +X), with `gap` and `angle` as in a mate; only the entry's ground counts, and `world` anywhere else is `BAD_MATE`
- joints: `revolute(a, b, { angle, min, max, gap })`, default range -180 to 180; `slider(a, b, { min, max, travel, angle })`; both are named in an assembly's `joints`
- a joint's value lives in the source; `--pose` and the viewer only override it. Its path is `sub/name`, and a value outside its range is an error
- a positive angle turns the moving part about its own port's +z; a positive travel separates the ports along the fixed port's +z
- instance: a `.cad.ts` file's default export, `export default Bracket({ ... })`; without one it is `BAD_ENTRY`, and a second exported instance is `MANY_INSTANCES`
- a factory used by one instance can stay unexported in its file; one shared by several goes in a plain `.ts` file
- an assembly places only `.cad.ts` files' instances, at every depth, else `NOT_EXPORTED`
- `place(x)` places an instance again; the same one twice in one assembly is `PLACED_TWICE`

## libraries and factories

- a library is a folder of `.cad.ts` files, a finite set of instances; `import bolt from "lib:std/bolt-m3x8"` imports `std/bolt-m3x8.cad.ts`, and it is placed like a project file's
- a factory folder holds plain `.ts` code; `import { bolt } from "factory:std"` imports `std/index.ts`, and `factory:std/x` imports `std/x.ts`
- a folder is looked up in the project's `libs/` or `factories/`, then `~/.vibecad/libs/` or `~/.vibecad/factories/`, then vibecad's own; the first folder of that name wins whole, so a project pins a library by copying it in
- a name with no folder, or a library path with no file, is `NO_LIBRARY` or `NO_FACTORY`, and the hint lists where it looked
- vibecad ships `lib:std` and `factory:std`: ISO 4762 socket head cap screws, ISO 4032 hex nuts, ISO 7089 washers and deep groove ball bearings, at nominal size without threads; each sits on z=0 with `seat`/`tip` or `bottom`/`top` ports
- adding a library or factory is adding a folder; there is no install command yet
- mates, joints and checks name the places of their own assembly; a joint's path is the place path, so a placed assembly's joints are each its own
- rules: `check minClearance noOverlap`, run on every build
- sweeps: `noCollision(a, b, { joint, steps })` samples a joint's range, only in `vibecad test`, and reports the first failing value; collisions between samples can be missed
- a check reads other poses with `q.at(joint, value)`
- face names: `<feature>.<face>`, for example `mount[2].side`; a split face gets `~2`
- a swept profile's wall takes its segment's name, or else `side[i]`, its place in the outline counting rounds; an outline of one segment gives `side`
- caps are `top` and `bottom` on an extrude, `start` and `end` on a partial revolve, a sweep and a loft; these and `side` are reserved as segment names
- `fillet` and `chamfer` follow the kernel: they carry on along edges tangent to the selection
- when the kernel refuses a fillet or returns a broken solid, vibecad builds it directly: the fillet's section is swept along each edge, clipped to both faces' outlines, then added to a concave corner or removed from a convex one
- where the section keeps its shape along the edge, it is exact; where it changes, or a face curves across the edge, as on a cone or sphere, the rolling ball is solved against both surfaces at stations along the edge and the sections are lofted
- a kernel fillet that grows a solid whose edges are all convex, or shrinks one whose edges are all concave, counts as broken
- each edge is built alone: only selected edges are filleted, with no carrying on along tangent edges, and a fillet stops flat at the end of its edge
- in a corner wider than square, each half of the section is clipped to its own face only, so where a face ends, the other face's half stops at the end of the edge rather than flush with it
- a refused fillet stays an error when the radius fits nowhere along the edge, or when two selected edges meet at a corner, since edges built alone leave the corner unblended

## cli

- `build test query render export diff dev show`, see `vibecad --help`
- `--pose joint=value,...` sets joint values for any command that builds, except `diff` and `dev`
- `build` writes the file's kept build; a posed build is not the source's instance, so it goes to `.vibecad/out`
- a command that builds stops after 30 seconds with `BUILD_TIMEOUT`, or `VIBECAD_BUILD_TIMEOUT` seconds; a watcher process keeps the time, since the kernel blocks the build's own

## builds

- each file's build is kept in `.vibecad/builds/<file>/` until someone deletes it; a part's also holds its solid as BRep
- builds are kept by scope: a project file's, including the project's own `libs/`, in the project; a home or built-in library instance's in `~/.vibecad/builds/lib/<name>/<file>`, which every project reuses; a home folder hides vibecad's of the same name, so they share it
- inside the project an input's path is relative, so the project can move; outside it is absolute
- an assembly reuses the kept build of each part while it is fresh, and builds and keeps the rest; sub-assemblies at any depth compose from the same part builds, and each part is built once however often it is placed
- each build records what it read in `inputs.json`: a content digest of the file and every file it imports, any STEP file it loads, and vibecad's own source, and whether it has feature meshes; and each library or factory folder that would replace one it used, which must stay absent; a build is fresh while all of them match
- the app and the CLI share kept builds, so an agent's build serves the app too
- a part's build also keeps its features: their BReps one after another in `features.brep`, and in `features.json` each one's key, face names and place in that file; a part that changed rebuilds only the features its change reaches
- a feature's key is a digest of its op, name, arguments and inputs, and a loaded STEP file's content, but not its source line, so moving code keeps it; a kept face points at the line of the feature that made it in the current source
- `features.json` holds only the features of the part's last build, and records `FEATURES_VERSION` in `src/eval.ts` with the kernel version; from another version it is ignored and the part builds from scratch
- bump `FEATURES_VERSION` with any change to evaluation that can change a feature's solid or face names, or stale geometry is reused
- `render` shades the build's meshes with a z-buffer and draws edges where the face or depth changes; it draws no hidden edges, since the kernel's exact hidden-line removal took minutes per view on swept threads
- `render --labels` draws all six views and iso with a number on each face, and prints each number's part, face id and views, plus the faces no view can see
- each face is tagged in the view that shows it best, moved aside with a leader line when crowded, and in other views where its tag fits
- the PNG holds only numbers because the kernel's bitmap font lacks many letters; it reads the kernel package's layout and font files, so a kernel upgrade must recheck this

## settings

- `~/.vibecad/config.json`, per user because the app starts before any project opens; read when the app starts
- `port` (4173), `agent` (`claude`), `model` (agent default)
- every key is optional; an unknown key or a bad value stops the app with an error

## app and projects

- `vibecad dev` starts the app with nothing open; it takes no file
- the person opens a project root with the OS's own folder dialog, shown by the local server (Finder, Explorer, or zenity or kdialog); where there is none, or the folder cannot be opened, an in-app folder picker stands in
- opening a project runs its TypeScript in a build process, so only the person's own action opens one
- one app serves one project: the server's working directory is the root, and builds, agents and `.vibecad/` resolve against it
- the left panel lists the root's `*.cad.ts` and STEP files, skipping dot folders and `node_modules`, and updates as files change
- selecting a file opens it in a tab; a project opens on `main.cad.ts` when it has one
- the new-file button takes a name or `folder/name`, creates an empty `.cad.ts` and opens it; a name that exists, leaves the root, or goes through a dot folder is refused
- an empty file is not built: its view offers to add a photo or sketch, or to describe the part in the chat
- a tab shows a fresh kept build without a rebuild, so a file reopened after a restart renders at once
- a tab shown with an out-of-date build does not show it: it builds as if for the first time
- only the tab on screen holds its build in memory; the others read theirs from disk when shown
- pins, the draft message, the pose and the camera stay with their tab until it closes, even when its build is out of date; a pin goes when its face no longer exists
- a message carries only the pins of the tab it is sent from
- only the tab on screen builds; a save rebuilds it over the kept model, unless its build is still fresh
- stopping the app stops its running build; a build whose working directory is gone fails with `NO_WORKING_DIR`
- right-clicking a file in the left panel, or Cmd/Ctrl+E for the file on screen, opens a menu to export it as STEP or STL; a STEP file is an assembly named after the root type with one component per part, named by its path, or one named part; the server runs `vibecad export`, which reuses a fresh kept build, and the browser downloads the file named after the source; a failed export shows in the banner
- other `.ts` files are plain code: not listed, but saving one rebuilds
- the left panel has a slider per joint; moving one changes the view without a rebuild, using the joint data in `model.json`, and never writes the source
- the viewer's pose stays with its tab through rebuilds; a message carries the joints moved away from the source
- while the tab on screen builds, the view says so, the same for a first build and a rebuild over the kept model
- a tab's first build fits the camera to the model; a rebuild keeps the camera unless the model's bounds change, then fits again keeping the view direction
- drag orbits; right drag or shift-drag pans; on a trackpad two-finger scroll pans and pinch zooms, and a mouse wheel zooms
- a view cube in the corner turns with the camera and shows the world axes; side labels read upright with +Z up, top and bottom with +Y up, and the camera matches; clicking a face, named like `render`'s views, an edge or a corner turns the camera to look from that side, keeping target and distance
- the agent session survives a file switch, and each message names the file being viewed
- opening another project is refused while the agent runs
- the browser remembers the last project and its tabs, and reopens them on start; a reopened tab loads its build from disk when first shown, and builds only if it is out of date
- projects anywhere on disk import the language as `"vibecad"`; the CLI resolves it

## friction-free human-agent feedback loop

- in draw mode, click a face to pin it, numbered, with its source line shown
- drag in draw mode to mark an area; the stroke resolves to the faces under it
- hold Space to talk; pins made while talking land in the sentence where they were said: "this [1] should match that [2]"
- sending carries text, face ids, source lines, 3D points and a screenshot
- the agent edits the source, the preview rebuilds on save, changed faces glow
- the agent points back with `vibecad show`
- selecting a part in the parts list tints it in the view; hovering its row tints it lighter
- the parts list marks the grounded part with a pin icon
- the parts list is the instance tree: a placed sub-assembly is a row, named by its place and type, that folds its parts, folded at first; hovering it tints all of them
- a feature-history list replays any part step by step, next to its source

## reference images

- a reference image is a photo of a real object or a hand sketch; the agent models it by asking for dimensions drawn over it
- it lives in the project as `refs/<name>.jpg` and `refs/<name>.json`, tracked in git like STEP files
- the app shrinks an added image so the agent sees it at full size: at most 1568 px on a side and 1.15 megapixels, saved as JPEG
- an image belongs to one modeling file, its `entry`, set when it is added; it is added to the file on screen, so a new part starts as a new file
- `<name>.json` is `{ image, size: [w, h], entry, dims: [{ id, label, kind, a: [x, y], b: [x, y], c?, value }] }`, with points in image pixels from the top left
- `kind` is `length` (a to b, the default), `diameter` (a and b across the circle through its center), `radius` (a the center, b on the circle) or `angle` (c the vertex, a and b on each ray); values are mm, or degrees for an angle
- a dim with `value: null` is the agent asking; a number is the person's, measured on the object or meant on a sketch, and wins over the image
- an end point need not be exact: the label and the value carry the meaning
- the person adds images, several at once, by the button or a drop on the view; adding starts no turn: the images wait as thumbnails above the message box, to open or leave out, and go with the next message, which needs no text
- with them the agent models a draft in `entry` with every dimension a named param, marks guessed ones `// estimated`, and asks for the dims it needs, each once, on the image that shows it best
- the agent asks in rounds, the most important first; it never changes or removes a value the person gave
- the left panel lists the images of the file on screen; opening one shows it over the view, and switching files closes it
- photo mode: the image covers the view with its dims; the person types values, drags end points, drags on the image to add a dim, or removes one
- dims are drawn CAD style, with arrows at both ends; a radius has one, on the circle; a dim the agent asks for is dashed
- a label holds the value, with `Ø` or `R` before a diameter or radius; its name shows on hover or while typing
- a length's label reads along its line, above or below it; when it does not fit between the arrows it goes beyond one end, and the line runs on to it; when it covers another label, a line or an end point, the line moves off its points, with extension lines
- a diameter or radius turns about its center instead, and its label follows the length rules
- an angle is an arc between its rays, its label outside the arc; when the label does not fit, it goes beyond one end and the arc runs on to it; the arc grows to clear other labels, and rays reach it with extension lines
- the person draws lengths; the agent may ask any kind
- overlay mode: the image sits faded over the model and passes the pointer through, so the person orbits the model to match the image; the screenshot sent carries both
- `P` switches between the two modes; closing the image goes back to the model
- every message sent with an image open or added lists all the images of its file with their dims, as views of one object; sending saves the person's dims first, and needs no text when they changed
- an update from the agent keeps the person's unsent edits

## measuring

- outside draw mode, a click picks a face, or an edge within a few pixels of the pointer; picking it again drops it, and empty space clears all
- the picks' dimensions show in the view's lower right corner, at the current pose
- one face: area, and diameter for a cylinder or sphere; one edge: diameter for a circle, radius and length for an arc, else length
- two circles: center distance, and the least and greatest distance between them
- any other two: least distance; two lines, two planes, or a line and a plane add their distance when parallel, else their angle; two parallel cylinders add their axis distance
- three or more: total length of edges or total area of faces
- circles and planes are exact from the kernel; other least distances are over the display mesh, within its 0.05 mm deflection
- a build's `meshes.json` carries each face's surface and each edge as a polyline, with a circle's exact parameters; seams and degenerate edges are left out
- a rebuild or tab switch clears the picks

## agent sessions

- the preview starts one agent turn per message, prompt through stdin
- the first prompt points the agent at `AGENTS.md` and `docs/tutorial.md`
- vibecad owns its sessions and never touches the person's open terminal sessions
- one session per agent per git branch, in gitignored `.vibecad/sessions.json`
- a session is a disposable cache: durable decisions live in code, commits and `AGENTS.md`
- the chat is read back from the agent's own transcript: opening a project shows its current session's conversation
- the history button lists the project's past sessions, newest first, titled by their first message; opening one continues it from the next turn
- vibecad's sessions are the transcripts whose first prompt starts with its intro, so the person's own sessions in the folder stay out
- claude only for now: transcripts under `~/.claude/projects/`; codex lists none
- messages sent during a turn queue and go in the next turn; stop is one button
- permissions are preset for the session: file edits and the vibecad CLI
- no MCP: claude runs with `--strict-mcp-config` and no servers; codex `exec` refuses MCP calls, since it never asks for approval

## status

- modeling priority, draft: constraint solver is next
- wip: closed-loop linkages and more joint kinds (cylindrical, ball, planar)
- wip: drawn strokes stay in place when a joint moves; pins follow their part
- wip: sketch constraint solver, draft, drawings, sheet metal
- wip: isolating the agent from the person's global settings
- wip: reference images: match the overlay camera to the image from dim end points; zoom the image
- not yet verified: how close the agent places asked dims on real photos and sketches
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
- 2026-11-10: keep each build on disk; drop `keepMb`
- 2026-11-10: a part or assembly is an instance, and a `.cad.ts` file is one, replacing options; assemblies place files' instances and reuse their kept builds
- 2026-11-11: show the parts list as the instance tree of sub-assemblies
- 2026-11-12: click to measure faces and edges; pins move to draw mode
- 2026-11-12: keep each feature's result, so a changed part rebuilds only what its change reaches
- 2026-11-12: build refused fillets whose section changes along the edge, or whose face curves across it
- 2026-11-12: add libraries of instances and factory folders, imported as `lib:` and `factory:`, with a built-in `std`
- 2026-11-13: add reference images: the agent models a photo or sketch and asks for dimensions over it
- 2026-11-16: add the `knurl` primitive, built face by face
