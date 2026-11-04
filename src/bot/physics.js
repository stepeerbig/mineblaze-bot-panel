'use strict';

// Физика бота — замена встроенного плагина mineflayer (lib/plugins/physics.js из mineflayer 4.39, лицензия MIT).
// Снаружи всё как у mineflayer: setControlState, look, lookAt, waitForTicks, события physicsTick, move, forcedMove.
// Отличия — чтобы сервер и античит видели обычный клиент 1.21.x:
//  1. Тики по настоящему времени: в среднем ровно 20 в секунду и никогда не раньше срока. setInterval на Windows
//     срабатывает с шагом 15,6 мс, поэтому срок каждого тика считаем сами. После подвисания догоняем не больше
//     10 тиков подряд, остальные пропускаем — так делает и обычный клиент.
//  2. В конце каждого тика — пакет tick_end. Клиенты 1.21.2+ шлют его всегда; mineflayer не шлёт вовсе,
//     и античит Grim с первых секунд ругается на TickTimer.
//  3. Движение — по правилам обычного клиента: сдвиг меньше 0,0002 блока не отправляется, «напоминание» о позиции —
//     раз в 20 тиков (по тикам, а не по часам), отдельный пакет — при смене «стоит на земле» или «упёрся в стену».
//  4. Нажатые клавиши (player_input) и начало/конец бега отправляются внутри тика, перед движением, и только когда
//     изменились, — ровно те, по которым в этом тике считалось движение. Бег на 1.21.x — настоящий «начал бежать»
//     (mineflayer шлёт номер 3, а это «прыжок на лошади»).
//  5. Голова поворачивается как у человека: разгон и торможение, скорость немного разная от раза к разу, каждый
//     шаг кратен шагу мыши (0,15° при чувствительности 100%) — по шагам античиты узнают «руку». Движение считается
//     по настоящему взгляду в этом тике, а не по целевому (иначе на поворотах сервер видит расхождение).
//  6. Телепорт от сервера (в том числе откат античитом) — по правилам 1.21.2+: относительные координаты, поворот
//     и скорость из пакета. Угол в пакетах непрерывный — без скачков на 360°.

const assert = require('assert');
const { performance } = require('perf_hooks');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const math = require('mineflayer/lib/math');
const conv = require('mineflayer/lib/conversions');
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils');

const TICK_MS = 50;
const MAX_CATCHUP_TICKS = 10; // столько тиков подряд догоняет обычный клиент после подвисания
const MIN_MOVE_SQ = 2.0e-4 * 2.0e-4; // меньший сдвиг обычный клиент не отправляет
const POSITION_REMINDER_TICKS = 20; // позицию без движения клиент всё равно присылает раз в 20 тиков
const DEAD_TICKS = 20; // после смерти движение шлём ещё 20 тиков (как mineflayer)
const ERROR_REPORT_MS = 10 * 1000; // ошибку внутри тика сообщаем не чаще, чем раз в 10 с

// Поворот головы. Шаг мыши при чувствительности 100% (по умолчанию в игре) — 0,15°.
const MOUSE_STEP = 0.15;
const TURN_SPEED = 24; // предельная скорость поворота, градусов за тик (~480°/с)
const TURN_ACCEL = 7; // разгон и торможение, градусов за тик²
const NEW_MOTION_DEG = 2; // цель сдвинулась сильнее — это новое «движение мыши» со своей скоростью

const defaultClock = {
  now: () => performance.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (t) => clearTimeout(t),
};

const NO_INPUTS = Object.freeze({ forward: false, backward: false, left: false, right: false, jump: false, shift: false, sprint: false });

function hasServerboundPacket(bot, name) {
  try {
    return Boolean(bot.registry.protocol.play.toServer.types[`packet_${name}`]);
  } catch (_) {
    return false;
  }
}

/** Значение actionId для entity_action: в 1.21.x это строки из протокола, в старых версиях — номера. */
function entityActionId(bot, names, legacyId) {
  try {
    const fields = bot.registry.protocol.play.toServer.types.packet_entity_action[1];
    const type = fields.find((f) => f.name === 'actionId').type;
    if (Array.isArray(type) && type[0] === 'mapper') {
      const values = Object.values(type[1].mappings);
      const found = names.find((n) => values.includes(n));
      if (found) return found;
    }
  } catch (_) {
    /* нет описания протокола — старый номер */
  }
  return legacyId;
}

/** Разница углов в градусах, сведённая к [-180, 180). */
function wrapDegrees(d) {
  return ((((d + 180) % 360) + 360) % 360) - 180;
}

/**
 * Наибольшая скорость (за тик), с которой можно сделать шаг и потом затормозить по тикам с замедлением accel,
 * не проскочив цель на расстоянии dist. Тормозной путь считается по тикам, а не по формуле непрерывного движения:
 * та даёт заниженный путь, и голова проскакивала цель.
 */
function stopSpeed(dist, accel) {
  let lo = 0;
  let hi = dist;
  for (let i = 0; i < 30; i += 1) {
    const v = (lo + hi) / 2;
    const n = Math.max(0, Math.ceil(v / accel) - 1); // сколько ещё тиков голова будет двигаться при торможении
    const brake = n * v - (accel * n * (n + 1)) / 2;
    if (v + brake <= dist) lo = v;
    else hi = v;
  }
  return lo;
}

/** Поворот вектора скорости, как Vec3.xRot / Vec3.yRot в игре (углы в радианах). */
function rotateDelta(v, pitchRad, yawRad) {
  let { x, y, z } = v;
  let c = Math.cos(pitchRad);
  let s = Math.sin(pitchRad);
  [y, z] = [y * c + z * s, z * c - y * s];
  c = Math.cos(yawRad);
  s = Math.sin(yawRad);
  [x, z] = [x * c + z * s, z * c - x * s];
  return new Vec3(x, y, z);
}

/**
 * Плагин физики для mineflayer: createBot({ plugins: { physics: createPhysicsPlugin() } }) заменяет встроенный.
 * @param {object}   [opts]
 * @param {boolean}  [opts.tickEnd=true]  слать tick_end (выключается только для сравнения на тестовом стенде)
 * @param {object}   [opts.clock]         { now, setTimeout, clearTimeout } — подмена времени для тестов
 * @param {Function} [opts.random]        источник случайности 0..1 (подмена для тестов)
 */
function createPhysicsPlugin({ tickEnd = true, clock = defaultClock, random = Math.random } = {}) {
  return function vanillaPhysics(bot, options) {
    inject(bot, options || {}, { tickEnd, clock, random });
  };
}

function inject(bot, { physicsEnabled }, { tickEnd, clock, random }) {
  const world = { getBlock: (pos) => bot.blockAt(pos, false) };
  const physics = Physics(bot.registry, world);

  const positionUpdateSentEveryTick = bot.supportFeature('positionUpdateSentEveryTick'); // 1.8–1.11
  const hasConfigurationState = bot.supportFeature('hasConfigurationState'); // 1.20.2+
  const inputPacket = bot.supportFeature('newPlayerInputPacket'); // 1.21.3+: клавиши отдельным пакетом
  const sendTickEnd = tickEnd && hasServerboundPacket(bot, 'tick_end'); // 1.21.2+
  const SPRINT_START = entityActionId(bot, ['start_sprinting'], 3);
  const SPRINT_STOP = entityActionId(bot, ['stop_sprinting'], 4);
  const FALL_FLYING = entityActionId(bot, ['start_fall_flying', 'start_elytra_flying'], 8);

  bot.jumpQueued = false;
  bot.jumpTicks = 0; // пауза автопрыжка
  bot.physicsEnabled = physicsEnabled ?? true;
  bot.physics = physics;

  const controlState = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false };
  let shouldUsePhysics = false; // движение считаем только после первой позиции от сервера
  // Что сервер уже знает о боте (последние отправленные значения).
  const lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, onGround: false, horizontalCollision: false };
  let positionReminder = 0;
  let sentInputs = NO_INPUTS;
  let sentSprinting = false;
  let deadTicks = DEAD_TICKS + 1;
  let respawnTimer = 0;
  let lastErrorAt = -Infinity;
  let tickCount = 0;
  // Полёт, который включил сервер (пакет abilities: «Флай включен!» на спавне MineBlaze, /fly). mineflayer
  // этот пакет не читает вовсе — сервер считал бота летящим, а бот слал «стою на земле». Как обычный клиент:
  //  • после телепорта скорость нулевая — клиент висит на месте (не на земле), пока его не трогают;
  //  • если он стоял на земле или пошёл — «приземляется»: выключает полёт и сообщает серверу (abilities).
  let flying = false;

  // Взгляд в градусах игры, без сворачивания в круг (угол в пакетах меняется плавно, без скачков на 360°).
  // bot.entity.yaw/pitch — куда бот хочет смотреть (как в mineflayer), а здесь — куда он смотрит сейчас.
  const rot = { yaw: 0, pitch: 0 }; // текущий взгляд
  const vel = { yaw: 0, pitch: 0 }; // скорость поворота, градусов за тик
  const grid = { yaw: 0, pitch: 0 }; // от этого угла отсчитываются шаги мыши (последний телепорт)
  const current = { yaw: 0, pitch: 0 }; // взгляд этого тика с учётом шага мыши — он и уходит на сервер
  let rotationReady = false; // до первой позиции от сервера взгляда ещё нет
  let settled = true; // голова не движется и смотрит туда, куда нужно
  let motion = null; // текущее «движение мыши»: { yaw, pitch, speed, accel }

  // ---------- тики ----------

  let running = false;
  let timer = null;
  let nextTickAt = 0;

  function startTicking() {
    if (running) return;
    running = true;
    nextTickAt = clock.now() + TICK_MS;
    timer = clock.setTimeout(loop, TICK_MS);
  }

  function stopTicking() {
    running = false;
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
  }

  function loop() {
    timer = null;
    if (!running) return;
    const now = clock.now();
    let ticks = 0;
    while (running && now >= nextTickAt && ticks < MAX_CATCHUP_TICKS) {
      nextTickAt += TICK_MS;
      ticks += 1;
      try {
        tick();
      } catch (err) {
        reportError(err);
      }
    }
    if (now >= nextTickAt) nextTickAt = now + TICK_MS; // отстали сильнее: лишние тики пропускаем
    if (running) timer = clock.setTimeout(loop, Math.max(0, nextTickAt - clock.now()));
  }

  function reportError(err) {
    const now = clock.now();
    if (now - lastErrorAt < ERROR_REPORT_MS) return;
    lastErrorAt = now;
    bot.emit('error', err);
  }

  function tick() {
    const client = bot._client;
    if (!client || client.state !== 'play' || !bot.entity) return; // фаза настройки (переход между серверами)
    try {
      const pos = bot.entity.position;
      const ready = pos && Number.isFinite(pos.x) && bot.blockAt(pos) != null; // чанк под ботом загружен
      if (!ready || !shouldUsePhysics) return;
      tickCount += 1;
      stepRotation();
      // Клавиши этого тика: по ним считается движение, они же уходят на сервер. Что поменяют обработчики
      // physicsTick, сработает в следующем тике — так же, как у обычного клиента.
      const controls = { ...controlState };
      let hover = false;
      if (flying && !(bot.game && bot.game.gameMode === 'spectator')) {
        const wantsMove = controls.forward || controls.back || controls.left || controls.right || controls.jump || controls.sneak;
        if (wantsMove || bot.entity.onGround) {
          // «Приземлился» (или двойной пробел, чтобы пойти пешком): полёт выключен — сервер узнаёт первым.
          flying = false;
          client.write('abilities', { flags: 0 });
        } else {
          hover = true;
        }
      }
      if (bot.physicsEnabled) {
        if (hover) {
          // Висит в воздухе, как обычный клиент в полёте без нажатых клавиш: ни скорости, ни земли под ногами.
          bot.entity.velocity.set(0, 0, 0);
          bot.entity.onGround = false;
        } else {
          const state = new PlayerState(bot, controls);
          state.yaw = conv.fromNotchianYaw(current.yaw); // движение — по настоящему взгляду, а не по целевому
          state.pitch = conv.fromNotchianPitch(current.pitch);
          physics.simulatePlayer(state, world).apply(bot);
        }
        bot.emit('physicsTick');
        bot.emit('physicTick'); // устаревшее имя, оставлено для старых плагинов
      }
      sendInputs(controls);
      updatePosition(controls);
    } finally {
      // Тик закончился — даже если внутри что-то упало: пропуск tick_end античит заметит сразу.
      if (sendTickEnd && client.state === 'play') client.write('tick_end', {});
    }
  }

  // ---------- взгляд ----------

  /** Куда бот хочет смотреть (bot.entity.yaw/pitch) — в градусах игры, ближайшим путём от текущего взгляда. */
  function targetRotation() {
    return {
      yaw: rot.yaw + wrapDegrees(conv.toNotchianYaw(bot.entity.yaw) - rot.yaw),
      pitch: math.clamp(-90, conv.toNotchianPitch(bot.entity.pitch), 90),
    };
  }

  function stepRotation() {
    const target = targetRotation();
    const ex = target.yaw - rot.yaw;
    const ey = target.pitch - rot.pitch;
    const dist = Math.hypot(ex, ey);
    if (dist <= MOUSE_STEP / 2 && Math.hypot(vel.yaw, vel.pitch) <= MOUSE_STEP) {
      rot.yaw = target.yaw;
      rot.pitch = target.pitch;
      vel.yaw = 0;
      vel.pitch = 0;
      motion = null;
    } else {
      // Новое «движение мыши» — со своей скоростью и разгоном (люди каждый раз двигают немного по-разному).
      if (!motion || Math.hypot(target.yaw - motion.yaw, target.pitch - motion.pitch) > NEW_MOTION_DEG) {
        motion = { yaw: target.yaw, pitch: target.pitch, speed: TURN_SPEED * (0.8 + 0.4 * random()), accel: TURN_ACCEL * (0.85 + 0.3 * random()) };
      }
      motion.yaw = target.yaw;
      motion.pitch = target.pitch;
      // Желаемая скорость: не больше предельной, а у цели — такая, чтобы успеть затормозить.
      const speed = Math.min(motion.speed, stopSpeed(dist, motion.accel));
      const dirX = dist > 1e-9 ? ex / dist : 0; // уже на цели, но ещё по инерции — только тормозим
      const dirY = dist > 1e-9 ? ey / dist : 0;
      const dvx = dirX * speed - vel.yaw;
      const dvy = dirY * speed - vel.pitch;
      const dv = Math.hypot(dvx, dvy);
      const k = dv > motion.accel ? motion.accel / dv : 1;
      vel.yaw += dvx * k;
      vel.pitch += dvy * k;
      rot.yaw += vel.yaw;
      rot.pitch = math.clamp(-90, rot.pitch + vel.pitch, 90);
    }
    // Шаг мыши: от последнего телепорта взгляд меняется только на целое число шагов.
    current.yaw = grid.yaw + Math.round((rot.yaw - grid.yaw) / MOUSE_STEP) * MOUSE_STEP;
    current.pitch = math.clamp(-90, grid.pitch + Math.round((rot.pitch - grid.pitch) / MOUSE_STEP) * MOUSE_STEP, 90);
    const wasSettled = settled;
    settled = vel.yaw === 0 && vel.pitch === 0 && Math.abs(target.yaw - rot.yaw) < 1e-9 && Math.abs(target.pitch - rot.pitch) < 1e-9;
    if (settled && !wasSettled && !lookingTask.done) lookingTask.finish();
  }

  /** Сервер сам задал взгляд (телепорт, поворот): он применяется сразу, без плавного доворота. */
  function setRotation(yawDeg, pitchDeg) {
    rot.yaw = yawDeg;
    rot.pitch = math.clamp(-90, pitchDeg, 90);
    vel.yaw = 0;
    vel.pitch = 0;
    grid.yaw = rot.yaw;
    grid.pitch = rot.pitch;
    current.yaw = rot.yaw;
    current.pitch = rot.pitch;
    motion = null;
    rotationReady = true;
    bot.entity.yaw = conv.fromNotchianYaw(rot.yaw);
    bot.entity.pitch = conv.fromNotchianPitch(rot.pitch);
    settled = true;
    if (!lookingTask.done) lookingTask.finish();
  }

  /** Текущий взгляд в градусах игры — непрерывный, как в последних пакетах. */
  function currentYawDegrees() {
    return rotationReady ? rot.yaw : conv.toNotchianYaw(bot.entity.yaw);
  }

  // ---------- что уходит на сервер ----------

  function sendInputs(controls) {
    if (!inputPacket) return;
    const inputs = {
      forward: controls.forward,
      backward: controls.back,
      left: controls.left,
      right: controls.right,
      jump: controls.jump,
      shift: controls.sneak,
      sprint: controls.sprint,
    };
    if (Object.keys(inputs).every((k) => inputs[k] === sentInputs[k])) return;
    bot._client.write('player_input', { inputs });
    sentInputs = inputs;
  }

  function sendSprintIfNeeded(controls) {
    const sprinting = controls.sprint;
    if (sprinting === sentSprinting) return;
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: sprinting ? SPRINT_START : SPRINT_STOP, jumpBoost: 0 });
    sentSprinting = sprinting;
  }

  function writeMove(name, pos, yaw, pitch, onGround, horizontalCollision) {
    const oldPos = new Vec3(lastSent.x, lastSent.y, lastSent.z);
    const packet = { onGround, flags: { onGround, hasHorizontalCollision: horizontalCollision } };
    if (pos) {
      packet.x = pos.x;
      packet.y = pos.y;
      packet.z = pos.z;
      lastSent.x = pos.x;
      lastSent.y = pos.y;
      lastSent.z = pos.z;
      positionReminder = 0;
    }
    if (yaw !== null) {
      packet.yaw = yaw;
      packet.pitch = pitch;
      lastSent.yaw = yaw;
      lastSent.pitch = pitch;
    }
    lastSent.onGround = onGround;
    lastSent.horizontalCollision = horizontalCollision;
    bot._client.write(name, packet);
    bot.emit('move', oldPos);
  }

  // После смерти движение шлём ещё 20 тиков, потом молчим до возрождения (как mineflayer).
  function isEntityRemoved() {
    if (bot.isAlive === true) deadTicks = 0;
    if (bot.isAlive === false && deadTicks <= DEAD_TICKS) deadTicks += 1;
    return deadTicks >= DEAD_TICKS;
  }

  function updatePosition(controls) {
    if (isEntityRemoved()) return;
    const pos = bot.entity.position;
    if (!Number.isFinite(pos.x)) return;
    const yaw = Math.fround(current.yaw);
    const pitch = Math.fround(current.pitch);
    const onGround = Boolean(bot.entity.onGround);
    const horizontalCollision = Boolean(bot.entity.isCollidedHorizontally);

    sendSprintIfNeeded(controls); // обычный клиент сообщает о беге в начале отправки движения
    positionReminder += 1;
    const dx = pos.x - lastSent.x;
    const dy = pos.y - lastSent.y;
    const dz = pos.z - lastSent.z;
    const moved = dx * dx + dy * dy + dz * dz > MIN_MOVE_SQ || positionReminder >= POSITION_REMINDER_TICKS;
    const turned = yaw !== lastSent.yaw || pitch !== lastSent.pitch;

    if (moved && turned) writeMove('position_look', pos, yaw, pitch, onGround, horizontalCollision);
    else if (moved) writeMove('position', pos, null, null, onGround, horizontalCollision);
    else if (turned) writeMove('look', null, yaw, pitch, onGround, horizontalCollision);
    else if (positionUpdateSentEveryTick || onGround !== lastSent.onGround || horizontalCollision !== lastSent.horizontalCollision) {
      bot._client.write('flying', { onGround, flags: { onGround, hasHorizontalCollision: horizontalCollision } });
      lastSent.onGround = onGround;
      lastSent.horizontalCollision = horizontalCollision;
    }
  }

  // Новый мир или новый сервер (прокси): там ещё ничего не знают о нажатых клавишах и беге.
  function resetServerView() {
    sentInputs = NO_INPUTS;
    sentSprinting = false;
    positionReminder = 0;
  }

  // Что знает о боте сервер — для действий (src/bot/actions.js): по этому взгляду и положению он их проверяет.
  bot.serverView = {
    get position() {
      return new Vec3(lastSent.x, lastSent.y, lastSent.z);
    },
    /** Взгляд этого тика (радианы, как bot.entity.yaw/pitch). */
    get yaw() {
      return conv.fromNotchianYaw(current.yaw);
    },
    get pitch() {
      return conv.fromNotchianPitch(current.pitch);
    },
    /** Голова не движется и смотрит туда, куда нужно. */
    get lookSettled() {
      return settled && rotationReady;
    },
    /** Сколько тиков с движением прошло (счётчик для действий). */
    get ticks() {
      return tickCount;
    },
    get inputs() {
      return { ...sentInputs };
    },
    /** Летит ли бот (по мнению сервера и клиента): полёт включил сервер, а бот ещё не «приземлился». */
    get flying() {
      return flying;
    },
  };

  // ---------- управление ----------

  bot.elytraFly = async () => {
    if (bot.entity.elytraFlying) throw new Error('Already elytra flying');
    if (bot.entity.onGround) throw new Error('Unable to fly from ground');
    if (bot.entity.isInWater) throw new Error('Unable to elytra fly while in water');
    const mcData = require('minecraft-data')(bot.version);
    const levitation = mcData.effectsByName.Levitation;
    if (levitation && bot.entity.effects[levitation.id]) throw new Error('Unable to elytra fly with levitation effect');
    const item = bot.inventory.slots[bot.getEquipmentDestSlot('torso')];
    if (item == null || item.name !== 'elytra') throw new Error('Elytra must be equip to start flying');
    bot._client.write('entity_action', { entityId: bot.entity.id, actionId: FALL_FLYING, jumpBoost: 0 });
  };

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`);
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`);
    if (controlState[control] === state) return;
    controlState[control] = state;
    if (control === 'jump' && state) {
      bot.jumpQueued = true;
    } else if (control === 'sneak' && !inputPacket) {
      // До 1.21.3 присед — отдельным пакетом и сразу.
      bot._client.write('entity_action', { entityId: bot.entity.id, actionId: state ? 0 : 1, jumpBoost: 0 });
    }
    // Бег и клавиши (1.21.3+) уйдут на сервер в ближайшем тике, перед движением — как у обычного клиента.
  };

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`);
    return controlState[control];
  };

  bot.clearControlStates = () => {
    for (const control of Object.keys(controlState)) bot.setControlState(control, false);
  };

  bot.controlState = {};
  for (const control of Object.keys(controlState)) {
    Object.defineProperty(bot.controlState, control, {
      get: () => controlState[control],
      set: (state) => {
        bot.setControlState(control, state);
        return state;
      },
    });
  }

  let lookingTask = createDoneTask();

  /**
   * Повернуть голову (радианы, как в mineflayer). Голова поворачивается плавно, как у человека; промис
   * выполняется, когда взгляд дошёл до цели. force (в mineflayer — «мгновенно») здесь значит «не ждать»:
   * мгновенный поворот — верный признак бота, поэтому плавно всегда.
   */
  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) lookingTask.finish(); // предыдущий поворот прерван новым
    lookingTask = createTask();
    // Цель — на сетке шагов мыши относительно нынешней (как у mineflayer).
    const sensitivity = conv.fromNotchianPitch(MOUSE_STEP);
    const yawChange = Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity;
    const pitchChange = Math.round((pitch - bot.entity.pitch) / sensitivity) * sensitivity;
    if (yawChange === 0 && pitchChange === 0) {
      if (settled) lookingTask.finish();
    } else {
      bot.entity.yaw += yawChange;
      bot.entity.pitch += pitchChange;
      settled = false;
    }
    if (force) return;
    await lookingTask.promise;
  };

  bot.lookAt = async (point, force) => {
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0));
    const yaw = Math.atan2(-delta.x, -delta.z);
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
    const pitch = Math.atan2(delta.y, groundDistance);
    await bot.look(yaw, pitch, force);
  };

  bot.waitForTicks = async function waitForTicks(ticks) {
    if (ticks <= 0) return;
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        bot.removeListener('physicsTick', onTick);
        reject(new Error(`Timeout waiting for ${ticks} ticks after ${ticks * 50 + 5000}ms`));
      }, ticks * 50 + 5000);
      const onTick = () => {
        ticks -= 1;
        if (ticks === 0) {
          clearTimeout(timeout);
          bot.removeListener('physicsTick', onTick);
          resolve();
        }
      };
      bot.on('physicsTick', onTick);
    });
  };

  // ---------- пакеты сервера ----------

  bot._client.on('explosion', (explosion) => {
    if (!bot.physicsEnabled || bot.game.gameMode === 'creative') return;
    if (explosion.playerKnockback) {
      // 1.21.3+
      bot.entity.velocity.x += explosion.playerKnockback.x;
      bot.entity.velocity.y += explosion.playerKnockback.y;
      bot.entity.velocity.z += explosion.playerKnockback.z;
    }
    if ('playerMotionX' in explosion) {
      bot.entity.velocity.x += explosion.playerMotionX;
      bot.entity.velocity.y += explosion.playerMotionY;
      bot.entity.velocity.z += explosion.playerMotionZ;
    }
  });

  // Сервер сам повернул голову бота (1.21.3+). Поворот бывает относительным. Обычный клиент применяет его сразу.
  bot._client.on('player_rotation', (packet) => {
    const yawDeg = packet.relativeYaw ? currentYawDegrees() + packet.yaw : packet.yaw;
    const pitchDeg = packet.relativePitch ? (rotationReady ? rot.pitch : conv.toNotchianPitch(bot.entity.pitch)) + packet.pitch : packet.pitch;
    setRotation(yawDeg, pitchDeg);
  });

  // Сервер включил или выключил полёт (флаг 2 — «летит»).
  bot._client.on('abilities', (packet) => {
    flying = Boolean(packet && packet.flags & 2);
  });

  // Телепорт: сервер поставил бота в точку (в том числе откат античитом). Подтверждаем, как обычный клиент.
  bot._client.on('position', (packet) => {
    bot.entity.height = 1.8;
    const vel3 = bot.entity.velocity;
    const pos = bot.entity.position;
    const flags = packet.flags;
    const curYaw = currentYawDegrees();
    const curPitch = rotationReady ? rot.pitch : conv.toNotchianPitch(bot.entity.pitch);
    let newYaw;
    let newPitch;

    if (typeof flags === 'object' && flags !== null && typeof packet.dx === 'number') {
      // 1.21.2+: в пакете есть и скорость; флаги говорят, что из этого относительное.
      pos.set(flags.x ? pos.x + packet.x : packet.x, flags.y ? pos.y + packet.y : packet.y, flags.z ? pos.z + packet.z : packet.z);
      newYaw = (flags.yaw ? curYaw : 0) + packet.yaw;
      newPitch = math.clamp(-90, (flags.pitch ? curPitch : 0) + packet.pitch, 90);
      let v = vel3.clone();
      if (flags.yawDelta) v = rotateDelta(v, conv.toRadians(curPitch - newPitch), conv.toRadians(curYaw - newYaw));
      vel3.set(flags.dx ? v.x + packet.dx : packet.dx, flags.dy ? v.y + packet.dy : packet.dy, flags.dz ? v.z + packet.dz : packet.dz);
    } else if (typeof flags === 'object' && flags !== null) {
      // 1.20.5–1.21.1: флаги объектом, скорости в пакете нет
      vel3.set(flags.x ? vel3.x : 0, flags.y ? vel3.y : 0, flags.z ? vel3.z : 0);
      pos.set(flags.x ? pos.x + packet.x : packet.x, flags.y ? pos.y + packet.y : packet.y, flags.z ? pos.z + packet.z : packet.z);
      newYaw = (flags.yaw ? curYaw : 0) + packet.yaw;
      newPitch = (flags.pitch ? curPitch : 0) + packet.pitch;
    } else {
      // старые версии: флаги битовой маской
      vel3.set(flags & 1 ? vel3.x : 0, flags & 2 ? vel3.y : 0, flags & 4 ? vel3.z : 0);
      pos.set(flags & 1 ? pos.x + packet.x : packet.x, flags & 2 ? pos.y + packet.y : packet.y, flags & 4 ? pos.z + packet.z : packet.z);
      newYaw = (flags & 8 ? curYaw : 0) + packet.yaw;
      newPitch = (flags & 16 ? curPitch : 0) + packet.pitch;
    }

    bot.entity.onGround = false;
    if (bot.supportFeature('teleportUsesOwnPacket')) bot._client.write('teleport_confirm', { teleportId: packet.teleportId });

    const confirm = (at, yawDeg, pitchDeg) => {
      setRotation(yawDeg, pitchDeg);
      writeMove('position_look', at, Math.fround(current.yaw), Math.fround(current.pitch), false, false);
      shouldUsePhysics = true;
      bot.jumpTicks = 0;
      bot.emit('forcedMove');
    };

    // Сразу после смерти ответ на телепорт откладываем (как mineflayer): иначе старые серверы кикают
    // за «Invalid move player packet», а без ответа возрождение не завершится.
    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0;
      const at = pos.clone();
      bot.entity.yaw = conv.fromNotchianYaw(newYaw);
      bot.entity.pitch = conv.fromNotchianPitch(newPitch);
      clock.setTimeout(() => confirm(at, newYaw, newPitch), 1500);
      return;
    }
    confirm(pos, newYaw, newPitch);
  });

  // ---------- жизненный цикл ----------

  bot.on('mount', () => {
    shouldUsePhysics = false;
  });
  bot.on('death', () => {
    shouldUsePhysics = false;
    respawnTimer = Date.now();
  });
  bot.on('respawn', () => {
    shouldUsePhysics = false;
    resetServerView();
  });
  bot.on('login', () => {
    shouldUsePhysics = false;
    flying = false; // новый сервер — новый игрок; полёт он включит сам, если нужно
    resetServerView();
    startTicking();
  });
  // Прокси (Velocity) переводит на другой сервер через фазу настройки: там пакеты движения запрещены.
  // Физика снова включится с первой позицией от нового сервера.
  if (hasConfigurationState) {
    bot._client.on('start_configuration', () => {
      shouldUsePhysics = false;
    });
  }
  bot.on('end', stopTicking);
}

module.exports = { createPhysicsPlugin, wrapDegrees, TICK_MS, MAX_CATCHUP_TICKS, MOUSE_STEP, TURN_SPEED };
