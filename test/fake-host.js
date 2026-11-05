'use strict';

// Подделки для тестов процессов ботов (test/bot-process.test.js, test/fleet.test.js): менеджер бота без сети,
// экран бота без сервера и «процесс» в памяти — хозяин ботов (src/bot-host.js) на одном конце, BotClient — на
// другом. Сообщения копируются через structuredClone, как при настоящей передаче между процессами (функции
// и прочее непереносимое сразу упадёт).

const EventEmitter = require('node:events');
const path = require('node:path');

const { createBotHost } = require(path.join(__dirname, '..', 'src', 'bot-host.js'));

/** Менеджер одного бота: как BotManager, но без сети. С очередью входа — ждёт admit() в 'queued'. */
class FakeManager extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.state = 'offline';
    this.calls = [];
    this.admittedAt = null;
    this.journal = null;
  }

  _set(state) {
    this.state = state;
    this.emit('state', state);
  }

  start() {
    if (this.state !== 'offline') return false;
    this.calls.push('start');
    this._queue();
    return true;
  }

  /** Встать в очередь входа (как после старта или перед переподключением). */
  _queue() {
    if (!this.opts.requestConnect) return this._online();
    this._set('queued');
    this.opts.requestConnect();
    return true;
  }

  admit() {
    if (this.state !== 'queued') return false;
    this.calls.push('admit');
    this.admittedAt = Date.now();
    this._online();
    return true;
  }

  _online() {
    this._set('online');
    this.emit('log', { time: 1, level: 'ok', text: 'В сети: бот появился в мире' });
    this.emit('bot', this.getBot());
  }

  /** Обрыв связи: бот сам встаёт в очередь на переподключение. */
  drop() {
    this._set('reconnecting');
    this._queue();
  }

  stop() {
    this.calls.push('stop');
    if (this.state === 'offline') return;
    this._set('offline');
    this.emit('bot', null);
  }

  say(text) {
    this.calls.push(`say:${text}`);
    this.emit('chat', { time: 1, text: `› ${text}`, motd: `› ${text}`, position: 'self', links: [] });
    // serverReply(text) → [{ position, text }]: что «сервер» ответит в чат на команду «/…» (чуть позже, как настоящий).
    if (this.serverReply && String(text).startsWith('/')) {
      const replies = this.serverReply(text);
      setTimeout(() => {
        for (const r of replies) this.emit('chat', { time: 1, motd: r.text, links: [], ...r });
      }, 5);
    }
    return true;
  }

  /** Команда «#…» с ожиданием: идёт commandMs (по умолчанию 30 мс), runs — когда шла. */
  async command(line) {
    const started = Date.now();
    this.calls.push(`command:${line}`);
    await new Promise((r) => setTimeout(r, this.commandMs || 30));
    (this.runs = this.runs || []).push({ line, started, ended: Date.now() });
    return { ok: !this.failCommands, message: [`${line}: готово`] };
  }

  setAutoReconnect(on, opts = {}) {
    this.calls.push(`autoReconnect:${on}${opts.quiet ? ':quiet' : ''}`);
    this.opts.config.autoReconnect = on;
    return on;
  }

  getBot() {
    return this.state === 'online' ? { username: this.opts.config.username } : null;
  }

  shutdown() {
    this.calls.push('shutdown');
  }

  log(level, text) {
    this.emit('log', { time: 1, level, text });
  }
}

class FakeViewer extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.closed = false;
    this.bots = [];
  }

  start() {
    return Promise.resolve('http://127.0.0.1:1234/token/');
  }

  setBot(bot) {
    this.bots.push(bot);
  }

  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

/** fork() для BotClient: «процесс» в памяти. children[i].managers — менеджеры ботов этого процесса. */
function inMemory({ silent = false } = {}) {
  const children = [];
  const fork = () => {
    const child = new EventEmitter();
    const toChild = new EventEmitter();
    child.dead = false;
    child.managers = [];
    child.viewers = [];
    child.postMessage = (msg) => {
      const copy = structuredClone(msg);
      setImmediate(() => toChild.emit('message', copy));
    };
    child.kill = () => {
      if (child.dead) return;
      child.dead = true;
      setImmediate(() => child.emit('exit', 1));
    };
    child.crash = (code = 3) => {
      child.dead = true;
      child.emit('exit', code);
    };
    if (!silent) {
      child.host = createBotHost({
        port: {
          on: (fn) => toChild.on('message', fn),
          post: (msg) => {
            const copy = structuredClone(msg);
            if (!child.dead) setImmediate(() => child.emit('message', copy));
          },
        },
        createManager: (opts) => {
          const m = new FakeManager(opts);
          child.managers.push(m);
          return m;
        },
        createViewer: (opts) => {
          const v = new FakeViewer(opts);
          child.viewers.push(v);
          return v;
        },
        exit: (code) => {
          child.dead = true;
          setImmediate(() => child.emit('exit', code));
        },
      });
    }
    children.push(child);
    return child;
  };
  return { fork, children };
}

const flush = (ms = 20) => new Promise((r) => setTimeout(r, ms));

module.exports = { FakeManager, FakeViewer, inMemory, flush };
