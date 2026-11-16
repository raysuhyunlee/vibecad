// The live preview server: rebuilds on save, and carries human feedback to the agent.
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { constants as osConstants, homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner, cliCommand, INTRO } from "./agent.ts";
import { CONFIG_FILE } from "./config.ts";
import type { FaceInfo, Model } from "./eval.ts";
import { buildDir, ensureDir, isFresh } from "./fs.ts";
import { STEP_FILE } from "./lang.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "cli.ts");
const VIEWER = resolve(HERE, "../viewer");
const THREE_ROOT = resolve(dirname(fileURLToPath(import.meta.resolve("three"))), "..");
const MAX_BODY = 32 * 1024 * 1024;
const DEV_FILE = ".vibecad/dev.json";
const TUTORIAL = resolve(HERE, "../docs/tutorial.md");
const MAX_FILES = 2000; // keeps an accidental open of a huge folder responsive
const MAX_DIRS = 5000;
const ENTRY_SUFFIX = ".cad.ts";
const isEntry = (path: string) => path.endsWith(ENTRY_SUFFIX) || STEP_FILE.test(path);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** An open file. Its build lives on disk; only the tab on screen holds it in memory. */
interface Tab {
  version: number; // 0 while the tab has no fresh build
  empty?: boolean; // the file has no code yet, so it is not built
  model?: Model;
  meshes?: string;
  error?: unknown;
}
interface Ref {
  n: number;
  part: string;
  face: string;
  point?: number[];
}
interface Feedback {
  text: string;
  entry?: string;
  refs: string[];
  pose?: string;
  screenshot?: string;
  photo?: string; // the reference image's block of the prompt
}

// --- Reference images: a photo or sketch with dimensions drawn over it ---------
const PHOTOS = "refs";
const PHOTO_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DIM_KINDS = ["length", "diameter", "radius", "angle"] as const;
interface Dim {
  id: string;
  label: string;
  kind?: (typeof DIM_KINDS)[number]; // length when absent
  a: number[];
  b: number[];
  c?: number[]; // an angle's vertex
  value: number | null; // null: the agent asks for it
}
interface Photo {
  image: string;
  size: number[];
  entry?: string;
  dims: Dim[];
}
const photoJson = (name: string) => `${PHOTOS}/${name}.json`;
/** Each image with the file it belongs to. */
const listPhotos = () => {
  try {
    const names = readdirSync(PHOTOS).filter((f) => f.endsWith(".json") && PHOTO_NAME.test(f.slice(0, -5))).map((f) => f.slice(0, -5)).sort();
    return names.map((name) => ({ name, entry: readPhoto(name)?.entry }));
  } catch {
    return [];
  }
};
const readPhoto = (name: unknown): Photo | undefined => {
  if (typeof name !== "string" || !PHOTO_NAME.test(name)) return undefined;
  try {
    const p = JSON.parse(readFileSync(photoJson(name), "utf8"));
    return { ...p, dims: Array.isArray(p.dims) ? p.dims : [] };
  } catch {
    return undefined;
  }
};
const point = (v: unknown) => (Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) ? v.map(Number) : undefined);
/** The person's dims as sent by the viewer, keeping only well-formed ones. */
function cleanDims(list: unknown): Dim[] {
  const out: Dim[] = [];
  for (const d of Array.isArray(list) ? list : []) {
    const a = point(d?.a), b = point(d?.b), c = point(d?.c);
    const kind = DIM_KINDS.find((k) => k === d?.kind) ?? "length";
    if (!a || !b || typeof d.id !== "string" || (kind === "angle" && !c)) continue;
    const value = Number.isFinite(d.value) && d.value >= 0 ? Number(d.value) : null;
    out.push({ id: d.id.slice(0, 40), label: String(d.label ?? "").slice(0, 80), kind, a, b, ...(kind === "angle" && { c }), value });
  }
  return out;
}
/** What the agent needs to model a file's images and ask for dimensions over them. */
function photoPrompt(file: string | undefined, photos: { name: string; p: Photo }[], open?: string, added: string[] = []) {
  const n = (v: number[]) => `[${v.map(Math.round).join(",")}]`;
  const list = photos.map(({ name, p }) => {
    const tags = [added.includes(name) && "new", name === open && "open on screen"].filter(Boolean);
    const dims = p.dims.map((d) => {
      const at = d.kind === "angle" && d.c ? `c=${n(d.c)} a=${n(d.a)} b=${n(d.b)}` : `${n(d.a)}-${n(d.b)}`;
      const value = d.value === null ? "asked" : `= ${d.value} ${d.kind === "angle" ? "deg" : "mm"}`;
      return `    ${d.id} ${d.kind ?? "length"} "${d.label}" ${at} ${value}`;
    });
    return [`- ${PHOTOS}/${p.image} (${p.size[0]}x${p.size[1]} px), dims in ${photoJson(name)}${tags.length ? ` (${tags.join(", ")})` : ""}`, ...(dims.length ? dims : ["    no dims yet"])].join("\n");
  });
  return [
    `Reference images: photos of one real object from different sides, or hand sketches of it.`,
    ...list,
    `- Look at every image${added.length ? ", the new ones closely" : ""}. Model the object in ${file ?? "a new .cad.ts file, and set \"entry\" in each json to its project path"}, every dimension a named param; mark params you guessed \`// estimated\`.`,
    `- Ask for the dimensions you still need by adding dims { id, label, kind, a, b, value: null } to the image that shows them best. kind is "length" (a to b), "diameter" (a and b across the circle, through its center), "radius" (a the center, b on the circle) or "angle" (c the vertex, a and b on each ray). Points are in image pixels from the top left, on the edges the dimension spans; label is a few words. Ask each dimension once, on one image. Ask the few that most change the shape first; ask more in later turns.`,
    `- A dim with a number is the person's, in mm or degrees for an angle: measured on the object or meant on a sketch. It wins over the images. Never change or remove it. Remove your asked dims you no longer need.`,
  ].join("\n");
}

/** True when `child` is inside `root`, so a request cannot read outside it. */
function inside(root: string, child: string) {
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && resolve(root, rel) === child;
}

const hiddenName = (name: string) => name.startsWith(".") || name === "node_modules";
const expandHome = (path: string) => path.replace(/^~(?=$|[\\/])/, homedir());

/** The OS's own folder dialog, tried in order; the first that exists runs. */
function folderDialogs(start: string): string[][] {
  if (process.platform === "darwin") {
    return [["osascript", "-e", "on run argv", "-e", "activate", "-e",
      'POSIX path of (choose folder with prompt "Open project" default location (POSIX file (item 1 of argv)))',
      "-e", "end run", start]];
  }
  if (process.platform === "win32") {
    return [["powershell", "-NoProfile", "-STA", "-Command",
      "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; " +
      "$d.SelectedPath = $env:VIBECAD_START; $d.UseDescriptionForTitle = $true; $d.Description = 'Open project'; " +
      "if ($d.ShowDialog((New-Object System.Windows.Forms.Form -Property @{TopMost = $true})) -eq 'OK') { $d.SelectedPath }"]];
  }
  return [
    ["zenity", "--file-selection", "--directory", "--title=Open project", `--filename=${join(start, "")}`],
    ["kdialog", "--getexistingdirectory", start, "--title", "Open project"],
  ];
}

/** Asks the person for a folder. `null` is a cancel; `undefined` means this OS has no dialog to show. */
async function pickFolder(start: string): Promise<string | null | undefined> {
  for (const [cmd, ...args] of folderDialogs(start)) {
    const out = await new Promise<string | null | undefined>((done) => {
      let text = "";
      const child = spawn(cmd!, args, { env: { ...process.env, VIBECAD_START: start }, stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.on("data", (d) => (text += d));
      child.on("error", () => done(undefined));
      child.on("close", (code) => done(code === 0 && text.trim() ? text.trim() : null));
    });
    if (out !== undefined) return out;
  }
  return undefined;
}

/** The project's modeling files, breadth first, relative to the working directory. */
function listFiles() {
  const files: string[] = [];
  const dirs = ["."];
  let i = 0;
  for (; i < dirs.length && i < MAX_DIRS && files.length < MAX_FILES; i++) {
    const dir = dirs[i]!;
    try {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        if (hiddenName(item.name)) continue;
        const path = dir === "." ? item.name : `${dir}/${item.name}`;
        if (item.isDirectory()) dirs.push(path);
        else if (item.isFile() && isEntry(path)) files.push(path);
      }
    } catch {
      // An unreadable folder just stays out of the list.
    }
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), truncated: i < dirs.length };
}

export async function serve(o: {
  port: number;
  agent: string;
  model?: string;
  print: (v: unknown) => void;
}) {
  const agent = new AgentRunner(o.agent, o.model);
  const clients = new Set<ServerResponse>();
  const log: unknown[] = [];
  const queue: Feedback[] = [];
  // The working directory is the open project's root, so builds, agents and
  // `.vibecad/` all resolve against it. One app serves one project at a time.
  let root: string | undefined;
  let entry: string | undefined;
  let project: ReturnType<typeof listFiles> = { files: [], truncated: false };
  let watcher: FSWatcher | undefined;
  const tabs = new Map<string, Tab>();
  let version = 0;
  let feedbackId = 0;

  const emit = (event: unknown) => {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const c of clients) c.write(data);
  };
  const say = (event: Record<string, unknown>) => {
    log.push(event);
    emit({ type: "message", ...event });
  };
  const status = () => {
    emit({ type: "status", running: agent.running, queued: queue.length });
  };

  const entryState = () => {
    const tab = entry ? tabs.get(entry) : undefined;
    return {
      entry,
      tabs: [...tabs].map(([file, t]) => ({ file, version: t.version, failed: !!t.error, empty: !!t.empty })),
      built: !!tab?.model,
      building: buildingFile,
      buildError: tab?.error,
    };
  };
  const hello = () => ({
    type: "hello", root, name: root && basename(root), ...project, ...entryState(), photos: root ? listPhotos() : [],
    log, running: agent.running, queued: queue.length, agent: o.agent,
  });

  // --- Builds ---------------------------------------------------------------
  /** The file's build on disk. Throws when there is none. */
  const readBuild = (file: string) => {
    const dir = buildDir(file);
    return { model: JSON.parse(readFileSync(`${dir}/model.json`, "utf8")) as Model, meshes: readFileSync(`${dir}/meshes.json`, "utf8") };
  };
  /** The tab's build, from memory or else from disk, while nothing it read has changed. */
  const freshBuild = (file: string, tab: Tab) => {
    if (!isFresh(buildDir(file), true)) return undefined;
    if (tab.model && tab.meshes) return { model: tab.model, meshes: tab.meshes };
    try {
      return readBuild(file);
    } catch {
      return undefined;
    }
  };

  let building: ChildProcess | undefined;
  let buildingFile: string | undefined;
  // A build must not outlive the app. Left running, it can lose its project folder too.
  process.on("exit", () => building?.kill());
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => process.exit(128 + osConstants.signals[signal]));
  }
  let timer: NodeJS.Timeout | undefined;
  const runBuild = () => {
    const file = entry;
    if (!file) return;
    building?.kill();
    building = buildingFile = undefined;
    const tab = tabs.get(file);
    let blank = false;
    try {
      blank = !STEP_FILE.test(file) && !readFileSync(file, "utf8").trim();
    } catch {
      // A missing file fails in the build, with its own error.
    }
    if (tab) tab.empty = blank;
    if (blank) {
      Object.assign(tab!, { model: undefined, meshes: undefined, error: undefined, version: 0 });
      emit({ type: "entry", ...entryState() });
      return;
    }
    const args = [CLI, "build", file, "--steps"];
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    building = child;
    buildingFile = file;
    emit({ type: "entry", ...entryState() }); // the viewer shows the build running
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (_code, signal) => {
      if (signal || building !== child) return;
      building = buildingFile = undefined;
      const tab = tabs.get(file);
      if (!tab) return;
      try {
        const r = JSON.parse(out);
        if (r.ok) {
          Object.assign(tab, readBuild(file));
          tab.version = ++version;
          tab.error = undefined;
        } else tab.error = r.error;
      } catch {
        tab.error = { code: "BUILD_CRASHED", message: "The build process crashed. Run vibecad build for details." };
      }
      emit({ type: "entry", ...entryState() });
    });
  };
  /** Rebuilds the tab on screen after a save, unless nothing its build read has changed. */
  const scheduleBuild = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const tab = entry ? tabs.get(entry) : undefined;
      if (tab && (building || !freshBuild(entry!, tab))) runBuild();
    }, 120);
  };

  // --- Project --------------------------------------------------------------
  const newTab = (): Tab => ({ version: 0 });
  /**
   * Shows a tab, opening it if needed. A fresh build on disk shows at once. An out-of-date one is
   * not shown: the tab builds as if for the first time, except the tab already on screen keeps its view.
   */
  const switchTo = (next: string | undefined) => {
    clearTimeout(timer);
    const left = entry ? tabs.get(entry) : undefined;
    entry = next;
    if (next && !tabs.has(next)) tabs.set(next, newTab());
    const tab = next ? tabs.get(next)! : undefined;
    if (left && left !== tab) left.model = left.meshes = undefined;
    if (!tab || buildingFile === next) return;
    building?.kill();
    building = buildingFile = undefined;
    const fresh = freshBuild(next!, tab);
    if (fresh) {
      Object.assign(tab, fresh);
      tab.version ||= ++version; // else the same build the viewer may still hold
      return;
    }
    // Only a rebuild of the tab already on screen keeps its view.
    if (left !== tab) {
      tab.model = tab.meshes = undefined;
      tab.version = 0;
    }
    runBuild();
  };
  const setEntry = (next: string | undefined) => {
    switchTo(next);
    emit({ type: "entry", ...entryState() });
  };
  const closeTab = (file: string) => {
    const open = [...tabs.keys()];
    const i = open.indexOf(file);
    if (i < 0) return;
    tabs.delete(file);
    setEntry(file === entry ? open[i + 1] ?? open[i - 1] : entry);
  };
  /** A project-relative path that exists and passes `accept`, or undefined. */
  const projectFile = (file: unknown, accept: (path: string) => boolean) => {
    if (typeof file !== "string" || !root) return undefined;
    const target = resolve(file);
    if (!accept(target) || !inside(root, target) || !existsSync(target)) return undefined;
    return relative(root, target).replaceAll(sep, "/");
  };
  const projectEntry = (file: unknown) => projectFile(file, isEntry);
  let photosTimer: NodeJS.Timeout | undefined;
  const changedPhotos = new Set<string>();
  const schedulePhotos = (name: string) => {
    changedPhotos.add(name);
    clearTimeout(photosTimer);
    photosTimer = setTimeout(() => {
      emit({ type: "photos", photos: listPhotos(), changed: [...changedPhotos] });
      changedPhotos.clear();
    }, 150);
  };
  let filesTimer: NodeJS.Timeout | undefined;
  const scheduleFiles = () => {
    clearTimeout(filesTimer);
    filesTimer = setTimeout(() => {
      const next = listFiles();
      if (JSON.stringify(next) !== JSON.stringify(project)) {
        project = next;
        emit({ type: "files", ...project });
      }
      for (const file of [...tabs.keys()]) if (!existsSync(file)) closeTab(file);
    }, 200);
  };
  const openProject = (target: string, wanted: unknown, wantedTabs: unknown) => {
    const previous = root;
    process.chdir(target);
    building?.kill();
    building = buildingFile = undefined;
    entry = undefined;
    tabs.clear();
    if (previous) rmSync(resolve(previous, DEV_FILE), { force: true });
    root = process.cwd();
    // The chat picks up where this project's session left off.
    log.splice(0, log.length, ...agent.messages());
    queue.length = 0;
    ensureDir(".vibecad");
    writeFileSync(".vibecad/.gitignore", "*\n");
    writeFileSync(DEV_FILE, JSON.stringify({ port: o.port }));
    project = listFiles();
    watcher?.close();
    watcher = watch(".", { recursive: true }, (_event, file) => {
      if (!file || file.split(/[\\/]/).some(hiddenName)) return;
      const photo = /^refs[\\/]([^\\/]+)\.json$/.exec(file);
      if (photo) schedulePhotos(photo[1]!);
      const source = file.endsWith(".ts") || STEP_FILE.test(file);
      if (source) scheduleBuild();
      if (source || !extname(file)) scheduleFiles();
    });
    watcher.on("error", () => {});
    for (const file of Array.isArray(wantedTabs) ? wantedTabs : []) {
      const path = projectEntry(file);
      if (path) tabs.set(path, newTab());
    }
    switchTo(projectEntry(wanted) ?? project.files.find((f) => f === `main${ENTRY_SUFFIX}`));
    emit(hello());
  };

  // --- Agent turns ----------------------------------------------------------
  const describeRef = (r: Ref) => {
    const part = (entry ? tabs.get(entry)?.model : undefined)?.parts.find((p) => p.path === r.part);
    const face: FaceInfo | undefined = part?.faces.find((f) => f.id === r.face);
    const src = face ? `${face.src.file}:${face.src.line}` : "unknown";
    const point = r.point ? ` point=[${r.point.map((v) => v.toFixed(2)).join(",")}]` : "";
    return `[${r.n}] part=${r.part} (${part?.type ?? "?"}) face=${r.face} surface=${face?.surface ?? "?"} source=${src}${point}`;
  };
  const prompt = (batch: Feedback[], fresh: boolean) => {
    const cli = cliCommand();
    const intro = fresh
      ? `${INTRO} Each message names the entry file they are viewing. ` +
        `Read AGENTS.md if it exists, and ${TUTORIAL} for how to lay out a project. Change the TypeScript source, never generated files. ` +
        `The preview rebuilds on every save. Verify with \`${cli} build <entry>\` and \`${cli} test <entry>\`. ` +
        `Use \`${cli} render <entry>\` to see the result, add \`--labels\` to number each face and get its name, and use\`${cli} show --part P --face F --message M\` ` +
        `to point at geometry when you ask the person something. Commands that build take \`--pose joint=value,...\`. Reply in the person's language, briefly.\n\n`
      : "";
    const body = batch.map((f) => {
      const lines = [`Viewing: ${f.entry ?? "no file yet"}`, `Person said: ${JSON.stringify(f.text)}`];
      if (f.photo) lines.push(f.photo);
      if (f.pose) lines.push(`They moved joints in the viewer, without changing the source. Points and the screenshot use this pose: --pose ${f.pose}`);
      if (f.refs.length) lines.push("They pointed at (tokens like [1] in the text refer to these):", ...f.refs);
      if (f.screenshot) lines.push(`Screenshot of what they see: ${f.screenshot}`);
      return lines.join("\n");
    });
    return intro + body.join("\n\n");
  };
  const flush = async () => {
    if (agent.running || queue.length === 0) return;
    const batch = queue.splice(0);
    const text = prompt(batch, !agent.session());
    const turn = agent.run(text, (e) => say({ role: "agent", ...e }));
    status();
    await turn;
    status();
    void flush();
  };

  // --- HTTP -----------------------------------------------------------------
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((ok, bad) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          bad(new Error("Request too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => ok(Buffer.concat(chunks).toString()));
      req.on("error", bad);
    });
  const json = (res: ServerResponse, value: unknown, code = 200) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const file = (res: ServerResponse, path: string) => {
    if (!existsSync(path)) return json(res, { error: "Not found" }, 404);
    res.writeHead(200, { "content-type": MIME[extname(path)] ?? "application/octet-stream" });
    res.end(readFileSync(path));
  };

  /** Blocks other websites from driving the agent through this local server. */
  const trusted = (req: IncomingMessage) => {
    const hosts = [`127.0.0.1:${o.port}`, `localhost:${o.port}`];
    if (!hosts.includes(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    return !origin || hosts.some((h) => origin === `http://${h}`);
  };

  const server = createServer(async (req, res) => {
    try {
      if (!trusted(req)) return json(res, { error: "Forbidden" }, 403);
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;

      if (req.method === "GET") {
        if (path === "/") return file(res, resolve(VIEWER, "index.html"));
        if (path === "/events") {
          res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
          clients.add(res);
          req.on("close", () => clients.delete(res));
          res.write(`data: ${JSON.stringify(hello())}\n\n`);
          return;
        }
        if (path === "/model") {
          const file = url.searchParams.get("file") ?? entry ?? "";
          const tab = tabs.get(file);
          // A tab off screen serves its build from disk, while it is fresh.
          const b = tab?.version ? (file === entry ? tab.model && tab.meshes && tab : freshBuild(file, tab)) : undefined;
          if (!tab || !b) return json(res, { error: "No build yet" }, 404);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(`{"version":${tab.version},"model":${JSON.stringify(b.model)},"meshes":${b.meshes}}`);
          return;
        }
        if (path === "/export") {
          const target = projectEntry(url.searchParams.get("file"));
          const format = url.searchParams.get("format");
          if (!target) return json(res, { error: "That file is no longer in the project." }, 404);
          if (format !== "step" && format !== "stl") return json(res, { error: "Export as step or stl" }, 400);
          // The CLI reuses the kept build, so a fresh file exports without rebuilding.
          const dir = mkdtempSync(join(tmpdir(), "vibecad-export-"));
          const out = join(dir, `${basename(target).replace(/\.cad\.ts$|\.(step|stp)$/i, "")}.${format}`);
          try {
            const r = await new Promise<any>((done) => {
              const child = spawn(process.execPath, [CLI, "export", target, "--out", out], { stdio: ["ignore", "pipe", "ignore"] });
              let text = "";
              child.stdout.on("data", (d) => (text += d));
              child.on("close", () => {
                try { done(JSON.parse(text)); } catch { done({ ok: false, error: { message: "The export process crashed. Run vibecad export for details." } }); }
              });
            });
            if (!r.ok) return json(res, { error: r.error?.message ?? "Export failed" }, 422);
            res.writeHead(200, {
              "content-type": "application/octet-stream",
              "content-disposition": `attachment; filename="${basename(out)}"`,
              "cache-control": "no-store",
            });
            return res.end(readFileSync(out));
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        }
        if (path === "/source") {
          const target = projectFile(url.searchParams.get("file"), (p) => p.endsWith(".ts"));
          if (!target) return json(res, { error: "Not found" }, 404);
          return json(res, { lines: readFileSync(target, "utf8").split("\n") });
        }
        if (path === "/photo") {
          const p = readPhoto(url.searchParams.get("name"));
          return p ? json(res, p) : json(res, { error: "Not found" }, 404);
        }
        if (path === "/photo/image") {
          const p = readPhoto(url.searchParams.get("name"));
          const target = p && resolve(PHOTOS, String(p.image));
          if (!target || !inside(resolve(PHOTOS), target) || !existsSync(target)) return json(res, { error: "Not found" }, 404);
          res.writeHead(200, { "content-type": /\.png$/i.test(target) ? "image/png" : "image/jpeg", "cache-control": "no-store" });
          return res.end(readFileSync(target));
        }
        if (path === "/dirs") {
          const asked = url.searchParams.get("path");
          const target = resolve(asked ? expandHome(asked) : root ? dirname(root) : homedir());
          try {
            const dirs = readdirSync(target, { withFileTypes: true })
              .filter((d) => !hiddenName(d.name) && (d.isDirectory() ||
                (d.isSymbolicLink() && statSync(join(target, d.name), { throwIfNoEntry: false })?.isDirectory())))
              .map((d) => d.name)
              .sort((a, b) => a.localeCompare(b));
            return json(res, { path: target, parent: dirname(target) === target ? null : dirname(target), dirs });
          } catch {
            return json(res, { error: `Cannot read ${target}. Check the path and its permissions.` }, 400);
          }
        }
        if (path.startsWith("/viewer/")) {
          const target = resolve(VIEWER, path.slice(8));
          return inside(VIEWER, target) ? file(res, target) : json(res, { error: "Not found" }, 404);
        }
        if (path.startsWith("/vendor/three/")) {
          const target = resolve(THREE_ROOT, path.slice(14));
          return inside(THREE_ROOT, target) ? file(res, target) : json(res, { error: "Not found" }, 404);
        }
        return json(res, { error: "Not found" }, 404);
      }

      if (req.method !== "POST") return json(res, { error: "Method not allowed" }, 405);
      if (path === "/project/pick") {
        const picked = await pickFolder(root ? dirname(root) : homedir());
        return picked === undefined ? json(res, { error: "No folder dialog on this system" }, 501) : json(res, { path: picked });
      }
      if (path === "/project") {
        const b = JSON.parse(await readBody(req));
        if (agent.running) return json(res, { error: "Stop the agent before opening another project." }, 409);
        const target = resolve(expandHome(String(b.path ?? "")));
        try {
          if (!statSync(target).isDirectory()) throw new Error();
          accessSync(target, constants.W_OK);
        } catch {
          return json(res, { error: `Cannot open ${target}. It must be a folder you can write to.` }, 400);
        }
        openProject(target, b.entry, b.tabs);
        return json(res, { ok: true });
      }
      if (path === "/entry") {
        const next = projectEntry(JSON.parse(await readBody(req)).file);
        if (!next) return json(res, { error: "That file is no longer in the project." }, 400);
        setEntry(next);
        return json(res, { ok: true });
      }
      if (path === "/tab/close") {
        closeTab(String(JSON.parse(await readBody(req)).file));
        return json(res, { ok: true });
      }
      if (path === "/file/new") {
        if (!root) return json(res, { error: "Open a project first" }, 409);
        let name = String(JSON.parse(await readBody(req)).path ?? "").trim().replaceAll("\\", "/").replace(/^\/+/, "");
        if (!name.endsWith(ENTRY_SUFFIX)) name = name.replace(/\.ts$/, "") + ENTRY_SUFFIX;
        const target = resolve(name);
        if (name === ENTRY_SUFFIX || name.split("/").some((s) => !s || s === ".." || hiddenName(s)) || !inside(root, target)) {
          return json(res, { error: "Use a name like bracket or parts/bracket" }, 400);
        }
        if (existsSync(target)) return json(res, { error: `${name} already exists` }, 409);
        ensureDir(dirname(target));
        writeFileSync(target, "");
        setEntry(name);
        return json(res, { file: name });
      }
      if (path === "/photo") {
        if (!root) return json(res, { error: "Open a project first" }, 409);
        if (!entry) return json(res, { error: "Open or create a file first" }, 409);
        const b = JSON.parse(await readBody(req));
        const size = point(b.size);
        if (typeof b.image !== "string" || !b.image.startsWith("data:image/jpeg;base64,") || !size) {
          return json(res, { error: "The image must be a JPEG with its size" }, 400);
        }
        const base = String(b.name ?? "").toLowerCase().replace(/\.[^.]*$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "photo";
        let name = base;
        for (let i = 2; existsSync(photoJson(name)); i++) name = `${base}-${i}`;
        ensureDir(PHOTOS);
        writeFileSync(`${PHOTOS}/${name}.jpg`, Buffer.from(b.image.slice(23), "base64"));
        writeFileSync(photoJson(name), JSON.stringify({ image: `${name}.jpg`, size, entry, dims: [] } satisfies Photo, null, 2) + "\n");
        return json(res, { name });
      }
      if (path === "/feedback") {
        const b = JSON.parse(await readBody(req));
        const photoName = typeof b.photo?.name === "string" ? b.photo.name : undefined;
        let photo = photoName ? readPhoto(photoName) : undefined;
        if (photoName && !photo) return json(res, { error: "That image is no longer in the project." }, 400);
        if (!entry && !photo) return json(res, { error: "Open a file first" }, 409);
        const added = (Array.isArray(b.photos) ? b.photos : []).filter((name: unknown) => readPhoto(name)) as string[];
        const text = String(b.text ?? "").trim();
        if (!text && !photo && !added.length) return json(res, { error: "Feedback needs text" }, 400);
        if (photo && Array.isArray(b.photo.dims)) {
          photo = { ...photo, dims: cleanDims(b.photo.dims) };
          writeFileSync(photoJson(photoName!), JSON.stringify(photo, null, 2) + "\n");
        }
        const refs: Ref[] = (Array.isArray(b.refs) ? b.refs : []).map((r: any) => ({
          n: Number(r.n), part: String(r.part), face: String(r.face),
          ...(Array.isArray(r.point) && { point: r.point.map(Number) }),
        }));
        const id = ++feedbackId;
        // Described now: the model may be a different file by the time the turn starts.
        const feedback: Feedback = { text, refs: entry ? refs.map(describeRef) : [] };
        if (entry) feedback.entry = entry;
        if (photo || added.length) {
          // Every image of the file goes along: they show one object from different sides.
          const file = photo ? photo.entry : entry;
          const photos = listPhotos().filter((x) => x.name === photoName || added.includes(x.name) || (file && x.entry === file))
            .map(({ name }) => ({ name, p: name === photoName ? photo! : readPhoto(name)! })).filter((x) => x.p);
          feedback.photo = photoPrompt(file, photos, photoName, added);
        }
        const pose = Object.entries(b.pose ?? {}).filter(([, v]) => Number.isFinite(v)).map(([j, v]) => `${j}=${v}`);
        if (pose.length) feedback.pose = pose.join(",");
        if (typeof b.screenshot === "string" && b.screenshot.startsWith("data:image/png;base64,")) {
          ensureDir(".vibecad/feedback");
          feedback.screenshot = `.vibecad/feedback/${Date.now()}-${id}.png`;
          writeFileSync(feedback.screenshot, Buffer.from(b.screenshot.slice(22), "base64"));
        }
        queue.push(feedback);
        const said = text
          || (added.length ? `Model from ${added.length === 1 ? added[0] : `${added.length} images`}` : `Dimensions on ${photoName}`);
        say({ role: "user", kind: "text", text: said, refs: refs.length });
        status();
        void flush();
        return json(res, { ok: true });
      }
      if (path === "/stop") {
        queue.length = 0;
        agent.stop();
        status();
        return json(res, { ok: true });
      }
      if (path === "/session/new") {
        if (!root) return json(res, { error: "Open a project first" }, 409);
        if (agent.running) return json(res, { error: "Stop the agent first" }, 409);
        agent.newSession();
        log.length = 0;
        emit({ type: "reset" });
        return json(res, { ok: true });
      }
      if (path === "/sessions") {
        if (!root) return json(res, { error: "Open a project first" }, 409);
        return json(res, { current: agent.session(), sessions: agent.pastSessions() });
      }
      if (path === "/session/open") {
        if (!root) return json(res, { error: "Open a project first" }, 409);
        if (agent.running) return json(res, { error: "Stop the agent first" }, 409);
        const id = String(JSON.parse(await readBody(req)).id);
        if (!agent.pastSessions().some((s) => s.id === id)) return json(res, { error: "That session is no longer on disk." }, 404);
        agent.useSession(id);
        queue.length = 0;
        log.splice(0, log.length, ...agent.messages(id));
        emit(hello());
        return json(res, { ok: true });
      }
      if (path === "/show") {
        const b = JSON.parse(await readBody(req));
        emit({ type: "show", part: String(b.part), ...(b.face && { face: String(b.face) }) });
        if (b.message) say({ role: "agent", kind: "text", text: String(b.message) });
        return json(res, { ok: true });
      }
      json(res, { error: "Not found" }, 404);
    } catch (e) {
      if (!res.headersSent) json(res, { error: e instanceof Error ? e.message : String(e) }, 500);
    }
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    o.print({
      ok: false,
      error: { code: e.code, message: e.code === "EADDRINUSE" ? `Port ${o.port} is in use. Set another "port" in ${CONFIG_FILE}.` : e.message },
    });
    process.exit(1);
  });
  server.listen(o.port, "127.0.0.1", () => {
    o.print({ ok: true, url: `http://127.0.0.1:${o.port}`, agent: o.agent });
  });
  await new Promise(() => {});
}
