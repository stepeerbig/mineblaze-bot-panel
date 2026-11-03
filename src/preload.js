'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  start: (settings) => ipcRenderer.invoke('bot:start', settings),
  stop: () => ipcRenderer.invoke('bot:stop'),
  setAutoReconnect: (on) => ipcRenderer.invoke('bot:auto-reconnect', Boolean(on)),
  say: (text) => ipcRenderer.invoke('bot:say', String(text)),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  openViewer: () => ipcRenderer.invoke('viewer:open'), // окно «Экран бота»; true, если открылось
  onLog: listen('bot:log'),
  onChat: listen('bot:chat'),
  onState: listen('bot:state'),
});
