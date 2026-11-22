const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibecadUpdate", {
  info: () => ipcRenderer.invoke("update-info"),
  resize: (height) => ipcRenderer.send("update-resize", height),
  install: () => ipcRenderer.send("update-install"),
  later: () => ipcRenderer.send("update-later"),
  onState: (listener) => ipcRenderer.on("update-state", (_event, state) => listener(state)),
});
