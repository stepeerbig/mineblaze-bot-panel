'use strict';

// Поиск предметов в сундуках (src/bot/commands.js): увидел нужное в открытом сундуке — сразу берёт (не «осмотреть
// всё и вернуться»); таблички на сундуках — «Рыбалка», «Шахтёрство», «Мусор», «Добыча».

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { runFor } = require('./fake-bot');
const { setup, fishServer, rodItem } = require('./fish-fake');

const { runCommand } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));

const textOf = (r) => [].concat(r.message).join('\n');
const opens = (bot, [x, y, z]) => bot._client.sent.filter((p) => p.name === 'block_place' && p.params.location.x === x &&
  p.params.location.y === y && p.params.location.z === z).length;
const openOrder = (bot) => bot._client.sent.filter((p) => p.name === 'block_place').map((p) => `${p.params.location.x},${p.params.location.y},${p.params.location.z}`);

/** Сундуки по «x,y,z» и таблички над ними: labels — «x,y,z» сундука → текст таблички. */
function scene(storage, labels = {}) {
  const s = setup({ storage });
  for (const key of Object.keys(storage)) s.world.set(new Vec3(...key.split(',').map(Number)), 'chest');
  const signs = new Map();
  for (const [key, text] of Object.entries(labels)) {
    const [x, y, z] = key.split(',').map(Number);
    s.world.set(new Vec3(x, y + 1, z), 'oak_sign');
    signs.set(`${x},${y + 1},${z}`, text);
  }
  const blockAt = s.bot.blockAt;
  s.bot.blockAt = (pos) => {
    const b = blockAt(pos);
    const p = pos.floored();
    const text = signs.get(`${p.x},${p.y},${p.z}`);
    if (b && text !== undefined) b.getSignText = () => [text, ''];
    return b;
  };
  return s;
}

test('#снаряжение: увидел нужное — сразу берёт; каждый сундук открывает один раз (раньше: осмотр всех, потом — снова за вещами)', async () => {
  const s = scene({
    '2,64,-2': { items: [[0, 'iron_sword', 1], [1, 'bread', 50]] },
    '-3,64,2': { items: [[0, 'shield', 1], [1, 'iron_helmet', 1]] },
  });
  s.bot.equip = async () => {};
  const r = await runFor(s.clock, runCommand(s.bot, '#снаряжение'), 900000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(opens(s.bot, [2, 64, -2]), 1, text);
  assert.equal(opens(s.bot, [-3, 64, 2]), 1, text);
  const has = (name) => s.bot.inventory.slots.some((it) => it && it.name === name);
  assert.ok(has('iron_sword') && has('shield') && has('iron_helmet') && has('bread'), text);
});

test('#снаряжение: в дальнем сундуке лучше — берёт его, а взятое раньше кладёт туда же', async () => {
  const near = { items: [[0, 'stone_pickaxe', 1]] };
  const far = { items: [[0, 'diamond_pickaxe', 1]] };
  const s = scene({ '2,64,-2': near, '-3,64,4': far });
  s.bot.equip = async () => {};
  const r = await runFor(s.clock, runCommand(s.bot, '#снаряжение'), 900000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  const has = (name) => s.bot.inventory.slots.some((it) => it && it.name === name);
  assert.ok(has('diamond_pickaxe') && !has('stone_pickaxe'), text);
  assert.ok((far.slots || []).some((it) => it && it.name === 'stone_pickaxe'), 'каменную — в дальний сундук');
  assert.match(text, /Вернул в сундук \(взял лучше\): stone_pickaxe/);
});

test('таблички: удочки — сперва из сундука «Рыбалка» (хоть он и дальше), сундук «Мусор» не трогает', async () => {
  const junk = { items: [[0, 'fishing_rod', 1]] };
  const plain = { items: [[0, 'fishing_rod', 1]] };
  const fish = { items: [[0, 'fishing_rod', 1]] };
  const s = scene({ '2,64,-2': junk, '-3,64,2': plain, '5,64,5': fish }, { '2,64,-2': 'Мусор', '5,64,5': '§lРЫБАЛКА' });
  fishServer(s.bot, { biteTicks: 30 });
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 1'), 900000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.deepEqual(openOrder(s.bot).filter((k) => ['2,64,-2', '-3,64,2', '5,64,5'].includes(k)), ['5,64,5'], 'один сундук — «Рыбалка»');
  assert.equal(opens(s.bot, [2, 64, -2]), 0, 'в «Мусор» не лез');
});

test('таблички: мусор (#очисти здесь) — в сундук «Мусор», в «Рыбалку» и «Добычу» не кладёт', async () => {
  const fish = { items: [] };
  const loot = { items: [] };
  const junk = { items: [] };
  const s = scene({ '2,64,-2': fish, '-3,64,2': loot, '6,64,-4': junk }, { '2,64,-2': 'рыбалка', '-3,64,2': 'Добыча', '6,64,-4': 'Мусор' });
  s.bot.inventory.slots[9] = { name: 'dirt', count: 30 };
  s.bot.inventory.slots[10] = { name: 'gravel', count: 10 };
  const r = await runFor(s.clock, runCommand(s.bot, '#очисти здесь'), 900000);
  assert.ifError(r.error);
  assert.equal(r.value.ok, true, textOf(r.value));
  assert.ok((junk.slots || []).some((it) => it && it.name === 'gravel'), 'гравий — в «Мусор» (одну стопку блоков бот оставляет себе для «столба»)');
  assert.equal(opens(s.bot, [2, 64, -2]), 0);
  assert.equal(opens(s.bot, [-3, 64, 2]), 0);
});

test('удочки без табличек: в ближнем — потёртая, берёт её сразу (раньше закрывал, искал новые и возвращался)', async () => {
  const near = { items: [[0, 'fishing_rod', 1, [{ type: 'damage', data: 30 }]]] };
  const far = { items: [[0, 'fishing_rod', 1]] };
  const s = scene({ '2,64,-2': near, '-4,64,4': far });
  fishServer(s.bot, { biteTicks: 30 });
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 1'), 900000);
  assert.ifError(r.error);
  assert.equal(r.value.ok, true, textOf(r.value));
  assert.equal(opens(s.bot, [2, 64, -2]), 1);
  assert.equal(opens(s.bot, [-4, 64, 4]), 0, 'к дальнему не ходил');
  assert.ok(rodItem && s.bot.inventory.slots.some((it) => it && it.name === 'fishing_rod'));
});
