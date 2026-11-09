// The live preview server: rebuilds on save, and carries human feedback to the agent.
import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner, cliCommand } from "./agent.ts";
import { CONFIG_FILE } from "./config.ts";
import type { FaceInfo, Model } from "./eval.ts";
import { STEP_FILE } from "./lang.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "cli.ts");
const VIEWER = resolve(HERE, "../viewer");
const THREE_ROOT = resolve(dirname(fileURLToPath(import.meta.resolve("three"))), "..");
const MAX_BODY = 32 * 1024 * 1024;
const DEV_FILE = ".vibecad/dev.json";
const PREVIEW_DIR = ".vibecad/preview"; // apart from the agent's own builds in .vibecad/out
const MAX_FILES = 2000; // keeps an accidental open of a huge folder responsive
const MAX_DIRS = 5000;
const ENTRY_SUFFIX = ".cad.ts";
const isEntry = (path: string) => path.endsWith(ENTRY_SUFFIX) || STEP_FILE.test(path);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

/** An open file. It keeps its last good build until it closes or the keep limit drops it. */
interface Tab {
  version: number; // 0 while no build is kept
  stale: boolean; // source may have changed since the last build
  leftAt: number; // when it was last on screen, to drop the longest unseen build first
  size: number; // bytes of build output kept
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
  entry: string;
  refs: string[];
  pose?: string;
  screenshot?: string;
}

/** True when `child` is inside `root`, so a request cannot read outside it. */
function inside(root: string, child: string) {
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && resolve(root, rel) === child;
}

const hiddenName = (name: string) => name.startsWith(".") || name === "node_modules";
const expandHome = (path: string) => path.replace(/^~(?=$|[\\/])/, homedir());

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
  keepBytes: number;
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
  let leaveCount = 0;
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
      tabs: [...tabs].map(([file, t]) => ({ file, version: t.version, failed: !!t.error })),
      built: !!tab?.model,
      building: buildingFile,
      buildError: tab?.error,
    };
  };
  const hello = () => ({
    type: "hello", root, name: root && basename(root), ...project, ...entryState(),
    log, running: agent.running, queued: queue.length, agent: o.agent,
  });

  /** Drops the longest unseen builds over the limit. The tab on screen always keeps its build. */
  const enforceKeepLimit = () => {
    let total = 0;
    for (const t of tabs.values()) total += t.size;
    const droppable = [...tabs].filter(([file, t]) => t.model && file !== entry).sort(([, a], [, b]) => a.leftAt - b.leftAt);
    for (const [, t] of droppable) {
      if (total <= o.keepBytes) break;
      total -= t.size;
      t.model = t.meshes = undefined;
      t.size = t.version = 0;
      t.stale = true;
    }
  };

  // --- Builds ---------------------------------------------------------------
  let building: ChildProcess | undefined;
  let buildingFile: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  const runBuild = () => {
    const file = entry;
    if (!file) return;
    building?.kill();
    const child = spawn(process.execPath, [CLI, "build", file, "--steps", "--out-dir", PREVIEW_DIR], { stdio: ["ignore", "pipe", "ignore"] });
    building = child;
    buildingFile = file;
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (_code, signal) => {
      if (signal || building !== child) return;
      building = buildingFile = undefined;
      const tab = tabs.get(file);
      if (!tab) return;
      tab.stale = false;
      try {
        const r = JSON.parse(out);
        if (r.ok) {
          const modelText = readFileSync(`${PREVIEW_DIR}/model.json`, "utf8");
          tab.model = JSON.parse(modelText);
          tab.meshes = readFileSync(`${PREVIEW_DIR}/meshes.json`, "utf8");
          tab.size = modelText.length + tab.meshes.length;
          tab.version = ++version;
          tab.error = undefined;
        } else tab.error = r.error;
      } catch {
        tab.error = { code: "BUILD_CRASHED", message: "The build process crashed. Run vibecad build for details." };
      }
      enforceKeepLimit();
      emit({ type: "entry", ...entryState() });
    });
  };
  const scheduleBuild = () => {
    clearTimeout(timer);
    timer = setTimeout(runBuild, 120);
  };

  // --- Project --------------------------------------------------------------
  const newTab = (): Tab => ({ version: 0, stale: true, leftAt: 0, size: 0 });
  /** Shows a tab, opening it if needed. Only a tab that may be out of date builds. */
  const switchTo = (next: string | undefined) => {
    clearTimeout(timer);
    const left = entry ? tabs.get(entry) : undefined;
    if (left) left.leftAt = ++leaveCount;
    entry = next;
    if (next && !tabs.has(next)) tabs.set(next, newTab());
    enforceKeepLimit();
    if (buildingFile === next) return;
    building?.kill();
    building = buildingFile = undefined;
    if (next && tabs.get(next)!.stale) runBuild();
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
    log.length = 0;
    queue.length = 0;
    mkdirSync(".vibecad", { recursive: true });
    writeFileSync(".vibecad/.gitignore", "*\n");
    writeFileSync(DEV_FILE, JSON.stringify({ port: o.port }));
    project = listFiles();
    watcher?.close();
    watcher = watch(".", { recursive: true }, (_event, file) => {
      if (!file || file.split(/[\\/]/).some(hiddenName)) return;
      const source = file.endsWith(".ts") || STEP_FILE.test(file);
      if (source) {
        for (const tab of tabs.values()) tab.stale = true;
        scheduleBuild();
      }
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
      ? `You are editing a vibecad model from a person's live feedback. Each message names the entry file they are viewing. ` +
        `Read AGENTS.md if it exists. Change the TypeScript source, never generated files. ` +
        `The preview rebuilds on every save. Verify with \`${cli} build <entry>\` and \`${cli} test <entry>\`. ` +
        `Use \`${cli} render <entry>\` to see the result, and \`${cli} show --part P --face F --message M\` ` +
        `to point at geometry when you ask the person something. Commands that build take \`--pose joint=value,...\`. Reply in the person's language, briefly.\n\n`
      : "";
    const body = batch.map((f) => {
      const lines = [`Viewing: ${f.entry}`, `Person said: ${JSON.stringify(f.text)}`];
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
          const tab = tabs.get(url.searchParams.get("file") ?? entry ?? "");
          if (!tab?.model || !tab.meshes) return json(res, { error: "No build yet" }, 404);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(`{"version":${tab.version},"model":${JSON.stringify(tab.model)},"meshes":${tab.meshes}}`);
          return;
        }
        if (path === "/source") {
          const target = projectFile(url.searchParams.get("file"), (p) => p.endsWith(".ts"));
          if (!target) return json(res, { error: "Not found" }, 404);
          return json(res, { lines: readFileSync(target, "utf8").split("\n") });
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
      if (path === "/feedback") {
        if (!entry) return json(res, { error: "Open a file first" }, 409);
        const b = JSON.parse(await readBody(req));
        const text = String(b.text ?? "").trim();
        if (!text) return json(res, { error: "Feedback needs text" }, 400);
        const refs: Ref[] = (Array.isArray(b.refs) ? b.refs : []).map((r: any) => ({
          n: Number(r.n), part: String(r.part), face: String(r.face),
          ...(Array.isArray(r.point) && { point: r.point.map(Number) }),
        }));
        const id = ++feedbackId;
        // Described now: the model may be a different file by the time the turn starts.
        const feedback: Feedback = { text, entry, refs: refs.map(describeRef) };
        const pose = Object.entries(b.pose ?? {}).filter(([, v]) => Number.isFinite(v)).map(([j, v]) => `${j}=${v}`);
        if (pose.length) feedback.pose = pose.join(",");
        if (typeof b.screenshot === "string" && b.screenshot.startsWith("data:image/png;base64,")) {
          mkdirSync(".vibecad/feedback", { recursive: true });
          feedback.screenshot = `.vibecad/feedback/${Date.now()}-${id}.png`;
          writeFileSync(feedback.screenshot, Buffer.from(b.screenshot.slice(22), "base64"));
        }
        queue.push(feedback);
        say({ role: "user", kind: "text", text, refs: refs.length });
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
