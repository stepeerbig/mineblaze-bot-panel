'use strict';

/*
 * Перевод блоков между версиями Minecraft для окна «Экран бота».
 *
 * Готовый клиент prismarine-viewer рисует только версии из своего списка (новейшая — 1.21.4)
 * и разбирает чанки своими данными minecraft-data. А номера состояний блоков (stateId) в каждой
 * версии свои: если отдать ему мир 1.21.11 как есть, блоки перепутаются. Здесь выбирается версия
 * для просмотра и переводятся номера блоков и целые чанки (JSON из prismarine-chunk).
 */

const { Vec3 } = require('vec3');
const BitArray = require('prismarine-chunk/src/pc/common/BitArrayNoSpan'); // так хранятся палитры чанков 1.18+

const FLATTENING_DV = 1519; // dataVersion 1.13: с неё у каждого состояния блока свой номер
const MODERN_CHUNKS_DV = 2860; // dataVersion 1.18: формат чанков prismarine-chunk pc/1.18 (minY, палитры)
const BLOCK_BITS = { min: 4, max: 8 }; // бит на запись палитры секции блоков (как в prismarine-chunk)
const BIOME_BITS = { min: 1, max: 3 }; // то же для биомов
const HAS_DIRECT = /(?<![a-z])direct/; // в JSON есть «прямой» контейнер (но не слово indirect)

// Блоки, которых нет в версии просмотра: чем заменить (берётся первый существующий вариант).
// Приставки waxed_/exposed_/weathered_/oxidized_ срезаются заранее (медные варианты).
const ALIASES = new Map(Object.entries({
  iron_chain: 'chain', // переименовали в 1.21.9
  chain: 'iron_chain',
  short_grass: 'grass', // переименовали в 1.20.3
  grass: 'short_grass',
  copper_chain: ['chain', 'iron_chain'],
  copper_bars: 'iron_bars',
  copper_torch: 'torch',
  copper_wall_torch: 'wall_torch',
  copper_lantern: 'lantern',
  copper_chest: 'chest',
  copper_golem_statue: 'air',
  wildflowers: 'pink_petals', // те же свойства facing и flower_amount
  bush: ['short_grass', 'grass'],
  firefly_bush: ['short_grass', 'grass'],
  short_dry_grass: 'dead_bush',
  tall_dry_grass: 'dead_bush',
  golden_dandelion: 'dandelion',
  potted_golden_dandelion: 'potted_dandelion',
  leaf_litter: 'air',
  cactus_flower: 'air',
  dried_ghast: 'air',
  test_block: 'air',
  test_instance_block: 'air',
  // для старых пар версий (1.19.4 → 1.19, 1.20.4 → 1.20.1)
  suspicious_sand: 'sand',
  suspicious_gravel: 'gravel',
  chiseled_bookshelf: 'bookshelf',
  copper_grate: 'copper_block',
  copper_bulb: 'copper_block',
  chiseled_copper: 'cut_copper',
  trial_spawner: 'spawner',
  vault: 'spawner',
  crafter: 'crafting_table',
}));

// Общие правила по окончанию имени — для прочих новых блоков. Третий элемент — свойства,
// которые выставляются принудительно. Срабатывает первое подходящее правило.
const FAMILY = [
  [/^potted_/, 'flower_pot'],
  [/_shelf$/, (name) => [name.replace(/_shelf$/, '_slab'), 'oak_slab'], { type: 'top' }], // полки 1.21.9
  [/_wall_hanging_sign$/, 'oak_wall_hanging_sign'],
  [/_hanging_sign$/, 'oak_hanging_sign'],
  [/_wall_sign$/, 'oak_wall_sign'],
  [/_sign$/, 'oak_sign'],
  [/_wall_torch$/, 'wall_torch'],
  [/_torch$/, 'torch'],
  [/_stairs$/, ['stone_stairs', 'cobblestone_stairs']],
  [/_slab$/, 'stone_slab'],
  [/_wall$/, 'cobblestone_wall'],
  [/_fence_gate$/, 'oak_fence_gate'],
  [/_fence$/, 'oak_fence'],
  [/_trapdoor$/, 'oak_trapdoor'],
  [/_door$/, 'oak_door'],
  [/_button$/, 'stone_button'],
  [/_pressure_plate$/, 'stone_pressure_plate'],
  [/_log$/, 'oak_log'],
  [/_wood$/, 'oak_wood'],
  [/_planks$/, 'oak_planks'],
  [/_leaves$/, 'oak_leaves'],
  [/_sapling$/, 'oak_sapling'],
  [/_carpet$/, 'white_carpet'],
  [/_wool$/, 'white_wool'],
  [/_bed$/, 'red_bed'],
  [/_candle$/, 'candle'],
  [/_lantern$/, 'lantern'],
  [/_chain$/, ['chain', 'iron_chain']],
  [/_bars$/, 'iron_bars'],
  [/_chest$/, 'chest'],
];

// Деревянный блок незнакомой породы сначала пробуем заменить таким же дубовым.
const WOOD_RE = /^(stripped_|potted_)?(pale_oak|dark_oak|oak|spruce|birch|jungle|acacia|mangrove|cherry|bamboo|crimson|warped)_/;

// Свойства, которые в разных версиях называются по-разному (ключ — имя блока в версии просмотра).
const PROP_RULES = new Map(Object.entries({
  // Сердце скрипуна: 1.21.2–1.21.3 creaking=disabled|dormant|active, 1.21.4 active=true|false,
  // 1.21.5+ creaking_heart_state=uprooted|dormant|awake. «Горящее» сердце — active/awake.
  creaking_heart: (p) => {
    const awake = p.active === true || p.creaking === 'active' || p.creaking_heart_state === 'awake';
    const dormant = !awake && (p.creaking === 'dormant' || p.creaking_heart_state === 'dormant');
    return {
      active: awake,
      creaking: awake ? 'active' : dormant ? 'dormant' : 'disabled',
      creaking_heart_state: awake ? 'awake' : dormant ? 'dormant' : 'uprooted',
    };
  },
}));

const neededBits = (value) => 32 - Math.clz32(value);
const toMajor = (version) => String(version).split('.').slice(0, 2).join('.'); // как в prismarine-viewer
const dvOf = (data) => (Number.isFinite(data.version.dataVersion) ? data.version.dataVersion : -Infinity);
const isFlat = (data) => dvOf(data) >= FLATTENING_DV;
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isCube = (shapes) => Array.isArray(shapes) && shapes.length === 1 && shapes[0].join() === '0,0,0,1,1,1';

/** Данные minecraft-data для версии Java Edition или null (неизвестная версия, Bedrock, ошибка). */
function dataFor(mcData, version) {
  if (version === undefined || version === null || version === '') return null;
  try {
    const data = mcData(String(version));
    return data && data.type === 'pc' && data.version ? data : null;
  } catch (_) {
    return null;
  }
}

/** dataVersion версии без загрузки всех её данных (по таблице версий minecraft-data), null — не знаем. */
function dataVersionOf(mcData, version) {
  const index = mcData.versionsByMinecraftVersion && mcData.versionsByMinecraftVersion.pc;
  if (index && hasOwn(index, version)) {
    return Number.isFinite(index[version].dataVersion) ? index[version].dataVersion : null;
  }
  const data = dataFor(mcData, version);
  return data && Number.isFinite(data.version.dataVersion) ? data.version.dataVersion : null;
}

/**
 * Какую версию показывать в окне просмотра для версии бота.
 * Возвращает { viewerVersion, translate } (translate — нужен ли перевод номеров блоков) или null.
 */
function pickViewerVersion(botVersion, supportedVersions, mcData = require('minecraft-data')) {
  const bot = dataFor(mcData, botVersion);
  if (!bot) return null;
  const version = String(botVersion);
  const list = (Array.isArray(supportedVersions)
    ? supportedVersions
    : require('prismarine-viewer/viewer/lib/version.js').supportedVersions).map(String);
  if (list.includes(version)) return { viewerVersion: version, translate: false };

  const known = list
    .map((v) => ({ v, dv: dataVersionOf(mcData, v) }))
    .filter((x) => x.dv !== null)
    .sort((a, b) => a.dv - b.dv);
  const last = (arr) => (arr.length ? arr[arr.length - 1].v : null);
  const sameMajor = last(known.filter((x) => toMajor(x.v) === toMajor(version)));
  // До 1.13 номера блоков внутри одной ветки версий совпадают — переводить нечего.
  if (!isFlat(bot)) return sameMajor ? { viewerVersion: sameMajor, translate: false } : null;
  if (sameMajor) return { viewerVersion: sameMajor, translate: true };
  // Ветки нет в списке (например, 26.1): новейшая не новее бота, иначе самая старая из новых.
  const flat = known.filter((x) => x.dv >= FLATTENING_DV);
  const own = dvOf(bot);
  const pick = last(flat.filter((x) => x.dv <= own)) || (flat.length ? flat[0].v : null);
  return pick ? { viewerVersion: pick, translate: true } : null;
}

/** Совпадают ли реестры блоков двух версий (тогда номера состояний одинаковые). */
function sameRegistry(a, b) {
  const x = a.blocksArray;
  const y = b.blocksArray;
  if (x === y) return true;
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i];
    const q = y[i];
    if (p.name !== q.name || p.minStateId !== q.minStateId || p.maxStateId !== q.maxStateId ||
      JSON.stringify(p.states || []) !== JSON.stringify(q.states || [])) return false;
  }
  return true;
}

/*
 * Как устроен номер состояния (так же считает prismarine-block): stateId = minStateId + индексы
 * значений свойств в смешанной системе счисления, последнее свойство — младший разряд.
 * Индекс значения: enum и числа со списком values — номер строки в списке; bool — true=0, false=1;
 * числа без списка values (данные 1.13–1.16 и 1.18) идут с нуля — индекс равен самому числу.
 */
function makeCodec(block) {
  const states = block.states || [];
  const def = new Array(states.length);
  let rest = block.defaultState - block.minStateId;
  if (!(rest >= 0 && rest <= block.maxStateId - block.minStateId)) rest = 0;
  for (let i = states.length - 1; i >= 0; i--) {
    def[i] = rest % states[i].num_values;
    rest = Math.floor(rest / states[i].num_values);
  }
  return { block, states, def, index: new Map(states.map((s, i) => [s.name, i])) };
}

/** Индекс значения value у свойства state или -1, если такого значения у свойства нет. */
function valueIndex(state, value) {
  if (state.type === 'bool' && !state.values) {
    if (value === true || value === 'true') return 0;
    return value === false || value === 'false' ? 1 : -1;
  }
  const i = state.values ? state.values.indexOf(String(value)) : Number(value);
  return Number.isInteger(i) && i >= 0 && i < state.num_values ? i : -1;
}

/** Собирает номер состояния: свойства по умолчанию, поверх — подходящие из каждого набора по очереди. */
function encodeState(codec, ...sets) {
  const idx = codec.def.slice();
  for (const obj of sets) {
    if (!obj) continue;
    for (const key of Object.keys(obj)) {
      const i = codec.index.get(key);
      const v = i === undefined ? -1 : valueIndex(codec.states[i], obj[key]);
      if (v >= 0) idx[i] = v;
    }
  }
  let data = 0;
  for (let i = 0; i < idx.length; i++) data = data * codec.states[i].num_values + idx[i];
  return codec.block.minStateId + data;
}

/** Варианты замены по порядку: [имя, принудительные свойства]. */
function candidates(name) {
  const out = [];
  const add = (list, props = null) => {
    for (const n of [].concat(list)) out.push([n, props]);
  };
  const base = name.replace(/^waxed_/, '').replace(/^(exposed|weathered|oxidized)_/, '');
  for (const n of base === name ? [name] : [name, base]) {
    add(n);
    if (ALIASES.has(n)) add(ALIASES.get(n));
  }
  const wood = base.match(WOOD_RE);
  if (wood && wood[2] !== 'oak') add(base.replace(WOOD_RE, `${wood[1] || ''}oak_`));
  const rule = FAMILY.find(([re]) => re.test(base));
  if (rule) add(typeof rule[1] === 'function' ? rule[1](base) : rule[1], rule[2] || null);
  return out;
}

/*
 * «Прямой» контейнер (больше 256 разных блоков в секции): prismarine-chunk теряет его содержимое
 * при fromJson (конструктор DirectPaletteContainer не берёт data) — и в node, и в бандле просмотра,
 * секция стала бы пустой. Поэтому пересобираем его в контейнер с палитрой: тот данные сохраняет.
 */
function directToIndirect(container, map, bits, globalBits) {
  const src = BitArray.fromJson(container.data);
  const n = src.capacity;
  const palette = [];
  const slots = new Map();
  const idx = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const id = map ? map(src.get(i)) : src.get(i);
    let k = slots.get(id);
    if (k === undefined) {
      k = palette.length;
      palette.push(id);
      slots.set(id, k);
    }
    idx[i] = k;
  }
  const data = new BitArray({ bitsPerValue: Math.max(bits.min, neededBits(palette.length - 1)), capacity: n });
  for (let i = 0; i < n; i++) data.set(i, idx[i]);
  return {
    type: 'indirect',
    palette,
    maxBits: bits.max,
    maxBitsPerBlock: Math.max(globalBits, src.bitsPerValue), // ширина, если клиент сам перейдёт на «прямой»
    data: data.toJson(),
  };
}

/** Секция чанка 1.18+: переводит номера блоков (map = null — только чинит «прямой» контейнер). */
function convertSection(json, map, globalBits) {
  if (!map && !HAS_DIRECT.test(json)) return json;
  const section = JSON.parse(json);
  let c = JSON.parse(section.data);
  if (c.type === 'direct') {
    c = directToIndirect(c, map, BLOCK_BITS, globalBits);
  } else if (map) {
    if (c.type === 'single') c.value = map(c.value);
    else if (c.type === 'indirect') c.palette = c.palette.map(map);
    else throw new Error(`Неизвестный тип секции чанка: ${c.type}`);
    if (!(c.maxBitsPerBlock >= globalBits)) c.maxBitsPerBlock = globalBits;
  }
  section.data = JSON.stringify(c);
  return JSON.stringify(section);
}

/** Секция биомов: «прямой» контейнер пересобираем с палитрой, номера биомов не меняются. */
function convertBiomes(json) {
  if (!HAS_DIRECT.test(json)) return json;
  const c = JSON.parse(json);
  return c.type === 'direct' ? JSON.stringify(directToIndirect(c, null, BIOME_BITS, 0)) : json;
}

const isModernColumn = (col) => Boolean(col) && typeof col.minY === 'number' &&
  Array.isArray(col.sections) && Array.isArray(col.biomes);

/** Колонка 1.18+ (разобранный JSON): меняем только секции и биомы, остальное (свет, minY…) как есть. */
function convertColumn(col, map, globalBits) {
  col.sections = col.sections.map((s) => (typeof s === 'string' ? convertSection(s, map, globalBits) : s));
  col.biomes = col.biomes.map((b) => (typeof b === 'string' ? convertBiomes(b) : b));
  return col;
}

/**
 * Чинит JSON колонки 1.18+ без перевода номеров (бот и просмотр на одной версии): «прямые»
 * секции пересобирает с палитрой, иначе клиент покажет их пустыми. Если чинить нечего —
 * возвращает ту же строку.
 */
function fixChunkJson(json) {
  if (typeof json !== 'string' || !HAS_DIRECT.test(json)) return json;
  const col = JSON.parse(json);
  return isModernColumn(col) ? JSON.stringify(convertColumn(col, null, 0)) : json;
}

/**
 * Переводчик номеров блоков из версии бота в версию просмотра.
 * null — перевод не нужен (версии или реестры блоков совпадают) или невозможен (до 1.13, неизвестная версия).
 */
function createStateTranslator(fromVersion, toVersion, mcData = require('minecraft-data')) {
  if (String(fromVersion) === String(toVersion)) return null;
  const src = dataFor(mcData, fromVersion);
  const dst = dataFor(mcData, toVersion);
  if (!src || !dst || !isFlat(src) || !isFlat(dst) || sameRegistry(src, dst)) return null;

  const SrcBlock = require('prismarine-block')(String(fromVersion)); // имя и свойства состояния источника
  const maxSrc = src.blocksArray.reduce((m, b) => Math.max(m, b.maxStateId), 0);
  const globalBits = neededBits(dst.blocksArray.reduce((m, b) => Math.max(m, b.maxStateId), 0));
  const cache = new Int32Array(maxSrc + 1).fill(-1); // номер у источника → номер в просмотре
  const codecs = new Map(); // имя блока просмотра → его кодек
  const resolved = new Map(); // имя блока источника → { codec, forced } | null (замены нет)
  const unknownNames = new Set();
  const modernSrc = dvOf(src) >= MODERN_CHUNKS_DV;
  const modernDst = dvOf(dst) >= MODERN_CHUNKS_DV;
  let chunkClasses = null;

  const codecOf = (name) => {
    let codec = codecs.get(name);
    if (!codec) codecs.set(name, (codec = makeCodec(dst.blocksByName[name])));
    return codec;
  };
  const airId = codecOf('air').block.defaultState;

  function resolve(name) {
    for (const [candidate, forced] of candidates(name)) {
      if (hasOwn(dst.blocksByName, candidate)) return { codec: codecOf(candidate), forced };
    }
    return null;
  }

  function translate(id) {
    const info = src.blocksByStateId[id];
    if (!info) return airId;
    const block = SrcBlock.fromStateId(id, 0);
    if (!resolved.has(block.name)) resolved.set(block.name, resolve(block.name));
    let target = resolved.get(block.name);
    if (!target) {
      // Совсем незнакомый блок: сплошной куб показываем камнем, остальное — воздухом.
      unknownNames.add(block.name);
      target = { codec: codecOf(isCube(block.shapes) ? 'stone' : 'air'), forced: null };
    }
    const props = block.getProperties();
    const rule = PROP_RULES.get(target.codec.block.name);
    return encodeState(target.codec, props, rule ? rule(props) : null, target.forced);
  }

  /** Номер состояния в версии просмотра; неизвестный номер — воздух. Никогда не бросает. */
  function stateId(id) {
    if (!Number.isInteger(id) || id < 0 || id > maxSrc) return airId;
    let t = cache[id];
    if (t < 0) {
      try {
        t = translate(id);
      } catch (_) {
        t = airId; // сбой разбора одного состояния не должен ронять показ мира
      }
      cache[id] = t;
    }
    return t;
  }

  // Другие форматы (до 1.18 или разные у сторон): разбираем чанк целиком и копируем блок за блоком.
  function slowChunkJson(json) {
    if (!chunkClasses) {
      const Chunk = require('prismarine-chunk');
      chunkClasses = { From: Chunk(String(fromVersion)), To: Chunk(String(toVersion)) };
    }
    const a = chunkClasses.From.fromJson(json);
    const aMin = a.minY ?? 0;
    const aHeight = a.worldHeight ?? 256;
    // Чанки до 1.18 хранят высоту 0..256 без minY в JSON — для них колонку создаём по умолчанию.
    const b = new chunkClasses.To(modernDst ? { minY: aMin, worldHeight: aHeight } : undefined);
    const bMin = b.minY ?? 0;
    const lo = Math.max(aMin, bMin);
    const hi = Math.min(aMin + aHeight, bMin + (b.worldHeight ?? 256));
    const p = new Vec3(0, 0, 0);
    for (let y0 = lo; y0 < hi; y0 += 16) {
      const sec = Array.isArray(a.sections) ? a.sections[(y0 - aMin) >> 4] : undefined;
      if (sec === null || (sec && typeof sec.isEmpty === 'function' && sec.isEmpty())) continue; // пустая
      for (p.y = y0; p.y < Math.min(y0 + 16, hi); p.y++) {
        for (p.z = 0; p.z < 16; p.z++) {
          for (p.x = 0; p.x < 16; p.x++) {
            const id = a.getBlockStateId(p);
            if (id) b.setBlockStateId(p, stateId(id));
          }
        }
      }
    }
    if (typeof a.getBiome === 'function' && typeof b.setBiome === 'function') {
      for (p.y = lo; p.y < hi; p.y += 4) { // биомы хранятся кубиками 4×4×4 (или столбцами)
        for (p.z = 0; p.z < 16; p.z++) {
          for (p.x = 0; p.x < 16; p.x++) b.setBiome(p, a.getBiome(p));
        }
      }
    }
    if (a.blockEntities && typeof a.blockEntities === 'object') b.blockEntities = { ...a.blockEntities };
    const out = b.toJson();
    return modernDst ? fixChunkJson(out) : out;
  }

  /** JSON колонки из prismarine-chunk версии бота → JSON колонки версии просмотра (новая строка). */
  function chunkJson(json) {
    if (modernSrc && modernDst) {
      const col = JSON.parse(json);
      if (isModernColumn(col)) return JSON.stringify(convertColumn(col, stateId, globalBits));
    }
    return slowChunkJson(json);
  }

  return {
    fromVersion: String(fromVersion),
    toVersion: String(toVersion),
    stateId,
    chunkJson,
    unknownNames,
  };
}

module.exports = { pickViewerVersion, createStateTranslator, fixChunkJson };
