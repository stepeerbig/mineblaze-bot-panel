'use strict';

// Хозяин бота — то, что работает в отдельном процессе (src/bot-process.js): BotManager и экран бота живут здесь,
// а окно панели, настройки и логи — в главном процессе (src/bot-client.js на той стороне).
// Зачем отдельно: тяжёлая работа окна и экрана не подвешивает тики бота, а падение бота не роняет панель.
//
// Сообщения главного процесса: { id, type, payload } → ответ { id, ok: true, value } или { id, ok: false, error }.
// События отсюда: { event, payload }: log, chat, state, link, msa, viewer-mode.

const path = require('path');

/**
 * @param {object}   opts
 * @param {object}   opts.port            { on(handler), post(message) } — канал к главному процессу
 * @param {Function} [opts.createManager] (options) => BotManager (подмена для тестов)
 * @param {Function} [opts.createViewer]  (options) => ViewerServer (подмена для тестов)
 * @param {Function} [opts.exit]          завершить процесс (после shutdown)
 */
function createBotHost({ port, createManager, createViewer, exit = () => {} }) {
  let manager = null;
  let config = null;
  let viewer = null;
  let viewerStarting = null;

  const emit = (event, payload) => {
    try {
      port.post({ event, payload });
    } catch (_) {
      /* канал закрыт — главный процесс уже ушёл */
    }
  };
  const log = (level, text) => emit('log', { time: Date.now(), level, text });

  function makeManager(opts) {
    if (createManager) return createManager(opts);
    const { BotManager } = require('./bot-manager');
    return new BotManager(opts);
  }

  function makeViewer(opts) {
    if (createViewer) return createViewer(opts);
    const { ViewerServer } = require('./viewer/viewer-server'); // грузим только при первом открытии
    return new ViewerServer(opts);
  }

  function requireManager() {
    if (!manager) throw new Error('процесс бота ещё не готов');
    return manager;
  }

  async function openViewer(mode) {
    const m = requireManager();
    if (!viewer) {
      const created = makeViewer({
        mode,
        log: (level, text) => m.log(level, `Экран бота: ${text}`),
      });
      // Режим переключают в самом окне экрана — главный процесс запомнит его до следующего раза.
      created.on('mode', (value) => emit('viewer-mode', value));
      created.on('error', (err) => m.log('error', `Экран бота: ${err && err.message ? err.message : err}`));
      viewer = created;
    }
    const server = viewer;
    if (!viewerStarting) viewerStarting = server.start().finally(() => (viewerStarting = null));
    const url = await viewerStarting;
    server.setBot(m.getBot());
    return url;
  }

  async function closeViewer() {
    const server = viewer;
    viewer = null;
    if (!server) return;
    try {
      await server.close();
    } catch (err) {
      if (manager) manager.log('warn', `Экран бота: сервер не остановился: ${err && err.message ? err.message : err}`);
    }
  }

  const handlers = {
    init({ config: cfg, authCacheDir, journalDir }) {
      if (manager) return true;
      config = { ...cfg };
      manager = makeManager({ config, authCacheDir, journalDir });
      manager.on('log', (entry) => emit('log', entry));
      manager.on('chat', (msg) => emit('chat', msg));
      manager.on('state', (state) => emit('state', state));
      manager.on('link', (link) => emit('link', link));
      manager.on('msa', (data) => emit('msa', data));
      // Экран бота показывает того бота, который сейчас в мире.
      manager.on('bot', (bot) => {
        if (viewer) viewer.setBot(bot);
      });
      return true;
    },
    config({ config: cfg }) {
      // Живой объект настроек менеджера: меняем поля, а не подменяем объект.
      if (config) Object.assign(config, cfg);
      return true;
    },
    start: () => requireManager().start(),
    stop: () => {
      requireManager().stop();
      return true;
    },
    autoReconnect: ({ on }) => requireManager().setAutoReconnect(Boolean(on)),
    say: ({ text }) => requireManager().say(text),
    state: () => (manager ? manager.state : 'offline'),
    'viewer:open': ({ mode }) => openViewer(mode),
    'viewer:close': () => closeViewer().then(() => true),
    ping: () => 'pong',
    /** Сколько пакетов какого вида бот отправил и насколько ровно шли тики — за последние windowMs. */
    journalStats: ({ windowMs = 60 * 1000 }) => {
      const journal = manager && manager.journal;
      if (!journal) return null;
      const { performance } = require('perf_hooks'); // те же часы, что у журнала
      return journal.stats({ sinceMs: performance.timeOrigin + performance.now() - windowMs });
    },
    /** Проверка сборки: модули бота грузятся (в том числе из app.asar), экран поднимается и закрывается. */
    async selftest() {
      const mineflayerVersion = require('mineflayer/package.json').version;
      require('./bot/physics');
      require('./bot/actions');
      const url = await openViewer('first');
      await closeViewer();
      return { node: process.versions.node, electron: process.versions.electron || null, mineflayer: mineflayerVersion, viewer: Boolean(url) };
    },
    async shutdown() {
      if (manager) manager.shutdown();
      await closeViewer();
      return true;
    },
  };

  port.on(async (message) => {
    if (!message || typeof message !== 'object' || message.id === undefined) return;
    const { id, type, payload } = message;
    const handler = handlers[type];
    try {
      if (!handler) throw new Error(`неизвестная команда процессу бота: ${type}`);
      const value = await handler(payload || {});
      port.post({ id, ok: true, value });
    } catch (err) {
      port.post({ id, ok: false, error: err && err.message ? err.message : String(err) });
    }
    if (type === 'shutdown') setTimeout(() => exit(0), 300).unref?.(); // дать ответу и отключению бота уйти
  });

  return { log, handlers, get manager() { return manager; }, get viewer() { return viewer; } };
}

module.exports = { createBotHost, ENTRY: path.join(__dirname, 'bot-process.js') };
