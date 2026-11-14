'use strict';

// Рыбалка, продолжение: удочки (целые и изношенные, ожидание новых), работа «Рыбак» в /jobs, деньги ботов —
// баланс с табло и /pay (src/bot/commands.js: #рыбалка, #работа, #баланс, #перевод). Сервер — поддельный.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { runFor } = require('./fake-bot');
const { setup, fishServer, rodItem, rodsIn, say, sidebarBalance } = require('./fish-fake');

const fishing = require(path.join(__dirname, '..', 'src', 'bot', 'fishing.js'));
const { attachSidebar } = require(path.join(__dirname, '..', 'src', 'bot', 'sidebar.js'));
const { runCommand } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));

const json = (text) => JSON.stringify({ text });
const textOf = (r) => [].concat(r.message).join('\n');

test('своя целая удочка — рыбачит сразу, по сундукам не ходит (раньше искал ещё две и «бегал» по складу)', async () => {
  const chests = [[2, 64, -2], [2, 64, 3], [-3, 64, 2], [-3, 64, -3], [1, 64, 5], [-1, 64, -5]];
  const storage = Object.fromEntries(chests.map(([x, y, z]) => [`${x},${y},${z}`, { items: [] }]));
  const s = setup({ storage });
  for (const [x, y, z] of chests) s.world.set(new Vec3(x, y, z), 'chest');
  s.bot.inventory.slots[40] = rodItem(0);
  fishServer(s.bot, { biteTicks: 30 });
  const states = [];
  s.bot.on('fishing', (e) => states.push(e.state));
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 1'), 900000);
  assert.ifError(r.error);
  assert.equal(r.value.ok, true, textOf(r.value));
  assert.equal(r.value.data.caught, 1);
  assert.ok(!states.includes('rods'), `за удочками не ходил: ${states.join(', ')}`);
  const keys = new Set(chests.map(([x, y, z]) => `${x},${y},${z}`));
  const opened = s.bot._client.sent.filter((p) => p.name === 'block_place' && keys.has(`${p.params.location.x},${p.params.location.y},${p.params.location.z}`));
  assert.equal(opened.length, 0, 'ни одного сундука не открывал');
});

test('удочка изношена — прочности 3 и меньше: и у обычной (64), и у особой на 1000', () => {
  assert.equal(fishing.ROD_SAVE_LEFT, 3);
  assert.equal(fishing.rodWorn(rodItem(0)), false);
  assert.equal(fishing.rodWorn(rodItem(45)), false, '19 из 64 — ловит (раньше порог был 30)');
  assert.equal(fishing.rodWorn(rodItem(60)), false, '4 из 64 — ещё ловит: улов стоит 1');
  assert.equal(fishing.rodWorn(rodItem(61)), true, '3 из 64 — в сундук');
  assert.equal(fishing.rodWorn(rodItem(63)), true, '1 из 64 — тоже');
  const big = (damage) => {
    const it = rodItem(damage);
    it.components.push({ type: 'max_damage', data: 1000 });
    return it;
  };
  assert.equal(fishing.rodMax(big(0)), 1000);
  assert.equal(fishing.rodWorn(big(996)), false, '4 из 1000');
  assert.equal(fishing.rodWorn(big(997)), true, '3 из 1000 — порог в единицах, не в процентах');
  const forever = rodItem(63);
  forever.components.push({ type: 'unbreakable', data: {} });
  assert.equal(fishing.rodWorn(forever), false, 'неразрушимая не изнашивается');
});

test('поплавок лёг на берег — не вытаскивает (это −2 прочности), а убирает сменой ячейки: прочность удочки цела', async () => {
  const s = setup({ at: { x: 5.5, y: 64, z: 0.5 } });
  const rod = rodItem(60); // осталось 4 — ещё ловит; вытащить с берега — 2, зацепленного моба — сломалась бы
  s.bot.inventory.slots[36] = rod;
  const st = fishServer(s.bot, { biteTicks: 100000, at: new Vec3(3.5, 64, 0.5) }); // поплавок — на камне берега
  const r = await runFor(s.clock, s.bot.actions.fish({ yaw: -Math.PI / 2, pitch: -0.25, rod }), 60000);
  assert.ifError(r.error);
  assert.equal(r.value.outcome, 'ground');
  assert.equal(st.reels, 0, 'не вытаскивал');
  assert.equal(st.drops, 1, 'убрал сменой ячейки');
  assert.equal(fishing.rodLeft(rod), 4, 'прочность та же');
  assert.equal(s.bot.actions.bobber, null, 'поплавка нет');
  assert.notEqual(s.bot.heldItem, rod, 'в руке — не удочка');
  // Следующий заброс — снова этой удочкой: берёт её в руку сама рыбалка.
  const again = await runFor(s.clock, s.bot.actions.fish({ yaw: -Math.PI / 2, pitch: -0.25, rod, maxWaitTicks: 60 }), 60000);
  assert.ifError(again.error);
  assert.equal(st.casts, 2);
  assert.equal(fishing.rodLeft(rod), 4);
});

test('изношенная удочка (прочность 3 и меньше) — в сундук склада; со склада берёт сначала новую, изношенные там не трогает', async () => {
  // В сундуке: потёртая (44 прочности), новая (64), изношенная (1).
  const spec = { items: [[0, 'fishing_rod', 1, [{ type: 'damage', data: 20 }]], [1, 'fishing_rod', 1], [2, 'fishing_rod', 1, [{ type: 'damage', data: 63 }]]] };
  const s = setup({ storage: { '2,64,-2': spec } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  s.bot.inventory.slots[36] = rodItem(63); // у бота — изношенная: 1
  fishServer(s.bot, { biteTicks: 30 });
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 1'), 900000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.equal(r.value.data.saved, 1, text);
  assert.equal(r.value.data.took, 1);
  assert.equal(fishing.rodLeft(s.bot.heldItem), 63, 'ловил новой (после улова — 63)');
  assert.deepEqual(rodsIn(spec), [1, 1, 44], 'в сундуке: изношенная бота, изношенная склада и потёртая');
  assert.match(text, /Изношенные удочки \(прочность 3 и меньше\) — в сундук: 1/);
});

test('общий сундук: бот положил удочку, а сосед в тот же миг взял другую — перенос засчитан (считает по своему инвентарю)', async () => {
  const { moveStacks, storageSlots, playerSlots } = require(path.join(__dirname, '..', 'src', 'bot', 'chests.js'));
  const spec = { items: [[0, 'fishing_rod', 1], [1, 'fishing_rod', 1]] };
  const s = setup({ storage: { '2,64,-2': spec } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  s.bot.inventory.slots[36] = rodItem(63);
  let window = null;
  s.bot.on('windowOpen', (w) => {
    window = w;
  });
  const opened = await runFor(s.clock, s.bot.actions.activate(new Vec3(2, 64, -2)), 30000);
  assert.ifError(opened.error);
  for (let i = 0; i < 10 && !window; i += 1) await runFor(s.clock, s.bot.actions.wait(50), 1000);
  assert.ok(window, 'сундук открылся');
  // Стенд 12.11: пока бот клал свою, соседний бот забрал из того же сундука новую — счёт сундука «не изменился».
  const click = s.bot.clickWindow;
  s.bot.clickWindow = async (slot, button, mode) => {
    await click(slot, button, mode);
    window.slots[0] = null;
  };
  const worn = (it) => it.name === 'fishing_rod' && fishing.rodWorn(it);
  const r = await runFor(s.clock, moveStacks(s.bot, window, playerSlots(window), storageSlots(window), worn), 60000);
  assert.ifError(r.error);
  assert.equal(r.value.moved.get('fishing_rod'), 1, 'положил одну');
  assert.equal(r.value.rejected, false);
  assert.equal(r.value.lost, 0);
});

test('удочка износилась за рыбалкой — кладёт её в сундук и ловит новой', async () => {
  const spec = { items: [[0, 'fishing_rod', 1]] };
  const s = setup({ storage: { '2,64,-2': spec } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  s.bot.inventory.slots[36] = rodItem(60); // 4 — ещё целая; после улова — 3: изношена
  fishServer(s.bot, { biteTicks: 30 });
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 2'), 900000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.data.caught, 2, text);
  assert.equal(r.value.data.saved, 1, text);
  assert.equal(r.value.data.took, 1, text);
  assert.deepEqual(rodsIn(spec), [3], 'изношенная (не сломанная) — в сундуке');
  assert.equal(fishing.rodLeft(s.bot.heldItem), 63, 'второй улов — новой удочкой');
});

test('целых удочек нет нигде — ждёт и раз в 5 мин смотрит сундуки; положили новую — рыбачит', async () => {
  const spec = { items: [] };
  const s = setup({ storage: { '2,64,-2': spec } });
  s.world.set(new Vec3(2, 64, -2), 'chest');
  s.bot.inventory.slots[36] = rodItem(63); // 1 — изношенная
  fishServer(s.bot, { biteTicks: 30 });
  const states = [];
  let waitAt = null;
  s.bot.on('fishing', (e) => {
    states.push(e.state);
    if (e.state === 'wait' && waitAt === null) waitAt = s.clock.now();
  });
  // Через минуту после «нужны новые удочки» человек кладёт в сундук новую.
  let added = false;
  s.bot.on('physicsTick', () => {
    if (!added && waitAt !== null && s.clock.now() - waitAt > 60000) {
      added = true;
      if (!spec.slots) spec.slots = [];
      spec.slots[5] = rodItem(0);
    }
  });
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 1'), 20 * 60000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.ok(states.includes('wait'), states.join(', '));
  assert.equal(r.value.data.caught, 1, text);
  assert.equal(r.value.data.saved, 1);
  assert.equal(r.value.data.took, 1);
  assert.match(text, /Ждал новые удочки: 1 раз по 5 мин/);
  assert.deepEqual(rodsIn(spec), [1], 'изношенная — в сундуке');
});

test('#работа: «Рыбак» не устроен — нажимает и ждёт «Вы устроились…»; 5 работ — увольняется с одной; уже устроен — не нажимает', async () => {
  const state = { jobs: { Шахтёр: true, Терафформер: true, Рыбак: false }, max: 2 };
  const names = { 10: 'Шахтёр', 11: 'Терафформер', 13: 'Рыбак' };
  const jobItem = (name) => ({
    name: 'prismarine', count: 1, customName: json(name),
    customLore: [json(`Статус: ${state.jobs[name] ? 'Вы устроены' : 'Вы не устроены'}`), json('Рабочих: 78'),
      json('Ловите рыбу и зарабатывайте деньги за свой улов.'), json(state.jobs[name] ? '▸ Нажмите, чтобы уволиться' : '▸ Нажмите, чтобы устроиться')],
  });
  let bot = null;
  const menu = () => {
    const w = { id: 9, title: json('Работы'), inventoryStart: 54, slots: new Array(90).fill(null) };
    for (const [slot, name] of Object.entries(names)) w.slots[slot] = jobItem(name);
    return w;
  };
  // Как сервер: нажал по своей работе — уволен; по чужой — устроен, если работ меньше лимита.
  const onClick = (w, slot) => {
    const name = names[slot];
    if (!name) return null;
    if (state.jobs[name]) {
      state.jobs[name] = false;
      setImmediate(() => say(bot, `| Вы уволились с работы ${name}.`));
    } else if (Object.values(state.jobs).filter(Boolean).length >= state.max) {
      setImmediate(() => say(bot, '| У Вас уже слишком много работ, доступно только 5 одновременно.'));
    } else {
      state.jobs[name] = true;
      setImmediate(() => say(bot, `| Вы устроились на работу ${name}.`));
    }
    w.slots[slot] = jobItem(name);
    return null;
  };
  const s = setup({ onClick });
  bot = s.bot;
  const sent = [];
  bot.sendCommand = (cmd) => {
    sent.push(cmd);
    if (cmd === '/jobs') {
      setImmediate(() => {
        const w = menu();
        bot.currentWindow = w;
        bot.emit('windowOpen', w);
      });
    }
    return true;
  };
  const r = await runFor(s.clock, runCommand(bot, '#работа'), 60000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.match(text, /Уволился с «Шахтёр», устроился: Рыбак/);
  assert.deepEqual(state.jobs, { Шахтёр: false, Терафформер: true, Рыбак: true });
  assert.equal(bot.currentWindow, null, 'меню закрыл');
  // Уже устроен — по своей работе не щёлкает (нажатие уволило бы).
  const clicks = bot.clicks.length;
  const r2 = await runFor(s.clock, runCommand(bot, '#работа рыбак'), 60000);
  assert.equal(r2.value.ok, true, textOf(r2.value));
  assert.match(textOf(r2.value), /уже устроен/);
  assert.equal(bot.clicks.length, clicks, 'по своей работе не щёлкал');
  assert.equal(state.jobs.Рыбак, true);
  assert.deepEqual(sent, ['/jobs', '/jobs']);
});

test('#рыбалка сама устраивается Рыбаком; /jobs на сервере нет — рыбачит всё равно и пишет почему', async () => {
  const s = setup();
  s.bot.inventory.slots[36] = rodItem(0);
  const sent = [];
  s.bot.sendCommand = (cmd) => {
    sent.push(cmd);
    if (cmd === '/jobs') setImmediate(() => say(s.bot, 'Unknown or incomplete command. See below for error'));
    return true;
  };
  fishServer(s.bot, { biteTicks: 30 });
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 1'), 900000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.deepEqual(sent, ['/jobs']);
  assert.match(text, /Работа: не устроился: \/jobs не открыл меню работ \(сервер: «Unknown or incomplete command/);
});

test('#баланс и #перевод: баланс с табло, /pay ник сумма (чуть меньше показанного); прошёл — по табло; отказ — с ответом сервера', async () => {
  const s = setup();
  attachSidebar(s.bot);
  const showBalance = sidebarBalance(s.bot);
  showBalance('$837.7k');
  const sent = [];
  let refuse = false;
  s.bot.sendCommand = (cmd) => {
    sent.push(cmd);
    const m = /^\/pay (\S+) (\d+)$/.exec(cmd);
    if (m) {
      setImmediate(() => {
        if (refuse) {
          say(s.bot, '| Недостаточно средств.');
        } else {
          showBalance('$0');
          say(s.bot, `| Вы перевели ${m[2]} игроку ${m[1]}.`);
        }
      });
    }
    return true;
  };
  const run = async (line) => {
    const r = await runFor(s.clock, runCommand(s.bot, line), 60000);
    assert.ifError(r.error);
    return { ...r.value, text: textOf(r.value) };
  };
  const b = await run('#баланс');
  assert.equal(b.text, 'Баланс (табло): $837.7k — перевести можно 837650$');
  const p = await run('#перевод Boss');
  assert.equal(p.ok, true, p.text);
  assert.equal(p.data.paid, 837650);
  assert.deepEqual(sent, ['/pay Boss 837650']);
  const none = await run('#перевод Boss');
  assert.match(none.text, /переводить нечего/i);
  assert.equal(sent.length, 1, 'с нулевым балансом /pay не пишет');
  showBalance('$5.2k');
  refuse = true;
  const bad = await run('#перевод Boss');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'pay_failed');
  assert.match(bad.text, /не прошёл.*Недостаточно средств/);
  const self = await run('#перевод Fisher');
  assert.equal(self.ok, false);
  assert.match(self.text, /себе/);
});

test('#рыбалка: ник для денег во вкладке — раз в N минут сам переводит баланс (/pay), если на нём от 100$', async () => {
  const s = setup();
  attachSidebar(s.bot);
  const showBalance = sidebarBalance(s.bot);
  showBalance('$1.5k');
  s.bot.panelConfig = { payTo: 'Boss', payEvery: 1 };
  const sent = [];
  s.bot.sendCommand = (cmd) => {
    sent.push(cmd);
    if (cmd.startsWith('/pay ')) setImmediate(() => showBalance('$0'));
    return true;
  };
  s.bot.inventory.slots[36] = rodItem(0);
  fishServer(s.bot, { biteTicks: 500 }); // клюёт раз в 25 с: за 4 улова пройдёт больше минуты
  const r = await runFor(s.clock, runCommand(s.bot, '#рыбалка здесь 4'), 900000);
  assert.ifError(r.error);
  const text = textOf(r.value);
  assert.equal(r.value.ok, true, text);
  assert.ok(sent.includes('/pay Boss 1450'), sent.join(', '));
  assert.equal(sent.filter((x) => x.startsWith('/pay')).length, 1, 'второй раз — баланс 0: не переводит');
  assert.match(text, /Перевёл денег: 1450\$ игроку Boss/);
});
