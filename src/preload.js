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
  // mode: 'one' — выбранному боту, 'all' — всем сразу, 'turn' — всем по очереди (команды «#…»)
  say: (text, mode) => ipcRenderer.invoke('bot:say', { text: String(text), mode: ['all', 'turn'].includes(mode) ? mode : 'one' }),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  openViewer: () => ipcRenderer.invoke('viewer:open'), // окно «Экран бота» выбранного бота; true, если открылось
  // ИИ-помощник: задание словами; settings — поля ИИ из формы (сохранить перед запуском). → { ok, error }
  aiRun: (task, settings) => ipcRenderer.invoke('ai:run', { task: String(task || ''), settings: settings || null }),
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  aiModels: (settings) => ipcRenderer.invoke('ai:models', settings || null), // → { ok, models: [название] }
  onAiState: listen('ai:state'), // { running }
  onAiDone: listen('ai:done'), // { text, partial, requests, error }
  onLog: listen('bot:log'),
  onChat: listen('bot:chat'),
  onState: listen('bot:state'), // { bot, nick, state }
  onPing: listen('bot:ping'), // { bot, nick, ping } — пинг, как его считает сервер (Tab)
  onSummary: listen('fleet:summary'), // { total, online, … }
  onList: listen('fleet:list'), // { bots: [{ bot, nick, state }], selected }
});
