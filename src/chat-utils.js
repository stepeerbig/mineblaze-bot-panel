'use strict';

/*
 * Превращает «сырые» данные от mineflayer (причина кика, причина разрыва, ошибки сети)
 * в короткий понятный текст для консоли.
 */

// Частые причины отключения (ключи из клиента Minecraft) по-русски.
// Если у ключа есть аргументы (например, причина бана), они дописываются через двоеточие.
const TRANSLATIONS = {
  'multiplayer.disconnect.banned': 'Аккаунт забанен на этом сервере',
  'multiplayer.disconnect.banned.reason': 'Аккаунт забанен на этом сервере, причина',
  'multiplayer.disconnect.banned_ip.reason': 'IP-адрес забанен на этом сервере, причина',
  'multiplayer.disconnect.ip_banned': 'IP-адрес забанен на этом сервере',
  'multiplayer.disconnect.not_whitelisted': 'Ника нет в белом списке сервера',
  'multiplayer.disconnect.server_full': 'Сервер заполнен',
  'multiplayer.disconnect.server_shutdown': 'Сервер выключается',
  'multiplayer.disconnect.duplicate_login': 'Под этим ником зашли с другого места',
  'multiplayer.disconnect.name_taken': 'Этот ник уже занят',
  'multiplayer.disconnect.idling': 'Кик за бездействие',
  'multiplayer.disconnect.flying': 'Кик за полёт',
  'multiplayer.disconnect.invalid_player_movement': 'Кик за недопустимое движение',
  'multiplayer.disconnect.kicked': 'Кик оператором сервера',
  'multiplayer.disconnect.slow_login': 'Слишком долгий вход на сервер',
  'multiplayer.disconnect.unverified_username': 'Не удалось проверить ник (online-mode на сервере?)',
  'multiplayer.disconnect.authservers_down': 'Серверы авторизации Mojang недоступны',
  'multiplayer.disconnect.incompatible': 'Несовместимая версия клиента',
  'multiplayer.disconnect.outdated_client': 'Версия клиента не подходит серверу',
  'multiplayer.disconnect.outdated_server': 'Версия клиента новее, чем у сервера',
  'multiplayer.disconnect.chat_validation_failed': 'Не пройдена проверка чата',
  'multiplayer.disconnect.too_many_pending_chats': 'Слишком много сообщений чата подряд',
  'multiplayer.disconnect.illegal_characters': 'Недопустимые символы в чате',
  'disconnect.spam': 'Кик за спам',
  'disconnect.timeout': 'Тайм-аут соединения',
  'disconnect.lost': 'Соединение потеряно',
  'disconnect.closed': 'Соединение закрыто',
  'disconnect.kicked': 'Кик с сервера',
  'disconnect.packetError': 'Ошибка сетевого протокола',
  'disconnect.exceeded_packet_rate': 'Превышен лимит пакетов',
  'disconnect.loginFailedInfo': 'Не удалось войти',
  'disconnect.loginFailedInfo.invalidSession': 'Недействительная сессия (войди в Microsoft заново)',
  'disconnect.loginFailedInfo.serversUnavailable': 'Серверы авторизации недоступны',
};

// Ключи, у которых важны только аргументы (сам шаблон — просто «%s»).
const PASSTHROUGH_KEYS = new Set(['disconnect.genericReason']);

// Кики, после которых автоматический реконнект не поможет (и может навредить).
const NO_RETRY_KEYS = {
  'multiplayer.disconnect.banned': 'аккаунт забанен',
  'multiplayer.disconnect.banned.reason': 'аккаунт забанен',
  'multiplayer.disconnect.banned_ip.reason': 'IP-адрес забанен',
  'multiplayer.disconnect.ip_banned': 'IP-адрес забанен',
  'multiplayer.disconnect.not_whitelisted': 'ника нет в белом списке',
  'multiplayer.disconnect.duplicate_login': 'под этим ником зашли с другого места (реконнект выкинул бы его)',
  'multiplayer.disconnect.outdated_client': 'версия клиента не подходит — укажи версию сервера',
  'multiplayer.disconnect.outdated_server': 'версия клиента не подходит — укажи версию сервера',
  'multiplayer.disconnect.incompatible': 'версия клиента не подходит — укажи версию сервера',
};

// То же по тексту: плагины (LiteBans, прокси) присылают обычный текст, а не ключ.
const NO_RETRY_TEXT = [
  [/\bbanned\b|забанен/i, 'аккаунт забанен'],
  [/logged in from another location/i, 'под этим ником зашли с другого места (реконнект выкинул бы его)'],
  [/outdated (client|server)/i, 'версия клиента не подходит — укажи версию сервера'],
];

// Коды сетевых ошибок.
const ERROR_HINTS = {
  ECONNREFUSED: 'сервер отклонил подключение (выключен или неверный порт)',
  ETIMEDOUT: 'время ожидания истекло (сервер не отвечает)',
  ENOTFOUND: 'адрес сервера не найден (проверь IP или домен)',
  EAI_AGAIN: 'не удалось определить адрес сервера (DNS или интернет)',
  ECONNRESET: 'соединение сброшено',
  EHOSTUNREACH: 'сервер недоступен',
  ENETUNREACH: 'сеть недоступна',
  EPIPE: 'соединение разорвано',
};

// Причины закрытия соединения, которые отдаёт mineflayer в событии 'end'.
const END_REASONS = {
  socketClosed: 'соединение закрыто (сервер отключил бота или оборвалась сеть)',
  'disconnect.quitting': 'бот вышел с сервера',
  keepAliveError: 'сервер перестал отвечать (keep-alive)',
  timeout: 'тайм-аут соединения',
  stopped: 'бот остановлен',
  error: 'ошибка соединения',
};

// Команды авторизации: их аргументы (пароли) никогда не показываем.
const SECRET_COMMANDS = new Set([
  'l', 'log', 'login', 'reg', 'register', 'cp', 'changepass', 'changepassword', 'unregister',
]);

const NBT_TYPES = new Set([
  'compound', 'list', 'string', 'byte', 'short', 'int', 'long', 'float', 'double',
  'byteArray', 'intArray', 'longArray',
]);

// Узел в «типизированном» NBT-формате: { type: 'compound', value: {...} }.
function isTypedNbt(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  if (typeof node.type !== 'string' || !NBT_TYPES.has(node.type) || !('value' in node)) return false;
  return Object.keys(node).every((k) => k === 'type' || k === 'value' || k === 'name');
}

function nbtTransform(value, type) {
  if (type === 'compound') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = simplifyNbt(value[key]);
    return out;
  }
  if (type === 'list') return value.value.map((v) => nbtTransform(v, value.type));
  return value;
}

// Новые версии Minecraft (1.20.3+) могут присылать текст в виде NBT — приводим к обычному объекту.
function simplifyNbt(node) {
  return isTypedNbt(node) ? nbtTransform(node.value, node.type) : node;
}

function componentToText(c) {
  if (c === null || c === undefined) return '';
  if (typeof c === 'string') return c;
  if (typeof c === 'number' || typeof c === 'boolean') return String(c);
  if (Array.isArray(c)) return c.map(componentToText).join('');
  if (typeof c !== 'object') return '';

  let out = '';
  if (typeof c.text === 'string') {
    out += c.text;
  } else if (typeof c.translate === 'string') {
    const args = Array.isArray(c.with) ? c.with.map((a) => componentToText(simplifyNbt(a))) : [];
    if (PASSTHROUGH_KEYS.has(c.translate)) {
      out += args.join(', ');
    } else {
      const base = TRANSLATIONS[c.translate] || c.translate;
      out += args.length ? `${base}: ${args.join(', ')}` : base;
    }
  }
  if (c.extra) out += componentToText(c.extra);
  return out;
}

function stripFormatting(s) {
  return String(s).replace(/§./g, '').trim();
}

/** Любой формат (JSON-строка, NBT, объект, обычная строка) -> компонент или строка. */
function toComponent(input) {
  if (typeof input === 'string') {
    const s = input.trim();
    if (!/^[[{"]/.test(s)) return s;
    try {
      return simplifyNbt(JSON.parse(s));
    } catch (_) {
      return s;
    }
  }
  return simplifyNbt(input);
}

/** Любое «чат-сообщение» (JSON-строка, NBT, объект, обычная строка) -> простой текст. */
function chatToText(input) {
  try {
    if (input === undefined || input === null) return '';
    return stripFormatting(componentToText(toComponent(input)));
  } catch (_) {
    return String(input);
  }
}

// Все ключи translate внутри компонента (включая extra и with).
function collectTranslateKeys(c, out = new Set(), depth = 0) {
  if (!c || typeof c !== 'object' || depth > 20) return out;
  if (Array.isArray(c)) {
    for (const item of c) collectTranslateKeys(simplifyNbt(item), out, depth + 1);
    return out;
  }
  if (typeof c.translate === 'string') out.add(c.translate);
  if (c.extra) collectTranslateKeys(c.extra, out, depth + 1);
  if (Array.isArray(c.with)) collectTranslateKeys(c.with, out, depth + 1);
  return out;
}

/**
 * Если по причине кика переподключаться бессмысленно (бан, белый список, вход с другого места,
 * не та версия) — возвращает короткое объяснение, иначе null.
 */
function noRetryReason(reason) {
  try {
    for (const key of collectTranslateKeys(toComponent(reason))) {
      if (NO_RETRY_KEYS[key]) return NO_RETRY_KEYS[key];
    }
  } catch (_) {
    /* ниже проверим по тексту */
  }
  const text = chatToText(reason);
  for (const [re, why] of NO_RETRY_TEXT) {
    if (re.test(text)) return why;
  }
  return null;
}

/** «/login secret» -> «/login ••••»: пароли не должны попадать ни в чат, ни в консоль. */
function maskSecrets(message) {
  const s = String(message);
  const m = s.match(/^\/(\S+)(\s+.*)?$/s);
  if (!m || !m[2] || !SECRET_COMMANDS.has(m[1].toLowerCase())) return s;
  const hidden = m[2].trim().split(/\s+/).map(() => '••••').join(' ');
  return `/${m[1]} ${hidden}`;
}

function describeError(err) {
  if (!err) return 'неизвестная ошибка';
  const code = err.code || (Array.isArray(err.errors) && err.errors[0] && err.errors[0].code);
  if (code && ERROR_HINTS[code]) return `${ERROR_HINTS[code]} [${code}]`;
  return err.message || code || err.name || String(err);
}

function describeEnd(reason) {
  if (reason === undefined || reason === null || reason === '') return 'соединение закрыто';
  if (typeof reason === 'string' && END_REASONS[reason]) return END_REASONS[reason];
  return chatToText(reason) || 'соединение закрыто';
}

// ---------- ссылки ----------

const URL_RE = /https?:\/\/[^\s"'<>\\`{}|^]+/gi;
const URL_TAIL_RE = /[.,;:!?)\]}»”’'"]+$/; // знаки препинания после ссылки в тексте — не часть адреса

/**
 * Все http(s)-ссылки внутри любого значения: строки, JSON-строки, компоненты чата (в том числе
 * скрытые в clickEvent / click_event), NBT, пакеты целиком. Порядок — как найдены, без повторов.
 * Буферы не читаем; обход ограничен, чтобы большой пакет не подвесил бота.
 */
function extractLinks(value, { maxNodes = 5000, maxDepth = 24 } = {}) {
  const found = new Set();
  let nodes = 0;
  const seen = new Set();
  const fromString = (s) => {
    // §-коды цвета и экранированные «\/» из JSON не должны попадать в адрес.
    const clean = s.replace(/§[0-9a-fk-orx#]/gi, ' ').replace(/\\\//g, '/');
    for (const m of clean.matchAll(URL_RE)) {
      const url = m[0].replace(URL_TAIL_RE, '');
      if (url.length > 'https://'.length && url.length <= 2048) found.add(url);
    }
  };
  const walk = (v, depth) => {
    if (nodes++ > maxNodes || depth > maxDepth || v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (v.length <= 100000 && /https?:/i.test(v)) fromString(v);
      return;
    }
    if (typeof v !== 'object' || Buffer.isBuffer(v) || ArrayBuffer.isView(v) || seen.has(v)) return;
    seen.add(v);
    const items = Array.isArray(v) ? v : Object.values(v);
    for (const item of items) walk(item, depth + 1);
  };
  try {
    walk(value, 0);
  } catch (_) {
    /* необычное значение — вернём то, что успели найти */
  }
  return [...found];
}

module.exports = { chatToText, describeError, describeEnd, noRetryReason, maskSecrets, extractLinks };
