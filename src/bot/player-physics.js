'use strict';

// Один тик движения игрока — как в игре 1.21. Основа — prismarine-physics 1.11.1 (PrismarineJS, лицензия MIT):
// столкновения и шаг на ступеньку, ходьба и воздух, лестницы, паутина, пузырьковые колонны, элитры — оттуда без
// изменений. По коду игры 1.21 переписано то, в чём prismarine с ней расходится (античит на сервере считает по игре
// и откатывает бота):
//  1. «В воде» и «в лаве» — по высоте жидкости в клетках, которых касается тело (Entity.updateFluidHeightAndDoFluidPushing).
//     prismarine проверял по-старому (1.12): тело, ужатое на 0,4 блока сверху и снизу, без уровня воды. В мелкой
//     растёкшейся воде бот «выплывал» медленными гребками, когда игра уже считала его над водой, — и получал откат
//     каждый тик (стенд, 7 ноября: тысячи откатов подряд); у поверхности озера — наоборот.
//  2. Снос течением — как в игре: среднее по клеткам, на мелководье слабее (FlowingFluid.getFlow).
//  3. Прыжок в жидкости (LivingEntity.aiStep): со дна мелкой воды (не глубже 0,4 блока) — обычный прыжок, глубже — гребок.
//  4. Движение в воде и лаве — LivingEntity.travelInFluid. Бег в воде, пока голова над водой, игра выключает.
//  5. Малая скорость гасится, как у игрока 1.21.5+: по длине по горизонтали (меньше 0,003), а не по каждой оси.

const { Vec3 } = require('vec3');
const AABB = require('prismarine-physics/lib/aabb');
const features = require('prismarine-physics/lib/features');
const attribute = require('prismarine-physics/lib/attribute');

const f32 = Math.fround;
const clamp = (min, x, max) => Math.max(min, Math.min(x, max));

const WATER_PUSH = 0.014; // Entity.updateInWaterStateAndDoWaterCurrentPushing
const LAVA_PUSH = 0.0023333333333333335; // лава сносит слабее; в аду — LAVA_PUSH_ULTRAWARM
const LAVA_PUSH_ULTRAWARM = 0.007;
const MIN_PUSH = 0.0045000000000000005; // стоящего игрока течение сдвигает хотя бы на столько
const FLUID_JUMP_THRESHOLD = 0.4; // LivingEntity.getFluidJumpThreshold: мельче — прыжок со дна, глубже — гребок
const LIQUID_JUMP = f32(0.04); // LivingEntity.jumpInLiquid
const FLUID_Y_DRAG = f32(0.8);
const OUT_OF_LIQUID_STEP = f32(0.6);
const OUT_OF_LIQUID_IMPULSE = f32(0.3);
const WATER_SLOWDOWN = f32(0.8); // Player.getWaterSlowDown
const WATER_SPRINT_SLOWDOWN = f32(0.9);
const SNEAK_HEIGHT = 1.5;
const STAND_HEIGHT = 1.8;
const H_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // север, восток, юг, запад (Direction.Plane.HORIZONTAL)

function unit(x, y, z) {
  const n = Math.sqrt(x * x + y * y + z * z);
  return n < f32(1.0e-5) ? new Vec3(0, 0, 0) : new Vec3(x / n, y / n, z / n);
}

/**
 * Физика игрока для мира версии mcData (prismarine-registry / minecraft-data). Как Physics из prismarine-physics:
 * simulatePlayer(state, world) — один тик для PlayerState. Дополнительно в state: ultraWarm (ад: лава сносит
 * сильнее); после тика — waterHeight, lavaHeight (глубина), eyeInWater и sprinting (бежит ли — бег в воде игра
 * выключает, это и нужно сообщить серверу).
 */
function createSimulator(mcData) {
  const supportFeature = (feature) => features.some(({ name, versions }) => name === feature && versions.includes(mcData.version.majorVersion));
  const atLeast = (v) => typeof mcData.version['>='] === 'function' && mcData.version['>='](v);
  const playerThreshold = atLeast('1.21.5'); // гасить малую скорость по длине по горизонтали (как игрок 1.21.5+)
  const fluidInteraction = atLeast('1.21.11'); // жидкости — по EntityFluidInteraction (1.21.11+)
  const legacyThreshold = !atLeast('1.9'); // 1.8 гасил с 0,005
  const blocksByName = mcData.blocksByName;
  const idOf = (name) => (blocksByName[name] ? blocksByName[name].id : -1);

  // Скольжение: https://www.mcpk.wiki/w/index.php?title=Slipperiness
  const blockSlipperiness = {};
  blockSlipperiness[blocksByName.slime_block ? blocksByName.slime_block.id : blocksByName.slime.id] = 0.8;
  blockSlipperiness[blocksByName.ice.id] = 0.98;
  blockSlipperiness[blocksByName.packed_ice.id] = 0.98;
  if (blocksByName.frosted_ice) blockSlipperiness[blocksByName.frosted_ice.id] = 0.98;
  if (blocksByName.blue_ice) blockSlipperiness[blocksByName.blue_ice.id] = 0.989;

  const slimeBlockId = blocksByName.slime_block ? blocksByName.slime_block.id : blocksByName.slime.id;
  const soulsandId = blocksByName.soul_sand.id;
  const honeyblockId = idOf('honey_block');
  const webId = blocksByName.cobweb ? blocksByName.cobweb.id : blocksByName.web.id;
  const waterIds = new Set([idOf('water'), idOf('flowing_water')].filter((i) => i >= 0));
  const lavaIds = new Set([idOf('lava'), idOf('flowing_lava')].filter((i) => i >= 0));
  const ladderId = blocksByName.ladder.id;
  const vineId = blocksByName.vine.id;
  const scaffoldingId = idOf('scaffolding');
  const airId = idOf('air');
  const trapdoorIds = new Set(Object.values(blocksByName).filter((b) => /_trapdoor$/.test(b.name)).map((b) => b.id));
  const waterLike = new Set(['seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column'].map(idOf).filter((i) => i >= 0));
  const bubblecolumnId = idOf('bubble_column');

  const physics = {
    gravity: 0.08,
    airdrag: f32(1 - 0.02),
    yawSpeed: 3.0,
    pitchSpeed: 3.0,
    playerSpeed: 0.1,
    sprintSpeed: 0.3,
    sneakSpeed: 0.3,
    stepHeight: 0.6,
    negligeableVelocity: legacyThreshold ? 0.005 : 0.003,
    soulsandSpeed: 0.4,
    honeyblockSpeed: 0.4,
    honeyblockJumpSpeed: 0.4,
    ladderMaxSpeed: 0.15,
    ladderClimbSpeed: 0.2,
    // Коробка игрока — как у игры и сервера: 0,6F × 1,8F (половина ширины 0,30000001…). С ровно 0,3 бот, упёршись
    // в стену, стоял на 0,00000001 ближе, чем считает сервер, — и Paper откатывал его как «влезшего в блок».
    playerHalfWidth: f32(0.6) / 2,
    playerHeight: f32(STAND_HEIGHT),
    waterInertia: 0.8,
    lavaInertia: 0.5,
    liquidAcceleration: 0.02,
    airborneInertia: 0.91,
    airborneAcceleration: 0.02,
    defaultSlipperiness: 0.6,
    outOfLiquidImpulse: 0.3,
    autojumpCooldown: 10,
    bubbleColumnSurfaceDrag: { down: 0.03, maxDown: -0.9, up: 0.1, maxUp: 1.8 },
    bubbleColumnDrag: { down: 0.03, maxDown: -0.3, up: 0.06, maxUp: 0.7 },
    slowFalling: 0.125,
    movementSpeedAttribute: mcData.attributesByName.movementSpeed.resource,
    sprintingUUID: '662a6b8d-da3e-4c1c-8813-96ea6097278d',
  };

  const blockXYZ = (world, x, y, z) => world.getBlock(new Vec3(x, y, z));

  function getPlayerBB(pos) {
    const w = physics.playerHalfWidth;
    return new AABB(-w, 0, -w, w, physics.playerHeight, w).offset(pos.x, pos.y, pos.z);
  }

  function setPositionToBB(bb, pos) {
    pos.x = bb.minX + physics.playerHalfWidth;
    pos.y = bb.minY;
    pos.z = bb.minZ + physics.playerHalfWidth;
  }

  /**
   * Сервер строит коробку заново из позиции (x ± половина ширины) и касание блока, которого раньше не касался,
   * считает «влез в блок» даже при перекрытии в 1e-15 (Paper: AABB.intersects без допуска) — откат. Округление
   * «позиция = край + половина» иногда даёт как раз такое перекрытие: у грани, в которую упёрлись, позицию
   * отодвигаем на долю единицы последнего разряда — коробка из неё за грань не заходит.
   * side +1 — грань со стороны меньших координат (pos − half ≥ face), −1 — со стороны больших (pos + half ≤ face).
   */
  function clearFace(pos, axis, face, side, half) {
    let v = pos[axis];
    for (let i = 0; i < 8 && (side > 0 ? v - half < face : v + half > face); i++) {
      v += side * Math.max(1, Math.abs(v)) * Number.EPSILON;
    }
    pos[axis] = v;
  }

  function getSurroundingBBs(world, queryBB) {
    const surroundingBBs = [];
    const cursor = new Vec3(0, 0, 0);
    for (cursor.y = Math.floor(queryBB.minY) - 1; cursor.y <= Math.floor(queryBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(queryBB.minZ); cursor.z <= Math.floor(queryBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(queryBB.minX); cursor.x <= Math.floor(queryBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor);
          if (block) {
            const blockPos = block.position;
            for (const shape of block.shapes) {
              const blockBB = new AABB(shape[0], shape[1], shape[2], shape[3], shape[4], shape[5]);
              blockBB.offset(blockPos.x, blockPos.y, blockPos.z);
              surroundingBBs.push(blockBB);
            }
          }
        }
      }
    }
    return surroundingBBs;
  }

  // ---------- жидкости (как в игре 1.21) ----------

  /** Жидкость в блоке, как FluidState игры: { lava, amount 1…8, falling } или null. */
  function fluidOf(block) {
    if (!block) return null;
    const lava = lavaIds.has(block.type);
    if (lava || waterIds.has(block.type)) {
      const level = block.metadata;
      return level >= 8 ? { lava, amount: 8, falling: true } : { lava, amount: 8 - level, falling: false };
    }
    if (waterLike.has(block.type) || block.isWaterlogged === true) return { lava: false, amount: 8, falling: false };
    return null;
  }

  const ownHeight = (fs) => f32(fs.amount / 9);

  /** FluidState.getHeight: полный блок, если сверху та же жидкость. */
  function fluidHeight(world, x, y, z, fs) {
    const above = fluidOf(blockXYZ(world, x, y + 1, z));
    return above && above.lava === fs.lava ? 1 : ownHeight(fs);
  }

  /** BlockState.blocksMotion: «твёрдый» блок — коробка столкновений почти во весь блок или во всю высоту. */
  function blocksMotion(block) {
    if (!block || block.type === webId || !block.shapes || block.shapes.length === 0) return false;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const s of block.shapes) {
      minX = Math.min(minX, s[0]);
      minY = Math.min(minY, s[1]);
      minZ = Math.min(minZ, s[2]);
      maxX = Math.max(maxX, s[3]);
      maxY = Math.max(maxY, s[4]);
      maxZ = Math.max(maxZ, s[5]);
    }
    return (maxX - minX + (maxY - minY) + (maxZ - minZ)) / 3 >= 0.7291666666666666 || maxY - minY >= 1;
  }

  /** FlowingFluid.isSolidFace (по бокам): другая жидкость или сплошная грань блока; лёд — нет. */
  function solidFace(world, x, y, z, fs) {
    const b = blockXYZ(world, x, y, z);
    const f = fluidOf(b);
    if (f && f.lava === fs.lava) return false;
    return Boolean(b) && b.boundingBox === 'block' && b.name !== 'ice' && b.name !== 'frosted_ice';
  }

  /** FlowingFluid.getFlow: куда течёт жидкость в клетке (единичный вектор или ноль). */
  function flowAt(world, x, y, z, fs) {
    const own = ownHeight(fs);
    let dx = 0;
    let dz = 0;
    for (const [sx, sz] of H_DIRS) {
      const nb = blockXYZ(world, x + sx, y, z + sz);
      const nf = fluidOf(nb);
      if (nf && nf.lava !== fs.lava) continue; // другая жидкость на течение не влияет
      let f = nf ? ownHeight(nf) : 0;
      let g = 0;
      if (f === 0) {
        if (!blocksMotion(nb)) {
          const bf = fluidOf(blockXYZ(world, x + sx, y - 1, z + sz));
          if (bf && bf.lava === fs.lava) {
            f = ownHeight(bf);
            if (f > 0) g = f32(own - f32(f - f32(0.8888889)));
          }
        }
      } else if (f > 0) {
        g = f32(own - f);
      }
      if (g !== 0) {
        dx += sx * g;
        dz += sz * g;
      }
    }
    let v = new Vec3(dx, 0, dz);
    if (fs.falling) {
      for (const [sx, sz] of H_DIRS) {
        if (solidFace(world, x + sx, y, z + sz, fs) || solidFace(world, x + sx, y + 1, z + sz, fs)) {
          v = unit(v.x, v.y, v.z).offset(0, -6, 0);
          break;
        }
      }
    }
    return unit(v.x, v.y, v.z);
  }

  /**
   * Касается ли тело (ужатое на 0,001) жидкости, насколько глубоко, и снос течением (у игрока — среднее по клеткам,
   * без растяжения до полной силы). 1.21.11+ — EntityFluidInteraction (так считает и Grim): глубина — от низа тела,
   * совсем слабое течение не сносит; раньше — Entity.updateFluidHeightAndDoFluidPushing.
   */
  function fluidContact(world, pos, vel, height, lava, motionScale) {
    const w = physics.playerHalfWidth;
    const minX = pos.x - w + 0.001;
    const maxX = pos.x + w - 0.001;
    const minY = pos.y + 0.001;
    const maxY = pos.y + height - 0.001;
    const minZ = pos.z - w + 0.001;
    const maxZ = pos.z + w - 0.001;
    const base = fluidInteraction ? pos.y : minY; // от чего меряется глубина
    let depth = 0;
    let touching = false;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    let count = 0;
    for (let x = Math.floor(minX); x < Math.ceil(maxX); x++) {
      for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
        for (let z = Math.floor(minZ); z < Math.ceil(maxZ); z++) {
          const fs = fluidOf(blockXYZ(world, x, y, z));
          if (!fs || fs.lava !== lava) continue;
          const level = fluidHeight(world, x, y, z, fs);
          const top = fluidInteraction ? y + level : f32(f32(y) + level);
          if (!(top >= minY)) continue;
          touching = true;
          depth = Math.max(top - base, depth);
          const flow = flowAt(world, x, y, z, fs);
          const k = depth < 0.4 ? depth : 1;
          sx += flow.x * k;
          sy += flow.y * k;
          sz += flow.z * k;
          count += 1;
        }
      }
    }
    let push = null;
    const sum2 = sx * sx + sy * sy + sz * sz;
    if (count > 0 && (fluidInteraction ? sum2 >= f32(1.0e-5) : sum2 > 0)) {
      let px = (sx / count) * motionScale;
      let py = (sy / count) * motionScale;
      let pz = (sz / count) * motionScale;
      if (Math.abs(vel.x) < 0.003 && Math.abs(vel.z) < 0.003 && Math.sqrt(px * px + py * py + pz * pz) < MIN_PUSH) {
        const u = unit(px, py, pz);
        px = u.x * MIN_PUSH;
        py = u.y * MIN_PUSH;
        pz = u.z * MIN_PUSH;
      }
      push = new Vec3(px, py, pz);
    }
    return { touching, depth, push };
  }

  /** Level.containsAnyLiquid: есть ли жидкость в клетках коробки. */
  function containsAnyLiquid(world, bb) {
    for (let x = Math.floor(bb.minX); x < Math.ceil(bb.maxX); x++) {
      for (let y = Math.floor(bb.minY); y < Math.ceil(bb.maxY); y++) {
        for (let z = Math.floor(bb.minZ); z < Math.ceil(bb.maxZ); z++) {
          if (fluidOf(blockXYZ(world, x, y, z))) return true;
        }
      }
    }
    return false;
  }

  /** Entity.isFree(dx, dy, dz): тело, сдвинутое на столько, ни во что не упирается и не в жидкости. */
  function isFree(world, pos, dx, dy, dz) {
    const bb = getPlayerBB(pos).offset(dx, dy, dz);
    if (getSurroundingBBs(world, bb).some((b) => bb.intersects(b))) return false;
    return !containsAnyLiquid(world, bb);
  }

  /** Глаза в воде (Entity.updateFluidOnEyes): уровень воды в клетке глаз выше глаз. */
  function eyeInWater(world, pos, sneak) {
    const eyeY = pos.y + (sneak ? f32(1.27) : f32(1.62));
    const x = Math.floor(pos.x);
    const y = Math.floor(eyeY);
    const z = Math.floor(pos.z);
    const fs = fluidOf(blockXYZ(world, x, y, z));
    if (!fs || fs.lava) return false;
    return f32(f32(y) + fluidHeight(world, x, y, z, fs)) > eyeY;
  }

  // ---------- движение (prismarine-physics) ----------

  function moveEntity(entity, world, dx, dy, dz) {
    const vel = entity.vel;
    const pos = entity.pos;

    if (entity.isInWeb) {
      dx *= 0.25;
      dy *= 0.05;
      dz *= 0.25;
      vel.x = 0;
      vel.y = 0;
      vel.z = 0;
      entity.isInWeb = false;
    }

    let oldVelX = dx;
    const oldVelY = dy;
    let oldVelZ = dz;

    if (entity.control.sneak && entity.onGround) {
      const step = 0.05;
      for (; dx !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(dx, 0, 0)).length === 0; oldVelX = dx) {
        if (dx < step && dx >= -step) dx = 0;
        else if (dx > 0) dx -= step;
        else dx += step;
      }
      for (; dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(0, 0, dz)).length === 0; oldVelZ = dz) {
        if (dz < step && dz >= -step) dz = 0;
        else if (dz > 0) dz -= step;
        else dz += step;
      }
      while (dx !== 0 && dz !== 0 && getSurroundingBBs(world, getPlayerBB(pos).offset(dx, 0, dz)).length === 0) {
        if (dx < step && dx >= -step) dx = 0;
        else if (dx > 0) dx -= step;
        else dx += step;
        if (dz < step && dz >= -step) dz = 0;
        else if (dz > 0) dz -= step;
        else dz += step;
        oldVelX = dx;
        oldVelZ = dz;
      }
    }

    let playerBB = getPlayerBB(pos);
    const queryBB = playerBB.clone().extend(dx, dy, dz);
    const surroundingBBs = getSurroundingBBs(world, queryBB);
    const oldBB = playerBB.clone();

    for (const blockBB of surroundingBBs) dy = blockBB.computeOffsetY(playerBB, dy);
    playerBB.offset(0, dy, 0);
    for (const blockBB of surroundingBBs) dx = blockBB.computeOffsetX(playerBB, dx);
    playerBB.offset(dx, 0, 0);
    for (const blockBB of surroundingBBs) dz = blockBB.computeOffsetZ(playerBB, dz);
    playerBB.offset(0, 0, dz);

    // Шаг на ступеньку не выше stepHeight
    if (physics.stepHeight > 0 && (entity.onGround || (dy !== oldVelY && oldVelY < 0)) && (dx !== oldVelX || dz !== oldVelZ)) {
      const oldVelXCol = dx;
      const oldVelYCol = dy;
      const oldVelZCol = dz;
      const oldBBCol = playerBB.clone();

      dy = physics.stepHeight;
      const stepQueryBB = oldBB.clone().extend(oldVelX, dy, oldVelZ);
      const stepBBs = getSurroundingBBs(world, stepQueryBB);

      const BB1 = oldBB.clone();
      const BB2 = oldBB.clone();
      const BB_XZ = BB1.clone().extend(dx, 0, dz);

      let dy1 = dy;
      let dy2 = dy;
      for (const blockBB of stepBBs) {
        dy1 = blockBB.computeOffsetY(BB_XZ, dy1);
        dy2 = blockBB.computeOffsetY(BB2, dy2);
      }
      BB1.offset(0, dy1, 0);
      BB2.offset(0, dy2, 0);

      let dx1 = oldVelX;
      let dx2 = oldVelX;
      for (const blockBB of stepBBs) {
        dx1 = blockBB.computeOffsetX(BB1, dx1);
        dx2 = blockBB.computeOffsetX(BB2, dx2);
      }
      BB1.offset(dx1, 0, 0);
      BB2.offset(dx2, 0, 0);

      let dz1 = oldVelZ;
      let dz2 = oldVelZ;
      for (const blockBB of stepBBs) {
        dz1 = blockBB.computeOffsetZ(BB1, dz1);
        dz2 = blockBB.computeOffsetZ(BB2, dz2);
      }
      BB1.offset(0, 0, dz1);
      BB2.offset(0, 0, dz2);

      const norm1 = dx1 * dx1 + dz1 * dz1;
      const norm2 = dx2 * dx2 + dz2 * dz2;
      if (norm1 > norm2) {
        dx = dx1;
        dy = -dy1;
        dz = dz1;
        playerBB = BB1;
      } else {
        dx = dx2;
        dy = -dy2;
        dz = dz2;
        playerBB = BB2;
      }
      for (const blockBB of stepBBs) dy = blockBB.computeOffsetY(playerBB, dy);
      playerBB.offset(0, dy, 0);

      if (oldVelXCol * oldVelXCol + oldVelZCol * oldVelZCol >= dx * dx + dz * dz) {
        dx = oldVelXCol;
        dy = oldVelYCol;
        dz = oldVelZCol;
        playerBB = oldBBCol;
      }
    }

    setPositionToBB(playerBB, pos);
    const half = physics.playerHalfWidth;
    if (dx !== oldVelX) clearFace(pos, 'x', oldVelX < 0 ? playerBB.minX : playerBB.maxX, oldVelX < 0 ? 1 : -1, half);
    if (dz !== oldVelZ) clearFace(pos, 'z', oldVelZ < 0 ? playerBB.minZ : playerBB.maxZ, oldVelZ < 0 ? 1 : -1, half);
    if (dy !== oldVelY && oldVelY > 0) clearFace(pos, 'y', playerBB.maxY, -1, physics.playerHeight); // потолок
    entity.isCollidedHorizontally = dx !== oldVelX || dz !== oldVelZ;
    entity.isCollidedVertically = dy !== oldVelY;
    entity.onGround = entity.isCollidedVertically && oldVelY < 0;

    const blockAtFeet = world.getBlock(pos.offset(0, -0.2, 0));
    if (dx !== oldVelX) vel.x = 0;
    if (dz !== oldVelZ) vel.z = 0;
    if (dy !== oldVelY) {
      if (blockAtFeet && blockAtFeet.type === slimeBlockId && !entity.control.sneak) vel.y = -vel.y;
      else vel.y = 0;
    }

    // Блоки, в которых стоит тело: паутина, песок душ, мёд, пузырьковые колонны
    playerBB.contract(0.001, 0.001, 0.001);
    const cursor = new Vec3(0, 0, 0);
    for (cursor.y = Math.floor(playerBB.minY); cursor.y <= Math.floor(playerBB.maxY); cursor.y++) {
      for (cursor.z = Math.floor(playerBB.minZ); cursor.z <= Math.floor(playerBB.maxZ); cursor.z++) {
        for (cursor.x = Math.floor(playerBB.minX); cursor.x <= Math.floor(playerBB.maxX); cursor.x++) {
          const block = world.getBlock(cursor);
          if (!block) continue;
          if (supportFeature('velocityBlocksOnCollision')) {
            if (block.type === soulsandId) {
              vel.x *= physics.soulsandSpeed;
              vel.z *= physics.soulsandSpeed;
            } else if (block.type === honeyblockId) {
              vel.x *= physics.honeyblockSpeed;
              vel.z *= physics.honeyblockSpeed;
            }
          }
          if (block.type === webId) {
            entity.isInWeb = true;
          } else if (block.type === bubblecolumnId) {
            const down = !block.metadata;
            const aboveBlock = world.getBlock(cursor.offset(0, 1, 0));
            const bubbleDrag = aboveBlock && aboveBlock.type === airId ? physics.bubbleColumnSurfaceDrag : physics.bubbleColumnDrag;
            if (down) vel.y = Math.max(bubbleDrag.maxDown, vel.y - bubbleDrag.down);
            else vel.y = Math.min(bubbleDrag.maxUp, vel.y + bubbleDrag.up);
          }
        }
      }
    }
    if (supportFeature('velocityBlocksOnTop')) {
      const blockBelow = world.getBlock(entity.pos.floored().offset(0, -0.5, 0));
      if (blockBelow) {
        if (blockBelow.type === soulsandId) {
          vel.x *= physics.soulsandSpeed;
          vel.z *= physics.soulsandSpeed;
        } else if (blockBelow.type === honeyblockId) {
          vel.x *= physics.honeyblockSpeed;
          vel.z *= physics.honeyblockSpeed;
        }
      }
    }
  }

  function getLookingVector(entity) {
    const yaw = entity.yaw;
    const pitch = entity.pitch;
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);
    const sinPitch = Math.sin(pitch);
    const cosPitch = Math.cos(pitch);
    const lookX = -sinYaw * cosPitch;
    const lookY = sinPitch;
    const lookZ = -cosYaw * cosPitch;
    return { yaw, pitch, sinYaw, cosYaw, sinPitch, cosPitch, lookX, lookY, lookZ, lookDir: new Vec3(lookX, lookY, lookZ) };
  }

  function applyHeading(entity, strafe, forward, multiplier) {
    let speed = Math.sqrt(strafe * strafe + forward * forward);
    if (speed < 0.01) return;
    speed = multiplier / Math.max(speed, 1);
    strafe *= speed;
    forward *= speed;
    const yaw = Math.PI - entity.yaw;
    const sin = Math.sin(yaw);
    const cos = Math.cos(yaw);
    const vel = entity.vel;
    vel.x -= strafe * cos + forward * sin;
    vel.z += forward * cos - strafe * sin;
  }

  const climbableTrapdoorFeature = supportFeature('climbableTrapdoor');
  function isOnLadder(world, pos) {
    const block = world.getBlock(pos);
    if (!block) return false;
    if (block.type === ladderId || block.type === vineId) return true;
    if (scaffoldingId !== -1 && block.type === scaffoldingId) return true;
    // С 1.9 открытый люк прямо над лестницей и повёрнутый так же — тоже лестница.
    if (climbableTrapdoorFeature && trapdoorIds.has(block.type)) {
      const blockBelow = world.getBlock(pos.offset(0, -1, 0));
      if (!blockBelow || blockBelow.type !== ladderId) return false;
      const props = block._properties || {};
      if (!props.open) return false;
      return props.facing === blockBelow.getProperties().facing;
    }
    return false;
  }

  /** Скорость ходьбы (атрибут), с бегом — как в prismarine-physics. */
  function walkSpeed(entity, sprinting) {
    let speed;
    if (entity.attributes && entity.attributes[physics.movementSpeedAttribute]) speed = entity.attributes[physics.movementSpeedAttribute];
    else speed = attribute.createAttributeValue(physics.playerSpeed);
    speed = attribute.deleteAttributeModifier(speed, physics.sprintingUUID);
    if (sprinting && !attribute.checkAttributeModifier(speed, physics.sprintingUUID)) {
      speed = attribute.addAttributeModifier(speed, { uuid: physics.sprintingUUID, amount: physics.sprintSpeed, operation: 2 });
    }
    return attribute.getAttributeValue(speed);
  }

  /** LivingEntity.getFluidFallingAdjustedMovement: «тяжесть» в жидкости (бегущий в воде её не чувствует). */
  function fluidFalling(vel, gravity, falling, sprinting) {
    if (gravity === 0 || sprinting) return;
    if (falling && Math.abs(vel.y - 0.005) >= 0.003 && Math.abs(vel.y - gravity / 16) < 0.003) vel.y = -0.003;
    else vel.y -= gravity / 16;
  }

  function moveEntityWithHeading(entity, world, strafe, forward) {
    const vel = entity.vel;
    const pos = entity.pos;
    const sprinting = entity.sprinting;
    const gravityMultiplier = vel.y <= 0 && entity.slowFalling > 0 ? physics.slowFalling : 1;

    if (entity.isInWater || entity.isInLava) {
      // LivingEntity.travelInFluid
      const falling = vel.y <= 0;
      const lastY = pos.y;
      const gravity = physics.gravity * gravityMultiplier;
      if (entity.isInWater) {
        // LivingEntity.travelInWater (числа — float, как в игре)
        let slow = sprinting ? WATER_SPRINT_SLOWDOWN : WATER_SLOWDOWN;
        let accel = f32(0.02);
        let strider = Math.min(entity.depthStrider || 0, 3) / 3; // WATER_MOVEMENT_EFFICIENCY
        if (!entity.onGround) strider *= 0.5;
        if (strider > 0) {
          slow += (f32(0.54600006) - slow) * strider;
          accel += (walkSpeed(entity, sprinting) - accel) * strider;
        }
        if (entity.dolphinsGrace > 0) slow = f32(0.96);
        applyHeading(entity, strafe, forward, accel);
        moveEntity(entity, world, vel.x, vel.y, vel.z);
        if (entity.isCollidedHorizontally && isOnLadder(world, pos)) vel.y = 0.2;
        vel.x *= slow;
        vel.y *= FLUID_Y_DRAG;
        vel.z *= slow;
        fluidFalling(vel, gravity, falling, sprinting);
      } else {
        applyHeading(entity, strafe, forward, 0.02);
        moveEntity(entity, world, vel.x, vel.y, vel.z);
        if (entity.lavaHeight <= FLUID_JUMP_THRESHOLD) {
          vel.x *= 0.5;
          vel.y *= FLUID_Y_DRAG;
          vel.z *= 0.5;
          fluidFalling(vel, gravity, falling, sprinting);
        } else {
          vel.x *= 0.5;
          vel.y *= 0.5;
          vel.z *= 0.5;
        }
        if (gravity !== 0) vel.y += -gravity / 4;
      }
      if (entity.isCollidedHorizontally && isFree(world, pos, vel.x, vel.y + OUT_OF_LIQUID_STEP - pos.y + lastY, vel.z)) {
        vel.y = OUT_OF_LIQUID_IMPULSE; // выбраться из жидкости на берег
      }
    } else if (entity.elytraFlying) {
      const { pitch, sinPitch, cosPitch, lookDir } = getLookingVector(entity);
      const horizontalSpeed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
      const cosPitchSquared = cosPitch * cosPitch;
      vel.y += physics.gravity * gravityMultiplier * (-1.0 + cosPitchSquared * 0.75);
      if (vel.y < 0.0 && cosPitch > 0.0) {
        const movingDownSpeedModifier = vel.y * -0.1 * cosPitchSquared;
        vel.x += (lookDir.x * movingDownSpeedModifier) / cosPitch;
        vel.y += movingDownSpeedModifier;
        vel.z += (lookDir.z * movingDownSpeedModifier) / cosPitch;
      }
      if (pitch > 0.0 && cosPitch > 0.0) {
        const lookDownSpeedModifier = horizontalSpeed * sinPitch * 0.04;
        vel.x += (-lookDir.x * lookDownSpeedModifier) / cosPitch;
        vel.y += lookDownSpeedModifier * 3.2;
        vel.z += (-lookDir.z * lookDownSpeedModifier) / cosPitch;
      }
      if (cosPitch > 0.0) {
        vel.x += ((lookDir.x / cosPitch) * horizontalSpeed - vel.x) * 0.1;
        vel.z += ((lookDir.z / cosPitch) * horizontalSpeed - vel.z) * 0.1;
      }
      vel.x *= 0.99;
      vel.y *= 0.98;
      vel.z *= 0.99;
      moveEntity(entity, world, vel.x, vel.y, vel.z);
      if (entity.onGround) entity.elytraFlying = false;
    } else {
      // Обычное движение
      let acceleration = 0.0;
      let inertia = 0.0;
      const blockUnder = world.getBlock(pos.offset(0, -1, 0));
      if (entity.onGround && blockUnder) {
        inertia = (blockSlipperiness[blockUnder.type] || physics.defaultSlipperiness) * 0.91;
        acceleration = walkSpeed(entity, sprinting) * (0.1627714 / (inertia * inertia * inertia));
        if (acceleration < 0) acceleration = 0;
      } else {
        acceleration = physics.airborneAcceleration;
        inertia = physics.airborneInertia;
        if (sprinting) acceleration += physics.airborneAcceleration * 0.3;
      }

      applyHeading(entity, strafe, forward, acceleration);

      if (isOnLadder(world, pos)) {
        vel.x = clamp(-physics.ladderMaxSpeed, vel.x, physics.ladderMaxSpeed);
        vel.z = clamp(-physics.ladderMaxSpeed, vel.z, physics.ladderMaxSpeed);
        vel.y = Math.max(vel.y, entity.control.sneak ? 0 : -physics.ladderMaxSpeed);
      }

      moveEntity(entity, world, vel.x, vel.y, vel.z);

      if (isOnLadder(world, pos) && (entity.isCollidedHorizontally || (supportFeature('climbUsingJump') && entity.control.jump))) {
        vel.y = physics.ladderClimbSpeed;
      }

      if (entity.levitation > 0) vel.y += (0.05 * entity.levitation - vel.y) * 0.2;
      else vel.y -= physics.gravity * gravityMultiplier;
      vel.y *= physics.airdrag;
      vel.x *= inertia;
      vel.z *= inertia;
    }
  }

  /** LivingEntity.jumpFromGround: обычный прыжок (не ниже уже набранной скорости вверх), с бегом — рывок вперёд. */
  function jumpFromGround(entity, world) {
    const vel = entity.vel;
    const blockBelow = world.getBlock(entity.pos.floored().offset(0, -0.5, 0));
    let power = f32(0.42) * (blockBelow && blockBelow.type === honeyblockId ? physics.honeyblockJumpSpeed : 1);
    if (entity.jumpBoost > 0) power += 0.1 * entity.jumpBoost;
    if (power <= 1.0e-5) return;
    vel.y = Math.max(power, vel.y);
    if (entity.sprinting) {
      const yaw = Math.PI - entity.yaw;
      vel.x -= Math.sin(yaw) * 0.2;
      vel.z += Math.cos(yaw) * 0.2;
    }
  }

  physics.simulatePlayer = (entity, world) => {
    const vel = entity.vel;
    const pos = entity.pos;
    const control = entity.control;
    const height = control.sneak ? SNEAK_HEIGHT : physics.playerHeight;

    // Entity.baseTick: сначала вода, потом лава — касание, глубина и снос течением.
    const water = fluidContact(world, pos, vel, height, false, WATER_PUSH);
    if (water.push) vel.add(water.push);
    const lava = fluidContact(world, pos, vel, height, true, entity.ultraWarm ? LAVA_PUSH_ULTRAWARM : LAVA_PUSH);
    if (lava.push) vel.add(lava.push);
    entity.isInWater = water.touching;
    entity.waterHeight = water.depth;
    entity.isInLava = lava.depth > 0;
    entity.lavaHeight = lava.depth;
    entity.eyeInWater = entity.isInWater && eyeInWater(world, pos, control.sneak);
    // Бег: в воде, пока голова над водой, игра его выключает (LocalPlayer.aiStep).
    entity.sprinting = Boolean(control.sprint) && !(entity.isInWater && !entity.eyeInWater);

    // LivingEntity.aiStep: малая скорость гасится.
    if (playerThreshold) {
      if (vel.x * vel.x + vel.z * vel.z < 9.0e-6) {
        vel.x = 0;
        vel.z = 0;
      }
    } else {
      if (Math.abs(vel.x) < physics.negligeableVelocity) vel.x = 0;
      if (Math.abs(vel.z) < physics.negligeableVelocity) vel.z = 0;
    }
    if (Math.abs(vel.y) < physics.negligeableVelocity) vel.y = 0;

    // Прыжок
    if (control.jump || entity.jumpQueued) {
      if (entity.jumpTicks > 0) entity.jumpTicks--;
      const depth = entity.isInLava ? entity.lavaHeight : entity.waterHeight;
      const swimming = entity.isInWater && depth > 0;
      const shallow = !(depth > FLUID_JUMP_THRESHOLD);
      if (swimming && !(entity.onGround && shallow)) {
        vel.y += LIQUID_JUMP; // гребок вверх
      } else if (entity.isInLava && !(entity.onGround && shallow)) {
        vel.y += LIQUID_JUMP;
      } else if (entity.onGround && entity.jumpTicks === 0) {
        jumpFromGround(entity, world);
        entity.jumpTicks = physics.autojumpCooldown;
      }
    } else {
      entity.jumpTicks = 0;
    }
    entity.jumpQueued = false;

    let strafe = (control.right - control.left) * 0.98;
    let forward = (control.forward - control.back) * 0.98;
    if (control.sneak) {
      strafe *= physics.sneakSpeed;
      forward *= physics.sneakSpeed;
    }

    entity.elytraFlying = entity.elytraFlying && entity.elytraEquipped && !entity.onGround && !entity.levitation;
    if (entity.fireworkRocketDuration > 0) {
      if (!entity.elytraFlying) {
        entity.fireworkRocketDuration = 0;
      } else {
        const { lookDir } = getLookingVector(entity);
        vel.x += lookDir.x * 0.1 + (lookDir.x * 1.5 - vel.x) * 0.5;
        vel.y += lookDir.y * 0.1 + (lookDir.y * 1.5 - vel.y) * 0.5;
        vel.z += lookDir.z * 0.1 + (lookDir.z * 1.5 - vel.z) * 0.5;
        --entity.fireworkRocketDuration;
      }
    }

    moveEntityWithHeading(entity, world, strafe, forward);
    return entity;
  };

  /** Есть ли у этой версии правила жидкостей 1.13+ (для 1.8–1.12 — prismarine-physics как есть). */
  physics.modernFluids = supportFeature('proportionalLiquidGravity');
  /** Вода там, где стоит бот (как посчитает следующий тик): { touching, depth, push }. */
  physics.fluidContact = (world, pos, vel, sneak = false) => fluidContact(world, pos, vel, sneak ? SNEAK_HEIGHT : physics.playerHeight, false, WATER_PUSH);
  return physics;
}

module.exports = { createSimulator };
