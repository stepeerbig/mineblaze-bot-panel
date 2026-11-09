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
//   link; msa; list — список ботов поменялся; summary { total, online, … }; viewer-mode; viewer-xray; output { worker, … }.

const EventEmitter = require('events');
const { BotClient } = require('./bot-client');
const { maskSecrets } = require('./chat-utils');

const DEFAULT_TIMINGS = Object.freeze({
  broadcastGap: 150, // «всем ботам»: между ботами — пауза, а не 70 команд в одну секунду
  turnTimeout: 15 * 60 * 1000, // «по очереди»: столько ждём одного бота (#квесты принести — минуты)
  turnGap: 2000, // «по очереди» сообщение или «/…»: конца не дождаться — следующий бот через столько
  replyMs: 3000, // команда серверу «/…» от ИИ: столько собираем ответ сервера в чате бота
  // Бот ждёт проверку «я не робот» (её проходит человек по ссылке) — столько новых в очередь входа не пускаем:
  // иначе ссылки сыплются пачкой, и сервер не дожидается проверки у остальных.
  captchaHoldMs: 90 * 1000,
  // Сервер заблокировал IP («заблокирован на 10 минут»): новые входы ждут конца блокировки и ещё столько.
  ipBlockExtraMs: 15 * 1000,
  // Столько входов подряд повисли (сервер принял подключение и не пускает) — сервер перестал пускать новых с нашего
  // IP (на MineBlaze 8.11: после 16 в сети повисли 21 подряд). Очередь не долбит его, а ждёт и пробует одного бота:
  // повис — ждёт вдвое дольше (до hungMaxHoldMs), вошёл — дальше как обычно.
  hungStreak: 3,
  hungHoldMs: 2 * 60 * 1000,
  hungMaxHoldMs: 10 * 60 * 1000,
});
const STOP_RE = /^#\s*(?:стоп|stop|хватит|стой)(?:\s|$)/i;
const REPLY_LINES = 6; // строк ответа сервера на «/…» — каждому боту
const errText = (err) => (err && err.message ? err.message : String(err));
const RUNNING = (state) => state && state !== 'offline';
const IN_GAME = (b) => b.state === 'online' || b.state === 'connected';
const waitText = (ms) => (ms < 60 * 1000 ? `${Math.max(1, Math.round(ms / 1000))} с` : `${Math.round(ms / 60000)} мин`);

class Fleet extends EventEmitter {
  constructor({ fork, initPayload, config, timings, clientTimings, captchaService } = {}) {
    super(); // <--- ОБЯЗАТЕЛЬНО ПЕРВОЙ СТРОКОЙ!
    
    this._fork = fork; 
    this._initPayload = initPayload || (() => ({}));
    this.config = config;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this._clientTimings = clientTimings;
    
    this.captchaService = captchaService; // <--- НАШ СЕРВИС КАПЧИ
    
    this.bots = new Map(); 
    this.order = []; 
    this.workers = []; 
    this.queue = []; 
    this._turn = null; 
    this._captcha = new Map(); 
    this._lastAdmitAt = -Infinity;
    this._ipBlockUntil = 0; 
    this._batch = null; 
    this._hung = { streak: 0, holdMs: 0, holdUntil: 0, probe: null };
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

    // === ЛОГИКА РОТАЦИИ ПРОКСИ ===
    const rawProxies = String(this.config.proxyPool || '').split('\n').map(l => l.trim()).filter(Boolean);
    const proxies = rawProxies.map(url => {
      try {
        const u = new URL(url);
        return { host: u.hostname, port: parseInt(u.port, 10) || 1080, username: u.username, password: u.password };
      } catch (e) { 
        return null; 
      }
    }).filter(Boolean);
    const maxPerProxy = parseInt(this.config.botsPerProxy, 10) || 15;
    
    let proxyIndex = 0;
    let proxyCount = 0;
    // =============================

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

      // === ВЫДАЧА ПРОКСИ ===
      let proxy = null;
      if (proxies.length > 0) {
        if (proxyCount >= maxPerProxy) {
          proxyIndex = (proxyIndex + 1) % proxies.length;
          proxyCount = 0;
        }
        proxy = proxies[proxyIndex];
        proxyCount++;
      }
      // =====================

      this.bots.set(id, { 
        bot: id, 
        nick: a.username, 
        username: a.username, 
        password: a.password || '', 
        worker, 
        state: 'offline',
        proxy: proxy // Сохраняем прокси за ботом
      });
    }
    
    this.order = [...next.keys()];
    for (const index of touched) {
      const w = this.workers[index];
      if (w && w.client && w.client.child) this._syncWorker(index).catch((err) => this._log('error', `Процесс ботов №${index + 1}: ${errText(err)}`));
    }
    this.emit('list', this.list());
    this._summary();
  
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
    const startedIds = [];
    for (const b of list) b.lastProblem = '';
    // По одному и по порядку: в каком порядке боты попросятся в очередь входа, в таком и войдут.
    for (const b of list) {
      const w = this.workers[b.worker];
      if (failed.has(b.worker) || !w || !w.client || !this.bots.has(b.bot)) continue;
      try {
        if (await w.client.request('start', { bot: b.bot })) {
          started += 1;
          startedIds.push(b.bot);
        }
      } catch (err) {
        this._log('error', `Не запустился: ${errText(err)}`, b.bot);
      }
    }
    if (startedIds.length > 1) {
      const ids = new Set(this._batch ? this._batch.ids : []);
      for (const id of startedIds) ids.add(id);
      this._batch = { ids, stopped: this._batch ? this._batch.stopped : 0 };
      this._checkBatch();
    }
    return started;
  }

  /** Остановить ботов (по номерам; без них — всех). Возвращает, скольких. */
  async stop(ids = null) {
    if (!ids) this.cancelTurn(); // «Стоп всех» останавливает и очередь
    // Остановленных итог входа не ждёт (человек сам их остановил), но скажет, сколько их.
    if (!ids) this._batch = null;
    else if (this._batch) {
      for (const id of ids) if (this._batch.ids.delete(String(id).toLowerCase())) this._batch.stopped += 1;
    }
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
   * Команда всем ботам в сети — почти сразу (пауза broadcastGap). Только команды («/…» серверу и «#…» боту): одно
   * и то же сообщение от 70 ботов за пару секунд — это спам; сообщение — «по очереди» (runInTurn).
   * Возвращает { targets } сразу, рассылка идёт дальше сама.
   */
  broadcast(text, { ids = null, who = 'всем' } = {}) {
    const msg = String(text || '').trim();
    if (!/^[/#]/.test(msg)) return { targets: 0, refused: `${who} сразу — только команды «/…» серверу или «#…» боту; обычное сообщение — выбери «${who} по очереди»` };
    if (STOP_RE.test(msg)) this.cancelTurn(); // «#стоп» всем — и очередь тоже
    const targets = this._inGame(ids);
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
   * Всем ботам в сети по очереди (together — сколько сразу). Команда боту «#…» — следующий начинает, когда
   * предыдущий закончил: для дел у одного склада и NPC (#квесты принести) 70 ботов разом — толпа и драка за
   * сундуки. Сообщение или «/…» серверу — конца не дождаться: следующий бот через turnGap (не 70 разом).
   * Возвращает { targets } сразу, очередь идёт дальше сама; остановить — cancelTurn() («#стоп» всем, «Стоп всех»).
   */
  runInTurn(text, { together = 1, ids = null } = {}) {
    const line = String(text || '').trim();
    if (!line) return { targets: 0 };
    const command = line.startsWith('#');
    const shown = maskSecrets(line); // «/reg пароль» по очереди — пароль в консоль не пишем
    if (this._turn) {
      return { targets: 0, refused: `уже идёт очередь «${this._turn.shown}» (${this._turn.done} из ${this._turn.total}); остановить — «#стоп» всем` };
    }
    const targets = this._inGame(ids);
    if (!targets.length) return { targets: 0 };
    const turn = { line, shown, total: targets.length, done: 0, ok: 0, failed: [], cancelled: false };
    this._turn = turn;
    this._log('info', `По очереди, ботов: ${targets.length} — ${shown}${command ? '' : ` (друг за другом через ${this.timings.turnGap / 1000} с)`}`);
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
        if (!command) {
          // Сообщение или «/…»: отправить — и через паузу следующий.
          try {
            if (await this.say(b.bot, line)) turn.ok += 1;
            else turn.failed.push(b.nick);
          } catch (err) {
            turn.failed.push(b.nick);
            this._log('error', `По очереди: ${errText(err)}`, b.bot);
          }
          turn.done += 1;
          if (queue.length && !turn.cancelled && !this._closed) await new Promise((r) => later(r, this.timings.turnGap));
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
        `По очереди «${shown}»: ${turn.cancelled ? 'остановлено' : 'готово'} — ${command ? 'без ошибок' : 'отправили'} ${turn.ok} из ${turn.total}${failed}`);
      this.emit('turn', { line: shown, total: turn.total, ok: turn.ok, failed: turn.failed.slice(), cancelled: turn.cancelled });
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
    this._log('warn', `По очереди «${this._turn.shown}»: останавливаю — новые боты не начнут`);
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
      const hold = this._holdLeft();
      if (hold > 0) {
        this._queueTimer = later(() => {
          this._queueTimer = null;
          this._pump();
        }, hold);
        return;
      }
      // Сервер перестал пускать: пробный вход ещё идёт — ждём, чем кончится (_onState / _onLoginHung снова позовут).
      if (this._hung.holdMs && this._hung.probe) return;
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
      if (this._hung.holdMs) this._hung.probe = id;
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

  /** Боты в игре по порядку списка; ids — только эти (группа), без них — все. */
  _inGame(ids = null) {
    const only = ids ? new Set(ids.map((id) => String(id).toLowerCase())) : null;
    return this.order.map((id) => this.bots.get(id)).filter((b) => IN_GAME(b) && (!only || only.has(b.bot)));
  }

  _pick(ids) {
    const wanted = ids ? ids.map((id) => String(id).toLowerCase()) : this.order;
    return wanted.map((id) => this.bots.get(id)).filter(Boolean);
  }

  _running() {
    return this.workers.filter((w) => w.client && w.client.child);
  }

  _sharedConfig() {
    // Пароли всех ботов процессам не нужны (у каждого — свой), ключ и настройки ИИ — тоже. «Дом склада» — нужен:
    // это общий дом, где #добудь берёт кирку.
    const {
      accounts, aiKey, aiBaseUrl, aiModel, aiProvider, ollamaUrl, ollamaModel, ollamaGpu,
      questAuto, questRewards, questMobHomes, questTogether, questPause, questFarm, questPen, questMine, ...rest
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
      .map((b) => ({ bot: b.bot, username: b.username, password: b.password,  proxy: b.proxy }));
    return w.client.request('bots', { list });
  }

   _makeClient(index) {
    const client = new BotClient({
      // ВОТ ЭТИ ТРИ СТРОКИ БЫЛИ УДАЛЕНЫ ИЗ-ЗА КОММЕНТАРИЯ // ...
      fork: () => this._fork(index),
      initPayload: () => ({ ...this._initPayload(), config: this._sharedConfig() }),
      timings: this._clientTimings,
    });

    client.on('log', (e) => {
      if (e && e.bot) {
        const b = this.bots.get(e.bot);
        if (b && (e.level === 'error' || e.level === 'kick')) b.lastProblem = String(e.text || '');
      }
      if (e && e.bot) this._emitBot('log', e);
      else this.emit('log', { ...e, bot: null, nick: null });
    });
    client.on('chat', (m) => this._emitBot('chat', m));
    client.on('state', (p) => this._onState(p && p.bot, p && p.state));
    client.on('link', (l) => this._emitBot('link', l));
    client.on('ready', (p) => this._onReady(p && p.bot));
    client.on('captcha', (c) => this._onCaptcha(c));
    client.on('captcha-done', (c) => this._onCaptchaDone(c && c.bot));
    client.on('ip-block', (p) => this._onIpBlock(p));
    client.on('login-hung', (p) => this._onLoginHung(p));
    client.on('msa', (d) => this._emitBot('msa', d));
    client.on('ping', (p) => {
      const b = p && this.bots.get(p.bot);
      if (!b) return;
      b.ping = Number.isFinite(p.ping) ? p.ping : null;
      this.emit('ping', { bot: b.bot, nick: b.nick, ping: b.ping });
    });
    client.on('want-connect', (p) => this._enqueue(p && p.bot));
    client.on('viewer-mode', (mode) => this.emit('viewer-mode', mode));
    client.on('viewer-xray', (settings) => this.emit('viewer-xray', settings));
    client.on('output', (o) => this.emit('output', { worker: index, ...o }));
    client.on('crash', ({ code, restarting }) => this._onCrash(index, code, restarting));
    client.on('restarted', () => this._onRestarted(index));

    // === ОТКЛЮЧЕНО АВТОПРОХОЖДЕНИЕ (РУЧНОЙ РЕЖИМ) ===
    client.on('solve-captcha', async (p) => {
      // Ничего не делаем, капчу обрабатываем вручную
    });

    return client;
  }
  /** Бот ждёт проверку «я не робот»: новых в очередь входа не пускаем, пока её не пройдут (не дольше captchaHoldMs). */
  _onCaptcha(c) {
    const b = c && this.bots.get(c.bot);
    if (!b) return;
    this._captcha.set(b.bot, { since: Date.now(), url: c.url });
    this._emitBot('captcha', c);
    if (this.queue.length) {
      this._log('warn', `Очередь входа ждёт: ${b.nick} проходит проверку «я не робот» — открой его ссылку в консоли и нажми «Да» ` +
        `(дольше ${Math.round(this.timings.captchaHoldMs / 1000)} с ждать не буду)`);
    }
  }

  _onCaptchaDone(id) {
    if (!id || !this._captcha.delete(id)) return;
    this._emitBot('captcha-done', { bot: id });
    clearTimeout(this._queueTimer); // ждали проверку — пустить следующего, как только можно
    this._queueTimer = null;
    this._pump();
  }

  /** Кик «IP адрес заблокирован на N минут»: IP у всех ботов общий — новые входы ждут, пока блокировка не кончится. */
  _onIpBlock(p) {
    const b = p && this.bots.get(p.bot);
    const until = Number(p && p.until) || 0;
    if (!b || until <= this._ipBlockUntil) return;
    const fresh = this._ipBlockUntil <= Date.now();
    this._ipBlockUntil = until;
    if (fresh) {
      const at = new Date(until + this.timings.ipBlockExtraMs);
      const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      this._log('warn', `Сервер заблокировал наш IP на ${p.minutes} мин (кик ${b.nick}): входить сейчас бессмысленно — ` +
        `каждая попытка продлевает блокировку. Новые входы ждут до ${hhmm}; боты в сети остаются в игре`);
    }
    clearTimeout(this._queueTimer); // очередь пересчитает, сколько ждать
    this._queueTimer = null;
    this._pump();
  }

  /** Сколько ещё очередь входа стоит: проверка «я не робот» или блокировка IP (0 — не стоит). */
  _holdLeft() {
    const ip = this._ipBlockUntil ? this._ipBlockUntil + this.timings.ipBlockExtraMs - Date.now() : 0;
    const hung = this._hung.holdMs && !this._hung.probe ? this._hung.holdUntil - Date.now() : 0;
    return Math.max(this._captchaHoldLeft(), ip, hung, 0);
  }

  /** Вход повис (BotManager, 'login-hung'). Несколько подряд — сервер перестал пускать: очередь ждёт и пробует одного. */
  _onLoginHung(p) {
    const b = p && this.bots.get(p.bot);
    if (!b) return;
    const h = this._hung;
    h.streak += 1;
    const online = this._inGame().length;
    if (h.probe === b.bot) {
      h.probe = null;
      h.holdMs = Math.min(h.holdMs * 2, this.timings.hungMaxHoldMs);
      h.holdUntil = Date.now() + h.holdMs;
      this._log('warn', `Пробный вход (${b.nick}) тоже повис — сервер всё ещё не пускает новых (в сети ${online}); ` +
        `следующая проба через ${waitText(h.holdMs)}`);
    } else if (!h.holdMs && h.streak >= this.timings.hungStreak) {
      h.holdMs = this.timings.hungHoldMs;
      h.holdUntil = Date.now() + h.holdMs;
      this._log('warn', `Сервер перестал пускать новых ботов: ${h.streak} входа подряд повисли (принимает подключение и ` +
        `молчит), в сети ${online}. Похоже на предел ботов с одного IP у MineBlaze — долбить его входами не буду: очередь ` +
        `ждёт ${waitText(h.holdMs)} и пробует одного; пустит — пойдёт дальше. Боты в сети остаются в игре`);
    }
    clearTimeout(this._queueTimer);
    this._queueTimer = null;
    this._pump();
  }

  /** Бот вошёл (новый вход): повисшие — не подряд; если сервер «не пускал» — снова пускает. */
  _onLoggedIn(b) {
    const h = this._hung;
    const was = h.holdMs > 0;
    this._hung = { streak: 0, holdMs: 0, holdUntil: 0, probe: null };
    if (was) {
      this._log('ok', `Сервер снова пускает: ${b.nick} вошёл (в сети ${this._inGame().length}) — очередь входа идёт дальше`);
      clearTimeout(this._queueTimer);
      this._queueTimer = null;
      this._pump();
    }
  }

  /** Все из последнего «Старт» вошли или окончательно не вошли — итог одной строкой (кто не вошёл и почему). */
  _checkBatch() {
    const batch = this._batch;
    if (!batch) return;
    const list = [...batch.ids].map((id) => this.bots.get(id)).filter(Boolean);
    if (list.some((b) => b.state === 'queued' || b.state === 'connecting' || b.state === 'reconnecting')) return;
    this._batch = null;
    const inGame = list.filter(IN_GAME);
    const out = list.filter((b) => !IN_GAME(b));
    const stopped = batch.stopped ? `; остановлены вручную: ${batch.stopped}` : '';
    if (!out.length) {
      this._log('ok', batch.stopped
        ? `Вход окончен: в сети ${inGame.length} из ${list.length + batch.stopped}${stopped}`
        : `Вход окончен: в сети все ${list.length} из ${list.length}`);
      return;
    }
    const shown = out.slice(0, 8).map((b) => `${b.nick}${b.lastProblem ? ` (${b.lastProblem.replace(/^Не удалось подключиться: /, '').slice(0, 90)})` : ''}`);
    const more = out.length > shown.length ? `; и ещё ${out.length - shown.length}` : '';
    this._log('warn', `Вход окончен: в сети ${inGame.length} из ${list.length + batch.stopped}${stopped}. ` +
      `Не вошли (${out.length}): ${shown.join('; ')}${more}`);
  }

  /** Сколько ещё очередь входа ждёт проверку «я не робот» (0 — не ждёт). */
  _captchaHoldLeft() {
    let left = 0;
    const now = Date.now();
    for (const c of this._captcha.values()) left = Math.max(left, c.since + this.timings.captchaHoldMs - now);
    return left;
  }

  /** Бот готов к делам: вход с паролем и команды после входа прошли (BotManager, событие 'ready'). */
  _onReady(id) {
    const b = this.bots.get(id);
    if (!b || !IN_GAME(b)) return;
    b.ready = true;
    this.emit('ready', { bot: b.bot, nick: b.nick });
  }

  /** В игре и готов к делам (задачи, src/tasks.js): вошёл, автовход и команды после входа прошли. */
  isReady(id) {
    const b = this.get(id);
    return Boolean(b && b.ready && IN_GAME(b));
  }

  _onState(id, state) {
    const b = this.bots.get(id);
    if (!b || !state || b.state === state) return;
    const wasIn = IN_GAME(b);
    b.state = state;
    if (!IN_GAME(b)) b.ready = false;
    if (IN_GAME(b) && !wasIn) this._onLoggedIn(b);
    // Пробный вход кончился не «повис» (обрыв, остановили) — проба не удалась, ждём следующую.
    if (this._hung.probe === id && (state === 'offline' || state === 'reconnecting' || state === 'queued')) {
      this._hung.probe = null;
      this._hung.holdUntil = Date.now() + this._hung.holdMs;
    }
    if (state === 'offline' || state === 'reconnecting') this._onCaptchaDone(id); // проверку он уже не ждёт
    if (state === 'offline') b.ping = null;
    this.emit('state', { bot: id, nick: b.nick, state });
    this._summary();
    this._checkBatch();
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
