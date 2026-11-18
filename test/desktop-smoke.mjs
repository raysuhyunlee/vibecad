// Run with Electron: npm run test:desktop -- normal|cancel|load-failure
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, dialog, protocol } from "electron";

const mode = process.argv[2] ?? "normal";
assert.ok(["normal", "cancel", "load-failure"].includes(mode));
const userData = mkdtempSync(join(tmpdir(), "vibecad-desktop-"));
app.setPath("userData", userData);
let splash, main, painted = false, initialized = false, passed = false;
const errors = [];
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
