// What the page may ask the main process for (and nothing else).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hello', {
  systemInfo: () => ipcRenderer.invoke('system-info'),
  ping: () => ipcRenderer.invoke('ping'),
  onSayHello: (listener) => ipcRenderer.on('say-hello', () => listener()),
});
