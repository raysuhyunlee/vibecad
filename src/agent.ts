// Runs the user's own coding agent, one turn per message, in a session vibecad owns.
// Sessions never touch the user's open terminal sessions.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const SESSIONS_FILE = ".vibecad/sessions.json";
import { ensureDir } from "./fs.ts";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

export type AgentEvent =
  | { kind: "text"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "error"; text: string };

/** Opens the first prompt of every session vibecad starts, which tells its sessions from the person's own. */
export const INTRO = "You are editing a vibecad model from a person's live feedback.";

export interface PastSession {
  id: string;
  title: string;
  updated: number;
}
export type ChatMessage = { role: "user" | "agent"; kind: "text" | "tool"; text: string };

interface History {
  /** vibecad's past sessions for the working directory, newest first. */
  list(): PastSession[];
  /** A session's conversation as the chat shows it. */
  load(id: string): ChatMessage[];
}

interface Adapter {
  history?: History;
  /** The prompt always goes through stdin, so no shell ever parses it. */
  command(session: string | undefined, model?: string, effort?: string): { cmd: string; args: string[]; newSession?: string };
  catalog(): Promise<Catalog>;
  parse(event: any): { session?: string; events: AgentEvent[] };
}

function short(input: unknown) {
  const o = (input ?? {}) as Record<string, unknown>;
  return String(o.command ?? o.file_path ?? o.path ?? o.pattern ?? "").replace(process.cwd() + "/", "").slice(0, 160);
}

const quote = (p: string) => (/\s/.test(p) ? JSON.stringify(p) : p);
/** In the desktop app the agent runs the CLI on the app's own Node, so it needs no Node of its own. */
export function cliCommand() {
  if (!process.versions.electron) return `node ${quote(CLI)}`;
  // The agent inherits ELECTRON_RUN_AS_NODE; the prefix keeps it when a shell drops it.
  const run = `${quote(process.execPath)} ${quote(CLI)}`;
  return process.platform === "win32" ? run : `ELECTRON_RUN_AS_NODE=1 ${run}`;
}

/** What the person said in one prompt: the prompt quotes each message as JSON. */
function said(prompt: string) {
  return [...prompt.matchAll(/^Person said: (".*")$/gm)].map((m) => JSON.parse(m[1]!) as string).filter(Boolean);
}

// Claude keeps each session at ~/.claude/projects/<cwd with every other character as "-">/<id>.jsonl.
const claudeDir = () => join(homedir(), ".claude", "projects", process.cwd().replace(/[^A-Za-z0-9]/g, "-"));
const claudeHistory: History = {
  list() {
    const dir = claudeDir();
    if (!existsSync(dir)) return [];
    const found: PastSession[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, name);
      // The first prompt sits near the top; a session file can be many megabytes.
      const head = Buffer.alloc(64 * 1024);
      const fd = openSync(file, "r");
      const n = readSync(fd, head, 0, head.length, 0);
      closeSync(fd);
      let title: string | undefined;
      for (const line of head.subarray(0, n).toString().split("\n")) {
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (e.type !== "user" || typeof e.message?.content !== "string") continue;
        // A turn from an image alone has no words; the file it was for names it then.
        if (e.message.content.startsWith(INTRO)) title = said(e.message.content)[0] ?? e.message.content.match(/^Viewing: (.+)$/m)?.[1] ?? "";
        break;
      }
      if (title !== undefined) found.push({ id: name.slice(0, -6), title, updated: statSync(file).mtimeMs });
    }
    return found.sort((a, b) => b.updated - a.updated);
  },
  load(id) {
    const file = join(claudeDir(), `${id}.jsonl`);
    if (!/^[\w-]+$/.test(id) || !existsSync(file)) return [];
    const out: ChatMessage[] = [];
    for (const line of readFileSync(file, "utf8").split("\n")) {
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.isSidechain) continue;
      const content = e.message?.content;
      if (e.type === "user" && typeof content === "string") {
        for (const text of said(content)) out.push({ role: "user", kind: "text", text });
      } else if (e.type === "assistant" && Array.isArray(content)) {
        for (const b of content) {
          if (b.type === "text" && b.text) out.push({ role: "agent", kind: "text", text: b.text });
          if (b.type === "tool_use") out.push({ role: "agent", kind: "tool", text: `${b.name} ${short(b.input)}`.trim() });
        }
      }
    }
    return out;
  },
};

export interface AgentModel {
  /** What the agent's model flag takes. */
  id: string;
  /** With its version, as the agent names it. */
  name: string;
  efforts: string[];
  defaultEffort?: string;
}
/** What the agent offers, and what it uses when vibecad names nothing. */
export interface Catalog {
  models: AgentModel[];
  defaultModel?: string;
  defaultEffort?: string;
}

const readJson = (file: string): any => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
};
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Claude's catalog from its initialize response, which lists each model with its version and levels,
 * and resolves the default; the default level comes from its settings.
 */
export function claudeCatalog(response: any, settings: any = readJson(join(homedir(), ".claude", "settings.json"))): Catalog {
  const all: any[] = Array.isArray(response?.models) ? response.models : [];
  const models = all
    .filter((m) => typeof m.value === "string" && m.value !== "default")
    .map((m) => ({ id: m.value, name: String(m.displayName ?? m.value), efforts: Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : [] }));
  // Aliases come first, so the default names the alias that resolves to it.
  const resolved = all.find((m) => m.value === "default")?.resolvedModel;
  const defaultModel = all.find((m) => m.value !== "default" && m.resolvedModel === resolved)?.value;
  return { models, defaultModel, defaultEffort: str(settings?.effortLevel) };
}

/** Asks the claude CLI for its catalog without starting a turn: it answers initialize before any request. */
function fetchClaudeCatalog(): Promise<Catalog> {
  return new Promise((done) => {
    const fallback = () => claudeCatalog({});
    const child = spawn("claude", ["-p", "--output-format", "stream-json", "--verbose", "--input-format", "stream-json", "--strict-mcp-config", "--no-session-persistence"], {
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "ignore"],
    });
    let finished = false;
    const finish = (c: Catalog) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill();
      done(c);
    };
    const timer = setTimeout(() => finish(fallback()), 10000);
    child.on("error", () => finish(fallback()));
    child.on("close", () => finish(fallback()));
    child.stdin!.on("error", () => {});
    child.stdin!.write(JSON.stringify({ type: "control_request", request_id: "catalog", request: { subtype: "initialize" } }) + "\n");
    createInterface({ input: child.stdout! }).on("line", (line) => {
      try {
        const e = JSON.parse(line);
        if (e.type === "control_response") finish(claudeCatalog(e.response?.response ?? e.response));
      } catch {}
    });
  });
}

/** The top-level keys of codex's config.toml, before any table. */
function codexConfig(file: string) {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*(\w+)\s*=\s*"([^"]*)"/.exec(line);
      if (m) out[m[1]!] = m[2]!;
    }
  } catch {}
  return out;
}

/**
 * The models codex lists for the person's account, from the catalog it caches. Its default is the model
 * in its config, else the first by priority; the default level is the config's, else the model's.
 */
export function codexCatalog(cache = join(homedir(), ".codex", "models_cache.json"), config = join(homedir(), ".codex", "config.toml")): Catalog {
  const listed: any[] = (readJson(cache)?.models ?? []).filter((m: any) => m.visibility === "list" && typeof m.slug === "string");
  listed.sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity));
  const models = listed.map((m) => ({
    id: m.slug,
    name: String(m.display_name ?? m.slug),
    efforts: (m.supported_reasoning_levels ?? []).map((l: any) => l.effort).filter((e: unknown) => typeof e === "string"),
    defaultEffort: str(m.default_reasoning_level),
  }));
  const c = codexConfig(config);
  return { models, defaultModel: c.model ?? models[0]?.id, defaultEffort: c.model_reasoning_effort };
}

const claude: Adapter = {
  history: claudeHistory,
  catalog: fetchClaudeCatalog,
  command(session, model, effort) {
    const newSession = session ? undefined : randomUUID();
    return {
      cmd: "claude",
      args: [
        "-p",
        "--output-format", "stream-json", "--verbose",
        "--permission-mode", "acceptEdits",
        "--allowedTools", `Bash(${cliCommand()}:*)`, "Read", "Edit", "Write", "Glob", "Grep",
        // No MCP servers: the agent works through files and the vibecad CLI only.
        "--strict-mcp-config",
        ...(session ? ["--resume", session] : ["--session-id", newSession!]),
        ...(model ? ["--model", model] : []),
        ...(effort ? ["--effort", effort] : []),
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
  catalog: async () => codexCatalog(),
  command(session, model, effort) {
    const options = [
      "--json",
      // A project need not be a git repo or one the person has trusted in codex.
      "--skip-git-repo-check",
      "-c", 'sandbox_mode="workspace-write"',
      ...(model ? ["-m", model] : []),
      ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
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
/** In the order vibecad picks one when the settings name none. */
export const AGENTS = Object.keys(ADAPTERS);
/** How the app names each agent, and how to install it. */
export const AGENT_INFO: Record<string, { name: string; install: string }> = {
  claude: { name: "Claude", install: "npm install -g @anthropic-ai/claude-code" },
  codex: { name: "Codex", install: "npm install -g @openai/codex" },
};
const INSTALL: Record<string, string> = { claude: "Claude Code (claude)", codex: "Codex CLI (codex)" };

/** Whether a command is on PATH, found the way a shell would. */
export function onPath(cmd: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform) {
  const win = platform === "win32";
  const dirs = (env.PATH ?? env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
  const exts = win ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  return dirs.some((dir) =>
    exts.some((ext) => {
      try {
        // Windows names are case-blind, and npm writes its shims in lower case.
        const file = join(dir, cmd + ext.toLowerCase());
        if (!statSync(file).isFile()) return false;
        if (!win) accessSync(file, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

/** `current` with the folders of `fresh` it lacks added at the end, so what resolved before still does. */
export function mergePath(current: string, fresh: string, platform = process.platform) {
  const sep = platform === "win32" ? ";" : ":";
  const key = (d: string) => (platform === "win32" ? d.toLowerCase().replace(/\\+$/, "") : d.replace(/\/+$/, ""));
  const dirs = current.split(sep).filter(Boolean);
  const seen = new Set(dirs.map(key));
  for (const d of fresh.split(sep).map((s) => s.trim()).filter(Boolean)) {
    if (seen.has(key(d))) continue;
    seen.add(key(d));
    dirs.push(d);
  }
  return dirs.join(sep);
}

/**
 * The PATH a newly started app would get: the registry's on Windows, which installers change without
 * reaching running processes; the login shell's elsewhere. Throws when it cannot be read.
 */
export async function freshPath(platform = process.platform): Promise<string> {
  const run = promisify(execFile);
  if (platform === "win32") {
    // UTF-8, or a non-ASCII user folder arrives in the console's code page and no longer matches.
    const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; " +
      "[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))";
    const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 10000, windowsHide: true });
    if (!stdout.trim()) throw new Error("the registry gave no PATH");
    return stdout.trim();
  }
  const shell = process.env.SHELL || "/bin/zsh";
  const { stdout } = await run(shell, ["-ilc", 'printf %s "$PATH"'], { encoding: "utf8", timeout: 10000 });
  // Startup files may print first; the PATH is the last line.
  const path = stdout.trim().split("\n").pop();
  if (!path) throw new Error(`${shell} gave no PATH`);
  return path;
}

/** Adds the folders of a fresh PATH to this process's, which the agents inherit. */
export async function reloadPath() {
  process.env.PATH = mergePath(process.env.PATH ?? "", await freshPath());
}

/** Folders of agent CLIs that desktop apps bundle without adding them to PATH. */
function appDirs(platform = process.platform, env = process.env): string[] {
  if (platform === "darwin") return ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin"];
  if (platform !== "win32" || !env.LOCALAPPDATA) return [];
  // The Codex app keeps codex.exe in one folder per build; the newest is current.
  const bin = join(env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  try {
    const builds = readdirSync(bin).map((d) => join(bin, d)).filter((d) => existsSync(join(d, "codex.exe")));
    builds.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return builds.slice(0, 1);
  } catch {
    return [];
  }
}
// VIBECAD_APP_DIRS replaces the list; tests set it empty.
const APP_DIRS = process.env.VIBECAD_APP_DIRS ?? appDirs().join(process.platform === "win32" ? ";" : ":");
// Added at the end, so a CLI the person installed still wins. The agents inherit it.
process.env.PATH = mergePath(process.env.PATH ?? "", APP_DIRS);

/** The agent CLIs on PATH. */
export const installedAgents = (env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform) => AGENTS.filter((a) => onPath(a, env, platform));

/** The configured agent while it is installed, or else the first one installed; null when none is. */
export const pickAgent = (configured: string | undefined, installed = installedAgents()): string | null =>
  configured && installed.includes(configured) ? configured : installed[0] ?? null;

/** What to tell the person when an agent's CLI is not on PATH. */
export function missingAgent(kind: string | null, installed = installedAgents()) {
  if (!kind || installed.length === 0) {
    return `No agent CLI found on PATH. Install and log in to ${AGENTS.map((a) => INSTALL[a]).join(" or ")}, then check again in the chat.`;
  }
  return `Could not find ${kind} on PATH. Install and log in to it, then restart Vibecad. Or set "agent": "${installed[0]}" in ~/.vibecad/config.json.`;
}

function branch() {
  try {
    return execFileSync("git", ["symbolic-ref", "--short", "HEAD"], { stdio: "pipe" }).toString().trim();
  } catch {
    return "default";
  }
}

export class AgentRunner {
  /** null: no agent CLI is installed, so every turn fails with how to install one. */
  readonly kind: string | null;
  /** Unset: the agent's own default. Changes take effect from the next turn. */
  model: string | undefined;
  effort: string | undefined;
  readonly adapter: Adapter | undefined;
  child: ChildProcess | undefined;

  constructor(kind: string | null, model?: string, effort?: string) {
    const adapter = kind === null ? undefined : ADAPTERS[kind];
    if (kind !== null && !adapter) throw new Error(`Unknown agent "${kind}". Use: ${Object.keys(ADAPTERS).join(", ")}`);
    this.kind = kind;
    this.model = model;
    this.effort = effort;
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
    if (!this.kind) return;
    const all = this.sessions();
    if (id) all[this.key()] = id;
    else delete all[this.key()];
    ensureDir(".vibecad");
    writeFileSync(SESSIONS_FILE, JSON.stringify(all, null, 2));
  }
  session(): string | undefined {
    return this.kind ? this.sessions()[this.key()] : undefined;
  }
  newSession() {
    this.saveSession(undefined);
  }
  /** Continues a past session from the next turn. */
  useSession(id: string) {
    this.saveSession(id);
  }
  catalog(): Promise<Catalog> {
    return this.adapter?.catalog() ?? Promise.resolve({ models: [] });
  }
  pastSessions() {
    return this.adapter?.history?.list() ?? [];
  }
  /** The current session's conversation, or a past one's. */
  messages(id = this.session()) {
    return id && this.adapter?.history ? this.adapter.history.load(id) : [];
  }

  /** Runs one turn. Resolves when the agent exits. */
  run(prompt: string, onEvent: (e: AgentEvent) => void): Promise<void> {
    if (!this.adapter) {
      onEvent({ kind: "error", text: missingAgent(null) });
      return Promise.resolve();
    }
    const adapter = this.adapter;
    const session = this.session();
    const { cmd, args, newSession } = adapter.command(session, this.model, this.effort);
    // Checked first: on Windows a missing command only shows as cmd.exe's own message, in its local code page.
    if (!onPath(cmd)) {
      onEvent({ kind: "error", text: missingAgent(cmd) });
      return Promise.resolve();
    }
    return new Promise((done) => {
      // Windows launches npm-installed CLIs through .cmd shims, which need a shell.
      // Arguments here are fixed flags and ids. The prompt goes through stdin.
      const child = spawn(cmd, args, { shell: process.platform === "win32", stdio: ["pipe", "pipe", "pipe"] });
      this.child = child;
      // Kept as bytes and decoded once, so a character split across chunks stays whole.
      let stderr = Buffer.alloc(0);
      let stopped = false;
      let reported = false;
      const report = (e: AgentEvent) => {
        if (e.kind === "error") {
          if (reported) return; // one failure often arrives as several events
          reported = true;
        }
        onEvent(e);
      };
      child.stderr!.on("data", (d: Buffer) => (stderr = Buffer.concat([stderr, d]).subarray(-8000)));
      child.stdin!.on("error", () => {});
      child.stdin!.end(prompt);
      createInterface({ input: child.stdout! }).on("line", (line) => {
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const r = adapter.parse(event);
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
          report({ kind: "error", text: stderr.toString("utf8").trim().slice(-2000) || `${cmd} exited with code ${code}.` });
        }
        done();
      });
    });
  }

  stop() {
    this.child?.kill();
  }
}
