'use strict';

// Много ботов (src/fleet.js): раскладка по процессам, общая очередь входа, «всем ботам», аварии процессов.
// Процессы — в памяти (test/fake-host.js), сеть не нужна.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { Fleet } = require(path.join(__dirname, '..', 'src', 'fleet.js'));
const { inMemory, flush } = require('./fake-host');

const accounts = (n, prefix = 'Farm') => Array.from({ length: n }, (_, i) => ({ username: `${prefix}${String(i + 1).padStart(2, '0')}`, password: i % 2 ? `p${i}` : '' }));

function makeFleet({ perProcess = 3, gapMs = 30, autoReconnect = false } = {}) {
  const mem = inMemory();
  const config = { host: 'mineblaze.net', botsPerProcess: perProcess, startInterval: 5, autoReconnect, loginPassword: 'common', accounts: 'секрет' };
  const fleet = new Fleet({
    fork: () => mem.fork(),
    initPayload: () => ({ authCacheDir: '/a', journalDir: '/j' }),
    config,
    timings: { startGapMs: gapMs, broadcastGap: 5 },
    clientTimings: { restartDelay: 10, requestTimeout: 2000, shutdownTimeout: 200 },
  });
  const events = [];
  for (const name of ['log', 'state', 'chat', 'list', 'crash']) fleet.on(name, (p) => events.push([name, p]));
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
  assert.deepEqual(fleet.broadcast('привет всем'), { targets: 0, refused: 'всем ботам — только команды: «/…» серверу или «#…» боту' });
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
