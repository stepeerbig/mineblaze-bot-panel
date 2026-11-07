'use strict';

// Команды боту: строка чата панели, начинающаяся с «#», на сервер не уходит — её выполняет бот через безопасные
// действия (src/bot/actions.js). Писать можно по-русски или по-английски, координаты не обязательны:
//   #иди ко мне · #иди к Steve · #вперёд 3 · #смотри вниз · #копай · #поставь земля · #открой · #инвентарь
// Все команды описаны в одном списке (COMMANDS): имена, как писать, что делают. По нему же их сможет вызывать ИИ:
// catalog() — описание всех команд, runCommand() — выполнить и получить ответ { ok, message, data }.

const { Vec3 } = require('vec3');
const { FACE_VECTORS } = require('./actions');
const { chatToText } = require('../chat-utils');
const {
  parseQuestMenu, parseOffer, describeQuest, matchesQuery, deliverItems, parseQuestChat, sameTitle, questNpc, questRules, mobsOf, mobName,
} = require('./quests');
const { isStorageWindow } = require('./window-clicks');
const { moveStacks, countIn, itemsIn, storageSlots, playerSlots } = require('./chests');
const { sanitizeXray, scanXray, findEntries, registryOf } = require('./xray');
const { createGuard, prepareShield, cooldownFor, eatIfHungry, isFood, foodRank } = require('./survival');

const MAX_WALK = 256; // за раз дальше не ходим: путь ищется по загруженному миру, дальше — по ходу
const MAX_STEPS = 32; // «#вперёд N»: не больше
const NEAR_PLAYERS = 32; // «ко мне»: кого считаем рядом
const NEAR_CONTAINERS = 8; // «#рядом»: где искать сундуки
const OPEN_RANGE = 4; // «#открой»: до какого сундука дотянуться
const PLAYER_STOP = 1.6; // на каком расстоянии от игрока остановиться

class CommandError extends Error {}

const norm = (s) => String(s === undefined || s === null ? '' : s).trim().toLowerCase().replace(/ё/g, 'е');
const round = (n, d = 1) => Number(n).toFixed(d);
const toDeg = (rad) => (rad * 180) / Math.PI;
const toRad = (deg) => (deg * Math.PI) / 180;
const clampPitch = (p) => Math.max(-90, Math.min(90, p));
const fmtPos = (p) => `${p.x} ${p.y} ${p.z}`;
/** 1 раз, 2 раза, 5 раз. */
const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
};
const plain = (v) => ({ x: v.x, y: v.y, z: v.z });
// Углы как в F3: поворот 0 — юг, 90 — запад, 180 — север, -90 — восток; наклон вниз — плюс.
const f3Yaw = (yawRad) => ((((180 - toDeg(yawRad) + 180) % 360) + 360) % 360) - 180;
const f3Pitch = (pitchRad) => -toDeg(pitchRad);
const fromF3 = (yaw, pitch) => [toRad(180 - yaw), toRad(-pitch)];

// ---------- стороны света и направления ----------

const CARDINALS = [
  { name: 'юг', yaw: 0, dir: new Vec3(0, 0, 1) },
  { name: 'запад', yaw: 90, dir: new Vec3(-1, 0, 0) },
  { name: 'север', yaw: 180, dir: new Vec3(0, 0, -1) },
  { name: 'восток', yaw: -90, dir: new Vec3(1, 0, 0) },
];
const cardinalOf = (yaw) => CARDINALS[((Math.round(yaw / 90) % 4) + 4) % 4];
const CARDINAL_WORDS = { юг: 0, запад: 90, север: 180, восток: -90, south: 0, west: 90, north: 180, east: -90 };
// Повороты относительно того, куда бот смотрит сейчас (направо — по часовой стрелке, как в игре).
const TURN_WORDS = { вперед: 0, прямо: 0, forward: 0, назад: 180, back: 180, налево: -90, влево: -90, left: -90, направо: 90, вправо: 90, right: 90 };
const SPRINT_RE = /^(бегом|бег|sprint|run)$/;

/** Куда бот смотрит, по сторонам света (по взгляду, известному серверу). */
const facing = (bot) => cardinalOf(f3Yaw(bot.serverView.yaw));

// ---------- координаты ----------

const COORD_RE = /^(~(-?\d+([.,]\d+)?)?|-?\d+([.,]\d+)?)$/;
const isCoords = (t) => t.length >= 3 && t.slice(0, 3).every((x) => COORD_RE.test(x));
const isNumber = (t) => COORD_RE.test(String(t));

function parseCoord(token, base) {
  const t = String(token === undefined ? '' : token).trim();
  if (t.startsWith('~')) {
    const rest = t.slice(1).replace(',', '.');
    const add = rest === '' ? 0 : Number(rest);
    if (!Number.isFinite(add)) throw new CommandError(`непонятная координата «${t}»`);
    return base + add;
  }
  const v = Number(t.replace(',', '.'));
  if (t === '' || !Number.isFinite(v)) throw new CommandError(`непонятная координата «${t}»`);
  return v;
}

/** Блок по трём словам: целые координаты, «~» — от клетки, где стоит бот. */
function parseBlockPos(tokens, botPos) {
  if (tokens.length < 3) throw new CommandError('нужны три координаты: x y z');
  const base = botPos.floored();
  return new Vec3(Math.floor(parseCoord(tokens[0], base.x)), Math.floor(parseCoord(tokens[1], base.y)), Math.floor(parseCoord(tokens[2], base.z)));
}

/** Точка, куда идти: целые координаты — центр блока, как в игре. */
function parseWalkPoint(tokens, botPos) {
  const p = new Vec3(parseCoord(tokens[0], botPos.x), parseCoord(tokens[1], botPos.y), parseCoord(tokens[2], botPos.z));
  if (/^-?\d+$/.test(tokens[0])) p.x += 0.5;
  if (/^-?\d+$/.test(tokens[2])) p.z += 0.5;
  return p;
}

/** Клетка рядом с ботом по слову: впереди (на уровне ног), под (под ногами), над (над головой). */
function relativeBlock(bot, word) {
  const feet = bot.entity.position.floored();
  const w = norm(word);
  if (w === 'впереди' || w === 'вперед' || w === 'front') return feet.plus(facing(bot).dir);
  if (w === 'под' || w === 'снизу' || w === 'вниз' || w === 'below' || w === 'down') return feet.offset(0, -1, 0);
  if (w === 'над' || w === 'сверху' || w === 'вверх' || w === 'above' || w === 'up') return feet.offset(0, 2, 0);
  return null;
}

// ---------- игроки ----------

function otherPlayers(bot) {
  return Object.values(bot.entities || {}).filter((e) => e && e.type === 'player' && e !== bot.entity && e.username && e.position);
}

function playersNear(bot, radius) {
  const me = bot.entity.position;
  return otherPlayers(bot)
    .map((e) => ({ entity: e, dist: e.position.distanceTo(me) }))
    .filter((p) => p.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
}

function findPlayer(bot, nick) {
  const n = norm(nick);
  const e = otherPlayers(bot).find((x) => norm(x.username) === n);
  if (e) return e;
  const known = bot.players && Object.keys(bot.players).find((k) => norm(k) === n);
  if (known) throw new CommandError(`${known} далеко — бот его не видит`);
  throw new CommandError(`игрока ${nick} нет рядом и на сервере`);
}

/** «Ко мне»: единственный игрок рядом. Если рядом несколько — нужно назвать ник. */
function resolveMe(bot) {
  const near = playersNear(bot, NEAR_PLAYERS);
  if (!near.length) throw new CommandError(`рядом никого нет (в пределах ${NEAR_PLAYERS} блоков) — укажи ник: #иди к <ник>`);
  if (near.length > 1) {
    const list = near.slice(0, 5).map((p) => `${p.entity.username} (${Math.round(p.dist)} бл.)`).join(', ');
    throw new CommandError(`рядом несколько игроков: ${list} — скажи, к кому: #иди к ${near[0].entity.username}`);
  }
  return near[0].entity;
}

// ---------- сущности (NPC, мобы, надписи) и меню ----------

/** Текст из чего угодно похожего на сообщение чата (JSON, NBT, ChatMessage) — без §-кодов. */
function textOf(value) {
  if (value === undefined || value === null) return '';
  try {
    const raw = typeof value === 'object' && typeof value.toString === 'function' && value.json !== undefined ? value.toString() : chatToText(value);
    return String(raw || '').replace(/§[0-9a-fk-orx#]/gi, '').replace(/\s+/g, ' ').trim();
  } catch (_) {
    return '';
  }
}

// Надписи и «подставки», а не сами NPC.
const DISPLAY_TYPES = new Set(['text_display', 'item_display', 'block_display', 'armor_stand', 'marker', 'area_effect_cloud', 'item']);

/** Как сущность называется в игре: ник игрока, имя над головой или текст надписи. */
function entityLabel(e) {
  if (e.type === 'player' && e.username) return e.username;
  let name = '';
  try {
    const custom = typeof e.getCustomName === 'function' ? e.getCustomName() : null;
    if (custom) name = textOf(custom);
  } catch (_) {
    /* у сущности нет имени */
  }
  if (!name && DISPLAY_TYPES.has(e.name) && Array.isArray(e.metadata)) {
    // Текст надписи (text_display) лежит среди её данных — берём самый длинный текст.
    for (const v of e.metadata) {
      const isText = (typeof v === 'string' && /^[{["]/.test(v)) || (v && typeof v === 'object' && !Array.isArray(v) && ('text' in v || 'translate' in v || 'extra' in v || v.type === 'compound' || v.type === 'string'));
      if (!isText) continue;
      const t = textOf(v);
      if (t && t.length > name.length && !/^[\d.\s-]+$/.test(t)) name = t;
    }
  }
  return name;
}

// NPC на серверах — это «игроки» со служебным ником (#1479d9c455b1f85); их имя — в надписи над головой.
const REAL_NICK = /^[A-Za-z0-9_]{3,16}$/;
const GENERIC_SIGN = /^(?:квест\s*npc|npc|нпс|нажмите.*|кликни.*|пкм.*|click.*)$/i;

function entitiesNear(bot, radius) {
  const me = bot.entity.position;
  const list = Object.values(bot.entities || {})
    .filter((e) => e && e !== bot.entity && e.position && e.position.distanceTo(me) <= radius)
    .map((e) => ({ entity: e, dist: e.position.distanceTo(me), label: entityLabel(e) }))
    .sort((a, b) => a.dist - b.dist);
  for (const x of list) {
    const e = x.entity;
    if (e.type !== 'player' || REAL_NICK.test(e.username || '')) continue;
    const p = e.position;
    const sign = list.find((s) =>
      s.label && DISPLAY_TYPES.has(s.entity.name) && !GENERIC_SIGN.test(s.label.trim()) &&
      Math.hypot(s.entity.position.x - p.x, s.entity.position.z - p.z) < 1.2 &&
      s.entity.position.y > p.y + 0.5 && s.entity.position.y < p.y + 4.5);
    if (sign) {
      x.label = sign.label;
      x.npc = true;
    }
  }
  return list;
}

/**
 * Сущность по имени: «@123» — по номеру из #сущности; иначе — по имени (ник, имя над головой) или по надписи
 * над NPC (тогда берётся сущность прямо под надписью).
 */
function findEntity(bot, query) {
  const q = norm(query);
  const all = entitiesNear(bot, 24);
  if (/^@\d+$/.test(q)) {
    const e = bot.entities && bot.entities[Number(q.slice(1))];
    if (!e) throw new CommandError(`сущности ${query} рядом нет — номера показывает #сущности`);
    return e;
  }
  const named = all.filter((x) => x.label && norm(x.label).includes(q));
  const direct = named.find((x) => !DISPLAY_TYPES.has(x.entity.name));
  if (direct) return direct.entity;
  for (const sign of named) {
    const p = sign.entity.position;
    const under = all
      .filter((x) => !DISPLAY_TYPES.has(x.entity.name) && x.entity.type !== 'object')
      .map((x) => ({ x, d: Math.hypot(x.entity.position.x - p.x, x.entity.position.z - p.z) }))
      .filter(({ x, d }) => d < 1.2 && x.entity.position.y <= p.y + 0.5 && x.entity.position.y >= p.y - 4)
      .sort((a, b) => a.d - b.d)[0];
    if (under) return under.x.entity;
  }
  throw new CommandError(`рядом нет «${query}» — посмотри, кто есть: #сущности`);
}

const itemTitle = (it) => textOf(it.customName) || it.displayName || it.name;
const itemLore = (it) => (Array.isArray(it.customLore) ? it.customLore : it.customLore ? [it.customLore] : []).map(textOf).filter(Boolean);
const windowTitle = (w) => textOf(w.title) || w.type || 'меню';

/** Сообщения сервера (не игроков) с этого момента: lines — все, take() — новые с прошлого раза, stop() — хватит. */
function watchChat(bot) {
  const lines = [];
  let read = 0;
  const on = (msg, position) => {
    if (position === 'chat' || position === 'game_info') return; // игроки и надпись над хотбаром — не ответы сервера
    const text = textOf(msg);
    if (text) lines.push(text);
  };
  if (typeof bot.on === 'function') bot.on('message', on);
  return {
    lines,
    take: () => lines.slice(read, (read = lines.length)),
    stop: () => {
      if (typeof bot.removeListener === 'function') bot.removeListener('message', on);
    },
  };
}

/** Ждать (по умолчанию до секунды), пока не откроется новое меню (не то, что было). */
async function waitNewWindow(bot, before, ms = 1000) {
  for (let i = 0; i < ms / 50 && (!bot.currentWindow || bot.currentWindow === before); i += 1) await bot.actions.wait(50);
  return bot.currentWindow && bot.currentWindow !== before ? bot.currentWindow : null;
}

function directionTo(bot, pos) {
  const d = pos.minus(bot.entity.position);
  return cardinalOf(f3Yaw(Math.atan2(-d.x, -d.z))).name;
}

// ---------- предметы ----------

// Русские названия частых предметов: слово → точные имена или шаблон имени.
const ITEM_WORDS = [
  [/^земл/, ['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt']],
  [/^дерн/, ['grass_block']],
  [/^булыжн/, ['cobblestone', 'cobbled_deepslate']],
  [/^(камен|камн)/, ['stone', 'cobblestone', 'deepslate']],
  [/^досок|^доск/, /_planks$/],
  [/^бревн/, /_log$/],
  [/^стекл/, ['glass']],
  [/^песо?к/, ['sand', 'red_sand']],
  [/^грави/, ['gravel']],
  [/^обсидиан/, ['obsidian']],
  [/^шерст/, /_wool$/],
  [/^кирк/, /_pickaxe$/],
  [/^топор/, /_axe$/],
  [/^лопат/, /_shovel$/],
  [/^меч/, /_sword$/],
  [/^мотыг/, /_hoe$/],
  [/^факел/, ['torch']],
  [/^сундук/, ['chest']],
  [/^верстак/, ['crafting_table']],
  [/^печ/, ['furnace']],
  [/^ведр/, /bucket$/],
  [/^хлеб/, ['bread']],
  [/^(тнт|динамит)/, ['tnt']],
  [/^лестниц/, ['ladder']],
  [/^(ступен|ступеньк)/, /_stairs$/],
  [/^плит/, /_slab$/],
];
const TOOL_TIERS = ['netherite', 'diamond', 'iron', 'golden', 'stone', 'wooden'];
const tierOf = (name) => {
  const i = TOOL_TIERS.findIndex((t) => name.startsWith(`${t}_`));
  return i < 0 ? TOOL_TIERS.length : i;
};

function inventoryItems(bot) {
  const inv = bot.inventory;
  if (!inv) return [];
  if (typeof inv.items === 'function') return inv.items();
  return (inv.slots || []).slice(9, 45).filter(Boolean);
}

function inventorySummary(items, limit = 12) {
  const counts = new Map();
  for (const it of items) counts.set(it.name, (counts.get(it.name) || 0) + (it.count || 1));
  const list = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const text = list.slice(0, limit).map(([n, c]) => `${n}×${c}`).join(', ');
  return { list, text: list.length > limit ? `${text} и ещё ${list.length - limit}` : text };
}

/** Предмет из инвентаря по имени: точное имя (cobblestone), по-русски (земля, кирка) или часть имени (planks). */
function findItem(bot, query) {
  const q = norm(query).replace(/^minecraft:/, '').replace(/\s+/g, '_');
  const items = inventoryItems(bot);
  const best = (list) => list.sort((a, b) => tierOf(a.name) - tierOf(b.name) || (b.count || 1) - (a.count || 1))[0];
  let found = items.find((it) => it.name === q);
  if (!found) {
    // По любому слову: «дубовые доски» — по «доски».
    const parts = q.split('_');
    const word = ITEM_WORDS.find(([re]) => parts.some((part) => re.test(part)));
    if (word) {
      const m = word[1];
      found = best(items.filter((it) => (Array.isArray(m) ? m.includes(it.name) : m.test(it.name))));
    }
  }
  if (!found) found = items.find((it) => norm(it.displayName).replace(/\s+/g, '_') === q);
  if (!found && q.length >= 3) found = best(items.filter((it) => it.name.includes(q)));
  if (found) return found;
  const inv = inventorySummary(items).text;
  throw new CommandError(`у бота нет «${query}». ${inv ? `В инвентаре: ${inv}` : 'Инвентарь пуст'}`);
}

// ---------- сундуки ----------

const isContainer = (name) => /^(chest|trapped_chest|barrel|ender_chest)$|shulker_box$/.test(name || '');

/**
 * Блоки вокруг бота (куб radius), подходящие под match, — от ближнего к дальнему. В настоящем боте — быстрым
 * поиском mineflayer по палитрам чанков (перебор тысяч блоков по одному подвешивал тик на ~0,1 с).
 */
function scanBlocks(bot, radius, match) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  if (typeof bot.findBlocks === 'function' && bot.registry) {
    const ids = bot.registry.blocksArray.filter((b) => match(b)).map((b) => b.id);
    if (!ids.length) return [];
    return bot
      .findBlocks({ matching: ids, maxDistance: radius, count: 64 })
      .map((pos) => ({ block: bot.blockAt(pos), pos, dist: eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) }))
      .filter((x) => x.block)
      .sort((a, b) => a.dist - b.dist);
  }
  const c = bot.entity.position.floored();
  const found = [];
  for (let x = -radius; x <= radius; x += 1) {
    for (let y = -radius; y <= radius; y += 1) {
      for (let z = -radius; z <= radius; z += 1) {
        const pos = c.offset(x, y, z);
        const block = bot.blockAt(pos);
        if (block && match(block)) found.push({ block, pos, dist: eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) });
      }
    }
  }
  return found.sort((a, b) => a.dist - b.dist);
}

/** После нажатия: если открылось окно (сундук), показать содержимое и закрыть, как человек. */
async function closeAfterLook(bot) {
  // Сервер открывает окно не мгновенно: ждём до секунды (по тикам бота).
  for (let i = 0; i < 20 && !bot.currentWindow; i += 1) await bot.actions.wait(50);
  const window = bot.currentWindow;
  if (!window) return null;
  const items = typeof window.containerItems === 'function' ? window.containerItems() : [];
  const summary = inventorySummary(items, 8);
  try {
    await bot.actions.wait(700 + Math.random() * 700); // «посмотреть» и закрыть
  } finally {
    // Закрываем, даже если ожидание прервали: открытым сундук не оставляем.
    if (bot.currentWindow === window && typeof bot.closeWindow === 'function') bot.closeWindow(window);
  }
  return { title: window.title ? String(window.title) : '', items: summary.list.map(([name, count]) => ({ name, count })), text: summary.text };
}

// ---------- команды ----------

async function cmdHelp() {
  return { ok: true, message: ['Команды боту (пишутся здесь, на сервер не уходят):', ...COMMANDS.map((c) => `${c.usage[0]} — ${c.about}`)], data: catalog() };
}

async function cmdWhere({ bot }) {
  const p = bot.entity.position;
  const v = bot.serverView;
  const yaw = f3Yaw(v.yaw);
  const pitch = f3Pitch(v.pitch);
  const hit = bot.actions.lookedAtBlock();
  const health = bot.health === undefined ? null : Math.round(bot.health);
  const lines = [
    `Бот: ${round(p.x)} ${round(p.y)} ${round(p.z)}, смотрит на ${cardinalOf(yaw).name} (${round(yaw)} / ${round(pitch)})` +
      `${health === null ? '' : `, здоровье ${health}, сытость ${bot.food}`}`,
  ];
  if (hit) lines.push(`Видит блок ${hit.block.name} в ${fmtPos(hit.position)}`);
  if (bot.actions.current) lines.push(`Сейчас: ${bot.actions.current}`);
  return {
    ok: true,
    message: lines,
    data: {
      position: plain(p), yaw, pitch, facing: cardinalOf(yaw).name, health, food: bot.food === undefined ? null : bot.food,
      lookingAt: hit ? { block: hit.block.name, position: plain(hit.position) } : null, busy: bot.actions.current,
    },
  };
}

async function cmdLook({ bot, args, words }) {
  const a = bot.actions;
  const v = bot.serverView;
  if (!args.length) throw new CommandError('куда смотреть? Например: #смотри вниз, #смотри на Steve, #смотри 90 0');
  const skip = words[0] === 'на' ? 1 : 0;
  const raw = args.slice(skip);
  const w = words.slice(skip);
  let what;
  if (isCoords(raw)) {
    const pos = parseBlockPos(raw, bot.entity.position);
    await a.lookAt(pos.offset(0.5, 0.5, 0.5));
    what = `на блок ${fmtPos(pos)}`;
  } else if (raw.length >= 2 && isNumber(raw[0]) && isNumber(raw[1])) {
    const yaw = parseCoord(raw[0], f3Yaw(v.yaw));
    const pitch = clampPitch(parseCoord(raw[1], f3Pitch(v.pitch)));
    await a.look(...fromF3(yaw, pitch));
    what = 'в заданную сторону';
  } else if (w[0] === 'вниз' || w[0] === 'down') {
    await a.look(...fromF3(f3Yaw(v.yaw), 90));
    what = 'вниз';
  } else if (w[0] === 'вверх' || w[0] === 'up') {
    await a.look(...fromF3(f3Yaw(v.yaw), -90));
    what = 'вверх';
  } else if (w[0] in TURN_WORDS) {
    // Относительно нынешнего взгляда, как поворачивается человек; «прямо» — голова ровно, в ту же сторону.
    await a.look(...fromF3(f3Yaw(v.yaw) + TURN_WORDS[w[0]], 0));
    what = TURN_WORDS[w[0]] === 0 ? 'прямо' : w[0];
  } else if (w[0] in CARDINAL_WORDS) {
    await a.look(...fromF3(CARDINAL_WORDS[w[0]], 0));
    what = `на ${cardinalOf(CARDINAL_WORDS[w[0]]).name}`;
  } else {
    const e = findPlayer(bot, raw[0]);
    await a.lookAt(e.position.offset(0, (e.height || 1.8) * 0.9, 0));
    what = `на ${e.username}`;
  }
  const now = { yaw: f3Yaw(v.yaw), pitch: f3Pitch(v.pitch) };
  return { ok: true, message: `Смотрит ${what}: ${round(now.yaw)} / ${round(now.pitch)}`, data: now };
}

/**
 * Дойти, обходя препятствия (поиск пути). Без своей навигации (старые подделки в тестах) — по прямой.
 * Пути нет — понятная ошибка (код no_path).
 */
async function navigate(bot, target, { range = 0.6, sprint = false, vertical = 2 } = {}) {
  if (typeof bot.actions.goTo !== 'function') return bot.actions.walkTo(target, { range, sprint });
  return bot.actions.goTo(target, { range, sprint, vertical });
}

async function goToPoint(bot, target, sprint) {
  const dist = bot.entity.position.distanceTo(target);
  if (dist > MAX_WALK) throw new CommandError(`слишком далеко (${Math.round(dist)} блоков): за раз — не больше ${MAX_WALK}`);
  await navigate(bot, target, { range: 0.6, sprint, vertical: 1 });
  const p = bot.entity.position;
  return { ok: true, message: `Дошёл до ${round(p.x)} ${round(p.y)} ${round(p.z)}`, data: { position: plain(p) } };
}

async function goToPlayer(bot, e, sprint) {
  const dist = bot.entity.position.distanceTo(e.position);
  if (dist > MAX_WALK) throw new CommandError(`${e.username} слишком далеко (${Math.round(dist)} блоков)`);
  await navigate(bot, e.position.clone(), { range: PLAYER_STOP, sprint });
  if (bot.entities && bot.entities[e.id]) await bot.actions.lookAt(e.position.offset(0, (e.height || 1.8) * 0.9, 0)); // и посмотреть на него
  return { ok: true, message: `Подошёл к ${e.username}`, data: { player: e.username, position: plain(bot.entity.position) } };
}

async function goToEntity(bot, e, sprint, query) {
  const label = entityLabel(e) || query || e.name;
  const dist = bot.entity.position.distanceTo(e.position);
  if (dist > MAX_WALK) throw new CommandError(`${label} слишком далеко (${Math.round(dist)} блоков)`);
  await navigate(bot, e.position.clone(), { range: 2, sprint }); // на расстояние вытянутой руки
  return { ok: true, message: `Подошёл к ${label}`, data: { entity: label, id: e.id, position: plain(bot.entity.position) } };
}

async function walkDirection(bot, turn, tokens, sprint) {
  const n = tokens.find((t) => /^\d+$/.test(t));
  const steps = n === undefined ? 1 : Math.min(MAX_STEPS, Math.max(1, parseInt(n, 10)));
  const side = cardinalOf(facing(bot).yaw + turn);
  const start = bot.entity.position.floored().offset(0.5, 0, 0.5);
  const target = start.plus(side.dir.scaled(steps));
  await bot.actions.walkTo(target, { sprint });
  return { ok: true, message: `Прошёл ${steps} бл. на ${side.name}`, data: { steps, direction: side.name, position: plain(bot.entity.position) } };
}

async function cmdGo({ bot, args, words }) {
  const sprint = words.some((w) => SPRINT_RE.test(w));
  const rest = args.filter((_, i) => !SPRINT_RE.test(words[i]));
  const rw = rest.map(norm);
  if (!rest.length) throw new CommandError('куда идти? Например: #иди ко мне, #иди к Steve, #вперёд 3, #иди X Y Z');
  if ((rw[0] === 'ко' && rw[1] === 'мне') || rw[0] === 'сюда') return goToPlayer(bot, resolveMe(bot), sprint);
  if (rw[0] === 'к' && rest[1]) {
    // Игрок по нику, а если такого нет — NPC по имени («#иди к Фермер»).
    const target = rest.slice(1).join(' ');
    const player = otherPlayers(bot).find((x) => norm(x.username) === norm(target));
    if (player) return goToPlayer(bot, player, sprint);
    let entity = null;
    try {
      entity = findEntity(bot, target);
    } catch (_) {
      /* такой сущности рядом нет — тогда это ник игрока */
    }
    if (entity) return goToEntity(bot, entity, sprint, target);
    return goToPlayer(bot, findPlayer(bot, target), sprint);
  }
  if (rw[0] in TURN_WORDS) return walkDirection(bot, TURN_WORDS[rw[0]], rest.slice(1), sprint);
  if (isCoords(rest)) return goToPoint(bot, parseWalkPoint(rest, bot.entity.position), sprint);
  if (/^[a-z0-9_]{3,16}$/i.test(rest[0])) return goToPlayer(bot, findPlayer(bot, rest[0]), sprint);
  throw new CommandError(`не понял, куда идти: «${rest.join(' ')}». Например: #иди ко мне, #иди к Steve, #иди X Y Z`);
}

const walkCommand = (turn) => async ({ bot, args, words }) => walkDirection(bot, turn, args, words.some((w) => SPRINT_RE.test(w)));

/** Блок, на который смотрит бот, или ошибка с подсказкой. */
function lookedAtOrThrow(bot) {
  const hit = bot.actions.lookedAtBlock();
  if (!hit) throw new CommandError('бот не видит блока рядом — сначала поверни его (#смотри вниз) или укажи X Y Z');
  return hit;
}

async function cmdDig({ bot, args, words }) {
  let pos;
  if (isCoords(args)) pos = parseBlockPos(args, bot.entity.position);
  else if (words.length) {
    pos = relativeBlock(bot, words[0]);
    if (!pos) throw new CommandError(`не понял, что копать: «${args.join(' ')}». Например: #копай, #копай впереди, #копай под, #копай X Y Z`);
  } else pos = lookedAtOrThrow(bot).position;
  const block = bot.blockAt(pos);
  const name = block ? block.name : 'блок';
  const r = await bot.actions.dig(pos);
  return { ok: true, message: `Сломал ${name} в ${fmtPos(pos)} (${r.ticks} тиков)`, data: { block: name, position: plain(pos), ticks: r.ticks } };
}

async function cmdPlace({ bot, args, words }) {
  let pos;
  let itemTokens;
  if (isCoords(args)) {
    pos = parseBlockPos(args, bot.entity.position);
    itemTokens = args.slice(3);
  } else if (words.length && relativeBlock(bot, words[0])) {
    if (relativeBlock(bot, words[0]).y < bot.entity.position.floored().y) throw new CommandError('ставить блок себе под ноги пока не умею');
    pos = relativeBlock(bot, words[0]);
    itemTokens = args.slice(1);
  } else {
    const hit = lookedAtOrThrow(bot);
    pos = hit.position.plus(FACE_VECTORS[hit.face]); // клетка перед гранью, на которую смотрит бот
    itemTokens = args;
  }
  const item = itemTokens.length ? findItem(bot, itemTokens.join(' ')).name : undefined;
  const r = await bot.actions.place(pos, { item });
  const placed = bot.blockAt(pos);
  const name = placed ? placed.name : item || 'блок';
  return { ok: true, message: `Поставил ${name} в ${fmtPos(pos)}`, data: { block: name, position: plain(pos), against: plain(r.against) } };
}

async function useBlock(bot, pos) {
  const block = bot.blockAt(pos);
  await bot.actions.activate(pos);
  const opened = await closeAfterLook(bot);
  const name = block ? block.name : 'блок';
  if (!opened) return { ok: true, message: `Нажал на ${name} в ${fmtPos(pos)}`, data: { block: name, position: plain(pos), opened: null } };
  return {
    ok: true,
    message: `Открыл ${name} в ${fmtPos(pos)}: ${opened.text || 'пусто'} — и закрыл`,
    data: { block: name, position: plain(pos), opened },
  };
}

/** Нажать на NPC (сущность) по имени; меню, если открылось, остаётся открытым — дальше #окно и #клик. */
async function useEntity(bot, query) {
  const e = findEntity(bot, query);
  const label = entityLabel(e) || query; // имя может быть только в надписи над NPC
  const before = bot.currentWindow;
  await bot.actions.interact(e);
  const w = await waitNewWindow(bot, before);
  if (!w) return { ok: true, message: `Нажал на ${label} (меню не открылось)`, data: { entity: label, id: e.id, window: null } };
  return {
    ok: true,
    message: `Нажал на ${label}: открылось меню «${windowTitle(w)}» — #окно покажет, что в нём`,
    data: { entity: label, id: e.id, window: windowTitle(w) },
  };
}

async function cmdUse({ bot, args }) {
  if (isCoords(args)) return useBlock(bot, parseBlockPos(args, bot.entity.position));
  if (args.length) return useEntity(bot, args.join(' '));
  return useBlock(bot, lookedAtOrThrow(bot).position);
}

async function cmdEntities({ bot }) {
  const list = entitiesNear(bot, 10).slice(0, 20);
  if (!list.length) return { ok: true, message: 'Рядом (до 10 блоков) никого и ничего нет', data: { entities: [] } };
  return {
    ok: true,
    message: ['Рядом (номер, вид, имя, расстояние):', ...list.map((x) => `@${x.entity.id} ${x.npc ? 'NPC' : x.entity.name || x.entity.type}${x.label ? ` «${x.label}»` : ''} — ${round(x.dist)} бл.`)],
    data: {
      entities: list.map((x) => ({
        id: x.entity.id,
        type: x.npc ? 'npc' : x.entity.name || x.entity.type,
        name: x.label || null,
        distance: Math.round(x.dist * 10) / 10,
        position: plain(x.entity.position),
      })),
    },
  };
}

async function cmdWindow({ bot }) {
  const w = bot.currentWindow;
  if (!w) throw new CommandError('меню не открыто — сначала нажми на NPC или сундук: #нажми Фермер');
  const end = Number.isInteger(w.inventoryStart) ? w.inventoryStart : w.slots.length;
  const slots = [];
  for (let i = 0; i < end; i += 1) {
    const it = w.slots[i];
    if (it) slots.push({ slot: i, item: it.name, count: it.count || 1, name: itemTitle(it), lore: itemLore(it) });
  }
  const title = windowTitle(w);
  return {
    ok: true,
    message: [`Меню «${title}»: предметов ${slots.length}`, ...slots.map((s) => `[${s.slot}] ${s.name}${s.count > 1 ? ` ×${s.count}` : ''} (${s.item})${s.lore.length ? ` — ${s.lore.join(' / ')}` : ''}`)],
    data: { title, slots },
  };
}

async function cmdClick({ bot, args, words }) {
  const n = parseInt(args[0], 10);
  if (!Number.isInteger(n)) throw new CommandError('по какой ячейке? Номер — из #окно, например: #клик 13');
  const before = bot.currentWindow;
  if (!before) throw new CommandError('меню не открыто — сначала нажми на NPC: #нажми Фермер');
  const item = before.slots[n];
  await bot.actions.clickSlot(n, { button: words.some((w) => w === 'правой' || w === 'right') ? 1 : 0 });
  const next = await waitNewWindow(bot, before);
  let after = 'меню закрылось';
  if (next) after = `открылось меню «${windowTitle(next)}» — #окно покажет, что в нём`;
  else if (bot.currentWindow === before) after = 'меню то же';
  return {
    ok: true,
    message: `Клик по [${n}] ${item ? itemTitle(item) : 'пустой ячейке'}: ${after}`,
    data: { slot: n, item: item ? itemTitle(item) : null, window: bot.currentWindow ? windowTitle(bot.currentWindow) : null },
  };
}

async function cmdClose({ bot }) {
  const r = await bot.actions.closeMenu();
  return { ok: true, message: r.closed ? 'Меню закрыто' : 'Меню и так не открыто', data: r };
}

// ---------- задания и покупки у NPC (Фермер, Алхимик, Оружейник — /warp ah) ----------

const QUEST_NPC = 'Фермер';
const NPC_REACH = 2.5; // ближе — можно нажимать (дотянуться можно на 2,9 от глаз)
const MENU_WAIT_MS = 2000; // меню NPC сервер присылает не сразу
const AFTER_CLICK_MS = 400; // после клика сервер пересобирает меню несколькими пакетами
const MAX_BUY = 20;

/** Ячейки меню (без инвентаря игрока) в виде для разбора: { slot, title, lore, icon, count }. */
function menuSlots(w) {
  const end = Number.isInteger(w.inventoryStart) ? w.inventoryStart : w.slots.length;
  const out = [];
  for (let i = 0; i < end; i += 1) {
    const it = w.slots[i];
    if (it) out.push({ slot: i, title: itemTitle(it), lore: itemLore(it), icon: it.name, count: it.count || 1 });
  }
  return out;
}

const findButton = (w, re) => {
  const s = menuSlots(w).find((x) => re.test(x.title));
  return s ? s.slot : null;
};

/** Сколько у бота предметов из списка (пока открыто меню — по его части с инвентарём игрока). */
function countItems(bot, ids) {
  const w = bot.currentWindow;
  const slots = w && Number.isInteger(w.inventoryStart) ? w.slots.slice(w.inventoryStart) : bot.inventory ? bot.inventory.slots : [];
  return slots.filter((it) => it && ids.includes(it.name)).reduce((n, it) => n + (it.count || 1), 0);
}

/** Открыть меню NPC: подойти, если далеко, и нажать. Уже открытое меню этого NPC — оставить. */
async function openNpcMenu(bot, npc) {
  const cur = bot.currentWindow;
  if (cur && norm(windowTitle(cur)).includes(norm(npc))) return cur;
  if (cur) await bot.actions.closeMenu();
  let e;
  try {
    e = findEntity(bot, npc);
  } catch (err) {
    // NPC не видно — они стоят у /warp ah: туда бот телепортируется сам (как в «#квесты принести»).
    if (typeof bot.sendCommand !== 'function') {
      throw new CommandError(`рядом нет «${npc}» — сначала /warp ah (NPC стоят там), потом #сущности покажет, кто есть`);
    }
    await ensureNpc(bot, npc);
    e = findEntity(bot, npc);
  }
  if (bot.entity.position.distanceTo(e.position) > NPC_REACH) {
    try {
      await goToEntity(bot, e, false, npc);
    } catch (err) {
      // NPC часто стоят за прилавком: вплотную не подойти («застрял», «пути нет»), но дотянуться можно — нажать
      // всё равно попробуем. Прерывания (#стоп, новое действие, телепорт) — не про это: их пробрасываем.
      if (!err || !['stuck', 'no_path', 'timeout'].includes(err.code)) throw err;
    }
  }
  const before = bot.currentWindow;
  await bot.actions.interact(e);
  const w = await waitNewWindow(bot, before, MENU_WAIT_MS);
  if (!w) throw new CommandError(`${npc} не открыл меню`);
  return w;
}

/** Открыть меню NPC и перейти в нужный раздел (кнопка по названию), если его ячеек ещё не видно. */
async function openNpcSection(bot, npc, isSection, buttonRe, what) {
  const w = await openNpcMenu(bot, npc);
  if (isSection(w)) return w;
  const btn = findButton(w, buttonRe);
  if (btn === null) throw new CommandError(`в меню «${windowTitle(w)}» нет кнопки «${what}»`);
  const chat = watchChat(bot);
  let next = null;
  try {
    await bot.actions.clickSlot(btn);
    next = await waitNewWindow(bot, w, MENU_WAIT_MS);
  } finally {
    chat.stop();
  }
  if (next && isSection(next)) return next;
  // Вместо меню — ответ в чате: у NPC пройдены все уровни (Фермер 4-го уровня, скриншот 5 ноября).
  const said = chat.lines.map(parseQuestChat).filter((x) => x && (x.type === 'finished' || x.type === 'nochain'));
  if (said.length) {
    const finished = said.some((x) => x.type === 'finished');
    const level = /уровень\s*(\d+)/i.exec(windowTitle(w));
    const err = new CommandError(finished
      ? `${npc}: ${level ? `${level[1]}-й уровень, ` : ''}все задания пройдены — больше заданий нет`
      : `${npc}: заданий нет (сервер: «${said[0].text}»)`);
    err.code = finished ? 'finished' : 'no_quests';
    throw err;
  }
  const server = serverSaid(chat.lines);
  throw new CommandError(`раздел «${what}» не открылся${next ? ` (открылось «${windowTitle(next)}»)` : ''}${server ? ` (сервер: «${server}»)` : ''}`);
}

/** Имя NPC из слов команды: «у Алхимика», «оружейнику» → «Алхимик», «Оружейник»; другое — как написали. */
function npcName(text) {
  const t = String(text || '').trim().replace(/^у(?:\s+|$)/i, '');
  if (!t) return QUEST_NPC;
  return questNpc(t) || t;
}

// Меню заданий: в нём задания, кнопка уровня или заголовок «Фермер › Уровень 1 → 2» (когда всё выполнено,
// заданий в нём может и не остаться).
const hasQuests = (w) => {
  const m = parseQuestMenu(menuSlots(w));
  return m.quests.length > 0 || Boolean(m.level) || /уровень\s*\d+\s*(?:→|->)/i.test(windowTitle(w));
};
const hasOffers = (w) => menuSlots(w).some((s) => parseOffer(s));
const openQuests = (bot, npc) => openNpcSection(bot, npc, hasQuests, /улучшени|задани|квест/i, 'Улучшения');
const openShop = (bot, npc) => openNpcSection(bot, npc, hasOffers, /покупк|купить|магазин/i, 'Покупка');
/** Задания из открытого меню. Заодно запоминаем «Убейте…» — для #бей без слов. */
function readQuests(bot) {
  if (!bot.currentWindow) return { quests: [], level: null };
  const menu = parseQuestMenu(menuSlots(bot.currentWindow));
  rememberKillGoals(bot, windowTitle(bot.currentWindow), menu.quests);
  return menu;
}

/** Кликнуть по ячейке меню и дождаться, пока сервер пересоберёт меню. */
async function clickAndSettle(bot, slot) {
  await bot.actions.clickSlot(slot);
  await bot.actions.wait(AFTER_CLICK_MS);
  if (!bot.currentWindow) throw new CommandError('меню закрылось');
}

const quote = (q) => `«${q.title}»`;

/** «#квесты [взять|сдать|уровень] [у NPC]», «#квесты принести <дом склада> [<дом наград>] [у NPC]» — разобрать слова. */
function questArgs(args, words) {
  const ACTIONS = {
    взять: 'take', возьми: 'take', прими: 'take', принять: 'take', take: 'take',
    сдать: 'give', сдай: 'give', отдать: 'give', отдай: 'give', give: 'give', deliver: 'give',
    принести: 'bring', принеси: 'bring', bring: 'bring',
    уровень: 'level', повысить: 'level', повысь: 'level', улучшить: 'level', улучши: 'level', level: 'level', up: 'level',
    купить: 'buy', купи: 'buy', закупить: 'buy', закупи: 'buy', buy: 'buy',
  };
  let action = 'show';
  const rest = [];
  args.forEach((a, i) => {
    const act = ACTIONS[words[i]];
    if (act && (action === 'show' || act === action)) action = act; // «повысить уровень» — одно действие
    else rest.push(a);
  });
  if (action === 'bring') {
    const at = rest.findIndex((a) => norm(a) === 'у');
    const homes = at >= 0 ? rest.slice(0, at) : rest;
    return { action, npc: npcName(at >= 0 ? rest.slice(at + 1).join(' ') : ''), storage: homes[0] || null, rewards: homes[1] || null };
  }
  return { action, npc: npcName(rest.join(' ')) };
}

/** Закрыть меню после дела (как человек: посмотрел — закрыл); ошибка закрытия не важнее ответа. */
async function closeAfter(bot) {
  if (!bot.currentWindow) return;
  try {
    await bot.actions.closeMenu();
  } catch (_) {
    /* например, действие прервали #стоп */
  }
}

async function cmdQuests({ bot, args, words }) {
  const { action, npc, storage, rewards } = questArgs(args, words);
  if (action === 'bring') {
    // Без слов — те же дома, что в прошлый раз.
    const last = lastHomes.get(norm(bot.username)) || {};
    const homes = storage ? { storage, rewards } : last;
    if (!homes.storage) {
      throw new CommandError('откуда брать? Например: #квесты принести урожай награды — со склада у /home урожай, награды — в сундук у /home награды');
    }
    for (const h of [homes.storage, homes.rewards].filter(Boolean)) {
      if (!HOME_NAME_RE.test(h)) throw new CommandError(`«${h}» не похоже на название дома (буквы, цифры, «_» и «-»)`);
    }
    lastHomes.set(norm(bot.username), homes);
    return bringQuests(bot, npc, homes.storage, homes.rewards || null);
  }
  const lines = []; // что уже сделано (например, новый уровень) — в ответе, даже если дальше ошибка
  try {
    await openQuests(bot, npc);
    if (action === 'level') return await levelQuests(bot, npc);
    if (action === 'take') {
      // Все задания уровня выполнены — сначала новый уровень: новые задания появятся только после него.
      const up = await levelUpBeforeTaking(bot, npc, lines);
      const took = await takeQuests(bot, npc);
      const unconfirmed = Boolean(up && !up.up);
      return {
        ok: took.ok && !unconfirmed,
        code: unconfirmed ? 'unconfirmed' : took.code,
        message: [...lines, ...[].concat(took.message)],
        data: { ...took.data, levelUp: up },
      };
    }
    if (action === 'give') {
      const gave = await giveQuests(bot, npc);
      lines.push(...[].concat(gave.message));
      const up = await levelUpAfterGiving(bot, npc, gave.data.gave, lines);
      return { ok: !up || up.up, code: up && !up.up ? 'unconfirmed' : undefined, message: lines, data: { ...gave.data, levelUp: up } };
    }
    if (action === 'buy') {
      const r = await buyForQuests(bot, npc);
      if (!r) return { ok: true, message: 'Покупать нечего: заданий «Купите…» нет или они уже выполнены', data: { npc, spent: 0 } };
      lines.push(...r.lines);
      const up = await levelUpAfterGiving(bot, npc, [r.quest], lines); // купили последнее — новый уровень
      const ok = r.ok && (!up || up.up);
      return { ok, code: ok ? undefined : 'not_bought', message: lines, data: { npc, spent: r.spent, bought: r.bought, left: r.left, noMoney: r.noMoney, levelUp: up } };
    }
    return showQuests(bot, npc);
  } catch (err) {
    // Не ошибка: у NPC просто больше нет заданий (все уровни пройдены) — так и сказать.
    if (err && (err.code === 'finished' || err.code === 'no_quests')) {
      return { ok: true, code: err.code, message: [...lines, err.message], data: { npc, finished: err.code === 'finished' } };
    }
    if (!lines.length) throw err;
    lines.push(`Остановился: ${err && err.message ? err.message : err}`);
    return { ok: false, code: (err && err.code) || 'failed', message: lines };
  } finally {
    await closeAfter(bot);
  }
}

function showQuests(bot, npc) {
  const title = windowTitle(bot.currentWindow);
  const { quests, level } = readQuests(bot);
  const taken = quests.filter((q) => q.taken).length;
  const done = quests.filter((q) => q.done).length;
  const lines = [`Задания (${title}): ${quests.length}, взято ${taken}, выполнено ${done}`, ...quests.map(describeQuest)];
  if (level) lines.push(level.ready ? 'Уровень: все задания выполнены — можно повышать (#квесты уровень)' : `Уровень: ${level.text || level.title}`);
  return { ok: true, message: lines, data: { npc, title, quests, level } };
}

// ---------- уровень NPC: кнопка-подсолнух внизу «Улучшений» ----------

const LEVEL_WAIT_MS = 5000; // ответ сервера на кнопку уровня

/** Последние системные строки сервера («| …», «! …») — объяснить, что пошло не так. */
function serverSaid(lines, n = 2) {
  return lines.filter((l) => /^\s*[|!│]/.test(l)).slice(-n).map((l) => l.replace(/^[\s!|│]+/, '')).join(' / ');
}

/**
 * Нажать готовую кнопку уровня («Доступно улучшение») и дождаться ответа в чате:
 * «| Уровень доверия повышен! Текущий уровень: 4 ↑» (скриншоты 5 ноября). Меню после этого сервер может закрыть.
 */
async function pressLevel(bot, npc, level) {
  const chat = watchChat(bot);
  const answer = () => chat.lines.map(parseQuestChat).find((x) => x && x.type === 'level');
  try {
    await bot.actions.clickSlot(level.slot);
    for (let t = 0; t < LEVEL_WAIT_MS && !answer(); t += 100) await bot.actions.wait(100);
  } finally {
    chat.stop();
  }
  const hit = answer();
  if (hit) return { up: true, level: hit.level, line: `${npc}: уровень повышен${hit.level ? ` — теперь ${hit.level}` : ''}` };
  const said = serverSaid(chat.lines);
  return { up: false, level: null, line: `${npc}: нажал «Доступно улучшение», но сервер не написал «Уровень доверия повышен»${said ? ` (сервер: «${said}»)` : ''}` };
}

/** Перед взятием заданий: все задания уровня выполнены — повысить уровень и открыть «Улучшения» заново. */
async function levelUpBeforeTaking(bot, npc, lines) {
  const { level } = readQuests(bot);
  if (!level || !level.ready) return null;
  const r = await pressLevel(bot, npc, level);
  lines.push(r.line);
  await closeAfter(bot);
  await openQuests(bot, npc); // уже с заданиями нового уровня
  return r;
}

/**
 * После сдачи: задания уровня теперь все выполнены — повысить уровень. Кнопку в открытом меню сервер может
 * не обновить: если сдали последнее невыполненное, а она не готова — открыть меню заново и посмотреть ещё раз.
 */
async function levelUpAfterGiving(bot, npc, gave, lines) {
  const now = readQuests(bot);
  let { level } = now;
  const finished = gave.filter((g) => g.done);
  const left = now.quests.filter((q) => !q.done && !finished.some((g) => g.slot === q.slot && sameTitle(g.title, q.title)));
  if (!(level && level.ready) && finished.length && !left.length) {
    await closeAfter(bot);
    await openQuests(bot, npc);
    ({ level } = readQuests(bot));
  }
  if (!level || !level.ready) return null;
  const r = await pressLevel(bot, npc, level);
  lines.push(r.line);
  return r;
}

/** «#квесты уровень»: все задания выполнены — повысить уровень; нет — показать, что осталось. */
async function levelQuests(bot, npc) {
  const title = windowTitle(bot.currentWindow);
  const { quests, level } = readQuests(bot);
  if (!level) return { ok: false, code: 'not_found', message: `В меню «${title}» нет кнопки уровня`, data: { npc, title } };
  if (!level.ready) {
    const left = quests.filter((q) => !q.done);
    const lines = [`Уровень пока не повысить (${title}): ${level.text || level.title}`];
    if (left.length) lines.push(`Не выполнено: ${left.length}`, ...left.map(describeQuest));
    return { ok: false, code: 'not_ready', message: lines, data: { npc, title, ready: false, left: left.map((q) => q.slot) } };
  }
  const r = await pressLevel(bot, npc, level);
  return { ok: r.up, code: r.up ? undefined : 'unconfirmed', message: r.line, data: { npc, title, up: r.up, level: r.level } };
}

async function takeQuests(bot, npc) {
  const took = [];
  const failed = [];
  const tried = new Set();
  const chat = watchChat(bot);
  try {
    for (;;) {
      const next = readQuests(bot).quests.find((q) => !q.taken && !tried.has(q.slot));
      if (!next) break;
      tried.add(next.slot);
      chat.take();
      await clickAndSettle(bot, next.slot);
      const after = readQuests(bot).quests.find((q) => q.slot === next.slot);
      // «| Вы взяли задание Ночная прополка.» — подтверждение сервера, даже если меню ещё не обновилось.
      const said = chat.take().map(parseQuestChat).some((x) => x && x.type === 'took' && sameTitle(x.text, next.title));
      (said || (after && after.taken) ? took : failed).push(next);
    }
  } finally {
    chat.stop();
  }
  const lines = [];
  if (took.length) lines.push(`Взял задания: ${took.map(quote).join(', ')}`);
  if (failed.length) lines.push(`Не взялись (сервер не отметил): ${failed.map(quote).join(', ')}`);
  if (!took.length && !failed.length) lines.push('Все задания уже взяты');
  return { ok: failed.length === 0, code: failed.length ? 'partial' : undefined, message: lines, data: { npc, took: took.map((q) => q.slot), failed: failed.map((q) => q.slot) } };
}

async function giveQuests(bot, npc) {
  const gave = [];
  const nothing = [];
  const lines = [];
  const chat = watchChat(bot);
  try {
    for (const q of readQuests(bot).quests) {
      if (q.kind !== 'deliver' || !q.taken || q.done) continue;
      if (q.items.length && countItems(bot, q.items) === 0) {
        nothing.push(q);
        continue;
      }
      chat.take();
      await clickAndSettle(bot, q.slot);
      // Сервер пишет: «Вы передали …», «Задание … выполнено», «Вы получаете награду: …». Выполненное задание
      // в меню может смениться чем-то другим — поэтому чат главнее меню.
      const said = chat.take().map(parseQuestChat).filter(Boolean);
      const after = readQuests(bot).quests.find((x) => x.slot === q.slot && sameTitle(x.title, q.title));
      const done = said.some((x) => x.type === 'done' && sameTitle(x.text, q.title)) || Boolean(after && after.done);
      const reward = said.filter((x) => x.type === 'reward').map((x) => x.text).join(', ') || null;
      const handed = said.some((x) => x.type === 'gave');
      if (done || handed || (after && after.have > q.have)) {
        let to = after ? after.have : q.have;
        if (done) to = q.need;
        gave.push({ slot: q.slot, title: q.title, from: q.have, to, need: q.need, done, reward });
        const progress = to > q.have ? `: ${q.have} → ${to} из ${q.need}` : '';
        lines.push(`Сдал в ${quote(q)}${progress}${done ? ' — выполнено' : ''}${reward ? `, награда: ${reward}` : ''}`);
      } else {
        lines.push(`${quote(q)}: сервер ничего не взял (нужно: ${q.items.join(', ') || q.goal})`);
      }
    }
  } finally {
    chat.stop();
  }
  if (!gave.length && !lines.length) {
    lines.push(nothing.length
      ? `Сдавать нечего: в инвентаре нет нужного (${nothing.map((q) => `${quote(q)} — ${q.items.join('/')}`).join('; ')})`
      : 'Сдавать нечего: нет взятых заданий «Передайте…»');
  }
  return { ok: true, message: lines, data: { npc, gave } };
}

// ---------- задания «Купите у NPC товаров на N» ----------

const MAX_QUEST_PURCHASES = 40; // за один раз не больше стольких покупок: деньги тратятся настоящие

/**
 * Что купить следующим, чтобы набрать left (деньги настоящие — главное не переплатить): самый дорогой товар,
 * который не больше остатка (без переплаты и с меньшим числом кликов); остаток меньше любой цены — самый
 * дешёвый (переплата меньше самой маленькой цены). Только то, что продаётся и не кончилось.
 */
function pickPurchase(offers, left) {
  const can = offers.filter((o) => o && o.buyable && o.price > 0 && o.left !== 0);
  const fits = can.filter((o) => o.price <= left).sort((a, b) => b.price - a.price);
  return fits[0] || can.sort((a, b) => a.price - b.price)[0] || null;
}

/** Задания «Купите…» этого NPC, которые ещё не набраны: [{ q, left }]. */
const buyTodo = (quests) => quests.filter((q) => q.kind === 'buy' && q.taken && !q.done && q.need > q.have);

/**
 * «Купите у Фермера товаров на: 0/12000» — купить в «Покупке» на недостающую сумму за деньги бота (ТЗ).
 * Первая покупка проверяется по самому заданию: не засчиталась — дальше не покупаем. Меню заданий должно быть
 * открыто (читаем из него); в конце открыто снова оно же, уже с новым прогрессом.
 * → null (покупать нечего) или { lines, ok, spent, bought: [{ title, times }], left }
 */
async function buyForQuests(bot, npc) {
  const before = buyTodo(readQuests(bot).quests);
  if (!before.length) return null;
  const quest = before.reduce((a, b) => (b.need - b.have > a.need - a.have ? b : a));
  let left = quest.need - quest.have;
  const bought = new Map();
  let spent = 0;
  let purchases = 0;
  let note = '';
  const shop = async () => {
    await closeAfter(bot);
    await openShop(bot, npc);
  };
  const buyNext = async () => {
    const offer = pickPurchase(menuSlots(bot.currentWindow).map(parseOffer), left);
    if (!offer) {
      note = 'в «Покупке» больше нечего купить';
      return false;
    }
    const r = await buyOnce(bot, offer.slot);
    if (!r.ok) {
      note = r.why;
      return false;
    }
    purchases += 1;
    spent += offer.price;
    left -= offer.price;
    const key = `«${offer.title}»${offer.count > 1 ? ` (×${offer.count})` : ''}`;
    bought.set(key, (bought.get(key) || 0) + 1);
    return true;
  };
  await shop();
  let firstOk = await buyNext();
  if (firstOk) {
    // Засчиталась ли покупка в задание? Нет — деньги дальше не тратим.
    await closeAfter(bot);
    await openQuests(bot, npc);
    const now = readQuests(bot).quests.find((q) => q.slot === quest.slot && sameTitle(q.title, quest.title));
    if (now && !now.done && now.have <= quest.have) {
      firstOk = false;
      note = `покупка не засчиталась в задание (${quest.have} → ${now.have} из ${quest.need}) — дальше не покупаю`;
    } else if (now) {
      left = now.done ? 0 : now.need - now.have;
    }
    if (firstOk && left > 0) {
      await shop();
      while (left > 0 && purchases < MAX_QUEST_PURCHASES && (await buyNext()));
      if (left > 0 && purchases >= MAX_QUEST_PURCHASES && !note) note = `за раз не больше ${MAX_QUEST_PURCHASES} покупок — продолжу в следующий раз`;
    }
  }
  // Итог — по самому заданию.
  await closeAfter(bot);
  await openQuests(bot, npc);
  const after = readQuests(bot).quests.find((q) => q.slot === quest.slot && sameTitle(q.title, quest.title));
  const done = Boolean(after && after.done);
  const list = [...bought.entries()].map(([title, times]) => ({ title, times }));
  const lines = [];
  if (list.length) {
    const what = list.map((x) => `${x.title} ×${x.times}`).join(', ');
    const progress = after ? `: ${quest.have} → ${after.have} из ${quest.need}${done ? ' — выполнено' : ''}` : '';
    lines.push(`Купил у ${npc} для ${quote(quest)}: ${what} — потрачено ${spent}${progress}`);
  }
  const remaining = done ? 0 : Math.max(0, Math.ceil(after ? after.need - after.have : left));
  // Похоже, кончились деньги — подсказать, сколько дать: столько не хватает до задания.
  const noMoney = !done && /денег|средств|баланс|монет/i.test(note);
  const money = noMoney ? ` — дай боту денег: /pay ${bot.username || '<ник бота>'} ${remaining}` : '';
  if (!done && note) lines.push(`${list.length ? 'Докупить' : `Купить для ${quote(quest)}`} не вышло: ${note}${money}`);
  return {
    lines,
    ok: done || (list.length > 0 && !note),
    spent,
    bought: list,
    left: remaining,
    noMoney,
    quest: { slot: quest.slot, title: quest.title, done },
  };
}

// ---------- задания «Передайте…» целиком: склад → NPC → склад наград ----------

const NPC_WARP = '/warp ah'; // где стоят NPC с заданиями (ТЗ)
const TELEPORT_WAIT_MS = 8000;
const MAX_STORAGE_CHESTS = 24;
// Склад у дома: сундуки до стольких блоков от точки /home (к дальним бот подходит). Было 4 — бот открывал
// один-два ближних сундука и говорил «кирки нет», хотя она лежала в соседнем (7 ноября).
const STORAGE_RANGE = 12;

/** Сундуки склада вокруг бота, от ближнего; половинки большого сундука — один раз. */
function storageChests(bot) {
  const out = [];
  const seen = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  for (const c of scanBlocks(bot, STORAGE_RANGE, (b) => isContainer(b.name))) {
    if (c.dist > STORAGE_RANGE + 0.5 || seen.has(key(c.pos))) continue;
    seen.add(key(c.pos));
    const partner = chestPartner(c.block, c.pos);
    if (partner) seen.add(key(partner));
    out.push(c);
    if (out.length >= MAX_STORAGE_CHESTS) break;
  }
  return out;
}
const HOME_NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const lastHomes = new Map(); // ник бота → { storage, rewards }: «#квесты принести» без слов — как в прошлый раз

/**
 * Написать серверу команду телепорта (/home склад, /warp ah) и дождаться самого телепорта (пакет позиции
 * или смена мира). Потом постоять, пока вокруг догрузятся чанки с сундуками и NPC.
 */
async function teleportBy(bot, cmd, { waitMs = TELEPORT_WAIT_MS } = {}) {
  if (typeof bot.sendCommand !== 'function') throw new CommandError('бот не может писать команды серверу');
  let moved = false;
  const onMove = () => {
    moved = true;
  };
  bot.on('forcedMove', onMove);
  bot.on('respawn', onMove);
  const chat = watchChat(bot);
  try {
    if (!bot.sendCommand(cmd)) throw new CommandError(`не удалось отправить ${cmd}: бот не в сети`);
    for (let t = 0; t < waitMs && !moved; t += 100) await bot.actions.wait(100);
  } finally {
    bot.removeListener('forcedMove', onMove);
    bot.removeListener('respawn', onMove);
    chat.stop();
  }
  if (!moved) {
    const said = serverSaid(chat.lines);
    const err = new CommandError(`после ${cmd} телепорта не было${said ? ` (сервер: «${said}»)` : ''}`);
    // Для автопилота заданий: бой не пускает (подождать) или у бота нет такого дома (поставить /sethome).
    if (/pvp/i.test(said)) err.code = 'pvp';
    else if (/^\/home\s/i.test(cmd)) err.code = 'no_home';
    else err.code = 'no_teleport';
    throw err;
  }
  for (let i = 0; i < 30 && !bot.blockAt(bot.entity.position.offset(0, -1, 0)); i += 1) await bot.actions.wait(100);
  await bot.actions.wait(800 + Math.floor(Math.random() * 400));
}

/** NPC рядом? Нет — /warp ah (NPC стоят там) и подождать, пока сервер покажет сущности. */
async function ensureNpc(bot, npc) {
  const near = () => {
    try {
      return findEntity(bot, npc);
    } catch (_) {
      return null;
    }
  };
  if (near()) return;
  await teleportBy(bot, NPC_WARP);
  for (let i = 0; i < 30 && !near(); i += 1) await bot.actions.wait(100);
  if (!near()) throw new CommandError(`после ${NPC_WARP} «${npc}» рядом не видно`);
}

/** Вторая половина большого сундука (чтобы не открывать его дважды) — как ChestBlock.getConnectedDirection. */
function chestPartner(block, pos) {
  let props = {};
  try {
    props = typeof block.getProperties === 'function' ? block.getProperties() : {};
  } catch (_) {
    return null;
  }
  const clockwise = { north: [1, 0], east: [0, 1], south: [-1, 0], west: [0, -1] }[props.facing];
  if (!clockwise || (props.type !== 'left' && props.type !== 'right')) return null;
  const [dx, dz] = props.type === 'left' ? clockwise : [-clockwise[0], -clockwise[1]];
  return pos.offset(dx, 0, dz);
}

/**
 * Взять со склада: сундуки в пределах досягаемости (от ближнего); из каждого — по нуждам needs
 * ([{ test, want, got }], got растёт). Возвращает { taken: имя → сколько, full }.
 */
async function takeFromStorage(bot, needs) {
  const chests = storageChests(bot);
  if (!chests.length) throw new CommandError(`у дома нет сундуков (до ${STORAGE_RANGE} блоков от места, куда переносит /home)`);
  const taken = new Map();
  const seen = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  let full = false;
  for (const c of chests) {
    if (full || needs.every((n) => n.got >= n.want)) break;
    if (seen.has(key(c.pos))) continue;
    seen.add(key(c.pos));
    const partner = chestPartner(c.block, c.pos);
    if (partner) seen.add(key(partner));
    const chest = await openStorage(bot, c.pos);
    try {
      const w = chest.window;
      for (const n of needs) {
        if (n.got >= n.want) continue;
        const r = await moveStacks(bot, w, storageSlots(w), playerSlots(w), n.test, n.want - n.got);
        n.got += r.total;
        for (const [name, count] of r.moved) taken.set(name, (taken.get(name) || 0) + count);
        if (r.full) {
          full = true;
          break;
        }
      }
    } finally {
      await closeAfter(bot);
    }
  }
  return { taken, full };
}

// ---------- снаряжение со склада ----------

const FOOD_WANT = 45; // еды с собой (штук)
const ARMOR_TIERS = ['netherite', 'diamond', 'iron', 'chainmail', 'golden', 'leather'];
const GEAR_TOOL_TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden'];
// Что входит в снаряжение: броня на 4 места, меч, кирка, щит во вторую руку. rank — меньше = лучше, null — не то.
const GEAR = [
  { key: 'head', wear: 'head', slot: 5, label: 'шлем', rank: (n) => (n === 'turtle_helmet' ? 2.5 : armorRank(n, 'helmet')) },
  { key: 'torso', wear: 'torso', slot: 6, label: 'нагрудник', rank: (n) => armorRank(n, 'chestplate') },
  { key: 'legs', wear: 'legs', slot: 7, label: 'поножи', rank: (n) => armorRank(n, 'leggings') },
  { key: 'feet', wear: 'feet', slot: 8, label: 'ботинки', rank: (n) => armorRank(n, 'boots') },
  { key: 'sword', label: 'меч', rank: (n) => toolRank(n, 'sword') },
  { key: 'pickaxe', label: 'кирка', rank: (n) => toolRank(n, 'pickaxe') },
  { key: 'shield', wear: 'off-hand', slot: 45, label: 'щит', rank: (n) => (n === 'shield' ? 0 : null) },
];

function armorRank(name, piece) {
  const m = String(name || '').match(/^([a-z]+)_([a-z]+)$/);
  if (!m || m[2] !== piece) return null;
  const i = ARMOR_TIERS.indexOf(m[1]);
  return i < 0 ? null : i;
}

function toolRank(name, tool) {
  const m = String(name || '').match(/^([a-z]+)_([a-z]+)$/);
  if (!m || m[2] !== tool) return null;
  const i = GEAR_TOOL_TIERS.indexOf(m[1]);
  return i < 0 ? null : i;
}

/** Лучшее своё по каждому месту снаряжения: { key → { item, rank } } (надетое — тоже). */
function ownGear(bot) {
  const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : [];
  const out = {};
  for (const g of GEAR) {
    for (let i = 5; i <= 45; i += 1) {
      const it = slots[i];
      const r = it ? g.rank(it.name) : null;
      if (r !== null && (!out[g.key] || r < out[g.key].rank)) out[g.key] = { item: it, rank: r, slot: i };
    }
  }
  return out;
}

const foodCount = (bot) => inventoryItems(bot).filter((it) => isFood(it.name, bot.registry)).reduce((n, it) => n + (it.count || 1), 0);

/** Нужно ли боту за снаряжением: нет брони совсем, мало еды или нет щита. */
function gearMissing(bot) {
  const own = ownGear(bot);
  return !['head', 'torso', 'legs', 'feet'].some((k) => own[k]) || !own.shield || foodCount(bot) < 10;
}

/**
 * Собрать снаряжение со склада вокруг бота: броня на 4 места, меч, кирка, щит, еда (FOOD_WANT штук). Сначала
 * осмотреть все сундуки (до STORAGE_RANGE блоков), потом взять лучшее по каждому месту (незерит → алмаз → железо…),
 * из какого сундука бы оно ни было; чего нет в одном — ищет в остальных. Броню надевает, щит — во вторую руку.
 * → { lines, data: { took, wore, missing, food, chests } }
 */
async function gearUp(bot, { pickTier = 0 } = {}) {
  const chests = storageChests(bot);
  if (!chests.length) throw new CommandError(`рядом нет сундуков склада (до ${STORAGE_RANGE} блоков)`);
  const own = ownGear(bot);
  // 1. Осмотр: что где лежит.
  const found = []; // { chest, name, count, rank?, key? }
  let opened = 0;
  for (const c of chests) {
    let chest;
    try {
      chest = await openStorage(bot, c.pos);
    } catch (err) {
      if (isFatal(err)) throw err;
      continue; // чужой или не открылся — следующий
    }
    opened += 1;
    try {
      const [start, end] = storageSlots(chest.window);
      for (let i = start; i < end; i += 1) {
        const it = chest.window.slots[i];
        if (it) found.push({ chest: c, name: it.name, count: it.count || 1 });
      }
    } finally {
      await closeAfter(bot);
    }
  }
  if (!opened) throw new CommandError('ни один сундук склада не открылся');
  // 2. Что брать: по каждому месту — лучшее из найденного, если оно лучше своего; еда — до FOOD_WANT.
  const plan = new Map(); // сундук → [{ name, want, key }]
  const add = (chest, entry) => {
    if (!plan.has(chest)) plan.set(chest, []);
    plan.get(chest).push(entry);
  };
  const missing = [];
  for (const g of GEAR) {
    let best = null;
    for (const f of found) {
      const r = g.rank(f.name);
      if (r === null || (g.key === 'pickaxe' && PICK_TIERS[f.name] < pickTier)) continue;
      if (!best || r < best.rank) best = { ...f, rank: r };
    }
    const mine = own[g.key];
    if (best && (!mine || best.rank < mine.rank)) add(best.chest, { name: best.name, want: 1, key: g.key });
    else if (!best && !mine) missing.push(g.label);
  }
  let foodNeed = Math.max(0, FOOD_WANT - foodCount(bot));
  const foods = found.filter((f) => isFood(f.name, bot.registry)).sort((a, b) => foodRank(a.name) - foodRank(b.name) || a.count - b.count);
  for (const f of foods) {
    if (foodNeed <= 0) break;
    add(f.chest, { name: f.name, want: Math.min(f.count, foodNeed), key: 'food' });
    foodNeed -= Math.min(f.count, foodNeed);
  }
  // 3. Взять: только те сундуки, где лежит выбранное.
  const took = new Map();
  let full = false;
  for (const [c, entries] of plan) {
    if (full) break;
    let chest;
    try {
      chest = await openStorage(bot, c.pos);
    } catch (err) {
      if (isFatal(err)) throw err;
      continue;
    }
    try {
      const w = chest.window;
      for (const e of entries) {
        const r = await moveStacks(bot, w, storageSlots(w), playerSlots(w), (it) => it.name === e.name, e.want);
        for (const [name, n] of r.moved) took.set(name, (took.get(name) || 0) + n);
        if (r.full) {
          full = true;
          break;
        }
      }
    } finally {
      await closeAfter(bot);
    }
  }
  // 4. Надеть лучшее: броня, щит во вторую руку.
  const wore = [];
  const now = ownGear(bot);
  for (const g of GEAR.filter((x) => x.wear)) {
    const best = now[g.key];
    if (!best || best.slot === g.slot) continue;
    try {
      await bot.actions.equipTo(best.item, g.wear);
      wore.push(best.item.name);
    } catch (err) {
      if (isFatal(err)) throw err;
    }
  }
  const food = foodCount(bot);
  const lines = [];
  lines.push(`Снаряжение: сундуков осмотрел ${opened}${took.size ? `, взял ${countsText(took)}` : ', брать нечего — у бота уже лучшее'}`);
  if (wore.length) lines.push(`Надел: ${wore.join(', ')}`);
  lines.push(`Еда: ${food} из ${FOOD_WANT}${food < FOOD_WANT ? ' — на складе больше нет' : ''}`);
  if (missing.length) lines.push(`Не нашлось ни у бота, ни в сундуках: ${missing.join(', ')}`);
  if (full) lines.push('Инвентарь полон — взял не всё');
  return { lines, data: { took: countsData(took), wore, missing, food, chests: opened, full } };
}

async function cmdGear({ bot, args, words }) {
  const { home } = homeArg(args, words, '#снаряжение дом база');
  const base = home || String((bot.panelConfig && bot.panelConfig.questStorage) || '').trim();
  const lines = [];
  if (base) {
    await teleportBy(bot, `/home ${base}`);
    lines.push(`/home ${base}`);
  }
  const r = await gearUp(bot);
  return { ok: !r.data.missing.length, code: r.data.missing.length ? 'incomplete' : undefined, message: [...lines, ...r.lines], data: { home: base || null, ...r.data } };
}

// ---------- мусор — в отдельные сундуки ----------

// Что бот считает мусором: земля и камень разных видов, гравий, песок, адский камень, семена, гнилая плоть…
// Не мусор: песок душ, чернокамень (их просит Алхимик), кости, нитки, порох (задания «Принесите…»).
const JUNK = new Set([
  'dirt', 'coarse_dirt', 'rooted_dirt', 'mud', 'cobblestone', 'cobbled_deepslate', 'stone', 'deepslate', 'tuff', 'granite',
  'diorite', 'andesite', 'calcite', 'dripstone_block', 'pointed_dripstone', 'gravel', 'sand', 'red_sand', 'netherrack',
  'basalt', 'smooth_basalt', 'flint', 'wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds',
  'pitcher_pod', 'rotten_flesh', 'poisonous_potato',
]);
const MAX_JUNK_TRIPS = 3; // #добудь: столько раз за одну команду сходить разгрузиться

/** Ячейка инвентаря (9–44) со стопкой, которую оставить себе: самая большая из блоков для «столба» — или null. */
function keepPillarSlot(bot) {
  const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : [];
  let best = null;
  for (let i = 9; i < 45; i += 1) {
    const it = slots[i];
    if (it && PILLAR_BLOCKS.includes(it.name) && (best === null || (it.count || 1) > (slots[best].count || 1))) best = i;
  }
  return best;
}

/** Мусор в инвентаре (без стопки для «столба»): [{ name, count }]. */
function junkItems(bot) {
  const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : [];
  const keep = keepPillarSlot(bot);
  const out = new Map();
  for (let i = 9; i < 45; i += 1) {
    const it = slots[i];
    if (it && i !== keep && JUNK.has(it.name)) out.set(it.name, (out.get(it.name) || 0) + (it.count || 1));
  }
  return [...out].map(([name, count]) => ({ name, count }));
}

/**
 * Сложить мусор в сундуки вокруг бота (до STORAGE_RANGE блоков), от ближнего: сундук полон — в следующий.
 * Одну стопку блоков для «столба» бот оставляет себе. → { put: Map, left: [{ name, count }], opened, kept }
 */
async function depositJunk(bot) {
  const chests = storageChests(bot);
  if (!chests.length) throw new CommandError(`рядом нет сундуков для мусора (до ${STORAGE_RANGE} блоков)`);
  const put = new Map();
  let opened = 0;
  const keep = keepPillarSlot(bot);
  const kept = keep === null ? null : { name: bot.inventory.slots[keep].name, count: bot.inventory.slots[keep].count || 1 };
  for (const c of chests) {
    if (!junkItems(bot).length) break;
    let chest;
    try {
      chest = await openStorage(bot, c.pos);
    } catch (err) {
      if (isFatal(err)) throw err;
      continue;
    }
    opened += 1;
    let rejected = false;
    try {
      const w = chest.window;
      const keepObj = keep === null ? null : w.slots[w.inventoryStart + (keep - 9)];
      const r = await moveStacks(bot, w, playerSlots(w), storageSlots(w), (it) => JUNK.has(it.name) && it !== keepObj);
      for (const [name, n] of r.moved) put.set(name, (put.get(name) || 0) + n);
      rejected = r.rejected;
    } finally {
      await closeAfter(bot);
    }
    if (rejected) break; // сервер не даёт класть (чужой сундук) — дальше не пробуем
  }
  return { put, left: junkItems(bot), opened, kept };
}

/** «#очисти [дом X | здесь]»: мусор из инвентаря — в сундуки «Дома мусора» (или в сундуки рядом). */
async function cmdClean({ bot, args, words }) {
  const hereAt = words.findIndex((w) => /^(?:здесь|тут|here)$/.test(w));
  const { home } = homeArg(args, words, '#очисти дом мусор');
  const base = hereAt >= 0 ? null : home || String((bot.panelConfig && bot.panelConfig.questJunk) || '').trim();
  if (hereAt < 0 && !base) {
    throw new CommandError('куда складывать мусор? Впиши «Дом мусора» в настройках автопилота (дом у сундуков для мусора), ' +
      'или #очисти дом мусор, или #очисти здесь — в сундуки рядом');
  }
  if (!junkItems(bot).length) return { ok: true, message: 'Мусора в инвентаре нет', data: { put: [], left: [] } };
  const lines = [];
  if (base) await teleportBy(bot, `/home ${base}`);
  const r = await depositJunk(bot);
  lines.push(r.put.size ? `Мусор — в сундуки${base ? ` у дома «${base}»` : ' рядом'}: ${countsText(r.put)}` : 'Мусор положить не вышло');
  if (r.kept) lines.push(`Оставил себе для «столба»: ${r.kept.name}×${r.kept.count}`);
  if (r.left.length) lines.push(`Не влезло (сундуки полны или не открылись): ${r.left.map((x) => `${x.name}×${x.count}`).join(', ')}`);
  return { ok: !r.left.length, code: r.left.length ? 'full' : undefined, message: lines, data: { home: base, put: countsData(r.put), left: r.left, chests: r.opened } };
}

/**
 * «#квесты принести урожай награды»: задания «Передайте…» целиком. У NPC (/warp ah) — взять новые задания и
 * посчитать, чего не хватает (с учётом инвентаря); /home урожай — взять это из сундуков у дома; /warp ah —
 * сдать; /home награды — положить награды. Инструменты и остатки для заданий бот оставляет себе.
 * Все задания уровня выполнены (до или после сдачи) — бот повышает уровень NPC кнопкой «Доступно улучшение».
 */
async function bringQuests(bot, npc, storageHome, rewardsHome) {
  const lines = [];
  const data = { npc, storage: storageHome, rewards: rewardsHome, took: [], needs: [], taken: [], gave: [], stored: [], levelUps: [], short: [], unknown: [], full: false };
  // Готово; кнопку уровня нажали, а сервер не подтвердил — это стоит проверить, поэтому не «всё хорошо».
  const finish = () => {
    const unconfirmed = data.levelUps.some((u) => !u.up);
    return { ok: !unconfirmed, code: unconfirmed ? 'unconfirmed' : undefined, message: lines, data };
  };
  try {
    // 1. Задания (все задания уровня уже выполнены — сначала новый уровень).
    await ensureNpc(bot, npc);
    let quests;
    try {
      await openQuests(bot, npc);
      const up = await levelUpBeforeTaking(bot, npc, lines);
      if (up) data.levelUps.push({ up: up.up, level: up.level });
      const took = await takeQuests(bot, npc);
      if (took.data.took.length) lines.push([].concat(took.message)[0]);
      data.took = [...took.data.took];
      // «Купите у NPC товаров на N» — пока бот у NPC, за свои деньги. Купили последнее — сразу новый уровень.
      const bought = await buyForQuests(bot, npc);
      if (bought) {
        lines.push(...bought.lines);
        data.bought = { spent: bought.spent, items: bought.bought, left: bought.left, noMoney: bought.noMoney };
        if (bought.quest.done) {
          const again = await levelUpBeforeTaking(bot, npc, lines);
          if (again) {
            data.levelUps.push({ up: again.up, level: again.level });
            const more = await takeQuests(bot, npc);
            if (more.data.took.length) lines.push([].concat(more.message)[0]);
            data.took.push(...more.data.took);
          }
        }
      }
      quests = readQuests(bot).quests;
    } finally {
      await closeAfter(bot);
    }
    const todo = quests.filter((q) => q.kind === 'deliver' && q.taken && !q.done && q.items.length && q.need > q.have);
    // «Передайте …» с незнакомыми словами: что приносить, бот не знает — сказать, а не молча пропустить.
    const unknown = quests.filter((q) => q.kind === 'deliver' && q.taken && !q.done && !q.items.length);
    if (unknown.length) lines.push(`Не знаю, какие это предметы — пропускаю: ${unknown.map((q) => `${quote(q)} («${q.goal}»)`).join('; ')}`);
    data.unknown = unknown.map((q) => ({ title: q.title, goal: q.goal }));
    if (!todo.length) {
      lines.push('Приносить нечего: заданий «Передайте…» нет или все выполнены');
      return finish();
    }
    // 2. Чего не хватает: нужное минус то, что уже есть в инвентаре.
    const inv = new Map();
    for (const it of inventoryItems(bot)) inv.set(it.name, (inv.get(it.name) || 0) + (it.count || 1));
    const needs = todo.map((q) => {
      let want = q.need - q.have;
      for (const id of q.items) {
        const use = Math.min(want, inv.get(id) || 0);
        want -= use;
        if (use) inv.set(id, inv.get(id) - use);
      }
      return { q, want, got: 0, test: (it) => q.items.includes(it.name) };
    });
    data.needs = needs.map(({ q, want }) => ({ slot: q.slot, title: q.title, missing: q.need - q.have, fetch: want, items: q.items }));
    lines.push(`Нужно передать: ${needs.map(({ q }) => `${quote(q)} — ${q.need - q.have} (${q.items.join('/')})`).join('; ')}`);
    // 3. Склад.
    const fetch = needs.filter((n) => n.want > 0);
    let taken = new Map();
    if (fetch.length) {
      await teleportBy(bot, `/home ${storageHome}`);
      const r = await takeFromStorage(bot, fetch);
      taken = r.taken;
      data.taken = countsData(taken);
      const short = fetch.filter((n) => n.got < n.want);
      let line = `Склад (/home ${storageHome}): ${taken.size ? `взял ${countsText(taken)}` : 'подходящего нет'}`;
      if (short.length) line += `; не хватило: ${short.map((n) => `${quote(n.q)} — ${n.want - n.got}`).join(', ')}`;
      if (r.full) line += '; инвентарь полон';
      // Чего не хватило на складе (для автопилота: «положи на склад …»).
      data.short = short.map((n) => ({ title: n.q.title, goal: n.q.goal, items: n.q.items, missing: n.want - n.got }));
      data.full = Boolean(r.full);
      lines.push(line);
    }
    // 4. Сдать; выполнили всё — новый уровень.
    await ensureNpc(bot, npc);
    try {
      await openQuests(bot, npc);
      const gave = await giveQuests(bot, npc);
      data.gave = gave.data.gave;
      lines.push(...[].concat(gave.message));
      const up = await levelUpAfterGiving(bot, npc, gave.data.gave, lines);
      if (up) data.levelUps.push({ up: up.up, level: up.level });
    } finally {
      await closeAfter(bot);
    }
    // 5. Награды — в сундук у дома наград; инструменты и всё, что ещё пригодится для заданий, — с собой.
    if (rewardsHome) {
      const keep = (it) => KEEP_RE.test(it.name) || taken.has(it.name) || needs.some((n) => n.test(it));
      if (inventoryItems(bot).some((it) => !keep(it))) {
        await teleportBy(bot, `/home ${rewardsHome}`);
        const { r } = await putIntoStorage(bot, null, (it) => !keep(it), Infinity);
        data.stored = countsData(r.moved);
        lines.push(`Награды (/home ${rewardsHome}): ${r.total ? `положил ${countsText(r.moved)}` : 'ничего не положил'}${r.full ? ' — сундук полон' : ''}`);
      }
    }
    return finish();
  } catch (err) {
    // У NPC все уровни пройдены — приносить некуда; это не сбой.
    if (err && (err.code === 'finished' || err.code === 'no_quests')) {
      lines.push(err.message);
      return finish();
    }
    // Что успели — в ответе; дальше — почему остановились.
    lines.push(`Остановился: ${err && err.message ? err.message : err}`);
    return { ok: false, code: (err && err.code) || 'failed', message: lines, data };
  }
}

/** «#купи сено 2 у Фермер» — купить у NPC в разделе «Покупка». */
/**
 * Купить товар из ячейки slot открытой «Покупки» один раз. Покупку подтверждает «Осталось»: уменьшилось —
 * куплено (счётчика нет — верим клику). → { ok } или { ok: false, why } (с тем, что сервер написал в чат).
 */
async function buyOnce(bot, slot) {
  const read = () => parseOffer(menuSlots(bot.currentWindow).find((s) => s.slot === slot) || { lore: [] });
  const before = read();
  if (before && before.left === 0) return { ok: false, why: 'товар закончился' };
  const chat = watchChat(bot);
  try {
    await clickAndSettle(bot, slot);
  } finally {
    chat.stop();
  }
  const after = read();
  if (before && after && before.left !== null && after.left !== null && after.left >= before.left) {
    const said = serverSaid(chat.lines, 1);
    return { ok: false, why: `сервер не продал${said ? ` — «${said}»` : ' (не хватило денег?)'}` };
  }
  return { ok: true };
}

async function cmdBuy({ bot, args, words }) {
  const at = words.indexOf('у');
  const npc = at >= 0 ? npcName(args.slice(at + 1).join(' ')) : QUEST_NPC;
  const head = at >= 0 ? args.slice(0, at) : args;
  const numIdx = head.findIndex((a) => /^\d+$/.test(a));
  const times = numIdx >= 0 ? Math.min(MAX_BUY, Math.max(1, parseInt(head[numIdx], 10))) : 1;
  const query = head.filter((_, i) => i !== numIdx).join(' ');
  if (!query) throw new CommandError('что купить? Например: #купи сено 2 (или #купи сено 2 у Алхимика)');
  try {
    await openShop(bot, npc);
    const offers = menuSlots(bot.currentWindow).map(parseOffer).filter(Boolean);
    const offer = offers.find((o) => matchesQuery(o.title, query) || matchesQuery(o.icon, query));
    if (!offer) throw new CommandError(`у ${npc} нет «${query}». Есть: ${offers.map((o) => o.title).join(', ') || 'ничего'}`);
    let bought = 0;
    let note = '';
    for (let i = 0; i < times; i += 1) {
      const r = await buyOnce(bot, offer.slot);
      if (!r.ok) {
        note = r.why;
        break;
      }
      bought += 1;
    }
    const price = offer.price !== null ? ` по ${offer.price}` : '';
    const msg = bought
      ? `Купил «${offer.title}»${offer.count > 1 ? ` (×${offer.count})` : ''} ${bought} ${plural(bought, 'раз', 'раза', 'раз')}${price}${note ? `; дальше ${note}` : ''}`
      : `Не купил «${offer.title}»: ${note || 'сервер не продал'}`;
    return { ok: bought > 0, code: bought ? undefined : 'not_bought', message: msg, data: { npc, item: offer.title, bought, price: offer.price } };
  } finally {
    await closeAfter(bot);
  }
}

async function cmdOpen({ bot, args }) {
  if (isCoords(args)) return useBlock(bot, parseBlockPos(args, bot.entity.position));
  const near = scanBlocks(bot, OPEN_RANGE + 1, (b) => isContainer(b.name)).filter((c) => c.dist <= OPEN_RANGE + 0.5);
  if (!near.length) throw new CommandError(`рядом нет сундука (до ${OPEN_RANGE} блоков) — подойди ближе или укажи X Y Z`);
  let lastError = null;
  for (const c of near.slice(0, 3)) {
    try {
      return await useBlock(bot, c.pos);
    } catch (err) {
      if (err && (err.code === 'replaced' || err.code === 'stopped')) throw err;
      lastError = err; // этот не виден — пробуем следующий
    }
  }
  throw lastError;
}

// ---------- склады: достать из сундука, положить в сундук ----------

const STORAGE_WAIT_MS = 1500; // сундук сервер открывает не мгновенно
const ALL_WORDS = new Set(['все', 'all', 'everything']); // norm() уже заменил «ё» на «е»
// «Сундук», «бочка»… в команде — место, а не предмет: «#достань из сундука пшеницу».
const CONTAINER_WORD = /^(сундук|бочк|бочон|ящик|шалкер|chest|barrel|shulker)/;
// «#положи всё» — кроме того, чем бот работает и что на нём надето.
const KEEP_RE = /_(?:pickaxe|axe|shovel|hoe|sword|helmet|chestplate|leggings|boots)$|^(?:shears|flint_and_steel|fishing_rod|brush|bow|crossbow|trident|mace|shield|elytra|totem_of_undying)$/;
// Слово про группу предметов: «семена» — любые семена, «рыба» — любая рыба.
const GROUP_WORDS = [
  [/^(семен|семян)/, /_seeds$/],
  [/^ягод/, /_berries$/],
  [/^рыб/, /^(cod|salmon|tropical_fish|pufferfish)$/],
];
const STORAGE_NAMES = { chest: 'Сундук', trapped_chest: 'Сундук-ловушка', barrel: 'Бочка', ender_chest: 'Эндер-сундук' };
const storageName = (name) => STORAGE_NAMES[name] || (/shulker_box$/.test(name) ? 'Шалкер' : name);
const countsText = (map) => [...map.entries()].map(([n, c]) => `${n}×${c}`).join(', ');
const countsData = (map) => [...map.entries()].map(([name, count]) => ({ name, count }));

/**
 * Подходит ли предмет под слова: точный id (wheat — только пшеница, без семян), по-русски (пшеница, земля,
 * кирка, семена — любые семена) или, если слова незнакомые, часть id или названия.
 */
function itemTest(query, registry = null) {
  const q = norm(query).replace(/^minecraft:/, '');
  const id = q.replace(/\s+/g, '_');
  if (registry && registry.itemsByName && registry.itemsByName[id]) return (it) => it.name === id;
  const parts = q.split(/[\s_]+/);
  const ru = deliverItems(q);
  const groups = GROUP_WORDS.filter(([re]) => parts.some((p) => re.test(p))).map(([, m]) => m);
  const word = ITEM_WORDS.find(([re]) => parts.some((p) => re.test(p)));
  const byWord = !word ? () => false : Array.isArray(word[1]) ? (n) => word[1].includes(n) : (n) => word[1].test(n);
  const known = ru.length > 0 || groups.length > 0 || Boolean(word);
  return (it) =>
    it.name === id || ru.includes(it.name) || groups.some((m) => m.test(it.name)) || byWord(it.name) ||
    (!known && ((id.length >= 3 && it.name.includes(id)) || norm(itemTitle(it)).includes(q)));
}

/**
 * Слова команды склада → { query, want, at }: что взять (пусто — всё), сколько (Infinity — всё), откуда
 * (координаты сундука или null — ближайший). preps — предлоги перед местом: «из» для #достань, «в» для #положи.
 */
function storageArgs(args, words, preps) {
  const rest = [];
  let at = null;
  for (let i = 0; i < args.length; i += 1) {
    if (preps.includes(words[i])) {
      const place = args.slice(i + 1);
      if (isCoords(place)) {
        at = place.slice(0, 3);
        i += 3;
      } else if (place.length && CONTAINER_WORD.test(words[i + 1])) {
        i += 1;
      } else if (place.length) {
        throw new CommandError(`не понял, что за сундук: «${place.join(' ')}» — подойди к сундуку или укажи ${preps[0]} X Y Z`);
      }
      continue;
    }
    if (!CONTAINER_WORD.test(words[i])) rest.push(i);
  }
  // Координаты в конце и без предлога: «#положи всё 10 64 -3».
  if (!at && rest.length >= 4 && isCoords(rest.slice(-3).map((i) => args[i]))) at = rest.splice(-3).map((i) => args[i]);
  let want = Infinity;
  const q = [];
  for (const i of rest) {
    if (want === Infinity && /^\d+$/.test(words[i])) want = Math.max(1, parseInt(words[i], 10));
    else if (!ALL_WORDS.has(words[i])) q.push(args[i]);
  }
  return { query: q.join(' '), want, at };
}

/** Подойти к блоку, если до него не дотянуться (поиск пути); не подойти вплотную — всё равно попробуем нажать. */
async function reachBlock(bot, pos) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= OPEN_RANGE) return;
  try {
    await navigate(bot, new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5), { range: 2.5, vertical: 3 });
  } catch (err) {
    if (!err || !['stuck', 'no_path', 'timeout'].includes(err.code)) throw err; // дотянуться можно и не подходя вплотную
  }
}

// «! К сожалению, Вы не можете открывать это в этом месте.» — сундук на чужой (защищённой) территории.
const NO_OPEN_RE = /не можете открывать|нельзя открывать|не можете использовать это/i;

/**
 * Открыть сундук и вернуть { window, pos, block }; окно остаётся открытым. at — координаты (слова «X Y Z» или
 * точка), null — ближайший сундук.
 */
async function openStorage(bot, at) {
  let list;
  if (at) {
    const pos = Array.isArray(at) ? parseBlockPos(at, bot.entity.position) : new Vec3(Math.floor(at.x), Math.floor(at.y), Math.floor(at.z));
    const block = bot.blockAt(pos);
    if (!block || !isContainer(block.name)) throw new CommandError(`в ${fmtPos(pos)} нет сундука${block ? ` (там ${block.name})` : ''}`);
    const dist = bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5));
    if (dist > MAX_WALK) throw new CommandError(`сундук в ${fmtPos(pos)} слишком далеко (${Math.round(dist)} блоков)`);
    list = [{ pos, block }];
  } else {
    list = scanBlocks(bot, OPEN_RANGE + 1, (b) => isContainer(b.name)).filter((c) => c.dist <= OPEN_RANGE + 0.5).slice(0, 3);
    if (!list.length) throw new CommandError(`рядом нет сундука (до ${OPEN_RANGE} блоков) — подойди ближе (например, /home у сундука) или укажи X Y Z`);
  }
  let lastError = null;
  for (const c of list) {
    try {
      await reachBlock(bot, c.pos);
      const before = bot.currentWindow;
      const chat = watchChat(bot);
      let w;
      try {
        await bot.actions.activate(c.pos);
        w = await waitNewWindow(bot, before, STORAGE_WAIT_MS);
      } finally {
        chat.stop();
      }
      if (!w) {
        const denied = chat.lines.find((l) => NO_OPEN_RE.test(l));
        if (denied) {
          throw new CommandError(`${storageName(c.block.name)} в ${fmtPos(c.pos)}: сервер не даёт открыть — «${denied.replace(/^[\s!|│]+/, '')}» (чужая или защищённая территория)`);
        }
        throw new CommandError(`${storageName(c.block.name)} в ${fmtPos(c.pos)} не открылся`);
      }
      if (!isStorageWindow(w)) {
        await closeAfter(bot);
        throw new CommandError(`в ${fmtPos(c.pos)} открылся не сундук, а «${windowTitle(w)}»`);
      }
      return { window: w, pos: c.pos, block: c.block };
    } catch (err) {
      if (err && (err.code === 'replaced' || err.code === 'stopped')) throw err;
      lastError = err; // этот не открылся — пробуем следующий
    }
  }
  throw lastError;
}

/** «#достань пшеница 224 [из X Y Z]» — взять из сундука в инвентарь (целыми стопками). */
async function cmdTake({ bot, args, words }) {
  if (!args.length) throw new CommandError('что достать? Например: #достань пшеница 224, #достань всё (из ближайшего сундука)');
  const { query, want, at } = storageArgs(args, words, ['из', 'from']);
  const test = query ? itemTest(query, bot.registry) : () => true;
  const chest = await openStorage(bot, at);
  try {
    const w = chest.window;
    const where = `${storageName(chest.block.name)} ${fmtPos(chest.pos)}`;
    const data = { chest: { block: chest.block.name, position: plain(chest.pos) }, want: Number.isFinite(want) ? want : null };
    if (!countIn(w, storageSlots(w), test)) {
      const inside = countsText(itemsIn(w, storageSlots(w)));
      return {
        ok: false,
        code: 'not_found',
        message: `${where}: ${query ? `нет «${query}»` : 'пусто'}${query ? (inside ? `. Там: ${inside}` : ' — там пусто') : ''}`,
        data: { ...data, moved: [], total: 0 },
      };
    }
    const r = await moveStacks(bot, w, storageSlots(w), playerSlots(w), test, want);
    const notes = [];
    if (Number.isFinite(want) && r.total > want) notes.push(`просили ${want} — беру целыми стопками`);
    if (Number.isFinite(want) && r.total < want && !r.full && !r.rejected) notes.push(`больше нет, просили ${want}`);
    if (r.full) notes.push('инвентарь полон');
    if (r.rejected) notes.push('сервер не дал взять');
    const result = { ...data, moved: countsData(r.moved), total: r.total, full: r.full };
    if (!r.total) return { ok: false, code: r.full ? 'full' : 'rejected', message: `${where}: ничего не достал — ${notes.join(', ')}`, data: result };
    return { ok: true, message: `${where}: достал ${countsText(r.moved)}${notes.length ? ` (${notes.join('; ')})` : ''}`, data: result };
  } finally {
    await closeAfter(bot);
  }
}

/** «#положи всё [в X Y Z]» — положить в сундук; «всё» — кроме инструментов, оружия и брони. */
async function cmdPut({ bot, args, words }) {
  if (!args.length) throw new CommandError('что положить? Например: #положи всё, #положи хлеб (в ближайший сундук)');
  const { query, want, at } = storageArgs(args, words, ['в', 'во', 'into', 'to']);
  const match = query ? itemTest(query, bot.registry) : null;
  const test = match || ((it) => !KEEP_RE.test(it.name)); // названный предмет — любой, даже кирку
  const inv = inventoryItems(bot);
  const kept = new Map();
  if (!match) for (const it of inv) if (KEEP_RE.test(it.name)) kept.set(it.name, (kept.get(it.name) || 0) + (it.count || 1));
  if (!inv.some(test)) {
    let why = 'инвентарь пуст';
    if (match) why = `в инвентаре нет «${query}»`;
    else if (kept.size) why = `в инвентаре только инструменты и броня (${countsText(kept)})`;
    return { ok: false, code: 'not_found', message: `Класть нечего: ${why}`, data: { moved: [], total: 0 } };
  }
  const { chest, r } = await putIntoStorage(bot, at, test, want);
  const where = `${storageName(chest.block.name)} ${fmtPos(chest.pos)}`;
  const notes = [];
  if (r.full) notes.push('сундук полон');
  if (r.rejected) notes.push('сервер не дал положить');
  if (kept.size) notes.push(`оставил себе: ${countsText(kept)}`);
  const result = { chest: { block: chest.block.name, position: plain(chest.pos) }, moved: countsData(r.moved), total: r.total, full: r.full };
  if (!r.total) return { ok: false, code: r.full ? 'full' : 'rejected', message: `${where}: ничего не положил — ${notes.join(', ')}`, data: result };
  return { ok: true, message: `${where}: положил ${countsText(r.moved)}${notes.length ? ` (${notes.join('; ')})` : ''}`, data: result };
}

/** Открыть сундук (at — как у openStorage) и положить в него то, что подходит под test (до want штук). */
async function putIntoStorage(bot, at, test, want) {
  const chest = await openStorage(bot, at);
  try {
    const w = chest.window;
    return { chest, r: await moveStacks(bot, w, playerSlots(w), storageSlots(w), test, want) };
  } finally {
    await closeAfter(bot);
  }
}

async function cmdEquip({ bot, args, words }) {
  if (words.includes('из') || words.includes('from')) return cmdTake({ bot, args, words }); // «#возьми пшеницу из сундука»
  if (!args.length) throw new CommandError('что взять? Например: #возьми кирка, #возьми земля, #возьми cobblestone');
  const item = findItem(bot, args.join(' '));
  await bot.actions.equip(item.name);
  return { ok: true, message: `В руке: ${bot.heldItem ? bot.heldItem.name : item.name}`, data: { item: item.name } };
}

async function cmdInventory({ bot }) {
  const items = inventoryItems(bot);
  const s = inventorySummary(items, 20);
  const held = bot.heldItem ? bot.heldItem.name : null;
  return {
    ok: true,
    message: [`В руке: ${held || 'ничего'}`, items.length ? `Инвентарь: ${s.text}` : 'Инвентарь пуст'],
    data: { held, items: s.list.map(([name, count]) => ({ name, count })) },
  };
}

async function cmdNearby({ bot }) {
  const players = playersNear(bot, 64).slice(0, 8);
  const chests = scanBlocks(bot, NEAR_CONTAINERS, (b) => isContainer(b.name)).slice(0, 5);
  const lines = [];
  lines.push(players.length
    ? `Игроки: ${players.map((p) => `${p.entity.username} — ${Math.round(p.dist)} бл. на ${directionTo(bot, p.entity.position)}`).join(', ')}`
    : 'Игроков рядом нет');
  lines.push(chests.length
    ? `Сундуки: ${chests.map((c) => `${c.block.name} в ${fmtPos(c.pos)} (${Math.round(c.dist)} бл.)`).join(', ')}`
    : `Сундуков рядом нет (до ${NEAR_CONTAINERS} блоков)`);
  return {
    ok: true,
    message: lines,
    data: {
      players: players.map((p) => ({ name: p.entity.username, distance: Math.round(p.dist * 10) / 10, position: plain(p.entity.position) })),
      containers: chests.map((c) => ({ block: c.block.name, position: plain(c.pos), distance: Math.round(c.dist * 10) / 10 })),
    },
  };
}

// ---------- бой: «#бей пауков 20» и задания «Убейте…» ----------

const FIGHT_IDLE_MS = 60 * 1000; // столько никого в досягаемости — бой окончен
const FIGHT_MAX_MS = 30 * 60 * 1000; // и не дольше получаса за раз (дальше — снова командой)
const FIGHT_WAIT_MS = 250; // пауза, пока ждём, что кто-нибудь подойдёт
const KILL_CONFIRM_MS = 4000; // цель умерла в течение стольких после нашего удара — наш счёт
const FIGHT_MIN_HEALTH = 6; // здоровья меньше (режим бога не спас) — из боя уходим
const MAX_KILLS = 1000;
const lastKillGoals = new Map(); // ник бота → Map(NPC → [{ title, mobs, left }]): «Убейте…» из последнего взгляда на задания

/** Задания «Убейте…» из меню заданий NPC — запомнить для #бей без слов (меню без заданий не трогает). */
function rememberKillGoals(bot, title, quests) {
  if (!quests.length) return;
  const npc = String(title || '').split('›')[0].trim() || '?';
  const goals = quests
    .filter((q) => q.kind === 'kill' && q.taken && !q.done && q.mobs && q.mobs.length && q.need > q.have)
    .map((q) => ({ title: q.title, mobs: q.mobs, left: q.need - q.have }));
  const key = norm(bot.username);
  if (!lastKillGoals.has(key)) lastKillGoals.set(key, new Map());
  lastKillGoals.get(key).set(npc, goals);
}

const hasCustomName = (e) => {
  try {
    return typeof e.getCustomName === 'function' && Boolean(e.getCustomName());
  } catch (_) {
    return false;
  }
};

/**
 * Кого бить: мобы нужных видов, до которых бот достаёт ударом не сходя с места (и не сквозь стену), ближние
 * первыми. Игроков (и NPC-«игроков») и мобов с именем (чьи-то питомцы, NPC) — никогда.
 */
function fightTargets(bot, wanted) {
  const me = bot.entity.position;
  return Object.values(bot.entities || {})
    .filter((e) => e && e !== bot.entity && e.type !== 'player' && e.position && wanted.has(e.name) && !hasCustomName(e))
    .filter((e) => bot.actions.canHit(e))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
}

/**
 * Бой на месте: бить мобов из goals ([{ mobs, left }] — left уменьшается по ходу), пока каждой цели не наберётся
 * или никого нет idleMs. Убитый — тот, кто умер вскоре после нашего удара. → { kills: Map(моб → сколько), note }
 */
async function fight(bot, goals, { idleMs = FIGHT_IDLE_MS, maxMs = FIGHT_MAX_MS } = {}) {
  const hitAt = new Map();
  const kills = new Map();
  const wanted = () => new Set(goals.filter((g) => g.left > 0).flatMap((g) => g.mobs));
  const onDead = (e) => {
    if (!e || !hitAt.has(e.id) || Date.now() - hitAt.get(e.id) > KILL_CONFIRM_MS) return;
    hitAt.delete(e.id);
    kills.set(e.name, (kills.get(e.name) || 0) + 1);
    const g = goals.find((x) => x.left > 0 && x.mobs.includes(e.name));
    if (g) g.left -= 1;
  };
  bot.on('entityDead', onDead);
  const started = Date.now();
  let idle = 0;
  let note = '';
  try {
    for (;;) {
      const mobs = wanted();
      if (!mobs.size) break; // всё набрали
      if (Date.now() - started > maxMs) {
        note = `прошло ${Math.round(maxMs / 60000)} мин — на один раз хватит`;
        break;
      }
      if (Number.isFinite(bot.health) && bot.health > 0 && bot.health < FIGHT_MIN_HEALTH) {
        note = `мало здоровья (${Math.round(bot.health)} из 20) — режим бога не помог`;
        break;
      }
      const target = fightTargets(bot, mobs)[0];
      if (!target) {
        if (await eatIfHungry(bot)) continue; // пока никого — поесть, если голоден
        if (idle >= idleMs) {
          note = `рядом никого ${Math.round(idleMs / 1000)} с`;
          break;
        }
        await bot.actions.wait(FIGHT_WAIT_MS);
        idle += FIGHT_WAIT_MS;
        continue;
      }
      idle = 0;
      hitAt.set(target.id, Date.now()); // до удара: сервер может ответить смертью раньше, чем удар «вернётся»
      try {
        await bot.actions.attack(target, { cooldownTicks: cooldownFor(bot.heldItem) });
        hitAt.set(target.id, Date.now());
      } catch (err) {
        if (err && (err.code === 'stopped' || err.code === 'replaced')) throw err;
        // цель пропала, отошла или за блоком — берём следующую
      }
    }
  } finally {
    bot.removeListener('entityDead', onDead);
  }
  return { kills, note };
}

/**
 * «#бей пауков 20», «#бей ифритов», «#бей» — для заданий «Убейте…», которые бот видел у NPC.
 * «… дом пауки» — сначала /home пауки (комната со спавнером), бой — там.
 */
async function cmdFight({ bot, args: allArgs, words = [] }) {
  const { home, args } = homeArg(allArgs, words, '#бей пауков 20 дом пауки');
  const num = args.find((a) => /^\d+$/.test(a));
  const text = args.filter((a) => a !== num).join(' ');
  let goals;
  if (text) {
    const mobs = mobsOf(text);
    if (!mobs.length) throw new CommandError(`не знаю, кто это: «${text}». Например: #бей пауков 20, #бей ифритов, #бей зомби`);
    goals = [{ title: null, mobs, left: num ? Math.min(MAX_KILLS, Math.max(1, parseInt(num, 10))) : Infinity }];
  } else {
    goals = [...(lastKillGoals.get(norm(bot.username)) || new Map()).values()].flat().filter((g) => g.left > 0);
    if (!goals.length) {
      throw new CommandError('кого бить? Например: #бей пауков 20. Без слов — для заданий «Убейте…», но таких бот не видел: сначала #квесты у NPC');
    }
  }
  if (home) await teleportBy(bot, `/home ${home}`);
  // Оружие: лучший меч, нет — лучший топор, нет и его — чем есть.
  for (const word of ['меч', 'топор']) {
    let item = null;
    try {
      item = findItem(bot, word);
    } catch (_) {
      continue;
    }
    if (!bot.heldItem || bot.heldItem.name !== item.name) await bot.actions.equip(item.name);
    break;
  }
  const r = await fight(bot, goals);
  const total = [...r.kills.values()].reduce((a, b) => a + b, 0);
  const lines = [total ? `Убил: ${[...r.kills.entries()].map(([id, n]) => `${mobName(id)} ×${n}`).join(', ')} — всего ${total}` : 'Никого не убил'];
  const finite = goals.filter((g) => Number.isFinite(g.left));
  const left = finite.filter((g) => g.left > 0);
  const reached = finite.length > 0 && !left.length;
  if (reached) lines.push(`Готово${goals.some((g) => g.title) ? ': для заданий хватит (засчитывается само)' : ''}`);
  if (r.note) lines.push(`Остановился: ${r.note}`);
  if (left.length) lines.push(`Ещё нужно: ${left.map((g) => `${g.title ? `${quote(g)} — ` : ''}${g.mobs.map(mobName).join('/')} ${g.left}`).join('; ')}`);
  const kills = Object.fromEntries(r.kills);
  const ok = total > 0 || reached;
  return { ok, code: ok ? undefined : 'no_targets', message: lines, data: { kills, total, left: left.map((g) => ({ title: g.title, mobs: g.mobs, left: g.left })) } };
}

// ---------- общее для работы «у дома»: подойти, подобрать выпавшее, «дом <имя>» в словах команды ----------

const WORK_REACH = 4; // дальше — сначала подойти (дотянуться можно на 4,4)
const isStopped = (err) => Boolean(err && (err.code === 'stopped' || err.code === 'replaced'));

/** «… дом пауки» в словах команды — { home, args без этих слов }; имя дома — как у /home. */
function homeArg(args, words, example) {
  const at = words.indexOf('дом');
  if (at < 0) return { home: null, args };
  const home = args[at + 1] || null;
  if (!home || !HOME_NAME_RE.test(home)) throw new CommandError(`какой дом? Например: ${example}`);
  return { home, args: args.filter((_, i) => i !== at && i !== at + 1) };
}

/** Свободных ячеек в инвентаре (без брони и второй руки). */
function freeSlots(bot) {
  const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : [];
  let free = 0;
  for (let i = 9; i < 45; i += 1) if (!slots[i]) free += 1;
  return free;
}

const hasItem = (bot, name) => inventoryItems(bot).some((it) => it.name === name);

/** Подойти, если клетка дальше вытянутой руки. Не дошёл (застрял, пути нет) — false; «#стоп» — дальше. */
async function comeClose(bot, pos, range = 2.2) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= WORK_REACH) return true;
  try {
    await navigate(bot, new Vec3(pos.x + 0.5, pos.y, pos.z + 0.5), { range, vertical: 3 });
    return true;
  } catch (err) {
    if (isStopped(err)) throw err;
    return false;
  }
}

/** Выпавший предмет (сущность «item»). */
const isDrop = (e) => Boolean(e && e.position && (e.name === 'item' || e.objectType === 'Item' || e.displayName === 'Item'));

/** Подобрать выпавшее рядом: пройти по предметам — сервер отдаёт их, когда игрок подходит вплотную. → сколько. */
async function collectDrops(bot, radius, limit = 64) {
  const seen = new Set();
  let n = 0;
  for (let i = 0; i < limit; i += 1) {
    const me = bot.entity.position;
    const drop = Object.values(bot.entities || {})
      .filter((e) => isDrop(e) && !seen.has(e.id) && e.position.distanceTo(me) <= radius)
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me))[0];
    if (!drop) break;
    seen.add(drop.id);
    if (freeSlots(bot) === 0) break;
    try {
      await navigate(bot, drop.position.clone(), { range: 0.6, vertical: 1 });
      n += 1;
    } catch (err) {
      if (isStopped(err)) throw err; // не дошёл до этого — следующий
    }
  }
  return n;
}

// ---------- урожай: собрать спелое, подобрать, посадить снова ----------

const HARVEST_RADIUS = 16;
const HARVEST_MAX = 300; // блоков за один раз
// Культура (блок) → когда спелая, что из неё выходит и что сажать обратно.
const CROPS = {
  wheat: { ripe: 7, seed: 'wheat_seeds', item: 'wheat' },
  carrots: { ripe: 7, seed: 'carrot', item: 'carrot' },
  potatoes: { ripe: 7, seed: 'potato', item: 'potato' },
  beetroots: { ripe: 3, seed: 'beetroot_seeds', item: 'beetroot' },
  nether_wart: { ripe: 3, seed: 'nether_wart', item: 'nether_wart', soil: 'soul_sand' },
  cocoa: { ripe: 2, item: 'cocoa_beans' },
  sweet_berry_bush: { ripe: 2, use: true, item: 'sweet_berries' }, // ягоды срывают правой кнопкой, куст остаётся
  melon: { whole: true, item: 'melon_slice' },
  pumpkin: { whole: true, item: 'pumpkin' },
  sugar_cane: { tall: true, item: 'sugar_cane' }, // нижний блок оставляем — вырастет снова
  cactus: { tall: true, item: 'cactus' },
  bamboo: { tall: true, item: 'bamboo' },
};
const CROP_OF_ITEM = Object.fromEntries(Object.entries(CROPS).map(([block, c]) => [c.item, block]));

/** Спелая ли культура: возраст, целый плод (арбуз, тыква) или второй снизу блок тростника, кактуса, бамбука. */
function isRipe(bot, block) {
  const c = CROPS[block.name];
  if (!c) return false;
  if (c.whole) return true;
  if (c.tall) {
    const below = bot.blockAt(block.position.offset(0, -1, 0));
    const below2 = bot.blockAt(block.position.offset(0, -2, 0));
    return Boolean(below && below.name === block.name && !(below2 && below2.name === block.name));
  }
  let age = 0;
  try {
    age = Number(block.getProperties().age) || 0;
  } catch (_) {
    age = 0;
  }
  return age >= c.ripe;
}

/**
 * Собрать спелое в радиусе: подойти, сломать (ягоды — сорвать), потом подобрать выпавшее и посадить семена туда,
 * где было. kinds — какие культуры (имена блоков). → { harvested: Map(предмет → блоков), planted, replant, picked, note, noSeed }
 */
async function harvest(bot, kinds, radius) {
  const want = new Set(kinds);
  const harvested = new Map();
  const replant = [];
  const skip = new Set();
  const key = (p) => `${p.x},${p.y},${p.z}`;
  let note = '';
  let count = 0;
  for (;;) {
    if (count >= HARVEST_MAX) {
      note = `за раз не больше ${HARVEST_MAX} блоков`;
      break;
    }
    if (freeSlots(bot) === 0) {
      note = 'инвентарь полон';
      break;
    }
    const next = scanBlocks(bot, radius, (b) => want.has(b.name)).find((x) => !skip.has(key(x.pos)) && isRipe(bot, x.block));
    if (!next) break;
    const c = CROPS[next.block.name];
    skip.add(key(next.pos)); // не вышло — к этой клетке не возвращаемся
    if (!(await comeClose(bot, next.pos))) continue;
    try {
      if (c.use) await bot.actions.activate(next.pos);
      else await bot.actions.dig(next.pos);
    } catch (err) {
      if (isStopped(err)) throw err;
      continue;
    }
    count += 1;
    harvested.set(c.item, (harvested.get(c.item) || 0) + 1);
    if (c.seed) replant.push({ pos: next.pos.clone(), seed: c.seed, soil: c.soil || 'farmland' });
  }
  const picked = count ? await collectDrops(bot, radius) : 0;
  let planted = 0;
  const noSeed = new Set();
  for (const r of replant) {
    const cell = bot.blockAt(r.pos);
    const soil = bot.blockAt(r.pos.offset(0, -1, 0));
    if (!cell || !/^(?:cave_|void_)?air$/.test(cell.name) || !soil || soil.name !== r.soil) continue;
    if (!hasItem(bot, r.seed)) {
      noSeed.add(r.seed);
      continue;
    }
    if (!(await comeClose(bot, r.pos))) continue;
    try {
      await bot.actions.plant(r.pos, { item: r.seed });
      planted += 1;
    } catch (err) {
      if (isStopped(err)) throw err;
    }
  }
  return { harvested, planted, replant: replant.length, picked, note, noSeed: [...noSeed] };
}

/** «#урожай», «#урожай пшеница», «#урожай морковь 24 дом ферма» — собрать спелое в радиусе и посадить снова. */
async function cmdHarvest({ bot, args: allArgs, words = [] }) {
  const { home, args } = homeArg(allArgs, words, '#урожай пшеница дом ферма');
  const num = args.find((a) => /^\d+$/.test(a));
  const radius = num ? Math.max(4, Math.min(32, parseInt(num, 10))) : HARVEST_RADIUS;
  const text = args.filter((a) => a !== num).join(' ');
  let kinds = Object.keys(CROPS);
  if (text) {
    kinds = [...new Set(deliverItems(text).map((id) => CROP_OF_ITEM[id]).filter(Boolean))];
    if (!kinds.length) throw new CommandError(`не знаю такой культуры: «${text}». Например: #урожай пшеница, #урожай (всё спелое)`);
  }
  if (home) await teleportBy(bot, `/home ${home}`);
  const r = await harvest(bot, kinds, radius);
  const total = [...r.harvested.values()].reduce((a, b) => a + b, 0);
  const lines = [total
    ? `Собрал: ${[...r.harvested.entries()].map(([id, n]) => `${id} ×${n}`).join(', ')} — блоков ${total}`
    : `Спелого рядом нет (радиус ${radius})`];
  if (r.picked) lines.push(`Подобрал выпавшее: ${r.picked}`);
  if (r.replant) lines.push(`Посадил снова: ${r.planted} из ${r.replant}${r.noSeed.length ? ` (нет семян: ${r.noSeed.join(', ')})` : ''}`);
  if (r.note) lines.push(`Остановился: ${r.note}`);
  return {
    ok: total > 0,
    code: total ? undefined : 'nothing',
    message: lines,
    data: { harvested: Object.fromEntries(r.harvested), total, planted: r.planted, picked: r.picked, note: r.note, home },
  };
}

// ---------- разведение: покормить пары взрослых животных ----------

const BREED_RADIUS = 16;
const BREED_COOLDOWN_MS = 5 * 60 * 1000; // после разведения животное 5 мин не размножается
const MAX_BREED_PAIRS = 32;
const MEAT = ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_rabbit', 'rotten_flesh'];
const FLOWERS = ['dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'sunflower', 'lilac', 'rose_bush', 'peony'];
// Чем кормить для разведения (как в игре 1.21).
const BREED_FOOD = {
  cow: ['wheat'], mooshroom: ['wheat'], sheep: ['wheat'], goat: ['wheat'],
  pig: ['carrot', 'potato', 'beetroot'],
  chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds', 'torchflower_seeds', 'pitcher_pod'],
  rabbit: ['carrot', 'golden_carrot', 'dandelion'],
  horse: ['golden_carrot', 'golden_apple', 'enchanted_golden_apple'], donkey: ['golden_carrot', 'golden_apple', 'enchanted_golden_apple'],
  llama: ['hay_block'], camel: ['cactus'], panda: ['bamboo'], fox: ['sweet_berries', 'glow_berries'], turtle: ['seagrass'],
  wolf: MEAT, cat: ['cod', 'salmon'], bee: FLOWERS, frog: ['slime_ball'], strider: ['warped_fungus'], hoglin: ['crimson_fungus'],
  sniffer: ['torchflower_seeds'], armadillo: ['spider_eye'], axolotl: ['tropical_fish_bucket'],
};
const lastFed = new Map(); // id животного → когда покормили (не кормить, пока не прошло 5 мин)
// Детёныш: у AgeableMob в 1.20.5+ — ячейка 16 метаданных «baby» (minecraft-data 1.21.11: metadataKeys[16]).
const isBaby = (e) => Boolean(e.metadata && e.metadata[16] === true);
const FOOD_NAMES = {
  wheat: 'пшеница', carrot: 'морковь', potato: 'картофель', beetroot: 'свёкла', wheat_seeds: 'семена пшеницы',
  beetroot_seeds: 'семена свёклы', melon_seeds: 'семена арбуза', pumpkin_seeds: 'семена тыквы', golden_carrot: 'золотая морковь',
  golden_apple: 'золотое яблоко', dandelion: 'одуванчик', hay_block: 'сено', cactus: 'кактус', bamboo: 'бамбук',
  sweet_berries: 'сладкие ягоды', glow_berries: 'светящиеся ягоды', seagrass: 'морская трава', cod: 'треска', salmon: 'лосось',
  slime_ball: 'слизь', warped_fungus: 'искажённый гриб', crimson_fungus: 'багровый гриб', torchflower_seeds: 'семена факельника',
  spider_eye: 'паучий глаз', beef: 'говядина', porkchop: 'свинина',
};
/** «пшеница (wheat)» / «морковь (carrot), картофель (potato) или свёкла (beetroot)» — чем кормить вид. */
function foodText(kind) {
  const list = (BREED_FOOD[kind] || []).slice(0, 3).map((f) => `${FOOD_NAMES[f] || f} (${f})`);
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} или ${list[list.length - 1]}` : list[0] || '?';
}
/** Расстояние от глаз бота до ближайшей точки сущности (так считает досягаемость игра). */
function reachTo(bot, e) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  const w = (e.width || 0.6) / 2;
  const p = e.position;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const q = new Vec3(clamp(eye.x, p.x - w, p.x + w), clamp(eye.y, p.y, p.y + (e.height || 1)), clamp(eye.z, p.z - w, p.z + w));
  return eye.distanceTo(q);
}

/** Что за предмет лежит на земле (сущность «item»): имя или null. */
function droppedName(e) {
  try {
    const it = typeof e.getDroppedItem === 'function' ? e.getDroppedItem() : e.droppedItem;
    return it && it.name ? it.name : null;
  } catch (_) {
    return null;
  }
}

/**
 * Корм для вида kind: из инвентаря; нет — подобрать брошенный рядом (человек кинул боту, Q) или взять из сундука
 * рядом (до 4 блоков, как #достань). → { food: имя | null, from: 'инвентарь' | 'подобрал' | 'сундук' }
 */
async function getFood(bot, kind, want) {
  const foods = BREED_FOOD[kind] || [];
  const inHand = () => foods.find((f) => hasItem(bot, f)) || null;
  let food = inHand();
  if (food) return { food, from: 'инвентарь' };
  const me = bot.entity.position;
  const drops = Object.values(bot.entities || {})
    .filter((e) => isDrop(e) && e.position.distanceTo(me) <= 8 && foods.includes(droppedName(e)))
    .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
  for (const d of drops) {
    try {
      await navigate(bot, d.position.clone(), { range: 0.5, vertical: 1 });
      await bot.actions.wait(500); // сервер отдаёт предмет, когда игрок вплотную
    } catch (err) {
      if (isStopped(err)) throw err;
    }
    food = inHand();
    if (food) return { food, from: 'подобрал' };
  }
  const chests = scanBlocks(bot, OPEN_RANGE + 1, (b) => isContainer(b.name)).filter((c) => c.dist <= OPEN_RANGE + 0.5);
  if (chests.length) {
    try {
      await takeFromStorage(bot, [{ test: (it) => foods.includes(it.name), want: Math.max(2, want), got: 0 }]);
    } catch (err) {
      if (isStopped(err)) throw err;
    }
    food = inHand();
    if (food) return { food, from: 'сундук' };
  }
  return { food: null, from: null };
}

/**
 * Покормить пары взрослых животных (kinds — виды), чтобы они размножились: не больше pairs пар. Корм — то, что есть
 * у бота для этого вида. → { pairs, fed, byKind: Map(вид → пар), noFood: [вид], few: [вид] }
 */
async function breed(bot, kinds, pairs, radius = BREED_RADIUS) {
  const byKind = new Map();
  const noFood = [];
  const few = [];
  const got = []; // откуда взял корм: «пшеница — из сундука»
  let done = 0;
  let fed = 0;
  for (const kind of kinds) {
    if (done >= pairs) break;
    const { food, from } = await getFood(bot, kind, (pairs - done) * 2);
    if (!food) {
      noFood.push(kind);
      continue;
    }
    if (from !== 'инвентарь') got.push(`${FOOD_NAMES[food] || food} — ${from === 'сундук' ? 'взял из сундука рядом' : 'подобрал с земли'}`);
    const now = Date.now();
    const me = bot.entity.position;
    const adults = Object.values(bot.entities || {})
      .filter((e) => e && e.name === kind && e.position && !isBaby(e) && e.position.distanceTo(me) <= radius)
      .filter((e) => !(lastFed.has(e.id) && now - lastFed.get(e.id) < BREED_COOLDOWN_MS))
      .sort((a, b) => a.position.distanceTo(me) - b.position.distanceTo(me));
    if (adults.length < 2) {
      few.push(kind);
      continue;
    }
    for (let i = 0; i + 1 < adults.length && done < pairs; i += 2) {
      if (!hasItem(bot, food)) break;
      let ok = 0;
      for (const animal of [adults[i], adults[i + 1]]) {
        if (!bot.entities[animal.id]) continue;
        try {
          if (reachTo(bot, animal) > 2.7) {
            try {
              await navigate(bot, animal.position.clone(), { range: 1.8 });
            } catch (err) {
              if (isStopped(err)) throw err; // в загон не пройти (забор) — дотянуться можно и через него
            }
          }
          await bot.actions.equip(food);
          await bot.actions.interact(animal);
          lastFed.set(animal.id, Date.now());
          ok += 1;
          fed += 1;
        } catch (err) {
          if (isStopped(err)) throw err;
        }
      }
      if (ok === 2) {
        done += 1;
        byKind.set(kind, (byKind.get(kind) || 0) + 1);
      }
    }
  }
  return { pairs: done, fed, byKind, noFood, few, got };
}

/** «#разведи коров», «#разведи кур 5 дом загон» — покормить пары взрослых животных (на всех — сколько есть пар). */
async function cmdBreed({ bot, args: allArgs, words = [] }) {
  const { home, args } = homeArg(allArgs, words, '#разведи коров 5 дом загон');
  const num = args.find((a) => /^\d+$/.test(a));
  const pairs = num ? Math.max(1, Math.min(MAX_BREED_PAIRS, parseInt(num, 10))) : MAX_BREED_PAIRS;
  const text = args.filter((a) => a !== num).join(' ');
  const kinds = mobsOf(text).filter((m) => BREED_FOOD[m]);
  if (!kinds.length) throw new CommandError(`кого разводить? Например: #разведи коров, #разведи кур 5 (знаю: коровы, овцы, свиньи, куры, кролики, козы, лошади…)`);
  if (home) await teleportBy(bot, `/home ${home}`);
  const r = await breed(bot, kinds, pairs);
  const lines = [];
  if (r.got.length) lines.push(`Корм: ${r.got.join('; ')}`);
  lines.push(r.pairs
    ? `Покормил пар: ${r.pairs} (${[...r.byKind.entries()].map(([k, n]) => `${mobName(k)} ×${n}`).join(', ')}) — малыши появятся через пару секунд`
    : 'Никого не покормил');
  for (const k of r.noFood) {
    lines.push(`Нет корма (${mobName(k)}) — подойдёт: ${foodText(k)}. В инвентаре бота нет, рядом на земле нет, в сундуке рядом (до 4 блоков) нет. ` +
      'Дай боту: выброси рядом с ним (Q) или положи в сундук рядом — он возьмёт сам');
  }
  if (r.few.length) lines.push(`Мало взрослых рядом (до ${BREED_RADIUS} блоков) или прошло меньше 5 мин после прошлого раза: ${r.few.map(mobName).join(', ')}`);
  return { ok: r.pairs > 0, code: r.pairs ? undefined : r.noFood.length ? 'no_food' : 'no_animals', message: lines, data: { pairs: r.pairs, fed: r.fed, noFood: r.noFood, few: r.few, home } };
}

// ---------- добыча руды: где искать, лестница вниз, туннель с рудой в стенах ----------

// Руды 1.21: блоки, что из них выпадает, лучшая высота и где искать (распределение руд в 1.18+).
const ORES = {
  coal: { name: 'уголь', blocks: ['coal_ore', 'deepslate_coal_ore'], item: 'coal', best: 96, tier: 0, where: 'везде выше Y 0, больше всего — Y ≈ 96 и в горах' },
  copper: { name: 'медь', blocks: ['copper_ore', 'deepslate_copper_ore'], item: 'raw_copper', best: 48, tier: 1, where: 'Y −16…112, больше всего — Y ≈ 48 и в пещерах с капельником' },
  iron: { name: 'железо', blocks: ['iron_ore', 'deepslate_iron_ore'], item: 'raw_iron', best: 16, tier: 1, where: 'Y −64…72, больше всего — Y ≈ 16 (и высоко в горах, Y ≈ 232)' },
  lapis: { name: 'лазурит', blocks: ['lapis_ore', 'deepslate_lapis_ore'], item: 'lapis_lazuli', best: 0, tier: 1, where: 'Y −64…64, больше всего — Y ≈ 0' },
  gold: { name: 'золото', blocks: ['gold_ore', 'deepslate_gold_ore'], item: 'raw_gold', best: -16, tier: 2, where: 'Y −64…32, больше всего — Y ≈ −16; в пустошах (badlands) — и у поверхности' },
  redstone: { name: 'редстоун', blocks: ['redstone_ore', 'deepslate_redstone_ore'], item: 'redstone', best: -58, tier: 2, where: 'Y −64…15, больше всего — Y ≈ −58' },
  diamond: { name: 'алмазы', blocks: ['diamond_ore', 'deepslate_diamond_ore'], item: 'diamond', best: -58, tier: 2, where: 'Y −64…16, больше всего — Y ≈ −58' },
  emerald: { name: 'изумруды', blocks: ['emerald_ore', 'deepslate_emerald_ore'], item: 'emerald', best: 232, tier: 2, where: 'только в горах, Y −16…320, больше всего — Y ≈ 232' },
  quartz: { name: 'кварц', blocks: ['nether_quartz_ore'], item: 'quartz', best: 15, tier: 0, nether: true, where: 'Незер, Y 10…117' },
  nether_gold: { name: 'золото Незера', blocks: ['nether_gold_ore'], item: 'gold_nugget', best: 15, tier: 0, nether: true, where: 'Незер, Y 10…117' },
  debris: { name: 'древние обломки', blocks: ['ancient_debris'], item: 'ancient_debris', best: 15, tier: 3, nether: true, where: 'Незер, Y 8…22, больше всего — Y ≈ 15' },
};
const ORE_WORDS = [
  [/(?:^|\s)(?:незерск\S*\s+золот|золот\S*\s+незер)/, 'nether_gold'], [/(?:^|\s)(?:древн|обломк)/, 'debris'],
  [/(?:^|\s)(?:угол|угл[яеиь]|coal)/, 'coal'], [/(?:^|\s)(?:мед[ьи]|copper)/, 'copper'], [/(?:^|\s)(?:желез|iron)/, 'iron'],
  [/(?:^|\s)(?:лазурит|lapis)/, 'lapis'], [/(?:^|\s)(?:золот|gold)/, 'gold'], [/(?:^|\s)(?:редстоун|красн\S*\s+пыл|redstone)/, 'redstone'],
  [/(?:^|\s)(?:алмаз|diamond)/, 'diamond'], [/(?:^|\s)(?:изумруд|emerald)/, 'emerald'], [/(?:^|\s)(?:кварц|quartz)/, 'quartz'],
];
const PICK_TIERS = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 4 };
const TIER_NAMES = ['деревянная', 'каменная', 'железная', 'алмазная'];
const MINE_SCAN_CHUNKS = 2; // руду ищем в 5×5 чанках вокруг, во всю высоту мира (видна и та, что в толще камня)
const MINE_REACH = 40; // к руде прокапываемся не дальше (по горизонтали)
const MINE_RESCAN_MOVE = 6; // ушёл от места поиска дальше — искать заново (ближние руды — уже другие)
const MINE_MAX_HOPS = 16; // рядом руды нет — столько раз копать дальше (вглубь или вбок) и искать снова
const MINE_HOP_DOWN = 8;
const MINE_HOP_SIDE = 8; // ход вбок короче: анти-X-ray открывает руду только у ходов — чаще оглядываться
const RTP_CMD = '/rtp';
const RTP_WAIT_MS = 20000; // /rtp ищет место — дольше обычного телепорта
// 26 соседей блока: жила — руда рядом с только что выкопанной.
const AROUND = [];
for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) if (dx || dy || dz) AROUND.push(new Vec3(dx, dy, dz));
const MINE_FLOOR_Y = -58; // ниже — бедрок
const MINE_MAX_MS = 15 * 60 * 1000;
const LIQUID_RE = /^(?:lava|water|flowing_lava|flowing_water)$/;
// Чем строить «столб» (подняться на свою высоту): простые блоки, которые и так набираются при копании.
const PILLAR_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'netherrack', 'stone', 'deepslate', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt', 'calcite', 'end_stone', 'coarse_dirt', 'sandstone'];

const oreOf = (text) => {
  const t = ` ${norm(text)}`;
  const hit = ORE_WORDS.find(([re]) => re.test(t));
  return hit ? hit[1] : null;
};
const posKey = (p) => `${p.x},${p.y},${p.z}`;
// Остановили, бот погиб или вышел — копать дальше нечем.
const isFatal = (err) => isStopped(err) || Boolean(err && (err.code === 'interrupted' || err.code === 'not_ready'));
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, -1, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];

/** Рядом с блоком вода или лава: сломаешь — потечёт на бота. */
const nearLiquid = (bot, pos) => SIDES.some((d) => {
  const b = bot.blockAt(pos.plus(d));
  return b && LIQUID_RE.test(b.name);
});
/** Блок касается воздуха (пещера, свой ход): такую руду анти-X-ray не подделывает. */
const touchesAir = (bot, pos) => SIDES.some((d) => {
  const b = bot.blockAt(pos.plus(d));
  return b && /^(?:cave_|void_)?air$/.test(b.name);
});
const MINE_DENIED = 'сервер не даёт ломать блоки здесь (спавн, варп, чужой приват или лобби)';
/** Чем строить «столб»: самый многочисленный простой блок в инвентаре (булыжник, земля…) или null. */
function pillarItem(bot) {
  const counts = new Map();
  for (const it of inventoryItems(bot)) {
    if (PILLAR_BLOCKS.includes(it.name)) counts.set(it.name, (counts.get(it.name) || 0) + (it.count || 1));
  }
  let best = null;
  for (const [name, n] of counts) if (!best || n > best[1]) best = [name, n];
  return best ? best[0] : null;
}

const feetY = (bot) => Math.floor(bot.entity.position.y + 0.01);

/**
 * Вернуться туда, откуда начал копать: по выкопанному, где нужно — «столбом» (блок под себя) или прокапываясь.
 * Туда не выходит — хотя бы на ту же высоту рядом. → { ok, moved, y, why? }
 */
async function climbBack(bot, start, opts, guarded = (fn) => fn()) {
  const startY = Math.floor(start.y + 0.01);
  if (bot.entity.position.distanceTo(start) < 1.5) return { ok: true, moved: false, y: startY };
  try {
    await guarded(() => bot.actions.digTo(start, { range: 0.6, vertical: 0, maxDistance: 160, maxNodes: 30000, ...opts() }));
    return { ok: true, moved: true, y: startY };
  } catch (err) {
    if (isFatal(err)) throw err;
    if (feetY(bot) >= startY) return { ok: false, moved: false, y: feetY(bot), why: err.message };
    try {
      const p = bot.entity.position;
      await guarded(() => bot.actions.digTo(new Vec3(p.x, startY, p.z), { range: 6, vertical: 0, maxDistance: 32, maxNodes: 20000, ...opts() }));
      return { ok: true, moved: true, y: startY, nearby: true };
    } catch (err2) {
      if (isFatal(err2)) throw err2;
      return { ok: false, moved: false, y: feetY(bot), why: err2.message };
    }
  }
}

/**
 * Добыть руду: найти её в загруженном мире (5×5 чанков вокруг, вся высота — и спрятанную в толще камня, если сервер
 * её прислал) и прокопаться прямо
 * к ближайшей: вперёд, ступеньками, под себя; выкопать, потом следующую (жила — рядом). Руды рядом нет — вглубь к
 * лучшей высоте (по MINE_HOP_DOWN блоков), на ней — вбок, и снова искать. В конце — обратно на свою высоту: по
 * выкопанному, а где нужно — «столбом». Вода и лава рядом, гравий над головой, бедрок — в обход; полный
 * инвентарь, 15 минут — стоп. Сервер не даёт ломать (спавн, приват) — стоп сразу (denied). Дошёл до руды, а там
 * камень (анти-X-ray показывает ненастоящую) — дальше только руда у воздуха и у своих ходов (antiXray).
 * → { mined, dug, hops, note, denied, antiXray, fails: [{ text, count }], y, startY, back }
 */
async function mine(bot, ore, want, pick, progress = {}) {
  const ids = new Set(ore.blocks);
  const start = bot.entity.position.clone();
  const skip = new Set();
  const dugAt = new Set(); // где ломали сами: в 2 блоках от них анти-X-ray уже показал настоящее
  const started = Date.now();
  let mined = 0;
  let dug = 0;
  let hops = 0;
  let note = '';
  let rejected = 0; // сервер вернул сломанный блок
  let vanished = 0; // дошёл до руды — а её нет
  let antiXray = false;
  const fails = new Map(); // почему не прокопался: текст → сколько раз
  const failed = (err) => {
    const text = String(err && err.message ? err.message : err).replace(/^не прокопаться к [-\d]+ [-\d]+ [-\d]+: /, '');
    fails.set(text, (fails.get(text) || 0) + 1);
    if (err && err.code === 'rejected') rejected += 1;
  };
  let lastOre = null; // последняя выкопанная руда: рядом с ней — жила
  const onDig = (block, pos) => {
    dug += 1;
    if (pos) dugAt.add(posKey(pos));
    if (block && ids.has(block.name)) {
      mined += 1; // руда на пути — тоже добыча
      progress.mined = mined; // сколько уже есть — если прервут, задача продолжит с остатка
      if (pos) lastOre = pos.clone();
    }
  };
  // Анти-X-ray (Paper, update-radius 2) открывает настоящее не кубом, а «крестом»: до 2 шагов по осям от сломанного.
  const nearDug = (pos) => {
    for (const k of dugAt) {
      const [x, y, z] = k.split(',').map(Number);
      if (Math.abs(x - pos.x) + Math.abs(y - pos.y) + Math.abs(z - pos.z) <= 2) return true;
    }
    return false;
  };
  // Руда, до которой идём: без воды и лавы рядом; после подделок — только та, что видна по-настоящему.
  const usable = (pos) => !skip.has(posKey(pos)) && !nearLiquid(bot, pos) && (!antiXray || touchesAir(bot, pos) || nearDug(pos));
  // Кирка — лучшая из оставшихся (прежняя могла сломаться за сотни блоков).
  const toolNow = () => {
    const picks = inventoryItems(bot).filter((it) => PICK_TIERS[it.name] !== undefined && PICK_TIERS[it.name] >= ore.tier)
      .sort((a, b) => PICK_TIERS[b.name] - PICK_TIERS[a.name]);
    return picks.length ? picks[0].name : null;
  };
  const opts = () => ({ tool: toolNow(), item: pillarItem(bot), onDig });
  // Где руда: поиск по чанкам вокруг (кусками — бот не замирает и тики не опаздывают), очередь от ближних; искать
  // заново — когда очередь кончилась или бот ушёл от места поиска. Сначала — жила: соседи только что выкопанной
  // руды (их видно и при анти-X-ray — сервер открывает всё рядом со сломанным).
  const oreEntries = ore.blocks.map((name) => ({ name, label: name, color: '#ffffffff', on: true, same: false }));
  const isOre = (p) => {
    const b = bot.blockAt(p);
    return Boolean(b && ids.has(b.name));
  };
  let queue = [];
  let scannedAt = null;
  const revealed = []; // руда, которую сервер только что открыл рядом с ходом
  async function rescan() {
    const r = await scanXray(bot, { blocks: oreEntries, lava: false, radius: MINE_SCAN_CHUNKS }, { limit: 256 });
    const here = bot.entity.position;
    const all = [];
    for (const g of r.groups) for (let i = 0; i < g.positions.length; i += 3) all.push(new Vec3(g.positions[i], g.positions[i + 1], g.positions[i + 2]));
    const dist = (p) => Math.hypot(p.x + 0.5 - here.x, p.y + 0.5 - here.y, p.z + 0.5 - here.z);
    all.sort((a, b) => dist(a) - dist(b));
    queue = all;
    scannedAt = here.clone();
  }
  async function nextTarget() {
    // Только что открылась рядом (сервер прислал клетку, пока бот копал ход) — её первой.
    while (revealed.length) {
      const p = revealed.shift();
      if (isOre(p) && usable(p) && !skip.has(posKey(p))) return p;
    }
    if (lastOre) {
      const vein = AROUND.map((d) => lastOre.plus(d)).find((p) => isOre(p) && usable(p));
      if (vein) return vein;
      lastOre = null;
    }
    if (!scannedAt || !queue.length || bot.entity.position.distanceTo(scannedAt) > MINE_RESCAN_MOVE) await rescan();
    while (queue.length) {
      const p = queue.shift();
      if (isOre(p) && usable(p)) return p;
    }
    return null;
  }
  // Сторож: враг рядом или пора поесть — текущее действие прерывается (код «threat»), бот отбивается или ест и
  // продолжает то же самое (src/bot/survival.js). Щит — во вторую руку: от крипера.
  const guard = createGuard(bot);
  const guarded = async (fn) => {
    for (let i = 0; ; i += 1) {
      try {
        return await fn();
      } catch (err) {
        if (!err || err.code !== 'threat' || i >= 30) throw err;
        await guard.handle();
      }
    }
  };
  // Анти-X-ray открывает настоящую руду, когда рядом ломают блоки: сервер присылает клетку. Нужная руда открылась
  // рядом, пока бот копает ход (или идёт к дальней), — бросить ход и взять её сразу.
  let roaming = false; // идёт ход или путь к руде (их можно прервать ради открывшейся рядом)
  const onBlock = (oldBlock, newBlock) => {
    if (!newBlock || !newBlock.position || !ids.has(newBlock.name) || (oldBlock && ids.has(oldBlock.name))) return;
    const p = newBlock.position;
    if (skip.has(posKey(p)) || p.distanceTo(bot.entity.position) > 6) return;
    revealed.push(p.clone());
    if (roaming && !guard.busy && bot.actions.busy) bot.actions.interrupt('рядом открылась руда', 'found');
  };
  bot.on('blockUpdate', onBlock);
  try {
    // Щит — во вторую руку до сторожа: зомби рядом прервал бы перекладывание, и весь раз бот был бы без щита
    // (от крипера только отходил бы). Перекладывание — полсекунды.
    await prepareShield(bot);
    guard.start();
    return await mineLoop();
  } finally {
    guard.stop();
    bot.removeListener('blockUpdate', onBlock);
  }

  async function mineLoop() {
    const yaw = bot.entity.yaw;
    let dir = Math.abs(Math.sin(yaw)) > Math.abs(Math.cos(yaw)) ? new Vec3(-Math.sign(Math.sin(yaw)), 0, 0) : new Vec3(0, 0, -Math.sign(Math.cos(yaw)));
    while (mined < want) {
      if (guard.wants()) await guard.handle();
      if (freeSlots(bot) === 0) {
        note = 'инвентарь полон';
        break;
      }
      if (Date.now() - started > MINE_MAX_MS) {
        note = 'прошло 15 мин — на один раз хватит';
        break;
      }
      if (rejected >= 2) {
        note = MINE_DENIED;
        break;
      }
      if (!toolNow()) {
        note = 'кирка сломалась — дай боту новую';
        break;
      }
      const target = await nextTarget();
      if (target) {
        const key = posKey(target);
        skip.add(key);
        try {
          roaming = true;
          try {
            await guarded(() => bot.actions.digTo(target, { reach: true, maxDistance: MINE_REACH, ...opts() }));
          } finally {
            roaming = false;
          }
          const b = bot.blockAt(target);
          if (b && ids.has(b.name)) {
            const tool = toolNow();
            if (tool) await guarded(() => bot.actions.equip(tool));
            await guarded(() => bot.actions.dig(target));
            onDig(b, target);
          } else if (!dugAt.has(key)) {
            // Дошёл — а руды нет, и ломал её не он: сервер показывал ненастоящую (анти-X-ray), подошёл — открыл камень.
            vanished += 1;
            if (vanished >= 2) antiXray = true;
          }
        } catch (err) {
          if (isFatal(err)) throw err;
          if (err && err.code === 'found') {
            // По дороге рядом открылась руда — сначала её, к этой — потом.
            skip.delete(key);
            queue.unshift(target);
            continue;
          }
          failed(err); // не прокопаться (вода, лава, бедрок, сервер не дал) — к следующей
        }
        continue;
      }
      // Руды рядом не видно: вглубь к лучшей высоте, на ней — вбок; и снова искать.
      if (hops >= MINE_MAX_HOPS) {
        note = `рядом руды нет — ${hops} раз копал дальше и искал снова, на один раз хватит`;
        break;
      }
      hops += 1;
      const feet = bot.entity.position.floored();
      const deeper = feet.y > ore.best + 1 && feet.y > MINE_FLOOR_Y;
      let moved = false;
      for (let turn = 0; turn < 4 && !moved; turn += 1) {
        const down = Math.min(MINE_HOP_DOWN, feet.y - Math.max(ore.best, MINE_FLOOR_Y));
        const to = deeper ? feet.offset(dir.x * 4 * Math.sign(turn), -down, dir.z * 4 * Math.sign(turn)) : feet.plus(dir.scaled(MINE_HOP_SIDE));
        try {
          roaming = true;
          try {
            await guarded(() => bot.actions.digTo(to, { range: deeper ? 2.5 : 1.5, vertical: 0, maxDistance: 24, ...opts() }));
          } finally {
            roaming = false;
          }
          moved = true;
        } catch (err) {
          if (isFatal(err)) throw err;
          if (err && err.code === 'found') {
            moved = true; // ход прерван: рядом открылась руда — за ней
            break;
          }
          failed(err);
          if (rejected >= 2) break;
          dir = new Vec3(-dir.z, 0, dir.x); // туда не прокопаться — в другую сторону
        }
      }
      if (rejected >= 2) {
        note = MINE_DENIED;
        break;
      }
      if (!moved) {
        const last = [...fails.keys()].pop();
        note = `дальше не прокопаться${last ? `: ${last}` : ''}`;
        break;
      }
    }
    const back = await climbBack(bot, start, opts, guarded);
    const toolEnd = toolNow();
    if (toolEnd && back.moved) {
      try {
        await guarded(() => bot.actions.equip(toolEnd)); // после столба в руке булыжник — снова кирку
      } catch (err) {
        if (isFatal(err)) throw err;
      }
    }
    return {
      mined, dug, hops, note, denied: rejected >= 2, antiXray, vanished,
      fails: [...fails].map(([text, count]) => ({ text, count })).sort((a, b) => b.count - a.count),
      y: feetY(bot), startY: Math.floor(start.y + 0.01), back, guard: guard.stats,
    };
  }
}

/** Лучшая подходящая для руды кирка в инвентаре (имя) или null. */
function pickFor(bot, ore) {
  const picks = inventoryItems(bot).filter((it) => PICK_TIERS[it.name] !== undefined && PICK_TIERS[it.name] >= ore.tier)
    .sort((a, b) => PICK_TIERS[b.name] - PICK_TIERS[a.name]);
  return picks.length ? picks[0].name : null;
}

const noPickaxe = (text) => Object.assign(new CommandError(text), { code: 'no_pickaxe' });

/**
 * «#добудь лазурит [N] [дом X] [здесь]». Кирка — своя; нет подходящей — с общего дома (дом X или «Дом склада» из
 * настроек: /home, сундуки рядом). Копать — после /rtp (случайное место: там можно ломать); «здесь» — на месте.
 */
async function cmdMine({ bot, args: allArgs, words = [] }) {
  const { home, args: rest } = homeArg(allArgs, words, '#добудь лазурит 20 дом база');
  const hereAt = rest.findIndex((a) => /^(?:здесь|тут|here)$/.test(norm(a)));
  const here = hereAt >= 0;
  const args = rest.filter((_, i) => i !== hereAt);
  const num = args.find((a) => /^\d+$/.test(a));
  const want = num ? Math.max(1, Math.min(512, parseInt(num, 10))) : 32;
  const text = args.filter((a) => a !== num).join(' ');
  const key = oreOf(text);
  if (!key) {
    throw new CommandError(`какую руду? Например: #добудь железо 20. Знаю: ${Object.values(ORES).map((o) => o.name).join(', ')}`);
  }
  const ore = ORES[key];
  const dim = () => (bot.game && bot.game.dimension ? String(bot.game.dimension) : '');
  if (ore.nether && dim() && !/nether/.test(dim())) throw new CommandError(`«${ore.name}» — только в Незере (${ore.where}); бот сейчас не там`);
  const lines = [];
  // 1. Снаряжение: нет кирки (или брони, щита, мало еды) — на общий дом, там лучшее из сундуков (#снаряжение).
  let pick = pickFor(bot, ore);
  const base = home || String((bot.panelConfig && bot.panelConfig.questStorage) || '').trim();
  if (!pick && !base) {
    throw noPickaxe(`нет кирки для «${ore.name}» (нужна не хуже: ${TIER_NAMES[ore.tier]}) — дай боту кирку или укажи общий дом, где в сундуке лежат кирки: «Дом склада» в настройках автопилота или #добудь ${text} дом база`);
  }
  if (base && (!pick || gearMissing(bot))) {
    await teleportBy(bot, `/home ${base}`);
    let why = '';
    try {
      const g = await gearUp(bot, { pickTier: ore.tier });
      lines.push(`Общий дом «${base}»: ${g.lines[0].replace(/^Снаряжение: /, '')}`, ...g.lines.slice(1));
    } catch (err) {
      if (isFatal(err)) throw err;
      why = `: ${err.message}`;
    }
    pick = pickFor(bot, ore);
    if (!pick) throw noPickaxe(`на общем доме «${base}» нет кирки не хуже: ${TIER_NAMES[ore.tier]}${why || ' (в сундуках рядом)'} — положи туда кирки`);
  }
  // 2. Где копать: случайное место (/rtp) — там можно ломать; или прямо здесь.
  if (!here) {
    await teleportBy(bot, RTP_CMD, { waitMs: RTP_WAIT_MS });
    const p = bot.entity.position;
    lines.push(`${RTP_CMD}: копаю у ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
  }
  await bot.actions.equip(pick);
  const progress = { mined: 0 };
  const junkHome = String((bot.panelConfig && bot.panelConfig.questJunk) || '').trim();
  let r;
  let total = 0;
  let dugTotal = 0;
  for (let trips = 0; ; trips += 1) {
    progress.mined = 0;
    try {
      r = await mine(bot, ore, want - total, pick, progress);
    } catch (err) {
      // Прервали (бот вышел, переход на другой сервер): задача (src/tasks.js) продолжит с остатка, а не с начала.
      const done = total + progress.mined;
      if (err && typeof err === 'object' && done > 0 && done < want) {
        err.resume = `#добудь ${text} ${want - done}${here ? ' здесь' : ''}${home ? ` дом ${home}` : ''}`;
      }
      throw err;
    }
    total += r.mined;
    dugTotal += r.dug;
    // Инвентарь забился — мусор в сундуки «Дома мусора» и дальше копать (на новом месте после /rtp).
    if (r.note !== 'инвентарь полон' || !junkHome || total >= want || trips >= MAX_JUNK_TRIPS || !junkItems(bot).length) break;
    await teleportBy(bot, `/home ${junkHome}`);
    const d = await depositJunk(bot);
    lines.push(`Инвентарь забился — мусор в сундуки у дома «${junkHome}»: ${d.put.size ? countsText(d.put) : 'положить не вышло'}`);
    if (!freeSlots(bot) || here) break; // место не освободилось; «здесь» — назад на то место не попасть
    await teleportBy(bot, RTP_CMD, { waitMs: RTP_WAIT_MS });
    const p = bot.entity.position;
    lines.push(`${RTP_CMD}: копаю дальше у ${Math.floor(p.x)} ${Math.floor(p.y)} ${Math.floor(p.z)}`);
    pick = pickFor(bot, ore) || pick;
    await bot.actions.equip(pick);
  }
  r = { ...r, mined: total, dug: dugTotal };
  lines.push(r.mined
    ? `Добыл: ${ore.name} — блоков руды ${r.mined} (выпадает ${ore.item})`
    : r.denied ? `Не добыл «${ore.name}»: ${MINE_DENIED}` : `Руды «${ore.name}» не нашёл`);
  if (r.denied) {
    lines.push(here
      ? `Здесь копать нельзя — без «здесь» бот сам уйдёт на случайное место: #добудь ${text}`
      : `${RTP_CMD} привёл туда, где копать нельзя, — повтори: #добудь ${text} (будет другое место)`);
  }
  if (r.dug > r.mined) lines.push(`Прокопал к руде блоков: ${r.dug - r.mined}`);
  if (!r.back.ok) lines.push(`На свою высоту (Y ${r.startY}) не вернулся: ${r.back.why}. Бот на Y ${r.y}`);
  else if (r.back.moved) lines.push(`Вернулся ${r.back.nearby ? 'на свою высоту' : 'туда, откуда начал'} (Y ${r.startY})`);
  if (r.antiXray) {
    lines.push(`Похоже, на сервере анти-X-ray: ${r.vanished} раз дошёл до руды — а там камень (сервер показывает ненастоящую). ` +
      'Дальше брал только открытую — у пещер и в своих ходах; рентген в «Экране бота» тоже показывает и ненастоящую');
  }
  const g = r.guard || {};
  if (g.kills) {
    const byName = new Map();
    for (const n of g.killed || []) byName.set(n, (byName.get(n) || 0) + 1);
    lines.push(`Отбился от мобов: ${[...byName].map(([n, k]) => `${mobName(n)} ×${k}`).join(', ')}`);
  }
  if (g.blocked) lines.push(`От крипера закрывался щитом: ${g.blocked} ${plural(g.blocked, 'раз', 'раза', 'раз')}`);
  if (g.ate) lines.push(`Поел: ${g.ate} ${plural(g.ate, 'раз', 'раза', 'раз')}`);
  if (g.hungry) lines.push('Голоден, а еды нет — положи боту еду (хлеб, жареное мясо)');
  if (r.note && !r.denied) lines.push(`Остановился: ${r.note}`);
  if (!r.mined && !r.denied && r.fails.length) {
    lines.push(`Не прокопался к руде: ${r.fails.slice(0, 2).map((f) => `${f.text}${f.count > 1 ? ` (×${f.count})` : ''}`).join('; ')}`);
  }
  if (r.mined < want && !r.denied) lines.push(`Где искать: ${ore.where}`);
  return {
    ok: r.mined > 0,
    code: r.mined ? undefined : r.denied ? 'protected' : 'not_found',
    message: lines,
    data: { ore: key, item: ore.item, mined: r.mined, dug: r.dug, y: r.y, back: r.back.ok, note: r.note, denied: r.denied, antiXray: r.antiXray },
  };
}

// ---------- рентген: что из списка (руды, спавнеры…) есть в загруженных чанках вокруг ----------

const XRAY_TOP = 10; // строк с координатами, когда спрашивают про один блок
const HIDDEN_MIN = 12; // столько руды «только у воздуха» — уже не случайность

/** Руда вся у воздуха (пещеры, ходы), а в толще камня — ни одной? Так бывает, когда сервер её прячет. → { total, buried } */
function oreExposure(bot, groups) {
  let total = 0;
  let buried = 0;
  const open = (b) => !b || !b.shapes || !b.shapes.length || /(?:air|water|lava|glass|leaves|ice|slab|stairs|torch|pane|fence|wall)/.test(b.name);
  for (const g of groups) {
    if (!/(?:_ore|ancient_debris)$/.test(g.key || '')) continue;
    for (let i = 0; i < g.positions.length && total < 400; i += 3) {
      const p = new Vec3(g.positions[i], g.positions[i + 1], g.positions[i + 2]);
      total += 1;
      if (!SIDES.some((d) => open(bot.blockAt(p.plus(d))))) buried += 1;
    }
  }
  return { total, buried };
}
const HIDDEN_ORE_NOTE = 'Вся найденная руда — у воздуха (пещеры, шахты), а в толще камня — ни одной: так бывает, когда сервер прячет руду ' +
  '(анти-X-ray) — вместо неё присылает камень, и её не видит ни мод, ни бот. Настоящую сервер открывает, когда рядом ломают блоки ' +
  '(в 2 блоках от выкопанного): #добудь так её и находит — копает ходы на нужной высоте и сразу берёт открывшуюся';

/**
 * «#рентген» — что из списка рентгена (настройки панели, «Экран бота» → G) есть вокруг и где ближайшее;
 * «#рентген алмазы» — до 10 ближайших с координатами; «… радиус 4» (или просто число) — радиус в чанках.
 */
async function cmdXray({ bot, args, words = [] }) {
  const settings = sanitizeXray(bot.panelConfig && bot.panelConfig.xray);
  let radius;
  const rest = [];
  for (let i = 0; i < words.length; i += 1) {
    if (/^(?:радиус|radius|r)$/.test(words[i]) && /^\d+$/.test(args[i + 1] || '')) {
      radius = parseInt(args[i + 1], 10);
      i += 1;
    } else if (/^\d+$/.test(words[i]) && radius === undefined) {
      radius = parseInt(words[i], 10);
    } else {
      rest.push(words[i]);
    }
  }
  let cfg = settings;
  let asked = null;
  if (rest.length) {
    asked = findEntries(settings, rest, registryOf(bot));
    if (!asked.length) {
      throw new CommandError(`что искать? Например: #рентген алмазы, #рентген спавнер, #рентген diamond_ore. В списке: ${settings.blocks.map((b) => b.label.toLowerCase()).join(', ')}, лава`);
    }
    cfg = { ...settings, blocks: asked.filter((e) => e.name !== 'lava').map((e) => ({ ...e, on: true })), lava: asked.some((e) => e.name === 'lava') };
  }
  const r = await scanXray(bot, cfg, radius === undefined ? {} : { radius });
  const side = r.radius * 2 + 1;
  const where = `радиус ${r.radius} ${plural(r.radius, 'чанк', 'чанка', 'чанков')}, ${side}×${side}`;
  const p = bot.entity.position;
  const distTo = (x, y, z) => Math.round(Math.hypot(x + 0.5 - p.x, y + 0.5 - p.y, z + 0.5 - p.z));
  const found = r.groups.filter((g) => g.count);
  const lines = [];
  if (!found.length) {
    lines.push(`Рентген (${where}): ${asked ? asked.map((e) => e.label).join(', ') : 'ничего из списка'} — не нашёл`);
    lines.push('Смотрит загруженные чанки вокруг бота. Если на сервере анти-X-ray, руда в толще камня спрятана — видна только открытая (в пещерах)');
  } else if (asked) {
    for (const g of found) {
      lines.push(`Рентген: ${g.label} ×${g.count}${r.truncated ? '+' : ''} (${where}), ближние:`);
      for (let i = 0; i < Math.min(XRAY_TOP, g.positions.length / 3); i += 1) {
        const [x, y, z] = g.positions.slice(i * 3, i * 3 + 3);
        lines.push(`  ${x} ${y} ${z} — ${distTo(x, y, z)} бл.`);
      }
    }
  } else {
    lines.push(`Рентген (${where}): найдено ${r.total}${r.truncated ? '+' : ''}`);
    for (const g of found) lines.push(`${g.label} ×${g.count} — ближайший ${g.nearest.x} ${g.nearest.y} ${g.nearest.z} (${Math.round(g.nearest.dist)} бл.)`);
    const none = r.groups.filter((g) => !g.count).map((g) => g.label.toLowerCase());
    if (none.length) lines.push(`Нет: ${none.join(', ')}`);
  }
  const exposure = oreExposure(bot, found);
  const hidden = exposure.total >= HIDDEN_MIN && exposure.buried === 0;
  if (hidden) lines.push(HIDDEN_ORE_NOTE);
  return {
    ok: true,
    message: lines,
    data: {
      radius: r.radius,
      total: r.total,
      hiddenOre: hidden,
      groups: r.groups.map((g) => ({ key: g.key, label: g.label, count: g.count, nearest: g.nearest, positions: g.positions.slice(0, XRAY_TOP * 3) })),
    },
  };
}

// ---------- пинг ----------

const PING_SAMPLES = 3;
const PING_TIMEOUT_MS = 3000;
const { performance } = require('perf_hooks');
const lowId = (v) => (Array.isArray(v) ? v[1] : typeof v === 'bigint' ? Number(BigInt.asIntN(32, v)) : Number(v));

/**
 * Один замер: ping_request → ping_response — тем же пакетом обычный клиент рисует график пинга в F3; сервер
 * отвечает сразу. Миллисекунды туда и обратно или null (не ответил).
 */
function measureRtt(bot, timeoutMs = PING_TIMEOUT_MS) {
  const client = bot._client;
  if (!client || typeof client.write !== 'function' || typeof client.on !== 'function') return Promise.resolve(null);
  const id = 1 + Math.floor(Math.random() * 0x7ffffffe);
  return new Promise((resolve) => {
    let timer = null;
    const started = performance.now();
    const onPong = (packet) => {
      if (packet && lowId(packet.id) === id) done(Math.round(performance.now() - started));
    };
    function done(value) {
      clearTimeout(timer);
      client.removeListener('ping_response', onPong);
      resolve(value);
    }
    timer = setTimeout(() => done(null), timeoutMs);
    client.on('ping_response', onPong);
    try {
      client.write('ping_request', { id: [0, id] });
    } catch (_) {
      done(null);
    }
  });
}

/**
 * Пинг бота: несколько замеров самим ботом и пинг из Tab (как считает сервер), с выводом, где задержка.
 * Ждёт обычными таймерами, а не bot.actions.wait: замер не должен прерывать то, что бот делает.
 */
async function pingReport(bot, { samples: count = PING_SAMPLES, timeoutMs = PING_TIMEOUT_MS, gapMs = 250 } = {}) {
  const samples = [];
  for (let i = 0; i < count; i += 1) {
    if (i) await new Promise((r) => setTimeout(r, gapMs));
    const rtt = await measureRtt(bot, timeoutMs);
    if (rtt === null) break; // не ответил — ждать ещё раз бессмысленно
    samples.push(rtt);
  }
  const shown = bot.player && Number.isFinite(bot.player.ping) ? bot.player.ping : null;
  const best = samples.length ? Math.min(...samples) : null;
  const lines = [
    best === null
      ? `Замер ботом: сервер не ответил за ${timeoutMs / 1000} с`
      : `Замер ботом: ${samples.join(', ')} мс — столько пакет идёт до сервера и обратно (как график пинга в F3)`,
    shown === null ? 'Пинг в Tab: сервер его ещё не прислал' : `Пинг в Tab: ${shown} мс — так его считает сервер`,
  ];
  if (best !== null && shown !== null && shown > best * 2 + 40) {
    lines.push('Связь у бота быстрая — лишнее в Tab добавляет сам сервер, когда считает пинг бота (не сеть и не панель)');
  } else if (best !== null && best > 120) {
    lines.push('Пакеты бота правда идут долго: задержка на пути до сервера');
  }
  return { ok: true, message: lines, data: { samples, best, shown } };
}

/** «#пинг»: сколько на самом деле идут пакеты бота (замер ботом) и какой пинг показывает сервер в Tab. */
async function cmdPing({ bot }) {
  if (!bot._client || bot._client.state !== 'play') throw new CommandError('бот сейчас не в игре (переходит на другой сервер?) — попробуй через пару секунд');
  return pingReport(bot);
}

async function cmdStop({ bot }) {
  const had = bot.actions.stop();
  return { ok: true, message: had ? 'Остановлено' : 'Бот ничего не делал', data: { stopped: had } };
}

/** #охрана — что с охраной; #охрана вкл — следить прямо сейчас (бот уже на месте); #охрана выкл. */
async function cmdGuard({ bot, words }) {
  if (!bot) return { ok: false, code: 'not_ready', message: 'Команда не выполнена: бот не в мире' };
  const guard = bot.guard;
  if (!guard) return { ok: false, code: 'unsupported', message: 'Охраны у этого бота нет' };
  const w = words[0] || '';
  if (['вкл', 'включи', 'on', 'да', 'следи'].includes(w)) {
    if (!guard.enabled) return { ok: false, code: 'disabled', message: 'Охрана выключена в настройках панели («Охрана и режим бога»)' };
    if (!guard.activateNow('включена командой')) {
      return { ok: false, code: 'at_spawn', message: 'Бот на спавне — здесь охрана не нужна (включится сама после /home или /rtp)' };
    }
    return { ok: true, message: guard.status(), data: { armed: true } };
  }
  if (['выкл', 'выключи', 'off', 'нет'].includes(w)) {
    guard.disarm('выключена командой');
    return { ok: true, message: 'Охрана выключена до следующего /home или /rtp', data: { armed: false } };
  }
  if (w) return { ok: false, code: 'bad_args', message: 'Так: #охрана, #охрана вкл или #охрана выкл' };
  return { ok: true, message: guard.status(), data: { armed: guard.armed, active: guard.active, pvp: Boolean(guard.inPvp) } };
}

/**
 * Все команды. name — главное имя (по-русски), aliases — другие написания, usage — как писать (первая строка —
 * главная форма), about — что делает. observe — только смотрит, ничего не меняет.
 */
const COMMANDS = [
  { name: 'помощь', aliases: ['help', 'команды', '?'], usage: ['#помощь'], about: 'список команд', observe: true, needsWorld: false, run: cmdHelp },
  { name: 'где', aliases: ['pos', 'позиция', 'координаты'], usage: ['#где'], about: 'где бот, куда смотрит, здоровье, на какой блок смотрит', observe: true, run: cmdWhere },
  {
    name: 'смотри',
    aliases: ['look', 'посмотри', 'повернись'],
    usage: ['#смотри на <ник>', '#смотри вниз | вверх | прямо | налево | направо | назад', '#смотри север | юг | запад | восток', '#смотри X Y Z', '#смотри <поворот> <наклон>'],
    about: 'повернуть голову: на игрока, в сторону, на блок или на угол (как в F3)',
    run: cmdLook,
  },
  {
    name: 'иди',
    aliases: ['goto', 'go', 'подойди'],
    usage: ['#иди ко мне', '#иди к <ник или имя NPC>', '#иди X Y Z [бегом]', '#иди вперёд 3 [бегом]'],
    about: 'дойти, обходя стены и ямы (поиск пути): запрыгивает на блок выше, спускается до 3 блоков, плывёт; лаву, огонь, кактусы ' +
      'обходит; далеко (до 256 блоков) — по частям, пока догружается мир; пути нет — скажет',
    run: cmdGo,
  },
  { name: 'вперёд', aliases: ['forward'], usage: ['#вперёд 3 [бегом]'], about: 'пройти N блоков вперёд', run: walkCommand(0) },
  { name: 'назад', aliases: ['back'], usage: ['#назад 2'], about: 'развернуться и пройти N блоков', run: walkCommand(180) },
  { name: 'налево', aliases: ['влево', 'left'], usage: ['#налево 2'], about: 'повернуть налево и пройти N блоков', run: walkCommand(-90) },
  { name: 'направо', aliases: ['вправо', 'right'], usage: ['#направо 2'], about: 'повернуть направо и пройти N блоков', run: walkCommand(90) },
  {
    name: 'копай',
    aliases: ['dig', 'сломай', 'ломай'],
    usage: ['#копай', '#копай впереди | под | над', '#копай X Y Z'],
    about: 'сломать блок: на который смотрит, рядом или по координатам',
    run: cmdDig,
  },
  {
    name: 'поставь',
    aliases: ['place', 'построй'],
    usage: ['#поставь [предмет]', '#поставь впереди [предмет]', '#поставь X Y Z [предмет]'],
    about: 'поставить блок туда, куда смотрит (или впереди, или по координатам); предмет — например, земля',
    run: cmdPlace,
  },
  {
    name: 'нажми',
    aliases: ['use', 'используй'],
    usage: ['#нажми Фермер', '#нажми @<номер из #сущности>', '#нажми', '#нажми X Y Z'],
    about: 'нажать на NPC (меню останется открытым) или на блок: дверь, рычаг, кнопку (сундук откроет и закроет)',
    run: cmdUse,
  },
  { name: 'окно', aliases: ['menu', 'меню', 'window'], usage: ['#окно'], about: 'что в открытом меню: номера ячеек, названия, описания (квесты)', observe: true, run: cmdWindow },
  { name: 'клик', aliases: ['click', 'кликни'], usage: ['#клик <ячейка> [правой]'], about: 'кликнуть по ячейке открытого меню (номер — из #окно)', run: cmdClick },
  { name: 'закрой', aliases: ['close', 'esc'], usage: ['#закрой'], about: 'закрыть открытое меню', run: cmdClose },
  { name: 'сущности', aliases: ['entities', 'нпс', 'npc'], usage: ['#сущности'], about: 'кто и что рядом: NPC, мобы, надписи — с номерами для #нажми @номер', observe: true, run: cmdEntities },
  { name: 'открой', aliases: ['open'], usage: ['#открой', '#открой X Y Z'], about: 'открыть ближайший сундук, показать, что внутри, и закрыть', run: cmdOpen },
  {
    name: 'достань',
    aliases: ['withdraw', 'вынь', 'забери'],
    usage: ['#достань пшеница 224', '#достань всё', '#достань <предмет> [сколько] [из X Y Z]'],
    about: 'взять из ближайшего сундука (до 4 блоков) или из сундука по координатам — целыми стопками',
    run: cmdTake,
  },
  {
    name: 'положи',
    aliases: ['deposit', 'сложи', 'убери'],
    usage: ['#положи всё', '#положи хлеб', '#положи <предмет | всё> [сколько] [в X Y Z]'],
    about: 'положить в ближайший сундук (или по координатам); «всё» — кроме инструментов, оружия и брони',
    run: cmdPut,
  },
  { name: 'возьми', aliases: ['equip', 'вруку'], usage: ['#возьми <предмет>'], about: 'взять в руку; можно по-русски: земля, булыжник, доски, кирка, меч… («из сундука» — как #достань)', run: cmdEquip },
  { name: 'инвентарь', aliases: ['inv', 'инв'], usage: ['#инвентарь'], about: 'что у бота в руке и в инвентаре', observe: true, run: cmdInventory },
  { name: 'рядом', aliases: ['near', 'кто'], usage: ['#рядом'], about: 'игроки и сундуки поблизости', observe: true, run: cmdNearby },
  {
    name: 'бей',
    aliases: ['убей', 'бить', 'attack', 'fight'],
    usage: ['#бей пауков 20', '#бей ифритов', '#бей', '#бей пауков 20 дом пауки'],
    about: 'бить мобов рядом, не сходя с места (в досягаемости, не сквозь стену; игроков и мобов с именем не трогает): ' +
      'N штук или пока подходят; без слов — сколько нужно для заданий «Убейте…» (бот запоминает их у NPC); ' +
      '«дом пауки» — сначала /home пауки (комната со спавнером)',
    run: cmdFight,
  },
  {
    name: 'урожай',
    aliases: ['собери', 'собрать', 'harvest', 'ферма'],
    usage: ['#урожай', '#урожай пшеница', '#урожай морковь 24', '#урожай дом ферма'],
    about: 'собрать спелое в радиусе (по умолчанию 16): пшеница, морковь, картофель, свёкла, незерский нарост, какао, ягоды, ' +
      'арбузы, тыквы, тростник, кактус, бамбук — подойти, сломать, подобрать выпавшее и посадить семена обратно; «дом ферма» — сначала /home ферма',
    run: cmdHarvest,
  },
  {
    name: 'добудь',
    aliases: ['добыть', 'шахта', 'mine'],
    usage: ['#добудь железо', '#добудь алмазы 5', '#добудь уголь 64 дом база', '#добудь лазурит здесь'],
    about: 'добыть руду (уголь, медь, железо, лазурит, золото, редстоун, алмазы, изумруды; в Незере — кварц, золото, древние обломки): ' +
      'нет подходящей кирки, брони, щита или еды — идёт на общий дом («дом X» или «Дом склада» из настроек) и берёт там лучшее ' +
      '(как #снаряжение), потом /rtp и копает там ' +
      '(«здесь» — на месте); находит руду в чанках вокруг и прокапывается прямо к ней — вперёд, под себя, ступеньками, сначала жила; ' +
      'рядом нет — вглубь к лучшей высоте (железо Y≈16, алмазы и редстоун Y≈−58…), там ходами вбок (открылась руда у хода — сразу к ней); ' +
      'потом обратно на свою высоту (где нужно — «столбом»); за работой ест (хлеб, мясо из инвентаря) и отбивается от мобов мечом, ' +
      'от крипера — щитом во второй руке; у воды, лавы, под гравием не копает; где копать нельзя — скажет сразу; не нашёл — скажет, где искать',
    run: cmdMine,
  },
  {
    name: 'снаряжение',
    aliases: ['снарядись', 'экипировка', 'экипируйся', 'gear'],
    usage: ['#снаряжение', '#снаряжение дом база'],
    about: `собрать снаряжение со склада: /home (дом X или «Дом склада» из настроек; без них — сундуки рядом), осмотреть все сундуки ` +
      `до ${STORAGE_RANGE} блоков и взять лучшее, где бы оно ни лежало: броня на 4 места, меч, кирка (незерит → алмаз → железо…), ` +
      `щит во вторую руку, еда — до ${FOOD_WANT} штук (любая, кроме вредной); броню надевает сам; чего нет нигде — скажет`,
    run: cmdGear,
  },
  {
    name: 'очисти',
    aliases: ['очистить', 'мусор', 'выгрузи', 'clean'],
    usage: ['#очисти', '#очисти дом мусор', '#очисти здесь'],
    about: 'сложить мусор из инвентаря в сундуки: землю, камень разных видов, гравий, песок, адский камень, кремень, семена, ' +
      'гнилую плоть, ядовитый картофель — на «Дом мусора» из настроек (или дом X; «здесь» — в сундуки рядом); сундук полон — в ' +
      'следующий; одну стопку блоков (булыжник) оставляет себе для «столба»; песок душ, чернокамень, кости, нитки — не мусор. ' +
      '#добудь делает это сам, когда инвентарь забился',
    run: cmdClean,
  },
  {
    name: 'рентген',
    aliases: ['xray', 'иксрей', 'рентгент'],
    usage: ['#рентген', '#рентген алмазы', '#рентген спавнер радиус 4'],
    about: 'рентген, как мод Advanced XRay: что из списка (руды, спавнеры…) есть в загруженных чанках вокруг бота — сколько и где ближайшее; ' +
      'с названием — до 10 ближайших с координатами; радиус — в чанках (0–8, по умолчанию из настроек). Список, цвета и подсветку сквозь ' +
      'стены настраивают в «Экране бота»: клавиша G — меню, \\ — включить',
    observe: true,
    run: cmdXray,
  },
  {
    name: 'разведи',
    aliases: ['развести', 'разводи', 'breed'],
    usage: ['#разведи коров', '#разведи кур 5', '#разведи овец дом загон'],
    about: 'покормить пары взрослых животных рядом, чтобы родились малыши (корм — как в игре: коровам и овцам пшеница, свиньям морковь, ' +
      'курам семена…; он должен быть у бота); число — сколько пар; одних и тех же — не чаще раза в 5 мин; «дом загон» — сначала /home загон',
    run: cmdBreed,
  },
  {
    name: 'пинг',
    aliases: ['ping', 'задержка'],
    usage: ['#пинг'],
    about: 'задержка связи: замер самим ботом (как график пинга в F3) и пинг, который показывает сервер в Tab',
    observe: true,
    run: cmdPing,
  },
  { name: 'стоп', aliases: ['stop', 'хватит', 'стой'], usage: ['#стоп'], about: 'остановить действие', run: cmdStop },
  {
    name: 'квесты',
    aliases: ['quests', 'задания'],
    usage: ['#квесты', '#квесты взять', '#квесты сдать', '#квесты купить', '#квесты уровень', '#квесты принести урожай награды', '#квесты у Алхимика', '#квесты взять у Оружейника'],
    about: 'задания NPC (по умолчанию Фермер, у /warp ah): показать; взять все новые; сдать из инвентаря; купить — для «Купите у NPC ' +
      'товаров на N» (за деньги бота); уровень — повысить (взять, сдать, купить и принести повышают сами, когда все задания выполнены); ' +
      'принести — всё для «Передайте…» со склада (/home урожай), «Купите…» у NPC, сдать и сложить награды (/home награды)',
    notes: questRules(), // правила заданий (какой NPC когда открывается) — для ИИ
    run: cmdQuests,
  },
  {
    name: 'купи',
    aliases: ['buy', 'купить'],
    usage: ['#купи сено 2', '#купи <товар> [сколько раз] [у <NPC>]'],
    about: 'купить у NPC в разделе «Покупка» (по умолчанию у Фермера); каждая покупка проверяется по «Осталось»',
    run: cmdBuy,
  },
  {
    name: 'охрана',
    aliases: ['guard'],
    usage: ['#охрана', '#охрана вкл', '#охрана выкл'],
    about: 'охрана вне спавна: следит ли она, кто был рядом; вкл — следить сразу (бот уже на месте), выкл — перестать',
    needsWorld: false,
    run: cmdGuard,
  },
];

function findCommand(word) {
  const w = norm(word);
  return COMMANDS.find((c) => norm(c.name) === w || c.aliases.some((a) => norm(a) === w)) || null;
}

/** Описание всех команд (для ИИ и справки): имя, другие имена, как писать, что делает; notes — правила игры к команде. */
function catalog() {
  return COMMANDS.map(({ name, aliases, usage, about, observe, notes }) => ({
    name, aliases: [...aliases], usage: [...usage], about, observe: Boolean(observe), ...(notes ? { notes: [...notes] } : {}),
  }));
}

/**
 * Выполнить строку с командой. log(level, text) — консоль панели (каждая строка ответа отдельно).
 * @returns {Promise<{ ok: boolean, message: string | string[], data?: object, code?: string }>}
 */
async function runCommand(bot, line, log = () => {}) {
  const tokens = String(line === undefined ? '' : line).trim().replace(/^#\s*/, '').split(/\s+/).filter(Boolean);
  const cmd = findCommand(tokens[0] || 'помощь');
  let result;
  if (!cmd) {
    result = { ok: false, code: 'unknown', message: `Неизвестная команда «#${tokens[0]}». Список: #помощь` };
  } else if (cmd.needsWorld !== false && (!bot || !bot.entity)) {
    result = { ok: false, code: 'not_ready', message: 'Команда не выполнена: бот не в мире' };
  } else if (cmd.needsWorld !== false && (!bot.actions || !bot.serverView)) {
    result = { ok: false, code: 'unsupported', message: 'Команда не выполнена: действия работают только со своей физикой бота' };
  } else {
    const args = tokens.slice(1);
    try {
      result = await cmd.run({ bot, args, words: args.map(norm) });
    } catch (err) {
      const code = err && err.code ? err.code : 'failed';
      result = { ok: false, code, message: `#${cmd.name}: ${err && err.message ? err.message : err}` };
      // Команда знает, где остановилась (#добудь — сколько осталось): задача продолжит с этого места.
      if (err && typeof err.resume === 'string') result.data = { resume: err.resume };
    }
  }
  let level = 'ok';
  if (!result.ok) level = ['unknown', 'not_ready', 'unsupported'].includes(result.code) ? 'warn' : ['replaced', 'stopped'].includes(result.code) ? 'info' : 'error';
  else if (cmd.observe) level = 'info';
  for (const text of [].concat(result.message)) log(level, text);
  return result;
}

module.exports = { runCommand, catalog, findCommand, findItem, itemTest, storageArgs, parseCoord, parseBlockPos, f3Yaw, f3Pitch, pingReport, COMMANDS };
