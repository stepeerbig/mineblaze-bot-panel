'use strict';

const DEFAULT_CONFIG = Object.freeze({
  host: 'mineblaze.net',
  port: 25565,
  username: 'TestBot',
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
});

const MAX_WHITELIST_LENGTH = 5000;

const VIEWER_MODES = ['first', 'third'];

const MAX_JOIN_COMMANDS = 10;
const MAX_CHAT_LENGTH = 256;
const NICK_RE = /^[A-Za-z0-9_]{3,16}$/;

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
  if (typeof src.whitelist === 'string') out.whitelist = src.whitelist.replace(/\r\n?/g, '\n').slice(0, MAX_WHITELIST_LENGTH);
  return out;
}

/** Возвращает текст проблемы или null, если запускать можно. */
function validate(cfg) {
  if (!cfg.host) return 'Не указан адрес сервера';
  if (/\s/.test(cfg.host) || /^[a-z]+:\/\//i.test(cfg.host)) {
    return 'Адрес сервера указан неверно: нужен только домен или IP, например mineblaze.net';
  }
  if (cfg.auth === 'microsoft') {
    if (!cfg.username) return 'Не указана почта Microsoft-аккаунта';
    return null;
  }
  if (!cfg.username) return 'Не указан ник бота';
  if (!NICK_RE.test(cfg.username)) {
    return 'Ник должен быть длиной 3–16 символов: латинские буквы, цифры и «_»';
  }
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

module.exports = { DEFAULT_CONFIG, MAX_CHAT_LENGTH, sanitize, validate, parseJoinCommands };
