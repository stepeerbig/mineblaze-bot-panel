'use strict';

// Задачи ботам (src/tasks.js): очередь у каждого бота, шаги по порядку, ожидание бота, продолжение с того же места,
// пауза, убрать, по кругу, файл. Флот — подставной: готовность ботов и ответы на команды задаёт тест.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const EventEmitter = require('node:events');

const { TaskBoard, parseSteps } = require(path.join(__dirname, '..', 'src', 'tasks.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check, ms = 2000) => {
  for (let t = 0; t < ms; t += 5) {
    if (check()) return true;
    await sleep(5);
  }
  return false;
};

/** Флот: боты (номер → { nick, ready }), команды «#…» — по handler(bot, line, signal), иначе сразу «готово». */
class FakeFleet extends EventEmitter {
  constructor(nicks) {
    super();
    this.bots = new Map(nicks.map((n) => [n.toLowerCase(), { bot: n.toLowerCase(), nick: n, ready: true }]));
    this.calls = [];
    this.handler = null;
  }

  get(id) {
    return this.bots.get(String(id || '').toLowerCase()) || null;
  }

  list() {
    return [...this.bots.values()].map((b) => ({ bot: b.bot, nick: b.nick, state: b.ready ? 'online' : 'offline' }));
  }

  isReady(id) {
    const b = this.get(id);
    return Boolean(b && b.ready);
  }

  setReady(id, on) {
    const b = this.get(id);
    b.ready = on;
    this.emit('state', { bot: b.bot, state: on ? 'online' : 'offline' });
    if (on) this.emit('ready', { bot: b.bot, nick: b.nick });
  }

  async commandOne(id, line, { signal } = {}) {
    this.calls.push([id, line]);
    if (!this.isReady(id)) return { ok: false, code: 'offline', message: ['бот не в сети'] };
    if (this.handler) return this.handler(id, line, signal);
    await sleep(5);
    return { ok: true, message: [`${line}: готово`] };
  }

  async say(id, text) {
    this.calls.push([id, text]);
    return this.isReady(id);
  }
}

const FAST = { second: 10, serverGap: 5, retryMs: 20, saveDelay: 5 };
const board = (fleet, extra = {}) => {
  const b = new TaskBoard({ fleet, timings: FAST, ...extra });
  const logs = [];
  b.on('log', (e) => logs.push(`${e.level}:${e.nick || '-'}:${e.text}`));
  b.start();
  return { b, logs };
};

test('задачи: шаги — #команда, /команда, «скажи», «ждать 30 / 2 мин / 1 ч»; пароли и обычный текст — понятный отказ', () => {
  assert.deepEqual(parseSteps('#добудь алмазы 5\n\n/home база\nскажи всем привет\nждать 30\nждать 2 мин\nпауза 1 ч'), [
    { line: '#добудь алмазы 5', kind: 'cmd' },
    { line: '/home база', kind: 'server' },
    { line: 'скажи всем привет', kind: 'chat', text: 'всем привет' },
    { line: 'ждать 30', kind: 'wait', seconds: 30 },
    { line: 'ждать 2 мин', kind: 'wait', seconds: 120 },
    { line: 'пауза 1 ч', kind: 'wait', seconds: 3600 },
  ]);
  assert.throws(() => parseSteps('добудь алмазы'), /шаг — это #команда боту/);
  assert.throws(() => parseSteps('/login секрет'), /пароли в задачах не храню/);
  assert.throws(() => parseSteps('/reg секрет'), /пароли в задачах не храню/);
  assert.throws(() => parseSteps('   \n  '), /впиши шаги/);
  assert.throws(() => parseSteps('ждать 0'), /от 1 секунды/);
  assert.throws(() => parseSteps(Array.from({ length: 31 }, () => '#где').join('\n')), /не больше 30/);
});

test('задачи: шаги по порядку, следующий — когда закончил прошлый; у бота задачи по очереди, у разных ботов — сразу', async () => {
  const fleet = new FakeFleet(['Bot1', 'Bot2']);
  const { b, logs } = board(fleet);
  b.add(['bot1'], '#добудь алмазы 2\n/home база\nждать 1\nскажи готово');
  b.add(['bot1'], '#положи склад');
  b.add(['bot2'], '#где');
  assert.ok(await waitFor(() => b.summary().done === 3), JSON.stringify(b.list()));
  assert.deepEqual(fleet.calls.filter(([id]) => id === 'bot1').map(([, l]) => l), ['#добудь алмазы 2', '/home база', 'готово', '#положи склад']);
  assert.ok(fleet.calls.findIndex(([id]) => id === 'bot2') < fleet.calls.findIndex(([, l]) => l === '#положи склад'), 'второй бот не ждёт первого');
  assert.ok(logs.includes('ok:Bot1:Задача готова: #добудь алмазы 2 → /home база → ждать 1 → скажи готово'), logs.join('\n'));
  assert.equal(b.hasWork('bot1'), false);
  b.stop();
});

test('задачи: бот вылетел посреди #добудь — ждёт его и продолжает с остатка руды; не в сети с начала — ждёт', async () => {
  const fleet = new FakeFleet(['Miner']);
  let first = true;
  fleet.handler = async (id, line) => {
    if (first) {
      first = false;
      fleet.bots.get(id).ready = false; // обрыв посреди копания
      return { ok: false, code: 'interrupted', message: ['#добудь: прервано: бот отключился'], data: { resume: '#добудь алмазы 3' } };
    }
    return { ok: true, message: [`${line}: готово`] };
  };
  const { b, logs } = board(fleet);
  b.add(['miner'], '#добудь алмазы 5\n#положи склад');
  assert.ok(await waitFor(() => b.list()[0].state === 'waiting'));
  assert.equal(b.list()[0].current, '#добудь алмазы 3 (продолжение)');
  assert.ok(logs.some((l) => l.startsWith('warn:Miner:Задача ждёт бота (вышел из сети), продолжит с шага 1: #добудь алмазы 3')), logs.join('\n'));
  assert.equal(b.hasWork('miner'), true, 'автопилот бота не трогает');
  await sleep(30);
  assert.equal(fleet.calls.length, 1, 'пока бот не вернулся — ничего не шлёт');
  fleet.setReady('miner', true);
  assert.ok(await waitFor(() => b.summary().done === 1));
  assert.deepEqual(fleet.calls.map(([, l]) => l), ['#добудь алмазы 5', '#добудь алмазы 3', '#положи склад']);

  // Бот не в сети, когда задачу дали, — она ждёт, а как войдёт — идёт.
  fleet.bots.get('miner').ready = false;
  b.add(['miner'], '#где');
  assert.ok(await waitFor(() => b.list().some((t) => t.state === 'waiting' && t.note === 'ждёт бота: не в сети')));
  fleet.setReady('miner', true);
  assert.ok(await waitFor(() => b.summary().done === 2));
  b.stop();
});

test('задачи: пауза (боту — #стоп через сигнал), продолжить с того же шага, убрать; #стоп и другая команда — пауза', async () => {
  const fleet = new FakeFleet(['Bot']);
  let aborted = 0;
  fleet.handler = (id, line, signal) => new Promise((resolve) => {
    if (line === '#стоп-сам') return resolve({ ok: false, code: 'stopped', message: ['#добудь: остановлено'] });
    if (line === '#занят') return resolve({ ok: false, code: 'replaced', message: ['заменено'] });
    // Как fleet.commandOne: подписка на сигнал — только пока команда идёт.
    const onAbort = () => {
      aborted += 1;
      clearTimeout(timer);
      resolve({ ok: false, code: 'stopped', message: ['остановлено'] });
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve({ ok: true, message: ['готово'] });
    }, line === '#долго' ? 200 : 5);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  const { b } = board(fleet);
  b.add(['bot'], '#первый\n#долго\n#третий');
  assert.ok(await waitFor(() => b.list()[0].current === '#долго'));
  assert.equal(b.pause(), 1);
  assert.ok(await waitFor(() => aborted === 1));
  assert.equal(b.list()[0].state, 'paused');
  assert.equal(b.list()[0].step, 2, 'стоит на втором шаге');
  b.resume();
  assert.ok(await waitFor(() => b.summary().done === 1));
  assert.deepEqual(fleet.calls.map(([, l]) => l), ['#первый', '#долго', '#долго', '#третий']);

  b.add(['bot'], '#стоп-сам\n#после');
  assert.ok(await waitFor(() => b.list().some((t) => t.state === 'paused')));
  assert.match(b.list().find((t) => t.state === 'paused').note, /остановлено командой #стоп/);
  b.add(['bot'], '#не-начнёт');
  await sleep(30);
  assert.ok(!fleet.calls.some(([, l]) => l === '#не-начнёт'), 'пока первая на паузе — следующая ждёт');
  const paused = b.list().find((t) => t.state === 'paused');
  assert.equal(b.cancel(paused.id), 1);
  assert.ok(await waitFor(() => fleet.calls.some(([, l]) => l === '#не-начнёт')), 'убрали — пошла следующая');

  b.add(['bot'], '#занят');
  assert.ok(await waitFor(() => b.list().some((t) => t.state === 'paused' && /другой командой/.test(t.note))));
  b.stop();
});

test('задачи: шаг не удался — «ошибка» с причиной, очередь бота стоит; «продолжить» — повтор шага; по кругу', async () => {
  const fleet = new FakeFleet(['Bot']);
  let fail = true;
  fleet.handler = async (id, line) => {
    if (line === '#положи склад' && fail) return { ok: false, code: 'failed', message: ['#положи: склад полон'] };
    return { ok: true, message: ['готово'] };
  };
  const { b, logs } = board(fleet);
  b.add(['bot'], '#добудь уголь 3\n#положи склад');
  assert.ok(await waitFor(() => b.list()[0].state === 'error'));
  assert.equal(b.list()[0].note, '#положи: склад полон');
  assert.ok(logs.some((l) => l.startsWith('error:Bot:Задача остановилась на шаге 2 (#положи склад): #положи: склад полон')), logs.join('\n'));
  fail = false;
  b.resume();
  assert.ok(await waitFor(() => b.summary().done === 1));
  assert.deepEqual(fleet.calls.map(([, l]) => l), ['#добудь уголь 3', '#положи склад', '#положи склад']);

  b.cancel(null, { done: true });
  fleet.calls.length = 0;
  b.add(['bot'], '#урожай\nждать 1', { repeat: true });
  assert.ok(await waitFor(() => fleet.calls.length >= 3));
  const t = b.list()[0];
  assert.equal(t.repeat, true);
  assert.ok(t.rounds >= 2 && t.state !== 'done', JSON.stringify(t));
  b.pause();
  const n = fleet.calls.length;
  await sleep(60);
  assert.equal(fleet.calls.length, n, 'на паузе круг не идёт');
  b.stop();
});

test('задачи: шаг прервался, а бот в сети (смена мира) — повтор через паузу, 5 раз подряд — ошибка', async () => {
  const fleet = new FakeFleet(['Bot']);
  let n = 0;
  fleet.handler = async () => {
    n += 1;
    return n <= 2 ? { ok: false, code: 'interrupted', message: ['прервано: смена мира'] } : { ok: true, message: ['готово'] };
  };
  const { b } = board(fleet);
  b.add(['bot'], '#квесты принести');
  assert.ok(await waitFor(() => b.summary().done === 1));
  assert.equal(n, 3);

  n = -100; // всё время прерывается
  b.add(['bot'], '#квесты принести');
  assert.ok(await waitFor(() => b.list().some((t) => t.state === 'error')));
  b.stop();
});

test('задачи: список в файле — после перезапуска панели задача ждёт бота и продолжает с того же шага', async () => {
  let saved = null;
  const store = { load: () => saved, save: (s) => { saved = JSON.parse(JSON.stringify(s)); } };
  const fleet = new FakeFleet(['Bot']);
  fleet.handler = (id, line, signal) => new Promise((resolve) => {
    if (line !== '#долго') return resolve({ ok: true, message: ['готово'] });
    signal.addEventListener('abort', () => resolve({ ok: false, code: 'stopped', message: ['остановлено'] }));
  });
  const first = board(fleet, { store });
  first.b.add(['bot'], '#быстро\n#долго\n#после', { repeat: false });
  assert.ok(await waitFor(() => first.b.list()[0].current === '#долго'));
  first.b.stop(); // панель закрыли посреди шага
  assert.equal(saved.tasks[0].step, 1);

  const fleet2 = new FakeFleet(['Bot']);
  fleet2.bots.get('bot').ready = false;
  const second = board(fleet2, { store });
  assert.equal(second.b.list()[0].state, 'waiting');
  assert.equal(second.b.list()[0].note, 'ждёт бота: панель перезапущена');
  fleet2.setReady('bot', true);
  assert.ok(await waitFor(() => second.b.summary().done === 1));
  assert.deepEqual(fleet2.calls.map(([, l]) => l), ['#долго', '#после'], 'с того же шага, без первого');
  second.b.stop();
});

test('задачи: «всем» — по задаче каждому; лимит задач у бота; незнакомый бот — отказ', () => {
  const fleet = new FakeFleet(['A', 'B', 'C']);
  for (const id of ['a', 'b', 'c']) fleet.bots.get(id).ready = false;
  const { b } = board(fleet);
  assert.equal(b.add(['a', 'b', 'c'], '#где').added, 3);
  assert.deepEqual(b.list().map((t) => [t.nick, t.state]), [['A', 'waiting'], ['B', 'waiting'], ['C', 'waiting']]);
  assert.throws(() => b.add(['nobody'], '#где'), /нет в списке/);
  for (let i = 0; i < 19; i += 1) b.add(['a'], '#где');
  assert.throws(() => b.add(['a'], '#где'), /уже 20 задач/);
  assert.equal(b.cancel(), 22);
  b.stop();
});
