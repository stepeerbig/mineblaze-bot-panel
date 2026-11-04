'use strict';

// Заготовки для тестов физики и действий: подменённое время, изменяемый мир из настоящих блоков 1.21.11,
// поддельный бот с нашей физикой и «сервер», который отвечает на копание и установку блоков.
// (Сам файл тестов не содержит: node --test просто загрузит его.)

const path = require('node:path');
const EventEmitter = require('node:events');
const { Vec3 } = require('vec3');

const SRC = path.join(__dirname, '..', 'src', 'bot');
const { createPhysicsPlugin } = require(path.join(SRC, 'physics.js'));
const { createActionsPlugin } = require(path.join(SRC, 'actions.js'));
const { quickMove } = require(path.join(SRC, 'window-clicks.js'));

const VERSION = '1.21.11';
const FACE_VECTORS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      nextId += 1;
      timers.set(nextId, { fn, at: now + ms });
      return nextId;
    },
    clearTimeout: (id) => timers.delete(id),
    /** Время идёт, таймеры срабатывают точно в срок. */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next.t.at)) next = { id, t };
        if (!next) break;
        timers.delete(next.id);
        now = Math.max(now, next.t.at);
        next.t.fn();
      }
      now = end;
    },
    /** Процесс «подвис»: время прошло, а таймеры не сработали. */
    stall(ms) {
      now += ms;
    },
  };
}

/** Мир: по умолчанию камень ниже y=64 и воздух выше; отдельные клетки можно менять. */
function makeWorld(registry) {
  const Block = require('prismarine-block')(registry);
  const cells = new Map();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  const floor = (p) => new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
  const world = {
    set(pos, name) {
      cells.set(key(floor(pos)), name);
    },
    get(pos) {
      const p = floor(pos);
      return cells.get(key(p)) || (p.y < 64 ? 'stone' : 'air');
    },
    blockAt(pos) {
      const p = floor(pos);
      const info = registry.blocksByName[world.get(p)];
      const block = Block.fromStateId(info.defaultState, 0);
      block.position = p;
      return block;
    },
  };
  return world;
}

/**
 * Бот с нашей физикой (и действиями) на поддельном клиенте: всё отправленное — в bot._client.sent.
 * @param {object} [opts]
 * @param {object} [opts.clock]    fakeClock()
 * @param {object} [opts.world]    makeWorld(); по умолчанию — свой
 * @param {boolean} [opts.tickEnd]
 * @param {boolean} [opts.actions] подключить src/bot/actions.js
 * @param {number}  [opts.random]  «случайность» для поворота головы и действий (0..1, постоянная)
 */
function physicsBot({ clock, world, tickEnd = true, actions = false, random = 0.5 } = {}) {
  const registry = require('prismarine-registry')(VERSION);
  const w = world || makeWorld(registry);
  const bot = new EventEmitter();
  bot.version = VERSION;
  bot.registry = registry;
  bot.supportFeature = registry.supportFeature;
  bot.world = w;
  const client = new EventEmitter();
  client.state = 'play';
  client.sent = [];
  client.write = (name, params) => client.sent.push({ name, params });
  bot._client = client;
  bot.game = { gameMode: 'survival' };
  bot.inventory = { slots: [] };
  bot.isAlive = true;
  bot.food = 20;
  bot.entities = {};
  bot.entity = {
    id: 42, position: new Vec3(0.5, 80, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: false,
    height: 1.8, eyeHeight: 1.62, effects: {}, attributes: {}, isInWater: false, isInLava: false, isInWeb: false,
    isCollidedHorizontally: false, isCollidedVertically: false, elytraFlying: false,
  };
  bot.blockAt = (pos) => w.blockAt(pos);
  // Время копания по умолчанию — 10 тиков; для отдельных блоков можно задать своё.
  bot.digTicks = { short_grass: 1 };
  bot.digTime = (block) => (bot.digTicks[block.name] || 10) * 50;
  bot.chatted = [];
  bot.chat = (text) => bot.chatted.push(text);
  bot.heldItem = null;
  bot.quickBarSlot = 0;
  bot.setQuickBarSlot = (i) => {
    bot.quickBarSlot = i;
    bot.heldItem = bot.inventory.slots[36 + i] || null;
    client.write('held_item_slot', { slotId: i });
  };
  createPhysicsPlugin({ tickEnd, clock, random: () => random })(bot, {});
  if (actions) createActionsPlugin({ random: () => random, now: () => (clock ? clock.now() : Date.now()) })(bot);
  return bot;
}

/**
 * «Сервер» для действий: ломает блок по концу копания (или сразу, если блок ломается мгновенно), ставит блок,
 * а нажатие на сундук открывает окно (содержимое — chests[«x,y,z»] или пусто).
 * storage[«x,y,z»] = { items: [[ячейка, имя, сколько]], type?, reject? } — настоящее окно-хранилище
 * (prismarine-windows): shift-клик переносит стопку, как в игре (reject — сервер не даёт), при закрытии
 * инвентарь из окна переписывается в bot.inventory, как у mineflayer.
 */
function autoServer(bot, world, { chests = {}, storage = {}, npcs = {}, onClick = null } = {}) {
  const write = bot._client.write;
  bot.currentWindow = null;
  bot.clicks = [];
  const open = (window) => {
    bot.currentWindow = window;
    bot.emit('windowOpen', window);
  };
  bot.closeWindow = (window) => {
    if (bot.currentWindow !== window) return;
    if (window.storageSpec) {
      for (let i = 0; i < 36; i += 1) bot.inventory.slots[9 + i] = window.slots[window.inventoryStart + i] || null;
      window.storageSpec.slots = window.slots.slice(0, window.inventoryStart); // сундук помнит, что в нём
    }
    bot.currentWindow = null;
    write('close_window', { windowId: 1 });
  };
  // Клик в меню: записываем; onClick(window, slot) может вернуть новое меню (сервер его откроет).
  bot.clickWindow = async (slot, mouseButton, mode) => {
    bot.clicks.push({ window: bot.currentWindow && bot.currentWindow.id, slot, mouseButton, mode });
    write('window_click', { windowId: bot.currentWindow && bot.currentWindow.id, slot, mouseButton, mode });
    const w = bot.currentWindow;
    if (w && w.storageSpec) {
      if (mode === 1 && !w.storageSpec.reject) quickMove(w, slot);
      return;
    }
    const next = onClick ? onClick(bot.currentWindow, slot) : null;
    if (next) open(next);
  };
  const openStorage = (spec, title) => {
    const registry = bot.registry;
    const Item = require('prismarine-item')(registry);
    const make = (name, count) => new Item(registry.itemsByName[name].id, count);
    const w = require('prismarine-windows')(registry).createWindow(7, spec.type || 'minecraft:generic_9x3', title);
    w.storageSpec = spec;
    if (spec.slots) spec.slots.forEach((it, slot) => it && w.updateSlot(slot, it));
    else for (const [slot, name, count] of spec.items || []) w.updateSlot(slot, make(name, count));
    for (let i = 0; i < 36; i += 1) {
      const it = bot.inventory.slots[9 + i];
      if (it) w.updateSlot(w.inventoryStart + i, it.type !== undefined ? it : make(it.name, it.count));
    }
    open(w);
  };
  bot._client.write = (name, params) => {
    write(name, params);
    if (name === 'use_entity' && params.mouse === 0 && npcs[params.target]) {
      open(npcs[params.target]());
    } else if (name === 'block_dig') {
      const block = world.blockAt(params.location);
      if (params.status === 2 || (params.status === 0 && bot.digTime(block) <= 50)) world.set(params.location, 'air');
    } else if (name === 'block_place') {
      const loc = new Vec3(params.location.x, params.location.y, params.location.z);
      const clicked = world.get(loc);
      const spec = storage[`${loc.x},${loc.y},${loc.z}`];
      if (spec && spec.deny) {
        const text = '! К сожалению, Вы не можете открывать это в этом месте.'; // чужая территория (MineBlaze)
        bot.emit('message', { json: { text }, toString: () => text }, 'system');
      } else if (spec && /chest|barrel|shulker_box/.test(clicked)) {
        openStorage(spec, clicked);
      } else if (/chest|barrel|shulker_box/.test(clicked)) {
        const items = chests[`${loc.x},${loc.y},${loc.z}`] || [];
        bot.currentWindow = { title: clicked, containerItems: () => items.map((it) => ({ ...it })) };
        bot.emit('windowOpen', bot.currentWindow);
      } else if (bot.heldItem) {
        world.set(loc.plus(FACE_VECTORS[params.direction]), bot.heldItem.name);
      }
    }
  };
}

/** Телепорт от сервера в формате 1.21.11. */
function teleport(bot, over = {}) {
  bot._client.emit('position', {
    teleportId: 3, x: 0.5, y: 64, z: 0.5, dx: 0, dy: 0, dz: 0, yaw: 0, pitch: 0,
    flags: { x: false, y: false, z: false, yaw: false, pitch: false, dx: false, dy: false, dz: false, yawDelta: false },
    ...over,
  });
}

const names = (bot) => bot._client.sent.map((p) => p.name);
const take = (bot) => {
  const out = bot._client.sent;
  bot._client.sent = [];
  return out;
};

/** Крутить время, пока промис не выполнится (или не выйдет время). Возвращает { value } или { error }. */
async function runFor(clock, promise, maxMs = 30000) {
  let state = null;
  promise.then((value) => { state = { value }; }, (error) => { state = { error }; });
  for (let t = 0; t < maxMs && !state; t += 50) {
    clock.advance(50);
    for (let i = 0; i < 5; i += 1) await Promise.resolve(); // дать продолжиться async-функциям действий
  }
  if (!state) throw new Error(`не закончилось за ${maxMs} мс`);
  return state;
}

module.exports = { fakeClock, makeWorld, physicsBot, autoServer, teleport, names, take, runFor, FACE_VECTORS, VERSION };
