'use strict';

// Проверка бота на тестовом стенде. Если сервер не запущен — поднимает его сам, заводит бота так же,
// как панель (через BotManager), держит его в мире и показывает, что заметили античит Grim и сервер.
//
// Запуск: npm run stand:check                    — бот стоит в мире 60 секунд
//         npm run stand:check -- 300             — 300 секунд
//         npm run stand:check -- --legacy        — бот как чистый mineflayer, без исправлений (сравнить «до/после»)
//         npm run stand:check -- --no-tick-end   — без одного исправления: --no-tick-end, --no-physics, --no-profile
//         npm run stand:check -- --scenario      — бот не стоит, а действует: смотрит по сторонам, обходит квадрат
//                                                  (часть пути бегом), копает и ставит блоки (площадку готовит сам)
//         npm run stand:check -- --electron      — бот заходит через настоящий Electron (как в панели: главный
//                                                  процесс + процесс бота); --electron=<путь к exe> — через сборку
//         npm run stand:check -- --electron --bots=24 — 24 бота сразу (StandBot1…24, входят по одному в секунду):
//                                                  все ли вошли и простояли, память и процессор на бота
//         npm run stand:check -- --clicks        — клики в меню: бот берёт из сундука предметы с названиями,
//                                                  описаниями, зачарованиями… и кладёт обратно; сервер не должен
//                                                  ничего поправлять (значит, «отпечатки» предметов как у игры);
//                                                  --clicks --no-clicks — то же без исправления (для сравнения)
//         npm run stand:check -- --fight         — бой: бот в стеклянном загоне бьёт пауков командой #бей (как в
//                                                  панели); Grim смотрит дальность, наводку и порядок пакетов ударов
//         npm run stand:check -- --mine          — добыча: руда спрятана в толще камня; бот (#добудь) прокапывается к ней
//                                                  и поднимается обратно «столбом»; Grim смотрит копание и прыжки с блоком;
//                                                  STAND_MINE=denied — там, где копать нельзя (ждём быстрый стоп)
//         npm run stand:check -- --survive       — добыча с выживанием: алмазная кирка «Эффективность V», меч, щит, хлеб;
//                                                  голод и мобы (зомби, крипер); бот добывает алмазы, отбивается, ест,
//                                                  от крипера — щитом. Grim смотрит копание, еду, щит, удары и движение
// Перед первым запуском один раз открой test-server\start-test-server.bat: он скачает сервер и спросит про EULA.
// Код выхода 0 — бот простоял всё время, его не кикнули, и ни Grim, ни сервер ничего не заметили.
// Журнал пакетов каждой проверки: test-server\server\journals.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { BotManager } = require('../src/bot-manager');
const { DEFAULT_CONFIG } = require('../src/config');
const { runCommand } = require('../src/bot/commands');

const SERVER_DIR = path.join(__dirname, 'server');
const LOG_FILE = path.join(SERVER_DIR, 'logs', 'latest.log');
const JOURNAL_DIR = path.join(SERVER_DIR, 'journals');
const BOT_NAME = 'StandBot';
const HELPER_NAME = 'Helper'; // второй игрок в сценарии — для команд по нику

const ARGS = process.argv.slice(2);
const KNOWN_FLAGS = new Set(['--legacy', '--no-physics', '--no-tick-end', '--no-profile', '--no-clicks', '--scenario', '--clicks', '--fight', '--mine', '--survive', '--gear', '--electron']);
const SCENARIO = ARGS.includes('--scenario');
const CLICKS = ARGS.includes('--clicks');
const FIGHT = ARGS.includes('--fight');
const MINE = ARGS.includes('--mine');
const SURVIVE = ARGS.includes('--survive');
const GEAR = ARGS.includes('--gear');
const ANY_CHECK = SCENARIO || CLICKS || FIGHT || MINE || SURVIVE || GEAR;
const ELECTRON_ARG = ARGS.find((a) => a === '--electron' || a.startsWith('--electron='));
const ELECTRON = Boolean(ELECTRON_ARG);
const ELECTRON_EXE = ELECTRON_ARG && ELECTRON_ARG.includes('=') ? ELECTRON_ARG.slice(ELECTRON_ARG.indexOf('=') + 1).replace(/^"|"$/g, '') : '';
const BOTS_ARG = ARGS.find((a) => a.startsWith('--bots='));
const BOTS = BOTS_ARG ? Math.max(1, Math.min(200, parseInt(BOTS_ARG.slice('--bots='.length), 10) || 1)) : 1;
const isStandBot = (name) => name === BOT_NAME || (BOTS > 1 && new RegExp(`^${BOT_NAME}\\d+$`).test(name));
const ROOT = path.join(__dirname, '..');
const STAY_MS = Math.max(5, parseInt(ARGS.find((a) => /^\d+$/.test(a)), 10) || (ANY_CHECK ? 10 : 60)) * 1000;
const LEGACY = ARGS.includes('--legacy');
const COMPAT = {
  physics: !LEGACY && !ARGS.includes('--no-physics'),
  tickEnd: !LEGACY && !ARGS.includes('--no-tick-end'),
  profile: !LEGACY && !ARGS.includes('--no-profile'),
  clicks: !LEGACY && !ARGS.includes('--no-clicks'),
};
const SERVER_START_TIMEOUT = 6 * 60 * 1000; // первый запуск скачивает файлы Mojang и создаёт мир
const BOT_ONLINE_TIMEOUT = 60 * 1000;

// Что показывать из вывода сервера, пока он запускается.
const START_PROGRESS = /Starting minecraft server|Downloading|Applying patches|Preparing (level|start region|spawn)|Enabling GrimAC|Done \(|ERROR|Exception|UnsupportedClassVersion/i;
// Срабатывание Grim: «Grim » StandBot failed TickTimer (x98) type=flying…» (на русском сервере — «провалил»).
const GRIM_ALERT = /Grim\s*»\s*(\S+)\s+(?:failed|провалил)\s+(\S+)\s+\(x(\d+)\)\s*(.*)$/i;
// Прочие строки о боте, которые стоит показать: кики, «двигался неправильно», обрывы.
const OTHER_NOTICE = /moved (too quickly|wrongly)|flying is not enabled|kick|lost connection|disconnect/i;
const NORMAL_QUIT = /lost connection: Disconnected$/; // бот сам вышел по окончании проверки

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clean = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/§./g, '').trimEnd();

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\\uFEFF/, ''));
  } catch (_) {
    return {};
  }
}

function readProps() {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(SERVER_DIR, 'server.properties'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) out[m[1].trim()] = m[2].trim();
    }
  } catch (_) {
    /* файла ещё нет — значения по умолчанию */
  }
  return out;
}

function portOpen(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => {
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

function logSize() {
  try {
    return fs.statSync(LOG_FILE).size;
  } catch (_) {
    return 0;
  }
}

function readLogFrom(offset) {
  try {
    const buf = fs.readFileSync(LOG_FILE);
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8');
  } catch (_) {
    return '';
  }
}

/** Срабатывания Grim по проверкам и прочие заметки сервера о боте (обычный выход бота не считается). */
function summarize(logText) {
  const checks = new Map();
  const other = [];
  for (const line of logText.split(/\r?\n/).map(clean)) {
    const alert = line.match(GRIM_ALERT);
    if (alert && isStandBot(alert[1])) {
      const c = checks.get(alert[2]) || { alerts: 0, maxVl: 0, lastDetails: '' };
      c.alerts += 1;
      c.maxVl = Math.max(c.maxVl, Number(alert[3]));
      c.lastDetails = alert[4].trim();
      checks.set(alert[2], c);
    } else if (line.includes(BOT_NAME) && OTHER_NOTICE.test(line) && !NORMAL_QUIT.test(line)) {
      other.push(line);
    }
  }
  return { checks, other };
}

function startServer() {
  // STAND_XMX=1G — меньше памяти серверу (когда рядом открыт Minecraft и свободной памяти мало).
  const xmx = /^\d+[MG]$/i.test(process.env.STAND_XMX || '') ? process.env.STAND_XMX : '2G';
  const child = spawn('java', [`-Xms${/^1G$|M$/i.test(xmx) ? '512M' : '1G'}`, `-Xmx${xmx}`, '-jar', 'paper.jar', '--nogui'], {
    cwd: SERVER_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('сервер не запустился за 6 минут')), SERVER_START_TIMEOUT);
    let partial = '';
    let lastShown = '';
    // Вывод читаем до самого конца: если его не забирать, сервер встанет на заполненном канале.
    const onData = (chunk) => {
      const lines = (partial + chunk.toString('utf8')).split(/\r?\n/);
      partial = lines.pop();
      for (const raw of lines) {
        const line = clean(raw);
        if (child.started) continue;
        const shown = line.replace(/^\[[\d:]+ \w+\]: /, ''); // без времени, чтобы схлопнуть повторы
        if (START_PROGRESS.test(line) && shown !== lastShown) {
          lastShown = shown;
          console.log(`  [сервер] ${line}`);
        }
        if (/Done \(\d/.test(line)) {
          child.started = true;
          clearTimeout(timer);
          resolve();
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`не удалось запустить java: ${err.message}`));
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`сервер завершился с кодом ${code}`));
    });
  });
  return { child, ready };
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  console.log('Останавливаю тестовый сервер…');
  const exited = new Promise((resolve) => child.once('exit', () => resolve(true)));
  try {
    child.stdin.write('stop\n');
  } catch (_) {
    /* ниже добьём */
  }
  const ok = await Promise.race([exited, sleep(60 * 1000).then(() => false)]);
  if (!ok) child.kill();
}

/**
 * Сценарий «бот действует» — теми же командами, что пишут в строке чата панели (src/bot/commands.js).
 * Площадку готовит консоль сервера: ровный каменный пол, воздух над ним, камень для копания, сундук с алмазами,
 * кирка и земля. Для команд по нику рядом ставится второй игрок — такой же бот Helper.
 * cmd(text) — команда в консоль тестового сервера. Возвращает число команд, которые не выполнились.
 */
async function runScenario(manager, cmd) {
  if (!cmd) throw new Error('для сценария сервер должна запускать сама проверка: закрой окно тестового сервера и запусти снова');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(3000); // как человек: постоять после входа
  const bot = manager.getBot();
  if (!bot || !bot.actions) throw new Error('у бота нет безопасных действий (они работают только со своей физикой)');

  const helper = new BotManager({ config: { ...manager.config, username: HELPER_NAME }, authCacheDir: path.join(os.tmpdir(), 'mineblaze-stand-auth') });
  const helperOnline = new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 30 * 1000);
    helper.on('state', (s) => {
      if (s === 'online') {
        clearTimeout(t);
        resolve(true);
      }
    });
  });
  helper.start();
  try {
    if (!(await helperOnline)) console.log(`  [сценарий] второй игрок ${HELPER_NAME} не зашёл`);
    // Площадка — в мировых координатах от того места, где бот стоит сейчас. С «~» у каждой команды была своя точка:
    // пока консоль строила, бота сносило водой, и помост вставал в стороне (стенд, 7 ноября). Вокруг — каменная
    // коробка (fill … hollow: снаружи камень, внутри воздух), чтобы вода и пещера снаружи не затекали внутрь.
    const o = bot.entity.position.floored();
    const xyz = (dx, dy, dz) => `${o.x + dx} ${o.y + dy} ${o.z + dz}`;
    const mid = (dx, dy, dz) => `${o.x + dx + 0.5} ${o.y + dy} ${o.z + dz + 0.5}`; // сущность — в середину клетки
    for (const c of [
      'difficulty peaceful',
      'time set day',
      'kill @e[type=minecraft:villager,name=Farmer]', // остались от прошлых проверок
      'kill @e[type=minecraft:chest_minecart,name=Market]',
      'kill @e[type=minecraft:item]',
      `fill ${xyz(-7, -1, -7)} ${xyz(7, 5, 7)} minecraft:stone hollow`,
      `tp ${BOT_NAME} ${mid(0, 0, 0)}`,
      `setblock ${xyz(-3, 0, 0)} minecraft:stone`,
      `setblock ${xyz(2, 0, -2)} minecraft:chest`,
      `item replace block ${xyz(2, 0, -2)} container.0 with minecraft:diamond 3`,
      `give ${BOT_NAME} minecraft:iron_pickaxe`,
      `give ${BOT_NAME} minecraft:dirt 16`,
      `tp ${HELPER_NAME} ${mid(4, 0, 4)}`,
      // NPC с меню — житель-торговец (как Фермер на спавне MineBlaze, только меню — обычная торговля).
      `summon villager ${mid(2, 0, 2)} {NoAI:1b,Invulnerable:1b,PersistenceRequired:1b,CustomName:"Farmer",` +
        'VillagerData:{profession:"minecraft:farmer",level:2,type:"minecraft:plains"},' +
        'Offers:{Recipes:[{buy:{id:"minecraft:emerald",count:1},sell:{id:"minecraft:bread",count:6},maxUses:99}]}}',
      // Меню-сундук у сущности — как меню NPC на MineBlaze: вагонетка с сундуком.
      `summon chest_minecart ${mid(-2, 0, 2)} {CustomName:"Market",` +
        'Items:[{Slot:0b,id:"minecraft:diamond",count:3},{Slot:4b,id:"minecraft:emerald",count:5}]}',
      // Навигация (поиск пути): стена поперёк площадки с проходом у края и помост на блок выше.
      `fill ${xyz(4, 0, -6)} ${xyz(4, 2, 3)} minecraft:stone`,
      `fill ${xyz(-5, 0, -5)} ${xyz(-4, 0, -4)} minecraft:stone`,
    ]) cmd(c);
    await wait(3000);
    let failed = 0;
    for (const line of [
      '#где',
      '#инвентарь',
      '#смотри налево',
      '#смотри направо',
      '#смотри вниз',
      '#смотри прямо',
      `#смотри на ${HELPER_NAME}`,
      '#иди ко мне',
      `#иди ${xyz(0, 0, 0)}`,
      `#иди ${xyz(5, 0, -3)}`, // за стену — в обход, через проход у края
      `#иди ${xyz(-4, 1, -4)}`, // на помост — прыжком
      `#иди ${xyz(0, 0, 0)}`, // обратно — вниз с помоста
      '#смотри юг',
      '#вперёд 3',
      '#назад 3 бегом',
      '#возьми кирка',
      `#смотри ${xyz(-3, 0, 0)}`,
      '#копай',
      `#поставь ${xyz(-3, 0, 0)} земля`,
      `#копай ${xyz(-3, 0, 0)}`,
      '#смотри юг',
      '#поставь впереди земля',
      '#копай впереди',
      '#открой',
      '#рядом',
      '#рентген',
      '#сущности',
      '#иди к Farmer',
      '#нажми Farmer',
      '#окно',
      '#закрой',
      '#иди к Market',
      '#нажми Market',
      '#окно',
      '#клик 4',
      '#закрой',
      '#инвентарь',
    ]) {
      const started = Date.now();
      const r = await runCommand(bot, line);
      if (!r.ok) failed += 1;
      const text = [].concat(r.message).join(' | ');
      console.log(`  [сценарий] ${line} → ${r.ok ? 'да' : 'НЕТ'} (${((Date.now() - started) / 1000).toFixed(1)} с): ${text}`);
      await wait(300 + Math.random() * 500); // человек между командами тоже не мгновенен
    }
    return failed;
  } finally {
    helper.stop();
  }
}

/**
 * Бой — той же командой, что в панели: #бей пауков N. Консоль сервера строит загон из стекла (ночь — пауки
 * злые и сами идут к боту, сами мобы не появляются), даёт боту железный меч и «сопротивление» (урона нет — как
 * режим бога на MineBlaze) и ставит пауков по углам. Возвращает 0 — всех убил (а Grim — в общем итоге).
 */
async function runFightCheck(manager, cmd) {
  if (!cmd) throw new Error('для боя сервер должна запускать сама проверка: закрой окно тестового сервера и запусти снова');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2000);
  const bot = manager.getBot();
  if (!bot || !bot.actions) throw new Error('у бота нет безопасных действий (они работают только со своей физикой)');
  const COUNT = 4;
  for (const c of [
    'difficulty easy',
    'gamerule spawn_mobs false', // 1.21.11: правила игры переименованы (было doMobSpawning)
    'time set midnight',
    `effect give ${BOT_NAME} minecraft:resistance infinite 255 true`,
    `effect give ${BOT_NAME} minecraft:saturation infinite 255 true`,
    `execute at ${BOT_NAME} run fill ~-4 ~-1 ~-4 ~4 ~3 ~4 minecraft:glass hollow`,
    `give ${BOT_NAME} minecraft:iron_sword`,
    ...[[2, 2], [-2, 2], [2, -2], [-2, -2]].map(([x, z]) => `execute at ${BOT_NAME} run summon minecraft:spider ~${x} ~ ~${z}`),
  ]) cmd(c);
  await wait(2500);
  const started = Date.now();
  const r = await runCommand(bot, `#бей пауков ${COUNT}`);
  console.log(`  [бой] #бей пауков ${COUNT} → ${r.ok ? 'да' : 'НЕТ'} (${((Date.now() - started) / 1000).toFixed(1)} с): ${[].concat(r.message).join(' | ')}`);
  cmd('kill @e[type=minecraft:spider]');
  cmd('time set day');
  return r.data && r.data.total >= COUNT ? 0 : 1;
}

/**
 * Добыча (--mine): консоль сервера делает под ботом толщу камня, прячет в ней две железные руды (не видны —
 * со всех сторон камень) и третью — рядом с водой. Бот командой #добудь железо 2 (как в панели) прокапывается
 * прямо к первым двум, руду у воды не трогает и возвращается на свою высоту — где нужно, «столбом» из выкопанного
 * булыжника. Grim смотрит копание, прыжки с блоком под себя и движение. Возвращает 0 — всё так.
 */
async function runMineCheck(manager, cmd) {
  if (!cmd) throw new Error('для добычи сервер должна запускать сама проверка: закрой окно тестового сервера и запусти снова');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2000);
  const bot = manager.getBot();
  if (!bot || !bot.actions) throw new Error('у бота нет безопасных действий (они работают только со своей физикой)');
  const o = bot.entity.position.floored();
  const at = (dx, dy, dz) => `${o.x + dx} ${o.y + dy} ${o.z + dz}`;
  for (const c of [
    'difficulty peaceful',
    'time set day',
    `fill ${at(-8, -12, -8)} ${at(8, -1, 8)} minecraft:stone`,
    `fill ${at(-8, 0, -8)} ${at(8, 4, 8)} minecraft:air`,
    `setblock ${at(5, -5, 2)} minecraft:iron_ore`,
    `setblock ${at(-3, -8, -4)} minecraft:deepslate_iron_ore`,
    `setblock ${at(2, -3, -5)} minecraft:iron_ore`,
    `setblock ${at(3, -3, -5)} minecraft:water`, // рядом с этой рудой — вода: сломаешь — потечёт
    `clear ${BOT_NAME}`,
    `give ${BOT_NAME} minecraft:iron_pickaxe`,
  ]) cmd(c);
  await wait(3000);
  // Рентген по настоящим чанкам сервера: спрятанные руды должен видеть (с координатами).
  bot.panelConfig = { xray: { radius: 1 } };
  const x = await runCommand(bot, '#рентген железо');
  console.log(`  [добыча] #рентген железо → ${[].concat(x.message).join(' | ')}`);
  if (process.env.STAND_MINE === 'denied') {
    // Как спавн или чужой приват: сервер возвращает каждый сломанный блок (режим «приключение»).
    cmd(`gamemode adventure ${BOT_NAME}`);
    await wait(1000);
    const t0 = Date.now();
    const d = await runCommand(bot, '#добудь железо 2 здесь');
    console.log(`  [добыча] копать нельзя: #добудь железо 2 здесь → ${d.code} (${((Date.now() - t0) / 1000).toFixed(1)} с): ${[].concat(d.message).join(' | ')}`);
    cmd(`gamemode survival ${BOT_NAME}`);
    return d.code === 'protected' ? 0 : 1;
  }
  const started = Date.now();
  const r = await runCommand(bot, '#добудь железо 2 здесь');
  console.log(`  [добыча] #добудь железо 2 здесь → ${r.ok ? 'да' : 'НЕТ'} (${((Date.now() - started) / 1000).toFixed(1)} с): ${[].concat(r.message).join(' | ')}`);
  const p = bot.entity.position;
  console.log(`  [добыча] бот: ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)} (начал в ${o.x + 0.5} ${o.y} ${o.z + 0.5})`);
  const wet = bot.blockAt(o.offset(2, -3, -5));
  if (wet) console.log(`  [добыча] руда у воды: ${wet.name}`);
  const ok = r.data && r.data.mined >= 2 && r.data.back === true && Math.abs(p.y - o.y) < 0.1 && (!wet || wet.name === 'iron_ore');
  return ok ? 0 : 1;
}

/**
 * Добыча с выживанием (--survive): каменная коробка, в толще — два спрятанных алмаза. У бота — алмазная кирка
 * «Эффективность V», железный меч, щит и хлеб; голод (сытость падает) и мобы: зомби в 3 блоках, крипер в 6. Бот
 * командой #добудь алмазы 2 здесь копает (руда — 3–4 тика, как у клиента), отбивается (зомби — мечом, крипер — щитом),
 * ест хлеб. «Сопротивление I» — чтобы при ошибке проверка не кончилась смертью. Возвращает 0 или что не вышло.
 */
async function runSurviveCheck(manager, cmd) {
  if (!cmd) throw new Error('для этой проверки сервер должна запускать сама проверка: закрой окно тестового сервера и запусти снова');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2000);
  const bot = manager.getBot();
  if (!bot || !bot.actions) throw new Error('у бота нет безопасных действий (они работают только со своей физикой)');
  const o = bot.entity.position.floored();
  const at = (dx, dy, dz) => `${o.x + dx} ${o.y + dy} ${o.z + dz}`;
  const mid = (dx, dy, dz) => `${o.x + dx + 0.5} ${o.y + dy} ${o.z + dz + 0.5}`;
  for (const c of [
    'difficulty easy',
    'gamerule spawn_mobs false', // 1.21.11: правила игры переименованы (было doMobSpawning)
    'kill @e[type=!minecraft:player]', // мобы, предметы и сущности прошлых проверок
    `fill ${at(-9, -13, -9)} ${at(9, 6, 9)} minecraft:stone hollow`,
    `fill ${at(-8, -12, -8)} ${at(8, -1, 8)} minecraft:stone`,
    `tp ${BOT_NAME} ${mid(0, 0, 0)}`,
    `setblock ${at(5, -5, 2)} minecraft:diamond_ore`,
    `setblock ${at(-3, -8, -4)} minecraft:deepslate_diamond_ore`,
    `clear ${BOT_NAME}`,
    `give ${BOT_NAME} minecraft:diamond_pickaxe[enchantments={efficiency:5}]`,
    `give ${BOT_NAME} minecraft:iron_sword`,
    `give ${BOT_NAME} minecraft:shield`,
    `give ${BOT_NAME} minecraft:bread 8`,
    `effect clear ${BOT_NAME}`,
    `effect give ${BOT_NAME} minecraft:resistance 600 0 true`,
  ]) cmd(c);
  await wait(3000);
  // Голод: сначала тратится насыщение (после прошлых проверок оно бывает полным), потом сытость — у бота есть хлеб.
  cmd(`effect give ${BOT_NAME} minecraft:hunger 20 60 true`);
  // Зомби — рядом (подходит первым), крипер — в углу, в ~10 блоках: подойдёт позже, его взрыв не убьёт зомби за бота.
  cmd(`summon minecraft:zombie ${mid(3, 0, 3)} {PersistenceRequired:1b}`);
  cmd(`summon minecraft:creeper ${mid(-7, 0, 7)} {PersistenceRequired:1b}`);
  await wait(500);
  const health0 = bot.health;
  const started = Date.now();
  const r = await runCommand(bot, '#добудь алмазы 2 здесь');
  const text = [].concat(r.message).join(' | ');
  console.log(`  [выживание] #добудь алмазы 2 здесь → ${r.ok ? 'да' : 'НЕТ'} (${((Date.now() - started) / 1000).toFixed(1)} с): ${text}`);
  console.log(`  [выживание] здоровье ${health0} → ${bot.health}, сытость ${bot.food}`);
  const problems = [];
  if (!(r.data && r.data.mined >= 2)) problems.push('добыл меньше 2 алмазов');
  if (!/Отбился от мобов/.test(text)) problems.push('не отбился от мобов');
  if (!/Поел/.test(text)) problems.push('не поел');
  if (!(bot.health > 0)) problems.push('погиб');
  // Щит бот кладёт во вторую руку сам в начале добычи (зомби рядом — не помеха): без него от крипера только отходит.
  const off = bot.inventory && bot.inventory.slots ? bot.inventory.slots[45] : null;
  if (!off || off.name !== 'shield') problems.push('щит так и не во второй руке');
  return problems.length ? problems.join(', ') : 0;
}

/**
 * Проверка снаряжения (--gear): в трёх сундуках (один — дальше 4 блоков) незеритовая броня с зачарованиями,
 * алмазная и железная похуже, кирки, мечи, щит, еда и вредная еда. #снаряжение должен надеть лучшее, щит — во вторую
 * руку, взять незеритовые кирку и меч и еды не меньше 45; сервер (Paper) должен принять клики, Grim — промолчать.
 */
async function runGearCheck(manager, cmd) {
  if (!cmd) throw new Error('для этой проверки сервер должна запускать сама проверка: закрой окно тестового сервера и запусти снова');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(2000);
  const bot = manager.getBot();
  if (!bot || !bot.actions) throw new Error('у бота нет безопасных действий (они работают только со своей физикой)');
  const o = bot.entity.position.floored();
  const at = (dx, dy, dz) => `${o.x + dx} ${o.y + dy} ${o.z + dz}`;
  const item = (slot, id, count = 1, extra = '') => `{Slot:${slot}b,id:"minecraft:${id}",count:${count}${extra}}`;
  const ench = (list) => `,components:{"minecraft:enchantments":{${list}}}`;
  for (const c of [
    'kill @e[type=item]',
    `fill ${at(-9, 0, -9)} ${at(9, 3, 9)} minecraft:air`,
    `fill ${at(-9, -1, -9)} ${at(9, -1, 9)} minecraft:stone`,
    `clear ${BOT_NAME}`,
    `setblock ${at(2, 0, -2)} minecraft:chest{Items:[${[item(0, 'iron_helmet'), item(1, 'bread', 20), item(2, 'stone_pickaxe'), item(3, 'iron_boots')].join(',')}]}`,
    `setblock ${at(-2, 0, 3)} minecraft:chest{Items:[${[item(0, 'diamond_helmet'), item(1, 'diamond_leggings'), item(2, 'rotten_flesh', 10)].join(',')}]}`,
    `setblock ${at(7, 0, 4)} minecraft:chest{Items:[${[
      item(0, 'netherite_chestplate', 1, ench('"minecraft:protection":4,"minecraft:unbreaking":3')),
      item(1, 'netherite_pickaxe', 1, ench('"minecraft:efficiency":5')),
      item(2, 'netherite_sword', 1, ench('"minecraft:sharpness":5')),
      item(3, 'netherite_boots'),
      item(4, 'shield'),
      item(5, 'cooked_beef', 40),
    ].join(',')}]}`,
  ]) cmd(c);
  await wait(2500);
  const started = Date.now();
  const r = await runCommand(bot, '#снаряжение');
  const text = [].concat(r.message).join(' | ');
  console.log(`  [снаряжение] #снаряжение → ${r.ok ? 'да' : 'НЕТ'} (${((Date.now() - started) / 1000).toFixed(1)} с): ${text}`);
  const slots = bot.inventory.slots;
  const nameAt = (i) => (slots[i] ? slots[i].name : '—');
  console.log(`  [снаряжение] надето: ${[5, 6, 7, 8].map(nameAt).join(', ')}; вторая рука: ${nameAt(45)}`);
  const problems = [];
  const want = { 5: 'diamond_helmet', 6: 'netherite_chestplate', 7: 'diamond_leggings', 8: 'netherite_boots', 45: 'shield' };
  for (const [i, name] of Object.entries(want)) if (nameAt(Number(i)) !== name) problems.push(`в ячейке ${i} ${nameAt(Number(i))}, а не ${name}`);
  const inv = slots.slice(9, 45).filter(Boolean);
  for (const name of ['netherite_pickaxe', 'netherite_sword']) if (!inv.some((it) => it.name === name)) problems.push(`нет ${name}`);
  if (inv.some((it) => it.name === 'rotten_flesh')) problems.push('взял гнилую плоть');
  const food = inv.filter((it) => ['cooked_beef', 'bread'].includes(it.name)).reduce((n, it) => n + it.count, 0);
  if (food < 45) problems.push(`еды ${food} (< 45)`);
  return problems.length ? problems.join(', ') : 0;
}

// Предметы для проверки кликов: как в меню NPC на MineBlaze (название с цветом, описание из нескольких строк)
// и другие частые компоненты. [что проверяем, предмет для команды /item].
const CLICK_ITEMS = [
  ['простое название', 'minecraft:gold_ingot[custom_name="Аванс на семена."]'],
  [
    'название и описание с цветами',
    'minecraft:wheat[custom_name={text:"Грядки без истерики.",color:"yellow",italic:false},' +
      'lore=[{text:"После последней непогоды огород",color:"gray",italic:false},' +
      '{text:"",italic:false,extra:[{text:"Передайте пшеницу: ",color:"white"},"0/224"]},' +
      '{text:"Нажмите, чтобы взять задание",color:"green",bold:true,italic:false}]]',
  ],
  ['цвет #RRGGBB, жирный, тень', 'minecraft:experience_bottle[custom_name={text:"Улучшения",color:"#FFAA00",bold:true,italic:false,shadow_color:-16777216}]'],
  ['зачарования и износ', 'minecraft:diamond_sword[enchantments={sharpness:5,unbreaking:3},damage=10,repair_cost=4]'],
  ['данные плагина', 'minecraft:paper[custom_data={quest:"farmer_1",level:2b,nums:[I;1,2,3],list:[1,2,3],PublicBukkitValues:{"plugin:key":"v"}}]'],
  ['блеск, редкость, размер стака', 'minecraft:stick[enchantment_glint_override=true,rarity="epic",max_stack_size=16]'],
  [
    'скрытые подсказки, своя модель',
    'minecraft:clock[tooltip_display={hidden_components:["minecraft:enchantments"]},' +
      'custom_model_data={floats:[1.5f],flags:[true],strings:["a"],colors:[16711680]}]',
  ],
  ['стекло без подсказки', 'minecraft:gray_stained_glass_pane[tooltip_display={hide_tooltip:true}]'],
  ['краска и неразрушимость', 'minecraft:leather_chestplate[dyed_color=16711680,unbreakable={}]'],
  ['другая модель предмета', 'minecraft:apple[item_model="minecraft:golden_apple"]'],
  ['стак без компонентов', 'minecraft:dirt 5'],
];

/**
 * Проверка кликов в меню (--clicks). Бот открывает сундук с предметами из CLICK_ITEMS и каждый берёт в курсор,
 * а потом кладёт обратно (стак земли — ещё и правой кнопкой, половину); затем переносит стопки shift-кликом
 * (как #достань и #положи) — куда легла стопка, бот считает сам, как игра. В пакете клика бот сообщает серверу
 * «отпечатки» предметов; если они посчитаны как в игре, серверу нечего поправлять, и он молчит. Поправка
 * (set_slot, set_cursor_item, window_items) — отпечаток не совпал. Возвращает число неудачных проверок.
 */
async function runClickCheck(manager, cmd) {
  if (!cmd) throw new Error('для проверки кликов сервер должна запускать сама проверка: закрой окно тестового сервера и запусти снова');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(3000);
  const bot = manager.getBot();
  if (!bot || !bot.actions) throw new Error('у бота нет безопасных действий (они работают только со своей физикой)');
  const o = bot.entity.position.floored();
  const chest = o.offset(2, 0, -2);
  const at = `${chest.x} ${chest.y} ${chest.z}`;
  for (const c of [
    'difficulty peaceful',
    'time set day',
    `fill ${o.x - 3} ${o.y - 1} ${o.z - 3} ${o.x + 3} ${o.y - 1} ${o.z + 3} minecraft:stone`,
    `fill ${o.x - 3} ${o.y} ${o.z - 3} ${o.x + 3} ${o.y + 3} ${o.z + 3} minecraft:air`,
    `setblock ${at} minecraft:chest`,
    ...CLICK_ITEMS.map(([, item], i) => `item replace block ${at} container.${i} with ${item}`),
    // Для shift-кликов: яйца (стопка по 16) и камень — сундук занят весь, кроме последней ячейки [26].
    `item replace block ${at} container.11 with minecraft:egg 12`,
    ...Array.from({ length: 14 }, (_, i) => `item replace block ${at} container.${12 + i} with minecraft:stone 64`),
    `clear ${BOT_NAME}`,
    `item replace entity ${BOT_NAME} container.0 with minecraft:iron_pickaxe[damage=5,enchantments={efficiency:2},custom_name="Кирка"]`,
    `item replace entity ${BOT_NAME} container.9 with minecraft:wheat 60`,
    `item replace entity ${BOT_NAME} container.10 with minecraft:egg 10`,
    `item replace entity ${BOT_NAME} container.11 with minecraft:egg 4`,
  ]) cmd(c);
  await wait(2500);

  const opened = new Promise((resolve) => bot.once('windowOpen', resolve));
  await bot.actions.activate(chest);
  const window = await Promise.race([opened, wait(5000).then(() => null)]);
  if (!window) throw new Error('сундук не открылся');
  await wait(1000); // содержимое сундука пришло, дальше сервер молчит

  const answers = [];
  const onPacket = (data, meta) => {
    if (['set_slot', 'set_cursor_item', 'window_items'].includes(meta.name)) {
      const win = data && data.windowId !== undefined ? ` окно ${data.windowId}` : '';
      answers.push(`${meta.name}${win}${data && data.slot !== undefined ? ` [${data.slot}]` : ''}`);
    }
  };
  bot._client.on('packet', onPacket);
  const unknown = [];
  const onUnknown = (type) => unknown.push(type);
  bot.on('clickHashUnknown', onUnknown);

  let failed = 0;
  const check = async (slot, label, button = 0) => {
    const item = window.slots[slot];
    if (!item) {
      console.log(`  [клики] [${slot}] ${label}: предмета нет — НЕ ПРОВЕРЕНО`);
      failed += 1;
      return;
    }
    answers.length = 0;
    await bot.actions.clickSlot(slot, { button }); // взять в курсор (правой — половину)
    const took = answers.splice(0);
    await bot.actions.clickSlot(slot); // положить обратно
    await wait(300);
    const put = answers.splice(0);
    const ok = !took.length && !put.length && window.slots[slot] && window.slots[slot].count === item.count && !window.selectedItem;
    if (!ok) failed += 1;
    const what = ok
      ? 'сервер согласен'
      : `ПОПРАВИЛ: взять — ${took.join(', ') || 'нет'}; положить — ${put.join(', ') || 'нет'}; ` +
        `компоненты: ${JSON.stringify(item.components || []).slice(0, 400)}`;
    console.log(`  [клики] [${slot}] ${label} (${item.name}${button ? ', правой' : ''}): ${what}`);
  };

  // Shift-клик: куда ляжет стопка, бот считает сам (как игра); посчитал не так — сервер поправит ячейки.
  // expect — [ячейка, предмет, сколько] после переноса.
  const fmtSlot = (s) => `[${s}] ${window.slots[s] ? `${window.slots[s].name}×${window.slots[s].count}` : 'пусто'}`;
  const shift = async (slot, label, expect) => {
    const item = window.slots[slot];
    if (!item) {
      console.log(`  [shift] [${slot}] ${label}: предмета нет — НЕ ПРОВЕРЕНО`);
      failed += 1;
      return;
    }
    answers.length = 0;
    await bot.actions.clickSlot(slot, { mode: 1 });
    await wait(400);
    const got = answers.splice(0);
    const placed = expect.every(([s, name, count]) => window.slots[s] && window.slots[s].name === name && window.slots[s].count === count);
    const ok = !got.length && placed && !window.selectedItem;
    if (!ok) failed += 1;
    const what = ok ? 'сервер согласен' : `ПОПРАВИЛ: ${got.join(', ') || 'нет'}; ячейки: ${expect.map(([s]) => fmtSlot(s)).join(', ')}`;
    console.log(`  [shift] [${slot}] ${label} (${item.name}): ${what}`);
  };

  try {
    for (let i = 0; i < CLICK_ITEMS.length; i += 1) await check(i, CLICK_ITEMS[i][0]);
    const dirt = CLICK_ITEMS.findIndex(([, item]) => item.startsWith('minecraft:dirt'));
    await check(dirt, 'половина стака', 1);
    const pick = window.slots.findIndex((it, i) => i >= window.inventoryStart && it && it.name === 'iron_pickaxe');
    if (pick >= 0) await check(pick, 'своя кирка в инвентаре (название, износ, зачарование)');
    else console.log('  [клики] кирки в инвентаре нет — её не проверил');

    const S = window.inventoryStart; // инвентарь в окне сундука: S… — основной, S+27… — быстрая панель
    await shift(1, 'из сундука: к простой пшенице не ложится (другое название), — в последнюю пустую ячейку', [[S + 35, 'wheat', 1]]);
    await shift(S + 1, 'в сундук: дополнить стопку яиц до 16, остаток — в первую пустую ячейку', [[11, 'egg', 16], [1, 'egg', 6]]);
    await shift(S, 'в сундук: в его последнюю ячейку (prismarine-windows её не видит)', [[26, 'wheat', 60]]);
    await shift(11, 'из сундука: дополнить стопку яиц в инвентаре, остаток — в последнюю пустую', [[S + 2, 'egg', 16], [S + 34, 'egg', 4]]);
    await shift(26, 'из сундука: пшеница обратно', [[S + 33, 'wheat', 60]]);
  } finally {
    bot._client.removeListener('packet', onPacket);
    bot.removeListener('clickHashUnknown', onUnknown);
    await bot.actions.closeMenu().catch(() => {});
  }
  if (unknown.length) console.log(`  [клики] не умею считать отпечатки: ${[...new Set(unknown)].join(', ')}`);
  return failed;
}

/** Бот заходит через настоящий Electron: самопроверка панели с сервером (см. MBP_SELFTEST_* в src/main.js). */
function runElectron(host, port, version) {
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `mbp-electron-check-${process.pid}.json`);
    fs.rmSync(out, { force: true });
    const env = {
      ...process.env,
      MBP_SELFTEST_OUT: out,
      MBP_SELFTEST_SERVER: `${host}:${port}`,
      MBP_SELFTEST_STAY: String(STAY_MS / 1000),
      MBP_SELFTEST_VERSION: version,
      MBP_SELFTEST_NICK: BOT_NAME,
      MBP_SELFTEST_BOTS: String(BOTS),
      MBP_SELFTEST_INTERVAL: '1',
    };
    delete env.ELECTRON_RUN_AS_NODE; // иначе Electron запустится как обычный Node (так бывает в терминале VS Code)
    const file = ELECTRON_EXE ? path.resolve(ELECTRON_EXE) : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
    console.log(`Бот заходит через ${ELECTRON_EXE ? `сборку: ${file}` : 'Electron из node_modules (как npm start)'}…`);
    const child = spawn(file, ELECTRON_EXE ? [] : [ROOT], { env, cwd: ROOT, stdio: 'ignore', windowsHide: true });
    child.once('error', (err) => resolve({ problem: `не удалось запустить Electron: ${err.message}` }));
    child.once('exit', (code) => {
      let r = null;
      try {
        r = JSON.parse(fs.readFileSync(out, 'utf8'));
      } catch (_) {
        /* нет результата — ниже скажем */
      }
      fs.rmSync(out, { force: true });
      const s = r && r.server;
      if (s) for (const line of s.logs) console.log(`  [бот] ${line.replace(/^(\w+): /, '')}`);
      let problem = null;
      if (!r) problem = `Electron завершился (код ${code}) без результата`;
      else if (r.error) problem = r.error;
      else if (!s || !s.online) problem = 'бот не продержался на сервере всё время';
      const kick = s ? s.logs.find((l) => l.startsWith('kick: ')) : null;
      if (s && s.bots > 1) {
        console.log(`  [боты] вошли ${s.joined} из ${s.bots}, простояли ${s.stayed}`);
        const m = s.memory || {};
        for (const p of m.processes || []) console.log(`  [процесс] ${p.name}: память ${p.memoryMB} МБ (своя ${p.privateMB} МБ), процессор ${p.cpu}%`);
        console.log(`  [память] процессы ботов ${m.botsMB} МБ — на бота ≈ ${m.perBotMB} МБ; вся программа ${m.appMB} МБ`);
      }
      resolve({ online: Boolean(s && s.states.includes('online')), onlineMs: s ? s.stayMs : 0, kick: kick ? kick.slice(6) : null, problem, stats: s ? s.stats : null });
    });
  });
}

function runBot(host, port, version, cmd) {
  return new Promise((resolve) => {
    const config = {
      ...DEFAULT_CONFIG,
      host,
      port,
      username: BOT_NAME,
      version,
      auth: 'offline',
      autoReconnect: false,
      loginPassword: '',
      joinCommands: '',
      godMode: false, // на стенде нет /god (это плагин сервера MineBlaze)
    };
    const manager = new BotManager({
      config,
      authCacheDir: path.join(os.tmpdir(), 'mineblaze-stand-auth'),
      journalDir: JOURNAL_DIR,
      compat: COMPAT,
      // Проверки бывают по несколько минут (добыча): журнал — за всё время, чтобы разобрать любой откат.
      journalLimits: { keepMs: 10 * 60 * 1000, maxEntries: 400000 },
    });
    const result = { online: false, onlineMs: 0, kick: null, problem: null, stats: null };
    let onlineAt = 0;
    let onlineAtJournal = 0; // то же время, но в часах журнала пакетов
    let stayTimer = null;
    let finished = false;

    const finish = (problem) => {
      if (finished) return;
      finished = true;
      clearTimeout(onlineTimer);
      clearTimeout(stayTimer);
      result.problem = problem;
      result.onlineMs = onlineAt ? Date.now() - onlineAt : 0;
      if (manager.journal) result.stats = manager.journal.stats(onlineAtJournal ? { sinceMs: onlineAtJournal } : {});
      if (manager.state === 'offline') {
        resolve(result); // при кике журнал уже сохранила сама панель
        return;
      }
      manager.saveJournal(problem ? `проверка на стенде: ${problem}` : 'проверка на стенде');
      const giveUp = setTimeout(() => resolve(result), 5000);
      manager.on('state', (state) => {
        if (state === 'offline') {
          clearTimeout(giveUp);
          resolve(result);
        }
      });
      manager.stop();
    };
    const onlineTimer = setTimeout(() => finish('бот не появился в мире за 60 с'), BOT_ONLINE_TIMEOUT);

    manager.on('log', ({ level, text }) => {
      console.log(`  [бот] ${text}`);
      if (level === 'kick') result.kick = text;
    });
    manager.on('chat', ({ text, position }) => {
      if (position !== 'self' && String(text).trim()) console.log(`  [чат] ${clean(text)}`);
    });
    manager.on('state', (state) => {
      if (state === 'online' && !result.online) {
        result.online = true;
        onlineAt = Date.now();
        onlineAtJournal = performance.timeOrigin + performance.now();
        clearTimeout(onlineTimer);
        if (ANY_CHECK) {
          const check = SCENARIO ? { what: 'сценарий', start: 'готовлю площадку и действую…', done: 'Сценарий закончен', run: runScenario, why: (f) => `не выполнено команд — ${f}` }
            : CLICKS ? { what: 'клики', start: 'проверяю клики в меню…', done: 'Клики проверены', run: runClickCheck, why: (f) => `неудачных проверок — ${f}` }
              : MINE ? { what: 'добыча', start: 'прячу руду в камне…', done: 'Добыча окончена', run: runMineCheck, why: () => 'добыл не всё, тронул руду у воды или не вернулся на свою высоту' }
                : GEAR ? { what: 'снаряжение', start: 'раскладываю по сундукам незерит, броню, щит, еду…', done: 'Снаряжение собрано', run: runGearCheck, why: (f) => `не вышло: ${f}` }
                : SURVIVE ? { what: 'выживание', start: 'прячу алмазы, зову мобов…', done: 'Добыча с мобами окончена', run: runSurviveCheck, why: (f) => `не вышло: ${f}` }
                  : { what: 'бой', start: 'готовлю загон и пауков…', done: 'Бой окончен', run: runFightCheck, why: () => 'убил не всех пауков' };
          console.log(`Бот в мире: ${check.start}`);
          check.run(manager, cmd).then(
            (failed) => {
              console.log(`${check.done}, бот стоит ещё ${STAY_MS / 1000} с…`);
              stayTimer = setTimeout(() => finish(failed ? `${check.what}: ${check.why(failed)}` : null), STAY_MS);
            },
            (err) => finish(`${check.what}: ${err.message}`),
          );
        } else {
          console.log(`Бот в мире, стоит ${STAY_MS / 1000} с…`);
          stayTimer = setTimeout(() => finish(null), STAY_MS);
        }
      } else if (state === 'offline') {
        finish(result.online ? 'бот отключился раньше времени' : 'бот не смог войти');
      }
    });
    manager.start();
  });
}

async function main() {
  const unknown = ARGS.filter((a) => a.startsWith('-') && !KNOWN_FLAGS.has(a) && !a.startsWith('--electron=') && !a.startsWith('--bots='));
  if (BOTS > 1 && !ELECTRON) {
    console.error('--bots=N — только вместе с --electron (боты заходят через панель, как «Старт всех»)');
    return 2;
  }
  if (ELECTRON && (ANY_CHECK || ARGS.some((a) => /^--(legacy|no-)/.test(a)))) {
    console.error('--electron проверяет бота таким, какой он в панели: без --scenario, --clicks, --fight, --mine, --survive, --legacy и --no-…');
    return 2;
  }
  if ([SCENARIO, CLICKS, FIGHT, MINE, SURVIVE].filter(Boolean).length > 1) {
    console.error('--scenario, --clicks, --fight, --mine и --survive — разные проверки: запусти их по очереди');
    return 2;
  }
  if (unknown.length) {
    console.error(`Неизвестные параметры: ${unknown.join(' ')}. Есть: ${[...KNOWN_FLAGS].join(' ')} и число секунд.`);
    return 2;
  }
  if (!fs.existsSync(path.join(SERVER_DIR, 'paper.jar'))) {
    console.error('Стенд не установлен: сначала запусти test-server\\start-test-server.bat (он скачает сервер и спросит про EULA).');
    return 2;
  }
  const props = readProps();
  const host = props['server-ip'] || '127.0.0.1';
  const port = parseInt(props['server-port'], 10) || 25565;
  const version = readJson(path.join(SERVER_DIR, 'stand.json')).mcVersion || DEFAULT_CONFIG.version;

  let server = null;
  const stopOnCtrlC = () => {
    stopServer(server && server.child).finally(() => process.exit(130));
  };
  process.once('SIGINT', stopOnCtrlC);

  try {
    if (await portOpen(host, port)) {
      console.log(`Сервер уже запущен на ${host}:${port}, проверяю на нём.`);
    } else {
      console.log(`Запускаю тестовый сервер ${version} на ${host}:${port} (первый запуск может занять несколько минут)…`);
      server = startServer();
      await server.ready;
    }

    const grimLine = readLogFrom(0).split(/\r?\n/).find((line) => /Enabling GrimAC/i.test(line));
    console.log(grimLine ? `Античит: ${clean(grimLine).replace(/^.*Enabling /, '')}` : 'ВНИМАНИЕ: в логе сервера не видно, что Grim включился.');
    const fixes = Object.keys(COMPAT).filter((k) => COMPAT[k]);
    if (!ELECTRON) console.log(`Бот: ${fixes.length ? `как обычный клиент (${fixes.join(', ')})` : 'чистый mineflayer, без исправлений'}`);

    const offset = logSize();
    const cmd = server ? (text) => server.child.stdin.write(`${text}\n`) : null; // консоль — только у своего сервера
    const result = ELECTRON ? await runElectron(host, port, version) : await runBot(host, port, version, cmd);
    await sleep(2000); // сервер успеет дописать лог
    const { checks, other } = summarize(readLogFrom(offset));

    console.log('');
    console.log('===== Итог =====');
    const stayed = `${Math.round(result.onlineMs / 1000)} с${ANY_CHECK ? ' (проверка и пауза после неё)' : ` из ${STAY_MS / 1000}`}`;
    console.log(`Бот в мире: ${result.online ? stayed : 'не появился'}`);
    if (result.kick) console.log(`Кик: ${result.kick}`);
    if (result.problem) console.log(`Проблема: ${result.problem}`);
    if (result.stats) {
      const st = result.stats;
      const sent = st.out.map((r) => `${r.name} ${r.perSecond.toFixed(1)}`).join(', ');
      console.log(`Бот отправлял, пакетов в секунду: ${sent || 'ничего'}`);
      const t = st.ticks;
      if (t.gaps) {
        console.log(
          `Тики (по tick_end): в среднем ${t.avgMs.toFixed(1)} мс, от ${t.minMs.toFixed(1)} до ${t.maxMs.toFixed(1)} мс; ` +
            `длиннее 70 мс: ${t.over70}, пачкой: ${t.under5}`,
        );
      }
    }
    if (checks.size) {
      console.log('Срабатывания Grim:');
      for (const [name, c] of checks) {
        console.log(`  ${name}: сообщений ${c.alerts}, нарушений до x${c.maxVl}${c.lastDetails ? ` (последнее: ${c.lastDetails})` : ''}`);
      }
    } else {
      console.log('Grim ничего не заметил.');
    }
    if (other.length) {
      console.log('Сервер заметил:');
      for (const line of other) console.log(`  ${line}`);
    }
    return result.online && !result.problem && !result.kick && !checks.size && !other.length ? 0 : 1;
  } finally {
    await stopServer(server && server.child);
    process.removeListener('SIGINT', stopOnCtrlC);
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(`Ошибка: ${err && err.message ? err.message : err}`);
    process.exit(1);
  },
);
