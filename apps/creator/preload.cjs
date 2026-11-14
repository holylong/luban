// Sandboxed preload for the 造物主 window: the queue lives in the main process,
// so the renderer never touches the filesystem or spawns a process itself.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("creator", Object.freeze({
  snapshot: () => ipcRenderer.invoke("creator:snapshot"),
  add: input => ipcRenderer.invoke("creator:add", input),
  cancel: id => ipcRenderer.invoke("creator:cancel", id),
  runs: (id, limit) => ipcRenderer.invoke("creator:runs", id, limit),
  startWorker: () => ipcRenderer.invoke("creator:startWorker"),
  pickWorkspace: () => ipcRenderer.invoke("creator:pickWorkspace"),
  openPolicy: () => ipcRenderer.invoke("creator:openPolicy"),
  openData: () => ipcRenderer.invoke("creator:openData"),
  hide: () => ipcRenderer.invoke("creator:hide"),
  // Control session: the window talks to a `luban drive` child through these.
  settings: () => ipcRenderer.invoke("creator:settings"),
  drive: () => ipcRenderer.invoke("creator:drive"),
  driveStart: input => ipcRenderer.invoke("creator:drive-start", input),
  driveStop: () => ipcRenderer.invoke("creator:drive-stop"),
  driveSay: text => ipcRenderer.invoke("creator:drive-say", text),
  driveApprove: (id, allow) => ipcRenderer.invoke("creator:drive-approve", id, allow),
  setComputer: on => ipcRenderer.invoke("creator:computer", on),
  forgetApprovals: () => ipcRenderer.invoke("creator:forget"),
  onSettings: handler => { const listener = (_event, payload) => handler(payload); ipcRenderer.on("creator:settings", listener); return () => ipcRenderer.removeListener("creator:settings", listener); },
  onDrive: handler => { const listener = (_event, payload) => handler(payload); ipcRenderer.on("creator:drive-event", listener); return () => ipcRenderer.removeListener("creator:drive-event", listener); },
  onDriveLog: handler => { const listener = (_event, payload) => handler(payload); ipcRenderer.on("creator:drive-log", listener); return () => ipcRenderer.removeListener("creator:drive-log", listener); },
}));
