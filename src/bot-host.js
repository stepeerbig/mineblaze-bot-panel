'use strict';

// Хозяин ботов — то, что работает в отдельном процессе (src/bot-process.js): несколько BotManager (по боту на
// каждый) и экран бота живут здесь, а окно панели, настройки и логи — в главном процессе (src/fleet.js,
// src/bot-client.js на той стороне). Зачем отдельно: тяжёлая работа окна и экрана не подвешивает тики ботов,
// а падение процесса роняет только его ботов. Ботов много — процессов несколько (см. fleet.js).
//
// Сообщения главного процесса: { id, type, payload } → ответ { id, ok: true, value } или { id, ok: false, error }.
// События отсюда: { event, payload }; у событий бота в payload есть bot — его номер (ник маленькими буквами):
//   log, chat, state { bot, state }, link, msa, ping { bot, ping } — пинг, как его считает сервер,
//   want-connect { bot } — просится в общую очередь входа;
//   viewer-mode — режим экрана переключили в его окне; viewer-xray — там же поменяли рентген (настройки целиком).

const path = require('path');

// Журнал пакетов каждого бота (сохраняется при кике): полминуты и не больше 20 000 пакетов. Ботов много, а на
// людном спавне журнал за минуту — мегабайты у каждого; для разбора кика хватает и последних 30 секунд.
const JOURNAL_LIMITS = Object.freeze({ keepMs: 30 * 1000, maxEntries: 20000 });

/**
 * @param {object}   opts
 * @param {object}   opts.port            { on(handler), post(message) } — канал к главному процессу
 * @param {Function} [opts.createManager] (options) => BotManager (подмена для тестов)
 * @param {Function} [opts.createViewer]  (options) => ViewerServer (подмена для тестов)
 * @param {Function} [opts.exit]          завершить процесс (после shutdown)
 */
function createBotHost({ port, createManager, createViewer, exit = () => {} }) {
  const bots = new Map(); // номер бота → { account: { username, password }, config, manager }
  let shared = null; // общие настройки панели (живой объект: меняем поля)
  let dirs = null; // { authCacheDir, journalDir }
  let viewer = null;
  let viewerStarting = null;
  let viewerBot = null; // какого бота показывает экран

  const emit = (event, payload) => {
    try {
      port.post({ event, payload });
    } catch (_) {
      /* канал закрыт — главный процесс уже ушёл */
    }
  };
  const log = (level, text, bot = null) => emit('log', { bot, time: Date.now(), level, text });

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

  function requireReady() {
    if (!shared) throw new Error('процесс бота ещё не готов');
  }

  function entryOf(id) {
    requireReady();
    const entry = bots.get(String(id || ''));
    if (!entry) throw new Error(`бота ${id} в этом процессе нет`);
    return entry;
  }

  /** Настройки бота = общие + его ник и пароль (свой или общий). Объект тот же: менеджер читает его вживую. */
  function refresh(entry) {
    Object.assign(entry.config, shared, {
      username: entry.account.username,
      loginPassword: entry.account.password || shared.loginPassword || '',
    });
  }

  function addBot(id, account) {
    const entry = { account: { username: account.username, password: account.password || '' }, config: {}, manager: null };
    refresh(entry);
    const manager = makeManager({
      config: entry.config,
      authCacheDir: dirs.authCacheDir,
      journalDir: dirs.journalDir,
      requestConnect: () => emit('want-connect', { bot: id }),
      journalLimits: JOURNAL_LIMITS,
    });
    entry.manager = manager;
    manager.on('log', (e) => emit('log', { bot: id, ...e }));
    manager.on('chat', (m) => emit('chat', { bot: id, ...m }));
    manager.on('state', (state) => emit('state', { bot: id, state }));
    manager.on('link', (l) => emit('link', { bot: id, ...l }));
    manager.on('ready', () => emit('ready', { bot: id }));
    manager.on('captcha', (c) => emit('captcha', { bot: id, ...c }));
    manager.on('captcha-done', (c) => emit('captcha-done', { bot: id, ...c }));
    manager.on('ip-block', (b) => emit('ip-block', { bot: id, ...b }));
    manager.on('login-hung', (h) => emit('login-hung', { bot: id, ...h }));
    manager.on('msa', (d) => emit('msa', { bot: id, ...d }));
    manager.on('ping', (ping) => emit('ping', { bot: id, ping }));
    // Экран показывает своего бота: тот появился в мире или пропал — экран узнаёт сразу.
    manager.on('bot', (bot) => {
      if (viewer && viewerBot === id) viewer.setBot(bot);
    });
    bots.set(id, entry);
    return entry;
  }

  function removeBot(id) {
    const entry = bots.get(id);
    if (!entry) return;
    bots.delete(id);
    try {
      entry.manager.shutdown();
    } catch (err) {
      log('warn', `Бот ${entry.account.username}: не остановился: ${err && err.message ? err.message : err}`, id);
    }
    entry.manager.removeAllListeners();
    emit('state', { bot: id, state: 'offline' });
    if (viewerBot === id && viewer) viewer.setBot(null);
  }

  async function openViewer(mode, id) {
    requireReady();
    if (!viewer) {
      const created = makeViewer({
        mode,
        xray: shared.xray,
        log: (level, text) => log(level, `Экран бота: ${text}`, viewerBot),
      });
      // Режим и рентген меняют в самом окне экрана — главный процесс запомнит их до следующего раза.
      created.on('mode', (value) => emit('viewer-mode', value));
      created.on('xray', (settings) => emit('viewer-xray', settings));
      created.on('error', (err) => log('error', `Экран бота: ${err && err.message ? err.message : err}`, viewerBot));
      viewer = created;
    }
    const server = viewer;
    if (!viewerStarting) viewerStarting = server.start().finally(() => (viewerStarting = null));
    const url = await viewerStarting;
    showOnViewer(id);
    return url;
  }

  function showOnViewer(id) {
    viewerBot = id && bots.has(String(id)) ? String(id) : null;
    if (viewer) viewer.setBot(viewerBot ? bots.get(viewerBot).manager.getBot() : null);
  }

  async function closeViewer() {
    const server = viewer;
    viewer = null;
    viewerBot = null;
    if (!server) return;
    try {
      await server.close();
    } catch (err) {
      log('warn', `Экран бота: сервер не остановился: ${err && err.message ? err.message : err}`);
    }
  }

  const handlers = {
    init({ config: cfg, authCacheDir, journalDir }) {
      if (shared) return true;
      shared = { ...cfg };
      dirs = { authCacheDir, journalDir };
      return true;
    },
    config({ config: cfg }) {
      // Живые объекты настроек ботов: меняем поля, а не подменяем объекты.
      requireReady();
      Object.assign(shared, cfg);
      for (const entry of bots.values()) refresh(entry);
      if (viewer && cfg && cfg.xray && typeof viewer.setXray === 'function') viewer.setXray(cfg.xray); // те же — ничего
      return true;
    },
    /** Какие боты живут в этом процессе: [{ bot, username, password }]. Новые — создать, лишние — убрать. */
    bots({ list }) {
      requireReady();
      const wanted = new Map((Array.isArray(list) ? list : []).map((a) => [String(a.bot), a]));
      for (const id of [...bots.keys()]) if (!wanted.has(id)) removeBot(id);
      for (const [id, account] of wanted) {
        const entry = bots.get(id);
        if (!entry) {
          addBot(id, account);
        } else {
          entry.account = { username: account.username, password: account.password || '' };
          refresh(entry);
        }
      }
      return [...bots.keys()];
    },
    start: ({ bot }) => entryOf(bot).manager.start(),
    stop: ({ bot }) => {
      entryOf(bot).manager.stop();
      return true;
    },
    admit: ({ bot }) => (bots.has(String(bot)) ? entryOf(bot).manager.admit() : false),
    /** Автореконнект — у всех ботов процесса (в консоль панель пишет об этом сама, один раз). */
    autoReconnect: ({ on }) => {
      requireReady();
      shared.autoReconnect = Boolean(on);
      for (const entry of bots.values()) entry.manager.setAutoReconnect(Boolean(on), { quiet: true });
      return shared.autoReconnect;
    },
    say: ({ bot, text }) => entryOf(bot).manager.say(text),
    /**
     * Команда боту «#…» с ожиданием конца: { ok, code, message, data } (для «всем по очереди», ИИ и автопилота
     * заданий). data — как есть, но только то, что переживёт передачу между процессами (JSON).
     */
    command: async ({ bot, line, quiet = false }) => {
      const r = await entryOf(bot).manager.command(String(line || ''), { quiet: Boolean(quiet) });
      let data = null;
      try {
        data = r && r.data !== undefined ? JSON.parse(JSON.stringify(r.data)) : null;
      } catch (_) {
        data = null; // например, кольцевые ссылки — без данных, ответ всё равно нужен
      }
      return { ok: Boolean(r && r.ok), code: (r && r.code) || null, message: [].concat((r && r.message) || []).map(String), data };
    },
    state: ({ bot }) => entryOf(bot).manager.state,
    'viewer:open': ({ mode, bot }) => openViewer(mode, bot),
    /** Экран уже открыт — показать другого бота этого процесса. */
    'viewer:bot': ({ bot }) => {
      showOnViewer(bot);
      return Boolean(viewerBot);
    },
    'viewer:close': () => closeViewer().then(() => true),
    ping: () => 'pong',
    /** Сколько пакетов какого вида бот отправил и насколько ровно шли тики — за последние windowMs. */
    journalStats: ({ bot, windowMs = 60 * 1000 }) => {
      const entry = bots.get(String(bot || '')) || bots.values().next().value;
      const journal = entry && entry.manager.journal;
      if (!journal) return null;
      const { performance } = require('perf_hooks'); // те же часы, что у журнала
      return journal.stats({ sinceMs: performance.timeOrigin + performance.now() - windowMs });
    },
    /** Проверка сборки: модули бота грузятся (в том числе из app.asar), экран поднимается и закрывается. */
    async selftest() {
      const mineflayerVersion = require('mineflayer/package.json').version;
      require('./bot/physics');
      require('./bot/actions');
      require('./bot-manager');
      const url = await openViewer('first', null);
      await closeViewer();
      return { node: process.versions.node, electron: process.versions.electron || null, mineflayer: mineflayerVersion, viewer: Boolean(url) };
    },
    async shutdown() {
      for (const entry of bots.values()) {
        try {
          entry.manager.shutdown();
        } catch (_) {
          /* выходим всё равно */
        }
      }
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
    if (type === 'shutdown') setTimeout(() => exit(0), 300).unref?.(); // дать ответу и отключению ботов уйти
  });

  return { log, handlers, get bots() { return bots; }, get viewer() { return viewer; } };
}

module.exports = { createBotHost, ENTRY: path.join(__dirname, 'bot-process.js') };
