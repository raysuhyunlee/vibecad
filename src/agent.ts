// Runs the user's own coding agent, one turn per message, in a session vibecad owns.
// Sessions never touch the user's open terminal sessions.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SESSIONS_FILE = ".vibecad/sessions.json";
import { ensureDir } from "./fs.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string };

interface Adapter {
  /** The prompt always goes through stdin, so no shell ever parses it. */
  command(session: string | undefined, model?: string): { cmd: string; args: string[]; newSession?: string };
  parse(event: any): { session?: string; events: AgentEvent[] };
}

function short(input: unknown) {
  const o = (input ?? {}) as Record<string, unknown>;
  return String(o.command ?? o.file_path ?? o.path ?? o.pattern ?? "").replace(process.cwd() + "/", "").slice(0, 160);
}

export function cliCommand() {
  return `node ${/\s/.test(CLI) ? JSON.stringify(CLI) : CLI}`;
}

const claude: Adapter = {
  command(session, model) {
    const newSession = session ? undefined : randomUUID();
    return {
      cmd: "claude",
      args: [
        "-p",
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", `Bash(${cliCommand()}:*)`, "Read", "Edit", "Write", "Glob", "Grep",
        ...(session ? ["--resume", session] : ["--session-id", newSession!]),
        ...(model ? ["--model", model] : []),
      ],
      ...(newSession && { newSession }),
    };
  },
  parse(e) {
    if (e.type === "result" && e.is_error) {
      return { events: [{ kind: "error", text: String(e.result ?? "The agent turn failed.") }] };
    }
    if (e.type !== "assistant") return { events: [] };
    const events: AgentEvent[] = [];
    for (const b of e.message?.content ?? []) {
      if (b.type === "text" && b.text) events.push({ kind: "text", text: b.text });
      if (b.type === "tool_use") events.push({ kind: "tool", text: `${b.name} ${short(b.input)}`.trim() });
    }
    return { events };
  },
};

const codex: Adapter = {
  command(session, model) {
    const options = [
      "--json",
      "-c", 'sandbox_mode="workspace-write"',
      ...(model ? ["-m", model] : []),
    ];
    return {
      cmd: "codex",
      args: session ? ["exec", "resume", ...options, session, "-"] : ["exec", ...options, "-"],
    };
  },
  parse(e) {
    if (e.type === "thread.started") return { session: e.thread_id, events: [] };
    if (e.type !== "item.completed") {
      if (e.type === "turn.failed" || e.type === "error") {
        return { events: [{ kind: "error", text: String(e.error?.message ?? e.message ?? "The agent turn failed.") }] };
      }
      return { events: [] };
    }
    const item = e.item ?? {};
    if (item.type === "agent_message") return { events: [{ kind: "text", text: item.text }] };
    if (item.type === "command_execution") return { events: [{ kind: "tool", text: String(item.command).slice(0, 160) }] };
    if (item.type === "file_change") return { events: [{ kind: "tool", text: "Edit files" }] };
    return { events: [] };
  },
};

const ADAPTERS: Record<string, Adapter> = { claude, codex };

function branch() {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { stdio: "pipe" }).toString().trim();
  } catch {
    return "default";
  }
}

export class AgentRunner {
  readonly kind: string;
  readonly model: string | undefined;
  readonly adapter: Adapter;
  child: ChildProcess | undefined;

  constructor(kind: string, model?: string) {
    const adapter = ADAPTERS[kind];
    if (!adapter) throw new Error(`Unknown agent "${kind}". Use: ${Object.keys(ADAPTERS).join(", ")}`);
    this.kind = kind;
    this.model = model;
    this.adapter = adapter;
  }

  get running() {
    return this.child !== undefined;
  }

  // One session per git branch, per agent.
  private key() {
    return `${this.kind}:${branch()}`;
  }
  private sessions(): Record<string, string> {
    return existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) : {};
  }
  private saveSession(id: string | undefined) {
    const all = this.sessions();
    if (id) all[this.key()] = id;
    else delete all[this.key()];
    ensureDir(".vibecad");
    writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2));
  }
  session() {
    return this.sessions()[this.key()];
  }
  newSession() {
    this.saveSession(undefined);
  }

  /** Runs one turn. Resolves when the agent exits. */
  run(prompt: string, onEvent: (e: AgentEvent) => void): Promise<void> {
    const session = this.session();
    const { cmd, args, newSession } = this.adapter.command(session, this.model);
    return new Promise((done) => {
      // Windows launches npm-installed CLIs through .cmd shims, which need a shell.
      // Arguments here are fixed flags and ids. The prompt goes through stdin.
      const child = spawn(cmd, args, { shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      let stderr = "";
      let stopped = false;
      let reported = false;
      const report = (e: AgentEvent) => {
        if (e.kind === "error") {
          if (reported) return; // one failure often arrives as several events
          reported = true;
        }
        onEvent(e);
      };
      child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const r = this.adapter.parse(event);
        if (r.session && r.session !== session) this.saveSession(r.session);
        r.events.forEach(report);
      });
      child.on("error", (e) => {
        report({ kind: "error", text: `Could not start ${cmd}: ${e.message}. Install and log in to it, then send again.` });
      });
      child.on("close", (code, signal) => {
        stopped = signal !== null;
        this.child = undefined;
        if (code === 0 && newSession) this.saveSession(newSession);
        if (code !== 0 && code !== null && !stopped) {
          report({ kind: "error", text: stderr.trim() || `${cmd} exited with code ${code}.` });
        }
        done();
      });
    });
  }

  stop() {
    this.child?.kill();
  }
}
