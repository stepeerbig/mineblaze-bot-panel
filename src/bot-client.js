'use strict';

// Связь главного процесса с одним процессом ботов (src/bot-process.js, внутри — src/bot-host.js): запуск,
// запросы с ответами, события, перезапуск после аварии. Electron здесь не нужен: fork передаётся снаружи
// (в main.js — utilityProcess.fork), поэтому всё это проверяется обычными тестами. Процессов несколько,
// кто чем занят — решает src/fleet.js.
//
// События: log, chat, state, link, msa, want-connect, viewer-mode, viewer-xray — от ботов процесса (в payload.bot — чей);
// crash { code, restarting }; restarted; output { stream, line } — то, что процесс печатает сам.

const EventEmitter = require('events');

const DEFAULT_TIMINGS = Object.freeze({
  requestTimeout: 15 * 1000,
  restartDelay: 1000,
  shutdownTimeout: 3000,
  crashWindow: 60 * 1000,
});
const MAX_CRASHES = 3; // столько аварий за минуту — и больше не перезапускаем: что-то сломано всерьёз
const EVENTS = new Set(['log', 'chat', 'state', 'link', 'ready', 'captcha', 'captcha-done', 'msa', 'ping', 'want-connect', 'viewer-mode', 'viewer-xray']);

class BotClient extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {Function} opts.fork         () => процесс: { postMessage, on('message' | 'exit'), kill, stdout?, stderr? }
   * @param {Function} opts.initPayload  () => данные для 'init' (настройки, папки) — при каждом (пере)запуске
   * @param {object}   [opts.timings]    подмена задержек (для тестов)
   */
  constructor({ fork, initPayload, timings } = {}) {
    super();
    this._fork = fork;
    this._initPayload = initPayload;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.child = null;
    this.stopping = false;
    this._nextId = 1;
    this._pending = new Map();
    this._crashes = [];
    this._restartTimer = null;
    this._ready = null;
  }

  /** Запустить процесс бота; промис — когда он готов принимать команды. */
  start() {
    if (this.child) return this._ready;
    this.stopping = false;
    const child = this._fork();
    this.child = child;
    child.on('message', (message) => this._onMessage(message));
    child.on('exit', (code) => this._onExit(child, code));
    for (const stream of ['stdout', 'stderr']) {
      if (child[stream] && typeof child[stream].on === 'function') {
        let partial = '';
        child[stream].on('data', (chunk) => {
          const lines = (partial + chunk.toString()).split(/\r?\n/);
          partial = lines.pop();
          for (const line of lines) if (line.trim()) this.emit('output', { stream, line });
        });
      }
    }
    this._ready = this.request('init', this._initPayload());
    return this._ready;
  }

  /** Запрос процессу бота; промис — с его ответом. */
  request(type, payload, { timeoutMs = this.timings.requestTimeout } = {}) {
    const child = this.child;
    if (!child) return Promise.reject(new Error('процесс бота не запущен'));
    const id = this._nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`процесс бота не ответил на «${type}»`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this._pending.set(id, { resolve, reject, timer });
      try {
        child.postMessage({ id, type, payload });
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Новые настройки — процессу бота (ответ не нужен). */
  setConfig(config) {
    if (!this.child) return;
    this.request('config', { config }).catch(() => {});
  }

  /** Остановить процесс бота: бот выходит с сервера, процесс завершается; не ответил — завершаем сами. */
  async shutdown() {
    this.stopping = true;
    clearTimeout(this._restartTimer);
    this._restartTimer = null;
    const child = this.child;
    if (!child) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    try {
      await this.request('shutdown', {}, { timeoutMs: this.timings.shutdownTimeout });
    } catch (_) {
      /* не ответил — ниже завершим принудительно */
    }
    const timeout = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, ms);
        if (typeof t.unref === 'function') t.unref();
      });
    await Promise.race([exited, timeout(this.timings.shutdownTimeout)]);
    if (this.child === child) {
      try {
        child.kill();
      } catch (_) {
        /* уже завершился */
      }
      await Promise.race([exited, timeout(1000)]); // к выходу из shutdown процесса уже нет
    }
  }

  // ---------- внутреннее ----------

  _onMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.id !== undefined) {
      const pending = this._pending.get(message.id);
      if (!pending) return;
      this._pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(new Error(message.error || 'ошибка в процессе бота'));
      return;
    }
    if (!EVENTS.has(message.event)) return;
    this.emit(message.event, message.payload);
  }

  _onExit(child, code) {
    if (this.child !== child) return;
    this.child = null;
    this._ready = null;
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(new Error('процесс бота завершился'));
    }
    this._pending.clear();
    if (this.stopping) return;

    // Авария: перезапускаем, но не бесконечно. Что было с ботами процесса — знает fleet.js.
    const now = Date.now();
    this._crashes = this._crashes.filter((t) => now - t < this.timings.crashWindow);
    this._crashes.push(now);
    const restarting = this._crashes.length <= MAX_CRASHES;
    this.emit('crash', { code, restarting });
    if (!restarting) return;
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null;
      if (this.stopping) return;
      this.start().then(
        () => this.emit('restarted'),
        () => {
          /* не поднялся — придёт новое событие exit */
        },
      );
    }, this.timings.restartDelay);
  }
}

module.exports = { BotClient, MAX_CRASHES };
