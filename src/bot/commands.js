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
  parseQuestMenu, parseOffer, describeQuest, matchesQuery, deliverItems, parseQuestChat, sameTitle, questNpc, questRules,
} = require('./quests');
const { isStorageWindow } = require('./window-clicks');
const { moveStacks, countIn, itemsIn, storageSlots, playerSlots } = require('./chests');

const MAX_WALK = 64; // по прямой дальше не ходим (поиска пути пока нет)
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

async function goToPoint(bot, target, sprint) {
  const dist = bot.entity.position.distanceTo(target);
  if (dist > MAX_WALK) throw new CommandError(`слишком далеко (${Math.round(dist)} блоков): по прямой — не больше ${MAX_WALK}`);
  await bot.actions.walkTo(target, { sprint });
  const p = bot.entity.position;
  return { ok: true, message: `Дошёл до ${round(p.x)} ${round(p.y)} ${round(p.z)}`, data: { position: plain(p) } };
}

async function goToPlayer(bot, e, sprint) {
  const dist = bot.entity.position.distanceTo(e.position);
  if (dist > MAX_WALK) throw new CommandError(`${e.username} слишком далеко (${Math.round(dist)} блоков)`);
  await bot.actions.walkTo(e.position.clone(), { range: PLAYER_STOP, sprint });
  if (bot.entities && bot.entities[e.id]) await bot.actions.lookAt(e.position.offset(0, (e.height || 1.8) * 0.9, 0)); // и посмотреть на него
  return { ok: true, message: `Подошёл к ${e.username}`, data: { player: e.username, position: plain(bot.entity.position) } };
}

async function goToEntity(bot, e, sprint, query) {
  const label = entityLabel(e) || query || e.name;
  const dist = bot.entity.position.distanceTo(e.position);
  if (dist > MAX_WALK) throw new CommandError(`${label} слишком далеко (${Math.round(dist)} блоков)`);
  await bot.actions.walkTo(e.position.clone(), { range: 2, sprint }); // на расстояние вытянутой руки
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
    throw new CommandError(`рядом нет «${npc}» — сначала /warp ah (NPC стоят там), потом #сущности покажет, кто есть`);
  }
  if (bot.entity.position.distanceTo(e.position) > NPC_REACH) {
    try {
      await goToEntity(bot, e, false, npc);
    } catch (err) {
      // NPC часто стоят за прилавком: вплотную не подойти («застрял»), но дотянуться можно — нажать всё равно
      // попробуем. Прерывания (#стоп, новое действие, телепорт) — не про это: их пробрасываем.
      if (!err || err.code !== 'stuck') throw err;
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
const readQuests = (bot) => (bot.currentWindow ? parseQuestMenu(menuSlots(bot.currentWindow)) : { quests: [], level: null });

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

// ---------- задания «Передайте…» целиком: склад → NPC → склад наград ----------

const NPC_WARP = '/warp ah'; // где стоят NPC с заданиями (ТЗ)
const TELEPORT_WAIT_MS = 8000;
const MAX_STORAGE_CHESTS = 12;
const HOME_NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u;
const lastHomes = new Map(); // ник бота → { storage, rewards }: «#квесты принести» без слов — как в прошлый раз

/**
 * Написать серверу команду телепорта (/home склад, /warp ah) и дождаться самого телепорта (пакет позиции
 * или смена мира). Потом постоять, пока вокруг догрузятся чанки с сундуками и NPC.
 */
async function teleportBy(bot, cmd) {
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
    for (let t = 0; t < TELEPORT_WAIT_MS && !moved; t += 100) await bot.actions.wait(100);
  } finally {
    bot.removeListener('forcedMove', onMove);
    bot.removeListener('respawn', onMove);
    chat.stop();
  }
  if (!moved) {
    const said = serverSaid(chat.lines);
    throw new CommandError(`после ${cmd} телепорта не было${said ? ` (сервер: «${said}»)` : ''}`);
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
  const chests = scanBlocks(bot, OPEN_RANGE + 1, (b) => isContainer(b.name)).filter((c) => c.dist <= OPEN_RANGE + 0.5).slice(0, MAX_STORAGE_CHESTS);
  if (!chests.length) throw new CommandError(`у дома нет сундуков (до ${OPEN_RANGE} блоков от места, куда переносит /home)`);
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

/**
 * «#квесты принести урожай награды»: задания «Передайте…» целиком. У NPC (/warp ah) — взять новые задания и
 * посчитать, чего не хватает (с учётом инвентаря); /home урожай — взять это из сундуков у дома; /warp ah —
 * сдать; /home награды — положить награды. Инструменты и остатки для заданий бот оставляет себе.
 * Все задания уровня выполнены (до или после сдачи) — бот повышает уровень NPC кнопкой «Доступно улучшение».
 */
async function bringQuests(bot, npc, storageHome, rewardsHome) {
  const lines = [];
  const data = { npc, storage: storageHome, rewards: rewardsHome, needs: [], taken: [], gave: [], stored: [], levelUps: [] };
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
      quests = readQuests(bot).quests;
    } finally {
      await closeAfter(bot);
    }
    const todo = quests.filter((q) => q.kind === 'deliver' && q.taken && !q.done && q.items.length && q.need > q.have);
    // «Передайте …» с незнакомыми словами: что приносить, бот не знает — сказать, а не молча пропустить.
    const unknown = quests.filter((q) => q.kind === 'deliver' && q.taken && !q.done && !q.items.length);
    if (unknown.length) lines.push(`Не знаю, какие это предметы — пропускаю: ${unknown.map((q) => `${quote(q)} («${q.goal}»)`).join('; ')}`);
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
async function cmdBuy({ bot, args, words }) {
  const at = words.indexOf('у');
  const npc = at >= 0 ? args.slice(at + 1).join(' ') : QUEST_NPC;
  const head = at >= 0 ? args.slice(0, at) : args;
  const numIdx = head.findIndex((a) => /^\d+$/.test(a));
  const times = numIdx >= 0 ? Math.min(MAX_BUY, Math.max(1, parseInt(head[numIdx], 10))) : 1;
  const query = head.filter((_, i) => i !== numIdx).join(' ');
  if (!query) throw new CommandError('что купить? Например: #купи сено 2 (или #купи сено 2 у Алхимик)');
  try {
    await openShop(bot, npc);
    const offers = menuSlots(bot.currentWindow).map(parseOffer).filter(Boolean);
    const offer = offers.find((o) => matchesQuery(o.title, query) || matchesQuery(o.icon, query));
    if (!offer) throw new CommandError(`у ${npc} нет «${query}». Есть: ${offers.map((o) => o.title).join(', ') || 'ничего'}`);
    let bought = 0;
    let note = '';
    for (let i = 0; i < times; i += 1) {
      const before = parseOffer(menuSlots(bot.currentWindow).find((s) => s.slot === offer.slot) || { lore: [] });
      if (before && before.left === 0) {
        note = 'товар закончился';
        break;
      }
      await clickAndSettle(bot, offer.slot);
      const after = parseOffer(menuSlots(bot.currentWindow).find((s) => s.slot === offer.slot) || { lore: [] });
      // Покупку подтверждает «Осталось»: уменьшилось — куплено. Если счётчика нет, верим клику.
      if (before && after && before.left !== null && after.left !== null && after.left >= before.left) {
        note = 'сервер не продал (не хватило денег?)';
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

/** Подойти к блоку, если до него не дотянуться: по прямой, на своей высоте; упёрся — всё равно попробуем нажать. */
async function reachBlock(bot, pos) {
  const eye = bot.entity.position.offset(0, 1.62, 0);
  if (eye.distanceTo(pos.offset(0.5, 0.5, 0.5)) <= OPEN_RANGE) return;
  try {
    await bot.actions.walkTo(new Vec3(pos.x + 0.5, bot.entity.position.y, pos.z + 0.5), { range: 2.5 });
  } catch (err) {
    if (!err || err.code !== 'stuck') throw err;
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
    about: 'дойти по прямой (поиска пути пока нет — обходить ямы и стены не умеет)',
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
  { name: 'стоп', aliases: ['stop', 'хватит', 'стой'], usage: ['#стоп'], about: 'остановить действие', run: cmdStop },
  {
    name: 'квесты',
    aliases: ['quests', 'задания'],
    usage: ['#квесты', '#квесты взять', '#квесты сдать', '#квесты уровень', '#квесты принести урожай награды', '#квесты у Алхимика', '#квесты взять у Оружейника'],
    about: 'задания NPC (по умолчанию Фермер, у /warp ah): показать; взять все новые; сдать из инвентаря; уровень — повысить ' +
      '(взять, сдать и принести повышают сами, когда все задания выполнены); принести — всё для «Передайте…» со склада ' +
      '(/home урожай), сдать и сложить награды (/home награды)',
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
    }
  }
  let level = 'ok';
  if (!result.ok) level = ['unknown', 'not_ready', 'unsupported'].includes(result.code) ? 'warn' : ['replaced', 'stopped'].includes(result.code) ? 'info' : 'error';
  else if (cmd.observe) level = 'info';
  for (const text of [].concat(result.message)) log(level, text);
  return result;
}

module.exports = { runCommand, catalog, findCommand, findItem, itemTest, storageArgs, parseCoord, parseBlockPos, f3Yaw, f3Pitch, COMMANDS };
