'use strict';

// Много ботов сразу. Боты живут в процессах (src/bot-client.js ↔ src/bot-host.js) — по botsPerProcess в
// каждом: все в одном — тики ботов начнут опаздывать (а за неровные тики античит кикает), по процессу на
// бота — слишком много памяти. Входят боты по одному, через общую очередь, с паузой startInterval: прокси
// (Velocity и т.п.) не пускает частые входы с одного IP, а лобби-антибот принимает пачку входов за атаку.
// Переподключения идут через ту же очередь. Electron здесь не нужен: fork передаётся снаружи (в main.js —
// utilityProcess.fork), поэтому всё проверяется обычными тестами (test/fleet.test.js).
//
// Бот — по нику: номер (bot) = ник маленькими буквами. События (у событий бота — bot и nick):
//   log { bot, nick, time, level, text } (bot null — сама панель или процесс); chat; state { bot, nick, state };
//   link; msa; list — список ботов поменялся; summary { total, online, … }; viewer-mode; output { worker, … }.

const EventEmitter = require('events');
const { BotClient } = require('./bot-client');

const DEFAULT_TIMINGS = Object.freeze({
  broadcastGap: 150, // «всем ботам»: между ботами — пауза, а не 70 команд в одну секунду
  turnTimeout: 15 * 60 * 1000, // «по очереди»: столько ждём одного бота (#квесты принести — минуты)
  replyMs: 3000, // команда серверу «/…» от ИИ: столько собираем ответ сервера в чате бота
});
const STOP_RE = /^#\s*(?:стоп|stop|хватит|стой)(?:\s|$)/i;
const REPLY_LINES = 6; // строк ответа сервера на «/…» — каждому боту
const errText = (err) => (err && err.message ? err.message : String(err));
const RUNNING = (state) => state && state !== 'offline';
const IN_GAME = (b) => b.state === 'online' || b.state === 'connected';

class Fleet extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {Function} opts.fork          (index) => процесс ботов (как у BotClient)
   * @param {Function} opts.initPayload   () => { authCacheDir, journalDir } — общие настройки fleet добавит сам
   * @param {object}   opts.config        живой объект настроек панели (botsPerProcess, startInterval, …)
   * @param {object}   [opts.timings]     { startGapMs, broadcastGap } — подмена задержек (для тестов)
   * @param {object}   [opts.clientTimings] задержки BotClient (для тестов)
   */
  constructor({ fork, initPayload, config, timings, clientTimings } = {}) {
    super();
    this._fork = fork;
    this._initPayload = initPayload || (() => ({}));
    this.config = config;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this._clientTimings = clientTimings;
    this.bots = new Map(); // номер → { bot, nick, username, password, worker, state }
    this.order = []; // номера ботов в порядке списка
    this.workers = []; // { client, ready, bots: Set, resume: [] }
    this.queue = []; // кто ждёт входа (номера), по порядку
    this._turn = null; // идущая очередь «по очереди» (см. runInTurn)
    this._lastAdmitAt = -Infinity;
    this._queueTimer = null;
    this._summaryPending = false;
    this._closed = false;
  }

  // ---------- список ботов ----------

  /** Боты из настроек: [{ username, password }]. Новые — в процессы, где есть место; убранные — остановить. */
  setAccounts(accounts) {
    const next = new Map();
    for (const a of accounts || []) next.set(String(a.username).toLowerCase(), a);
    const touched = new Set();
    for (const id of [...this.bots.keys()]) {
      if (next.has(id)) continue;
      const b = this.bots.get(id);
      this.bots.delete(id);
      this.queue = this.queue.filter((q) => q !== id);
      const w = this.workers[b.worker];
      if (w) {
        w.bots.delete(id);
        touched.add(b.worker);
      }
    }
    for (const [id, a] of next) {
      const b = this.bots.get(id);
      if (b) {
        if (b.username !== a.username || b.password !== (a.password || '')) touched.add(b.worker);
        Object.assign(b, { nick: a.username, username: a.username, password: a.password || '' });
        continue;
      }
      const worker = this._pickWorker();
      this.workers[worker].bots.add(id);
      touched.add(worker);
      this.bots.set(id, { bot: id, nick: a.username, username: a.username, password: a.password || '', worker, state: 'offline' });
    }
    this.order = [...next.keys()];
    for (const index of touched) {
      const w = this.workers[index];
      if (w && w.client && w.client.child) this._syncWorker(index).catch((err) => this._log('error', `Процесс ботов №${index + 1}: ${errText(err)}`));
    }
    this.emit('list', this.list());
    this._summary();
  }

  /** Боты по порядку: [{ bot, nick, state, worker, ping }]. */
  list() {
    return this.order.map((id) => {
      const b = this.bots.get(id);
      return { bot: id, nick: b.nick, state: b.state, worker: b.worker, ping: b.ping === undefined ? null : b.ping };
    });
  }

  get(id) {
    return this.bots.get(String(id || '').toLowerCase()) || null;
  }

  /** Сколько ботов в каком состоянии. */
  summary() {
    const out = { total: 0, online: 0, connected: 0, connecting: 0, queued: 0, reconnecting: 0, offline: 0 };
    for (const b of this.bots.values()) {
      out.total += 1;
      out[b.state] = (out[b.state] || 0) + 1;
    }
    out.processes = this.workers.filter((w) => w.client && w.client.child).length;
    return out;
  }

  // ---------- управление ----------

  /** Запустить ботов (по номерам; без них — всех). Входить они будут по очереди. Возвращает, скольких. */
  async start(ids = null) {
    const list = this._pick(ids).filter((b) => !RUNNING(b.state));
    const failed = new Set();
    await Promise.all([...new Set(list.map((b) => b.worker))].map((index) => this._ensureWorker(index).catch((err) => {
      failed.add(index);
      this._log('error', `Процесс ботов №${index + 1} не запустился: ${errText(err)}`);
    })));
    let started = 0;
    // По одному и по порядку: в каком порядке боты попросятся в очередь входа, в таком и войдут.
    for (const b of list) {
      const w = this.workers[b.worker];
      if (failed.has(b.worker) || !w || !w.client || !this.bots.has(b.bot)) continue;
      try {
        if (await w.client.request('start', { bot: b.bot })) started += 1;
      } catch (err) {
        this._log('error', `Не запустился: ${errText(err)}`, b.bot);
      }
    }
    return started;
  }

  /** Остановить ботов (по номерам; без них — всех). Возвращает, скольких. */
  async stop(ids = null) {
    if (!ids) this.cancelTurn(); // «Стоп всех» останавливает и очередь
    const list = this._pick(ids).filter((b) => RUNNING(b.state));
    const stopping = new Set(list.map((b) => b.bot));
    this.queue = this.queue.filter((id) => !stopping.has(id));
    await Promise.all(list.map((b) => {
      const w = this.workers[b.worker];
      if (!w || !w.client || !w.client.child) return null;
      return w.client.request('stop', { bot: b.bot }).catch((err) => this._log('error', `Не остановился: ${errText(err)}`, b.bot));
    }));
    return list.length;
  }

  /** Сообщение или команда одному боту. */
  async say(id, text) {
    const b = this.get(id);
    if (!b) return false;
    const w = this.workers[b.worker];
    if (!w || !w.client || !w.client.child) return false;
    return Boolean(await w.client.request('say', { bot: b.bot, text }));
  }

  /**
   * Команда всем ботам в сети — по очереди, с паузой. Только команды («/…» серверу и «#…» боту): одно и то же
   * сообщение от 70 ботов в общий чат — это спам. Возвращает { targets } сразу, рассылка идёт дальше сама.
   */
  broadcast(text) {
    const msg = String(text || '').trim();
    if (!/^[/#]/.test(msg)) return { targets: 0, refused: 'всем ботам — только команды: «/…» серверу или «#…» боту' };
    if (STOP_RE.test(msg)) this.cancelTurn(); // «#стоп» всем — и очередь тоже
    const targets = this.order.map((id) => this.bots.get(id)).filter((b) => b.state === 'online' || b.state === 'connected');
    (async () => {
      for (const [i, b] of targets.entries()) {
        if (this._closed) return;
        if (i) await new Promise((r) => later(r, this.timings.broadcastGap));
        if (b.state !== 'online' && b.state !== 'connected') continue;
        try {
          await this.say(b.bot, msg);
        } catch (err) {
          this._log('error', `Не отправилось: ${errText(err)}`, b.bot);
        }
      }
    })();
    return { targets: targets.length };
  }

  /**
   * Команда боту «#…» всем ботам в сети по очереди: следующий начинает, когда предыдущий закончил (together —
   * сколько сразу). Для дел у одного склада и NPC (#квесты принести): 70 ботов разом — толпа и драка за сундуки.
   * Возвращает { targets } сразу, очередь идёт дальше сама; остановить — cancelTurn() («#стоп» всем, «Стоп всех»).
   */
  runInTurn(text, { together = 1 } = {}) {
    const line = String(text || '').trim();
    if (!line.startsWith('#')) return { targets: 0, refused: 'по очереди — только команды боту «#…» (у «/…» нет конца, который можно ждать)' };
    if (this._turn) {
      return { targets: 0, refused: `уже идёт очередь «${this._turn.line}» (${this._turn.done} из ${this._turn.total}); остановить — «#стоп» всем` };
    }
    const targets = this.order.map((id) => this.bots.get(id)).filter((b) => b.state === 'online' || b.state === 'connected');
    if (!targets.length) return { targets: 0 };
    const turn = { line, total: targets.length, done: 0, ok: 0, failed: [], cancelled: false };
    this._turn = turn;
    this._log('info', `По очереди, ботов: ${targets.length} — ${line}`);
    const queue = targets.slice();
    const lane = async () => {
      while (queue.length && !turn.cancelled && !this._closed) {
        const b = queue.shift();
        const w = this.workers[b.worker];
        if (!this.bots.has(b.bot) || (b.state !== 'online' && b.state !== 'connected') || !w || !w.client || !w.client.child) {
          turn.done += 1;
          turn.failed.push(`${b.nick} (не в сети)`);
          continue;
        }
        this._log('info', `По очереди: ${turn.done + 1} из ${turn.total} — начинаю`, b.bot);
        try {
          const r = await w.client.request('command', { bot: b.bot, line }, { timeoutMs: this.timings.turnTimeout });
          if (r && r.ok) turn.ok += 1;
          else turn.failed.push(b.nick);
        } catch (err) {
          turn.failed.push(b.nick);
          this._log('error', `По очереди: ${errText(err)}`, b.bot);
        }
        turn.done += 1;
      }
    };
    Promise.all(Array.from({ length: Math.max(1, together) }, lane)).then(() => {
      if (this._turn === turn) this._turn = null;
      const failed = turn.failed.length ? `; не вышло: ${turn.failed.slice(0, 10).join(', ')}${turn.failed.length > 10 ? ` и ещё ${turn.failed.length - 10}` : ''}` : '';
      this._log(turn.failed.length || turn.cancelled ? 'warn' : 'ok',
        `По очереди «${line}»: ${turn.cancelled ? 'остановлено' : 'готово'} — без ошибок ${turn.ok} из ${turn.total}${failed}`);
      this.emit('turn', { line, total: turn.total, ok: turn.ok, failed: turn.failed.slice(), cancelled: turn.cancelled });
    });
    return { targets: targets.length };
  }

  /**
   * Команда ботам с ответом каждого — для ИИ (src/ai.js). «#…» — по одному: следующий начинает, когда закончил
   * предыдущий (как «по очереди»); «/…» серверу — всем почти сразу (пауза broadcastGap), ответ — сообщения
   * сервера в чате бота за replyMs после отправки (чат игроков не берём). ids — каким ботам (null — всем в сети).
   * signal (AbortSignal) сработал — новые боты не начинают, а тем, кто выполняет «#…», уходит «#стоп».
   * → [{ bot, nick, ok, code, message: [строки] }] в порядке списка ботов.
   */
  async commandEach(ids, text, { signal = null } = {}) {
    const line = String(text || '').trim();
    if (!/^[/#]/.test(line)) throw new Error('только команды: «/…» серверу или «#…» боту');
    const picked = ids ? this._pick(ids) : this.order.map((id) => this.bots.get(id)).filter(IN_GAME);
    const result = (b, ok, code, message) => ({ bot: b.bot, nick: b.nick, ok, code: code || null, message: [].concat(message || []).map(String) });
    const stopped = () => Boolean(signal && signal.aborted);
    if (line.startsWith('/')) return this._commandServer(picked, line, result, stopped, signal);
    const out = [];
    for (const b of picked) {
      const { data, ...r } = await this.commandOne(b.bot, line, { signal }); // данные ИИ не нужны — только ответ
      out.push(r);
    }
    return out;
  }

  /**
   * Команда «#…» одному боту с ответом: { bot, nick, ok, code, message: [строки], data } — data как у команды
   * (для автопилота заданий). Не в сети — сразу { ok: false, code: 'offline' }. signal сработал — боту «#стоп».
   */
  async commandOne(id, text, { signal = null, quiet = false } = {}) {
    const line = String(text || '').trim();
    if (!line.startsWith('#')) throw new Error('одному боту с ответом — только команды «#…»');
    const b = this.get(id);
    if (!b) return { bot: String(id || '').toLowerCase(), nick: String(id || ''), ok: false, code: 'unknown', message: ['нет такого бота'], data: null };
    const result = (ok, code, message, data = null) => ({ bot: b.bot, nick: b.nick, ok, code: code || null, message: [].concat(message || []).map(String), data });
    if (signal && signal.aborted) return result(false, 'stopped', 'не начато: остановлено');
    const w = this.workers[b.worker];
    if (!this.bots.has(b.bot) || !IN_GAME(b) || !w || !w.client || !w.client.child) return result(false, 'offline', 'бот не в сети');
    const onAbort = () => this.say(b.bot, '#стоп').catch(() => {});
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      const r = await w.client.request('command', { bot: b.bot, line, quiet: Boolean(quiet) }, { timeoutMs: this.timings.turnTimeout });
      return result(Boolean(r && r.ok), r && r.code, r && r.message, (r && r.data) || null);
    } catch (err) {
      return result(false, 'failed', errText(err));
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  /** Идёт ли «по очереди» (автопилот заданий в это время не трогает ботов). */
  get turnRunning() {
    return Boolean(this._turn);
  }

  async _commandServer(picked, line, result, stopped, signal) {
    const windows = new Map(); // номер бота → строки ответа сервера
    const onChat = (m) => {
      const lines = m && windows.get(m.bot);
      if (lines && m.position !== 'chat' && m.position !== 'self' && lines.length < REPLY_LINES) lines.push(String(m.text || ''));
    };
    this.on('chat', onChat);
    try {
      const sends = [];
      for (const [i, b] of picked.entries()) {
        if (stopped()) break;
        if (i) await new Promise((r) => later(r, this.timings.broadcastGap));
        if (!IN_GAME(b)) continue;
        windows.set(b.bot, []);
        sends.push(this.say(b.bot, line).then((ok) => ({ b, ok }), (err) => ({ b, ok: false, err })));
      }
      const sent = new Map((await Promise.all(sends)).map((s) => [s.b.bot, s]));
      if (sent.size) {
        await new Promise((resolve) => {
          const t = later(resolve, this.timings.replyMs);
          if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
        });
      }
      return picked.map((b) => {
        const s = sent.get(b.bot);
        if (!s) return result(b, false, stopped() ? 'stopped' : 'offline', stopped() ? 'не отправлено: остановлено' : 'бот не в сети');
        if (!s.ok) return result(b, false, 'failed', `не отправилось${s.err ? `: ${errText(s.err)}` : ''}`);
        const lines = windows.get(b.bot);
        return result(b, true, null, lines.length ? lines : 'отправлено; сервер ничего не ответил');
      });
    } finally {
      this.off('chat', onChat);
    }
  }

  /** Остановить очередь «по очереди»: бот, который уже начал, доделает своё, новые не начнут. */
  cancelTurn() {
    if (!this._turn || this._turn.cancelled) return false;
    this._turn.cancelled = true;
    this._log('warn', `По очереди «${this._turn.line}»: останавливаю — новые боты не начнут`);
    return true;
  }

  /** Автореконнект — у всех ботов (в консоль — одна строка). */
  async setAutoReconnect(on) {
    this.config.autoReconnect = Boolean(on);
    this._log('info', `Автоматический реконнект: ${on ? 'ON' : 'OFF'}`);
    await Promise.all(this._running().map((w) => w.client.request('autoReconnect', { on: Boolean(on) }).catch(() => {})));
    return this.config.autoReconnect;
  }

  /** Настройки поменялись — всем запущенным процессам (боты читают их вживую). */
  pushConfig() {
    for (const w of this._running()) w.client.setConfig(this._sharedConfig());
  }

  /** Процесс бота (BotClient) — для экрана бота и проверок. */
  clientOf(id) {
    const b = this.get(id);
    const w = b ? this.workers[b.worker] : null;
    return w && w.client && w.client.child ? w.client : null;
  }

  /** Запустить процесс бота (если ещё нет) — например, чтобы открыть экран до старта. */
  async ensureClientOf(id) {
    const b = this.get(id);
    if (!b) throw new Error(`бота ${id} нет в списке`);
    await this._ensureWorker(b.worker);
    return this.workers[b.worker].client;
  }

  /** Выход из программы: все боты выходят с сервера, процессы завершаются. */
  async shutdown() {
    this._closed = true;
    clearTimeout(this._queueTimer);
    this._queueTimer = null;
    this.queue = [];
    await Promise.all(this.workers.map((w) => (w.client ? w.client.shutdown().catch(() => {}) : null)));
  }

  // ---------- очередь входа ----------

  _gapMs() {
    if (this.timings.startGapMs !== undefined) return this.timings.startGapMs;
    return Math.max(1, Number(this.config.startInterval) || 5) * 1000;
  }

  _enqueue(id) {
    const b = this.bots.get(id);
    if (!b || this._closed) return;
    if (!this.queue.includes(id)) this.queue.push(id);
    this._pump();
  }

  /** Пустить следующего, если пауза после прошлого входа прошла; иначе — подождать её. */
  _pump() {
    if (this._queueTimer || this._closed) return;
    while (this.queue.length) {
      const id = this.queue[0];
      const b = this.bots.get(id);
      if (!b || b.state !== 'queued') {
        this.queue.shift(); // остановили, убрали из списка или уже входит
        continue;
      }
      const gap = this._gapMs();
      const wait = this._lastAdmitAt + gap - Date.now();
      if (wait > 0 && wait <= gap) {
        this._queueTimer = later(() => {
          this._queueTimer = null;
          this._pump();
        }, wait);
        return;
      }
      this.queue.shift();
      this._lastAdmitAt = Date.now();
      const w = this.workers[b.worker];
      if (w && w.client && w.client.child) {
        w.client.request('admit', { bot: id }).catch((err) => this._log('error', `Не удалось начать вход: ${errText(err)}`, id));
      }
    }
  }

  // ---------- процессы ----------

  _pickWorker() {
    const per = Math.max(1, Number(this.config.botsPerProcess) || 10);
    let index = this.workers.findIndex((w) => w.bots.size < per);
    if (index < 0) {
      index = this.workers.length;
      this.workers.push({ client: null, ready: null, bots: new Set(), resume: [] });
    }
    return index;
  }

  _pick(ids) {
    const wanted = ids ? ids.map((id) => String(id).toLowerCase()) : this.order;
    return wanted.map((id) => this.bots.get(id)).filter(Boolean);
  }

  _running() {
    return this.workers.filter((w) => w.client && w.client.child);
  }

  _sharedConfig() {
    // Пароли всех ботов процессам не нужны (у каждого — свой), ключ и настройки ИИ — тоже.
    const {
      accounts, aiKey, aiBaseUrl, aiModel, aiProvider, ollamaUrl, ollamaModel, ollamaGpu,
      questAuto, questStorage, questRewards, questMobHomes, questTogether, questPause, questFarm, questPen, questMine, ...rest
    } = this.config;
    // Ники всех ботов панели: охрана каждого считает остальных своими (у одного склада их много).
    rest.fleetNicks = this.order.map((id) => this.bots.get(id).username).join('\n');
    return rest;
  }

  _ensureWorker(index) {
    const w = this.workers[index];
    if (!w) return Promise.reject(new Error(`нет процесса ботов №${index + 1}`));
    if (!w.client) w.client = this._makeClient(index);
    if (w.client.child && w.ready) return w.ready;
    const ready = w.client.start().then(() => this._syncWorker(index));
    w.ready = ready;
    ready.catch(() => {
      if (w.ready === ready) w.ready = null;
    });
    return ready;
  }

  _syncWorker(index) {
    const w = this.workers[index];
    const list = [...w.bots].map((id) => this.bots.get(id)).filter(Boolean)
      .map((b) => ({ bot: b.bot, username: b.username, password: b.password }));
    return w.client.request('bots', { list });
  }

  _makeClient(index) {
    const client = new BotClient({
      fork: () => this._fork(index),
      initPayload: () => ({ ...this._initPayload(), config: this._sharedConfig() }),
      timings: this._clientTimings,
    });
    client.on('log', (e) => {
      if (e && e.bot) this._emitBot('log', e);
      else this.emit('log', { ...e, bot: null, nick: null });
    });
    client.on('chat', (m) => this._emitBot('chat', m));
    client.on('state', (p) => this._onState(p && p.bot, p && p.state));
    client.on('link', (l) => this._emitBot('link', l));
    client.on('msa', (d) => this._emitBot('msa', d));
    client.on('ping', (p) => {
      const b = p && this.bots.get(p.bot);
      if (!b) return;
      b.ping = Number.isFinite(p.ping) ? p.ping : null;
      this.emit('ping', { bot: b.bot, nick: b.nick, ping: b.ping });
    });
    client.on('want-connect', (p) => this._enqueue(p && p.bot));
    client.on('viewer-mode', (mode) => this.emit('viewer-mode', mode));
    client.on('output', (o) => this.emit('output', { worker: index, ...o }));
    client.on('crash', ({ code, restarting }) => this._onCrash(index, code, restarting));
    client.on('restarted', () => this._onRestarted(index));
    return client;
  }

  _onState(id, state) {
    const b = this.bots.get(id);
    if (!b || !state || b.state === state) return;
    b.state = state;
    if (state === 'offline') b.ping = null;
    this.emit('state', { bot: id, nick: b.nick, state });
    this._summary();
  }

  _onCrash(index, code, restarting) {
    const w = this.workers[index];
    w.ready = null;
    const affected = [...w.bots].map((id) => this.bots.get(id)).filter((b) => b && RUNNING(b.state));
    w.resume = affected.map((b) => b.bot);
    for (const b of affected) this._onState(b.bot, 'offline');
    this._log('error', `Процесс ботов №${index + 1} неожиданно завершился (код ${code}), в сети было ботов: ${affected.length}` +
      (restarting ? ' — перезапускаю…' : ' — слишком много сбоев подряд, их боты остановлены (запусти их снова)'));
    this.emit('crash', { worker: index, code, restarting, bots: w.resume.slice() });
  }

  _onRestarted(index) {
    const w = this.workers[index];
    const resume = w.resume;
    w.resume = [];
    const ready = this._syncWorker(index);
    w.ready = ready;
    ready.catch((err) => this._log('error', `Процесс ботов №${index + 1}: ${errText(err)}`));
    this._log('ok', `Процесс ботов №${index + 1} перезапущен`);
    // Боты работали и включён автореконнект — продолжаем, как после обрыва связи (через очередь входа).
    if (this.config.autoReconnect && resume.length) ready.then(() => this.start(resume)).catch(() => {});
  }

  _emitBot(name, payload) {
    const b = payload && this.bots.get(payload.bot);
    if (!b) return; // бота уже убрали из списка
    this.emit(name, { ...payload, nick: b.nick });
  }

  _log(level, text, bot = null) {
    const b = bot ? this.bots.get(bot) : null;
    this.emit('log', { bot: b ? b.bot : null, nick: b ? b.nick : null, time: Date.now(), level, text });
  }

  _summary() {
    if (this._summaryPending) return;
    this._summaryPending = true;
    setImmediate(() => {
      this._summaryPending = false;
      this.emit('summary', this.summary());
    });
  }
}

function later(fn, ms) {
  const t = setTimeout(fn, ms);
  if (t && typeof t.unref === 'function') t.unref();
  return t;
}

module.exports = { Fleet };
