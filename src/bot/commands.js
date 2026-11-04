'use strict';

// Команды панели: строка чата, начинающаяся с «#», не уходит на сервер, а выполняется ботом через безопасные
// действия (src/bot/actions.js). Нужны, чтобы проверить действия руками, пока нет системы задач.
// Координаты — как в игре: числа или «~» (относительно бота): #goto ~5 ~ ~-3.

const { Vec3 } = require('vec3');

const HELP = [
  '#pos — где бот и куда смотрит',
  '#look <поворот> <наклон> — повернуть голову (градусы, как в F3: наклон вниз — плюс)',
  '#goto <x> <y> <z> [бег] — дойти по прямой (поиска пути пока нет, до 64 блоков)',
  '#dig <x> <y> <z> — сломать блок',
  '#place <x> <y> <z> [предмет] — поставить блок (например, #place ~1 ~ ~ cobblestone)',
  '#use <x> <y> <z> — нажать на блок (сундук, дверь, кнопка)',
  '#equip <предмет> — взять предмет в руку',
  '#stop — остановить действие',
  '#help — этот список',
];

const MAX_WALK = 64;

class CommandError extends Error {}

function parseCoord(token, base) {
  const t = String(token === undefined ? '' : token).trim();
  if (t.startsWith('~')) {
    const rest = t.slice(1);
    const add = rest === '' ? 0 : Number(rest);
    if (!Number.isFinite(add)) throw new CommandError(`непонятная координата «${t}»`);
    return base + add;
  }
  const v = Number(t.replace(',', '.'));
  if (t === '' || !Number.isFinite(v)) throw new CommandError(`непонятная координата «${t}»`);
  return v;
}

/** Точка из трёх слов: блочные координаты (целые), «~» — от клетки, где стоит бот. */
function parseBlockPos(args, botPos) {
  if (args.length < 3) throw new CommandError('нужны три координаты: x y z');
  const base = botPos.floored();
  return new Vec3(Math.floor(parseCoord(args[0], base.x)), Math.floor(parseCoord(args[1], base.y)), Math.floor(parseCoord(args[2], base.z)));
}

const round = (n, d = 1) => Number(n).toFixed(d);
const toDeg = (rad) => (rad * 180) / Math.PI;
// Углы как в F3: поворот 0 — юг, 90 — запад; наклон вниз — плюс.
const f3Yaw = (yawRad) => (((180 - toDeg(yawRad) + 180) % 360) + 360) % 360 - 180;
const f3Pitch = (pitchRad) => -toDeg(pitchRad);

/**
 * Выполнить команду. log(level, text) — куда писать результат (консоль панели).
 * @returns {Promise<boolean>} true — команда понята (даже если действие не удалось)
 */
async function runCommand(bot, line, log) {
  const [rawName, ...args] = String(line).trim().slice(1).split(/\s+/);
  const name = (rawName || '').toLowerCase();
  if (!bot || !bot.entity) {
    log('warn', 'Команда не выполнена: бот не в мире');
    return true;
  }
  if (!bot.actions) {
    log('warn', 'Команда не выполнена: действия работают только со своей физикой бота');
    return true;
  }
  const a = bot.actions;
  try {
    switch (name) {
      case '':
      case 'help':
      case 'помощь':
        log('info', 'Команды бота (пишутся в строке чата, на сервер не уходят):');
        for (const line of HELP) log('info', line);
        return true;
      case 'pos': {
        const p = bot.entity.position;
        const v = bot.serverView;
        log('info', `Бот: ${round(p.x, 2)} ${round(p.y, 2)} ${round(p.z, 2)}, взгляд ${round(f3Yaw(v.yaw))} / ${round(f3Pitch(v.pitch))}` +
          `${a.current ? `, сейчас: ${a.current}` : ''}`);
        const hit = a.lookedAtBlock();
        if (hit) log('info', `Смотрит на ${hit.block.name} в ${hit.position.x} ${hit.position.y} ${hit.position.z}`);
        return true;
      }
      case 'look': {
        if (args.length < 2) throw new CommandError('нужно два числа: поворот и наклон, например #look 90 0');
        const yawF3 = parseCoord(args[0], f3Yaw(bot.serverView.yaw));
        const pitchF3 = Math.max(-90, Math.min(90, parseCoord(args[1], f3Pitch(bot.serverView.pitch))));
        await a.look(((180 - yawF3) * Math.PI) / 180, (-pitchF3 * Math.PI) / 180);
        // Фактический взгляд: из-за шага мыши (0,15°) он может отличаться от заданного на долю градуса.
        log('ok', `Повернулся: ${round(f3Yaw(bot.serverView.yaw))} / ${round(f3Pitch(bot.serverView.pitch))}`);
        return true;
      }
      case 'goto': {
        const base = bot.entity.position;
        if (args.length < 3) throw new CommandError('нужны три координаты: x y z');
        const target = new Vec3(parseCoord(args[0], base.x), parseCoord(args[1], base.y), parseCoord(args[2], base.z));
        // Целые координаты — центр блока, как в игре.
        for (const k of ['x', 'z']) if (/^-?\d+$/.test(args[k === 'x' ? 0 : 2])) target[k] += 0.5;
        const dist = base.distanceTo(target);
        if (dist > MAX_WALK) throw new CommandError(`слишком далеко (${Math.round(dist)} блоков): по прямой — не больше ${MAX_WALK}`);
        const sprint = args.slice(3).some((w) => /^(бег|sprint|run)$/i.test(w));
        log('info', `Иду к ${round(target.x)} ${round(target.y)} ${round(target.z)}${sprint ? ' бегом' : ''}…`);
        await a.walkTo(target, { sprint });
        log('ok', 'Дошёл');
        return true;
      }
      case 'dig': {
        const pos = parseBlockPos(args, bot.entity.position);
        const res = await a.dig(pos);
        log('ok', `Сломал блок ${pos.x} ${pos.y} ${pos.z} (грань: ${res.face}, ${res.ticks} тиков)`);
        return true;
      }
      case 'place': {
        const pos = parseBlockPos(args, bot.entity.position);
        const res = await a.place(pos, { item: args[3] });
        log('ok', `Поставил блок в ${pos.x} ${pos.y} ${pos.z} (опора: ${res.against.x} ${res.against.y} ${res.against.z}, грань: ${res.face})`);
        return true;
      }
      case 'use': {
        const pos = parseBlockPos(args, bot.entity.position);
        const res = await a.activate(pos);
        log('ok', `Нажал на ${res.block} в ${pos.x} ${pos.y} ${pos.z}`);
        return true;
      }
      case 'equip': {
        if (!args[0]) throw new CommandError('какой предмет? например #equip iron_pickaxe');
        await a.equip(args[0]);
        log('ok', `В руке: ${bot.heldItem ? bot.heldItem.name : 'ничего'}`);
        return true;
      }
      case 'stop': {
        const had = a.stop();
        log(had ? 'ok' : 'info', had ? 'Остановлено' : 'Бот ничего не делал');
        return true;
      }
      default:
        log('warn', `Неизвестная команда «#${rawName}». Список: #help`);
        return true;
    }
  } catch (err) {
    if (err && (err.code === 'replaced' || err.code === 'stopped')) {
      log('info', `#${name}: ${err.message}`);
    } else {
      log('error', `#${name}: ${err && err.message ? err.message : err}`);
    }
    return true;
  }
}

module.exports = { runCommand, parseCoord, parseBlockPos, HELP, f3Yaw, f3Pitch };
