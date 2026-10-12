/**
 * The only bridge between the sandboxed page and the rest of capmac Studio:
 * a small typed API (window.capmac). Main validates every payload again.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { AppChannel, CapmacApi } from '../shared/contract.js';

const CHANNELS = new Set<AppChannel>([
  'app:info',
  'app:get-settings',
  'app:set-settings',
  'app:pick-folder',
  'app:open-in-editor',
  'app:show-in-folder',
  'app:open-path',
  'app:open-external',
  'app:project-icon',
  'app:save-image',
  'app:copy-image',
  'app:save-text',
  'app:screen-open',
  'app:project-opened',
  'app:forget-project',
  'app:prompt-response',
  'app:visibility',
]);

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.off(channel, wrapped);
  };
}

const api: CapmacApi = {
  invoke: (channel, payload) => {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`Unknown channel ${channel}`));
    return ipcRenderer.invoke(channel, payload);
  },
  call: (method, params) => ipcRenderer.invoke('app:engine-call', { method, params }),
  onEvents: (listener) => subscribe('engine:events', listener),
  onPrompt: (listener) => subscribe('engine:prompt', listener),
  onEngineStatus: (listener) => subscribe('engine:status', listener),
  onSettings: (listener) => subscribe('app:settings', listener),
  onCommand: (listener) => subscribe('app:command', listener),
  onAccent: (listener) => subscribe('app:accent', listener),
  pathForFile: (file) => webUtils.getPathForFile(file),
  ready: () => ipcRenderer.send('app:hello'),
};

contextBridge.exposeInMainWorld('capmac', api);

// Screen streams arrive as a MessagePort; hand it to the page (it moves it on to a worker).
ipcRenderer.on('screen-port', (event, message: { streamId: string }) => {
  window.postMessage({ type: 'capmac:screen-port', streamId: message.streamId }, window.location.origin, [...event.ports]);
});
