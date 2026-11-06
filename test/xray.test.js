'use strict';

// Рентген (src/bot/xray.js): настройки, что искать, поиск по палитрам чанков настоящего мира 1.21.11, слежка.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const EventEmitter = require('node:events');
const { Vec3 } = require('vec3');

const xray = require(path.join(__dirname, '..', 'src', 'bot', 'xray.js'));
const { DEFAULT_CONFIG, sanitize } = require(path.join(__dirname, '..', 'src', 'config.js'));

const VERSION = '1.21.11';
const registry = require('prismarine-registry')(VERSION);
const Chunk = require('prismarine-chunk')(VERSION);
const World = require('prismarine-world')(VERSION);
const Block = require('prismarine-block')(VERSION);

const sid = (name, props) => (props ? Block.fromProperties(name, props, 0).stateId : registry.blocksByName[name].defaultState);

/** Мир: колонки от -r до r чанков, камень от -64 до 63; blocks — [[x, y, z, имя]]. */
function makeWorld(r, blocks = []) {
  const world = new World(null);
  for (let cx = -r; cx <= r; cx++) {
    for (let cz = -r; cz <= r; cz++) {
      const c = new Chunk({ minY: -64, worldHeight: 384 });
      const p = new Vec3(0, 0, 0);
      for (p.x = 0; p.x < 16; p.x++) for (p.z = 0; p.z < 16; p.z++) for (p.y = -64; p.y < 64; p.y++) c.setBlockStateId(p, sid('stone'));
      world.sync.setColumn(cx, cz, c);
    }
  }
  for (const [x, y, z, name, props] of blocks) world.sync.setBlockStateId(new Vec3(x, y, z), sid(name, props));
  return world.sync;
}

const makeBot = (world, at = new Vec3(8.5, 64, 8.5)) => {
  const bot = new EventEmitter();
  bot.version = VERSION;
  bot.registry = registry;
  bot.world = world;
  bot.entity = { position: at.clone() };
  return bot;
};

const group = (r, key) => r.groups.find((g) => g.key === key);

test('настройки: по умолчанию — руды и спавнер; неверное отбрасывается, цвета и имена — как у игры, без повторов', () => {
  const d = xray.sanitizeXray();
  assert.deepEqual([d.enabled, d.radius, d.lava, d.overlay], [false, 2, false, true]);
  assert.ok(d.blocks.length >= 12);
  const byName = Object.fromEntries(d.blocks.map((b) => [b.name, b]));
  assert.deepEqual(byName.diamond_ore, { name: 'diamond_ore', label: 'Алмазы', color: '#4aedd9ff', on: true, same: true });
  assert.strictEqual(byName.coal_ore.on, false, 'уголь есть, но выключен — его слишком много');
  assert.strictEqual(byName.spawner.on, true);
  assert.notStrictEqual(d.blocks[0], xray.DEFAULT_BLOCKS[0], 'копия, а не общий объект');

  const s = xray.sanitizeXray({
    enabled: 'да', radius: '99', lava: true, overlay: false,
    blocks: [
      { name: 'Minecraft:Diamond_Ore', label: '  Алмазы\n', color: '#ABCDEF' },
      { name: 'diamond_ore', label: 'повтор' },
      { name: 'нет такого', color: '#123456' },
      { name: 'chest', label: '', color: 'красный', on: false, same: false },
      null, 5, 'iron_ore',
    ],
  });
  assert.deepEqual([s.enabled, s.radius, s.lava, s.overlay], [false, 8, true, false]);
  assert.deepEqual(s.blocks, [
    { name: 'diamond_ore', label: 'Алмазы', color: '#abcdefff', on: true, same: true },
    { name: 'chest', label: 'chest', color: '#ffffffff', on: false, same: false },
  ]);
  assert.deepEqual(xray.sanitizeXray({ blocks: [] }).blocks, [], 'всё удалили — список пуст, а не «по умолчанию»');
  assert.strictEqual(xray.sanitizeXray({ radius: -3 }).radius, 0);
  const many = Array.from({ length: 80 }, (_, i) => ({ name: `b${i}` }));
  assert.strictEqual(xray.sanitizeXray({ blocks: many }).blocks.length, xray.MAX_BLOCKS);

  // Настройки панели: рентген — свой раздел, неверное в нём чинится.
  assert.deepEqual(DEFAULT_CONFIG.xray, xray.DEFAULT_XRAY);
  assert.deepEqual(sanitize({ xray: { enabled: true, radius: 3, blocks: [{ name: 'spawner' }] } }).xray,
    { enabled: true, radius: 3, lava: false, overlay: true, blocks: [{ name: 'spawner', label: 'spawner', color: '#ffffffff', on: true, same: true }] });
  assert.strictEqual(sanitize({ xray: 'вкл' }).xray, undefined);
});

test('что искать: строка с глубинной парой (deepslate_…), выключенные — нет, лава — по желанию, все состояния блока', () => {
  const { groups, byState } = xray.xrayGroups(registry, {
    lava: true,
    blocks: [
      { name: 'diamond_ore', label: 'Алмазы', color: '#00ffffff' },
      { name: 'deepslate_iron_ore', label: 'Железо', color: '#ffffffff' },
      { name: 'redstone_ore', label: 'Редстоун', color: '#ff0000ff', same: false },
      { name: 'coal_ore', label: 'Уголь', on: false },
      { name: 'unknown_block_xyz', label: '?' },
    ],
  });
  assert.deepEqual(groups.map((g) => [g.key, g.names]), [
    ['diamond_ore', ['diamond_ore', 'deepslate_diamond_ore']],
    ['deepslate_iron_ore', ['deepslate_iron_ore', 'iron_ore']],
    ['redstone_ore', ['redstone_ore']],
    ['lava', ['lava']],
  ]);
  assert.strictEqual(byState.get(sid('deepslate_diamond_ore')), 0);
  assert.strictEqual(byState.get(sid('redstone_ore', { lit: true })), 2, 'горящий редстоун — тоже редстоун');
  assert.strictEqual(byState.get(sid('redstone_ore', { lit: false })), 2);
  assert.strictEqual(byState.get(sid('deepslate_redstone_ore')), undefined);
  assert.strictEqual(byState.get(sid('lava', { level: 3 })), 3, 'и текущая лава');
  assert.strictEqual(byState.get(sid('coal_ore')), undefined);
  assert.strictEqual(byState.get(sid('stone')), undefined);
});

test('поиск по палитрам: квадрат чанков вокруг бота и вся высота, ближние первыми, сколько и где ближайшее', async () => {
  const world = makeWorld(3, [
    [10, 20, 10, 'diamond_ore'], // в чанке бота
    [-3, -60, 5, 'deepslate_diamond_ore'], // соседний чанк, глубоко
    [20, 100, 20, 'iron_ore'], // соседний чанк, высоко (выше камня — в воздухе)
    [52, 10, 8, 'emerald_ore'], // 3 чанка от бота
    [9, 64, 9, 'lava'],
    [12, 30, 12, 'spawner'],
  ]);
  const bot = makeBot(world);
  const r = await xray.scanXray(bot, { radius: 1, lava: true });
  assert.deepEqual([r.radius, r.center, r.truncated], [1, { x: 8, y: 64, z: 8 }, false]);
  const d = group(r, 'diamond_ore');
  assert.strictEqual(d.count, 2);
  assert.deepEqual(d.positions, [10, 20, 10, -3, -60, 5], 'ближние первыми');
  assert.deepEqual(d.nearest, { x: 10, y: 20, z: 10, dist: 43.6 }); // от ног бота до центра блока
  assert.strictEqual(group(r, 'iron_ore').count, 1);
  assert.strictEqual(group(r, 'emerald_ore').count, 0, 'за радиусом');
  assert.strictEqual(group(r, 'lava').count, 1);
  assert.deepEqual(group(r, 'spawner').positions, [12, 30, 12]);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.shown, 5);

  const wide = await xray.scanXray(bot, { radius: 1 }, { radius: 3 });
  assert.strictEqual(group(wide, 'emerald_ore').count, 1, 'радиус из команды — сильнее настроек');
  assert.strictEqual(group(wide, 'lava'), undefined, 'лава выключена — её группы нет');

  // Показываем не больше limit ближних, считаем все; собираем не больше collect — «обрезано».
  // Ближние три (без лавы): спавнер 34 бл., железо 40, алмаз 43,6 — дальний алмаз уже не показан.
  const few = await xray.scanXray(bot, { radius: 1 }, { limit: 3 });
  assert.strictEqual(few.shown, 3);
  assert.deepEqual(group(few, 'diamond_ore').positions, [10, 20, 10]);
  assert.strictEqual(group(few, 'diamond_ore').count, 2);
  const cut = await xray.scanXray(bot, { radius: 1 }, { collect: 1 });
  assert.strictEqual(cut.truncated, true);
  assert.strictEqual(cut.total, 1);

  // Пустой список — ничего не ищет; прерывание — ошибка с кодом aborted.
  assert.strictEqual((await xray.scanXray(bot, { blocks: [] })).total, 0);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(xray.scanXray(bot, { radius: 1 }, { signal: ctl.signal }), (err) => err.code === 'aborted');
});

test('поиск не держит процесс: кусками с паузами, тики других ботов идут', async () => {
  const blocks = [];
  for (let i = 0; i < 400; i++) blocks.push([(i * 7) % 80 - 40, -60 + (i % 100), (i * 13) % 80 - 40, i % 2 ? 'iron_ore' : 'deepslate_iron_ore']);
  const bot = makeBot(makeWorld(3, blocks));
  let ticks = 0;
  const timer = setInterval(() => (ticks += 1), 0);
  try {
    const r = await xray.scanXray(bot, { radius: 3 }, { sliceMs: 1 });
    assert.strictEqual(group(r, 'iron_ore').count, 400);
  } finally {
    clearInterval(timer);
  }
  assert.ok(ticks > 0, 'между кусками событийный цикл отпускался');
});

test('слежка для окна: сразу, другой чанк — заново, блок из списка поменялся — заново, чужой — нет; stop снимает слушателей', async () => {
  const world = makeWorld(2, [[5, 10, 5, 'gold_ore']]);
  const bot = makeBot(world);
  const results = [];
  const tracker = xray.createXrayTracker({ bot, getSettings: () => ({ radius: 1 }), onResult: (r) => results.push(r), minIntervalMs: 0 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(50);
  assert.strictEqual(results.length, 1);
  assert.strictEqual(group(results[0], 'gold_ore').count, 1);

  bot.emit('blockUpdate', { position: new Vec3(1, 1, 1), stateId: sid('stone') }, { position: new Vec3(1, 1, 1), stateId: 0 });
  await wait(400);
  assert.strictEqual(results.length, 1, 'камень не в списке — не ищет');

  const at = new Vec3(5, 10, 5);
  world.setBlockStateId(at, 0);
  bot.emit('blockUpdate', { position: at, stateId: sid('gold_ore') }, { position: at, stateId: 0 });
  await wait(400);
  assert.strictEqual(results.length, 2);
  assert.strictEqual(group(results[1], 'gold_ore').count, 0);

  bot.entity.position = new Vec3(30, 64, 8); // в соседний чанк
  bot.emit('move');
  await wait(300);
  assert.strictEqual(results.length, 3);

  tracker.stop();
  for (const e of ['move', 'forcedMove', 'chunkColumnLoad', 'blockUpdate']) assert.strictEqual(bot.listenerCount(e), 0, e);
  bot.emit('move');
  await wait(50);
  assert.strictEqual(results.length, 3);
});

test('слова команды: подпись, имя блока, лава; не из списка — любой блок игры; непонятное — пусто', () => {
  const s = xray.sanitizeXray();
  assert.deepEqual(xray.findEntries(s, ['алмазы'], registry).map((e) => e.name), ['diamond_ore']);
  assert.deepEqual(xray.findEntries(s, ['алмаз'], registry).map((e) => e.name), ['diamond_ore']);
  assert.deepEqual(xray.findEntries(s, ['золото', 'незера'], registry).map((e) => e.name), ['nether_gold_ore']);
  assert.deepEqual(xray.findEntries(s, ['diamond_ore'], registry).map((e) => e.name), ['diamond_ore']);
  assert.deepEqual(xray.findEntries(s, ['лава'], registry).map((e) => e.name), ['lava']);
  assert.deepEqual(xray.findEntries(s, ['ancient', 'debris'], registry).map((e) => e.name), ['ancient_debris']);
  assert.deepEqual(xray.findEntries({ blocks: [] }, ['obsidian'], registry).map((e) => e.name), ['obsidian']);
  assert.deepEqual(xray.findEntries(s, ['пирожки'], registry), []);
  assert.deepEqual(xray.findEntries(s, [], registry), []);
});
