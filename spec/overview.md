# vibecad tech spec

- summary: a CAD for agents, and a feedback system for humans

## key principles

- occt kernel, pinned as wasm: same binary and geometry on every OS
- declarative: code is pure TypeScript that returns a feature graph; only `src/eval.ts` touches the kernel
- a part or an assembly is one instance, made to be produced, so a project has a finite set of them; a factory is the code that makes them
- object oriented: a factory is typed, params are its dimension interface, ports are its connections
- a part is made of bodies: a body is one connected solid with its own feature history; a feature is one operation vibecad supports, a primitive, a boolean, a transform and the like
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
- voice: Whisper small, run locally with transformers.js
- agents: `claude` and `codex` CLIs
- desktop app: Electron, which runs `vibecad dev` on its own bundled Node and shows it in a window

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
- a part's build returns a solid, `{ solid }`, or `{ bodies: { name: solid } }`; one solid is the body `body`; giving both or no bodies is an error, and a body that is not exactly one solid is `NOT_ONE_SOLID`
- a part's faces keep their feature names across bodies, so face ids do not name the body; `model.json` lists each part's `bodies` as `{ name, steps }`, the ids of the steps first reached from that body in build order, the body last
- links: mates and joints join parts into one tree, growing from the ground, or else the first part; a closed loop is `OVER_CONSTRAINED`
- ground: an assembly's `ground: mate(world, port)` fixes that part facing the world frame (origin, +z up, x along +X), with `gap` and `angle` as in a mate; only the entry's ground counts, and `world` anywhere else is `BAD_MATE`
- joints: `revolute(a, b, { angle, min, max, gap })`, default range -180 to 180; `slider(a, b, { min, max, travel, angle })`; both are named in an assembly's `joints`
- motions: `motion([{ t, pose }, ...])` animates joints through keyframes, `t` in seconds rising from 0, `pose` by joint path from its assembly; each joint eases between the keys that set it and holds outside them; `ease` (`linear in out inOut step`, cubic, `step` jumps at the key) shapes the way into a key, set per key or as `motion(keys, { ease })`, `linear` by default; named in an assembly's `motions`, a path like a joint's. A bad `t` or ease, or an empty motion, is `BAD_MOTION`; an unknown joint or out-of-range value is `NO_SUCH_JOINT` or `JOINT_OUT_OF_RANGE`
- assembly sequence: every assembly has one, derived from its links with no source of its own; a part goes in once the part it mates or joints to is in, and of the parts ready, the first in the leaf order of `parts` goes first; the ground part, or else the first part, starts it
- each step comes in along its link's fixed port +z at the build pose, the direction a positive gap separates; a grounded part comes in along world +z; `model.json` carries it as `sequence: [{ part, on, axis }]`, and build output lists the part paths
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
- `agent` (`claude`), `model` (agent default)
- every key is optional; an unknown key or a bad value stops the app with an error

## app and projects

- the desktop app is the only way to run the app; it starts with nothing open
- the app uses the approved diamond-cut orange V icon and dark wordmark splash from `design/vibecad-logo.pen`; the splash shows the app version at its bottom left; exports live in `app/assets/`, including macOS, Windows and Linux icons
- startup shows the splash before resolving the login shell's PATH or starting the server; the main window stays hidden until its first paint and the viewer's first server state, then replaces the splash without an artificial delay
- closing the splash cancels startup; a startup timeout or load failure shows an error and quits
- the desktop app runs `vibecad dev --socket <path>` as a child, on a local socket in its data folder, and its window loads `vibecad://app/`, whose requests it passes to that socket; so it opens no port and clashes with no other app; one runs at a time; `dev` takes no file
- the server stopping, or failing to start, shows an error and quits the desktop app
- `.vibecad/dev.json` records the server's socket, so `vibecad show` reaches it
- the desktop app reads PATH from the login shell, so the agent CLIs are found when started from Finder; builds and the agent run vibecad's CLI on the app's own Node, with `ELECTRON_RUN_AS_NODE`
- `just build` packages the desktop app into `dist/` for this OS; `--mac --win --linux` pick others; macOS gets a dmg and a zip, signed and notarized when `.env` holds the keys (see `.env.example`), with the microphone entitlement voice needs; Windows gets an unsigned NSIS installer; Linux gets an AppImage
- work lands on `dev`; a pull request merges it to `main`; CI tests and typechecks both
- a `v<version>` tag on `main`, matching `package.json`, makes CI build macOS arm64 (signed and notarized from repo secrets), Windows x64 and Linux x64 and upload them to a draft GitHub release of `raysuhyunlee/vibecad`; its notes start with direct links to the DMG, EXE and AppImage, followed by generated release notes; publishing the draft ships the update
- the packaged app checks GitHub releases at start and every 4 hours and downloads nothing on its own; a newer release opens a modal titled `New version is out!` with the version and the release's `What's New` (or GitHub's `What's Changed`) section, which scrolls when long; a failed check is only logged. macOS updates from the zip, Windows from the installer
- `Install and Restart` downloads with a progress bar, then installs silently and reopens the app; `Cancel` or closing stops the download; `Later` or closing puts that version off until the next manual check; a failed download shows its error in the modal
- `Check for Updates...` lives below About in the macOS Vibecad menu, and in Help on Windows and Linux; a manual check shows checking status and opens the modal, or reports the latest version or an error
- the person opens a project root with the desktop app's own folder dialog; where the folder cannot be opened, an in-app folder picker says why
- opening a project runs its TypeScript in a build process, so only the person's own action opens one
- one app serves one project: the server's working directory is the root, and builds, agents and `.vibecad/` resolve against it
- the left panel lists the root's `*.cad.ts` and STEP files, skipping dot folders and `node_modules`, and updates as files change
- selecting a file opens it in a tab; a project opens on `main.cad.ts` when it has one
- the new-file button takes a name or `folder/name`, creates an empty `.cad.ts` and opens it; a name that exists, leaves the root, or goes through a dot folder is refused
- an empty file is not built: its model view offers to add a photo or sketch, or to describe the part in the chat
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
- above the sliders, a row per motion toggles playing it in a loop over the view's pose; one plays at a time, and moving a slider, resetting one or switching tabs stops it where it is
- an assembly of two or more parts gets an `Assembly` row first, which plays its sequence once over the view's pose: parts not in yet are hidden, and each in turn slides 0.6 s into place from a few of its own sizes away, at least a quarter of the model's diagonal, 0.8 s per part; it ends on the whole model
- the assembly plays like a motion: one plays at a time, and anything that stops a motion, previewing a feature step, or pressing it again stops it and shows the whole model; it starts by clearing the picks
- the viewer's pose stays with its tab through rebuilds; a message carries the joints moved away from the source
- while the tab on screen builds, the view says so, the same for a first build and a rebuild over the kept model
- a tab's first build fits the camera to the model; a rebuild keeps the camera unless the model's bounds change, then fits again keeping the view direction
- drag orbits; right drag or shift-drag pans; on a trackpad two-finger scroll pans and pinch zooms, and a mouse wheel zooms
- a view cube in the corner turns with the camera and shows the world axes; side labels read upright with +Z up, top and bottom with +Y up, and the camera matches; clicking a face, named like `render`'s views, an edge or a corner turns the camera to look from that side, keeping target and distance
- the agent session survives a file switch, and each message names the file being viewed
- opening another project is refused while the agent runs
- the window remembers the last project and its tabs, and reopens them on start; a reopened tab loads its build from disk when first shown, and builds only if it is out of date
- projects anywhere on disk import the language as `"vibecad"`; the CLI resolves it

## friction-free human-agent feedback loop

- in draw mode, click a face to pin it, numbered, with its source line shown
- drag in draw mode to mark an area; the stroke resolves to the faces under it
- draw mode turns off after one pin or stroke; a click that hits nothing keeps it on
- hold Space to talk; pins made while talking land in the sentence where they were said: "this [1] should match that [2]"
- speech never leaves the machine: the window records it, and the server transcribes it with Whisper in the OS language, with each word's time; a pin goes after the words said before it
- the speech model, about 260 MB, downloads into `~/.vibecad/models` on first use; it loads while the person talks
- sending carries text, face ids, source lines, 3D points and a screenshot
- the agent edits the source, the preview rebuilds on save, changed faces glow
- the agent points back with `vibecad show`
- the model tree floats over the view's top left with no panel behind it, each row on its own background: a placed sub-assembly folds its parts, a part its bodies, a body its features; a file of one part opens on it, and a part of one body on that body; everything else starts folded
- each row starts with an icon of its kind: assembly, part, body, or the feature's op; a sub-assembly or a placed part also shows its type, and hovering one tints all its parts
- selecting a part row tints it in the view; hovering it tints it lighter; the grounded part has a pin icon
- every feature is a row, named transforms and unnamed ones alike, in build order, named by its feature name
- clicking a feature shows its part as it was after it, the rest ghosted, with its source; clicking it again goes back
- a part's or body's play button plays its features in build order, 0.7 s each, marking the row playing; each step shows every solid made so far that no later feature has used, tools faint; a translate or rotate moves its input into place; anything else wipes from its input to its result along the extrude's direction, or +z, with a boolean's tools fading as the wipe passes; it ends on the whole model
- its stop button, clicking a feature, playing a motion or the assembly, or switching tabs stops it

## reference images

- a reference image is a photo of a real object or a hand sketch; the agent models it by asking for dimensions drawn over it
- it lives in the project as `refs/<name>.jpg` and `refs/<name>.json`, tracked in git like STEP files
- the app shrinks an added image so the agent sees it at full size: at most 1568 px on a side and 1.15 megapixels, saved as JPEG
- an image belongs to one modeling file, its `entry`, set when it is added; it is added to the file on screen, so a new part starts as a new file
- `<name>.json` is `{ image, size: [w, h], entry, dims: [{ id, label, kind, a: [x, y], b: [x, y], c?, r?, value }] }`, with points and r in image pixels from the top left
- `kind` is `length` (a to b, the default), `diameter` (c the center and r the radius, no a or b; an older a and b across the circle read as its center and radius), `radius` (a the center, b on the arc, where it shows) or `angle` (c the vertex, a and b on each ray); values are mm, or degrees for an angle
- a dim with `value: null` is the agent asking; a number is the person's, measured on the object or meant on a sketch, and wins over the image
- an end point need not be exact: the label and the value carry the meaning
- the person adds images, several at once, by the button or a drop on the view, the model or the images alike; adding starts no turn and shows the image browser: the images wait as thumbnails above the message box, to open or leave out, and go with the next message, which needs no text
- with them the agent models a draft in `entry` with every dimension a named param, marks guessed ones `// estimated`, and asks for the dims it needs, each once, on the image that shows it best, with end points on the features themselves even when dims crowd
- the agent asks in rounds, the most important first; it never changes or removes a value the person gave
- a bar at the bottom of the view switches between the model and the image browser, `I` too; it shows once the file has an image; switching files goes back to the model
- an image with asked dims the person has not filled shows their count, `N to measure` on its tile and a number on its strip thumbnail, counting unsent values as they are typed
- the image browser shows the file's images in a grid, with a tile to add more; deleting one, after a confirm, removes its jpg and json
- opening an image shows a strip of the file's images on top, the open one marked, and the image below; a grid button goes back to the grid; going to the model and back reopens it
- the browser's button sends a message with no text: `Model from N new images` while there are added images, else `Update model`, enabled while some image's dims changed
- an open image fills the space below the strip with its dims; the person types values, drags end points (a diameter's or radius's are its center and a point on its circle at its arrow, which sizes a diameter or moves a radius along), drags on the image to add a dim, or removes one
- dims are drawn CAD style, with arrows at both ends; a radius has one, on the circle; a dim the agent asks for is dashed
- a label holds the value, with `Ø` or `R` before a diameter or radius; its name shows on hover or while typing
- a length's label reads along its line, above or below it; when it does not fit between the arrows it goes beyond one end, and the line runs on to it; when it covers another label, a line or an end point, or runs close beside another dim's line, arrows or label, the line and its arrows move off its points, parallel, with an extension line square to it from each point
- a diameter draws its circle, a radius the arc of its circle around its end; its line turns about the center instead of moving off, so concentric ones turn apart, and its label follows the length rules, a diameter's also sitting off its center
- an angle is an arc between its rays, its label outside the arc; when the label does not fit, it goes beyond one end and the arc runs on to it; the arc grows to clear other labels, and rays reach it with extension lines
- the person draws lengths; the agent may ask any kind
- the person's unsent dims stay with their image when another opens, and go with the next message
- every message sent with an image open, added, or with changed dims lists all the images of its file with their dims, as views of one object; sending saves the person's dims first, and needs no text when they changed
- an update from the agent keeps the person's unsent edits

## measuring

- outside draw mode, a click picks a face, or an edge within a few pixels of the pointer; picking it again drops it, and empty space clears all, including a part or feature selected in the tree
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
- wip: reference images: zoom the image
- not yet verified: how close the agent places asked dims on real photos and sketches
- wip: npm distribution. Node will not strip types under `node_modules`, so vibecad runs from this repo today; a release needs compiled output
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
- 2026-11-16: package the app as an Electron desktop app, served over a local socket
- 2026-11-17: drop the browser app; voice runs locally with Whisper
- 2026-11-17: update the desktop app from GitHub releases; Windows gets an installer
- 2026-11-22: ask before downloading an update, since a release is over 200MB
- 2026-11-22: animate joints with named motions, played from the viewer
- 2026-11-23: play an assembly's sequence, derived from its links, from the viewer
- 2026-11-24: a part is made of named bodies; the model tree moves into the view, lists every feature with an icon of its kind, and plays a part's features in order
