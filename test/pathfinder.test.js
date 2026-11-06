'use strict';

// Поиск пути (src/bot/pathfinder.js) на поддельном мире: камень ниже y=64, воздух выше, отдельные клетки — свои.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { makeWorld, VERSION } = require('./fake-bot');

const { findPath } = require(path.join(__dirname, '..', 'src', 'bot', 'pathfinder.js'));

const registry = require('prismarine-registry')(VERSION);
const Block = require('prismarine-block')(registry);

/** Мир и getBlock; limit — дальше по x мир «не загружен» (null). */
function world(limit = Infinity) {
  const w = makeWorld(registry);
  const getBlock = (p) => (Math.abs(p.x) > limit || Math.abs(p.z) > limit ? null : w.blockAt(p));
  return { w, getBlock };
}
const run = (getBlock, from, to, opts) => findPath(getBlock, new Vec3(...from), new Vec3(...to), opts);
const cells = (r) => r.path.map((p) => `${p.x},${p.y},${p.z}`);

test('путь: ровное поле — прямо к цели; путь из клеток, где можно стоять', async () => {
  const { getBlock } = world();
  const r = await run(getBlock, [0.5, 64, 0.5], [10.5, 64, 0.5]);
  assert.equal(r.complete, true);
  assert.equal(r.path.length, 10);
  assert.deepEqual(cells(r).at(-1), '10,64,0');
  assert.ok(r.path.every((p) => p.y === 64));
});

test('путь: стена — в обход; через диагональ угол не срезает', async () => {
  const { w, getBlock } = world();
  for (let z = -3; z <= 3; z += 1) for (const y of [64, 65]) w.set(new Vec3(5, y, z), 'stone');
  const r = await run(getBlock, [0.5, 64, 0.5], [10.5, 64, 0.5]);
  assert.equal(r.complete, true);
  assert.ok(!r.path.some((p) => p.x === 5 && Math.abs(p.z) <= 3), 'сквозь стену не идёт');
  assert.ok(r.path.some((p) => p.x === 5 && Math.abs(p.z) === 4), 'обходит у края стены');

  // Угол: соседи по осям заняты — по диагонали (0,0) → (1,1) нельзя, только в обход.
  const c = world();
  for (const [x, z] of [[1, 0], [0, 1]]) for (const y of [64, 65]) c.w.set(new Vec3(x, y, z), 'stone');
  const corner = await run(c.getBlock, [0.5, 64, 0.5], [1.5, 64, 1.5], { range: 0.1 });
  assert.equal(corner.complete, true);
  assert.ok(corner.path.length > 1, `в обход: ${cells(corner).join(' ')}`);
});

test('путь: ступенька — прыжком на блок выше; уступ — вниз до 3 блоков, глубже — нет', async () => {
  const { w, getBlock } = world();
  for (let x = 3; x <= 12; x += 1) for (let z = -2; z <= 2; z += 1) w.set(new Vec3(x, 64, z), 'stone'); // платформа на блок выше
  const up = await run(getBlock, [0.5, 64, 0.5], [8.5, 65, 0.5]);
  assert.equal(up.complete, true);
  assert.deepEqual(cells(up).slice(0, 3), ['1,64,0', '2,64,0', '3,65,0'], 'запрыгнул со 2-й клетки на 3-ю');

  // Вниз: стоит на столбе высотой 3 (ноги на y=67) — спрыгнуть можно.
  const tower = world();
  for (const y of [64, 65, 66]) tower.w.set(new Vec3(0, y, 0), 'stone');
  const down = await run(tower.getBlock, [0.5, 67, 0.5], [6.5, 64, 0.5]);
  assert.equal(down.complete, true);
  assert.equal(cells(down)[0], '1,64,0', 'шаг с края и вниз на 3');
  // Столб на 4 — уже нет (только если внизу вода).
  tower.w.set(new Vec3(0, 67, 0), 'stone');
  const deep = await run(tower.getBlock, [0.5, 68, 0.5], [6.5, 64, 0.5]);
  assert.equal(deep.complete, false);
  assert.equal(deep.path.length, 0);
  assert.match(deep.reason, /пути нет/);
});

test('путь: лава, огонь, кактус — в обход; забор не перешагнуть', async () => {
  const { w, getBlock } = world();
  for (let z = -2; z <= 2; z += 1) w.set(new Vec3(4, 63, z), 'lava'); // лава вместо пола
  w.set(new Vec3(6, 64, 0), 'fire');
  const r = await run(getBlock, [0.5, 64, 0.5], [10.5, 64, 0.5]);
  assert.equal(r.complete, true);
  assert.ok(!r.path.some((p) => p.x === 4 && Math.abs(p.z) <= 2), 'по лаве не идёт');
  assert.ok(!r.path.some((p) => p.x === 6 && p.z === 0), 'в огонь не идёт');

  const f = world();
  const fence = Block.fromProperties('oak_fence', { north: true, south: true, east: false, west: false, waterlogged: false }, 0);
  for (let z = -3; z <= 3; z += 1) f.w.set(new Vec3(3, 64, z), `oak_fence#${fence.stateId - registry.blocksByName.oak_fence.minStateId}`);
  const fenced = await run(f.getBlock, [0.5, 64, 0.5], [6.5, 64, 0.5]);
  assert.equal(fenced.complete, true);
  assert.ok(!fenced.path.some((p) => p.x === 3 && Math.abs(p.z) <= 3), 'через забор не прыгает');
});

test('путь: заперт со всех сторон — пути нет; мир дальше не загружен — путь до края (дальше — заново)', async () => {
  const { w, getBlock } = world();
  for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
    for (const y of [64, 65, 66]) w.set(new Vec3(x, y, z), 'stone');
  }
  const shut = await run(getBlock, [0.5, 64, 0.5], [8.5, 64, 0.5]);
  assert.deepEqual([shut.complete, shut.path.length], [false, 0]);
  assert.match(shut.reason, /^пути нет/);

  const edge = world(20);
  const far = await run(edge.getBlock, [0.5, 64, 0.5], [40.5, 64, 0.5]);
  assert.equal(far.complete, false);
  assert.equal(far.path.at(-1).x, 20, 'до края загруженного');
  assert.match(far.reason, /не загружен/);
});

test('путь: в воде — можно (дороже); поиск идёт кусками и отменяется', async () => {
  const { w, getBlock } = world();
  for (let x = 2; x <= 4; x += 1) for (let z = -1; z <= 1; z += 1) w.set(new Vec3(x, 63, z), 'water'); // пруд глубиной 1 вместо пола
  for (let z = -6; z <= 6; z += 1) if (Math.abs(z) > 1) for (const y of [64, 65]) w.set(new Vec3(3, y, z), 'stone'); // обход далеко
  const r = await run(getBlock, [0.5, 64, 0.5], [6.5, 64, 0.5]);
  assert.equal(r.complete, true);
  assert.ok(r.path.some((p) => p.x === 3 && p.y === 63), `через пруд: ${cells(r).join(' ')}`);

  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(run(getBlock, [0.5, 64, 0.5], [60.5, 64, 0.5], { signal: ctl.signal }), /прерван/);
});

const near = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.z - b.z) === 1;
const dugCells = (r) => r.path.flatMap((p) => p.dig || []);

test('путь с копанием: к руде в толще камня — прямо, сквозь камень; дошёл — руду видно и достать', async () => {
  const { w, getBlock } = world();
  const ore = new Vec3(6, 58, 0);
  w.set(ore, 'iron_ore');
  // Без копания — никак (руда в камне).
  const walk = await run(getBlock, [0.5, 64, 0.5], [6, 58, 0], { reach: true });
  assert.equal(walk.complete, false);
  const r = await run(getBlock, [0.5, 64, 0.5], [6, 58, 0], { reach: true, dig: true, weight: 2 });
  assert.equal(r.complete, true, r.reason);
  const end = r.path.at(-1);
  const feet = new Vec3(end.x, end.y, end.z);
  const reachable = near(feet, ore) || near(feet.offset(0, 1, 0), ore) || feet.offset(0, -1, 0).equals(ore);
  assert.ok(reachable, `с конца пути руда рядом: ${cells(r).join(' ')}`);
  // Прямо: сломано немного блоков (вниз под себя — по одному), а не туннель.
  const dug = dugCells(r);
  assert.ok(dug.length <= 8, `сломать ${dug.length} блоков: ${dug.map((p) => `${p.x},${p.y},${p.z}`).join(' ')}`);
  assert.ok(r.path.some((p) => p.move === 'drop'), 'вниз — под себя');
  assert.ok(!dug.some((p) => p.equals(ore)) || r.path.at(-1), 'руда — в конце или по пути');
});

test('путь с копанием: не ломает рядом с водой и лавой, под гравием; под себя — только на твёрдое', async () => {
  // Вода рядом с прямой дорогой вниз — ни один ломаемый блок не касается воды.
  const { w, getBlock } = world();
  w.set(new Vec3(0, 60, 1), 'water');
  w.set(new Vec3(1, 61, 0), 'lava');
  const r = await run(getBlock, [0.5, 64, 0.5], [0.5, 56, 0.5], { dig: true, range: 2.5, vertical: 0, weight: 2 });
  assert.equal(r.complete, true, r.reason);
  const liquids = [new Vec3(0, 60, 1), new Vec3(1, 61, 0)];
  for (const d of dugCells(r)) assert.ok(!liquids.some((l) => near(l, d)), `сломал ${d} рядом с водой или лавой`);

  // Стена: без гравия — насквозь (дешевле обхода); гравий над стеной — в обход (иначе обвалится на бота).
  const g = world();
  for (let z = -8; z <= 8; z += 1) for (const y of [64, 65]) g.w.set(new Vec3(1, y, z), 'stone');
  const through = await run(g.getBlock, [0.5, 64, 0.5], [3.5, 64, 0.5], { dig: true, weight: 2 });
  assert.equal(through.complete, true, through.reason);
  assert.ok(dugCells(through).some((p) => p.x === 1), 'сквозь стену');
  for (let z = -8; z <= 8; z += 1) g.w.set(new Vec3(1, 66, z), 'gravel');
  const grav = await run(g.getBlock, [0.5, 64, 0.5], [3.5, 64, 0.5], { dig: true, weight: 2 });
  assert.equal(grav.complete, true, grav.reason);
  const dug = dugCells(grav);
  const dugSet = new Set(dug.map(String));
  for (const d of dug) {
    const above = d.offset(0, 1, 0);
    assert.ok(g.w.get(above) !== 'gravel' || dugSet.has(String(above)), `${d} ломать нельзя: сверху гравий (${cells(grav).join(' ')})`);
  }

  // Пещера под ногами: сломать пол и упасть в неё — нельзя.
  const cave = world();
  for (let y = 58; y <= 62; y += 1) cave.w.set(new Vec3(0, y, 0), 'air');
  const deep = await run(cave.getBlock, [0.5, 64, 0.5], [0.5, 63, 0.5], { dig: true, range: 0.1, vertical: 0 });
  assert.ok(!deep.path.some((p) => p.move === 'drop' && p.x === 0 && p.z === 0), 'в пещеру под собой не прыгает');
});

test('путь: из шахты наверх — «столбом» (блок под себя), если есть блоки; без них — ступеньками с копанием', async () => {
  const { w, getBlock } = world();
  for (let y = 59; y <= 63; y += 1) w.set(new Vec3(0, y, 0), 'air'); // шахта 1×1 глубиной 5, бот на дне (ноги y=59)
  const up = await run(getBlock, [0.5, 59, 0.5], [0.5, 64, 0.5], { dig: true, place: true, range: 0.5, vertical: 0, weight: 2 });
  assert.equal(up.complete, true, up.reason);
  assert.deepEqual(up.path.map((p) => p.move), ['pillar', 'pillar', 'pillar', 'pillar', 'pillar']);
  assert.deepEqual(up.path.map((p) => p.place.y), [59, 60, 61, 62, 63], 'блок — в клетку ног перед прыжком');
  assert.ok(up.path.every((p) => !p.dig), 'над головой и так пусто');

  // Без блоков и без копания — не выбраться; с копанием — ступеньками (с прыжком наверх).
  const stuck = await run(getBlock, [0.5, 59, 0.5], [0.5, 64, 0.5], { range: 0.5, vertical: 0 });
  assert.equal(stuck.complete, false);
  const stairs = await run(getBlock, [0.5, 59, 0.5], [0.5, 64, 0.5], { dig: true, range: 1.5, vertical: 0, weight: 2 });
  assert.equal(stairs.complete, true, stairs.reason);
  assert.ok(stairs.path.some((p) => p.move === 'up') && !stairs.path.some((p) => p.place));
});
