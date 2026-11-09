'use strict';

const { DEFAULT_XRAY, sanitizeXray } = require('./bot/xray');

const DEFAULT_CONFIG = Object.freeze({
  host: 'mineblaze.net',
  port: 25565,
  username: 'TestBot', // один бот (как было до списка ботов): если «Боты» пусты — запускается он
  proxyPool: '', // свои прокси — только в настройках на ПК (config.json), не в коде: репозиторий публичный
   // Пул прокси: ссылки по одной на строку (socks5://user:pass@host:port)
  botsPerProxy: 4, // Сколько ботов пускать через один прокси
  accounts: '', // боты: «ник» или «ник:пароль», по одному в строке (хранится зашифрованным)
  version: '1.21.11',
  auth: 'offline',
  autoReconnect: false,
  reconnectDelay: 5,
  loginPassword: '', // если задан — после входа бот сам отправит /login <пароль>
  joinCommands: '', // команды после входа, по одной на строку (например, /server survival)
  viewerMode: 'first', // «Экран бота»: 'first' — глазами бота, 'third' — со стороны
  guard: true, // охрана: после /home или /rtp — /near раз в 5 с, чужой рядом → /spawn
  godMode: true, // режим бога: /god после перехода на сервер режима
  whitelist: '', // белый список охраны: ники, по одному в строке
  // Много ботов. Входы (и переподключения) — по одному с паузой: прокси не пускает частые входы с одного IP.
  startInterval: 5, // секунд между входами ботов
  viewDistance: 4, // дальность прорисовки, которую бот сообщает серверу: меньше чанков — меньше памяти на бота
  botsPerProcess: 10, // ботов в одном процессе: больше — тики начнут опаздывать, меньше — больше памяти на процессы
  // ИИ-помощник (src/ai.js). Где работает модель: 'ollama' — Ollama на этом ПК (бесплатно, без ключа и лимитов),
  // 'openai' — интернет-сервис с OpenAI-совместимым API и ключом (OpenRouter и др.).
  aiProvider: 'ollama',
  ollamaUrl: 'http://127.0.0.1:11434',
  ollamaModel: 'qwen3:4b-instruct',
  ollamaGpu: true, // часть модели — на видеокарту; Ollama падает на ней (старый драйвер) — панель сама выключит
  aiBaseUrl: 'https://openrouter.ai/api/v1', // интернет-сервис; ключ хранится зашифрованным
  aiKey: '',
  aiModel: 'nvidia/nemotron-3-ultra-550b-a55b:free',
  // Автопилот заданий NPC (src/quest-autopilot.js): боты сами проходят задания Фермера, Алхимика, Оружейника.
  questAuto: false, // включён (после перезапуска панели продолжит сам)
  netherCommand: '', // как попасть в Незер (например, /warp nether): #добудь обломки, кварц — бот пойдёт туда сам
  questJunk: '', // дом мусора: сундуки, куда бот складывает землю, камень, семена… (#очисти; #добудь — когда инвентарь полон)
  questStorage: '', // дом склада с предметами для «Передайте…» (/home <имя> у каждого бота)
  questRewards: '', // дом склада наград
  questMobHomes: '', // комнаты мобов для «Убейте…»: строки «пауки: пауки» (кто: дом)
  questFarm: '', // дом фермы: «Передайте пшеницу…» — сначала собрать урожай там (#урожай)
  questPen: '', // дом загона: «Разведите коров…» — покормить пары там (#разведи)
  questMine: '', // дом шахты: «Передайте редстоун…» — сначала добыть руду оттуда (#добудь)
  questTogether: 2, // ботов делают задания одновременно
  questPause: 15, // минут между проверками одного бота
  // Рентген (src/bot/xray.js): какие блоки подсвечивать в «Экране бота» и искать #рентген — цвета, радиус, лава.
  xray: DEFAULT_XRAY,
  liveBackground: true, // живой фон окна «Вороны» (src/renderer/background.js); на ботов не влияет
});

const MAX_WHITELIST_LENGTH = 5000;
const MAX_ACCOUNTS = 200;
const MAX_ACCOUNTS_LENGTH = 20000;

const VIEWER_MODES = ['first', 'third'];

const MAX_JOIN_COMMANDS = 10;
const MAX_CHAT_LENGTH = 256;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;
const AI_LOCAL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:\/\S*)?$/i; // сервис ИИ на своём ПК
// Ollama — на этом ПК или на другом в домашней сети (ключа у неё нет, так что http по своей сети — можно).
const OLLAMA_URL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d{1,5})?(?:\/\S*)?$/i;
const AI_PROVIDERS = ['ollama', 'openai'];
const HOME_RE = /^[\p{L}\p{N}_-]{1,32}$/u; // имя дома: /home <имя>

/**
 * Комнаты мобов для заданий «Убейте…»: строки «пауки: пауки» (кто — по-русски, : или =, дом). Пустые и
 * непонятные строки пропускаются. → [{ who, home }]
 */
function parseMobHomes(text) {
  const out = [];
  for (const raw of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(.+?)\s*[:=—-]\s*\/?(?:home\s+)?([\p{L}\p{N}_-]{1,32})$/iu.exec(line);
    if (m) out.push({ who: m[1].trim(), home: m[2] });
  }
  return out;
}

/** Приводит присланные значения к безопасному виду; неверные поля просто отбрасывает. */
/** Приводит присланные значения к безопасному виду; неверные поля просто отбрасывает. */
function sanitize(src) {
  const out = {};
  if (!src || typeof src !== 'object') return out;

  if (src.port !== undefined) {
    const port = parseInt(src.port, 10);
    if (port >= 1 && port <= 65535) out.port = port;
  }
  if (typeof src.host === 'string') {
    let host = src.host.trim();
    const m = host.match(/^([^:\s]+):(\d{1,5})$/); // «адрес:порт» в одном поле
    if (m && Number(m[2]) >= 1 && Number(m[2]) <= 65535) {
      host = m[1];
      out.port = Number(m[2]);
    }
    out.host = host;
  }
  if (typeof src.username === 'string') out.username = src.username.trim();
  if (typeof src.version === 'string') out.version = src.version.trim();
  if (src.auth === 'offline' || src.auth === 'microsoft') out.auth = src.auth;
  if (typeof src.autoReconnect === 'boolean') out.autoReconnect = src.autoReconnect;
  if (src.reconnectDelay !== undefined) {
    const d = parseInt(src.reconnectDelay, 10);
    if (d >= 1 && d <= 600) out.reconnectDelay = d;
  }
  if (typeof src.loginPassword === 'string') {
    out.loginPassword = src.loginPassword.replace(/[\r\n]/g, '').trim().slice(0, 100);
  }
  if (typeof src.joinCommands === 'string') {
    out.joinCommands = src.joinCommands.replace(/\r\n?/g, '\n').slice(0, 2000);
  }
  if (VIEWER_MODES.includes(src.viewerMode)) out.viewerMode = src.viewerMode;
  if (typeof src.guard === 'boolean') out.guard = src.guard;
  if (typeof src.godMode === 'boolean') out.godMode = src.godMode;
  if (typeof src.liveBackground === 'boolean') out.liveBackground = src.liveBackground;
  if (typeof src.whitelist === 'string') out.whitelist = src.whitelist.replace(/\r\n?/g, '\n').slice(0, MAX_WHITELIST_LENGTH);
  if (typeof src.accounts === 'string') out.accounts = src.accounts.replace(/\r\n?/g, '\n').slice(0, MAX_ACCOUNTS_LENGTH);
  const int = (value, min, max) => {
    const n = parseInt(value, 10);
    return n >= min && n <= max ? n : undefined;
  };
  for (const [key, min, max] of [['startInterval', 1, 120], ['viewDistance', 2, 16], ['botsPerProcess', 1, 20]]) {
    const n = src[key] === undefined ? undefined : int(src[key], min, max);
    if (n !== undefined) out[key] = n;
  }
  if (typeof src.aiBaseUrl === 'string') {
    const url = src.aiBaseUrl.trim().replace(/\/+$/, '');
    if (!url) out.aiBaseUrl = DEFAULT_CONFIG.aiBaseUrl;
    // Ключ по сети — только через https; http — лишь на своём ПК (Ollama и т.п.).
    else if (url.length <= 300 && (/^https:\/\/[^\s/]+(?:\/\S*)?$/i.test(url) || AI_LOCAL_RE.test(url))) out.aiBaseUrl = url;
  }
  if (typeof src.aiKey === 'string') out.aiKey = src.aiKey.replace(/\s+/g, '').slice(0, 300);
  if (typeof src.aiModel === 'string') out.aiModel = src.aiModel.trim().replace(/\s+/g, '').slice(0, 200) || DEFAULT_CONFIG.aiModel;
  if (AI_PROVIDERS.includes(src.aiProvider)) out.aiProvider = src.aiProvider;
  if (typeof src.ollamaGpu === 'boolean') out.ollamaGpu = src.ollamaGpu;
  if (typeof src.ollamaUrl === 'string') {
    const url = src.ollamaUrl.trim().replace(/\/+$/, '');
    if (!url) out.ollamaUrl = DEFAULT_CONFIG.ollamaUrl;
    else if (url.length <= 300 && (/^https:\/\/[^\s/]+(?:\/\S*)?$/i.test(url) || OLLAMA_URL_RE.test(url))) out.ollamaUrl = url;
  }
  if (typeof src.ollamaModel === 'string') {
    out.ollamaModel = src.ollamaModel.trim().replace(/\s+/g, '').slice(0, 200) || DEFAULT_CONFIG.ollamaModel;
  }
  if (typeof src.questAuto === 'boolean') out.questAuto = src.questAuto;
  for (const key of ['questStorage', 'questRewards', 'questFarm', 'questPen', 'questMine', 'questJunk']) {
    if (typeof src[key] !== 'string') continue;
    const home = src[key].trim().replace(/^\/?home\s+/i, ''); // «/home урожай» — тоже можно
    if (!home || HOME_RE.test(home)) out[key] = home;
  }
  if (typeof src.netherCommand === 'string') {
    const c = src.netherCommand.replace(/[\r\n]+/g, ' ').trim().slice(0, 100);
    if (!c || c.startsWith('/')) out.netherCommand = c;
  }
  if (typeof src.questMobHomes === 'string') out.questMobHomes = src.questMobHomes.replace(/\r\n?/g, '\n').slice(0, 2000);
  for (const [key, min, max] of [['questTogether', 1, 5], ['questPause', 5, 240]]) {
    const n = src[key] === undefined ? undefined : int(src[key], min, max);
    if (n !== undefined) out[key] = n;
  }
  if (src.xray && typeof src.xray === 'object') out.xray = sanitizeXray(src.xray);

  // === ДОБАВЛЕННЫЕ НАСТРОЙКИ ПРОКСИ ===
  if (typeof src.proxyPool === 'string') out.proxyPool = src.proxyPool.slice(0, 5000);
  if (src.botsPerProxy !== undefined) {
    const n = parseInt(src.botsPerProxy, 10);
    if (n >= 1 && n <= 100) out.botsPerProxy = n;
  }

  return out;
}


const NICK_PROBLEM = 'Ник должен быть длиной 3–16 символов: латинские буквы, цифры и «_»';

/**
 * Боты из поля «Боты»: в строке «ник», «ник:пароль» или «ник пароль» (пароль — для /login; нет — общий).
 * Пустые строки и «# …» пропускаются. Для входа через Microsoft вместо ника — почта.
 * → { accounts: [{ username, password }], errors: [текст] }
 */
function parseAccounts(text, { auth = 'offline' } = {}) {
  const accounts = [];
  const errors = [];
  const seen = new Set();
  String(text || '').replace(/\r\n?/g, '\n').split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) return;
    const m = /^([^\s:;]+)\s*(?:[:;]\s*|\s+)?(.*)$/.exec(line);
    const username = m ? m[1] : line;
    const password = (m ? m[2] : '').trim().slice(0, 100);
    const where = `Боты, строка ${i + 1}: «${username}»`;
    if (auth !== 'microsoft' && !NICK_RE.test(username)) {
      errors.push(`${where} — ${NICK_PROBLEM[0].toLowerCase()}${NICK_PROBLEM.slice(1)}`);
      return;
    }
    const key = username.toLowerCase();
    if (seen.has(key)) {
      errors.push(`${where} — этот бот уже есть выше`);
      return;
    }
    if (accounts.length >= MAX_ACCOUNTS) {
      if (!errors.some((e) => e.startsWith('Ботов больше'))) errors.push(`Ботов больше ${MAX_ACCOUNTS} — столько не запустить: убери лишние`);
      return;
    }
    seen.add(key);
    accounts.push({ username, password });
  });
  return { accounts, errors };
}

/** Боты из настроек: список «Боты», а если он пуст — один бот из старого поля «Ник бота». */
function accountsOf(cfg) {
  if (String(cfg.accounts || '').trim()) return parseAccounts(cfg.accounts, { auth: cfg.auth });
  const one = String(cfg.username || '').trim();
  if (!one) return { accounts: [], errors: [] };
  if (cfg.auth !== 'microsoft' && !NICK_RE.test(one)) return { accounts: [], errors: [NICK_PROBLEM] };
  return { accounts: [{ username: one, password: '' }], errors: [] };
}

/** Возвращает текст проблемы или null, если запускать можно. */
function validate(cfg) {
  if (!cfg.host) return 'Не указан адрес сервера';
  if (/\s/.test(cfg.host) || /^[a-z]+:\/\//i.test(cfg.host)) {
    return 'Адрес сервера указан неверно: нужен только домен или IP, например mineblaze.net';
  }
  const { accounts, errors } = accountsOf(cfg);
  if (errors.length) return errors[0];
  if (!accounts.length) return cfg.auth === 'microsoft' ? 'Не указана почта Microsoft-аккаунта' : 'Не указан ник бота';
  return null;
}

/** Строки из поля «Команды после входа»: без пустых, не длиннее лимита чата. */
function parseJoinCommands(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, MAX_JOIN_COMMANDS)
    .map((line) => line.slice(0, MAX_CHAT_LENGTH));
}

module.exports = { DEFAULT_CONFIG, MAX_CHAT_LENGTH, MAX_ACCOUNTS, sanitize, validate, parseJoinCommands, parseAccounts, accountsOf, parseMobHomes };
