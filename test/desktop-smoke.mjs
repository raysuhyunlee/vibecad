// Run with Electron: npm run test:desktop -- normal|cancel|load-failure
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, Menu, protocol } from "electron";
import updater from "electron-updater";

const mode = process.argv[2] ?? "normal";
assert.ok(["normal", "cancel", "load-failure"].includes(mode));
const userData = mkdtempSync(join(tmpdir(), "vibecad-desktop-"));
app.setPath("userData", userData);
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
let splash, main, painted = false, initialized = false, passed = false;
const errors = [];
const messages = [];
let updateChecks = 0;
let onUpdateWindow;
let checkUpdate = async () => ({ isUpdateAvailable: false });
Object.defineProperty(app, "isPackaged", { get: () => true });
updater.autoUpdater.checkForUpdates = () => { updateChecks++; return checkUpdate(); };
dialog.showMessageBox = async (_win, options) => { messages.push(options); return { response: 1 }; };
const fail = (e) => { console.error(e); app.exit(1); };
process.on("uncaughtException", fail);
process.on("unhandledRejection", fail);
const timeout = setTimeout(() => fail(new Error(`Startup test timed out: ${mode}`)), 20000);

async function capture(win, name) {
  const image = await win.webContents.capturePage();
  assert.ok(!image.isEmpty(), `${name} has rendered content`);
  if (process.env.VIBECAD_SMOKE_OUTPUT) {
    mkdirSync(process.env.VIBECAD_SMOKE_OUTPUT, { recursive: true });
    writeFileSync(join(process.env.VIBECAD_SMOKE_OUTPUT, `${name}.png`), image.toPNG());
  }
}

// Hold the first server state to prove a painted-but-uninitialized viewer stays hidden.
const handle = protocol.handle.bind(protocol);
protocol.handle = (scheme, handler) => handle(scheme, async (request) => {
  const path = new URL(request.url).pathname;
  if (mode === "load-failure" && path === "/") return Response.error();
  if (path === "/events" && !initialized) {
    assert.ok(splash.isVisible());
    assert.equal(await splash.webContents.executeJavaScript('document.getElementById("version").textContent'), `v${version}`);
    assert.equal(main.isVisible(), false);
    await capture(splash, "splash");
    assert.equal(main.isVisible(), false, "splash remains until server state arrives");
  }
  return handler(request);
});
dialog.showErrorBox = (_title, message) => {
  assert.equal(mode, "load-failure", message);
  assert.match(message, /could not load/);
  passed = true;
};

app.on("browser-window-created", (_event, win) => {
  if (!splash) {
    splash = win;
    win.once("show", () => {
      assert.equal(BrowserWindow.getAllWindows().length, 1, "splash precedes the main window");
      if (mode === "cancel") {
        passed = true;
        setImmediate(() => win.close());
      }
    });
    return;
  }
  if (main) return onUpdateWindow?.(win);
  main = win;
  assert.equal(win.isVisible(), false);
  win.once("ready-to-show", () => { painted = true; });
  win.webContents.ipc.once("viewer-ready", () => { initialized = true; });
  win.webContents.on("console-message", (details) => {
    if (details.level === "error") errors.push(details.message);
  });
  win.once("show", async () => {
    assert.equal(mode, "normal");
    assert.ok(painted && initialized, "main window waits for paint and initialization");
    await new Promise(setImmediate);
    assert.ok(splash.isDestroyed(), "splash closes after the main window appears");
    assert.deepEqual(errors, []);
    assert.ok(await win.webContents.executeJavaScript('!!document.querySelector("#open-first") && !!window.vibecad'));
    await capture(win, "main");
    const menu = Menu.getApplicationMenu();
    const item = menu.getMenuItemById("check-for-updates");
    const parent = process.platform === "darwin" ? menu.items[0] : menu.items.find((m) => m.role === "help");
    assert.ok(parent.submenu.items.includes(item), "update check is in the platform's native menu");
    if (process.platform === "darwin") assert.equal(parent.submenu.items[1], item, "update check follows About");
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100 && !predicate(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(predicate(), "update menu finished its operation");
    };
    await waitFor(() => updateChecks === 1);
    let finishCheck;
    checkUpdate = () => new Promise((resolve) => { finishCheck = resolve; });
    item.click();
    assert.equal(item.enabled, false);
    assert.equal(item.label, "Checking for Updates...");
    item.click();
    assert.equal(updateChecks, 2, "duplicate manual checks are ignored");
    finishCheck({ isUpdateAvailable: false });
    await waitFor(() => item.enabled);
    assert.equal(messages.at(-1).message, "You're up to date");
    checkUpdate = async () => { throw new Error("Offline"); };
    item.click();
    await waitFor(() => item.enabled);
    assert.match(messages.at(-1).detail, /Offline/);
    assert.equal(updater.autoUpdater.autoDownload, false, "nothing downloads before the person chooses to install");
    // Long release notes scroll inside a window of bounded height; only What's Changed shows, cleaned.
    const items = Array.from({ length: 40 }, (_, i) => `<li>Change ${i} https://github.com/raysuhyunlee/vibecad/pull/${i}${"x".repeat(80)} <script>window.bad = 1</script><a href="javascript:window.bad = 1">link</a></li>`).join("");
    const longNotes = `<h2>Downloads</h2><ul><li>dmg</li></ul><h2>What&#39;s Changed</h2><ul>${items}</ul><h2>New Contributors</h2><p>skipped</p>`;
    const openUpdate = async (releaseNotes, name) => {
      checkUpdate = async () => ({ isUpdateAvailable: true, updateInfo: { version: "0.3.0", releaseNotes } });
      const shown = new Promise((resolve) => { onUpdateWindow = (w) => w.once("show", () => resolve(w)); });
      item.click();
      const w = await shown;
      await waitFor(() => item.enabled);
      await new Promise((r) => setTimeout(r, 100));
      const layout = await w.webContents.executeJavaScript(`(() => {
        const notes = document.getElementById("notes");
        const box = (s) => document.querySelector(s).getBoundingClientRect();
        return {
          title: document.querySelector("h1").textContent,
          version: document.getElementById("version").textContent,
          items: notes.querySelectorAll("li").length,
          text: notes.textContent,
          scripts: notes.querySelectorAll("script").length,
          badLinks: [...notes.querySelectorAll("a")].filter((a) => a.href && !a.href.startsWith("http")).length,
          scrolls: notes.scrollHeight > notes.clientHeight,
          footerBottom: box("footer").bottom,
          installRight: box("#install").right,
          height: innerHeight,
          width: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        };
      })()`);
      await capture(w, name);
      assert.equal(layout.title, "New version is out!");
      assert.equal(layout.version, "Vibecad 0.3.0");
      assert.ok(layout.footerBottom <= layout.height + 0.5, "footer stays inside the window");
      assert.ok(layout.installRight <= layout.width + 0.5, "buttons stay inside the window");
      assert.ok(layout.scrollWidth <= layout.width, "no horizontal overflow");
      return { w, layout };
    };
    let { w: updateWin, layout } = await openUpdate(longNotes, "update-long");
    assert.equal(layout.items, 40);
    assert.equal(layout.scripts, 0);
    assert.equal(layout.badLinks, 0);
    assert.doesNotMatch(layout.text, /dmg|skipped/);
    assert.ok(layout.scrolls, "long notes scroll");
    assert.equal(updateWin.getContentSize()[1], 560, "window height is capped");
    const closed = new Promise((resolve) => updateWin.once("closed", resolve));
    await updateWin.webContents.executeJavaScript('document.getElementById("later").click()');
    await closed;
    ({ w: updateWin, layout } = await openUpdate("<h2>What's Changed</h2><ul><li>One fix</li></ul>", "update-short"));
    assert.equal(layout.scrolls, false);
    assert.ok(updateWin.getContentSize()[1] < 300, "short notes give a short window");
    // Installing downloads with progress, then installs and restarts.
    let finishDownload, installed;
    updater.autoUpdater.downloadUpdate = () => new Promise((resolve) => { finishDownload = resolve; });
    updater.autoUpdater.quitAndInstall = (...args) => { installed = args; };
    await updateWin.webContents.executeJavaScript('document.getElementById("install").click()');
    await waitFor(() => finishDownload);
    updater.autoUpdater.emit("download-progress", { percent: 42.4 });
    await new Promise((r) => setTimeout(r, 300));
    const progress = await updateWin.webContents.executeJavaScript(`({
      visible: !document.getElementById("progress").hidden,
      value: document.getElementById("progress").getAttribute("aria-valuenow"),
      install: document.getElementById("install").textContent,
      later: document.getElementById("later").textContent,
    })`);
    assert.deepEqual(progress, { visible: true, value: "42", install: "Downloading... 42%", later: "Cancel" });
    await capture(updateWin, "update-progress");
    finishDownload();
    await waitFor(() => installed);
    assert.deepEqual(installed, [true, true], "installs silently and reopens");
    updateWin.destroy();
    const minimized = new Promise((resolve) => win.once("minimize", resolve));
    win.minimize();
    await minimized;
    const restored = new Promise((resolve) => win.once("restore", resolve));
    app.emit("second-instance");
    await restored;
    assert.equal(win.isMinimized(), false, "a second launch restores the main window");
    passed = true;
    app.quit();
  });
});
app.on("will-quit", () => {
  clearTimeout(timeout);
  assert.ok(passed, `Startup test did not finish: ${mode}`);
  console.log(JSON.stringify({ ok: true, mode, painted, initialized }));
});
app.on("quit", () => rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
await import("../app/main.js");
