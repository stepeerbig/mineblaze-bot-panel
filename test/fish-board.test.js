'use strict';

// Вкладка «Авто фиш» в главном процессе (src/fish-board.js): кто рыбачит, сколько поймал, кто уже нет.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { FishBoard } = require(path.join(__dirname, '..', 'src', 'fish-board.js'));

test('«Авто фиш»: отправили команду — сразу «команда отправлена»; ход и улов — от бота; вышел — рыбалка кончилась', () => {
  const board = new FishBoard({ now: () => 1000 });
  let updates = 0;
  board.on('update', () => {
    updates += 1;
  });
  board.started('a', 'Alpha');
  board.started('b', 'Beta');
  assert.deepEqual(board.activeIds().sort(), ['a', 'b']);
  assert.equal(board.list().rows[0].stateText, 'команда отправлена');
  board.update({ bot: 'a', nick: 'Alpha', state: 'fishing', text: 'поймал: треска', caught: 3, items: [{ name: 'cod', label: 'треска', count: 3 }], rods: 2 });
  board.update({ bot: 'b', nick: 'Beta', state: 'stopped', text: 'Рыбалка остановлена', caught: 1 });
  const l = board.list();
  assert.equal(l.active, 1);
  assert.equal(l.caught, 4);
  assert.equal(l.rows[0].nick, 'Alpha', 'кто рыбачит — сверху');
  assert.equal(l.rows[0].stateText, 'рыбачит');
  assert.ok(board.isActive('a'));
  assert.ok(!board.isActive('b'));
  board.offline('a');
  assert.ok(!board.isActive('a'));
  assert.equal(board.list().rows.find((r) => r.bot === 'a').stateText, 'не в сети');
  // Снова «Начать» — счёт с нуля.
  board.started('a', 'Alpha');
  assert.equal(board.list().rows.find((r) => r.bot === 'a').caught, 0);
  board.update({ bot: 'a', state: 'done' });
  assert.equal(board.clearDone(), 2);
  assert.equal(board.list().rows.length, 0);
  board.started('c', 'Gamma');
  board.retain(['x']);
  assert.equal(board.list().rows.length, 0, 'убранных из списка ботов — нет и здесь');
  assert.ok(updates >= 8);
});

test('«Авто фиш»: балансы ботов с табло — у рыбаков в строке, всех — в сводке с суммой; тот же баланс — без обновления окна', () => {
  const board = new FishBoard();
  let updates = 0;
  board.on('update', () => {
    updates += 1;
  });
  board.started('a', 'Alpha');
  board.setBalance({ bot: 'a', nick: 'Alpha', value: 837700, safe: 837650, text: '$837.7k' });
  board.setBalance({ bot: 'b', nick: 'Beta', value: 1500, safe: 1450, text: '$1.5k' }); // не рыбачит — только в сводке
  const before = updates;
  board.setBalance({ bot: 'b', nick: 'Beta', value: 1500, safe: 1450, text: '$1.5k' });
  assert.equal(updates, before, 'тот же баланс — окно не дёргаем');
  board.setBalance({ bot: 'c', value: NaN, text: '?' }); // не число — не баланс
  const l = board.list();
  assert.equal(l.rows[0].balance, '$837.7k');
  assert.deepEqual(l.balances.map((b) => [b.nick, b.text]), [['Alpha', '$837.7k'], ['Beta', '$1.5k']]);
  assert.equal(l.balanceTotal, 839200);
  board.retain(['a']);
  assert.deepEqual(board.list().balances.map((b) => b.nick), ['Alpha'], 'убранный из списка бот — и из балансов');
});
