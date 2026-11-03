'use strict';

// Правки бандлов prismarine-viewer: node --test test/viewer-patches.test.js
// Сначала синтетические фрагменты (разные имена, включая $), затем настоящие бандлы из node_modules:
// все правки применяются, код компилируется, а настоящий воркер в песочнице vm рисует блоки ниже y=0.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const {
  INDEX_PATCHES, WORKER_PATCHES, applyPatches, patchIndexBundle, patchWorkerBundle,
} = require(path.join(SRC, 'viewer', 'bundle-patches.js'));

const PUBLIC = path.join(path.dirname(require.resolve('prismarine-viewer/package.json')), 'public');
const ALL = [...INDEX_PATCHES, ...WORKER_PATCHES];
const only = (name) => ALL.filter((p) => p.name === name);
const count = (text, needle) => text.split(needle).length - 1;
const matches = (text, re) => (text.match(re) || []).length;
// Выполняет фрагмент как тело функции; ключи args — имена параметров.
const run = (code, args = {}) => new Function(...Object.keys(args), code)(...Object.values(args));
// Нижние границы секций от from (включая) до to (не включая).
const sectionYs = (from, to) => Array.from({ length: (to - from) / 16 }, (_, k) => from + 16 * k);

// Все четыре места из бандлов в одном фрагменте (как в минифицированном коде, но с другими именами).
const FULL = [
  'addColumn(t,e,i){for(let $=0;$<256;$+=16)this.dirty($)}removeColumn(t,e){for(let i_=0;i_<256;i_+=16)this.clean(i_)}',
  'on("position",({pos:P,addMesh:A})=>{if(P.y>0&&F$&&(C.target.set(P.x,P.y,P.z),F$=!1),A){}});',
  'function setSectionDirty(e){const a=e.y,$i=w.getColumn();$i&&$i.sections[Math.floor(a/16)]?d[a]=1:post()}',
  'setInterval(()=>{const l=w.getColumn();if(l&&l.sections[Math.floor(n_/16)]){mesh()}});',
  'for(const _ in o){const g=get();if(g.position.y<0)continue;}',
  'if(m.cullface){const n=get();if(!n)continue;if(n.position.y<0)continue}',
].join('');

// ---------- описание правок ----------

test('правки бандлов: состав и формат описаний', () => {
  assert.deepEqual(INDEX_PATCHES.map((p) => p.name), ['full-height-sections', 'third-person-camera-any-y']);
  assert.deepEqual(WORKER_PATCHES.map((p) => p.name), ['section-index-min-y', 'cull-below-world-bottom']);
  for (const p of ALL) {
    assert.match(p.description, /^[^\n]*[а-яё][^\n]*$/i, p.name); // одна строка по-русски
    assert.ok(p.pattern instanceof RegExp && p.pattern.global, p.name);
    assert.ok(['string', 'function'].includes(typeof p.replacement), p.name);
    assert.ok(Number.isInteger(p.expected) && p.expected > 0, p.name);
  }
  assert.ok(Object.isFrozen(INDEX_PATCHES) && Object.isFrozen(WORKER_PATCHES) && ALL.every(Object.isFrozen));
});

// ---------- каждая правка на синтетике ----------

test('full-height-sections: секции от -64 до 304 при любых именах переменной', () => {
  const loop = (v) => `for(let ${v}=0;${v}<256;${v}+=16)ys.push(${v});`;
  const src = `const ys=[];${loop('$')}${loop('i_1')}return ys;`;
  const { code, applied, skipped } = applyPatches(src, only('full-height-sections'));
  assert.deepEqual(applied, ['full-height-sections']);
  assert.deepEqual(skipped, []);
  assert.ok(code.includes('for(let $=-64;$<320;$+=16)ys.push($);'));
  assert.ok(code.includes('for(let i_1=-64;i_1<320;i_1+=16)ys.push(i_1);'));
  assert.deepEqual(run(src), [...sectionYs(0, 256), ...sectionYs(0, 256)]); // было: только 0…240
  assert.deepEqual(run(code), [...sectionYs(-64, 320), ...sectionYs(-64, 320)]);
  // Похожие, но другие циклы не трогаем.
  const other = 'for(let i=0;j<256;i+=16);for(let t=0;t<256;t++);for(let k=0;k<256;k+=8);';
  assert.equal(applyPatches(other + src, only('full-height-sections')).code, other + code);
});

test('third-person-camera-any-y: камера наводится на бота и ниже y=0', () => {
  // Как в бандле: if(pos.y>0&&first&&(controls.target.set(pos.x,pos.y,pos.z),…,first=!1),addMesh){…}
  const src = 'if($p.y>0&&_f&&(c$.target.set($p.x,$p.y,$p.z),c$.update(),_f=!1),i){}return _f;';
  const { code, applied } = applyPatches(src, only('third-person-camera-any-y'));
  assert.deepEqual(applied, ['third-person-camera-any-y']);
  assert.equal(code, 'if(_f&&(c$.target.set($p.x,$p.y,$p.z),c$.update(),_f=!1),i){}return _f;');
  const center = (snippet, y) => {
    const calls = [];
    const c$ = { target: { set: (...a) => calls.push(a) }, update() {} };
    const first = run(snippet, { $p: { x: 1, y, z: 2 }, _f: true, c$, i: false });
    return { calls, first };
  };
  assert.deepEqual(center(src, -30), { calls: [], first: true }); // ошибка оригинала
  assert.deepEqual(center(code, -30), { calls: [[1, -30, 2]], first: false });
  assert.deepEqual(center(code, 70), { calls: [[1, 70, 2]], first: false });
  // В target.set другая переменная — это не тот код.
  const alien = 'if(p.y>0&&f&&(c.target.set(q.x,q.y,q.z),c.update(),f=!1),i){}';
  const r = applyPatches(alien, only('third-person-camera-any-y'));
  assert.equal(r.code, alien);
  assert.deepEqual(r.skipped, [{ name: 'third-person-camera-any-y', found: 0, expected: 1 }]);
});

test('section-index-min-y: секция ищется от minY колонки, имя слева и справа — одно', () => {
  const src = 'return[C&&C.sections[Math.floor(Y/16)],$c&&$c.sections[Math.floor(Y/16)]];';
  const { code, applied } = applyPatches(src, only('section-index-min-y'));
  assert.deepEqual(applied, ['section-index-min-y']);
  assert.equal(code, 'return[C&&C.sections[Math.floor((Y-(C.minY||0))/16)],$c&&$c.sections[Math.floor((Y-($c.minY||0))/16)]];');

  const sectionAt = (snippet, column, Y) => run(snippet, { C: column, $c: column, Y });
  const modern = { minY: -64, sections: sectionYs(-64, 320).map((y) => `y${y}`) }; // 1.18+: sections[0] — это y=-64
  const legacy = { sections: sectionYs(0, 256).map((y) => `y${y}`) }; // до 1.17: minY нет, sections[0] — это y=0
  assert.deepEqual(sectionAt(src, modern, -64), [undefined, undefined]); // ошибка оригинала: ниже нуля секций «нет»
  assert.deepEqual(sectionAt(src, modern, 0), ['y-64', 'y-64']); // …а выше — сдвиг на 4 секции
  assert.deepEqual(sectionAt(code, modern, -64), ['y-64', 'y-64']);
  assert.deepEqual(sectionAt(code, modern, 0), ['y0', 'y0']);
  assert.deepEqual(sectionAt(code, modern, 304), ['y304', 'y304']);
  assert.deepEqual(sectionAt(code, modern, 320), [undefined, undefined]);
  assert.deepEqual(sectionAt(code, legacy, 240), ['y240', 'y240']); // старые версии — как раньше
  assert.deepEqual(sectionAt(code, legacy, -16), [undefined, undefined]);
  assert.deepEqual(sectionAt(code, undefined, 0), [undefined, undefined]); // колонка не загружена

  // Разные имена, хвост длинного имени, другой делитель — не тот код (иначе совпадений стало бы 3).
  for (const alien of [
    'a&&b.sections[Math.floor(y/16)]', 'xa&&a.sections[Math.floor(y/16)]', 'a&&ab.sections[Math.floor(y/16)]',
    'ab&&b.sections[Math.floor(y/16)]', 'a&&a.sections[Math.floor(y/8)]', 'a&&a.sections[Math.floor(y.k/16)]',
  ]) {
    const r = applyPatches(`${alien};${src}`, only('section-index-min-y'));
    assert.deepEqual(r.applied, ['section-index-min-y'], alien);
    assert.equal(r.code, `${alien};${code}`, alien);
  }
});

test('cull-below-world-bottom: грани отбрасываются только у соседей ниже дна мира', () => {
  // Как в мешере (renderLiquid и renderElement): if(neighbor.position.y<0)continue
  const src = 'const out=[];for(const g of list){if(g.position.y<0)continue;out.push(g.position.y)}' +
    'for(const $n of list){if($n.position.y<0)continue}return out;';
  const { code, applied } = applyPatches(src, only('cull-below-world-bottom'));
  assert.deepEqual(applied, ['cull-below-world-bottom']);
  assert.equal(count(code, '.position.y<-64)continue'), 2);
  const list = [-65, -64, -1, 0, 5].map((y) => ({ position: { y } }));
  assert.deepEqual(run(src, { list }), [0, 5]); // ошибка оригинала: всё ниже нуля без граней
  assert.deepEqual(run(code, { list }), [-64, -1, 0, 5]);
});

// ---------- правила применения ----------

test('шаблон найден не столько раз, сколько ожидалось: правка пропускается, код не меняется', () => {
  const loop = 'for(let i=0;i<256;i+=16){}';
  for (const n of [0, 1, 3]) {
    const src = `x();${loop.repeat(n)}y();`;
    const r = applyPatches(src, only('full-height-sections'));
    assert.equal(r.code, src);
    assert.deepEqual(r.applied, []);
    assert.deepEqual(r.skipped, [{ name: 'full-height-sections', found: n, expected: 2 }]);
  }
});

test('правки независимы: пропуск одной не мешает другим, порядок не важен', () => {
  // В index.js цикл один (нужно два) — пропускается только он, камера правится.
  const index = 'for(let i=0;i<256;i+=16){}if(t.y>0&&s&&(h.target.set(t.x,t.y,t.z),s=!1),i){}';
  const r = patchIndexBundle(index);
  assert.deepEqual(r.applied, ['third-person-camera-any-y']);
  assert.deepEqual(r.skipped, [{ name: 'full-height-sections', found: 1, expected: 2 }]);
  assert.equal(r.code, 'for(let i=0;i<256;i+=16){}if(s&&(h.target.set(t.x,t.y,t.z),s=!1),i){}');
  // В worker.js проверка соседа одна (нужно две) — пропускается только она.
  const worker = 'a&&a.sections[Math.floor(b/16)];c&&c.sections[Math.floor(d/16)];if(e.position.y<0)continue;';
  const w = patchWorkerBundle(worker);
  assert.deepEqual(w.applied, ['section-index-min-y']);
  assert.deepEqual(w.skipped, [{ name: 'cull-below-world-bottom', found: 1, expected: 2 }]);
  assert.ok(w.code.endsWith('if(e.position.y<0)continue;'));

  // Все четыре места сразу: любой порядок и поштучное применение дают один результат.
  const forward = applyPatches(FULL, ALL);
  assert.deepEqual(forward.applied, ALL.map((p) => p.name));
  assert.deepEqual(forward.skipped, []);
  assert.equal(applyPatches(FULL, [...ALL].reverse()).code, forward.code);
  let step = FULL;
  for (const p of ALL) step = applyPatches(step, [p]).code;
  assert.equal(step, forward.code);
  // Правки бандла index.js не трогают места воркера и наоборот.
  const half = patchIndexBundle(FULL);
  assert.deepEqual(half.applied, INDEX_PATCHES.map((p) => p.name));
  assert.equal(patchWorkerBundle(half.code).code, forward.code);
});

test('повторное применение к уже исправленному коду: всё пропускается, код тот же', () => {
  const once = applyPatches(FULL, ALL);
  const twice = applyPatches(once.code, ALL);
  assert.equal(twice.code, once.code);
  assert.deepEqual(twice.applied, []);
  assert.deepEqual(twice.skipped, ALL.map((p) => ({ name: p.name, found: 0, expected: p.expected })));
});

test('applyPatches: строковая замена с $1, Buffer, общий RegExp не портится', () => {
  const pattern = /x(\d)/g;
  pattern.lastIndex = 3; // «грязное» состояние общего шаблона не влияет на поиск
  const patch = { name: 'demo', description: 'Проверка', pattern, replacement: 'y$1', expected: 2 };
  assert.deepEqual(applyPatches(Buffer.from('x1 x2'), [patch]), { code: 'y1 y2', applied: ['demo'], skipped: [] });
  assert.equal(pattern.lastIndex, 3);
  assert.equal(applyPatches('x1 x2', [{ ...patch, pattern: /x(\d)/ }]).code, 'y1 y2'); // без флага g — тоже все
  assert.deepEqual(applyPatches('x1', []), { code: 'x1', applied: [], skipped: [] });
  assert.throws(() => applyPatches(undefined, [patch]), TypeError);
});

// ---------- настоящие бандлы ----------

// Читаем и правим один раз: worker.js весит 61 МБ.
const cache = new Map();
const once = (key, make) => (cache.has(key) ? cache.get(key) : cache.set(key, make()).get(key));
const realBundle = (file) => once(file, () => fs.readFileSync(path.join(PUBLIC, file), 'utf8'));
const patchedWorker = () => once('patched worker', () => patchWorkerBundle(realBundle('worker.js')));

test('настоящий index.js: все правки применились, код компилируется', () => {
  const { code, applied, skipped } = patchIndexBundle(realBundle('index.js'));
  assert.deepEqual(skipped, []);
  assert.deepEqual(applied, INDEX_PATCHES.map((p) => p.name));
  assert.equal(matches(code, /for\(let ([\w$]+)=-64;\1<320;\1\+=16\)\{/g), 2);
  assert.equal(matches(code, /<256;[\w$]+\+=16\)/g), 0);
  assert.equal(matches(code, /\.y>0&&[\w$]+&&\([\w$]+\.target\.set\(/g), 0);
  assert.equal(matches(code, /if\(([\w$]+)&&\(([\w$]+)\.target\.set\(([\w$]+)\.x,\3\.y,\3\.z\),[\w$]+\.camera\.position\.set\(/g), 1);
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'index.js' }));
  // Цикл из настоящего бандла действительно проходит секции -64…304.
  const [header, v] = code.match(/for\(let ([\w$]+)=-64;\1<320;\1\+=16\)/);
  assert.deepEqual(run(`const ys=[];${header}ys.push(${v});return ys;`), sectionYs(-64, 320));
  const again = patchIndexBundle(code);
  assert.equal(again.code, code);
  assert.deepEqual(again.applied, []);
});

test('настоящий worker.js (61 МБ): все правки применились, код компилируется', () => {
  const { code, applied, skipped } = patchedWorker();
  assert.deepEqual(skipped, []);
  assert.deepEqual(applied, WORKER_PATCHES.map((p) => p.name));
  // Шаблоны начинаются с литерала — по 61 МБ это быстро.
  assert.equal(matches(code, /&&([\w$]+)(?<=(?<![\w$])\1&&\1)\.sections\[Math\.floor\(\(([\w$]+)-\(\1\.minY\|\|0\)\)\/16\)\]/g), 2);
  assert.equal(count(code, '.sections[Math.floor('), 2);
  assert.equal(count(code, '.position.y<-64)continue'), 2);
  assert.equal(count(code, '.position.y<0)continue'), 0);
  assert.doesNotThrow(() => new vm.Script(code, { filename: 'worker.js' }));
  const again = patchWorkerBundle(code);
  assert.equal(again.code, code);
  assert.deepEqual(again.applied, []);
});

// Гоняет настоящий воркер в песочнице vm: колонка 1.21.4 с камнями, секции помечаются «грязными»,
// один оборот его setInterval — и считаем вершины готовой геометрии по секциям.
function meshInSandbox(workerCode) {
  const VERSION = '1.21.4';
  const { Vec3 } = require('vec3');
  const Chunk = require('prismarine-chunk')(VERSION);
  const stone = require('minecraft-data')(VERSION).blocksByName.stone.defaultState;
  const column = new Chunk({ minY: -64, worldHeight: 384 });
  for (const y of [-64, -60, 0, 300]) column.setBlockStateId(new Vec3(5, y, 5), stone);

  const messages = [];
  let tick = null;
  const ctx = {
    console, setTimeout, clearTimeout, TextDecoder, TextEncoder, AbortController, AbortSignal,
    URL, URLSearchParams, performance, queueMicrotask, atob, btoa,
    postMessage: (m) => messages.push(m),
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval() {},
  };
  ctx.self = ctx; // как в настоящем воркере: self — это глобальный объект
  vm.createContext(ctx);
  new vm.Script(workerCode, { filename: 'worker.js' }).runInContext(ctx);
  assert.equal(typeof ctx.onmessage, 'function');
  assert.equal(typeof tick, 'function');
  const send = (data) => ctx.onmessage({ data });
  send({ type: 'version', version: VERSION });
  // JSON разбираем внутри песочницы: мешер проверяет «instanceof Array», а у vm свой Array.
  const blockStates = fs.readFileSync(path.join(PUBLIC, 'blocksStates', `${VERSION}.json`), 'utf8');
  send({ type: 'blockStates', json: vm.runInContext('JSON.parse', ctx)(blockStates) });
  send({ type: 'chunk', x: 0, z: 0, chunk: column.toJson() });
  for (const y of [-64, 0, 288]) send({ type: 'dirty', x: 0, y, z: 0, value: true });
  tick();
  const vertices = {};
  for (const m of messages) if (m.type === 'geometry') vertices[m.key] = m.geometry.positions.length / 3;
  return vertices;
}

test('настоящий воркер в песочнице: после правок рисуются блоки ниже y=0', () => {
  // Отдельный камень — 6 граней по 4 вершины.
  // Оригинал: секция y=-64 не строится вовсе, у камня на y=0 нет нижней грани (сосед ниже нуля).
  assert.deepEqual(meshInSandbox(realBundle('worker.js')), { '0,0,0': 20, '0,288,0': 24 });
  // Только индекс секции: секция строится, но все грани ниже нуля отброшены — камней не видно.
  const sectionOnly = applyPatches(realBundle('worker.js'), only('section-index-min-y')).code;
  assert.deepEqual(meshInSandbox(sectionOnly), { '0,-64,0': 0, '0,0,0': 20, '0,288,0': 24 });
  // Все правки: камень на y=-60 — 6 граней, на дне мира y=-64 — 5 (под ним пустота за миром), на y=0 — 6.
  assert.deepEqual(meshInSandbox(patchedWorker().code), { '0,-64,0': 44, '0,0,0': 24, '0,288,0': 24 });
});
