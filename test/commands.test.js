'use strict';

// Команды боту из строки чата (src/bot/commands.js): простые формы по-русски, ответ человеку в консоль
// и данные для ИИ ({ ok, message, data }). Бот — поддельный, с нашей физикой и действиями (test/fake-bot.js).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { fakeClock, makeWorld, physicsBot, autoServer, teleport, take, runFor, VERSION } = require('./fake-bot');

const { runCommand, catalog, COMMANDS, parseCoord, parseBlockPos } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));

/** Бот стоит в 0.5 64 0.5 на камне, смотрит на юг (+z). players: [{ name, at: [x, y, z] }], inventory: [[имя, кол-во]]. */
function setup({ players = [], farPlayers = [], chests = {}, inventory = [], entities = [], npcs = {}, onClick = null } = {}) {
  const clock = fakeClock();
  const world = makeWorld(require('prismarine-registry')(VERSION));
  const bot = physicsBot({ clock, world, actions: true });
  autoServer(bot, world, { chests, npcs, onClick });
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
  const run = async (line) => {
    const r = await runFor(clock, runCommand(bot, line, (level, text) => logs.push(`${level}:${text}`)));
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
