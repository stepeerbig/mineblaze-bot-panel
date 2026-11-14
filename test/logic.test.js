'use strict';

// Запуск: npm test (или node --test). Сеть и сервер Minecraft не нужны: вместо mineflayer — подделка FakeBot.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const EventEmitter = require('node:events');

const SRC = path.join(__dirname, '..', 'src');
const { BotManager, ipBlockMinutes } = require(path.join(SRC, 'bot-manager.js'));
const { chatToText, describeError, describeEnd, noRetryReason, maskSecrets } = require(path.join(SRC, 'chat-utils.js'));
const { parseMotd, readableHex } = require(path.join(SRC, 'renderer', 'motd.js'));
const { sanitize, validate, parseJoinCommands, parseAccounts, accountsOf, DEFAULT_CONFIG, MAX_ACCOUNTS } = require(path.join(SRC, 'config.js'));

class FakeBot extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.quitCalled = 0;
    this.socketDestroyed = false;
    this.autoEndOnQuit = true;
    this.sent = [];
    this.packsAccepted = 0;
    this._client = { socket: { destroy: () => { this.socketDestroyed = true; } } };
  }

  quit() {
    this.quitCalled += 1;
    if (this.autoEndOnQuit) setImmediate(() => this.emit('end', 'disconnect.quitting'));
  }

  end() {
    setImmediate(() => this.emit('end', 'socketClosed'));
  }

  chat(message) {
    this.sent.push(message);
  }

  acceptResourcePack() {
    this.packsAccepted += 1;
  }
}

function setup(over = {}, timings = {}, extra = {}) {
  const bots = [];
  const config = {
    host: 'h', port: 25565, username: 'Bot', version: '1.21.11', auth: 'offline',
    autoReconnect: false, reconnectDelay: 1, loginPassword: '', joinCommands: '', ...over,
  };
  const mgr = new BotManager({
    config,
    authCacheDir: '/tmp/auth',
    // Паузы между командами в чат проверяются отдельно (см. «очередь команд»); здесь команды уходят сразу.
    // Повторы входа (loginRetryDelays) проверяются отдельно; здесь неудачный вход — сразу «не в сети».
    timings: { commandGap: 0, loginRetryDelays: [], ...timings },
    createBot: (opts) => {
      const b = new FakeBot(opts);
      bots.push(b);
      return b;
    },
    ...extra,
  });
  const logs = [];
  const states = [];
  const chats = [];
  mgr.on('log', (e) => logs.push(e));
  mgr.on('state', (s) => states.push(s));
  mgr.on('chat', (c) => chats.push(c));
  return { mgr, bots, logs, states, chats, config };
}

const lines = (logs) => logs.map((l) => `${l.level}:${l.text}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const goOnline = (bot) => { bot.emit('login'); bot.emit('spawn'); };

// ---------- жизненный цикл бота ----------

test('полный цикл: подключение, вход, чат, кик, выход', () => {
  const { mgr, bots, logs, states, chats } = setup();
  assert.equal(mgr.start(), true);
  assert.equal(mgr.state, 'connecting');
  const bot = bots[0];
  const o = bot.opts;
  assert.deepEqual([o.host, o.port, o.username, o.auth, o.version], ['h', 25565, 'Bot', 'offline', '1.21.11']);

  goOnline(bot);
  bot.emit('message', { toString: () => '<Steve> hi', toMotd: () => '§a<Steve> §fhi' }, 'chat');
  bot.emit('message', { toString: () => 'actionbar', toMotd: () => 'actionbar' }, 'game_info'); // не чат
  bot.emit('message', { toString: () => '   ', toMotd: () => '' }, 'system'); // пустое
  bot.emit('kicked', JSON.stringify({ text: 'Bye', extra: [{ text: '!' }] }), true);
  bot.emit('end', 'socketClosed');

  assert.deepEqual(states, ['connecting', 'connected', 'online', 'offline']);
  assert.equal(chats.length, 1);
  assert.equal(chats[0].text, '<Steve> hi');
  assert.equal(chats[0].motd, '§a<Steve> §fhi');
  const t = lines(logs);
  assert.ok(t.some((x) => x.startsWith('info:Подключение к h:25565 как Bot (версия 1.21.11)')));
  assert.ok(t.includes('ok:Подключен: вход на сервер выполнен'));
  assert.ok(t.includes('ok:В сети: бот появился в мире'));
  assert.ok(t.includes('kick:Кик: Bye!'));
  assert.ok(t.includes('warn:Не в сети: кик с сервера'));
  assert.equal(mgr.wantRun, false);
});

test('кик при входе помечается отдельно', () => {
  const { mgr, bots, logs } = setup();
  mgr.start();
  bots[0].emit('kicked', '{"translate":"multiplayer.disconnect.not_whitelisted"}', false);
  bots[0].emit('end', 'socketClosed');
  assert.ok(lines(logs).includes('kick:Кик при входе: Ника нет в белом списке сервера'));
  assert.equal(mgr.state, 'offline');
});

test('ошибка подключения: сообщение и автореконнект', async () => {
  const { mgr, bots, logs } = setup({ autoReconnect: true, reconnectDelay: 1 });
  mgr.start();
  bots[0].emit('error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
  bots[0].emit('end', 'socketClosed');

  assert.equal(mgr.state, 'reconnecting');
  const t = lines(logs);
  assert.ok(t.some((x) => x.startsWith('error:Не удалось подключиться: сервер отклонил подключение')));
  assert.ok(t.includes('warn:Не в сети'));
  assert.ok(t.some((x) => x.startsWith('warn:Автореконнект: подключение через 1 с (попытка 1)')));
  assert.equal(bots.length, 1);

  await sleep(1200);
  assert.equal(bots.length, 2);
  assert.equal(mgr.state, 'connecting');

  mgr.stop();
  await tick();
  assert.equal(mgr.state, 'offline');
});

test('успешный вход сбрасывает счётчик попыток', async () => {
  const { mgr, bots } = setup({ autoReconnect: true, reconnectDelay: 1 });
  mgr.start();
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.attempt, 1);
  await sleep(1200);
  goOnline(bots[1]);
  assert.equal(mgr.attempt, 0);
  mgr.stop();
  await tick();
});

test('пауза реконнекта растёт после трёх неудач, но не больше минуты', () => {
  const { mgr, config } = setup({ reconnectDelay: 5 });
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 8].map((n) => mgr.reconnectDelayFor(n)), [5, 5, 5, 10, 20, 40, 60, 60]);
  config.reconnectDelay = 120; // если пауза в настройках больше минуты — её и держим
  assert.deepEqual([1, 4, 9].map((n) => mgr.reconnectDelayFor(n)), [120, 120, 120]);
});

test('стоп не вызывает реконнект, даже если он включён', async () => {
  const { mgr, bots, logs } = setup({ autoReconnect: true });
  mgr.start();
  goOnline(bots[0]);
  mgr.stop();
  assert.equal(bots[0].quitCalled, 1);
  await tick();
  assert.equal(mgr.state, 'offline');
  assert.equal(mgr.reconnectTimer, null);
  assert.ok(lines(logs).includes('warn:Не в сети: бот остановлен'));
  await sleep(1300);
  assert.equal(bots.length, 1);
});

test('очередь входа: ждёт разрешения (queued), admit — входит; переподключение — тоже через очередь; стоп — выходит из неё', async () => {
  const asks = [];
  const { mgr, bots, logs } = setup({ autoReconnect: true, reconnectDelay: 1, viewDistance: 4 }, {}, { requestConnect: () => asks.push(mgr.state) });
  mgr.start();
  assert.equal(mgr.state, 'queued');
  assert.equal(bots.length, 0, 'без разрешения не подключается');
  assert.deepEqual(asks, ['queued']);
  assert.equal(mgr.start(), false, 'второй «Старт» в очередь второй раз не ставит');
  assert.equal(mgr.admit(), true);
  assert.equal(bots.length, 1);
  assert.equal(mgr.state, 'connecting');
  assert.equal(mgr.admit(), false, 'уже входит');
  assert.equal(bots[0].opts.clientSettings.viewDistance, 4, 'дальность прорисовки — из настроек');

  // Обрыв: переподключение ждёт очереди, а не входит само.
  goOnline(bots[0]);
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.state, 'reconnecting');
  await sleep(1200);
  assert.equal(mgr.state, 'queued');
  assert.equal(asks.length, 2);
  assert.equal(bots.length, 1);

  // Автореконнект выключили, пока ждал очереди на переподключение — ждать больше нечего.
  mgr.setAutoReconnect(false, { quiet: true });
  assert.equal(mgr.state, 'offline');
  assert.equal(mgr.admit(), false);
  assert.ok(!lines(logs).some((x) => x.startsWith('info:Автоматический реконнект')), 'quiet — без строки в консоль');

  // Стоп, пока ждал очереди, — просто выходит из неё.
  mgr.start();
  assert.equal(mgr.state, 'queued');
  mgr.stop();
  assert.equal(mgr.state, 'offline');
  assert.ok(lines(logs).includes('warn:Не в сети: вход отменён'));
  assert.equal(mgr.admit(), false);
  assert.equal(bots.length, 1);
});

test('пинг бота (как его считает сервер) — событием; сервер раз за разом возвращает бота на место — предупреждение', async () => {
  const { mgr, bots, logs } = setup();
  const pings = [];
  mgr.on('ping', (p) => pings.push(p));
  mgr.start();
  const b = bots[0];
  b.username = 'Bot';
  goOnline(b);
  b.emit('playerJoined', { username: 'Other', ping: 5 });
  b.emit('playerJoined', { username: 'Bot', ping: 0 });
  b.emit('playerUpdated', { username: 'Bot', ping: 133 });
  b.emit('playerUpdated', { username: 'Bot', ping: 133 });
  assert.deepEqual(pings, [0, 133], 'только свой и только когда поменялся');
  assert.equal(mgr.ping, 133);

  const warned = () => lines(logs).filter((x) => x.includes('раз за разом возвращает бота на место')).length;
  for (let i = 0; i < 7; i += 1) b.emit('forcedMove');
  assert.equal(warned(), 0, 'несколько телепортов — нормально');
  b.emit('forcedMove');
  assert.equal(warned(), 1);
  assert.ok(lines(logs).some((x) => x.startsWith('warn:Сервер раз за разом возвращает бота на место: 8 раз за 3 с — похоже, он застрял')));
  for (let i = 0; i < 10; i += 1) b.emit('forcedMove');
  assert.equal(warned(), 1, 'не чаще раза в 30 с');

  mgr.stop();
  await tick();
  assert.deepEqual(pings, [0, 133, null], 'не в сети — пинга нет');
});

test('команда боту с ожиданием конца: результат команды, строка «› …» в чате', async () => {
  const { mgr, chats } = setup();
  const r = await mgr.command('#помощь');
  assert.equal(r.ok, true);
  assert.equal([].concat(r.message)[0], 'Команды боту (пишутся здесь, на сервер не уходят):');
  assert.equal(chats.at(-1).text, '› #помощь');
  const offline = await mgr.command('#где');
  assert.deepEqual([offline.ok, offline.code], [false, 'not_ready'], 'бот не в мире — так и отвечает');
});

test('повторное нажатие «Стоп» не дублирует остановку', () => {
  const { mgr, bots, logs } = setup();
  mgr.start();
  goOnline(bots[0]);
  bots[0].autoEndOnQuit = false;
  mgr.stop();
  mgr.stop();
  assert.equal(bots[0].quitCalled, 1);
  assert.equal(lines(logs).filter((x) => x === 'info:Остановка бота…').length, 1);
  mgr.shutdown();
});

test('стоп во время подключения закрывает сокет принудительно', async () => {
  const { mgr, bots } = setup();
  mgr.start();
  bots[0].autoEndOnQuit = false;
  mgr.stop();
  assert.equal(mgr.state, 'connecting');
  await sleep(450);
  assert.equal(mgr.state, 'offline');
  assert.ok(bots[0].socketDestroyed);
});

test('стоп во время ожидания реконнекта отменяет его', () => {
  const { mgr, bots } = setup({ autoReconnect: true, reconnectDelay: 30 });
  mgr.start();
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.state, 'reconnecting');
  mgr.stop();
  assert.equal(mgr.state, 'offline');
  assert.equal(mgr.reconnectTimer, null);
});

test('выключение реконнекта отменяет ожидание', () => {
  const { mgr, bots, logs } = setup({ autoReconnect: true, reconnectDelay: 30 });
  mgr.start();
  bots[0].emit('login');
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.state, 'reconnecting');
  assert.equal(mgr.setAutoReconnect(false), false);
  assert.equal(mgr.state, 'offline');
  assert.equal(mgr.reconnectTimer, null);
  assert.ok(lines(logs).includes('info:Автоматический реконнект: OFF'));
});

test('реконнект выключен: после обрыва бот остаётся не в сети', () => {
  const { mgr, bots } = setup({ autoReconnect: false });
  mgr.start();
  goOnline(bots[0]);
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.state, 'offline');
  assert.equal(mgr.reconnectTimer, null);
  assert.equal(mgr.wantRun, false);
});

test('реконнект можно включить на ходу, пока бот онлайн', async () => {
  const { mgr, bots } = setup({ autoReconnect: false, reconnectDelay: 1 });
  mgr.start();
  goOnline(bots[0]);
  mgr.setAutoReconnect(true);
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.state, 'reconnecting');
  await sleep(1200);
  assert.equal(bots.length, 2);
  mgr.stop();
  await tick();
});

test('бан или вход с другого места: реконнект не запускается', () => {
  const banned = setup({ autoReconnect: true, reconnectDelay: 1 });
  banned.mgr.start();
  goOnline(banned.bots[0]);
  banned.bots[0].emit('kicked', { type: 'string', value: '§cВы забанены на этом сервере' }, true);
  banned.bots[0].emit('end', 'socketClosed');
  assert.equal(banned.mgr.state, 'offline');
  assert.equal(banned.mgr.reconnectTimer, null);
  assert.ok(lines(banned.logs).includes('warn:Автореконнект не запущен: аккаунт забанен'));

  const dup = setup({ autoReconnect: true, reconnectDelay: 1 });
  dup.mgr.start();
  goOnline(dup.bots[0]);
  dup.bots[0].emit('kicked', '{"translate":"multiplayer.disconnect.duplicate_login"}', true);
  dup.bots[0].emit('end', 'socketClosed');
  assert.equal(dup.mgr.state, 'offline');
  assert.ok(lines(dup.logs).some((x) => x.startsWith('warn:Автореконнект не запущен: под этим ником зашли')));
});

test('обычный кик (рестарт сервера): реконнект запускается', () => {
  const { mgr, bots } = setup({ autoReconnect: true, reconnectDelay: 30 });
  mgr.start();
  goOnline(bots[0]);
  bots[0].emit('kicked', '{"text":"Сервер перезагружается"}', true);
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.state, 'reconnecting');
  mgr.stop();
});

test('исключение при создании бота: ошибка в консоли, без повторов', () => {
  const config = { host: 'h', port: 1, username: 'Bot', version: '1.21.11', auth: 'offline', autoReconnect: true, reconnectDelay: 1 };
  const mgr = new BotManager({ config, createBot: () => { throw new Error('Version 1.21.11 is not supported'); } });
  const logs = [];
  mgr.on('log', (e) => logs.push(e));
  mgr.start();
  assert.equal(mgr.state, 'offline');
  assert.equal(mgr.reconnectTimer, null);
  assert.equal(mgr.wantRun, false);
  assert.ok(lines(logs).some((x) => x.startsWith('error:Не удалось запустить бота: Version 1.21.11 is not supported')));
});

test('события старого бота после остановки игнорируются, а его вход тут же закрывается', async () => {
  const { mgr, bots, logs } = setup();
  mgr.start();
  const old = bots[0];
  old.autoEndOnQuit = false;
  mgr.stop();
  await sleep(450);
  mgr.start();
  const fresh = bots[1];
  const before = logs.length;
  const quitsBefore = old.quitCalled;
  old.emit('login');
  old.emit('error', new Error('late'));
  old.emit('kicked', 'x', true);
  old.emit('end', 'x');
  assert.equal(logs.length, before);
  assert.equal(old.quitCalled, quitsBefore + 1); // «осиротевший» вход — сразу выходим
  assert.equal(mgr.state, 'connecting');
  fresh.emit('login');
  assert.equal(mgr.state, 'connected');
  mgr.stop();
  await tick();
});

test('ошибка после входа не рвёт соединение', () => {
  const { mgr, bots, logs } = setup();
  mgr.start();
  bots[0].emit('login');
  bots[0].emit('error', new Error('boom'));
  assert.equal(mgr.state, 'connected');
  assert.ok(lines(logs).includes('error:Ошибка: boom'));
  mgr.shutdown();
});

test('сервер закрыл соединение до входа без ошибки', () => {
  const { mgr, bots, logs } = setup();
  mgr.start();
  bots[0].emit('end', 'socketClosed');
  assert.ok(lines(logs).some((x) => x.startsWith('error:Не удалось подключиться: соединение закрыто')));
  assert.equal(mgr.state, 'offline');
});

test('ошибка до входа без события end: закрываем сами', async () => {
  const { mgr, bots } = setup();
  mgr.start();
  bots[0].emit('error', new Error('ping failed'));
  assert.equal(mgr.state, 'connecting');
  await sleep(2200);
  assert.equal(mgr.state, 'offline');
  assert.ok(bots[0].socketDestroyed);
});

test('сервер молчит: «Подключение…» не висит вечно', async () => {
  const { mgr, bots, logs } = setup({}, { loginTimeout: 60 });
  mgr.start();
  await sleep(120);
  assert.equal(mgr.state, 'offline');
  assert.ok(bots[0].socketDestroyed);
  assert.ok(lines(logs).some((x) => x.startsWith('error:Не удалось подключиться: вход не завершился')));
});

// Бот, у которого видно этапы входа (minecraft-protocol: 'connect', 'state').
function setupStaged(over = {}, timings = {}) {
  const made = [];
  const t = setup(over, timings, {
    createBot: (opts) => {
      const b = new FakeBot(opts);
      b._client = Object.assign(new EventEmitter(), { socket: { destroy: () => { b.socketDestroyed = true; } } });
      made.push(b);
      return b;
    },
  });
  return { ...t, bots: made };
}
const waitUntil = async (check, ms = 2000) => {
  for (let t = 0; t < ms; t += 5) {
    if (check()) return true;
    await sleep(5);
  }
  return false;
};

test('вход повис: в причине — этап, повтор и без автореконнекта (по очереди пауз), потом — «не вошёл»', async () => {
  const { mgr, bots, logs, states } = setupStaged({ autoReconnect: false }, { loginTimeout: 40, loginRetryDelays: [30, 30] });
  mgr.start();
  bots[0]._client.emit('connect');
  bots[0]._client.emit('state', 'configuration', 'login');
  assert.ok(await waitUntil(() => mgr.state === 'reconnecting'));
  assert.deepEqual(states, ['connecting', 'reconnecting'], 'перед повтором — без «не в сети» (флот решил бы, что вход окончен)');
  assert.ok(lines(logs).some((x) => x.startsWith('error:Не удалось подключиться: вход не завершился') &&
    x.includes('прокси держит бота на этапе настройки (configuration)')), lines(logs).join(' | '));
  assert.ok(lines(logs).includes('warn:Вход не удался — попробую ещё раз через 1 с (повтор 1 из 2)'));
  assert.ok(await waitUntil(() => bots.length === 2), 'повтор — новое подключение');
  assert.ok(await waitUntil(() => bots.length === 3 && mgr.state === 'offline'), `${bots.length} ${mgr.state}`);
  assert.ok(lines(logs).includes('warn:Вход не удался — попробую ещё раз через 1 с (повтор 2 из 2)'));
  assert.ok(lines(logs).includes('error:Не вошёл и после 2 повторов — запусти бота позже (или включи «Переподключаться»)'));
  // Сервер не ответил даже на подключение — так и сказано.
  assert.ok(lines(logs).some((x) => x.includes('сервер не ответил на подключение')));
});

test('вход повис, а повтор прошёл — счётчик повторов с нуля; «Стоп» во время паузы — повтора нет', async () => {
  const { mgr, bots, logs } = setupStaged({}, { loginTimeout: 30, loginRetryDelays: [20, 20] });
  mgr.start();
  assert.ok(await waitUntil(() => bots.length === 2));
  goOnline(bots[1]);
  assert.equal(mgr.state, 'online');
  assert.equal(mgr.loginRetries, 0);
  bots[1].emit('end', 'socketClosed'); // обрыв уже после входа: без автореконнекта — не повторяем
  assert.equal(mgr.state, 'offline');
  mgr.start();
  assert.ok(await waitUntil(() => mgr.state === 'reconnecting'));
  mgr.stop();
  assert.equal(mgr.state, 'offline');
  await sleep(60);
  assert.equal(bots.length, 3, 'после «Стоп» нового подключения нет');
  assert.ok(lines(logs).includes('warn:Не в сети: переподключение отменено'));
});

test('кик «IP адрес заблокирован на 10 минут»: событие ip-block, повтор — не раньше конца блокировки; бан — без повторов', async () => {
  const { mgr, bots, logs } = setupStaged({}, { loginTimeout: 1000, loginRetryDelays: [20] });
  const blocks = [];
  mgr.on('ip-block', (b) => blocks.push(b));
  mgr.start();
  bots[0].emit('kicked', { type: 'string', value: '§cВаш IP адрес заблокирован на 10 минут' }, false);
  bots[0].emit('end', 'socketClosed');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].minutes, 10);
  assert.ok(blocks[0].until - Date.now() > 9 * 60 * 1000);
  assert.equal(mgr.state, 'reconnecting');
  assert.ok(lines(logs).some((x) => /^warn:Вход не удался — попробую ещё раз через 61\d с/.test(x)), lines(logs).join(' | '));
  mgr.stop();

  const banned = setupStaged({}, { loginTimeout: 1000, loginRetryDelays: [20] });
  banned.mgr.start();
  banned.bots[0].emit('kicked', { type: 'string', value: 'Вы забанены' }, false);
  banned.bots[0].emit('end', 'socketClosed');
  assert.equal(banned.mgr.state, 'offline');
  assert.ok(lines(banned.logs).includes('warn:Повторять вход не буду: аккаунт забанен'));

  assert.equal(ipBlockMinutes('Ваш IP адрес заблокирован на 10 минут'), 10);
  assert.equal(ipBlockMinutes('Your IP is banned for 2 hours'), 120);
  assert.equal(ipBlockMinutes('IP заблокирован'), 10);
  assert.equal(ipBlockMinutes('Вы забанены'), 0);
  assert.equal(ipBlockMinutes('Вы не успели авторизироваться'), 0);
});

test('нельзя запустить второй раз', () => {
  const { mgr, bots } = setup();
  assert.equal(mgr.start(), true);
  assert.equal(mgr.start(), false);
  assert.equal(bots.length, 1);
  mgr.shutdown();
});

test('вход через Microsoft: папка кэша, код устройства и долгое ожидание', async () => {
  const { mgr, bots, logs } = setup({ auth: 'microsoft', version: '' }, { loginTimeout: 60, msaTimeout: 5000 });
  mgr.start();
  assert.equal(bots[0].opts.profilesFolder, '/tmp/auth');
  assert.equal(bots[0].opts.version, false);
  bots[0].opts.onMsaCode({ verification_uri: 'https://www.microsoft.com/link', user_code: 'ABCD1234' });
  assert.ok(lines(logs).some((x) => x.includes('ABCD1234') && x.includes('https://www.microsoft.com/link')));
  await sleep(150); // обычный тайм-аут (60 мс) уже прошёл бы, но человек вводит код
  assert.equal(mgr.state, 'connecting');
  mgr.shutdown();
});

// ---------- новое: чат, автовход, гибель, ресурспак ----------

test('отправка в чат: только когда бот на сервере', () => {
  const { mgr, bots, logs, chats } = setup();
  assert.equal(mgr.say('привет'), false);
  assert.ok(lines(logs).includes('warn:Сообщение не отправлено: бот не в сети'));

  mgr.start();
  goOnline(bots[0]);
  assert.equal(mgr.say('  привет\nвсем  '), true);
  assert.equal(mgr.say('   '), false);
  assert.equal(mgr.say('/spawn'), true);
  assert.equal(mgr.say('x'.repeat(400)), true);
  assert.deepEqual(bots[0].sent.slice(0, 2), ['привет всем', '/spawn']);
  assert.equal(bots[0].sent[2].length, 256);
  // Команды показываются в чате панели, обычные сообщения — нет (их пришлёт сервер).
  assert.deepEqual(chats.map((c) => [c.position, c.text]), [['self', '› /spawn']]);
  mgr.shutdown();
});

/** Сообщение сервера в чат бота (не игрока). */
const serverSays = (bot, text) => bot.emit('message', { toString: () => text, toMotd: () => text }, 'system');

test('вход: /login — когда сервер просит; «успешно» — дальше команды после входа; пароль нигде не виден', async () => {
  const { mgr, bots, logs, chats } = setup(
    { loginPassword: 'Secr3t', joinCommands: '/server survival\n\n  /home  \n' },
    { joinFirst: 10, joinStep: 10 },
  );
  mgr.start();
  goOnline(bots[0]);
  await sleep(40);
  assert.deepEqual(bots[0].sent, [], 'сервер не просил войти — /login не шлёт, команды ждут входа');
  serverSays(bots[0], '| Авторизируйтесь » /login [пароль]');
  assert.deepEqual(bots[0].sent, ['/login Secr3t']);
  serverSays(bots[0], '| Авторизируйтесь » /login [пароль]'); // напоминание сразу за командой — ещё раз не шлёт
  assert.deepEqual(bots[0].sent, ['/login Secr3t']);
  serverSays(bots[0], '| Вы успешно авторизовались');
  await sleep(80);
  assert.deepEqual(bots[0].sent, ['/login Secr3t', '/server survival', '/home']);
  const t = lines(logs);
  assert.ok(t.includes('info:Автовход: /login ••••'));
  assert.ok(t.includes('ok:Автовход: сервер принял пароль'));
  assert.ok(t.includes('info:Команда после входа: /server survival'));
  assert.ok(!JSON.stringify([logs, chats]).includes('Secr3t'));

  // Вошёл: напоминание, ушедшее до ответа, и гибель с возрождением — ничего не шлёт заново.
  serverSays(bots[0], '| Авторизируйтесь » /login [пароль]');
  bots[0].emit('death');
  bots[0].emit('spawn');
  await sleep(60);
  assert.equal(bots[0].sent.length, 3);
  mgr.shutdown();
});

test('вход: пароль с пробелом («пароль пароль») — /login первым словом; сервер 3 раза снова просит — стоп с понятной причиной', async () => {
  const { mgr, bots, logs } = setup({ loginPassword: 'Secr3t Secr3t' }, { joinFirst: 10, authRetry: 20 });
  mgr.start();
  goOnline(bots[0]);
  serverSays(bots[0], '| Авторизируйтесь » /login [пароль]');
  assert.deepEqual(bots[0].sent, ['/login Secr3t'], 'MineBlaze ждёт одно слово: на два отвечает «Авторизируйтесь»');
  assert.ok(!JSON.stringify(logs).includes('Secr3t'), 'пароль нигде не виден');
  serverSays(bots[0], '| Вы успешно авторизовались');
  assert.ok(lines(logs).includes('ok:Автовход: сервер принял пароль'));
  mgr.shutdown();

  // Пароль не подходит: сервер раз за разом снова просит — ещё 2 попытки (команду сразу за другой MineBlaze
  // пропускает), потом стоп: иначе бот заходил бы по кругу.
  const b = setup({ loginPassword: 'wrong', autoReconnect: true }, { joinFirst: 10, authRetry: 20 });
  b.mgr.start();
  goOnline(b.bots[0]);
  for (let i = 0; i < 4; i += 1) {
    serverSays(b.bots[0], '| Авторизируйтесь » /login [пароль]');
    await sleep(30);
  }
  assert.deepEqual(b.bots[0].sent, ['/login wrong', '/login wrong', '/login wrong']);
  assert.ok(lines(b.logs).some((l) => /^error:Автовход не прошёл: сервер 3 раза подряд снова просит \/login/.test(l)), lines(b.logs).join('\n'));
  await sleep(20);
  assert.equal(b.mgr.state, 'offline');
  assert.equal(b.mgr.wantRun, false, 'не переподключается');
});

test('вход: в поле пароля — команда целиком или несколько слов: только пароль, слова по очереди на «Пароль указан неверно», подошедшее — помнит', async () => {
  // «/login пароль» вписано целиком — уходит только пароль.
  const c = setup({ loginPassword: '/login Secr3t' });
  c.mgr.start();
  goOnline(c.bots[0]);
  serverSays(c.bots[0], '| Авторизируйтесь » /login [пароль]');
  assert.deepEqual(c.bots[0].sent, ['/login Secr3t']);
  assert.ok(lines(c.logs).some((l) => /^warn:В поле пароля вписана команда целиком/.test(l)));
  c.mgr.shutdown();

  // Два разных слова, пароль — второе (так было у пользователя 7 ноября: первое — «неверно», руками — входит).
  const { mgr, bots, logs } = setup({ loginPassword: 'Old1 New2', autoReconnect: true }, { commandGap: 0 });
  mgr.start();
  goOnline(bots[0]);
  serverSays(bots[0], '| Авторизируйтесь » /login [пароль]');
  serverSays(bots[0], '| Пароль указан неверно');
  serverSays(bots[0], '| Вы успешно авторизовались');
  assert.deepEqual(bots[0].sent, ['/login Old1', '/login New2']);
  const t = lines(logs);
  assert.ok(t.some((l) => /^warn:Автовход: 1-е слово из поля пароля сервер не принял \(«Пароль указан неверно»\) — пробую 2-е/.test(l)), t.join('\n'));
  assert.ok(t.some((l) => /^warn:Автовход: подошло 2-е слово из поля пароля\. Оставь в поле только его/.test(l)), t.join('\n'));
  assert.ok(!JSON.stringify(logs).includes('New2') && !JSON.stringify(logs).includes('Old1'), 'пароль нигде не виден');
  // Переподключение — сразу второе слово.
  bots[0].emit('end', 'socketClosed');
  await sleep(1100);
  goOnline(bots[1]);
  serverSays(bots[1], '| Авторизируйтесь » /login [пароль]');
  assert.deepEqual(bots[1].sent, ['/login New2']);
  mgr.shutdown();

  // Ни одно слово не подошло — стоп с понятной причиной.
  const w = setup({ loginPassword: 'a1 b2', autoReconnect: true });
  w.mgr.start();
  goOnline(w.bots[0]);
  serverSays(w.bots[0], '| Авторизируйтесь » /login [пароль]');
  serverSays(w.bots[0], '| Пароль указан неверно');
  serverSays(w.bots[0], '| Пароль указан неверно');
  assert.ok(lines(w.logs).some((l) => /^error:Автовход не прошёл: сервер ответил «Пароль указан неверно» на все слова из поля пароля \(2\)/.test(l)), lines(w.logs).join('\n'));
  await sleep(20);
  assert.equal(w.mgr.wantRun, false);
});

test('вход: не зарегистрирован — /reg по подсказке сервера; лимит регистраций с IP — понятная причина и стоп', async () => {
  const { mgr, bots, logs } = setup({ loginPassword: 'pw' }, { joinFirst: 10 });
  mgr.start();
  bots[0].emit('login');
  // Просьба пришла ещё до появления в мире (MineBlaze — сразу после проверки «я не робот») — ответ при появлении.
  serverSays(bots[0], '| Зарегистрируйтесь » /reg [пароль]');
  assert.deepEqual(bots[0].sent, []);
  bots[0].emit('spawn');
  assert.deepEqual(bots[0].sent, ['/reg pw'], 'MineBlaze: /reg [пароль] — пароль один раз');
  serverSays(bots[0], '| Вы успешно зарегистрировались');
  assert.ok(lines(logs).includes('ok:Регистрация: аккаунт зарегистрирован, вход выполнен'));
  assert.ok(lines(logs).includes('info:Регистрация: /reg ••••'));
  mgr.shutdown();

  // Другой сервер (AuthMe): «/register <password> <ConfirmPassword>» — пароль дважды.
  const a = setup({ loginPassword: 'pw' });
  a.mgr.start();
  goOnline(a.bots[0]);
  serverSays(a.bots[0], 'Please, register to the server with the command: /register <password> <ConfirmPassword>');
  assert.deepEqual(a.bots[0].sent, ['/register pw pw']);
  a.mgr.shutdown();

  // Сервер не даёт регистрировать больше аккаунтов с этого IP — заходить снова бессмысленно.
  const b = setup({ loginPassword: 'pw', autoReconnect: true });
  b.mgr.start();
  goOnline(b.bots[0]);
  serverSays(b.bots[0], '| Зарегистрируйтесь » /reg [пароль]');
  serverSays(b.bots[0], '| Вы превысили лимит регистраций с вашего IP');
  assert.ok(lines(b.logs).some((l) => l.startsWith('error:Сервер не даёт зарегистрировать аккаунт: «Вы превысили лимит регистраций с вашего IP»')), lines(b.logs).join('\n'));
  await sleep(20);
  assert.equal(b.mgr.state, 'offline');
  assert.equal(b.mgr.wantRun, false, 'не переподключается');
});

test('вход: сервер не просит войти (уже вошёл или вход не нужен) — /login не шлёт, команды после входа идут', async () => {
  const { mgr, bots, logs } = setup({ loginPassword: 'pw', joinCommands: '/g5' }, { joinFirst: 10, authWait: 30 });
  mgr.start();
  goOnline(bots[0]);
  await sleep(100);
  assert.deepEqual(bots[0].sent, ['/g5']);
  assert.ok(!lines(logs).some((l) => /Автовход/.test(l)));
  mgr.shutdown();

  // Без пароля сервер просит войти — подсказка, где его вписать (одна).
  const n = setup();
  n.mgr.start();
  goOnline(n.bots[0]);
  serverSays(n.bots[0], '| Авторизируйтесь » /login [пароль]');
  serverSays(n.bots[0], '| Авторизируйтесь » /login [пароль]');
  assert.deepEqual(n.bots[0].sent, []);
  assert.equal(lines(n.logs).filter((l) => /^warn:Сервер просит войти \(\/login\), а пароль не задан/.test(l)).length, 1);
  n.mgr.shutdown();
});

test('проверка «я не робот»: ссылка — в консоль с подсказкой, события для очереди входа; прошёл — «пройдена»', () => {
  const { mgr, bots, logs } = setup();
  const events = [];
  mgr.on('captcha', (c) => events.push(['captcha', c.url]));
  mgr.on('captcha-done', () => events.push(['done']));
  mgr.start();
  bots[0].emit('login');
  const url = 'https://mineblaze.net/antibot/?id=abc';
  const text = `[*] Пожалуйста подтвердите, что вы не робот - кликните мышкой по ссылке и нажмите 'Да': ${url}`;
  bots[0].emit('message', { toString: () => text, toMotd: () => text, json: { text } }, 'system');
  bots[0].emit('message', { toString: () => text, toMotd: () => text, json: { text } }, 'system'); // повтор — тот же
  assert.ok(lines(logs).includes(`warn:Ссылка от сервера (проверка «я не робот» — открой ссылку и нажми «Да»): ${url}`), lines(logs).join('\n'));
  serverSays(bots[0], '[*] Вы прошли проверку, пропускаем вас на сервер!');
  assert.ok(lines(logs).includes('ok:Проверка «я не робот» пройдена'));
  assert.deepEqual(events, [['captcha', url], ['done']]);

  // Снова проверка, и бот отключился, так её и не пройдя, — очередь входа его больше не ждёт.
  const again = text.replace('abc', 'xyz');
  bots[0].emit('message', { toString: () => again, toMotd: () => again, json: { text: again } }, 'system');
  bots[0].emit('end', 'socketClosed');
  assert.deepEqual(events, [['captcha', url], ['done'], ['captcha', `${url.replace('abc', 'xyz')}`], ['done']]);
});

test('готов к делам (для задач): без пароля — после команд входа; с паролем — только после входа; переход на другой сервер — после него', async () => {
  const readyAt = (mgr) => new Promise((r) => mgr.once('ready', () => r(Date.now())));
  const a = setup({ joinCommands: '/g5' }, { joinFirst: 10, joinStep: 10, readySettle: 30 });
  const at = readyAt(a.mgr);
  a.mgr.start();
  const t0 = Date.now();
  goOnline(a.bots[0]);
  assert.ok((await at) - t0 >= 35, 'после /g5 и паузы');
  a.mgr.shutdown();

  const b = setup({ loginPassword: 'pw' }, { joinFirst: 10, readySettle: 20, authWait: 5000 });
  let ready = false;
  b.mgr.on('ready', () => { ready = true; });
  b.mgr.start();
  goOnline(b.bots[0]);
  serverSays(b.bots[0], '| Авторизируйтесь » /login [пароль]');
  await sleep(60);
  assert.equal(ready, false, 'пока не вошёл — не готов');
  serverSays(b.bots[0], '| Вы успешно авторизовались');
  await sleep(60);
  assert.equal(ready, true);
  b.mgr.shutdown();

  // Команда входа перевела на другой сервер: готов — когда переход закончился (и бот устоялся).
  let fake = null;
  const c = setup({ joinCommands: '/g5' }, { joinFirst: 10, readySettle: 20 }, {
    createBot: (opts) => {
      fake = new FakeBot(opts);
      fake._client = Object.assign(new EventEmitter(), { socket: { destroy() {} } }); // у клиента есть события протокола
      return fake;
    },
  });
  let readyC = false;
  c.mgr.on('ready', () => { readyC = true; });
  c.mgr.start();
  goOnline(fake);
  await sleep(15);
  fake._client.emit('start_configuration'); // прокси переводит бота на другой сервер
  await sleep(60);
  assert.equal(readyC, false, 'идёт переход — не готов');
  fake.emit('login'); // переход выполнен
  await sleep(60);
  assert.equal(readyC, true);
  c.mgr.shutdown();
});

test('автовход отменяется, если бот отключился раньше', async () => {
  const { mgr, bots } = setup({ loginPassword: 'pw' }, { joinFirst: 40 });
  mgr.start();
  goOnline(bots[0]);
  bots[0].emit('end', 'socketClosed');
  serverSays(bots[0], '| Авторизируйтесь » /login [пароль]');
  await sleep(80);
  assert.deepEqual(bots[0].sent, []);
});

test('гибель и возрождение видны в консоли, смена мира — нет', () => {
  const { mgr, bots, logs } = setup();
  mgr.start();
  goOnline(bots[0]);
  bots[0].emit('spawn'); // смена мира/сервера
  bots[0].emit('death');
  bots[0].emit('spawn');
  const t = lines(logs);
  assert.equal(t.filter((x) => x === 'warn:Бот погиб').length, 1);
  assert.equal(t.filter((x) => x === 'ok:Бот возродился').length, 1);
  assert.equal(mgr.state, 'online');
  mgr.shutdown();
});

test('ресурспак принимается автоматически, сообщение в консоли одно', () => {
  const { mgr, bots, logs } = setup();
  mgr.start();
  bots[0].emit('resourcePack', 'https://example.com/pack.zip', 'uuid');
  bots[0].emit('resourcePack', 'https://example.com/pack2.zip', 'uuid2');
  assert.equal(bots[0].packsAccepted, 2);
  assert.equal(lines(logs).filter((x) => x.startsWith('info:Сервер прислал ресурспак')).length, 1);
  mgr.shutdown();
});

// ---------- экран бота: какой бот сейчас в мире (getBot и событие 'bot') ----------

function watchBot(mgr) {
  const seen = [];
  mgr.on('bot', (b) => seen.push(b));
  return seen;
}

test('экран бота: бот объявляется после появления в мире, «Стоп» сразу убирает его', async () => {
  const { mgr, bots } = setup();
  const seen = watchBot(mgr);
  assert.equal(mgr.getBot(), null);
  mgr.start();
  bots[0].emit('login');
  assert.equal(mgr.getBot(), null); // зашёл на сервер, но ещё не в мире
  bots[0].emit('spawn');
  assert.equal(mgr.getBot(), bots[0]);
  bots[0].emit('spawn'); // смена мира
  bots[0].emit('death');
  assert.equal(mgr.getBot(), bots[0]); // погибший бот всё ещё в мире
  bots[0].emit('spawn');
  assert.deepEqual(seen, [bots[0]]); // без повторов
  mgr.stop();
  assert.equal(mgr.getBot(), null); // ещё выходит, но для экрана его уже нет
  assert.deepEqual(seen, [bots[0], null]);
  await tick();
  assert.equal(mgr.state, 'offline');
  assert.deepEqual(seen, [bots[0], null]); // закрытие сессии не дублирует null
});

test('экран бота: кик и обрыв соединения убирают бота', () => {
  const kicked = setup();
  const seenKick = watchBot(kicked.mgr);
  kicked.mgr.start();
  goOnline(kicked.bots[0]);
  kicked.bots[0].emit('kicked', '{"text":"Bye"}', true);
  assert.equal(kicked.mgr.getBot(), kicked.bots[0]); // кик пришёл, а соединение ещё открыто
  kicked.bots[0].emit('end', 'socketClosed');
  assert.equal(kicked.mgr.getBot(), null);
  assert.deepEqual(seenKick, [kicked.bots[0], null]);

  const dropped = setup();
  const seenDrop = watchBot(dropped.mgr);
  dropped.mgr.start();
  goOnline(dropped.bots[0]);
  dropped.bots[0].emit('end', 'socketClosed');
  assert.equal(dropped.mgr.getBot(), null);
  assert.deepEqual(seenDrop, [dropped.bots[0], null]);
});

test('экран бота: после реконнекта объявляется новый бот', async () => {
  const { mgr, bots } = setup({ autoReconnect: true, reconnectDelay: 1 });
  const seen = watchBot(mgr);
  mgr.start();
  goOnline(bots[0]);
  bots[0].emit('end', 'socketClosed');
  assert.equal(mgr.state, 'reconnecting');
  assert.equal(mgr.getBot(), null);
  await sleep(1200);
  assert.equal(bots.length, 2);
  bots[1].emit('login');
  assert.equal(mgr.getBot(), null);
  bots[1].emit('spawn');
  assert.equal(mgr.getBot(), bots[1]);
  assert.deepEqual(seen, [bots[0], null, bots[1]]);
  mgr.stop();
  await tick();
  assert.deepEqual(seen, [bots[0], null, bots[1], null]);
});

test('экран бота: «осиротевший» бот и появление в мире во время остановки не объявляются', async () => {
  const { mgr, bots } = setup();
  const seen = watchBot(mgr);
  mgr.start();
  const old = bots[0];
  old.autoEndOnQuit = false;
  mgr.stop(); // ещё до входа
  await sleep(450); // сокет закрыт принудительно
  mgr.start();
  const fresh = bots[1];
  old.emit('login');
  old.emit('spawn');
  assert.equal(mgr.getBot(), null);

  fresh.autoEndOnQuit = false;
  fresh.emit('login');
  mgr.stop(); // «Стоп» уже нажат, а сервер успел прислать появление в мире
  fresh.emit('spawn');
  assert.equal(mgr.getBot(), null);
  mgr.shutdown();
  assert.deepEqual(seen, []);
});

test('экран бота: ошибка подписчика не ломает бота, при закрытии программы бот убирается', async () => {
  const { mgr, bots, logs } = setup({ loginPassword: 'pw' }, { joinFirst: 10 });
  const seen = watchBot(mgr);
  mgr.on('bot', (b) => {
    if (b) throw new Error('viewer boom');
  });
  mgr.start();
  goOnline(bots[0]);
  assert.equal(mgr.state, 'online');
  assert.ok(lines(logs).includes('error:Экран бота: viewer boom'));
  serverSays(bots[0], '| Авторизируйтесь » /login [пароль]');
  assert.deepEqual(bots[0].sent, ['/login pw']); // автовход всё равно работает
  mgr.shutdown();
  assert.equal(mgr.getBot(), null);
  assert.deepEqual(seen, [bots[0], null]);
});

// ---------- разбор текстов ----------

test('причина кика в формате NBT и с переводом', () => {
  const nbt = {
    type: 'compound',
    name: '',
    value: {
      text: { type: 'string', value: 'Banned' },
      extra: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: ' now' } }] } },
    },
  };
  assert.equal(chatToText(nbt), 'Banned now');
  assert.equal(chatToText(JSON.stringify(nbt)), 'Banned now');
  assert.equal(
    chatToText('{"translate":"multiplayer.disconnect.banned.reason","with":["spam"]}'),
    'Аккаунт забанен на этом сервере, причина: spam',
  );
  assert.equal(chatToText('{"translate":"disconnect.genericReason","with":["Сервер на техработах"]}'), 'Сервер на техработах');
  assert.equal(
    chatToText({ translate: 'disconnect.loginFailedInfo', with: [{ translate: 'disconnect.loginFailedInfo.invalidSession' }] }),
    'Не удалось войти: Недействительная сессия (войди в Microsoft заново)',
  );
  assert.equal(chatToText('§cПлохо §r\n'), 'Плохо');
  assert.equal(chatToText('plain text'), 'plain text');
  assert.equal(chatToText(undefined), '');
  assert.equal(chatToText({ text: 'x', extra: ['y', { text: 'z' }] }), 'xyz');
});

test('после каких киков переподключаться бессмысленно', () => {
  assert.equal(noRetryReason('{"translate":"multiplayer.disconnect.banned.reason","with":["x"]}'), 'аккаунт забанен');
  assert.equal(noRetryReason({ text: '', extra: [{ translate: 'multiplayer.disconnect.not_whitelisted' }] }), 'ника нет в белом списке');
  assert.equal(
    noRetryReason({ type: 'compound', name: '', value: { translate: { type: 'string', value: 'multiplayer.disconnect.ip_banned' } } }),
    'IP-адрес забанен',
  );
  assert.equal(noRetryReason('You are banned from this server!'), 'аккаунт забанен');
  assert.match(noRetryReason('{"translate":"multiplayer.disconnect.outdated_client","with":["1.21.4"]}'), /версия/);
  assert.equal(noRetryReason('{"text":"Сервер перезагружается"}'), null);
  assert.equal(noRetryReason('{"translate":"multiplayer.disconnect.idling"}'), null);
  assert.equal(noRetryReason(undefined), null);
});

test('пароли в командах скрываются', () => {
  assert.equal(maskSecrets('/login Secr3t'), '/login ••••');
  assert.equal(maskSecrets('/reg a b'), '/reg •••• ••••');
  assert.equal(maskSecrets('/L pass'), '/L ••••');
  assert.equal(maskSecrets('/login'), '/login');
  assert.equal(maskSecrets('/server survival'), '/server survival');
  assert.equal(maskSecrets('login secret'), 'login secret');
});

test('ошибки сети и причины разрыва', () => {
  assert.match(describeError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), /отклонил/);
  assert.match(describeError(Object.assign(new Error(''), { errors: [{ code: 'ENOTFOUND' }] })), /не найден/);
  assert.equal(describeError(new Error('boom')), 'boom');
  assert.match(describeEnd('socketClosed'), /закрыто/);
  assert.match(describeEnd(undefined), /закрыто/);
});

test('цвета чата: коды, hex и сброс', () => {
  const segs = parseMotd('§aHello §lworld§r!');
  assert.deepEqual(segs.map((s) => [s.text, s.color, s.bold]), [
    ['Hello ', '#55ff55', false],
    ['world', '#55ff55', true],
    ['!', null, false],
  ]);
  const bukkit = parseMotd('§x§f§f§0§0§0§0red§rplain');
  assert.deepEqual(bukkit.map((s) => [s.text, s.color]), [['red', '#ff0000'], ['plain', null]]);
  assert.deepEqual(parseMotd('a§zb').map((s) => s.text), ['ab']);
  assert.deepEqual(parseMotd('abc§').map((s) => s.text), ['abc§']);
  assert.deepEqual(parseMotd('').length, 0);
  const reset = parseMotd('§lBold§cRed');
  assert.equal(reset[1].bold, false); // цвет сбрасывает жирный, как в игре
  assert.equal(reset[1].color, '#ff5555');
});

test('hex-цвета из mineflayer (§#RRGGBB) не превращаются в мусор', () => {
  // Так prismarine-chat отдаёт градиентные префиксы: раньше в чате было «FF8800[Админ]».
  const segs = parseMotd('§#FF8800[Админ] §#33CCFFSteve§r: hi');
  assert.deepEqual(segs.map((s) => [s.text, s.color]), [
    ['[Админ] ', '#ff8800'],
    ['Steve', '#33ccff'],
    [': hi', null],
  ]);
  assert.equal(parseMotd('§#12zzzzbad').map((s) => s.text).join(''), '12zzzzbad'); // не hex — не цвет
});

test('слишком тёмные цвета осветляются, нормальные не меняются', () => {
  assert.equal(readableHex('ff0000'), '#ff0000');
  assert.equal(readableHex('55ff55'), '#55ff55');
  const dark = readableHex('000080');
  assert.notEqual(dark, '#000080');
  const n = parseInt(dark.slice(1), 16);
  assert.ok(((n >> 16) & 255) > 60 && (n & 255) > 128);
});

// ---------- настройки ----------

test('настройки: разбор и проверка', () => {
  assert.deepEqual(sanitize({ host: ' mineblaze.net:25570 ', port: '25565' }), { host: 'mineblaze.net', port: 25570 });
  assert.deepEqual(sanitize({ port: '99999', reconnectDelay: '0', auth: 'hack', autoReconnect: 'yes' }), {});
  assert.deepEqual(sanitize({ reconnectDelay: '12', auth: 'microsoft', autoReconnect: true }), {
    reconnectDelay: 12, auth: 'microsoft', autoReconnect: true,
  });
  assert.deepEqual(sanitize({ loginPassword: ' p w \n', joinCommands: 'a\r\nb' }), { loginPassword: 'p w', joinCommands: 'a\nb' });
  assert.deepEqual(sanitize({ liveBackground: false }), { liveBackground: false }, 'живой фон можно выключить');
  assert.deepEqual(sanitize({ liveBackground: 'да' }), {}, 'не да/нет — не принимается');
  assert.equal(DEFAULT_CONFIG.liveBackground, true, 'по умолчанию живой фон включён');
  assert.deepEqual(sanitize(null), {});
  assert.equal(validate({ ...DEFAULT_CONFIG }), null);
  assert.equal(validate({ ...DEFAULT_CONFIG, host: '' }), 'Не указан адрес сервера');
  assert.match(validate({ ...DEFAULT_CONFIG, host: 'http://mineblaze.net' }), /Адрес сервера указан неверно/);
  assert.equal(validate({ ...DEFAULT_CONFIG, username: '' }), 'Не указан ник бота');
  for (const bad of ['ab', 'Слишком', 'with space', 'a'.repeat(17)]) {
    assert.match(validate({ ...DEFAULT_CONFIG, username: bad }), /3–16 символов/, bad);
  }
  assert.equal(validate({ ...DEFAULT_CONFIG, username: 'Bot_2024' }), null);
  assert.equal(validate({ ...DEFAULT_CONFIG, auth: 'microsoft', username: 'me@outlook.com' }), null);
  assert.equal(validate({ ...DEFAULT_CONFIG, auth: 'microsoft', username: '' }), 'Не указана почта Microsoft-аккаунта');
});

test('настройки: список ботов — «ник», «ник:пароль», «ник пароль»; ошибки с номером строки; старый «Ник бота» — один бот', () => {
  const { accounts, errors } = parseAccounts('Farm01:pass1\nFarm02 pass 2\n\n# комментарий\nFarm03\nfarm01:dup\nab\nFarm04 ; p4');
  assert.deepEqual(accounts, [
    { username: 'Farm01', password: 'pass1' },
    { username: 'Farm02', password: 'pass 2' },
    { username: 'Farm03', password: '' },
    { username: 'Farm04', password: 'p4' },
  ]);
  assert.deepEqual(errors, [
    'Боты, строка 6: «farm01» — этот бот уже есть выше',
    'Боты, строка 7: «ab» — ник должен быть длиной 3–16 символов: латинские буквы, цифры и «_»',
  ]);
  assert.match(validate({ ...DEFAULT_CONFIG, accounts: 'Farm01\nab' }), /строка 2: «ab» — ник должен быть длиной 3–16 символов/);
  assert.equal(validate({ ...DEFAULT_CONFIG, accounts: 'Farm01\nFarm02:x' }), null);
  assert.equal(validate({ ...DEFAULT_CONFIG, accounts: '# только комментарий', username: '' }), 'Не указан ник бота');
  assert.deepEqual(accountsOf({ accounts: '', username: 'Solo' }).accounts, [{ username: 'Solo', password: '' }]);
  assert.deepEqual(accountsOf({ accounts: ' \n', username: 'Solo' }).accounts, [{ username: 'Solo', password: '' }]);
  assert.deepEqual(parseAccounts('me@outlook.com', { auth: 'microsoft' }).accounts, [{ username: 'me@outlook.com', password: '' }]);
  const many = parseAccounts(Array.from({ length: MAX_ACCOUNTS + 5 }, (_, i) => `Bot${i}`).join('\n'));
  assert.equal(many.accounts.length, MAX_ACCOUNTS);
  assert.deepEqual(many.errors, [`Ботов больше ${MAX_ACCOUNTS} — столько не запустить: убери лишние`]);
  assert.deepEqual(sanitize({ startInterval: '3', viewDistance: '1', botsPerProcess: '25', accounts: 'a\r\nb' }), { startInterval: 3, accounts: 'a\nb' });
  assert.deepEqual(sanitize({ viewDistance: '6', botsPerProcess: '10' }), { viewDistance: 6, botsPerProcess: 10 });
});

test('настройки: режим экрана бота', () => {
  assert.equal(DEFAULT_CONFIG.viewerMode, 'first');
  assert.deepEqual(sanitize({ viewerMode: 'third' }), { viewerMode: 'third' });
  assert.deepEqual(sanitize({ viewerMode: 'first' }), { viewerMode: 'first' });
  for (const bad of ['side', 'THIRD', ' third', '', 1, true, null, {}]) {
    assert.deepEqual(sanitize({ viewerMode: bad }), {}, String(bad));
  }
});

test('команды после входа: пустые строки и лишнее отбрасываются', () => {
  assert.deepEqual(parseJoinCommands(' /a \n\n/b\n'), ['/a', '/b']);
  assert.deepEqual(parseJoinCommands(''), []);
  assert.equal(parseJoinCommands(Array.from({ length: 30 }, (_, i) => `/c${i}`).join('\n')).length, 10);
  assert.equal(parseJoinCommands('x'.repeat(500))[0].length, 256);
});

// ---------- ссылки от сервера (браузерная проверка «я не робот» и т.п.) ----------

const { extractLinks } = require(path.join(SRC, 'chat-utils.js'));

test('ссылки: обычный текст, скрытые в clickEvent / click_event, NBT, §-коды и знаки препинания', () => {
  assert.deepEqual(extractLinks('Перейди: https://check.example.ru/v?id=42.'), ['https://check.example.ru/v?id=42']);
  // Кликабельный текст «[НАЖМИ]»: адрес есть только в событии клика
  const legacy = { text: '', extra: [{ text: 'Пройди проверку: ' }, { text: '[НАЖМИ]', clickEvent: { action: 'open_url', value: 'https://a.example/verify' } }] };
  assert.deepEqual(extractLinks(legacy), ['https://a.example/verify']);
  const modern = { text: '[Проверка]', click_event: { action: 'open_url', url: 'https://b.example/x' } }; // 1.21.5+
  assert.deepEqual(extractLinks(modern), ['https://b.example/x']);
  // JSON-строка (причина кика в старых версиях), в том числе с экранированными слешами
  assert.deepEqual(extractLinks('{"text":"go","clickEvent":{"action":"open_url","value":"https:\/\/c.example\/p"}}'), ['https://c.example/p']);
  // NBT (1.20.3+)
  const nbt = { type: 'compound', value: { text: { type: 'string', value: '§cПроверка: §ehttps://d.example/q§r (5 минут)' } } };
  assert.deepEqual(extractLinks(nbt), ['https://d.example/q']);
  // Повторы и не-ссылки
  assert.deepEqual(extractLinks(['https://e.example', 'https://e.example', 'ftp://x', 'нет ссылки']), ['https://e.example']);
  assert.deepEqual(extractLinks(Buffer.from('https://f.example')), [], 'буферы не читаем');
  assert.deepEqual(extractLinks(null), []);
  const loop = { a: 'https://g.example/1' };
  loop.self = loop;
  assert.deepEqual(extractLinks(loop), ['https://g.example/1'], 'циклические ссылки не вешают обход');
});

function withPacketClient(bot) {
  // У настоящего mineflayer bot._client — EventEmitter протокола; у FakeBot его нет
  const client = new EventEmitter();
  client.socket = bot._client.socket;
  bot._client = client;
  return client;
}

test('ссылка в окне сервера, заголовке и причине кика попадает в консоль и событие link', () => {
  const links = [];
  const { mgr, bots, logs } = setup({}, {});
  mgr.on('link', (l) => links.push(l));
  const origCreate = mgr._createBot;
  mgr._createBot = (opts) => { const b = origCreate(opts); withPacketClient(b); return b; };
  mgr.start();
  const client = bots[0]._client;
  client.emit('packet', { dialog: { type: 'notice', body: [{ text: 'Подтверди, что ты не робот' }], action: { action: { type: 'open_url', url: 'https://verify.example/abc' } } } }, { name: 'show_dialog', state: 'configuration' });
  client.emit('packet', { text: '{"text":"Проверка: https://verify.example/abc"}' }, { name: 'set_title_text', state: 'play' }); // та же — без повтора
  client.emit('packet', { chunkData: 'https://junk.example' }, { name: 'map_chunk', state: 'play' }); // тяжёлые пакеты не смотрим
  client.emit('packet', { url: 'https://pack.example/rp.zip' }, { name: 'add_resource_pack', state: 'play' }); // адрес ресурспака — не для человека
  client.emit('packet', { reason: { text: 'Вы не прошли проверку', clickEvent: { action: 'open_url', value: 'https://verify.example/retry' } } }, { name: 'disconnect', state: 'login' });
  assert.deepEqual(links.map((l) => [l.url, l.source]), [
    ['https://verify.example/abc', 'окно сервера'],
    ['https://verify.example/retry', 'причина кика'],
  ]);
  const linkLines = lines(logs).filter((l) => l.includes('Ссылка от сервера'));
  assert.deepEqual(linkLines, [
    'warn:Ссылка от сервера (окно сервера): https://verify.example/abc',
    'warn:Ссылка от сервера (причина кика): https://verify.example/retry',
  ]);
  mgr.shutdown();
});

test('ссылки в чате: скрытые показываются у сообщения и в консоли, до появления в мире — все', () => {
  const links = [];
  const { mgr, bots, chats } = setup();
  mgr.on('link', (l) => links.push(l.url));
  mgr.start();
  const bot = bots[0];
  const msg = (text, json) => ({ toString: () => text, toMotd: () => text, json });
  // До появления в мире: и видимая, и скрытая ссылка — в консоль
  bot.emit('message', msg('Пройди проверку: https://v.example/1', { text: 'Пройди проверку: https://v.example/1' }), 'system');
  bot.emit('message', msg('[НАЖМИ]', { text: '[НАЖМИ]', clickEvent: { action: 'open_url', value: 'https://v.example/2' } }), 'system');
  // Надпись над хотбаром: в чат не идёт, ссылка — в консоль
  bot.emit('message', msg('Ссылка: https://v.example/3', { text: 'Ссылка: https://v.example/3' }), 'game_info');
  goOnline(bot);
  // В мире: видимую ссылку игрока в консоль не дублируем, скрытую — показываем
  bot.emit('message', msg('<Steve> смотри https://ads.example', { text: '<Steve> смотри https://ads.example' }), 'chat');
  bot.emit('message', msg('[Сайт]', { text: '[Сайт]', click_event: { action: 'open_url', url: 'https://v.example/4' } }), 'system');
  assert.deepEqual(links, ['https://v.example/1', 'https://v.example/2', 'https://v.example/3', 'https://v.example/4']);
  const shown = chats.filter((c) => c.position !== 'self');
  assert.deepEqual(shown.map((c) => [c.text, c.links]), [
    ['Пройди проверку: https://v.example/1', ['https://v.example/1']],
    ['[НАЖМИ]', ['https://v.example/2']],
    ['<Steve> смотри https://ads.example', ['https://ads.example']],
    ['[Сайт]', ['https://v.example/4']],
  ]);
  mgr.shutdown();
});

test('ссылки из пакетов старого бота после переподключения не показываются', () => {
  const links = [];
  const { mgr, bots } = setup();
  mgr.on('link', (l) => links.push(l.url));
  const origCreate = mgr._createBot;
  mgr._createBot = (opts) => { const b = origCreate(opts); withPacketClient(b); return b; };
  mgr.start();
  const old = bots[0];
  mgr.stop();
  old.emit('end', 'socketClosed');
  old._client.emit('packet', { reason: 'https://late.example' }, { name: 'kick_disconnect', state: 'play' });
  assert.deepEqual(links, []);
});

// ---------- бот как обычный клиент, журнал пакетов, возврат в лобби ----------

const fs = require('node:fs');
const os = require('node:os');
const { forcedMoveReason } = require(path.join(SRC, 'chat-utils.js'));

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mbp-test-'));
}

/** Клиент протокола, который пишет отправленное в client.sent (у FakeBot своего нет). */
function withWritingClient(mgr) {
  const origCreate = mgr._createBot;
  mgr._createBot = (opts) => {
    const b = origCreate(opts);
    const client = withPacketClient(b);
    client.state = 'play';
    client.sent = [];
    client.write = (name, params) => client.sent.push([name, params]);
    return b;
  };
}

test('строка с «#» — команда боту: на сервер не уходит, видна в чате, ответ — в консоли', async () => {
  const { mgr, bots, logs, chats } = setup();
  mgr.start();
  goOnline(bots[0]);
  assert.equal(mgr.say('#pos'), true);
  await tick();
  assert.deepEqual(bots[0].sent, [], 'в чат сервера ничего не ушло');
  assert.deepEqual(chats.filter((c) => c.position === 'self').map((c) => c.text), ['› #pos']);
  assert.ok(lines(logs).includes('warn:Команда не выполнена: бот не в мире'), 'у подделки нет мира — честно об этом');
  mgr.shutdown();
});

test('опции бота: своя физика, настройки и бренд как у обычного клиента; без исправлений — чистый mineflayer', () => {
  const { mgr, bots } = setup();
  mgr.start();
  const o = bots[0].opts;
  assert.equal(typeof o.plugins.physics, 'function', 'своя физика вместо встроенной');
  assert.equal(typeof o.plugins.actions, 'function', 'безопасные действия');
  assert.equal(typeof o.plugins.settings, 'function', 'настройки не отправляются после каждого входа в мир');
  assert.equal(typeof o.plugins.windowClicks, 'function', 'клики в меню с настоящими отпечатками предметов');
  assert.equal(o.brand, 'vanilla');
  assert.equal(o.clientSettings.locale, 'ru_ru');
  mgr.shutdown();

  const legacy = setup({}, {}, { compat: { physics: false, tickEnd: false, profile: false, clicks: false } });
  legacy.mgr.start();
  const lo = legacy.bots[0].opts;
  assert.equal(lo.plugins, undefined);
  assert.equal(lo.brand, undefined);
  assert.equal(lo.clientSettings, undefined);
  legacy.mgr.shutdown();
});

test('сторож тишины: отличает «сервер молчит» от «бот не разбирает пришедшее»', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000000 });
  const bots = [];
  const mgr = new BotManager({
    config: { host: 'h', port: 1, username: 'Bot', version: '1.21.11', auth: 'offline', autoReconnect: false },
    authCacheDir: '/tmp/auth',
    createBot: (opts) => {
      const b = new FakeBot(opts);
      const client = new EventEmitter();
      client.socket = { bytesRead: 0, destroy: () => {} };
      b._client = client;
      bots.push(b);
      return b;
    },
  });
  const logs = [];
  mgr.on('log', (e) => logs.push(e));
  mgr.start();
  const bot = bots[0];
  const client = bot._client;
  goOnline(bot);
  const packet = () => client.emit('packet', {}, { name: 'keep_alive', state: 'play' });
  const seconds = (n) => {
    for (let i = 0; i < n; i += 1) t.mock.timers.tick(1000); // по секунде: так часы и сторож идут вместе
  };

  packet();
  seconds(3);
  assert.ok(!lines(logs).some((l) => l.includes('ничего не приходит')), '3 с — ещё не тишина');
  seconds(1);
  assert.ok(lines(logs).includes('warn:От сервера 4 с ничего не приходит'));

  client.socket.bytesRead += 5000; // байты есть, а пакетов нет
  seconds(1);
  assert.ok(lines(logs).some((l) => l.startsWith('error:Данные от сервера приходят, но бот перестал их разбирать')));

  packet();
  assert.ok(lines(logs).includes('info:Сервер снова на связи (молчал 5.0 с)'));

  // Снова тишина, но на этот раз сервер правда ничего не шлёт — и соединение закрывается.
  seconds(6);
  bot.emit('end', 'socketClosed');
  assert.ok(lines(logs).includes('warn:Перед обрывом сервер ничего не присылал (молчал сам)'));
  assert.equal(mgr.state, 'offline');
});

test('охрана и режим бога в менеджере: /god после входа; /home → тихий /near → чужой → /spawn', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000000 });
  const { mgr, bots, logs, chats } = setup({ whitelist: 'Friend' });
  mgr.start();
  const bot = bots[0];
  goOnline(bot);
  const seconds = (n) => {
    for (let i = 0; i < n; i += 1) t.mock.timers.tick(1000);
  };
  const msg = (text) => bot.emit('message', { toString: () => text, toMotd: () => text }, 'system');

  // Команд входа нет: режим бога — через 1,5 + 4 с после появления в мире.
  seconds(6);
  assert.deepEqual(bot.sent, ['/god']);
  msg('| Режим бога включен!');
  assert.ok(lines(logs).includes('ok:Режим бога включён'));

  assert.equal(mgr.say('/home home'), true);
  bot.emit('forcedMove'); // сервер перенёс бота на дом
  seconds(2);
  assert.deepEqual(bot.sent.slice(-2), ['/home home', '/near']);
  assert.equal(chats.filter((c) => c.text === '› /near').length, 0, '/near охраны в чат панели не пишется');
  assert.equal(chats.filter((c) => c.text === '› /home home').length, 1, 'а свою команду человек видит');

  msg('| Окружающие игроки: никого');
  msg('| Окружающие игроки: никого');
  assert.equal(chats.filter((c) => c.text === '| Окружающие игроки: никого').length, 2, 'каждый ответ /near виден в чате — охрана работает');
  msg('| Окружающие игроки: [Ender] friend(8m)');
  assert.equal(bot.sent.at(-1), '/near');

  msg('| Окружающие игроки: [Игрок] Stranger(30m)');
  assert.equal(bot.sent.at(-1), '/spawn');
  assert.ok(lines(logs).includes('warn:Охрана: рядом чужой — Stranger (30 м). Ухожу на спавн (/spawn)'));
  assert.ok(!lines(logs).some((l) => l.startsWith('info:Охрана выключена')), 'выключится, только когда бот правда на спавне');

  // Сервер перенёс бота в мир спавна — охрана выключилась и молчит.
  bot.worldName = 'lobby';
  bot.emit('respawn');
  assert.ok(lines(logs).includes('info:Охрана выключена: бот на спавне'));
  const sentAfter = bot.sent.length;
  seconds(15);
  assert.equal(bot.sent.length, sentAfter, 'на спавне охрана молчит');
  mgr.shutdown();
});

test('очередь команд: не чаще раза в 1,5 с — /spawn охраны за /near не теряется; срочное — вперёд, повтор не копится', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000000 });
  const { mgr, bots, logs, chats } = setup({ whitelist: '', godMode: false }, { commandGap: 1500 });
  mgr.start();
  const bot = bots[0];
  goOnline(bot);
  const ms = (n) => {
    for (let i = 0; i < n; i += 100) t.mock.timers.tick(100);
  };
  const msg = (text) => bot.emit('message', { toString: () => text, toMotd: () => text }, 'system');

  // Человек пишет две команды подряд: вторая ждёт 1,5 с, а в чате панели видна, когда правда ушла.
  assert.equal(mgr.say('/rtp'), true);
  assert.equal(mgr.say('/sethome home'), true);
  assert.deepEqual(bot.sent, ['/rtp']);
  assert.ok(!chats.some((c) => c.text === '› /sethome home'));
  ms(1400);
  assert.deepEqual(bot.sent, ['/rtp']);
  ms(100);
  assert.deepEqual(bot.sent, ['/rtp', '/sethome home']);
  assert.ok(chats.some((c) => c.text === '› /sethome home'));

  // /rtp сработал: другой мир — охрана включилась, /near — через 1,5 с после телепорта.
  bot.worldName = 'world';
  bot.emit('respawn');
  ms(1500);
  assert.equal(bot.sent.at(-1), '/near');
  // Ответ пришёл сразу — чужой. Как на MineBlaze 4 ноября: /spawn сразу за /near сервер молча пропускал.
  msg('| Окружающие игроки: [Игрок] kakajamba(0m)');
  assert.equal(bot.sent.at(-1), '/near', '/spawn ждёт: 1,5 с после /near ещё не прошли');
  mgr.say('/god'); // человек тоже что-то пишет — срочный /spawn охраны всё равно первый
  ms(1500);
  assert.deepEqual(bot.sent.slice(-1), ['/spawn']);
  ms(1500);
  assert.deepEqual(bot.sent.slice(-2), ['/spawn', '/god']);
  assert.ok(lines(logs).includes('warn:Охрана: рядом чужой — kakajamba (0 м). Ухожу на спавн (/spawn)'));

  // Сервер /spawn пропустил: телепорта нет — через 4 с после него охрана пишет /spawn ещё раз.
  ms(2400);
  assert.equal(bot.sent.filter((c) => c === '/spawn').length, 1);
  ms(100);
  assert.equal(bot.sent.filter((c) => c === '/spawn').length, 2);
  assert.ok(lines(logs).includes('warn:Охрана: телепорта на спавн нет — /spawn ещё раз (попытка 2)'));
  bot.worldName = 'lobby';
  bot.emit('respawn');
  assert.ok(lines(logs).includes('info:Охрана выключена: бот на спавне'));
  ms(20000);
  assert.equal(bot.sent.filter((c) => c === '/spawn').length, 2, 'на спавне — тишина');
  assert.ok(!bot.sent.slice(bot.sent.lastIndexOf('/spawn')).includes('/near'));
  mgr.shutdown();
});

test('очередь команд: одинаковые не копятся, ненужные не уходят, при переходе на другой сервер ждут', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: 1000000 });
  const { mgr, bots } = setup({ godMode: false }, { commandGap: 1500 });
  mgr.start();
  const bot = bots[0];
  goOnline(bot);
  const s = mgr.cur;
  mgr.say('/a');
  mgr._send(s, '/near', { quiet: true, key: 'near' });
  mgr._send(s, '/near', { quiet: true, key: 'near' });
  mgr._send(s, '/x', { check: () => false });
  mgr._send(s, '/b');
  t.mock.timers.tick(1500);
  t.mock.timers.tick(1500);
  t.mock.timers.tick(1500);
  assert.deepEqual(bot.sent, ['/a', '/near', '/b'], 'второй /near заменил первый, /x уже не нужен');

  // Прокси переводит бота на другой сервер: команда ждёт, пока переход не закончится.
  mgr._send(s, '/c');
  assert.deepEqual(bot.sent.slice(-1), ['/c'], 'очередь пуста и пауза прошла — сразу');
  s.switching = true;
  mgr.say('/d');
  t.mock.timers.tick(3000);
  assert.deepEqual(bot.sent.slice(-1), ['/c']);
  s.switching = false;
  t.mock.timers.tick(500);
  assert.deepEqual(bot.sent.slice(-1), ['/d']);

  // Часы Windows перевели на час назад: очередь не встаёт на час.
  t.mock.timers.tick(1500);
  s.lastSentAt = Date.now() + 3600 * 1000;
  mgr.say('/e');
  assert.deepEqual(bot.sent.slice(-1), ['/e']);
  mgr.shutdown();
});

test('возврат в лобби: причина из сообщения прокси', () => {
  assert.equal(forcedMoveReason('| Ты перемещен в лобби ▸ Подозрение в использовании читов'), 'Подозрение в использовании читов');
  assert.equal(forcedMoveReason('§cВы были перемещёны в лобби: §fAFK'), 'AFK');
  assert.equal(forcedMoveReason('You were kicked from g5: Cheating'), 'g5: Cheating');
  assert.equal(forcedMoveReason('You have been moved to the lobby'), 'You have been moved to the lobby', 'без причины — весь текст');
  assert.equal(forcedMoveReason('Добро пожаловать на сервер'), null);
  assert.equal(forcedMoveReason(''), null);
  assert.equal(forcedMoveReason(undefined), null);
});

test('возврат в лобби: строка в консоли и журнал в файл; повтор и чат игроков не считаются', () => {
  const dir = tmpDir();
  const { mgr, bots, logs } = setup({}, {}, { journalDir: dir });
  mgr.start();
  const bot = bots[0];
  goOnline(bot);
  const msg = (text) => ({ toString: () => text, toMotd: () => text, json: { text } });
  bot.emit('message', msg('<Steve> меня перемещен в лобби, лол'), 'chat'); // игрок — не считается
  bot.emit('message', msg('| Ты перемещен в лобби ▸ Подозрение в использовании читов'), 'system');
  bot.emit('message', msg('| Ты перемещен в лобби ▸ Подозрение в использовании читов'), 'system'); // повтор
  const t = lines(logs);
  assert.deepEqual(t.filter((x) => x.includes('в лобби')), ['kick:Сервер вернул бота в лобби: Подозрение в использовании читов']);
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  assert.match(files[0], /^packets-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/);
  const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.match(text, /возврат в лобби: Подозрение в использовании читов/);
  assert.match(text, /Сервер: h:25565/);
  assert.ok(t.includes(`info:Журнал пакетов сохранён: ${path.join(dir, files[0])}`));
  assert.equal(mgr.state, 'online', 'соединение не рвётся');
  mgr.shutdown();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('переход на другой сервер и бренд сервера видны в консоли', () => {
  const { mgr, bots, logs } = setup();
  withWritingClient(mgr);
  mgr.start();
  const bot = bots[0];
  const client = bot._client;
  client.emit('minecraft:brand', '§6Velocity');
  goOnline(bot);
  client.emit('minecraft:brand', 'Velocity'); // тот же — без повтора
  client.emit('start_configuration');
  client.emit('minecraft:brand', 'Paper');
  bot.emit('login');
  const t = lines(logs);
  assert.deepEqual(t.filter((x) => /Сервер|сервер/.test(x) && !x.includes('Подключение')), [
    'info:Сервер: Velocity',
    'ok:Подключен: вход на сервер выполнен',
    'info:Сервер переводит бота на другой сервер…',
    'info:Сервер: Paper',
    'ok:Переход на другой сервер выполнен',
  ]);
  mgr.shutdown();
});

test('кик: журнал пакетов в файле, пароль из /login в него не попадает; «Стоп» журнал не сохраняет', () => {
  const dir = tmpDir();
  const { mgr, bots, logs } = setup({}, {}, { journalDir: dir });
  withWritingClient(mgr);
  mgr.start();
  const bot = bots[0];
  const client = bot._client;
  goOnline(bot);
  client.emit('packet', { x: 1, y: 64, z: 2 }, { name: 'position', state: 'play' }, Buffer.alloc(40));
  client.write('chat_command', { command: 'login Secret123', timestamp: 1n, salt: 0n, argumentSignatures: [] });
  client.write('tick_end', {});
  bot.emit('kicked', '{"text":"Подозрение в читах"}', true);
  bot.emit('end', 'socketClosed');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(dir, files[0]), 'utf8');
  assert.match(text, /кик: Подозрение в читах/);
  assert.match(text, /← {2}play {10}position {2}40 Б/);
  assert.match(text, /chat_command {2}\{"command":"login ••••"/);
  assert.ok(!text.includes('Secret123'), 'пароль не попал в журнал');
  assert.match(text, /# {2}Кик: Подозрение в читах/);
  assert.ok(lines(logs).some((x) => x.startsWith('info:Журнал пакетов сохранён:')));

  // Ручная остановка — это не проблема, журнал не нужен.
  mgr.start();
  goOnline(bots[1]);
  mgr.stop();
  bots[1].emit('end', 'disconnect.quitting');
  assert.equal(fs.readdirSync(dir).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('только через прокси: бот без прокси не подключается — ни при старте, ни при переподключении; с прокси — входит', () => {
  const { mgr, bots, logs } = setup({ proxyOnly: true });
  assert.equal(mgr.start(), false);
  assert.equal(mgr.state, 'offline');
  assert.equal(bots.length, 0, 'createBot не вызывался — соединения не было');
  assert.ok(lines(logs).some((t) => /^error:Нет прокси — с IP компьютера не вхожу \(включено «Только через прокси»\)/.test(t)));

  const withProxy = setup({ proxyOnly: true }, {}, { proxy: { host: '10.0.0.1', port: 1080, username: 'u', password: 'p' } });
  assert.equal(withProxy.mgr.start(), true);
  assert.equal(withProxy.bots.length, 1, 'с прокси — подключается');
  assert.equal(typeof withProxy.bots[0].opts.connect, 'function', 'и само подключение — через прокси');
  // Прокси пропал (например, убрали из пула) — переподключение не пойдёт с IP компьютера.
  withProxy.mgr.proxy = null;
  withProxy.mgr._connect();
  assert.equal(withProxy.mgr.state, 'offline');
  assert.equal(withProxy.bots.length, 1, 'второго подключения не было');
  assert.equal(withProxy.mgr.wantRun, false);
});
