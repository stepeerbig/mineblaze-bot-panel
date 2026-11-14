'use strict';

// Рыбалка: расчёт заброса и мест у воды (src/bot/fishing.js), действие «рыбачить» (src/bot/actions.js) и команда
// #рыбалка (src/bot/commands.js). Сервер — поддельный: на заброс присылает поплавок (свой — с номером бота в
// objectData, рядом — чужой), через время — «клюёт», на подсечку — улов в инвентарь.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { makeWorld, runFor, VERSION } = require('./fake-bot');

const fishing = require(path.join(__dirname, '..', 'src', 'bot', 'fishing.js'));
const { runCommand } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));

const { pond, setup, fishServer, registry } = require('./fish-fake');

const DEG = Math.PI / 180;

test('заброс как у сервера: вниз — у берега, прямо — дальше, вверх — перелетает пруд на берег', () => {
  const world = makeWorld(registry);
  pond(world);
  const cell = fishing.cellReader((p) => world.blockAt(p));
  const eye = new Vec3(5.5, 64 + 1.62, 0.5);
  const east = -Math.PI / 2; // взгляд на восток (+x), как в mineflayer
  const near = fishing.simulateCast(cell, eye, east, -30 * DEG);
  assert.equal(near.hit, 'water');
  assert.deepEqual([near.cell.x, near.cell.y], [8, 63]);
  const mid = fishing.simulateCast(cell, eye, east, -14 * DEG);
  assert.equal(mid.hit, 'water');
  assert.ok(mid.cell.x > near.cell.x, `дальше: ${mid.cell.x}`);
  const over = fishing.simulateCast(cell, eye, east, 30 * DEG);
  assert.equal(over.hit, 'block', 'вверх на 30° — за пруд, на камень');
  assert.ok(over.at.x > 14);
  // Игрок на пути поплавка — его зацепило бы.
  const hooked = fishing.simulateCast(cell, eye, east, -14 * DEG, { others: [new Vec3(8.5, 64, 0.5)] });
  assert.equal(hooked.hit, 'entity');
});

test('места у воды: каждому боту своё (в 2+ блоках от другого), занятое игроком — не берёт; заброс — в воду', () => {
  const { bot } = setup();
  const home = new Vec3(0.5, 64, 0.5);
  const a = fishing.planSpot(bot, home, { owner: 'a' });
  assert.ok(!a.none, JSON.stringify(a));
  assert.deepEqual([a.feet.x, a.feet.y, a.feet.z], [5, 64, 0], 'ближний берег к дому');
  assert.ok(a.landing.x >= 6 && a.landing.x <= 13 && a.landing.y === 63, `поплавок в пруду: ${a.landing}`);
  fishing.claimSpot(a.feet, 'a');
  const b = fishing.planSpot(bot, home, { owner: 'b' });
  assert.ok(!b.none);
  assert.ok(Math.hypot(a.feet.x - b.feet.x, a.feet.z - b.feet.z) >= fishing.SPOT_GAP, `${a.feet} и ${b.feet}`);
  // Третий — в другом процессе (его записи не видно), но на месте b уже стоит игрок.
  fishing.releaseSpot('a');
  bot.entities[77] = { id: 77, type: 'player', username: 'Other', position: new Vec3(a.feet.x + 0.5, 64, a.feet.z + 0.5) };
  const c = fishing.planSpot(bot, home, { owner: 'c' });
  assert.ok(!c.none);
  assert.ok(Math.hypot(a.feet.x - c.feet.x, a.feet.z - c.feet.z) >= 1.8, 'где стоит игрок — не встаёт');
  delete bot.entities[77];
  fishing.releaseSpot('b');
  fishing.releaseSpot('c');
  // Воды нет — так и говорит.
  const dry = setup();
  for (const p of dry.world.list()) dry.world.set(p, 'stone');
  assert.equal(fishing.planSpot(dry.bot, home, { owner: 'd' }).none, 'no_water');
});

test('рыбачить: заброс — use_item и взмах; свой поплавок (чужой рядом — не путает); клюнуло — подсечка через 3–7 тиков; улов', async () => {
  const { clock, bot } = setup({ at: { x: 5.5, y: 64, z: 0.5 } });
  bot.inventory.slots[36] = { name: 'fishing_rod', count: 1 };
  const st = fishServer(bot, { biteTicks: 40 });
  const r = await runFor(clock, bot.actions.fish({ yaw: -Math.PI / 2, pitch: -14 * DEG }), 60000);
  assert.ifError(r.error);
  assert.equal(r.value.outcome, 'caught');
  assert.equal(r.value.collected, true, 'улов подобрал');
  assert.equal(st.casts, 1);
  assert.equal(st.reels, 1);
  assert.ok(st.reelAfterBite[0] >= 3 && st.reelAfterBite[0] <= 10, `подсёк через ${st.reelAfterBite[0]} тиков после поклёвки`);
  const order = bot._client.sent.map((p) => p.name).filter((n) => n === 'use_item' || n === 'arm_animation');
  assert.deepEqual(order, ['use_item', 'arm_animation', 'use_item', 'arm_animation'], 'как клиент: правая кнопка, потом взмах');
  assert.equal(bot.actions.bobber, null, 'поплавка нет');
});

test('рыбачить: #стоп, пока ждёт поклёвку, — поплавок вытаскивает и останавливается', async () => {
  const { clock, bot } = setup({ at: { x: 5.5, y: 64, z: 0.5 } });
  bot.inventory.slots[36] = { name: 'fishing_rod', count: 1 };
  const st = fishServer(bot, { biteTicks: 100000 });
  const p = bot.actions.fish({ yaw: -Math.PI / 2, pitch: -14 * DEG });
  const done = runFor(clock, p, 60000);
  for (let i = 0; i < 80 && st.bobber === null; i += 1) {
    clock.advance(50);
    await new Promise((r) => setImmediate(r));
  }
  assert.notEqual(st.bobber, null, 'заброс был');
  for (let i = 0; i < 20; i += 1) {
    clock.advance(50);
    await new Promise((r) => setImmediate(r));
  }
  bot.actions.stop();
  const r = await done;
  assert.equal(r.error && r.error.code, 'stopped');
  for (let i = 0; i < 6; i += 1) {
    clock.advance(50);
    await new Promise((r2) => setImmediate(r2));
  }
  assert.equal(st.reels, 1, 'после #стоп — вытащил поплавок');
  assert.equal(st.bobber, null);
});

test('#рыбалка здесь 2: удочку из сундука, место на берегу, ловит 2 и заканчивает; ход — событиями «fishing»', async () => {
  const s = setup({ storage: { '2,64,-2': { items: [[0, 'fishing_rod', 1], [1, 'fishing_rod', 1], [2, 'fishing_rod', 1], [3, 'fishing_rod', 1], [5, 'bread', 10]] } } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  const st = fishServer(s.bot, { biteTicks: 30, loot: 'cod' });
  const events = [];
  s.bot.on('fishing', (e) => events.push(e));
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 2'), 900000);
  assert.ifError(r.error);
  const text = [].concat(r.value.message).join('\n');
  assert.equal(r.value.ok, true, text);
  assert.equal(r.value.data.caught, 2, text);
  assert.deepEqual(r.value.data.items, { cod: 2 });
  assert.match(text, /Рыбалка готова: поймал 2 — треска ×2/);
  assert.equal(r.value.data.rods, 1, 'взял одну целую удочку (остальные — в сундуке)');
  assert.equal(st.casts, 2);
  const p = s.bot.entity.position;
  assert.ok(Math.abs(p.x - 5.5) < 0.5 && Math.abs(p.z - 0.5) < 0.5, `стоит на берегу: ${p}`);
  const states = new Set(events.map((e) => e.state));
  for (const want of ['rods', 'search', 'walk', 'fishing', 'done']) assert.ok(states.has(want), `событие ${want}: ${[...states]}`);
  assert.equal(events[events.length - 1].caught, 2);
  assert.deepEqual(fishing._claims.size, 0, 'место освободил');
});

test('#рыбалка здесь: инвентарь забит — улов в сундук склада и дальше; #стоп — «остановлена» и итог', async () => {
  const s = setup({ storage: { '2,64,-2': { items: [] } } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  s.bot.inventory.slots[36] = { name: 'fishing_rod', count: 1 };
  for (let i = 9; i < 44; i += 1) if (i !== 36) s.bot.inventory.slots[i] = { name: 'cod', count: 64 }; // одна ячейка свободна
  const st = fishServer(s.bot, { biteTicks: 30, loot: 'salmon' });
  const events = [];
  s.bot.on('fishing', (e) => events.push(e));
  const cmd = runCommand(s.bot, '#рыбалка здесь');
  const done = runFor(s.clock, cmd, 900000);
  // Ждём два улова, потом — #стоп (как кнопка «Стоп» во вкладке «Авто фиш»).
  for (let i = 0; i < 20000 && st.reels < 2; i += 1) {
    s.clock.advance(50);
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(st.reels >= 2, `подсекал: ${st.reels}`);
  await runCommand(s.bot, '#стоп');
  const r = await done;
  assert.ifError(r.error);
  const text = [].concat(r.value.message).join('\n');
  assert.equal(r.value.code, 'stopped', text);
  assert.match(text, /Рыбалка остановлена: поймал \d+ — лосось/);
  assert.match(text, /Сложил в сундуки склада: треска ×\d+/);
  assert.ok(r.value.data.stored.cod >= 27 * 64 - 64, `в сундук: ${r.value.data.stored.cod}`);
  assert.equal(events[events.length - 1].state, 'stopped');
});

test('общий сундук: удочку из-под руки забрал другой бот — берёт следующую, по пустой ячейке не щёлкает', async () => {
  const { moveStacks, storageSlots, playerSlots } = require(path.join(__dirname, '..', 'src', 'bot', 'chests.js'));
  const s = setup({ storage: { '2,64,-2': { items: [[0, 'fishing_rod', 1], [1, 'fishing_rod', 1], [2, 'fishing_rod', 1]] } } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  let window = null;
  let ticks = 0;
  s.bot.on('windowOpen', (w) => {
    window = w;
    ticks = 0;
  });
  // Пока бот «тянется» к первой удочке (пауза перед первым кликом), её забирает другой бот.
  s.bot.on('physicsTick', () => {
    ticks += 1;
    if (window && ticks === 3) window.slots[0] = null;
  });
  const opened = await runFor(s.clock, s.bot.actions.activate(new Vec3(2, 64, -2)), 30000);
  assert.ifError(opened.error);
  for (let i = 0; i < 10 && !window; i += 1) await runFor(s.clock, s.bot.actions.wait(50), 1000);
  assert.ok(window, 'сундук открылся');
  const r = await runFor(s.clock, moveStacks(s.bot, window, storageSlots(window), playerSlots(window), (it) => it.name === 'fishing_rod', 2), 60000);
  assert.ifError(r.error);
  assert.equal(r.value.moved.get('fishing_rod'), 2, 'взял две оставшиеся');
  assert.equal(r.value.lost, 1);
  assert.equal(r.value.rejected, false);
  assert.ok(!s.bot.clicks.some((c) => c.slot === 0), 'по пустой ячейке не щёлкал');
});

test('заброс: улов летит обратно мимо соседа — так не забрасывает; всплеск у чужого поплавка — не поклёвка', async () => {
  const world = makeWorld(registry);
  pond(world);
  const cell = fishing.cellReader((p) => world.blockAt(p));
  const eye = new Vec3(5.5, 64 + 1.62, 0.5);
  const waters = [];
  for (let x = 6; x <= 13; x += 1) for (let z = -4; z <= 3; z += 1) waters.push(new Vec3(x, 63, z));
  // Сосед на берегу в 2 блоках (z = 2.5): улов не должен лететь мимо него.
  const neighbor = new Vec3(5.5, 64, 2.5);
  const plan = fishing.planCast(cell, eye, waters, { others: [neighbor] });
  assert.ok(plan, 'заброс нашёлся');
  const clear = fishing.returnClearance(neighbor, plan.at, eye);
  assert.ok(clear >= fishing.STEAL_RANGE, `путь улова в ${clear.toFixed(2)} бл. от соседа`);
  // Как на стенде: соседи с обеих сторон в 2 блоках, а воды больше наискосок — заброс всё равно почти поперёк
  // берега (стенд 12.11: наискосок на 26° — улов уходил соседу).
  const both = fishing.planCast(cell, eye, waters, { others: [neighbor, new Vec3(5.5, 64, -1.5)] });
  assert.ok(both, 'заброс между двумя соседями нашёлся');
  const off = Math.abs(Math.atan2(both.at.z - eye.z, both.at.x - eye.x)) * 180 / Math.PI;
  assert.ok(off <= 6, `отклонение от «поперёк берега» ${off.toFixed(1)}°`);

  // Всплеск: свой поплавок в 2 блоках от соседского, всплеск — у соседского.
  const s = setup({ at: { x: 5.5, y: 64, z: 0.5 } });
  s.bot.inventory.slots[36] = { name: 'fishing_rod', count: 1 };
  const st = fishServer(s.bot, { biteTicks: 100000 });
  const p = s.bot.actions.fish({ yaw: -Math.PI / 2, pitch: -14 * DEG, maxWaitTicks: 200 });
  const done = runFor(s.clock, p, 60000);
  for (let i = 0; i < 80 && st.bobber === null; i += 1) {
    s.clock.advance(50);
    await new Promise((r) => setImmediate(r));
  }
  for (let i = 0; i < 10; i += 1) {
    s.clock.advance(50);
    await new Promise((r) => setImmediate(r));
  }
  const other = Object.values(s.bot.entities).find((e) => e.name === 'fishing_bobber' && e.id !== st.bobber);
  s.bot.emit('soundEffectHeard', 'entity.fishing_bobber.splash', other.position.offset(0.1, 0.5, 0.1), 0.25, 1);
  const r = await done;
  assert.ifError(r.error);
  assert.equal(r.value.outcome, 'timeout', 'чужой всплеск не принял за поклёвку');
  assert.equal(st.reelAfterBite[0], null);
});

test('клетки для расчёта: из палитры чанка (быстро) — то же, что по одному блоку', () => {
  const Chunk = require('prismarine-chunk')(VERSION);
  const column = new Chunk({ minY: -64, worldHeight: 384 });
  const set = (x, y, z, name) => column.setBlockStateId(new Vec3(x, y, z), registry.blocksByName[name].defaultState);
  for (let x = 0; x < 16; x += 1) for (let z = 0; z < 16; z += 1) set(x, 63, z, 'stone');
  set(5, 63, 5, 'water');
  set(6, 63, 5, 'seagrass');
  set(7, 64, 5, 'oak_fence');
  const world = { getColumn: (cx, cz) => (cx === 0 && cz === 0 ? column : null) };
  const Block = require('prismarine-block')(registry);
  const blockAt = (p) => {
    if (p.x < 0 || p.x > 15 || p.z < 0 || p.z > 15) return null;
    const b = Block.fromStateId(column.getBlockStateId(new Vec3(p.x, p.y, p.z)), 0);
    b.position = p;
    return b;
  };
  const fast = fishing.cellReader(blockAt, { world, registry });
  const slow = fishing.cellReader(blockAt);
  for (const [x, y, z] of [[5, 63, 5], [6, 63, 5], [7, 64, 5], [1, 63, 1], [1, 64, 1], [20, 63, 1]]) {
    const a = fast(x, y, z);
    const b = slow(x, y, z);
    for (const k of ['loaded', 'water', 'solid', 'passable', 'floor', 'top']) assert.equal(a[k], b[k], `${k} в ${x} ${y} ${z}`);
  }
  assert.equal(fast(5, 63, 5).water, true);
  assert.equal(fast(6, 63, 5).water, true, 'морская трава — тоже вода');
  assert.equal(fast(7, 64, 5).top > 1, true, 'забор выше своей клетки');
  assert.equal(fast(20, 63, 1).loaded, false, 'не загружено');
});

test('удачный заброс повторяется без пересчёта, пока бот стоит там же и на пути улова никого', () => {
  const { bot } = setup({ at: { x: 5.5, y: 64, z: 0.5 } });
  const plan = fishing.planFromHere(bot);
  assert.ok(plan && plan.eyeAt, 'заброс посчитан');
  assert.equal(fishing.castStillGood(bot, plan), true);
  // Встал игрок на пути улова назад — считать заново.
  bot.entities[55] = { id: 55, type: 'player', username: 'X', position: new Vec3((plan.at.x + 5.5) / 2, 64, (plan.at.z + 0.5) / 2) };
  assert.equal(fishing.castStillGood(bot, plan), false);
  delete bot.entities[55];
  // Бота сдвинули — тоже.
  bot.entity.position = new Vec3(5.2, 64, 0.5);
  assert.equal(fishing.castStillGood(bot, plan), false);
  assert.equal(fishing.castStillGood(bot, null), false);
});
