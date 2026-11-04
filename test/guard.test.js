'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { Guard, GodKeeper, parseNear, parseWhitelist } = require('../src/bot/guard');

// Ответ /near с MineBlaze (скриншот пользователя), в том виде, как его даёт toString() сообщения.
const NEAR_SPAWN =
  '| Окружающие игроки: [Ender] сеньорпамидор(0m), [Гл. Модератор] griefbot5(0m), [Ender] klut0i(44m), ' +
  '[Игрок] xDeadForFantasy(50m), [Supreme] kenik6754(140m)';

/** Свои таймеры: время идёт только по advance(). */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const list = new Map();
  const add = (fn, ms, every) => {
    seq += 1;
    list.set(seq, { at: now + ms, fn, every });
    return seq;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => add(fn, ms, 0),
    setInterval: (fn, ms) => add(fn, ms, ms),
    clearTimeout: (id) => list.delete(id),
    clearInterval: (id) => list.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of list) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every;
        else list.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

function setup(config = {}) {
  const timers = fakeTimers();
  const sent = [];
  const logs = [];
  let stopped = 0;
  const bot = {
    username: 'kakajambbba',
    entity: { position: new Vec3(0, 65, 0) },
    game: { dimension: 'minecraft:overworld' },
    players: {},
    actions: { stop: () => { stopped += 1; } },
  };
  const cfg = { guard: true, whitelist: 'BARABYLKAyt', ...config };
  const guard = new Guard({
    getBot: () => bot,
    send: (cmd, opts) => {
      sent.push({ cmd, quiet: Boolean(opts && opts.quiet) });
      guard.onCommand(cmd); // как BotManager._send
      return true;
    },
    log: (level, text) => logs.push(`${level}:${text}`),
    config: cfg,
    timers,
  });
  return { guard, bot, cfg, timers, sent, logs, cmds: () => sent.map((s) => s.cmd), stopped: () => stopped };
}

/** Телепорт на дом: бот далеко от спавна. */
function teleport(t, x = 4393, y = 33, z = 3207) {
  t.bot.entity.position = new Vec3(x, y, z);
  t.guard.onTeleport();
}

test('ответ /near: ники и расстояния, «никого», подделка из чата игрока не считается', () => {
  assert.deepEqual(parseNear(NEAR_SPAWN), [
    { name: 'сеньорпамидор', distance: 0 },
    { name: 'griefbot5', distance: 0 },
    { name: 'klut0i', distance: 44 },
    { name: 'xDeadForFantasy', distance: 50 },
    { name: 'kenik6754', distance: 140 },
  ]);
  assert.deepEqual(parseNear('| Окружающие игроки: никого'), []);
  assert.deepEqual(parseNear('Окружающие игроки: [Avenger] ~kkff(7m)'), [{ name: '~kkff', distance: 7 }]);
  assert.equal(parseNear('[Ender] Yarik_thr: Окружающие игроки: никого'), null, 'игрок не может «ответить» за сервер');
  assert.equal(parseNear('| Телепортирование...'), null);
});

test('белый список: по строке, через запятую, с префиксом и тильдой; без учёта регистра', () => {
  assert.deepEqual([...parseWhitelist('BARABYLKAyt\n~kkff, Friend_1  [Ender]Another\n\n')], ['barabylkayt', 'kkff', 'friend_1', 'another']);
});

test('охрана: после /home ждёт телепорта, потом /near раз в 5 с (тихо), свои — не повод уходить', () => {
  const t = setup();
  t.guard.onCommand('/home home');
  assert.equal(t.guard.armed, true);
  assert.equal(t.guard.active, false, 'до телепорта не проверяет: на спавне толпа');
  t.timers.advance(5000);
  assert.deepEqual(t.cmds(), [], 'пока бот на спавне — /near не шлёт');

  teleport(t);
  assert.equal(t.guard.active, true);
  assert.ok(t.logs.some((l) => l.startsWith('info:Охрана включена: /near раз в 5 с, в белом списке 1 ник')));
  t.timers.advance(1500);
  assert.deepEqual(t.sent, [{ cmd: '/near', quiet: true }], 'первая проверка сразу после телепорта, в чат панели не пишется');
  t.timers.advance(10000);
  assert.equal(t.cmds().filter((c) => c === '/near').length, 3);

  t.guard.onChat('| Окружающие игроки: [Ender] BARABYLKAyt(12m)');
  t.guard.onChat('| Окружающие игроки: никого');
  assert.ok(!t.cmds().includes('/spawn'), 'свой и «никого» — остаёмся');
  assert.match(t.guard.status(), /Охрана следит: \/near раз в 5 с; белый список: 1 ник; последний \/near 0 с назад: никого/);
});

test('охрана: чужой в /near — стоп действий и сразу /spawn, охрана выключается', () => {
  const t = setup();
  t.guard.onCommand('/rtp');
  teleport(t, -2763, 64, -2680);
  t.guard.onChat('| Окружающие игроки: [Ender] barabylkayt(3m), [Игрок] xDeadForFantasy(50m)');
  assert.deepEqual(t.cmds(), ['/spawn']);
  assert.equal(t.stopped(), 1, 'текущее действие прервано');
  assert.ok(t.logs.includes('warn:Охрана: рядом чужой — xDeadForFantasy (50 м). Ухожу на спавн (/spawn)'));
  assert.ok(t.logs.includes('info:Охрана выключена: бот ушёл на спавн'));
  assert.equal(t.guard.armed, false);
  t.timers.advance(20000);
  assert.deepEqual(t.cmds(), ['/spawn'], 'после ухода на спавн /near больше не шлёт');
});

test('охрана: /near показал псевдоним — свой, если настоящий ник (из Tab) в белом списке', () => {
  const t = setup();
  t.bot.players = { BARABYLKAyt: { username: 'BARABYLKAyt', displayName: { toString: () => '[Ender] сеньорпамидор' } } };
  t.guard.onCommand('/home farm');
  teleport(t);
  t.guard.onChat('| Окружающие игроки: [Ender] сеньорпамидор(4m)');
  assert.deepEqual(t.cmds(), []);
});

test('охрана: белый список меняется на ходу — сразу действует', () => {
  const t = setup({ whitelist: '' });
  t.guard.onCommand('/home home');
  teleport(t);
  t.cfg.whitelist = 'Friend_1';
  t.guard.onChat('| Окружающие игроки: [Игрок] friend_1(20m)');
  assert.deepEqual(t.cmds(), []);
  t.cfg.whitelist = '';
  t.guard.onChat('| Окружающие игроки: [Игрок] friend_1(20m)');
  assert.deepEqual(t.cmds(), ['/spawn']);
});

test('охрана: игрока видно глазами — не ждёт /near; NPC и свои не в счёт', () => {
  const t = setup();
  t.guard.onCommand('/home home');
  teleport(t, 100, 64, 100);
  const near = (dx) => ({ position: new Vec3(100 + dx, 64, 100) });
  t.bot.players = {
    kakajambbba: { username: 'kakajambbba', entity: t.bot.entity },
    '#1479d9c455b1f85': { username: '#1479d9c455b1f85', entity: near(2) }, // NPC
    BARABYLKAyt: { username: 'BARABYLKAyt', entity: near(3) },
  };
  t.timers.advance(1000);
  assert.ok(!t.cmds().includes('/spawn'));
  t.bot.players.Griefer = { username: 'Griefer', entity: near(30) };
  t.timers.advance(1000);
  assert.ok(t.cmds().includes('/spawn'));
  assert.ok(t.logs.includes('warn:Охрана: рядом чужой — Griefer (30 м, виден). Ухожу на спавн (/spawn)'));
});

test('охрана: в бою (PvP) телепорт запрещён — /spawn сразу после выхода из боя', () => {
  const t = setup();
  t.guard.onCommand('/home home');
  teleport(t);
  t.guard.onChat('| Вы вошли в режим PvP! Не выходите из игры, иначе будете наказаны!');
  t.guard.onChat('| Окружающие игроки: [Игрок] Griefer(5m)');
  assert.ok(!t.cmds().includes('/spawn'));
  assert.ok(t.logs.some((l) => l.startsWith('warn:Охрана: рядом чужой — Griefer (5 м), но идёт бой (PvP)')));
  t.guard.onChat('| Вы вышли из режима PvP! Можете использовать команды и выходить из игры.');
  assert.ok(t.cmds().includes('/spawn'));
});

test('охрана: /spawn, /warp ah и выключатель в настройках', () => {
  const t = setup();
  t.guard.onCommand('/home home');
  t.guard.onCommand('/warp ah');
  assert.equal(t.guard.armed, false);
  assert.ok(t.logs.includes('info:Охрана выключена: бот ушёл на /warp ah'));
  t.guard.onCommand('/spawner'); // магазин спавнеров — не /spawn
  t.guard.onCommand('/homes');
  assert.equal(t.guard.armed, false, '/homes — список домов, не телепорт');

  t.cfg.guard = false;
  t.guard.onCommand('/home home');
  assert.equal(t.guard.armed, false);
  assert.equal(t.guard.status(), 'Охрана выключена в настройках');
});

test('охрана: на спавне (мир lobby) не включается; /rtp не сработал — через 12 с выключается, а не бежит на /spawn', () => {
  const t = setup({ whitelist: '' });
  t.bot.worldName = 'lobby';
  t.bot.players = { griefbot5: { username: 'griefbot5', entity: { position: new Vec3(37, 65, 0) } } };
  t.guard.onCommand('/rtp');
  t.bot.entity.position = new Vec3(26.7, 63, -25.9); // сервер подвинул в пределах спавна
  t.guard.onTeleport();
  assert.equal(t.guard.active, false, 'всё ещё лобби — ждёт настоящего телепорта');
  t.timers.advance(12000);
  assert.equal(t.guard.armed, false);
  assert.ok(t.logs.includes('info:Охрана выключена: телепорт не состоялся — бот на спавне'));
  t.timers.advance(10000);
  assert.deepEqual(t.cmds(), [], 'модератор на спавне — не повод писать /spawn');

  // /rtp сработал: другой мир — охрана включилась; вернулся на спавн (сам или сервер вернул) — выключилась.
  t.guard.onCommand('/rtp');
  t.bot.worldName = 'overworld';
  t.bot.entity.position = new Vec3(-3574, 91, -12602);
  t.guard.onTeleport();
  assert.equal(t.guard.active, true);
  t.bot.worldName = 'lobby';
  t.guard.onTeleport();
  assert.equal(t.guard.armed, false);
  assert.ok(t.logs.includes('info:Охрана выключена: бот на спавне'));
  assert.equal(t.guard.activateNow('вручную'), false, '#охрана вкл на спавне не включает');
});

test('охрана: телепорта не было (дом рядом) — через 12 с проверяет и так; смена мира — тоже телепорт', () => {
  const t = setup();
  t.guard.onCommand('/home near');
  t.bot.entity.position = new Vec3(3, 65, 0); // 3 блока — не телепорт
  t.guard.onTeleport();
  assert.equal(t.guard.active, false);
  t.timers.advance(12000);
  assert.equal(t.guard.active, true);
  assert.ok(t.logs.some((l) => l.includes('телепорта не заметил')));

  const u = setup();
  u.guard.onCommand('/home end');
  u.bot.game.dimension = 'minecraft:the_end';
  u.guard.onTeleport();
  assert.equal(u.guard.active, true);
});

function godSetup(config = {}, { remembered = null, gameMode = 'survival' } = {}) {
  const timers = fakeTimers();
  const sent = [];
  const logs = [];
  const states = [];
  const cfg = { godMode: true, ...config };
  const bot = { game: { gameMode } };
  const god = new GodKeeper({
    send: (cmd) => {
      sent.push(cmd);
      god.onCommand(cmd);
      return true;
    },
    log: (level, text) => logs.push(`${level}:${text}`),
    config: cfg,
    getBot: () => bot,
    remembered,
    onState: (on) => states.push(on),
    timers,
  });
  return { god, timers, sent, logs, cfg, bot, states };
}

test('режим бога: /god — переключатель: выключился — ещё раз (через 3 с), включился — всё; состояние запоминается', () => {
  const g = godSetup();
  g.god.schedule(3000);
  g.timers.advance(2999);
  assert.deepEqual(g.sent, []);
  g.timers.advance(1);
  assert.deepEqual(g.sent, ['/god']);
  g.god.onChat('| Режим Бога выключено.'); // MineBlaze: был включён с прошлого раза — переключатель выключил
  g.timers.advance(2900);
  assert.deepEqual(g.sent, ['/god'], 'не чаще, чем раз в 3 с');
  g.timers.advance(800);
  assert.deepEqual(g.sent, ['/god', '/god']);
  g.god.onChat('| Режим Бога включен.');
  assert.ok(g.logs.includes('ok:Режим бога включён'));
  assert.deepEqual(g.states, [false, true]);
  g.timers.advance(60000);
  assert.deepEqual(g.sent, ['/god', '/god']);
});

test('режим бога: был включён в прошлой сессии — после входа не трогает; бот теряет здоровье или сытость — /god', () => {
  const g = godSetup({}, { remembered: true });
  g.god.schedule(3000);
  g.timers.advance(10000);
  assert.deepEqual(g.sent, [], 'включён по памяти — переключатель не трогаем');
  g.god.onHealth(20, 20);
  g.god.onHealth(20, 20);
  g.god.onHealth(20, 19); // в режиме бога сытость не падает
  assert.deepEqual(g.sent, ['/god']);
  assert.ok(g.logs.some((l) => l.startsWith('warn:Режим бога, похоже, выключен')));
  g.god.onChat('| Режим Бога включен.');
  g.god.onHealth(20, 20); // сервер вернул сытость
  g.god.onHealth(18, 20);
  assert.deepEqual(g.sent, ['/god'], 'сразу после /god — не дёргаем снова');
});

test('режим бога: в лобби («приключение») /god не пишет; сервер не ответил — ещё одна попытка, потом подсказка', () => {
  const lobby = godSetup({}, { gameMode: 'adventure' });
  lobby.god.schedule(0);
  lobby.timers.advance(10000);
  assert.deepEqual(lobby.sent, []);

  const g = godSetup();
  g.god.schedule(0);
  g.timers.advance(0);
  assert.deepEqual(g.sent, ['/god']);
  g.timers.advance(5000 + 3000); // ответа нет — ещё раз
  assert.deepEqual(g.sent, ['/god', '/god']);
  g.timers.advance(5000);
  assert.ok(g.logs.some((l) => l.startsWith('warn:Режим бога: на /god сервер ничего понятного не ответил')));
  g.timers.advance(30000);
  assert.equal(g.sent.length, 2);
});

test('режим бога: нет прав — не долбит; три неудачи подряд — сдаётся; выключатель в настройках', () => {
  const g = godSetup();
  g.god.schedule(0);
  g.timers.advance(0);
  g.god.onChat('| У вас нет прав на эту команду.');
  assert.ok(g.logs.some((l) => l.startsWith('warn:Режим бога: сервер не дал выполнить /god')));
  g.god.onChat('| Режим бога выключен!');
  g.timers.advance(10000);
  assert.deepEqual(g.sent, ['/god']);

  const h = godSetup();
  h.god.schedule(0);
  h.timers.advance(0);
  for (let i = 0; i < 5; i += 1) {
    h.god.onChat('| God mode disabled.');
    h.timers.advance(4000);
  }
  assert.equal(h.sent.length, 3);
  assert.ok(h.logs.some((l) => l.includes('после трёх /god он всё ещё выключен')));

  const off = godSetup({ godMode: false });
  off.god.schedule(0);
  off.timers.advance(1000);
  assert.deepEqual(off.sent, []);
});

test('режим бога: сообщение игрока в чате — не ответ сервера', () => {
  const g = godSetup();
  g.god.schedule(0);
  g.timers.advance(0);
  g.god.onChat('[Ender] Yarik_thr: Режим бога выключен ахах');
  g.timers.advance(5000);
  assert.deepEqual(g.sent, ['/god']);
});
