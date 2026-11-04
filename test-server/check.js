'use strict';

// Проверка бота на тестовом стенде. Если сервер не запущен — поднимает его сам, заводит бота так же,
// как панель (через BotManager), держит его в мире и показывает, что заметили античит Grim и сервер.
//
// Запуск: npm run stand:check            — бот стоит в мире 60 секунд
//         npm run stand:check -- 300     — 300 секунд
// Перед первым запуском один раз открой test-server\start-test-server.bat: он скачает сервер и спросит про EULA.
// Код выхода 0 — бот простоял всё время, его не кикнули, и ни Grim, ни сервер ничего не заметили.

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { BotManager } = require('../src/bot-manager');
const { DEFAULT_CONFIG } = require('../src/config');

const SERVER_DIR = path.join(__dirname, 'server');
const LOG_FILE = path.join(SERVER_DIR, 'logs', 'latest.log');
const BOT_NAME = 'StandBot';
const STAY_MS = Math.max(5, parseInt(process.argv[2], 10) || 60) * 1000;
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
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
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
    if (alert && alert[1] === BOT_NAME) {
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
  const child = spawn('java', ['-Xms1G', '-Xmx2G', '-jar', 'paper.jar', '--nogui'], {
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

function runBot(host, port, version) {
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
    };
    const manager = new BotManager({ config, authCacheDir: path.join(os.tmpdir(), 'mineblaze-stand-auth') });
    const result = { online: false, onlineMs: 0, kick: null, problem: null };
    let onlineAt = 0;
    let stayTimer = null;
    let finished = false;

    const finish = (problem) => {
      if (finished) return;
      finished = true;
      clearTimeout(onlineTimer);
      clearTimeout(stayTimer);
      result.problem = problem;
      result.onlineMs = onlineAt ? Date.now() - onlineAt : 0;
      if (manager.state === 'offline') {
        resolve(result);
        return;
      }
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
        clearTimeout(onlineTimer);
        console.log(`Бот в мире, стоит ${STAY_MS / 1000} с…`);
        stayTimer = setTimeout(() => finish(null), STAY_MS);
      } else if (state === 'offline') {
        finish(result.online ? 'бот отключился раньше времени' : 'бот не смог войти');
      }
    });
    manager.start();
  });
}

async function main() {
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

    const offset = logSize();
    const result = await runBot(host, port, version);
    await sleep(2000); // сервер успеет дописать лог
    const { checks, other } = summarize(readLogFrom(offset));

    console.log('');
    console.log('===== Итог =====');
    console.log(`Бот в мире: ${result.online ? `${Math.round(result.onlineMs / 1000)} с из ${STAY_MS / 1000}` : 'не появился'}`);
    if (result.kick) console.log(`Кик: ${result.kick}`);
    if (result.problem) console.log(`Проблема: ${result.problem}`);
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
