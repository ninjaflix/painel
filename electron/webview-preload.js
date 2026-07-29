const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ninjaflixDesktop', {
  installUpdate: (update) => ipcRenderer.sendToHost('ninjaflix-install-update', update),
  onUpdateAvailable: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ninjaflix-update-available', (_event, payload) => callback(payload));
  },
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('ninjaflix-update-status', (_event, payload) => callback(payload));
  }
});
