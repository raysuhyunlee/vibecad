const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibecadDesktop", {
  ready: () => ipcRenderer.send("viewer-ready"),
});
