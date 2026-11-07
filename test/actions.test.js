'use strict';

// Безопасные действия (src/bot/actions.js) на поддельном боте: проверяем не только итог, но и то, что увидит
// сервер — пакеты, их порядок внутри тиков, паузы. Команды из строки чата — в commands.test.js.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { fakeClock, makeWorld, physicsBot, autoServer, teleport, take, runFor, VERSION } = require('./fake-bot');

const { lookVector } = require(path.join(__dirname, '..', 'src', 'bot', 'actions.js'));

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
  // Как с зажатой кнопкой: в тике удара прогресса нет, конец — через 10 тиков после него (Grim FastBreak).
  assert.equal(during.filter((p) => p.name === 'tick_end').length, 10, 'конец — через 10 тиков после удара');
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

test('копание: после блока, что ломается сразу (трава, камень со «Спешкой»), паузы нет — как у клиента', async () => {
  const { clock, world, bot } = setup();
  // Тот же блок дважды (трава, потом на её месте камень): голове не нужно поворачиваться — остаётся только пауза.
  const p = new Vec3(0, 64, 2);
  world.set(p, 'short_grass');
  assert.ifError((await runFor(clock, bot.actions.dig(p))).error);
  world.set(p, 'stone');
  bot.digTicks.stone = 3;
  assert.ifError((await runFor(clock, bot.actions.dig(p))).error);
  const sent = take(bot);
  const starts = sent.map((x, i) => (x.name === 'block_dig' && x.params.status === 0 ? i : -1)).filter((i) => i >= 0);
  assert.equal(starts.length, 2);
  const gap = sent.slice(starts[0], starts[1]).filter((x) => x.name === 'tick_end').length;
  assert.ok(gap < 5, `второй удар — сразу, как сервер ответил, без паузы 5 тиков: ${gap}`);
});

test('копание туннелем, как с зажатой кнопкой: в паузе между блоками рука машет каждый тик, следующий удар — на 6-й тик', async () => {
  const { clock, world, bot } = setup();
  // Закрытый коридор шириной в блок: к цели — только сквозь стенку из двух блоков (голова, ноги).
  for (let z = 1; z <= 5; z += 1) for (const x of [-1, 1]) for (const y of [64, 65]) world.set(new Vec3(x, y, z), 'stone');
  for (const y of [64, 65]) {
    world.set(new Vec3(0, y, 2), 'stone');
    world.set(new Vec3(0, y, 5), 'stone');
  }
  bot.digTicks.stone = 3;
  const res = await runFor(clock, bot.actions.digTo(new Vec3(0.5, 64, 3.5), { range: 0.4 }));
  assert.ifError(res.error);
  const sent = take(bot);
  const at = (status) => sent.map((p, i) => (p.name === 'block_dig' && p.params.status === status ? i : -1)).filter((i) => i >= 0);
  const [starts, stops] = [at(0), at(2)];
  assert.equal(stops.length, 2, 'два блока: голова и ноги');
  const pause = byTick(sent.slice(stops[0] + 1, starts[1]));
  assert.equal(sent.slice(stops[0], starts[1]).filter((p) => p.name === 'tick_end').length, 6, 'удар по второму — на 6-й тик после первого');
  const quiet = pause.filter((tick) => tick.some((p) => p.name === 'tick_end') && !tick.some((p) => p.name === 'arm_animation'));
  assert.equal(quiet.length, 0, `в паузе рука машет каждый тик (тихих тиков: ${quiet.length})`);
});

test('удар: моб ходит (голова его ведёт и не «встаёт») — бьёт, как человек мышью: когда прицел на нём', async () => {
  const { clock, bot } = setup();
  const zombie = { id: 801, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 2.3), width: 0.6, height: 1.95 };
  bot.entities[801] = zombie;
  let tick = 0;
  bot.on('physicsTick', () => {
    tick += 1;
    zombie.position = new Vec3(0.5 + 0.15 * Math.sin(tick / 2), 64, 2.3); // переминается с ноги на ногу
  });
  const res = await runFor(clock, bot.actions.attack(zombie));
  assert.ifError(res.error);
  const sent = take(bot);
  const hits = sent.filter((p) => p.name === 'use_entity' && p.params.mouse === 1);
  assert.equal(hits.length, 1, 'ударил');
});

test('еда: в руку, правая кнопка (use_item с тем взглядом, что в пакетах) и держать, пока сервер не засчитает', async () => {
  const { clock, bot } = setup();
  bot.inventory.slots[37] = { name: 'bread', count: 3 };
  bot.food = 10;
  // Сервер: через 32 тика после use_item хлеба меньше, сытость +5.
  let tick = 0;
  let usedAt = null;
  bot.on('physicsTick', () => {
    tick += 1;
    if (usedAt !== null && tick - usedAt === 32) {
      bot.inventory.slots[37].count -= 1;
      bot.food = 15;
      bot.emit('health');
      usedAt = null;
    }
  });
  const write = bot._client.write;
  bot._client.write = (name, params) => {
    write(name, params);
    if (name === 'use_item' && bot.heldItem && bot.heldItem.name === 'bread') usedAt = tick;
  };
  const res = await runFor(clock, bot.actions.eat('bread'));
  assert.ifError(res.error);
  assert.equal(bot.food, 15);
  const sent = take(bot);
  const uses = sent.filter((p) => p.name === 'use_item');
  assert.equal(uses.length, 1, 'одно нажатие — и держит');
  assert.equal(uses[0].params.hand, 0);
  const look = lastLook(sent, sent.indexOf(uses[0])) || { yaw: 0, pitch: 0 }; // голова не двигалась — взгляд с телепорта
  assert.ok(Math.abs(uses[0].params.rotation.x - look.yaw) < 1e-6 && Math.abs(uses[0].params.rotation.y - look.pitch) < 1e-6, 'взгляд в нажатии — как в пакетах движения');
  assert.ok(!sent.some((p) => p.name === 'block_dig' && p.params.status === 5), 'съел — отпускать нечего (клиент сам перестаёт)');
  const moves = sent.filter((p) => /^position/.test(p.name));
  assert.ok(moves.every((p) => Math.abs(p.params.x - 0.5) < 1e-6 && Math.abs(p.params.z - 0.5) < 1e-6), 'ел стоя на месте');
});

test('щит: лицом к криперу, правая кнопка как у клиента (основная рука — ничего, вторая — щит), держать, пока он есть', async () => {
  const { clock, bot } = setup();
  bot.inventory.slots[36] = { name: 'iron_sword', count: 1 };
  bot.heldItem = bot.inventory.slots[36];
  bot.inventory.slots[45] = { name: 'shield', count: 1 };
  const creeper = { id: 501, type: 'hostile', name: 'creeper', position: new Vec3(0.5, 64, 3.2), width: 0.6, height: 1.7 };
  bot.entities[501] = creeper;
  let tick = 0;
  bot.on('physicsTick', () => {
    if ((tick += 1) === 40) delete bot.entities[501]; // взорвался
  });
  const res = await runFor(clock, bot.actions.shield(creeper, { maxTicks: 200 }));
  assert.ifError(res.error);
  const sent = take(bot);
  const order = sent.filter((p) => p.name === 'use_entity' || p.name === 'use_item').map((p) => `${p.name}:${p.params.mouse !== undefined ? p.params.mouse : ''}:${p.params.hand}`);
  // Крипер под взглядом (ближе 3 блоков): у каждой руки — «нажать в точку» и «нажать», потом сам предмет.
  assert.deepEqual(order, ['use_entity:2:0', 'use_entity:0:0', 'use_item::0', 'use_entity:2:1', 'use_entity:0:1', 'use_item::1']);
  const pressed = sent.findIndex((p) => p.name === 'use_item');
  const release = sent.findIndex((p) => p.name === 'block_dig' && p.params.status === 5);
  assert.ok(release > pressed, 'крипера нет — щит опущен');
  assert.ok(!sent.some((p) => p.name === 'use_entity' && p.params.mouse === 1), 'со щитом не бьёт');
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

test('столбом: взгляд прямо вниз, прыжок, блок под себя — когда сервер уже знает, что ноги выше клетки', async () => {
  const { clock, world, bot } = setup();
  bot.inventory.slots[36] = { name: 'iron_pickaxe' };
  bot.inventory.slots[37] = { name: 'cobblestone', count: 10 };
  bot.heldItem = bot.inventory.slots[36];
  const write = bot._client.write;
  const serverY = [];
  bot._client.write = (name, params) => {
    if (name === 'block_place') serverY.push(bot.serverView.position.y);
    write(name, params);
  };
  const res = await runFor(clock, bot.actions.pillarUp({ item: 'cobblestone', count: 2 }));
  assert.ifError(res.error);
  assert.equal(world.get(new Vec3(0, 64, 0)), 'cobblestone');
  assert.equal(world.get(new Vec3(0, 65, 0)), 'cobblestone');
  assert.ok(Math.abs(bot.entity.position.y - 66) < 1e-6 && bot.entity.onGround, `стоит на столбе: ${bot.entity.position}`);
  assert.ok(serverY[0] >= 65 && serverY[1] >= 66, `блок — когда сервер знает, что ноги выше: ${serverY.join(', ')}`);

  const sent = take(bot);
  const places = sent.map((p, i) => (p.name === 'block_place' ? i : -1)).filter((i) => i >= 0);
  const first = sent[places[0]].params;
  assert.deepEqual([first.location.x, first.location.y, first.location.z, first.direction, first.cursorY], [0, 63, 0, 1, 1], 'по верхней грани опоры');
  assert.equal(lastLook(sent, places[0]).pitch, 90, 'взгляд прямо вниз');
  assert.equal(sent[places[0] + 1].name, 'arm_animation');
  assert.ok(sent.some((p) => p.name === 'held_item_slot' && p.params.slotId === 1), 'взял булыжник');
});

test('столбом: ответ сервера медленный — блок уже стоит у бота (не проваливается); сервер отказал — понятная ошибка', async () => {
  // Сервер ставит блок через 6 тиков после нажатия (пинг ~300 мс).
  const clock = fakeClock();
  const world = makeWorld(require('prismarine-registry')(VERSION));
  const bot = physicsBot({ clock, world, actions: true });
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  bot.inventory.slots[36] = { name: 'dirt', count: 5 };
  bot.heldItem = bot.inventory.slots[36];
  const write = bot._client.write;
  let reject = false;
  bot._client.write = (name, params) => {
    write(name, params);
    if (name !== 'block_place') return;
    const at = new Vec3(params.location.x, params.location.y + 1, params.location.z);
    clock.setTimeout(() => {
      world.set(at, reject ? 'air' : 'dirt');
      bot.emit('blockUpdate', null, world.blockAt(at)); // как mineflayer по пакету сервера
    }, 300);
  };
  let lowest = Infinity;
  let placed = false;
  bot.on('physicsTick', () => {
    if (placed) lowest = Math.min(lowest, bot.entity.position.y);
    if (world.get(new Vec3(0, 64, 0)) === 'dirt') placed = true;
  });
  const ok = await runFor(clock, bot.actions.pillarUp());
  assert.ifError(ok.error);
  assert.ok(lowest >= 65 - 1e-9, `после установки ниже блока не опускался: ${lowest}`);
  assert.ok(Math.abs(bot.entity.position.y - 65) < 1e-6);

  reject = true;
  const no = await runFor(clock, bot.actions.pillarUp());
  assert.match(no.error && no.error.message, /сервер не дал поставить блок/);
  assert.ok(Math.abs(bot.entity.position.y - 65) < 1e-6, 'вернулся на прежнюю высоту');
});

test('копание под себя: блок у себя пропадает сразу (как у клиента) — бот падает, не дожидаясь ответа сервера', async () => {
  const clock = fakeClock();
  const world = makeWorld(require('prismarine-registry')(VERSION));
  const bot = physicsBot({ clock, world, actions: true });
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  // Сервер отвечает через 300 мс (пинг): тогда и ставит у себя воздух.
  const write = bot._client.write;
  let yWhenAnswered = null;
  bot._client.write = (name, params) => {
    write(name, params);
    if (name !== 'block_dig' || params.status !== 2) return;
    const at = new Vec3(params.location.x, params.location.y, params.location.z);
    clock.setTimeout(() => {
      yWhenAnswered = bot.entity.position.y;
      world.set(at, 'air');
      bot.emit('blockUpdate', null, world.blockAt(at));
    }, 300);
  };
  const res = await runFor(clock, bot.actions.dig(new Vec3(0, 63, 0)));
  assert.ifError(res.error);
  assert.ok(yWhenAnswered !== null && yWhenAnswered < 63.5, `к ответу сервера уже падал: y = ${yWhenAnswered}`);
  for (let i = 0; i < 20; i += 1) clock.advance(50);
  assert.ok(Math.abs(bot.entity.position.y - 63) < 1e-6 && bot.entity.onGround, `спрыгнул на блок ниже: ${bot.entity.position}`);
});

test('копание: сервер молча не дал сломать (спавн, «приключение») — на его подтверждении блок у бота возвращается, ошибка «не дал»', async () => {
  const clock = fakeClock();
  const world = makeWorld(require('prismarine-registry')(VERSION));
  const bot = physicsBot({ clock, world, actions: true });
  autoServer(bot, world, { denyDig: true }); // клетку не присылает, только подтверждает номер действия (как Paper)
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  world.set(new Vec3(0, 64, 2), 'iron_ore');
  const seen = [];
  bot.on('physicsTick', () => seen.push(world.get(new Vec3(0, 64, 2))));
  const res = await runFor(clock, bot.actions.dig(new Vec3(0, 64, 2)));
  assert.match(res.error && res.error.message, /сервер не дал сломать блок в 0 64 2/);
  assert.equal(res.error.code, 'rejected');
  assert.equal(world.get(new Vec3(0, 64, 2)), 'iron_ore', 'вернулся как был');
  assert.ok(seen.includes('air'), 'до подтверждения у бота блок был сломан (предсказание, как у клиента)');
  // Копание под себя на спавне: бот не проваливается насовсем — пол возвращается.
  const under = await runFor(clock, bot.actions.dig(new Vec3(0, 63, 0)));
  assert.equal(under.error && under.error.code, 'rejected');
  assert.equal(world.get(new Vec3(0, 63, 0)), 'stone');
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

test('навигация: из ямы в 1 блок — как игрок: вплотную, прыжок вверх, шаг на край, когда ноги выше; в воздухе края не цепляет', async () => {
  const { clock, world, bot } = setup();
  // Бот в яме: пол на 62, стены ямы — камень на 63 вокруг, выйти — на поверхность (ноги на 64) к северу.
  world.set(new Vec3(0, 63, 0), 'air');
  teleport(bot, { x: 0.5, y: 63, z: 0.5 });
  clock.advance(300);
  take(bot);
  const res = await runFor(clock, bot.actions.goTo(new Vec3(0.5, 64, -3.5), { range: 0.6, vertical: 0 }));
  assert.ifError(res.error);
  assert.ok(Math.abs(bot.entity.position.y - 64) < 1e-6 && bot.entity.position.z < -2.8, `выбрался: ${bot.entity.position}`);
  const moves = take(bot).filter((p) => /^(position|position_look)$/.test(p.name));
  const airHits = moves.filter((p) => p.params.flags && !p.params.onGround && p.params.flags.hasHorizontalCollision);
  assert.equal(airHits.length, 0, `в воздухе упирался в край ${airHits.length} раз`);
  assert.ok(moves.some((p) => p.params.y > 64.1), 'прыгал');
});

test('навигация: из мелкой растёкшейся воды на ступеньку — обычным прыжком, как игрок (гребками оттуда не выбраться)', async () => {
  const { clock, world, bot } = setup();
  // Та же яма, но в ней мелкая вода (2/9 блока, как натекает в пещере): игра здесь даёт обычный прыжок со дна.
  world.set(new Vec3(0, 63, 0), 'water#6');
  teleport(bot, { x: 0.5, y: 63, z: 0.5 });
  clock.advance(300);
  take(bot);
  const res = await runFor(clock, bot.actions.goTo(new Vec3(0.5, 64, -3.5), { range: 0.6, vertical: 0 }));
  assert.ifError(res.error);
  assert.ok(Math.abs(bot.entity.position.y - 64) < 1e-6 && bot.entity.position.z < -2.8, `выбрался: ${bot.entity.position}`);
  const moves = take(bot).filter((p) => /^(position|position_look)$/.test(p.name));
  const first = moves.find((p) => p.params.y > 63.0001);
  assert.ok(first && first.params.y - 63 > 0.4, `первый тик прыжка — обычный прыжок, а не гребок: ${first && (first.params.y - 63).toFixed(4)}`);
  const airHits = moves.filter((p) => p.params.flags && !p.params.onGround && p.params.flags.hasHorizontalCollision);
  assert.equal(airHits.length, 0, `в воздухе упирался в край ${airHits.length} раз`);
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

test('открытое окно (сундук) перед действием закрывается — с открытым окном человек не ходит', async () => {
  const { clock, bot } = setup();
  const closed = [];
  bot.currentWindow = { title: 'chest' };
  bot.closeWindow = (w) => {
    closed.push(w.title);
    bot.currentWindow = null;
  };
  assert.ifError((await runFor(clock, bot.actions.walkTo(new Vec3(0.5, 64, 2.5)))).error);
  assert.deepEqual(closed, ['chest']);
  bot.currentWindow = { title: 'barrel' };
  assert.ifError((await runFor(clock, bot.actions.wait(100))).error);
  assert.deepEqual(closed, ['chest'], '«ждать» окно не трогает');
});
