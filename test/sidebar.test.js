'use strict';

// Табло справа (src/bot/sidebar.js): строки, как их видит игрок, и баланс из строки «Баланс» — как на MineBlaze
// («• Баланс • $837.7k»). Плагины табло рисуют строку тремя способами — проверены все.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const EventEmitter = require('node:events');

const { attachSidebar, parseMoney } = require(path.join(__dirname, '..', 'src', 'bot', 'sidebar.js'));

/** Бот-заготовка: события пакетов — на bot._client, как у mineflayer. */
function fakeBot() {
  const bot = new EventEmitter();
  bot._client = new EventEmitter();
  bot.teamMap = {};
  attachSidebar(bot);
  return bot;
}
const nbt = (text) => ({ type: 'compound', name: '', value: { text: { type: 'string', value: text } } });
const tick = () => new Promise((r) => setImmediate(r));

test('сумма с табло: «$837.7k» — показано округлённым, перевести можно 837 650; «k», «M», запятые, копейки', () => {
  assert.deepEqual(parseMoney('$837.7k'), { value: 837700, safe: 837650, text: '837.7k' });
  assert.equal(parseMoney('837,7к').safe, 837650, 'русская «к» и дробная запятая');
  assert.equal(parseMoney('$1.5M').safe, 1450000);
  assert.equal(parseMoney('$600.25').safe, 600, 'с копейками — точно');
  assert.equal(parseMoney('$600').safe, 599, 'целые — могли округлить: минус полдоллара');
  assert.equal(parseMoney('$1,234.56').value, 1234.56, 'запятые тысяч');
  assert.equal(parseMoney('$0').safe, 0);
  assert.equal(parseMoney('нет денег'), null);
});

test('табло: строка — подпись очка (1.20.3+); баланс — из строки «Баланс», «Коинов» — не баланс; изменился — событие', async () => {
  const bot = fakeBot();
  const events = [];
  bot.on('balance', (b) => events.push(b));
  const c = bot._client;
  c.emit('scoreboard_objective', { name: 'mb', action: 0, displayText: nbt('MineBlaze') });
  c.emit('scoreboard_display_objective', { position: 1, name: 'mb' });
  c.emit('scoreboard_score', { itemName: 'line3', scoreName: 'mb', value: 3, display_name: nbt('• Коинов • 266') });
  c.emit('scoreboard_score', { itemName: 'line4', scoreName: 'mb', value: 4, display_name: nbt('• Баланс • $837.7k') });
  c.emit('scoreboard_score', { itemName: 'line5', scoreName: 'mb', value: 5, display_name: nbt('Ник: BARABYLKAyt') });
  assert.deepEqual(bot.sidebar.lines(), ['Ник: BARABYLKAyt', '• Баланс • $837.7k', '• Коинов • 266'], 'сверху вниз по очкам');
  assert.equal(bot.sidebar.title(), 'MineBlaze');
  const b = bot.sidebar.balance();
  assert.equal(b.value, 837700);
  assert.equal(b.safe, 837650);
  assert.equal(b.text, '$837.7k', 'для показа — как на табло');
  assert.deepEqual(events.map((e) => e.text), ['$837.7k']);
  // Баланс изменился — новое событие; убрали строку — баланса нет.
  c.emit('scoreboard_score', { itemName: 'line4', scoreName: 'mb', value: 4, display_name: nbt('• Баланс • $838.3k') });
  assert.equal(bot.sidebar.balance().value, 838300);
  assert.deepEqual(events.map((e) => e.text), ['$837.7k', '$838.3k']);
  c.emit('reset_score', { entity_name: 'line4', objective_name: 'mb' });
  assert.equal(bot.sidebar.balance(), null);
  await tick();
});

test('табло: строка — префикс и суффикс команды (старые плагины) и «текст вместо числа» (number_format fixed)', async () => {
  const bot = fakeBot();
  const c = bot._client;
  c.emit('scoreboard_objective', { name: 'sb', action: 0, displayText: '{"text":"Сервер"}' });
  c.emit('scoreboard_display_objective', { position: 1, name: 'sb' });
  // Запись — невидимый цветовой код, текст — в команде: «• Баланс • » + запись + «$12.5k».
  bot.teamMap['§1§r'] = { prefix: { toString: () => '• Баланс • ' }, suffix: { toString: () => '$12.5k' } };
  c.emit('scoreboard_score', { itemName: '§1§r', scoreName: 'sb', value: 1 });
  assert.equal(bot.sidebar.balance().value, 12500);
  // Другой плагин: подпись слева, сумма справа — вместо числа очков.
  const bot2 = fakeBot();
  const c2 = bot2._client;
  c2.emit('scoreboard_objective', { name: 'x', action: 0, displayText: nbt('X') });
  c2.emit('scoreboard_display_objective', { position: 1, name: 'x' });
  c2.emit('scoreboard_score', { itemName: 'bal', scoreName: 'x', value: 7, display_name: nbt('Баланс:'), number_format: 2, styling: nbt('$600.25') });
  assert.equal(bot2.sidebar.balance().safe, 600);
  // Табло сменили — старые строки не в счёт.
  c2.emit('scoreboard_objective', { name: 'y', action: 0, displayText: nbt('Y') });
  c2.emit('scoreboard_display_objective', { position: 1, name: 'y' });
  assert.equal(bot2.sidebar.balance(), null);
  await tick();
});
