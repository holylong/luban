// Sandboxed preload for the 造物主 window: the queue lives in the main process,
// so the renderer never touches the filesystem or spawns a process itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("creator", Object.freeze({
  snapshot: () => ipcRenderer.invoke("creator:snapshot"),
  add: input => ipcRenderer.invoke("creator:add", input),
  cancel: id => ipcRenderer.invoke("creator:cancel", id),
  startWorker: () => ipcRenderer.invoke("creator:startWorker"),
  pickWorkspace: () => ipcRenderer.invoke("creator:pickWorkspace"),
  openPolicy: () => ipcRenderer.invoke("creator:openPolicy"),
  openData: () => ipcRenderer.invoke("creator:openData"),
  hide: () => ipcRenderer.invoke("creator:hide"),
}));
