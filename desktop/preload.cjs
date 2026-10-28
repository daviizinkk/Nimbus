'use strict';

const { contextBridge, ipcRenderer } = require('electron');

function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {};
  const listener = (_event, value) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('nimbusDesktop', {
  platform: process.platform,
  minimize: () => ipcRenderer.send('desktop:minimize'),
  toggleMaximize: () => ipcRenderer.send('desktop:toggle-maximize'),
  close: () => ipcRenderer.send('desktop:close'),
  hideToTray: () => ipcRenderer.send('desktop:hide-to-tray'),
  isMaximized: () => ipcRenderer.invoke('desktop:is-maximized'),
  getInfo: () => ipcRenderer.invoke('desktop:info'),
  getPreferences: () => ipcRenderer.invoke('desktop:preferences:get'),
  savePreferences: (preferences) => ipcRenderer.invoke('desktop:preferences:save', preferences),
  notifyUpload: (summary) => ipcRenderer.invoke('desktop:notify-upload', summary),
  onPreferences: (callback) => subscribe('desktop:preferences', callback),
  onCommand: (callback) => subscribe('desktop:command', callback),
  onMaximized: (callback) => subscribe('desktop:maximized', callback),
  resetPassword: (password) => ipcRenderer.invoke('desktop:reset-password', password),
  openDataFolder: () => ipcRenderer.invoke('desktop:open-data-folder'),
  openLogsFolder: () => ipcRenderer.invoke('desktop:open-logs-folder'),
  createShortcut: () => ipcRenderer.invoke('desktop:create-shortcut'),
  copyDiagnostics: () => ipcRenderer.invoke('desktop:copy-diagnostics'),
  openUninstaller: () => ipcRenderer.invoke('desktop:open-uninstaller'),
  rpc: {
    get: () => ipcRenderer.invoke('desktop:rpc:get'),
    save: (config) => ipcRenderer.invoke('desktop:rpc:save', config),
    setActivity: (activity) => ipcRenderer.send('desktop:rpc:activity', activity),
    onStatus: (callback) => subscribe('desktop:rpc:status', callback),
  },
});
