'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const listen = (channel) => (callback) => {
  ipcRenderer.on(channel, (_event, payload) => callback(payload));
};

contextBridge.exposeInMainWorld('api', {
  init: () => ipcRenderer.invoke('app:init'),
  saveConfig: (patch) => ipcRenderer.invoke('config:save', patch),
  // ids — каких ботов (без них — всех); settings — поля формы, сохранить перед запуском.
  start: (ids, settings) => ipcRenderer.invoke('bots:start', { ids: Array.isArray(ids) ? ids : null, settings: settings || null }),
  stop: (ids) => ipcRenderer.invoke('bots:stop', { ids: Array.isArray(ids) ? ids : null }),
  select: (id) => ipcRenderer.invoke('bots:select', String(id || '')),
  setAutoReconnect: (on) => ipcRenderer.invoke('bot:auto-reconnect', Boolean(on)),
  say: (text, all) => ipcRenderer.invoke('bot:say', { text: String(text), all: Boolean(all) }),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  openViewer: () => ipcRenderer.invoke('viewer:open'), // окно «Экран бота» выбранного бота; true, если открылось
  onLog: listen('bot:log'),
  onChat: listen('bot:chat'),
  onState: listen('bot:state'), // { bot, nick, state }
  onSummary: listen('fleet:summary'), // { total, online, … }
  onList: listen('fleet:list'), // { bots: [{ bot, nick, state }], selected }
});
