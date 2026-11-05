'use strict';

// Процесс ботов: src/bot-client.js (главный процесс) ↔ src/bot-host.js (процесс ботов). В одном процессе —
// несколько ботов; Electron не нужен (см. test/fake-host.js).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { BotClient, MAX_CRASHES } = require(path.join(__dirname, '..', 'src', 'bot-client.js'));
const { inMemory, flush } = require('./fake-host');

function makeClient(over = {}) {
  const mem = inMemory(over);
  const config = { host: 'mineblaze.net', autoReconnect: false, loginPassword: 'common' };
  const client = new BotClient({
    fork: mem.fork,
    initPayload: () => ({ config, authCacheDir: '/a', journalDir: '/j' }),
    timings: { restartDelay: 10, requestTimeout: over.requestTimeout || 2000, shutdownTimeout: 200 },
  });
  const events = [];
  for (const name of ['log', 'chat', 'state', 'ping', 'want-connect', 'viewer-mode', 'crash', 'restarted']) client.on(name, (p) => events.push([name, p]));
  return { client, mem, events, config };
}

const TWO = [{ bot: 'farm01', username: 'Farm01', password: '' }, { bot: 'farm02', username: 'Farm02', password: 'own' }];

test('процесс ботов: несколько ботов — свои ник и пароль, события с номером бота, настройки вживую', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  assert.deepEqual(await client.request('bots', { list: TWO }), ['farm01', 'farm02']);
  const child = mem.children[0];
  const [a, b] = child.managers;
  assert.equal(a.opts.journalDir, '/j');
  assert.deepEqual([a.opts.config.username, a.opts.config.loginPassword], ['Farm01', 'common'], 'без своего пароля — общий');
  assert.deepEqual([b.opts.config.username, b.opts.config.loginPassword], ['Farm02', 'own']);

  // Настройки меняются в тех же живых объектах, которые читают менеджеры.
  const cfgA = a.opts.config;
  client.setConfig({ host: 'localhost', loginPassword: 'new', whitelist: 'Friend' });
  await flush();
  assert.equal(a.opts.config, cfgA);
  assert.deepEqual([cfgA.host, cfgA.loginPassword, cfgA.whitelist], ['localhost', 'new', 'Friend']);
  assert.equal(b.opts.config.loginPassword, 'own', 'свой пароль общий не перебивает');

  // Старт: бот просится в очередь входа, admit — входит. События — с номером бота.
  assert.equal(await client.request('start', { bot: 'farm01' }), true);
  await flush();
  assert.ok(events.some(([n, p]) => n === 'state' && p.bot === 'farm01' && p.state === 'queued'));
  assert.ok(events.some(([n, p]) => n === 'want-connect' && p.bot === 'farm01'));
  assert.equal(await client.request('admit', { bot: 'farm01' }), true);
  assert.equal(await client.request('admit', { bot: 'farm01' }), false, 'второй раз не пускает');
  assert.equal(await client.request('admit', { bot: 'nobody' }), false);
  await flush();
  assert.ok(events.some(([n, p]) => n === 'state' && p.bot === 'farm01' && p.state === 'online'));
  assert.ok(events.some(([n, p]) => n === 'log' && p.bot === 'farm01' && p.text === 'В сети: бот появился в мире'));

  assert.equal(await client.request('say', { bot: 'farm02', text: '#pos' }), true);
  await flush();
  assert.ok(events.some(([n, p]) => n === 'chat' && p.bot === 'farm02' && p.text === '› #pos'));
  b.emit('ping', 87); // пинг, как его считает сервер
  await flush();
  assert.ok(events.some(([n, p]) => n === 'ping' && p.bot === 'farm02' && p.ping === 87));

  // Автореконнект — у всех ботов процесса, без строки в консоль от каждого.
  assert.equal(await client.request('autoReconnect', { on: true }), true);
  assert.ok(a.calls.includes('autoReconnect:true:quiet') && b.calls.includes('autoReconnect:true:quiet'));

  // Бота убрали из списка — он выходит с сервера и пропадает из процесса.
  assert.deepEqual(await client.request('bots', { list: [TWO[1]] }), ['farm02']);
  await flush();
  assert.ok(a.calls.includes('shutdown'));
  assert.ok(events.some(([n, p]) => n === 'state' && p.bot === 'farm01' && p.state === 'offline'));
  await assert.rejects(client.request('start', { bot: 'farm01' }), /бота farm01 в этом процессе нет/);
  await assert.rejects(client.request('nope'), /неизвестная команда процессу бота: nope/);
  await client.shutdown();
});

test('процесс ботов: экран показывает выбранного бота, переключается на другого, закрывается', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  await client.request('bots', { list: TWO });
  const child = mem.children[0];
  const [a, b] = child.managers;
  await client.request('start', { bot: 'farm02' });
  await client.request('admit', { bot: 'farm02' });

  const url = await client.request('viewer:open', { mode: 'third', bot: 'farm02' });
  assert.equal(url, 'http://127.0.0.1:1234/token/');
  const viewer = child.viewers[0];
  assert.equal(viewer.opts.mode, 'third');
  assert.deepEqual(viewer.bots.at(-1), { username: 'Farm02' });

  // Бот, которого экран не показывает, появился в мире — экрану всё равно.
  const shown = viewer.bots.length;
  a.start();
  a.admit();
  await flush();
  assert.equal(viewer.bots.length, shown);

  assert.equal(await client.request('viewer:bot', { bot: 'farm01' }), true);
  assert.deepEqual(viewer.bots.at(-1), { username: 'Farm01' });
  b.stop();
  assert.deepEqual(viewer.bots.at(-1), { username: 'Farm01' }, 'другой бот ушёл — экран не трогаем');
  a.stop();
  assert.equal(viewer.bots.at(-1), null, 'показанный бот ушёл из мира');

  viewer.emit('mode', 'first');
  await flush();
  assert.ok(events.some(([n, p]) => n === 'viewer-mode' && p === 'first'));
  assert.equal(await client.request('viewer:close'), true);
  assert.equal(viewer.closed, true);
  await client.request('viewer:open', { mode: 'first', bot: 'farm01' });
  assert.equal(child.viewers.length, 2, 'после закрытия — новый сервер экрана');
  await client.shutdown();
});

test('процесс ботов: авария — ждущие запросы получают ошибку, процесс перезапускается, но не бесконечно', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  await client.request('bots', { list: TWO });
  const pending = client.request('state', { bot: 'farm01' });
  mem.children[0].crash(3);
  await assert.rejects(pending, /процесс бота завершился/);
  const crash = events.find(([n]) => n === 'crash')[1];
  assert.deepEqual(crash, { code: 3, restarting: true });
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

test('процесс ботов: при выходе все боты отключаются, процесс завершается сам, аварией это не считается', async () => {
  const { client, mem, events } = makeClient();
  await client.start();
  await client.request('bots', { list: TWO });
  await client.shutdown();
  assert.deepEqual(mem.children[0].managers.map((m) => m.calls), [['shutdown'], ['shutdown']]);
  assert.equal(mem.children[0].dead, true);
  assert.equal(client.child, null);
  assert.ok(!events.some(([n]) => n === 'crash'));
});

test('процесс ботов: не отвечает — запрос завершается ошибкой, а выход не зависает', async () => {
  const { client, mem } = makeClient({ silent: true, requestTimeout: 50 });
  await assert.rejects(client.start(), /не ответил на «init»/);
  const started = Date.now();
  await client.shutdown();
  assert.ok(Date.now() - started < 2000);
  assert.equal(mem.children[0].dead, true, 'не ответил — завершён принудительно');
});
