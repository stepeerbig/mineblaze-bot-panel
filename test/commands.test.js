'use strict';

// Команды боту из строки чата (src/bot/commands.js): простые формы по-русски, ответ человеку в консоль
// и данные для ИИ ({ ok, message, data }). Бот — поддельный, с нашей физикой и действиями (test/fake-bot.js).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { fakeClock, makeWorld, physicsBot, autoServer, teleport, take, runFor, VERSION } = require('./fake-bot');

const { runCommand, catalog, COMMANDS, parseCoord, parseBlockPos, itemTest, storageArgs, pingReport } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));

/** Бот стоит в 0.5 64 0.5 на камне, смотрит на юг (+z). players: [{ name, at: [x, y, z] }], inventory: [[имя, кол-во]]. */
function setup({ players = [], farPlayers = [], chests = {}, storage = {}, inventory = [], entities = [], npcs = {}, onClick = null, server = {} } = {}) {
  const clock = fakeClock();
  const world = makeWorld(require('prismarine-registry')(VERSION));
  const bot = physicsBot({ clock, world, actions: true });
  autoServer(bot, world, { chests, storage, npcs, onClick, ...server });
  for (const e of entities) bot.entities[e.id] = e;
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  take(bot);
  bot.players = {};
  let id = 100;
  for (const p of players) {
    id += 1;
    const entity = { id, type: 'player', username: p.name, position: new Vec3(...p.at), height: 1.8 };
    bot.entities[id] = entity;
    bot.players[p.name] = { username: p.name, entity };
  }
  for (const name of farPlayers) bot.players[name] = { username: name }; // на сервере, но далеко
  inventory.forEach(([name, count], i) => {
    bot.inventory.slots[36 + i] = { name, count, displayName: name };
  });
  const logs = [];
  const run = async (line, maxMs) => {
    const r = await runFor(clock, runCommand(bot, line, (level, text) => logs.push(`${level}:${text}`)), maxMs);
    assert.ifError(r.error); // runCommand сам не падает: ошибки — в ответе
    return r.value;
  };
  return { clock, world, bot, logs, run };
}

const near = (a, b, eps = 0.3) => Math.abs(a - b) <= eps;

test('команды: один список — имена по-русски и по-английски, как писать, что делают; имена не повторяются', () => {
  const list = catalog();
  assert.equal(list.length, COMMANDS.length);
  const seen = new Set();
  for (const c of list) {
    assert.ok(c.usage.length && c.usage.every((u) => u.startsWith('#')), `${c.name}: примеры начинаются с #`);
    assert.ok(c.about.length > 5, `${c.name}: есть описание`);
    for (const n of [c.name, ...c.aliases]) {
      const key = n.toLowerCase().replace(/ё/g, 'е');
      assert.ok(!seen.has(key), `имя «${n}» встречается дважды`);
      seen.add(key);
    }
  }
  for (const en of ['help', 'pos', 'look', 'goto', 'dig', 'place', 'use', 'open', 'equip', 'inv', 'near', 'stop']) assert.ok(seen.has(en), `есть английское ${en}`);
});

test('команды: #охрана — что с охраной, вкл сразу, выкл; выключена в настройках — честно скажет', async () => {
  const { Guard } = require(path.join(__dirname, '..', 'src', 'bot', 'guard.js'));
  const { bot, run } = setup();
  const sent = [];
  const config = { guard: true, whitelist: 'Friend\nДруг' };
  bot.guard = new Guard({ getBot: () => bot, send: (cmd) => sent.push(cmd), log: () => {}, config });

  let r = await run('#охрана');
  assert.equal(r.ok, true);
  assert.equal(r.message, 'Охрана ждёт: включится после /home или /rtp; белый список: 2 ника');
  assert.deepEqual(r.data, { armed: false, active: false, pvp: false });

  r = await run('#охрана вкл');
  assert.equal(r.ok, true);
  assert.match(r.message, /^Охрана следит: \/near раз в 5 с/);
  assert.equal(bot.guard.active, true);

  r = await run('#guard выкл');
  assert.equal(r.message, 'Охрана выключена до следующего /home или /rtp');
  assert.equal(bot.guard.active, false);

  config.guard = false;
  r = await run('#охрана вкл');
  assert.equal(r.ok, false);
  assert.match(r.message, /выключена в настройках/);
  r = await run('#охрана туда');
  assert.equal(r.code, 'bad_args');
  bot.guard.stop();
});

test('команды: координаты как в игре — числа и «~» от бота', () => {
  assert.equal(parseCoord('10', 0), 10);
  assert.equal(parseCoord('-3,5', 0), -3.5);
  assert.equal(parseCoord('~', 7), 7);
  assert.equal(parseCoord('~-2', 7), 5);
  assert.throws(() => parseCoord('abc', 0), /непонятная координата/);
  assert.deepEqual(parseBlockPos(['~1', '~', '~-1'], new Vec3(0.5, 64, 0.5)), new Vec3(1, 64, -1));
});

test('команды: #где и #инвентарь — понятная строка человеку и данные для ИИ', async () => {
  const { run, logs } = setup({ inventory: [['dirt', 10], ['iron_pickaxe', 1]] });
  const where = await run('#где');
  assert.equal(where.ok, true);
  assert.deepEqual(where.data.position, { x: 0.5, y: 64, z: 0.5 });
  assert.equal(where.data.facing, 'юг');
  assert.ok(logs.includes('info:Бот: 0.5 64.0 0.5, смотрит на юг (0.0 / 0.0)'), logs.join('\n'));
  const inv = await run('#инвентарь');
  assert.deepEqual(inv.data.items, [{ name: 'dirt', count: 10 }, { name: 'iron_pickaxe', count: 1 }]);
  assert.ok(logs.includes('info:Инвентарь: dirt×10, iron_pickaxe×1'));
  assert.ok(logs.includes('info:В руке: ничего'));
  await run('#pos'); // английское имя той же команды
  assert.equal(logs.filter((l) => l.startsWith('info:Бот:')).length, 2);
});

test('команды: #смотри — вниз, прямо, налево, на игрока, на блок, по углам', async () => {
  const { run } = setup({ players: [{ name: 'Steve', at: [0.5, 64, 6.5] }], farPlayers: ['Alex'] });
  assert.ok(near((await run('#смотри вниз')).data.pitch, 90, 0.2));
  assert.ok(near((await run('#смотри прямо')).data.pitch, 0, 0.2));
  const left = await run('#смотри налево');
  assert.ok(near(left.data.yaw, -90, 0.2), `налево от юга — восток (-90), а не ${left.data.yaw}`);
  const steve = await run('#смотри на steve'); // ник — без учёта регистра
  assert.ok(near(steve.data.yaw, 0, 0.5) && steve.message.startsWith('Смотрит на Steve'));
  const block = await run('#смотри 0 64 2');
  assert.ok(near(block.data.yaw, 0, 0.5) && block.data.pitch > 20 && block.data.pitch < 35);
  assert.ok(near((await run('#смотри 90 0')).data.yaw, 90, 0.2));
  const far = await run('#смотри на Alex');
  assert.equal(far.ok, false);
  assert.match(far.message, /Alex далеко — бот его не видит/);
});

test('команды: #иди ко мне / к нику / назад N; если рядом несколько — спросить, к кому', async () => {
  const one = setup({ players: [{ name: 'Steve', at: [0.5, 64, 6.5] }] });
  const come = await one.run('#иди ко мне');
  assert.equal(come.ok, true, come.message);
  assert.equal(come.message, 'Подошёл к Steve');
  assert.ok(one.bot.entity.position.distanceTo(new Vec3(0.5, 64, 6.5)) < 2.1);
  const startZ = Math.floor(one.bot.entity.position.z) + 0.5; // три блока — от центра клетки, где бот стоит
  const back = await one.run('#назад 3');
  assert.equal(back.ok, true, back.message);
  assert.equal(back.data.direction, 'север');
  assert.ok(near(one.bot.entity.position.z, startZ - 3, 0.45), `${one.bot.entity.position}, ждали z≈${startZ - 3}`);

  const two = setup({ players: [{ name: 'Steve', at: [0.5, 64, 6.5] }, { name: 'Alex', at: [3.5, 64, 0.5] }] });
  const ask = await two.run('#иди ко мне');
  assert.equal(ask.ok, false);
  assert.match(ask.message, /рядом несколько игроков: Alex \(3 бл\.\), Steve \(6 бл\.\) — скажи, к кому: #иди к Alex/);
  assert.equal((await two.run('#иди к Alex')).ok, true);
  assert.match((await two.run('#иди 1000 64 0')).message, /слишком далеко/);
  assert.match((await two.run('#иди')).message, /куда идти\?/);
  assert.match((await two.run('#иди туда-сюда')).message, /не понял, куда идти/);
});

test('команды: #иди X Y Z — поиск пути: обходит стену, запрыгивает на ступеньку, спускается с уступа; заперт — честно скажет', async () => {
  const s = setup();
  for (let z = -4; z <= 4; z += 1) for (const y of [64, 65, 66]) s.world.set(new Vec3(4, y, z), 'stone'); // стена поперёк
  for (let x = 8; x <= 12; x += 1) for (let z = -2; z <= 2; z += 1) s.world.set(new Vec3(x, 64, z), 'stone'); // помост на блок выше
  const up = await s.run('#иди 10 65 0', 120000);
  assert.equal(up.ok, true, [].concat(up.message).join('\n'));
  const p = s.bot.entity.position;
  assert.ok(Math.hypot(p.x - 10.5, p.z - 0.5) < 1 && Math.abs(p.y - 65) < 0.01, `на помосте: ${p}`);
  const down = await s.run('#иди 15 64 0', 120000);
  assert.equal(down.ok, true, [].concat(down.message).join('\n'));
  assert.ok(Math.abs(s.bot.entity.position.y - 64) < 0.01, 'спустился');

  const shut = setup();
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    for (const y of [64, 65, 66]) shut.world.set(new Vec3(x, y, z), 'stone');
  }
  const no = await shut.run('#иди 10 64 0', 60000);
  assert.equal(no.ok, false);
  assert.equal(no.code, 'no_path');
  assert.match([].concat(no.message).join('\n'), /не нашёл пути до 10 64 0: пути нет/);
});

test('команды: #копай — то, на что смотрит, или впереди; #поставь — по-русски и впереди; понятные отказы', async () => {
  const { run, world, bot } = setup({ inventory: [['dirt', 10]] });
  world.set(new Vec3(0, 64, 2), 'stone');
  await run('#смотри 0 64 2');
  const dug = await run('#копай');
  assert.equal(dug.ok, true, dug.message);
  assert.equal(dug.message, 'Сломал stone в 0 64 2 (10 тиков)');
  assert.equal(world.get(new Vec3(0, 64, 2)), 'air');

  const placed = await run('#поставь впереди земля');
  assert.equal(placed.ok, true, placed.message);
  assert.equal(placed.message, 'Поставил dirt в 0 64 1');
  assert.equal(bot.heldItem.name, 'dirt', 'землю сам взял в руку');
  assert.equal((await run('#копай впереди')).ok, true);

  await run('#смотри вниз');
  assert.match((await run('#поставь')).message, /где стоит бот/);
  assert.match((await run('#поставь под земля')).message, /под ноги пока не умею/);
  assert.match((await run('#поставь впереди алмаз')).message, /у бота нет «алмаз»\. В инвентаре: dirt×10/);
  await run('#смотри вверх');
  assert.match((await run('#копай')).message, /бот не видит блока рядом/);
  assert.match((await run('#копай где-то')).message, /не понял, что копать/);
});

test('команды: #открой — ближайший сундук: показать, что внутри, и закрыть; #рядом — игроки и сундуки', async () => {
  const chest = new Vec3(1, 64, 2);
  const { run, world, bot, logs } = setup({
    players: [{ name: 'Steve', at: [0.5, 64, 6.5] }],
    chests: { '1,64,2': [{ name: 'diamond', count: 3 }, { name: 'iron_ingot', count: 12 }] },
  });
  assert.match((await run('#открой')).message, /рядом нет сундука/);
  world.set(chest, 'chest');
  const opened = await run('#открой');
  assert.equal(opened.ok, true, opened.message);
  assert.equal(opened.message, 'Открыл chest в 1 64 2: iron_ingot×12, diamond×3 — и закрыл');
  assert.deepEqual(opened.data.opened.items, [{ name: 'iron_ingot', count: 12 }, { name: 'diamond', count: 3 }]);
  assert.equal(bot.currentWindow, null, 'сундук закрыт');
  assert.ok(take(bot).some((p) => p.name === 'close_window'));

  const nearby = await run('#рядом');
  assert.deepEqual(nearby.data.players.map((p) => p.name), ['Steve']);
  assert.deepEqual(nearby.data.containers.map((c) => c.position), [{ x: 1, y: 64, z: 2 }]);
  assert.ok(logs.includes('info:Игроки: Steve — 6 бл. на юг'), logs.join('\n'));
  assert.ok(logs.some((l) => l.startsWith('info:Сундуки: chest в 1 64 2')));
});

const invCount = (bot, name) => bot.inventory.slots.slice(9, 45).filter((it) => it && it.name === name).reduce((n, it) => n + it.count, 0);
const invNames = (bot) => [...new Set(bot.inventory.slots.slice(9, 45).filter(Boolean).map((it) => it.name))];

test('команды: #достань — из ближайшего сундука целыми стопками, по-русски; #положи всё — кроме инструментов', async () => {
  const { run, world, bot } = setup({
    inventory: [['iron_pickaxe', 1], ['bread', 24], ['string', 24]],
    storage: {
      '1,64,2': {
        items: [[0, 'wheat', 64], [1, 'hay_block', 32], [2, 'wheat', 64], [3, 'wheat', 64], [4, 'wheat', 64], [5, 'wheat', 30], [6, 'wheat_seeds', 64], [7, 'pumpkin_seeds', 10]],
      },
    },
  });
  assert.match((await run('#достань пшеница 100')).message, /рядом нет сундука/);
  world.set(new Vec3(1, 64, 2), 'chest');

  const took = await run('#достань пшеница 100');
  assert.equal(took.ok, true, took.message);
  assert.equal(took.message, 'Сундук 1 64 2: достал wheat×128 (просили 100 — беру целыми стопками)');
  assert.equal(bot.currentWindow, null, 'сундук закрыт');
  assert.equal(invCount(bot, 'wheat'), 128);
  assert.ok(bot.clicks.length === 2 && bot.clicks.every((c) => c.mode === 1 && c.mouseButton === 0), 'по стопке — shift-клик');
  assert.deepEqual(took.data.moved, [{ name: 'wheat', count: 128 }]);

  assert.equal((await run('#достань семена')).message, 'Сундук 1 64 2: достал wheat_seeds×64, pumpkin_seeds×10');
  const none = await run('#достань морковь');
  assert.equal(none.ok, false);
  assert.equal(none.message, 'Сундук 1 64 2: нет «морковь». Там: hay_block×32, wheat×158');

  const put = await run('#положи всё');
  assert.equal(put.ok, true, put.message);
  assert.equal(put.message, 'Сундук 1 64 2: положил bread×24, string×24, pumpkin_seeds×10, wheat_seeds×64, wheat×128 (оставил себе: iron_pickaxe×1)');
  assert.deepEqual(invNames(bot), ['iron_pickaxe']);
  assert.equal((await run('#положи всё')).message, 'Класть нечего: в инвентаре только инструменты и броня (iron_pickaxe×1)');
  assert.equal((await run('#положи кирка в 1 64 2')).message, 'Сундук 1 64 2: положил iron_pickaxe×1');
  assert.deepEqual(invNames(bot), []);
});

test('команды: склад — инвентарь полон, сервер не дал, «#возьми … из сундука», сундук по координатам', async () => {
  const { run, world, bot } = setup({
    storage: { '1,64,2': { items: [[0, 'wheat', 64]] }, '-2,64,3': { items: [[0, 'diamond', 5]], reject: true } },
  });
  world.set(new Vec3(1, 64, 2), 'chest');
  world.set(new Vec3(-2, 64, 3), 'barrel');
  const Item = require('prismarine-item')(bot.registry);
  for (let i = 9; i < 45; i += 1) bot.inventory.slots[i] = new Item(bot.registry.itemsByName.stone.id, 64);
  const full = await run('#достань пшеница из 1 64 2');
  assert.equal(full.ok, false);
  assert.equal(full.message, 'Сундук 1 64 2: ничего не достал — инвентарь полон');
  for (let i = 9; i < 45; i += 1) bot.inventory.slots[i] = null;

  const guarded = await run('#возьми алмаз из -2 64 3');
  assert.equal(guarded.ok, false);
  assert.equal(guarded.message, 'Бочка -2 64 3: ничего не достал — сервер не дал взять');
  assert.equal(bot.currentWindow, null);

  const took = await run('#возьми пшеницу из сундука');
  assert.equal(took.message, 'Сундук 1 64 2: достал wheat×64');
  assert.match((await run('#достань пшеница из огорода')).message, /не понял, что за сундук: «огорода»/);
  assert.match((await run('#достань пшеница из 0 64 9')).message, /в 0 64 9 нет сундука \(там air\)/);
  assert.match((await run('#положи')).message, /что положить\?/);
  assert.equal((await run('#положи алмаз')).message, 'Класть нечего: в инвентаре нет «алмаз»');
});

test('склад: разбор слов — что, сколько, откуда; предметы по-русски и по id', () => {
  const norm = (s) => s.toLowerCase().replace(/ё/g, 'е');
  const p = (line, preps) => {
    const args = line.split(' ');
    return storageArgs(args, args.map(norm), preps);
  };
  assert.deepEqual(p('пшеница 224 из 10 64 -3', ['из']), { query: 'пшеница', want: 224, at: ['10', '64', '-3'] });
  assert.deepEqual(p('из сундука пшеницу', ['из']), { query: 'пшеницу', want: Infinity, at: null });
  assert.deepEqual(p('всё', ['в']), { query: '', want: Infinity, at: null });
  assert.deepEqual(p('всё 10 64 -3', ['в']), { query: '', want: Infinity, at: ['10', '64', '-3'] });
  assert.throws(() => p('всё в огород', ['в']), /не понял, что за сундук/);

  const registry = require('prismarine-registry')(VERSION);
  const all = ['wheat', 'wheat_seeds', 'pumpkin_seeds', 'carrot', 'oak_planks', 'iron_pickaxe', 'cod', 'salmon', 'sweet_berries', 'leather', 'egg'];
  const pick = (q) => all.filter((name) => itemTest(q, registry)({ name, displayName: name }));
  assert.deepEqual(pick('пшеница'), ['wheat']);
  assert.deepEqual(pick('wheat'), ['wheat'], 'точный id — без семян');
  assert.deepEqual(pick('семена'), ['wheat_seeds', 'pumpkin_seeds']);
  assert.deepEqual(pick('доски'), ['oak_planks']);
  assert.deepEqual(pick('кирку'), ['iron_pickaxe']);
  assert.deepEqual(pick('рыба'), ['cod', 'salmon']);
  assert.deepEqual(pick('ягоды'), ['sweet_berries']);
  assert.deepEqual(pick('кожа'), ['leather']);
  assert.deepEqual(pick('яйца'), ['egg']);
  assert.deepEqual(pick('seeds'), ['wheat_seeds', 'pumpkin_seeds'], 'незнакомое слово — по части id');
});

test('команды: #возьми — по-русски выбирает лучшую кирку, понимает «доски» и часть имени', async () => {
  const { run, bot } = setup({ inventory: [['wooden_pickaxe', 1], ['iron_pickaxe', 1], ['stone_pickaxe', 1], ['oak_planks', 20]] });
  assert.equal((await run('#возьми кирка')).message, 'В руке: iron_pickaxe');
  assert.equal((await run('#возьми дубовые доски')).message, 'В руке: oak_planks');
  await run('#возьми iron_pickaxe');
  assert.equal((await run('#возьми planks')).data.item, 'oak_planks');
  assert.equal(bot.heldItem.name, 'oak_planks');
  assert.match((await run('#возьми')).message, /что взять\?/);
});

test('команды: NPC — #сущности, #нажми по имени (и по надписи над ним), #окно с описаниями, #клик, #закрой', async () => {
  const json = (text) => JSON.stringify({ text });
  const slots = (filled) => {
    const s = new Array(90).fill(null);
    for (const [i, it] of Object.entries(filled)) s[i] = it;
    return s;
  };
  const farmerMenu = () => ({
    id: 5,
    title: json('Фермер › Уровень 3'),
    inventoryStart: 54,
    slots: slots({
      20: { name: 'hay_block', count: 3, customName: json('Покупка'), customLore: [json('Вам доступны товары 3 уровня')] },
      24: { name: 'experience_bottle', count: 1, customName: '{"text":"Улучшения","color":"green"}', customLore: [json('Повышайте уровень доверия фермера'), json('Вам доступны товары 3 уровня')] },
    }),
  });
  const questsMenu = () => ({
    id: 6,
    title: json('Фермер › Уровень 2 → 4'),
    inventoryStart: 54,
    slots: slots({ 10: { name: 'cookie', count: 1, customName: json('Какао для настроения.'), customLore: [json('• Награда: 32 печенья'), json('Передайте какао-бобы или печенье: 0/96')] } }),
  });
  const villager = (id, x, z, name) => ({
    id, type: 'mob', name: 'villager', position: new Vec3(x, 64, z), height: 1.95, width: 0.6,
    getCustomName: () => (name ? { json: { text: name }, toString: () => name } : null),
  });
  const { run, bot, logs } = setup({
    entities: [
      villager(201, 0.5, 2.5, null), // имя — только в надписи над ним
      { id: 202, type: 'object', name: 'text_display', position: new Vec3(0.5, 66.4, 2.5), metadata: [0, 0, null, json('Фермер')] },
      villager(203, 3.5, 2.5, 'Оружейник'),
    ],
    npcs: { 201: farmerMenu },
    onClick: (window, slot) => (window.id === 5 && slot === 24 ? questsMenu() : null),
  });

  const list = await run('#сущности');
  assert.deepEqual(list.data.entities.map((e) => [e.id, e.type, e.name]), [[201, 'villager', null], [202, 'text_display', 'Фермер'], [203, 'villager', 'Оружейник']]);
  assert.ok(logs.includes('info:@202 text_display «Фермер» — 3.1 бл.'), logs.join('\n'));

  const opened = await run('#нажми Фермер');
  assert.equal(opened.ok, true, opened.message);
  assert.equal(opened.message, 'Нажал на Фермер: открылось меню «Фермер › Уровень 3» — #окно покажет, что в нём');
  const uses = take(bot).filter((p) => p.name === 'use_entity');
  assert.deepEqual(uses.map((p) => [p.params.target, p.params.mouse]), [[201, 2], [201, 0]], 'как клиент: «нажать в точку», потом «нажать»');

  const menu = await run('#окно');
  assert.deepEqual(menu.message, [
    'Меню «Фермер › Уровень 3»: предметов 2',
    '[20] Покупка ×3 (hay_block) — Вам доступны товары 3 уровня',
    '[24] Улучшения (experience_bottle) — Повышайте уровень доверия фермера / Вам доступны товары 3 уровня',
  ]);
  const click = await run('#клик 24');
  assert.equal(click.message, 'Клик по [24] Улучшения: открылось меню «Фермер › Уровень 2 → 4» — #окно покажет, что в нём');
  assert.deepEqual(bot.clicks.map((c) => [c.window, c.slot, c.mouseButton]), [[5, 24, 0]]);
  const quests = await run('#окно');
  assert.equal(quests.data.slots[0].name, 'Какао для настроения.');
  assert.deepEqual(quests.data.slots[0].lore, ['• Награда: 32 печенья', 'Передайте какао-бобы или печенье: 0/96']);
  assert.equal((await run('#клик 99')).ok, false, 'нет такой ячейки — отказ, а не клик');
  assert.equal((await run('#закрой')).message, 'Меню закрыто');
  assert.equal(bot.currentWindow, null);
  assert.match((await run('#окно')).message, /меню не открыто/);

  assert.equal((await run('#нажми Оружейник')).message, '#нажми: слишком далеко — подойди ближе', 'до него 3,2 блока, а дотянуться можно на 2,9');
  assert.equal((await run('#иди к Оружейник')).message, 'Подошёл к Оружейник');
  assert.equal((await run('#нажми Оружейник')).message, 'Нажал на Оружейник (меню не открылось)');
  assert.match((await run('#нажми Кузнец')).message, /рядом нет «Кузнец» — посмотри, кто есть: #сущности/);
});

test('команды: #квесты у Фермера — показать, взять все новые, сдать из инвентаря; #купи — по «Осталось»', async () => {
  const json = (text) => JSON.stringify({ text });
  const state = { wheat: 0, taken: { 14: false, 21: false }, left: 6, money: 20000 };
  let bot = null;
  const quest = (title, icon, lore) => ({ name: icon, count: 1, customName: json(title), customLore: lore.map(json) });
  const questSlot = {
    11: () => quest('Грядки без истерики.', 'wheat', ['▪ Награда: 24 хлеба', 'Передайте пшеницу, морковь,', `картофель или свёклу: ${state.wheat}/224`]),
    14: () => quest('Посиди у костра.', 'clock', ['▪ Награда: 2 500 монет', 'Проведите на сервере: 0 м./3 ч.', ...(state.taken[14] ? [] : ['Нажмите, чтобы взять задание'])]),
    21: () => quest('Ночная прополка.', 'string', ['▪ Награда: 24 нити', 'Убейте пауков: 0/20', ...(state.taken[21] ? [] : ['Нажмите, чтобы взять задание'])]),
  };
  const hay = () => ({
    name: 'hay_block', count: 32, customName: json('Тюк сена'),
    customLore: [json('Лошадям нравится.'), json(`‖ Осталось › ${state.left}`), json('‖ Цена › 8400.0'), json('› Нажмите, чтобы купить')],
  });
  // Как в игре: под ячейками меню — инвентарь игрока (основной, потом хотбар).
  const menu = (id, title, filled) => {
    const w = { id, title: json(title), inventoryStart: 54, slots: new Array(90).fill(null) };
    for (const [i, it] of Object.entries(filled)) w.slots[i] = it;
    for (let j = 0; j < 36; j += 1) w.slots[54 + j] = bot.inventory.slots[9 + j] || null;
    return w;
  };
  const mainMenu = () => menu(5, 'Фермер › Уровень 1', {
    20: { name: 'hay_block', count: 1, customName: json('Покупка'), customLore: [json('Вам доступны товары 1 уровня')] },
    22: { name: 'experience_bottle', count: 1, customName: json('Улучшения'), customLore: [json('Повышайте уровень доверия фермера')] },
    24: { name: 'wheat', count: 1, customName: json('Продажа'), customLore: [json('Здесь вы можете продать предметы')] },
  });
  const questsMenu = () => menu(6, 'Фермер › Уровень 1 → 2', {
    11: questSlot[11](), 14: questSlot[14](), 21: questSlot[21](),
    36: { name: 'arrow', count: 1, customName: json('Назад') },
    40: { name: 'sunflower', count: 1, customLore: [json('Ещё не все задания уровня'), json('выполнены до конца.')] },
  });
  const shopMenu = () => menu(7, 'Фермер › Покупка', { 12: hay() });
  const onClick = (w, slot) => {
    if (w.id === 5 && slot === 22) return questsMenu();
    if (w.id === 5 && slot === 20) return shopMenu();
    if (w.id === 6 && (slot === 14 || slot === 21)) state.taken[slot] = true; // сервер меняет ячейку на месте
    if (w.id === 6 && slot === 11) {
      for (let i = 0; i < bot.inventory.slots.length; i += 1) {
        const it = bot.inventory.slots[i];
        if (it && it.name === 'wheat') {
          state.wheat += it.count;
          bot.inventory.slots[i] = null;
        }
      }
    }
    if (w.id === 6 && questSlot[slot]) w.slots[slot] = questSlot[slot]();
    if (w.id === 7 && slot === 12 && state.left > 0 && state.money >= 8400) {
      state.left -= 1;
      state.money -= 8400;
      w.slots[12] = hay();
    }
    return null;
  };
  const npc = { id: 401, type: 'player', username: '#1479d9c455b1f85', position: new Vec3(0.5, 64, 2.5), height: 1.8, width: 0.6 };
  const sign = { id: 402, type: 'object', name: 'armor_stand', position: new Vec3(0.5, 66.4, 2.5), getCustomName: () => ({ json: { text: 'Фермер' }, toString: () => 'Фермер' }) };
  const s = setup({ entities: [npc, sign], npcs: { 401: mainMenu }, onClick, inventory: [['wheat', 40], ['dirt', 3]] });
  bot = s.bot;

  const shown = await s.run('#квесты');
  assert.equal(shown.ok, true, [].concat(shown.message).join('\n'));
  assert.deepEqual(shown.message, [
    'Задания (Фермер › Уровень 1 → 2): 3, взято 1, выполнено 0',
    '[11] Грядки без истерики. — Передайте пшеницу, морковь, картофель или свёклу (wheat, carrot, potato, beetroot): 0/224; награда: 24 хлеба',
    '[14] Посиди у костра. — не взято, Проведите на сервере: 0 мин из 3 ч; награда: 2 500 монет',
    '[21] Ночная прополка. — не взято, Убейте пауков (spider, cave_spider): 0/20; награда: 24 нити',
    'Уровень: Ещё не все задания уровня выполнены до конца.',
  ]);
  assert.equal(bot.currentWindow, null, 'посмотрел — закрыл меню');
  assert.deepEqual(bot.clicks.map((c) => [c.window, c.slot]), [[5, 22]], 'в «Улучшения» — кликом по кнопке');

  const took = await s.run('#квесты взять');
  assert.deepEqual(took.message, ['Взял задания: «Посиди у костра.», «Ночная прополка.»']);
  assert.deepEqual(state.taken, { 14: true, 21: true });
  assert.deepEqual((await s.run('#квесты взять')).message, ['Все задания уже взяты']);

  const gave = await s.run('#квесты сдать');
  assert.deepEqual(gave.message, ['Сдал в «Грядки без истерики.»: 0 → 40 из 224']);
  assert.equal(state.wheat, 40);
  assert.deepEqual((await s.run('#квесты сдать')).message, ['Сдавать нечего: в инвентаре нет нужного («Грядки без истерики.» — wheat/carrot/potato/beetroot)']);

  const bought = await s.run('#купи сено 3');
  assert.equal(bought.message, 'Купил «Тюк сена» (×32) 2 раза по 8400; дальше сервер не продал (не хватило денег?)');
  assert.deepEqual([state.left, state.money], [4, 3200]);
  assert.equal(bot.currentWindow, null);
  assert.match((await s.run('#купи торт')).message, /у Фермер нет «торт». Есть: Тюк сена/);
});

test('команды: #квесты далеко от NPC — бот сам телепортируется на /warp ah (не умеет писать серверу — подскажет)', async () => {
  const json = (text) => JSON.stringify({ text });
  let bot = null;
  const menu = (id, title, filled) => {
    const w = { id, title: json(title), inventoryStart: 54, slots: new Array(90).fill(null) };
    for (const [i, it] of Object.entries(filled)) w.slots[i] = it;
    for (let j = 0; j < 36; j += 1) w.slots[54 + j] = bot.inventory.slots[9 + j] || null;
    return w;
  };
  const mainMenu = () => menu(5, 'Фермер › Уровень 1', { 22: { name: 'experience_bottle', count: 1, customName: json('Улучшения'), customLore: [json('Повышайте уровень доверия')] } });
  const questsMenu = () => menu(6, 'Фермер › Уровень 1 → 2', {
    12: { name: 'clock', count: 1, customName: json('Посиди у костра.'), customLore: [json('▪ Награда: 2 500 монет'), json('Проведите на сервере: 0 м./3 ч.')] },
    40: { name: 'sunflower', count: 1, customLore: [json('Ещё не все задания уровня'), json('выполнены до конца.')] },
  });
  const onClick = (w, slot) => (w.id === 5 && slot === 22 ? questsMenu() : null);
  // NPC — у /warp ah, далеко от бота: пока бот не там, сервер их не показывает.
  const npc = { id: 401, type: 'player', username: '#1479d9c455b1f85', position: new Vec3(100.5, 64, 2.5), height: 1.8, width: 0.6 };
  const sign = { id: 402, type: 'object', name: 'armor_stand', position: new Vec3(100.5, 66.4, 2.5), getCustomName: () => ({ json: { text: 'Фермер' }, toString: () => 'Фермер' }) };
  const s = setup({ npcs: { 401: mainMenu }, onClick });
  bot = s.bot;

  const hint = await s.run('#квесты');
  assert.equal(hint.ok, false);
  assert.match(hint.message, /рядом нет «Фермер» — сначала \/warp ah/);

  const sent = [];
  bot.sendCommand = (cmd) => {
    sent.push(cmd);
    if (cmd === '/warp ah') {
      bot.entities[npc.id] = npc;
      bot.entities[sign.id] = sign;
      teleport(bot, { x: 100.5, y: 64, z: 0.5 });
    }
    return true;
  };
  const r = await s.run('#квесты', 60000);
  assert.equal(r.ok, true, [].concat(r.message).join('\n'));
  assert.equal(r.message[0], 'Задания (Фермер › Уровень 1 → 2): 1, взято 1, выполнено 0');
  assert.deepEqual(sent, ['/warp ah']);
  await s.run('#квесты');
  assert.deepEqual(sent, ['/warp ah'], 'уже у NPC — второй раз не телепортируется');
});

test('команды: #квесты принести — склад (/home), сдать NPC (/warp ah), награды (/home); ответы сервера — из чата', async () => {
  const json = (text) => JSON.stringify({ text });
  let bot = null;
  const state = { taken: { 19: false }, have: { 11: 0, 19: 0 }, done: { 11: false, 19: false }, level: 1 };
  const QUESTS = {
    11: { title: 'Грядки без истерики.', icon: 'wheat', need: 224, items: ['wheat', 'carrot', 'potato', 'beetroot'], what: ['Передайте пшеницу, морковь,', 'картофель или свёклу'], gave: 'Урожай', reward: ['bread', 24, '24 хлеба'] },
    19: { title: 'Лесная кислинка.', icon: 'sweet_berries', need: 96, items: ['sweet_berries', 'apple'], what: ['Передайте сладкие ягоды или', 'яблоки'], gave: 'Ягодный запас', reward: ['cookie', 16, '16 печенек'] },
  };
  // Выполненное задание сервер меняет на другой предмет — по меню уже не понять, что оно сдано (только по чату).
  const questItem = (slot) => {
    const q = QUESTS[slot];
    if (state.done[slot]) return { name: 'lime_dye', count: 1, customName: json(q.title), customLore: [json('✔ Выполнено')] };
    const lore = [`▪ Награда: ${q.reward[2]}`, q.what[0], `${q.what[1]}: ${state.have[slot]}/${q.need}`];
    if (slot === 19 && !state.taken[19]) lore.push('Нажмите, чтобы взять задание');
    return { name: q.icon, count: 1, customName: json(q.title), customLore: lore.map(json) };
  };
  const menu = (id, title, filled) => {
    const w = { id, title: json(title), inventoryStart: 54, slots: new Array(90).fill(null) };
    for (const [i, it] of Object.entries(filled)) w.slots[i] = it;
    for (let j = 0; j < 36; j += 1) w.slots[54 + j] = bot.inventory.slots[9 + j] || null;
    return w;
  };
  const mainMenu = () => menu(5, 'Фермер › Уровень 1', { 22: { name: 'experience_bottle', count: 1, customName: json('Улучшения'), customLore: [json('Повышайте уровень доверия')] } });
  // Кнопка уровня (как на скриншотах 5 ноября); в открытом меню сервер её не обновляет — видно, только если открыть заново.
  const allDone = () => state.done[11] && state.done[19];
  const sunflower = () => (state.level === 1 && allDone()
    ? { name: 'sunflower', count: 1, customName: json('Доступно улучшение'), customLore: [json(''), json('Нажмите, чтобы перейти на новый уровень!')] }
    : { name: 'sunflower', count: 1, customLore: [json('Ещё не все задания уровня'), json('выполнены до конца.')] });
  const back = { name: 'arrow', count: 1, customName: json('Назад') };
  const questsMenu = () => (state.level === 1
    ? menu(6, 'Фермер › Уровень 1 → 2', { 11: questItem(11), 19: questItem(19), 36: back, 40: sunflower() })
    : menu(6, 'Фермер › Уровень 2 → 3', {
      12: { name: 'clock', count: 1, customName: json('Посиди у костра.'), customLore: [json('▪ Награда: 2 500 монет'), json('Проведите на сервере: 0 м./3 ч.')] },
      36: back,
      40: sunflower(),
    }));
  const say = (text) => bot.emit('message', { json: { text }, toString: () => text }, 'system');
  const deliver = (w, slot) => {
    const q = QUESTS[slot];
    let given = 0;
    for (let i = 9; i < 45; i += 1) {
      const it = bot.inventory.slots[i];
      const left = q.need - state.have[slot] - given;
      if (!it || left <= 0 || !q.items.includes(it.name)) continue;
      const n = Math.min(it.count, left);
      given += n;
      it.count -= n;
      if (it.count <= 0) {
        bot.inventory.slots[i] = null;
        w.slots[w.inventoryStart + i - 9] = null;
      }
    }
    if (!given) return;
    state.have[slot] += given;
    say(`| Вы передали ${q.gave}`);
    if (state.have[slot] < q.need) return;
    state.done[slot] = true;
    say(`| Задание ${q.title.replace(/\.$/, '')} выполнено`);
    say(`| Вы получаете награду: ${q.reward[2]}`);
    const Item = require('prismarine-item')(bot.registry);
    const free = bot.inventory.slots.findIndex((it, i) => i >= 9 && i < 45 && !it);
    const reward = new Item(bot.registry.itemsByName[q.reward[0]].id, q.reward[1]);
    bot.inventory.slots[free] = reward;
    w.slots[w.inventoryStart + free - 9] = reward;
  };
  const onClick = (w, slot) => {
    if (w.id === 5 && slot === 22) return questsMenu();
    if (w.id === 6 && slot === 40 && state.level === 1 && allDone()) {
      state.level = 2;
      say('| Уровень доверия повышен! Текущий уровень: 2 ↑');
      bot.currentWindow = null; // и меню закрыто (на скриншоте после нажатия меню уже нет)
      return null;
    }
    if (w.id === 6 && slot === 19 && !state.taken[19]) {
      state.taken[19] = true;
      say('| Вы взяли задание Лесная кислинка.');
    } else if (w.id === 6 && QUESTS[slot] && !state.done[slot]) {
      deliver(w, slot);
    }
    if (w.id === 6 && QUESTS[slot]) w.slots[slot] = questItem(slot);
    return null;
  };
  const npc = { id: 401, type: 'player', username: '#1479d9c455b1f85', position: new Vec3(0.5, 64, 2.5), height: 1.8, width: 0.6 };
  const sign = { id: 402, type: 'object', name: 'armor_stand', position: new Vec3(0.5, 66.4, 2.5), getCustomName: () => ({ json: { text: 'Фермер' }, toString: () => 'Фермер' }) };
  const s = setup({
    entities: [npc, sign],
    npcs: { 401: mainMenu },
    onClick,
    inventory: [['iron_pickaxe', 1], ['wheat', 40]],
    storage: {
      '51,64,2': { items: [[0, 'wheat', 64], [1, 'wheat', 64], [2, 'wheat', 64], [3, 'carrot', 32]] },
      '48,64,2': { items: [[0, 'sweet_berries', 64], [1, 'sweet_berries', 64]] },
      '101,64,2': { items: [] },
    },
  });
  bot = s.bot;
  bot.username = 'CycleBot';
  for (const p of ['51,64,2', '48,64,2', '101,64,2']) s.world.set(new Vec3(...p.split(',').map(Number)), 'chest');
  // Сервер: /warp ah и дома переносят бота, незнакомый дом — «не найден».
  const places = { '/warp ah': [0.5, 64, 0.5], '/home урожай': [50.5, 64, 0.5], '/home награды': [100.5, 64, 0.5] };
  bot.sentCommands = [];
  bot.sendCommand = (cmd) => {
    bot.sentCommands.push(cmd);
    const to = places[cmd];
    if (to) teleport(bot, { x: to[0], y: to[1], z: to[2] });
    else say(`| Дом ${cmd.split(' ')[1]} не найден.`);
    return true;
  };

  const r = await s.run('#квесты принести урожай награды', 120000);
  assert.equal(r.ok, true, [].concat(r.message).join('\n'));
  assert.deepEqual(r.message, [
    'Взял задания: «Лесная кислинка.»',
    'Нужно передать: «Грядки без истерики.» — 224 (wheat/carrot/potato/beetroot); «Лесная кислинка.» — 96 (sweet_berries/apple)',
    'Склад (/home урожай): взял wheat×192, sweet_berries×128',
    'Сдал в «Грядки без истерики.»: 0 → 224 из 224 — выполнено, награда: 24 хлеба',
    'Сдал в «Лесная кислинка.»: 0 → 96 из 96 — выполнено, награда: 16 печенек',
    'Фермер: уровень повышен — теперь 2',
    'Награды (/home награды): положил bread×24, cookie×16',
  ]);
  assert.equal(state.level, 2);
  assert.deepEqual(r.data.levelUps, [{ up: true, level: 2 }]);
  assert.deepEqual(r.data.took, [19], 'какие задания взял (для автопилота)');
  assert.deepEqual(r.data.short, [], 'на складе всего хватило');
  assert.equal(bot.clicks.filter((c) => c.slot === 40).length, 1, 'кнопку уровня — один раз');
  assert.deepEqual(bot.sentCommands, ['/home урожай', '/warp ah', '/home награды']);
  assert.deepEqual(invNames(bot).sort(), ['iron_pickaxe', 'sweet_berries', 'wheat'], 'остатки для заданий и кирка — с собой');
  assert.equal(invCount(bot, 'wheat'), 8);
  assert.equal(bot.currentWindow, null);

  // Ещё раз, без слов — те же дома; приносить уже нечего.
  const again = await s.run('#квесты принести', 60000);
  assert.deepEqual(again.message, ['Приносить нечего: заданий «Передайте…» нет или все выполнены']);
  assert.deepEqual(bot.sentCommands.slice(3), ['/warp ah'], 'к NPC вернулся сам');

  // Дома нет — сервер так и сказал; что успел — в ответе.
  state.level = 1;
  state.done[11] = false;
  state.have[11] = 200;
  const lost = await s.run('#квесты принести нет', 60000);
  assert.equal(lost.ok, false);
  assert.equal([].concat(lost.message).at(-1), 'Остановился: после /home нет телепорта не было (сервер: «Дом нет не найден.»)');
  assert.equal(lost.code, 'no_home', 'автопилот поймёт: боту нужен /sethome');

  bot.username = 'NewBot';
  assert.match((await s.run('#квесты принести')).message, /откуда брать\? Например: #квесты принести урожай награды/);
  assert.match((await s.run('#квесты принести урожай;op')).message, /не похоже на название дома/);
});

test('команды: #квесты уровень — «Доступно улучшение», подтверждение из чата; «у Алхимика»; взять — сначала новый уровень', async () => {
  const json = (text) => JSON.stringify({ text });
  let bot = null;
  const state = { level: 1, done: false, answer: true, taken: false };
  const menu = (id, title, filled) => {
    const w = { id, title: json(title), inventoryStart: 54, slots: new Array(90).fill(null) };
    for (const [i, it] of Object.entries(filled)) w.slots[i] = it;
    for (let j = 0; j < 36; j += 1) w.slots[54 + j] = bot.inventory.slots[9 + j] || null;
    return w;
  };
  const say = (text) => bot.emit('message', { json: { text }, toString: () => text }, 'system');
  const quest = (title, icon, lore) => ({ name: icon, count: 1, customName: json(title), customLore: lore.map(json) });
  const ready = { name: 'sunflower', count: 1, customName: json('Доступно улучшение'), customLore: [json(''), json('Нажмите, чтобы перейти на новый уровень!')] };
  const notReady = { name: 'sunflower', count: 1, customLore: [json('Ещё не все задания уровня'), json('выполнены до конца.')] };
  const mainMenu = () => menu(5, `Алхимик › Уровень ${state.level}`, {
    22: { name: 'experience_bottle', count: 1, customName: json('Улучшения'), customLore: [json('Повышайте уровень доверия алхимика')] },
  });
  const questsMenu = () => (state.level === 1
    ? menu(6, 'Алхимик › Уровень 1 → 2', {
      11: quest('Глаз да глаз.', 'spider_eye', ['▪ Награда: 8 зелий', `Передайте паучьи глаза: ${state.done ? 16 : 3}/16`]),
      40: state.done ? ready : notReady,
    })
    : menu(6, 'Алхимик › Уровень 2 → 3', {
      12: quest('Сладкая жизнь.', 'sugar_cane', ['▪ Награда: 4 бутылочки', 'Передайте сахарный тростник: 0/64', ...(state.taken ? [] : ['Нажмите, чтобы взять задание'])]),
      40: notReady,
    }));
  const onClick = (w, slot) => {
    if (w.id === 5 && slot === 22) return questsMenu();
    if (w.id === 6 && slot === 40 && state.level === 1 && state.done && state.answer) {
      state.level = 2;
      say('| Уровень доверия повышен! Текущий уровень: 2 ↑');
      bot.currentWindow = null; // сервер закрыл меню
    }
    if (w.id === 6 && slot === 12 && state.level === 2 && !state.taken) {
      state.taken = true;
      say('| Вы взяли задание Сладкая жизнь.');
      w.slots[12] = questsMenu().slots[12];
    }
    return null;
  };
  const npc = { id: 401, type: 'player', username: '#2a8b1c0f9d3e7a1', position: new Vec3(0.5, 64, 2.5), height: 1.8, width: 0.6 };
  const sign = { id: 402, type: 'object', name: 'armor_stand', position: new Vec3(0.5, 66.4, 2.5), getCustomName: () => ({ json: { text: 'Алхимик' }, toString: () => 'Алхимик' }) };
  const s = setup({ entities: [npc, sign], npcs: { 401: mainMenu }, onClick });
  bot = s.bot;

  // Не всё выполнено — кнопку не трогает, пишет, что осталось.
  const early = await s.run('#квесты уровень у Алхимика');
  assert.equal(early.ok, false);
  assert.deepEqual(early.message, [
    'Уровень пока не повысить (Алхимик › Уровень 1 → 2): Ещё не все задания уровня выполнены до конца.',
    'Не выполнено: 1',
    '[11] Глаз да глаз. — Передайте паучьи глаза (spider_eye): 3/16; награда: 8 зелий',
  ]);
  assert.ok(!bot.clicks.some((c) => c.slot === 40));
  assert.equal(bot.currentWindow, null);

  // Всё выполнено, но сервер промолчал — так и пишет.
  state.done = true;
  state.answer = false;
  assert.equal([].concat((await s.run('#квесты алхимик')).message).at(-1), 'Уровень: все задания выполнены — можно повышать (#квесты уровень)');
  const silent = await s.run('#квесты повысить уровень алхимику');
  assert.equal(silent.ok, false);
  assert.equal(silent.message, 'Алхимик: нажал «Доступно улучшение», но сервер не написал «Уровень доверия повышен»');
  assert.equal(state.level, 1);

  // «#квесты взять»: сначала новый уровень (меню сервер закрывает), потом — задания нового уровня.
  state.answer = true;
  const took = await s.run('#квесты взять у Алхимика');
  assert.equal(took.ok, true, [].concat(took.message).join('\n'));
  assert.deepEqual(took.message, ['Алхимик: уровень повышен — теперь 2', 'Взял задания: «Сладкая жизнь.»']);
  assert.deepEqual([state.level, state.taken], [2, true]);
  assert.equal(bot.currentWindow, null);
});

test('команды: Фермер 4-го уровня — заданий больше нет (без ошибок); 3 → 4 и сразу «всё пройдено»; Оружейник — условия', async () => {
  const json = (text) => JSON.stringify({ text });
  let bot = null;
  const state = { farmer: 3 };
  const menu = (id, title, filled) => {
    const w = { id, title: json(title), inventoryStart: 54, slots: new Array(90).fill(null) };
    for (const [i, it] of Object.entries(filled)) w.slots[i] = it;
    for (let j = 0; j < 36; j += 1) w.slots[54 + j] = bot.inventory.slots[9 + j] || null;
    return w;
  };
  const say = (text) => bot.emit('message', { json: { text }, toString: () => text }, 'system');
  const quest = (title, icon, lore) => ({ name: icon, count: 1, customName: json(title), customLore: lore.map(json) });
  // Главное меню NPC, как на скриншоте Фермера 4-го уровня.
  const upgrades = (whose) => ({
    name: 'experience_bottle', count: 1, customName: json('Улучшения'),
    customLore: [json(`Повышайте уровень доверия ${whose}`), json('чтобы стали доступны новые предметы'), json(''), json(`Вам доступны товары ${state.farmer} уровня`)],
  });
  const farmerMain = () => menu(5, `Фермер › Уровень ${state.farmer}`, { 22: upgrades('фермера') });
  const farmerQuests = () => menu(6, 'Фермер › Уровень 3 → 4', {
    11: quest('Грядки без истерики.', 'wheat', ['▪ Награда: 24 хлеба', 'Передайте пшеницу: 224/224']),
    40: { name: 'sunflower', count: 1, customName: json('Доступно улучшение'), customLore: [json(''), json('Нажмите, чтобы перейти на новый уровень!')] },
  });
  const smithMain = () => menu(7, 'Оружейник › Уровень 0', { 22: upgrades('оружейника') });
  const smithQuests = () => menu(8, 'Оружейник › Уровень 0 → 1', {
    10: quest('Рекомендация от Фермера.', 'hay_block', ['Добейся максимального доверия у', 'главного по урожаю.', '', `Прокачайте Фермера до 4 уровня. ${state.farmer >= 4 ? 'Выполнено!' : `${state.farmer}/4`}`]),
    11: quest('Печать Алхимика.', 'brewing_stand', ['Алхимик тоже должен подтвердить', 'твою ценность.', '', 'Прокачайте Алхимика до 4', 'уровня. 1/4']),
    40: { name: 'sunflower', count: 1, customLore: [json('Ещё не все задания уровня'), json('выполнены до конца.')] },
  });
  const onClick = (w, slot) => {
    if (w.id === 5 && slot === 22) {
      if (state.farmer < 4) return farmerQuests();
      say('| Эта цепочка уже полностью завершена!'); // меню заданий сервер не открывает
      say('| Цепочка квестов не найдена!');
      return null;
    }
    if (w.id === 6 && slot === 40) {
      state.farmer = 4;
      say('| Уровень доверия повышен! Текущий уровень: 4 ↑');
      bot.currentWindow = null;
    }
    if (w.id === 7 && slot === 22) return smithQuests();
    return null;
  };
  const npc = (id, x, z, name) => [
    { id, type: 'player', username: `#${id}c455b1f85`, position: new Vec3(x, 64, z), height: 1.8, width: 0.6 },
    { id: id + 1, type: 'object', name: 'armor_stand', position: new Vec3(x, 66.4, z), getCustomName: () => ({ json: { text: name }, toString: () => name }) },
  ];
  const s = setup({ entities: [...npc(401, 0.5, 2.5, 'Фермер'), ...npc(403, 2.5, 0.5, 'Оружейник')], npcs: { 401: farmerMain, 403: smithMain }, onClick });
  bot = s.bot;

  // Оружейник закрыт: в «Улучшениях» — условия, с прогрессом.
  const closed = await s.run('#квесты у Оружейника');
  assert.deepEqual(closed.message, [
    'Задания (Оружейник › Уровень 0 → 1): 2, взято 2, выполнено 0',
    '[10] Рекомендация от Фермера. — Прокачайте Фермера до 4 уровня: 3/4',
    '[11] Печать Алхимика. — Прокачайте Алхимика до 4 уровня: 1/4',
    'Уровень: Ещё не все задания уровня выполнены до конца.',
  ]);

  // Все задания 3-го уровня выполнены: «#квесты взять» — новый уровень, а заданий на 4-м уже нет.
  const FINISHED = 'Фермер: 4-й уровень, все задания пройдены — больше заданий нет';
  const up = await s.run('#квесты взять');
  assert.equal(up.ok, true, [].concat(up.message).join('\n'));
  assert.deepEqual(up.message, ['Фермер: уровень повышен — теперь 4', FINISHED]);
  assert.equal(bot.currentWindow, null);

  // Дальше — не ошибка, а ответ: заданий больше нет (и никаких /home).
  bot.sendCommand = () => assert.fail('на 4-м уровне склад не нужен');
  for (const line of ['#квесты', '#квесты уровень', '#квесты сдать', '#квесты принести урожай награды']) {
    const r = await s.run(line);
    assert.equal(r.ok, true, `${line}: ${[].concat(r.message).join('\n')}`);
    assert.deepEqual([].concat(r.message), [FINISHED], line);
    assert.equal(bot.currentWindow, null, line);
  }

  // Условие Фермера у Оружейника теперь выполнено.
  assert.equal((await s.run('#квесты оружейник')).message[1], '[10] Рекомендация от Фермера. — выполнено, Прокачайте Фермера до 4 уровня: 4/4');
});

test('команды: #пинг — замер ботом (ping_request → ping_response, как график в F3) и пинг из Tab; действие бота не прерывает', async () => {
  const { bot } = setup();
  bot._client.state = 'play';
  const write = bot._client.write;
  const echo = (name, params) => {
    write(name, params);
    if (name === 'ping_request') setImmediate(() => bot._client.emit('ping_response', { id: params.id }));
  };
  bot._client.write = echo;
  bot.player = { username: 'Bot', ping: 133 };
  let interrupted = false;
  bot.actions.wait(60000).catch(() => { interrupted = true; }); // бот чем-то занят
  const logs = [];
  const r = await runCommand(bot, '#пинг', (level, text) => logs.push(`${level}:${text}`));
  assert.equal(r.ok, true, [].concat(r.message).join('\n'));
  assert.equal(r.data.samples.length, 3);
  assert.ok(r.data.best < 50, String(r.data.best));
  assert.equal(r.data.shown, 133);
  assert.match(r.message[0], /^Замер ботом: \d+, \d+, \d+ мс — столько пакет идёт до сервера и обратно/);
  assert.equal(r.message[1], 'Пинг в Tab: 133 мс — так его считает сервер');
  assert.equal(r.message[2], 'Связь у бота быстрая — лишнее в Tab добавляет сам сервер, когда считает пинг бота (не сеть и не панель)');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interrupted, false, 'замер не прерывает дело бота');
  assert.ok(logs.every((l) => l.startsWith('info:')), 'просто сведения — не ошибка');

  // Сервер не отвечает — так и пишет, а лишний раз не ждёт.
  bot._client.write = write;
  const silent = await pingReport(bot, { timeoutMs: 30, gapMs: 1 });
  assert.equal(silent.message[0], 'Замер ботом: сервер не ответил за 0.03 с');
  assert.deepEqual(silent.data.samples, []);

  bot._client.state = 'configuration';
  assert.match((await runCommand(bot, '#пинг')).message, /бот сейчас не в игре/);
  bot.actions.stop();
});

test('команды: #квесты купить — «Купите у Фермера товаров на N»: без лишней переплаты, первая покупка — проверка по заданию; нет денег — сколько дать', async () => {
  const json = (text) => JSON.stringify({ text });
  const PRICES = { 12: 8400, 13: 500 };
  const TITLES = { 12: ['Тюк сена', 'hay_block'], 13: ['Морковь', 'carrot'] };
  const ready = { name: 'sunflower', count: 1, customName: json('Доступно улучшение'), customLore: [json(''), json('Нажмите, чтобы перейти на новый уровень!')] };
  const notReady = { name: 'sunflower', count: 1, customLore: [json('Ещё не все задания уровня'), json('выполнены до конца.')] };

  async function scenario({ money, counts = true }) {
    let bot = null;
    const state = { money, spent: 0, stock: { 12: 6, 13: 20 }, level: 1, purchases: 0 };
    const menu = (id, title, filled) => {
      const w = { id, title: json(title), inventoryStart: 54, slots: new Array(90).fill(null) };
      for (const [i, it] of Object.entries(filled)) w.slots[i] = it;
      for (let j = 0; j < 36; j += 1) w.slots[54 + j] = bot.inventory.slots[9 + j] || null;
      return w;
    };
    const say = (text) => bot.emit('message', { json: { text }, toString: () => text }, 'system');
    const have = () => Math.min(state.spent, 12000);
    const questItem = () => ({
      name: 'gold_ingot', count: 1, customName: json('Аванс на семена.'),
      customLore: [json('Помоги распродать витрину.'), json(`Купите у Фермера товаров на: ${have()}/12000`)],
    });
    const offer = (slot) => ({
      name: TITLES[slot][1], count: 32, customName: json(TITLES[slot][0]),
      customLore: [json(`‖ Осталось › ${state.stock[slot]}`), json(`‖ Цена › ${PRICES[slot]}.0`), json('› Нажмите, чтобы купить')],
    });
    const mainMenu = () => menu(5, `Фермер › Уровень ${state.level}`, {
      20: { name: 'hay_block', count: 1, customName: json('Покупка'), customLore: [json('Вам доступны товары 1 уровня')] },
      22: { name: 'experience_bottle', count: 1, customName: json('Улучшения'), customLore: [json('Повышайте уровень доверия фермера')] },
    });
    const questsMenu = () => menu(6, 'Фермер › Уровень 1 → 2', { 10: questItem(), 40: have() >= 12000 ? ready : notReady });
    const shopMenu = () => menu(7, 'Фермер › Покупка', { 12: offer(12), 13: offer(13) });
    const onClick = (w, slot) => {
      if (w.id === 5 && slot === 22) return questsMenu();
      if (w.id === 5 && slot === 20) return shopMenu();
      if (w.id === 7 && PRICES[slot]) {
        if (state.money < PRICES[slot]) {
          say('| У вас недостаточно средств');
          return null;
        }
        state.money -= PRICES[slot];
        state.stock[slot] -= 1;
        state.purchases += 1;
        if (counts) state.spent += PRICES[slot];
        w.slots[slot] = offer(slot);
      }
      if (w.id === 6 && slot === 40 && have() >= 12000) {
        state.level = 2;
        say('| Уровень доверия повышен! Текущий уровень: 2 ↑');
        bot.currentWindow = null;
      }
      return null;
    };
    const npc = { id: 401, type: 'player', username: '#1479d9c455b1f85', position: new Vec3(0.5, 64, 2.5), height: 1.8, width: 0.6 };
    const sign = { id: 402, type: 'object', name: 'armor_stand', position: new Vec3(0.5, 66.4, 2.5), getCustomName: () => ({ json: { text: 'Фермер' }, toString: () => 'Фермер' }) };
    const s = setup({ entities: [npc, sign], npcs: { 401: mainMenu }, onClick });
    bot = s.bot;
    bot.username = 'Farm01';
    const r = await s.run('#квесты купить', 180000);
    return { r, state, bot };
  }

  // Денег хватает: сначала самый дорогой товар, что не больше остатка, остаток — дешёвым (переплата < 500).
  const full = await scenario({ money: 30000 });
  assert.equal(full.r.ok, true, [].concat(full.r.message).join('\n'));
  assert.deepEqual(full.r.message, [
    'Купил у Фермер для «Аванс на семена.»: «Тюк сена» (×32) ×1, «Морковь» (×32) ×8 — потрачено 12400: 0 → 12000 из 12000 — выполнено',
    'Фермер: уровень повышен — теперь 2',
  ]);
  assert.deepEqual([full.state.money, full.state.purchases, full.state.level], [17600, 9, 2]);
  assert.equal(full.bot.currentWindow, null);

  // Покупка в задание не засчиталась — после первой больше не тратит.
  const wrong = await scenario({ money: 30000, counts: false });
  assert.equal(wrong.r.ok, false);
  assert.equal(wrong.state.purchases, 1);
  assert.deepEqual(wrong.r.message, [
    'Купил у Фермер для «Аванс на семена.»: «Тюк сена» (×32) ×1 — потрачено 8400: 0 → 0 из 12000',
    'Докупить не вышло: покупка не засчиталась в задание (0 → 0 из 12000) — дальше не покупаю',
  ]);

  // Деньги кончились — сервер так и написал, бот говорит, сколько дать.
  const poor = await scenario({ money: 9000 });
  assert.equal(poor.r.ok, false);
  assert.deepEqual(poor.r.message, [
    'Купил у Фермер для «Аванс на семена.»: «Тюк сена» (×32) ×1, «Морковь» (×32) ×1 — потрачено 8900: 0 → 8900 из 12000',
    'Докупить не вышло: сервер не продал — «У вас недостаточно средств» — дай боту денег: /pay Farm01 3100',
  ]);
});

test('команды: #бей — только нужные мобы в досягаемости и не сквозь стену; игроков и мобов с именем не трогает; без слов — для заданий «Убейте…»', async () => {
  const json = (text) => JSON.stringify({ text });
  const mob = (id, name, x, z, extra = {}) => ({ id, type: 'hostile', name, position: new Vec3(x, 64, z), width: 1.4, height: 0.9, hp: 2, ...extra });
  const spiders = [mob(301, 'spider', 0.5, 2.5), mob(302, 'spider', -1.5, 0.5), mob(303, 'cave_spider', 0.5, -1.5)];
  const walled = mob(304, 'spider', 3.5, 0.5);
  const far = mob(305, 'spider', 0.5, 7.5);
  const named = mob(306, 'spider', -1.5, -1.5, { getCustomName: () => ({ toString: () => 'Пушок' }) });
  const zombie = { ...mob(307, 'zombie', 1.5, 1.5), width: 0.6, height: 1.95 };
  const player = { id: 308, type: 'player', username: 'Spider', name: 'player', position: new Vec3(-0.5, 64, 1.5), width: 0.6, height: 1.8 };
  const s = setup({ entities: [...spiders, walled, far, named, zombie, player], inventory: [['iron_sword', 1], ['wooden_sword', 1]] });
  for (const y of [64, 65]) s.world.set(new Vec3(2, y, 0), 'stone'); // стена между ботом и пауком 304
  const attacked = [];
  const write = s.bot._client.write;
  s.bot._client.write = (name, params) => {
    write(name, params);
    if (name !== 'use_entity' || params.mouse !== 1) return;
    attacked.push(params.target);
    const e = s.bot.entities[params.target];
    if (e && e.hp !== undefined && (e.hp -= 1) <= 0) {
      delete s.bot.entities[params.target];
      s.bot.emit('entityDead', e);
    }
  };

  assert.match((await s.run('#бей')).message, /кого бить\? Например: #бей пауков 20/);
  assert.match((await s.run('#бей драконов')).message, /не знаю, кто это: «драконов»/);

  const r = await s.run('#бей пауков 3', 60000);
  assert.equal(r.ok, true, [].concat(r.message).join('\n'));
  assert.deepEqual(r.message, ['Убил: паук ×2, пещерный паук ×1 — всего 3', 'Готово']);
  assert.deepEqual([...new Set(attacked)].sort(), [301, 302, 303], 'только видимые пауки в досягаемости');
  assert.equal(attacked.length, 6, 'по два удара на паука');
  assert.equal(s.bot.heldItem && s.bot.heldItem.name, 'iron_sword', 'лучший меч в руке');

  // Пауки остались — но за стеной, далеко или с именем: бить некого, ждёт и уходит.
  const idle = await s.run('#бей пауков', 90000);
  assert.equal(idle.ok, false);
  assert.deepEqual(idle.message, ['Никого не убил', 'Остановился: рядом никого 60 с']);
  assert.ok(!attacked.some((id) => [304, 305, 306, 307, 308].includes(id)), 'стена, даль, имя, зомби и игрок — не цели');

  // Задания «Убейте пауков: 18/20» — бот видит у NPC и потом бьёт, сколько нужно.
  const quests = () => ({
    id: 9,
    title: json('Фермер › Уровень 1 → 2'),
    inventoryStart: 54,
    slots: Object.assign(new Array(90).fill(null), {
      21: { name: 'string', count: 1, customName: json('Ночная прополка.'), customLore: [json('▪ Награда: 24 нити'), json('Убейте пауков: 18/20')] },
    }),
  });
  s.bot.entities[401] = { id: 401, type: 'mob', name: 'villager', position: new Vec3(0.5, 64, 2.5), height: 1.95, width: 0.6, getCustomName: () => ({ json: { text: 'Фермер' }, toString: () => 'Фермер' }) };
  s.bot.npcMenus = quests;
  const npcWrite = s.bot._client.write;
  s.bot._client.write = (name, params) => {
    npcWrite(name, params);
    if (name === 'use_entity' && params.mouse === 0 && params.target === 401) {
      s.bot.currentWindow = quests();
      s.bot.emit('windowOpen', s.bot.currentWindow);
    }
  };
  const shown = await s.run('#квесты');
  assert.ok([].concat(shown.message).includes('[21] Ночная прополка. — Убейте пауков (spider, cave_spider): 18/20; награда: 24 нити'));
  for (const m of [mob(311, 'spider', 1.5, -0.5), mob(312, 'spider', -0.5, -0.5)]) s.bot.entities[m.id] = m;
  const forQuest = await s.run('#бей', 60000);
  assert.equal(forQuest.ok, true, [].concat(forQuest.message).join('\n'));
  assert.deepEqual(forQuest.message, ['Убил: паук ×2 — всего 2', 'Готово: для заданий хватит (засчитывается само)']);
  assert.match((await s.run('#бей')).message, /кого бить\?/, 'для заданий больше не нужно');

  // «дом пауки» — сначала /home пауки (комната со спавнером), потом бой там; дома нет — код no_home.
  const sent = [];
  s.bot.sendCommand = (cmd) => {
    sent.push(cmd);
    if (cmd === '/home пауки') teleport(s.bot, { x: 0.5, y: 64, z: 0.5 });
    else s.bot.emit('message', { json: { text: '| Дом не найден.' }, toString: () => '| Дом не найден.' }, 'system');
    return true;
  };
  for (const m of [mob(321, 'spider', 1.5, -0.5)]) s.bot.entities[m.id] = m;
  const room = await s.run('#бей пауков 1 дом пауки', 60000);
  assert.equal(room.ok, true, [].concat(room.message).join('\n'));
  assert.deepEqual(sent, ['/home пауки']);
  assert.deepEqual(room.data.total, 1);
  const noRoom = await s.run('#бей пауков 1 дом подвал', 60000);
  assert.equal(noRoom.code, 'no_home');
  assert.match((await s.run('#бей пауков дом')).message, /какой дом\? Например: #бей пауков 20 дом пауки/);
});

test('команды: #урожай — только спелое (по возрасту), подобрать выпавшее, посадить семена обратно; «пшеница» — только её', async () => {
  const s = setup({ inventory: [['wheat_seeds', 10], ['carrot', 3]] });
  const field = [[2, 0, 'wheat#7'], [2, 1, 'wheat#7'], [3, 0, 'wheat#3'], [-2, 0, 'carrots#7'], [-2, 1, 'carrots#5']];
  for (const [x, z, crop] of field) {
    s.world.set(new Vec3(x, 63, z), 'farmland');
    s.world.set(new Vec3(x, 64, z), crop);
  }
  s.world.set(new Vec3(0, 64, 3), 'sugar_cane');
  s.world.set(new Vec3(0, 65, 3), 'sugar_cane'); // второй снизу — срезать, нижний оставить
  for (const name of ['wheat', 'carrots', 'sugar_cane']) s.bot.digTicks[name] = 1;
  s.bot.entities[900] = { id: 900, name: 'item', position: new Vec3(2.5, 64, 2.5) }; // выпало у грядки

  const only = await s.run('#урожай пшеница', 120000);
  assert.equal(only.ok, true, [].concat(only.message).join('\n'));
  assert.deepEqual(only.data.harvested, { wheat: 2 }, 'только спелая пшеница; незрелая (возраст 3) и морковь — нет');
  assert.equal(s.world.get(new Vec3(3, 64, 0)), 'wheat#3');
  assert.equal(s.world.get(new Vec3(-2, 64, 0)), 'carrots#7');
  assert.equal(only.data.picked, 1, 'подобрал выпавшее');
  assert.ok(s.bot.entity.position.distanceTo(new Vec3(2.5, 64, 2.5)) < 1, 'дошёл до предмета');
  assert.equal(only.data.planted, 2, 'посадил семена обратно');
  assert.equal(s.world.get(new Vec3(2, 64, 0)), 'wheat');
  assert.equal(s.world.get(new Vec3(2, 64, 1)), 'wheat');

  const all = await s.run('#урожай', 120000);
  assert.deepEqual(all.data.harvested, { carrot: 1, sugar_cane: 1 });
  assert.equal(s.world.get(new Vec3(0, 64, 3)), 'sugar_cane', 'нижний тростник остался');
  assert.equal(s.world.get(new Vec3(0, 65, 3)), 'air');
  assert.equal(s.world.get(new Vec3(-2, 64, 0)), 'carrots', 'морковь посажена снова');

  const none = await s.run('#урожай', 60000);
  assert.equal(none.ok, false);
  assert.equal(none.code, 'nothing');
  assert.match([].concat(none.message)[0], /^Спелого рядом нет/);
  assert.match((await s.run('#урожай камней')).message, /не знаю такой культуры: «камней»/);
});

test('команды: #разведи — пары взрослых (малышей не трогает), корм из инвентаря; повторно — не раньше 5 мин; нет корма — скажет', async () => {
  const cow = (id, x, z, baby = false) => ({ id, type: 'mob', name: 'cow', position: new Vec3(x, 64, z), width: 0.9, height: 1.4, metadata: baby ? { 16: true } : {} });
  const s = setup({ inventory: [['wheat', 5]], entities: [cow(501, 1.5, 1.5), cow(502, 2.5, 1.5), cow(503, 0.5, 2.5, true), cow(504, 3.5, 2.5)] });
  const fed = () => s.bot._client.sent.filter((p) => p.name === 'use_entity' && p.params.mouse === 0).map((p) => p.params.target);
  s.bot._client.sent = [];
  const r = await s.run('#разведи коров', 120000);
  assert.equal(r.ok, true, [].concat(r.message).join('\n'));
  assert.equal(r.data.pairs, 1, 'взрослых трое: одна пара');
  assert.deepEqual(fed().sort(), [501, 502]);
  assert.ok(!fed().includes(503), 'телёнка не кормит');
  assert.equal(s.bot.heldItem && s.bot.heldItem.name, 'wheat');

  // Тех же — не раньше 5 мин: осталась одна взрослая — пары нет.
  const again = await s.run('#разведи коров', 60000);
  assert.equal(again.ok, false);
  assert.match([].concat(again.message).join('\n'), /Мало взрослых рядом/);

  const pigs = await s.run('#разведи свиней', 60000);
  assert.equal(pigs.code, 'no_food');
  assert.match([].concat(pigs.message).join('\n'), /Нет корма \(свинья\) — подойдёт: морковь \(carrot\), картофель \(potato\) или свёкла \(beetroot\)\. .*выброси рядом с ним \(Q\) или положи в сундук рядом/);
  assert.match((await s.run('#разведи драконов')).message, /кого разводить\?/);
});

test('команды: #разведи без корма в инвентаре — сам берёт: брошенный рядом (подбирает) или из сундука рядом', async () => {
  const cow = (id, x, z) => ({ id, type: 'mob', name: 'cow', position: new Vec3(x, 64, z), width: 0.9, height: 1.4, metadata: {} });
  // Сундук рядом с пшеницей (до 4 блоков) — корм оттуда.
  const s = setup({ entities: [cow(601, 1.5, 1.5), cow(602, 2.5, 1.5)], storage: { '2,64,-2': { items: [[0, 'wheat', 64]] } } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  const fromChest = await s.run('#разведи коров', 120000);
  assert.equal(fromChest.ok, true, [].concat(fromChest.message).join('\n'));
  assert.equal([].concat(fromChest.message)[0], 'Корм: пшеница — взял из сундука рядом');
  assert.equal(fromChest.data.pairs, 1);

  // Пшеницу кинули на землю рядом — подойдёт и подберёт (сервер отдаёт, когда бот вплотную).
  const t = setup({ entities: [cow(611, 1.5, 1.5), cow(612, 2.5, 1.5)] });
  const drop = { id: 700, name: 'item', position: new Vec3(-2.5, 64, 0.5), getDroppedItem: () => ({ name: 'wheat' }) };
  t.bot.entities[700] = drop;
  t.bot.on('move', () => {
    if (t.bot.entities[700] && t.bot.entity.position.distanceTo(drop.position) < 1) {
      delete t.bot.entities[700];
      t.bot.inventory.slots[40] = { name: 'wheat', count: 3, displayName: 'Wheat' };
    }
  });
  const picked = await t.run('#разведи коров', 120000);
  assert.equal(picked.ok, true, [].concat(picked.message).join('\n'));
  assert.equal([].concat(picked.message)[0], 'Корм: пшеница — подобрал с земли');

  // Коровы в замкнутом загоне: войти нельзя — бот подходит к забору и дотягивается через него.
  const u = setup({ inventory: [['wheat', 4]], entities: [cow(621, 3.8, 0.5), cow(622, 3.8, 0.9)] });
  const registry = require('prismarine-registry')(VERSION);
  const fenceId = (props) => {
    const b = require('prismarine-block')(registry).fromProperties('oak_fence', { east: false, west: false, north: false, south: false, waterlogged: false, ...props }, 0);
    return `oak_fence#${b.stateId - registry.blocksByName.oak_fence.minStateId}`;
  };
  for (let z = -2; z <= 3; z += 1) for (const x of [2, 7]) u.world.set(new Vec3(x, 64, z), fenceId({ north: z > -2, south: z < 3 }));
  for (let x = 3; x <= 6; x += 1) for (const z of [-2, 3]) u.world.set(new Vec3(x, 64, z), fenceId({ east: true, west: true }));
  const fenced = await u.run('#разведи коров', 120000);
  assert.equal(fenced.ok, true, [].concat(fenced.message).join('\n'));
  assert.equal(fenced.data.pairs, 1);
  assert.ok(u.bot.entity.position.x < 2.4, `в загон не вошёл: x = ${u.bot.entity.position.x.toFixed(2)}`);
});

/** Клетки ниже поверхности (y < 64), которые стали воздухом или блоком, — что бот выкопал и поставил. */
const changedBelow = (world, name) => world.list().filter((p) => p.y < 64 && world.get(p) === name);

test('команды: #добудь — руда в толще камня: прокапывается прямо к ней (вниз под себя), потом столбом на свою высоту', async () => {
  const s = setup({ inventory: [['iron_pickaxe', 1], ['cobblestone', 32]] });
  const ore = new Vec3(6, 58, 0); // со всех сторон камень — не видна, но в загруженном мире известна
  s.world.set(ore, 'iron_ore');
  const r = await s.run('#добудь железо 1 здесь', 600000);
  const text = [].concat(r.message).join('\n');
  assert.equal(r.ok, true, text);
  assert.equal(r.data.mined, 1);
  assert.notEqual(s.world.get(ore), 'iron_ore', 'руду выкопал (на её месте теперь столб)');
  const changed = [...changedBelow(s.world, 'air'), ...changedBelow(s.world, 'cobblestone')];
  const dug = changed.length;
  assert.ok(dug <= 8, `прямо к руде, а не туннель: выкопано ${dug} блоков: ${changed.map((c) => `${c}=${s.world.get(c)}`).join(' ')}`);
  // Обратно: столбом (блок под себя) — шахта заложена булыжником, бот там, откуда начал.
  assert.ok(changedBelow(s.world, 'cobblestone').length >= 4, 'поднимался, ставя блоки под себя');
  const p = s.bot.entity.position;
  assert.ok(Math.abs(p.y - 64) < 0.01 && Math.hypot(p.x - 0.5, p.z - 0.5) < 0.7, `вернулся: ${p}`);
  assert.equal(r.data.back, true);
  assert.match(text, /Вернулся туда, откуда начал \(Y 64\)/);
  assert.equal(s.bot.heldItem && s.bot.heldItem.name, 'iron_pickaxe', 'копал киркой');
});

test('команды: #добудь — подошёл зомби: бросает копать, бьёт его лучшим мечом и докапывает; проголодался — ест хлеб', async () => {
  const s = setup({ inventory: [['iron_pickaxe', 1], ['iron_sword', 1], ['bread', 3], ['cobblestone', 32]] });
  s.world.set(new Vec3(6, 58, 0), 'iron_ore');
  const zombie = { id: 601, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 2.5), width: 0.6, height: 1.95, hp: 2 };
  let stops = 0;
  let tick = 0;
  let ateAt = null;
  const attacked = [];
  s.bot.on('physicsTick', () => {
    tick += 1;
    if (ateAt !== null && tick - ateAt >= 32) {
      const bread = s.bot.inventory.slots.find((it) => it && it.name === 'bread');
      bread.count -= 1;
      s.bot.food = 17;
      s.bot.emit('health');
      ateAt = null;
    }
  });
  const write = s.bot._client.write;
  s.bot._client.write = (name, params) => {
    write(name, params);
    if (name === 'block_dig' && params.status === 2) {
      stops += 1;
      if (stops === 1) s.bot.entities[zombie.id] = zombie; // пришёл, пока бот копает
      if (stops === 3) s.bot.food = 12; // проголодался
    }
    if (name === 'use_entity' && params.mouse === 1) {
      attacked.push(params.target);
      if (params.target === zombie.id && (zombie.hp -= 1) <= 0) {
        delete s.bot.entities[zombie.id];
        s.bot.emit('entityDead', zombie);
      }
    }
    if (name === 'use_item' && s.bot.heldItem && s.bot.heldItem.name === 'bread') ateAt = tick;
  };
  const r = await s.run('#добудь железо 1 здесь', 900000);
  const text = [].concat(r.message).join('\n');
  assert.equal(r.ok, true, text);
  assert.equal(r.data.mined, 1);
  assert.deepEqual(attacked, [zombie.id, zombie.id], 'два удара — зомби нет');
  assert.match(text, /Отбился от мобов: зомби ×1/);
  assert.match(text, /Поел: 1 раз/);
  assert.equal(s.bot.food, 17);
  assert.equal(s.bot.heldItem && s.bot.heldItem.name, 'iron_pickaxe', 'после боя и еды снова кирка');
});

test('команды: #добудь прервали (бот вышел) после первой руды — в ответе, с чего продолжить задаче: остаток', async () => {
  const s = setup({ inventory: [['iron_pickaxe', 1], ['cobblestone', 32]] });
  const ores = [new Vec3(3, 62, 0), new Vec3(-5, 60, 3)];
  for (const p of ores) s.world.set(p, 'iron_ore');
  let tick = 0;
  let dugAt = null;
  s.bot.on('physicsTick', () => {
    tick += 1;
    if (dugAt === null && ores.some((p) => s.world.get(p) !== 'iron_ore')) dugAt = tick;
    if (dugAt !== null && tick - dugAt === 10) s.bot.emit('end', 'socketClosed'); // обрыв, когда первая руда уже засчитана
  });
  const r = await s.run('#добудь железо 3 здесь', 600000);
  assert.equal(r.ok, false, [].concat(r.message).join('\n'));
  assert.equal(r.code, 'interrupted');
  assert.deepEqual(r.data, { resume: '#добудь железо 2 здесь' });
});

test('команды: #добудь — зомби рядом с самого начала: щит всё равно сначала во вторую руку, потом бой и добыча', async () => {
  const s = setup({ inventory: [['iron_pickaxe', 1], ['iron_sword', 1], ['shield', 1], ['cobblestone', 32]] });
  s.world.set(new Vec3(6, 58, 0), 'iron_ore');
  // Как mineflayer: перенести предмет во вторую руку (ячейка 45).
  const moved = [];
  s.bot.equip = async (item, dest) => {
    const from = s.bot.inventory.slots.indexOf(item);
    assert.equal(dest, 'off-hand');
    s.bot.inventory.slots[45] = item;
    s.bot.inventory.slots[from] = null;
    moved.push(item.name);
  };
  const zombie = { id: 621, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 2.5), width: 0.6, height: 1.95, hp: 2 };
  s.bot.entities[zombie.id] = zombie;
  const write = s.bot._client.write;
  s.bot._client.write = (name, params) => {
    write(name, params);
    if (name === 'use_entity' && params.mouse === 1 && params.target === zombie.id && (zombie.hp -= 1) <= 0) {
      delete s.bot.entities[zombie.id];
      s.bot.emit('entityDead', zombie);
    }
  };
  const r = await s.run('#добудь железо 1 здесь', 900000);
  const text = [].concat(r.message).join('\n');
  assert.equal(r.ok, true, text);
  assert.deepEqual(moved, ['shield'], 'щит переложил (сторож не прервал это из-за зомби)');
  assert.equal(s.bot.inventory.slots[45] && s.bot.inventory.slots[45].name, 'shield');
  assert.match(text, /Отбился от мобов: зомби ×1/);
  assert.equal(r.data.mined, 1);
});

test('команды: #добудь при анти-X-ray — руду, что сервер открыл у хода, берёт сразу (ход бросает), а не после 8 блоков', async () => {
  // Руды не видно нигде (сервер прячет её камнем). Бот копает ход вглубь; у второго выкопанного блока сервер
  // открывает железо — бот бросает ход и берёт его.
  const hiddenOres = { '1,61,0': 'iron_ore' };
  const s = setup({ inventory: [['iron_pickaxe', 1], ['cobblestone', 32]], server: { hiddenOres } });
  const r = await s.run('#добудь железо 1 здесь', 900000);
  const text = [].concat(r.message).join('\n');
  assert.equal(r.ok, true, text);
  assert.equal(r.data.mined, 1);
  assert.equal(s.world.get(new Vec3(1, 61, 0)) === 'iron_ore', false, 'открывшуюся руду выкопал');
  const deepest = Math.min(...changedBelow(s.world, 'air').concat(changedBelow(s.world, 'cobblestone')).map((c) => c.y));
  assert.ok(deepest >= 60, `ход бросил, как открылась руда: глубже Y ${deepest} не копал`);
});

test('команды: #рентген — вся руда у воздуха, в камне ни одной: честно говорит, что сервер её прячет', async () => {
  const s = setup({ inventory: [] });
  // 12 руд — все у воздуха (над полом): будто пещера; в толще камня — ничего.
  for (let x = -6; x < 6; x += 1) s.world.set(new Vec3(x, 63, 3), 'iron_ore');
  const r = await s.run('#рентген');
  const text = [].concat(r.message).join('\n');
  assert.equal(r.data.hiddenOre, true, text);
  assert.match(text, /сервер прячет руду \(анти-X-ray\)/);
  // А если хоть одна лежит в толще камня — так не говорит.
  s.world.set(new Vec3(0, 50, 0), 'iron_ore');
  const r2 = await s.run('#рентген');
  assert.equal(r2.data.hiddenOre, false);
});

test('команды: #добудь — руду у воды не трогает (потечёт), берёт другую; рядом нет — копает дальше и ищет снова; кирка; где искать', async () => {
  const s = setup({ inventory: [['stone_pickaxe', 1], ['cobblestone', 16]] });
  s.world.set(new Vec3(3, 62, 0), 'iron_ore');
  s.world.set(new Vec3(4, 62, 0), 'water'); // рядом с этой рудой — вода
  s.world.set(new Vec3(-4, 62, 2), 'iron_ore');
  const r = await s.run('#добудь железо 1 здесь', 600000);
  assert.equal(r.ok, true, [].concat(r.message).join('\n'));
  assert.notEqual(s.world.get(new Vec3(-4, 62, 2)), 'iron_ore');
  assert.equal(s.world.get(new Vec3(3, 62, 0)), 'iron_ore', 'руду у воды не тронул');
  assert.equal(s.world.get(new Vec3(4, 62, 0)), 'water');

  // Уголь (лучше всего — выше) дальше, чем видно (45 блоков на юг, куда смотрит бот): идёт/копает вбок и находит.
  const far = setup({ inventory: [['wooden_pickaxe', 1]] });
  far.world.set(new Vec3(0, 62, 45), 'coal_ore');
  const c = await far.run('#добудь уголь 1 здесь', 600000);
  const text = [].concat(c.message).join('\n');
  assert.equal(c.ok, true, text);
  assert.equal(far.world.get(new Vec3(0, 62, 45)), 'air');
  assert.ok(Math.hypot(far.bot.entity.position.x - 0.5, far.bot.entity.position.z - 0.5) < 0.7, `вернулся к началу: ${far.bot.entity.position}`);

  // Руды нет вовсе — честно: не нашёл, где искать.
  const none = setup({ inventory: [['stone_pickaxe', 1]] });
  for (let x = -40; x <= 40; x += 1) for (let z = -40; z <= 40; z += 1) none.world.set(new Vec3(x, 62, z), 'bedrock');
  const n = await none.run('#добудь железо 1 здесь', 600000);
  assert.equal(n.ok, false);
  assert.equal(n.code, 'not_found');
  assert.match([].concat(n.message).join('\n'), /Руды «железо» не нашёл/);
  assert.match([].concat(n.message).join('\n'), /Где искать: Y −64…72, больше всего — Y ≈ 16/);

  const weak = setup({ inventory: [['wooden_pickaxe', 1]] });
  const noPick = await weak.run('#добудь алмазы');
  assert.equal(noPick.code, 'no_pickaxe');
  assert.match(noPick.message, /нет кирки для «алмазы» \(нужна не хуже: железная\) — дай боту кирку или укажи общий дом/);
  assert.match((await weak.run('#добудь пирожки')).message, /какую руду\? .*Знаю: уголь, медь, железо/);
});

test('команды: сундук на чужой территории — сервер не даёт открыть, бот так и пишет', async () => {
  const { run, world } = setup({ storage: { '1,64,2': { deny: true } } });
  world.set(new Vec3(1, 64, 2), 'chest');
  const r = await run('#достань пшеница');
  assert.equal(r.ok, false);
  assert.equal(r.message, '#достань: Сундук в 1 64 2: сервер не даёт открыть — «К сожалению, Вы не можете открывать это в этом месте.» (чужая или защищённая территория)');
});

test('команды: NPC за прилавком — вплотную не подойти, но дотянуться можно: меню всё равно открывается', async () => {
  const json = (text) => JSON.stringify({ text });
  const quests = () => ({
    id: 8,
    title: json('Фермер › Уровень 1 → 2'),
    inventoryStart: 54,
    slots: Object.assign(new Array(90).fill(null), {
      11: { name: 'wheat', count: 1, customName: json('Грядки.'), customLore: [json('Передайте пшеницу: 0/224')] },
    }),
  });
  const npc = { id: 501, type: 'mob', name: 'villager', position: new Vec3(0.5, 64, 4.5), height: 1.95, width: 0.6, getCustomName: () => ({ json: { text: 'Фермер' }, toString: () => 'Фермер' }) };
  const s = setup({ entities: [npc], npcs: { 501: quests } });
  // Будка NPC: прилавок до потолка спереди и стены с боков и сзади — внутрь не пройти (и в обход тоже).
  for (const y of [64, 65]) {
    for (let x = -3; x <= 3; x += 1) for (const z of [2, 8]) s.world.set(new Vec3(x, y, z), 'stone');
    for (let z = 3; z <= 7; z += 1) for (const x of [-3, 3]) s.world.set(new Vec3(x, y, z), 'stone');
  }
  const r = await s.run('#квесты', 60000);
  assert.equal(r.ok, true, [].concat(r.message).join('\n'));
  assert.ok(s.bot.entity.position.z < 2, 'за стену не прошёл');
  assert.deepEqual(r.data.quests.map((q) => q.slot), [11]);
});

test('команды: #сущности — NPC-«игрок» со служебным ником называется по надписи над головой', async () => {
  const stand = (id, y, name) => ({
    id, type: 'object', name: 'armor_stand', position: new Vec3(4.5, y, 2.5),
    getCustomName: () => ({ json: { text: name }, toString: () => name }),
  });
  const { run } = setup({
    entities: [
      { id: 301, type: 'player', username: '#1479d9c455b1f85', position: new Vec3(4.5, 64, 2.5), height: 1.8 },
      stand(302, 66.3, 'Квест NPC'),
      stand(303, 66.6, 'Фермер'),
      stand(304, 66.0, 'Нажмите, чтобы открыть'),
    ],
  });
  const list = await run('#сущности');
  const npc = list.data.entities.find((e) => e.id === 301);
  assert.deepEqual([npc.type, npc.name], ['npc', 'Фермер']);
  assert.ok([].concat(list.message).includes('@301 NPC «Фермер» — 4.5 бл.'), [].concat(list.message).join('\n'));
});

test('команды: неизвестная — подсказка; #помощь работает и без мира; #стоп', async () => {
  const { run, logs } = setup();
  const unknown = await run('#абв');
  assert.equal(unknown.ok, false);
  assert.ok(logs.includes('warn:Неизвестная команда «#абв». Список: #помощь'));
  await run('#помощь');
  assert.ok(logs.includes('info:#где — где бот, куда смотрит, здоровье, на какой блок смотрит'));
  assert.equal((await run('#стоп')).message, 'Бот ничего не делал');
  const offline = await runCommand(null, '#помощь');
  assert.equal(offline.ok, true, 'справка — даже когда бот не в мире');
  assert.equal((await runCommand(null, '#где')).code, 'not_ready');
});

test('команды: #рентген — что из списка есть в чанках вокруг и где ближайшее; одно — с координатами; радиус; лава; непонятное', async () => {
  const s = setup();
  s.bot.panelConfig = { xray: { radius: 1 } }; // список — по умолчанию
  for (const [x, y, z, name] of [
    [3, 50, 2, 'diamond_ore'], [-5, -40, 6, 'deepslate_diamond_ore'], [10, 60, 10, 'iron_ore'],
    [20, 30, 20, 'spawner'], [40, 10, 0, 'emerald_ore'], [2, 62, 2, 'lava'],
  ]) s.world.set(new Vec3(x, y, z), name);
  const text = (r) => [].concat(r.message).join('\n');

  const all = await s.run('#рентген');
  assert.equal(all.ok, true);
  const lines = [].concat(all.message);
  assert.equal(lines[0], 'Рентген (радиус 1 чанк, 3×3): найдено 4');
  assert.equal(lines[1], 'Алмазы ×2 — ближайший 3 50 2 (14 бл.)');
  assert.ok(lines.includes('Железо ×1 — ближайший 10 60 10 (15 бл.)'), text(all));
  assert.ok(lines.includes('Спавнер ×1 — ближайший 20 30 20 (44 бл.)'), text(all));
  assert.match(lines.at(-1), /^Нет: изумруды, древние обломки, золото, /);
  assert.equal(all.data.total, 4);

  const one = await s.run('#рентген алмазы');
  assert.deepEqual([].concat(one.message), ['Рентген: Алмазы ×2 (радиус 1 чанк, 3×3), ближние:', '  3 50 2 — 14 бл.', '  -5 -40 6 — 104 бл.']);
  assert.match(text(await s.run('#рентген изумруды радиус 3')), /^Рентген: Изумруды ×1 \(радиус 3 чанка, 7×7\), ближние:\n {2}40 10 0 — /);
  assert.match(text(await s.run('#рентген лава')), /^Рентген: Лава ×1 /);
  assert.match(text(await s.run('#рентген 0')), /^Рентген \(радиус 0 чанков, 1×1\): найдено 2/); // алмаз и железо — в чанке бота

  const none = setup();
  const empty = await none.run('#рентген');
  assert.equal(empty.ok, true);
  assert.match(text(empty), /^Рентген \(радиус 2 чанка, 5×5\): ничего из списка — не нашёл\n.*анти-X-ray/);
  assert.match((await none.run('#рентген пирожки')).message, /что искать\? Например: #рентген алмазы/);
});

test('команды: #добудь там, где копать не дают (спавн, приват) — сразу стоп и куда отвести бота, а не «не нашёл»', async () => {
  const s = setup({ inventory: [['iron_pickaxe', 1], ['cobblestone', 16]], server: { denyDig: true } });
  for (let i = 0; i < 10; i += 1) s.world.set(new Vec3(3 + i, 60, i % 3), 'lapis_ore');
  const r = await s.run('#добудь лазурит здесь', 600000);
  const text = [].concat(r.message).join('\n');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'protected');
  assert.match(text, /^Не добыл «лазурит»: сервер не даёт ломать блоки здесь \(спавн, варп, чужой приват или лобби\)/);
  assert.match(text, /Здесь копать нельзя — без «здесь» бот сам уйдёт на случайное место: #добудь лазурит$/m);
  assert.doesNotMatch(text, /вода, лава|Где искать/);
  // Два отказа — и стоп: к остальным рудам не ходил.
  const digs = s.bot._client.sent.filter((p) => p.name === 'block_dig' && p.params.status === 2);
  assert.ok(digs.length <= 3, `ломал ${digs.length} раз`);
  assert.equal(s.world.get(new Vec3(3, 60, 0)), 'lapis_ore');
  assert.equal(r.data.denied, true);
});

test('команды: #добудь при анти-X-ray — ненастоящую руду (подошёл — камень) распознаёт, берёт настоящую, открытую', async () => {
  // Две «руды» в толще камня — подделка: сломаешь блок в 2 от неё — сервер покажет камень.
  const fakeOres = new Set(['3,60,0', '-3,60,0']);
  const s = setup({ inventory: [['iron_pickaxe', 1], ['cobblestone', 32]], server: { fakeOres } });
  for (const key of fakeOres) s.world.set(new Vec3(...key.split(',').map(Number)), 'iron_ore');
  // Настоящая — у пещеры (рядом воздух) и дальше подделок.
  s.world.set(new Vec3(0, 55, 9), 'iron_ore');
  for (let z = 6; z <= 8; z += 1) for (const y of [55, 56]) s.world.set(new Vec3(0, y, z), 'air');
  const r = await s.run('#добудь железо 1 здесь', 900000);
  const text = [].concat(r.message).join('\n');
  assert.equal(r.ok, true, text);
  assert.equal(r.data.mined, 1);
  assert.notEqual(s.world.get(new Vec3(0, 55, 9)), 'iron_ore', 'настоящую выкопал');
  assert.equal(r.data.antiXray, true);
  assert.match(text, /Похоже, на сервере анти-X-ray: 2 раз дошёл до руды — а там камень/);
});

test('команды: #снаряжение — все сундуки склада (и дальше 4 блоков), лучшее по каждому месту, незерит, щит, еда 45, броню надевает', async () => {
  const s = setup({
    inventory: [['iron_sword', 1]],
    storage: {
      '2,64,-2': { items: [[0, 'iron_helmet', 1], [1, 'bread', 20], [2, 'stone_pickaxe', 1], [3, 'leather_boots', 1]] },
      // Дальний сундук (7 блоков): лучшее — здесь.
      '7,64,3': { items: [[0, 'netherite_chestplate', 1], [1, 'diamond_helmet', 1], [2, 'netherite_pickaxe', 1], [3, 'shield', 1], [4, 'cooked_beef', 40], [5, 'rotten_flesh', 10], [6, 'netherite_sword', 1]] },
    },
  });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  s.world.set(new Vec3(7, 64, 3), 'chest');
  const WEAR = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
  s.bot.equip = async (item, dest) => { // как mineflayer: надеть / во вторую руку
    const slots = s.bot.inventory.slots;
    const from = slots.indexOf(item);
    const old = slots[WEAR[dest]] || null;
    slots[WEAR[dest]] = item;
    slots[from] = old;
  };
  const r = await s.run('#снаряжение', 900000);
  const text = [].concat(r.message).join('\n');
  const slots = s.bot.inventory.slots;
  assert.equal(slots[5] && slots[5].name, 'diamond_helmet', `${text}`);
  assert.equal(slots[6] && slots[6].name, 'netherite_chestplate');
  assert.equal(slots[8] && slots[8].name, 'leather_boots', 'лучше нет — и кожаные годятся');
  assert.equal(slots[45] && slots[45].name, 'shield', 'щит во второй руке');
  const has = (name) => slots.slice(9, 45).some((it) => it && it.name === name);
  assert.ok(has('netherite_pickaxe') && has('netherite_sword'), 'незеритовые кирка и меч');
  assert.ok(!has('stone_pickaxe') && !has('iron_helmet'), 'хуже — не брал');
  assert.ok(!has('rotten_flesh'), 'вредную еду не брал');
  assert.ok(r.data.food >= 45, `еды ${r.data.food}`);
  assert.equal(r.data.chests, 2);
  assert.match(text, /Не нашлось ни у бота, ни в сундуках: поножи/);
  assert.equal(r.ok, false, 'поножей нет — комплект неполный');
});

test('команды: #добудь без кирки — /home на общий дом, кирка из сундука, потом /rtp и добыча там', async () => {
  const s = setup({ inventory: [['cobblestone', 16]], storage: { '2,64,-2': { items: [[0, 'stone_pickaxe', 1], [1, 'iron_pickaxe', 1]] } } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  s.bot.panelConfig = { questStorage: 'база' };
  // /rtp — на случайное место (здесь — x 100), там в камне железо.
  s.world.set(new Vec3(104, 58, 3), 'iron_ore');
  const sent = [];
  s.bot.sendCommand = (cmd) => {
    sent.push(cmd);
    setImmediate(() => {
      if (cmd === '/home база') teleport(s.bot, { x: 0.5, y: 64, z: 0.5 });
      if (cmd === '/rtp') teleport(s.bot, { x: 100.5, y: 64, z: 0.5 });
    });
    return true;
  };
  const r = await s.run('#добудь железо 1', 900000);
  const text = [].concat(r.message).join('\n');
  assert.equal(r.ok, true, text);
  assert.deepEqual(sent, ['/home база', '/rtp']);
  assert.match(text, /^Общий дом «база»: сундуков осмотрел 1, взял iron_pickaxe×1$/m, 'из двух кирок — лучшая');
  assert.match(text, /^\/rtp: копаю у 100 64 0$/m);
  assert.equal(r.data.mined, 1);
  assert.notEqual(s.world.get(new Vec3(104, 58, 3)), 'iron_ore');

  // Кирка уже есть — дом не нужен: сразу /rtp.
  const t = setup({ inventory: [['iron_pickaxe', 1]] });
  t.world.set(new Vec3(103, 60, 0), 'iron_ore');
  const tSent = [];
  t.bot.sendCommand = (cmd) => {
    tSent.push(cmd);
    setImmediate(() => teleport(t.bot, { x: 100.5, y: 64, z: 0.5 }));
    return true;
  };
  const q = await t.run('#добудь железо 1', 900000);
  assert.equal(q.ok, true, [].concat(q.message).join('\n'));
  assert.deepEqual(tSent, ['/rtp']);

  // Кирки нет ни у бота, ни в сундуках дома — понятно, что положить.
  const u = setup({ inventory: [['cobblestone', 4]], storage: { '2,64,-2': { items: [[0, 'wheat', 5]] } } });
  u.world.set(new Vec3(2, 64, -2), 'chest');
  u.bot.sendCommand = (cmd) => {
    setImmediate(() => teleport(u.bot, { x: 0.5, y: 64, z: 0.5 }));
    return Boolean(cmd);
  };
  const none = await u.run('#добудь железо дом база');
  assert.equal(none.code, 'no_pickaxe');
  assert.match(none.message, /на общем доме «база» нет кирки не хуже: каменная .*положи туда кирки/);
});