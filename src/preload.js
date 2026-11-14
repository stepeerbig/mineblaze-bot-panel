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
  // mode: 'one' — выбранному боту, 'all' / 'turn' — всем сразу / по очереди, 'group' / 'group-turn' — группе (ids)
  say: (text, mode, ids) => ipcRenderer.invoke('bot:say', {
    text: String(text),
    mode: ['all', 'turn', 'group', 'group-turn'].includes(mode) ? mode : 'one',
    ids: Array.isArray(ids) ? ids.map(String) : null,
  }),
  openLogs: () => ipcRenderer.invoke('app:open-logs'),
  openViewer: () => ipcRenderer.invoke('viewer:open'), // окно «Экран бота» выбранного бота; true, если открылось
  // ИИ-помощник: задание словами; settings — поля ИИ из формы (сохранить перед запуском). → { ok, error }
  aiRun: (task, settings) => ipcRenderer.invoke('ai:run', { task: String(task || ''), settings: settings || null }),
  aiStop: () => ipcRenderer.invoke('ai:stop'),
  aiModels: (settings) => ipcRenderer.invoke('ai:models', settings || null), // → { ok, models: [название] }
  // Готов ли ИИ: Ollama — { running, installed, version, hasModel, models }; интернет-сервис — { keyMissing }.
  aiStatus: () => ipcRenderer.invoke('ai:status'),
  aiGetOllama: () => ipcRenderer.invoke('ai:get-ollama'), // страница скачивания Ollama — в браузере
  onAiState: listen('ai:state'), // { running }
  onAiProgress: listen('ai:progress'), // { text } — что ИИ делает сейчас (думает, команда ботам, скачано 40 %)
  onAiDone: listen('ai:done'), // { text, partial, requests, provider, took, error }
  // Автопилот заданий: on — включить/выключить, settings — его поля из формы. → состояние (см. QuestAutopilot.status)
  questsToggle: (on, settings) => ipcRenderer.invoke('quests:toggle', { on: Boolean(on), settings: settings || null }),
  questsStatus: () => ipcRenderer.invoke('quests:status'),
  questsCheckNow: () => ipcRenderer.invoke('quests:check-now'),
  onQuestsStatus: listen('quests:status'), // { running, paused, online, current, levels, needs, … }
  // Задачи ботам: text — шаги по строке, target — 'selected' | 'online' | 'all', repeat — по кругу. → { ok, added, error }
  tasksAdd: (text, target, repeat, ids) => ipcRenderer.invoke('tasks:add', {
    text: String(text || ''), target: String(target || 'selected'), repeat: Boolean(repeat), ids: Array.isArray(ids) ? ids.map(String) : null,
  }),
  // action: 'pause' | 'resume' | 'cancel' | 'clear-done'; id — одна задача (без него — все)
  tasksControl: (action, id) => ipcRenderer.invoke('tasks:control', { action: String(action), id: id === undefined || id === null ? null : String(id) }),
  tasksList: () => ipcRenderer.invoke('tasks:list'),
  onTasks: listen('tasks:update'), // [{ id, bot, nick, state, stateText, step, total, current, note, repeat, rounds }]
  // «Авто фиш»: target — 'selected' | 'group' | 'online', ids — группа, home — дом склада. → { ok, targets, error }
  fishStart: (target, ids, home) => ipcRenderer.invoke('fish:start', {
    target: String(target || 'selected'), ids: Array.isArray(ids) ? ids.map(String) : null, home: String(home || ''),
  }),
  fishStop: (ids) => ipcRenderer.invoke('fish:stop', { ids: Array.isArray(ids) ? ids.map(String) : null }), // без ids — всех рыбаков
  // Перевести деньги ботов на ник to (/pay ник весь баланс): target — 'selected' | 'group' | 'online'. → { ok, targets, error }
  fishPay: (target, ids, to) => ipcRenderer.invoke('fish:pay', {
    target: String(target || 'online'), ids: Array.isArray(ids) ? ids.map(String) : null, to: String(to || ''),
  }),
  fishList: () => ipcRenderer.invoke('fish:list'),
  fishClear: () => ipcRenderer.invoke('fish:clear'), // убрать тех, кто уже не рыбачит
  onFish: listen('fish:update'), // { rows: [{ bot, nick, state, stateText, text, caught, last, items, rods, balance, active }], active, caught, balances, balanceTotal }
  // Проверка «я не робот» внутри панели: место под страницу (null — спрятать), вкладки ботов.
  captchaBounds: (r) => ipcRenderer.send('captcha:bounds', r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null),
  captchaState: () => ipcRenderer.invoke('captcha:state'),
  // action: 'show' | 'reload' | 'close'
  captchaControl: (action, bot) => ipcRenderer.invoke('captcha:control', { action: String(action), bot: bot === undefined || bot === null ? null : String(bot) }),
  onCaptcha: listen('captcha:state'), // { active, items: [{ bot, nick, via, failed }] }
  onLog: listen('bot:log'),
  onChat: listen('bot:chat'),
  onState: listen('bot:state'), // { bot, nick, state }
  onPing: listen('bot:ping'), // { bot, nick, ping } — пинг, как его считает сервер (Tab)
  onSummary: listen('fleet:summary'), // { total, online, … }
  onList: listen('fleet:list'), // { bots: [{ bot, nick, state }], selected }
});
