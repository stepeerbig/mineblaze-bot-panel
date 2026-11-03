'use strict';

// Правки готовых бандлов prismarine-viewer (public/index.js и public/worker.js) при отдаче браузеру.
// Файлы в node_modules не меняем. Читаемые исходники бандлов: prismarine-viewer/lib/index.js и viewer/lib/*.js.
// Просмотрщик писался для мира 0…255, а в 1.18+ мир идёт от -64 до 319. Без правок всё, что ниже y=0
// (пещеры, глубинный сланец, бот в шахте), не рисуется, а камера «Со стороны» не наводится на бота ниже y=0.
// Правка применяется, только если шаблон найден ровно expected раз. Иначе это другая сборка бандла:
// правку пропускаем, код не трогаем и сообщаем об этом в skipped.

// Высота мира 1.18+: от -64 до 319 включительно (24 секции по 16 блоков).
const MIN_Y = -64;
const MAX_Y = 320;

// Шаблоны подходят к любым минифицированным именам ([\w$]+). worker.js — 61 МБ в одну строку, поэтому его
// шаблоны начинаются с литерала: так поиск занимает десятки миллисекунд, а с [\w$]+ в начале — около секунды.
// Имена слева от литерала проверяет ретроспектива (?<=…).

const INDEX_PATCHES = [
  {
    name: 'full-height-sections',
    description: 'Рендер отдаёт воркерам все секции высоты мира (-64…319), а не только 0…255',
    // WorldRenderer.addColumn и removeColumn: for(let y=0;y<256;y+=16)
    pattern: /for\(let ([\w$]+)=0;\1<256;\1\+=16\)/g,
    replacement: (m, y) => `for(let ${y}=${MIN_Y};${y}<${MAX_Y};${y}+=16)`,
    expected: 2,
  },
  {
    name: 'third-person-camera-any-y',
    description: 'Камера «Со стороны» наводится на бота по первой позиции, даже если он ниже y=0',
    // Обработчик 'position': if(pos.y>0&&firstPositionUpdate&&(controls.target.set(pos.x,pos.y,pos.z),…
    pattern: /if\(([\w$]+)\.y>0&&([\w$]+)&&\(([\w$]+)\.target\.set\(\1\.x,\1\.y,\1\.z\)/g,
    replacement: (m, pos, first, controls) => `if(${first}&&(${controls}.target.set(${pos}.x,${pos}.y,${pos}.z)`,
    expected: 1,
  },
];

const WORKER_PATCHES = [
  {
    name: 'section-index-min-y',
    description: 'Воркер ищет секцию с учётом minY колонки: в 1.18+ sections[0] — это y=-64, а не y=0',
    // setSectionDirty и цикл «грязных» секций: chunk&&chunk.sections[Math.floor(y/16)].
    // Совпадение начинается с «&&»; ретроспектива проверяет, что слева то же имя целиком (chunk&&chunk).
    // У колонок до 1.17 minY нет (или 0) — для них индекс прежний.
    pattern: /&&([\w$]+)(?<=(?<![\w$])\1&&\1)\.sections\[Math\.floor\(([\w$]+)\/16\)\]/g,
    replacement: (m, chunk, y) => `&&${chunk}.sections[Math.floor((${y}-(${chunk}.minY||0))/16)]`,
    expected: 2,
  },
  {
    name: 'cull-below-world-bottom',
    description: 'Мешер отбрасывает грани только к соседям ниже дна мира (y<-64), а не ко всем ниже y=0',
    // renderLiquid и renderElement: if(neighbor.position.y<0)continue
    pattern: /(?<=[\w$])\.position\.y<0\)continue/g,
    replacement: `.position.y<${MIN_Y})continue`,
    expected: 2,
  },
];

// Применяет правки по очереди: { code, applied: [имена], skipped: [{ name, found, expected }] }.
function applyPatches(source, patches) {
  let code = Buffer.isBuffer(source) ? source.toString('utf8') : source;
  if (typeof code !== 'string') throw new TypeError('applyPatches: нужен текст бандла (строка или Buffer)');
  const applied = [];
  const skipped = [];
  for (const patch of patches) {
    // Своя копия шаблона: у глобального RegExp есть состояние (lastIndex), общий объект не трогаем.
    const { flags } = patch.pattern;
    const re = new RegExp(patch.pattern, flags.includes('g') ? flags : `${flags}g`);
    const found = (code.match(re) || []).length;
    if (found === patch.expected) {
      code = code.replace(re, patch.replacement);
      applied.push(patch.name);
    } else {
      skipped.push({ name: patch.name, found, expected: patch.expected });
    }
  }
  return { code, applied, skipped };
}

const patchIndexBundle = (source) => applyPatches(source, INDEX_PATCHES);
const patchWorkerBundle = (source) => applyPatches(source, WORKER_PATCHES);

// Списки общие для всех модулей — защищаем от случайной правки (сами RegExp не замораживаем).
for (const list of [INDEX_PATCHES, WORKER_PATCHES]) {
  list.forEach(Object.freeze);
  Object.freeze(list);
}

module.exports = { INDEX_PATCHES, WORKER_PATCHES, applyPatches, patchIndexBundle, patchWorkerBundle };
