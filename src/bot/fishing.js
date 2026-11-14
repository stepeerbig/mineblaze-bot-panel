'use strict';

// Рыбалка (#рыбалка, вкладка «Авто фиш»): расчёты без действий.
//  - Заброс — как у сервера (FishingHook 1.21): поплавок вылетает из глаз на 0,3 блока вперёд, скорость — по
//    взгляду (по горизонтали 1, по вертикали tan, не больше 5) × (0,6 / длина + 0,5). Каждый тик: клетка поплавка
//    с водой — упал в воду (дальше качается и ждёт рыбу); иначе гравитация 0,03, движение со столкновениями,
//    торможение ×0,92. Упёрся в блок — лежит (на берегу рыба не клюёт). По этой симуляции бот выбирает, куда
//    смотреть, чтобы поплавок упал в воду — не у самого берега и не через другого игрока (его бы зацепило).
//  - Место на берегу: вода у дома (до 24 блоков), под ногами твёрдый блок, над ним два свободных, рядом — вода.
//  - Ботов много — каждый берёт своё место: в одном процессе — по общей записи «занято», боты из других процессов —
//    по игрокам, которые уже стоят рядом.

const { Vec3 } = require('vec3');
const { lookVector } = require('./actions');

const GRAVITY = 0.03;
const DRAG = 0.92;
const HALF = 0.125; // поплавок — коробка 0,25 × 0,25
const HEIGHT = 0.25;
const MAX_FLY_TICKS = 120;
const PLAYER_HALF = 0.3;
const PLAYER_HEIGHT = 1.8;
const HOOK_MARGIN = 0.3; // сервер цепляет сущность, если поплавок прошёл ближе (ProjectileUtil.computeMargin)
const EYE = 1.62;

const FISH_RADIUS = 24; // вода — не дальше стольких блоков от дома (по горизонтали)
const FISH_HEIGHT = 8; // и не выше/ниже стольких
const SPOT_GAP = 2; // ботам — не ближе стольких блоков друг к другу (поплавки не путаются, ботов не цепляет)
const CLAIM_TTL_MS = 10 * 60 * 1000; // место «занято», пока бот рыбачит; запись старше — бот, видно, пропал
const MAX_SPOTS = 48; // мест на берегу смотрим не больше (океан рядом — их сотни)
const MAX_WATER = 4000;

// Блоки с водой внутри (FluidState WATER): вода любой высоты, водоросли, морская трава, пузырьковый столб.
const WATER_BLOCK_RE = /^(?:water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const DANGER_RE = /^(?:lava|fire|soul_fire|campfire|soul_campfire|magma_block|cactus|sweet_berry_bush|powder_snow|cobweb|wither_rose|pointed_dripstone)$/;

// Что вылавливается (таблица добычи рыбалки 1.21): рыба, «мусор», «сокровища». Это бот складывает на склад.
// Бутылочку воды (potion) не трогаем: под тем же именем у бота лежат зелья огнестойкости для Незера.
const FISH_ITEMS = ['cod', 'salmon', 'tropical_fish', 'pufferfish'];
const FISH_LOOT = new Set([
  ...FISH_ITEMS, 'lily_pad', 'leather_boots', 'leather', 'bone', 'string', 'bowl', 'stick', 'ink_sac',
  'tripwire_hook', 'rotten_flesh', 'bamboo', 'bow', 'enchanted_book', 'name_tag', 'nautilus_shell', 'saddle',
  'cocoa_beans',
]);
const LOOT_NAMES = {
  cod: 'треска', salmon: 'лосось', tropical_fish: 'тропическая рыба', pufferfish: 'иглобрюх', lily_pad: 'кувшинка',
  leather_boots: 'кожаные ботинки', leather: 'кожа', bone: 'кость', potion: 'бутылочка воды', string: 'нить', bowl: 'миска',
  stick: 'палка', ink_sac: 'чернильный мешок', tripwire_hook: 'крюк', rotten_flesh: 'гнилая плоть', bamboo: 'бамбук',
  bow: 'лук', enchanted_book: 'зачарованная книга', name_tag: 'бирка', nautilus_shell: 'раковина наутилуса', saddle: 'седло',
  fishing_rod: 'удочка', cocoa_beans: 'какао-бобы',
};
const lootName = (name) => LOOT_NAMES[name] || name;

// ---------- удочки: сколько прочности осталось ----------

// Удочка, у которой прочности осталось 3 и меньше (у любой: и у обычной на 64, и у особой с сервера), — «изношенная»:
// ею не ловят, а кладут в сундук склада (сохранить: починить и зачаровать её потом можно, а сломанную — нет). Улов
// стоит удочке 1 прочности. Ловят целыми, самыми целыми — первыми. (Сначала порог был 30 из 64 — удочки уходили в
// сундук почти на половине прочности; 12.11 попросили 3 единицы.)
const ROD_SAVE_LEFT = 3;
const ROD_MAX = 64;

/** Данные компонента предмета 1.21 (damage, max_damage, unbreakable): prismarine-item или простой объект тестов. */
function componentData(item, type) {
  if (item.componentMap && typeof item.componentMap.get === 'function' && item.componentMap.has(type)) {
    return item.componentMap.get(type).data;
  }
  if (Array.isArray(item.components)) {
    const c = item.components.find((x) => x && x.type === type);
    if (c) return c.data === undefined ? true : c.data;
  }
  return undefined;
}

/** Полная прочность удочки (у обычной — 64; у особой с сервера — своя, компонентом max_damage). */
function rodMax(item) {
  return (item && (Number(componentData(item, 'max_damage')) || item.maxDurability)) || ROD_MAX;
}

/** Сколько прочности осталось у удочки (неразрушимая — бесконечно). */
function rodLeft(item) {
  if (!item) return 0;
  if (componentData(item, 'unbreakable') !== undefined) return Infinity;
  const max = rodMax(item);
  let used = componentData(item, 'damage');
  if (used === undefined) {
    try {
      used = item.durabilityUsed;
    } catch (_) {
      used = undefined;
    }
  }
  if (used === undefined || used === null) used = item.damage || 0;
  return Math.max(0, max - (Number(used) || 0));
}

/** Удочки бота (инвентарь, быстрая панель и вторая рука): [{ item, slot, left }], самые целые — первыми. */
function botRods(bot) {
  const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : [];
  const out = [];
  for (let i = 9; i <= 45; i += 1) {
    const it = slots[i];
    if (it && it.name === 'fishing_rod') out.push({ item: it, slot: i, left: rodLeft(it) });
  }
  return out.sort((a, b) => b.left - a.left);
}

/** Удочка износилась: прочности осталось 3 и меньше (неразрушимая не изнашивается). */
function rodWorn(item) {
  if (!item) return false;
  const left = rodLeft(item);
  return Number.isFinite(left) && left <= ROD_SAVE_LEFT;
}

const usableRods = (bot) => botRods(bot).filter((r) => !rodWorn(r.item));
const wornRods = (bot) => botRods(bot).filter((r) => rodWorn(r.item));

const blockProps = (block) => {
  try {
    return typeof block.getProperties === 'function' ? block.getProperties() || {} : {};
  } catch (_) {
    return {};
  }
};

/** Вода ли в клетке для поплавка: блок воды (любой высоты), водоросли и т.п. или блок «в воде» (waterlogged). */
function isWaterBlock(block) {
  if (!block) return false;
  if (WATER_BLOCK_RE.test(block.name || '')) return true;
  return blockProps(block).waterlogged === true;
}

const UNLOADED_CELL = Object.freeze({ loaded: false, water: false, shapes: [], top: 1, solid: true, passable: false, floor: false, name: '' });

/** Что за блок для рыбалки (зависит только от его состояния): вода, формы, можно ли стоять в нём и на нём. */
function describe(block) {
  if (!block) return UNLOADED_CELL;
  const shapes = Array.isArray(block.shapes) ? block.shapes : [];
  const name = block.name || '';
  const water = isWaterBlock(block);
  const top = shapes.length ? Math.max(...shapes.map((s) => s[4])) : 0;
  const danger = DANGER_RE.test(name) || name === 'lava';
  return {
    loaded: true,
    water,
    name,
    shapes, // формы в клетке (0…1), как у prismarine-block
    top,
    solid: shapes.length > 0,
    passable: shapes.length === 0 && !water && name !== 'lava' && !danger,
    floor: shapes.length > 0 && top >= 0.8 && top <= 1.01 && !danger && !water,
  };
}

// Сведения по номеру состояния блока — один раз на версию игры: блоков вокруг пруда тысячи, состояний — десятки.
const byRegistry = new WeakMap();

/**
 * Клетки мира с кэшем на один расчёт: (x, y, z) → { loaded, water, shapes, top, solid, passable (стоять в ней можно:
 * нет формы, не вода, не лава), floor (на нём стоят: верх ≥ 0,8, не опасный) }. С миром mineflayer (world.getColumn) —
 * прямо из палитры чанка, без нового блока на каждую клетку (у 70 ботов расчёт не должен задерживать тики).
 */
function cellReader(blockAt, { world = null, registry = null } = {}) {
  const cache = new Map();
  let fast = null;
  if (world && typeof world.getColumn === 'function' && registry) {
    let states = byRegistry.get(registry);
    if (!states) {
      states = { Block: require('prismarine-block')(registry), map: new Map() };
      byRegistry.set(registry, states);
    }
    const p = { x: 0, y: 0, z: 0 };
    fast = (x, y, z) => {
      let column = null;
      try {
        column = world.getColumn(x >> 4, z >> 4);
      } catch (_) {
        column = null;
      }
      if (!column || typeof column.getBlockStateId !== 'function') return UNLOADED_CELL;
      p.x = x & 15;
      p.y = y;
      p.z = z & 15;
      let id;
      try {
        id = column.getBlockStateId(p);
      } catch (_) {
        return UNLOADED_CELL; // за пределами высоты мира
      }
      let info = states.map.get(id);
      if (!info) {
        info = describe(states.Block.fromStateId(id, 0));
        states.map.set(id, info);
      }
      return info;
    };
  }
  return (x, y, z) => {
    const key = `${x},${y},${z}`;
    let c = cache.get(key);
    if (c) return c;
    if (fast) {
      c = fast(x, y, z);
    } else {
      let block = null;
      try {
        block = blockAt(new Vec3(x, y, z));
      } catch (_) {
        block = null;
      }
      c = describe(block);
    }
    cache.set(key, c);
    return c;
  };
}

/** Клетки мира бота для расчётов рыбалки (быстро — из палитр чанков, если можно). */
const botCells = (bot) => cellReader((p) => bot.blockAt(p), { world: bot.world, registry: bot.registry });

/** Пересекает ли коробка поплавка (низ — в точке x,y,z) блоки мира. */
function hookHitsBlock(cell, x, y, z) {
  const x0 = x - HALF;
  const x1 = x + HALF;
  const y0 = y;
  const y1 = y + HEIGHT;
  const z0 = z - HALF;
  const z1 = z + HALF;
  for (let cx = Math.floor(x0); cx <= Math.floor(x1); cx += 1) {
    for (let cy = Math.floor(y0) - 1; cy <= Math.floor(y1); cy += 1) { // −1: забор и стена выше своей клетки
      for (let cz = Math.floor(z0); cz <= Math.floor(z1); cz += 1) {
        const c = cell(cx, cy, cz);
        if (!c.loaded) return true;
        for (const s of c.shapes) {
          if (x0 < cx + s[3] - 1e-7 && x1 > cx + s[0] + 1e-7 && y0 < cy + s[4] - 1e-7 && y1 > cy + s[1] + 1e-7 && z0 < cz + s[5] - 1e-7 && z1 > cz + s[2] + 1e-7) return true;
        }
      }
    }
  }
  return false;
}

/** Расстояние по горизонтали от точки p до отрезка a–b. */
function segmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2)) : 0;
  return Math.hypot(p.x - (a.x + dx * t), p.z - (a.z + dz * t));
}

/** Задевает ли поплавок в точке игрока (others — позиции ног игроков): сервер зацепит его крючком. */
function hookHitsPlayer(others, x, y, z) {
  for (const o of others) {
    const r = PLAYER_HALF + HOOK_MARGIN + HALF;
    if (Math.abs(x - o.x) < r && Math.abs(z - o.z) < r && y + HEIGHT > o.y - HOOK_MARGIN && y < o.y + PLAYER_HEIGHT + HOOK_MARGIN) return true;
  }
  return false;
}

/**
 * Куда упадёт поплавок при забросе из глаз eye со взглядом yaw/pitch (радианы, как в mineflayer).
 * cell — cellReader(blockAt); others — где стоят другие игроки (Vec3 ног).
 * → { hit: 'water' | 'block' | 'entity' | 'far' | 'unloaded' | 'straight', cell?: Vec3, at: Vec3, ticks }
 */
function simulateCast(cell, eye, yaw, pitch, { others = [] } = {}) {
  const look = lookVector(yaw, pitch);
  const h = Math.hypot(look.x, look.z);
  if (h < 1e-4) return { hit: 'straight', at: eye.clone(), ticks: 0 };
  const dx = look.x / h;
  const dz = look.z / h;
  let vx = dx;
  let vy = Math.max(-5, Math.min(5, look.y / h));
  let vz = dz;
  const k = 0.6 / Math.hypot(vx, vy, vz) + 0.5;
  vx *= k;
  vy *= k;
  vz *= k;
  let x = eye.x + dx * 0.3;
  let y = eye.y;
  let z = eye.z + dz * 0.3;
  for (let t = 0; t < MAX_FLY_TICKS; t += 1) {
    const fx = Math.floor(x);
    const fy = Math.floor(y);
    const fz = Math.floor(z);
    const c = cell(fx, fy, fz);
    if (!c.loaded) return { hit: 'unloaded', at: new Vec3(x, y, z), ticks: t };
    if (c.water) return { hit: 'water', cell: new Vec3(fx, fy, fz), at: new Vec3(x, y, z), ticks: t };
    vy -= GRAVITY;
    const len = Math.hypot(vx, vy, vz);
    const n = Math.max(1, Math.ceil(len / 0.1));
    for (let i = 0; i < n; i += 1) {
      const nx = x + vx / n;
      const ny = y + vy / n;
      const nz = z + vz / n;
      if (hookHitsBlock(cell, nx, ny, nz)) {
        // Упёрся в блок: в клетке с водой — всё равно в воде (дно мелкой воды), иначе лежит на берегу.
        const here = cell(Math.floor(x), Math.floor(y), Math.floor(z));
        if (here.water) return { hit: 'water', cell: new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)), at: new Vec3(x, y, z), ticks: t + 1 };
        return { hit: 'block', at: new Vec3(x, y, z), ticks: t + 1 };
      }
      if (hookHitsPlayer(others, nx, ny, nz)) return { hit: 'entity', at: new Vec3(nx, ny, nz), ticks: t + 1 };
      x = nx;
      y = ny;
      z = nz;
    }
    vx *= DRAG;
    vy *= DRAG;
    vz *= DRAG;
    if (y < eye.y - 48) return { hit: 'far', at: new Vec3(x, y, z), ticks: t + 1 };
  }
  return { hit: 'far', at: new Vec3(x, y, z), ticks: MAX_FLY_TICKS };
}

/** Сколько воды вокруг клетки (3×3 на её высоте, с ней самой): поплавку там просторно. */
function openness(cell, p) {
  let n = 0;
  for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) if (cell(p.x + dx, p.y, p.z + dz).water) n += 1;
  return n;
}

const DEG = Math.PI / 180;
// Наклоны заброса (градусы, вверх — плюс): сначала обычные — чуть вверх, как закидывает человек.
const PITCHES = [12, 5, 20, -5, 28, -14, 36, -24, -34, 45];
// Улов летит от поплавка прямо к рыбаку (недолетел — скользит по воде туда же); игрок ближе стольких блоков к этому
// пути подберёт его сам (подбирают в 1,3 блока от середины игрока, а поплавок за время клёва сносит). Последний
// блок пути у самого бота не в счёт: там улов уже его. Стенд 12.11: 10 ботов у одного пруда; кто забрасывал
// наискосок вдоль берега (путь улова — в 1,8 блока от соседа), отдавал улов соседу; поперёк берега — нет.
const STEAL_RANGE = 2.2;
const STEAL_KEEP_END = 1;
const YAW_STEP = 5; // направления заброса — через столько градусов (есть и ровно поперёк берега: 0°, 45°, 90°…)

/** Как близко к игроку o пройдёт улов на пути от места падения поплавка at к глазам eye (без последнего блока). */
function returnClearance(o, at, eye) {
  const dx = eye.x - at.x;
  const dz = eye.z - at.z;
  const len = Math.hypot(dx, dz);
  if (len <= STEAL_KEEP_END) return Infinity;
  const k = (len - STEAL_KEEP_END) / len;
  return segmentDistance(o, at, { x: at.x + dx * k, z: at.z + dz * k });
}

/**
 * Лучший заброс с места: глаза eye, вода — в waters (клетки воды у поверхности). Направления — на воду
 * в 2…12 блоках, наклоны — PITCHES; поплавок должен упасть в воду не ближе 2 блоков, и вокруг — вода; улов полетит
 * обратно не мимо другого игрока (чем дальше от них, тем лучше).
 * → { yaw, pitch, landing: Vec3, dist, open, score } или null.
 */
function planCast(cell, eye, waters, { others = [], minDist = 2 } = {}) {
  const buckets = new Map(); // направление (по YAW_STEP°) → сколько воды в нём
  for (const w of waters) {
    const dx = w.x + 0.5 - eye.x;
    const dz = w.z + 0.5 - eye.z;
    const d = Math.hypot(dx, dz);
    if (d < minDist || d > 12) continue;
    const yaw = Math.atan2(-dx, -dz); // как в mineflayer
    const b = Math.round(yaw / (YAW_STEP * DEG));
    const e = buckets.get(b) || { yaw: b * YAW_STEP * DEG, n: 0 };
    e.n += 1;
    buckets.set(b, e);
  }
  const yaws = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 14);
  let best = null;
  for (const { yaw, n } of yaws) {
    for (const deg of PITCHES) {
      const pitch = deg * DEG;
      const r = simulateCast(cell, eye, yaw, pitch, { others });
      if (r.hit !== 'water') continue;
      const dist = Math.hypot(r.at.x - eye.x, r.at.z - eye.z);
      if (dist < minDist) continue;
      // Улов полетит обратно мимо другого игрока — достанется ему.
      const clear = others.reduce((m, o) => Math.min(m, returnClearance(o, r.at, eye)), Infinity);
      if (clear < STEAL_RANGE) continue;
      const open = openness(cell, r.cell);
      if (open < 4) continue;
      // Просторно вокруг, не у самого берега, побольше воды в этом направлении, наклон — как у человека, и подальше
      // от чужого пути улова.
      const score = open * 2 + Math.min(dist, 7) + Math.min(n, 20) / 10 - Math.abs(deg - 10) / 15 + Math.min(clear, 5) * 0.6;
      if (!best || score > best.score) best = { yaw, pitch, landing: r.cell, at: r.at, dist, open, score };
    }
  }
  return best;
}

/** Клетки воды у поверхности (над ней — не вода) около center: ближние первыми. */
function findWater(bot, center, { radius = FISH_RADIUS, height = FISH_HEIGHT } = {}) {
  const cell = botCells(bot);
  const ids = ['water', 'bubble_column', 'kelp_plant', 'kelp', 'seagrass', 'tall_seagrass']
    .map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id);
  let found = [];
  if (typeof bot.findBlocks === 'function') {
    found = bot.findBlocks({ matching: ids, maxDistance: radius + height, count: MAX_WATER, point: center });
  }
  const out = [];
  for (const p of found) {
    if (Math.hypot(p.x + 0.5 - center.x, p.z + 0.5 - center.z) > radius || Math.abs(p.y - center.y) > height) continue;
    const c = cell(p.x, p.y, p.z);
    const above = cell(p.x, p.y + 1, p.z);
    if (c.water && !above.water && !above.solid) out.push(new Vec3(p.x, p.y, p.z));
  }
  out.sort((a, b) => a.distanceTo(center) - b.distanceTo(center));
  return { waters: out, cell };
}

const HORIZONTAL = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/**
 * Места на берегу у воды waters: клетка для ног (под ней — опора, над ней — свободно), вплотную к воде
 * (по горизонтали), не ниже воды и не выше 3 блоков над ней. → [{ feet: Vec3, key }] — ближние к center первыми.
 */
function shoreSpots(cell, waters, center) {
  const seen = new Set();
  const out = [];
  for (const w of waters) {
    for (const [dx, dz] of HORIZONTAL) {
      const x = w.x + dx;
      const z = w.z + dz;
      for (let dy = 1; dy <= 3; dy += 1) {
        const y = w.y + dy;
        const feet = cell(x, y, z);
        if (feet.passable) {
          // Свободно: стоять можно, если под ногами опора и над головой тоже свободно. Выше смотреть незачем.
          const key = `${x},${y},${z}`;
          if (!seen.has(key) && cell(x, y - 1, z).floor && cell(x, y + 1, z).passable) {
            seen.add(key);
            out.push({ feet: new Vec3(x, y, z), key });
          }
          break;
        }
        if (feet.water || !feet.solid || !feet.loaded) break; // вода (это не берег) или не загружено
        // Здесь блок: берег выше воды — может, стоять можно на нём.
      }
    }
  }
  const d = (s) => Math.hypot(s.feet.x + 0.5 - center.x, s.feet.y - center.y, s.feet.z + 0.5 - center.z);
  return out.sort((a, b) => d(a) - d(b));
}

// ---------- места ботов: кто где рыбачит (на процесс ботов) ----------

const claims = new Map(); // «x,y,z» → { owner, at, feet }

function claimFree(feet, owner, now = Date.now()) {
  for (const [key, c] of claims) {
    if (now - c.at > CLAIM_TTL_MS) {
      claims.delete(key);
      continue;
    }
    if (c.owner === owner) continue;
    if (Math.hypot(c.feet.x - feet.x, c.feet.z - feet.z) < SPOT_GAP && Math.abs(c.feet.y - feet.y) <= 2) return false;
  }
  return true;
}

/** Занять место (и освободить прежнее этого бота). */
function claimSpot(feet, owner, now = Date.now()) {
  releaseSpot(owner);
  claims.set(`${feet.x},${feet.y},${feet.z}`, { owner, at: now, feet: feet.clone() });
}

/** Ещё рыбачу здесь — запись свежая. */
function touchSpot(owner, now = Date.now()) {
  for (const c of claims.values()) if (c.owner === owner) c.at = now;
}

function releaseSpot(owner) {
  for (const [key, c] of claims) if (c.owner === owner) claims.delete(key);
}

/** Где стоят другие игроки (Vec3 ног): им не мешать, через них не забрасывать. */
function otherPlayers(bot) {
  const out = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || e.type !== 'player' || !e.position) continue;
    out.push(e.position.clone());
  }
  return out;
}

/**
 * Где рыбачить: вода у center (дом), место на берегу (не занятое другим ботом и не рядом с другим игроком) и
 * заброс оттуда. exclude — ключи мест, где не вышло. → { feet, yaw, pitch, landing, dist, waters, spots } или
 * { none: 'no_water' | 'no_shore' | 'no_cast' | 'busy', waters, spots }.
 */
function planSpot(bot, center, { owner = bot.username, exclude = new Set(), now = Date.now() } = {}) {
  const { waters, cell } = findWater(bot, center);
  if (!waters.length) return { none: 'no_water', waters: 0, spots: 0 };
  const spots = shoreSpots(cell, waters, center).slice(0, MAX_SPOTS);
  if (!spots.length) return { none: 'no_shore', waters: waters.length, spots: 0 };
  const others = otherPlayers(bot);
  let busy = 0;
  let tried = 0;
  for (const s of spots) {
    if (exclude.has(s.key)) continue;
    if (!claimFree(s.feet, owner, now)) {
      busy += 1;
      continue;
    }
    const taken = others.some((o) => Math.hypot(o.x - (s.feet.x + 0.5), o.z - (s.feet.z + 0.5)) < SPOT_GAP - 0.2 && Math.abs(o.y - s.feet.y) < 2.5);
    if (taken) {
      busy += 1;
      continue;
    }
    tried += 1;
    const eye = new Vec3(s.feet.x + 0.5, s.feet.y + EYE, s.feet.z + 0.5);
    const near = waters.filter((w) => Math.abs(w.x - s.feet.x) <= 13 && Math.abs(w.z - s.feet.z) <= 13);
    const plan = planCast(cell, eye, near, { others });
    // near — вода у этого места: забросы отсюда считаются по ней (не искать воду заново перед каждым).
    if (plan) return { feet: s.feet, key: s.key, ...plan, near, waters: waters.length, spots: spots.length };
    if (tried >= 24) break;
  }
  return { none: busy && !tried ? 'busy' : 'no_cast', waters: waters.length, spots: spots.length, busy };
}

/**
 * Заброс с того места, где бот стоит сейчас (после подхода он мог встать не точно в середину клетки). waters —
 * клетки воды у места (из planSpot), без них — поиск воды вокруг landing.
 */
function planFromHere(bot, { landing = null, waters = null } = {}) {
  const p = bot.entity.position;
  let cell;
  let near = waters;
  if (near && near.length) {
    cell = botCells(bot);
  } else {
    const found = findWater(bot, landing || p, { radius: 14, height: 6 });
    near = found.waters;
    cell = found.cell;
  }
  if (!near.length) return null;
  const eye = p.offset(0, EYE, 0);
  const plan = planCast(cell, eye, near, { others: otherPlayers(bot) });
  return plan ? { ...plan, eyeAt: eye } : null;
}

/**
 * Прошлый заброс годится и сейчас: бот стоит там же, а на пути улова назад не встал другой игрок (тогда — считать
 * заново). plan — { at, eyeAt } прошлого расчёта.
 */
function castStillGood(bot, plan) {
  if (!plan || !plan.eyeAt || !bot.entity) return false;
  const eye = bot.entity.position.offset(0, EYE, 0);
  if (eye.distanceTo(plan.eyeAt) > 0.05) return false;
  return !otherPlayers(bot).some((o) => returnClearance(o, plan.at, eye) < STEAL_RANGE || hookPathNear(o, plan));
}

/** Игрок рядом с полётом поплавка (по прямой от глаз до места падения) — его может зацепить. */
function hookPathNear(o, plan) {
  return segmentDistance(o, plan.at, plan.eyeAt) < PLAYER_HALF + HOOK_MARGIN + HALF + 0.3 &&
    o.y < Math.max(plan.at.y, plan.eyeAt.y) + 0.5 && o.y + PLAYER_HEIGHT > Math.min(plan.at.y, plan.eyeAt.y) - 0.5;
}

module.exports = {
  simulateCast, planCast, planSpot, planFromHere, castStillGood, returnClearance, STEAL_RANGE, findWater, shoreSpots, cellReader, isWaterBlock, openness,
  claimSpot, touchSpot, releaseSpot, claimFree, otherPlayers, lootName,
  rodLeft, rodMax, rodWorn, botRods, usableRods, wornRods, ROD_SAVE_LEFT,
  FISH_ITEMS, FISH_LOOT, FISH_RADIUS, SPOT_GAP, _claims: claims,
};
