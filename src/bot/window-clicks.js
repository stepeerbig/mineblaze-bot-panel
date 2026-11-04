'use strict';

// Клики в меню — как у настоящего клиента 1.21.5+.
//
// 1. В пакете клика (window_click) mineflayer пишет предметы не так, как игра: отпечатки компонентов — нули,
//    пустая ячейка — «воздух, 0 штук». Здесь пакет переписывается: настоящие отпечатки (см. item-hash.js),
//    пустая ячейка — «ничего».
// 2. Сервер поправляет курсор пакетом set_cursor_item (с 1.21.2), а mineflayer его не читает: после клика по
//    кнопке меню (сервер отменяет «взятие» предмета) бот думал, что держит предмет, и следующий клик сообщал
//    серверу неправду (так «Назад» превратилось в задание в ячейке [36]). Теперь курсор — как скажет сервер.
// 3. Номер состояния окна (stateId) у каждого окна свой. mineflayer хранит один на всех и перезаписывает его
//    пакетами инвентаря (Paper после каждого обновления сундука шлёт ячейку второй руки из окна 0) — поэтому
//    любой клик в сундуке уходил с чужим номером, и сервер в ответ пересылал всё окно заново. Как в игре:
//    клик несёт номер того окна, в котором кликают.
// 4. Зачарования предметов 1.20.5+ mineflayer отдаёт объектом, а ждёт список: bot.digTime падал
//    («enchantments is not iterable») у любой зачарованной кирки — бот не мог копать.
// 5. Shift-клик в сундуке (перенос стопки) prismarine-windows считает не как игра: в сундук — мимо последней
//    его ячейки, стопки сравнивает без компонентов. Ошибка в прогнозе — сервер в ответ поправляет ячейки.
//    Здесь — как в игре (AbstractContainerMenu.moveItemStackTo), см. quickMove.

const { toHashedSlot } = require('./item-hash');

// Окна-хранилища: сундук и большой сундук, бочка, эндер-сундук (generic_9xN), раздатчик (generic_3x3),
// шалкер, воронка. Сначала ячейки хранилища, за ними 36 ячеек инвентаря игрока.
const STORAGE_TYPES = /^minecraft:(?:generic_\dx\d|shulker_box|hopper)$/;

function isStorageWindow(window) {
  return Boolean(
    window && STORAGE_TYPES.test(String(window.type)) && Number.isInteger(window.inventoryStart) &&
    window.inventoryStart > 0 && window.inventoryEnd - window.inventoryStart === 36,
  );
}

/** Сколько предметов помещается в стопку: компонент max_stack_size или по виду предмета. */
function maxStack(item) {
  const c = item && item.componentMap && item.componentMap.get('max_stack_size');
  if (c && Number.isInteger(c.data) && c.data > 0) return c.data;
  return (item && item.stackSize) || 64;
}

// Запись значения, не зависящая от порядка полей (у словарей NBT порядок не важен, у списков — важен).
function stable(v) {
  if (typeof v === 'bigint') return `${v}n`;
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    if (Buffer.isBuffer(v)) return `<${v.toString('hex')}>`;
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
  }
  return v === undefined ? 'u' : JSON.stringify(v);
}

const byType = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);

/** Один ли это предмет с теми же компонентами (как ItemStack.isSameItemSameComponents в игре). */
function sameStack(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  const key = (it) => stable([
    (it.components || []).map((c) => [c.type, stable(c.data)]).sort(byType),
    (it.removedComponents || []).map((c) => c.type).sort(),
  ]);
  return key(a) === key(b);
}

/**
 * Shift-клик по ячейке slot окна-хранилища — как в игре (ChestMenu.quickMoveStack → moveItemStackTo):
 * из хранилища стопка идёт в инвентарь с конца (сначала в неполные стопки того же предмета, остаток — в последнюю
 * пустую ячейку), из инвентаря — в хранилище с начала. Меняет window.slots, возвращает изменившиеся ячейки.
 */
function quickMove(window, slot) {
  const item = window.slots[slot];
  if (!item) return [];
  const fromStorage = slot < window.inventoryStart;
  const start = fromStorage ? window.inventoryStart : 0;
  const end = fromStorage ? window.inventoryEnd : window.inventoryStart;
  // Шалкер в шалкер не кладётся (ShulkerBoxSlot.mayPlace).
  if (!fromStorage && window.type === 'minecraft:shulker_box' && /shulker_box$/.test(item.name || '')) return [];
  const order = [];
  for (let i = 0; i < end - start; i += 1) order.push(fromStorage ? end - 1 - i : start + i);
  const changed = [];
  if (maxStack(item) > 1) {
    for (const i of order) {
      if (item.count <= 0) break;
      const other = window.slots[i];
      if (!other || !sameStack(item, other)) continue;
      const limit = maxStack(other);
      if (other.count + item.count <= limit) {
        other.count += item.count;
        item.count = 0;
      } else if (other.count < limit) {
        item.count -= limit - other.count;
        other.count = limit;
      } else {
        continue;
      }
      window.updateSlot(i, other);
      changed.push(i);
    }
  }
  if (item.count > 0) {
    const empty = order.find((i) => !window.slots[i]);
    if (empty !== undefined) {
      // Больше стопки в одной ячейке не бывает, поэтому в пустую ячейку уходит весь остаток.
      window.updateSlot(slot, null);
      window.updateSlot(empty, item);
      return [...changed, slot, empty];
    }
  }
  if (!changed.length) return [];
  window.updateSlot(slot, item.count > 0 ? item : null);
  return [...changed, slot];
}

/** Подменить прогноз shift-клика в окне-хранилище на игровой (см. quickMove). */
function useVanillaQuickMove(window) {
  if (!isStorageWindow(window) || window.vanillaQuickMove) return;
  const original = window.acceptClick.bind(window);
  window.acceptClick = (click, gameMode) => (click && click.mode === 1 ? quickMove(window, click.slot) : original(click, gameMode));
  window.vanillaQuickMove = true;
}

function usesHashedSlots(registry) {
  try {
    const def = registry.protocol.play.toServer.types.packet_window_click;
    return JSON.stringify(def).includes('HashedSlot');
  } catch (_) {
    return false;
  }
}

function windowClicksPlugin(bot) {
  const client = bot._client;
  if (!client || typeof client.write !== 'function' || !bot.registry) return;
  const Item = require('prismarine-item')(bot.registry);

  // Номер состояния — у каждого окна свой (как AbstractContainerMenu.getStateId() в игре).
  const stateIds = new Map();
  const remember = (packet) => {
    if (packet && Number.isInteger(packet.windowId) && Number.isInteger(packet.stateId)) stateIds.set(packet.windowId, packet.stateId);
  };
  client.on('window_items', remember);
  client.on('set_slot', remember);
  client.on('open_window', (packet) => stateIds.delete(packet.windowId)); // новое окно — новый счёт
  bot.stateIdOf = (windowId) => (stateIds.has(windowId) ? stateIds.get(windowId) : null);

  // Shift-клик в сундуке — как в игре.
  if (typeof bot.on === 'function') bot.on('windowOpen', (window) => useVanillaQuickMove(window));

  // Сервер поправил курсор: верим ему (иначе следующий клик опишет несуществующий предмет).
  client.on('set_cursor_item', (packet) => {
    const window = bot.currentWindow || bot.inventory;
    if (!window) return;
    try {
      window.selectedItem = Item.fromNotch(packet.contents);
    } catch (_) {
      window.selectedItem = null;
    }
    bot.emit('cursorItem', window.selectedItem);
  });

  // Зачарования списком {name, lvl}, как их ждёт prismarine-block (у предметов с компонентами — {id, level}).
  const enchantList = (item) => {
    if (!item) return [];
    let e;
    try {
      e = item.enchants;
    } catch (_) {
      return [];
    }
    if (Array.isArray(e)) return e;
    const list = e && Array.isArray(e.enchantments) ? e.enchantments : [];
    return list.map((x) => ({ name: (bot.registry.enchantments && bot.registry.enchantments[x.id] && bot.registry.enchantments[x.id].name) || '', lvl: x.level }));
  };
  bot.enchantsOf = enchantList;
  if (typeof bot.digTime === 'function') {
    // Как digTime в mineflayer (инструмент в руке, зачарования руки и шлема, вода, земля под ногами, эффекты).
    bot.digTime = (block) => {
      const held = bot.heldItem;
      const headSlot = typeof bot.getEquipmentDestSlot === 'function' ? bot.getEquipmentDestSlot('head') : 5;
      const head = bot.inventory && bot.inventory.slots ? bot.inventory.slots[headSlot] : null;
      const creative = Boolean(bot.game && bot.game.gameMode === 'creative');
      const e = bot.entity;
      const eyeBlock = e && e.position && typeof bot.blockAt === 'function' ? bot.blockAt(e.position.offset(0, e.eyeHeight, 0)) : null;
      const inWater = Boolean(eyeBlock && ['water', 'flowing_water'].includes(eyeBlock.name));
      return block.digTime(held ? held.type : null, creative, inWater, !(e && e.onGround), [...enchantList(held), ...enchantList(head)], (e && e.effects) || {});
    };
  }

  const hashed = usesHashedSlots(bot.registry);
  let componentNames = null;
  const names = {
    enchantment: (id) => {
      const e = bot.registry.enchantments && bot.registry.enchantments[id];
      return e ? e.name : null;
    },
    component: (id) => {
      if (!componentNames) {
        try {
          componentNames = bot.registry.protocol.types.SlotComponentType[1].mappings;
        } catch (_) {
          componentNames = {};
        }
      }
      return componentNames[id] || null;
    },
  };
  const reported = new Set();
  const onUnknown = (type) => {
    if (reported.has(type)) return;
    reported.add(type);
    bot.emit('clickHashUnknown', type);
  };
  const opts = { names, onUnknown };

  const write = client.write.bind(client);
  client.write = (name, params) => {
    if (name === 'window_click' && params && typeof params === 'object') {
      params = { ...params };
      // -1 mineflayer шлёт нарочно (просит сервер прислать окно заново) — его не трогаем.
      if (params.stateId !== undefined && params.stateId !== -1 && stateIds.has(params.windowId)) {
        params.stateId = stateIds.get(params.windowId);
      }
      if (hashed) {
        params.changedSlots = (params.changedSlots || []).map((s) => ({ location: s.location, item: toHashedSlot(s.item, opts) }));
        params.cursorItem = toHashedSlot(params.cursorItem, opts);
      }
    }
    return write(name, params);
  };
}

module.exports = { windowClicksPlugin, usesHashedSlots, quickMove, useVanillaQuickMove, isStorageWindow, sameStack, maxStack };
