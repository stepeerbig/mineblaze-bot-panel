'use strict';

// Рентген — то же, что мод Advanced XRay, только для бота и окна «Экран бота»: список блоков (руды, спавнеры…)
// со своим цветом, радиус в чанках в каждую сторону от бота, лава по желанию. Найденное окно рисует контурами
// сквозь стены, а #рентген пишет текстом.
//
// Бот знает все блоки загруженных чанков — ищем прямо по ним: у каждой секции 16×16×16 есть палитра (какие блоки в
// ней вообще есть), секция без нужных блоков пропускается сразу. Ищем кусками по sliceMs мс и между кусками
// отпускаем событийный цикл: в процессе живут до 20 ботов, их тики не должны опаздывать.
//
// Что сервер спрятал анти-X-ray, клиент не получает — этого не покажет ни мод, ни бот.

const { Vec3 } = require('vec3');

const MAX_RADIUS = 8; // чанков в каждую сторону: 8 → 17×17 чанков
const MAX_BLOCKS = 64; // строк в списке
const MAX_SHOWN = 4000; // столько ближних блоков отдаём окну (контуры дороги для видеокарты)
const MAX_COLLECT = 60000; // столько найденных держим, чтобы посчитать и отсортировать
const LAVA = Object.freeze({ key: 'lava', label: 'Лава', color: '#ff3000ff' });
const NAME_RE = /^[a-z0-9_]{1,64}$/;
const COLOR_RE = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i;

// Список по умолчанию: руды (вместе с глубинными — deepslate_…), спавнер; уголь и сундук есть, но выключены —
// их слишком много, за ними не видно нужного.
const DEFAULT_BLOCKS = Object.freeze([
  ['diamond_ore', 'Алмазы', '#4aedd9ff', true],
  ['emerald_ore', 'Изумруды', '#17dd62ff', true],
  ['ancient_debris', 'Древние обломки', '#b4643cff', true],
  ['gold_ore', 'Золото', '#fcee4bff', true],
  ['redstone_ore', 'Редстоун', '#ff2a2aff', true],
  ['lapis_ore', 'Лазурит', '#3d6bffff', true],
  ['iron_ore', 'Железо', '#e3b08cff', true],
  ['copper_ore', 'Медь', '#f07a3cff', true],
  ['nether_quartz_ore', 'Кварц', '#f1ece4ff', true],
  ['nether_gold_ore', 'Золото Незера', '#ffcc33ff', true],
  ['spawner', 'Спавнер', '#c34bffff', true],
  ['coal_ore', 'Уголь', '#7a7a7aff', false],
  ['chest', 'Сундук', '#c8963cff', false],
].map(([name, label, color, on]) => Object.freeze({ name, label, color, on, same: true })));

const DEFAULT_XRAY = Object.freeze({
  enabled: false, // подсветка в «Экране бота»
  radius: 2, // 2 чанка в каждую сторону → 5×5 чанков
  lava: false, // лава — красным, как блок из списка
  overlay: true, // надпись «Рентген включён» в окне
  blocks: DEFAULT_BLOCKS,
});

const clampInt = (v, min, max, def) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Цвет «#rrggbb» или «#rrggbbaa» → «#rrggbbaa» маленькими буквами; неверный — null. */
function normColor(value) {
  const m = COLOR_RE.exec(String(value || '').trim());
  return m ? `#${m[1]}${m[2] || 'ff'}`.toLowerCase() : null;
}

/** Имя блока как у игры: «minecraft:diamond_ore», «Diamond_Ore» → «diamond_ore»; неверное — null. */
function normName(value) {
  const name = String(value || '').trim().toLowerCase().replace(/^minecraft:/, '');
  return NAME_RE.test(name) ? name : null;
}

const cleanLabel = (value, fallback) => {
  const text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40);
  return text || fallback;
};

/** Настройки рентгена в безопасном виде; чего нет или неверно — по умолчанию. Список — без повторов. */
function sanitizeXray(src) {
  const s = src && typeof src === 'object' ? src : {};
  const bool = (v, def) => (typeof v === 'boolean' ? v : def);
  let blocks;
  if (Array.isArray(s.blocks)) {
    blocks = [];
    const seen = new Set();
    for (const raw of s.blocks) {
      if (blocks.length >= MAX_BLOCKS) break;
      if (!raw || typeof raw !== 'object') continue;
      const name = normName(raw.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      blocks.push({
        name,
        label: cleanLabel(raw.label, name),
        color: normColor(raw.color) || '#ffffffff',
        on: bool(raw.on, true),
        same: bool(raw.same, true),
      });
    }
  } else {
    blocks = DEFAULT_BLOCKS.map((b) => ({ ...b }));
  }
  return {
    enabled: bool(s.enabled, DEFAULT_XRAY.enabled),
    radius: clampInt(s.radius, 0, MAX_RADIUS, DEFAULT_XRAY.radius),
    lava: bool(s.lava, DEFAULT_XRAY.lava),
    overlay: bool(s.overlay, DEFAULT_XRAY.overlay),
    blocks,
  };
}

// Реестр блоков версии бота (у настоящего бота — bot.registry).
const registries = new Map();
function registryOf(bot) {
  if (bot && bot.registry && bot.registry.blocksByName) return bot.registry;
  const version = (bot && bot.version) || '1.21.11';
  if (!registries.has(version)) registries.set(version, require('prismarine-registry')(version));
  return registries.get(version);
}

/** Имена блоков строки: сам блок и (same) его пара — глубинная руда deepslate_… или обычная. */
function variantsOf(registry, entry) {
  const names = [entry.name];
  if (entry.same) {
    const pair = entry.name.startsWith('deepslate_') ? entry.name.slice('deepslate_'.length) : `deepslate_${entry.name}`;
    if (registry.blocksByName[pair]) names.push(pair);
  }
  return names.filter((n) => registry.blocksByName[n]);
}

/**
 * Что искать: группы (строки списка, которые включены и есть в этой версии, и лава) и номер состояния блока →
 * номер группы. → { groups: [{ key, label, color, names }], byState: Map }
 */
function xrayGroups(registry, settings) {
  const cfg = sanitizeXray(settings);
  const groups = [];
  const byState = new Map();
  const add = (key, label, color, names) => {
    if (!names.length) return;
    const g = groups.length;
    groups.push({ key, label, color, names });
    for (const n of names) {
      const b = registry.blocksByName[n];
      const lo = Number.isFinite(b.minStateId) ? b.minStateId : b.defaultState;
      const hi = Number.isFinite(b.maxStateId) ? b.maxStateId : b.defaultState;
      for (let id = lo; id <= hi; id += 1) if (!byState.has(id)) byState.set(id, g);
    }
  };
  for (const e of cfg.blocks) if (e.on) add(e.name, e.label, e.color, variantsOf(registry, e));
  if (cfg.lava && registry.blocksByName.lava) add(LAVA.key, LAVA.label, LAVA.color, ['lava']);
  return { groups, byState };
}

const abortError = () => Object.assign(new Error('поиск прерван'), { code: 'aborted' });

/**
 * Найти блоки списка в загруженных чанках вокруг бота: квадрат radius чанков в каждую сторону, вся высота мира.
 * @param {object} bot
 * @param {object} settings  настройки рентгена (sanitizeXray)
 * @param {object} [opts]    { radius — вместо настроек, limit, collect, sliceMs, signal }
 * @returns {Promise<{ radius, center, total, shown, truncated, ms, groups: Array<{ key, label, color, count, shown,
 *   nearest: { x, y, z, dist } | null, positions: number[] }> }>} positions — x, y, z подряд, ближние первыми
 */
async function scanXray(bot, settings, { radius, limit = MAX_SHOWN, collect = MAX_COLLECT, sliceMs = 4, signal } = {}) {
  const cfg = sanitizeXray(settings);
  const r = radius === undefined ? cfg.radius : clampInt(radius, 0, MAX_RADIUS, cfg.radius);
  const registry = registryOf(bot);
  const { groups, byState } = xrayGroups(registry, cfg);
  const p = bot.entity.position;
  const center = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const ccx = Math.floor(center.x / 16);
  const ccz = Math.floor(center.z / 16);
  const hits = []; // g, x, y, z подряд
  let truncated = false;
  const started = Date.now();
  let sliceStart = Date.now();
  const pause = async () => {
    if (signal && signal.aborted) throw abortError();
    if (Date.now() - sliceStart < sliceMs) return;
    await new Promise((res) => setImmediate(res));
    if (signal && signal.aborted) throw abortError();
    sliceStart = Date.now();
  };
  const push = (g, x, y, z) => {
    if (hits.length >= collect * 4) {
      truncated = true;
      return false;
    }
    hits.push(g, x, y, z);
    return true;
  };

  const world = bot.world;
  if (groups.length && world && typeof world.getColumn === 'function') {
    // Колонки — от ближних к дальним: обрежем по collect — останутся ближние.
    const order = [];
    for (let dx = -r; dx <= r; dx += 1) for (let dz = -r; dz <= r; dz += 1) order.push([dx, dz]);
    order.sort((a, b) => a[0] * a[0] + a[1] * a[1] - b[0] * b[0] - b[1] * b[1]);
    scan: for (const [dx, dz] of order) {
      const cx = ccx + dx;
      const cz = ccz + dz;
      let column = null;
      try {
        column = world.getColumn(cx, cz);
      } catch (_) {
        column = null;
      }
      if (!column || !Array.isArray(column.sections)) continue;
      const minY = Number.isFinite(column.minY) ? column.minY : 0;
      for (let s = 0; s < column.sections.length; s += 1) {
        const section = column.sections[s];
        if (!section) continue;
        // Палитра секции: нужного блока в ней нет — 4096 блоков смотреть незачем.
        const palette = section.palette;
        const data = section.data;
        if (Array.isArray(palette)) {
          if (!palette.some((id) => byState.has(id))) continue;
        } else if (data && typeof data === 'object' && 'value' in data && typeof data.get === 'function') {
          if (!byState.has(data.value)) continue; // вся секция — один блок
        }
        const bx = cx * 16;
        const by = minY + s * 16;
        const bz = cz * 16;
        if (data && typeof data.get === 'function') {
          // 1.18+: номер блока в секции — (y << 8) | (z << 4) | x.
          for (let i = 0; i < 4096; i += 1) {
            const g = byState.get(data.get(i));
            if (g !== undefined && !push(g, bx + (i & 15), by + (i >> 8), bz + ((i >> 4) & 15))) break scan;
          }
        } else if (typeof column.getBlockStateId === 'function') {
          // Старые форматы секций — по одному блоку.
          const v = new Vec3(0, 0, 0);
          for (let y = 0; y < 16; y += 1) {
            for (let z = 0; z < 16; z += 1) {
              for (let x = 0; x < 16; x += 1) {
                v.set(bx + x, by + y, bz + z);
                const g = byState.get(column.getBlockStateId(v));
                if (g !== undefined && !push(g, v.x, v.y, v.z)) break scan;
              }
            }
          }
        }
        await pause();
      }
      await pause();
    }
  } else if (groups.length && typeof bot.findBlocks === 'function') {
    // Мир без колонок (подделка в тестах) — поиском mineflayer, в том же квадрате чанков.
    const ids = [...new Set(groups.flatMap((g) => g.names.map((n) => registry.blocksByName[n].id)))];
    const found = bot.findBlocks({ matching: ids, maxDistance: (r + 1) * 16 * Math.SQRT2 + 384, count: collect });
    for (const pos of found) {
      if (Math.abs(Math.floor(pos.x / 16) - ccx) > r || Math.abs(Math.floor(pos.z / 16) - ccz) > r) continue;
      const block = bot.blockAt(pos);
      const g = block ? byState.get(block.stateId) : undefined;
      if (g !== undefined && !push(g, pos.x, pos.y, pos.z)) break;
    }
  }

  // Ближние первыми (от центра блока до ног бота).
  const n = hits.length / 4;
  const dist2 = new Float64Array(n);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    const dx = hits[i * 4 + 1] + 0.5 - p.x;
    const dy = hits[i * 4 + 2] + 0.5 - p.y;
    const dz = hits[i * 4 + 3] + 0.5 - p.z;
    dist2[i] = dx * dx + dy * dy + dz * dz;
    order[i] = i;
  }
  order.sort((a, b) => dist2[a] - dist2[b]);
  const out = groups.map((g) => ({ key: g.key, label: g.label, color: g.color, count: 0, shown: 0, nearest: null, positions: [] }));
  let shown = 0;
  for (const i of order) {
    const grp = out[hits[i * 4]];
    const x = hits[i * 4 + 1];
    const y = hits[i * 4 + 2];
    const z = hits[i * 4 + 3];
    grp.count += 1;
    if (!grp.nearest) grp.nearest = { x, y, z, dist: Math.round(Math.sqrt(dist2[i]) * 10) / 10 };
    if (shown < limit) {
      grp.positions.push(x, y, z);
      grp.shown += 1;
      shown += 1;
    }
  }
  return { radius: r, center, total: n, shown, truncated, ms: Date.now() - started, groups: out };
}

/**
 * Следить за рентгеном для окна «Экран бота»: искать сразу, потом снова — когда бот ушёл в другой чанк, загрузился
 * чанк рядом или поменялся блок из списка (руду выкопали). Не чаще раза в minIntervalMs. onResult(результат
 * scanXray). → { refresh(), stop() }
 */
function createXrayTracker({ bot, getSettings, onResult, log = () => {}, minIntervalMs = 400 }) {
  const settings = sanitizeXray(getSettings());
  const { byState } = xrayGroups(registryOf(bot), settings);
  let timer = null;
  let running = false;
  let dirty = false;
  let stopped = false;
  let ctrl = null;
  let lastAt = 0;
  let lastChunk = null;

  const near = (x, z) => {
    const p = bot.entity && bot.entity.position;
    if (!p) return false;
    return Math.abs(Math.floor(x / 16) - Math.floor(p.x / 16)) <= settings.radius
      && Math.abs(Math.floor(z / 16) - Math.floor(p.z / 16)) <= settings.radius;
  };

  function schedule(delay = 0) {
    if (stopped) return;
    if (running) {
      dirty = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(run, Math.max(delay, lastAt + minIntervalMs - Date.now(), 0));
  }

  async function run() {
    timer = null;
    if (stopped || !bot.entity) return;
    running = true;
    dirty = false;
    ctrl = new AbortController();
    try {
      const result = await scanXray(bot, settings, { signal: ctrl.signal });
      lastAt = Date.now();
      if (!stopped) onResult(result);
    } catch (err) {
      if (!stopped && !(err && err.code === 'aborted')) log('warn', `рентген: ${err && err.message ? err.message : err}`);
    } finally {
      running = false;
      ctrl = null;
      if (dirty && !stopped) schedule();
    }
  }

  const listeners = {
    move: () => {
      const p = bot.entity && bot.entity.position;
      if (!p) return;
      const key = `${Math.floor(p.x / 16)},${Math.floor(p.z / 16)}`;
      if (key === lastChunk) return;
      const first = lastChunk === null;
      lastChunk = key;
      if (!first) schedule(150);
    },
    chunkColumnLoad: (pos) => {
      if (pos && near(pos.x, pos.z)) schedule(500);
    },
    blockUpdate: (oldBlock, newBlock) => {
      const b = newBlock || oldBlock;
      if (!b || !b.position || !near(b.position.x, b.position.z)) return;
      if ((oldBlock && byState.has(oldBlock.stateId)) || (newBlock && byState.has(newBlock.stateId))) schedule(250);
    },
  };
  listeners.forcedMove = listeners.move;
  for (const [event, fn] of Object.entries(listeners)) bot.on(event, fn);
  listeners.move();
  schedule(0);

  return {
    get settings() {
      return settings;
    },
    refresh: () => schedule(0),
    stop() {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      timer = null;
      if (ctrl) ctrl.abort();
      for (const [event, fn] of Object.entries(listeners)) bot.removeListener(event, fn);
    },
  };
}

/** Строки списка рентгена по словам: подпись («алмазы», «спавнер»), имя блока (diamond_ore) или «лава». */
function findEntries(settings, words, registry) {
  const cfg = sanitizeXray(settings);
  const text = words.join(' ').trim().toLowerCase().replace(/ё/g, 'е');
  if (!text) return [];
  if (/^лав|^lava$/.test(text)) return [{ ...LAVA, name: LAVA.key }];
  const stem = text.length > 4 ? text.slice(0, Math.max(4, text.length - 2)) : text;
  const hit = cfg.blocks.filter((b) => {
    const label = b.label.toLowerCase().replace(/ё/g, 'е');
    return b.name === text || b.name === normName(text) || label === text || label.startsWith(stem) || b.name.startsWith(text.replace(/\s+/g, '_'));
  });
  if (hit.length) return hit;
  const name = normName(text.replace(/\s+/g, '_'));
  if (name && registry && registry.blocksByName[name]) return [{ name, label: name, color: '#ffffffff', on: true, same: true }];
  return [];
}

module.exports = {
  DEFAULT_XRAY, DEFAULT_BLOCKS, LAVA, MAX_RADIUS, MAX_BLOCKS, MAX_SHOWN,
  sanitizeXray, normColor, normName, registryOf, variantsOf, xrayGroups, scanXray, createXrayTracker, findEntries,
};
