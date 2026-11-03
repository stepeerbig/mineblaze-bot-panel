'use strict';

// Перевод номеров блоков для окна «Экран бота» (src/viewer/block-translator.js).
// Запуск: node --test test/viewer-translator.test.js. Сеть и сервер Minecraft не нужны:
// чанки собираются здесь же через prismarine-chunk, проверка — через prismarine-block.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const mcData = require('minecraft-data');
const PBlock = require('prismarine-block');
const PChunk = require('prismarine-chunk');
const { Vec3 } = require('vec3');
const { supportedVersions } = require('prismarine-viewer/viewer/lib/version.js');

const { pickViewerVersion, createStateTranslator, fixChunkJson } =
  require(path.join(__dirname, '..', 'src', 'viewer', 'block-translator.js'));

const blockClasses = {};
const blockClass = (v) => blockClasses[v] || (blockClasses[v] = PBlock(v));
const maxState = (v) => mcData(v).blocksArray.reduce((m, b) => Math.max(m, b.maxStateId), 0);

/** Имя и свойства состояния так, как их видит prismarine-block. */
function describeState(version, id) {
  const b = blockClass(version).fromStateId(id, 0);
  return { name: b.name, props: { ...b.getProperties() } };
}

/** Номер состояния по имени и части свойств (остальные — как у состояния по умолчанию). */
function stateOf(version, name, props = {}) {
  const info = mcData(version).blocksByName[name];
  assert.ok(info, `в ${version} нет блока ${name}`);
  const B = blockClass(version);
  const all = { ...B.fromStateId(info.defaultState, 0).getProperties(), ...props };
  const id = B.fromProperties(name, all, 0).stateId;
  assert.deepEqual(describeState(version, id), { name, props: all }, `неверно заданы свойства ${name}`);
  return id;
}

/** Проверка одного перевода: блок name с props из from должен стать wantName со всеми свойствами wantProps. */
const translated = (tr, from, to) => (name, props, wantName, wantProps) => {
  const got = describeState(to, tr.stateId(stateOf(from, name, props)));
  assert.deepEqual(got, { name: wantName, props: wantProps }, `${name} ${JSON.stringify(props)}`);
};

/** Каждое состояние блоков с одинаковыми именем и свойствами в обеих версиях переходит в такое же. */
function checkCommonBlocks(tr, from, to) {
  const other = mcData(to).blocksByName;
  const bad = [];
  let checked = 0;
  for (const block of mcData(from).blocksArray) {
    const same = other[block.name];
    if (!same || JSON.stringify(same.states) !== JSON.stringify(block.states)) continue;
    for (let id = block.minStateId; id <= block.maxStateId; id++) {
      const want = describeState(from, id);
      const got = describeState(to, tr.stateId(id));
      if (!isDeepStrictEqual(got, want)) bad.push({ id, want, got });
      checked++;
    }
  }
  assert.deepEqual(bad.slice(0, 3), [], `расхождений: ${bad.length}`);
  return checked;
}

/** Обходит все позиции колонки по высоте minY..minY+height. */
function forEachPos(minY, height, fn) {
  const p = new Vec3(0, 0, 0);
  for (p.y = minY; p.y < minY + height; p.y++) {
    for (p.z = 0; p.z < 16; p.z++) {
      for (p.x = 0; p.x < 16; p.x++) fn(p);
    }
  }
}

/** В переведённой колонке back каждый блок — перевод блока из src (detailed — ещё имя и свойства). */
function assertTranslated(tr, src, back, toVersion, { minY, height, detailed = false }) {
  const wrong = [];
  forEachPos(minY, height, (p) => {
    const id = src.getBlockStateId(p);
    const want = tr.stateId(id);
    const got = back.getBlockStateId(p);
    if (got !== want) wrong.push({ pos: p.toString(), id, want, got });
    if (detailed && id) {
      const b = back.getBlock(p);
      if (!isDeepStrictEqual({ name: b.name, props: { ...b.getProperties() } }, describeState(toVersion, want))) {
        wrong.push({ pos: p.toString(), id, name: b.name });
      }
    }
  });
  assert.deepEqual(wrong.slice(0, 3), [], `ошибок: ${wrong.length}`);
}

/** Тип контейнера каждой секции блоков в JSON колонки формата 1.18+. */
const sectionTypes = (json) => JSON.parse(json).sections.map((s) => JSON.parse(JSON.parse(s).data).type);

// ---------- выбор версии просмотра ----------

test('версия просмотра: точная, последняя из той же ветки или ближайшая (26.1)', () => {
  const table = {
    '1.21.4': ['1.21.4', false],
    '1.20.1': ['1.20.1', false],
    '1.8.8': ['1.8.8', false],
    '1.21.11': ['1.21.4', true],
    '1.21': ['1.21.4', true],
    '1.21.5': ['1.21.4', true],
    '1.20.4': ['1.20.1', true],
    '1.19.4': ['1.19', true],
    '1.18.2': ['1.18.1', true],
    '1.17': ['1.17.1', true],
    '1.16.5': ['1.16.4', true],
    '1.13': ['1.13.2', true],
    '26.1': ['1.21.4', true],
    '26.1.2': ['1.21.4', true],
    '1.8.9': ['1.8.8', false],
    '1.9': ['1.9.4', false],
    '1.12.1': ['1.12.2', false],
    '1.12.2': ['1.12.2', false],
  };
  for (const [v, [viewerVersion, translate]] of Object.entries(table)) {
    assert.deepEqual(pickViewerVersion(v, supportedVersions), { viewerVersion, translate }, v);
  }
  // 0.30c minecraft-data знает, но клиент такое не рисует; остальное — неизвестные версии или Bedrock
  for (const v of ['0.30c', '1.7.10', '9.9.9', 'abc', '', null, undefined, 'bedrock_1.20.0']) {
    assert.equal(pickViewerVersion(v, supportedVersions), null, String(v));
  }
});

test('версия просмотра: свой список версий клиента и список по умолчанию', () => {
  assert.deepEqual(pickViewerVersion('1.21.11'), { viewerVersion: '1.21.4', translate: true }); // список prismarine-viewer
  assert.deepEqual(pickViewerVersion('1.21.11', ['1.20.1', '1.16.4']), { viewerVersion: '1.20.1', translate: true });
  assert.deepEqual(pickViewerVersion('26.1', ['1.21.1', '1.12.2', '1.20.1']), { viewerVersion: '1.21.1', translate: true });
  // старше бота ничего нет — берём самую старую из более новых
  assert.deepEqual(pickViewerVersion('1.20.4', ['1.21.4', '1.21.1']), { viewerVersion: '1.21.1', translate: true });
  assert.equal(pickViewerVersion('1.21.11', ['1.12.2', '1.8.8']), null); // нет версий 1.13+
  assert.equal(pickViewerVersion('1.12.2', ['1.13.2']), null); // до 1.13 — только та же ветка
  assert.equal(pickViewerVersion('1.21.11', []), null);
  // minecraft-data без таблицы версий: dataVersion берётся из данных самой версии
  const plain = (v) => mcData(v);
  assert.deepEqual(pickViewerVersion('26.1', supportedVersions, plain), { viewerVersion: '1.21.4', translate: true });
  assert.deepEqual(pickViewerVersion('1.20.4', supportedVersions, plain), { viewerVersion: '1.20.1', translate: true });
});

test('версия просмотра: для каждой версии из minecraft-data — версия из списка клиента', () => {
  const versions = [...new Set(mcData.versions.pc.map((v) => v.minecraftVersion))]
    .filter((v) => /^\d+(\.\d+)+$/.test(v));
  let shown = 0;
  for (const v of versions) {
    const r = pickViewerVersion(v, supportedVersions);
    const data = mcData(v);
    if (!data || v.split('.').slice(0, 2).join('.') === '1.7') {
      assert.equal(r, null, v); // нет данных или ветка 1.7, которую клиент не рисует
      continue;
    }
    assert.ok(r && supportedVersions.includes(r.viewerVersion), v);
    const exact = supportedVersions.includes(v);
    if (exact) assert.equal(r.viewerVersion, v);
    assert.equal(r.translate, !exact && data.version.dataVersion >= 1519, v);
    shown++;
  }
  assert.ok(shown >= 60, `проверено версий: ${shown}`);
});

// ---------- перевод номеров состояний ----------

test('переводчик не нужен: та же версия, одинаковые реестры блоков, версии до 1.13', () => {
  assert.equal(createStateTranslator('1.21.4', '1.21.4'), null);
  assert.equal(createStateTranslator('1.16.5', '1.16.4'), null);
  assert.equal(createStateTranslator('1.18.2', '1.18.1'), null);
  assert.equal(createStateTranslator('1.19.2', '1.19'), null);
  assert.equal(createStateTranslator('1.12.2', '1.8.8'), null);
  assert.equal(createStateTranslator('1.12.2', '1.13.2'), null);
  assert.equal(createStateTranslator('9.9.9', '1.21.4'), null);
  const tr = createStateTranslator('1.21.11', '1.21.4', mcData);
  assert.equal(tr.fromVersion, '1.21.11');
  assert.equal(tr.toVersion, '1.21.4');
  assert.ok(tr.unknownNames instanceof Set);
});

test('1.21.11 → 1.21.4: каждое состояние одинаковых блоков — те же имя и свойства', () => {
  const tr = createStateTranslator('1.21.11', '1.21.4');
  const checked = checkCommonBlocks(tr, '1.21.11', '1.21.4');
  assert.ok(checked > 27000, `проверено состояний: ${checked}`);
});

test('1.21.11 → 1.21.4: получается каждое состояние 1.21.4, незнакомых блоков нет', () => {
  // Вместе с предыдущим тестом это сверка кодировщика с prismarine-block на всех состояниях 1.21.4.
  const tr = createStateTranslator('1.21.11', '1.21.4');
  const maxTo = maxState('1.21.4');
  const maxFrom = maxState('1.21.11');
  const seen = new Uint8Array(maxTo + 1);
  for (let id = 0; id <= maxFrom; id++) {
    const t = tr.stateId(id);
    assert.ok(Number.isInteger(t) && t >= 0 && t <= maxTo, `${id} → ${t}`);
    seen[t] = 1;
  }
  assert.deepEqual([...seen.keys()].filter((i) => !seen[i]), []);
  assert.deepEqual([...tr.unknownNames], []); // для каждого нового блока есть правило
});

test('1.21.11 → 1.21.4: переименованные, новые и изменённые блоки', () => {
  const tr = createStateTranslator('1.21.11', '1.21.4');
  const check = translated(tr, '1.21.11', '1.21.4');
  check('stone', {}, 'stone', {});
  check('grass_block', { snowy: true }, 'grass_block', { snowy: true });
  check('grass_block', { snowy: false }, 'grass_block', { snowy: false });
  const stairs = { facing: 'east', half: 'top', shape: 'outer_left', waterlogged: true };
  check('oak_stairs', stairs, 'oak_stairs', stairs);
  for (let level = 0; level < 16; level++) check('water', { level: String(level) }, 'water', { level: String(level) });
  check('wildflowers', { facing: 'west', flower_amount: '3' }, 'pink_petals', { facing: 'west', flower_amount: '3' });
  check('iron_chain', { axis: 'x' }, 'chain', { axis: 'x', waterlogged: false });
  check('exposed_copper_chain', { axis: 'z', waterlogged: true }, 'chain', { axis: 'z', waterlogged: true });
  check('waxed_oxidized_copper_chest', { facing: 'west', type: 'left' }, 'chest',
    { facing: 'west', type: 'left', waterlogged: false });
  check('copper_wall_torch', { facing: 'north' }, 'wall_torch', { facing: 'north' });
  check('copper_torch', {}, 'torch', {});
  check('weathered_copper_lantern', { hanging: true }, 'lantern', { hanging: true, waterlogged: false });
  check('waxed_exposed_copper_bars', { north: true, east: true }, 'iron_bars',
    { north: true, east: true, south: false, west: false, waterlogged: false });
  check('waxed_lightning_rod', { facing: 'down', powered: true }, 'lightning_rod',
    { facing: 'down', powered: true, waterlogged: false });
  check('oak_shelf', { facing: 'east', waterlogged: true }, 'oak_slab', { type: 'top', waterlogged: true });
  check('pale_oak_shelf', {}, 'pale_oak_slab', { type: 'top', waterlogged: false });
  check('creaking_heart', { creaking_heart_state: 'awake', axis: 'z', natural: true }, 'creaking_heart',
    { active: true, axis: 'z', natural: true });
  check('creaking_heart', { creaking_heart_state: 'dormant', axis: 'x' }, 'creaking_heart',
    { active: false, axis: 'x', natural: false });
  check('creaking_heart', { creaking_heart_state: 'uprooted' }, 'creaking_heart', { active: false, axis: 'y', natural: false });
  check('bush', {}, 'short_grass', {});
  check('firefly_bush', {}, 'short_grass', {});
  check('short_dry_grass', {}, 'dead_bush', {});
  check('tall_dry_grass', {}, 'dead_bush', {});
  check('leaf_litter', { segment_amount: '4' }, 'air', {});
  check('cactus_flower', {}, 'air', {});
  check('dried_ghast', {}, 'air', {});
  check('oxidized_copper_golem_statue', {}, 'air', {});
  check('test_block', {}, 'air', {});
  // незнакомые номера и мусор — воздух, исключений нет
  for (const bad of [999999, maxState('1.21.11') + 1, -1, 1.5, NaN, Infinity, '5', null, undefined, {}]) {
    assert.equal(tr.stateId(bad), 0, String(bad));
  }
  assert.deepEqual([...tr.unknownNames], []);
});

test('1.21.4 → 1.21.11: обратный перевод тоже точный', () => {
  const tr = createStateTranslator('1.21.4', '1.21.11');
  assert.ok(checkCommonBlocks(tr, '1.21.4', '1.21.11') > 27000);
  const check = translated(tr, '1.21.4', '1.21.11');
  check('chain', { axis: 'z', waterlogged: true }, 'iron_chain', { axis: 'z', waterlogged: true });
  check('creaking_heart', { active: true, axis: 'x', natural: true }, 'creaking_heart',
    { axis: 'x', creaking_heart_state: 'awake', natural: true });
  check('creaking_heart', { active: false }, 'creaking_heart', { axis: 'y', creaking_heart_state: 'uprooted', natural: false });
  assert.deepEqual([...tr.unknownNames], []);
});

test('26.1 → 1.21.4: золотой одуванчик и новые инструменты нотного блока', () => {
  const tr = createStateTranslator('26.1', '1.21.4');
  const check = translated(tr, '26.1', '1.21.4');
  check('golden_dandelion', {}, 'dandelion', {});
  check('potted_golden_dandelion', {}, 'potted_dandelion', {});
  check('note_block', { instrument: 'trumpet', note: '12', powered: true }, 'note_block',
    { instrument: 'harp', note: '12', powered: true }); // такого инструмента нет — по умолчанию
  check('note_block', { instrument: 'banjo', note: '3' }, 'note_block', { instrument: 'banjo', note: '3', powered: false });
  assert.ok(checkCommonBlocks(tr, '26.1', '1.21.4') > 26000); // без нотного блока (1150 состояний)
  const maxFrom = maxState('26.1');
  for (let id = 0; id <= maxFrom; id++) tr.stateId(id);
  assert.deepEqual([...tr.unknownNames], []);
});

test('старые пары версий: похожие блоки, а незнакомые — камнем или воздухом', () => {
  const tr = createStateTranslator('1.20.4', '1.20.1');
  const check = translated(tr, '1.20.4', '1.20.1');
  check('short_grass', {}, 'grass', {});
  check('tuff_stairs', { facing: 'east', half: 'top' }, 'stone_stairs',
    { facing: 'east', half: 'top', shape: 'straight', waterlogged: false });
  check('polished_tuff_wall', { up: false, north: 'tall' }, 'cobblestone_wall',
    { east: 'none', north: 'tall', south: 'none', up: false, waterlogged: false, west: 'none' });
  check('waxed_exposed_copper_door', { facing: 'south', half: 'upper', hinge: 'right', open: true }, 'oak_door',
    { facing: 'south', half: 'upper', hinge: 'right', open: true, powered: false });
  check('trial_spawner', {}, 'spawner', {});
  check('polished_tuff', {}, 'stone', {}); // сплошной куб без правила
  assert.deepEqual([...tr.unknownNames], ['polished_tuff']);

  const old = createStateTranslator('1.19.4', '1.19');
  const check19 = translated(old, '1.19.4', '1.19');
  check19('cherry_stairs', { facing: 'west', shape: 'inner_left' }, 'oak_stairs',
    { facing: 'west', half: 'bottom', shape: 'inner_left', waterlogged: false });
  check19('cherry_leaves', { distance: '3', persistent: true }, 'oak_leaves',
    { distance: '3', persistent: true, waterlogged: false });
  check19('stripped_cherry_log', { axis: 'x' }, 'stripped_oak_log', { axis: 'x' });
  check19('potted_cherry_sapling', {}, 'potted_oak_sapling', {});
  check19('potted_torchflower', {}, 'flower_pot', {});
  check19('suspicious_sand', {}, 'sand', {});
  check19('bamboo_mosaic', {}, 'stone', {});
  check19('decorated_pot', {}, 'air', {});
  check19('cherry_hanging_sign', {}, 'air', {}); // висячих табличек в 1.19 ещё нет
  assert.deepEqual([...old.unknownNames].sort(), ['bamboo_mosaic', 'cherry_hanging_sign', 'decorated_pot']);
});

test('числовые свойства со списком значений и без него (данные 1.18 и 1.19)', () => {
  // В данных 1.18.2 возраст пшеницы — просто число, в 1.19 — строка из списка values.
  translated(createStateTranslator('1.18.2', '1.19'), '1.18.2', '1.19')('wheat', { age: 5 }, 'wheat', { age: '5' });
  translated(createStateTranslator('1.19', '1.18.2'), '1.19', '1.18.2')('wheat', { age: '6' }, 'wheat', { age: 6 });
});

// ---------- перевод чанков ----------

test('чанк 1.21.11 → 1.21.4: секции из одного блока, с палитрой и «прямые»', () => {
  const tr = createStateTranslator('1.21.11', '1.21.4');
  const Chunk = PChunk('1.21.11');
  const col = new Chunk({ minY: -64, worldHeight: 384 });
  // y -64..-49: секция из одного блока
  col.sections[0] = new Chunk.section({
    singleValue: stateOf('1.21.11', 'deepslate'), maxBitsPerBlock: col.maxBitsPerBlock, noSizePrefix: true,
  });
  // y -48..-33: несколько блоков с палитрой, в том числе новые в 1.21.5+
  const special = [
    [new Vec3(1, -40, 2), 'iron_chain', { axis: 'x' }, 'chain', { axis: 'x', waterlogged: false }],
    [new Vec3(5, -35, 9), 'waxed_oxidized_copper_chest', { facing: 'west', type: 'left' }, 'chest',
      { facing: 'west', type: 'left', waterlogged: false }],
    [new Vec3(0, -48, 0), 'leaf_litter', {}, 'air', {}],
    [new Vec3(15, -33, 15), 'oak_shelf', { waterlogged: true }, 'oak_slab', { type: 'top', waterlogged: true }],
    [new Vec3(7, -41, 3), 'creaking_heart', { creaking_heart_state: 'awake', axis: 'x' }, 'creaking_heart',
      { active: true, axis: 'x', natural: false }],
    [new Vec3(8, -36, 8), 'wildflowers', { facing: 'south', flower_amount: '2' }, 'pink_petals',
      { facing: 'south', flower_amount: '2' }],
  ];
  for (const [p, name, props] of special) col.setBlockStateId(p, stateOf('1.21.11', name, props));
  // y 0..15: обычная местность
  const layers = ['stone', 'stone', 'dirt', 'grass_block', 'short_grass'].map((n) => stateOf('1.21.11', n));
  forEachPos(0, 16, (p) => { if (p.y < layers.length) col.setBlockStateId(p, layers[p.y]); });
  // y 32..47: 4096 разных состояний — prismarine-chunk переходит на «прямой» контейнер
  const max = maxState('1.21.11');
  let k = 0;
  forEachPos(32, 16, (p) => col.setBlockStateId(p, 1 + ((k++ * 37) % max)));
  // там же 64 разных биома — «прямой» контейнер биомов
  for (let i = 0; i < 64; i++) col.setBiome(new Vec3((i & 3) * 4, 32 + ((i >> 2) & 3) * 4, (i >> 4) * 4), i);

  const json = col.toJson();
  const types = sectionTypes(json);
  assert.deepEqual([types[0], types[1], types[4], types[6], types[7]], ['single', 'indirect', 'indirect', 'direct', 'single']);
  assert.equal(JSON.parse(JSON.parse(json).biomes[6]).type, 'direct');

  const out = tr.chunkJson(json);
  assert.equal(col.toJson(), json); // исходный чанк не тронут
  assert.equal(tr.chunkJson(json), out); // повторный перевод даёт то же
  const outTypes = sectionTypes(out);
  assert.equal(outTypes[0], 'single');
  assert.equal(outTypes[6], 'indirect'); // «прямой» пересобран с палитрой, иначе fromJson его потеряет
  assert.ok(JSON.parse(JSON.parse(JSON.parse(out).sections[6]).data).palette.length > 256);
  // остальные поля (свет, minY, высота, биомы других секций) не изменились
  const a = JSON.parse(json);
  const b = JSON.parse(out);
  assert.deepEqual(b.biomes.filter((_, i) => i !== 6), a.biomes.filter((_, i) => i !== 6));
  for (const o of [a, b]) {
    delete o.sections;
    delete o.biomes;
  }
  assert.deepEqual(b, a);

  const back = PChunk('1.21.4').fromJson(out);
  assertTranslated(tr, col, back, '1.21.4', { minY: -64, height: 384, detailed: true });
  for (const [p, name, , wantName, wantProps] of special) {
    assert.deepEqual(describeState('1.21.4', back.getBlockStateId(p)), { name: wantName, props: wantProps }, name);
  }
  assert.equal(back.getBlockStateId(new Vec3(4, -60, 4)), stateOf('1.21.4', 'deepslate'));
  forEachPos(-64, 384, (p) => assert.equal(back.getBiome(p), col.getBiome(p)));
  assert.throws(() => tr.chunkJson('не JSON'));
});

test('чанк 1.20.4 → 1.20.1: старая пара версий (тоже формат 1.18+)', () => {
  const tr = createStateTranslator('1.20.4', '1.20.1');
  const col = new (PChunk('1.20.4'))({ minY: -64, worldHeight: 384 });
  const blocks = [
    [new Vec3(0, -60, 0), 'short_grass', {}, 'grass', {}],
    [new Vec3(3, 70, 4), 'tuff_stairs', { facing: 'east' }, 'stone_stairs',
      { facing: 'east', half: 'bottom', shape: 'straight', waterlogged: false }],
    [new Vec3(15, 100, 15), 'polished_tuff', {}, 'stone', {}],
    [new Vec3(9, 5, 2), 'oak_log', { axis: 'z' }, 'oak_log', { axis: 'z' }],
  ];
  for (const [p, name, props] of blocks) col.setBlockStateId(p, stateOf('1.20.4', name, props));
  const back = PChunk('1.20.1').fromJson(tr.chunkJson(col.toJson()));
  for (const [p, name, , wantName, wantProps] of blocks) {
    assert.deepEqual(describeState('1.20.1', back.getBlockStateId(p)), { name: wantName, props: wantProps }, name);
  }
  assertTranslated(tr, col, back, '1.20.1', { minY: -64, height: 384 });
});

test('чанк 1.16 → 1.16.4: старый формат чанков (через prismarine-chunk)', () => {
  const tr = createStateTranslator('1.16', '1.16.4');
  const col = new (PChunk('1.16'))();
  const blocks = [
    [new Vec3(1, 10, 1), 'chain', { waterlogged: true }, 'chain', { axis: 'y', waterlogged: true }],
    [new Vec3(2, 11, 3), 'lantern', { hanging: true }, 'lantern', { hanging: true, waterlogged: false }],
    [new Vec3(4, 64, 4), 'wheat', { age: 5 }, 'wheat', { age: 5 }],
  ];
  for (const [p, name, props] of blocks) col.setBlockStateId(p, stateOf('1.16', name, props));
  const max = maxState('1.16');
  let k = 0;
  forEachPos(48, 16, (p) => col.setBlockStateId(p, 1 + ((k++ * 31) % max))); // глобальная палитра
  col.setBiome(new Vec3(8, 64, 8), 7);

  const back = PChunk('1.16.4').fromJson(tr.chunkJson(col.toJson()));
  for (const [p, name, , wantName, wantProps] of blocks) {
    assert.deepEqual(describeState('1.16.4', back.getBlockStateId(p)), { name: wantName, props: wantProps }, name);
  }
  assertTranslated(tr, col, back, '1.16.4', { minY: 0, height: 256 });
  assert.equal(back.getBiome(new Vec3(8, 64, 8)), 7);
});

test('чанк между форматами до 1.18 и 1.18+ — блоки на своих местах', () => {
  // старый → новый: высота 0..256, «прямая» секция пересобирается с палитрой
  const up = createStateTranslator('1.16.4', '1.20.1');
  const col = new (PChunk('1.16.4'))();
  const max = maxState('1.16.4');
  let k = 0;
  forEachPos(16, 16, (p) => col.setBlockStateId(p, 1 + ((k++ * 31) % max)));
  col.setBlockStateId(new Vec3(2, 200, 2), stateOf('1.16.4', 'grass'));
  const out = up.chunkJson(col.toJson());
  assert.equal(JSON.parse(out).minY, 0);
  assert.ok(!sectionTypes(out).includes('direct'));
  assertTranslated(up, col, PChunk('1.20.1').fromJson(out), '1.20.1', { minY: 0, height: 256 });

  // новый → старый: что ниже 0 и выше 255 — не помещается, остальное без сдвига
  const down = createStateTranslator('1.20.4', '1.16.4');
  const col2 = new (PChunk('1.20.4'))({ minY: -64, worldHeight: 384 });
  const stone = stateOf('1.20.4', 'stone');
  for (const y of [-10, 0, 255, 256]) col2.setBlockStateId(new Vec3(1, y, 1), stone);
  col2.setBlockStateId(new Vec3(1, 10, 1), stateOf('1.20.4', 'oak_log', { axis: 'z' }));
  const back = PChunk('1.16.4').fromJson(down.chunkJson(col2.toJson()));
  assert.deepEqual(describeState('1.16.4', back.getBlockStateId(new Vec3(1, 10, 1))), { name: 'oak_log', props: { axis: 'z' } });
  assert.equal(describeState('1.16.4', back.getBlockStateId(new Vec3(1, 0, 1))).name, 'stone');
  assert.equal(describeState('1.16.4', back.getBlockStateId(new Vec3(1, 255, 1))).name, 'stone');
  assert.equal(back.getBlockStateId(new Vec3(1, 1, 1)), 0);
});

test('fixChunkJson: без перевода номеров чинит только «прямые» секции', () => {
  const Chunk = PChunk('1.21.4');
  const col = new Chunk({ minY: -64, worldHeight: 384 });
  col.setBlockStateId(new Vec3(0, 0, 0), 1);
  const plain = col.toJson();
  assert.equal(sectionTypes(plain)[4], 'indirect');
  // чинить нечего — строка возвращается как есть, без разбора (пробел остался на месте)
  const spaced = plain.replace('{', '{ ');
  assert.equal(fixChunkJson(spaced), spaced);
  let k = 0;
  forEachPos(16, 16, (p) => col.setBlockStateId(p, 1 + k++));
  const json = col.toJson();
  assert.equal(sectionTypes(json)[5], 'direct');
  const fixed = fixChunkJson(json);
  assert.equal(sectionTypes(fixed)[5], 'indirect');
  const back = Chunk.fromJson(fixed);
  let wrong = 0;
  forEachPos(-64, 384, (p) => { if (back.getBlockStateId(p) !== col.getBlockStateId(p)) wrong++; });
  assert.equal(wrong, 0);
  assert.equal(fixChunkJson('не JSON'), 'не JSON');
  assert.equal(fixChunkJson(undefined), undefined);
});

test('настоящий worker.js из prismarine-viewer рисует переведённый чанк так же, как эталон 1.21.4', async () => {
  const { Worker } = require('node:worker_threads');
  const publicDir = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public');
  const tr = createStateTranslator('1.21.11', '1.21.4');
  const src = new (PChunk('1.21.11'))({ minY: -64, worldHeight: 384 });
  const max = maxState('1.21.11');
  let k = 0;
  forEachPos(32, 16, (p) => src.setBlockStateId(p, 1 + ((k++ * 37) % max))); // «прямая» секция
  const ids = ['stone', 'iron_chain', 'oak_shelf', 'waxed_copper_chest', 'grass_block', 'wildflowers', 'water']
    .map((n) => stateOf('1.21.11', n));
  forEachPos(64, 6, (p) => src.setBlockStateId(p, ids[(p.x + p.y + p.z) % ids.length]));
  // эталон: те же блоки, сразу записанные номерами 1.21.4
  const ref = new (PChunk('1.21.4'))({ minY: -64, worldHeight: 384 });
  forEachPos(-64, 384, (p) => {
    const id = src.getBlockStateId(p);
    if (id) ref.setBlockStateId(p, tr.stateId(id));
  });

  // Колонки по очереди кладём на одно и то же место (часть моделей зависит от координат блока)
  // и просим построить геометрию двух секций: «прямой» и с палитрой.
  const worker = new Worker(path.join(publicDir, 'worker.js'));
  const keys = ['0,32,0', '0,64,0'];
  const mesh = (chunk) => new Promise((resolve, reject) => {
    const got = {};
    const done = (err) => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', done);
      if (err) reject(err);
      else resolve(got);
    };
    const onMessage = (m) => {
      if (m.type !== 'geometry') return;
      got[m.key] = m.geometry;
      if (keys.every((key) => got[key])) done(null);
    };
    const timer = setTimeout(() => done(new Error('worker.js не прислал геометрию')), 60000);
    worker.on('message', onMessage);
    worker.on('error', done);
    worker.postMessage({ type: 'unloadChunk', x: 0, z: 0 });
    worker.postMessage({ type: 'chunk', x: 0, z: 0, chunk });
    for (const key of keys) {
      const [x, y, z] = key.split(',').map(Number);
      worker.postMessage({ type: 'dirty', x, y, z, value: true });
    }
  });
  try {
    worker.postMessage({ type: 'version', version: '1.21.4' });
    worker.postMessage({ type: 'blockStates', json: require(path.join(publicDir, 'blocksStates', '1.21.4.json')) });
    const got = await mesh(tr.chunkJson(src.toJson()));
    const want = await mesh(fixChunkJson(ref.toJson()));
    for (const key of keys) {
      assert.ok(got[key].positions.length > 0, `секция ${key} пустая`);
      for (const field of ['positions', 'normals', 'colors', 'uvs']) {
        assert.deepEqual(Array.from(got[key][field]), Array.from(want[key][field]), `${field}, секция ${key}`);
      }
    }
  } finally {
    await worker.terminate();
  }
});

test('скорость: плотная колонка 1.21.11 переводится за миллисекунды', (t) => {
  const col = new (PChunk('1.21.11'))({ minY: -64, worldHeight: 384 });
  const max = maxState('1.21.11');
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
  for (let s = 0; s < 24; s++) {
    const kinds = s % 12 === 5 ? 400 : 40 + Math.floor(rnd() * 120); // две секции — «прямые»
    const pool = Array.from({ length: kinds }, () => 1 + Math.floor(rnd() * max));
    forEachPos(-64 + s * 16, 16, (p) => col.setBlockStateId(p, pool[Math.floor(rnd() * kinds)]));
  }
  const json = col.toJson();
  const tr = createStateTranslator('1.21.11', '1.21.4');
  const run = () => {
    const start = process.hrtime.bigint();
    const out = tr.chunkJson(json);
    return [Number(process.hrtime.bigint() - start) / 1e6, out];
  };
  const [cold, out] = run();
  const warm = Array.from({ length: 10 }, () => run()[0]).sort((a, b) => a - b);
  t.diagnostic(`колонка ${Math.round(json.length / 1024)} КБ, «прямых» секций: ` +
    `${sectionTypes(json).filter((x) => x === 'direct').length}; первый перевод ${cold.toFixed(1)} мс ` +
    `(с разбором новых состояний), дальше медиана ${warm[5].toFixed(1)} мс, лучший ${warm[0].toFixed(1)} мс`);
  assertTranslated(tr, col, PChunk('1.21.4').fromJson(out), '1.21.4', { minY: -64, height: 384 });
});
