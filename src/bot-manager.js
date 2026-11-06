'use strict';

const EventEmitter = require('events');
const { chatToText, describeError, describeEnd, noRetryReason, maskSecrets, extractLinks, forcedMoveReason } = require('./chat-utils');
const { parseJoinCommands, MAX_CHAT_LENGTH } = require('./config');
const { PacketJournal, saveJournal } = require('./bot/packet-journal');
const { createPhysicsPlugin } = require('./bot/physics');
const { profileOptions, settingsPlugin, applyClientProfile } = require('./bot/client-profile');
const { createActionsPlugin } = require('./bot/actions');
const { windowClicksPlugin } = require('./bot/window-clicks');
const { Guard, GodKeeper, worldNameOf } = require('./bot/guard');
const { runCommand } = require('./bot/commands');

// Что бот делает как обычный клиент, а не как mineflayer (см. src/bot/). Выключать нужно только для сравнения
// на тестовом стенде: physics — своя физика (ровные тики, движение по правилам клиента), tickEnd — пакет
// tick_end в конце каждого тика, profile — бренд и настройки клиента один раз при входе, clicks — клики
// в меню с настоящими «отпечатками» предметов и курсор, который поправляет сервер.
const DEFAULT_COMPAT = Object.freeze({ physics: true, tickEnd: true, profile: true, clicks: true });
const FORCED_MOVE_REPEAT_MS = 10 * 1000; // одно и то же сообщение о возврате в лобби может прийти несколько раз
// Сервер шлёт что-нибудь (ping, keep_alive…) по многу раз в секунду: столько тишины — уже странно.
const SILENCE_MS = 4000;
const SILENCE_STUCK_BYTES = 256; // столько пришло за тишину, а пакетов нет — бот перестал разбирать данные
// Режим бога: проверить через столько после команд входа и после перехода на другой сервер.
const GOD_AFTER_JOIN_MS = 4000;
const GOD_AFTER_SWITCH_MS = 3000;
// Сервер возвращает бота на место (телепорт) столько раз за SETBACK_WINDOW_MS — бот застрял: в блоках, в другом
// игроке, в воде. Обычный клиент так не дёргается, и MineBlaze за это выкидывает в лобби («Кажется вы залагали»).
const SETBACK_LIMIT = 8;
const SETBACK_WINDOW_MS = 3000;
const SETBACK_WARN_EVERY_MS = 30 * 1000;

const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Сколько байтов пришло по сокету клиента (null — не узнать). */
function socketBytes(client) {
  const sock = client && client.socket;
  return sock && Number.isFinite(sock.bytesRead) ? sock.bytesRead : null;
}

/** Где застряли данные от сервера (для журнала пакетов): байты сокета и очереди разбора minecraft-protocol. */
function pipelineInfo(client) {
  const len = (stream) => {
    if (!stream) return '—';
    const queued = Number.isFinite(stream.writableLength) ? stream.writableLength : '?';
    return `${queued}${stream.destroyed ? ' (сломан)' : ''}`;
  };
  const split = client && client.splitter && client.splitter.buffer ? client.splitter.buffer.length : '?';
  return `получено байт ${socketBytes(client) === null ? '?' : socketBytes(client)}, ждут нарезки ${split} Б, ` +
    `очередь распаковки ${len(client && client.decompressor)}, очередь разбора ${len(client && client.deserializer)}`;
}

// Таймеры менеджера не должны держать процесс живым (важно для тестов; в Electron ничего не меняет).
function later(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

const DEFAULT_TIMINGS = Object.freeze({
  loginTimeout: 40 * 1000, // столько ждём входа на сервер, потом считаем попытку неудачной
  msaTimeout: 15 * 60 * 1000, // вход через Microsoft: время, чтобы ввести код в браузере
  joinFirst: 1500, // пауза после появления в мире перед первой командой
  joinStep: 1200, // пауза между командами после входа
  // Между командами (и сообщениями) в чат. MineBlaze молча пропускает команду, пришедшую меньше чем через
  // ~1 с после предыдущей: так терялся /spawn охраны сразу за /near и второй /god подряд.
  commandGap: 1500,
});
const OUTBOX_SWITCH_WAIT_MS = 500; // пока прокси переводит бота на другой сервер, команды ждут

// Автореконнект: первые попытки — с паузой из настроек, дальше пауза удваивается (но не больше минуты),
// чтобы не долбить лежащий сервер и не попасть под защиту от частых подключений.
const BACKOFF_FREE_ATTEMPTS = 3;
const BACKOFF_MAX_SECONDS = 60;

// Ссылки от сервера (например, браузерная проверка «я не робот») могут прийти где угодно: в причине кика,
// в окне-диалоге 1.21.6+, в заголовке на экране, в меню, на табличке. Смотрим все пакеты, кроме тяжёлых
// и заведомо пустых. Чат разбирается отдельно, в обработчике 'message'.
const LINK_SKIP = new Set([
  'system_chat', 'player_chat', 'profileless_chat', 'chat', // чат — см. 'message'
  'map_chunk', 'update_light', 'unload_chunk', 'multi_block_change', 'block_change', 'block_action',
  'block_break_animation', 'world_event', 'world_particles', 'explosion', 'map', 'tags', 'registry_data',
  'declare_commands', 'declare_recipes', 'advancements', 'statistics', 'player_info', 'player_remove',
  'add_resource_pack', 'remove_resource_pack', 'resource_pack_send', // адрес ресурспака — не для человека
  'server_links', // ссылки «сайт / дискорд» из меню паузы — не то, что ищем
  // Таблица справа и команды (Tab): там адрес сайта сервера-рекламы («www.MineBlaze.net»), а не проверка.
  'scoreboard_score', 'scoreboard_objective', 'scoreboard_display_objective', 'reset_score', 'teams',
  'keep_alive', 'ping', 'ping_response', 'position', 'player_rotation', 'sync_entity_position',
  'rel_entity_move', 'entity_move_look', 'entity_look', 'entity_head_rotation', 'entity_teleport', 'entity_velocity',
  'entity_status', 'entity_destroy', 'entity_effect', 'remove_entity_effect', 'entity_update_attributes',
  'entity_sound_effect', 'sound_effect', 'stop_sound', 'update_time', 'update_health', 'experience',
  'spawn_entity', 'animation', 'hurt_animation', 'damage_event', 'collect', 'attach_entity', 'set_passengers',
  'move_minecart', 'vehicle_move', 'camera', 'update_view_position', 'update_view_distance', 'simulation_distance',
  'spawn_position', 'game_state_change', 'held_item_slot', 'set_cooldown', 'craft_progress_bar',
  'acknowledge_player_digging', 'set_ticking_state', 'step_tick', 'set_title_time', 'clear_titles',
  'bundle_delimiter', 'tracked_waypoint', 'set_projectile_power', 'feature_flags', 'select_known_packs',
  'finish_configuration', 'reset_chat', 'compress', 'success', 'encryption_begin', 'custom_payload',
  'cookie_request', 'store_cookie', 'login', 'respawn', 'abilities', 'difficulty',
]);
const LINK_SKIP_RE = /^(debug_|world_border|chunk_|recipe_book_|initialize_world_border)/;
const LINK_SOURCES = {
  kick_disconnect: 'причина кика',
  disconnect: 'причина кика',
  show_dialog: 'окно сервера',
  set_title_text: 'заголовок на экране',
  set_title_subtitle: 'подзаголовок на экране',
  title: 'заголовок на экране',
  action_bar: 'надпись над хотбаром',
  boss_bar: 'полоса вверху экрана',
  playerlist_header: 'список игроков (Tab)',
  window_items: 'меню',
  set_slot: 'меню',
  open_window: 'меню',
  tile_entity_data: 'табличка',
  entity_metadata: 'надпись в мире',
  open_book: 'книга',
  server_data: 'описание сервера',
  death_combat_event: 'экран смерти',
  custom_report_details: 'данные для отчёта',
  code_of_conduct: 'правила сервера',
};
const MAX_LINKS_PER_SESSION = 30; // чтобы спам ссылками не забил консоль

/**
 * Управляет одним ботом mineflayer.
 *
 * События:
 *   'log'   { time, level, text }   level: info | ok | warn | error | kick   (только статусы и ошибки)
 *   'chat'  { time, text, motd, position }   весь чат сервера; position 'self' — команда, отправленная из панели
 *   'state' 'offline' | 'queued' | 'connecting' | 'connected' | 'online' | 'reconnecting'
 *           queued — ждёт своей очереди на вход (много ботов входят по одному, см. opts.requestConnect)
 *   'msa'   { verification_uri, user_code }                                  (вход через Microsoft)
 *   'bot'   bot | null   бот появился в мире / пропал (для «Экрана бота»; без повторов, см. getBot)
 *   'link'  { time, url, source }   сервер прислал ссылку для человека (например, проверка «я не робот»)
 *   'ping'  мс | null   пинг бота, как его считает сервер (он же — в Tab у игроков); null — бот не в сети
 */
class BotManager extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {object}   opts.config        живой объект настроек (см. config.js)
   * @param {string}   opts.authCacheDir  папка для токенов Microsoft-входа
   * @param {string}   [opts.journalDir]  куда сохранять журнал пакетов при кике и возврате в лобби (нет — не сохранять)
   * @param {object}   [opts.compat]      что делать как обычный клиент (см. DEFAULT_COMPAT)
   * @param {Function} [opts.createBot]   подмена mineflayer.createBot (нужна для тестов)
   * @param {object}   [opts.timings]     подмена задержек (нужна для тестов)
   * @param {Function} [opts.requestConnect] () => void — попросить общую очередь входа о месте (много ботов
   *   входят по одному); бот ждёт в состоянии 'queued', пока ему не скажут admit(). Нет — входит сразу.
   * @param {object}   [opts.journalLimits]  { keepMs, maxEntries } журнала пакетов (у множества ботов — меньше:
   *   на людном спавне журнал каждого — мегабайты)
   */
  constructor({ config, authCacheDir, journalDir = null, compat, createBot, timings, requestConnect = null, journalLimits = {} } = {}) {
    super();
    this.config = config;
    this.authCacheDir = authCacheDir;
    this.journalDir = journalDir;
    this.journalLimits = journalLimits;
    this.compat = { ...DEFAULT_COMPAT, ...compat };
    this._createBot = createBot;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this._requestConnect = requestConnect;

    this.state = 'offline';
    this.cur = null; // текущая сессия (см. _connect)
    this.lastSession = null; // последняя сессия, даже закончившаяся: её журнал можно сохранить
    this.wantRun = false; // true между «Старт» и «Стоп» (или окончательным отказом)
    this.reconnectTimer = null;
    this.attempt = 0;
    this.announced = null; // какой бот последним объявлен событием 'bot'
    this.godMemory = new Map(); // ник → был ли включён режим бога (сервер помнит его и после перезахода)
    this.ping = null; // пинг, как его считает сервер (см. событие 'ping')
  }

  /** Журнал пакетов последней сессии (или null, если бот ещё не запускался). */
  get journal() {
    return this.lastSession ? this.lastSession.journal : null;
  }

  // ---------- публичные методы ----------

  /** Бот mineflayer, если он уже появился в мире и не останавливается; иначе null. */
  getBot() {
    const s = this.cur;
    return s && s.spawned && !s.stopping ? s.bot : null;
  }

  start() {
    if (this.state !== 'offline') {
      this.log('warn', 'Бот уже запущен');
      return false;
    }
    this.wantRun = true;
    this.attempt = 0;
    this._begin();
    return true;
  }

  /** Очередь входа дошла до этого бота: входить (если он всё ещё ждёт). true — начал вход. */
  admit() {
    if (!this.wantRun || this.state !== 'queued') return false;
    this._connect();
    return true;
  }

  stop() {
    if (this.state === 'offline') return;
    this.wantRun = false;

    // Ждал очереди на вход — просто выходим из неё.
    if (this.state === 'queued' && !this.cur) {
      this._setState('offline');
      this.log('warn', 'Не в сети: вход отменён');
      return;
    }

    // Ждали переподключения — просто отменяем.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this._setState('offline');
      this.log('warn', 'Не в сети: переподключение отменено');
      return;
    }

    const s = this.cur;
    if (!s) {
      this._setState('offline');
      return;
    }
    if (s.stopping) return; // повторное нажатие «Стоп»
    s.stopping = true;
    clearTimeout(s.joinTimer);
    this._announceBot(); // для экрана бота он уже не в сети

    this.log('info', 'Остановка бота…');
    try {
      s.bot.quit();
    } catch (_) {
      /* ничего: ниже закроем принудительно */
    }
    // Если сервер не ответил закрытием — закрываем сами (до входа ждём совсем недолго).
    clearTimeout(s.forceTimer);
    s.forceTimer = later(() => this._forceClose(s, 'stopped'), s.loggedIn ? 2000 : 300);
  }

  /** quiet — не писать в консоль «Автоматический реконнект: ON» (у многих ботов это пишет панель один раз). */
  setAutoReconnect(on, { quiet = false } = {}) {
    this.config.autoReconnect = Boolean(on);
    if (!quiet) this.log('info', `Автоматический реконнект: ${on ? 'ON' : 'OFF'}`);

    // Выключили, пока шло ожидание перед переподключением (или очередь на него) — отменяем.
    const waitingRetry = this.reconnectTimer || (this.state === 'queued' && this.attempt > 0 && !this.cur);
    if (!on && waitingRetry) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this.wantRun = false;
      this._setState('offline');
      this.log('warn', 'Не в сети: ожидание переподключения отменено');
    }
    return this.config.autoReconnect;
  }

  /** Отправить сообщение или команду (/...) в чат сервера. Строка с «#» — команда боту (src/bot/commands.js). */
  say(text) {
    const msg = String(text === undefined || text === null ? '' : text)
      .replace(/[\r\n]+/g, ' ')
      .trim()
      .slice(0, MAX_CHAT_LENGTH);
    if (!msg) return false;
    if (msg.startsWith('#')) return this._command(msg);
    const s = this.cur;
    if (!s || !s.loggedIn || s.stopping) {
      this.log('warn', 'Сообщение не отправлено: бот не в сети');
      return false;
    }
    return this._send(s, msg);
  }

  /** Сохраняет журнал пакетов последней сессии в файл; возвращает путь или null. */
  saveJournal(reason) {
    return this.lastSession ? this._saveJournal(this.lastSession, reason) : null;
  }

  /** Пауза перед попыткой номер attempt (в секундах). */
  reconnectDelayFor(attempt) {
    const base = clamp(parseInt(this.config.reconnectDelay, 10) || 5, 1, 600);
    const extra = Math.max(0, attempt - BACKOFF_FREE_ATTEMPTS);
    if (extra === 0) return base;
    return Math.max(base, Math.min(base * 2 ** extra, BACKOFF_MAX_SECONDS));
  }

  /** Вызывается при закрытии приложения. */
  shutdown() {
    this.wantRun = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const s = this.cur;
    this.cur = null;
    this._announceBot();
    if (!s) return;
    this._clearTimers(s);
    try {
      s.bot.quit();
    } catch (_) {
      /* ignore */
    }
  }

  log(level, text) {
    this.emit('log', { time: Date.now(), level, text });
  }

  // ---------- внутреннее ----------

  /** Начать вход: сразу или через общую очередь входа (тогда — 'queued' до admit()). */
  _begin() {
    if (!this._requestConnect) {
      this._connect();
      return;
    }
    this._setState('queued');
    try {
      this._requestConnect();
    } catch (err) {
      this.log('error', `Очередь входа: ${describeError(err)}`);
      this._connect(); // без очереди — лучше войти сразу, чем стоять вечно
    }
  }

  _setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  // Сообщает подписчикам (экрану бота), что бот появился в мире или пропал; одно и то же дважды не шлёт.
  _announceBot() {
    const bot = this.getBot();
    if (bot === this.announced) return;
    this.announced = bot;
    try {
      this.emit('bot', bot);
    } catch (err) {
      // Вызывается из обработчиков событий бота: ошибка подписчика не должна их ломать.
      this.log('error', `Экран бота: ${describeError(err)}`);
    }
  }

  _clearTimers(s) {
    clearTimeout(s.forceTimer);
    clearTimeout(s.errorTimer);
    clearTimeout(s.loginTimer);
    clearTimeout(s.joinTimer);
    clearInterval(s.silenceTimer);
    clearTimeout(s.outboxTimer);
    s.outboxTimer = null;
    if (s.outbox) s.outbox.length = 0;
    if (s.guard) s.guard.stop();
    if (s.god) s.god.stop();
  }

  /**
   * Сторож тишины. Если от сервера несколько секунд не приходит ни одного пакета, это или сервер перестал
   * отвечать, или бот перестал разбирать то, что приходит. Различаем по счётчику байтов сокета и пишем
   * в консоль и в журнал пакетов — чтобы по следующему обрыву было видно, чья это проблема.
   */
  _watchSilence(s) {
    const client = s.bot && s.bot._client;
    if (!client || typeof client.on !== 'function') return;
    s.lastInAt = Date.now();
    client.on('packet', () => {
      const now = Date.now();
      if (s.silence && this.cur === s) {
        const sec = ((now - s.silence.since) / 1000).toFixed(1);
        this.log('info', `Сервер снова на связи (молчал ${sec} с)`);
        if (s.journal) s.journal.mark(`Сервер снова на связи после ${sec} с тишины`);
      }
      s.silence = null;
      s.lastInAt = now;
    });
    s.silenceTimer = setInterval(() => {
      if (this.cur !== s || !s.loggedIn || s.stopping) return;
      const quiet = Date.now() - s.lastInAt;
      if (quiet < SILENCE_MS) return;
      const bytes = socketBytes(client);
      if (!s.silence) {
        s.silence = { since: s.lastInAt, bytes, stuck: false };
        this.log('warn', `От сервера ${Math.round(quiet / 1000)} с ничего не приходит`);
        if (s.journal) s.journal.mark(`Тишина от сервера ${quiet} мс; ${pipelineInfo(client)}`);
        return;
      }
      if (!s.silence.stuck && bytes !== null && s.silence.bytes !== null && bytes - s.silence.bytes > SILENCE_STUCK_BYTES) {
        s.silence.stuck = true;
        this.log('error', 'Данные от сервера приходят, но бот перестал их разбирать — это ошибка бота (журнал пакетов сохранён)');
        if (s.journal) s.journal.mark(`Данные приходят, но не разбираются: ${pipelineInfo(client)}`);
        this._saveJournal(s, 'бот перестал разбирать данные от сервера');
      }
    }, 1000);
    if (s.silenceTimer && typeof s.silenceTimer.unref === 'function') s.silenceTimer.unref();
  }

  _connect() {
    const cfg = { ...this.config };
    this._setState('connecting');
    this.log('info', `Подключение к ${cfg.host}:${cfg.port} как ${cfg.username} (версия ${cfg.version || 'авто'})…`);

    const s = {
      bot: null,
      loggedIn: false,
      spawned: false,
      dead: false,
      reported: false, // причина неудачи уже показана в консоли
      kicked: false,
      noRetry: null, // почему переподключаться бессмысленно (бан и т.п.)
      stopping: false,
      packNoted: false,
      links: new Set(), // ссылки, уже показанные в консоли за эту сессию
      kickText: '',
      switching: false, // прокси переводит бота на другой сервер
      serverBrand: '',
      forcedAt: 0, // когда последний раз сообщили о возврате в лобби
      journal: null,
      // Шапка файла журнала (без паролей).
      meta: {
        Сервер: `${cfg.host}:${cfg.port}`,
        Версия: cfg.version || 'авто',
        Ник: cfg.username,
        Вход: cfg.auth,
        'Как обычный клиент': Object.keys(this.compat).map((k) => `${k}=${this.compat[k] ? 'да' : 'нет'}`).join(', '),
      },
      forceTimer: null,
      errorTimer: null,
      loginTimer: null,
      joinTimer: null,
      outbox: [], // команды и сообщения, ждущие своей очереди (см. _send)
      outboxTimer: null,
      lastSentAt: 0,
    };
    const alive = () => this.cur === s;

    let bot;
    try {
      const createBot = this._createBot || require('mineflayer').createBot;
      const options = {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        auth: cfg.auth,
        version: cfg.version || false,
        ...this._compatOptions(),
      };
      if (cfg.auth === 'microsoft') {
        options.profilesFolder = this.authCacheDir;
        options.onMsaCode = (data) => {
          this.log('warn', `Вход через Microsoft: открой ${data.verification_uri} и введи код ${data.user_code}`);
          if (alive() && !s.loggedIn) {
            // Пока человек вводит код, обычный тайм-аут входа не действует.
            clearTimeout(s.loginTimer);
            s.loginTimer = later(() => this._loginTimeout(s, 'время на вход через Microsoft истекло'), this.timings.msaTimeout);
          }
          this.emit('msa', data);
        };
      }
      bot = createBot(options);
    } catch (err) {
      // Это ошибка настроек/установки (например, версия не поддерживается) — повторять бессмысленно.
      this.log('error', `Не удалось запустить бота: ${describeError(err)}`);
      this.wantRun = false;
      this._setState('offline');
      return;
    }

    s.bot = bot;
    this.cur = s;
    this.lastSession = s;
    // Журнал — ближе всех к сети, профиль — поверх него: в журнал попадает то, что ушло на сервер на самом деле.
    s.journal = new PacketJournal({ ...this.journalLimits, getSelfId: () => (bot.entity ? bot.entity.id : null) });
    s.journal.attach(bot._client);
    if (this.compat.profile) applyClientProfile(bot._client);
    this._watchSilence(s);

    // Охрана вне спавна и режим бога (src/bot/guard.js). Настройки берут живые: белый список меняется на ходу.
    const guardCtx = {
      send: (cmd, opts) => (alive() && s.loggedIn && !s.stopping ? this._send(s, cmd, opts) : false),
      log: (level, text) => {
        if (alive()) this.log(level, text);
      },
      config: this.config,
    };
    const getSpawnedBot = () => (alive() && s.spawned && !s.stopping ? bot : null);
    s.guard = new Guard({ ...guardCtx, getBot: getSpawnedBot });
    const godKey = String(cfg.username || '').toLowerCase();
    s.god = new GodKeeper({
      ...guardCtx,
      getBot: getSpawnedBot,
      remembered: this.godMemory.get(godKey) === true,
      onState: (on) => this.godMemory.set(godKey, on),
    });
    bot.guard = s.guard;
    bot.panelConfig = this.config; // живые настройки панели — командам (#рентген берёт отсюда список блоков)
    // Команды серверу из команд боту (#квесты принести пишет /home и /warp ah): та же очередь, что у чата панели,
    // и охрана с режимом бога видят их так же.
    bot.sendCommand = (cmd) => (alive() && s.loggedIn && !s.stopping ? this._send(s, cmd) : false);
    bot.on('forcedMove', () => {
      if (!alive()) return;
      s.guard.onTeleport();
      this._countSetback(s);
    });
    // Пинг бота, как его считает сервер (он же — в Tab у игроков): сервер обновляет его раз в несколько секунд.
    const onPlayer = (p) => {
      if (alive() && p && p.username === bot.username) this._setPing(p.ping);
    };
    bot.on('playerJoined', onPlayer);
    bot.on('playerUpdated', onPlayer);
    bot.on('respawn', () => {
      if (alive()) s.guard.onTeleport();
    });
    bot.on('health', () => {
      if (alive() && s.spawned) s.god.onHealth(bot.health, bot.food);
    });
    // Имя мира (на MineBlaze спавн сервера режима — мир «lobby»): охране надо знать, на спавне ли бот.
    if (bot._client && typeof bot._client.on === 'function') {
      const onWorld = (packet) => {
        const name = worldNameOf(packet);
        if (name) bot.worldName = name;
      };
      bot._client.on('login', onWorld);
      bot._client.on('respawn', onWorld);
    }
    s.loginTimer = later(
      () => this._loginTimeout(s, `вход не завершился за ${Math.round(this.timings.loginTimeout / 1000)} с`),
      this.timings.loginTimeout,
    );

    bot.once('login', () => {
      if (!alive()) {
        // «Осиротевший» бот всё-таки зашёл (например, после «Стоп» во время входа через Microsoft) — выходим.
        try {
          bot.quit();
        } catch (_) {
          /* ignore */
        }
        return;
      }
      s.loggedIn = true;
      clearTimeout(s.loginTimer);
      this._setState('connected');
      this.log('ok', 'Подключен: вход на сервер выполнен');
    });

    // Повторный 'login' — бот уже на другом сервере за тем же прокси.
    bot.on('login', () => {
      if (!alive() || !s.switching) return;
      s.switching = false;
      this.log('ok', 'Переход на другой сервер выполнен');
      s.god.schedule(GOD_AFTER_SWITCH_MS); // на новом сервере режим бога — свой
    });

    // 'spawn' приходит при первом появлении, после возрождения и при смене мира.
    bot.on('spawn', () => {
      if (!alive()) return;
      if (!s.spawned) {
        s.spawned = true;
        this.attempt = 0;
        this._setState('online');
        this.log('ok', 'В сети: бот появился в мире');
        const joinCount = this._scheduleJoinCommands(s);
        // Режим бога — после команд входа (если они переведут на другой сервер, проверка перенесётся туда).
        s.god.schedule(this.timings.joinFirst + joinCount * this.timings.joinStep + GOD_AFTER_JOIN_MS);
        this._announceBot();
      } else if (s.dead) {
        s.dead = false;
        this.log('ok', 'Бот возродился');
      }
    });

    bot.on('death', () => {
      if (!alive()) return;
      s.dead = true;
      this.log('warn', 'Бот погиб');
      // Бой для бота кончился, а «Вы вышли из режима PvP» после гибели сервер может и не написать.
      s.guard.onDeath();
      s.god.onDeath();
    });

    // Без ответа на запрос ресурспака многие серверы не пускают дальше или кикают.
    bot.on('resourcePack', () => {
      if (!alive()) return;
      try {
        bot.acceptResourcePack();
        if (!s.packNoted) {
          s.packNoted = true;
          this.log('info', 'Сервер прислал ресурспак: бот принял его (скачивать не нужно)');
        }
      } catch (err) {
        this.log('error', `Не удалось ответить на запрос ресурспака: ${describeError(err)}`);
      }
    });

    // Ссылки во всех остальных пакетах (кик, диалоги, заголовки, меню…). Ошибки сюда не выпускаем:
    // это обработчик протокола, он не должен ронять бота.
    if (bot._client && typeof bot._client.on === 'function') {
      bot._client.on('packet', (data, meta) => {
        try {
          const name = meta && meta.name;
          if (!alive() || !name || LINK_SKIP.has(name) || LINK_SKIP_RE.test(name)) return;
          const links = extractLinks(data);
          if (links.length) this._reportLinks(s, links, LINK_SOURCES[name] || `пакет ${name}`);
        } catch (_) {
          /* ignore */
        }
      });

      // Прокси (Velocity) переводит бота на другой сервер: снова фаза настройки, потом новый 'login'.
      bot._client.on('start_configuration', () => {
        if (!alive() || !s.spawned || s.stopping) return;
        s.switching = true;
        this.log('info', 'Сервер переводит бота на другой сервер…');
        s.guard.disarm('бот уходит на другой сервер');
      });

      // Название серверной программы (например, «Paper» или «Velocity»): помогает понять, кто кикает.
      bot._client.on('minecraft:brand', (brand) => {
        if (!alive()) return;
        const text = String(brand === undefined || brand === null ? '' : brand)
          .replace(/§[0-9a-fk-orx#]/gi, '')
          .trim()
          .slice(0, 100);
        if (!text || text === s.serverBrand) return;
        s.serverBrand = text;
        this.log('info', `Сервер: ${text}`);
      });
    }

    bot.on('message', (jsonMsg, position) => {
      if (!alive()) return;
      // Адрес часто спрятан в кликабельном тексте («[Нажми сюда]»), toString() его не показывает.
      const links = extractLinks(jsonMsg && jsonMsg.json !== undefined ? jsonMsg.json : String(jsonMsg));
      if (position === 'game_info') {
        // Надпись над хотбаром в чат не пишем, но ссылку из неё покажем.
        this._reportLinks(s, links, 'надпись над хотбаром');
        return;
      }
      let text = '';
      let motd = '';
      try {
        text = jsonMsg.toString();
      } catch (_) {
        /* ignore */
      }
      try {
        motd = jsonMsg.toMotd();
      } catch (_) {
        /* ignore */
      }
      if (!String(text).trim() && !String(motd).trim() && !links.length) return;
      const shown = String(text);
      // Все сообщения — в чат панели (и ответ на /near охраны каждые 5 секунд: видно, что охрана работает).
      this.emit('chat', { time: Date.now(), text, motd: motd || text, position, links });
      // В консоль — спрятанные ссылки и всё, что пришло до появления в мире (проверка при входе).
      const important = s.spawned ? links.filter((url) => !shown.includes(url)) : links;
      this._reportLinks(s, important, 'сообщение в чате');
      // Сообщения сервера (не игроков): возврат в лобби, ответы для охраны и режима бога.
      if (position !== 'chat') {
        const forced = forcedMoveReason(shown);
        if (forced) this._onForcedMove(s, forced);
        s.guard.onChat(shown);
        s.god.onChat(shown);
      }
    });

    bot.on('kicked', (reason, loggedIn) => {
      if (!alive()) return;
      s.reported = true;
      s.kicked = true;
      s.noRetry = noRetryReason(reason);
      const text = chatToText(reason) || 'причина не указана';
      s.kickText = text;
      if (s.journal) s.journal.mark(`Кик: ${text}`);
      this.log('kick', `Кик${loggedIn === false ? ' при входе' : ''}: ${text}`);
    });

    bot.on('clickHashUnknown', (type) => {
      if (!alive()) return;
      this.log('warn', `Клик в меню: не умею считать «отпечаток» компонента ${type} у предмета — сервер увидит неточный клик`);
    });

    bot.on('error', (err) => {
      if (!alive()) return;
      s.reported = true;
      if (s.loggedIn) {
        this.log('error', `Ошибка: ${describeError(err)}`);
        return;
      }
      this.log('error', `Не удалось подключиться: ${describeError(err)}`);
      // Иногда после ошибки до входа событие 'end' не приходит (например, при автоопределении версии) — закрываем сами.
      clearTimeout(s.errorTimer);
      s.errorTimer = later(() => this._forceClose(s, 'error'), 2000);
    });

    bot.once('end', (reason) => {
      if (!alive()) return;
      this._onEnd(s, reason);
    });
  }

  /** Команда боту из строки чата («#goto 10 64 -5»): выполняется здесь, на сервер не уходит. */
  _command(line) {
    this.command(line);
    return true;
  }

  /**
   * Команда боту («#…») с ожиданием результата: { ok, code, message, data } — например, для «всем по очереди»:
   * следующий бот начинает, когда этот закончил. Строки ответа — в консоль, как обычно; quiet — только ошибки
   * (автопилот заданий то и дело смотрит задания — 70 ботов залили бы консоль списками).
   */
  async command(line, { quiet = false } = {}) {
    const shown = `› ${line}`;
    if (!quiet) this.emit('chat', { time: Date.now(), text: shown, motd: shown, position: 'self' });
    try {
      return await runCommand(this.getBot(), line, (level, text) => {
        if (!quiet || level === 'error') this.log(level, text);
      });
    } catch (err) {
      this.log('error', `${line}: ${describeError(err)}`);
      return { ok: false, code: 'failed', message: describeError(err) };
    }
  }

  /** Опции createBot, чтобы бот вёл себя как обычный клиент (см. DEFAULT_COMPAT и src/bot/). */
  _compatOptions() {
    const c = this.compat;
    const out = {};
    const plugins = {};
    if (c.physics) {
      plugins.physics = createPhysicsPlugin({ tickEnd: c.tickEnd });
      plugins.actions = createActionsPlugin(); // безопасные действия: им нужна своя физика
    }
    if (c.profile) {
      plugins.settings = settingsPlugin;
      Object.assign(out, profileOptions({ viewDistance: parseInt(this.config.viewDistance, 10) || undefined }));
    }
    if (c.clicks) plugins.windowClicks = windowClicksPlugin;
    if (Object.keys(plugins).length) out.plugins = plugins;
    return out;
  }

  _setPing(ping) {
    const value = Number.isFinite(ping) ? ping : null;
    if (value === this.ping) return;
    this.ping = value;
    this.emit('ping', value);
  }

  /**
   * Сервер телепортировал бота. Изредка — нормально (вход, /home, /spawn); раз за разом подряд — бот застрял
   * (сервер не принимает его движение и возвращает назад). Сказать в консоль, пока за это не выкинули.
   */
  _countSetback(s) {
    if (s.switching || !s.spawned) return;
    const now = Date.now();
    s.setbacks = (s.setbacks || []).filter((t) => now - t < SETBACK_WINDOW_MS);
    s.setbacks.push(now);
    if (s.setbacks.length < SETBACK_LIMIT || now - (s.setbackWarnedAt || 0) < SETBACK_WARN_EVERY_MS) return;
    s.setbackWarnedAt = now;
    const pos = s.bot && s.bot.entity && s.bot.entity.position;
    const where = pos ? ` (${Math.floor(pos.x)} ${Math.floor(pos.y)} ${Math.floor(pos.z)})` : '';
    this.log('warn', `Сервер раз за разом возвращает бота на место${where}: ${s.setbacks.length} раз за ${SETBACK_WINDOW_MS / 1000} с — похоже, ` +
      'он застрял (в блоках, в другом игроке, в воде). За это MineBlaze выкидывает «за лаги» — уведи бота: /spawn или /home');
    if (s.journal) s.journal.mark(`Сервер возвращает бота на место: ${s.setbacks.length} раз за ${SETBACK_WINDOW_MS} мс`);
  }

  /** Сервер вернул бота в лобби (прокси пишет об этом в чат): это тот же кик, только без разрыва соединения. */
  _onForcedMove(s, reason) {
    const now = Date.now();
    if (now - s.forcedAt < FORCED_MOVE_REPEAT_MS) return;
    s.forcedAt = now;
    this.log('kick', `Сервер вернул бота в лобби: ${reason}`);
    if (s.journal) s.journal.mark(`Возврат в лобби: ${reason}`);
    this._saveJournal(s, `возврат в лобби: ${reason}`);
  }

  _saveJournal(s, reason) {
    if (!this.journalDir || !s || !s.journal) return null;
    try {
      const file = saveJournal(s.journal, this.journalDir, { reason, meta: s.meta });
      this.log('info', `Журнал пакетов сохранён: ${file}`);
      return file;
    } catch (err) {
      this.log('warn', `Не удалось сохранить журнал пакетов: ${describeError(err)}`);
      return null;
    }
  }

  /** Новые ссылки сессии — в консоль (кликабельно) и событием 'link'; повторы не показываем. */
  _reportLinks(s, links, source) {
    for (const url of links) {
      if (s.links.has(url) || s.links.size >= MAX_LINKS_PER_SESSION) continue;
      s.links.add(url);
      this.log('warn', `Ссылка от сервера (${source}): ${url}`);
      this.emit('link', { time: Date.now(), url, source });
    }
  }

  _loginTimeout(s, why) {
    if (this.cur !== s || s.loggedIn || s.stopping) return;
    s.reported = true;
    this.log('error', `Не удалось подключиться: ${why}`);
    this._forceClose(s, 'timeout');
  }

  /**
   * Отправить в чат сервера — по очереди, не чаще раза в timings.commandGap: команду, пришедшую сразу за
   * другой, MineBlaze молча пропускает (так терялся /spawn охраны сразу за /near).
   *   quiet  — не показывать команду в чате панели (частые команды охраны);
   *   urgent — вперёд очереди (/spawn охраны);
   *   key    — одна такая в очереди: новая заменяет ждущую;
   *   origin — кто отправил ('guard', 'god'; человек — никто): охране и режиму бога важно, чья команда;
   *   check  — () => нужна ли ещё команда, когда до неё дойдёт очередь (false — не отправлять).
   * true — отправлено или ждёт очереди; false — отправить не вышло.
   */
  _send(s, msg, { quiet = false, urgent = false, key = null, origin = null, check = null } = {}) {
    const item = { msg, quiet, key, origin, check };
    if (!s.outbox.length && !s.switching && this._gapLeft(s) === 0) return this._write(s, item);
    const same = key ? s.outbox.findIndex((x) => x.key === key) : -1;
    if (same >= 0) s.outbox.splice(same, 1);
    if (urgent) s.outbox.unshift(item);
    else s.outbox.push(item);
    this._scheduleOutbox(s);
    return true;
  }

  /** Сколько ещё ждать до следующей отправки, мс. Больше одной паузы — часы перевели назад: не ждём. */
  _gapLeft(s) {
    const left = s.lastSentAt + this.timings.commandGap - Date.now();
    return left > 0 && left <= this.timings.commandGap ? left : 0;
  }

  _scheduleOutbox(s) {
    if (s.outboxTimer || !s.outbox.length) return;
    const wait = s.switching ? OUTBOX_SWITCH_WAIT_MS : this._gapLeft(s);
    s.outboxTimer = later(() => {
      s.outboxTimer = null;
      this._drainOutbox(s);
    }, wait);
  }

  _drainOutbox(s) {
    if (this.cur !== s || s.stopping || !s.loggedIn) {
      s.outbox.length = 0;
      return;
    }
    while (s.outbox.length && !s.switching && this._gapLeft(s) === 0) {
      const item = s.outbox.shift();
      let needed = true;
      if (item.check) {
        try {
          needed = Boolean(item.check());
        } catch (_) {
          needed = false;
        }
      }
      if (needed) this._write(s, item); // не нужна (например, охрана уже выключилась) — просто пропускаем
    }
    this._scheduleOutbox(s);
  }

  /** Сама отправка: в чат сервера, строка «› /команда» в чат панели, охране и режиму бога — что ушло. */
  _write(s, { msg, quiet, origin }) {
    try {
      s.bot.chat(msg);
    } catch (err) {
      this.log('error', `Не удалось отправить сообщение: ${describeError(err)}`);
      return false;
    }
    s.lastSentAt = Date.now();
    if (msg.startsWith('/')) {
      // Ответ на команду сервер пришлёт сам, а саму команду покажем в чате (пароли скрыты).
      if (!quiet) {
        const shown = `› ${maskSecrets(msg)}`;
        this.emit('chat', { time: Date.now(), text: shown, motd: shown, position: 'self' });
      }
      // /home, /rtp, /spawn, /warp ah включают и выключают охрану — откуда бы ни пришли.
      if (s.guard) s.guard.onCommand(msg, { origin });
      if (s.god) s.god.onCommand(msg, { origin });
    }
    return true;
  }

  /** Автовход и команды после входа — по очереди с паузами. Возвращает, сколько их будет. */
  _scheduleJoinCommands(s) {
    const queue = [];
    if (this.config.loginPassword) queue.push({ cmd: `/login ${this.config.loginPassword}`, label: 'Автовход' });
    for (const cmd of parseJoinCommands(this.config.joinCommands)) queue.push({ cmd, label: 'Команда после входа' });
    if (!queue.length) return 0;

    let i = 0;
    const next = () => {
      s.joinTimer = null;
      if (this.cur !== s || s.stopping || !s.loggedIn) return;
      const { cmd, label } = queue[i];
      i += 1;
      if (this._send(s, cmd)) this.log('info', `${label}: ${maskSecrets(cmd)}`);
      if (i < queue.length) s.joinTimer = later(next, this.timings.joinStep);
    };
    s.joinTimer = later(next, this.timings.joinFirst);
    return queue.length;
  }

  _forceClose(s, reason) {
    if (this.cur !== s) return;
    try {
      if (s.bot._client && s.bot._client.socket) s.bot._client.socket.destroy();
    } catch (_) {
      /* ignore */
    }
    try {
      s.bot.end();
    } catch (_) {
      /* ignore */
    }
    this._onEnd(s, reason);
  }

  _onEnd(s, reason) {
    if (this.cur !== s) return; // сессия уже закрыта
    this._clearTimers(s);
    this.cur = null;
    this._announceBot();
    this._setPing(null);

    const manual = !this.wantRun;

    if (!manual && !s.loggedIn && !s.reported) {
      this.log('error', `Не удалось подключиться: ${describeEnd(reason)}`);
    }

    this._setState('offline');
    if (manual) {
      this.log('warn', 'Не в сети: бот остановлен');
    } else if (s.kicked) {
      this.log('warn', 'Не в сети: кик с сервера');
    } else if (s.loggedIn) {
      this.log('warn', `Не в сети: ${describeEnd(reason)}`);
    } else {
      this.log('warn', 'Не в сети');
    }

    // Обрыв после тишины: сколько байтов пришло, пока пакетов не было (0 — молчал сервер, больше — бот не разобрал).
    if (s.silence && s.journal) {
      const bytes = socketBytes(s.bot && s.bot._client);
      const during = bytes !== null && s.silence.bytes !== null ? bytes - s.silence.bytes : '?';
      s.journal.mark(
        `Соединение закрыто после ${((Date.now() - s.silence.since) / 1000).toFixed(1)} с тишины; ` +
          `за тишину пришло байт: ${during}; ${pipelineInfo(s.bot && s.bot._client)}`,
      );
      if (!manual && s.loggedIn && !s.kicked) {
        this.log('warn', during === 0
          ? 'Перед обрывом сервер ничего не присылал (молчал сам)'
          : `Перед обрывом данные от сервера приходили (${during} байт), но бот их не разобрал`);
      }
    }

    // Неожиданный разрыв после входа (кик, обрыв) — журнал в файл, чтобы можно было понять причину.
    if (!manual && (s.loggedIn || s.kicked)) {
      this._saveJournal(s, s.kickText ? `кик: ${s.kickText}` : `соединение прервано: ${describeEnd(reason)}`);
    }

    if (!manual && this.config.autoReconnect && s.noRetry) {
      this.log('warn', `Автореконнект не запущен: ${s.noRetry}`);
      this.wantRun = false;
      return;
    }
    if (!manual && this.config.autoReconnect) {
      this._scheduleReconnect();
    } else {
      this.wantRun = false;
    }
  }

  _scheduleReconnect() {
    this.attempt += 1;
    const delay = this.reconnectDelayFor(this.attempt);
    this._setState('reconnecting');
    this.log('warn', `Автореконнект: подключение через ${delay} с (попытка ${this.attempt})…`);
    this.reconnectTimer = later(() => {
      this.reconnectTimer = null;
      if (this.wantRun) this._begin();
    }, delay * 1000);
  }
}

module.exports = { BotManager };
