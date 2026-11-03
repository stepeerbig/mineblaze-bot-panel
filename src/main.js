'use strict';

const { app, BrowserWindow, Menu, clipboard, ipcMain, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { BotManager } = require('./bot-manager');
const { DEFAULT_CONFIG, sanitize, validate } = require('./config');

// Фиксированная папка для настроек и логов: %APPDATA%\MineBlazeBotPanel
app.setPath('userData', path.join(app.getPath('appData'), 'MineBlazeBotPanel'));

const config = { ...DEFAULT_CONFIG }; // один живой объект: его же читает BotManager
const SECRET_FIELDS = ['loginPassword', 'joinCommands']; // хранятся зашифрованными (Windows DPAPI)
const ICON = path.join(__dirname, 'assets', 'icon.png');
const VIEWER_PARTITION = 'mineblaze-viewer'; // без «persist:» — сессия окна экрана живёт только в памяти
let configFile = '';
let logsDir = '';
let win = null;
let manager = null;
let viewerWin = null; // окно «Экран бота»
let viewerServer = null; // его локальный сервер (src/viewer/viewer-server.js): живёт, пока открыто окно
let viewerOpening = null; // общий промис, пока окно открывается (защита от двойного клика)
let quitting = false;

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
    if (manager) manager.log('error', `Не удалось сохранить настройки: ${err.message}`);
  }
}

// ---------- логи в файлы: %APPDATA%\MineBlazeBotPanel\logs ----------

const pad = (n) => String(n).padStart(2, '0');
const dayOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const clockOf = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const logStreams = new Map(); // вид лога -> { day, stream }
let logWriteFailed = false;

function appendLog(kind, time, line) {
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
      if (logWriteFailed || !manager) return;
      logWriteFailed = true; // одного сообщения достаточно
      manager.log('error', `Не удалось записать лог в файл: ${err.message}`);
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

function registerIpc() {
  ipcMain.handle('app:init', () => ({ config: { ...config }, state: manager.state }));

  ipcMain.handle('config:save', (_e, patch) => {
    Object.assign(config, sanitize(patch));
    saveConfig();
    return { ...config };
  });

  ipcMain.handle('bot:start', (_e, patch) => {
    Object.assign(config, sanitize(patch));
    saveConfig();
    const problem = validate(config);
    if (problem) {
      manager.log('error', problem);
      return { ok: false, config: { ...config } };
    }
    return { ok: manager.start(), config: { ...config } };
  });

  ipcMain.handle('bot:stop', () => {
    manager.stop();
    return { ok: true };
  });

  ipcMain.handle('bot:auto-reconnect', (_e, on) => {
    const value = manager.setAutoReconnect(Boolean(on));
    saveConfig();
    return value;
  });

  ipcMain.handle('bot:say', (_e, text) => (typeof text === 'string' ? manager.say(text) : false));

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
    if (!viewerServer) {
      const { ViewerServer } = require('./viewer/viewer-server'); // грузим только при первом открытии
      const created = new ViewerServer({
        mode: config.viewerMode,
        log: (level, text) => manager.log(level, `Экран бота: ${text}`),
      });
      // Режим переключают в самом окне экрана — запоминаем его до следующего раза.
      created.on('mode', (mode) => {
        Object.assign(config, sanitize({ viewerMode: mode }));
        saveConfig();
      });
      created.on('error', (err) => manager.log('error', `Экран бота: ${errText(err)}`));
      viewerServer = created;
    }
    const server = viewerServer;
    const url = await server.start();
    if (viewerServer !== server || quitting || !win) {
      // Пока сервер запускался, программу закрыли — окно уже не нужно.
      if (viewerServer === server) await closeViewerServer();
      return false;
    }
    server.setBot(manager.getBot());
    createViewerWindow(server, url);
    return true;
  } catch (err) {
    if (!quitting) manager.log('error', `Не удалось открыть экран бота: ${errText(err)}`);
    if (!viewerWin) await closeViewerServer();
    return false;
  }
}

async function closeViewerServer() {
  const server = viewerServer;
  viewerServer = null; // события бота сюда больше не идут
  if (!server) return;
  try {
    await server.close();
  } catch (err) {
    manager.log('warn', `Экран бота: сервер не остановился: ${errText(err)}`);
  }
}

function createViewerWindow(server, url) {
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
      manager.log('warn', `Экран бота: страница аварийно закрылась (${details.reason}). Закрой окно экрана и открой снова`);
    }
  });

  w.on('closed', () => {
    if (viewerWin === w) viewerWin = null;
    if (viewerServer === server) closeViewerServer(); // окно закрыли — сервер тоже больше не нужен
  });

  wc.loadURL(url).catch((err) => {
    // ERR_ABORTED — загрузку прервали перезагрузка страницы или закрытие окна, это не ошибка.
    if (w.isDestroyed() || (err && err.code === 'ERR_ABORTED')) return;
    manager.log('error', `Не удалось открыть экран бота: ${errText(err)}`);
  });
}

function reportFatal(err) {
  if (manager) manager.log('error', `Необработанная ошибка: ${errText(err)}`);
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

    manager = new BotManager({
      config,
      authCacheDir: path.join(app.getPath('userData'), 'auth-cache'),
    });
    manager.on('log', (entry) => {
      send('bot:log', entry);
      appendLog('events', entry.time, `${entry.level.toUpperCase().padEnd(5)} ${entry.text}`);
    });
    manager.on('chat', (msg) => {
      send('bot:chat', msg);
      // Спрятанные за кликабельным текстом адреса тоже сохраняем в лог.
      const hidden = (Array.isArray(msg.links) ? msg.links : []).filter((url) => !String(msg.text).includes(url));
      appendLog('chat', msg.time, hidden.length ? `${msg.text} [${hidden.join(' ')}]` : msg.text);
    });
    // Сервер прислал ссылку (например, проверку «я не робот»): мигаем окном на панели задач,
    // чтобы успеть перейти по ней, пока сервер ждёт.
    manager.on('link', () => {
      if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
    });
    manager.on('state', (state) => send('bot:state', state));
    // Экран бота показывает того бота, который сейчас в мире (null — бота нет).
    manager.on('bot', (bot) => {
      if (viewerServer) viewerServer.setBot(bot);
    });
    manager.on('msa', (data) => {
      if (!data) return;
      // Код сразу в буфер обмена, страница входа Microsoft открывается сама.
      if (typeof data.user_code === 'string') {
        try {
          clipboard.writeText(data.user_code);
          manager.log('info', 'Код скопирован в буфер обмена: вставь его на открывшейся странице (Ctrl+V)');
        } catch (_) {
          /* не страшно: код и так виден в консоли */
        }
      }
      if (typeof data.verification_uri === 'string' && data.verification_uri.startsWith('https://')) {
        shell.openExternal(data.verification_uri);
      }
    });

    // Странице экрана бота не нужны камера, уведомления и прочие разрешения.
    session.fromPartition(VIEWER_PARTITION).setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'fullscreen' || permission === 'pointerLock');
    });

    registerIpc();
    Menu.setApplicationMenu(null);
    createWindow();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (manager) manager.shutdown();
    closeViewerServer();
    closeLogs();
  });

  app.on('window-all-closed', () => app.quit());
}

if (app.requestSingleInstanceLock()) {
  startApp();
} else {
  app.quit();
}
