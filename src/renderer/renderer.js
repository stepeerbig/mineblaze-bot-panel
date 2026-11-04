'use strict';

const bridge = window.api; // не «api»: это имя уже занято глобальным window.api из preload
if (!bridge) {
  document.body.textContent = 'Ошибка: не загрузился preload.js. Закрой приложение и запусти снова.';
  throw new Error('window.api is not available');
}

const $ = (id) => document.getElementById(id);

const el = {
  lamp: $('lamp'),
  statusText: $('statusText'),
  statusSub: $('statusSub'),
  btnStart: $('btnStart'),
  btnStop: $('btnStop'),
  btnView: $('btnView'),
  arOff: $('arOff'),
  arOn: $('arOn'),
  delay: $('delay'),
  host: $('host'),
  port: $('port'),
  version: $('version'),
  username: $('username'),
  usernameLabel: $('usernameLabel'),
  auth: $('auth'),
  autologinTag: $('autologinTag'),
  loginPassword: $('loginPassword'),
  joinCommands: $('joinCommands'),
  console: $('console'),
  chat: $('chat'),
  chatForm: $('chatForm'),
  chatInput: $('chatInput'),
  chatSend: $('chatSend'),
  clearConsole: $('clearConsole'),
  clearChat: $('clearChat'),
  openLogs: $('openLogs'),
};

const STATE_TITLES = {
  offline: 'Не в сети',
  connecting: 'Подключение…',
  connected: 'Подключен',
  online: 'В сети',
  reconnecting: 'Переподключение…',
};

const LEVELS = ['info', 'ok', 'warn', 'error', 'kick'];
const MAX_LINES = 1000;
const MAX_HISTORY = 50;
const SETTINGS_FIELDS = [el.host, el.port, el.version, el.username, el.auth];

let state = 'offline';
let lastConsoleLine = null;
const history = []; // отправленные сообщения, листаются стрелками ↑/↓
let historyPos = 0;

// ---------- вывод строк ----------

const pad = (n) => String(n).padStart(2, '0');

function clock(ms) {
  const d = new Date(ms || Date.now());
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeRow(time, extraClass) {
  const row = document.createElement('div');
  row.className = `line ${extraClass}`;
  const ts = document.createElement('span');
  ts.className = 'ts';
  ts.textContent = clock(time);
  const tx = document.createElement('span');
  tx.className = 'tx';
  row.append(ts, tx);
  return { row, ts, tx };
}

function pushRow(box, row) {
  // Прокручиваем вниз только если пользователь и так был внизу.
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.appendChild(row);
  while (box.childElementCount > MAX_LINES) box.firstElementChild.remove();
  if (stick) box.scrollTop = box.scrollHeight;
}

// ---------- ссылки: кликабельные, открываются во внешнем браузере ----------

const LINK_RE = /https?:\/\/[^\s"'<>\\`{}|^]+/gi;
const LINK_TAIL_RE = /[.,;:!?)\]}»”’'"]+$/;

function makeLink(url) {
  const a = document.createElement('a');
  a.className = 'ext-link';
  a.href = url;
  a.target = '_blank'; // главный процесс откроет её в браузере, не в панели
  a.rel = 'noopener noreferrer';
  a.title = 'Открыть в браузере';
  a.textContent = url;
  return a;
}

/** Пишет текст в target, превращая http(s)-адреса в ссылки. */
function appendLinkified(target, text) {
  const s = String(text || '');
  let pos = 0;
  for (const m of s.matchAll(LINK_RE)) {
    const url = m[0].replace(LINK_TAIL_RE, '');
    if (m.index > pos) target.appendChild(document.createTextNode(s.slice(pos, m.index)));
    target.appendChild(makeLink(url));
    pos = m.index + url.length;
  }
  if (pos < s.length) target.appendChild(document.createTextNode(s.slice(pos)));
}

function addConsole({ time, level, text }) {
  const lv = LEVELS.includes(level) ? level : 'info';

  // Одинаковые подряд идущие строки сворачиваем в «×N» (время — последнего повтора).
  const last = lastConsoleLine;
  if (last && last.level === lv && last.text === text && el.console.lastElementChild === last.row) {
    last.count += 1;
    last.cnt.textContent = `×${last.count}`;
    last.ts.textContent = clock(time);
    return;
  }

  const { row, ts, tx } = makeRow(time, `lv-${lv}`);
  appendLinkified(tx, text);
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  row.appendChild(cnt);
  pushRow(el.console, row);
  lastConsoleLine = { level: lv, text, row, ts, cnt, count: 1 };
}

function renderMotd(target, motd) {
  for (const seg of parseMotd(motd)) {
    const span = document.createElement('span');
    appendLinkified(span, seg.text);
    if (seg.color) span.style.color = seg.color;
    if (seg.bold) span.style.fontWeight = '700';
    if (seg.italic) span.style.fontStyle = 'italic';
    const deco = [];
    if (seg.underline) deco.push('underline');
    if (seg.strike) deco.push('line-through');
    if (deco.length) span.style.textDecoration = deco.join(' ');
    target.appendChild(span);
  }
}

function addChat({ time, text, motd, position, links }) {
  if (position === 'self') {
    // Команда, отправленная из панели: показываем как есть, без разбора цветов.
    const { row, tx } = makeRow(time, 'chat-line chat-self');
    tx.textContent = text || '';
    pushRow(el.chat, row);
    return;
  }
  const { row, tx } = makeRow(time, 'chat-line');
  renderMotd(tx, motd || text || '');
  // Ссылки, спрятанные за кликабельным текстом («[Нажми сюда]»), показываем рядом с сообщением.
  const visible = String(text || '');
  for (const url of Array.isArray(links) ? links : []) {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || visible.includes(url)) continue;
    const hidden = document.createElement('span');
    hidden.className = 'hidden-link';
    hidden.append(' 🔗 ', makeLink(url));
    tx.appendChild(hidden);
  }
  pushRow(el.chat, row);
}

// ---------- состояние и форма ----------

function applyState(next) {
  state = STATE_TITLES[next] ? next : 'offline';
  const idle = state === 'offline';
  const canChat = state === 'connected' || state === 'online';
  el.lamp.dataset.state = state;
  el.statusText.textContent = STATE_TITLES[state];
  el.btnStart.disabled = !idle;
  el.btnStop.disabled = idle;
  for (const field of SETTINGS_FIELDS) field.disabled = !idle;
  el.chatInput.disabled = !canChat;
  el.chatSend.disabled = !canChat;
  el.chatInput.placeholder = canChat
    ? 'Сообщение, команда серверу (/…) или боту (#помощь), Enter — отправить'
    : 'Бот не в сети';
}

function setAutoReconnectUi(on) {
  el.arOn.classList.toggle('is-on', on);
  el.arOff.classList.toggle('is-on', !on);
  el.arOn.setAttribute('aria-pressed', String(on));
  el.arOff.setAttribute('aria-pressed', String(!on));
}

function updateLabels() {
  const microsoft = el.auth.value === 'microsoft';
  el.usernameLabel.textContent = microsoft ? 'Почта Microsoft' : 'Ник бота';
  el.username.placeholder = microsoft ? 'name@outlook.com' : 'латиница, 3–16 символов';
  el.statusSub.textContent = `${el.username.value || '—'} · ${el.host.value || '—'}:${el.port.value || '—'}`;
}

function updateAutologinTag() {
  el.autologinTag.hidden = !(el.loginPassword.value || el.joinCommands.value.trim());
}

function fillForm(cfg) {
  el.host.value = cfg.host;
  el.port.value = cfg.port;
  el.version.value = cfg.version;
  el.username.value = cfg.username;
  el.auth.value = cfg.auth;
  el.delay.value = cfg.reconnectDelay;
  el.loginPassword.value = cfg.loginPassword || '';
  el.joinCommands.value = cfg.joinCommands || '';
  setAutoReconnectUi(cfg.autoReconnect);
  updateLabels();
  updateAutologinTag();
}

function readForm() {
  return {
    host: el.host.value,
    port: el.port.value,
    version: el.version.value,
    username: el.username.value,
    auth: el.auth.value,
  };
}

// ---------- обработчики ----------

el.btnStart.addEventListener('click', async () => {
  el.btnStart.disabled = true; // защита от двойного клика
  try {
    const res = await bridge.start(readForm());
    if (res && res.config) fillForm(res.config);
  } finally {
    applyState(state); // вернёт кнопку, если запуск не удался (например, не указан ник)
  }
});

el.btnStop.addEventListener('click', () => {
  bridge.stop();
});

// «Экран бота» доступен всегда: если бот не в сети, окно экрана само это покажет.
el.btnView.addEventListener('click', async () => {
  el.btnView.disabled = true; // пока окно открывается (защита от двойного клика)
  try {
    await bridge.openViewer(); // ошибки открытия main.js сам пишет в консоль
  } catch (err) {
    addConsole({ time: Date.now(), level: 'error', text: `Не удалось открыть экран бота: ${err && err.message ? err.message : err}` });
  } finally {
    el.btnView.disabled = false;
  }
});

el.arOff.addEventListener('click', async () => setAutoReconnectUi(await bridge.setAutoReconnect(false)));
el.arOn.addEventListener('click', async () => setAutoReconnectUi(await bridge.setAutoReconnect(true)));

el.delay.addEventListener('change', async () => {
  const cfg = await bridge.saveConfig({ reconnectDelay: el.delay.value });
  el.delay.value = cfg.reconnectDelay; // неверное значение вернётся к последнему корректному
});

// Настройки подключения сохраняются сразу, не только по «Старт».
for (const field of SETTINGS_FIELDS) {
  field.addEventListener('change', async () => {
    const cfg = await bridge.saveConfig(readForm());
    fillForm(cfg);
  });
}
el.auth.addEventListener('input', updateLabels);
el.username.addEventListener('input', updateLabels);

for (const field of [el.loginPassword, el.joinCommands]) {
  field.addEventListener('input', updateAutologinTag);
  field.addEventListener('change', () => {
    bridge.saveConfig({ loginPassword: el.loginPassword.value, joinCommands: el.joinCommands.value });
  });
}

el.chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text || el.chatInput.disabled) return;
  const sent = await bridge.say(text);
  if (!sent) return; // причина уже в консоли, текст остаётся в поле
  if (history[history.length - 1] !== text) history.push(text);
  if (history.length > MAX_HISTORY) history.shift();
  historyPos = history.length;
  el.chatInput.value = '';
});

el.chatInput.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
  if (!history.length) return;
  event.preventDefault();
  historyPos += event.key === 'ArrowUp' ? -1 : 1;
  historyPos = Math.max(0, Math.min(history.length, historyPos));
  el.chatInput.value = history[historyPos] || '';
});

el.clearConsole.addEventListener('click', () => {
  el.console.replaceChildren();
  lastConsoleLine = null;
});

el.clearChat.addEventListener('click', () => el.chat.replaceChildren());

el.openLogs.addEventListener('click', () => bridge.openLogs());

bridge.onLog(addConsole);
bridge.onChat(addChat);
bridge.onState(applyState);

bridge.init().then(({ config, state: current }) => {
  fillForm(config);
  applyState(current);
});
