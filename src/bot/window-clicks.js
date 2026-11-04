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

const { toHashedSlot } = require('./item-hash');

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

module.exports = { windowClicksPlugin, usesHashedSlots };
