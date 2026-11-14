'use strict';

// Много ботов (src/fleet.js): раскладка по процессам, общая очередь входа, «всем ботам», аварии процессов.
// Процессы — в памяти (test/fake-host.js), сеть не нужна.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { Fleet } = require(path.join(__dirname, '..', 'src', 'fleet.js'));
const { inMemory, flush, hangs } = require('./fake-host');

const accounts = (n, prefix = 'Farm') => Array.from({ length: n }, (_, i) => ({ username: `${prefix}${String(i + 1).padStart(2, '0')}`, password: i % 2 ? `p${i}` : '' }));

function makeFleet({ perProcess = 3, gapMs = 30, autoReconnect = false, timings = {} } = {}) {
  const mem = inMemory();
  const config = { host: 'mineblaze.net', botsPerProcess: perProcess, startInterval: 5, autoReconnect, loginPassword: 'common', accounts: 'секрет' };
  const fleet = new Fleet({
    fork: () => mem.fork(),
    initPayload: () => ({ authCacheDir: '/a', journalDir: '/j' }),
    config,
    timings: { startGapMs: gapMs, broadcastGap: 5, captchaBurst: 0, ...timings },
    clientTimings: { restartDelay: 10, requestTimeout: 2000, shutdownTimeout: 200 },
  });
  const events = [];
  for (const name of ['log', 'state', 'chat', 'list', 'crash', 'turn']) fleet.on(name, (p) => events.push([name, p]));
  const managers = () => mem.children.filter((c) => !c.dead).flatMap((c) => c.managers);
  const managerOf = (nick) => managers().find((m) => m.opts.config.username === nick);
  return { fleet, mem, config, events, managers, managerOf };
}

const waitFor = async (check, ms = 3000) => {
  for (let t = 0; t < ms; t += 10) {
    if (check()) return true;
    await flush(10);
  }
  return false;
};

test('флот: боты раскладываются по процессам (по botsPerProcess), процессы запускаются, только когда нужны', async () => {
  const { fleet, mem } = makeFleet({ perProcess: 3 });
  fleet.setAccounts(accounts(7));
  assert.deepEqual(fleet.list().map((b) => [b.nick, b.worker]), [
    ['Farm01', 0], ['Farm02', 0], ['Farm03', 0], ['Farm04', 1], ['Farm05', 1], ['Farm06', 1], ['Farm07', 2],
  ]);
  assert.equal(mem.children.length, 0, 'до «Старт» процессов нет');
  assert.deepEqual(fleet.summary(), { total: 7, online: 0, connected: 0, connecting: 0, queued: 0, reconnecting: 0, offline: 7, processes: 0 });

  // Новый бот — в процесс, где есть место; убранный освобождает место.
  fleet.setAccounts([...accounts(7).filter((a) => a.username !== 'Farm02'), { username: 'Extra1' }, { username: 'Extra2' }]);
  assert.equal(fleet.get('Extra1').worker, 0, 'место после Farm02');
  assert.equal(fleet.get('extra2').worker, 2);
  assert.equal(fleet.get('Farm02'), null);
  await fleet.shutdown();
});

test('флот: «Старт всех» — входят по одному, по порядку списка, с паузой; у каждого свои ник и пароль', async () => {
  const { fleet, mem, managers, managerOf } = makeFleet({ perProcess: 3, gapMs: 40 });
  fleet.setAccounts(accounts(7));
  assert.equal(await fleet.start(), 7);
  assert.equal(mem.children.length, 3);
  assert.ok(await waitFor(() => fleet.summary().online === 7), JSON.stringify(fleet.summary()));
  const admitted = managers().slice().sort((a, b) => a.admittedAt - b.admittedAt);
  assert.deepEqual(admitted.map((m) => m.opts.config.username), accounts(7).map((a) => a.username), 'по порядку списка');
  for (let i = 1; i < admitted.length; i += 1) {
    assert.ok(admitted[i].admittedAt - admitted[i - 1].admittedAt >= 30, `пауза между ${i} и ${i + 1}`);
  }
  assert.equal(managerOf('Farm01').opts.config.loginPassword, 'common');
  assert.equal(managerOf('Farm02').opts.config.loginPassword, 'p1');
  // Пароли всех ботов процессам не уходят, а ники всех — уходят (охрана считает своих своими).
  const cfg = managerOf('Farm05').opts.config;
  assert.equal(cfg.accounts, undefined);
  assert.equal(cfg.fleetNicks, accounts(7).map((a) => a.username).join('\n'));
  assert.equal(await fleet.start(), 0, 'все и так запущены');
  assert.equal(fleet.summary().processes, 3);
  await fleet.shutdown();
});

test('флот: стоп в очереди — бот из неё выходит, остальные входят; «Стоп всех»; один бот', async () => {
  const { fleet, managerOf } = makeFleet({ perProcess: 2, gapMs: 60 });
  fleet.setAccounts(accounts(4));
  await fleet.start();
  await flush(5);
  assert.equal(fleet.get('Farm03').state, 'queued');
  assert.equal(await fleet.stop(['farm03']), 1);
  assert.ok(await waitFor(() => fleet.summary().online === 3));
  assert.ok(!managerOf('Farm03').calls.includes('admit'), 'остановленного в очереди не пускают');
  assert.equal(fleet.get('Farm03').state, 'offline');

  assert.equal(await fleet.stop(), 3);
  assert.ok(await waitFor(() => fleet.summary().offline === 4));
  assert.equal(await fleet.start(['Farm04']), 1);
  assert.ok(await waitFor(() => fleet.get('Farm04').state === 'online'));
  assert.equal(fleet.summary().online, 1);
  await fleet.shutdown();
});

test('флот: переподключения — через ту же очередь (не все сразу после падения сервера)', async () => {
  const { fleet, managers } = makeFleet({ perProcess: 5, gapMs: 40 });
  fleet.setAccounts(accounts(5));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.summary().online === 5));
  for (const m of managers()) m.drop(); // сервер перезапустился: обрыв у всех
  await flush(5);
  assert.ok(fleet.summary().online <= 1, 'сразу — не больше одного');
  assert.ok(await waitFor(() => fleet.summary().online === 5));
  const times = managers().map((m) => m.admittedAt).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i += 1) assert.ok(times[i] - times[i - 1] >= 30, 'и после обрыва — по одному');
  await fleet.shutdown();
});

test('флот: «всем ботам» — только команды, всем в сети по очереди; сообщение одному — выбранному', async () => {
  const { fleet, managerOf, events } = makeFleet({ perProcess: 2, gapMs: 1 });
  fleet.setAccounts(accounts(5));
  await fleet.start(['Farm01', 'Farm03']);
  assert.ok(await waitFor(() => fleet.summary().online === 2));
  assert.deepEqual(fleet.broadcast('привет всем'), { targets: 0, refused: 'всем сразу — только команды «/…» серверу или «#…» боту; обычное сообщение — выбери «всем по очереди»' });
  assert.deepEqual(fleet.broadcast('/warp ah'), { targets: 2 });
  assert.ok(await waitFor(() => managerOf('Farm03').calls.includes('say:/warp ah')));
  assert.ok(managerOf('Farm01').calls.includes('say:/warp ah'));
  assert.ok(!managerOf('Farm02').calls.some((c) => c.startsWith('say:')), 'не в сети — не отправляем');

  assert.equal(await fleet.say('farm03', 'привет'), true);
  await flush();
  assert.ok(events.some(([n, p]) => n === 'chat' && p.bot === 'farm03' && p.nick === 'Farm03' && p.text === '› привет'));
  assert.equal(await fleet.say('farm05', 'привет'), false, 'процесс бота ещё не запускали — некому');
  assert.equal(await fleet.say('nobody', 'привет'), false);
  assert.equal(await fleet.setAutoReconnect(true), true);
  assert.ok(managerOf('Farm01').calls.includes('autoReconnect:true:quiet'));
  await fleet.shutdown();
});

test('флот: «всем по очереди» — команда боту по одному (следующий — когда закончил предыдущий); «#стоп» всем — останавливает', async () => {
  const { fleet, managers, managerOf, events } = makeFleet({ perProcess: 2, gapMs: 1 });
  fleet.setAccounts(accounts(4));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.summary().online === 4));
  managerOf('Farm03').failCommands = true;
  assert.deepEqual(fleet.runInTurn('#квесты принести'), { targets: 4 });
  assert.match(fleet.runInTurn('#где').refused, /^уже идёт очередь «#квесты принести» \(0 из 4\)/);
  assert.ok(await waitFor(() => events.some(([n]) => n === 'turn')));
  const runs = managers().flatMap((m) => (m.runs || []).map((r) => ({ ...r, nick: m.opts.config.username }))).sort((a, b) => a.started - b.started);
  assert.deepEqual(runs.map((r) => r.nick), ['Farm01', 'Farm02', 'Farm03', 'Farm04'], 'по порядку списка');
  for (let i = 1; i < runs.length; i += 1) assert.ok(runs[i].started >= runs[i - 1].ended - 1, `${runs[i].nick} начал, когда ${runs[i - 1].nick} закончил`);
  const done = events.find(([n]) => n === 'turn')[1];
  assert.deepEqual(done, { line: '#квесты принести', total: 4, ok: 3, failed: ['Farm03'], cancelled: false });
  assert.ok(events.some(([n, p]) => n === 'log' && p.text === 'По очереди «#квесты принести»: готово — без ошибок 3 из 4; не вышло: Farm03'));

  // «#стоп» всем: тот, кто начал, доделывает, новые не начинают.
  events.length = 0;
  for (const m of managers()) m.commandMs = 80;
  fleet.runInTurn('#квесты купить');
  await flush(20);
  fleet.broadcast('#стоп');
  assert.ok(await waitFor(() => events.some(([n]) => n === 'turn')));
  const stopped = events.find(([n]) => n === 'turn')[1];
  assert.equal(stopped.cancelled, true);
  assert.equal(managers().filter((m) => (m.runs || []).some((r) => r.line === '#квесты купить')).length, 1, 'начал только первый');
  // До ботов другого процесса «#стоп» идёт своим сообщением — может прийти чуть позже конца очереди.
  assert.ok(await waitFor(() => managerOf('Farm04').calls.includes('say:#стоп')), '#стоп ушёл и самим ботам');
  assert.deepEqual(fleet.runInTurn('#где'), { targets: 4 }, 'после остановки можно новую очередь');
  await fleet.shutdown();
});

test('флот: «всем по очереди» — и «/…», и обычное сообщение: друг за другом через паузу; пароль в консоль не пишется', async () => {
  const { fleet, managers, events } = makeFleet({ perProcess: 2, gapMs: 1, timings: { turnGap: 40 } });
  fleet.setAccounts(accounts(3));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.summary().online === 3));
  const said = [];
  for (const m of managers()) {
    const say = m.say.bind(m);
    m.say = (text) => {
      said.push({ nick: m.opts.config.username, text, at: Date.now() });
      return say(text);
    };
  }
  assert.deepEqual(fleet.runInTurn('/reg Secr3t'), { targets: 3 });
  assert.ok(await waitFor(() => events.some(([n]) => n === 'turn')));
  assert.deepEqual(said.map((s) => [s.nick, s.text]), [['Farm01', '/reg Secr3t'], ['Farm02', '/reg Secr3t'], ['Farm03', '/reg Secr3t']]);
  for (let i = 1; i < said.length; i += 1) assert.ok(said[i].at - said[i - 1].at >= 35, `пауза перед ${said[i].nick}: ${said[i].at - said[i - 1].at} мс`);
  const logs = events.filter(([n]) => n === 'log').map(([, p]) => p.text);
  assert.ok(logs.includes('По очереди, ботов: 3 — /reg •••• (друг за другом через 0.04 с)'), logs.join('\n'));
  assert.ok(logs.includes('По очереди «/reg ••••»: готово — отправили 3 из 3'), logs.join('\n'));
  // (В чат бота команда уходит как есть — её маскирует сам менеджер бота; у подделки маски нет.)
  assert.ok(!JSON.stringify(events.filter(([n]) => n !== 'chat')).includes('Secr3t'), 'пароль в консоль не попал');

  said.length = 0;
  events.length = 0;
  assert.deepEqual(fleet.runInTurn('всем привет'), { targets: 3 });
  assert.ok(await waitFor(() => events.some(([n]) => n === 'turn')));
  assert.deepEqual(said.map((s) => s.text), ['всем привет', 'всем привет', 'всем привет']);
  await fleet.shutdown();
});

test('флот: проверка «я не робот» — очередь входа ждёт, пока её пройдут (или не дольше заданного)', async () => {
  const { fleet, managerOf, events } = makeFleet({ perProcess: 3, gapMs: 60, timings: { captchaHoldMs: 400 } });
  fleet.setAccounts(accounts(3));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.get('Farm01').state === 'online'));
  managerOf('Farm01').emit('captcha', { time: 1, url: 'https://mineblaze.net/antibot/?id=1' });
  assert.ok(await waitFor(() => events.some(([n, p]) => n === 'log' && /^Очередь входа ждёт: Farm01 проходит проверку «я не робот»/.test(p.text))));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fleet.get('Farm02').state, 'queued', 'пока Farm01 не прошёл проверку, следующий не входит');
  managerOf('Farm01').emit('captcha-done', { time: 2 });
  assert.ok(await waitFor(() => fleet.get('Farm02').state === 'online', 300), 'прошёл — следующий входит');

  // Farm02 так и не прошёл проверку — дольше captchaHoldMs очередь не стоит.
  managerOf('Farm02').emit('captcha', { time: 3, url: 'https://mineblaze.net/antibot/?id=2' });
  const since = Date.now();
  assert.ok(await waitFor(() => fleet.get('Farm03').state === 'online', 2000));
  assert.ok(Date.now() - since >= 350, `ждала ${Date.now() - since} мс`);
  await fleet.shutdown();
});

test('флот: «IP заблокирован» — очередь входа ждёт конца блокировки у всех; итог входа — кто не вошёл и почему', async () => {
  const { fleet, managerOf, events } = makeFleet({ perProcess: 3, gapMs: 200, timings: { ipBlockExtraMs: 0 } });
  fleet.setAccounts(accounts(3));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.get('Farm01').state === 'online'));
  const since = Date.now();
  managerOf('Farm01').emit('ip-block', { time: since, until: since + 500, minutes: 10 });
  assert.ok(await waitFor(() => events.some(([n, p]) => n === 'log' && /^Сервер заблокировал наш IP на 10 мин \(кик Farm01\)/.test(p.text))));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(fleet.get('Farm02').state, 'queued', 'пока IP заблокирован, следующий не входит');
  // Farm03 так и не вошёл (в его консоли — причина): итог входа это скажет.
  managerOf('Farm03').emit('log', { time: 1, level: 'error', text: 'Не удалось подключиться: вход не завершился за 30 с — прокси держит бота' });
  managerOf('Farm03')._set('offline');
  assert.ok(await waitFor(() => fleet.get('Farm02').state === 'online', 2000), 'блокировка кончилась — входит');
  assert.ok(Date.now() - since >= 450, `ждала ${Date.now() - since} мс`);
  assert.ok(await waitFor(() => events.some(([n, p]) => n === 'log' && p.text ===
    'Вход окончен: в сети 2 из 3. Не вошли (1): Farm03 (вход не завершился за 30 с — прокси держит бота)')),
  events.filter(([n]) => n === 'log').map(([, p]) => p.text).join(' | '));

  // Все вошли — так и сказано.
  await fleet.stop();
  await waitFor(() => fleet.summary().offline === 3);
  events.length = 0;
  await fleet.start();
  assert.ok(await waitFor(() => events.some(([n, p]) => n === 'log' && p.text === 'Вход окончен: в сети все 3 из 3'), 3000));
  await fleet.shutdown();
});

test('флот: входы виснут подряд — сервер перестал пускать: очередь ждёт, пробует по одному, пустил — дальше', async () => {
  const { fleet, events } = makeFleet({ perProcess: 3, gapMs: 10, timings: { hungStreak: 2, hungHoldMs: 200, hungMaxHoldMs: 400 } });
  const logs = () => events.filter(([n]) => n === 'log').map(([, p]) => p.text);
  hangs.clear();
  for (const n of ['Farm03', 'Farm04', 'Farm05', 'Farm06']) hangs.add(n);
  fleet.setAccounts(accounts(6));
  try {
    await fleet.start();
    assert.ok(await waitFor(() => logs().some((t) => /^Сервер перестал пускать новых ботов: 2 входа подряд повисли/.test(t)), 3000),
      logs().join(' | '));
    assert.ok(logs().some((t) => /в сети 2\. Похоже на предел ботов с одного IP/.test(t)));
    // Пока ждёт — никого не пускает: повисших за 150 мс не прибавилось.
    const admitsAt = () => events.filter(([n, p]) => n === 'state' && p.state === 'connecting').length;
    const before = admitsAt();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(admitsAt(), before, 'во время паузы новых входов нет');
    // Проба тоже повисла — пауза вдвое дольше.
    assert.ok(await waitFor(() => logs().some((t) => /^Пробный вход \(Farm\d\d\) тоже повис/.test(t)), 3000), logs().join(' | '));
    // Сервер снова пускает — очередь идёт дальше, все входят.
    hangs.clear();
    assert.ok(await waitFor(() => logs().some((t) => /^Сервер снова пускает: Farm\d\d вошёл/.test(t)), 3000), logs().join(' | '));
    assert.ok(await waitFor(() => fleet.summary().online === 6, 3000), JSON.stringify(fleet.summary()));
    assert.ok(await waitFor(() => logs().includes('Вход окончен: в сети все 6 из 6')));
  } finally {
    hangs.clear();
    await fleet.shutdown();
  }
});

test('флот: итог входа — сколько остановлено вручную', async () => {
  const { fleet, events } = makeFleet({ perProcess: 3, gapMs: 80 });
  fleet.setAccounts(accounts(4));
  await fleet.start();
  await fleet.stop(['Farm03', 'Farm04']); // ещё ждали очереди
  assert.ok(await waitFor(() => events.some(([n, p]) => n === 'log' && p.text === 'Вход окончен: в сети 2 из 4; остановлены вручную: 2')),
    events.filter(([n]) => n === 'log').map(([, p]) => p.text).join(' | '));
  await fleet.shutdown();
});

test('флот: группе — «сразу» и «по очереди» только её ботам в сети', async () => {
  const { fleet, managerOf, events } = makeFleet({ perProcess: 2, gapMs: 1, timings: { turnGap: 5 } });
  fleet.setAccounts(accounts(4));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.summary().online === 4));
  assert.deepEqual(fleet.broadcast('привет', { ids: ['farm02'], who: 'группе' }), { targets: 0, refused: 'группе сразу — только команды «/…» серверу или «#…» боту; обычное сообщение — выбери «группе по очереди»' });
  assert.deepEqual(fleet.broadcast('/warp ah', { ids: ['Farm02', 'farm04'] }), { targets: 2 });
  assert.ok(await waitFor(() => managerOf('Farm04').calls.includes('say:/warp ah')));
  assert.ok(managerOf('Farm02').calls.includes('say:/warp ah'));
  assert.ok(!managerOf('Farm01').calls.includes('say:/warp ah') && !managerOf('Farm03').calls.includes('say:/warp ah'), 'не группе — не шлём');
  assert.deepEqual(fleet.runInTurn('#где', { ids: ['farm01', 'farm03'] }), { targets: 2 });
  assert.ok(await waitFor(() => events.some(([n]) => n === 'turn')));
  assert.ok(managerOf('Farm01').calls.includes('command:#где') && managerOf('Farm03').calls.includes('command:#где'));
  assert.ok(!managerOf('Farm02').calls.includes('command:#где'));
  await fleet.shutdown();
});

test('флот: «готов к делам» — после события бота; вышел из сети — уже не готов', async () => {
  const { fleet, managerOf } = makeFleet({ perProcess: 2, gapMs: 1 });
  fleet.setAccounts(accounts(2));
  const ready = [];
  fleet.on('ready', (p) => ready.push(p.nick));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.isReady('farm01') && fleet.isReady('farm02')));
  assert.deepEqual(ready.sort(), ['Farm01', 'Farm02']);
  const whileOut = [];
  fleet.on('state', (p) => {
    if (p.bot === 'farm01' && p.state !== 'online') whileOut.push(fleet.isReady('farm01'));
  });
  managerOf('Farm01').drop(); // обрыв: бот снова в очереди входа
  assert.ok(await waitFor(() => ready.length === 3), 'вошёл снова — снова готов');
  assert.ok(whileOut.length && whileOut.every((r) => r === false), `пока не в сети — не готов: ${whileOut}`);
  assert.equal(fleet.isReady('farm01'), true);
  assert.equal(fleet.isReady('nobody'), false);
  await fleet.shutdown();
});

test('флот: упал процесс — его боты не в сети; после перезапуска с автореконнектом снова входят', async () => {
  const { fleet, mem, events } = makeFleet({ perProcess: 2, gapMs: 1, autoReconnect: true });
  fleet.setAccounts(accounts(3));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.summary().online === 3));
  mem.children[0].crash(3);
  await flush(5);
  assert.deepEqual([fleet.get('Farm01').state, fleet.get('Farm02').state, fleet.get('Farm03').state], ['offline', 'offline', 'online']);
  const crash = events.find(([n]) => n === 'crash')[1];
  assert.deepEqual(crash, { worker: 0, code: 3, restarting: true, bots: ['farm01', 'farm02'] });
  assert.ok(await waitFor(() => fleet.summary().online === 3), 'вошли снова');
  assert.ok(events.some(([n, p]) => n === 'log' && p.text === 'Процесс ботов №1 перезапущен'));
  await fleet.shutdown();
});

test('флот: команда ботам для ИИ — «#…» по одному с ответом каждого, «/…» — ответ сервера из чата; стоп', async () => {
  const { fleet, config, managers, managerOf } = makeFleet({ perProcess: 2, gapMs: 1 });
  config.aiKey = 'sk-or-v1-секрет';
  fleet.setAccounts(accounts(4));
  await fleet.start(['Farm01', 'Farm02', 'Farm03']);
  assert.ok(await waitFor(() => fleet.summary().online === 3));
  assert.equal(managerOf('Farm01').opts.config.aiKey, undefined, 'ключ ИИ процессам ботов не уходит');
  managerOf('Farm02').failCommands = true;

  // Всем в сети: по одному, по порядку списка, у каждого — свой ответ.
  const all = await fleet.commandEach(null, '#где');
  assert.deepEqual(all.map((r) => [r.nick, r.ok, r.message]), [
    ['Farm01', true, ['#где: готово']], ['Farm02', false, ['#где: готово']], ['Farm03', true, ['#где: готово']],
  ]);
  const runs = managers().flatMap((m) => m.runs || []).sort((a, b) => a.started - b.started);
  for (let i = 1; i < runs.length; i += 1) assert.ok(runs[i].started >= runs[i - 1].ended - 1, 'следующий — когда закончил предыдущий');
  // По никам (любой регистр); не в сети — так и сказано.
  const some = await fleet.commandEach(['farm03', 'Farm04'], '#где');
  assert.deepEqual(some.map((r) => [r.nick, r.ok, r.code]), [['Farm03', true, null], ['Farm04', false, 'offline']]);
  await assert.rejects(fleet.commandEach(null, 'привет'), /только команды/);

  // «/…»: ответ — сообщения сервера в чате бота; чат игроков не берём.
  for (const m of managers()) m.serverReply = (text) => [{ position: 'system', text: `| ответ на ${text}` }, { position: 'chat', text: '<Игрок> привет' }];
  fleet.timings.replyMs = 80;
  const warp = await fleet.commandEach(['Farm01', 'Farm03'], '/warp ah');
  assert.deepEqual(warp.map((r) => [r.nick, r.ok, r.message]), [['Farm01', true, ['| ответ на /warp ah']], ['Farm03', true, ['| ответ на /warp ah']]]);
  managerOf('Farm03').serverReply = () => [];
  const silent = await fleet.commandEach(['Farm03'], '/near');
  assert.deepEqual(silent[0].message, ['отправлено; сервер ничего не ответил']);

  // Стоп: тот, кто выполняет, получает «#стоп», остальные не начинают.
  for (const m of managers()) m.commandMs = 100;
  const abort = new AbortController();
  const pending = fleet.commandEach(null, '#квесты принести', { signal: abort.signal });
  await flush(30);
  abort.abort();
  const stopped = await pending;
  assert.deepEqual(stopped.map((r) => [r.nick, r.code]), [['Farm01', null], ['Farm02', 'stopped'], ['Farm03', 'stopped']]);
  assert.ok(await waitFor(() => managerOf('Farm01').calls.includes('say:#стоп')), '#стоп — тому, кто начал');
  assert.ok(!managerOf('Farm02').calls.includes('command:#квесты принести'), 'следующие не начали');
  await fleet.shutdown();
});

test('флот: команда одному боту — с данными команды (для автопилота заданий), тихо; не в сети — сразу ответ', async () => {
  const { fleet, managerOf } = makeFleet({ perProcess: 2, gapMs: 1 });
  fleet.setAccounts(accounts(2));
  await fleet.start(['Farm01']);
  assert.ok(await waitFor(() => fleet.summary().online === 1));
  // Данные переживают передачу между процессами (structuredClone в подделке, JSON в bot-host).
  managerOf('Farm01').commandReply = (line) => ({ ok: true, message: [`${line}: ок`], data: { npc: 'Фермер', quests: [{ title: 'Грядки', have: 0, need: 224 }], fn: () => 1 } });
  const r = await fleet.commandOne('farm01', '#квесты у Фермер', { quiet: true });
  assert.deepEqual(r, { bot: 'farm01', nick: 'Farm01', ok: true, code: null, message: ['#квесты у Фермер: ок'], data: { npc: 'Фермер', quests: [{ title: 'Грядки', have: 0, need: 224 }] } });
  assert.equal(managerOf('Farm01').runs.at(-1).quiet, true, 'тихо: строки ответа в консоль не пишутся');
  assert.equal((await fleet.commandOne('Farm02', '#где')).code, 'offline');
  assert.equal((await fleet.commandOne('Nobody', '#где')).code, 'unknown');
  await assert.rejects(fleet.commandOne('Farm01', '/warp ah'), /только команды «#…»/);
  // Для ИИ данные не нужны — в ответе всем их нет.
  const each = await fleet.commandEach(['Farm01'], '#где');
  assert.equal('data' in each[0], false);
  await fleet.shutdown();
});

test('флот: события ботов — с ником; убранный из списка бот выходит с сервера', async () => {
  const { fleet, events, managerOf } = makeFleet({ perProcess: 3, gapMs: 1 });
  fleet.setAccounts(accounts(2));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.summary().online === 2));
  assert.ok(events.some(([n, p]) => n === 'log' && p.bot === 'farm02' && p.nick === 'Farm02' && p.text === 'В сети: бот появился в мире'));
  // Пинг (как считает сервер) — у бота в списке; не в сети — пинга нет.
  managerOf('Farm01').emit('ping', 133);
  assert.ok(await waitFor(() => fleet.get('Farm01').ping === 133));
  assert.equal(fleet.list()[0].ping, 133);
  // Рыбалка (#рыбалка) — ход и улов доходят из процесса ботов до вкладки «Авто фиш» (с ником).
  const fished = [];
  fleet.on('fishing', (p) => fished.push(p));
  managerOf('Farm01').emit('fishing', { state: 'fishing', text: 'поймал: треска', caught: 3, items: [{ name: 'cod', label: 'треска', count: 3 }] });
  assert.ok(await waitFor(() => fished.length === 1));
  assert.deepEqual({ ...fished[0], items: fished[0].items.length }, { bot: 'farm01', nick: 'Farm01', state: 'fishing', text: 'поймал: треска', caught: 3, items: 1 });
  // Баланс с табло — туда же.
  const balances = [];
  fleet.on('balance', (p) => balances.push(p));
  managerOf('Farm01').emit('balance', { value: 837700, safe: 837650, text: '$837.7k' });
  assert.ok(await waitFor(() => balances.length === 1));
  assert.deepEqual(balances[0], { bot: 'farm01', nick: 'Farm01', value: 837700, safe: 837650, text: '$837.7k' });
  managerOf('Farm01').stop();
  assert.ok(await waitFor(() => fleet.get('Farm01').state === 'offline'));
  assert.equal(fleet.get('Farm01').ping, null);
  const gone = managerOf('Farm02');
  fleet.setAccounts(accounts(1));
  assert.ok(await waitFor(() => gone.calls.includes('shutdown')));
  assert.deepEqual(fleet.list().map((b) => b.nick), ['Farm01']);
  assert.ok(events.some(([n, p]) => n === 'list' && p.length === 1));
  await fleet.shutdown();
});

// ---------- прокси из пула: у каждого бота свой (botsPerProxy), лишние — не на чужой ----------

const POOL = ['socks5://u1:p1@10.0.0.1:1081', '# socks5://old:old@10.9.9.9:1080', 'socks5://u2:p2@10.0.0.2:1082', 'socks5://u3:p3@10.0.0.3:1083'].join(String.fromCharCode(10));
const proxyOf = (fleet, nick) => {
  const b = fleet.get(nick);
  return b && b.proxy ? b.proxy.host : null;
};

test('прокси: по одному на бота — у каждого свой; не хватило — бот не запускается, в консоли кто и что делать', async () => {
  const { fleet, config, events } = makeFleet({ perProcess: 3, gapMs: 20 });
  Object.assign(config, { proxyPool: POOL, botsPerProxy: 1 });
  fleet.setAccounts(accounts(5));
  assert.deepEqual(accounts(5).map((a) => proxyOf(fleet, a.username)), ['10.0.0.1', '10.0.0.2', '10.0.0.3', null, null]);
  assert.equal(await fleet.start(), 3, 'запущены только те, кому хватило прокси');
  assert.ok(events.some(([n, p]) => n === 'log' && /^Не запускаю 2 ботов: прокси на всех не хватает — в пуле 3, по 1 боту на прокси/.test(p.text) && /Farm04, Farm05/.test(p.text)));
  assert.ok(await waitFor(() => fleet.summary().online === 3));
  assert.equal(fleet.get('Farm04').state, 'offline');
  await fleet.shutdown();
});

test('прокси: список дополнили — новые боты не садятся на занятые прокси; убрали бота — его прокси достаётся ждущему', async () => {
  const { fleet, config } = makeFleet({ perProcess: 3 });
  Object.assign(config, { proxyPool: POOL, botsPerProxy: 1 });
  fleet.setAccounts(accounts(2));
  assert.deepEqual([proxyOf(fleet, 'Farm01'), proxyOf(fleet, 'Farm02')], ['10.0.0.1', '10.0.0.2']);
  // Раньше счёт шёл заново с первого прокси: Farm03 сел бы на прокси Farm01.
  fleet.setAccounts(accounts(4));
  assert.deepEqual(accounts(4).map((a) => proxyOf(fleet, a.username)), ['10.0.0.1', '10.0.0.2', '10.0.0.3', null]);
  assert.equal(fleet.get('Farm04').noProxy, true);
  fleet.setAccounts(accounts(4).filter((a) => a.username !== 'Farm02'));
  assert.equal(proxyOf(fleet, 'Farm04'), '10.0.0.2', 'освободившийся прокси — тому, кому не хватило');
  assert.equal(fleet.get('Farm04').noProxy, false);
  await fleet.shutdown();
});

test('прокси: по 2 на прокси — сначала всем по одному (наименее занятый), больше двух ни на одном', async () => {
  const { fleet, config } = makeFleet({ perProcess: 4 });
  Object.assign(config, { proxyPool: POOL, botsPerProxy: 2 });
  fleet.setAccounts(accounts(7));
  const hosts = accounts(7).map((a) => proxyOf(fleet, a.username));
  assert.deepEqual(hosts, ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.1', '10.0.0.2', '10.0.0.3', null]);
  await fleet.shutdown();
});

test('флот: лимит проверок «я не робот» — после N проверок подряд очередь входа ждёт (MineBlaze: «превысили лимит»)', async () => {
  const { fleet, managerOf, events } = makeFleet({
    perProcess: 3, gapMs: 20, timings: { captchaHoldMs: 5000, captchaBurst: 2, captchaWindowMs: 700 },
  });
  fleet.setAccounts(accounts(3));
  await fleet.start();
  assert.ok(await waitFor(() => fleet.get('Farm01').state === 'online'));
  const first = Date.now();
  managerOf('Farm01').emit('captcha', { time: 1, url: 'https://mineblaze.net/antibot/?id=1' });
  await flush(20);
  managerOf('Farm01').emit('captcha-done', { time: 2 });
  // Одна проверка из двух — следующий входит сразу.
  assert.ok(await waitFor(() => fleet.get('Farm02').state === 'online', 400), 'вторая проверка ещё в лимите');
  managerOf('Farm02').emit('captcha', { time: 3, url: 'https://mineblaze.net/antibot/?id=2' });
  await flush(20);
  managerOf('Farm02').emit('captcha-done', { time: 4 });
  assert.ok(await waitFor(() => events.some(([n, p]) => n === 'log' && /^Проверок «я не робот» подряд: 2 — больше MineBlaze сразу не даёт/.test(p.text))));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fleet.get('Farm03').state, 'queued', 'две проверки подряд — третий ждёт');
  assert.ok(await waitFor(() => fleet.get('Farm03').state === 'online', 3000));
  assert.ok(Date.now() - first >= 650, `третий вошёл через ${Date.now() - first} мс после первой проверки`);
  await fleet.shutdown();
});

test('только через прокси: прокси не заданы — боты не запускаются вовсе (с IP компьютера не входят)', async () => {
  const { fleet, config, events, mem } = makeFleet({ perProcess: 3 });
  config.proxyOnly = true;
  fleet.setAccounts(accounts(3));
  assert.equal(await fleet.start(), 0);
  assert.ok(events.some(([n, p]) => n === 'log' && /^Не запускаю ботов \(3\): прокси не заданы, а включено «Только через прокси»/.test(p.text)));
  assert.equal(mem.children.length, 0, 'процессы ботов даже не запускались');
  // С пулом — входят только те, у кого есть прокси.
  config.proxyPool = POOL;
  config.botsPerProxy = 1;
  fleet.setAccounts([...accounts(3), { username: 'Extra1' }]);
  // Боты, созданные без пула, получили прокси, как только он появился; четвёртому не хватило.
  assert.deepEqual(accounts(3).map((a) => proxyOf(fleet, a.username)), ['10.0.0.1', '10.0.0.2', '10.0.0.3']);
  assert.ok(fleet.get('Extra1').noProxy);
  await fleet.shutdown();
});

test('прокси: боту не хватило, потом освободился — в уже запущенном процессе бот входит через выданный прокси, а не с IP компьютера', async () => {
  const { fleet, config, managerOf } = makeFleet({ perProcess: 4, gapMs: 10 });
  Object.assign(config, { proxyPool: POOL, botsPerProxy: 1 });
  fleet.setAccounts(accounts(4));
  assert.equal(await fleet.start(), 3); // процесс запущен, Farm04 в нём есть, но без прокси
  assert.ok(await waitFor(() => fleet.summary().online === 3));
  assert.equal(managerOf('Farm04').proxy, null);
  assert.equal(fleet.list().find((b) => b.nick === 'Farm04').proxy, 'нет');
  await fleet.stop([fleet.get('Farm02').bot]);
  fleet.setAccounts(accounts(4).filter((a) => a.username !== 'Farm02'));
  assert.ok(await waitFor(() => managerOf('Farm04').proxy && managerOf('Farm04').proxy.host === '10.0.0.2'), 'бот узнал выданный прокси');
  assert.equal(fleet.list().find((b) => b.nick === 'Farm04').proxy, '10.0.0.2:1082');
  assert.equal(await fleet.start([fleet.get('Farm04').bot]), 1);
  assert.ok(await waitFor(() => fleet.get('Farm04').state === 'online'));
  await fleet.shutdown();
});
