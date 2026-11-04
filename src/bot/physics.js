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
//     раз в 20 тиков (по тикам, а не по часам), отдельный пакет — при смене «стоит на земле» или «упёрся в стену»;
//     флаг упора в стену настоящий, а не всегда «нет».
//  4. Нажатые клавиши (player_input) и начало/конец бега отправляются внутри тика, перед движением, и только когда
//     изменились. Присед больше не «отпускает» остальные клавиши, а бег на 1.21.x — настоящий «начал бежать»
//     (mineflayer шлёт номер 3, а это «прыжок на лошади»).
//  5. Телепорт от сервера (в том числе откат античитом) — по правилам 1.21.2+: относительные координаты, поворот
//     и скорость из пакета. Поворот головы в пакетах непрерывный — без скачков на 360°.

const assert = require('assert');
const { performance } = require('perf_hooks');
const { Vec3 } = require('vec3');
const { Physics, PlayerState } = require('prismarine-physics');
const math = require('mineflayer/lib/math');
const conv = require('mineflayer/lib/conversions');
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils');

const PI = Math.PI;
const PI_2 = Math.PI * 2;
const TICK_MS = 50;
const TICK_SECONDS = TICK_MS / 1000;
const MAX_CATCHUP_TICKS = 10; // столько тиков подряд догоняет обычный клиент после подвисания
const MIN_MOVE_SQ = 2.0e-4 * 2.0e-4; // меньший сдвиг обычный клиент не отправляет
const POSITION_REMINDER_TICKS = 20; // позицию без движения клиент всё равно присылает раз в 20 тиков
const DEAD_TICKS = 20; // после смерти движение шлём ещё 20 тиков (как mineflayer)
const ERROR_REPORT_MS = 10 * 1000; // ошибку внутри тика сообщаем не чаще, чем раз в 10 с

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

function deltaYaw(yaw1, yaw2) {
  let d = (yaw1 - yaw2) % PI_2;
  if (d < -PI) d += PI_2;
  else if (d > PI) d -= PI_2;
  return d;
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
 * @param {object}  [opts]
 * @param {boolean} [opts.tickEnd=true]  слать tick_end (выключается только для сравнения на тестовом стенде)
 * @param {object}  [opts.clock]         { now, setTimeout, clearTimeout } — подмена времени для тестов
 */
function createPhysicsPlugin({ tickEnd = true, clock = defaultClock } = {}) {
  return function vanillaPhysics(bot, options) {
    inject(bot, options || {}, { tickEnd, clock });
  };
}

function inject(bot, { physicsEnabled }, { tickEnd, clock }) {
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
  // Отправленный поворот головы в радианах, без сворачивания в круг: угол в пакетах меняется плавно.
  let lastSentYaw = null;
  let lastSentPitch = null;
  // Что сервер уже знает о боте (последние отправленные значения).
  const lastSent = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, onGround: false, horizontalCollision: false };
  let positionReminder = 0;
  let sentInputs = NO_INPUTS;
  let sentSprinting = false;
  let deadTicks = DEAD_TICKS + 1;
  let respawnTimer = 0;
  let lastErrorAt = -Infinity;

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
      if (ready && bot.physicsEnabled && shouldUsePhysics) {
        physics.simulatePlayer(new PlayerState(bot, controlState), world).apply(bot);
        bot.emit('physicsTick');
        bot.emit('physicTick'); // устаревшее имя, оставлено для старых плагинов
      }
      if (ready && shouldUsePhysics) {
        sendInputs();
        updatePosition();
      }
    } finally {
      // Тик закончился — даже если внутри что-то упало: пропуск tick_end античит заметит сразу.
      if (sendTickEnd && client.state === 'play') client.write('tick_end', {});
    }
  }

  // ---------- что уходит на сервер ----------

  function sendInputs() {
    if (!inputPacket) return;
    const inputs = {
      forward: controlState.forward,
      backward: controlState.back,
      left: controlState.left,
      right: controlState.right,
      jump: controlState.jump,
      shift: controlState.sneak,
      sprint: controlState.sprint,
    };
    if (Object.keys(inputs).every((k) => inputs[k] === sentInputs[k])) return;
    bot._client.write('player_input', { inputs });
    sentInputs = inputs;
  }

  function sendSprintIfNeeded() {
    const sprinting = controlState.sprint;
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

  function updatePosition() {
    if (isEntityRemoved()) return;
    const pos = bot.entity.position;
    if (!Number.isFinite(pos.x)) return;

    // Голова поворачивается не мгновенно, а с ограниченной скоростью — сервер и другие клиенты успевают за ней.
    const maxYaw = TICK_SECONDS * physics.yawSpeed;
    const maxPitch = TICK_SECONDS * physics.pitchSpeed;
    lastSentYaw += math.clamp(-maxYaw, deltaYaw(bot.entity.yaw, lastSentYaw), maxYaw);
    lastSentPitch += math.clamp(-maxPitch, bot.entity.pitch - (lastSentPitch || 0), maxPitch);
    const yaw = Math.fround(conv.toNotchianYaw(lastSentYaw));
    const pitch = Math.fround(conv.toNotchianPitch(lastSentPitch));
    const onGround = Boolean(bot.entity.onGround);
    const horizontalCollision = Boolean(bot.entity.isCollidedHorizontally);

    sendSprintIfNeeded(); // обычный клиент сообщает о беге в начале отправки движения
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

  /** Текущий поворот головы в градусах игры — непрерывный, как в последних пакетах. */
  function currentYawDegrees() {
    return lastSentYaw !== null ? conv.toNotchianYaw(lastSentYaw) : conv.toNotchianYaw(bot.entity.yaw);
  }

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

  bot.on('move', () => {
    if (!lookingTask.done && Math.abs(deltaYaw(bot.entity.yaw, lastSentYaw)) < 0.001) lookingTask.finish();
  });

  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) lookingTask.finish(); // предыдущий поворот прерван новым
    lookingTask = createTask();
    // Шаг поворота кратен шагу мыши при чувствительности 100%: часть античитов вычисляет его по поворотам.
    const sensitivity = conv.fromNotchianPitch(0.15);
    const yawChange = Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity;
    const pitchChange = Math.round((pitch - bot.entity.pitch) / sensitivity) * sensitivity;
    if (yawChange === 0 && pitchChange === 0) return;
    bot.entity.yaw += yawChange;
    bot.entity.pitch += pitchChange;
    if (force) {
      // Сразу к новому углу, но от прежнего (а не «с нуля»): иначе угол в пакете может скакнуть на 360°.
      lastSentYaw = lastSentYaw === null ? bot.entity.yaw : lastSentYaw + deltaYaw(bot.entity.yaw, lastSentYaw);
      lastSentPitch = bot.entity.pitch;
      return;
    }
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

  // Сервер сам повернул голову бота (1.21.3+). Поворот бывает относительным.
  bot._client.on('player_rotation', (packet) => {
    const yawDeg = packet.relativeYaw ? currentYawDegrees() + packet.yaw : packet.yaw;
    const pitchDeg = math.clamp(-90, packet.relativePitch ? conv.toNotchianPitch(bot.entity.pitch) + packet.pitch : packet.pitch, 90);
    bot.entity.yaw = conv.fromNotchianYaw(yawDeg);
    bot.entity.pitch = conv.fromNotchianPitch(pitchDeg);
    // Обычный клиент применяет такой поворот сразу: в следующем пакете уже новый угол, без плавного доворота.
    lastSentYaw = PI - conv.toRadians(yawDeg);
    lastSentPitch = bot.entity.pitch;
  });

  // Телепорт: сервер поставил бота в точку (в том числе откат античитом). Подтверждаем, как обычный клиент.
  bot._client.on('position', (packet) => {
    bot.entity.height = 1.8;
    const vel = bot.entity.velocity;
    const pos = bot.entity.position;
    const flags = packet.flags;
    let newYaw;
    let newPitch;

    if (typeof flags === 'object' && flags !== null && typeof packet.dx === 'number') {
      // 1.21.2+: в пакете есть и скорость; флаги говорят, что из этого относительное.
      const curYaw = currentYawDegrees();
      const curPitch = conv.toNotchianPitch(bot.entity.pitch);
      pos.set(flags.x ? pos.x + packet.x : packet.x, flags.y ? pos.y + packet.y : packet.y, flags.z ? pos.z + packet.z : packet.z);
      newYaw = (flags.yaw ? curYaw : 0) + packet.yaw;
      newPitch = math.clamp(-90, (flags.pitch ? curPitch : 0) + packet.pitch, 90);
      let v = vel.clone();
      if (flags.yawDelta) v = rotateDelta(v, conv.toRadians(curPitch - newPitch), conv.toRadians(curYaw - newYaw));
      vel.set(flags.dx ? v.x + packet.dx : packet.dx, flags.dy ? v.y + packet.dy : packet.dy, flags.dz ? v.z + packet.dz : packet.dz);
    } else if (typeof flags === 'object' && flags !== null) {
      // 1.20.5–1.21.1: флаги объектом, скорости в пакете нет
      vel.set(flags.x ? vel.x : 0, flags.y ? vel.y : 0, flags.z ? vel.z : 0);
      pos.set(flags.x ? pos.x + packet.x : packet.x, flags.y ? pos.y + packet.y : packet.y, flags.z ? pos.z + packet.z : packet.z);
      newYaw = (flags.yaw ? currentYawDegrees() : 0) + packet.yaw;
      newPitch = (flags.pitch ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch;
    } else {
      // старые версии: флаги битовой маской
      vel.set(flags & 1 ? vel.x : 0, flags & 2 ? vel.y : 0, flags & 4 ? vel.z : 0);
      pos.set(flags & 1 ? pos.x + packet.x : packet.x, flags & 2 ? pos.y + packet.y : packet.y, flags & 4 ? pos.z + packet.z : packet.z);
      newYaw = (flags & 8 ? currentYawDegrees() : 0) + packet.yaw;
      newPitch = (flags & 16 ? conv.toNotchianPitch(bot.entity.pitch) : 0) + packet.pitch;
    }

    bot.entity.yaw = conv.fromNotchianYaw(newYaw);
    bot.entity.pitch = conv.fromNotchianPitch(newPitch);
    bot.entity.onGround = false;

    if (bot.supportFeature('teleportUsesOwnPacket')) bot._client.write('teleport_confirm', { teleportId: packet.teleportId });

    const confirm = (at, yawDeg, pitchDeg) => {
      writeMove('position_look', at, Math.fround(yawDeg), Math.fround(pitchDeg), false, false);
      shouldUsePhysics = true;
      bot.jumpTicks = 0;
      lastSentYaw = PI - conv.toRadians(yawDeg); // тот же угол, что ушёл в пакете, — следующий не прыгнет на 360°
      lastSentPitch = bot.entity.pitch;
      bot.emit('forcedMove');
    };

    // Сразу после смерти ответ на телепорт откладываем (как mineflayer): иначе старые серверы кикают
    // за «Invalid move player packet», а без ответа возрождение не завершится.
    if (respawnTimer > 0 && Date.now() - respawnTimer < 2000) {
      respawnTimer = 0;
      const at = pos.clone();
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

module.exports = { createPhysicsPlugin, TICK_MS, MAX_CATCHUP_TICKS };
