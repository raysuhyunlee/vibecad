// App settings. The CLI takes actions; how the app behaves lives in this one file.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDir } from "./fs.ts";
import { CadError } from "./eval.ts";

export const CONFIG_FILE = join(homedir(), ".vibecad", "config.json");

export interface Config {
  port: number;
  agent: string;
  model?: string;
  /** "ask": the agent asks before a tool's first use. "all": it may use any tool. */
  permissions: "ask" | "all";
  /** Tools the person allowed on first use, as agent permission rules. */
  allowedTools: string[];
}

const VALID: Record<keyof Config, [(v: unknown) => boolean, string]> = {
  port: [(v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535, "a port number"],
  agent: [(v) => typeof v === "string", "a string"],
  model: [(v) => typeof v === "string", "a string"],
  permissions: [(v) => v === "ask" || v === "all", '"ask" or "all"'],
  allowedTools: [(v) => Array.isArray(v) && v.every((t) => typeof t === "string"), "a list of strings"],
};

export function loadConfig(): Config {
  const config: Config = { port: 4173, agent: "claude", permissions: "ask", allowedTools: [] };
  if (!existsSync(CONFIG_FILE)) return config;
  let file: Record<string, unknown>;
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    throw new CadError("BAD_CONFIG", `${CONFIG_FILE} is not valid JSON: ${e instanceof Error ? e.message : e}`);
  }
  for (const [key, value] of Object.entries(file)) {
    const rule = VALID[key as keyof Config];
    if (!rule) throw new CadError("BAD_CONFIG", `Unknown setting "${key}" in ${CONFIG_FILE}`, undefined, `Settings: ${Object.keys(VALID).join(", ")}`);
    if (!rule[0](value)) throw new CadError("BAD_CONFIG", `"${key}" in ${CONFIG_FILE} must be ${rule[1]}`);
  }
  return { ...config, ...file };
}

/** Writes changed settings, keeping the rest of the file. */
export function saveConfig(change: Partial<Config>) {
  const file = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
  ensureDir(dirname(CONFIG_FILE));
  writeFileSync(CONFIG_FILE, JSON.stringify({ ...file, ...change }, null, 2) + "\n");
}
