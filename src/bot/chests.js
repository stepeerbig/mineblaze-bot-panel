'use strict';

// Сундуки: достать предметы в инвентарь бота и положить из инвентаря — shift-кликом по стопке, как человек.
// Паузы между кликами и ожидание ответа сервера — в bot.actions.clickSlot; сам перенос бот считает так же,
// как игра (quickMove в window-clicks.js), поэтому серверу нечего поправлять.

const { sameStack, maxStack } = require('./window-clicks');

/** Ячейки хранилища и инвентаря бота в открытом окне-хранилище (сундук, бочка, шалкер…). */
const storageSlots = (w) => [0, w.inventoryStart];
const playerSlots = (w) => [w.inventoryStart, w.inventoryEnd];

/** Сколько предметов в ячейках [start, end), подходящих под test. */
function countIn(window, [start, end], test = () => true) {
  let n = 0;
  for (let i = start; i < end; i += 1) {
    const it = window.slots[i];
    if (it && test(it)) n += it.count || 1;
  }
  return n;
}

/** Стопки в ячейках [start, end), подходящие под test: имя → сколько всего. */
function itemsIn(window, [start, end], test = () => true) {
  const out = new Map();
  for (let i = start; i < end; i += 1) {
    const it = window.slots[i];
    if (it && test(it)) out.set(it.name, (out.get(it.name) || 0) + (it.count || 1));
  }
  return out;
}

/** Есть ли в ячейках [start, end) место для стопки item: пустая ячейка или неполная стопка того же предмета. */
function hasRoom(window, [start, end], item) {
  for (let i = start; i < end; i += 1) {
    const it = window.slots[i];
    if (!it) return true;
    if (sameStack(it, item) && it.count < maxStack(it)) return true;
  }
  return false;
}

// Сундук общий (у склада много ботов): пока бот тянулся к стопке, её забрал другой — ячейка уже пуста. Тогда
// взять следующую, но не больше стольких раз подряд.
const MAX_TAKEN_BY_OTHERS = 12;

/**
 * Перенести shift-кликом стопки, подходящие под test, из ячеек from в ячейки to, пока не наберётся want
 * предметов (Infinity — все). Стопки идут целиком, поэтому перенести можно чуть больше want.
 * @returns {Promise<{ moved: Map<string, number>, total: number, full: boolean, rejected: boolean, lost: number }>}
 *   full — какой-то стопке не хватило места; rejected — сервер не дал перенести (ячейки остались как были);
 *   lost — сколько раз стопку из-под руки забрал кто-то другой.
 */
async function moveStacks(bot, window, from, to, test, want = Infinity) {
  const moved = new Map();
  const skip = new Set(); // ячейки, которые уже пробовали: их стопке места нет
  let total = 0;
  let full = false;
  let rejected = false;
  let lost = 0;
  while (total < want && bot.currentWindow === window) {
    let slot = -1;
    for (let i = from[0]; i < from[1]; i += 1) {
      const it = window.slots[i];
      if (it && !skip.has(i) && test(it)) {
        slot = i;
        break;
      }
    }
    if (slot < 0) break; // переносить больше нечего
    const item = window.slots[slot];
    if (!hasRoom(window, to, item)) {
      full = true;
      skip.add(slot);
      continue; // этому предмету места нет — другому, может, есть
    }
    const name = item.name;
    // Сколько перенеслось — по своему инвентарю: его меняет только сам бот. В общем сундуке в тот же миг другой бот
    // может взять или положить такое же (стенд 12.11: бот положил удочку, сосед взял — счёт сундука не изменился,
    // и перенос засчитался как «не вышло»).
    const mineFrom = from[0] === window.inventoryStart && to[0] !== window.inventoryStart;
    const side = mineFrom ? from : to;
    const count = () => countIn(window, side, (x) => x.name === name);
    const before = count();
    // Пустую ячейку не щёлкаем: стопку, пока бот тянулся, забрал другой (это видно по ячейкам от сервера).
    const gone = () => !window.slots[slot] || window.slots[slot].name !== name;
    const r = await bot.actions.clickSlot(slot, { mode: 1, unless: gone });
    const n = mineFrom ? before - count() : count() - before;
    if (n <= 0) {
      if ((r && r.skipped) || gone()) {
        lost += 1;
        if (lost <= MAX_TAKEN_BY_OTHERS) continue; // взять другую стопку
      }
      rejected = true;
      break;
    }
    moved.set(name, (moved.get(name) || 0) + n);
    total += n;
    if (window.slots[slot] && window.slots[slot].name === name) {
      full = true; // перенеслась только часть стопки: остальному места нет
      skip.add(slot);
    }
  }
  return { moved, total, full, rejected, lost };
}

module.exports = { moveStacks, countIn, itemsIn, hasRoom, storageSlots, playerSlots };
