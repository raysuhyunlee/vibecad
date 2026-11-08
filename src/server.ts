// The live preview server: rebuilds on save, and carries human feedback to the agent.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner, cliCommand } from "./agent.ts";
import type { FaceInfo, Model } from "./eval.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "cli.ts");
const VIEWER = resolve(HERE, "../viewer");
const THREE_ROOT = resolve(dirname(fileURLToPath(import.meta.resolve("three"))), "..");
const MAX_BODY = 32 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

interface Ref {
  n: number;
  part: string;
  face: string;
  point?: number[];
}
interface Feedback {
  text: string;
  refs: Ref[];
  screenshot?: string;
}

/** True when `child` is inside `root`, so a request cannot read outside it. */
function inside(root: string, child: string) {
  const rel = relative(root, child);
  return rel !== "" && !rel.startsWith("..") && !rel.startsWith(sep) && resolve(root, rel) === child;
}

export async function serve(o: {
  entry: string;
  port: number;
  agent: string;
  model?: string;
  print: (v: unknown) => void;
}) {
  const agent = new AgentRunner(o.agent, o.model);
  const clients = new Set<ServerResponse>();
  const log: unknown[] = [];
  const queue: Feedback[] = [];
  let model: Model | undefined;
  let buildError: unknown;
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

  // --- Builds ---------------------------------------------------------------
  let building: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  const runBuild = () => {
    building?.kill();
    const child = spawn(process.execPath, [CLI, "build", o.entry, "--steps"], { stdio: ["ignore", "pipe", "ignore"] });
    building = child;
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.on("close", (_code, signal) => {
      if (signal || building !== child) return;
      building = undefined;
      try {
        const r = JSON.parse(out);
        if (r.ok) {
          model = JSON.parse(readFileSync(".vibecad/out/model.json", "utf8"));
          buildError = undefined;
          emit({ type: "build", ok: true, version: ++version });
        } else {
          buildError = r.error;
          emit({ type: "build", ok: false, error: r.error });
        }
      } catch {
        buildError = { code: "BUILD_CRASHED", message: "The build process crashed. Run vibecad build for details." };
        emit({ type: "build", ok: false, error: buildError });
      }
    });
  };
  const scheduleBuild = () => {
    clearTimeout(timer);
    timer = setTimeout(runBuild, 120);
  };
  watch(".", { recursive: true }, (_event, file) => {
    if (!file) return;
    const top = file.split(/[\\/]/)[0];
    if (top === "node_modules" || top === ".vibecad" || top === ".git") return;
    if (file.endsWith(".ts")) scheduleBuild();
  });

  // --- Agent turns ----------------------------------------------------------
  const describeRef = (r: Ref) => {
    const part = model?.parts.find((p) => p.path === r.part);
    const face: FaceInfo | undefined = part?.faces.find((f) => f.id === r.face);
    const src = face ? `${face.src.file}:${face.src.line}` : "unknown";
    const point = r.point ? ` point=[${r.point.map((v) => v.toFixed(2)).join(",")}]` : "";
    return `[${r.n}] part=${r.part} (${part?.type ?? "?"}) face=${r.face} surface=${face?.surface ?? "?"} source=${src}${point}`;
  };
  const prompt = (batch: Feedback[], fresh: boolean) => {
    const cli = cliCommand();
    const intro = fresh
      ? `You are editing a vibecad model from a person's live feedback. The entry file is ${o.entry}. ` +
        `Read AGENTS.md first. Change the TypeScript source, never generated files. ` +
        `The preview rebuilds on every save. Verify with \`${cli} build ${o.entry}\` and \`${cli} test ${o.entry}\`. ` +
        `Use \`${cli} render ${o.entry}\` to see the result, and \`${cli} show --part P --face F --message M\` ` +
        `to point at geometry when you ask the person something. Reply in the person's language, briefly.\n\n`
      : "";
    const body = batch.map((f) => {
      const lines = [`Person said: ${JSON.stringify(f.text)}`];
      if (f.refs.length) lines.push("They pointed at (tokens like [1] in the text refer to these):", ...f.refs.map(describeRef));
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
          res.write(`data: ${JSON.stringify({ type: "hello", version, buildError, log, running: agent.running, queued: queue.length, agent: o.agent })}\n\n`);
          return;
        }
        if (path === "/model") {
          if (!existsSync(".vibecad/out/meshes.json") || !model) return json(res, { error: "No build yet" }, 404);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(`{"model":${JSON.stringify(model)},"meshes":${readFileSync(".vibecad/out/meshes.json", "utf8")}}`);
          return;
        }
        if (path === "/source") {
          const target = resolve(url.searchParams.get("file") ?? "");
          if (!target.endsWith(".ts") || !inside(process.cwd(), target) || !existsSync(target)) {
            return json(res, { error: "Not found" }, 404);
          }
          return json(res, { lines: readFileSync(target, "utf8").split("\n") });
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
      if (path === "/feedback") {
        const b = JSON.parse(await readBody(req));
        const text = String(b.text ?? "").trim();
        if (!text) return json(res, { error: "Feedback needs text" }, 400);
        const refs: Ref[] = (Array.isArray(b.refs) ? b.refs : []).map((r: any) => ({
          n: Number(r.n), part: String(r.part), face: String(r.face),
          ...(Array.isArray(r.point) && { point: r.point.map(Number) }),
        }));
        const id = ++feedbackId;
        const feedback: Feedback = { text, refs };
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
      error: { code: e.code, message: e.code === "EADDRINUSE" ? `Port ${o.port} is in use. Pass another with --port.` : e.message },
    });
    process.exit(1);
  });
  server.listen(o.port, "127.0.0.1", () => {
    mkdirSync(".vibecad", { recursive: true });
    writeFileSync(".vibecad/dev.json", JSON.stringify({ port: o.port }));
    runBuild();
    o.print({ ok: true, url: `http://127.0.0.1:${o.port}`, agent: o.agent, entry: o.entry });
  });
  await new Promise(() => {});
}
