const { contextBridge, ipcRenderer, webUtils } = require('electron');
contextBridge.exposeInMainWorld('petBridge', Object.freeze({
  open: () => ipcRenderer.invoke('luban:petOpen'),
  submit: input => ipcRenderer.invoke('luban:petSubmit', input),
  status: () => ipcRenderer.invoke('luban:petStatus'),
  botStatus: () => ipcRenderer.invoke('luban:botStatus'),
  onBotChanged: listen => ipcRenderer.on('luban:botChanged', () => listen()),
  filePath: file => webUtils.getPathForFile(file),
}));
