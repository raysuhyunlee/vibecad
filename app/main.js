// The desktop app: runs `vibecad dev` on Electron's own Node, on a local socket, and shows it in a window.
import { app, BrowserWindow, dialog, Menu, MenuItem, nativeTheme, protocol, shell } from "electron";
import { execFile, spawn } from "node:child_process";
import { request } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import updater from "electron-updater";
import { installCli } from "./cli-path.js";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const ICON = fileURLToPath(new URL("./assets/icon.png", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./preload.cjs", import.meta.url));
const UPDATE_PRELOAD = fileURLToPath(new URL("./update-preload.cjs", import.meta.url));
// Read the version from the root package.json; never fall back to Electron's version.
const VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? ""; }
  catch { return ""; }
})();
if (VERSION) app.setVersion(VERSION);
// The window loads vibecad://app/, and every request goes to the server's socket, so no port can clash.
const ORIGIN = "vibecad://app";
protocol.registerSchemesAsPrivileged([
  { scheme: "vibecad", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// Resolve the login shell's PATH after showing the splash, without blocking its painting.
async function shellPath() {
  if (process.platform === "win32") return;
  try {
    const { stdout } = await promisify(execFile)(process.env.SHELL || "/bin/zsh", ["-ilc", "printf %s \"$PATH\""], { encoding: "utf8", timeout: 5000 });
    if (stdout.trim()) process.env.PATH = stdout.trim().split("\n").pop();
  } catch {}
}

let server;
let socket;
let win;
let splash;
let startupTimer;
let quitting = false;

function fail(message) {
  if (quitting) return;
  quitting = true;
  clearTimeout(startupTimer);
  splash?.destroy();
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
  let announced = false;
  server.stdout.on("data", (chunk) => {
    if (announced) return;
    out += chunk;
    let status;
    try {
      status = JSON.parse(out);
    } catch {
      return;
    }
    announced = true;
    if (!status.ok) return fail(status.error?.message ?? "The app could not start.");
    open();
  });
  server.on("error", (e) => fail(`The vibecad server could not start: ${e.message}`));
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
  if (quitting) return;
  win = new BrowserWindow({
    width: 1440, height: 900, title: "Vibecad", backgroundColor: "#ffffff", show: false, icon: ICON,
    webPreferences: { preload: PRELOAD },
  });
  // Both the first paint and the viewer's initial server state must be ready.
  let painted = false, initialized = false, shown = false;
  const reveal = () => {
    if (!painted || !initialized || shown || quitting) return;
    shown = true;
    clearTimeout(startupTimer);
    win.show();
    splash?.destroy();
    watchUpdates();
  };
  win.once("ready-to-show", () => { painted = true; reveal(); });
  win.webContents.ipc.once("viewer-ready", (event) => {
    if (event.senderFrame !== win.webContents.mainFrame) return;
    initialized = true;
    reveal();
  });
  win.webContents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) fail(`The app could not load: ${description}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit") fail("The app window stopped unexpectedly. Please reopen Vibecad.");
  });
  // Links leave the app for the person's browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.loadURL(`${ORIGIN}/`).catch((e) => fail(`The app could not load: ${e.message}`));
}

function showSplash() {
  splash = new BrowserWindow({
    width: 560, height: 340, title: "Vibecad", icon: ICON,
    frame: false, resizable: false, maximizable: false, fullscreenable: false,
    show: false, backgroundColor: "#20251F",
  });
  splash.on("closed", () => {
    splash = null;
    if (!win?.isVisible() && !quitting) app.quit();
  });
  splash.once("ready-to-show", async () => {
    splash.show();
    startupTimer = setTimeout(() => fail("Vibecad could not finish starting. Please reopen the app."), 30000);
    await shellPath();
    if (!quitting) start();
  });
  splash.loadFile(fileURLToPath(new URL("./splash.html", import.meta.url)), { query: { version: VERSION } })
    .catch((e) => fail(`The startup screen could not load: ${e.message}`));
}

// How often a running app looks for a newer release.
const UPDATE_CHECK_MS = 4 * 60 * 60 * 1000;
const UPDATE_WIDTH = 480;
// Past this height the release notes scroll inside the window.
const UPDATE_MAX_HEIGHT = 560;
let updateMenuItem;
let updateWindow;
// A version the person put off is not offered again by background checks.
let dismissedVersion;
let updaterReady = false;

/** Nothing downloads until the person chooses to install. */
function setupUpdater() {
  if (updaterReady) return updater.autoUpdater;
  updaterReady = true;
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // An offline machine or a missing release is not the person's problem.
  autoUpdater.on("error", (e) => console.error("update failed:", e.message));
  autoUpdater.on("download-progress", ({ percent }) => sendUpdateState({ phase: "downloading", percent }));
  return autoUpdater;
}

function sendUpdateState(state) {
  if (updateWindow && !updateWindow.isDestroyed()) updateWindow.webContents.send("update-state", state);
}

/** GitHub gives the release body as HTML, or one entry per release when several are newer. */
function releaseNotes(info) {
  const notes = info.releaseNotes;
  if (Array.isArray(notes)) return notes[0]?.note ?? "";
  return typeof notes === "string" ? notes : "";
}

/** Asks whether to install the new version, then downloads and installs it with progress. */
function offerUpdate(info, { manual = false } = {}) {
  if (quitting || (!manual && info.version === dismissedVersion)) return;
  if (updateWindow) return updateWindow.focus();
  const parent = win && !win.isDestroyed() ? win : undefined;
  const w = new BrowserWindow({
    parent, modal: !!parent, width: UPDATE_WIDTH, height: 240, title: "Vibecad Update", icon: ICON,
    resizable: false, minimizable: false, maximizable: false, fullscreenable: false, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#212327" : "#ffffff",
    webPreferences: { preload: UPDATE_PRELOAD },
  });
  updateWindow = w;
  let token;
  const { ipc } = w.webContents;
  ipc.handle("update-info", () => ({ version: info.version, notes: releaseNotes(info) }));
  ipc.on("update-resize", (_event, height) => {
    const h = Math.min(UPDATE_MAX_HEIGHT, Math.max(160, Math.round(Number(height) || 0)));
    w.setContentSize(UPDATE_WIDTH, h);
    if (!w.isVisible()) w.show();
  });
  ipc.on("update-later", () => w.close());
  ipc.on("update-install", async () => {
    if (token) return;
    token = new updater.CancellationToken();
    sendUpdateState({ phase: "downloading", percent: 0 });
    try {
      await setupUpdater().downloadUpdate(token);
    } catch (e) {
      const cancelled = token.cancelled;
      token = undefined;
      if (!cancelled) sendUpdateState({ phase: "error", message: `Could not download the update. Check your internet connection and try again. (${e.message})` });
      return;
    }
    if (w.isDestroyed()) return;
    sendUpdateState({ phase: "installing" });
    // The server's exit on the way out must not show the crash dialog.
    quitting = true;
    // Install silently and reopen the app.
    setupUpdater().quitAndInstall(true, true);
  });
  // Closing during the download cancels it; closing before installing puts this version off.
  w.on("closed", () => {
    if (token && !quitting) token.cancel();
    if (!quitting) dismissedVersion = info.version;
    updateWindow = undefined;
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  w.webContents.on("will-navigate", (e, url) => {
    e.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url);
  });
  w.loadFile(fileURLToPath(new URL("./update.html", import.meta.url))).catch((e) => console.error("update window failed:", e.message));
}

async function checkForUpdates() {
  if (!updateMenuItem.enabled) return;
  if (updateWindow) return updateWindow.focus();
  updateMenuItem.enabled = false;
  updateMenuItem.label = "Checking for Updates...";
  try {
    if (!app.isPackaged) {
      await dialog.showMessageBox(win, { type: "info", message: "Updates are available in the installed app.", detail: "This is a development build of Vibecad." });
    } else {
      const result = await setupUpdater().checkForUpdates();
      if (!result) throw new Error("The update service did not respond.");
      if (result.isUpdateAvailable) {
        offerUpdate(result.updateInfo, { manual: true });
      } else {
        await dialog.showMessageBox(win, { type: "info", message: "You're up to date", detail: `Vibecad ${app.getVersion()} is the latest version.` });
      }
    }
  } catch (e) {
    if (!quitting) await dialog.showMessageBox(win, { type: "error", message: "Could not update Vibecad", detail: `Check your internet connection and try again.\n\n${e.message}` });
  } finally {
    updateMenuItem.label = "Check for Updates...";
    updateMenuItem.enabled = true;
  }
}

function createMenu() {
  const mac = process.platform === "darwin";
  const menu = Menu.buildFromTemplate([
    ...(mac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    { role: "help", submenu: [] },
  ]);
  updateMenuItem = new MenuItem({ id: "check-for-updates", label: "Check for Updates...", click: checkForUpdates });
  const target = mac ? menu.items[0] : menu.items.find((item) => item.role === "help");
  target.submenu.insert(mac ? 1 : 0, updateMenuItem);
  Menu.setApplicationMenu(menu);
}

/** Looks for newer GitHub releases in the background, and asks whether to install one. */
function watchUpdates() {
  if (!app.isPackaged) return;
  const autoUpdater = setupUpdater();
  const check = () => autoUpdater.checkForUpdates()
    .then((result) => { if (result?.isUpdateAvailable) offerUpdate(result.updateInfo); })
    .catch(() => {});
  check();
  setInterval(check, UPDATE_CHECK_MS);
}

// The AppImage launcher runs the app with VIBECAD_CLI set: relay to the CLI and exit with its code.
if (process.env.VIBECAD_CLI) {
  const { VIBECAD_CLI, ...env } = process.env;
  spawn(process.execPath, [CLI, ...process.argv.slice(1)], { cwd: env.OWD || process.cwd(), env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, stdio: "inherit" })
    .on("exit", (code) => app.exit(code ?? 1));
}
// One app at a time: a second launch shows the open window.
else if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    const active = splash ?? win;
    if (active?.isMinimized()) active.restore();
    active?.focus();
  });
  app.whenReady().then(() => {
    createMenu();
    protocol.handle("vibecad", forward);
    app.dock?.setIcon(ICON);
    showSplash();
    if (app.isPackaged) {
      try { installCli({ home: homedir(), exe: process.execPath, cli: CLI, appImage: process.env.APPIMAGE }); }
      catch (e) { console.error("could not install the vibecad command:", e.message); }
    }
  });
}
app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  quitting = true;
  clearTimeout(startupTimer);
  server?.kill();
});
