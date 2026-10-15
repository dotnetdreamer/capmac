// What the page may ask the main process for (and nothing else).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hello', {
  systemInfo: () => ipcRenderer.invoke('system-info'),
  ping: () => ipcRenderer.invoke('ping'),
  dialog: (kind) => ipcRenderer.invoke('dialog', kind),
  onDialogResult: (listener) => ipcRenderer.on('dialog-result', (_event, result) => listener(result)),
  onSayHello: (listener) => ipcRenderer.on('say-hello', () => listener()),
});
