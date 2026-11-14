// App settings. The CLI takes actions; how the app behaves lives in this one file.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CadError } from "./eval.ts";

export const CONFIG_FILE = join(homedir(), ".vibecad", "config.json");

export interface Config {
  port: number;
  agent: string;
  model?: string;
}

const VALID: Record<keyof Config, [(v: unknown) => boolean, string]> = {
  port: [(v) => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 65535, "a port number"],
  agent: [(v) => typeof v === "string", "a string"],
  model: [(v) => typeof v === "string", "a string"],
};

export function loadConfig(): Config {
  const config: Config = { port: 4173, agent: "claude" };
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
