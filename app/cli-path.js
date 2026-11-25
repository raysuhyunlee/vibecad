// Puts a `vibecad` command on the person's PATH, so their own agent tools can run the installed app's CLI.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const MARK = ".vibecad/bin";
const sh = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The launcher script for this platform. An AppImage mounts at a new path each run,
 * so its launcher goes through the AppImage itself, which relays to the CLI.
 */
export function shim({ platform, exe, cli, appImage }) {
  if (platform === "win32") {
    return { name: "vibecad.cmd", text: `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${exe}" "${cli}" %*\r\n` };
  }
  const run = appImage ? `VIBECAD_CLI=1 exec ${sh(appImage)} "$@"` : `ELECTRON_RUN_AS_NODE=1 exec ${sh(exe)} ${sh(cli)} "$@"`;
  return { name: "vibecad", text: `#!/bin/sh\n# Written by Vibecad on each launch.\n${run}\n` };
}

/** The startup files of the person's shell that should put the bin folder on PATH. */
export function rcFiles({ platform, shell, home }) {
  const name = basename(shell || "");
  if (name === "zsh") return [join(home, ".zshrc")];
  if (name === "bash") return [join(home, ".bashrc"), ...(platform === "darwin" ? [join(home, ".bash_profile")] : [])];
  return [];
}

/** Writes the launcher, and adds its folder to PATH once. Returns the launcher's path. */
export function installCli({ platform = process.platform, shell = process.env.SHELL, home, exe, cli, appImage }) {
  const bin = join(home, ".vibecad", "bin");
  mkdirSync(bin, { recursive: true });
  const { name, text } = shim({ platform, exe, cli, appImage });
  const file = join(bin, name);
  if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
  if (platform !== "win32") chmodSync(file, 0o755);

  if (platform === "win32") {
    // The user PATH, so new terminals see it without a restart or admin rights.
    const b = bin.replace(/'/g, "''");
    const ps = `$p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -notcontains '${b}') { [Environment]::SetEnvironmentVariable('Path', ((@($p, '${b}') | Where-Object { $_ }) -join ';'), 'User') }`;
    execFile("powershell.exe", ["-NoProfile", "-Command", ps], (e) => { if (e) console.error("could not add vibecad to PATH:", e.message); });
  } else {
    for (const rc of rcFiles({ platform, shell, home })) {
      if (existsSync(rc) && readFileSync(rc, "utf8").includes(MARK)) continue;
      mkdirSync(dirname(rc), { recursive: true });
      appendFileSync(rc, `\n# Added by Vibecad\nexport PATH="$HOME/${MARK}:$PATH"\n`);
    }
  }
  return file;
}
