'use strict';

// Сколько тиков ломается блок — как у игры 1.21 (Player.getDestroySpeed, BlockState.getDestroyProgress), с float,
// как в Java: античит (Grim FastBreak) ждёт ровно столько тиков, сколько у обычного клиента.
// Что поправлено против prismarine-block / minecraft-data:
//  1. У 108 «кирочных» блоков (железная, золотая, алмазная, редстоуновая, медная руда, обсидиан, древние обломки,
//     блоки металлов…) в minecraft-data 1.21.11 вместо «mineable/pickaxe» записан тег «incorrect_for_wooden_tool».
//     prismarine-block считал, что кирка для них — не тот инструмент: скорость 1 вместо 8, без «Эффективности».
//     Алмазная руда алмазной киркой с «Эффективностью V» ломалась 91 тик (4,5 с) вместо 3.
//  2. Номера зачарований в 1.21 — по списку, который присылает сервер (registry_data «minecraft:enchantment»):
//     плагины добавляют свои зачарования, и номера ванильных сдвигаются. Без списка — по minecraft-data.
//  3. Что сервер прислал о характеристиках игрока (mining_efficiency, block_break_speed, submerged_mining_speed) —
//     учитываем, а прибавку «Эффективности» берём не больше, чем у сервера: бот не ломает быстрее, чем тот ждёт.

const { getAttributeValue } = require('prismarine-physics/lib/attribute');

const f32 = Math.fround;
const FATIGUE = [f32(0.3), f32(0.09), f32(0.0027), f32(8.1e-4)];

/** Поправить материалы блоков в реестре (общие объекты minecraft-data — один раз на процесс, повторно — ничего). */
function fixMaterials(registry) {
  if (!registry) return;
  const blocks = registry.blocksArray || Object.values(registry.blocks || {});
  for (const b of blocks) {
    if (b && typeof b.material === 'string' && /^incorrect_for_/.test(b.material)) b.material = 'mineable/pickaxe';
  }
}

/** Слушать список зачарований сервера (фаза настройки). Вызывать до входа — при создании бота. */
function trackServerEnchantments(bot) {
  if (bot && bot.registry) fixMaterials(bot.registry);
  if (!bot || !bot._client || typeof bot._client.on !== 'function') return;
  bot._client.on('registry_data', (packet) => {
    if (!packet || !Array.isArray(packet.entries) || !/(?:^|:)enchantment$/.test(String(packet.id || ''))) return;
    bot.serverEnchantments = packet.entries.map((e) => String((e && e.key) || ''));
  });
}

/** Имя зачарования по номеру: «efficiency», чужое — с пространством имён («plugin:veinminer»), неизвестное — ''. */
function enchantmentName(bot, id) {
  const list = bot && bot.serverEnchantments;
  if (Array.isArray(list) && typeof list[id] === 'string') return list[id].replace(/^minecraft:/, '');
  const e = bot && bot.registry && bot.registry.enchantments ? bot.registry.enchantments[id] : null;
  return e ? e.name : '';
}

/** Зачарования предмета списком { name, lvl } (у предметов 1.20.5+ — компонент enchantments: { id, level }). */
function enchantmentsOf(bot, item) {
  if (!item) return [];
  let e;
  try {
    e = item.enchants;
  } catch (_) {
    return [];
  }
  if (Array.isArray(e)) return e.map((x) => ({ name: String(x.name || '').replace(/^minecraft:/, ''), lvl: x.lvl }));
  const list = e && Array.isArray(e.enchantments) ? e.enchantments : [];
  return list.map((x) => ({ name: enchantmentName(bot, x.id), lvl: x.level }));
}

const levelOf = (list, name) => {
  const hit = list.find((x) => x.name === name);
  return hit ? Number(hit.lvl) || 0 : 0;
};

/** Значение характеристики игрока, как его посчитает клиент (основа + прибавки), или null — сервер не присылал. */
function attribute(bot, ...keys) {
  const attrs = bot && bot.entity && bot.entity.attributes;
  if (!attrs) return null;
  for (const k of keys) {
    const a = attrs[k];
    if (!a || typeof a.value !== 'number') continue;
    try {
      return getAttributeValue({ value: a.value, modifiers: Array.isArray(a.modifiers) ? a.modifiers : [] });
    } catch (_) {
      return a.value;
    }
  }
  return null;
}

/** Уровень эффекта (усиление + 1; 0 — нет). */
function effectLevel(bot, name) {
  const info = bot.registry && bot.registry.effectsByName ? bot.registry.effectsByName[name] : null;
  const effects = bot.entity && bot.entity.effects;
  if (!info || !effects) return 0;
  const e = effects[info.id];
  return e && typeof e.amplifier === 'number' ? e.amplifier + 1 : 0;
}

/** Глаза в воде (тогда копать в 5 раз медленнее, если нет «Подводника»). */
function eyesInWater(bot) {
  const e = bot.entity;
  if (!e || !e.position || typeof bot.blockAt !== 'function') return false;
  const eyeY = e.position.y + (e.eyeHeight || 1.62);
  const b = bot.blockAt(e.position.offset(0, e.eyeHeight || 1.62, 0));
  if (!b) return false;
  const water = /^(?:water|flowing_water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/.test(b.name) || b.isWaterlogged === true;
  if (!water) return false;
  const level = typeof b.metadata === 'number' && /water$/.test(b.name) && b.metadata < 8 ? (8 - b.metadata) / 9 : 1;
  return Math.floor(eyeY) + level > eyeY;
}

/**
 * Сколько тиков держать кнопку, чтобы сломать блок вещью item (по умолчанию — что в руке): 0 — ломается сразу,
 * Infinity — не сломать. opts: onGround, inWater (по умолчанию — как сейчас у бота).
 */
function digTicks(bot, block, item = bot.heldItem, opts = {}) {
  if (!block) return Infinity;
  if (bot.game && bot.game.gameMode === 'creative') return 0;
  const registry = bot.registry;
  fixMaterials(registry);
  const hardness = block.hardness;
  if (typeof hardness !== 'number' || hardness < 0) return Infinity;
  const type = item ? item.type : null;
  // Скорость инструмента (правила компонента tool) — по таблице материалов. Блок, созданный до поправки реестра,
  // помнит старый материал — поправляем и здесь.
  const materialName = typeof block.material === 'string' && /^incorrect_for_/.test(block.material) ? 'mineable/pickaxe' : block.material;
  const material = registry && registry.materials ? registry.materials[materialName] : null;
  let speed = f32(material && type !== null && material[type] ? material[type] : 1);
  if (speed > 1) {
    let bonus = 0;
    const lvl = levelOf(enchantmentsOf(bot, item), 'efficiency');
    if (lvl > 0) bonus = lvl * lvl + 1;
    // Сервер считает прибавку характеристикой mining_efficiency (вещь в руке): не больше, чем у него.
    const fromServer = item && item === bot.heldItem ? attribute(bot, 'mining_efficiency', 'minecraft:mining_efficiency', 'player.mining_efficiency') : null;
    if (fromServer !== null) bonus = Math.min(bonus, fromServer);
    speed = f32(speed + f32(bonus));
  }
  const haste = Math.max(effectLevel(bot, 'Haste'), effectLevel(bot, 'ConduitPower'));
  if (haste > 0) speed = f32(speed * f32(1 + f32(haste * f32(0.2))));
  const fatigue = effectLevel(bot, 'MiningFatigue');
  if (fatigue > 0) speed = f32(speed * FATIGUE[Math.min(fatigue - 1, 3)]);
  const breakSpeed = attribute(bot, 'player.block_break_speed', 'block_break_speed', 'minecraft:block_break_speed');
  if (breakSpeed !== null) speed = f32(speed * f32(breakSpeed));
  const inWater = opts.inWater !== undefined ? opts.inWater : eyesInWater(bot);
  if (inWater) {
    let sub = attribute(bot, 'submerged_mining_speed', 'minecraft:submerged_mining_speed', 'player.submerged_mining_speed');
    if (sub === null) {
      const headSlot = typeof bot.getEquipmentDestSlot === 'function' ? bot.getEquipmentDestSlot('head') : 5;
      const head = bot.inventory && bot.inventory.slots ? bot.inventory.slots[headSlot] : null;
      sub = levelOf(enchantmentsOf(bot, head), 'aqua_affinity') > 0 ? 1 : 0.2;
    }
    speed = f32(speed * f32(sub));
  }
  const onGround = opts.onGround !== undefined ? opts.onGround : Boolean(bot.entity && bot.entity.onGround);
  if (!onGround) speed = f32(speed / 5);
  if (hardness === 0) return 0;
  const correct = !block.harvestTools || Boolean(type !== null && block.harvestTools[type]);
  const delta = f32(f32(speed / f32(hardness)) / (correct ? 30 : 100));
  if (delta >= 1) return 0;
  if (!(delta > 0)) return Infinity;
  // Как у клиента: прогресс копится по тикам во float (иначе на редких числах — на тик меньше, чем ждёт сервер).
  let progress = 0;
  let n = 0;
  while (progress < 1 && n < 100000) {
    progress = f32(progress + delta);
    n += 1;
  }
  return n;
}

module.exports = { fixMaterials, trackServerEnchantments, enchantmentName, enchantmentsOf, digTicks, eyesInWater };
