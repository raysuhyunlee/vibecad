// App settings. The CLI takes actions; how the app behaves lives in this one file.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CadError } from "./eval.ts";

export const CONFIG_FILE = join(homedir(), ".vibecad", "config.json");

export interface Config {
  /** Unset: the app picks the first agent CLI on PATH. */
  agent?: string;
  model?: string;
}

const VALID: Record<keyof Config, [(v: unknown) => boolean, string]> = {
  agent: [(v) => typeof v === "string", "a string"],
  model: [(v) => typeof v === "string", "a string"],
};

/**
 * Saves the agent picked in the app. A model name belongs to one agent, so a change of agent drops it.
 * Other keys stay as the person wrote them.
 */
export function saveAgent(agent: string) {
  const file: Record<string, unknown> = existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, "utf8")) : {};
  if (file.agent !== agent) delete file.model;
  file.agent = agent;
  mkdirSync(dirname(CONFIG_FILE), { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(file, null, 2) + "\n");
}

export function loadConfig(): Config {
  const config: Config = {};
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
