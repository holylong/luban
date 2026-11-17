// Sandboxed preload: Electron is the only available require dependency.
const { contextBridge, ipcRenderer } = require("electron");

let dirty = false;
window.addEventListener("beforeunload", event => {
  if (!dirty) return;
  event.preventDefault();
  event.returnValue = "Unsaved workspace changes";
});
contextBridge.exposeInMainWorld("lubanDesktop", Object.freeze({
  onPetJob: listener => {
    const handler = (_event, id) => listener(id);
    ipcRenderer.on('luban:petJob', handler);
    return () => ipcRenderer.removeListener('luban:petJob', handler);
  },
  readFile: path => ipcRenderer.invoke("luban:readFile", path),
  saveFile: input => ipcRenderer.invoke("luban:saveFile", input),
  listFiles: () => ipcRenderer.invoke("luban:listFiles"),
  // Parsed slide decks and draw.io diagrams render inside the workbench.
  readPreview: path => ipcRenderer.invoke("luban:readPreview", path),
  // Hand a file the preview cannot paint to the system application.
  openPath: path => ipcRenderer.invoke("luban:openPath", path),
  openExternal: url => ipcRenderer.invoke("luban:openExternal", url),
  // File-tree menu: reveal in Finder, copy the absolute path, and the three
  // mutations the tree can perform without an editor round-trip.
  revealPath: path => ipcRenderer.invoke("luban:revealPath", path),
  copyPath: path => ipcRenderer.invoke("luban:copyPath", path),
  createEntry: input => ipcRenderer.invoke("luban:createEntry", input),
  renameEntry: input => ipcRenderer.invoke("luban:renameEntry", input),
  trashEntry: path => ipcRenderer.invoke("luban:trashEntry", path),
  // Opens the folder picker in the main process, which owns workspace switching.
  openWorkspace: () => ipcRenderer.invoke("luban:openWorkspace"),
  createWorkspace: () => ipcRenderer.invoke("luban:createWorkspace"),
  // The Creator window floats on top, so the workbench owns a switch for it.
  petVisible: () => ipcRenderer.invoke("luban:petVisible"),
  togglePet: () => ipcRenderer.invoke("luban:petToggle"),
  onPetVisibility: listener => {
    const handler = (_event, visible) => listener(visible === true);
    ipcRenderer.on("luban:petVisibility", handler);
    return () => ipcRenderer.removeListener("luban:petVisibility", handler);
  },
  runCommand: command => ipcRenderer.invoke("luban:runCommand", command),
  stopCommand: id => ipcRenderer.invoke("luban:stopCommand", id),
  startTerminal: input => ipcRenderer.invoke("luban:startTerminal", input),
  writeTerminal: input => ipcRenderer.invoke("luban:writeTerminal", input),
  resizeTerminal: input => ipcRenderer.invoke("luban:resizeTerminal", input),
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
