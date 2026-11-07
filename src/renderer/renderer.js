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
  auth: $('auth'),
  botsTag: $('botsTag'),
  accounts: $('accounts'),
  accountsLabel: $('accountsLabel'),
  startInterval: $('startInterval'),
  viewDistance: $('viewDistance'),
  botsPerProcess: $('botsPerProcess'),
  autologinTag: $('autologinTag'),
  loginPassword: $('loginPassword'),
  showPassword: $('showPassword'),
  joinCommands: $('joinCommands'),
  guardTag: $('guardTag'),
  guardOn: $('guardOn'),
  godOn: $('godOn'),
  liveBg: $('liveBg'),
  taskTag: $('taskTag'),
  taskSteps: $('taskSteps'),
  taskTarget: $('taskTarget'),
  taskRepeat: $('taskRepeat'),
  taskAdd: $('taskAdd'),
  taskStatus: $('taskStatus'),
  taskList: $('taskList'),
  taskTools: $('taskTools'),
  taskPauseAll: $('taskPauseAll'),
  taskResumeAll: $('taskResumeAll'),
  whitelist: $('whitelist'),
  questTag: $('questTag'),
  questToggle: $('questToggle'),
  questStatus: $('questStatus'),
  questLevels: $('questLevels'),
  questNeeds: $('questNeeds'),
  questNeedsList: $('questNeedsList'),
  questCheckNow: $('questCheckNow'),
  questSettings: $('questSettings'),
  questSetupTag: $('questSetupTag'),
  questStorage: $('questStorage'),
  questRewards: $('questRewards'),
  questMobHomes: $('questMobHomes'),
  questFarm: $('questFarm'),
  questPen: $('questPen'),
  questTogether: $('questTogether'),
  questPause: $('questPause'),
  aiTag: $('aiTag'),
  aiTask: $('aiTask'),
  aiRun: $('aiRun'),
  aiStop: $('aiStop'),
  aiResult: $('aiResult'),
  aiSettings: $('aiSettings'),
  aiSetupTag: $('aiSetupTag'),
  aiProvider: $('aiProvider'),
  ollamaFields: $('ollamaFields'),
  ollamaStatus: $('ollamaStatus'),
  getOllama: $('getOllama'),
  ollamaModel: $('ollamaModel'),
  ollamaModels: $('ollamaModels'),
  ollamaUrl: $('ollamaUrl'),
  ollamaGpu: $('ollamaGpu'),
  openaiFields: $('openaiFields'),
  aiKey: $('aiKey'),
  showAiKey: $('showAiKey'),
  aiModel: $('aiModel'),
  aiModels: $('aiModels'),
  aiBaseUrl: $('aiBaseUrl'),
  botList: $('botList'),
  botsCount: $('botsCount'),
  console: $('console'),
  onlySelected: $('onlySelected'),
  clearConsole: $('clearConsole'),
  chat: $('chat'),
  chatWho: $('chatWho'),
  botStart: $('botStart'),
  botStop: $('botStop'),
  openLogs: $('openLogs'),
  clearChat: $('clearChat'),
  chatForm: $('chatForm'),
  chatInput: $('chatInput'),
  sendMode: $('sendMode'),
  chatSend: $('chatSend'),
};

const STATE_TITLES = {
  offline: 'Не в сети',
  queued: 'В очереди на вход',
  connecting: 'Подключение…',
  connected: 'Подключен',
  online: 'В сети',
  reconnecting: 'Переподключение…',
};

const LEVELS = ['info', 'ok', 'warn', 'error', 'kick'];
const MAX_LINES = 1000;
const MAX_HISTORY = 50;
// Сервер, версию и способ входа не меняем, пока боты работают: их переподключения ушли бы уже по-новому.
const CONNECTION_FIELDS = [el.host, el.port, el.version, el.auth];
const LIST_FIELDS = [el.startInterval, el.viewDistance, el.botsPerProcess];

const bots = new Map(); // номер → { bot, nick, state, chip, dot }
let selected = null; // чей чат показан и кому уходит сообщение
let summary = { total: 0, online: 0, connected: 0, connecting: 0, queued: 0, reconnecting: 0, offline: 0 };
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

// ---------- консоль: строки всех ботов (с ником), можно оставить только выбранного ----------

const hiddenByFilter = (row) => el.onlySelected.checked && Boolean(row.dataset.bot) && row.dataset.bot !== selected;

// Метка у строки консоли: кто её написал, кроме бота и панели.
const SOURCE_TAGS = { ai: ['ИИ', 'ИИ-помощник'], quests: ['Авто', 'Автопилот заданий'], tasks: ['Задача', 'Задачи ботам'] };

function addConsole({ bot = null, nick = null, source = null, time, level, text }) {
  const lv = LEVELS.includes(level) ? level : 'info';

  // Одинаковые подряд идущие строки одного бота сворачиваем в «×N» (время — последнего повтора).
  const last = lastConsoleLine;
  if (last && last.level === lv && last.text === text && last.bot === (bot || null) && last.source === (source || null) && el.console.lastElementChild === last.row) {
    last.count += 1;
    last.cnt.textContent = `×${last.count}`;
    last.ts.textContent = clock(time);
    return;
  }

  const { row, ts, tx } = makeRow(time, `lv-${lv}`);
  row.dataset.bot = bot || '';
  if (SOURCE_TAGS[source]) {
    const tag = document.createElement('span');
    tag.className = 'ai-tag';
    [tag.textContent, tag.title] = SOURCE_TAGS[source];
    tx.append(tag, ' ');
  }
  if (nick) {
    const tag = document.createElement('span');
    tag.className = 'who-tag';
    tag.dataset.bot = bot;
    tag.title = 'Выбрать этого бота';
    tag.textContent = nick;
    tx.append(tag, ' ');
  }
  appendLinkified(tx, text);
  const cnt = document.createElement('span');
  cnt.className = 'cnt';
  row.appendChild(cnt);
  row.hidden = hiddenByFilter(row);
  pushRow(el.console, row);
  lastConsoleLine = { level: lv, text, bot: bot || null, source: source || null, row, ts, cnt, count: 1 };
}

function applyConsoleFilter() {
  for (const row of el.console.children) row.hidden = hiddenByFilter(row);
  el.console.scrollTop = el.console.scrollHeight;
}

// ---------- чат выбранного бота ----------

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

function addChat({ bot, time, text, motd, position, links }) {
  if (bot && bot !== selected) return; // чат другого бота (пришёл, пока переключались)
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

function renderChatHistory(list) {
  el.chat.replaceChildren();
  for (const msg of Array.isArray(list) ? list : []) addChat(msg);
  el.chat.scrollTop = el.chat.scrollHeight;
}

// ---------- список ботов ----------

const stateTitle = (state) => STATE_TITLES[state] || state || '';
const inGame = (b) => b.state === 'online' || b.state === 'connected';
// Пинг бота, как его считает сервер (то же число, что у игроков в Tab); не в сети — не показываем.
const pingOf = (b) => (inGame(b) && Number.isFinite(b.ping) ? b.ping : null);
const chipTitle = (b) => `${b.nick} — ${stateTitle(b.state)}${pingOf(b) === null ? '' : `, пинг ${pingOf(b)} мс (так его считает сервер)`}`;

function showPing(b) {
  const ping = pingOf(b);
  b.pingEl.textContent = ping === null ? '' : String(ping);
  b.pingEl.classList.toggle('slow', ping !== null && ping >= 150 && ping < 300);
  b.pingEl.classList.toggle('bad', ping !== null && ping >= 300);
  b.chip.title = chipTitle(b);
}

function renderList(list, sel) {
  bots.clear();
  const chips = [];
  for (const item of Array.isArray(list) ? list : []) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'bot';
    chip.dataset.bot = item.bot;
    chip.dataset.state = item.state;
    chip.setAttribute('role', 'option');
    const dot = document.createElement('i');
    dot.className = 'dot';
    dot.dataset.state = item.state;
    const name = document.createElement('span');
    name.className = 'nick';
    name.textContent = item.nick;
    const pingEl = document.createElement('span');
    pingEl.className = 'ping';
    chip.append(dot, name, pingEl);
    const b = { bot: item.bot, nick: item.nick, state: item.state, ping: item.ping, chip, dot, pingEl };
    showPing(b);
    bots.set(item.bot, b);
    chips.push(chip);
  }
  el.botList.replaceChildren(...chips);
  setSelected(sel);
}

function setSelected(id) {
  selected = id && bots.has(id) ? id : null;
  for (const b of bots.values()) {
    const on = b.bot === selected;
    b.chip.classList.toggle('is-selected', on);
    b.chip.setAttribute('aria-selected', String(on));
  }
  updateSelectedUi();
  applyConsoleFilter();
  renderTasks(taskItems); // сначала — задачи выбранного бота
}

async function choose(id) {
  if (!id || !bots.has(id)) return;
  const r = await bridge.select(id);
  setSelected(r && r.selected);
  renderChatHistory(r && r.chat);
}

function updateBot({ bot, state }) {
  const b = bots.get(bot);
  if (!b) return;
  b.state = state;
  b.chip.dataset.state = state;
  b.dot.dataset.state = state;
  showPing(b);
  if (bot === selected) updateSelectedUi();
}

function updatePing({ bot, ping }) {
  const b = bots.get(bot);
  if (!b) return;
  b.ping = ping;
  showPing(b);
  if (bot === selected) updateSelectedUi();
}

/** Шапка чата, кнопки выбранного бота и строка ввода. */
function updateSelectedUi() {
  const b = bots.get(selected);
  const ping = b ? pingOf(b) : null;
  el.chatWho.textContent = b ? `${b.nick} · ${stateTitle(b.state)}${ping === null ? '' : ` · пинг ${ping} мс`}` : '— выбери бота в списке';
  el.botStart.disabled = !b || b.state !== 'offline';
  el.botStop.disabled = !b || b.state === 'offline';
  const mode = el.sendMode.value;
  const canOne = Boolean(b) && (b.state === 'online' || b.state === 'connected');
  const canAll = summary.online + summary.connected > 0;
  const can = mode === 'one' ? canOne : canAll;
  el.chatInput.disabled = !can;
  el.chatSend.disabled = !can;
  if (mode === 'all') el.chatInput.placeholder = canAll ? 'Команда всем ботам в сети сразу: /… серверу или #… боту' : 'Ни одного бота в сети';
  else if (mode === 'turn') el.chatInput.placeholder = canAll ? 'Всем по очереди: сообщение, /… серверу (через 2 с друг за другом) или #… боту (когда закончит предыдущий)' : 'Ни одного бота в сети';
  else if (canOne) el.chatInput.placeholder = 'Сообщение, команда серверу (/…) или боту (#помощь), Enter — отправить';
  else el.chatInput.placeholder = b ? 'Бот не в сети' : 'Выбери бота в списке';
}

/** Сводка по всем ботам: лампа, «В сети: N из M», общие кнопки. */
function applySummary(s) {
  summary = { ...summary, ...(s || {}) };
  const busy = summary.connecting + summary.connected + summary.queued;
  const running = summary.total - summary.offline;
  let lamp = 'offline';
  if (summary.online) lamp = 'online';
  else if (busy) lamp = 'connecting';
  else if (summary.reconnecting) lamp = 'reconnecting';
  el.lamp.dataset.state = lamp;
  el.statusText.textContent = summary.total ? `В сети: ${summary.online} из ${summary.total}` : 'Нет ботов';
  const parts = [];
  if (summary.queued) parts.push(`в очереди ${summary.queued}`);
  if (summary.connecting + summary.connected) parts.push(`входят ${summary.connecting + summary.connected}`);
  if (summary.reconnecting) parts.push(`переподключаются ${summary.reconnecting}`);
  if (summary.total && summary.offline) parts.push(`не в сети ${summary.offline}`);
  parts.push(`${el.host.value || '—'}:${el.port.value || '—'}`);
  el.statusSub.textContent = parts.join(' · ');
  el.botsCount.textContent = summary.total ? `${summary.online} / ${summary.total} в сети` : '';
  el.btnStart.disabled = !summary.offline;
  el.btnStop.disabled = running === 0;
  for (const field of CONNECTION_FIELDS) field.disabled = running > 0;
  updateSelectedUi();
}

// ---------- форма настроек ----------

function setAutoReconnectUi(on) {
  el.arOn.classList.toggle('is-on', on);
  el.arOff.classList.toggle('is-on', !on);
  el.arOn.setAttribute('aria-pressed', String(on));
  el.arOff.setAttribute('aria-pressed', String(!on));
}

/** Строки поля «Боты», которые станут ботами (без пустых и «#…»). */
function accountLines() {
  return el.accounts.value.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#') && !s.startsWith('//'));
}

function updateBotsTag() {
  const n = accountLines().length;
  el.botsTag.textContent = String(n);
  el.botsTag.hidden = n === 0;
}

function updateLabels() {
  const microsoft = el.auth.value === 'microsoft';
  el.accountsLabel.textContent = microsoft ? 'Почта Microsoft — по одной в строке' : 'Ник или ник:пароль — по одному в строке';
  applySummary(null);
}

function updateAutologinTag() {
  el.autologinTag.hidden = !(el.loginPassword.value || el.joinCommands.value.trim());
}

/** Ники белого списка (как их читает бот: через перенос строки, запятую или пробел). */
function whitelistCount() {
  return new Set(el.whitelist.value.split(/[\s,;]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)).size;
}

function updateGuardTag() {
  const on = el.guardOn.checked;
  el.guardTag.textContent = on ? 'вкл' : el.godOn.checked ? '/god' : '';
  el.guardTag.title = on ? `Охрана включена, в белом списке: ${whitelistCount()} (и все боты из списка)` : '';
  el.guardTag.hidden = !on && !el.godOn.checked;
}

function fillForm(cfg) {
  el.host.value = cfg.host;
  el.port.value = cfg.port;
  el.version.value = cfg.version;
  el.auth.value = cfg.auth;
  el.delay.value = cfg.reconnectDelay;
  // Поля, которые человек сейчас правит, не трогаем (иначе прыгнет курсор).
  if (document.activeElement !== el.accounts) el.accounts.value = cfg.accounts || '';
  el.startInterval.value = cfg.startInterval;
  el.viewDistance.value = cfg.viewDistance;
  el.botsPerProcess.value = cfg.botsPerProcess;
  el.loginPassword.value = cfg.loginPassword || '';
  el.joinCommands.value = cfg.joinCommands || '';
  el.guardOn.checked = cfg.guard !== false;
  el.godOn.checked = cfg.godMode !== false;
  el.liveBg.checked = cfg.liveBackground !== false;
  applyLiveBackground();
  if (document.activeElement !== el.whitelist) el.whitelist.value = cfg.whitelist || '';
  for (const key of ['aiKey', 'aiModel', 'aiBaseUrl', 'ollamaModel', 'ollamaUrl']) {
    if (document.activeElement !== el[key]) el[key].value = cfg[key] || '';
  }
  el.aiProvider.value = cfg.aiProvider === 'openai' ? 'openai' : 'ollama';
  el.ollamaGpu.checked = cfg.ollamaGpu !== false;
  for (const key of ['questStorage', 'questRewards', 'questFarm', 'questPen', 'questMobHomes', 'questTogether', 'questPause']) {
    if (document.activeElement !== el[key]) el[key].value = cfg[key] === undefined || cfg[key] === null ? '' : cfg[key];
  }
  updateQuestSetupTag();
  setAutoReconnectUi(cfg.autoReconnect);
  updateLabels();
  updateBotsTag();
  updateAutologinTag();
  updateGuardTag();
  updateAiProviderUi();
}

// ---------- автопилот заданий ----------

let questState = null; // последнее состояние автопилота (QuestAutopilot.status)

const readQuestForm = () => ({
  questStorage: el.questStorage.value,
  questRewards: el.questRewards.value,
  questFarm: el.questFarm.value,
  questPen: el.questPen.value,
  questMobHomes: el.questMobHomes.value,
  questTogether: el.questTogether.value,
  questPause: el.questPause.value,
});

/** Без склада автопилот возьмёт задания и купит «Купите…», а «Передайте…» приносить будет неоткуда. */
function updateQuestSetupTag() {
  el.questSetupTag.hidden = Boolean(el.questStorage.value.trim());
}

const fmtWait = (sec) => (sec >= 90 ? `${Math.round(sec / 60)} мин` : `${Math.max(1, Math.round(sec))} с`);

function renderQuests(s) {
  if (!s) return;
  questState = s;
  el.questToggle.textContent = s.running ? 'Выключить автопилот' : 'Включить автопилот';
  el.questToggle.classList.toggle('on', s.running);
  let tag = '';
  let kind = '';
  let text;
  if (!s.running) {
    text = 'Выключен. Включи — и боты в сети сами пойдут по заданиям NPC.';
  } else if (s.paused) {
    tag = 'пауза';
    kind = 'warn';
    text = `Пауза: ${s.paused} — продолжу сам.`;
  } else if (!s.online) {
    tag = 'ждёт ботов';
    kind = 'warn';
    text = 'Включён, но в сети ни одного бота — нажми «Старт всех».';
  } else {
    tag = 'работает';
    kind = 'ok';
    const now = s.current.map((c) => `${c.nick}${c.npc ? ` — ${c.npc}` : ''}: ${c.what}`);
    text = `Работает, ботов в сети: ${s.online}.`;
    if (now.length) text += `\nСейчас: ${now.join('; ')}`;
    else if (s.nextInSec) text += `\nВсе проверены — следующая проверка через ${fmtWait(s.nextInSec)}.`;
  }
  el.questStatus.textContent = text;
  el.questStatus.className = `ai-status ${kind}`;
  el.questTag.textContent = tag;
  el.questTag.className = `tag${kind === 'warn' ? ' warn' : kind === 'ok' ? ' busy' : ''}`;
  el.questTag.hidden = !tag;
  // Уровни NPC у ботов — когда автопилот хоть кого-то уже видел.
  const levels = s.levels || [];
  el.questLevels.textContent = levels.join('\n');
  el.questLevels.hidden = !levels.length || levels.every((l) => /^[^:]+: не смотрели — \d+$/.test(l));
  el.questNeedsList.replaceChildren(...(s.needs || []).map((t) => {
    const li = document.createElement('li');
    li.textContent = t;
    return li;
  }));
  el.questNeeds.hidden = !(s.needs && s.needs.length);
}

// ---------- ИИ-помощник ----------

const AI_LOCAL_RE =/^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])/i; // ИИ на своём ПК — без ключа
const AI_STATUS_POLL_MS = 15000; // Ollama ещё не готова — проверять, не установили ли её
let aiRunning = false;
let aiModelsLoaded = false; // подсказка моделей интернет-сервиса
let aiStatus = null; // последний ответ ai:status
let aiStatusBusy = false;

const readAiForm = () => ({
  aiProvider: el.aiProvider.value,
  ollamaModel: el.ollamaModel.value,
  ollamaUrl: el.ollamaUrl.value,
  ollamaGpu: el.ollamaGpu.checked,
  aiKey: el.aiKey.value,
  aiModel: el.aiModel.value,
  aiBaseUrl: el.aiBaseUrl.value,
});

const usesOllama = () => el.aiProvider.value !== 'openai';

/** Поля выбранного сервиса; метка у «Модель и сервис»: чего не хватает. */
function updateAiProviderUi() {
  el.ollamaFields.hidden = !usesOllama();
  el.openaiFields.hidden = usesOllama();
  updateAiSetupTag();
}

function updateAiSetupTag() {
  let tag = '';
  if (!usesOllama()) {
    if (!el.aiKey.value.trim() && !AI_LOCAL_RE.test(el.aiBaseUrl.value.trim())) tag = 'нужен ключ';
  } else if (aiStatus && aiStatus.ok && aiStatus.provider === 'ollama' && !aiStatus.running && aiStatus.local && !aiStatus.installed) {
    tag = 'нужна Ollama';
  }
  el.aiSetupTag.textContent = tag;
  el.aiSetupTag.hidden = !tag;
  if (tag) el.aiSettings.open = true; // чего не хватает — сразу видно
}

function fillDatalist(list, names) {
  list.replaceChildren(...names.map((id) => {
    const o = document.createElement('option');
    o.value = id;
    return o;
  }));
}

/** Состояние Ollama — строкой над полями (и кнопка «Скачать Ollama», если её нет). */
function showOllamaStatus(s) {
  let text = '';
  let kind = '';
  let install = false;
  if (s && s.ok && s.provider === 'ollama') {
    if (typeof s.gpu === 'boolean') el.ollamaGpu.checked = s.gpu; // панель могла выключить видеокарту сама
    if (s.running && s.hasModel) {
      text = `Ollama ${s.version} работает, модель ${s.model} скачана — всё готово.${s.gpu ? '' : ' Считает на процессоре.'}`;
      kind = 'ok';
    } else if (s.running) {
      text = `Ollama ${s.version} работает. Модели ${s.model} ещё нет — панель скачает её сама при первом задании (один раз).`;
      kind = 'warn';
    } else if (!s.local) {
      text = `Ollama по адресу ${s.url} не отвечает — проверь, что она запущена на том ПК.`;
      kind = 'warn';
    } else if (s.installed) {
      text = 'Ollama установлена, но не запущена — панель запустит её сама при задании.';
      kind = 'warn';
    } else {
      text = 'Ollama не установлена. Нажми «Скачать Ollama», установи её (как обычную программу) и возвращайся — модель панель скачает сама.';
      kind = 'warn';
      install = true;
    }
    if (Array.isArray(s.models)) fillDatalist(el.ollamaModels, [...new Set([...s.models, 'qwen3:4b-instruct'])]);
  }
  el.ollamaStatus.textContent = text;
  el.ollamaStatus.className = `ai-status ${kind}`;
  el.getOllama.hidden = !install;
}

/** Спросить у панели, готов ли ИИ (Ollama запущена? модель скачана?). */
async function refreshAiStatus() {
  if (aiStatusBusy) return;
  aiStatusBusy = true;
  try {
    aiStatus = await bridge.aiStatus();
  } catch (_) {
    aiStatus = null;
  } finally {
    aiStatusBusy = false;
  }
  showOllamaStatus(aiStatus);
  updateAiSetupTag();
}

const aiReady = () => Boolean(aiStatus && aiStatus.ok && (aiStatus.provider !== 'ollama' || (aiStatus.running && aiStatus.hasModel)));

function showAiResult(text, kind) {
  el.aiResult.textContent = text;
  el.aiResult.className = `ai-result ${kind}`;
  el.aiResult.hidden = !text;
}

function setAiRunning(on) {
  aiRunning = Boolean(on);
  el.aiRun.disabled = aiRunning;
  el.aiStop.disabled = !aiRunning;
  el.aiTag.textContent = aiRunning ? 'работает…' : '';
  el.aiTag.className = 'tag busy';
  el.aiTag.hidden = !aiRunning;
}

async function runAi() {
  const task = el.aiTask.value.trim();
  if (aiRunning) return;
  if (!task) {
    showAiResult('Напиши задание словами, например: «Сколько ботов в сети?»', 'warn');
    el.aiTask.focus();
    return;
  }
  el.aiRun.disabled = true; // защита от двойного клика
  const r = await bridge.aiRun(task, readAiForm());
  if (r && r.ok) {
    setAiRunning(true);
    showAiResult('Работаю… шаги — в консоли с меткой «ИИ»', 'busy');
  } else {
    el.aiRun.disabled = aiRunning;
    showAiResult(`Не начато: ${(r && r.error) || 'неизвестная ошибка'}`, 'error');
    updateAiSetupTag();
  }
}

/** Подсказка в поле «Модель» интернет-сервиса: бесплатные модели, которые умеют вызывать инструменты. */
async function loadAiModels() {
  if (aiModelsLoaded) return;
  aiModelsLoaded = true;
  const r = await bridge.aiModels(readAiForm());
  if (!r || !r.ok) {
    aiModelsLoaded = false; // попробуем в следующий раз
    return;
  }
  fillDatalist(el.aiModels, r.models);
}

function readForm() {
  return {
    host: el.host.value,
    port: el.port.value,
    version: el.version.value,
    auth: el.auth.value,
    accounts: el.accounts.value,
    startInterval: el.startInterval.value,
    viewDistance: el.viewDistance.value,
    botsPerProcess: el.botsPerProcess.value,
  };
}

// ---------- обработчики ----------

el.btnStart.addEventListener('click', async () => {
  el.btnStart.disabled = true; // защита от двойного клика
  try {
    const res = await bridge.start(null, readForm());
    if (res && res.config) fillForm(res.config);
  } finally {
    applySummary(null); // вернёт кнопку, если запуск не удался (например, неверный ник в списке)
  }
});

el.btnStop.addEventListener('click', () => {
  bridge.stop(null);
});

el.botStart.addEventListener('click', async () => {
  if (!selected) return;
  el.botStart.disabled = true;
  try {
    const res = await bridge.start([selected], readForm());
    if (res && res.config) fillForm(res.config);
  } finally {
    updateSelectedUi();
  }
});

el.botStop.addEventListener('click', () => {
  if (selected) bridge.stop([selected]);
});

el.botList.addEventListener('click', (event) => {
  const chip = event.target.closest('.bot');
  if (chip) choose(chip.dataset.bot);
});

// Ник в строке консоли — выбрать этого бота.
el.console.addEventListener('click', (event) => {
  const tag = event.target.closest('.who-tag');
  if (tag) choose(tag.dataset.bot);
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

// Настройки сохраняются сразу, не только по «Старт».
for (const field of [...CONNECTION_FIELDS, ...LIST_FIELDS]) {
  field.addEventListener('change', async () => {
    const cfg = await bridge.saveConfig(readForm());
    fillForm(cfg);
  });
}
el.auth.addEventListener('input', updateLabels);
el.host.addEventListener('input', () => applySummary(null));

// Список ботов — когда человек закончил править (ушёл из поля): иначе недописанный ник уже стал бы ботом.
el.accounts.addEventListener('input', updateBotsTag);
el.accounts.addEventListener('change', async () => {
  const cfg = await bridge.saveConfig({ accounts: el.accounts.value });
  fillForm(cfg);
});

for (const field of [el.loginPassword, el.joinCommands]) {
  field.addEventListener('input', updateAutologinTag);
  field.addEventListener('change', () => {
    bridge.saveConfig({ loginPassword: el.loginPassword.value, joinCommands: el.joinCommands.value });
  });
}

// «Глазок»: показать пароль, чтобы видеть, что пишешь.
el.showPassword.addEventListener('click', () => {
  const show = el.loginPassword.type === 'password';
  el.loginPassword.type = show ? 'text' : 'password';
  el.showPassword.setAttribute('aria-pressed', String(show));
  const label = show ? 'Скрыть пароль' : 'Показать пароль';
  el.showPassword.title = label;
  el.showPassword.setAttribute('aria-label', label);
});

el.guardOn.addEventListener('change', () => {
  updateGuardTag();
  bridge.saveConfig({ guard: el.guardOn.checked });
});
el.godOn.addEventListener('change', () => {
  updateGuardTag();
  bridge.saveConfig({ godMode: el.godOn.checked });
});

// Живой фон «Вороны» (background.js): галочка «Живой фон» в «Вид».
function applyLiveBackground() {
  if (window.liveBackground) window.liveBackground.setEnabled(el.liveBg.checked);
}
el.liveBg.addEventListener('change', () => {
  applyLiveBackground();
  bridge.saveConfig({ liveBackground: el.liveBg.checked });
});

// Белый список уходит ботам прямо во время набора (с небольшой паузой), перезапуск не нужен.
let whitelistTimer = null;
const saveWhitelist = () => {
  clearTimeout(whitelistTimer);
  whitelistTimer = null;
  bridge.saveConfig({ whitelist: el.whitelist.value });
};
el.whitelist.addEventListener('input', () => {
  updateGuardTag();
  clearTimeout(whitelistTimer);
  whitelistTimer = setTimeout(saveWhitelist, 400);
});
el.whitelist.addEventListener('change', saveWhitelist);

el.questToggle.addEventListener('click', async () => {
  el.questToggle.disabled = true; // выключение ждёт, пока боты бросят начатое
  try {
    const on = !(questState && questState.running);
    if (on && !el.questStorage.value.trim()) el.questSettings.open = true; // где задать склад — сразу видно
    renderQuests(await bridge.questsToggle(on, readQuestForm()));
  } finally {
    el.questToggle.disabled = false;
  }
});
el.questCheckNow.addEventListener('click', async () => renderQuests(await bridge.questsCheckNow()));
for (const field of [el.questStorage, el.questRewards, el.questFarm, el.questPen, el.questMobHomes, el.questTogether, el.questPause]) {
  field.addEventListener('change', async () => fillForm(await bridge.saveConfig(readQuestForm())));
}
el.questStorage.addEventListener('input', updateQuestSetupTag);
bridge.onQuestsStatus(renderQuests);

// ---------- задачи ботам (src/tasks.js) ----------

let taskItems = [];
const TASK_ROWS = 12; // строк в списке — не больше (у 70 ботов задач много: остальные — числом)

function taskRow(t) {
  const row = document.createElement('div');
  row.className = 'task';
  row.dataset.state = t.state;
  const head = document.createElement('div');
  head.className = 'task-head';
  const state = document.createElement('span');
  state.className = 'task-state';
  state.textContent = t.stateText;
  const who = document.createElement('span');
  who.className = 'task-who';
  who.textContent = t.nick;
  const step = document.createElement('span');
  step.className = 'task-step';
  step.textContent = `шаг ${t.step}/${t.total}${t.repeat ? ` · круг ${t.rounds + 1}` : ''}`;
  head.append(state, who, step);
  row.append(head);
  const now = document.createElement('div');
  now.className = 'task-now';
  now.textContent = t.state === 'done' ? t.steps.join(' → ') : t.current;
  now.title = t.steps.join('\n');
  row.append(now);
  if (t.note && t.state !== 'running') {
    const note = document.createElement('div');
    note.className = 'task-note';
    note.textContent = t.note;
    row.append(note);
  }
  const tools = document.createElement('div');
  tools.className = 'task-tools';
  const button = (label, action, title) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'link';
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', () => bridge.tasksControl(action, t.id));
    tools.append(b);
  };
  if (t.state === 'paused' || t.state === 'error') button('▶ Продолжить', 'resume', t.state === 'error' ? 'Повторить шаг, на котором остановилась' : 'Продолжить с того же шага');
  else if (t.state !== 'done') button('⏸ Пауза', 'pause', 'Приостановить (боту — #стоп); продолжить можно с того же шага');
  button(t.state === 'done' ? 'Убрать' : '✕ Убрать', 'cancel', 'Убрать задачу из списка');
  row.append(tools);
  return row;
}

function renderTasks(list) {
  taskItems = Array.isArray(list) ? list : [];
  const active = taskItems.filter((t) => t.state !== 'done');
  const count = (st) => taskItems.filter((t) => t.state === st).length;
  const parts = [['идут', count('running')], ['ждут бота', count('waiting')], ['в очереди', count('queued')], ['на паузе', count('paused')], ['с ошибкой', count('error')], ['готово', count('done')]]
    .filter(([, n]) => n).map(([w, n]) => `${w} ${n}`);
  el.taskStatus.textContent = taskItems.length ? `Задач: ${active.length}${parts.length ? ` — ${parts.join(', ')}` : ''}` : '';
  el.taskStatus.className = count('error') ? 'ai-status warn' : active.length ? 'ai-status ok' : 'ai-status';
  const errors = count('error');
  el.taskTag.hidden = !active.length;
  el.taskTag.className = errors ? 'tag warn' : 'tag';
  el.taskTag.textContent = errors ? `ошибок ${errors}` : `${active.length}`;
  el.taskTools.hidden = active.length < 2;
  // Сначала — задачи выбранного бота (и его готовые), потом незаконченные у остальных.
  const mine = taskItems.filter((t) => t.bot === selected);
  const others = active.filter((t) => t.bot !== selected);
  const shown = [...mine.filter((t) => t.state !== 'done'), ...mine.filter((t) => t.state === 'done').slice(-3), ...others].slice(0, TASK_ROWS);
  el.taskList.replaceChildren(...shown.map(taskRow));
  const hidden = mine.length + others.length - shown.length;
  if (hidden > 0) {
    const more = document.createElement('p');
    more.className = 'hint';
    more.textContent = `…и ещё задач: ${hidden} (выбери бота в списке — покажу его задачи первыми)`;
    el.taskList.append(more);
  }
  if (taskItems.some((t) => t.state === 'done')) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'link';
    clear.textContent = 'Убрать готовые';
    clear.addEventListener('click', () => bridge.tasksControl('clear-done'));
    el.taskList.append(clear);
  }
}

el.taskAdd.addEventListener('click', async () => {
  const text = el.taskSteps.value;
  el.taskAdd.disabled = true;
  try {
    const r = await bridge.tasksAdd(text, el.taskTarget.value, el.taskRepeat.checked);
    if (r && r.ok) {
      el.taskStatus.className = 'ai-status ok';
      el.taskStatus.textContent = r.added > 1 ? `Задача добавлена ботам: ${r.added}` : 'Задача добавлена';
    } else {
      el.taskStatus.className = 'ai-status warn';
      el.taskStatus.textContent = `Не добавлено: ${(r && r.error) || 'ошибка'}`;
    }
  } finally {
    el.taskAdd.disabled = false;
  }
});
el.taskPauseAll.addEventListener('click', () => bridge.tasksControl('pause'));
el.taskResumeAll.addEventListener('click', () => bridge.tasksControl('resume'));
bridge.onTasks(renderTasks);
// «Следующая проверка через …» и кто чем занят — освежать, пока автопилот включён.
setInterval(async () => {
  if (questState && questState.running && !document.hidden) renderQuests(await bridge.questsStatus());
}, 20000);

el.aiRun.addEventListener('click', runAi);
el.aiTask.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    runAi();
  }
});
el.aiStop.addEventListener('click', async () => {
  el.aiStop.disabled = true;
  if (!(await bridge.aiStop())) setAiRunning(false);
});

// Сервис, модель, адрес и ключ сохраняются сразу (ключ — зашифрованным).
for (const field of [el.aiProvider, el.ollamaModel, el.ollamaUrl, el.ollamaGpu, el.aiKey, el.aiModel, el.aiBaseUrl]) {
  field.addEventListener('change', async () => {
    const before = `${el.aiBaseUrl.value}\n${el.aiKey.value}`;
    const cfg = await bridge.saveConfig(readAiForm());
    fillForm(cfg);
    if (`${el.aiBaseUrl.value}\n${el.aiKey.value}` !== before) aiModelsLoaded = false; // другой сервис — другие модели
    if ([el.aiProvider, el.ollamaModel, el.ollamaUrl, el.ollamaGpu].includes(field)) refreshAiStatus();
  });
}
el.aiKey.addEventListener('input', updateAiSetupTag);
el.aiBaseUrl.addEventListener('input', updateAiSetupTag);
el.aiModel.addEventListener('focus', loadAiModels);
el.ollamaModel.addEventListener('focus', refreshAiStatus); // свежий список скачанных моделей
el.aiSettings.addEventListener('toggle', () => {
  if (el.aiSettings.open) refreshAiStatus();
});
el.getOllama.addEventListener('click', () => bridge.aiGetOllama());
// Вернулся в панель (например, после установки Ollama) — проверить ещё раз; пока не готово — раз в 15 с.
window.addEventListener('focus', () => {
  if (usesOllama() && !aiRunning && !aiReady()) refreshAiStatus();
});
setInterval(() => {
  if (usesOllama() && !aiRunning && !aiReady() && !document.hidden) refreshAiStatus();
}, AI_STATUS_POLL_MS);

el.showAiKey.addEventListener('click', () => {
  const show = el.aiKey.type === 'password';
  el.aiKey.type = show ? 'text' : 'password';
  el.showAiKey.setAttribute('aria-pressed', String(show));
  const label = show ? 'Скрыть ключ' : 'Показать ключ';
  el.showAiKey.title = label;
  el.showAiKey.setAttribute('aria-label', label);
});

bridge.onAiState(({ running }) => {
  setAiRunning(running);
  if (!running) refreshAiStatus(); // модель могла скачаться, Ollama — запуститься
});
bridge.onAiProgress(({ text }) => {
  if (aiRunning && text) showAiResult(`${text}\n\nШаги — в консоли с меткой «ИИ»`, 'busy');
});
bridge.onAiDone(({ text, partial, error, requests, provider, took }) => {
  let tail = '';
  if (Number.isFinite(requests)) tail = provider === 'ollama' ? `\n\nХодов ИИ: ${requests}${took ? ` · ${took}` : ''}` : `\n\nЗапросов к ИИ: ${requests}`;
  showAiResult(error ? `Не получилось: ${text}` : `${text}${tail}`, error ? 'error' : partial ? 'warn' : 'ok');
});

el.sendMode.addEventListener('change', updateSelectedUi);
el.onlySelected.addEventListener('change', applyConsoleFilter);

el.chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const text = el.chatInput.value.trim();
  if (!text || el.chatInput.disabled) return;
  const sent = await bridge.say(text, el.sendMode.value);
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
bridge.onState(updateBot);
bridge.onPing(updatePing);
bridge.onSummary(applySummary);
bridge.onList(({ bots: list, selected: sel }) => {
  const changed = sel !== selected;
  renderList(list, sel);
  if (changed && sel) choose(sel);
});

bridge.init().then(({ config, bots: list, summary: s, selected: sel, chat, ai, quests, tasks }) => {
  fillForm(config);
  renderList(list, sel);
  applySummary(s);
  renderChatHistory(chat);
  setAiRunning(ai && ai.running);
  refreshAiStatus();
  renderQuests(quests);
  renderTasks(tasks);
});
