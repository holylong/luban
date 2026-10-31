// Sandboxed preload: Electron is the only available require dependency.
const { contextBridge, ipcRenderer } = require("electron");

let dirty = false;
window.addEventListener("beforeunload", event => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "Unsaved workspace changes";
});
contextBridge.exposeInMainWorld("lubanDesktop", Object.freeze({
  readFile: path => ipcRenderer.invoke("luban:readFile", path),
  saveFile: input => ipcRenderer.invoke("luban:saveFile", input),
  listFiles: () => ipcRenderer.invoke("luban:listFiles"),
  runCommand: command => ipcRenderer.invoke("luban:runCommand", command),
  stopCommand: id => ipcRenderer.invoke("luban:stopCommand", id),
  startTerminal: input => ipcRenderer.invoke("luban:startTerminal", input),
  writeTerminal: input => ipcRenderer.invoke("luban:writeTerminal", input),
  stopTerminal: id => ipcRenderer.invoke("luban:stopTerminal", id),
  setDirty: value => {
    if (typeof value !== "boolean") throw new TypeError("Dirty state must be boolean");
    dirty = value;
    // Synchronous acknowledgment prevents a menu switch racing the dirty update.
    ipcRenderer.sendSync("luban:setDirty", value);
  },
  onCommandEvent: listener => {
    if (typeof listener !== "function") throw new TypeError("Listener must be a function");
    const handler = (_event, value) => listener(value);
    ipcRenderer.on("luban:commandEvent", handler);
    return () => ipcRenderer.removeListener("luban:commandEvent", handler);
  },
}));
