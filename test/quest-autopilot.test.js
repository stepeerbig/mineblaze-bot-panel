'use strict';

// Автопилот заданий (src/quest-autopilot.js): что делать у NPC, ход бота по NPC, «что нужно от тебя», пауза и
// стоп, редкие проверки, когда делать нечего. Боты — подделка: на команды отвечают, как настоящие (data — как у
// #квесты, #квесты принести, #бей).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { QuestAutopilot, planNpc, mobHome } = require(path.join(__dirname, '..', 'src', 'quest-autopilot.js'));
const { sanitize, parseMobHomes, DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'src', 'config.js'));

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (check, ms = 3000) => {
  for (let t = 0; t < ms; t += 5) {
    if (check()) return true;
    await flush(5);
  }
  return false;
};

const q = (over) => ({ slot: 10, title: 'Задание', kind: 'deliver', goal: 'Передайте пшеницу', have: 0, need: 224, unit: '', taken: true, done: false, items: ['wheat'], ...over });
const view = (npc, level, quests, ready = false) => ({ npc, title: `${npc} › Уровень ${level} → ${level + 1}`, quests, level: { slot: 40, ready } });
const ok = (data, message = ['ок']) => ({ ok: true, code: null, message, data });

/** Боты-подделка: handler(bot, line) → ответ команды; calls — что им отдавали. */
function makeEnv(handler, nicks = ['Farm01']) {
  const calls = [];
  const env = {
    bots: nicks.map((nick) => ({ bot: nick.toLowerCase(), nick, state: 'online' })),
    busyReason: '',
    reconnect: true,
    listBots: () => env.bots,
    runCommand: async (bot, line, { signal, quiet } = {}) => {
      calls.push({ bot, line, quiet: Boolean(quiet) });
      await flush(1);
      if (signal && signal.aborted) return { ok: false, code: 'stopped', message: ['остановлено'], data: null };
      return handler(bot, line, signal);
    },
    busy: () => env.busyReason,
    autoReconnect: () => env.reconnect,
  };
  return { env, calls };
}

function makePilot(handler, { nicks, cfg = {}, store = null } = {}) {
  const { env, calls } = makeEnv(handler, nicks);
  const config = { ...DEFAULT_CONFIG, questStorage: 'урожай', questRewards: 'награды', ...cfg };
  const pilot = new QuestAutopilot({ getConfig: () => config, env, store, timings: { pollMs: 5, minuteMs: 60 * 1000 } });
  const logs = [];
  pilot.on('log', (e) => logs.push(e));
  return { pilot, env, calls, config, logs };
}

/** Дождаться, пока все боты сходят по разу (у каждого nextAt в будущем), и выключить. */
async function oneRound(pilot, env) {
  pilot.start();
  const done = await waitFor(() => env.bots.every((b) => pilot.state.bots[b.bot] && pilot.state.bots[b.bot].nextAt > Date.now()) && !pilot.current.size);
  await pilot.stop();
  assert.ok(done, 'круг не закончился');
}

test('автопилот: что делать у NPC — взять, принести, купить, убить, не умею; закрытый NPC; время заданий', () => {
  const p = planNpc(view('Фермер', 1, [
    q({ slot: 10 }),
    q({ slot: 11, kind: 'buy', goal: 'Купите у Фермера товаров на', need: 12000, items: [] }),
    q({ slot: 12, kind: 'kill', goal: 'Убейте пауков', need: 20, have: 5, items: [], mobs: ['spider', 'cave_spider'] }),
    q({ slot: 13, kind: 'breed', goal: 'Разведите коров', need: 10, items: [] }),
    q({ slot: 14, kind: 'time', goal: 'Проведите на сервере', unit: 'мин', have: 60, need: 180, items: [] }),
    q({ slot: 15, kind: 'deliver', goal: 'Передайте штуковины', items: [] }),
    q({ slot: 16, taken: false }),
    q({ slot: 19, done: true, have: 224 }),
  ]));
  assert.equal(p.level, 1);
  assert.equal(p.locked, false);
  assert.equal(p.take, true, 'есть не взятое');
  assert.equal(p.buy, true);
  assert.deepEqual(p.deliver.map((x) => x.slot), [10]);
  assert.deepEqual(p.unknown.map((x) => x.slot), [15]);
  assert.deepEqual(p.kill, [{ title: 'Задание', goal: 'Убейте пауков', mobs: ['spider', 'cave_spider'], left: 15 }]);
  assert.deepEqual(p.cant.map((x) => x.goal), ['Разведите коров']);
  assert.equal(p.waitMin, 120, 'до конца «Проведите…» — 2 ч');
  assert.equal(p.bring, true);

  // Закрытый Алхимик (уровень 0 → 1): условия ещё не выполнены — делать нечего; выполнены — кнопка уровня.
  const unlock = (done) => q({ kind: 'unlock', goal: 'Прокачайте Фермера до 3 уровня', have: done ? 3 : 2, need: 3, done, items: [] });
  assert.equal(planNpc(view('Алхимик', 0, [unlock(false)])).locked, true);
  const open = planNpc(view('Алхимик', 0, [unlock(true)], true));
  assert.deepEqual([open.locked, open.take, open.bring], [false, true, true], 'готова кнопка уровня — повысить');
  // Всё выполнено, кнопка не готова (сервер не обновил) — делать нечего.
  assert.equal(planNpc(view('Фермер', 2, [q({ done: true, have: 224 })])).bring, false);

  const rooms = parseMobHomes('пауки: паучья\n# комментарий\nифриты = /home незер\nчепуха');
  assert.deepEqual(rooms, [{ who: 'пауки', home: 'паучья' }, { who: 'ифриты', home: 'незер' }]);
  assert.equal(mobHome(rooms, ['cave_spider']), 'паучья');
  assert.equal(mobHome(rooms, ['blaze']), 'незер');
  assert.equal(mobHome(rooms, ['zombie']), null);
});

test('автопилот: бот берёт и приносит задания Фермера; новые задания — смотрит ещё раз; Алхимик закрыт до 3-го уровня', async () => {
  let stage = 0; // 0 — до «принести», 1 — после
  const { pilot, env, calls, logs } = makePilot((bot, line) => {
    if (line === '#квесты у Фермер') {
      return ok(stage === 0
        ? view('Фермер', 1, [q({ slot: 10 }), q({ slot: 11, kind: 'buy', goal: 'Купите', need: 12000, items: [] }), q({ slot: 12, kind: 'time', unit: 'мин', need: 180, items: [], taken: false })])
        : view('Фермер', 1, [q({ slot: 10, done: true, have: 224 }), q({ slot: 11, kind: 'buy', done: true, have: 12000, need: 12000, items: [] }), q({ slot: 12, kind: 'time', unit: 'мин', have: 0, need: 180, items: [] })]));
    }
    if (line === '#квесты принести урожай награды у Фермер') {
      stage = 1;
      return ok({ npc: 'Фермер', took: [12], gave: [{ slot: 10, done: true }], bought: { spent: 12000, left: 0, noMoney: false }, levelUps: [], short: [], unknown: [], full: false });
    }
    throw new Error(`лишняя команда: ${line}`);
  });
  await oneRound(pilot, env);
  assert.deepEqual(calls.map((c) => [c.line, c.quiet]), [
    ['#квесты у Фермер', true],
    ['#квесты принести урожай награды у Фермер', false],
    ['#квесты у Фермер', true], // взял новое — посмотреть ещё раз
  ]);
  const st = pilot.state.bots.farm01;
  assert.equal(st.npcs['Фермер'].level, 1);
  assert.equal(st.npcs['Алхимик'].locked, true, 'Алхимик — когда Фермер 3-го уровня, к нему не ходили');
  assert.deepEqual(st.problems, []);
  assert.equal(st.idle, 0);
  const wait = (st.nextAt - Date.now()) / 60000;
  assert.ok(wait > 14 && wait <= 15, `следующая проверка — через 15 мин (${wait})`);
  assert.deepEqual(pilot.levels(), ['Фермер: ур. 1 — 1', 'Алхимик: закрыт — 1', 'Оружейник: закрыт — 1']);
  assert.deepEqual(pilot.needs(), []);
  assert.ok(logs.some((e) => e.nick === 'Farm01' && e.text === 'Фермер: беру задания и приношу со склада (#квесты принести урожай награды у Фермер)'));
});

test('автопилот: «что нужно от тебя» — склад, деньги, дом, комната мобов, незнакомое; одинаковое у многих — вместе', async () => {
  const farmer = view('Фермер', 1, [
    q({ slot: 10, title: 'Грядки', goal: 'Передайте пшеницу' }),
    q({ slot: 11, kind: 'buy', goal: 'Купите', need: 12000, items: [] }),
    q({ slot: 12, kind: 'kill', title: 'Паутина', goal: 'Убейте пауков', need: 20, items: [], mobs: ['spider', 'cave_spider'] }),
    q({ slot: 13, kind: 'breed', goal: 'Разведите коров', need: 10, items: [] }),
  ]);
  const { pilot, env } = makePilot((bot, line) => {
    if (line === '#квесты у Фермер') return ok(farmer);
    if (line.startsWith('#квесты принести')) {
      if (bot === 'farm03') return { ok: false, code: 'no_home', message: ['Остановился: после /home урожай телепорта не было (сервер: «Дом не найден»)'], data: {} };
      return { ok: true, code: null, message: ['…'], data: { short: [{ title: 'Грядки', goal: 'Передайте пшеницу', items: ['wheat'], missing: 100 }], bought: { spent: 0, left: bot === 'farm01' ? 12000 : 5000, noMoney: true }, levelUps: [] } };
    }
    throw new Error(`лишняя команда: ${line}`);
  }, { nicks: ['Farm01', 'Farm02', 'Farm03'] });
  env.reconnect = false;
  await oneRound(pilot, env);
  pilot.running = true; // строка про автореконнект — только у включённого
  assert.deepEqual(pilot.needs(), [
    'Нет дома «урожай» у 1 бота: Farm03 — поставь каждому /sethome урожай у сундука (бот должен стоять там)',
    'Положи на склад (/home урожай) для «Передайте пшеницу»: ещё 200 — не хватило 2 ботам',
    'Дай денег 2 ботам для «Купите…» (всего 17000): /pay Farm01 12000, /pay Farm02 5000',
    '«Убейте пауков» у 2 ботов: нужна комната с ними — впиши в «Комнаты мобов» строку «паук: <дом>» и поставь ботам этот дом',
    'Пока не умею: «Разведите коров» (2 бота)',
    'Включи автореконнект (ON): «Проведите на сервере» идёт, только пока бот в сети, а выпавший сам не вернётся',
  ]);
  pilot.running = false;
  // Ничего не вышло — следующая проверка реже (15 мин × 2).
  const wait = (pilot.state.bots.farm01.nextAt - Date.now()) / 60000;
  assert.ok(wait > 29 && wait <= 30, String(wait));

  // Убрали бота из списка — его беды больше не показываем.
  env.bots = env.bots.filter((b) => b.bot !== 'farm03');
  assert.ok(!pilot.needs().some((l) => l.includes('Farm03')));
});

test('автопилот: «Убейте…» — в комнате мобов (#бей … дом …); выполнили — сразу новый уровень', async () => {
  let killed = false;
  let level = 3;
  let alchemistTook = false;
  const { pilot, env, calls } = makePilot((bot, line) => {
    if (line === '#квесты у Фермер') {
      if (level === 4) return { ok: true, code: 'finished', message: ['Фермер: 4-й уровень, все задания пройдены — больше заданий нет'], data: { finished: true } };
      return ok(view('Фермер', 3, [q({ kind: 'kill', goal: 'Убейте пауков', need: 20, have: killed ? 20 : 0, done: killed, items: [], mobs: ['spider', 'cave_spider'] })], killed));
    }
    if (line === '#бей паук 20 дом паучья') {
      killed = true;
      return ok({ kills: { spider: 20 }, total: 20, left: [] });
    }
    if (line === '#квесты принести урожай у Фермер') {
      level = 4;
      return ok({ levelUps: [{ up: true, level: 4 }], took: [], gave: [] });
    }
    if (line === '#квесты у Алхимик') return ok(view('Алхимик', 1, [q({ kind: 'time', unit: 'мин', need: 240, items: [], taken: alchemistTook })]));
    if (line === '#квесты принести урожай у Алхимик') {
      alchemistTook = true;
      return ok({ took: [10], levelUps: [] });
    }
    throw new Error(`лишняя команда: ${line}`);
  }, { cfg: { questRewards: '', questMobHomes: 'пауки: паучья' } });
  await oneRound(pilot, env);
  assert.deepEqual(calls.map((c) => c.line), [
    '#квесты у Фермер',
    '#бей паук 20 дом паучья',
    '#квесты у Фермер', // убил — ещё проход: всё выполнено, кнопка уровня готова
    '#квесты принести урожай у Фермер', // новый уровень
    '#квесты у Фермер', // ещё проход: Фермер пройден
    '#квесты у Алхимик', // Фермер 4-й — Алхимик открыт
    '#квесты принести урожай у Алхимик',
    '#квесты у Алхимик', // взял новое — посмотреть ещё раз: только время
  ]);
  const st = pilot.state.bots.farm01;
  assert.equal(st.npcs['Фермер'].finished, true);
  assert.equal(st.npcs['Оружейник'].locked, true, 'Оружейник — когда и Алхимик 4-го');
  assert.deepEqual(pilot.levels(), ['Фермер: пройден — 1', 'Алхимик: ур. 1 — 1', 'Оружейник: закрыт — 1']);
});

test('автопилот: пауза (ИИ, «по очереди») — начатое бросают и продолжают потом; стоп; не в сети — не трогает', async () => {
  let release = null;
  const { pilot, env, calls } = makePilot((bot, line, signal) => {
    if (line === '#квесты у Фермер') return ok(view('Фермер', 1, [q({ taken: false })]));
    // «Принести» долгое: ждёт, пока не оборвут.
    return new Promise((resolve) => {
      release = () => resolve(ok({ took: [10] }));
      signal.addEventListener('abort', () => resolve({ ok: false, code: 'stopped', message: ['Остановлено'], data: null }), { once: true });
    });
  }, { nicks: ['Farm01', 'Farm02'] });
  env.bots[1].state = 'offline';
  pilot.start();
  assert.ok(await waitFor(() => calls.some((c) => c.line.startsWith('#квесты принести'))));
  assert.equal(pilot.status().current[0].what, 'беру задания и приношу со склада');
  // Пользователь запустил ИИ: начатое — бросить, новые — не начинать.
  env.busyReason = 'ИИ выполняет задание';
  assert.equal(pilot.interrupt('ИИ выполняет задание'), true);
  assert.ok(await waitFor(() => !pilot.current.size));
  assert.equal(pilot.state.bots.farm01.nextAt, 0, 'прерванного — доделать, как только можно');
  assert.ok(await waitFor(() => pilot.status().paused === 'ИИ выполняет задание'));
  const before = calls.length;
  await flush(40);
  assert.equal(calls.length, before, 'на паузе ботов не трогает');
  // ИИ закончил — продолжает сам.
  env.busyReason = '';
  assert.ok(await waitFor(() => calls.length > before));
  assert.ok(!calls.some((c) => c.bot === 'farm02'), 'бот не в сети — не трогает');
  // Выключили — начатое бросают («#стоп» уходит через signal).
  assert.ok(await waitFor(() => pilot.current.size === 1 && release));
  await pilot.stop();
  assert.equal(pilot.running, false);
  assert.equal(pilot.current.size, 0);
  assert.equal(pilot.status().running, false);
});

test('автопилот: делать нечего — проверять реже (до 2 ч), «Проведите на сервере» — когда выйдет время; «проверить сейчас»; состояние сохраняется', async () => {
  const saved = [];
  const store = { load: () => null, save: (s) => saved.push(JSON.parse(JSON.stringify(s))) };
  const { pilot, env } = makePilot((bot, line) => {
    if (line === '#квесты у Фермер') return ok(view('Фермер', 2, [q({ kind: 'time', unit: 'мин', have: 150, need: 180, items: [] }), q({ kind: 'breed', goal: 'Разведите коров', items: [] })]));
    throw new Error(`лишняя команда: ${line}`);
  }, { store });
  const st = () => pilot.state.bots.farm01;
  await oneRound(pilot, env);
  // Сделать нечего, но «Проведите…» кончится через 30 мин → через 31 (а не 15 × 2).
  let wait = (st().nextAt - Date.now()) / 60000;
  assert.ok(wait > 29 && wait <= 30, String(wait));
  assert.equal(st().idle, 1);
  // Ещё раз ничего — 15 × 4 = 60, но время задания — через 31.
  st().nextAt = 0;
  await oneRound(pilot, env);
  wait = (st().nextAt - Date.now()) / 60000;
  assert.ok(wait > 29 && wait <= 31, String(wait));
  // Без «Проведите…» — до 2 ч.
  st().idle = 7;
  const pilot2 = makePilot(() => ok(view('Фермер', 2, [q({ kind: 'breed', goal: 'Разведите коров', items: [] })])));
  pilot2.pilot.state.bots.farm01 = { nick: 'Farm01', nextAt: 0, idle: 7, npcs: {}, problems: [] };
  await oneRound(pilot2.pilot, pilot2.env);
  wait = (pilot2.pilot.state.bots.farm01.nextAt - Date.now()) / 60000;
  assert.ok(wait > 119 && wait <= 120, String(wait));
  // «Сделал — проверить всех сейчас».
  pilot2.pilot.checkNow();
  assert.deepEqual([pilot2.pilot.state.bots.farm01.nextAt, pilot2.pilot.state.bots.farm01.idle], [0, 0]);

  // Сохранено — после перезапуска панели уровни известны.
  assert.ok(saved.length >= 2);
  const again = new QuestAutopilot({ getConfig: () => ({}), env, store: { load: () => saved.at(-1), save: () => {} } });
  assert.deepEqual(again.levels(), ['Фермер: ур. 2 — 1', 'Алхимик: закрыт — 1', 'Оружейник: закрыт — 1']);
});

test('настройки автопилота: дома — имя (можно «/home имя»), ботов сразу 1–5, пауза 5–240 мин', () => {
  assert.equal(DEFAULT_CONFIG.questAuto, false);
  assert.deepEqual(sanitize({ questStorage: ' /home урожай ', questRewards: 'награды' }), { questStorage: 'урожай', questRewards: 'награды' });
  assert.equal(sanitize({ questStorage: 'не дом;op' }).questStorage, undefined, 'не имя дома — не сохраняем');
  assert.equal(sanitize({ questStorage: '' }).questStorage, '');
  assert.deepEqual(sanitize({ questTogether: '9', questPause: '3' }), {}, 'вне пределов — не меняем');
  assert.deepEqual(sanitize({ questTogether: '3', questPause: '30', questAuto: true }), { questTogether: 3, questPause: 30, questAuto: true });
  assert.equal(sanitize({ questMobHomes: 'пауки: паучья\r\nифриты: незер' }).questMobHomes, 'пауки: паучья\nифриты: незер');
});
