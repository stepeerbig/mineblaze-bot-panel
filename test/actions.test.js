'use strict';

// Безопасные действия (src/bot/actions.js) и команды панели (src/bot/commands.js) на поддельном боте:
// проверяем не только итог, но и то, что увидит сервер — пакеты, их порядок внутри тиков, паузы.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { fakeClock, makeWorld, physicsBot, autoServer, teleport, take, runFor, VERSION } = require('./fake-bot');

const { lookVector } = require(path.join(__dirname, '..', 'src', 'bot', 'actions.js'));
const { runCommand, parseCoord, parseBlockPos, f3Yaw } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));

/** Бот стоит в 0.5 64 0.5 на камне и смотрит на юг (+z). */
function setup({ random = 0.5 } = {}) {
  const clock = fakeClock();
  const world = makeWorld(require('prismarine-registry')(VERSION));
  const bot = physicsBot({ clock, world, actions: true, random });
  autoServer(bot, world);
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  take(bot);
  return { clock, world, bot };
}

/** Пакеты, разбитые по тикам (каждый тик кончается tick_end). */
function byTick(packets) {
  const ticks = [[]];
  for (const p of packets) {
    ticks[ticks.length - 1].push(p);
    if (p.name === 'tick_end') ticks.push([]);
  }
  return ticks;
}

const lastLook = (packets, beforeIndex) => {
  for (let i = beforeIndex; i >= 0; i -= 1) if (packets[i].name === 'look' || packets[i].name === 'position_look') return packets[i].params;
  return null;
};

test('копание: взгляд на видимую грань, удар, взмах каждый тик, конец — по времени клиента', async () => {
  const { clock, world, bot } = setup();
  world.set(new Vec3(0, 64, 2), 'stone');
  const res = await runFor(clock, bot.actions.dig(new Vec3(0, 64, 2)));
  assert.ifError(res.error);
  assert.deepEqual(res.value, { position: new Vec3(0, 64, 2), face: 'север', ticks: 10 });
  assert.equal(world.get(new Vec3(0, 64, 2)), 'air');

  const sent = take(bot);
  const start = sent.findIndex((p) => p.name === 'block_dig' && p.params.status === 0);
  const stop = sent.findIndex((p) => p.name === 'block_dig' && p.params.status === 2);
  assert.ok(start > 0 && stop > start);
  assert.deepEqual([sent[start].params.face, sent[start].params.sequence, sent[stop].params.sequence], [2, 1, 2]);
  const during = sent.slice(start, stop + 1);
  assert.ok(!during.some((p) => p.name === 'look' || p.name === 'position_look'), 'пока копает — голова неподвижна');
  assert.equal(during.filter((p) => p.name === 'tick_end').length, 9, 'конец — в 10-м тике, считая тик удара');
  assert.equal(sent.slice(start, stop + 2).filter((p) => p.name === 'arm_animation').length, 11, 'взмах каждый тик и ещё один от нажатия');
  // Внутри тика — сначала копание и взмах, потом движение: как нажатия мыши у клиента.
  for (const tick of byTick(during)) {
    const dig = tick.findIndex((p) => p.name === 'block_dig');
    const move = tick.findIndex((p) => /^(position|position_look|look|flying)$/.test(p.name));
    if (dig >= 0 && move >= 0) assert.ok(dig < move);
  }
  // Удар — уже по неподвижному взгляду, и он смотрит в блок.
  const look = lastLook(sent, start);
  const dir = lookVector(((180 - look.yaw) * Math.PI) / 180, (-look.pitch * Math.PI) / 180);
  const eye = new Vec3(0.5, 64 + 1.62, 0.5);
  const t = (2 - eye.z) / dir.z;
  const hit = eye.plus(dir.scaled(t));
  assert.ok(hit.x >= 0 && hit.x <= 1 && hit.y >= 64 && hit.y <= 65, `луч взгляда попадает в северную грань: ${hit}`);
});

test('копание: блок, который ломается сразу (трава), — только начало, без конца', async () => {
  const { clock, world, bot } = setup();
  world.set(new Vec3(0, 64, 2), 'short_grass');
  const res = await runFor(clock, bot.actions.dig(new Vec3(0, 64, 2)));
  assert.ifError(res.error);
  const digs = take(bot).filter((p) => p.name === 'block_dig');
  assert.deepEqual(digs.map((p) => p.params.status), [0]);
});

test('копание: пауза 5 тиков между блоками, как у клиента', async () => {
  const { clock, world, bot } = setup();
  world.set(new Vec3(0, 64, 2), 'stone');
  world.set(new Vec3(1, 64, 2), 'stone');
  bot.digTicks.stone = 2;
  assert.ifError((await runFor(clock, bot.actions.dig(new Vec3(0, 64, 2)))).error);
  assert.ifError((await runFor(clock, bot.actions.dig(new Vec3(1, 64, 2)))).error);
  const sent = take(bot);
  const stops = sent.map((p, i) => (p.name === 'block_dig' && p.params.status === 2 ? i : -1)).filter((i) => i >= 0);
  const secondStart = sent.findIndex((p, i) => i > stops[0] && p.name === 'block_dig' && p.params.status === 0);
  const gap = sent.slice(stops[0], secondStart).filter((p) => p.name === 'tick_end').length;
  assert.ok(gap >= 5, `между концом одного и началом другого — ${gap} тиков`);
  assert.deepEqual(sent.filter((p) => p.name === 'block_dig').map((p) => p.params.sequence), [1, 2, 3, 4]);
});

test('установка: нажатие по видимой грани соседа, курсор — точка под взглядом, пауза 4 тика', async () => {
  const { clock, world, bot } = setup();
  bot.inventory.slots[36] = { name: 'cobblestone' };
  bot.heldItem = bot.inventory.slots[36];
  const a = await runFor(clock, bot.actions.place(new Vec3(0, 64, 2)));
  assert.ifError(a.error);
  assert.deepEqual(a.value.against, new Vec3(0, 63, 2));
  assert.equal(a.value.face, 'верх');
  assert.equal(world.get(new Vec3(0, 64, 2)), 'cobblestone');
  const b = await runFor(clock, bot.actions.place(new Vec3(1, 64, 2)));
  assert.ifError(b.error);

  const sent = take(bot);
  const places = sent.map((p, i) => (p.name === 'block_place' ? i : -1)).filter((i) => i >= 0);
  assert.equal(places.length, 2);
  const first = sent[places[0]].params;
  assert.deepEqual([first.location.x, first.location.y, first.location.z, first.direction, first.hand], [0, 63, 2, 1, 0]);
  assert.equal(first.cursorY, 1);
  assert.ok(first.cursorX > 0.2 && first.cursorX < 0.8 && first.cursorZ > 0.2 && first.cursorZ < 0.8);
  assert.equal(sent[places[0] + 1].name, 'arm_animation', 'после нажатия — взмах');
  assert.deepEqual([first.sequence, sent[places[1]].params.sequence], [1, 2]);
  // Курсор совпадает с точкой, куда смотрит взгляд, известный серверу.
  const look = lastLook(sent, places[0]);
  const dir = lookVector(((180 - look.yaw) * Math.PI) / 180, (-look.pitch * Math.PI) / 180);
  const eye = new Vec3(0.5, 64 + 1.62, 0.5);
  const hit = eye.plus(dir.scaled((64 - eye.y) / dir.y));
  assert.ok(Math.abs(hit.x - (0 + first.cursorX)) < 1e-3 && Math.abs(hit.z - (2 + first.cursorZ)) < 1e-3, 'курсор = точка под взглядом');
  const gap = sent.slice(places[0], places[1]).filter((p) => p.name === 'tick_end').length;
  assert.ok(gap >= 4, `между нажатиями — ${gap} тиков`);
});

test('установка: понятные ошибки', async () => {
  const { clock, world, bot } = setup();
  const err = async (promise) => (await runFor(clock, promise)).error.message;
  assert.match(await err(bot.actions.place(new Vec3(0, 64, 2))), /в руке ничего нет/);
  bot.heldItem = { name: 'stick' };
  assert.match(await err(bot.actions.place(new Vec3(0, 64, 2))), /в руке не блок: stick/);
  bot.heldItem = { name: 'cobblestone' };
  assert.match(await err(bot.actions.place(new Vec3(0, 64, 0))), /где стоит бот/);
  world.set(new Vec3(0, 64, 2), 'stone');
  assert.match(await err(bot.actions.place(new Vec3(0, 64, 2))), /занята: stone/);
  assert.match(await err(bot.actions.place(new Vec3(0, 70, 2))), /некуда опереть/);
  assert.match(await err(bot.actions.dig(new Vec3(0, 64, 3))), /нечего ломать/);
  world.set(new Vec3(0, 64, 9), 'stone');
  assert.match(await err(bot.actions.dig(new Vec3(0, 64, 9))), /не виден или слишком далеко/);
});

test('ходьба: по прямой к цели, клавиши и остановка у цели', async () => {
  const { clock, bot } = setup();
  const res = await runFor(clock, bot.actions.walkTo(new Vec3(0.5, 64, 5.5)));
  assert.ifError(res.error);
  const p = bot.entity.position;
  assert.ok(Math.abs(p.x - 0.5) < 0.05 && p.z > 5.1 && p.z < 6, `пришёл: ${p}`);
  const inputs = take(bot).filter((x) => x.name === 'player_input').map((x) => x.params.inputs.forward);
  assert.deepEqual(inputs, [true, false]);
  assert.deepEqual(Object.values(bot.controlState).filter(Boolean), [], 'клавиши отпущены');
});

test('ходьба: цель сбоку — сначала поворот, потом шаг; бег только на прямой', async () => {
  const { clock, bot } = setup();
  const res = await runFor(clock, bot.actions.walkTo(new Vec3(8.5, 64, 0.5), { sprint: true }));
  assert.ifError(res.error);
  const sent = take(bot);
  const firstForward = sent.findIndex((x) => x.name === 'player_input' && x.params.inputs.forward);
  const turnBefore = sent.slice(0, firstForward).filter((x) => x.name === 'look' || x.name === 'position_look').length;
  assert.ok(turnBefore >= 2, `до шага голова поворачивалась ${turnBefore} тиков`);
  assert.ok(sent.some((x) => x.name === 'entity_action' && x.params.actionId === 'start_sprinting'));
  assert.ok(sent.some((x) => x.name === 'entity_action' && x.params.actionId === 'stop_sprinting'), 'у цели бег выключен');
  assert.ok(bot.entity.position.x > 8);
});

test('ходьба: ступенька в блок — прыжок; стена в два блока — «застрял»', async () => {
  const a = setup();
  for (let z = 3; z <= 7; z += 1) a.world.set(new Vec3(0, 64, z), 'stone');
  const up = await runFor(a.clock, a.bot.actions.walkTo(new Vec3(0.5, 65, 5.5)));
  assert.ifError(up.error);
  assert.ok(Math.abs(a.bot.entity.position.y - 65) < 1e-6, `на ступеньке: ${a.bot.entity.position}`);
  assert.ok(take(a.bot).some((x) => x.name === 'player_input' && x.params.inputs.jump));

  const b = setup();
  b.world.set(new Vec3(0, 64, 3), 'stone');
  b.world.set(new Vec3(0, 65, 3), 'stone');
  const stuck = await runFor(b.clock, b.bot.actions.walkTo(new Vec3(0.5, 64, 5.5)));
  assert.equal(stuck.error && stuck.error.code, 'stuck');
  assert.match(stuck.error.message, /застрял/);
});

test('очередь: новое действие прерывает текущее; «стоп» отпускает клавиши; переход между серверами прерывает', async () => {
  const { clock, bot } = setup();
  const walk = bot.actions.walkTo(new Vec3(0.5, 64, 40.5));
  clock.advance(500);
  await Promise.resolve();
  assert.equal(bot.actions.current, 'идти');
  const look = bot.actions.look(bot.entity.yaw, -0.5);
  const w = await runFor(clock, walk);
  assert.equal(w.error.code, 'replaced');
  assert.ifError((await runFor(clock, look)).error);

  const walk2 = bot.actions.walkTo(new Vec3(0.5, 64, 40.5));
  clock.advance(300);
  await Promise.resolve();
  assert.equal(bot.actions.stop(), true);
  assert.equal((await runFor(clock, walk2)).error.code, 'stopped');
  assert.equal(bot.controlState.forward, false);
  assert.equal(bot.actions.busy, false);

  const walk3 = bot.actions.walkTo(new Vec3(0.5, 64, 40.5));
  clock.advance(300);
  await Promise.resolve();
  bot._client.emit('start_configuration');
  assert.equal((await runFor(clock, walk3)).error.code, 'interrupted');
});

test('предмет в руку: из быстрой панели — сменой ячейки внутри тика', async () => {
  const { clock, bot } = setup();
  bot.inventory.slots[38] = { name: 'iron_pickaxe' };
  assert.ifError((await runFor(clock, bot.actions.equip('minecraft:iron_pickaxe'))).error);
  assert.equal(bot.heldItem.name, 'iron_pickaxe');
  const sent = take(bot);
  const i = sent.findIndex((p) => p.name === 'held_item_slot');
  assert.equal(sent[i].params.slotId, 2);
  assert.ok(sent.slice(i).some((p) => p.name === 'tick_end'), 'смена ячейки — внутри тика');
  assert.match((await runFor(clock, bot.actions.equip('diamond'))).error.message, /нет предмета diamond/);
});

test('без своей физики действия честно отказываются', async () => {
  const { clock, bot } = setup();
  delete bot.serverView;
  const res = await runFor(clock, bot.actions.walkTo(new Vec3(0, 64, 3)));
  assert.equal(res.error.code, 'unsupported');
});

// ---------- команды панели ----------

test('команды: координаты как в игре — числа и «~» от бота', () => {
  assert.equal(parseCoord('10', 0), 10);
  assert.equal(parseCoord('-3,5', 0), -3.5);
  assert.equal(parseCoord('~', 7), 7);
  assert.equal(parseCoord('~-2', 7), 5);
  assert.throws(() => parseCoord('abc', 0), /непонятная координата/);
  assert.throws(() => parseCoord('~x', 0), /непонятная координата/);
  assert.deepEqual(parseBlockPos(['~1', '~', '~-1'], new Vec3(0.5, 64, 0.5)), new Vec3(1, 64, -1));
  assert.throws(() => parseBlockPos(['1', '2'], new Vec3(0, 0, 0)), /три координаты/);
});

test('команды: #look, #pos, #goto и ошибки — понятными строками в консоли', async () => {
  const { clock, bot } = setup();
  const logs = [];
  const log = (level, text) => logs.push(`${level}:${text}`);
  const look = runCommand(bot, '#look 90 10', log);
  assert.ifError((await runFor(clock, look)).error);
  // 10° вниз точно не получить: ближайшее на сетке шагов мыши — 10,05°.
  assert.ok(logs.some((l) => /^ok:Повернулся: 90\.0 \/ 10\.[01]$/.test(l)), logs.join('\n'));
  assert.ok(Math.abs(f3Yaw(bot.serverView.yaw) - 90) < 0.2, 'смотрит на запад, как «90» в F3');
  await runCommand(bot, '#pos', log);
  assert.ok(logs.some((l) => /^info:Бот: 0\.50 64\.00 0\.50, взгляд 90\.0 \/ 10\.[01]/.test(l)));
  await runCommand(bot, '#goto 1000 64 0', log);
  assert.ok(logs.some((l) => l.startsWith('error:#goto: слишком далеко')));
  await runCommand(bot, '#dig 1 2', log);
  assert.ok(logs.includes('error:#dig: нужны три координаты: x y z'));
  await runCommand(bot, '#нет-такой', log);
  assert.ok(logs.some((l) => l.startsWith('warn:Неизвестная команда «#нет-такой»')));
  await runCommand(bot, '#help', log);
  assert.ok(logs.some((l) => l.startsWith('info:#goto')));
  await runCommand(bot, '#stop', log);
  assert.ok(logs.includes('info:Бот ничего не делал'));
});
