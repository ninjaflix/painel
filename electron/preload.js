const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ninjaflixAgent', {
  getAgentUrl: () => ipcRenderer.invoke('agent-url'),
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  installUpdate: (update) => ipcRenderer.invoke('install-update', update),
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, payload) => callback(payload)),
  onWindowReactivated: (callback) => ipcRenderer.on('window-reactivated', () => callback()),
  openExternalBrowser: (url) => ipcRenderer.invoke('open-external-browser', url)
});
