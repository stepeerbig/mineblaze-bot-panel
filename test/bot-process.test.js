'use strict';

// Бот в отдельном процессе: src/bot-client.js (главный процесс) ↔ src/bot-host.js (процесс бота).
// Electron не нужен: «процесс» здесь — пара EventEmitter, сообщения копируются через structuredClone,
// как при настоящей передаче между процессами (функции и прочее непереносимое сразу упадёт).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const EventEmitter = require('node:events');

const { BotClient, MAX_CRASHES } = require(path.join(__dirname, '..', 'src', 'bot-client.js'));
const { createBotHost } = require(path.join(__dirname, '..', 'src', 'bot-host.js'));

class FakeManager extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.state = 'offline';
    this.calls = [];
  }

  start() {
    this.calls.push('start');
    this.state = 'online';
    this.emit('state', 'online');
    this.emit('log', { time: 1, level: 'ok', text: 'В сети: бот появился в мире' });
    return true;
  }

  stop() {
    this.calls.push('stop');
    this.state = 'offline';
    this.emit('state', 'offline');
  }

  say(text) {
    this.calls.push(`say:${text}`);
    this.emit('chat', { time: 1, text: `› ${text}`, motd: `› ${text}`, position: 'self', links: [] });
    return true;
  }

  setAutoReconnect(on) {
    this.opts.config.autoReconnect = on;
    return on;
  }

  getBot() {
    return null;
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

/** «Процесс» бота в памяти: хозяин бота на одном конце, BotClient — на другом. */
function inMemory({ silent = false } = {}) {
  const children = [];
  const fork = () => {
    const child = new EventEmitter();
    const toChild = new EventEmitter();
    child.dead = false;
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
        createManager: (opts) => (child.manager = new FakeManager(opts)),
        createViewer: (opts) => {
          child.viewers = child.viewers || [];
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

function makeClient(over = {}) {
  const mem = inMemory(over);
  const config = { host: 'mineblaze.net', autoReconnect: false };
  const client = new BotClient({
    fork: mem.fork,
    initPayload: () => ({ config, authCacheDir: '/a', journalDir: '/j' }),
    timings: { restartDelay: 10, requestTimeout: over.requestTimeout || 2000, shutdownTimeout: 200 },
  });
  const events = [];
  for (const name of ['log', 'chat', 'state', 'viewer-mode', 'crash', 'restarted']) client.on(name, (p) => events.push([name, p]));
  return { client, mem, events, config };
}

const flush = () => new Promise((r) => setTimeout(r, 20));

test('процесс бота: запуск, команды с ответами, события и настройки', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  const child = mem.children[0];
  assert.deepEqual(child.manager.opts.journalDir, '/j');
  assert.equal(await client.request('start'), true);
  await flush();
  assert.equal(client.state, 'online');
  assert.ok(events.some(([n, p]) => n === 'log' && p.text === 'В сети: бот появился в мире'));

  // Настройки меняются в том же живом объекте, который читает менеджер.
  const managerConfig = child.manager.opts.config;
  client.setConfig({ host: 'localhost', autoReconnect: true });
  await flush();
  assert.equal(child.manager.opts.config, managerConfig);
  assert.equal(managerConfig.host, 'localhost');

  assert.equal(await client.request('say', { text: '#pos' }), true);
  await flush();
  assert.ok(events.some(([n, p]) => n === 'chat' && p.text === '› #pos'));
  assert.equal(await client.request('autoReconnect', { on: false }), false);
  await assert.rejects(client.request('nope'), /неизвестная команда процессу бота: nope/);
  await client.shutdown();
});

test('процесс бота: экран бота открывается и закрывается там же, режим из окна запоминается', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  const url = await client.request('viewer:open', { mode: 'third' });
  assert.equal(url, 'http://127.0.0.1:1234/token/');
  const viewer = mem.children[0].viewers[0];
  assert.equal(viewer.opts.mode, 'third');
  viewer.emit('mode', 'first');
  await flush();
  assert.ok(events.some(([n, p]) => n === 'viewer-mode' && p === 'first'));
  assert.equal(await client.request('viewer:close'), true);
  assert.equal(viewer.closed, true);
  await client.request('viewer:open', { mode: 'first' });
  assert.equal(mem.children[0].viewers.length, 2, 'после закрытия — новый сервер экрана');
  await client.shutdown();
});

test('процесс бота: авария — ждущие запросы получают ошибку, процесс перезапускается, но не бесконечно', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  await client.request('start');
  await flush();
  const pending = client.request('state');
  mem.children[0].crash(3);
  await assert.rejects(pending, /процесс бота завершился/);
  assert.equal(client.state, 'offline');
  const crash = events.find(([n]) => n === 'crash')[1];
  assert.deepEqual(crash, { code: 3, restarting: true, previousState: 'online' });
  await new Promise((r) => client.once('restarted', r));
  assert.equal(mem.children.length, 2);
  assert.equal(await client.request('ping'), 'pong', 'новый процесс отвечает');

  for (let i = 0; i < MAX_CRASHES; i += 1) {
    mem.children[mem.children.length - 1].crash(9);
    if (i < MAX_CRASHES - 1) await new Promise((r) => client.once('restarted', r));
  }
  const last = events.filter(([n]) => n === 'crash').pop()[1];
  assert.equal(last.restarting, false, 'много аварий подряд — больше не перезапускаем');
  await flush();
  assert.equal(client.child, null);
  await assert.rejects(client.request('ping'), /процесс бота не запущен/);
});

test('процесс бота: при выходе бот отключается, процесс завершается сам, аварией это не считается', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  await client.shutdown();
  assert.deepEqual(mem.children[0].manager.calls, ['shutdown']);
  assert.equal(mem.children[0].dead, true);
  assert.equal(client.child, null);
  assert.ok(!events.some(([n]) => n === 'crash'));
});

test('процесс бота: не отвечает — запрос завершается ошибкой, а выход не зависает', async () => {
  const { client, mem } = makeClient({ silent: true, requestTimeout: 50 });
  await assert.rejects(client.start(), /не ответил на «init»/);
  const started = Date.now();
  await client.shutdown();
  assert.ok(Date.now() - started < 2000);
  assert.equal(mem.children[0].dead, true, 'не ответил — завершён принудительно');
});
