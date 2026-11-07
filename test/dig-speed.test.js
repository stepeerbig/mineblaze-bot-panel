'use strict';

// Время копания — как у игры 1.21 (src/bot/dig-speed.js).

const test = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.11');
const Item = require('prismarine-item')(registry);
const Block = require('prismarine-block')(registry);
const { digTicks, enchantmentsOf, trackServerEnchantments } = require('../src/bot/dig-speed');

const block = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0);
const item = (name, enchants = null) => Item.fromNotch({
  itemCount: 1,
  itemId: registry.itemsByName[name].id,
  components: enchants ? [{ type: 'enchantments', data: { enchantments: enchants } }] : [],
  removeComponents: [],
});
const EFF = registry.enchantmentsByName.efficiency.id;

function fakeBot() {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.registry = registry;
  bot.game = { gameMode: 'survival' };
  bot.entity = { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62, onGround: true, effects: {} };
  bot.blockAt = () => null;
  bot.inventory = { slots: [] };
  return bot;
}

test('копание: руда с киркой — как в игре (в minecraft-data у руд «не тот материал» — было 91 тик на алмаз любой киркой)', () => {
  const bot = fakeBot();
  const diamond = item('diamond_pickaxe');
  const eff5 = item('diamond_pickaxe', [{ id: EFF, level: 5 }]);
  // Числа — как в игре (вики: «Breaking»): алмазная руда алмазной киркой — 0,6 с, с «Эффективностью V» — 0,15 с.
  assert.equal(digTicks(bot, block('diamond_ore'), diamond), 12);
  assert.equal(digTicks(bot, block('diamond_ore'), eff5), 3);
  assert.equal(digTicks(bot, block('deepslate_diamond_ore'), eff5), 4);
  assert.equal(digTicks(bot, block('iron_ore'), item('stone_pickaxe')), 23);
  assert.equal(digTicks(bot, block('obsidian'), diamond), 188);
  assert.equal(digTicks(bot, block('stone'), eff5), 2);
  // Деревянной киркой железо не добыть (руда не выпадет) — и копается долго, как в игре.
  assert.equal(digTicks(bot, block('iron_ore'), item('wooden_pickaxe')), 151);
  // В прыжке — в 5 раз медленнее; со «Спешкой II» камень ломается сразу.
  assert.equal(digTicks(bot, block('stone'), eff5, { onGround: false }), 7);
  bot.entity.effects[registry.effectsByName.Haste.id] = { amplifier: 1 };
  assert.equal(digTicks(bot, block('stone'), eff5), 0);
  assert.equal(digTicks(bot, block('bedrock'), eff5), Infinity);
});

test('копание: номера зачарований — по списку сервера (у плагинов свои зачарования, номера сдвигаются)', () => {
  const bot = fakeBot();
  trackServerEnchantments(bot);
  // Свои зачарования плагина — в начале списка: у «efficiency» теперь не 8, а 10.
  const keys = ['myplugin:veinminer', 'myplugin:telepathy', ...registry.enchantmentsArray.map((e) => `minecraft:${e.name}`)];
  bot._client.emit('registry_data', { id: 'minecraft:enchantment', entries: keys.map((key) => ({ key })) });
  const pick = item('diamond_pickaxe', [{ id: 10, level: 5 }, { id: 0, level: 1 }]);
  assert.deepEqual(enchantmentsOf(bot, pick), [{ name: 'efficiency', lvl: 5 }, { name: 'myplugin:veinminer', lvl: 1 }]);
  assert.equal(digTicks(bot, block('diamond_ore'), pick), 3);
  // По старой таблице номер 10 — не «эффективность»: кирка без неё.
  const plain = fakeBot();
  assert.equal(digTicks(plain, block('diamond_ore'), pick), 12);
});

test('копание: не быстрее, чем считает сервер (его mining_efficiency меньше, чем у зачарования, — по серверу)', () => {
  const bot = fakeBot();
  bot.heldItem = item('diamond_pickaxe', [{ id: EFF, level: 5 }]);
  assert.equal(digTicks(bot, block('diamond_ore')), 3);
  bot.entity.attributes = { mining_efficiency: { value: 0, modifiers: [{ amount: 2, operation: 0 }] } }; // как «Эффективность I»
  assert.equal(digTicks(bot, block('diamond_ore')), 9);
  bot.entity.attributes = { mining_efficiency: { value: 0, modifiers: [{ amount: 26, operation: 0 }] }, 'player.block_break_speed': { value: 0.5, modifiers: [] } };
  assert.equal(digTicks(bot, block('diamond_ore')), 6, 'block_break_speed 0,5 — вдвое дольше');
});
