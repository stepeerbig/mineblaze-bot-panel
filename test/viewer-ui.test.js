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
function openPage({ pathname = '/token/', canvas = true, server = {} } = {}) {
  const nodes = {};
  for (const [, id] of read('index.html').matchAll(/\sid="([^"]+)"/g)) {
    nodes[id] = {
      hidden: false,
      textContent: '',
      disabled: false,
      dataset: {},
      attrs: {},
      handlers: [],
      setAttribute(name, value) { this.attrs[name] = String(value); },
      addEventListener(type, fn) { if (type === 'click') this.handlers.push(fn); },
      click() { for (const fn of this.handlers) fn(); },
    };
  }

  const page = {
    nodes,
    now: 1000,
    reloads: 0,
    replaced: null,
    requests: [],
    down: false, // панель не отвечает
    server: { online: false, generation: 1, mode: 'first', ...server },
  };
  const timers = new Map();
  let seq = 0;
  const classes = new Set();
  const document = {
    title: 'Экран бота',
    body: { classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } },
    getElementById: (id) => nodes[id] || null,
    querySelector: (selector) => (selector === 'canvas' && canvas ? {} : null),
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
      return json(404, {});
    },
  };

  page.document = document;
  page.classes = classes;
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
