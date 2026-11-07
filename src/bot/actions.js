'use strict';

// Безопасные действия бота: всё, что бот делает в мире (смотрит, ходит, копает, ставит блоки, нажимает на блоки,
// бьёт, берёт предмет в руку, пишет в чат), идёт через этот слой — тогда новые функции не дают античиту новых
// поводов. Каждое действие повторяет обычного игрока:
//  - пакеты — те же и в том же порядке, внутри тика, до пакета движения (как нажатия мыши у клиента);
//  - сначала взгляд на блок (плавно, см. physics.js), и только когда голова остановилась — удар или нажатие;
//  - дальность и видимость проверяются по тому, что о боте знает сервер (его положение и взгляд в пакетах);
//  - копание — по тикам, с взмахом руки каждый тик и с тем же временем, что у клиента; после сломанного блока —
//    пауза 5 тиков, между нажатиями правой кнопки — 4 тика, как у клиента; номера sequence — как у клиента;
//  - чат — не чаще раза в 1,5–2 секунды.
// Нужна своя физика (src/bot/physics.js): по её взгляду и положению всё и проверяется.

const { Vec3 } = require('vec3');
const { RaycastIterator } = require('prismarine-world').iterators;
const { findPath, fastReader, edgeKey, LIQUID_RE, UNBREAKABLE_RE, MAX_HARDNESS } = require('./pathfinder');

const BLOCK_REACH = 4.4; // у игрока 4,5 блока — оставляем запас
const ENTITY_REACH = 2.9; // у игрока 3 блока
const USE_DELAY_TICKS = 4; // пауза между нажатиями правой кнопки у клиента
// Пауза после сломанного блока: у клиента с зажатой кнопкой следующий удар — на 6-м тике (5 тиков задержки);
// Grim (FastBreak) копит, если удар раньше 275 мс после конца прошлого.
const DESTROY_DELAY_TICKS = 6;
const CONFIRM_TICKS = 20; // столько ждём, что сервер подтвердит сломанный или поставленный блок
const LOOK_TIMEOUT_TICKS = 60;
const STUCK_TICKS = 60; // столько тиков без продвижения — бот застрял
const FIRST_SEARCH_NODES = 2000; // путь с копанием к точке: точный поиск — до стольких клеток, дальше — жадный
const SETBACK_CALM_TICKS = 6; // после отката сервером — столько тиков без клавиш
const WALK_TICKS_PER_BLOCK = 4.6; // шагом блок — за столько тиков (4,3 блока в секунду)
// Копание при поиске пути дешевле настоящего времени во столько раз: бот прёт прямо на цель, «как танк», а не
// обходит по пещерам. С хорошей киркой это и по времени не дольше: шаг туннеля ≈ 2 блока × (2–3 тика + пауза 5).
const TANK = 0.35;
const ATTACK_COOLDOWN_TICKS = 12; // пауза между ударами (меч восстанавливается за 12,5 тика)
const EAT_MAX_TICKS = 60; // еда съедается за 32 тика (1,6 с); дольше этого и ответа сервера — не вышло
const CHAT_INTERVAL_MS = 1500;
// Клики в меню: первый — через 0,5–0,9 с после открытия, следующие — через 0,25–0,55 с; ответ сервера ждём до 0,5 с.
const FIRST_CLICK_TICKS = 10;
const FIRST_CLICK_JITTER = 8;
const NEXT_CLICK_TICKS = 5;
const NEXT_CLICK_JITTER = 6;
const CLICK_REPLY_TICKS = 10;
// Меню приходит двумя пакетами: само окно (bot.currentWindow уже есть) и его ячейки (тогда — windowOpen).
// Кликать по ещё пустому окну нельзя — ждём ячейки столько.
const WINDOW_READY_TICKS = 20;
const WINDOW_PACKETS = ['set_slot', 'set_cursor_item', 'window_items', 'open_window', 'close_window', 'set_player_inventory'];
const FULL_BLOCK = [[0, 0, 0, 1, 1, 1]];

// Грани в номерах протокола: 0 низ, 1 верх, 2 север (-z), 3 юг (+z), 4 запад (-x), 5 восток (+x).
const FACE_NAMES = ['низ', 'верх', 'север', 'юг', 'запад', 'восток'];
const FACE_VECTORS = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)];
const faceOf = (v) => FACE_VECTORS.findIndex((f) => f.equals(v));

class ActionError extends Error {
  constructor(message, code = 'failed') {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}

const fmt = (v) => `${Math.floor(v.x)} ${Math.floor(v.y)} ${Math.floor(v.z)}`;

/** Направление взгляда по углам mineflayer (радианы). */
function lookVector(yaw, pitch) {
  const c = Math.cos(pitch);
  return new Vec3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c);
}

/** Углы взгляда (радианы, как в mineflayer) от точки from на точку to. */
function anglesTo(from, to) {
  const d = to.minus(from);
  return { yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) };
}

function angleDiff(a, b) {
  let d = (a - b) % (Math.PI * 2);
  if (d < -Math.PI) d += Math.PI * 2;
  else if (d > Math.PI) d -= Math.PI * 2;
  return d;
}

/** Общая рамка всех частей блока: [x0, y0, z0, x1, y1, z1]. */
function boundsOf(shapes) {
  const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const s of shapes) {
    for (let i = 0; i < 3; i += 1) {
      b[i] = Math.min(b[i], s[i]);
      b[i + 3] = Math.max(b[i + 3], s[i + 3]);
    }
  }
  return b;
}

/** Ближайшая к точке p точка коробки [x0, y0, z0, x1, y1, z1] (уже в мировых координатах). */
function closestPointOnBox(box, p) {
  return new Vec3(Math.min(Math.max(p.x, box[0]), box[3]), Math.min(Math.max(p.y, box[1]), box[4]), Math.min(Math.max(p.z, box[2]), box[5]));
}

/** Пересечение луча с коробкой: расстояние до входа или null. */
function rayBox(from, dir, box) {
  let tmin = -Infinity;
  let tmax = Infinity;
  const o = [from.x, from.y, from.z];
  const d = [dir.x, dir.y, dir.z];
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(d[i]) < 1e-12) {
      if (o[i] < box[i] || o[i] > box[i + 3]) return null;
    } else {
      let t1 = (box[i] - o[i]) / d[i];
      let t2 = (box[i + 3] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmax >= 0 ? Math.max(tmin, 0) : null;
}

/**
 * Первый блок с формой на луче. shapesOf(block, position) — формы блока для попадания (пустой массив — луч
 * проходит насквозь). Возвращает { block, position, face, point } или null.
 */
function raycastBlocks(blockAt, from, dir, maxDist, shapesOf) {
  const iter = new RaycastIterator(from, dir, maxDist);
  let cell = { x: Math.floor(from.x), y: Math.floor(from.y), z: Math.floor(from.z) };
  while (cell) {
    const position = new Vec3(cell.x, cell.y, cell.z);
    const block = blockAt(position);
    if (block) {
      const shapes = shapesOf(block, position);
      if (shapes.length) {
        const hit = iter.intersect(shapes, position);
        if (hit && hit.pos.distanceTo(from) <= maxDist) return { block, position, face: hit.face, point: hit.pos };
      }
    }
    cell = iter.next();
  }
  return null;
}

/**
 * Плагин для mineflayer: createBot({ plugins: { actions: createActionsPlugin() } }) добавляет bot.actions.
 * @param {object}   [opts]
 * @param {Function} [opts.random]  источник случайности 0..1 (подмена для тестов)
 * @param {Function} [opts.now]     текущее время в мс (подмена для тестов)
 */
function createActionsPlugin({ random = Math.random, now = () => Date.now() } = {}) {
  return function actionsPlugin(bot) {
    inject(bot, { random, now });
  };
}

function inject(bot, { random, now }) {
  const airIds = new Set(['air', 'cave_air', 'void_air'].map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((b) => b.id));
  const isAir = (block) => !block || airIds.has(block.type);

  let sequence = 0; // как у клиента: растёт с каждым копанием, установкой, использованием предмета
  let selfUpdate = false; // мир меняет наше же предсказание (а не ответ сервера)
  let ackedSequence = 0; // до какого номера сервер подтвердил действия (block_changed_ack)
  const predictions = new Map(); // «x,y,z» → { pos, state: номер состояния по серверу, sequence }
  let lastUseTick = -Infinity;
  let lastDestroyTick = -Infinity;
  let lastAttackTick = -Infinity;
  const entries = new Set(); // действия: идёт и ждут очереди
  let current = null;
  let chain = Promise.resolve();
  const tickHandlers = new Set();

  const ticks = () => (bot.serverView ? bot.serverView.ticks : 0);

  bot.on('physicsTick', () => {
    for (const handler of [...tickHandlers]) {
      try {
        handler();
      } catch (err) {
        bot.emit('error', err);
      }
    }
    stepSeen(); // конец тика клиента: сущности сдвигаются к позициям с сервера — уже после ударов этого тика
  });

  // Чужие сущности — там, где их видит игра. Клиент переносит сущность к новой позиции с сервера не сразу, а за
  // 3 тика (InterpolationHandler: каждый тик — 1/3, потом 1/2, потом остаток пути). Прицел и дальность удара у игрока —
  // по этой позиции, Grim проверяет удар по ней же. По самой свежей позиции с сервера подходящий зомби на 0,1–0,4
  // блока ближе: удар «с 2,9» у Grim был 3,05 (стенд, Reach).
  const seen = new Map(); // номер сущности → { pos: где видна, target: последняя с сервера, steps }
  const LERP_STEPS = 3;
  const SNAP_DISTANCE = 64; // дальше — игра переносит сразу
  const trackEntity = (e) => {
    if (e && e.position && e !== bot.entity) seen.set(e.id, { pos: e.position.clone(), target: e.position.clone(), steps: 0 });
  };
  bot.on('entitySpawn', trackEntity);
  bot.on('entityMoved', (e) => {
    if (!e || !e.position || e === bot.entity) return;
    const s = seen.get(e.id);
    if (!s) return trackEntity(e); // появилась до нас — откуда идёт, неизвестно
    if (s.target.equals(e.position)) return; // только повернулась
    s.target = e.position.clone();
    if (s.pos.distanceTo(s.target) > SNAP_DISTANCE) {
      s.pos = s.target.clone();
      s.steps = 0;
    } else {
      s.steps = LERP_STEPS;
    }
  });
  bot.on('entityGone', (e) => {
    if (e) seen.delete(e.id);
  });
  function stepSeen() {
    for (const s of seen.values()) {
      if (s.steps <= 0) continue;
      const k = 1 / s.steps;
      s.pos = new Vec3(s.pos.x + (s.target.x - s.pos.x) * k, s.pos.y + (s.target.y - s.pos.y) * k, s.pos.z + (s.target.z - s.pos.z) * k);
      s.steps -= 1;
    }
  }
  /** Где сущность сейчас у клиента игры: для прицела, дальности и луча (её позицию меняли без события — та, что есть). */
  const seenPosition = (entity) => {
    const s = entity && entity.position ? seen.get(entity.id) : null;
    return s && s.target.equals(entity.position) ? s.pos : entity.position;
  };

  // Новый мир или сервер — у клиента новый счётчик sequence; всё, что бот делал, прерывается.
  const interrupt = (why) => () => {
    sequence = 0;
    ackedSequence = 0; // новый счётчик — и подтверждения считаются заново
    predictions.clear();
    abortAll(new ActionError(why, 'interrupted'));
  };
  bot.on('respawn', interrupt('прервано: смена мира'));
  bot.on('death', interrupt('прервано: бот погиб'));
  bot.on('end', interrupt('прервано: бот отключился'));
  if (bot._client && typeof bot._client.on === 'function') bot._client.on('start_configuration', interrupt('прервано: переход на другой сервер'));

  // ---------- тики и очередь ----------

  function abortError(signal) {
    const reason = signal && signal.reason;
    return reason instanceof ActionError ? reason : new ActionError('действие прервано', 'aborted');
  }

  /** Выполнить fn внутри ближайшего тика — до пакета движения. Промис — с результатом fn. */
  function inTick(fn, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      const onAbort = () => {
        tickHandlers.delete(run);
        reject(abortError(signal));
      };
      const run = () => {
        tickHandlers.delete(run);
        if (signal) signal.removeEventListener('abort', onAbort);
        try {
          resolve(fn());
        } catch (err) {
          reject(err);
        }
      };
      tickHandlers.add(run);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async function waitTicks(n, signal) {
    for (let i = 0; i < n; i += 1) await inTick(() => {}, signal);
  }

  /** Каждый тик вызывает step(); step возвращает undefined — продолжить, иначе значение — конец. */
  function everyTick(step, signal) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => {
        tickHandlers.delete(handler);
        if (signal) signal.removeEventListener('abort', onAbort);
        fn(value);
      };
      const onAbort = () => finish(reject, abortError(signal));
      const handler = () => {
        let result;
        try {
          result = step();
        } catch (err) {
          finish(reject, err);
          return;
        }
        if (result !== undefined) finish(resolve, result);
      };
      if (signal && signal.aborted) {
        reject(abortError(signal));
        return;
      }
      tickHandlers.add(handler);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  function abortAll(reason) {
    for (const entry of entries) entry.controller.abort(reason);
  }

  /**
   * Действия идут по одному: новое прерывает то, что идёт сейчас (и то, что ждало очереди). Открытое окно
   * (сундук, меню) перед действием закрывается: человек с открытым окном не ходит, не смотрит по сторонам и не
   * ломает блоки — и античиты это проверяют.
   */
  function run(name, fn, { keepWindow = false } = {}) {
    abortAll(new ActionError(`прервано: новое действие «${name}»`, 'replaced'));
    const controller = new AbortController();
    const entry = { name, controller };
    entries.add(entry);
    const promise = chain.then(async () => {
      try {
        if (controller.signal.aborted) throw abortError(controller.signal);
        ensureInWorld();
        current = entry;
        if (!keepWindow) await closeWindowIfOpen(controller.signal);
        return await fn(controller.signal);
      } finally {
        if (current === entry) current = null;
        entries.delete(entry);
        releaseControls();
      }
    });
    chain = promise.catch(() => {});
    return promise;
  }

  function ensureInWorld() {
    if (!bot.serverView) throw new ActionError('действия работают только со своей физикой бота', 'unsupported');
    if (!bot.entity || !bot._client || bot._client.state !== 'play') throw new ActionError('бот не в мире', 'not_ready');
    if (bot.isAlive === false) throw new ActionError('бот мёртв', 'not_ready');
  }

  function releaseControls() {
    if (typeof bot.setControlState !== 'function') return;
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint']) bot.setControlState(c, false);
  }

  /** Закрыть сундук или меню, если открыто, и чуть подождать — как человек, нажавший Esc. */
  async function closeWindowIfOpen(signal) {
    const window = bot.currentWindow;
    if (!window || typeof bot.closeWindow !== 'function') return;
    bot.closeWindow(window);
    await waitTicks(2 + Math.floor(random() * 3), signal);
  }

  // ---------- что знает сервер ----------

  const eyeHeight = () => (bot.getControlState && bot.getControlState('sneak') ? 1.27 : 1.62);
  const eyePosition = () => bot.serverView.position.offset(0, eyeHeight(), 0);
  const currentLook = () => lookVector(bot.serverView.yaw, bot.serverView.pitch);
  const blockAt = (pos) => bot.blockAt(pos, false);

  /** Формы для луча: у нужного блока без формы столкновения (трава, цветы) — целый куб, остальные такие пропускаем. */
  const shapesFor = (target) => (block, position) => {
    if (block.shapes && block.shapes.length) return block.shapes;
    if (target && position.equals(target) && !isAir(block)) return FULL_BLOCK;
    return [];
  };

  /** Куда сейчас смотрит бот (по взгляду, известному серверу): { block, position, face, point } или null. */
  function lookedAtBlock(maxDist = BLOCK_REACH, target = null) {
    return raycastBlocks(blockAt, eyePosition(), currentLook(), maxDist, shapesFor(target));
  }

  /** Повернуть голову и дождаться, пока она остановится (взгляд уже ушёл на сервер). */
  async function settleLook(yaw, pitch, signal) {
    bot.look(yaw, pitch, true);
    for (let i = 0; i < LOOK_TIMEOUT_TICKS; i += 1) {
      await inTick(() => {}, signal);
      if (bot.serverView.lookSettled) return;
    }
    throw new ActionError('не удалось повернуть голову');
  }

  /**
   * Стоять на месте: отпустить клавиши и дождаться, пока бот остановится. loose — «почти стоит» (копать можно и
   * когда бот ещё чуть катится: за пару тиков он сдвинется на сотые доли блока, а ждать полной остановки — 6 тиков).
   */
  async function standStill(signal, { loose = false } = {}) {
    releaseControls();
    const limit = loose ? 0.03 : 0.003;
    for (let i = 0; i < 40; i += 1) {
      const v = bot.entity.velocity;
      if (bot.entity.onGround && Math.hypot(v.x, v.z) < limit) return;
      await inTick(() => {}, signal);
    }
  }

  /**
   * Точка на видимой грани блока, на которую можно навести взгляд: луч до неё не задевает другие блоки.
   * Возвращает { face, point } (ближайшую из видимых граней) или null.
   */
  function visibleFacePoint(position, block) {
    const eye = eyePosition();
    const shapes = block.shapes && block.shapes.length ? block.shapes : FULL_BLOCK;
    const b = boundsOf(shapes);
    const box = [position.x + b[0], position.y + b[1], position.z + b[2], position.x + b[3], position.y + b[4], position.z + b[5]];
    const lerp = (lo, hi) => lo + (hi - lo) * (0.35 + 0.3 * random()); // не в самый центр и не у края
    const candidates = [];
    for (let face = 0; face < 6; face += 1) {
      const n = FACE_VECTORS[face];
      let point;
      if (n.y !== 0) point = new Vec3(lerp(box[0], box[3]), n.y > 0 ? box[4] : box[1], lerp(box[2], box[5]));
      else if (n.z !== 0) point = new Vec3(lerp(box[0], box[3]), lerp(box[1], box[4]), n.z > 0 ? box[5] : box[2]);
      else point = new Vec3(n.x > 0 ? box[3] : box[0], lerp(box[1], box[4]), lerp(box[2], box[5]));
      if (eye.minus(point).dot(n) <= 1e-6) continue; // эту грань с места бота не видно
      const dist = eye.distanceTo(point);
      if (dist > BLOCK_REACH) continue;
      const hit = raycastBlocks(blockAt, eye, point.minus(eye).normalize(), dist + 0.05, shapesFor(position));
      if (!hit || !hit.position.equals(position)) continue; // мешает другой блок
      candidates.push({ face: hit.face, point, dist });
    }
    candidates.sort((a, b2) => a.dist - b2.dist);
    return candidates[0] || null;
  }

  function nextSequence() {
    sequence += 1;
    return sequence;
  }

  let swungTick = -Infinity;
  function swing() {
    bot._client.write('arm_animation', { hand: 0 });
    swungTick = ticks();
  }

  // Кнопка «зажата» между блоками: у клиента с зажатой кнопкой в паузе после сломанного блока (5 тиков) рука
  // машет каждый тик, если под взглядом блок (continueDestroyBlock во время destroyDelay). Без этого бот копал
  // «кликами»: удар — тишина — удар. Только пока идёт копание (dig, digTo).
  let digHolding = false;
  bot.on('physicsTick', () => {
    if (!digHolding || !bot.serverView || swungTick === ticks()) return;
    if (ticks() - lastDestroyTick >= DESTROY_DELAY_TICKS) return;
    try {
      const hit = lookedAtBlock(BLOCK_REACH);
      if (hit && !isAir(hit.block)) swing();
    } catch (_) {
      // мир не загружен — не машем
    }
  });

  function blockAtOrThrow(position) {
    const block = blockAt(position);
    if (!block) throw new ActionError(`мир в точке ${fmt(position)} не загружен`);
    return block;
  }

  async function waitBlockChange(position, check, signal) {
    for (let i = 0; i < CONFIRM_TICKS; i += 1) {
      await inTick(() => {}, signal);
      if (check(blockAt(position))) return true;
    }
    return false;
  }

  // ---------- действия ----------

  /** Повернуть голову (радианы, как в mineflayer). */
  function look(yaw, pitch) {
    return run('повернуться', (signal) => settleLook(yaw, pitch, signal));
  }

  /** Посмотреть на точку в мире. */
  function lookAt(point) {
    return run('посмотреть', (signal) => {
      const a = anglesTo(eyePosition(), point);
      return settleLook(a.yaw, a.pitch, signal);
    });
  }

  /**
   * Плывёт ли бот: вода глубже 0,4 блока (там игра на «прыжок» даёт гребок вверх — держать его, чтобы всплыть).
   * В мелкой воде — идти и прыгать на ступеньку, как по суше: прыжок там обычный.
   */
  const swimming = () => (bot.entity.waterDepth === undefined ? Boolean(bot.entity.isInWater) : bot.entity.waterDepth > 0.4);

  /**
   * Дойти до точки по прямой (без поиска пути): поворачивает на ходу, перешагивает на блок выше прыжком.
   * @param {Vec3}    target
   * @param {object}  [opts]
   * @param {number}  [opts.range=0.35]  насколько близко подойти (по горизонтали)
   * @param {boolean} [opts.sprint=false] бежать на длинных прямых участках
   * @param {number}  [opts.timeoutMs]    сколько можно идти (по умолчанию — по расстоянию)
   */
  function walkTo(target, { range = 0.35, sprint = false, timeoutMs } = {}) {
    return run('идти', async (signal) => {
      const start = bot.entity.position.clone();
      const limitTicks = Math.ceil((timeoutMs || 5000 + start.distanceTo(target) * 600) / 50);
      const walkPitch = -(0.1 + 0.15 * random()); // идущий человек смотрит чуть вниз
      let best = Infinity;
      let bestTick = 0;
      let tick = 0;
      let lastLookYaw = null;
      let jumpTicks = 0;
      let arrivedTicks = 0;
      const onForced = () => {
        lastLookYaw = null; // сервер поставил взгляд сам (откат, телепорт) — навести на цель заново
      };
      bot.on('forcedMove', onForced);
      try {
      await everyTick(() => {
        tick += 1;
        const pos = bot.entity.position;
        const dx = target.x - pos.x;
        const dz = target.z - pos.z;
        const dist = Math.hypot(dx, dz);
        if (dist <= range && Math.abs(target.y - pos.y) < 1.5) {
          // Пришли: отпускаем клавиши и даём остановиться (без «стоп-крана»).
          releaseControls();
          arrivedTicks += 1;
          const v = bot.entity.velocity;
          return Math.hypot(v.x, v.z) < 0.003 || arrivedTicks > 10 ? true : undefined;
        }
        if (dist < best - 0.05) {
          best = dist;
          bestTick = tick;
        } else if (tick - bestTick > STUCK_TICKS) {
          throw new ActionError(`не могу дойти до ${fmt(target)}: застрял`, 'stuck');
        }
        if (tick > limitTicks) throw new ActionError(`не успел дойти до ${fmt(target)}`, 'timeout');

        const yaw = Math.atan2(-dx, -dz);
        if (lastLookYaw === null || Math.abs(angleDiff(yaw, lastLookYaw)) > 0.02) {
          bot.look(yaw, walkPitch, true);
          lastLookYaw = yaw;
        }
        const facing = Math.abs(angleDiff(yaw, bot.serverView.yaw));
        const forward = facing < 0.7; // разворачиваемся на месте, если цель сильно сбоку
        bot.setControlState('forward', forward && dist > range * 0.6);
        bot.setControlState('sprint', Boolean(sprint) && forward && facing < 0.26 && dist > 3 && (bot.food === undefined || bot.food > 6));

        // Ступенька в один блок — прыжок; в глубокой воде — всплываем.
        let jump = swimming();
        if (jumpTicks > 0) jumpTicks -= 1;
        if (!jump && forward && bot.entity.onGround && bot.entity.isCollidedHorizontally && jumpTicks === 0) {
          const ahead = pos.offset(-Math.sin(yaw) * 0.7, 0, -Math.cos(yaw) * 0.7);
          const feet = blockAt(ahead.floored());
          const above = blockAt(ahead.floored().offset(0, 1, 0));
          const overHead = blockAt(pos.floored().offset(0, 2, 0));
          const solid = (b) => b && b.shapes && b.shapes.length;
          if (solid(feet) && !solid(above) && !solid(overHead)) {
            jump = true;
            jumpTicks = 10;
          }
        }
        bot.setControlState('jump', jump);
        return undefined;
      }, signal);
      } finally {
        bot.removeListener('forcedMove', onForced);
      }
    });
  }

  /**
   * Пройти по точкам пути (клетки ног, см. pathfinder.js), не останавливаясь на каждой: смотреть на ближайшую ещё не
   * пройденную, на ступеньку — прыжок, с уступа — шаг вниз, в воде — всплывать. До последней — с точностью range.
   */
  async function followPath(points, { range = 0.35, sprint = false, settle = 0.003 } = {}, signal) {
    if (!points.length) return;
    const walkPitch = -(0.1 + 0.15 * random());
    const centre = (p) => new Vec3(p.x + 0.5, p.y, p.z + 0.5);
    let i = 0;
    let tick = 0;
    let best = Infinity;
    let bestTick = 0;
    let lastLookYaw = null;
    let jumpTicks = 0;
    let arrivedTicks = 0;
    let climbing = false; // прыгнул на ступеньку и ещё не встал
    const limitTicks = Math.ceil((5000 + points.length * 700) / 50);
    // Где застрял — откуда и куда шёл: навигация обойдёт этот шаг (findPath opts.avoid).
    const stuckAt = (err, target) => Object.assign(err, { from: bot.entity.position.floored(), to: points[i] && new Vec3(points[i].x, points[i].y, points[i].z), target });
    // Сервер поставил бота в точку (откат, телепорт) — и взгляд тоже: навести его на цель заново. После отката —
    // несколько тиков без клавиш: тот же шаг сразу же античит часто откатывает снова, каждый тик (петля откатов).
    let calmTicks = 0;
    const onForced = () => {
      lastLookYaw = null;
      calmTicks = SETBACK_CALM_TICKS;
    };
    bot.on('forcedMove', onForced);
    try {
      await everyTick(() => {
      tick += 1;
      const pos = bot.entity.position;
      // Пройденные точки. По прямой — рядом с ней или уже за ней по ходу; на повороте — только встав в её клетку
      // (иначе бот срезает угол и цепляется коробкой за край стены).
      while (i < points.length - 1) {
        const p = centre(points[i]);
        const q = centre(points[i + 1]);
        const d = Math.hypot(p.x - pos.x, p.z - pos.z);
        const inX = p.x - pos.x;
        const inZ = p.z - pos.z;
        const outX = q.x - p.x;
        const outZ = q.z - p.z;
        const straight = d < 1e-6 || (inX * outX + inZ * outZ) / (Math.hypot(inX, inZ) * Math.hypot(outX, outZ) || 1) > 0.94;
        const passed = straight && (pos.x - p.x) * outX + (pos.z - p.z) * outZ > 0 && d < 0.9;
        const inCell = Math.abs(p.x - pos.x) <= 0.25 && Math.abs(p.z - pos.z) <= 0.25;
        const levelOk = pos.y > points[i].y - 1.6 && pos.y < points[i].y + 0.6; // на ступеньку ещё не запрыгнул — рано
        if (((straight && d < 0.45) || passed || inCell) && levelOk) i += 1;
        else break;
      }
      const target = centre(points[i]);
      const last = i === points.length - 1;
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      if (last && dist <= range && Math.abs(target.y - pos.y) < 1.5) {
        releaseControls();
        arrivedTicks += 1;
        const v = bot.entity.velocity;
        return Math.hypot(v.x, v.z) < settle || arrivedTicks > 10 ? true : undefined;
      }
      // Продвижение — по оставшемуся пути: нет его STUCK_TICKS — застрял (навигация найдёт путь заново).
      const left = dist + (points.length - 1 - i);
      if (left < best - 0.05) {
        best = left;
        bestTick = tick;
      } else if (tick - bestTick > STUCK_TICKS) {
        throw stuckAt(new ActionError(`не могу пройти к ${fmt(target)}: застрял`, 'stuck'), target);
      }
      if (tick > limitTicks) throw stuckAt(new ActionError(`не успел дойти до ${fmt(target)}`, 'timeout'), target);
      if (calmTicks > 0) {
        calmTicks -= 1;
        releaseControls();
        climbing = false;
        bestTick = tick; // пауза после отката — не «застрял»
        return undefined;
      }

      const yaw = Math.atan2(-dx, -dz);
      if (dist > 0.05 && (lastLookYaw === null || Math.abs(angleDiff(yaw, lastLookYaw)) > 0.02)) {
        bot.look(yaw, walkPitch, true);
        lastLookYaw = yaw;
      }
      const facing = dist > 0.05 ? Math.abs(angleDiff(yaw, bot.serverView.yaw)) : 0;
      const forward = facing < 0.7; // сильно сбоку — сначала развернуться
      // Ступенька в блок — как игрок: дойти вплотную (упереться), прыгнуть прямо вверх и, только когда ноги выше её
      // края, шагнуть на неё. Прыжок с разбега цепляет край в воздухе, а посадка на край — такое античит откатывает.
      // Под потолком не прыгаем: место над головой — во всех столбцах под коробкой бота (0,6 блока).
      let jump = swimming() && target.y >= pos.y - 0.2;
      if (jumpTicks > 0) jumpTicks -= 1;
      const higher = target.y > pos.y + 0.6;
      const y2 = Math.floor(pos.y + 0.01) + 2;
      const headroom = [pos.x - 0.3, pos.x + 0.2999].every((hx) => [pos.z - 0.3, pos.z + 0.2999]
        .every((hz) => !solidAt(new Vec3(Math.floor(hx), y2, Math.floor(hz)))));
      if (climbing && bot.entity.onGround && jumpTicks <= 8) climbing = false; // встал (на ступеньку или обратно)
      let startJump = false;
      if (!jump && higher && forward && headroom && bot.entity.onGround && jumpTicks === 0 && bot.entity.isCollidedHorizontally) {
        jump = true;
        startJump = true;
        climbing = true;
        jumpTicks = 10;
      }
      const rising = climbing && !bot.entity.onGround && pos.y < target.y - 0.02;
      bot.setControlState('forward', forward && !startJump && !rising && dist > (last ? range * 0.6 : 0.05));
      bot.setControlState('sprint', Boolean(sprint) && forward && !climbing && facing < 0.26 && points.length - i > 3 && (bot.food === undefined || bot.food > 6));
      bot.setControlState('jump', jump);
      return undefined;
      }, signal);
    } finally {
      bot.removeListener('forcedMove', onForced);
    }
  }

  /**
   * Дойти до точки, обходя препятствия (поиск пути — src/bot/pathfinder.js).
   * @param {Vec3}    target
   * @param {object}  [opts]
   * @param {number}  [opts.range=1]     насколько близко подойти (по горизонтали)
   * @param {number}  [opts.vertical=2]  и по высоте
   * @param {boolean} [opts.sprint=false]
   * Цель за пределами загруженного мира — путь до самой близкой точки, там — заново (чанки подгружаются). Застрял —
   * найти путь заново (не больше нескольких раз). Пути нет — ошибка с кодом no_path.
   */
  function goTo(target, { range = 1, vertical = 2, sprint = false, maxDistance } = {}) {
    const goal = new Vec3(target.x, target.y, target.z);
    return run('идти', async (signal) => {
      let stuck = 0;
      let lastLeft = Infinity;
      let noProgress = 0;
      const avoid = new Set(); // шаги, на которых застревал: путь заново — в обход них
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const pos = bot.entity.position;
        const left = Math.hypot(goal.x - pos.x, goal.z - pos.z);
        if (left <= range && Math.abs(goal.y - pos.y) <= vertical) {
          releaseControls();
          return { arrived: true, position: pos.clone() };
        }
        const res = await findPath(blockAt, pos, goal, {
          range: Math.max(0, range - 0.25), vertical, signal, avoid, fast: fastReader(bot.world, bot.registry), ...(maxDistance ? { maxDistance } : {}),
        });
        if (!res.path.length) throw new ActionError(`не нашёл пути до ${fmt(goal)}: ${res.reason}`, 'no_path');
        try {
          // Последняя клетка пути уже у цели (не дальше range) — до неё вплотную.
          await followPath(res.path, { range: 0.45, sprint }, signal);
        } catch (err) {
          if (err && (err.code === 'stuck' || err.code === 'timeout') && (stuck += 1) <= 4) {
            if (err.from && err.to) avoid.add(edgeKey(err.from, err.to)); // этот шаг не выходит — другой дорогой
            continue;
          }
          throw err;
        }
        // Шли до края видимого мира (или цель сдвинулась): дальше — снова, но если ближе к цели не становится — сдаёмся.
        const now = Math.hypot(goal.x - bot.entity.position.x, goal.z - bot.entity.position.z);
        noProgress = now > lastLeft - 0.5 ? noProgress + 1 : 0;
        lastLeft = now;
        if (noProgress >= 2) throw new ActionError(`не дошёл до ${fmt(goal)}: ${res.reason || 'ближе не подойти'}`, 'no_path');
      }
      throw new ActionError(`не дошёл до ${fmt(goal)}: слишком далеко`, 'no_path');
    });
  }

  /** Сломать блок: взгляд на видимую грань, удар, взмах рукой каждый тик, время — как у клиента. */
  function dig(position) {
    const pos = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return run('копать', async (signal) => {
      digHolding = true;
      try {
        return await digBlock(pos, signal);
      } finally {
        digHolding = false;
      }
    });
  }

  /** Куда смотреть, чтобы копать блок pos (видимая грань) — { yaw, pitch } или null. */
  function aimAt(pos) {
    const b = blockAt(pos);
    if (!b || isAir(b)) return null;
    const spot = visibleFacePoint(pos, b);
    return spot ? anglesTo(eyePosition(), spot.point) : null;
  }

  /**
   * Сломать блок внутри действия (dig, digTo). next — какой блок ломать следом: голова поворачивается к нему сразу
   * после удара, пока сервер подтверждает этот (и пока идёт пауза), — как у человека с зажатой кнопкой.
   */
  async function digBlock(pos, signal, { next = null } = {}) {
    const block = blockAtOrThrow(pos);
    if (isAir(block)) throw new ActionError(`в ${fmt(pos)} нечего ломать — там воздух`);
    if (block.hardness === null || block.hardness < 0 || block.diggable === false) throw new ActionError(`${block.name} в ${fmt(pos)} не ломается`);
    await standStill(signal, { loose: true });
    const spot = visibleFacePoint(pos, block);
    if (!spot) throw new ActionError(`блок ${block.name} в ${fmt(pos)} не виден или слишком далеко`);
    const a = anglesTo(eyePosition(), spot.point);
    bot.look(a.yaw, a.pitch, true);

    let needTicks = 1;
    let face = spot.face;
    let progress = 0;
    let started = false;
    let waited = 0;
    let reaims = 0;
    const abortDig = () => {
      if (started && progress < needTicks) bot._client.write('block_dig', { status: 1, location: pos, face: 0, sequence: 0 });
    };
    try {
      await everyTick(() => {
        if (isAir(blockAt(pos))) return true; // его уже нет (сломал кто-то другой)
        const hit = lookedAtBlock(BLOCK_REACH, pos);
        const onTarget = Boolean(hit && hit.position.equals(pos));
        if (!started) {
          // Удар — в том же тике, когда голова встала на блок и прошла пауза после прошлого (у клиента — на 6-й тик).
          if (++waited > LOOK_TIMEOUT_TICKS) throw new ActionError('не удалось повернуть голову');
          if (!bot.serverView.lookSettled || ticks() - lastDestroyTick < DESTROY_DELAY_TICKS) return undefined;
          if (!onTarget) {
            // Бот чуть сдвинулся (докатился) — навестись заново.
            const again = reaims < 3 ? aimAt(pos) : null;
            if (!again) throw new ActionError(`блок ${fmt(pos)} ушёл из-под взгляда`);
            reaims += 1;
            bot.look(again.yaw, again.pitch, true);
            return undefined;
          }
          face = hit.face;
          needTicks = Math.max(1, Math.round(bot.digTime(blockAt(pos)) / 50));
          if (!Number.isFinite(needTicks)) throw new ActionError(`${block.name} в ${fmt(pos)} этим не сломать`);
          started = true;
          bot._client.write('block_dig', { status: 0, location: pos, face, sequence: nextSequence() });
          swing(); // взмах от нажатия кнопки
          if (needTicks <= 1) {
            // Ломается сразу (трава, факел; камень со «Спешкой»): только начало, без конца — и без паузы после,
            // как у клиента (следующий блок — хоть в следующем тике).
            progress = 1;
            setLocalBlock(pos, 'air');
            return true;
          }
          // Как у клиента с зажатой кнопкой (копает блок за блоком): в тике удара прогресса ещё нет, конец — через
          // полное время. Конец на тик раньше Grim копит (FastBreak): за 20 блоков подряд набегает секунда — флаг.
          return undefined;
        }
        if (!onTarget) throw new ActionError(`блок ${fmt(pos)} ушёл из-под взгляда`);
        progress += 1;
        if (progress >= needTicks) {
          bot._client.write('block_dig', { status: 2, location: pos, face, sequence: nextSequence() });
          swing();
          lastDestroyTick = ticks();
          // Как обычный клиент: у себя блок пропадает сразу. Стоял на нём — падает тогда же, когда этого ждёт
          // античит (иначе, пока ответ сервера в пути, бот «висел» бы в воздухе — и Grim откатывал его).
          setLocalBlock(pos, 'air');
          // Следующий блок — голову к нему сразу (пауза 5 тиков и ответ сервера идут, пока она поворачивается).
          const aim = next ? aimAt(next) : null;
          if (aim) bot.look(aim.yaw, aim.pitch, true);
          return true;
        }
        swing(); // пока кнопка зажата — взмах каждый тик
        return undefined;
      }, signal);
    } catch (err) {
      abortDig();
      throw err;
    }
    if (!(await waitServerBlock(pos, isAir, signal))) throw new ActionError(`сервер не дал сломать блок в ${fmt(pos)}`, 'rejected');
    return { position: pos, face: FACE_NAMES[face], ticks: needTicks };
  }

  // ---------- столбом вверх и прокапывание ----------

  const solidAt = (p) => {
    const b = blockAt(p);
    return Boolean(b && b.shapes && b.shapes.length);
  };
  const isLiquid = (b) => Boolean(b) && (LIQUID_RE.test(b.name) || (typeof b.getProperties === 'function' && (() => {
    try {
      return b.getProperties().waterlogged === true;
    } catch (_) {
      return false;
    }
  })()));
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const countItem = (name) => (bot.inventory && bot.inventory.slots ? bot.inventory.slots : [])
    .reduce((n, it, i) => n + (i >= 9 && it && it.name === name ? it.count || 1 : 0), 0);

  // Предсказания, как у обычного клиента (BlockStatePredictionHandler): сломал или поставил — у себя сразу, а для
  // клетки помним, что там по словам сервера. Сервер прислал клетку — запоминаем его состояние. Сервер подтвердил
  // действие (block_changed_ack с номером) — всё, что предсказано до этого номера, становится тем, что сказал сервер:
  // не прислал ничего (не дал сломать — спавн, приват, «приключение») — блок возвращается как был.
  const posKeyOf = (p) => `${p.x},${p.y},${p.z}`;

  function applyLocalState(pos, stateId) {
    selfUpdate = true;
    try {
      if (typeof bot._updateBlockState === 'function') bot._updateBlockState(pos, stateId);
      else if (bot.world && typeof bot.world.setBlockStateId === 'function') bot.world.setBlockStateId(pos, stateId);
    } catch (_) {
      // не вышло — блок придёт от сервера
    } finally {
      selfUpdate = false;
    }
  }

  /** Блок у себя в мире — предсказание действия с номером seq (сервер потом подтвердит или вернёт как было). */
  function setLocalBlock(pos, name, seq = sequence) {
    const info = bot.registry.blocksByName[name];
    if (!info) return;
    const key = posKeyOf(pos);
    const before = blockAt(pos);
    const known = predictions.get(key);
    predictions.set(key, { pos: pos.clone(), state: known ? known.state : before ? before.stateId : 0, sequence: seq });
    applyLocalState(pos, info.defaultState);
  }

  // Сервер прислал клетку, где ждём подтверждения, — это и есть её состояние.
  bot.on('blockUpdate', (oldBlock, newBlock) => {
    if (selfUpdate || !predictions.size) return;
    const p = (newBlock && newBlock.position) || (oldBlock && oldBlock.position);
    const known = p && predictions.get(posKeyOf(p));
    if (known) known.state = newBlock ? newBlock.stateId : 0;
  });
  if (bot._client && typeof bot._client.on === 'function') {
    bot._client.on('acknowledge_player_digging', (packet) => {
      const seq = packet && Number(packet.sequenceId !== undefined ? packet.sequenceId : packet.sequence);
      if (!Number.isFinite(seq)) return;
      ackedSequence = Math.max(ackedSequence, seq);
      for (const [key, p] of predictions) {
        if (p.sequence > seq) continue;
        predictions.delete(key);
        const now = blockAt(p.pos);
        if (now && now.stateId !== p.state) applyLocalState(p.pos, p.state); // сервер не согласился — как было
      }
    });
  }

  /** Слушать ответы сервера о клетке pos (изменения мира не от своего предсказания). → { answered, stop() } */
  function watchServerBlock(pos) {
    const w = { answered: false };
    const onUpdate = (oldBlock, newBlock) => {
      const p = (newBlock && newBlock.position) || (oldBlock && oldBlock.position);
      if (!selfUpdate && p && p.x === pos.x && p.y === pos.y && p.z === pos.z) w.answered = true;
    };
    bot.on('blockUpdate', onUpdate);
    w.stop = () => bot.removeListener('blockUpdate', onUpdate);
    return w;
  }

  /**
   * После предсказания действия seq (блок у себя уже убран или поставлен) — дождаться ответа сервера: клетка
   * пришла или действие подтверждено (обычно — через пинг). Потом проверить, что в клетке то, что ждали:
   * отказал — там снова как было.
   */
  async function waitServerBlock(pos, check, signal, seq = sequence) {
    const w = watchServerBlock(pos);
    try {
      for (let i = 0; i < CONFIRM_TICKS && !w.answered && ackedSequence < seq; i += 1) await inTick(() => {}, signal);
      // Подтверждение пришло — предсказание уже сменилось на слово сервера; ещё тик, чтобы и физика это увидела.
      if (ackedSequence >= seq) await inTick(() => {}, signal);
    } finally {
      w.stop();
    }
    return check(blockAt(pos));
  }

  /** Почему блок сейчас ломать нельзя (вода, лава рядом — потечёт; не ломается) или null — можно. */
  function breakProblem(pos) {
    const b = blockAt(pos);
    if (!b) return 'мир не загружен';
    if (isLiquid(b)) return /lava/.test(b.name) ? 'там лава' : 'там вода';
    if (UNBREAKABLE_RE.test(b.name) || b.hardness === null || b.hardness < 0 || b.diggable === false) return `${b.name} не ломается`;
    for (const d of FACE_VECTORS) if (isLiquid(blockAt(pos.plus(d)))) return 'рядом вода или лава';
    return null;
  }

  /** Дождаться, пока бот встанет (или всплывёт) на высоте y. */
  async function waitLanded(y, signal) {
    for (let t = 0; t < 40; t += 1) {
      const p = bot.entity.position;
      if ((bot.entity.onGround || bot.entity.isInWater) && Math.abs(p.y - y) < 0.6) return;
      await inTick(() => {}, signal);
    }
  }

  /**
   * Подняться на блок «столбом» (внутри действия): взгляд вниз, прыжок, в верхней точке — блок под себя по верхней
   * грани опоры, как у человека. Блок сразу ставим и у себя, как обычный клиент: иначе, пока ответ сервера в пути,
   * бот упал бы обратно в клетку, где у сервера уже блок, — и античит откатил бы его.
   */
  async function pillarStep(item, signal) {
    await standStill(signal);
    const p0 = bot.entity.position;
    const feet = new Vec3(Math.floor(p0.x), Math.floor(p0.y + 0.25), Math.floor(p0.z));
    const floorPos = feet.offset(0, -1, 0);
    if (!solidAt(floorPos)) throw new ActionError('под ногами пусто — не на что поставить блок');
    if (!isAir(blockAtOrThrow(feet))) throw new ActionError(`клетка ${fmt(feet)} занята — блок не поставить`);
    if (solidAt(feet.offset(0, 2, 0))) throw new ActionError('над головой блок — подняться некуда');
    if (item) await equipItem(item, signal);
    const held = bot.heldItem;
    if (!held || !bot.registry.blocksByName[held.name]) throw new ActionError(held ? `в руке не блок: ${held.name}` : 'нет блоков, чтобы подняться');
    // В узкой шахте прыгать — из середины клетки (иначе коробка бота задевает потолок соседней).
    const p = bot.entity.position;
    if (Math.abs(p.x - (feet.x + 0.5)) > 0.15 || Math.abs(p.z - (feet.z + 0.5)) > 0.15) {
      await followPath([feet], { range: 0.1 }, signal);
      await standStill(signal);
    }
    await settleLook(bot.serverView.yaw, -Math.PI / 2, signal); // прямо вниз — как человек «столбом»
    while (ticks() - lastUseTick < USE_DELAY_TICKS) await inTick(() => {}, signal);
    let tick = 0;
    let placedAt = -1;
    let placeSeq = Infinity; // номер установки — ждём его подтверждения
    const server = watchServerBlock(feet); // ответ сервера о клетке (своё предсказание не в счёт)
    try {
      await everyTick(() => {
        tick += 1;
        if (tick === 1) {
          bot.setControlState('jump', true);
          return undefined;
        }
        if (tick === 2) bot.setControlState('jump', false); // прыжок пошёл — клавишу отпустить
        if (placedAt < 0) {
          // И сервер, и мы знаем: ноги уже выше клетки — блок не заденет бота.
          if (bot.serverView.position.y >= feet.y + 1 && bot.entity.position.y >= feet.y + 1) {
            const hit = lookedAtBlock(BLOCK_REACH, floorPos);
            if (!hit || !hit.position.equals(floorPos) || hit.face !== 1) throw new ActionError('не видно опоры под ногами');
            const cursor = hit.point.minus(floorPos);
            bot._client.write('block_place', {
              hand: 0,
              location: floorPos,
              direction: 1,
              cursorX: clamp01(cursor.x),
              cursorY: 1,
              cursorZ: clamp01(cursor.z),
              insideBlock: false,
              worldBorderHit: false,
              sequence: nextSequence(),
            });
            swing();
            lastUseTick = ticks();
            setLocalBlock(feet, held.name);
            placedAt = tick;
            placeSeq = sequence;
          } else if (tick > 12 || (tick > 3 && bot.entity.onGround)) {
            throw new ActionError('не допрыгнул: мешает потолок');
          }
          return undefined;
        }
        // Встал на новый блок — и сервер ответил: прислал клетку или подтвердил установку (или прошла секунда).
        // Не дал поставить — блок уже снова воздух (проверка после цикла).
        const onTop = bot.entity.onGround && bot.entity.position.y >= feet.y + 0.99;
        if (onTop && (server.answered || ackedSequence >= placeSeq || tick - placedAt > CONFIRM_TICKS)) return true;
        if (bot.entity.onGround && bot.entity.position.y < feet.y + 0.5) throw new ActionError(`сервер не дал поставить блок в ${fmt(feet)}`, 'rejected');
        if (tick - placedAt > 60) throw new ActionError('не встал на поставленный блок');
        return undefined;
      }, signal);
    } finally {
      server.stop();
    }
    if (!solidAt(feet)) throw new ActionError(`сервер не дал поставить блок в ${fmt(feet)}`, 'rejected');
    return { position: feet, block: held.name };
  }

  /**
   * Подняться «столбом»: прыжок и блок под себя, count раз.
   * @param {object} [opts]
   * @param {string} [opts.item]   какой блок ставить (по умолчанию — что в руке)
   * @param {number} [opts.count=1]
   */
  function pillarUp({ item, count = 1 } = {}) {
    return run('столбом вверх', async (signal) => {
      for (let i = 0; i < count; i += 1) await pillarStep(item, signal);
      return { placed: count, position: bot.entity.position.clone() };
    });
  }

  /**
   * Пройти путь с копанием (findPath с dig/place): сломать блоки шага, шагнуть, спрыгнуть, подняться столбом.
   * false — мир не такой, как думали (открылась вода, обвалился гравий, под ногами пусто): искать путь заново.
   */
  async function walkDigPath(path, { tool, item, onDig }, signal) {
    const plain = (s) => !s.dig && !s.place && s.move !== 'drop';
    // Клетки шага свободны: в ногах — пусто или низкое (плита, ковёр), в голове — пусто.
    const lowOrEmpty = (b) => !b || !b.shapes || !b.shapes.length || Math.max(...b.shapes.map((x) => x[4])) <= 0.6;
    const free = (s) => lowOrEmpty(blockAt(s)) && !solidAt(s.offset(0, 1, 0));
    let i = 0;
    while (i < path.length) {
      if (plain(path[i])) {
        // Без копания — подряд, не останавливаясь; но только по клеткам, которые и правда свободны.
        let j = i;
        while (j < path.length && plain(path[j]) && free(path[j])) j += 1;
        if (j === i) return false;
        await followPath(path.slice(i, j), { range: 0.3 }, signal);
        i = j;
        continue;
      }
      const step = path[i];
      const cells = step.dig || [];
      for (let ci = 0; ci < cells.length; ci += 1) {
        const c = cells[ci];
        if (!solidAt(c)) {
          if (isLiquid(blockAt(c))) return false;
          continue; // уже пусто
        }
        if (breakProblem(c)) return false;
        // Следом — следующий блок этого шага: голова повернётся к нему сразу после удара.
        const next = cells.slice(ci + 1).find((n) => solidAt(n)) || null;
        for (let k = 0; k < 4 && solidAt(c); k += 1) {
          if (tool) await equipItem(tool, signal);
          const was = blockAt(c);
          await digBlock(c, signal, { next });
          if (onDig) onDig(was, c);
          if (solidAt(c) && breakProblem(c)) return false; // сверху упало что-то, что ломать нельзя
        }
        if (solidAt(c)) return false;
      }
      // Куда встанем — там опора (а не открывшаяся пещера).
      if (step.move !== 'pillar' && !solidAt(step.offset(0, -1, 0)) && !isLiquid(blockAt(step))) return false;
      const from = bot.entity.position.floored();
      try {
        if (step.move === 'pillar') {
          await pillarStep(item, signal);
        } else if (step.move === 'drop') {
          await waitLanded(step.y, signal);
        } else {
          // Шаг в прокопанную клетку — не дожидаясь полной остановки: дальше снова копать (как человек в туннеле).
          await followPath([step], { range: step.move === 'down' ? 0.15 : 0.25, settle: cells.length ? 0.03 : 0.003 }, signal);
          await waitLanded(step.y, signal);
        }
      } catch (err) {
        // Шаг не вышел (застрял, не допрыгнул) — digTo найдёт путь в обход именно этого шага.
        if (err && err.code !== 'aborted' && err.code !== 'stopped' && err.code !== 'replaced' && !err.to) Object.assign(err, { from, to: new Vec3(step.x, step.y, step.z) });
        throw err;
      }
      const p = bot.entity.position;
      if (Math.floor(p.x) !== step.x || Math.floor(p.z) !== step.z || Math.abs(p.y - step.y) > 0.6) return false;
      i += 1;
    }
    return true;
  }

  /**
   * Дойти, прокапываясь сквозь блоки (и поднимаясь «столбом», если есть блоки item): к точке target (с точностью
   * range по горизонтали и vertical по высоте) или — reach — туда, откуда можно сломать блок target.
   * @param {Vec3}     target
   * @param {object}   [opts]
   * @param {boolean}  [opts.reach=false]
   * @param {string}   [opts.tool]      чем копать (кирка) — берётся в руку перед каждым блоком
   * @param {string}   [opts.item]      чем строить столб (булыжник…)
   * @param {Function} [opts.onDig]     (блок до слома, позиция) — после каждого сломанного
   * Мир оказался не таким (вода, гравий, пещера) — путь заново; пути нет — ошибка с кодом no_path.
   */
  function digTo(target, { reach = false, range = 0.5, vertical = 0, tool = null, item = null, onDig = null, maxDistance = 48, maxNodes = 8000 } = {}) {
    const goal = reach ? new Vec3(Math.floor(target.x), Math.floor(target.y), Math.floor(target.z)) : new Vec3(target.x, target.y, target.z);
    return run('копать путь', async (signal) => {
      digHolding = true;
      try {
        return await digToInner(goal, { reach, range, vertical, tool, item, onDig, maxDistance, maxNodes }, signal);
      } finally {
        digHolding = false;
      }
    });
  }

  /**
   * Цена сломать блок для поиска пути (в шагах ходьбы, шаг — ~4,6 тика) — по настоящему времени этой киркой: с
   * «Эффективностью V» камень — 2 тика, а не «как 3 шага». Копание в поиске ещё и дешевле настоящего (TANK) — бот
   * прокапывается прямо к цели, «как танк», а не обходит по пещерам. Обсидиан и твёрже — не копаем.
   */
  function digCostWith(toolName) {
    const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : [];
    const toolItem = toolName ? slots.find((it) => it && it.name === toolName) || bot.heldItem : bot.heldItem;
    const timeOf = typeof bot.digTimeWith === 'function'
      ? (b) => bot.digTimeWith(b, toolItem, { onGround: true, inWater: false })
      : (b) => bot.digTime(b);
    return (block) => {
      if (typeof block.hardness !== 'number' || block.hardness < 0 || block.hardness > MAX_HARDNESS) return null;
      const t = timeOf(block) / 50;
      if (!Number.isFinite(t)) return null;
      const perBlock = t > 1 ? t + DESTROY_DELAY_TICKS : 1; // мгновенно ломается — без паузы после
      return 0.1 + (perBlock / WALK_TICKS_PER_BLOCK) * TANK;
    };
  }

  async function digToInner(goal, { reach, range, vertical, tool, item, onDig, maxDistance, maxNodes }, signal) {
    {
      let replans = 0;
      let lastLeft = Infinity;
      let noProgress = 0;
      const avoid = new Set(); // шаги, которые не вышли (застрял, не допрыгнул): путь заново — в обход них
      for (;;) {
        const search = (weight, nodes) => findPath(blockAt, bot.entity.position, goal, {
          dig: digCostWith(tool), place: Boolean(item) && countItem(item) > 0, reach, range, vertical, maxDistance, maxNodes: nodes, weight, signal,
          avoid, fast: fastReader(bot.world, bot.registry),
        });
        // К руде — сразу жадный поиск (вес 4): путь почти лучший и находится за миллисекунды. К точке (обратно на
        // свою высоту) — сначала точный (столбом там, где столбом дешевле), не хватило клеток — жадный.
        let res;
        if (reach) {
          res = await search(4, maxNodes);
        } else {
          res = await search(1.5, Math.min(FIRST_SEARCH_NODES, maxNodes));
          if (!res.complete && res.nodes >= Math.min(FIRST_SEARCH_NODES, maxNodes)) res = await search(4, maxNodes);
        }
        if (res.complete && !res.path.length) return { arrived: true, position: bot.entity.position.clone() };
        if (!res.path.length) throw new ActionError(`не прокопаться к ${fmt(goal)}: ${res.reason}`, 'no_path');
        let ok;
        try {
          ok = await walkDigPath(res.path, { tool, item, onDig }, signal);
        } catch (err) {
          // Шаг не вышел — тот же шаг больше не предлагать (бот выберет другой: обход, столб, ступеньку).
          const retry = err && err.from && err.to && ['stuck', 'timeout', 'failed'].includes(err.code) && (replans += 1) <= 8;
          if (!retry) throw err;
          avoid.add(edgeKey(err.from, err.to));
          continue;
        }
        if (ok && res.complete) return { arrived: true, position: bot.entity.position.clone() };
        if (!ok && (replans += 1) > 8) throw new ActionError(`не прокопаться к ${fmt(goal)}: мир всё время не такой, как видно`, 'no_path');
        if (ok) {
          // Путь был только до края известного — дальше заново; ближе не становится — сдаёмся.
          const p = bot.entity.position;
          const left = Math.hypot(goal.x - p.x, goal.z - p.z) + Math.abs(goal.y - p.y);
          noProgress = left > lastLeft - 0.5 ? noProgress + 1 : 0;
          lastLeft = left;
          if (noProgress >= 2) throw new ActionError(`не прокопаться к ${fmt(goal)}: ${res.reason || 'ближе не подойти'}`, 'no_path');
        }
      }
    }
  }

  /** Нажать правой кнопкой по грани: { position, face, point } — куда навести взгляд. Общая часть place и activate. */
  async function useOn(target, signal, { expectTarget }) {
    await standStill(signal);
    const a = anglesTo(eyePosition(), target.point);
    await settleLook(a.yaw, a.pitch, signal);
    while (ticks() - lastUseTick < USE_DELAY_TICKS) await inTick(() => {}, signal);
    return inTick(() => {
      const hit = lookedAtBlock(BLOCK_REACH, target.position);
      if (!hit || !hit.position.equals(target.position) || (expectTarget && hit.face !== target.face)) {
        throw new ActionError(`грань блока ${fmt(target.position)} не под взглядом`);
      }
      const cursor = hit.point.minus(target.position);
      bot._client.write('block_place', {
        hand: 0,
        location: target.position,
        direction: hit.face,
        cursorX: Math.min(1, Math.max(0, cursor.x)),
        cursorY: Math.min(1, Math.max(0, cursor.y)),
        cursorZ: Math.min(1, Math.max(0, cursor.z)),
        insideBlock: false,
        worldBorderHit: false,
        sequence: nextSequence(),
      });
      swing();
      lastUseTick = ticks();
      return hit;
    }, signal);
  }

  /**
   * Поставить блок в пустую клетку: нажатие по грани соседнего блока, которую видно с места бота.
   * @param {Vec3}   position          куда поставить
   * @param {object} [opts]
   * @param {string} [opts.item]       что взять в руку (имя предмета, например cobblestone)
   */
  function place(position, { item } = {}) {
    const pos = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return run('поставить', async (signal) => {
      const there = blockAtOrThrow(pos);
      if (!isAir(there) && there.boundingBox === 'block') throw new ActionError(`клетка ${fmt(pos)} занята: ${there.name}`);
      const p = bot.entity.position;
      // Коробка бота — как её считает сервер (0,6F × 1,8F): вплотную к грани она уже чуть заходит в клетку.
      const hw = Math.fround(0.6) / 2;
      const h = Math.fround(1.8);
      if (p.x + hw > pos.x && p.x - hw < pos.x + 1 && p.z + hw > pos.z && p.z - hw < pos.z + 1 && p.y + h > pos.y && p.y < pos.y + 1) {
        throw new ActionError('нельзя поставить блок туда, где стоит бот');
      }
      if (item) await equipItem(item, signal);
      const held = bot.heldItem;
      if (!held || !bot.registry.blocksByName[held.name]) throw new ActionError(held ? `в руке не блок: ${held.name}` : 'в руке ничего нет');

      // Соседний твёрдый блок, грань которого смотрит в нужную клетку и видна с места бота.
      const eye = eyePosition();
      const options = [];
      for (const n of FACE_VECTORS) {
        const refPos = pos.minus(n); // сосед с той стороны, куда смотрит n
        const ref = blockAt(refPos);
        if (!ref || !ref.shapes || !ref.shapes.length || ref.boundingBox !== 'block') continue;
        const face = faceOf(n); // грань соседа, обращённая к нужной клетке
        const lerp = () => 0.3 + 0.4 * random();
        const point = refPos.offset(0.5 + n.x * 0.5, 0.5 + n.y * 0.5, 0.5 + n.z * 0.5);
        if (n.x === 0) point.x = refPos.x + lerp();
        if (n.y === 0) point.y = refPos.y + lerp();
        if (n.z === 0) point.z = refPos.z + lerp();
        if (eye.minus(point).dot(n) <= 1e-6) continue; // грань с места бота не видно
        const dist = eye.distanceTo(point);
        if (dist > BLOCK_REACH) continue;
        const hit = raycastBlocks(blockAt, eye, point.minus(eye).normalize(), dist + 0.05, shapesFor(null));
        if (!hit || !hit.position.equals(refPos) || hit.face !== face) continue;
        options.push({ position: refPos, face, point, dist });
      }
      if (!options.length) throw new ActionError(`некуда опереть блок в ${fmt(pos)}: нет видимой грани рядом`);
      options.sort((a, b) => a.dist - b.dist);
      await useOn(options[0], signal, { expectTarget: true });
      if (!(await waitBlockChange(pos, (b) => b && !isAir(b), signal))) throw new ActionError(`сервер не дал поставить блок в ${fmt(pos)}`, 'rejected');
      return { position: pos, against: options[0].position, face: FACE_NAMES[options[0].face] };
    });
  }

  /** Нажать на блок правой кнопкой (сундук, дверь, кнопка, рычаг). */
  function activate(position) {
    const pos = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return run('нажать', async (signal) => {
      const block = blockAtOrThrow(pos);
      if (isAir(block)) throw new ActionError(`в ${fmt(pos)} ничего нет`);
      const spot = visibleFacePoint(pos, block);
      if (!spot) throw new ActionError(`блок ${block.name} в ${fmt(pos)} не виден или слишком далеко`);
      const hit = await useOn({ position: pos, face: spot.face, point: spot.point }, signal, { expectTarget: false });
      return { position: pos, block: block.name, face: FACE_NAMES[hit.face] };
    });
  }

  /**
   * Посадить в клетку position (воздух над грядкой): семена или клубни (wheat_seeds, carrot…) в руку и нажать
   * по верхней грани блока под клеткой — как человек. Ждёт, пока сервер покажет росток.
   * @param {Vec3}   position
   * @param {object} opts
   * @param {string} opts.item  что сажать (имя предмета)
   */
  function plant(position, { item } = {}) {
    const pos = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return run('посадить', async (signal) => {
      const cell = blockAtOrThrow(pos);
      if (!isAir(cell)) throw new ActionError(`клетка ${fmt(pos)} занята: ${cell.name}`);
      const soilPos = pos.offset(0, -1, 0);
      const soil = blockAtOrThrow(soilPos);
      if (isAir(soil)) throw new ActionError(`под ${fmt(pos)} нет грядки`);
      if (item) await equipItem(item, signal);
      if (!bot.heldItem) throw new ActionError('в руке ничего нет');
      const top = soil.shapes && soil.shapes.length ? Math.max(...soil.shapes.map((s) => s[4])) : 1;
      const point = soilPos.offset(0.3 + 0.4 * random(), top, 0.3 + 0.4 * random());
      const eye = eyePosition();
      if (eye.distanceTo(point) > BLOCK_REACH) throw new ActionError(`грядка ${fmt(soilPos)} слишком далеко`);
      await useOn({ position: soilPos, face: 1, point }, signal, { expectTarget: true });
      if (!(await waitBlockChange(pos, (b) => b && !isAir(b), signal))) throw new ActionError(`сервер не дал посадить в ${fmt(pos)}`, 'rejected');
      return { position: pos, item: bot.heldItem ? bot.heldItem.name : item };
    });
  }

  // Коробка и точка прицела — там, где сущность видна в игре (seenPosition), а не по самой свежей позиции с сервера.
  const entityBox = (entity) => {
    const w = (entity.width || 0.6) / 2;
    const p = seenPosition(entity);
    return [p.x - w, p.y, p.z - w, p.x + w, p.y + (entity.height || 1.8), p.z + w];
  };
  const aimPoint = (entity) => seenPosition(entity).offset(0, (entity.height || 1.8) * 0.7, 0);

  /** Блок на пути взгляда до сущности (на расстоянии t по лучу dir) — стена между ботом и целью. */
  function wallBefore(eye, dir, t) {
    return raycastBlocks(blockAt, eye, dir, Math.max(0, t - 1e-3), shapesFor(null));
  }

  /**
   * Достанет ли бот до сущности ударом, не сходя с места: она в досягаемости и между глазами и ею нет блока
   * (ударить сквозь стену обычный клиент не может — античит это видит).
   */
  function canHit(entity) {
    if (!entity || !entity.position || !bot.entity) return false;
    const eye = eyePosition();
    const box = entityBox(entity);
    if (eye.distanceTo(closestPointOnBox(box, eye)) > ENTITY_REACH) return false;
    const to = aimPoint(entity).minus(eye);
    const len = to.norm();
    if (len < 1e-6) return true;
    const dir = to.scaled(1 / len);
    const t = rayBox(eye, dir, box);
    return !wallBefore(eye, dir, t === null ? len : t);
  }

  /**
   * Ударить сущность: взгляд на неё, удар и взмах; между ударами — пауза восстановления. Как человек мышью: бьёт,
   * когда прицел на цели, даже если голова ещё ведёт её (моб ходит — голова не «встаёт» никогда). Прицел на цели —
   * и по взгляду, что сервер уже знает (прошлый пакет), и по взгляду этого тика.
   */
  function attack(entity, { cooldownTicks = ATTACK_COOLDOWN_TICKS } = {}) {
    return run('ударить', async (signal) => {
      if (!entity || !entity.position) throw new ActionError('не на кого нападать');
      const boxOf = () => entityBox(entity);
      await standStill(signal);
      const onTarget = (from, dir) => {
        const t = rayBox(from, dir, boxOf());
        if (t === null || t > ENTITY_REACH) return false;
        return wallBefore(from, dir, t) ? 'wall' : true; // взгляд упирается в блок раньше цели
      };
      for (let i = 0; i < LOOK_TIMEOUT_TICKS; i += 1) {
        if (!bot.entities || !bot.entities[entity.id]) throw new ActionError('цель пропала');
        const eye = eyePosition();
        const box = boxOf();
        if (eye.distanceTo(closestPointOnBox(box, eye)) > ENTITY_REACH) throw new ActionError('цель слишком далеко');
        const a = anglesTo(eye, aimPoint(entity));
        bot.look(a.yaw, a.pitch, true);
        const ready = ticks() - lastAttackTick >= cooldownTicks;
        if (ready) {
          const done = await inTick(() => {
            const from = eyePosition();
            const now = onTarget(from, currentLook());
            const sent = onTarget(from, lookVector(bot.serverView.sentYaw, bot.serverView.sentPitch));
            if (now === 'wall' && sent === 'wall') return 'wall';
            if (now !== true || sent !== true) return false; // прицел ещё не на цели — следующий тик
            bot._client.write('use_entity', { target: entity.id, mouse: 1, sneaking: Boolean(bot.getControlState('sneak')) });
            swing();
            lastAttackTick = ticks();
            return true;
          }, signal);
          if (done === 'wall') throw new ActionError('цель за блоком — сквозь стену не бью', 'blocked');
          if (done) return { target: entity.username || entity.name || entity.id };
        } else {
          await inTick(() => {}, signal);
        }
      }
      throw new ActionError('не удалось навести взгляд на цель');
    });
  }

  // ---------- правая кнопка с предметом: есть, щит ----------

  // Блоки, на которых правая кнопка что-то делает (открыть, нажать, посадить): есть и поднимать щит, глядя на них, нельзя.
  const INTERACTIVE_RE = /(?:chest|barrel|shulker_box|furnace|smoker|crafting_table|crafter|_door$|trapdoor|fence_gate|button|lever|_bed$|anvil|enchanting_table|brewing_stand|hopper|dispenser|dropper|note_block|repeater|comparator|cake|bell|beacon|lectern|loom|grindstone|stonecutter|smithing_table|cartography_table|fletching_table|composter|cauldron|respawn_anchor|_sign$|campfire|jukebox|flower_pot|daylight_detector|farmland|decorated_pot|chiseled_bookshelf|vault|trial_spawner|command_block|structure_block|jigsaw|redstone_ore|dragon_egg|end_portal_frame|beehive|bee_nest|copper_bulb|crafter)/;
  const PICKABLE_TYPES = new Set(['player', 'mob', 'hostile', 'animal', 'passive', 'ambient', 'water_creature', 'other']);
  const USE_RELEASE = { status: 5, location: { x: 0, y: 0, z: 0 }, face: 0, sequence: 0 }; // отпустить правую кнопку

  /** Сущность на луче взгляда ближе блока и не дальше ENTITY_REACH: { entity, t, point } или null. */
  function entityOnRay(blockHit) {
    const eye = eyePosition();
    const dir = currentLook();
    const limit = Math.min(ENTITY_REACH + 0.1, blockHit ? eye.distanceTo(blockHit.point) : Infinity);
    let best = null;
    for (const e of Object.values(bot.entities || {})) {
      if (!e || e === bot.entity || !e.position || !(PICKABLE_TYPES.has(e.type) || /boat|minecart/.test(e.name || ''))) continue;
      const t = rayBox(eye, dir, entityBox(e));
      if (t === null || t > limit || (best && t >= best.t)) continue;
      best = { entity: e, t, point: eye.plus(dir.scaled(t)) };
    }
    return best;
  }

  /** На что сейчас пришлась бы правая кнопка: { block, entity } (то, что ближе) — и можно ли жать (ничего не откроет). */
  function useTarget(allowEntity = () => false) {
    const blockHit = lookedAtBlock(BLOCK_REACH);
    const entityHit = entityOnRay(blockHit);
    if (entityHit) return { entityHit, blockHit: null, ok: allowEntity(entityHit.entity) };
    return { entityHit: null, blockHit, ok: !blockHit || !INTERACTIVE_RE.test(blockHit.block.name || '') };
  }

  /**
   * Правая кнопка, как у клиента (Minecraft.startUseItem): для каждой руки по очереди — сначала то, на что смотрит
   * взгляд (сущность — «нажать в точку» и «нажать», блок — «нажать на грань»), потом сам предмет (use_item с
   * текущим взглядом). lastHand — рука, у которой выйдет (0 — основная: еда; 1 — вторая: щит); у основной перед ней
   * ничего не выходит (меч, кирка). Внутри тика.
   */
  function pressUse(lastHand, target) {
    const sneaking = Boolean(bot.getControlState('sneak'));
    const { yaw, pitch } = bot.serverView.rotationDegrees;
    for (let hand = 0; hand <= lastHand; hand += 1) {
      const held = hand === 0 ? bot.heldItem : bot.inventory.slots[45];
      if (target.entityHit) {
        const e = target.entityHit.entity;
        const at = target.entityHit.point.minus(e.position);
        bot._client.write('use_entity', { target: e.id, mouse: 2, x: at.x, y: at.y, z: at.z, hand, sneaking });
        bot._client.write('use_entity', { target: e.id, mouse: 0, hand, sneaking });
      } else if (target.blockHit) {
        const b = target.blockHit;
        const cursor = b.point.minus(b.position);
        bot._client.write('block_place', {
          hand, location: b.position, direction: b.face, cursorX: clamp01(cursor.x), cursorY: clamp01(cursor.y), cursorZ: clamp01(cursor.z),
          insideBlock: false, worldBorderHit: false, sequence: nextSequence(),
        });
      }
      if (held) bot._client.write('use_item', { hand, sequence: nextSequence(), rotation: { x: yaw, y: pitch } });
    }
    lastUseTick = ticks();
  }

  /** Повернуть взгляд туда, где правая кнопка ничего не откроет и не посадит (под ноги, вверх, вниз). */
  async function aimForUse(signal, allowEntity) {
    if (useTarget(allowEntity).ok) return;
    for (const pitchDeg of [60, -60, 89, -89]) {
      await settleLook(bot.entity.yaw, (-pitchDeg * Math.PI) / 180, signal);
      if (useTarget(allowEntity).ok) return;
    }
    throw new ActionError('некуда навести взгляд: правая кнопка что-нибудь откроет');
  }

  /**
   * Съесть еду name: в руку, взгляд туда, где правая кнопка ничего не откроет, нажать и держать, пока не съест
   * (у обычной еды 1,6 с), стоя на месте — как человек. Съел — сервер прибавил сытость или еды в руке стало меньше.
   */
  function eat(name) {
    return run('есть', async (signal) => {
      await equipItem(name, signal);
      await standStill(signal);
      await aimForUse(signal);
      while (ticks() - lastUseTick < USE_DELAY_TICKS) await inTick(() => {}, signal);
      const before = { food: bot.food };
      // Съел — сервер сообщает «предмет использован» (событие сущности 9) и прибавляет сытость. По числу еды в руке
      // не судим: ячейка от прошлой еды может прийти позже — и бот решил бы, что уже съел (и нажал бы снова).
      let finished = false;
      const onStatus = (p) => {
        if (p && bot.entity && p.entityId === bot.entity.id && p.entityStatus === 9) finished = true;
      };
      bot._client.on('entity_status', onStatus);
      let holding = false;
      try {
        await inTick(() => {
          const target = useTarget();
          if (!target.ok) throw new ActionError('взгляд ушёл туда, где правая кнопка что-нибудь откроет');
          pressUse(0, target);
          holding = true;
        }, signal);
        for (let t = 0; t < EAT_MAX_TICKS; t += 1) {
          await inTick(() => {}, signal);
          if (finished || (typeof bot.food === 'number' && typeof before.food === 'number' && bot.food > before.food)) {
            holding = false; // съел — клиент сам перестаёт есть, отпускать нечего
            return { ate: name, food: bot.food };
          }
        }
        throw new ActionError(`не получилось съесть ${name}: сервер не засчитал`);
      } finally {
        bot._client.removeListener('entity_status', onStatus);
        if (holding) bot._client.write('block_dig', USE_RELEASE);
      }
    });
  }

  /** Положить предмет во вторую руку (щит): переносом в инвентаре, стоя на месте, с паузами, как человек. */
  function equipOffhand(name) {
    return equipTo(name, 'off-hand');
  }

  // Ячейки инвентаря игрока, куда надевается: броня 5–8, вторая рука 45 (как у mineflayer: head, torso, legs, feet).
  const WEAR_SLOTS = { head: 5, torso: 6, legs: 7, feet: 8, 'off-hand': 45 };
  const WEAR_NAMES = { head: 'на голову', torso: 'на тело', legs: 'на ноги', feet: 'на ноги (ботинки)', 'off-hand': 'во вторую руку' };

  /**
   * Надеть предмет (броню — head / torso / legs / feet) или положить во вторую руку ('off-hand'): переносом в инвентаре,
   * стоя на месте, с паузами, как человек. Уже там — ничего. item — имя или сам предмет (из нескольких одинаковых).
   */
  function equipTo(item, dest) {
    return run(WEAR_NAMES[dest] || 'надеть', async (signal) => {
      const at = WEAR_SLOTS[dest];
      if (at === undefined) throw new ActionError(`некуда надеть: ${dest}`);
      const slots = bot.inventory ? bot.inventory.slots : [];
      const name = typeof item === 'string' ? item : item && item.name;
      if (slots[at] && (slots[at] === item || (typeof item === 'string' && slots[at].name === name))) return { already: true };
      const it = typeof item === 'string' ? slots.find((x, i) => x && x.name === name && i !== at) : slots.includes(item) ? item : null;
      if (!it) throw new ActionError(`нет предмета ${name}`);
      await standStill(signal);
      await waitTicks(3 + Math.floor(random() * 4), signal);
      await bot.equip(it, dest);
      await waitTicks(2 + Math.floor(random() * 3), signal);
      return { already: false };
    });
  }

  /**
   * Закрыться щитом (во второй руке) от сущности target: лицом к ней, правая кнопка — и держать, пока until() или
   * её нет (взорвалась, убежала), но не дольше maxTicks. Щит закрывает от удара и взрыва спереди.
   */
  function shield(target, { maxTicks = 60, until = null } = {}) {
    return run('щит', async (signal) => {
      const off = bot.inventory && bot.inventory.slots ? bot.inventory.slots[45] : null;
      if (!off || off.name !== 'shield') throw new ActionError('во второй руке нет щита');
      // Не ждать полной остановки (крипер шипит 1,5 с): кнопки отпущены — бот докатывается по инерции, а она с
      // поднятым щитом та же (замедление щита — только для нажатых кнопок), так что античиту нечего заметить.
      releaseControls();
      const facing = () => (target && target.position ? anglesTo(eyePosition(), target.position.offset(0, (target.height || 1.7) * 0.6, 0)) : null);
      const a = facing();
      if (a) await settleLook(a.yaw, a.pitch, signal);
      const allow = (e) => e === target; // нажать на крипера (или другого врага) — ничего не будет
      while (ticks() - lastUseTick < USE_DELAY_TICKS) await inTick(() => {}, signal);
      let raised = false;
      let held = 0;
      try {
        await inTick(() => {
          const t = useTarget(allow);
          if (!t.ok) throw new ActionError('щит не поднять: правая кнопка что-нибудь откроет');
          pressUse(1, t);
          raised = true;
        }, signal);
        for (; held < maxTicks; held += 1) {
          const stop = await inTick(() => {
            if (!bot.entities || !bot.entities[target.id]) return true;
            const f = facing();
            if (f) bot.look(f.yaw, f.pitch, true); // держать лицом к нему (щит закрывает спереди)
            return Boolean(until && until());
          }, signal);
          if (stop) break;
        }
      } finally {
        if (raised) bot._client.write('block_dig', USE_RELEASE);
      }
      return { ticks: held };
    });
  }

  /** Прервать текущее действие (и очередь) с кодом code — например, «рядом враг» во время добычи. */
  function interruptActions(reason, code = 'interrupted') {
    const had = entries.size > 0;
    abortAll(new ActionError(reason, code));
    return had;
  }

  /**
   * Нажать правой кнопкой на сущность (NPC, жителя): взгляд на неё, и только когда голова остановилась — нажатие.
   * Как у клиента: сначала «нажать в точку» (точка попадания взгляда на сущности), затем «нажать».
   */
  function interact(entity) {
    return run('нажать на сущность', async (signal) => {
      if (!entity || !entity.position) throw new ActionError('не на что нажимать');
      const boxOf = () => entityBox(entity);
      await standStill(signal);
      for (let i = 0; i < LOOK_TIMEOUT_TICKS; i += 1) {
        if (bot.entities && !bot.entities[entity.id]) throw new ActionError('сущность пропала');
        const eye = eyePosition();
        if (eye.distanceTo(closestPointOnBox(boxOf(), eye)) > ENTITY_REACH) throw new ActionError('слишком далеко — подойди ближе');
        const a = anglesTo(eye, seenPosition(entity).offset(0, (entity.height || 1.8) * 0.6, 0));
        bot.look(a.yaw, a.pitch, true);
        if (bot.serverView.lookSettled && ticks() - lastUseTick >= USE_DELAY_TICKS) {
          const done = await inTick(() => {
            const from = eyePosition();
            const dir = currentLook();
            const t = rayBox(from, dir, boxOf());
            if (t === null || t > ENTITY_REACH) return false;
            const hit = from.plus(dir.scaled(t)).minus(seenPosition(entity)); // точка — от сущности, какой её видит игра
            const sneaking = Boolean(bot.getControlState('sneak'));
            bot._client.write('use_entity', { target: entity.id, mouse: 2, x: hit.x, y: hit.y, z: hit.z, hand: 0, sneaking });
            bot._client.write('use_entity', { target: entity.id, mouse: 0, hand: 0, sneaking });
            lastUseTick = ticks();
            return true;
          }, signal);
          if (done) return { target: entity.username || (entity.getCustomName && entity.getCustomName() ? String(entity.getCustomName()) : entity.name) };
        } else {
          await inTick(() => {}, signal);
        }
      }
      throw new ActionError('не удалось навести взгляд на сущность');
    });
  }

  // Когда открылось меню: первый клик — не раньше, чем человек успел бы его рассмотреть и довести мышь.
  let windowOpenedTick = -Infinity;
  let openedWindow = null; // окно, ячейки которого уже пришли
  let lastClickTick = -Infinity;
  let lastWindowPacketTick = -Infinity; // последний ответ сервера про меню, ячейки или курсор
  bot.on('windowOpen', (window) => {
    windowOpenedTick = ticks();
    openedWindow = window || null;
  });
  if (bot._client && typeof bot._client.on === 'function') {
    for (const name of WINDOW_PACKETS) {
      bot._client.on(name, () => {
        lastWindowPacketTick = ticks();
      });
    }
  }

  /**
   * Клик по ячейке открытого меню (сундук, меню NPC): стоя на месте, с паузой после открытия и между кликами,
   * как у человека. После клика ждёт ответа сервера (он поправляет ячейки и курсор), чтобы следующий клик
   * исходил из того, что на самом деле лежит в меню.
   * @param {number} slot    номер ячейки (как в #окно)
   * @param {object} [opts]  button: 0 — левая, 1 — правая; mode: 0 — обычный клик, 1 — с Shift (перенос стопки)
   */
  function clickSlot(slot, { button = 0, mode = 0 } = {}) {
    return run('клик в меню', async (signal) => {
      const window = bot.currentWindow;
      if (!window) throw new ActionError('меню не открыто');
      for (let i = 0; openedWindow !== window && i < WINDOW_READY_TICKS; i += 1) await inTick(() => {}, signal);
      if (bot.currentWindow !== window) throw new ActionError('меню закрылось');
      if (openedWindow !== window) throw new ActionError('меню не загрузилось: сервер не прислал его ячейки');
      if (!Number.isInteger(slot) || slot < 0 || slot >= window.slots.length) throw new ActionError(`в меню нет ячейки ${slot}`);
      await standStill(signal);
      const afterOpen = windowOpenedTick + FIRST_CLICK_TICKS + Math.floor(random() * (FIRST_CLICK_JITTER + 1));
      const afterClick = lastClickTick + NEXT_CLICK_TICKS + Math.floor(random() * (NEXT_CLICK_JITTER + 1));
      const notBefore = Math.max(afterOpen, afterClick);
      while (ticks() < notBefore) await inTick(() => {}, signal);
      if (bot.currentWindow !== window) throw new ActionError('меню закрылось');
      const sentTick = ticks();
      try {
        await bot.clickWindow(slot, button, mode);
      } catch (err) {
        throw new ActionError(`клик не удался: ${err && err.message ? err.message : err}`);
      }
      lastClickTick = ticks();
      // Ответ сервера (если прогноз клика совпал с сервером, он молчит — тогда просто пауза).
      while (ticks() - sentTick < CLICK_REPLY_TICKS && lastWindowPacketTick < sentTick) await inTick(() => {}, signal);
      await waitTicks(2, signal);
      return { slot };
    }, { keepWindow: true });
  }

  /** Закрыть открытое меню (как Esc). */
  function closeMenu() {
    return run('закрыть меню', async (signal) => {
      const had = Boolean(bot.currentWindow);
      await closeWindowIfOpen(signal);
      return { closed: had };
    }, { keepWindow: true });
  }

  /** Взять предмет в руку: из быстрой панели — сменой ячейки, из инвентаря — переносом, стоя на месте. */
  async function equipItem(name, signal) {
    const wanted = String(name).replace(/^minecraft:/, '');
    const slots = bot.inventory ? bot.inventory.slots : [];
    if (bot.heldItem && bot.heldItem.name === wanted) return;
    for (let i = 0; i < 9; i += 1) {
      const it = slots[36 + i];
      if (it && it.name === wanted) {
        await inTick(() => bot.setQuickBarSlot(i), signal); // как нажатие цифры на клавиатуре
        await waitTicks(2, signal);
        return;
      }
    }
    const item = slots.find((it) => it && it.name === wanted);
    if (!item) throw new ActionError(`нет предмета ${wanted}`);
    // Перенос из инвентаря — щелчками в инвентаре: стоя на месте, с паузами, как человек.
    await standStill(signal);
    await waitTicks(3 + Math.floor(random() * 4), signal);
    await bot.equip(item, 'hand');
    await waitTicks(2 + Math.floor(random() * 3), signal);
  }

  function equip(name) {
    return run('взять в руку', (signal) => equipItem(name, signal));
  }

  /** Подождать (миллисекунды); прерывается, как любое действие. Открытое окно не трогает. */
  function wait(ms) {
    return run('ждать', (signal) => waitTicks(Math.max(1, Math.round(ms / 50)), signal), { keepWindow: true });
  }

  // Чат — своя очередь, не мешает действиям: сообщения не чаще раза в 1,5–2 секунды.
  let chatChain = Promise.resolve();
  let nextChatAt = 0;
  function chat(text) {
    const job = chatChain.then(async () => {
      const delay = nextChatAt - now();
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      bot.chat(text);
      nextChatAt = now() + CHAT_INTERVAL_MS + random() * 500;
    });
    chatChain = job.catch(() => {});
    return job;
  }

  /** Остановить всё: текущее действие и очередь; клавиши отпускаются. */
  function stop() {
    const had = entries.size > 0;
    abortAll(new ActionError('остановлено', 'stopped'));
    releaseControls();
    return had;
  }

  bot.actions = {
    look,
    lookAt,
    walkTo,
    goTo,
    digTo,
    pillarUp,
    dig,
    place,
    plant,
    activate,
    attack,
    canHit,
    eat,
    equipOffhand,
    equipTo,
    shield,
    interrupt: interruptActions,
    interact,
    clickSlot,
    closeMenu,
    equip,
    wait,
    chat,
    stop,
    /** Часы действий (мс): настоящие, в тестах — подменённые; по ним же считают паузы те, кто зовёт действия. */
    now,
    lookedAtBlock: () => (bot.serverView ? lookedAtBlock() : null),
    get busy() {
      return entries.size > 0;
    },
    get current() {
      return current ? current.name : null;
    },
  };
}

module.exports = { createActionsPlugin, ActionError, raycastBlocks, lookVector, anglesTo, rayBox, FACE_NAMES, FACE_VECTORS, BLOCK_REACH };
