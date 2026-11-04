'use strict';

const { app, BrowserWindow, Menu, clipboard, ipcMain, safeStorage, session, shell, utilityProcess } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { BotClient } = require('./bot-client');
const { DEFAULT_CONFIG, sanitize, validate } = require('./config');

// Фиксированная папка для настроек и логов: %APPDATA%\MineBlazeBotPanel
app.setPath('userData', path.join(app.getPath('appData'), 'MineBlazeBotPanel'));

// Самопроверка сборки: MBP_SELFTEST_OUT=<файл> — без окон запустить процесс бота, загрузить его модули
// (в собранном exe — из app.asar), поднять и закрыть экран бота, записать итог в файл и выйти.
// С MBP_SELFTEST_SERVER=<адрес:порт> бот ещё и заходит на сервер (тестовый стенд) и стоит там
// MBP_SELFTEST_STAY секунд — так проверяется весь путь бота в настоящем Electron (npm run stand:check -- --electron).
const SELFTEST_OUT = process.env.MBP_SELFTEST_OUT || '';
if (SELFTEST_OUT) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mbp-selftest-')));

const config = { ...DEFAULT_CONFIG }; // настройки панели; копию держит процесс бота
const SECRET_FIELDS = ['loginPassword', 'joinCommands']; // хранятся зашифрованными (Windows DPAPI)
const ICON = path.join(__dirname, 'assets', 'icon.png');
const VIEWER_PARTITION = 'mineblaze-viewer'; // без «persist:» — сессия окна экрана живёт только в памяти
let configFile = '';
let logsDir = '';
let win = null;
let bot = null; // связь с процессом бота (src/bot-client.js)
let viewerWin = null; // окно «Экран бота»
let viewerOpening = null; // общий промис, пока окно открывается (защита от двойного клика)
let quitting = false;
let shutdownDone = false;

const errText = (err) => (err && err.message ? err.message : String(err));

// ---------- настройки ----------

function encodeSecret(value) {
  if (!value) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(value).toString('base64')}`;
  } catch (_) {
    /* шифрование недоступно — сохраним как есть */
  }
  return `txt:${value}`;
}

function decodeSecret(value) {
  if (typeof value !== 'string' || !value) return '';
  if (value.startsWith('enc:')) {
    try {
      return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'));
    } catch (_) {
      return ''; // зашифровано под другим пользователем Windows — придётся ввести заново
    }
  }
  return value.startsWith('txt:') ? value.slice(4) : value;
}

function loadConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    for (const key of SECRET_FIELDS) raw[key] = decodeSecret(raw[key]);
    Object.assign(config, sanitize(raw));
  } catch (_) {
    /* первый запуск или файл повреждён — остаются значения по умолчанию */
  }
}

function saveConfig() {
  const data = { ...config };
  for (const key of SECRET_FIELDS) data[key] = encodeSecret(config[key]);
  const json = JSON.stringify(data, null, 2);
  try {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    // Через временный файл: если программа упадёт посреди записи, старые настройки не пострадают.
    const tmp = `${configFile}.tmp`;
    fs.writeFileSync(tmp, json, 'utf8');
    try {
      fs.renameSync(tmp, configFile);
    } catch (_) {
      fs.writeFileSync(configFile, json, 'utf8');
      fs.rmSync(tmp, { force: true });
    }
  } catch (err) {
    uiLog('error', `Не удалось сохранить настройки: ${err.message}`);
  }
  if (bot) bot.setConfig({ ...config }); // процессу бота — те же настройки
}

// ---------- логи в файлы: %APPDATA%\MineBlazeBotPanel\logs ----------

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const logStreams = new Map(); // вид лога -> { day, stream }
let logWriteFailed = false;

function appendLog(kind, time, line) {
  if (!logsDir) return;
  const d = new Date(time || Date.now());
  const day = dayOf(d);
  let entry = logStreams.get(kind);
  if (!entry || entry.day !== day) {
    if (entry) entry.stream.end();
    try {
      fs.mkdirSync(logsDir, { recursive: true });
    } catch (_) {
      /* ошибку покажет поток ниже */
    }
    const stream = fs.createWriteStream(path.join(logsDir, `${kind}-${day}.log`), { flags: 'a', encoding: 'utf8' });
    stream.on('error', (err) => {
      if (logWriteFailed) return;
      logWriteFailed = true; // одного сообщения достаточно
      uiLog('error', `Не удалось записать лог в файл: ${err.message}`);
    });
    entry = { day, stream };
    logStreams.set(kind, entry);
  }
  entry.stream.write(`[${clockOf(d)}] ${line}\n`);
}

function closeLogs() {
  for (const { stream } of logStreams.values()) stream.end();
  logStreams.clear();
}

// ---------- окно и связь с интерфейсом ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Строка в консоль панели и в лог — от самого главного процесса (как у BotManager). */
function uiLog(level, text) {
  const entry = { time: Date.now(), level, text };
  send('bot:log', entry);
  appendLog('events', entry.time, `${level.toUpperCase().padEnd(5)} ${text}`);
}

/** Запрос процессу бота; ошибку показываем в консоли и возвращаем запасное значение. */
async function ask(type, payload, fallback, opts) {
  try {
    return await bot.request(type, payload, opts);
  } catch (err) {
    uiLog('error', `Процесс бота: ${errText(err)}`);
    return fallback;
  }
}

function registerIpc() {
  ipcMain.handle('app:init', () => ({ config: { ...config }, state: bot.state }));

  ipcMain.handle('config:save', (_e, patch) => {
    Object.assign(config, sanitize(patch));
    saveConfig();
    return { ...config };
  });

  ipcMain.handle('bot:start', async (_e, patch) => {
    Object.assign(config, sanitize(patch));
    saveConfig();
    const problem = validate(config);
    if (problem) {
      uiLog('error', problem);
      return { ok: false, config: { ...config } };
    }
    return { ok: Boolean(await ask('start', {}, false)), config: { ...config } };
  });

  ipcMain.handle('bot:stop', async () => {
    await ask('stop', {}, false);
    return { ok: true };
  });

  ipcMain.handle('bot:auto-reconnect', async (_e, on) => {
    const value = await ask('autoReconnect', { on: Boolean(on) }, config.autoReconnect);
    config.autoReconnect = Boolean(value);
    saveConfig();
    return config.autoReconnect;
  });

  ipcMain.handle('bot:say', (_e, text) => (typeof text === 'string' ? ask('say', { text }, false) : false));

  ipcMain.handle('app:open-logs', async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    return (await shell.openPath(logsDir)) === '';
  });

  ipcMain.handle('viewer:open', () => openViewer());
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 580,
    backgroundColor: '#1c1e22',
    title: 'MineBlaze Bot Panel',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Ссылки и новые окна не открываем внутри приложения.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url); // в т.ч. ссылки проверки от сервера
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  // F12 — инструменты разработчика (пригодится, если что-то пойдёт не так).
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  win.on('focus', () => win.flashFrame(false)); // мигание «пришла ссылка» гасим, когда окно открыли

  win.on('closed', () => {
    win = null;
    // Без главного окна экран бота не нужен, а открытым он не дал бы программе закрыться.
    if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close();
  });
}

// ---------- «Экран бота»: отдельное окно с 3D-видом мира вокруг бота ----------
// Сервер картинки живёт в процессе бота (рядом с ботом), окно — здесь.

/** Открывает окно экрана (или показывает уже открытое). true — окно есть. */
function openViewer() {
  if (viewerWin && !viewerWin.isDestroyed()) {
    if (viewerWin.isMinimized()) viewerWin.restore();
    viewerWin.show();
    viewerWin.focus();
    return Promise.resolve(true);
  }
  // Пока окно открывается, повторные нажатия ждут тот же результат, а не открывают второе.
  if (!viewerOpening) {
    viewerOpening = createViewer().finally(() => {
      viewerOpening = null;
    });
  }
  return viewerOpening;
}

async function createViewer() {
  try {
    // Первый запуск экрана готовит его скрипты — это может занять несколько секунд.
    const url = await bot.request('viewer:open', { mode: config.viewerMode }, { timeoutMs: 60 * 1000 });
    if (quitting || !win) {
      bot.request('viewer:close').catch(() => {});
      return false;
    }
    createViewerWindow(url);
    return true;
  } catch (err) {
    if (!quitting) uiLog('error', `Не удалось открыть экран бота: ${errText(err)}`);
    if (!viewerWin && bot) bot.request('viewer:close').catch(() => {});
    return false;
  }
}

function createViewerWindow(url) {
  const w = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 480,
    minHeight: 320,
    title: 'Экран бота',
    backgroundColor: '#1c1e22',
    icon: ICON,
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      partition: VIEWER_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  viewerWin = w;
  const wc = w.webContents;

  // Новые окна не открываем; со страницы экрана никуда не уходим, перезагружать её можно.
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (event, legacyUrl) => {
    const target = String((event && event.url) || legacyUrl || '');
    if (!target.startsWith(url)) event.preventDefault();
  });
  // Страница без заголовка оставила бы окно без названия.
  w.on('page-title-updated', (event, title) => {
    if (!String(title || '').trim()) event.preventDefault();
  });

  // F12 — инструменты разработчика, F5 или Ctrl+R — перезагрузить картинку (code — при любой раскладке).
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') {
      wc.toggleDevTools();
    } else if (input.key === 'F5' || (input.control && (input.code === 'KeyR' || input.key.toLowerCase() === 'r'))) {
      event.preventDefault();
      if (!input.isAutoRepeat) wc.reload();
    }
  });

  wc.on('render-process-gone', (_event, details) => {
    if (details && details.reason !== 'clean-exit') {
      uiLog('warn', `Экран бота: страница аварийно закрылась (${details.reason}). Закрой окно экрана и открой снова`);
    }
  });

  w.on('closed', () => {
    if (viewerWin === w) viewerWin = null;
    // Окно закрыли — сервер картинки тоже больше не нужен.
    if (bot && !quitting) bot.request('viewer:close').catch(() => {});
  });

  wc.loadURL(url).catch((err) => {
    // ERR_ABORTED — загрузку прервали перезагрузка страницы или закрытие окна, это не ошибка.
    if (w.isDestroyed() || (err && err.code === 'ERR_ABORTED')) return;
    uiLog('error', `Не удалось открыть экран бота: ${errText(err)}`);
  });
}

// ---------- процесс бота ----------

function createBotClient() {
  const client = new BotClient({
    fork: () => utilityProcess.fork(path.join(__dirname, 'bot-process.js'), [], { serviceName: 'MineBlaze Bot', stdio: 'pipe' }),
    initPayload: () => ({
      config: { ...config },
      authCacheDir: path.join(app.getPath('userData'), 'auth-cache'),
      journalDir: path.join(logsDir, 'packets'), // журнал пакетов при кике и возврате в лобби
    }),
  });
  client.on('log', (entry) => {
    send('bot:log', entry);
    appendLog('events', entry.time, `${entry.level.toUpperCase().padEnd(5)} ${entry.text}`);
  });
  client.on('chat', (msg) => {
    send('bot:chat', msg);
    // Спрятанные за кликабельным текстом адреса тоже сохраняем в лог.
    const hidden = (Array.isArray(msg.links) ? msg.links : []).filter((url) => !String(msg.text).includes(url));
    appendLog('chat', msg.time, hidden.length ? `${msg.text} [${hidden.join(' ')}]` : msg.text);
  });
  client.on('state', (state) => send('bot:state', state));
  // Сервер прислал ссылку (например, проверку «я не робот»): мигаем окном на панели задач,
  // чтобы успеть перейти по ней, пока сервер ждёт.
  client.on('link', () => {
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  });
  client.on('msa', (data) => {
    if (!data) return;
    // Код сразу в буфер обмена, страница входа Microsoft открывается сама.
    if (typeof data.user_code === 'string') {
      try {
        clipboard.writeText(data.user_code);
        uiLog('info', 'Код скопирован в буфер обмена: вставь его на открывшейся странице (Ctrl+V)');
      } catch (_) {
        /* не страшно: код и так виден в консоли */
      }
    }
    if (typeof data.verification_uri === 'string' && data.verification_uri.startsWith('https://')) {
      shell.openExternal(data.verification_uri);
    }
  });
  // Режим переключают в самом окне экрана — запоминаем его до следующего раза.
  client.on('viewer-mode', (mode) => {
    Object.assign(config, sanitize({ viewerMode: mode }));
    saveConfig();
  });
  // То, что процесс бота печатает сам (предупреждения mineflayer и т.п.), — в отдельный лог.
  client.on('output', ({ stream, line }) => appendLog('process', Date.now(), `${stream === 'stderr' ? 'ERR ' : ''}${line}`));

  let resume = false; // бот был в сети, когда процесс упал
  client.on('crash', ({ code, restarting, previousState }) => {
    resume = previousState !== 'offline';
    if (viewerWin && !viewerWin.isDestroyed()) viewerWin.close();
    uiLog('error', `Процесс бота неожиданно завершился (код ${code})${restarting ? ': перезапускаю…' : '. Слишком много сбоев подряд — перезапусти программу'}`);
  });
  client.on('restarted', () => {
    uiLog('ok', 'Процесс бота перезапущен');
    // Бот работал и включён автореконнект — продолжаем, как после обрыва связи.
    if (resume && config.autoReconnect) ask('start', {}, false);
    resume = false;
  });
  return client;
}

function reportFatal(err) {
  uiLog('error', `Необработанная ошибка: ${errText(err)}`);
}

function startApp() {
  process.on('uncaughtException', reportFatal);
  process.on('unhandledRejection', reportFatal);

  // Второй запуск программы просто показывает уже открытое окно:
  // два бота с одним ником выкидывали бы друг друга с сервера.
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  app.whenReady().then(() => {
    configFile = path.join(app.getPath('userData'), 'config.json');
    logsDir = path.join(app.getPath('userData'), 'logs');
    loadConfig();

    bot = createBotClient();
    bot.start().catch((err) => uiLog('error', `Не удалось запустить процесс бота: ${errText(err)}`));

    // Странице экрана бота не нужны камера, уведомления и прочие разрешения.
    session.fromPartition(VIEWER_PARTITION).setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'fullscreen' || permission === 'pointerLock');
    });

    registerIpc();
    Menu.setApplicationMenu(null);
    createWindow();
  });

  // Перед выходом даём процессу бота выйти с сервера (не дольше нескольких секунд).
  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    Promise.resolve(bot && bot.shutdown())
      .catch(() => {})
      .finally(() => {
        closeLogs();
        shutdownDone = true;
        app.quit();
      });
  });

  app.on('window-all-closed', () => app.quit());
}

function runSelftest() {
  const finish = (result, code) => {
    try {
      fs.writeFileSync(SELFTEST_OUT, JSON.stringify(result, null, 2), 'utf8');
    } catch (_) {
      /* некуда записать — останется код выхода */
    }
    app.exit(code);
  };
  setTimeout(() => finish({ ok: false, error: 'самопроверка не закончилась за 90 с' }, 2), 90 * 1000);
  app.whenReady().then(async () => {
    logsDir = path.join(app.getPath('userData'), 'logs');
    bot = createBotClient();
    try {
      await bot.start();
      const pong = await bot.request('ping');
      const details = await bot.request('selftest', {}, { timeoutMs: 60 * 1000 });
      const server = process.env.MBP_SELFTEST_SERVER ? await selftestOnServer(process.env.MBP_SELFTEST_SERVER) : null;
      await bot.shutdown();
      finish({ ok: pong === 'pong' && (!server || server.online), ...details, server }, 0);
    } catch (err) {
      finish({ ok: false, error: errText(err) }, 1);
    }
  });
}

/** Бот заходит на сервер и стоит там: что было в консоли, какие состояния, что отправлял. */
async function selftestOnServer(address) {
  const [host, port] = String(address).split(':');
  const stayMs = Math.max(5, Number(process.env.MBP_SELFTEST_STAY) || 30) * 1000;
  const states = [];
  const logs = [];
  bot.on('state', (s) => states.push(s));
  bot.on('log', (e) => logs.push(`${e.level}: ${e.text}`));
  const testConfig = {
    ...DEFAULT_CONFIG,
    host,
    port: Number(port) || 25565,
    username: process.env.MBP_SELFTEST_NICK || 'StandBot',
    version: process.env.MBP_SELFTEST_VERSION || DEFAULT_CONFIG.version,
    auth: 'offline',
    autoReconnect: false,
  };
  await bot.request('config', { config: testConfig });
  await bot.request('start');
  const online = await new Promise((resolve) => {
    if (bot.state === 'online') return resolve(true);
    const t = setTimeout(() => resolve(false), 60 * 1000);
    bot.on('state', (s) => {
      if (s === 'online') {
        clearTimeout(t);
        resolve(true);
      } else if (s === 'offline') {
        clearTimeout(t);
        resolve(false);
      }
    });
  });
  if (online) await new Promise((r) => setTimeout(r, stayMs));
  const stillOnline = bot.state === 'online';
  const stats = await bot.request('journalStats', { windowMs: stayMs });
  await bot.request('stop');
  await new Promise((r) => setTimeout(r, 1000));
  return { online: online && stillOnline, stayMs, states, logs, stats };
}

if (SELFTEST_OUT) {
  runSelftest();
} else if (app.requestSingleInstanceLock()) {
  startApp();
} else {
  app.quit();
}
