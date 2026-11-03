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

  const helpers = { normalizeMode, dimensionName, formatInt, formatStat, formatCoords, hudModel, windowTitle, statusCard, shouldReload };
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
  };

  // index.js уже выполнился: нет холста — значит, WebGL не включился.
  const hasView = Boolean(document.querySelector('canvas'));

  let state = null; // последний ответ панели
  let firstGeneration; // поколение, с которым открылась страница
  let fails = 0; // неудачных запросов подряд
  let pendingMode = null; // выбранный вид, пока панель его не подтвердила
  let loadingUntil = 0; // до какого момента показывать «Загрузка мира…»
  let leaving = false; // страница уже перезагружается

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

  el.first.addEventListener('click', () => pickMode('first'));
  el.third.addEventListener('click', () => pickMode('third'));
  el.reload.addEventListener('click', reload);

  render();
  poll();
})();
