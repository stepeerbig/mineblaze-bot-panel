'use strict';

// Модули src/bot: журнал пакетов, профиль клиента и физика. Сеть и сервер не нужны:
// физика работает на поддельном боте с настоящими блоками 1.21.11 и подменённым временем.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { Vec3 } = require('vec3');
const { createSerializer, states } = require('minecraft-protocol');

const SRC = path.join(__dirname, '..', 'src', 'bot');
const { PacketJournal, saveJournal, compact } = require(path.join(SRC, 'packet-journal.js'));
const { applyClientProfile, settingsPlugin, profileOptions, encodeString } = require(path.join(SRC, 'client-profile.js'));
const { createPhysicsPlugin, MAX_CATCHUP_TICKS, MOUSE_STEP, TURN_SPEED } = require(path.join(SRC, 'physics.js'));

// ---------- журнал пакетов ----------

function journalWithClock(opts = {}) {
  let now = 1000;
  const journal = new PacketJournal({ now: () => now, ...opts });
  const client = new EventEmitter();
  client.state = 'play';
  client.sent = [];
  client.write = (name, params) => client.sent.push([name, params]);
  journal.attach(client);
  return { journal, client, at: (ms) => { now = ms; } };
}

test('журнал: входящие и исходящие пакеты, размер, подробности и отметки', () => {
  const { journal, client, at } = journalWithClock({ getSelfId: () => 7 });
  client.emit('packet', { teleportId: 1, x: 0.5 }, { name: 'position', state: 'play' }, Buffer.alloc(33));
  client.emit('packet', { entityId: 9, velocityX: 1 }, { name: 'entity_velocity', state: 'play' }, Buffer.alloc(9)); // чужая сущность
  client.emit('packet', { entityId: 7, velocityX: 2 }, { name: 'entity_velocity', state: 'play' }, Buffer.alloc(9)); // своя
  at(1010);
  client.write('position_look', { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, flags: { onGround: false } });
  client.write('chat_command', { command: 'register pass1 pass1' });
  client.write('chat_message', { message: '/l secret' });
  journal.mark('Кик: тест');
  assert.equal(client.sent.length, 3, 'пакеты уходят дальше без изменений');
  assert.equal(client.sent[1][1].command, 'register pass1 pass1', 'маскируется только запись в журнале');

  const e = journal.entries();
  assert.deepEqual(e.map((x) => [x.dir, x.name]), [
    ['in', 'position'], ['in', 'entity_velocity'], ['in', 'entity_velocity'],
    ['out', 'position_look'], ['out', 'chat_command'], ['out', 'chat_message'], ['mark', 'Кик: тест'],
  ]);
  assert.equal(e[0].size, 33);
  assert.deepEqual(e[0].data, { teleportId: 1, x: 0.5 });
  assert.equal(e[1].data, undefined, 'про чужие сущности — только имя и размер');
  assert.deepEqual(e[2].data, { entityId: 7, velocityX: 2 });
  assert.equal(e[4].data.command, 'register •••• ••••');
  assert.equal(e[5].data.message, '/l ••••');
});

test('журнал: хранит только последнюю минуту и не больше заданного числа записей', () => {
  const { journal, client, at } = journalWithClock({ keepMs: 60000, maxEntries: 100 });
  for (let i = 0; i < 50; i += 1) client.write('tick_end', {});
  at(70000);
  client.write('position', { x: 1 });
  assert.deepEqual(journal.entries().map((x) => x.name), ['position'], 'старые записи (старше минуты) не показываются');
  for (let i = 0; i < 300; i += 1) client.write('tick_end', {});
  journal._prune();
  assert.ok(journal._entries.length <= 100);
});

test('журнал: сколько пакетов в секунду и насколько ровно шли тики', () => {
  const { journal, client, at } = journalWithClock();
  // 2 секунды: tick_end каждые 50 мс, одна пауза 120 мс и одна пачка из двух тиков подряд
  let t = 1000;
  const times = [];
  for (let i = 0; i < 40; i += 1) {
    t += i === 10 ? 120 : i === 20 ? 0 : 50;
    times.push(t);
  }
  for (const time of times) {
    at(time);
    client.write('tick_end', {});
  }
  at(t);
  client.write('position', {});
  const st = journal.stats({ sinceMs: 1000 });
  assert.ok(Math.abs(st.seconds - (t - 1000) / 1000) < 1e-9);
  const tickRow = st.out.find((r) => r.name === 'tick_end');
  assert.equal(tickRow.count, 40);
  assert.equal(st.ticks.count, 40);
  assert.equal(st.ticks.maxMs, 120);
  assert.equal(st.ticks.minMs, 0);
  assert.equal(st.ticks.over70, 1);
  assert.equal(st.ticks.under5, 1);
  const text = journal.format({ reason: 'проверка', meta: { Сервер: 'h:1' } });
  assert.match(text, /^Журнал пакетов MineBlaze Bot Panel\nСохранён: \d{4}-\d{2}-\d{2} [\d:.]+ — проверка\nСервер: h:1\n/);
  assert.match(text, /tick_end +40 +\d+\.\d\d в секунду/);
  assert.match(text, /Промежутки между tick_end: в среднем [\d.]+ мс, от 0\.0 до 120\.0 мс; длиннее 70 мс: 1, пачкой \(меньше 5 мс\): 1/);
});

test('журнал: файл с понятным именем, старые файлы сверх лимита удаляются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbp-journal-'));
  const { journal, client } = journalWithClock();
  client.write('tick_end', {});
  const files = [];
  for (let i = 0; i < 4; i += 1) files.push(saveJournal(journal, dir, { reason: `№${i}`, keepFiles: 3, now: new Date(2026, 10, 4, 3, 50, 38) }));
  assert.equal(path.basename(files[0]), 'packets-2026-11-04_03-50-38.txt');
  assert.equal(path.basename(files[1]), 'packets-2026-11-04_03-50-38-2.txt', 'в ту же секунду — не затираем');
  const left = fs.readdirSync(dir).sort();
  assert.equal(left.length, 3);
  assert.ok(!left.includes('packets-2026-11-04_03-50-38.txt'), 'самый старый удалён');
  assert.match(fs.readFileSync(files[3], 'utf8'), /— №3/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('журнал: содержимое пакетов в тексте — без буферов, BigInt и бесконечной вложенности', () => {
  assert.equal(compact(5n), '5');
  assert.equal(compact(Buffer.alloc(10)), '<10 байт>');
  assert.equal(compact('x'.repeat(400)).length, 301);
  assert.deepEqual(compact({ a: { b: { c: { d: { e: 1 } } } } }), { a: { b: { c: { d: '{…}' } } } });
  assert.equal(compact(Array.from({ length: 25 }, (_, i) => i)).length, 21);
});

test('журнал: клиент без событий и записи (подделка в тестах) не ломается', () => {
  const journal = new PacketJournal();
  journal.attach({ socket: {} });
  journal.attach(null);
  assert.deepEqual(journal.entries(), []);
  assert.match(journal.format(), /Бот отправил за [\d.]+ с:\n {2}ничего/);
});

// ---------- профиль клиента ----------

function profileClient(state = 'configuration') {
  const client = { state, sent: [] };
  client.write = (name, params) => client.sent.push([name, params]);
  applyClientProfile(client);
  return client;
}

test('профиль: бренд один раз — в фазе настройки, прямо перед настройками клиента', () => {
  const client = profileClient();
  client.write('login_acknowledged', {}); // этот уходит ещё до фазы настройки, но проверим порядок целиком
  client.write('settings', { locale: 'ru_ru' });
  assert.deepEqual(client.sent.map((p) => p[0]), ['login_acknowledged', 'custom_payload', 'settings']);
  assert.equal(client.sent[1][1].channel, 'minecraft:brand');
  assert.deepEqual(client.sent[1][1].data, Buffer.from([7, ...Buffer.from('vanilla')]));

  // После входа в мир mineflayer шлёт бренд снова — он не уходит.
  client.state = 'play';
  client.write('custom_payload', { channel: 'minecraft:brand', data: Buffer.from([7]) });
  client.write('custom_payload', { channel: 'some:mod', data: Buffer.from([1]) }); // чужие каналы — как есть
  // Переход на другой сервер через прокси: настройки ещё раз, бренд — нет.
  client.state = 'configuration';
  client.write('settings', { locale: 'ru_ru' });
  assert.deepEqual(client.sent.slice(3).map((p) => [p[0], p[1].channel]), [['custom_payload', 'some:mod'], ['settings', undefined]]);
});

test('профиль: на старых версиях без фазы настройки бренд после входа в мир уходит как есть', () => {
  const client = profileClient('play');
  client.write('custom_payload', { channel: 'MC|Brand', data: Buffer.from([7]) });
  assert.equal(client.sent.length, 1);
});

test('профиль: настройки не уходят заново после входа в мир, bot.setSettings отправляет их как обычный клиент', () => {
  const bot = new EventEmitter();
  bot._client = { sent: [], write(name, params) { this.sent.push([name, params]); } };
  settingsPlugin(bot);
  bot.emit('login');
  assert.equal(bot._client.sent.length, 0);
  bot.setSettings({ viewDistance: 'far' });
  assert.deepEqual(bot._client.sent, [['settings', {
    locale: 'ru_ru', viewDistance: 12, chatFlags: 0, chatColors: true, skinParts: 0x7f, mainHand: 1,
    enableTextFiltering: false, enableServerListing: true, particleStatus: 'all',
  }]]);
  assert.throws(() => bot.setSettings({ chat: 'громко' }), /invalid chat setting/);
});

test('профиль: пакеты собираются протоколом 1.21.11 (настройки, бренд, клавиши, бег, tick_end)', () => {
  const config = createSerializer({ state: states.CONFIGURATION, isServer: false, version: '1.21.11' });
  const opts = profileOptions();
  assert.equal(opts.brand, 'vanilla');
  const settings = config.createPacketBuffer({ name: 'settings', params: { ...opts.clientSettings, particleStatus: 'all' } });
  assert.ok(settings.includes(Buffer.from('ru_ru')));
  config.createPacketBuffer({ name: 'custom_payload', params: { channel: 'minecraft:brand', data: encodeString('vanilla') } });
  const play = createSerializer({ state: states.PLAY, isServer: false, version: '1.21.11' });
  play.createPacketBuffer({ name: 'tick_end', params: {} });
  play.createPacketBuffer({ name: 'player_input', params: { inputs: { forward: true, sprint: true } } });
  const sprint = play.createPacketBuffer({ name: 'entity_action', params: { entityId: 1, actionId: 'start_sprinting', jumpBoost: 0 } });
  assert.equal(sprint[sprint.length - 2], 1, 'start_sprinting — действие №1, а не №3 («прыжок на лошади»)');
  assert.deepEqual(encodeString('x'.repeat(200)).subarray(0, 2), Buffer.from([0xc8, 0x01]), 'длина строки — varint');
});

// ---------- физика ----------

const { fakeClock, physicsBot, teleport, names, take } = require('./fake-bot');

test('физика: tick_end в конце каждого тика — ровно 20 в секунду, и только в игре', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot);
  assert.deepEqual(names(bot), ['teleport_confirm', 'position_look']);
  take(bot);
  clock.advance(1000);
  const sent = take(bot);
  assert.equal(sent.filter((p) => p.name === 'tick_end').length, 20);
  assert.equal(sent[sent.length - 1].name, 'tick_end');
  // Между двумя tick_end — не больше одного пакета движения (за это и ругается TickTimer).
  let moves = 0;
  for (const p of sent) {
    if (p.name === 'tick_end') moves = 0;
    else if (/^(position|position_look|look|flying)$/.test(p.name)) assert.ok(++moves <= 1);
  }
  // Фаза настройки (переход между серверами) — тиков нет.
  bot._client.state = 'configuration';
  clock.advance(500);
  assert.deepEqual(names(bot), []);
  bot.emit('end');
  bot._client.state = 'play';
  clock.advance(500);
  assert.deepEqual(names(bot), [], 'после отключения таймер остановлен');
});

test('физика: стоящий бот — позиция раз в 20 тиков, «встал на землю» отдельным пакетом, ничего лишнего', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot);
  take(bot);
  clock.advance(2000); // 40 тиков
  const moves = take(bot).filter((p) => p.name !== 'tick_end');
  assert.deepEqual(moves.map((p) => p.name), ['flying', 'position', 'position']);
  assert.deepEqual(moves[0].params.flags, { onGround: true, hasHorizontalCollision: false });
  assert.equal(moves[1].params.y, 64);
  assert.equal(bot.entity.onGround, true);
});

test('физика: полёт от сервера — после телепорта висит, как клиент; на земле или в движении «приземляется»', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  // Спавн MineBlaze: телепорт, сразу «Флай включен!» (abilities: может летать + летит).
  teleport(bot);
  bot._client.emit('abilities', { flags: 6, flyingSpeed: 0.05, walkingSpeed: 0.1 });
  take(bot);
  clock.advance(2000);
  let sent = take(bot);
  assert.ok(!sent.some((p) => p.name === 'abilities'), 'висит: полёт не выключает');
  const reminders = sent.filter((p) => p.name === 'position');
  assert.ok(reminders.length >= 1 && reminders.every((p) => p.params.onGround === false && p.params.y === 64), 'висит на месте, не на земле');
  assert.equal(bot.serverView.flying, true);

  // Пошёл — сначала выключает полёт (сервер узнаёт в том же тике, до движения), потом идёт пешком.
  bot.setControlState('forward', true);
  clock.advance(100);
  sent = take(bot);
  const order = sent.map((p) => p.name);
  assert.deepEqual(sent.find((p) => p.name === 'abilities').params, { flags: 0 });
  assert.ok(order.indexOf('abilities') < order.indexOf('player_input'), 'полёт выключен раньше клавиш и движения');
  assert.equal(bot.serverView.flying, false);
  bot.setControlState('forward', false);
  clock.advance(1000);
  take(bot);

  // Стоял на земле, и сервер включил полёт: обычный клиент в следующем тике «приземляется».
  assert.equal(bot.entity.onGround, true);
  bot._client.emit('abilities', { flags: 6, flyingSpeed: 0.05, walkingSpeed: 0.1 });
  clock.advance(50);
  sent = take(bot);
  assert.deepEqual(sent.filter((p) => p.name === 'abilities').map((p) => p.params), [{ flags: 0 }]);

  // Наблюдатель летает всегда — полёт не выключает.
  bot.game = { gameMode: 'spectator' };
  bot._client.emit('abilities', { flags: 7, flyingSpeed: 0.05, walkingSpeed: 0.1 });
  clock.advance(500);
  assert.ok(!take(bot).some((p) => p.name === 'abilities'));
});

test('физика: после подвисания догоняем не больше 10 тиков, потом снова ровно', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  take(bot);
  clock.stall(3000); // 60 тиков пропущено
  clock.advance(0);
  assert.equal(take(bot).filter((p) => p.name === 'tick_end').length, MAX_CATCHUP_TICKS);
  clock.advance(1000);
  assert.equal(take(bot).filter((p) => p.name === 'tick_end').length, 20);
});

test('физика: без tick_end (для сравнения на стенде) пакет не уходит', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock, tickEnd: false });
  bot.emit('login');
  teleport(bot);
  clock.advance(1000);
  assert.ok(!names(bot).includes('tick_end'));
  assert.ok(names(bot).includes('flying'));
});

test('физика: клавиши и бег — в тике перед движением; бег — «start_sprinting», присед не отпускает клавиши', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  take(bot);
  bot.setControlState('forward', true);
  bot.setControlState('sprint', true);
  assert.deepEqual(names(bot), [], 'сразу ничего не уходит — только в тике');
  clock.advance(50);
  const tick1 = take(bot);
  assert.deepEqual(tick1.map((p) => p.name).slice(0, 3), ['player_input', 'entity_action', 'position']);
  assert.equal(tick1[tick1.length - 1].name, 'tick_end');
  assert.deepEqual(tick1[0].params.inputs, { forward: true, backward: false, left: false, right: false, jump: false, shift: false, sprint: true });
  assert.equal(tick1[1].params.actionId, 'start_sprinting');
  clock.advance(50);
  assert.ok(!names(bot).includes('player_input'), 'без изменений клавиши не повторяются');
  take(bot);
  bot.setControlState('sneak', true);
  clock.advance(50);
  const input = take(bot).find((p) => p.name === 'player_input');
  assert.deepEqual(input.params.inputs, { forward: true, backward: false, left: false, right: false, jump: false, shift: true, sprint: true });
  bot.clearControlStates();
  clock.advance(50);
  const stop = take(bot);
  assert.equal(stop.find((p) => p.name === 'entity_action').params.actionId, 'stop_sprinting');
  // Новый сервер за прокси ничего не знает о нажатых клавишах: отправим заново, если они нажаты.
  bot.setControlState('forward', true);
  clock.advance(50);
  take(bot);
  bot.emit('login');
  teleport(bot);
  take(bot);
  clock.advance(50);
  assert.ok(names(bot).includes('player_input'));
});

test('физика: телепорт 1.21.2+ — относительные координаты, скорость из пакета, поворот без скачка на 360°', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot, { yaw: 270, pitch: 10 });
  const confirm = take(bot)[1];
  assert.equal(confirm.params.yaw, 270);
  assert.equal(confirm.params.pitch, 10);
  clock.advance(1000);
  assert.ok(!names(bot).some((n) => n === 'look' || n === 'position_look'), 'поворот не меняли — пакетов поворота нет');
  take(bot);

  // Поворот на 20° вправо от 270: в пакетах 270 → 290, а не прыжок к −70.
  const target = bot.entity.yaw - (20 * Math.PI) / 180;
  bot.look(target, bot.entity.pitch);
  clock.advance(500);
  const yaws = take(bot).filter((p) => p.name === 'look' || p.name === 'position_look').map((p) => p.params.yaw);
  assert.ok(yaws.length >= 1);
  for (const y of yaws) assert.ok(y > 269 && y < 291, `угол ${y} без скачка`);
  assert.ok(Math.abs(yaws[yaws.length - 1] - 290) < 0.2);

  // Откат античитом: относительная позиция по y, скорость не относительная — берётся из пакета.
  bot.entity.velocity.set(0.3, 0, 0.3);
  const before = bot.entity.position.clone();
  teleport(bot, {
    x: 2, y: 0.5, z: 0, dx: 0, dy: 0.1, dz: 0,
    flags: { x: false, y: true, z: false, yaw: true, pitch: true, dx: false, dy: false, dz: false, yawDelta: false },
  });
  assert.equal(bot.entity.position.x, 2);
  assert.equal(bot.entity.position.y, before.y + 0.5);
  assert.deepEqual([bot.entity.velocity.x, bot.entity.velocity.y, bot.entity.velocity.z], [0, 0.1, 0]);
  const reply = take(bot).find((p) => p.name === 'position_look');
  assert.ok(Math.abs(reply.params.yaw - 290) < 0.2, 'относительный поворот — от текущего, без скачка');
});

test('физика: поворот головы сервером (в том числе относительный) — в следующем пакете сразу новый угол', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot, { yaw: 90 });
  take(bot);
  bot._client.emit('player_rotation', { yaw: 30, relativeYaw: true, pitch: -10, relativePitch: false });
  clock.advance(50);
  const look = take(bot).find((p) => p.name === 'look');
  assert.ok(Math.abs(look.params.yaw - 120) < 1e-3);
  assert.ok(Math.abs(look.params.pitch + 10) < 1e-3);
});

test('физика: поворот как у человека — шаги мыши по 0.15°, разгон, торможение, без перелёта', async () => {
  for (const random of [0, 0.5, 0.99]) {
    // Самая медленная, средняя и самая быстрая «рука».
    const clock = fakeClock();
    const bot = physicsBot({ clock, random });
    bot.emit('login');
    teleport(bot, { yaw: 10, pitch: 0 });
    take(bot);
    let done = false;
    bot.look(bot.entity.yaw - Math.PI / 2, -0.3).then(() => {
      done = true;
    }); // 90° вправо и чуть вниз
    const yaws = [10];
    const pitches = [0];
    for (let i = 0; i < 40 && !done; i += 1) {
      clock.advance(50);
      await Promise.resolve();
      for (const p of take(bot)) {
        if (p.name === 'look' || p.name === 'position_look') {
          yaws.push(p.params.yaw);
          pitches.push(p.params.pitch);
        }
      }
    }
    assert.ok(done, 'поворот закончился и промис выполнился');
    const steps = yaws.slice(1).map((y, i) => y - yaws[i]);
    for (const [i, d] of steps.entries()) {
      const pd = pitches[i + 1] - pitches[i];
      assert.ok(Math.abs(d / MOUSE_STEP - Math.round(d / MOUSE_STEP)) < 1e-3, `шаг ${d} кратен шагу мыши`);
      assert.ok(Math.abs(pd / MOUSE_STEP - Math.round(pd / MOUSE_STEP)) < 1e-3, `шаг наклона ${pd} кратен шагу мыши`);
      assert.ok(d > 0, 'без перелёта и возврата');
      assert.ok(d <= TURN_SPEED * 1.25, `не быстрее предела: ${d}`);
    }
    assert.ok(steps.length >= 5 && steps.length <= 14, `90° — за ${steps.length} тиков (как рука, а не рывком)`);
    const peak = steps.indexOf(Math.max(...steps));
    assert.ok(peak > 0 && peak < steps.length - 1, 'сначала разгон, в конце торможение');
    assert.ok(Math.abs(yaws[yaws.length - 1] - 100) < MOUSE_STEP, `итог около 100°: ${yaws[yaws.length - 1]}`);
    assert.ok(bot.serverView.lookSettled);
    bot.emit('end');
  }
});

test('физика: на ходу движение идёт туда, куда бот смотрит сейчас, а не куда повернёт', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot, { yaw: 0, pitch: 0 }); // смотрит на юг (+z)
  clock.advance(100);
  take(bot);
  bot.look(bot.entity.yaw + Math.PI / 2, 0, true); // повернуть на 90° (к востоку, -x в формулах mineflayer — не важно)
  bot.setControlState('forward', true);
  const start = bot.entity.position.clone();
  clock.advance(50);
  const moved = bot.entity.position.minus(start);
  const yawSent = take(bot).find((p) => p.name === 'position_look').params.yaw; // взгляд этого тика
  const rad = (yawSent * Math.PI) / 180;
  const dir = new Vec3(-Math.sin(rad), 0, Math.cos(rad)); // куда смотрит игрок с таким углом
  const along = moved.x * dir.x + moved.z * dir.z;
  const across = Math.abs(moved.x * dir.z - moved.z * dir.x);
  assert.ok(along > 0 && across < along * 0.05, `сдвиг вдоль взгляда (${along.toFixed(4)}), поперёк — почти ноль (${across.toFixed(4)})`);
});

test('физика: клавиши, нажатые в обработчике тика, уходят и учитываются в следующем тике', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  take(bot);
  bot.once('physicsTick', () => bot.setControlState('forward', true));
  clock.advance(50);
  assert.ok(!names(bot).includes('player_input'), 'в этом тике движение считалось без клавиши — и пакета нет');
  take(bot);
  clock.advance(50);
  assert.equal(take(bot)[0].name, 'player_input');
});

test('физика: ошибка внутри тика не роняет бота и не отменяет tick_end', () => {
  const clock = fakeClock();
  const bot = physicsBot({ clock });
  const errors = [];
  bot.on('error', (err) => errors.push(err));
  bot.emit('login');
  teleport(bot);
  take(bot);
  bot.on('physicsTick', () => {
    throw new Error('сломанный плагин');
  });
  clock.advance(1000);
  assert.equal(names(bot).filter((n) => n === 'tick_end').length, 20);
  assert.equal(errors.length, 1, 'об ошибке — один раз, а не 20 раз в секунду');
});
