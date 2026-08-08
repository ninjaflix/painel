const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ninjaflixDesktop', {
  installUpdate: (update) => ipcRenderer.sendToHost('ninjaflix-install-update', update),
  notify: (payload) => ipcRenderer.sendToHost('ninjaflix-notify', payload),
  contentReady: (payload) => ipcRenderer.sendToHost('ninjaflix-content-ready', payload || {}),
  requestUpdateCheck: () => ipcRenderer.sendToHost('ninjaflix-check-updates'),
  onUpdateAvailable: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ninjaflix-update-available', (_event, payload) => callback(payload));
  },
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ninjaflix-update-status', (_event, payload) => callback(payload));
  },
  onBackgroundRefresh: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ninjaflix-background-refresh', (_event, payload) => callback(payload || {}));
  }
});
