'use strict';

/*
 * Страница окна «Экран бота». Сам 3D-вид рисует клиент prismarine-viewer (index.js),
 * а этот файл — слой поверх него: плашка с ником, здоровьем, сытостью, координатами
 * и измерением, переключатель камеры, кнопка «Обновить» и сообщения по центру.
 *
 * Раз в 500 мс страница спрашивает у панели состояние (GET state). Если поколение
 * сменилось (подключился другой бот или выбран другой вид), страница перезагружается:
 * клиент prismarine-viewer не умеет начинать заново без перезагрузки.
 *
 * Чистые функции экспортируются для тестов (как в renderer/motd.js); DOM-код под node не запускается.
 */

(function () {
  const DASH = '—';
  const BASE_TITLE = 'Экран бота';
  const DIMENSIONS = {
    overworld: 'Обычный мир',
    the_nether: 'Незер',
    the_end: 'Энд',
  };

  // Вид камеры: всё, кроме «со стороны», — глазами бота.
  const normalizeMode = (mode) => (mode === 'third' ? 'third' : 'first');

  // Измерение по-русски: 'minecraft:the_nether' -> 'Незер'; незнакомое — как есть, без 'minecraft:'.
  function dimensionName(dimension) {
    if (typeof dimension !== 'string') return '';
    const name = dimension.trim().replace(/^minecraft:/i, '');
    const key = name.toLowerCase();
    return Object.prototype.hasOwnProperty.call(DIMENSIONS, key) ? DIMENSIONS[key] : name;
  }

  // Целое число для показа; null, undefined, NaN, Infinity и не числа — «—».
  function formatInt(value, round = Math.round) {
    return typeof value === 'number' && Number.isFinite(value) ? String(round(value)) : DASH; // String(-0) === '0'
  }

  // Здоровье и сытость: «18/20». Вверх, как сердечки в игре: у живого бота не бывает «0/20».
  function formatStat(value) {
    const n = formatInt(value, Math.ceil);
    return n === DASH ? DASH : `${n}/20`;
  }

  // Координаты блока, как в F3: округление вниз (-0.5 -> -1).
  function formatCoords(pos) {
    const p = pos && typeof pos === 'object' ? pos : {};
    return { x: formatInt(p.x, Math.floor), y: formatInt(p.y, Math.floor), z: formatInt(p.z, Math.floor) };
  }

  // Тексты плашки в левом верхнем углу.
  function hudModel(state) {
    const s = state && typeof state === 'object' ? state : {};
    const name = typeof s.username === 'string' ? s.username.trim() : '';
    return {
      name: name || DASH,
      health: formatStat(s.health),
      food: formatStat(s.food),
      ...formatCoords(s.position),
      dimension: dimensionName(s.dimension),
    };
  }

  // Заголовок окна (Electron повторяет его в рамке окна).
  function windowTitle(state) {
    const name = state && state.online && typeof state.username === 'string' ? state.username.trim() : '';
    return name ? `${BASE_TITLE} — ${name}` : BASE_TITLE;
  }

  /**
   * Сообщение по центру: { kind, title, text } или null, когда мир виден без помех.
   * kind: unreachable | boot (ответа ещё нет) | offline | unsupported | nogl (нет WebGL) | loading.
   */
  function statusCard(state, { reachable = true, loading = false, hasView = true } = {}) {
    if (!reachable) return { kind: 'unreachable', title: 'Нет связи с панелью…', text: 'Пробую подключиться снова.' };
    if (!state) return { kind: 'boot', title: '', text: '' };
    if (!state.online) {
      return { kind: 'offline', title: 'Бот не в сети', text: 'Нажми «Старт» в панели — изображение появится само.' };
    }
    if (state.unsupported) {
      const version = typeof state.botVersion === 'string' && state.botVersion ? ` (${state.botVersion})` : '';
      return {
        kind: 'unsupported',
        title: 'Версия не поддерживается',
        text: `Эта версия Minecraft${version} пока не поддерживается окном просмотра.`,
      };
    }
    if (!hasView) {
      return {
        kind: 'nogl',
        title: '3D-вид не запустился',
        text: 'Не удалось включить 3D-графику (WebGL). Нажми «↻ Обновить» или перезапусти программу.',
      };
    }
    if (loading) return { kind: 'loading', title: 'Загрузка мира…', text: '' };
    return null;
  }

  // Поколение сменилось — нужна перезагрузка. Сравниваем, только когда оба значения известны.
  function shouldReload(first, next) {
    const known = (g) => g !== undefined && g !== null;
    return known(first) && known(next) && first !== next;
  }

  // ---------- рентген: чистые функции ----------

  // Цвет «#rrggbbaa» (или «#rrggbb») → { r, g, b, a } от 0 до 255; неверный — белый.
  function colorParts(hex) {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(hex || '').trim());
    if (!m) return { r: 255, g: 255, b: 255, a: 255 };
    const v = parseInt(m[1], 16);
    return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: m[2] ? parseInt(m[2], 16) : 255 };
  }

  // { r, g, b, a } → «#rrggbbaa».
  function colorHex({ r, g, b, a = 255 }) {
    const h = (n) => Math.max(0, Math.min(255, Math.round(Number(n) || 0))).toString(16).padStart(2, '0');
    return `#${h(r)}${h(g)}${h(b)}${h(a)}`;
  }

  // Цвет для CSS с прозрачностью.
  function cssColor(hex) {
    const c = colorParts(hex);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round((c.a / 255) * 1000) / 1000})`;
  }

  // Точка цветового круга: оттенок h (0–360°), насыщенность s и яркость v (0–1) → { r, g, b } от 0 до 255.
  function hsvToRgb(h, s, v) {
    const hh = (((h % 360) + 360) % 360) / 60;
    const c = v * s;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const [r, g, b] = hh < 1 ? [c, x, 0] : hh < 2 ? [x, c, 0] : hh < 3 ? [0, c, x] : hh < 4 ? [0, x, c] : hh < 5 ? [x, 0, c] : [c, 0, x];
    const m = v - c;
    return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
  }

  // Контуры блоков: на блок — 12 рёбер куба (по две точки), чуть внутрь, чтобы не мерцали на гранях.
  // positions — x, y, z подряд → Float32Array для LineSegments (72 числа на блок).
  const CUBE_EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
  function boxEdges(positions, inset = 0.002) {
    const n = Math.floor((positions ? positions.length : 0) / 3);
    const out = new Float32Array(n * 72);
    let o = 0;
    for (let i = 0; i < n; i += 1) {
      const x0 = positions[i * 3] + inset;
      const y0 = positions[i * 3 + 1] + inset;
      const z0 = positions[i * 3 + 2] + inset;
      const x1 = positions[i * 3] + 1 - inset;
      const y1 = positions[i * 3 + 1] + 1 - inset;
      const z1 = positions[i * 3 + 2] + 1 - inset;
      const c = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      for (const [a, b] of CUBE_EDGES) {
        out[o++] = c[a][0]; out[o++] = c[a][1]; out[o++] = c[a][2];
        out[o++] = c[b][0]; out[o++] = c[b][1]; out[o++] = c[b][2];
      }
    }
    return out;
  }

  // Радиус словами: «2 чанка (5×5)».
  function radiusText(radius) {
    const n = Math.max(0, Math.floor(Number(radius) || 0));
    const a = n % 100;
    const b = n % 10;
    const word = a > 10 && a < 20 ? 'чанков' : b === 1 ? 'чанк' : b >= 2 && b <= 4 ? 'чанка' : 'чанков';
    return `${n} ${word} (${n * 2 + 1}×${n * 2 + 1})`;
  }

  // Надпись поверх мира, как «XRay Active» у мода: null — не показывать.
  function xrayBadgeText(info, payload) {
    if (!info || !info.enabled || !info.overlay) return null;
    const result = payload && payload.enabled ? payload.result : null;
    if (!result) return 'Рентген включён · ищу…';
    return `Рентген включён · найдено ${result.total}${result.truncated ? '+' : ''}`;
  }

  // Строка списка подходит под поиск: по названию или имени блока, без учёта регистра и «ё».
  function entryMatches(entry, query) {
    const q = String(query || '').trim().toLowerCase().replace(/ё/g, 'е');
    if (!q) return true;
    const label = String((entry && entry.label) || '').toLowerCase().replace(/ё/g, 'е');
    const name = String((entry && entry.name) || '').toLowerCase();
    return label.includes(q) || name.includes(q.replace(/\s+/g, '_'));
  }

  // Найдено по строкам списка: имя блока → сколько.
  function countsByKey(payload) {
    const out = new Map();
    const result = payload && payload.enabled ? payload.result : null;
    if (result && Array.isArray(result.groups)) for (const g of result.groups) out.set(g.key, g.count);
    return out;
  }

  const helpers = {
    normalizeMode, dimensionName, formatInt, formatStat, formatCoords, hudModel, windowTitle, statusCard, shouldReload,
    colorParts, colorHex, cssColor, hsvToRgb, boxEdges, radiusText, xrayBadgeText, entryMatches, countsByKey,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = helpers;
  if (typeof document === 'undefined') return; // тесты под node: дальше только код страницы

  // ---------- страница ----------

  const POLL_MS = 500; // как часто спрашивать состояние
  const RETRY_MS = 1000; // пауза после неудачного запроса
  const TIMEOUT_MS = 4000; // зависший запрос не должен останавливать опрос
  const LOADING_MS = 3000; // сколько показывать «Загрузка мира…»
  const FAILS_TO_WARN = 2; // одна неудача подряд — ещё не «Нет связи»

  // Адрес должен кончаться на «/»: от него считаются 'state', 'worker.js' и путь socket.io.
  if (!location.pathname.endsWith('/')) {
    location.replace(`${location.pathname}/${location.search}`);
    return;
  }

  const $ = (id) => document.getElementById(id);
  const el = {
    hud: $('hud'),
    name: $('hudName'),
    health: $('hudHealth'),
    food: $('hudFood'),
    x: $('hudX'),
    y: $('hudY'),
    z: $('hudZ'),
    dim: $('hudDim'),
    first: $('modeFirst'),
    third: $('modeThird'),
    reload: $('btnReload'),
    hint: $('hint'),
    cross: $('crosshair'),
    curtain: $('curtain'),
    card: $('card'),
    cardTitle: $('cardTitle'),
    cardText: $('cardText'),
    xray: $('btnXray'),
    xrayMenuBtn: $('btnXrayMenu'),
    xrayBadge: $('xrayBadge'),
    xrayTip: $('xrayTip'),
    xrayTipClose: $('xrayTipClose'),
    menu: $('xrayMenu'),
    xmClose: $('xmClose'),
    xmMain: $('xmMain'),
    xmSearch: $('xmSearch'),
    xmList: $('xmList'),
    xmAdd: $('xmAdd'),
    xmHand: $('xmHand'),
    xmLook: $('xmLook'),
    xmRadius: $('xmRadius'),
    xmRadiusText: $('xmRadiusText'),
    xmLava: $('xmLava'),
    xmOverlay: $('xmOverlay'),
    xmMsg: $('xmMsg'),
    xmEdit: $('xmEdit'),
    xmEditTitle: $('xmEditTitle'),
    xmLabel: $('xmLabel'),
    xmName: $('xmName'),
    xmNames: $('xmNames'),
    xmWheel: $('xmWheel'),
    xmR: $('xmR'),
    xmG: $('xmG'),
    xmB: $('xmB'),
    xmA: $('xmA'),
    xmRv: $('xmRv'),
    xmGv: $('xmGv'),
    xmBv: $('xmBv'),
    xmAv: $('xmAv'),
    xmSwatch: $('xmSwatch'),
    xmSame: $('xmSame'),
    xmDelete: $('xmDelete'),
    xmCancel: $('xmCancel'),
    xmSave: $('xmSave'),
    xmEditMsg: $('xmEditMsg'),
  };

  // index.js уже выполнился: нет холста — значит, WebGL не включился.
  const hasView = Boolean(document.querySelector('canvas'));

  let state = null; // последний ответ панели
  let firstGeneration; // поколение, с которым открылась страница
  let fails = 0; // неудачных запросов подряд
  let pendingMode = null; // выбранный вид, пока панель его не подтвердила
  let loadingUntil = 0; // до какого момента показывать «Загрузка мира…»
  let leaving = false; // страница уже перезагружается

  // Рентген: настройки (как в панели), найденное, что нарисовано на сцене, меню и редактор.
  const xr = {
    settings: null, // { enabled, radius, lava, overlay, blocks: [{ name, label, color, on, same }] }
    info: null, // state.xray: { enabled, overlay, radius, rev }
    rev: null, // какой результат уже запрошен
    payload: null, // ответ xray/result: { rev, enabled, result }
    drawn: null, // для какого payload нарисованы контуры
    objects: [], // объекты three.js на сцене
    names: null, // [[имя, название]] — подсказки «Добавить блок»
    menu: false, // меню открыто
    edit: null, // редактор: { index (-1 — новый блок), color: { r, g, b, a } }
    saving: false,
  };

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  function reload() {
    if (leaving) return;
    leaving = true;
    location.reload();
  }

  function render() {
    const reachable = fails < FAILS_TO_WARN;
    const online = reachable && Boolean(state && state.online);
    const mode = pendingMode || normalizeMode(state && state.mode);
    const card = statusCard(state, { reachable, loading: Date.now() < loadingUntil, hasView });
    const worldShown = online && (!card || card.kind === 'loading');

    // Плашка видна, пока бот в сети, даже если сам мир показать нельзя.
    el.hud.hidden = !online;
    if (online) {
      const hud = hudModel(state);
      setText(el.name, hud.name);
      setText(el.health, hud.health);
      setText(el.food, hud.food);
      setText(el.x, hud.x);
      setText(el.y, hud.y);
      setText(el.z, hud.z);
      setText(el.dim, hud.dimension);
      el.dim.hidden = !hud.dimension;
    }

    el.first.setAttribute('aria-pressed', String(mode === 'first'));
    el.third.setAttribute('aria-pressed', String(mode === 'third'));
    el.first.disabled = !reachable;
    el.third.disabled = !reachable;

    el.hint.hidden = !(worldShown && mode === 'third');
    el.cross.hidden = !(worldShown && !card && mode === 'first');
    document.body.classList.toggle('orbit', worldShown && mode === 'third'); // курсор «рука» над миром

    el.curtain.hidden = !card;
    if (card) {
      el.curtain.dataset.kind = card.kind;
      el.card.hidden = !card.title;
      setText(el.cardTitle, card.title);
      setText(el.cardText, card.text);
      el.cardText.hidden = !card.text;
    }

    const title = windowTitle(online ? state : null);
    if (document.title !== title) document.title = title;

    renderXray(online, reachable);
  }

  // Запрос к панели с ограничением по времени; ответ — JSON состояния.
  async function request(url, options = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  function applyState(next) {
    if (firstGeneration === undefined) {
      firstGeneration = next.generation;
    } else if (shouldReload(firstGeneration, next.generation)) {
      reload(); // другой бот или другой вид: начинаем с чистой страницы
      return;
    }
    state = next;
    fails = 0;
    if (!loadingUntil && next.online && !next.unsupported) {
      loadingUntil = Date.now() + LOADING_MS;
      setTimeout(render, LOADING_MS + 50);
    }
    // Рентген: новый результат — перечитать; настройки поменялись не отсюда — тоже.
    const x = next.xray;
    if (x && x.rev !== xr.rev) {
      xr.rev = x.rev;
      xrayFetchResult();
      const s = xr.settings;
      if (!s || s.enabled !== x.enabled || s.radius !== x.radius || s.overlay !== x.overlay) xrayFetchSettings();
    }
    xr.info = x || null;
  }

  async function poll() {
    try {
      const next = await request('state').catch(() => null);
      if (next && typeof next === 'object') applyState(next);
      else fails += 1;
      if (!leaving) render();
    } finally {
      if (!leaving) setTimeout(poll, fails ? RETRY_MS : POLL_MS);
    }
  }

  async function pickMode(mode) {
    if (!state || leaving || pendingMode || normalizeMode(state.mode) === mode) return;
    pendingMode = mode; // кнопка нажимается сразу, не дожидаясь ответа
    render();
    const next = await request('mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode }),
    }).catch(() => null);
    pendingMode = null;
    if (next && typeof next === 'object') applyState(next); // панель сменила поколение — перезагрузка
    if (!leaving) render();
  }

  // ---------- рентген ----------

  const XRAY_TIP_KEY = 'mbp.xrayTip';
  // Сцена просмотрщика (index.js кладёт его в window.__mbpViewer — правка бандла expose-viewer) и THREE.
  const sceneOf = () => {
    const viewer = globalThis.__mbpViewer;
    return viewer && viewer.scene && globalThis.THREE ? viewer.scene : null;
  };

  function setMsg(node, text, ok = false) {
    node.textContent = text || '';
    node.classList.toggle('ok', Boolean(ok));
  }

  async function xrayFetchSettings() {
    const res = await request('xray').catch(() => null);
    if (res && res.settings) {
      xr.settings = res.settings;
      renderXrayMenu();
      if (!leaving) render();
    }
  }

  async function xrayFetchResult() {
    const res = await request('xray/result').catch(() => null);
    if (!res || typeof res !== 'object') return;
    xr.payload = res;
    xrayDraw();
    renderXrayMenu();
    render();
  }

  /** Сохранить настройки (панель запомнит их и раздаст ботам); msg — что написать в меню. */
  async function xraySave(next, msg = '') {
    if (xr.saving) return false;
    xr.saving = true;
    try {
      const res = await request('xray', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: next }),
      }).catch(() => null);
      if (!res || !res.settings) {
        setMsg(el.xmMsg, 'Не сохранилось: нет связи с панелью');
        return false;
      }
      xr.settings = res.settings;
      if (msg) setMsg(el.xmMsg, msg, true);
      renderXrayMenu();
      render();
      return true;
    } finally {
      xr.saving = false;
    }
  }

  function toggleXray() {
    if (!xr.settings) return;
    hideTip();
    xraySave({ ...xr.settings, enabled: !xr.settings.enabled });
  }

  // Контуры найденного — на сцене просмотрщика, поверх всего (без проверки глубины — сквозь стены).
  function xrayClear() {
    const scene = sceneOf();
    for (const obj of xr.objects) {
      if (scene) scene.remove(obj);
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) obj.material.dispose();
    }
    xr.objects = [];
  }

  function xrayDraw() {
    const scene = sceneOf();
    if (!scene) return; // 3D ещё не готово — нарисуем, когда появится (render зовёт снова)
    if (xr.drawn === xr.payload) return;
    xrayClear();
    xr.drawn = xr.payload;
    const result = xr.payload && xr.payload.enabled ? xr.payload.result : null;
    if (!result || !Array.isArray(result.groups)) return;
    const THREE = globalThis.THREE;
    for (const g of result.groups) {
      if (!Array.isArray(g.positions) || !g.positions.length) continue;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(boxEdges(g.positions), 3));
      const c = colorParts(g.color);
      // Мир просмотрщик рисует «прозрачным» материалом — последним; контуры тоже в этом проходе и после него
      // (renderOrder), иначе мир закрашивает их. Без проверки глубины — видны сквозь стены.
      const material = new THREE.LineBasicMaterial({
        color: (c.r << 16) | (c.g << 8) | c.b,
        transparent: true,
        opacity: Math.max(0.05, c.a / 255),
        depthTest: false,
        depthWrite: false,
      });
      const lines = new THREE.LineSegments(geometry, material);
      lines.renderOrder = 1000;
      lines.frustumCulled = false;
      // Заливка — едва заметная: контур в 1 пиксель издалека теряется, а блок с заливкой видно.
      if (typeof THREE.InstancedMesh === 'function') {
        const count = Math.floor(g.positions.length / 3);
        const fill = new THREE.InstancedMesh(
          new THREE.BoxGeometry(1, 1, 1),
          new THREE.MeshBasicMaterial({
            color: (c.r << 16) | (c.g << 8) | c.b,
            transparent: true,
            opacity: Math.max(0.03, (c.a / 255) * 0.3),
            depthTest: false,
            depthWrite: false,
          }),
          count,
        );
        const m = new THREE.Matrix4();
        for (let i = 0; i < count; i += 1) {
          m.makeTranslation(g.positions[i * 3] + 0.5, g.positions[i * 3 + 1] + 0.5, g.positions[i * 3 + 2] + 0.5);
          fill.setMatrixAt(i, m);
        }
        fill.instanceMatrix.needsUpdate = true;
        fill.renderOrder = 999;
        fill.frustumCulled = false;
        scene.add(fill);
        xr.objects.push(fill);
      }
      scene.add(lines);
      xr.objects.push(lines);
    }
  }

  let tipClosed = false;
  function hideTip() {
    tipClosed = true;
    el.xrayTip.hidden = true;
    try {
      localStorage.setItem(XRAY_TIP_KEY, '1');
    } catch (_) {
      // хранилища нет — подсказка просто покажется снова в другой раз
    }
  }

  function tipSeen() {
    if (tipClosed) return true;
    try {
      return localStorage.getItem(XRAY_TIP_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function renderXray(online, reachable) {
    const enabled = Boolean(xr.settings ? xr.settings.enabled : xr.info && xr.info.enabled);
    el.xray.setAttribute('aria-pressed', String(enabled));
    el.xray.disabled = !reachable || !xr.settings;
    el.xrayMenuBtn.disabled = !reachable || !xr.settings;
    el.xrayMenuBtn.setAttribute('aria-expanded', String(xr.menu));
    const text = online ? xrayBadgeText(xr.info, xr.payload) : null;
    el.xrayBadge.hidden = !text || xr.menu;
    if (text) setText(el.xrayBadge, text);
    el.xrayTip.hidden = !(online && xr.settings && !tipSeen() && !xr.menu);
    if (online) xrayDraw();
  }

  // ---------- меню ----------

  function openMenu() {
    if (!xr.settings) return;
    hideTip();
    xr.menu = true;
    el.menu.hidden = false;
    closeEditor();
    renderXrayMenu();
    render();
    el.xmSearch.focus();
  }

  function closeMenu() {
    xr.menu = false;
    el.menu.hidden = true;
    closeEditor();
    render();
    el.xrayMenuBtn.focus();
  }

  function renderXrayMenu() {
    if (!xr.menu || !xr.settings) return;
    const s = xr.settings;
    const counts = countsByKey(xr.payload);
    const query = el.xmSearch.value;
    const list = el.xmList;
    list.textContent = '';
    s.blocks.forEach((entry, index) => {
      if (!entryMatches(entry, query)) return;
      const li = document.createElement('li');
      li.className = 'xm-item';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'xm-entry';
      btn.setAttribute('aria-pressed', String(entry.on));
      btn.title = 'Нажми — включить или выключить; Shift+клик — изменить';
      const sw = document.createElement('span');
      sw.className = 'xm-sw';
      const fill = document.createElement('i');
      fill.style.background = cssColor(entry.color);
      sw.appendChild(fill);
      const name = document.createElement('span');
      name.className = 'xm-name';
      name.textContent = entry.label;
      const id = document.createElement('small');
      id.textContent = entry.name;
      name.appendChild(id);
      const count = document.createElement('span');
      count.className = 'xm-count';
      const n = counts.get(entry.name);
      if (entry.on && s.enabled && n !== undefined) {
        count.textContent = String(n);
        count.classList.toggle('found', n > 0);
      } else {
        count.textContent = entry.on ? '' : 'выкл';
      }
      btn.append(sw, name, count);
      btn.addEventListener('click', (e) => {
        if (e.shiftKey) {
          openEditor(index);
          return;
        }
        const blocks = s.blocks.map((b, i) => (i === index ? { ...b, on: !b.on } : b));
        xraySave({ ...s, blocks });
      });
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'xm-edit';
      edit.title = `Изменить: ${entry.label}`;
      edit.textContent = '✎';
      edit.addEventListener('click', () => openEditor(index));
      li.append(btn, edit);
      list.appendChild(li);
    });
    if (!list.children.length) {
      const li = document.createElement('li');
      li.className = 'xm-item';
      const empty = document.createElement('span');
      empty.className = 'xm-entry';
      empty.textContent = s.blocks.length ? 'Ничего не нашлось' : 'Список пуст — «+ Добавить блок»';
      li.appendChild(empty);
      list.appendChild(li);
    }
    el.xmRadius.value = String(s.radius);
    setText(el.xmRadiusText, radiusText(s.radius) + (s.radius >= 5 ? ' — поиск дольше' : ''));
    el.xmLava.checked = Boolean(s.lava);
    el.xmOverlay.checked = Boolean(s.overlay);
  }

  // ---------- редактор блока ----------

  async function loadNames() {
    if (xr.names) return xr.names;
    const res = await request('xray/blocks').catch(() => null);
    xr.names = res && Array.isArray(res.blocks) ? res.blocks : [];
    const frag = document.createDocumentFragment();
    for (const [name, title] of xr.names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.label = title;
      frag.appendChild(opt);
    }
    el.xmNames.textContent = '';
    el.xmNames.appendChild(frag);
    return xr.names;
  }

  function drawWheel() {
    const canvas = el.xmWheel;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx || canvas.dataset.drawn) return;
    const size = canvas.width;
    const r0 = size / 2;
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x + 0.5 - r0;
        const dy = y + 0.5 - r0;
        const d = Math.hypot(dx, dy) / r0;
        if (d > 1) continue;
        const c = hsvToRgb((Math.atan2(dy, dx) * 180) / Math.PI, d, 1);
        const o = (y * size + x) * 4;
        img.data[o] = c.r;
        img.data[o + 1] = c.g;
        img.data[o + 2] = c.b;
        img.data[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    canvas.dataset.drawn = '1';
  }

  function showEditColor() {
    const c = xr.edit.color;
    el.xmR.value = String(c.r);
    el.xmG.value = String(c.g);
    el.xmB.value = String(c.b);
    el.xmA.value = String(c.a);
    setText(el.xmRv, String(c.r));
    setText(el.xmGv, String(c.g));
    setText(el.xmBv, String(c.b));
    setText(el.xmAv, `${Math.round((c.a / 255) * 100)}%`);
    el.xmSwatch.textContent = '';
    const fill = document.createElement('i');
    fill.style.background = cssColor(colorHex(c));
    el.xmSwatch.appendChild(fill);
  }

  /** Открыть редактор: index — строка списка, -1 — новый блок (preset — имя и название, если уже известны). */
  async function openEditor(index, preset = null) {
    const s = xr.settings;
    const entry = index >= 0 ? s.blocks[index] : null;
    xr.edit = { index, color: colorParts(entry ? entry.color : '#ffffffff') };
    el.xmMain.hidden = true;
    el.xmEdit.hidden = false;
    setMsg(el.xmEditMsg, '');
    setText(el.xmEditTitle, entry ? `Изменить: ${entry.label}` : 'Добавить блок');
    el.xmLabel.value = entry ? entry.label : (preset && preset.label) || '';
    el.xmName.value = entry ? entry.name : (preset && preset.name) || '';
    el.xmName.readOnly = Boolean(entry); // блок у строки не меняется — только название и цвет
    el.xmSame.checked = entry ? entry.same !== false : true;
    el.xmDelete.hidden = !entry;
    drawWheel();
    showEditColor();
    (entry || (preset && preset.name) ? el.xmLabel : el.xmName).focus();
    if (!entry) loadNames();
  }

  function closeEditor() {
    xr.edit = null;
    el.xmEdit.hidden = true;
    el.xmMain.hidden = false;
  }

  async function saveEditor() {
    const s = xr.settings;
    const edit = xr.edit;
    if (!s || !edit) return;
    const name = String(el.xmName.value || '').trim().toLowerCase().replace(/^minecraft:/, '');
    if (!/^[a-z0-9_]{1,64}$/.test(name)) {
      setMsg(el.xmEditMsg, 'Нужно имя блока, как в игре: латиница, цифры и «_» (например, diamond_ore)');
      return;
    }
    if (edit.index < 0) {
      const names = await loadNames();
      if (names.length && !names.some(([n]) => n === name)) {
        setMsg(el.xmEditMsg, `Блока «${name}» в этой версии нет — выбери из подсказок`);
        return;
      }
      if (s.blocks.some((b) => b.name === name)) {
        setMsg(el.xmEditMsg, 'Этот блок уже есть в списке');
        return;
      }
    }
    const title = (xr.names || []).find(([n]) => n === name);
    const label = String(el.xmLabel.value || '').trim() || (title ? title[1] : name);
    const entry = { name, label, color: colorHex(edit.color), on: true, same: el.xmSame.checked };
    let blocks;
    if (edit.index >= 0) blocks = s.blocks.map((b, i) => (i === edit.index ? { ...b, ...entry, on: b.on } : b));
    else blocks = [...s.blocks, entry];
    const ok = await xraySave({ ...s, blocks }, edit.index >= 0 ? `Сохранено: ${label}` : `Добавлен: ${label}`);
    if (ok) {
      closeEditor();
      renderXrayMenu();
    } else {
      setMsg(el.xmEditMsg, 'Не сохранилось: нет связи с панелью');
    }
  }

  async function deleteEditor() {
    const s = xr.settings;
    const edit = xr.edit;
    if (!s || !edit || edit.index < 0) return;
    const gone = s.blocks[edit.index];
    const ok = await xraySave({ ...s, blocks: s.blocks.filter((_, i) => i !== edit.index) }, `Убран из списка: ${gone.label}`);
    if (ok) {
      closeEditor();
      renderXrayMenu();
    }
  }

  // «Что в руке» и «На что смотрит»: блок уже в списке — открыть его, нет — добавить.
  async function addPicked(which) {
    const res = await request('xray/pick').catch(() => null);
    const name = res && res[which];
    if (!name) {
      setMsg(el.xmMsg, which === 'hand' ? 'В руке у бота не блок' : 'Бот ни на что не смотрит (ближе 32 блоков)');
      return;
    }
    const index = xr.settings.blocks.findIndex((b) => b.name === name);
    if (index >= 0) {
      await openEditor(index);
      setMsg(el.xmEditMsg, 'Этот блок уже есть в списке — можно поменять название и цвет');
      return;
    }
    const names = await loadNames();
    const title = names.find(([n]) => n === name);
    openEditor(-1, { name, label: title ? title[1] : name });
  }

  function wheelPick(e) {
    if (!xr.edit) return;
    const rect = el.xmWheel.getBoundingClientRect();
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = e.clientY - rect.top - rect.height / 2;
    const d = Math.min(1, Math.hypot(dx, dy) / (rect.width / 2));
    const c = hsvToRgb((Math.atan2(dy, dx) * 180) / Math.PI, d, 1);
    xr.edit.color = { ...xr.edit.color, ...c };
    showEditColor();
  }

  el.xray.addEventListener('click', toggleXray);
  el.xrayMenuBtn.addEventListener('click', () => (xr.menu ? closeMenu() : openMenu()));
  el.xrayTipClose.addEventListener('click', () => {
    hideTip();
    render();
  });
  el.xmClose.addEventListener('click', closeMenu);
  el.xmSearch.addEventListener('input', renderXrayMenu);
  el.xmAdd.addEventListener('click', () => openEditor(-1));
  el.xmHand.addEventListener('click', () => addPicked('hand'));
  el.xmLook.addEventListener('click', () => addPicked('look'));
  el.xmRadius.addEventListener('input', () => setText(el.xmRadiusText, radiusText(el.xmRadius.value)));
  el.xmRadius.addEventListener('change', () => xraySave({ ...xr.settings, radius: Number(el.xmRadius.value) }));
  el.xmLava.addEventListener('change', () => xraySave({ ...xr.settings, lava: el.xmLava.checked }));
  el.xmOverlay.addEventListener('change', () => xraySave({ ...xr.settings, overlay: el.xmOverlay.checked }));
  for (const [input, key] of [[el.xmR, 'r'], [el.xmG, 'g'], [el.xmB, 'b'], [el.xmA, 'a']]) {
    input.addEventListener('input', () => {
      if (!xr.edit) return;
      xr.edit.color = { ...xr.edit.color, [key]: Number(input.value) };
      showEditColor();
    });
  }
  let wheelDrag = false;
  el.xmWheel.addEventListener('pointerdown', (e) => {
    wheelDrag = true;
    el.xmWheel.setPointerCapture(e.pointerId);
    wheelPick(e);
  });
  el.xmWheel.addEventListener('pointermove', (e) => {
    if (wheelDrag) wheelPick(e);
  });
  el.xmWheel.addEventListener('pointerup', () => {
    wheelDrag = false;
  });
  el.xmSave.addEventListener('click', saveEditor);
  el.xmCancel.addEventListener('click', closeEditor);
  el.xmDelete.addEventListener('click', deleteEditor);
  el.xmName.addEventListener('change', () => {
    // Выбрали блок из подсказок — название подставим по-игровому, если своё не задано.
    const title = (xr.names || []).find(([n]) => n === el.xmName.value.trim());
    if (title && !el.xmLabel.value.trim()) el.xmLabel.value = title[1];
  });
  for (const input of [el.xmLabel, el.xmName]) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveEditor();
    });
  }

  // Клавиши, как у мода: \ — рентген вкл/выкл, G — меню; Esc — закрыть. Пока печатают в поле — не мешаем.
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (e.key === 'Escape' && xr.menu) {
      if (xr.edit) closeEditor();
      else closeMenu();
      e.preventDefault();
      return;
    }
    if (typing || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.code === 'Backslash' || e.code === 'IntlBackslash') {
      toggleXray();
      e.preventDefault();
    } else if (e.code === 'KeyG') {
      if (xr.menu) closeMenu();
      else openMenu();
      e.preventDefault();
    }
  });

  el.first.addEventListener('click', () => pickMode('first'));
  el.third.addEventListener('click', () => pickMode('third'));
  el.reload.addEventListener('click', reload);

  render();
  poll(); // настройки рентгена — когда панель скажет о нём в state
})();
