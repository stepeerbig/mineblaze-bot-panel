'use strict';

// Поиск пути по блокам (A*) — для навигации бота (bot.actions.goTo в src/bot/actions.js).
//
// Где бот может стоять (узел — клетка ног): ноги и голова — в проходимых клетках, под ногами — опора (блок с верхом
// не ниже 0,8: земля, грядка, сундук…) или низкий блок в самой клетке ног (плита, ковёр, снег — на них физика
// заходит сама). Шаги из узла:
//  - в 8 сторон по ровному; по диагонали — только если обе соседние клетки свободны (иначе бот цепляется углом);
//  - на блок выше — прыжком (над головой должно быть место), только по прямой;
//  - вниз — с уступа до maxFall блоков, только по прямой; под ногами внизу — опора или вода;
//  - в воде — плыть (дороже), всплывать и нырять.
// Опасное (лава, огонь, кактус, ягодный куст, магма, порошковый снег, паутина…) — обходим. Заборы и стены (выше
// 1 блока) — не перешагнуть. Незагруженный мир — стена, но край поиска запоминаем: цель дальше — путь до самой
// близкой к ней точки, дальше бот ищет снова (чанки подгружаются по ходу).
//
// Поиск идёт кусками (по sliceMs мс), между кусками отпускаем событийный цикл: в процессе живут до 20 ботов,
// и долгий синхронный поиск задержал бы их тики (а за неровные тики античит кикает).
//
// С копанием (opts.dig) путь может идти сквозь блоки — так бот прокапывается к руде и обратно:
//  - вперёд — сломать 2 блока (ноги и голова), ступенькой вниз — 3, ступенькой вверх — 3 (и над своей головой);
//  - под себя — сломать блок под ногами и спрыгнуть на 1 (только если ниже — твёрдая опора, а не пещера или лава);
//  - не ломаем блок, рядом с которым вода или лава (потечёт на бота), и блок под песком или гравием (обвалится).
// С блоками в инвентаре (opts.place) — «столбом» вверх: прыжок и блок под себя.

const { Vec3 } = require('vec3');

const DANGER_RE = /^(?:lava|fire|soul_fire|campfire|soul_campfire|cactus|sweet_berry_bush|magma_block|powder_snow|cobweb|wither_rose|pointed_dripstone|sculk_sensor|calibrated_sculk_sensor)$/;
const WATER_RE = /^(?:water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const LIQUID_RE = /^(?:water|lava|flowing_water|flowing_lava|bubble_column)$/;
// Падают, если под ними пусто.
const FALLING_RE = /^(?:sand|red_sand|gravel|suspicious_sand|suspicious_gravel|\w+_concrete_powder|anvil|chipped_anvil|damaged_anvil|dragon_egg|pointed_dripstone|scaffolding)$/;
const UNBREAKABLE_RE = /^(?:bedrock|barrier|light|end_portal|end_portal_frame|end_gateway|nether_portal|reinforced_deepslate|\w*command_block|structure_block|structure_void|jigsaw|spawner|trial_spawner|vault)$/;
const LOW = 0.6; // на столько физика заходит сама (ступенька плиты, ковёр, снег)
const FLOOR = 0.8; // верх опоры не ниже этого — на ней стоят (грядка 0,94, песок душ 0,88, сундук 0,88)
const MAX_HARDNESS = 10; // твёрже (обсидиан, 50) — не копаем: слишком долго
const COST = { flat: 1, diagonal: Math.SQRT2, jump: 1.5, fallPerBlock: 0.4, deepFall: 1, water: 2.5, pillar: 3 };
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DIRS4 = DIRS.slice(0, 4);
const SIDES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const DEFAULTS = Object.freeze({ maxNodes: 20000, maxDistance: 96, maxFall: 3, sliceMs: 4, range: 0.5, vertical: 1, weight: 1 });

const key = (x, y, z) => `${x},${y},${z}`;

/** Цена сломать блок (в шагах ходьбы): по твёрдости — камень ≈ 3, глубинный сланец и руда ≈ 5,5. */
const digCostByHardness = (block) => (typeof block.hardness === 'number' && block.hardness <= MAX_HARDNESS ? 1 + block.hardness * 1.5 : null);

/**
 * Сведения о клетке для пути: { loaded, solid: есть форма, top, low, danger, water, liquid, tall, falls, breakable }
 * (с кэшем на один поиск).
 */
function cellReader(getBlock) {
  const cache = new Map();
  return (x, y, z) => {
    const k = key(x, y, z);
    let c = cache.get(k);
    if (c) return c;
    let block = null;
    try {
      block = getBlock(new Vec3(x, y, z));
    } catch (_) {
      block = null;
    }
    if (!block) {
      c = { loaded: false, solid: true, top: 1, low: false, danger: false, water: false, liquid: false, tall: false, falls: false, breakable: false };
    } else {
      const shapes = Array.isArray(block.shapes) ? block.shapes : [];
      const top = shapes.length ? Math.max(...shapes.map((s) => s[4])) : 0;
      const name = block.name || '';
      const waterlogged = Boolean(block.getProperties && safeProps(block).waterlogged === true);
      c = {
        loaded: true,
        solid: shapes.length > 0,
        top,
        low: shapes.length > 0 && top <= LOW,
        danger: DANGER_RE.test(name),
        water: WATER_RE.test(name) || (waterlogged && shapes.length === 0),
        liquid: LIQUID_RE.test(name) || waterlogged, // сломаешь рядом — потечёт
        tall: top > 1.01, // забор, стена, ворота: занимает и клетку выше
        falls: FALLING_RE.test(name),
        breakable: typeof block.hardness === 'number' && block.hardness >= 0 && block.diggable !== false && !UNBREAKABLE_RE.test(name),
        name,
        block,
      };
    }
    cache.set(k, c);
    return c;
  };
}

function safeProps(block) {
  try {
    return block.getProperties() || {};
  } catch (_) {
    return {};
  }
}

/** Двоичная куча по f — открытый список A*. */
class Heap {
  constructor() {
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(node) {
    const a = this.items;
    a.push(node);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Модель «где стоять и куда шагнуть» поверх cell(x, y, z).
 * @param {Function} cell
 * @param {number}   maxFall
 * @param {object}   [opts]
 * @param {Function} [opts.dig]    цена сломать блок (block → число или null — не ломать); без неё — только ходить
 * @param {boolean}  [opts.place]  можно ставить блок под себя (есть блоки)
 */
function makeWorld(cell, maxFall, { dig = null, place = false } = {}) {
  // Клетка свободна для тела: нет формы (или низкая — только для ног), не опасна, не занята забором снизу.
  const free = (x, y, z, { feet = false } = {}) => {
    const c = cell(x, y, z);
    if (!c.loaded || c.danger) return false;
    if (cell(x, y - 1, z).tall) return false;
    return !c.solid || (feet && c.low);
  };
  // Можно стоять (ноги в x, y, z) — на опоре или в воде.
  const stand = (x, y, z) => {
    const f = cell(x, y, z);
    if (!free(x, y, z, { feet: true }) || !free(x, y + 1, z)) return false;
    if (f.water) return true; // плывёт
    if (f.low) return true; // стоит на плите или ковре в своей клетке
    const b = cell(x, y - 1, z);
    return b.loaded && b.solid && !b.danger && b.top >= FLOOR && b.top <= 1.01;
  };
  // Твёрдая опора под клеткой (её не ломаем).
  const floorOk = (x, y, z) => {
    const b = cell(x, y, z);
    return b.loaded && b.solid && !b.danger && !b.liquid && b.top >= FLOOR && b.top <= 1.01;
  };
  // Цена сломать клетку или null: не ломается, опасна, рядом вода или лава, сверху песок или гравий (кроме тех,
  // что ломаем этим же ходом — set).
  const breakCost = (x, y, z, set) => {
    const c = cell(x, y, z);
    if (!c.loaded || c.danger || c.liquid || !c.breakable) return null;
    for (const [ax, ay, az] of SIDES) if (cell(x + ax, y + ay, z + az).liquid) return null;
    if (cell(x, y + 1, z).falls && !set.has(key(x, y + 1, z))) return null;
    if (c.digCost === undefined) c.digCost = c.block ? dig(c.block) : null;
    return typeof c.digCost === 'number' && Number.isFinite(c.digCost) ? c.digCost : null;
  };
  // Освободить клетки хода (сверху вниз): { cost, dig: [Vec3] } или null — нельзя.
  const clear = (cells) => {
    const set = new Set(cells.map(([x, y, z]) => key(x, y, z)));
    let cost = 0;
    const out = [];
    for (const [x, y, z] of cells) {
      const c = cell(x, y, z);
      if (!c.loaded || c.danger || c.liquid) return null;
      if (!c.solid) continue; // уже пусто (воздух, трава)
      const k = breakCost(x, y, z, set);
      if (k === null) return null;
      cost += k;
      out.push(new Vec3(x, y, z));
    }
    return { cost, dig: out };
  };
  // Ходы с копанием и «столбом» (только по прямой: по диагонали копать неудобно и не видно граней).
  const digMoves = (n, out) => {
    const { x: X, y: Y, z: Z } = n;
    if (dig) {
      for (const [dx, dz] of DIRS4) {
        const x = X + dx;
        const z = Z + dz;
        let r = clear([[x, Y + 1, z], [x, Y, z]]); // вперёд: голова, ноги
        if (r && r.dig.length && floorOk(x, Y - 1, z)) out.push({ x, y: Y, z, cost: COST.flat + r.cost, dig: r.dig, move: 'walk' });
        r = clear([[x, Y + 1, z], [x, Y, z], [x, Y - 1, z]]); // ступенькой вниз
        if (r && r.dig.length && floorOk(x, Y - 2, z)) out.push({ x, y: Y - 1, z, cost: COST.flat + COST.fallPerBlock + r.cost, dig: r.dig, move: 'down' });
        r = clear([[X, Y + 2, Z], [x, Y + 2, z], [x, Y + 1, z]]); // ступенькой вверх: над головой — место для прыжка
        if (r && r.dig.length && floorOk(x, Y, z)) out.push({ x, y: Y + 1, z, cost: COST.flat + COST.jump + r.cost, dig: r.dig, move: 'up' });
      }
      // Под себя: сломать блок под ногами — бот спрыгнет на 1, ниже должна быть опора.
      const r = clear([[X, Y - 1, Z]]);
      if (r && r.dig.length && floorOk(X, Y - 2, Z)) out.push({ x: X, y: Y - 1, z: Z, cost: COST.flat + r.cost, dig: r.dig, move: 'drop' });
    }
    if (place) {
      // Столбом: прыжок и блок под себя — над головой нужно место (сломать, если можно копать). Опора — настоящий
      // блок или поставленный прошлым ходом «столба» (в мире его ещё нет).
      const here = cell(X, Y, Z);
      const r = dig ? clear([[X, Y + 2, Z]]) : free(X, Y + 2, Z) ? { cost: 0, dig: [] } : null;
      const standing = n.move === 'pillar' || floorOk(X, Y - 1, Z);
      if (r && standing && here.loaded && !here.solid && !here.water && !here.liquid) {
        out.push({ x: X, y: Y + 1, z: Z, cost: COST.pillar + r.cost, dig: r.dig, place: new Vec3(X, Y, Z), move: 'pillar' });
      }
    }
  };
  return {
    free,
    stand,
    /** Соседи узла: [{ x, y, z, cost }]. */
    neighbors(n) {
      const out = [];
      const inWater = cell(n.x, n.y, n.z).water;
      for (const [dx, dz] of DIRS) {
        const x = n.x + dx;
        const z = n.z + dz;
        const diagonal = dx !== 0 && dz !== 0;
        if (diagonal) {
          // Не срезать угол: обе соседние клетки (ноги и голова) свободны, и встать в цели.
          const clear = (cx, cz) => free(cx, n.y, cz, { feet: true }) && free(cx, n.y + 1, cz);
          if (clear(n.x + dx, n.z) && clear(n.x, n.z + dz) && stand(x, n.y, z)) {
            out.push({ x, y: n.y, z, cost: COST.diagonal * (cell(x, n.y, z).water ? COST.water : 1) });
          }
          continue;
        }
        if (stand(x, n.y, z)) {
          out.push({ x, y: n.y, z, cost: COST.flat * (cell(x, n.y, z).water || inWater ? COST.water : 1) });
          continue;
        }
        // На блок выше — прыжком: над головой место, в цели можно стоять.
        if (free(n.x, n.y + 2, n.z) && stand(x, n.y + 1, z)) {
          out.push({ x, y: n.y + 1, z, cost: COST.flat + COST.jump });
          continue;
        }
        // Вниз с уступа: шагнуть вперёд (ноги и голова свободны) и упасть до опоры.
        if (free(x, n.y, z, { feet: true }) && free(x, n.y + 1, z)) {
          for (let d = 1; d <= maxFall; d += 1) {
            const y = n.y - d;
            if (stand(x, y, z)) {
              out.push({ x, y, z, cost: COST.flat + d * COST.fallPerBlock + (d >= 3 ? COST.deepFall : 0) });
              break;
            }
            if (!free(x, y, z)) break; // упрётся во что-то, на чём не стоят (или опасное)
          }
        }
      }
      // В воде — всплыть или нырнуть.
      if (inWater) {
        if (stand(n.x, n.y + 1, n.z)) out.push({ x: n.x, y: n.y + 1, z: n.z, cost: COST.water });
        if (cell(n.x, n.y - 1, n.z).water && stand(n.x, n.y - 1, n.z)) out.push({ x: n.x, y: n.y - 1, z: n.z, cost: COST.water });
      } else if (dig || place) {
        digMoves(n, out);
      }
      return out;
    },
  };
}

/**
 * Цель «дотянуться до блока» o (руда): бот стоит так, что блок рядом с ногами или головой, прямо под ногами (ниже
 * него — опора: сломаешь — спрыгнешь на 1) или прямо над головой. Отсюда видна его грань — можно копать.
 */
function reachGoal(o, cell) {
  const ox = Math.floor(o.x);
  const oy = Math.floor(o.y);
  const oz = Math.floor(o.z);
  return {
    test(n) {
      const dxz = Math.abs(n.x - ox) + Math.abs(n.z - oz);
      if (dxz === 1) return oy === n.y || oy === n.y + 1;
      if (dxz !== 0) return false;
      if (oy === n.y + 2) return true;
      if (oy !== n.y - 1) return false;
      const below = cell(ox, oy - 1, oz);
      return below.loaded && below.solid && !below.danger && !below.liquid;
    },
    h(n) {
      const dy = oy > n.y + 1 ? oy - n.y - 1 : oy < n.y ? n.y - oy : 0;
      return Math.max(0, Math.abs(n.x - ox) + Math.abs(n.z - oz) + dy - 1);
    },
  };
}

/**
 * Найти путь. getBlock(Vec3) → блок (prismarine-block, с shapes) или null — не загружен.
 * @param {Vec3}   start  где бот (ноги)
 * @param {Vec3}   goal   куда (точка; дойти до range по горизонтали и vertical по высоте) или блок (reach)
 * @param {object} [opts] { range, vertical, maxNodes, maxDistance, maxFall, sliceMs, signal,
 *   dig: true | (block → цена или null) — копать сквозь блоки, place — ставить блок под себя (столбом),
 *   reach — goal это блок: дойти туда, откуда до него дотянуться, weight — вес оценки (>1 — быстрее, путь чуть длиннее) }
 * @returns {Promise<{ path: Vec3[], complete: boolean, nodes: number, reason: string }>}
 *   path — клетки ног от первого шага до цели (без стартовой); complete=false — дошли только до самой близкой точки.
 *   У шагов с копанием: dig — какие блоки сломать (сверху вниз), move — 'walk' | 'down' | 'up' | 'drop' | 'pillar';
 *   у «столба» place — куда поставить блок (клетка ног до прыжка).
 */
async function findPath(getBlock, start, goal, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cell = cellReader(getBlock);
  const dig = o.dig === true ? digCostByHardness : typeof o.dig === 'function' ? o.dig : null;
  const world = makeWorld(cell, o.maxFall, { dig, place: Boolean(o.place) });
  const s = { x: Math.floor(start.x), y: Math.floor(start.y + 0.01), z: Math.floor(start.z) };
  const goalY = Math.floor(goal.y + 0.01);
  const hDist = (n) => Math.hypot(n.x + 0.5 - goal.x, n.z + 0.5 - goal.z);
  const target = o.reach ? reachGoal(goal, cell) : null;
  const isGoal = target ? (n) => target.test(n) : (n) => hDist(n) <= o.range + 1e-9 && Math.abs(n.y - goalY) <= o.vertical;
  // По высоте пешком — прыжок или спуск по пути (полцены); с копанием каждый блок высоты — это слом или столб.
  const perY = dig || o.place ? 1 : 0.5;
  const h = target ? (n) => target.h(n) : (n) => Math.max(0, hDist(n) - o.range) + Math.max(0, Math.abs(n.y - goalY) - o.vertical) * perY;
  const hw = (n) => h(n) * o.weight;

  const startNode = { ...s, g: 0, f: hw(s), parent: null };
  const open = new Heap();
  open.push(startNode);
  const best = new Map([[key(s.x, s.y, s.z), startNode]]);
  const closed = new Set();
  let closest = startNode;
  let nodes = 0;
  let sliceStart = Date.now();
  let found = null;

  while (open.size) {
    if (o.signal && o.signal.aborted) throw Object.assign(new Error('поиск пути прерван'), { code: 'aborted' });
    const n = open.pop();
    const k = key(n.x, n.y, n.z);
    if (closed.has(k)) continue;
    closed.add(k);
    nodes += 1;
    if (isGoal(n)) {
      found = n;
      break;
    }
    if (h(n) < h(closest) - 1e-9 || (Math.abs(h(n) - h(closest)) < 1e-9 && n.g < closest.g)) closest = n;
    if (nodes >= o.maxNodes) break;
    for (const m of world.neighbors(n)) {
      if (Math.hypot(m.x - s.x, m.z - s.z) > o.maxDistance) continue;
      const mk = key(m.x, m.y, m.z);
      if (closed.has(mk)) continue;
      const g = n.g + m.cost;
      const prev = best.get(mk);
      if (prev && prev.g <= g) continue;
      const node = { x: m.x, y: m.y, z: m.z, g, f: g + hw(m), parent: n, dig: m.dig, place: m.place, move: m.move };
      best.set(mk, node);
      open.push(node);
    }
    if (Date.now() - sliceStart >= o.sliceMs) {
      await new Promise((r) => setImmediate(r)); // тики ботов этого процесса — вовремя
      sliceStart = Date.now();
    }
  }

  const end = found || closest;
  const path = [];
  for (let n = end; n && n.parent; n = n.parent) {
    const p = new Vec3(n.x, n.y, n.z);
    if (n.move) p.move = n.move;
    if (n.dig && n.dig.length) p.dig = n.dig;
    if (n.place) p.place = n.place;
    path.push(p);
  }
  path.reverse();
  let reason = '';
  if (!found) {
    if (end === startNode) reason = 'пути нет: вокруг стены, обрывы или опасное (лава, огонь)';
    else reason = nodes >= o.maxNodes ? 'далеко: путь найден только до ближайшей точки' : 'дальше не видно (мир не загружен) или прохода нет';
  }
  return { path, complete: Boolean(found), nodes, reason };
}

module.exports = { findPath, makeWorld, cellReader, reachGoal, digCostByHardness, DANGER_RE, LIQUID_RE, FALLING_RE, UNBREAKABLE_RE, COST };
