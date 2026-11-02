const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('petBridge', Object.freeze({
  open: () => ipcRenderer.invoke('luban:petOpen'),
  submit: input => ipcRenderer.invoke('luban:petSubmit', input),
  status: () => ipcRenderer.invoke('luban:petStatus'),
  filePath: file => webUtils.getPathForFile(file),
}));
