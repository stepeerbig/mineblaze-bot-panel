'use strict';

// Заготовки для тестов рыбалки: пруд в камне, бот на берегу и «сервер рыбалки» (поплавок, поклёвка, улов).
// (Сам файл тестов не содержит: node --test просто загрузит его.)

const path = require('node:path');
const { Vec3 } = require('vec3');
const { fakeClock, makeWorld, physicsBot, autoServer, teleport, take, VERSION } = require('./fake-bot');

const registry = require('prismarine-registry')(VERSION);
const Item = require('prismarine-item')(registry);
const BOBBER = registry.entitiesByName.fishing_bobber.id;
const { rodLeft } = require(path.join(__dirname, '..', 'src', 'bot', 'fishing.js'));

/** Пруд 8×8 в камне: вода x 6…13, z −4…3, глубиной 2 (y 62, 63); берег — камень на y 63, стоять — на y 64. */
function pond(world) {
  for (let x = 6; x <= 13; x += 1) for (let z = -4; z <= 3; z += 1) for (let y = 62; y <= 63; y += 1) world.set(new Vec3(x, y, z), 'water');
}

/** Бот у пруда (по умолчанию — в 0.5 64 0.5, в 5 блоках от воды); storage, onClick — как у autoServer. */
function setup({ at = { x: 0.5, y: 64, z: 0.5 }, storage = {}, username = 'Fisher', onClick = null } = {}) {
  const clock = fakeClock();
  const world = makeWorld(registry);
  pond(world);
  const bot = physicsBot({ clock, world, actions: true });
  autoServer(bot, world, { storage, onClick });
  bot.username = username;
  bot.emit('login');
  teleport(bot, at);
  clock.advance(100);
  take(bot);
  return { clock, world, bot };
}

/**
 * «Сервер рыбалки»: правая кнопка с удочкой — поплавок (свой — через тик, objectData = номер бота; перед ним —
 * чужой, от игрока 4242); через biteTicks — «клюёт» (entity_metadata, ключ 9 = true); правая кнопка ещё раз —
 * поплавок пропал, если клевало — улов (loot) в инвентарь и «подобрал», удочке — минус 1 прочности; поплавок не в
 * воде (at — на берегу) — минус 2, как в игре. В руке больше не удочка — поплавок пропал (drops), прочность та же.
 */
function fishServer(bot, { biteTicks = 30, loot = 'cod', at = new Vec3(10.5, 63.9, 0.5) } = {}) {
  const st = { casts: 0, reels: 0, drops: 0, bobber: null, biting: false, tick: 0, castTick: 0, biteTick: null, reelAfterBite: [] };
  const onShore = !/water/.test(String((bot.blockAt(at.floored()) || {}).name || ''));
  const wear = (n) => {
    const held = bot.heldItem;
    if (!n || !held || held.name !== 'fishing_rod') return;
    const c = (held.components || []).find((x) => x.type === 'damage');
    if (c) c.data += n;
    else held.components = [...(held.components || []), { type: 'damage', data: n }];
  };
  const destroy = (id) => setImmediate(() => {
    delete bot.entities[id];
    bot._client.emit('entity_destroy', { entityIds: [id] });
  });
  let nextId = 900;
  bot.on('physicsTick', () => {
    st.tick += 1;
    if (st.bobber !== null && !st.biting && st.tick - st.castTick >= biteTicks) {
      st.biting = true;
      st.biteTick = st.tick;
      bot._client.emit('entity_metadata', { entityId: st.bobber, metadata: [{ key: 9, type: 'boolean', value: true }] });
    }
  });
  const write = bot._client.write;
  bot._client.write = (name, params) => {
    write(name, params);
    // Сменил ячейку — в руке не удочка: сервер убирает поплавок сам (FishingHook.shouldStopFishing), без износа.
    if (name === 'held_item_slot' && st.bobber !== null && (!bot.heldItem || bot.heldItem.name !== 'fishing_rod')) {
      st.drops += 1;
      const id = st.bobber;
      st.bobber = null;
      st.biting = false;
      st.biteTick = null;
      destroy(id);
      return;
    }
    if (name !== 'use_item' || params.hand !== 0 || !bot.heldItem || bot.heldItem.name !== 'fishing_rod') return;
    if (st.bobber === null) {
      st.casts += 1;
      st.castTick = st.tick;
      st.biting = false;
      nextId += 2;
      const id = nextId;
      st.bobber = id;
      setImmediate(() => {
        const other = id - 1; // чужой поплавок — раньше своего и рядом
        bot.entities[other] = { id: other, name: 'fishing_bobber', type: 'projectile', position: at.offset(-1, 0, 2) };
        bot._client.emit('spawn_entity', { entityId: other, type: BOBBER, objectData: 4242, x: at.x - 1, y: at.y, z: at.z + 2 });
        bot.entities[id] = { id, name: 'fishing_bobber', type: 'projectile', position: at.clone() };
        bot._client.emit('spawn_entity', { entityId: id, type: BOBBER, objectData: bot.entity.id, x: at.x, y: at.y, z: at.z });
      });
    } else {
      st.reels += 1;
      st.reelAfterBite.push(st.biteTick === null ? null : st.tick - st.biteTick);
      const id = st.bobber;
      const caught = st.biting;
      st.bobber = null;
      st.biting = false;
      st.biteTick = null;
      // Улов — минус 1 прочности удочке, вытащить с берега — минус 2 (как в игре: FishingHook.retrieve).
      wear(onShore ? 2 : caught ? 1 : 0);
      destroy(id);
      setImmediate(() => {
        if (caught) {
          const free = bot.inventory.slots.findIndex((it, i) => i >= 9 && i < 45 && !it);
          if (free >= 0) bot.inventory.slots[free] = { name: loot, count: 1, displayName: loot };
          bot.emit('playerCollect', bot.entity, { id: 999, name: 'item' });
        }
      });
    }
  };
  return st;
}

/** Удочка с износом damage (из 64 прочности). */
function rodItem(damage = 0) {
  const it = new Item(registry.itemsByName.fishing_rod.id, 1);
  if (damage) it.components = [{ type: 'damage', data: damage }];
  return it;
}

/** Сколько прочности у удочек в сундуке-заготовке autoServer (по возрастанию). */
const rodsIn = (spec) => (spec.slots || []).filter((it) => it && it.name === 'fishing_rod').map((it) => rodLeft(it)).sort((a, b) => a - b);

/** Сообщение сервера в чат (как у MineBlaze: «| …»). */
const say = (bot, text) => bot.emit('message', { json: { text }, toString: () => text }, 'system');

/** Табло справа: показать «• Баланс • text» (подписью очка, как у 1.20.3+). Сначала — само табло. */
function sidebarBalance(bot) {
  const nbt = (text) => ({ type: 'compound', name: '', value: { text: { type: 'string', value: text } } });
  const c = bot._client;
  c.emit('scoreboard_objective', { name: 'mb', action: 0, displayText: nbt('MineBlaze') });
  c.emit('scoreboard_display_objective', { position: 1, name: 'mb' });
  return (text) => c.emit('scoreboard_score', { itemName: 'b', scoreName: 'mb', value: 4, display_name: nbt(`• Баланс • ${text}`) });
}

module.exports = { pond, setup, fishServer, rodItem, rodsIn, say, sidebarBalance, registry, BOBBER };
