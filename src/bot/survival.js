'use strict';

// Выжить за работой (добыча): есть, когда голоден, и давать отпор мобам — пауки, скелеты, зомби, криперы…
// От крипера — щит во второй руке: лицом к нему, щит поднят, пока не взорвётся или не уйдёт (щит закрывает и от
// взрыва спереди). Без щита — бить, пока не подошёл вплотную; зашипел рядом — отойти.
// Сторож (createGuard) раз в 4 тика смотрит вокруг: враг рядом или пора поесть — прерывает текущее действие
// (код «threat»), добыча отбивается или ест (handle) и продолжает с того же места.

const { Vec3 } = require('vec3');
const { raycastBlocks } = require('./actions');

// Нападают сами. Стрелки бьют издалека — к ним надо подойти.
const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'bogged', 'spider', 'cave_spider', 'creeper',
  'silverfish', 'endermite', 'witch', 'slime', 'magma_cube', 'pillager', 'vindicator', 'evoker', 'ravager', 'vex',
  'phantom', 'blaze', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin', 'guardian', 'breeze', 'creaking',
]);
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'witch', 'blaze', 'breeze', 'guardian']);
const DETECT = 6; // ближе — отбиваться (и не сквозь стену: в соседней пещере — не враг)
const DETECT_RANGED = 12;
const CREEPER_SHIELD = 4.5; // крипер ближе — поднять щит
const CREEPER_SWELL = 3; // ближе крипер начинает шипеть (SwellGoal), взрыв — через 1,5 с
const FIGHT_IDLE_TICKS = 30; // врагов нет полторы секунды — отбился
const IGNORE_MS = 20000; // кого не достать (за забором, на уступе) — столько не отвлекаться на него снова
const APPROACH_AFTER_MS = 2000; // моб ближнего боя столько не подходит сам — подойти к нему
const KILL_WINDOW_MS = 5000; // умер в столько после удара бота — «отбился»

// Еда: сначала хорошая; плоды и сырое (могут быть нужны для заданий Фермера) — только когда совсем голоден.
const FOOD_GOOD = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'rabbit_stew',
  'pumpkin_pie', 'bread', 'baked_potato', 'cooked_cod', 'cooked_rabbit', 'mushroom_stew', 'beetroot_soup', 'cookie', 'dried_kelp',
];
const FOOD_LOW = ['apple', 'carrot', 'melon_slice', 'sweet_berries', 'glow_berries', 'beetroot', 'potato', 'beef', 'porkchop', 'mutton', 'rabbit', 'salmon', 'cod', 'chicken'];
// Не еда для бота: травит, голодит или телепортирует. Вёдра с рыбой — тоже не еда. Золотые яблоки — на крайний случай.
const FOOD_BAD = new Set(['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'suspicious_stew', 'chorus_fruit', 'chicken']);
const FOOD_LAST = ['golden_apple', 'enchanted_golden_apple'];

// ---------- огонь и зелья огнестойкости (Незер) ----------

const FIRE_POTIONS = ['long_fire_resistance', 'fire_resistance']; // долгое — первым
const { potionOf } = require('./item-hash');

/** Номер эффекта «Огнестойкость» (реестр 1.21: 11). */
const fireResEffect = (bot) => {
  const e = bot.registry && bot.registry.effectsByName ? bot.registry.effectsByName.FireResistance : null;
  return e ? e.id : 11;
};

/** Действует ли огнестойкость. */
function hasFireRes(bot) {
  const eff = bot.entity && bot.entity.effects;
  return Boolean(eff && eff[fireResEffect(bot)]);
}

/** Горит или в лаве (флаг «горит» — бит 0x01 в метаданных сущности). */
function burning(bot) {
  const e = bot.entity;
  if (!e) return false;
  const flags = e.metadata ? e.metadata[0] : 0;
  return Boolean((typeof flags === 'number' && flags & 1) || e.isInLava);
}

/** Зелья огнестойкости в инвентаре (предметы; долгие — первыми). */
function fireResPotions(bot) {
  const slots = bot.inventory && bot.inventory.slots ? bot.inventory.slots : [];
  return slots.filter((it, i) => it && i >= 9 && it.name === 'potion' && FIRE_POTIONS.includes(potionOf(it)))
    .sort((a, b) => FIRE_POTIONS.indexOf(potionOf(a)) - FIRE_POTIONS.indexOf(potionOf(b)));
}

/** Выпить зелье огнестойкости (если горит, а огнестойкости нет). → true — выпил. */
async function drinkFireRes(bot) {
  const potion = fireResPotions(bot)[0];
  if (!potion || !bot.actions || !bot.actions.drink) return false;
  try {
    await bot.actions.drink(potion);
    return true;
  } catch (err) {
    if (isStop(err)) throw err;
    return false;
  }
}

/** Годится ли предмет в еду (любая еда игры, кроме вредной и вёдер). */
function isFood(name, registry = null) {
  const n = String(name || '');
  if (!n || FOOD_BAD.has(n) || n.endsWith('_bucket')) return false;
  if (FOOD_GOOD.includes(n) || FOOD_LOW.includes(n) || FOOD_LAST.includes(n)) return true;
  return Boolean(registry && registry.foodsByName && registry.foodsByName[n]);
}

/** Насколько хороша еда (меньше — лучше): хорошая, прочая еда, плоды и сырое (для заданий), золотые яблоки. */
function foodRank(name) {
  const good = FOOD_GOOD.indexOf(name);
  if (good >= 0) return good;
  if (FOOD_LAST.includes(name)) return 300;
  if (FOOD_LOW.includes(name)) return 200 + FOOD_LOW.indexOf(name);
  return 100;
}
const EAT_AT = 14; // сытость (из 20) — пора поесть
const EAT_LOW = 6; // совсем голоден — годится и то, что для заданий

const SWORDS = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword'];
const AXES = ['netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'golden_axe', 'wooden_axe'];

/** Пауза между ударами под оружие (полная сила удара в 1.21): меч — 0,625 с, топор — около 1 с, кирка — 0,83 с. */
function cooldownFor(item) {
  const name = item ? item.name : '';
  if (/_sword$/.test(name)) return 13;
  if (/_axe$/.test(name)) return 21;
  if (/_pickaxe$/.test(name)) return 17;
  if (/_shovel$/.test(name)) return 20;
  if (name === 'trident') return 19;
  if (name === 'mace') return 34;
  return 10;
}

/**
 * Время (мс) — по часам действий бота: паузы («ждать 2 с, потом подойти») должны идти вместе с тиками бота.
 * В тестах часы подменены: по настоящим (Date.now) на быстром компьютере 2 с — это тысячи «тиков» теста.
 */
const nowOf = (bot) => (bot.actions && typeof bot.actions.now === 'function' ? bot.actions.now() : Date.now());

const inventoryItems = (bot) => (bot.inventory && bot.inventory.slots ? bot.inventory.slots.filter(Boolean) : []);
const hasItem = (bot, name) => inventoryItems(bot).some((it) => it.name === name);
const hasCustomName = (e) => {
  try {
    return typeof e.getCustomName === 'function' && Boolean(e.getCustomName());
  } catch (_) {
    return false;
  }
};

/** Лучшее оружие в инвентаре (меч, нет — топор) или null — бить тем, что в руке. */
function bestWeapon(bot) {
  return [...SWORDS, ...AXES].find((n) => hasItem(bot, n)) || null;
}

/** Что съесть сейчас (имя) или null: нечего или не голоден. */
function pickFood(bot) {
  const food = typeof bot.food === 'number' ? bot.food : 20;
  const lists = food <= EAT_LOW ? [FOOD_GOOD, FOOD_LOW] : [FOOD_GOOD];
  for (const list of lists) {
    const name = list.find((n) => hasItem(bot, n));
    if (name) return name;
  }
  // Прочая еда (пироги, супы, мёд…) — любая, кроме вредной; золотые яблоки — когда совсем голоден.
  const other = inventoryItems(bot).map((it) => it.name)
    .filter((n) => isFood(n, bot.registry) && !FOOD_LOW.includes(n) && (food <= EAT_LOW || !FOOD_LAST.includes(n)))
    .sort((a, b) => foodRank(a) - foodRank(b));
  return other[0] || null;
}

/** Пора поесть: сытость низкая (или мало здоровья, а восстановиться нечем) и есть что. */
function needsFood(bot) {
  if (typeof bot.food !== 'number' || bot.food >= 20) return false;
  const hurt = typeof bot.health === 'number' && bot.health < 14 && bot.food < 18;
  return (bot.food <= EAT_AT || hurt) && Boolean(pickFood(bot));
}

/** Шипит ли крипер (вот-вот взорвётся). */
function fusing(bot, e) {
  if (!e || e.name !== 'creeper' || !Array.isArray(e.metadata)) return false;
  const keys = (bot.registry.entitiesByName.creeper && bot.registry.entitiesByName.creeper.metadataKeys) || [];
  const swell = keys.indexOf('swell_dir');
  const ignited = keys.indexOf('is_ignited');
  return (swell >= 0 && e.metadata[swell] > 0) || (ignited >= 0 && e.metadata[ignited] === true);
}

/** Видно ли сущность глазами (между глазами бота и её серединой нет блоков). */
function visible(bot, eye, e) {
  const target = e.position.offset(0, (e.height || 1.8) * 0.6, 0);
  const d = target.minus(eye);
  const dist = d.norm();
  if (dist < 1e-6) return true;
  const hit = raycastBlocks((p) => bot.blockAt(p, false), eye, d.scaled(1 / dist), dist, (block) => block.shapes || []);
  return !hit;
}

/** Здоровье сущности из её данных (у живых — номер «health» в metadata) или null. */
function healthOf(bot, e) {
  if (!Array.isArray(e.metadata)) return null;
  const info = bot.registry && bot.registry.entitiesByName ? bot.registry.entitiesByName[e.name] : null;
  const i = info && Array.isArray(info.metadataKeys) ? info.metadataKeys.indexOf('health') : -1;
  return i >= 0 && typeof e.metadata[i] === 'number' ? e.metadata[i] : null;
}

/** Враги рядом (видно и близко), ближние первыми. ignore — номера сущностей, на которых не отвлекаться. */
function threats(bot, ignore = new Map()) {
  if (!bot.entity || !bot.entity.position) return [];
  const me = bot.entity.position;
  const eye = me.offset(0, 1.62, 0);
  const now = nowOf(bot);
  const out = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!e || e === bot.entity || !e.position || !HOSTILE.has(e.name) || hasCustomName(e)) continue;
    const hp = healthOf(bot, e);
    if (hp !== null && hp <= 0) continue; // уже умер (ещё падает) — не враг

    const until = ignore.get(e.id);
    if (until && until > now) continue;
    const d = e.position.distanceTo(me);
    if (d > (RANGED.has(e.name) ? DETECT_RANGED : DETECT) || Math.abs(e.position.y - me.y) > 4) continue;
    if (!visible(bot, eye, e)) continue;
    out.push({ e, d });
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.e);
}

const isStop = (err) => Boolean(err && ['stopped', 'replaced', 'interrupted', 'not_ready'].includes(err.code));

/** Отойти от крипера (по пути, без копания) на 7 блоков — дальше он перестаёт шипеть. */
async function stepBack(bot, creeper) {
  const me = bot.entity.position;
  const away = me.minus(creeper.position);
  away.y = 0;
  const len = Math.hypot(away.x, away.z) || 1;
  const to = me.plus(new Vec3((away.x / len) * 7, 0, (away.z / len) * 7));
  try {
    await bot.actions.goTo(to, { range: 2.5, vertical: 2, maxDistance: 16 });
  } catch (err) {
    if (isStop(err)) throw err;
  }
}

/**
 * Отбиться от врагов рядом: оружие в руку; крипер близко — щит (есть во второй руке) или отойти, если шипит;
 * кого достать с места — бить; стрелка или далёкого — подойти. Врагов нет 1,5 с — всё. → { kills, blocked }
 */
async function defend(bot, { ignore = new Map(), maxMs = 60000 } = {}) {
  const started = nowOf(bot);
  const weapon = bestWeapon(bot);
  if (weapon && (!bot.heldItem || bot.heldItem.name !== weapon)) await bot.actions.equip(weapon);
  const hitAt = new Map();
  let kills = 0;
  let blocked = 0;
  const killed = [];
  // Отбился — умер тот, кого бот бил недавно (добил ли он сам или, скажем, взрыв крипера рядом).
  const onDead = (e) => {
    if (!e || !hitAt.has(e.id) || nowOf(bot) - hitAt.get(e.id) > KILL_WINDOW_MS) return;
    hitAt.delete(e.id);
    kills += 1;
    killed.push(e.name);
  };
  bot.on('entityDead', onDead);
  let idle = 0;
  const waitingFor = new Map(); // кого ждём, когда подойдёт: номер → с какого времени
  // Пока бот ждёт, подходит или бьёт другого — крипер подошёл или зашипел: прервать это и закрыться щитом.
  let interruptible = false;
  let tick = 0;
  const creeperNear = () => threats(bot, ignore).some((e) => e.name === 'creeper' && (e.position.distanceTo(bot.entity.position) < CREEPER_SHIELD || fusing(bot, e)));
  const watch = () => {
    if (!interruptible || (tick += 1) % 2) return;
    if (creeperNear() && bot.actions.busy) bot.actions.interrupt('крипер рядом', 'threat');
  };
  bot.on('physicsTick', watch);
  // Действие, которое можно прервать ради крипера: прервали — просто оглядеться заново (щит — следующим шагом).
  const interruptibly = async (fn) => {
    interruptible = true;
    try {
      return await fn();
    } catch (err) {
      if (err && err.code === 'threat') return undefined;
      throw err;
    } finally {
      interruptible = false;
    }
  };
  try {
    while (nowOf(bot) - started < maxMs) {
      // Опаснее всего — крипер, который подошёл или шипит: он первым, даже если ближе зомби. Крипер подальше —
      // не цель (к нему не идём: взорвётся рядом), пока бьём остальных.
      const list = threats(bot, ignore);
      const dist = (e) => e.position.distanceTo(bot.entity.position);
      const close = list.find((e) => e.name === 'creeper' && (dist(e) < CREEPER_SHIELD || (fusing(bot, e) && dist(e) < 7)));
      const t = close || list.find((e) => e.name !== 'creeper') || list[0];
      if (!t) {
        if (idle >= FIGHT_IDLE_TICKS) break;
        await interruptibly(() => bot.actions.wait(250));
        idle += 5;
        continue;
      }
      idle = 0;
      const d = dist(t);
      const off = bot.inventory && bot.inventory.slots ? bot.inventory.slots[45] : null;
      if (t.name === 'creeper') {
        if (off && off.name === 'shield' && (d < CREEPER_SHIELD || fusing(bot, t))) {
          try {
            await bot.actions.shield(t, { maxTicks: 50, until: () => !fusing(bot, t) && t.position.distanceTo(bot.entity.position) > CREEPER_SHIELD + 1 });
            blocked += 1;
          } catch (err) {
            if (isStop(err)) throw err;
          }
          continue;
        }
        if (fusing(bot, t) && d < CREEPER_SWELL + 1) {
          await stepBack(bot, t);
          continue;
        }
        if (bot.actions.canHit(t)) {
          hitAt.set(t.id, nowOf(bot));
          try {
            await bot.actions.attack(t, { cooldownTicks: cooldownFor(bot.heldItem) });
          } catch (err) {
            if (isStop(err)) throw err;
          }
          continue;
        }
        await interruptibly(() => bot.actions.wait(150)); // далеко — ждать, пока подойдёт (тогда — щит или удар); к нему не идём
        continue;
      }
      if (bot.actions.canHit(t)) {
        hitAt.set(t.id, nowOf(bot));
        waitingFor.delete(t.id); // подошёл — ждать его снова, если отлетит от удара
        try {
          await interruptibly(() => bot.actions.attack(t, { cooldownTicks: cooldownFor(bot.heldItem) }));
          hitAt.set(t.id, nowOf(bot));
        } catch (err) {
          if (isStop(err)) throw err;
        }
        continue;
      }
      // Не достать с места. Зомби, паук и прочие идут к боту сами — ждать, повернувшись к нему (навстречу не идём:
      // так он бьёт первым); не идёт 2 с — подойти. Стрелок сам не подойдёт — к нему сразу. Подходить — короткими
      // рывками (потом снова оглядеться: вдруг крипер); не выходит подойти — не отвлекаться на него какое-то время.
      const now = nowOf(bot);
      const since = waitingFor.has(t.id) ? waitingFor.get(t.id) : now;
      waitingFor.set(t.id, since);
      if (RANGED.has(t.name) || now - since > APPROACH_AFTER_MS) {
        try {
          if (d <= 8) await interruptibly(() => bot.actions.walkTo(t.position.clone(), { range: 1.8, timeoutMs: 800 }));
          else await interruptibly(() => bot.actions.goTo(t.position.clone(), { range: 2, vertical: 2, maxDistance: 16 }));
        } catch (err) {
          if (isStop(err)) throw err;
          if (err && err.code !== 'threat' && err.code !== 'timeout') {
            ignore.set(t.id, nowOf(bot) + IGNORE_MS);
            waitingFor.delete(t.id);
          }
        }
        continue;
      }
      if (typeof bot.lookAt === 'function') bot.lookAt(t.position.offset(0, (t.height || 1.8) * 0.7, 0), true);
      await interruptibly(() => bot.actions.wait(150));
    }
  } finally {
    bot.removeListener('entityDead', onDead);
    bot.removeListener('physicsTick', watch);
  }
  return { kills, blocked, killed };
}

/** Поесть, если голоден и есть что. → true — поел. */
async function eatIfHungry(bot) {
  if (!needsFood(bot)) return false;
  const food = pickFood(bot);
  try {
    await bot.actions.eat(food);
    return true;
  } catch (err) {
    if (isStop(err)) throw err;
    return false;
  }
}

/** Щит — во вторую руку (если есть и там ещё не он). */
async function prepareShield(bot) {
  const off = bot.inventory && bot.inventory.slots ? bot.inventory.slots[45] : null;
  if ((off && off.name === 'shield') || !hasItem(bot, 'shield') || !bot.actions.equipOffhand) return false;
  try {
    await bot.actions.equipOffhand('shield');
    return true;
  } catch (err) {
    if (isStop(err)) throw err;
    return false;
  }
}

/**
 * Сторож на время работы: враг рядом или пора поесть — прерывает текущее действие (ошибка с кодом «threat»);
 * работа ловит её и зовёт handle() — отбиться и поесть, потом продолжает. → { start, stop, wants, handle, stats }
 */
function createGuard(bot) {
  let active = false;
  let busy = false;
  let tick = 0;
  const ignore = new Map();
  let eatFailedAt = -Infinity;
  let drinkFailedAt = -Infinity;
  const stats = { kills: 0, killed: [], ate: 0, fights: 0, blocked: 0, hungry: false, drank: 0, burnedNoPotion: false };
  const wants = () => {
    // Горит (или в лаве), огнестойкости нет — первым делом выпить зелье огнестойкости.
    if (burning(bot) && !hasFireRes(bot)) {
      if (fireResPotions(bot).length && nowOf(bot) - drinkFailedAt > 3000) return 'fire';
      stats.burnedNoPotion = !fireResPotions(bot).length || stats.burnedNoPotion;
    }
    if (threats(bot, ignore).length) return 'threat';
    if (needsFood(bot) && nowOf(bot) - eatFailedAt > 30000) return 'food';
    if (typeof bot.food === 'number' && bot.food <= EAT_LOW && !pickFood(bot)) stats.hungry = true;
    return null;
  };
  const onTick = () => {
    if (!active || busy || (tick += 1) % 4) return;
    if (wants() && bot.actions && bot.actions.busy) bot.actions.interrupt('горит, рядом враг или пора поесть', 'threat');
  };
  bot.on('physicsTick', onTick);
  return {
    start() {
      active = true;
    },
    stop() {
      active = false;
      bot.removeListener('physicsTick', onTick);
    },
    wants,
    stats,
    get busy() {
      return busy;
    },
    /** Отбиться и поесть (если нужно). */
    async handle() {
      if (busy) return;
      busy = true;
      try {
        for (let round = 0; round < 6; round += 1) {
          const w = wants();
          if (!w) break;
          if (w === 'fire') {
            if (await drinkFireRes(bot)) stats.drank += 1;
            else drinkFailedAt = nowOf(bot);
          } else if (w === 'threat') {
            stats.fights += 1;
            const r = await defend(bot, { ignore });
            stats.kills += r.kills;
            stats.killed.push(...r.killed);
            stats.blocked += r.blocked;
          } else if (await eatIfHungry(bot)) {
            stats.ate += 1;
          } else {
            eatFailedAt = nowOf(bot);
          }
        }
      } finally {
        busy = false;
      }
    },
  };
}

module.exports = {
  HOSTILE, RANGED, FOOD_GOOD, FOOD_LOW, FOOD_BAD, EAT_AT, isFood, foodRank, cooldownFor, bestWeapon, pickFood, needsFood, fusing, threats, defend,
  eatIfHungry, prepareShield, createGuard, FIRE_POTIONS, hasFireRes, burning, fireResPotions, drinkFireRes,
};
