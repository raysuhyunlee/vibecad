// The desktop app: runs `vibecad dev` on Electron's own Node, on a local socket, and shows it in a window.
import { app, BrowserWindow, dialog, protocol, shell } from "electron";
import { execFileSync, spawn } from "node:child_process";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import updater from "electron-updater";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
// The window loads vibecad://app/, and every request goes to the server's socket, so no port can clash.
const ORIGIN = "vibecad://app";
protocol.registerSchemesAsPrivileged([
  { scheme: "vibecad", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// A GUI app on macOS or Linux starts without the login shell's PATH, so `claude` and `codex` would not be found.
if (process.platform !== "win32") {
  try {
    const path = execFileSync(process.env.SHELL || "/bin/zsh", ["-ilc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
    if (path) process.env.PATH = path.trim().split("\n").pop();
  } catch {}
}

let server;
let socket;
let win;
let quitting = false;

function fail(message) {
  if (quitting) return;
  quitting = true;
  dialog.showErrorBox("Vibecad", message);
  app.quit();
}

function start() {
  socket = process.platform === "win32" ? "\\\\.\\pipe\\vibecad-app" : join(app.getPath("userData"), "server.sock");
  // The server and every process it starts run this binary as plain Node. Only they get the flag:
  // Chromium's own helper processes inherit the app's environment and must not.
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  server = spawn(process.execPath, [CLI, "dev", "--socket", socket], { cwd: homedir(), env, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  server.stdout.on("data", (chunk) => {
    out += chunk;
    let status;
    try {
      status = JSON.parse(out);
    } catch {
      return;
    }
    if (!status.ok) return fail(status.error?.message ?? "The app could not start.");
    open();
  });
  server.on("exit", (code) => fail(`The vibecad server stopped (exit ${code}).`));
}

/** Passes one window request to the server's socket, streaming the answer so server-sent events flow. */
async function forward(req) {
  const url = new URL(req.url);
  // The folder dialog is the app's own, on its window.
  if (req.method === "POST" && url.pathname === "/project/pick") {
    const r = await dialog.showOpenDialog(win, { title: "Open project", properties: ["openDirectory", "createDirectory"] });
    return Response.json({ path: r.canceled ? null : r.filePaths[0] ?? null });
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.from(await req.arrayBuffer());
  return new Promise((done) => {
    const r = request({ socketPath: socket, path: url.pathname + url.search, method: req.method, headers: Object.fromEntries(req.headers) }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const empty = res.statusCode === 204 || res.statusCode === 304 || req.method === "HEAD";
      done(new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
    });
    r.on("error", (e) => done(new Response(e.message, { status: 502 })));
    r.end(body);
  });
}

function open() {
  win = new BrowserWindow({ width: 1440, height: 900, title: "Vibecad", backgroundColor: "#ffffff" });
  // Links leave the app for the person's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(`${ORIGIN}/`);
}

// How often a running app looks for a newer release.
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;

/** Downloads newer GitHub releases in the background, and offers a restart once one is ready. */
function watchUpdates() {
  if (!app.isPackaged) return;
  const { autoUpdater } = updater;
  // An offline machine or a missing release is not the person's problem.
  autoUpdater.on("error", (e) => console.error("update check failed:", e.message));
  autoUpdater.on("update-downloaded", async ({ version }) => {
    const r = await dialog.showMessageBox(win, {
      type: "info",
      message: `Vibecad ${version} is ready`,
      detail: "Restart now to update, or it installs when you quit.",
      buttons: ["Restart", "Later"],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response !== 0) return;
    // The server's exit on the way out must not show the crash dialog.
    quitting = true;
    autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_MS);
}

// One app at a time: a second launch shows the open window.
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (win?.isMinimized()) win.restore();
    win?.focus();
  });
  app.whenReady().then(() => {
    protocol.handle("vibecad", forward);
    start();
    watchUpdates();
  });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  server?.kill();
});
