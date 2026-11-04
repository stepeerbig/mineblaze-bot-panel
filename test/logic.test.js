'use strict';

// Запуск: npm test (или node --test). Сеть и сервер Minecraft не нужны: вместо mineflayer — подделка FakeBot.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const EventEmitter = require('node:events');

const SRC = path.join(__dirname, '..', 'src');
const { BotManager } = require(path.join(SRC, 'bot-manager.js'));
const { chatToText, describeError, describeEnd, noRetryReason, maskSecrets } = require(path.join(SRC, 'chat-utils.js'));
const { parseMotd, readableHex } = require(path.join(SRC, 'renderer', 'motd.js'));
const { sanitize, validate, parseJoinCommands, DEFAULT_CONFIG } = require(path.join(SRC, 'config.js'));

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
    timings,
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

test('автовход: /login и команды после появления, пароль нигде не виден', async () => {
  const { mgr, bots, logs, chats } = setup(
    { loginPassword: 'Secr3t', joinCommands: '/server survival\n\n  /home  \n' },
    { joinFirst: 10, joinStep: 10 },
  );
  mgr.start();
  goOnline(bots[0]);
  assert.deepEqual(bots[0].sent, []); // сначала пауза
  await sleep(100);
  assert.deepEqual(bots[0].sent, ['/login Secr3t', '/server survival', '/home']);
  const t = lines(logs);
  assert.ok(t.includes('info:Автовход: /login ••••'));
  assert.ok(t.includes('info:Команда после входа: /server survival'));
  const everything = JSON.stringify([logs, chats]);
  assert.ok(!everything.includes('Secr3t'));

  // После смерти и возрождения команды повторно не отправляются.
  bots[0].emit('death');
  bots[0].emit('spawn');
  await sleep(60);
  assert.equal(bots[0].sent.length, 3);
  mgr.shutdown();
});

test('автовход отменяется, если бот отключился раньше', async () => {
  const { mgr, bots } = setup({ loginPassword: 'pw' }, { joinFirst: 40 });
  mgr.start();
  goOnline(bots[0]);
  bots[0].emit('end', 'socketClosed');
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
  await sleep(40);
  assert.deepEqual(bots[0].sent, ['/login pw']); // автовход всё равно отправлен
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
  assert.ok(lines(logs).includes('info:Охрана выключена: бот ушёл на спавн'));
  const sentAfter = bot.sent.length;
  seconds(15);
  assert.equal(bot.sent.length, sentAfter, 'на спавне охрана молчит');
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
