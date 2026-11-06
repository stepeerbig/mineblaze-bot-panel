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

const { Vec3 } = require('vec3');

const DANGER_RE = /^(?:lava|fire|soul_fire|campfire|soul_campfire|cactus|sweet_berry_bush|magma_block|powder_snow|cobweb|wither_rose|pointed_dripstone|sculk_sensor|calibrated_sculk_sensor)$/;
const WATER_RE = /^(?:water|bubble_column|kelp|kelp_plant|seagrass|tall_seagrass)$/;
const LOW = 0.6; // на столько физика заходит сама (ступенька плиты, ковёр, снег)
const FLOOR = 0.8; // верх опоры не ниже этого — на ней стоят (грядка 0,94, песок душ 0,88, сундук 0,88)
const COST = { flat: 1, diagonal: Math.SQRT2, jump: 1.5, fallPerBlock: 0.4, deepFall: 1, water: 2.5 };
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
const DEFAULTS = Object.freeze({ maxNodes: 20000, maxDistance: 96, maxFall: 3, sliceMs: 4, range: 0.5, vertical: 1 });

const key = (x, y, z) => `${x},${y},${z}`;

/** Сведения о клетке для пути: { loaded, shapes: есть форма, top, low, danger, water, tall } (с кэшем на один поиск). */
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
      c = { loaded: false, solid: true, top: 1, low: false, danger: false, water: false, tall: false };
    } else {
      const shapes = Array.isArray(block.shapes) ? block.shapes : [];
      const top = shapes.length ? Math.max(...shapes.map((s) => s[4])) : 0;
      const name = block.name || '';
      c = {
        loaded: true,
        solid: shapes.length > 0,
        top,
        low: shapes.length > 0 && top <= LOW,
        danger: DANGER_RE.test(name),
        water: WATER_RE.test(name) || Boolean(block.getProperties && safeProps(block).waterlogged === true && shapes.length === 0),
        tall: top > 1.01, // забор, стена, ворота: занимает и клетку выше
        name,
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

/** Модель «где стоять и куда шагнуть» поверх cell(x, y, z). */
function makeWorld(cell, maxFall) {
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
      }
      return out;
    },
  };
}

/**
 * Найти путь. getBlock(Vec3) → блок (prismarine-block, с shapes) или null — не загружен.
 * @param {Vec3}   start  где бот (ноги)
 * @param {Vec3}   goal   куда (точка; дойти до range по горизонтали и vertical по высоте)
 * @param {object} [opts] { range, vertical, maxNodes, maxDistance, maxFall, sliceMs, signal }
 * @returns {Promise<{ path: Vec3[], complete: boolean, nodes: number, reason: string }>}
 *   path — клетки ног от первого шага до цели (без стартовой); complete=false — дошли только до самой близкой точки
 */
async function findPath(getBlock, start, goal, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cell = cellReader(getBlock);
  const world = makeWorld(cell, o.maxFall);
  const s = { x: Math.floor(start.x), y: Math.floor(start.y + 0.01), z: Math.floor(start.z) };
  const goalY = Math.floor(goal.y + 0.01);
  const hDist = (n) => Math.hypot(n.x + 0.5 - goal.x, n.z + 0.5 - goal.z);
  const isGoal = (n) => hDist(n) <= o.range + 1e-9 && Math.abs(n.y - goalY) <= o.vertical;
  const h = (n) => Math.max(0, hDist(n) - o.range) + Math.max(0, Math.abs(n.y - goalY) - o.vertical) * 0.5;

  const startNode = { ...s, g: 0, f: h(s), parent: null };
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
      const node = { x: m.x, y: m.y, z: m.z, g, f: g + h(m), parent: n };
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
  for (let n = end; n && n.parent; n = n.parent) path.push(new Vec3(n.x, n.y, n.z));
  path.reverse();
  let reason = '';
  if (!found) {
    if (end === startNode) reason = 'пути нет: вокруг стены, обрывы или опасное (лава, огонь)';
    else reason = nodes >= o.maxNodes ? 'далеко: путь найден только до ближайшей точки' : 'дальше не видно (мир не загружен) или прохода нет';
  }
  return { path, complete: Boolean(found), nodes, reason };
}

module.exports = { findPath, makeWorld, cellReader, DANGER_RE, COST };
