'use strict';

const { app, BrowserWindow, Menu, clipboard, ipcMain, net, safeStorage, session, shell, utilityProcess } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Fleet } = require('./fleet');
const { AiAgent, formatDuration } = require('./ai');
const { DEFAULT_CONFIG, sanitize, validate, accountsOf } = require('./config');
const { maskSecrets } = require('./chat-utils');

// Фиксированная папка для настроек и логов: %APPDATA%\MineBlazeBotPanel
app.setPath('userData', path.join(app.getPath('appData'), 'MineBlazeBotPanel'));

// Самопроверка сборки: MBP_SELFTEST_OUT=<файл> — без окон запустить процесс ботов, загрузить его модули
// (в собранном exe — из app.asar), поднять и закрыть экран бота, записать итог в файл и выйти.
// С MBP_SELFTEST_SERVER=<адрес:порт> бот ещё и заходит на сервер (тестовый стенд) и стоит там
// MBP_SELFTEST_STAY секунд — так проверяется весь путь бота в настоящем Electron (npm run stand:check -- --electron).
const SELFTEST_OUT = process.env.MBP_SELFTEST_OUT || '';
if (SELFTEST_OUT) app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'mbp-selftest-')));

const config = { ...DEFAULT_CONFIG }; // настройки панели; копию держат процессы ботов
const SECRET_FIELDS = ['loginPassword', 'joinCommands', 'accounts', 'aiKey']; // хранятся зашифрованными (Windows DPAPI)
const ICON = path.join(__dirname, 'assets', 'icon.png');
const VIEWER_PARTITION = 'mineblaze-viewer'; // без «persist:» — сессия окна экрана живёт только в памяти
const CHAT_HISTORY = 300; // строк чата каждого бота: выбрал бота в списке — видишь его чат
let configFile = '';
let logsDir = '';
let win = null;
let fleet = null; // все боты (src/fleet.js)
let ai = null; // ИИ-помощник (src/ai.js)
let selectedBot = null; // чей чат в панели и кого показывает экран бота
let appliedAccounts = null; // список ботов, который уже отдан флоту
let viewerWin = null; // окно «Экран бота»
let viewerOpening = null; // общий промис, пока окно открывается (защита от двойного клика)
let viewerTarget = null; // { bot, client, url } — кого показывает экран и в каком процессе
let quitting = false;
let shutdownDone = false;
const chatHistory = new Map(); // номер бота → последние строки его чата

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
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    for (const key of SECRET_FIELDS) raw[key] = decodeSecret(raw[key]);
    Object.assign(config, sanitize(raw));
  } catch (_) {
    /* первый запуск или файл повреждён — остаются значения по умолчанию */
  }
  // Раньше бот был один («Ник бота») — он становится первым в списке «Боты».
  if (!String(config.accounts || '').trim() && config.username) config.accounts = config.username;
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
  syncFleet();
}

/** Процессам ботов — те же настройки; поменялся список ботов — флоту новый список. */
function syncFleet() {
  if (!fleet) return;
  const key = `${config.auth}\n${config.accounts}`;
  if (key !== appliedAccounts) {
    appliedAccounts = key;
    fleet.setAccounts(accountsOf(config).accounts);
  }
  fleet.pushConfig();
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

const tagOf = (nick) => (nick ? `[${nick}] ` : '');

// Одно и то же сообщение сервера (общий чат, объявления) видят все боты — в лог оно пишется один раз:
// другой бот прислал тот же текст в ближайшие секунды — пропускаем.
const CHAT_DEDUPE_MS = 3000;
const recentChat = new Map(); // текст → { time, bot }

function logChat(msg) {
  const time = msg.time || Date.now();
  const text = String(msg.text || '');
  if (msg.position !== 'self') {
    const seen = recentChat.get(text);
    if (seen && seen.bot !== msg.bot && time - seen.time < CHAT_DEDUPE_MS) return;
    recentChat.set(text, { time, bot: msg.bot });
    if (recentChat.size > 5000) {
      for (const [k, v] of recentChat) if (time - v.time >= CHAT_DEDUPE_MS) recentChat.delete(k);
    }
  }
  // Спрятанные за кликабельным текстом адреса тоже сохраняем в лог.
  const hidden = (Array.isArray(msg.links) ? msg.links : []).filter((url) => !text.includes(url));
  appendLog('chat', time, `${tagOf(msg.nick)}${hidden.length ? `${text} [${hidden.join(' ')}]` : text}`);
}

// ---------- окно и связь с интерфейсом ----------

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Строка в консоль панели и в лог — от самого главного процесса (не от бота). */
function uiLog(level, text) {
  const entry = { bot: null, nick: null, time: Date.now(), level, text };
  send('bot:log', entry);
  appendLog('events', entry.time, `${level.toUpperCase().padEnd(5)} ${text}`);
}

/** Пароли ботов и ключ ИИ — точками: ни в лог, ни в консоль, ни сервису ИИ они попасть не должны. */
function hideSecrets(text) {
  let s = String(text === undefined || text === null ? '' : text);
  const secrets = [config.loginPassword, config.aiKey, ...accountsOf(config).accounts.map((a) => a.password)];
  for (const v of new Set(secrets.filter((x) => typeof x === 'string' && x.length >= 4))) s = s.split(v).join('••••');
  return maskSecrets(s);
}

/** Строка ИИ-помощника: в консоль (с меткой «ИИ») и в лог. */
function aiLog(level, text) {
  const entry = { bot: null, nick: null, source: 'ai', time: Date.now(), level, text: hideSecrets(text) };
  send('bot:log', entry);
  appendLog('events', entry.time, `[ИИ] ${level.toUpperCase().padEnd(5)} ${entry.text}`);
}

function selectBot(id) {
  const b = fleet && fleet.get(id);
  if (b) selectedBot = b.bot;
  else if (!fleet || !fleet.get(selectedBot)) selectedBot = fleet && fleet.order.length ? fleet.order[0] : null;
  return selectedBot;
}

function registerIpc() {
  ipcMain.handle('app:init', () => {
    selectBot(selectedBot);
    return {
      config: { ...config },
      bots: fleet.list(),
      summary: fleet.summary(),
      selected: selectedBot,
      chat: chatHistory.get(selectedBot) || [],
      ai: { running: Boolean(ai && ai.busy) },
    };
  });

  ipcMain.handle('config:save', (_e, patch) => {
    Object.assign(config, sanitize(patch));
    saveConfig();
    return { ...config };
  });

  // Старт: ids — каких ботов (нет — всех); settings — поля формы, сохранить перед запуском.
  ipcMain.handle('bots:start', async (_e, { ids = null, settings = null } = {}) => {
    if (settings) Object.assign(config, sanitize(settings));
    saveConfig();
    const problem = validate(config);
    if (problem) {
      uiLog('error', problem);
      return { ok: false, config: { ...config } };
    }
    const started = await fleet.start(Array.isArray(ids) ? ids : null);
    if (!ids) {
      uiLog('info', started > 1
        ? `Запускаю ботов: ${started} — входят по одному каждые ${config.startInterval} с (последний войдёт примерно через ${Math.ceil(((started - 1) * config.startInterval) / 60)} мин)`
        : started ? 'Запускаю бота' : 'Все боты уже запущены');
    }
    return { ok: true, started, config: { ...config } };
  });

  ipcMain.handle('bots:stop', async (_e, { ids = null } = {}) => {
    if (!ids && ai && ai.stop()) aiLog('warn', 'Останавливаю ИИ: «Стоп всех»');
    const stopped = await fleet.stop(Array.isArray(ids) ? ids : null);
    if (!ids && stopped > 1) uiLog('info', `Останавливаю ботов: ${stopped}`);
    return { ok: true, stopped };
  });

  ipcMain.handle('bot:auto-reconnect', async (_e, on) => {
    const value = await fleet.setAutoReconnect(Boolean(on));
    saveConfig();
    return value;
  });

  // Сообщение или команда: mode 'one' — выбранному боту; 'all' — всем ботам в сети сразу (только команды);
  // 'turn' — команда боту «#…» всем по очереди: следующий начинает, когда закончил предыдущий.
  ipcMain.handle('bot:say', async (_e, { text, mode = 'one' } = {}) => {
    if (typeof text !== 'string' || !text.trim()) return false;
    if (mode === 'all' || mode === 'turn') {
      const r = mode === 'turn' ? fleet.runInTurn(text) : fleet.broadcast(text);
      if (r.refused) {
        uiLog('warn', `Не отправлено: ${r.refused}`);
        return false;
      }
      if (!r.targets) uiLog('warn', 'Всем ботам: в сети нет ни одного');
      else if (mode === 'all') uiLog('info', `Всем ботам в сети (${r.targets}): ${maskSecrets(text.trim())}`);
      return r.targets > 0;
    }
    if (!selectedBot) {
      uiLog('warn', 'Не отправлено: выбери бота в списке');
      return false;
    }
    try {
      return await fleet.say(selectedBot, text);
    } catch (err) {
      uiLog('error', `Процесс бота: ${errText(err)}`);
      return false;
    }
  });

  ipcMain.handle('bots:select', async (_e, id) => {
    selectBot(id);
    retargetViewer().catch((err) => uiLog('error', `Экран бота: ${errText(err)}`));
    return { selected: selectedBot, chat: chatHistory.get(selectedBot) || [] };
  });

  ipcMain.handle('app:open-logs', async () => {
    fs.mkdirSync(logsDir, { recursive: true });
    return (await shell.openPath(logsDir)) === '';
  });

  ipcMain.handle('viewer:open', () => openViewer());

  // ИИ-помощник (src/ai.js): задание словами — ИИ сам отдаёт ботам команды. settings — поля ИИ из формы.
  ipcMain.handle('ai:run', (_e, { task, settings = null } = {}) => {
    if (settings) {
      Object.assign(config, sanitize(settings));
      saveConfig();
    }
    const text = hideSecrets(String(task || '').trim()).slice(0, 2000);
    try {
      ai.run(text).catch((err) => aiLog('error', errText(err)));
    } catch (err) {
      return { ok: false, error: errText(err) };
    }
    const where = config.aiProvider === 'openai' ? `модель ${config.aiModel}` : `модель ${config.ollamaModel} на этом ПК`;
    aiLog('info', `Задание: ${text} (${where})`);
    return { ok: true };
  });

  // Готов ли ИИ (для подсказки на панели): Ollama запущена? модель скачана? у интернет-сервиса — есть ли ключ.
  ipcMain.handle('ai:status', async () => {
    try {
      return { ok: true, ...(await ai.status()) };
    } catch (err) {
      return { ok: false, error: hideSecrets(errText(err)) };
    }
  });

  ipcMain.handle('ai:get-ollama', () => shell.openExternal('https://ollama.com/download').then(() => true, () => false));

  ipcMain.handle('ai:stop', () => {
    const stopped = ai.stop();
    if (stopped) aiLog('warn', 'Останавливаю: новые команды ботам не уйдут, начатое бот бросит');
    return stopped;
  });

  // Бесплатные модели сервиса, которые умеют вызывать инструменты (для подсказки в поле «Модель»).
  ipcMain.handle('ai:models', async (_e, settings) => {
    if (settings) {
      Object.assign(config, sanitize(settings));
      saveConfig();
    }
    try {
      return { ok: true, models: await ai.listModels() };
    } catch (err) {
      return { ok: false, error: hideSecrets(errText(err)) };
    }
  });
}

function createWindow({ show = true } = {}) {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show, // самопроверка открывает окно скрытым
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

// ---------- «Экран бота»: отдельное окно с 3D-видом мира вокруг выбранного бота ----------
// Сервер картинки живёт в процессе этого бота (рядом с ним), окно — здесь.

const viewerTitle = (id) => {
  const b = fleet && fleet.get(id);
  return b ? `Экран бота — ${b.nick}` : 'Экран бота';
};

/** Открывает окно экрана (или показывает уже открытое). true — окно есть. */
function openViewer() {
  if (viewerWin && !viewerWin.isDestroyed()) {
    if (viewerWin.isMinimized()) viewerWin.restore();
    viewerWin.show();
    viewerWin.focus();
    retargetViewer().catch((err) => uiLog('error', `Экран бота: ${errText(err)}`));
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
  const id = selectedBot;
  if (!id) {
    uiLog('warn', 'Экран бота: сначала выбери бота в списке');
    return false;
  }
  let client = null;
  try {
    client = await fleet.ensureClientOf(id);
    // Первый запуск экрана готовит его скрипты — это может занять несколько секунд.
    const url = await client.request('viewer:open', { mode: config.viewerMode, bot: id }, { timeoutMs: 60 * 1000 });
    if (quitting || !win) {
      client.request('viewer:close').catch(() => {});
      return false;
    }
    viewerTarget = { bot: id, client, url };
    createViewerWindow(id);
    return true;
  } catch (err) {
    if (!quitting) uiLog('error', `Не удалось открыть экран бота: ${errText(err)}`);
    if (!viewerWin && client) client.request('viewer:close').catch(() => {});
    return false;
  }
}

/** Выбрали другого бота, а экран открыт — показать его (в том же процессе — сразу, в другом — новым адресом). */
async function retargetViewer() {
  if (!viewerWin || viewerWin.isDestroyed() || !viewerTarget || !selectedBot || viewerTarget.bot === selectedBot) return;
  const id = selectedBot;
  const client = await fleet.ensureClientOf(id);
  if (client === viewerTarget.client) {
    await client.request('viewer:bot', { bot: id });
    viewerTarget.bot = id;
  } else {
    const old = viewerTarget.client;
    viewerTarget = null;
    old.request('viewer:close').catch(() => {});
    const url = await client.request('viewer:open', { mode: config.viewerMode, bot: id }, { timeoutMs: 60 * 1000 });
    if (!viewerWin || viewerWin.isDestroyed()) {
      client.request('viewer:close').catch(() => {});
      return;
    }
    viewerTarget = { bot: id, client, url };
    viewerWin.webContents.loadURL(url).catch(() => {});
  }
  if (viewerWin && !viewerWin.isDestroyed()) viewerWin.setTitle(viewerTitle(id));
}

function createViewerWindow(id) {
  const w = new BrowserWindow({
    width: 1000,
    height: 640,
    minWidth: 480,
    minHeight: 320,
    title: viewerTitle(id),
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
    if (!viewerTarget || !target.startsWith(viewerTarget.url)) event.preventDefault();
  });
  // Заголовок окна — с ником бота; страница экрана своё название не навязывает.
  w.on('page-title-updated', (event) => event.preventDefault());

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
    const target = viewerTarget;
    viewerTarget = null;
    if (target && !quitting) target.client.request('viewer:close').catch(() => {});
  });

  wc.loadURL(viewerTarget.url).catch((err) => {
    // ERR_ABORTED — загрузку прервали перезагрузка страницы или закрытие окна, это не ошибка.
    if (w.isDestroyed() || (err && err.code === 'ERR_ABORTED')) return;
    uiLog('error', `Не удалось открыть экран бота: ${errText(err)}`);
  });
}

// ---------- боты ----------

function createFleet() {
  const f = new Fleet({
    config,
    fork: (index) => utilityProcess.fork(path.join(__dirname, 'bot-process.js'), [], { serviceName: `MineBlaze Bots ${index + 1}`, stdio: 'pipe' }),
    initPayload: () => ({
      authCacheDir: path.join(app.getPath('userData'), 'auth-cache'),
      journalDir: path.join(logsDir, 'packets'), // журнал пакетов при кике и возврате в лобби
    }),
  });
  f.on('log', (entry) => {
    send('bot:log', entry);
    appendLog('events', entry.time, `${tagOf(entry.nick)}${entry.level.toUpperCase().padEnd(5)} ${entry.text}`);
  });
  f.on('chat', (msg) => {
    let list = chatHistory.get(msg.bot);
    if (!list) chatHistory.set(msg.bot, (list = []));
    list.push(msg);
    if (list.length > CHAT_HISTORY) list.splice(0, list.length - CHAT_HISTORY);
    if (msg.bot === selectedBot) send('bot:chat', msg); // в панели — чат выбранного бота
    logChat(msg);
  });
  f.on('state', (s) => send('bot:state', s));
  f.on('ping', (p) => send('bot:ping', p)); // пинг бота, как его считает сервер (Tab)
  f.on('summary', (s) => send('fleet:summary', s));
  f.on('list', (bots) => {
    for (const id of [...chatHistory.keys()]) if (!f.get(id)) chatHistory.delete(id);
    selectBot(selectedBot);
    send('fleet:list', { bots, selected: selectedBot });
  });
  // Сервер прислал ссылку (например, проверку «я не робот»): мигаем окном на панели задач,
  // чтобы успеть перейти по ней, пока сервер ждёт.
  f.on('link', () => {
    if (win && !win.isDestroyed() && !win.isFocused()) win.flashFrame(true);
  });
  f.on('msa', (data) => {
    if (!data) return;
    // Код сразу в буфер обмена, страница входа Microsoft открывается сама.
    if (typeof data.user_code === 'string') {
      try {
        clipboard.writeText(data.user_code);
        uiLog('info', `${data.nick ? `${data.nick}: ` : ''}код скопирован в буфер обмена — вставь его на открывшейся странице (Ctrl+V)`);
      } catch (_) {
        /* не страшно: код и так виден в консоли */
      }
    }
    if (typeof data.verification_uri === 'string' && data.verification_uri.startsWith('https://')) {
      shell.openExternal(data.verification_uri);
    }
  });
  // Режим переключают в самом окне экрана — запоминаем его до следующего раза.
  f.on('viewer-mode', (mode) => {
    Object.assign(config, sanitize({ viewerMode: mode }));
    saveConfig();
  });
  // То, что процессы ботов печатают сами (предупреждения mineflayer и т.п.), — в отдельный лог.
  f.on('output', ({ worker, stream, line }) => appendLog('process', Date.now(), `#${worker + 1} ${stream === 'stderr' ? 'ERR ' : ''}${line}`));
  // Упал процесс, где был бот экрана, — окно экрана закрываем (после перезапуска можно открыть снова).
  f.on('crash', () => {
    if (viewerTarget && !viewerTarget.client.child && viewerWin && !viewerWin.isDestroyed()) viewerWin.close();
  });
  return f;
}

// ---------- ИИ-помощник ----------

/**
 * Чем запустить Ollama (значок у часов): её программа или ярлыки, которые ставит установщик.
 * Пусто — Ollama не установлена.
 */
function ollamaLaunchers() {
  if (process.platform !== 'win32') return [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const roaming = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const programs = path.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  return [
    path.join(local, 'Programs', 'Ollama', 'ollama app.exe'),
    path.join(programs, 'Ollama.lnk'),
    path.join(programs, 'Ollama', 'Ollama.lnk'),
    path.join(programs, 'Startup', 'Ollama.lnk'),
  ].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch (_) {
      return false;
    }
  });
}

/** Ollama не запущена — запустить её, как из меню «Пуск». true — нашли и запустили. */
async function startOllama() {
  for (const target of ollamaLaunchers()) {
    if ((await shell.openPath(target)) === '') return true;
  }
  return false;
}

function createAi() {
  const agent = new AiAgent({
    getConfig: () => config,
    // Сеть Chromium, а не fetch из Node: прокси и сертификаты Windows (антивирус с проверкой HTTPS иначе мешает).
    fetch: (url, opts) => net.fetch(url, opts),
    env: {
      listBots: () => fleet.list(),
      // Ответы ботов уходят сервису ИИ — пароли из них (если вдруг попали) прячем.
      runCommand: async (ids, line, signal) => (await fleet.commandEach(ids, line, { signal }))
        .map((r) => ({ ...r, message: r.message.map(hideSecrets) })),
      startBots: async (ids) => {
        const problem = validate(config);
        if (problem) throw new Error(problem);
        return fleet.start(ids);
      },
      catalog: () => require('./bot/commands').catalog(), // список команд ботов — тот же, что #помощь
      startOllama,
      ollamaInstalled: () => ollamaLaunchers().length > 0,
    },
  });
  agent.on('action', ({ text }) => {
    aiLog('info', text);
    send('ai:progress', { text: hideSecrets(text) });
  });
  agent.on('progress', ({ text }) => send('ai:progress', { text: hideSecrets(text) }));
  agent.on('thought', ({ text }) => aiLog('info', `«${text}»`));
  agent.on('done', ({ text, partial, requests, provider, ms }) => {
    const took = formatDuration(ms);
    const how = provider === 'ollama' ? `ходов ИИ: ${requests}, ${took}` : `запросов к ИИ: ${requests}`;
    aiLog(partial ? 'warn' : 'ok', `Итог (${how}): ${text}`);
    send('ai:done', { text: hideSecrets(text), partial, requests, provider, took });
  });
  agent.on('error', ({ text }) => {
    aiLog('error', `Не получилось: ${text}`);
    send('ai:done', { text: hideSecrets(text), error: true });
  });
  agent.on('state', (s) => send('ai:state', s));
  return agent;
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

    fleet = createFleet();
    ai = createAi();
    syncFleet(); // процессы ботов запускаются, когда нужны (по «Старт» или для экрана бота)
    selectBot(null);

    // Странице экрана бота не нужны камера, уведомления и прочие разрешения.
    session.fromPartition(VIEWER_PARTITION).setPermissionRequestHandler((_wc, permission, callback) => {
      callback(permission === 'fullscreen' || permission === 'pointerLock');
    });

    registerIpc();
    Menu.setApplicationMenu(null);
    createWindow();
  });

  // Перед выходом даём ботам выйти с сервера (не дольше нескольких секунд).
  app.on('before-quit', (event) => {
    if (shutdownDone) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    if (ai) ai.stop();
    Promise.resolve(fleet && fleet.shutdown())
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
  // MBP_SELFTEST_BOTS=N — на сервер заходят N ботов (StandBot1…N) через флот, как «Старт всех» в панели.
  const count = Math.max(1, Math.min(200, parseInt(process.env.MBP_SELFTEST_BOTS, 10) || 1));
  const interval = Math.max(1, Math.min(120, parseInt(process.env.MBP_SELFTEST_INTERVAL, 10) || 1));
  const stay = Math.max(5, Number(process.env.MBP_SELFTEST_STAY) || 30);
  const limitSec = 90 + (process.env.MBP_SELFTEST_SERVER ? count * interval + stay + 90 : 0);
  setTimeout(() => finish({ ok: false, error: `самопроверка не закончилась за ${limitSec} с` }, 2), limitSec * 1000);
  app.whenReady().then(async () => {
    logsDir = path.join(app.getPath('userData'), 'logs');
    const nick = process.env.MBP_SELFTEST_NICK || 'StandBot';
    const nicks = count === 1 ? [nick] : Array.from({ length: count }, (_, i) => `${nick}${i + 1}`);
    Object.assign(config, { accounts: nicks.join('\n'), username: nicks[0], startInterval: interval });
    fleet = createFleet();
    ai = createAi();
    syncFleet();
    selectBot(null);
    try {
      const client = await fleet.ensureClientOf(nicks[0]);
      const pong = await client.request('ping');
      const details = await client.request('selftest', {}, { timeoutMs: 60 * 1000 });
      // ИИ-помощник: список команд ботов грузится в главном процессе (в exe — из app.asar), подсказка модели собирается.
      const aiPrompt = require('./ai').systemPrompt(require('./bot/commands').catalog());
      const aiCheck = { promptChars: aiPrompt.length, ok: aiPrompt.length > 1000 && aiPrompt.includes('#квесты') };
      registerIpc();
      createWindow({ show: false });
      const ui = await checkUi(nicks.length);
      const server = process.env.MBP_SELFTEST_SERVER ? await selftestOnServer(process.env.MBP_SELFTEST_SERVER, nicks, stay * 1000) : null;
      await fleet.shutdown();
      finish({ ok: pong === 'pong' && ui.ok && aiCheck.ok && (!server || server.online), ...details, ui, ai: aiCheck, server }, 0);
    } catch (err) {
      finish({ ok: false, error: errText(err) }, 1);
    }
  });
}

/**
 * Окно панели (скрытое) грузится без ошибок: видит всех ботов, выбор бота, фильтр консоли и «всем» работают.
 * Ошибки страницы — из её консоли (так видны и необработанные исключения).
 */
async function checkUi(expected) {
  const errors = [];
  const wc = win.webContents;
  wc.on('console-message', (event, level, message) => {
    const lv = event && event.level !== undefined ? event.level : level;
    const text = event && event.message !== undefined ? event.message : message;
    if (lv === 'error' || lv === 3) errors.push(String(text));
  });
  wc.on('preload-error', (_event, _path, err) => errors.push(`preload: ${errText(err)}`));
  if (wc.isLoading()) await new Promise((resolve) => wc.once('did-finish-load', resolve));
  const result = await wc.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 50 && document.querySelectorAll('.bot').length < ${Number(expected)}; i += 1) await sleep(100);
    const chips = [...document.querySelectorAll('.bot')];
    const out = { bots: chips.length, status: document.getElementById('statusText').textContent };
    if (chips.length > 1) {
      chips[1].click();
      for (let i = 0; i < 20 && !chips[1].classList.contains('is-selected'); i += 1) await sleep(50);
    }
    out.selected = (document.querySelector('.bot.is-selected') || {}).textContent || null;
    out.chatWho = document.getElementById('chatWho').textContent;
    const only = document.getElementById('onlySelected');
    only.checked = true;
    only.dispatchEvent(new Event('change'));
    const mode = document.getElementById('sendMode');
    mode.value = 'turn';
    mode.dispatchEvent(new Event('change'));
    out.placeholder = document.getElementById('chatInput').placeholder;
    out.ai = Boolean(document.getElementById('aiRun') && document.getElementById('aiProvider').value === 'ollama' && document.getElementById('ollamaModel').value);
    return out;
  })()`, true);
  const wantSelected = fleet.order.length > 1 ? fleet.get(fleet.order[1]).nick : fleet.order.length ? fleet.get(fleet.order[0]).nick : null;
  return { ok: errors.length === 0 && result.bots === expected && result.selected === wantSelected && result.ai, ...result, errors };
}

/** Память и процессор процессов ботов (Electron считает их сам): сколько уходит на бота. */
function processMetrics() {
  const mb = (kb) => Math.round((kb || 0) / 1024);
  const all = app.getAppMetrics();
  const bots = all.filter((m) => /MineBlaze Bots/.test(`${m.serviceName || ''} ${m.name || ''}`));
  return {
    processes: bots.map((m) => ({ name: m.name || m.serviceName, memoryMB: mb(m.memory.workingSetSize), privateMB: mb(m.memory.privateBytes), cpu: Math.round(m.cpu.percentCPUUsage) })),
    botsMB: mb(bots.reduce((s, m) => s + m.memory.workingSetSize, 0)),
    appMB: mb(all.reduce((s, m) => s + m.memory.workingSetSize, 0)),
  };
}

/** Боты заходят на сервер (по очереди, как в панели) и стоят там: консоль, состояния, что отправлял первый, память. */
async function selftestOnServer(address, nicks, stayMs) {
  const [host, port] = String(address).split(':');
  const ids = nicks.map((n) => n.toLowerCase());
  const first = ids[0];
  const states = [];
  const logs = [];
  fleet.on('state', (s) => {
    if (s.bot === first) states.push(s.state);
  });
  fleet.on('log', (e) => logs.push(`${e.level}: ${e.nick && ids.length > 1 ? `[${e.nick}] ` : ''}${e.text}`));
  Object.assign(config, {
    host,
    port: Number(port) || 25565,
    accounts: nicks.join('\n'),
    username: nicks[0],
    version: process.env.MBP_SELFTEST_VERSION || DEFAULT_CONFIG.version,
    auth: 'offline',
    autoReconnect: false,
  });
  syncFleet();
  const stateOf = (id) => (fleet.get(id) ? fleet.get(id).state : 'offline');
  const onlineCount = () => ids.filter((id) => stateOf(id) === 'online').length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await fleet.start(ids);
  // Ждём, пока войдут все (или каждый либо вошёл, либо окончательно не смог).
  const deadline = Date.now() + (ids.length * (config.startInterval || 1) + 60) * 1000;
  while (Date.now() < deadline && !ids.every((id) => ['online', 'offline'].includes(stateOf(id)))) await sleep(250);
  const joined = onlineCount();
  processMetrics(); // отсчёт процессора — с этого момента
  if (joined) await sleep(stayMs);
  const stayed = onlineCount();
  const metrics = processMetrics();
  const client = fleet.clientOf(first);
  const stats = client ? await client.request('journalStats', { bot: first, windowMs: stayMs }) : null;
  await fleet.stop(ids);
  await sleep(1500);
  return {
    online: joined === ids.length && stayed === ids.length,
    bots: ids.length,
    joined,
    stayed,
    stayMs,
    states,
    logs,
    stats,
    memory: { ...metrics, perBotMB: stayed ? Math.round(metrics.botsMB / stayed) : null },
  };
}

if (SELFTEST_OUT) {
  runSelftest();
} else if (app.requestSingleInstanceLock()) {
  startApp();
} else {
  app.quit();
}
