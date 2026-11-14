'use strict';

// «#скинь»: весь инвентарь и всё надетое (броня, вторая рука) — в ближайший сундук, где есть место; полон — в
// следующий ближайший (src/bot/commands.js). Сервер — поддельный (test/fake-bot.js: настоящие окна-сундуки).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { runFor } = require('./fake-bot');
const { setup } = require('./fish-fake');

const { runCommand } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));

const textOf = (r) => [].concat(r.message).join('\n');
const WEAR = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
const FULL = () => ({ items: Array.from({ length: 27 }, (_, i) => [i, 'stone', 64]) }); // сундук забит камнем

/**
 * Бот (в 0.5 64 0.5) у сундуков storage («x,y,z» → заготовка autoServer). Снять надетое — как mineflayer (shift-клик:
 * в первую пустую ячейку инвентаря); cursed — вещи с проклятием несъёмности (сервер их не снимает).
 */
function dumpSetup(storage, { cursed = [] } = {}) {
  const s = setup({ storage });
  for (const key of Object.keys(storage)) s.world.set(new Vec3(...key.split(',').map(Number)), 'chest');
  s.bot.unequip = async (dest) => {
    const slots = s.bot.inventory.slots;
    const at = WEAR[dest];
    if (!slots[at] || cursed.includes(slots[at].name)) return;
    for (let i = 9; i < 45; i += 1) {
      if (!slots[i]) {
        slots[i] = slots[at];
        slots[at] = null;
        return;
      }
    }
  };
  s.bot.enchantsOf = (it) => (it && cursed.includes(it.name) ? [{ name: 'binding_curse', lvl: 1 }] : []);
  return s;
}

/** Что лежит в сундуке-заготовке: имя → сколько. */
function contents(spec) {
  const out = {};
  for (const it of spec.slots || []) if (it) out[it.name] = (out[it.name] || 0) + it.count;
  return out;
}

/** Сколько раз бот открывал сундук в x y z. */
const opens = (bot, [x, y, z]) => bot._client.sent.filter((p) => p.name === 'block_place' && p.params.location.x === x &&
  p.params.location.y === y && p.params.location.z === z).length;

const leftOn = (bot) => bot.inventory.slots.map((it, i) => (it ? `${i}:${it.name}` : null)).filter(Boolean);

test('#скинь: всё из инвентаря, броня и щит — в ближайший сундук, где есть место; забитый ближний — пропускает', async () => {
  const near = FULL(); // ближний — забит
  const far = { items: [] };
  const s = dumpSetup({ '2,64,-2': near, '-3,64,2': far });
  const slots = s.bot.inventory.slots;
  slots[9] = { name: 'cod', count: 5 };
  slots[10] = { name: 'bread', count: 3 };
  slots[36] = { name: 'fishing_rod', count: 1 };
  slots[37] = { name: 'iron_pickaxe', count: 1 };
  slots[5] = { name: 'iron_helmet', count: 1 };
  slots[6] = { name: 'iron_chestplate', count: 1 };
  slots[7] = { name: 'iron_leggings', count: 1 };
  slots[8] = { name: 'iron_boots', count: 1 };
  slots[45] = { name: 'shield', count: 1 };
  const r = await runFor(s.clock, runCommand(s.bot, '#скинь'), 120000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.deepEqual(leftOn(s.bot), [], 'у бота ничего не осталось — ни в инвентаре, ни на нём');
  assert.deepEqual(contents(far), {
    cod: 5, bread: 3, fishing_rod: 1, iron_pickaxe: 1, iron_helmet: 1, iron_chestplate: 1, iron_leggings: 1, iron_boots: 1, shield: 1,
  });
  assert.deepEqual(contents(near), { stone: 27 * 64 }, 'в забитый ничего не положил');
  assert.deepEqual(r.value.data.off, ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield']);
  assert.deepEqual(r.value.data.skipped, [{ block: 'chest', position: { x: 2, y: 64, z: -2 }, why: 'полон' }]);
  assert.match(text, /^Скинул 15 шт\. в сундук — инвентарь пуст/);
  assert.match(text, /Сундук -3 64 2: /);
  assert.match(text, /Снял с себя: iron_helmet, iron_chestplate, iron_leggings, iron_boots, shield/);
  assert.match(text, /Пропустил: Сундук 2 64 -2 — полон/);
  assert.equal(opens(s.bot, [-3, 64, 2]), 1, 'в дальний — за один заход (броню снял заранее)');
});

test('#скинь: инвентарь забит — сначала его, потом снимает броню и щит и несёт ещё раз', async () => {
  const big = { items: [], type: 'minecraft:generic_9x6' };
  const s = dumpSetup({ '2,64,-2': big });
  const slots = s.bot.inventory.slots;
  for (let i = 9; i < 45; i += 1) slots[i] = { name: 'cobblestone', count: 64 };
  slots[5] = { name: 'iron_helmet', count: 1 };
  slots[45] = { name: 'shield', count: 1 };
  const r = await runFor(s.clock, runCommand(s.bot, '#скинь'), 120000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.deepEqual(leftOn(s.bot), []);
  assert.deepEqual(contents(big), { cobblestone: 36 * 64, iron_helmet: 1, shield: 1 });
  assert.equal(opens(s.bot, [2, 64, -2]), 2, 'два захода: инвентарь, потом снятое');
  assert.match(text, /Снял с себя: iron_helmet, shield/);
  assert.equal(r.value.data.chests.length, 1, 'один и тот же сундук');
});

test('#скинь: броня с проклятием несъёмности остаётся (так и пишет); сундуки полны — что не влезло, пишет', async () => {
  const near = FULL();
  const s = dumpSetup({ '2,64,-2': near }, { cursed: ['iron_helmet'] });
  const slots = s.bot.inventory.slots;
  slots[9] = { name: 'cod', count: 5 };
  slots[5] = { name: 'iron_helmet', count: 1 };
  slots[8] = { name: 'iron_boots', count: 1 };
  const r = await runFor(s.clock, runCommand(s.bot, '#скинь'), 120000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, false, text);
  assert.equal(r.value.code, 'full');
  assert.match(text, /^Ничего не скинул/);
  assert.match(text, /Не снимается: iron_helmet \(проклятие несъёмности\)/);
  assert.match(text, /Не влезло: (cod×5, iron_boots×1|iron_boots×1, cod×5) — сундуки рядом полны/);
  assert.equal(slots[5] && slots[5].name, 'iron_helmet', 'проклятая — на месте');
  assert.equal(opens(s.bot, [2, 64, -2]), 1, 'забитый сундук открыл один раз');
});

test('#скинь: нечего скидывать — так и говорит; сундуков рядом нет — ошибка с подсказкой', async () => {
  const empty = dumpSetup({ '2,64,-2': { items: [] } });
  const r = await runFor(empty.clock, runCommand(empty.bot, '#скинь'), 30000);
  assert.ifError(r.error);
  assert.equal(r.value.ok, true);
  assert.match(textOf(r.value), /Скидывать нечего: инвентарь пуст и ничего не надето/);

  const none = dumpSetup({});
  none.bot.inventory.slots[9] = { name: 'cod', count: 5 };
  const r2 = await runFor(none.clock, runCommand(none.bot, '#скинь'), 60000);
  assert.ifError(r2.error);
  assert.equal(r2.value.ok, false);
  assert.match(textOf(r2.value), /рядом нет сундуков \(до 16 блоков\)/);
  assert.equal(none.bot.inventory.slots[9].name, 'cod');
});
