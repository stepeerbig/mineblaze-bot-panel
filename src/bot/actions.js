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

const BLOCK_REACH = 4.4; // у игрока 4,5 блока — оставляем запас
const ENTITY_REACH = 2.9; // у игрока 3 блока
const USE_DELAY_TICKS = 4; // пауза между нажатиями правой кнопки у клиента
const DESTROY_DELAY_TICKS = 5; // пауза после сломанного блока у клиента
const CONFIRM_TICKS = 20; // столько ждём, что сервер подтвердит сломанный или поставленный блок
const LOOK_TIMEOUT_TICKS = 60;
const STUCK_TICKS = 60; // столько тиков без продвижения — бот застрял
const ATTACK_COOLDOWN_TICKS = 12; // пауза между ударами (меч восстанавливается за 12,5 тика)
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
  });

  // Новый мир или сервер — у клиента новый счётчик sequence; всё, что бот делал, прерывается.
  const interrupt = (why) => () => {
    sequence = 0;
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

  /** Стоять на месте: отпустить клавиши и дождаться, пока бот остановится. */
  async function standStill(signal) {
    releaseControls();
    for (let i = 0; i < 40; i += 1) {
      const v = bot.entity.velocity;
      if (bot.entity.onGround && Math.hypot(v.x, v.z) < 0.003) return;
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

  function swing() {
    bot._client.write('arm_animation', { hand: 0 });
  }

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

        // Ступенька в один блок — прыжок; в воде — всплываем.
        let jump = Boolean(bot.entity.isInWater);
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
    });
  }

  /** Сломать блок: взгляд на видимую грань, удар, взмах рукой каждый тик, время — как у клиента. */
  function dig(position) {
    const pos = new Vec3(Math.floor(position.x), Math.floor(position.y), Math.floor(position.z));
    return run('копать', async (signal) => {
      const block = blockAtOrThrow(pos);
      if (isAir(block)) throw new ActionError(`в ${fmt(pos)} нечего ломать — там воздух`);
      if (block.hardness === null || block.hardness < 0 || block.diggable === false) throw new ActionError(`${block.name} в ${fmt(pos)} не ломается`);
      await standStill(signal);
      const spot = visibleFacePoint(pos, block);
      if (!spot) throw new ActionError(`блок ${block.name} в ${fmt(pos)} не виден или слишком далеко`);
      const a = anglesTo(eyePosition(), spot.point);
      await settleLook(a.yaw, a.pitch, signal);
      // Пауза после предыдущего сломанного блока — как у клиента.
      while (ticks() - lastDestroyTick < DESTROY_DELAY_TICKS) await inTick(() => {}, signal);

      const needTicks = Math.max(1, Math.round(bot.digTime(block) / 50));
      let face = spot.face;
      let progress = 0;
      let started = false;
      const abortDig = () => {
        if (started && progress < needTicks) bot._client.write('block_dig', { status: 1, location: pos, face: 0, sequence: 0 });
      };
      try {
        await everyTick(() => {
          const hit = lookedAtBlock(BLOCK_REACH, pos);
          if (!hit || !hit.position.equals(pos)) throw new ActionError(`блок ${fmt(pos)} ушёл из-под взгляда`);
          if (isAir(blockAt(pos))) return true; // его уже нет (сломал кто-то другой)
          if (!started) {
            face = hit.face;
            started = true;
            bot._client.write('block_dig', { status: 0, location: pos, face, sequence: nextSequence() });
            swing(); // взмах от нажатия кнопки
            if (needTicks <= 1) {
              progress = 1; // ломается сразу (трава, факел): только начало, без конца
              lastDestroyTick = ticks();
              return true;
            }
          }
          progress += 1;
          if (progress >= needTicks) {
            bot._client.write('block_dig', { status: 2, location: pos, face, sequence: nextSequence() });
            swing();
            lastDestroyTick = ticks();
            return true;
          }
          swing(); // пока кнопка зажата — взмах каждый тик
          return undefined;
        }, signal);
      } catch (err) {
        abortDig();
        throw err;
      }
      if (!(await waitBlockChange(pos, isAir, signal))) throw new ActionError(`сервер не дал сломать блок в ${fmt(pos)}`, 'rejected');
      return { position: pos, face: FACE_NAMES[face], ticks: needTicks };
    });
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
      if (p.x + 0.3 > pos.x && p.x - 0.3 < pos.x + 1 && p.z + 0.3 > pos.z && p.z - 0.3 < pos.z + 1 && p.y + 1.8 > pos.y && p.y < pos.y + 1) {
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

  const entityBox = (entity) => {
    const w = (entity.width || 0.6) / 2;
    const p = entity.position;
    return [p.x - w, p.y, p.z - w, p.x + w, p.y + (entity.height || 1.8), p.z + w];
  };
  const aimPoint = (entity) => entity.position.offset(0, (entity.height || 1.8) * 0.7, 0);

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

  /** Ударить сущность: взгляд на неё, удар и взмах; между ударами — пауза восстановления. */
  function attack(entity, { cooldownTicks = ATTACK_COOLDOWN_TICKS } = {}) {
    return run('ударить', async (signal) => {
      if (!entity || !entity.position) throw new ActionError('не на кого нападать');
      const boxOf = () => entityBox(entity);
      await standStill(signal);
      for (let i = 0; i < LOOK_TIMEOUT_TICKS; i += 1) {
        if (!bot.entities || !bot.entities[entity.id]) throw new ActionError('цель пропала');
        const eye = eyePosition();
        const box = boxOf();
        if (eye.distanceTo(closestPointOnBox(box, eye)) > ENTITY_REACH) throw new ActionError('цель слишком далеко');
        const a = anglesTo(eye, aimPoint(entity));
        bot.look(a.yaw, a.pitch, true);
        const ready = bot.serverView.lookSettled && ticks() - lastAttackTick >= cooldownTicks;
        if (ready) {
          const done = await inTick(() => {
            const from = eyePosition();
            const dir = currentLook();
            const t = rayBox(from, dir, boxOf());
            if (t === null || t > ENTITY_REACH) return false;
            if (wallBefore(from, dir, t)) return 'wall'; // взгляд упирается в блок раньше цели
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

  /**
   * Нажать правой кнопкой на сущность (NPC, жителя): взгляд на неё, и только когда голова остановилась — нажатие.
   * Как у клиента: сначала «нажать в точку» (точка попадания взгляда на сущности), затем «нажать».
   */
  function interact(entity) {
    return run('нажать на сущность', async (signal) => {
      if (!entity || !entity.position) throw new ActionError('не на что нажимать');
      const boxOf = () => {
        const w = (entity.width || 0.6) / 2;
        const p = entity.position;
        return [p.x - w, p.y, p.z - w, p.x + w, p.y + (entity.height || 1.8), p.z + w];
      };
      await standStill(signal);
      for (let i = 0; i < LOOK_TIMEOUT_TICKS; i += 1) {
        if (bot.entities && !bot.entities[entity.id]) throw new ActionError('сущность пропала');
        const eye = eyePosition();
        if (eye.distanceTo(closestPointOnBox(boxOf(), eye)) > ENTITY_REACH) throw new ActionError('слишком далеко — подойди ближе');
        const a = anglesTo(eye, entity.position.offset(0, (entity.height || 1.8) * 0.6, 0));
        bot.look(a.yaw, a.pitch, true);
        if (bot.serverView.lookSettled && ticks() - lastUseTick >= USE_DELAY_TICKS) {
          const done = await inTick(() => {
            const from = eyePosition();
            const dir = currentLook();
            const t = rayBox(from, dir, boxOf());
            if (t === null || t > ENTITY_REACH) return false;
            const hit = from.plus(dir.scaled(t)).minus(entity.position);
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
    dig,
    place,
    plant,
    activate,
    attack,
    canHit,
    interact,
    clickSlot,
    closeMenu,
    equip,
    wait,
    chat,
    stop,
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
