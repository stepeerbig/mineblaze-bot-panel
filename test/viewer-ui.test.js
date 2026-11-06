'use strict';

// Страница «Экран бота» (src/viewer/page): чистые функции ui.js и её поведение в поддельном DOM.
// Запуск: node --test test/viewer-ui.test.js. Ни Electron, ни сервер, ни сеть не нужны.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const PAGE = path.join(__dirname, '..', 'src', 'viewer', 'page');
const UI = path.join(PAGE, 'ui.js');
const ui = require(UI);

const read = (name) => fs.readFileSync(path.join(PAGE, name), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

// ---------- чистые функции ----------

test('ui.js проходит node --check', () => {
  execFileSync(process.execPath, ['--check', UI], { stdio: 'pipe' });
});

test('измерения по-русски', () => {
  assert.equal(ui.dimensionName('minecraft:overworld'), 'Обычный мир');
  assert.equal(ui.dimensionName('overworld'), 'Обычный мир');
  assert.equal(ui.dimensionName('minecraft:the_nether'), 'Незер');
  assert.equal(ui.dimensionName(' Minecraft:The_End '), 'Энд');
  assert.equal(ui.dimensionName('minecraft:lobby'), 'lobby'); // незнакомое — как есть
  assert.equal(ui.dimensionName('mineblaze:spawn'), 'mineblaze:spawn');
  assert.equal(ui.dimensionName('constructor'), 'constructor'); // не свойство Object.prototype
  for (const empty of ['', null, undefined, 0, {}]) assert.equal(ui.dimensionName(empty), '');
});

test('числа: округление и пустые значения', () => {
  assert.equal(ui.formatInt(12.6), '13');
  assert.equal(ui.formatInt(-0.4), '0'); // без «-0»
  assert.equal(ui.formatInt(-12.2, Math.floor), '-13');
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '12', true, {}]) assert.equal(ui.formatInt(bad), '—');
});

test('здоровье и сытость: «N/20», округление вверх, как сердечки в игре', () => {
  assert.equal(ui.formatStat(20), '20/20');
  assert.equal(ui.formatStat(17.5), '18/20');
  assert.equal(ui.formatStat(0.3), '1/20'); // живой бот — не «0/20»
  assert.equal(ui.formatStat(0), '0/20');
  for (const bad of [null, undefined, NaN]) assert.equal(ui.formatStat(bad), '—');
});

test('координаты блока округляются вниз', () => {
  assert.deepEqual(ui.formatCoords({ x: 12.9, y: 64, z: -0.5 }), { x: '12', y: '64', z: '-1' });
  assert.deepEqual(ui.formatCoords({ x: NaN, y: undefined, z: null }), { x: '—', y: '—', z: '—' });
  assert.deepEqual(ui.formatCoords(null), { x: '—', y: '—', z: '—' });
});

test('тексты плашки бота', () => {
  const state = {
    online: true,
    username: ' Steve ',
    health: 19.2,
    food: 20,
    position: { x: -3.2, y: 70.99, z: 8 },
    dimension: 'minecraft:the_nether',
  };
  assert.deepEqual(ui.hudModel(state), {
    name: 'Steve', health: '20/20', food: '20/20', x: '-4', y: '70', z: '8', dimension: 'Незер',
  });
  const empty = { name: '—', health: '—', food: '—', x: '—', y: '—', z: '—', dimension: '' };
  assert.deepEqual(ui.hudModel(null), empty);
  assert.deepEqual(ui.hudModel({ username: '', health: NaN, position: null, dimension: null }), empty);
});

test('заголовок окна', () => {
  assert.equal(ui.windowTitle({ online: true, username: 'Steve' }), 'Экран бота — Steve');
  assert.equal(ui.windowTitle({ online: false, username: 'Steve' }), 'Экран бота');
  assert.equal(ui.windowTitle({ online: true, username: '  ' }), 'Экран бота');
  assert.equal(ui.windowTitle(null), 'Экран бота');
});

test('сообщение по центру', () => {
  assert.equal(ui.statusCard({ online: true }, { reachable: false }).title, 'Нет связи с панелью…');
  assert.deepEqual(ui.statusCard(null), { kind: 'boot', title: '', text: '' });
  assert.deepEqual(ui.statusCard({ online: false, unsupported: true }), {
    kind: 'offline', title: 'Бот не в сети', text: 'Нажми «Старт» в панели — изображение появится само.',
  });
  assert.equal(ui.statusCard({ online: true, unsupported: true, botVersion: '1.22' }).text,
    'Эта версия Minecraft (1.22) пока не поддерживается окном просмотра.');
  assert.equal(ui.statusCard({ online: true, unsupported: true }).text,
    'Эта версия Minecraft пока не поддерживается окном просмотра.');
  assert.equal(ui.statusCard({ online: true }, { hasView: false, loading: true }).kind, 'nogl');
  assert.equal(ui.statusCard({ online: true }, { loading: true }).title, 'Загрузка мира…');
  assert.equal(ui.statusCard({ online: true }), null);
});

test('вид камеры и смена поколения', () => {
  assert.equal(ui.normalizeMode('third'), 'third');
  for (const m of ['first', 'side', '', null, undefined]) assert.equal(ui.normalizeMode(m), 'first');
  assert.equal(ui.shouldReload(1, 1), false);
  assert.equal(ui.shouldReload(1, 2), true);
  assert.equal(ui.shouldReload(0, 1), true); // 0 — тоже поколение
  assert.equal(ui.shouldReload(undefined, 2), false);
  assert.equal(ui.shouldReload(3, null), false);
});

// ---------- разметка и стили ----------

test('index.html: CSP, только свои скрипты, все id для ui.js на месте', () => {
  const html = read('index.html');
  assert.match(html, /<title>Экран бота<\/title>/);
  assert.ok(html.includes('content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; '
    + 'img-src \'self\' data: blob:; connect-src \'self\'; worker-src \'self\' blob:"'));
  assert.match(html, /<link rel="stylesheet" href="ui.css">/);

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map((m) => (/\ssrc="([^"]+)"/.exec(m[1]) || [])[1]), ['index.js', 'ui.js']);
  assert.ok(scripts.every((m) => m[2].trim() === ''), 'встроенных скриптов быть не должно');
  assert.doesNotMatch(html, /(src|href)="(https?:)?\/\//, 'внешних ресурсов быть не должно');

  const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
  const used = [...fs.readFileSync(UI, 'utf8').matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(used.length >= 15);
  for (const id of used) assert.ok(ids.has(id), `в index.html нет элемента #${id}`);
});

test('ui.css: слой интерфейса не перехватывает мышь, кроме кнопок', () => {
  const css = read('ui.css');
  assert.match(css, /\.overlay \{[^}]*pointer-events: none;/);
  assert.match(css, /\.overlay button \{ pointer-events: auto; \}/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/); // hidden сильнее display: grid/flex
});

// ---------- страница в поддельном DOM ----------

// Выполняет ui.js как в окне: поддельные элементы из index.html, часы, таймеры и сервер панели.
function openPage({ pathname = '/token/', canvas = true, server = {}, xray = null, scene = null } = {}) {
  const page = {};
  // Поддельный элемент: то, чем пользуется ui.js (текст с детьми, классы, события любого вида, фокус).
  const makeNode = (tag = 'div') => {
    let text = '';
    const classes = new Set();
    const node = {
      tag,
      hidden: false,
      disabled: false,
      readOnly: false,
      checked: false,
      value: '',
      title: '',
      className: '',
      dataset: {},
      attrs: {},
      style: {},
      handlers: [],
      on: {},
      children: [],
      classes,
      get textContent() { return text + this.children.map((c) => c.textContent).join(''); },
      set textContent(v) { text = String(v); this.children = []; },
      classList: { toggle: (n, on) => (on ? classes.add(n) : classes.delete(n)), add: (n) => classes.add(n), remove: (n) => classes.delete(n) },
      setAttribute(name, value) { this.attrs[name] = String(value); },
      addEventListener(type, fn) {
        (this.on[type] = this.on[type] || []).push(fn);
        if (type === 'click') this.handlers.push(fn);
      },
      click(ev = {}) { for (const fn of this.on.click || []) fn({ shiftKey: false, ...ev }); },
      fire(type, ev = {}) { for (const fn of this.on[type] || []) fn(ev); },
      appendChild(c) {
        if (c.tag === '#fragment') this.children.push(...c.children);
        else this.children.push(c);
        return c;
      },
      append(...cs) { for (const c of cs) this.appendChild(c); },
      focus() { page.focused = this; },
      getContext: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 136, height: 136 }),
      setPointerCapture() {},
    };
    return node;
  };
  const nodes = {};
  for (const [, id] of read('index.html').matchAll(/\sid="([^"]+)"/g)) nodes[id] = makeNode();

  Object.assign(page, {
    nodes,
    now: 1000,
    reloads: 0,
    replaced: null,
    requests: [],
    down: false, // панель не отвечает
    server: { online: false, generation: 1, mode: 'first', ...server },
    xray, // настройки рентгена на «панели»
    xrayResult: { rev: 1, enabled: false, result: null },
    pick: { hand: null, look: null },
    blocks: [['diamond_ore', 'Diamond Ore'], ['gold_ore', 'Gold Ore'], ['spawner', 'Spawner']],
  });
  const timers = new Map();
  const docHandlers = {};
  let seq = 0;
  const classes = new Set();
  const document = {
    title: 'Экран бота',
    body: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } },
    getElementById: (id) => nodes[id] || null,
    querySelector: (selector) => (selector === 'canvas' && canvas ? {} : null),
    createElement: (tag) => makeNode(tag),
    createDocumentFragment: () => makeNode('#fragment'),
    addEventListener: (type, fn) => {
      docHandlers[type] = fn;
    },
  };
  const json = (status, body) => ({ ok: status === 200, status, json: async () => JSON.parse(JSON.stringify(body)) });

  const sandbox = {
    console,
    AbortController,
    document,
    Date: { now: () => page.now },
    setTimeout: (fn, ms) => {
      timers.set(++seq, { fn, at: page.now + ms });
      return seq;
    },
    clearTimeout: (id) => timers.delete(id),
    location: {
      pathname,
      search: '',
      reload: () => { page.reloads += 1; },
      replace: (url) => { page.replaced = url; },
    },
    fetch: async (url, options = {}) => {
      page.requests.push({ url, method: options.method || 'GET', cache: options.cache, headers: options.headers, body: options.body });
      if (page.down) throw new TypeError('Failed to fetch');
      if (url === 'state') return json(200, page.server);
      if (url === 'mode' && options.method === 'POST') {
        const { mode } = JSON.parse(options.body);
        if (mode !== page.server.mode) page.server = { ...page.server, mode, generation: page.server.generation + 1 };
        return json(200, page.server);
      }
      if (url === 'xray' && page.xray) {
        if (options.method === 'POST') {
          page.xray = JSON.parse(options.body).settings;
          const x = page.server.xray || {};
          page.server = { ...page.server, xray: { ...x, enabled: page.xray.enabled, radius: page.xray.radius, overlay: page.xray.overlay, rev: (x.rev || 0) + 1 } };
        }
        return json(200, { settings: page.xray });
      }
      if (url === 'xray/result') return json(200, page.xrayResult);
      if (url === 'xray/pick') return json(200, page.pick);
      if (url === 'xray/blocks') return json(200, { blocks: page.blocks });
      return json(404, {});
    },
  };
  if (scene) {
    // Просмотрщик и THREE, как их видит страница после правки бандла expose-viewer.
    sandbox.__mbpViewer = { scene };
    sandbox.THREE = {
      BufferGeometry: class { setAttribute(name, attr) { this[name] = attr; } dispose() { this.disposed = true; } },
      BufferAttribute: class { constructor(array, size) { Object.assign(this, { array, size }); } },
      LineBasicMaterial: class { constructor(opts) { Object.assign(this, opts); } dispose() { this.disposed = true; } },
      LineSegments: class { constructor(geometry, material) { Object.assign(this, { kind: 'lines', geometry, material }); } },
      BoxGeometry: class { constructor(...size) { this.size = size; } dispose() { this.disposed = true; } },
      MeshBasicMaterial: class { constructor(opts) { Object.assign(this, opts); } dispose() { this.disposed = true; } },
      Matrix4: class { makeTranslation(x, y, z) { this.t = [x, y, z]; return this; } },
      InstancedMesh: class {
        constructor(geometry, material, count) { Object.assign(this, { kind: 'fill', geometry, material, count, at: [], instanceMatrix: {} }); }
        setMatrixAt(i, m) { this.at[i] = [...m.t]; }
      },
    };
  }

  page.document = document;
  page.classes = classes;
  // Нажать клавишу в окне (как событие keydown на document).
  page.key = (code, extra = {}) => docHandlers.keydown && docHandlers.keydown({ code, key: '', target: null, preventDefault() {}, ...extra });
  // Прокрутить часы на ms, выполняя созревшие таймеры по порядку.
  page.advance = async (ms) => {
    const end = page.now + ms;
    for (;;) {
      await flush();
      let due = null;
      for (const [id, t] of timers) if (t.at <= end && (!due || t.at < due.t.at)) due = { id, t };
      if (!due) break;
      timers.delete(due.id);
      page.now = due.t.at;
      due.t.fn();
    }
    page.now = end;
    await flush();
  };

  vm.runInNewContext(fs.readFileSync(UI, 'utf8'), sandbox, { filename: UI });
  return page;
}

const texts = (n, ids) => ids.map((id) => n[id].textContent);

test('страница: бот не в сети, потом в сети — плашка, заголовок, «Загрузка мира…»', async () => {
  const page = openPage();
  const n = page.nodes;
  await page.advance(0);
  assert.deepEqual(page.requests[0], { url: 'state', method: 'GET', cache: 'no-store', headers: undefined, body: undefined });
  assert.equal(n.curtain.hidden, false);
  assert.equal(n.curtain.dataset.kind, 'offline');
  assert.deepEqual(texts(n, ['cardTitle', 'cardText']), ['Бот не в сети', 'Нажми «Старт» в панели — изображение появится само.']);
  assert.equal(n.hud.hidden, true);
  assert.equal(page.document.title, 'Экран бота');
  assert.equal(n.modeFirst.attrs['aria-pressed'], 'true');
  assert.equal(n.modeThird.attrs['aria-pressed'], 'false');

  // Поколение то же (в жизни панель сменила бы его) — проверяем только отрисовку.
  page.server = {
    ...page.server,
    online: true,
    mode: 'third',
    username: 'Steve',
    health: 17.5,
    food: 20,
    position: { x: 1.5, y: 64, z: -2.5 },
    dimension: 'minecraft:overworld',
  };
  await page.advance(500);
  assert.equal(page.requests.length, 2);
  assert.equal(n.hud.hidden, false);
  assert.deepEqual(texts(n, ['hudName', 'hudHealth', 'hudFood', 'hudX', 'hudY', 'hudZ', 'hudDim']),
    ['Steve', '18/20', '20/20', '1', '64', '-3', 'Обычный мир']);
  assert.equal(page.document.title, 'Экран бота — Steve');
  assert.equal(n.curtain.dataset.kind, 'loading');
  assert.equal(n.cardTitle.textContent, 'Загрузка мира…');
  assert.equal(n.modeThird.attrs['aria-pressed'], 'true');
  assert.equal(n.hint.hidden, false); // подсказка про мышь — только в виде со стороны
  assert.ok(page.classes.has('orbit'));

  await page.advance(3100);
  assert.equal(n.curtain.hidden, true); // «Загрузка мира…» пропала сама
  assert.equal(n.crosshair.hidden, true); // прицел — только в виде глазами бота
  assert.equal(page.reloads, 0);
});

test('страница: «Нет связи» после двух неудач подряд, потом связь вернулась', async () => {
  const page = openPage({ server: { online: true, username: 'Bot', mode: 'first' } });
  const n = page.nodes;
  await page.advance(3100);
  assert.equal(n.curtain.hidden, true);
  assert.equal(n.crosshair.hidden, false);

  page.down = true;
  await page.advance(500); // одна неудача — ещё не повод пугать
  assert.equal(n.curtain.hidden, true);
  await page.advance(1000); // вторая подряд
  assert.equal(n.curtain.dataset.kind, 'unreachable');
  assert.equal(n.cardTitle.textContent, 'Нет связи с панелью…');
  assert.equal(n.hud.hidden, true);
  assert.equal(n.crosshair.hidden, true);
  assert.equal(n.modeThird.disabled, true);
  assert.equal(page.document.title, 'Экран бота');

  page.down = false;
  await page.advance(1000); // опрос продолжается сам
  assert.equal(n.curtain.hidden, true);
  assert.equal(n.hud.hidden, false);
  assert.equal(n.modeThird.disabled, false);
  assert.equal(page.document.title, 'Экран бота — Bot');
  assert.equal(page.reloads, 0);
});

test('страница: новое поколение — перезагрузка, после неё опрос не идёт', async () => {
  const page = openPage({ server: { online: true, generation: 0 } });
  await page.advance(1000);
  assert.equal(page.reloads, 0);
  page.server = { ...page.server, generation: 1 };
  await page.advance(500);
  assert.equal(page.reloads, 1);
  const count = page.requests.length;
  await page.advance(5000);
  assert.equal(page.requests.length, count);
  assert.equal(page.reloads, 1);
});

test('страница: смена вида — POST mode, затем перезагрузка; «Обновить» перезагружает', async () => {
  const page = openPage({ server: { online: true, mode: 'first' } });
  const n = page.nodes;
  const posts = () => page.requests.filter((r) => r.url === 'mode');
  await page.advance(0);

  n.modeFirst.click(); // этот вид уже выбран — запроса нет
  await page.advance(0);
  assert.equal(posts().length, 0);

  page.down = true; // запрос не прошёл — кнопки возвращаются как были
  n.modeThird.click();
  assert.equal(n.modeThird.attrs['aria-pressed'], 'true'); // нажимается сразу
  await page.advance(0);
  assert.equal(n.modeThird.attrs['aria-pressed'], 'false');
  assert.equal(page.reloads, 0);

  page.down = false;
  n.modeThird.click();
  await page.advance(0);
  assert.equal(posts().length, 2);
  const post = posts()[1];
  assert.equal(post.method, 'POST');
  assert.equal(post.body, '{"mode":"third"}');
  assert.equal(post.headers['Content-Type'], 'application/json');
  assert.equal(page.reloads, 1); // панель сменила поколение

  const other = openPage();
  other.nodes.btnReload.click();
  assert.equal(other.reloads, 1);
});

test('страница: без WebGL и адрес без «/» на конце', async () => {
  const noGl = openPage({ canvas: false, server: { online: true } });
  await noGl.advance(0);
  assert.equal(noGl.nodes.curtain.dataset.kind, 'nogl');
  assert.equal(noGl.nodes.hud.hidden, false); // данные бота всё равно видны

  const noSlash = openPage({ pathname: '/token' });
  assert.equal(noSlash.replaced, '/token/');
  assert.equal(noSlash.requests.length, 0);
});

// ---------- рентген ----------

test('рентген: цвета, круг, контуры блоков, радиус и надпись', () => {
  assert.deepEqual(ui.colorParts('#4aedd9'), { r: 74, g: 237, b: 217, a: 255 });
  assert.deepEqual(ui.colorParts('#ff000080'), { r: 255, g: 0, b: 0, a: 128 });
  assert.deepEqual(ui.colorParts('нет'), { r: 255, g: 255, b: 255, a: 255 });
  assert.equal(ui.colorHex({ r: 74, g: 237, b: 217, a: 255 }), '#4aedd9ff');
  assert.equal(ui.colorHex({ r: 300, g: -5, b: 12.4 }), '#ff000cff');
  assert.equal(ui.cssColor('#ff000080'), 'rgba(255, 0, 0, 0.502)');
  assert.deepEqual(ui.hsvToRgb(0, 1, 1), { r: 255, g: 0, b: 0 });
  assert.deepEqual(ui.hsvToRgb(240, 1, 1), { r: 0, g: 0, b: 255 });
  assert.deepEqual(ui.hsvToRgb(-120, 1, 1), { r: 0, g: 0, b: 255 });
  assert.deepEqual(ui.hsvToRgb(77, 0, 1), { r: 255, g: 255, b: 255 }); // середина круга — белый

  // 12 рёбер куба на блок, все точки — на его углах (чуть внутрь), каждое ребро — вдоль одной оси.
  const edges = ui.boxEdges([10, -60, 3, 0, 0, 0]);
  assert.equal(edges.length, 144);
  for (let i = 0; i < 72; i += 3) {
    assert.ok([10.002, 10.998].some((v) => Math.abs(edges[i] - v) < 1e-4), `x ${edges[i]}`);
    assert.ok([-59.998, -59.002].some((v) => Math.abs(edges[i + 1] - v) < 1e-4), `y ${edges[i + 1]}`);
  }
  for (let e = 0; e < 12; e += 1) {
    const a = edges.slice(e * 6, e * 6 + 3);
    const b = edges.slice(e * 6 + 3, e * 6 + 6);
    assert.equal([0, 1, 2].filter((k) => Math.abs(a[k] - b[k]) > 0.5).length, 1);
  }
  assert.equal(ui.boxEdges([]).length, 0);

  assert.equal(ui.radiusText(0), '0 чанков (1×1)');
  assert.equal(ui.radiusText(1), '1 чанк (3×3)');
  assert.equal(ui.radiusText(3), '3 чанка (7×7)');
  assert.equal(ui.radiusText(8), '8 чанков (17×17)');

  const on = { enabled: true, overlay: true };
  assert.equal(ui.xrayBadgeText(null, null), null);
  assert.equal(ui.xrayBadgeText({ enabled: true, overlay: false }, null), null); // надпись выключена
  assert.equal(ui.xrayBadgeText(on, null), 'Рентген включён · ищу…');
  assert.equal(ui.xrayBadgeText(on, { enabled: true, result: { total: 12, truncated: true } }), 'Рентген включён · найдено 12+');
  assert.equal(ui.entryMatches({ label: 'Алмазы', name: 'diamond_ore' }, 'алм'), true);
  assert.equal(ui.entryMatches({ label: 'Золото Незера', name: 'nether_gold_ore' }, 'gold ore'), true);
  assert.equal(ui.entryMatches({ label: 'Уголь', name: 'coal_ore' }, 'железо'), false);
  assert.deepEqual([...ui.countsByKey({ enabled: true, result: { groups: [{ key: 'iron_ore', count: 3 }] } })], [['iron_ore', 3]]);
  assert.equal(ui.countsByKey({ enabled: false, result: null }).size, 0);
});

test('страница: рентген — кнопка и клавиша \\, надпись, контуры на сцене, меню G: вкл/выкл блока, цвет, «что в руке»', async () => {
  const settings = {
    enabled: false,
    radius: 2,
    lava: false,
    overlay: true,
    blocks: [
      { name: 'diamond_ore', label: 'Алмазы', color: '#4aedd9ff', on: true, same: true },
      { name: 'coal_ore', label: 'Уголь', color: '#7a7a7aff', on: false, same: true },
    ],
  };
  const added = [];
  const removed = [];
  const scene = { add: (o) => added.push(o), remove: (o) => removed.push(o) };
  const page = openPage({ server: { online: true, xray: { enabled: false, overlay: true, radius: 2, rev: 1 } }, xray: settings, scene });
  const n = page.nodes;
  const posts = () => page.requests.filter((r) => r.url === 'xray' && r.method === 'POST').map((r) => JSON.parse(r.body).settings);
  await page.advance(0);
  assert.ok(page.requests.some((r) => r.url === 'xray/result') && page.requests.some((r) => r.url === 'xray'));
  assert.equal(n.btnXray.disabled, false);
  assert.equal(n.btnXray.attrs['aria-pressed'], 'false');
  assert.equal(n.xrayBadge.hidden, true);
  assert.equal(n.xrayTip.hidden, false); // подсказка о клавишах — пока не закрыли

  // «\» — включить; в поле ввода — нет.
  page.key('Backslash', { target: { tagName: 'INPUT' } });
  await page.advance(0);
  assert.equal(posts().length, 0);
  page.key('Backslash');
  await page.advance(0);
  assert.equal(posts().length, 1);
  assert.equal(posts()[0].enabled, true);
  assert.equal(n.btnXray.attrs['aria-pressed'], 'true');
  assert.equal(n.xrayTip.hidden, true);

  // Панель нашла блоки — надпись и контуры сквозь стены (без проверки глубины), цвет строки.
  page.xrayResult = {
    rev: 5,
    enabled: true,
    result: { total: 2, truncated: false, groups: [{ key: 'diamond_ore', label: 'Алмазы', color: '#4aedd980', count: 2, positions: [1, -58, 2, 3, -58, 2] }] },
  };
  page.server = { ...page.server, xray: { enabled: true, overlay: true, radius: 2, rev: 5 } };
  await page.advance(500);
  assert.equal(n.xrayBadge.hidden, false);
  assert.equal(n.xrayBadge.textContent, 'Рентген включён · найдено 2');
  assert.deepEqual(added.map((o) => o.kind), ['fill', 'lines']);
  const [fill, lines] = added;
  assert.equal(fill.count, 2);
  assert.deepEqual(fill.at, [[1.5, -57.5, 2.5], [3.5, -57.5, 2.5]], 'заливка — по центрам блоков');
  assert.equal(fill.material.depthTest, false);
  assert.ok(fill.material.opacity < lines.material.opacity && fill.renderOrder < lines.renderOrder);
  assert.equal(lines.geometry.position.array.length, 144);
  assert.equal(lines.material.depthTest, false);
  assert.equal(lines.material.color, 0x4aedd9);
  assert.ok(Math.abs(lines.material.opacity - 128 / 255) < 1e-9 && lines.material.transparent);
  assert.equal(lines.material.transparent, true, 'и непрозрачный цвет — в «прозрачном» проходе, после мира');
  assert.equal(lines.renderOrder, 1000);

  // G — меню: строки списка с образцом цвета, найдено у алмазов; клик по углю — включить его.
  page.key('KeyG');
  await page.advance(0);
  assert.equal(n.xrayMenu.hidden, false);
  assert.equal(n.xrayBadge.hidden, true, 'под меню надпись не нужна');
  assert.equal(n.xmList.children.length, 2);
  const [diamond, coal] = n.xmList.children.map((li) => li.children[0]);
  assert.equal(diamond.attrs['aria-pressed'], 'true');
  assert.match(diamond.textContent, /Алмазыdiamond_ore2/);
  assert.equal(diamond.children[0].children[0].style.background, 'rgba(74, 237, 217, 1)');
  assert.match(coal.textContent, /выкл/);
  coal.click();
  await page.advance(0);
  assert.deepEqual(posts().at(-1).blocks.map((b) => b.on), [true, true]);

  // ✎ у алмазов: название и цвет меняются, блок — нет; красный на максимум — сохранить.
  n.xmList.children[0].children[1].click();
  await page.advance(0);
  assert.equal(n.xmEdit.hidden, false);
  assert.equal(n.xmMain.hidden, true);
  assert.equal(n.xmName.readOnly, true);
  assert.equal(n.xmLabel.value, 'Алмазы');
  assert.equal(n.xmDelete.hidden, false);
  n.xmR.value = '255';
  n.xmR.fire('input');
  assert.equal(n.xmRv.textContent, '255');
  n.xmLabel.value = 'Алмазики';
  n.xmSave.click();
  await page.advance(0);
  const saved = posts().at(-1).blocks[0];
  assert.deepEqual([saved.name, saved.label, saved.color], ['diamond_ore', 'Алмазики', '#ffedd9ff']);
  assert.equal(n.xmEdit.hidden, true);

  // «Что в руке»: золотая руда — редактор нового блока с игровым названием; сохранить — в списке три.
  page.pick = { hand: 'gold_ore', look: null };
  n.xmHand.click();
  await page.advance(0);
  assert.equal(n.xmEdit.hidden, false);
  assert.equal(n.xmName.value, 'gold_ore');
  assert.equal(n.xmLabel.value, 'Gold Ore');
  assert.equal(n.xmDelete.hidden, true);
  n.xmSave.click();
  await page.advance(0);
  assert.deepEqual(posts().at(-1).blocks.map((b) => b.name), ['diamond_ore', 'coal_ore', 'gold_ore']);

  // «На что смотрит» — ни на что: понятное сообщение; Esc — закрыть меню.
  n.xmLook.click();
  await page.advance(0);
  assert.equal(n.xmMsg.textContent, 'Бот ни на что не смотрит (ближе 32 блоков)');
  page.key('Escape', { key: 'Escape' });
  await page.advance(0);
  assert.equal(n.xrayMenu.hidden, true);

  // Выключили — контуры убраны со сцены.
  n.btnXray.click();
  page.xrayResult = { rev: 9, enabled: false, result: null };
  page.server = { ...page.server, xray: { enabled: false, overlay: true, radius: 2, rev: 9 } };
  await page.advance(500);
  assert.equal(posts().at(-1).enabled, false);
  assert.ok(removed.includes(lines) && lines.geometry.disposed && lines.material.disposed);
  assert.ok(removed.includes(fill) && fill.geometry.disposed && fill.material.disposed);
  assert.equal(n.xrayBadge.hidden, true);
});