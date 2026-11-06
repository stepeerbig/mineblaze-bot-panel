'use strict';

// ИИ-помощник: задание словами («возьми задания у Фермера всеми ботами») → ИИ сам отдаёт ботам команды из списка
// (src/bot/commands.js), читает их ответы, решает, что дальше, и в конце пишет короткий отчёт.
//
// Где работает модель — в настройках панели (aiProvider):
//  - 'ollama' (по умолчанию) — Ollama на этом ПК (ollama.com): бесплатно, без ключа и лимитов. Разговор — через
//    родной API Ollama (/api/chat), а не OpenAI-совместимый: только в нём задаётся окно контекста (num_ctx), а по
//    умолчанию у Ollama 4096 токенов — подсказка с командами и ответы ботов туда не влезают. Ollama не запущена —
//    панель запускает её сама; модели нет — скачивает (/api/pull, один раз).
//  - 'openai' — интернет-сервис с OpenAI-совместимым API и ключом (OpenRouter, Groq…).
// Electron здесь не нужен: fetch, запуск Ollama и доступ к ботам передаются снаружи (main.js), поэтому всё
// проверяется обычными тестами (test/ai.test.js).
//
// События: action { text } — что ИИ делает (команда ботам, ожидание, скачивание модели); progress { text } — что
// сейчас (думает, скачано 40 %) — для окошка итога, не в лог; thought { text } — что ИИ пишет по ходу;
// done { text, requests, partial, provider, ms } — отчёт; error { text }; state { running }.

const EventEmitter = require('events');
const { DEFAULT_CONFIG } = require('./config');

const MAX_STEPS = 12; // ходов модели на задание
const MAX_COMMANDS = 200; // команд ботам за задание — защита от бесконечного цикла
const MAX_WAIT_S = 300;
const REQUEST_TIMEOUT_MS = 90 * 1000; // интернет-сервис
const LOCAL_TIMEOUT_MS = 10 * 60 * 1000; // своя модель на процессоре: первый ход (загрузка в память + подсказка) — минуты
const RESULT_LIMIT = 12000; // символов ответа инструмента в историю модели (≈ 3–4 тыс. токенов)
const LOCAL_RESULT_LIMIT = 6000; // своя модель: окно контекста меньше
const RETRY_WAIT_MS = 4000; // «слишком много запросов» — подождать и попробовать ещё раз
const OPENROUTER_FALLBACK = 'openrouter/free'; // OpenRouter сам выберет свободную бесплатную модель
const DEFAULT_BASE_URL = DEFAULT_CONFIG.aiBaseUrl;
const DEFAULT_MODEL = DEFAULT_CONFIG.aiModel;
const OLLAMA_URL = DEFAULT_CONFIG.ollamaUrl;
const OLLAMA_MODEL = DEFAULT_CONFIG.ollamaModel;
// Окно контекста, токенов: подсказка с командами (≈ 2,5 тыс.) + ответы ботов за задание. Память под него Ollama
// берёт сразу: у модели на 4B — ≈ 1,7 ГБ к 2,5 ГБ самой модели (16 тыс. — уже ≈ 2,3 ГБ, а ПК занят ещё и ботами).
const OLLAMA_CTX = 12288;
const OLLAMA_HISTORY_CHARS = 24000; // длиннее — старые ответы ботов сокращаются (русский текст — от ≈ 2,3 символа на токен)
const OLLAMA_PREDICT = 1024; // токенов на один ответ модели
const OLLAMA_KEEP_ALIVE = '10m'; // модель держится в памяти 10 мин после хода (wait — до 5 мин), потом память свободна
const OLLAMA_START_MS = 30 * 1000; // запустили Ollama — ждать, пока начнёт отвечать
const PULL_STALL_MS = 2 * 60 * 1000; // скачивание модели без единого байта столько — застряло
const LOCAL_URL_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i; // этот ПК: без ключа
const JSON_HEADERS = { 'Content-Type': 'application/json' };
// Ollama не смогла запустить модель на видеокарте (а не «нет памяти» и не «нет модели»).
const GPU_CRASH_RE = /CUDA|PTX|cublas|ggml-cuda|ROCm|HIP error|vulkan|GPU|llama-server process has terminated|exit status 0xc0000409/i;
const SERVICE = { timeout: 'сервис ИИ не ответил', offline: 'нет связи с сервисом ИИ' };
const OLLAMA = { timeout: 'Ollama не ответила', offline: 'нет связи с Ollama' };

// Команды серверу, которые ИИ отдавать нельзя: деньги и торговля (аукцион, скупщик), вход и пароли, сообщения
// игрокам и администрации, то, что губит бота или его вещи (kill, очистка инвентаря, удаление домов).
const FORBIDDEN_RE = new RegExp(`^/\\s*(?:${[
  'pay', 'money', 'eco', 'economy', 'trade', 'ah', 'auction', 'sell', 'buyer',
  'login', 'l', 'log', 'register', 'reg', 'changepassword', 'changepass', 'cp', 'unregister', 'email', '2fa',
  'msg', 'm', 'tell', 'w', 'whisper', 'r', 'reply', 'mail', 'me', 'broadcast', 'bc', 'shout', 'ad', 'advert', 'helpop', 'report',
  'kill', 'suicide', 'clear', 'ci', 'clearinventory', 'delhome', 'removehome',
].join('|')})(?:\\s|$)`, 'i');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_bots',
      description: 'Боты панели: ник, состояние (online — в сети, offline — не в сети, queued/connecting — входит), пинг. Узнай это первым, если не знаешь, кто в сети.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Отдать команду ботам и дождаться ответа. Команда боту — «#…» (список в инструкции), команда серверу — «/…» (например /warp ah). ' +
        'Обычный текст в чат нельзя. bots: ник, ники через запятую или all — все боты в сети по очереди (следующий начинает, когда закончил предыдущий).',
      parameters: {
        type: 'object',
        properties: {
          bots: { type: 'string', description: 'ник бота, ники через запятую или all' },
          command: { type: 'string', description: 'например: #квесты принести урожай награды, #бей пауков 20, /warp ah' },
        },
        required: ['bots', 'command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_bots',
      description: 'Запустить ботов, которые не в сети: войдут на сервер по очереди, по несколько секунд на каждого. bots: ники через запятую или all.',
      parameters: { type: 'object', properties: { bots: { type: 'string', description: 'ники через запятую или all' } }, required: ['bots'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait',
      description: `Подождать N секунд (до ${MAX_WAIT_S}) — например, пока боты войдут на сервер.`,
      parameters: { type: 'object', properties: { seconds: { type: 'number', description: 'сколько секунд' } }, required: ['seconds'] },
    },
  },
];

/** Подсказка модели: кто она, как работать и что умеют боты (список команд — тот же, что #помощь). */
function systemPrompt(catalog) {
  const commands = catalog.map((c) => {
    const notes = c.notes && c.notes.length ? `\n  Правила: ${c.notes.join(' ')}` : '';
    return `- ${c.usage.join(' · ')} — ${c.about}${notes}`;
  }).join('\n');
  return [
    'Ты — помощник в панели MineBlaze Bot Panel. Ты управляешь ботами Minecraft на сервере MineBlaze (версия 1.21.11) ' +
      'только через инструменты. Боты — аккаунты пользователя.',
    'Как работать:',
    '- Если не знаешь, кто в сети, — сначала list_bots. Ботов не в сети запускает start_bots (входят по очереди, ' +
      'по несколько секунд на каждого) — потом wait и снова list_bots.',
    '- Отдавай ботам команды «#…» из списка ниже: они сами делают сложное (открывают меню NPC, телепортируются, ' +
      'берут из сундуков). Команду серверу «/…» — только если нужна именно она.',
    '- Одним вызовом — сразу многим: bots="all" (все в сети) или ники через запятую. «#…» боты выполняют по очереди, ' +
      '«/…» уходит всем сразу. Ходов у тебя немного — экономь их: не спрашивай по одному боту то, что можно спросить у всех.',
    '- Читай ответы ботов: там написано, что вышло и что нет, ответ приходит целиком. «да» — команда выполнена, перепроверять ' +
      'её другими командами не нужно. Не повторяй неудачное больше одного раза — объясни почему.',
    '- Как только узнал всё, что просили (или сделал), — сразу пиши итог, без лишних ходов.',
    '- Обычный текст в чат сервера не пиши. Игроков не атакуй. Деньги ботов не трать без нужды (#квесты купить — только для ' +
      'заданий «Купите…»). Команды денег, входа и личных сообщений тебе недоступны.',
    '- Если задание непонятно, опасно или для него нет команды — не выдумывай, а скажи, чего не хватает.',
    '- В конце — итог по-русски, коротко: до 8 строк. Ответы ботов пользователь и так видит в консоли — не ' +
      'переписывай их, напиши вывод, строго по ответам, без догадок. Ботов по одному не перечисляй: одинаковое у ' +
      'многих — одной строкой («у всех…», «у 65 из 70…»), отдельно — только отличия и неудачи с причиной. Нужно ' +
      'что-то от пользователя — одной строкой. Простым текстом, без Markdown (без **, # и таблиц); списки — «- ».',
    'Сервер MineBlaze:',
    '- NPC с заданиями (Фермер, Алхимик, Оружейник) стоят у /warp ah. #квесты (все виды) и #купи сами телепортируют бота ' +
      'туда, если NPC не видно, — отдельный /warp ah не нужен. После телепорта ждать (wait) не нужно.',
    '- Ответы сервера начинаются с «| ». «Вы не можете использовать команды во время PvP» — бот в бою, подожди ~30 с.',
    '- В списке заданий (#квесты) «взято» — задание взято, но ещё не выполнено; «не взято» — его надо взять ' +
      '(#квесты взять); выполнено — когда счёт полный (224/224) или так и написано.',
    'Команды ботов:',
    commands,
  ].join('\n');
}

const clip = (text, n = RESULT_LIMIT) => (text.length > n
  ? `${text.slice(0, n)}… (обрезано: не влезло — остальных ботов спроси отдельно, ники через запятую)`
  : text);
const trimUrl = (url) => String(url || '').trim().replace(/\/+$/, '');
const gb = (bytes) => (bytes / 1e9).toFixed(1).replace('.', ',');
/** «qwen3» и «qwen3:latest» — одна и та же модель Ollama. */
const fullName = (model) => {
  const s = String(model || '').trim().toLowerCase();
  return /:[^/]*$/.test(s) ? s : `${s}:latest`;
};
/** 75 000 мс → «1 мин 15 с». */
function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  return s % 60 ? `${Math.floor(s / 60)} мин ${s % 60} с` : `${s / 60} мин`;
}
const abortError = () => Object.assign(new Error('Остановлено'), { name: 'AbortError' });

/** Markdown, который модели пишут по привычке, — в простой текст (панель показывает текст как есть). */
function plainText(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '') // размышления вслух (у некоторых моделей — прямо в ответе)
    .replace(/\*\*(.+?)\*\*/gs, '$1')
    .replace(/__(.+?)__/gs, '$1')
    .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=[\s).,:;!?]|$)/gm, '$1$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/^#{1,6}[ \t]+/gm, '') // заголовки «## …» (а «#квесты» без пробела — команда, её не трогаем)
    .replace(/^[ \t]*[*•][ \t]+/gm, '- ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

/** Понятная причина по ответу сервиса ИИ. */
function httpProblem(status, text) {
  const body = String(text || '').slice(0, 300);
  if (status === 401 || status === 403) return `сервис ИИ не принял ключ (${status}) — проверь ключ в настройках ИИ`;
  if (status === 402) return 'на счету сервиса ИИ нет денег (402) — выбери бесплатную модель (с «:free»)';
  if (status === 404) return 'нет такой модели (404) — проверь её название в настройках ИИ';
  if (status === 429) return 'лимит запросов к ИИ (429): подожди минуту — или до завтра, если кончился дневной (бесплатно — 50 в день)';
  if (status === 400 && /tool/i.test(body)) return 'эта модель не умеет вызывать инструменты — выбери другую';
  if (status >= 500) return `сервис ИИ сейчас не отвечает (${status}) — попробуй позже`;
  return `сервис ИИ ответил ошибкой ${status}${body ? `: ${body}` : ''}`;
}

/** Понятная причина по ответу Ollama ({ error: "…" } или текст). pull — ошибка при скачивании модели. */
function ollamaProblem(status, text, model, { pull = false } = {}) {
  let msg = String(text || '');
  try {
    const data = JSON.parse(msg);
    if (data && data.error) msg = String(data.error);
  } catch (_) {
    /* не JSON — как есть */
  }
  msg = msg.trim().slice(0, 300);
  if (/file does not exist|not found/i.test(msg) || (status === 404 && !msg)) {
    return `в Ollama нет модели «${model}» — проверь её название в настройках ИИ (например ${OLLAMA_MODEL})`;
  }
  if (/does not support tools/i.test(msg)) return `модель ${model} не умеет вызывать команды (tools) — выбери другую, например ${OLLAMA_MODEL}`;
  if (/memory/i.test(msg)) return `не хватает памяти для модели ${model} — закрой лишние программы или выбери модель поменьше (${msg})`;
  if (/no space left|not enough space|disk/i.test(msg)) return `не хватает места на диске для модели ${model} (${msg})`;
  if (pull && /dial tcp|no such host|timeout|timed out|connection|tls|certificate/i.test(msg)) {
    return `Ollama не может скачать модель: нет связи с ollama.com — проверь интернет и нажми «Выполнить» ещё раз (${msg})`;
  }
  const what = pull ? `не удалось скачать модель ${model}` : `Ollama ответила ошибкой${status ? ` ${status}` : ''}`;
  return `${what}${msg ? `: ${msg}` : ''}`;
}

/**
 * Своя модель: окно контекста небольшое. История длиннее maxChars — старые ответы ботов (кроме двух последних)
 * сокращаются до начала; подсказка, задание и свежие ответы остаются целиком. → длина истории после.
 */
function fitHistory(messages, maxChars) {
  const size = (m) => String(m.content || '').length + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  let total = messages.reduce((s, m) => s + size(m), 0);
  const old = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0).slice(0, -2);
  for (const i of old) {
    if (total <= maxChars) break;
    const m = messages[i];
    if (m.content.length <= 500) continue;
    const content = `${m.content.slice(0, 300)}… (старый ответ сокращён)`;
    total -= m.content.length - content.length;
    messages[i] = { ...m, content };
  }
  return total;
}

/** Тело ответа построчно (NDJSON — так Ollama присылает ход скачивания). onChunk — пришли данные. */
async function readLines(body, onLine, onChunk = () => {}) {
  if (!body || typeof body.getReader !== 'function') throw new Error('Ollama прислала ответ без тела');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk();
      buf += decoder.decode(value, { stream: true });
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    }
    buf += decoder.decode();
    if (buf.trim()) onLine(buf.trim());
  } catch (err) {
    reader.cancel().catch(() => {});
    throw err;
  }
}

class AiAgent extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {Function} opts.getConfig  () => { aiProvider, ollamaUrl, ollamaModel, aiBaseUrl, aiKey, aiModel }
   * @param {object}   opts.env        доступ к ботам: listBots() → [{ nick, state, ping }],
   *                                   runCommand(nicks|null, line, signal) → [{ nick, ok, message }],
   *                                   startBots(nicks|null) → сколько запущено, catalog() — команды ботов;
   *                                   Ollama: startOllama() → true, если программу нашли и запустили,
   *                                   ollamaInstalled() → установлена ли (для подсказки на панели)
   * @param {Function} [opts.fetch]    fetch (подмена для тестов)
   * @param {object}   [opts.timings]  { retryWaitMs, startWaitMs, pollMs, stallMs } (для тестов)
   */
  constructor({ getConfig, env, fetch = globalThis.fetch, timings = {} } = {}) {
    super();
    this.getConfig = getConfig;
    this.env = env;
    this._fetch = fetch;
    this.timings = { retryWaitMs: RETRY_WAIT_MS, startWaitMs: OLLAMA_START_MS, pollMs: 1000, stallMs: PULL_STALL_MS, ...timings };
    this.running = null;
  }

  get busy() {
    return Boolean(this.running);
  }

  /**
   * Начать задание. Сразу проверяет (пустое, нет ключа, ИИ уже занят — исключение), дальше идёт само.
   * Промис — итог { text, requests, partial } (ошибка по ходу — событие error и итог null).
   */
  run(task) {
    const text = String(task || '').trim();
    if (!text) throw new Error('напиши, что сделать');
    if (this.running) throw new Error('ИИ уже выполняет задание — дождись или нажми «Стоп»');
    const cfg = this._config();
    if (cfg.provider === 'openai' && !cfg.key && !LOCAL_URL_RE.test(cfg.url)) {
      throw new Error('нет ключа ИИ — впиши его в «ИИ-помощник» → «Модель и сервис» (или выбери там Ollama на этом ПК)');
    }
    const run = { abort: new AbortController(), cfg, model: cfg.model, requests: 0, commands: 0, think: false, started: Date.now() };
    this.running = run;
    this.emit('state', { running: true });
    return this._loop(run, text);
  }

  async _loop(run, text) {
    const local = run.cfg.provider === 'ollama';
    try {
      if (local) await this._prepareOllama(run);
      const messages = [{ role: 'system', content: systemPrompt(this.env.catalog()) }, { role: 'user', content: text }];
      for (let step = 0; step < MAX_STEPS; step += 1) {
        if (run.abort.signal.aborted) return this._finish(run, 'Остановлено', true);
        if (local) fitHistory(messages, OLLAMA_HISTORY_CHARS);
        this.emit('progress', {
          // На процессоре (Ryzen 5 2600) подсказка с командами читается ≈ 2 мин; дальше она в памяти Ollama — ход ≈ 10–15 с.
          text: local && step === 0 ? 'ИИ думает… Первое задание на процессоре — до 2–3 минут (модель читает список команд), следующие — быстрее' : `ИИ думает… (ход ${step + 1})`,
        });
        const reply = local ? await this._chatOllama(messages, run) : await this._chatOpenAi(messages, run);
        messages.push(reply.message);
        const said = plainText(reply.text);
        if (!reply.calls.length) return this._finish(run, said || 'Готово (ИИ ничего не написал)', false);
        if (said) this.emit('thought', { text: said });
        for (const call of reply.calls) {
          const result = run.abort.signal.aborted
            ? 'Остановлено пользователем'
            : await this._callTool(call, run).catch((err) => `Ошибка: ${err && err.message ? err.message : err}`);
          const content = clip(String(result), local ? LOCAL_RESULT_LIMIT : RESULT_LIMIT);
          // Ollama связывает ответ с вызовом по имени инструмента, OpenAI-совместимые — по id вызова.
          messages.push(local ? { role: 'tool', tool_name: call.name, content } : { role: 'tool', tool_call_id: call.id, content });
        }
      }
      return this._finish(run, `Ходы кончились (${MAX_STEPS} на задание) — задание, похоже, не закончено. Попробуй разбить его на части.`, true);
    } catch (err) {
      if (run.abort.signal.aborted) return this._finish(run, 'Остановлено', true);
      this.emit('error', { text: err && err.message ? err.message : String(err) });
      return null;
    } finally {
      this.running = null;
      this.emit('state', { running: false });
    }
  }

  /** Остановить задание: текущий запрос обрывается, новые команды ботам не уходят. */
  stop() {
    if (!this.running) return false;
    this.running.abort.abort();
    return true;
  }

  /**
   * Подсказка для поля «Модель». Ollama — скачанные модели (и рекомендуемая); интернет-сервис — бесплатные модели,
   * которые умеют вызывать инструменты (у OpenRouter — по цене и параметрам).
   */
  async listModels() {
    const cfg = this._config();
    if (cfg.provider === 'ollama') return [...new Set([...(await this._ollamaModels(cfg.url)), OLLAMA_MODEL])];
    const res = await this._send(`${cfg.url}/models`, { headers: this._headers(cfg) }, { timeoutMs: 30 * 1000, who: SERVICE });
    if (!res.ok) throw new Error(httpProblem(res.status, await res.text().catch(() => '')));
    const data = await res.json();
    const list = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    const priced = list.some((m) => m && m.pricing);
    return list
      .filter((m) => m && (m.id || m.name))
      .filter((m) => !priced || (String(m.pricing && m.pricing.prompt) === '0' && String(m.pricing && m.pricing.completion) === '0'))
      .filter((m) => !Array.isArray(m.supported_parameters) || m.supported_parameters.includes('tools'))
      .map((m) => m.id || m.name);
  }

  /**
   * Для панели: готов ли ИИ. Ollama — { running, version, installed, hasModel, models }; интернет-сервис —
   * { keyMissing }. Ничего не запускает и не скачивает.
   */
  async status() {
    const cfg = this._config();
    if (cfg.provider !== 'ollama') return { provider: cfg.provider, model: cfg.model, keyMissing: !cfg.key && !LOCAL_URL_RE.test(cfg.url) };
    const base = { provider: 'ollama', model: cfg.model, url: cfg.url, local: LOCAL_URL_RE.test(cfg.url), gpu: cfg.gpu };
    const version = await this._ollamaVersion(cfg.url, null, 2000);
    if (!version) return { ...base, running: false, installed: Boolean(this.env.ollamaInstalled && this.env.ollamaInstalled()) };
    let models = [];
    try {
      models = await this._ollamaModels(cfg.url);
    } catch (_) {
      /* на версию ответила — список моделей спросим в следующий раз */
    }
    const want = fullName(cfg.model);
    return { ...base, running: true, installed: true, version, models, hasModel: models.some((m) => fullName(m) === want) };
  }

  // ---------- внутреннее ----------

  _config() {
    const c = this.getConfig() || {};
    if (c.aiProvider === 'openai') {
      return { provider: 'openai', url: trimUrl(c.aiBaseUrl) || DEFAULT_BASE_URL, key: String(c.aiKey || ''), model: String(c.aiModel || DEFAULT_MODEL) };
    }
    return { provider: 'ollama', url: trimUrl(c.ollamaUrl) || OLLAMA_URL, key: '', model: String(c.ollamaModel || OLLAMA_MODEL), gpu: c.ollamaGpu !== false };
  }

  _headers(cfg) {
    const h = { 'Content-Type': 'application/json', 'X-Title': 'MineBlaze Bot Panel' };
    if (cfg.key) h.Authorization = `Bearer ${cfg.key}`;
    return h;
  }

  _finish(run, text, partial) {
    const result = { text, requests: run.requests, partial, provider: run.cfg.provider, ms: Date.now() - run.started };
    this.emit('done', result);
    return result;
  }

  /** Запрос с пределом по времени; «Стоп» (run) обрывает его. Нет связи — ошибка с причиной (err.offline). */
  async _send(url, opts, { run = null, timeoutMs, who }) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const onStop = () => timeout.abort();
    if (run) run.abort.signal.addEventListener('abort', onStop, { once: true });
    try {
      return await this._fetch(url, { ...opts, signal: timeout.signal });
    } catch (err) {
      if (run && run.abort.signal.aborted) throw err;
      if (timeout.signal.aborted) throw new Error(`${who.timeout} за ${duration(timeoutMs)}`);
      throw Object.assign(new Error(`${who.offline}: ${err && err.message ? err.message : err}`), { offline: true });
    } finally {
      clearTimeout(timer);
      if (run) run.abort.signal.removeEventListener('abort', onStop);
    }
  }

  /**
   * Один ход модели интернет-сервиса (OpenAI-совместимый chat/completions). «Слишком много запросов» — пауза и ещё
   * раз; у OpenRouter потом — запасная бесплатная модель. → { message (в историю), text, calls: [{ id, name, args }] }
   */
  async _chatOpenAi(messages, run) {
    const { cfg } = run;
    for (let attempt = 0; ; attempt += 1) {
      const res = await this._send(`${cfg.url}/chat/completions`, {
        method: 'POST',
        headers: this._headers(cfg),
        body: JSON.stringify({ model: run.model, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 4000, temperature: 0.2 }),
      }, { run, timeoutMs: REQUEST_TIMEOUT_MS, who: SERVICE });
      if (res.status === 429 && attempt === 0) {
        await sleep(this.timings.retryWaitMs, run.abort.signal);
        continue;
      }
      if (res.status === 429 && attempt === 1 && /openrouter\.ai/i.test(cfg.url) && run.model !== OPENROUTER_FALLBACK) {
        this.emit('action', { text: `модель ${run.model} занята — пробую запасную (${OPENROUTER_FALLBACK})` });
        run.model = OPENROUTER_FALLBACK;
        continue;
      }
      if (!res.ok) throw new Error(httpProblem(res.status, await res.text().catch(() => '')));
      const data = await res.json();
      run.requests += 1;
      if (data && data.error) throw new Error(`сервис ИИ: ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      if (!msg) throw new Error('сервис ИИ прислал пустой ответ');
      const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).filter((c) => c && c.function && c.function.name);
      const message = { role: 'assistant', content: msg.content === undefined ? null : msg.content };
      if (calls.length) message.tool_calls = calls;
      return { message, text: msg.content || '', calls: calls.map((c) => ({ id: c.id, name: c.function.name, args: c.function.arguments })) };
    }
  }

  /**
   * Один ход своей модели (родной API Ollama): окно контекста — OLLAMA_CTX; модель, которая умеет думать вслух, —
   * без этого (на процессоре размышления — минуты, а команды выходят и так). → как у _chatOpenAi.
   */
  async _chatOllama(messages, run) {
    const { url, model } = run.cfg;
    const body = {
      model,
      messages,
      tools: TOOLS,
      stream: false,
      keep_alive: OLLAMA_KEEP_ALIVE,
      options: { num_ctx: OLLAMA_CTX, num_predict: OLLAMA_PREDICT, temperature: 0.2 },
    };
    if (run.think) body.think = false;
    if (!run.cfg.gpu) body.options.num_gpu = 0; // только процессор
    const res = await this._send(`${url}/api/chat`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) },
      { run, timeoutMs: LOCAL_TIMEOUT_MS, who: OLLAMA });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      // Ollama упала, загружая модель на видеокарту (например, драйвер NVIDIA старше её библиотек CUDA:
      // «PTX was compiled with an unsupported toolchain»), — тот же ход на процессоре, и дальше только так.
      if (run.cfg.gpu && res.status >= 500 && GPU_CRASH_RE.test(text)) {
        run.cfg.gpu = false;
        this.emit('action', { text: 'видеокарта не подошла Ollama (скорее всего, старый драйвер NVIDIA) — считаю на процессоре; включить снова — галочка «Видеокарта» в настройках ИИ' });
        if (this.env.disableGpu) this.env.disableGpu();
        return this._chatOllama(messages, run);
      }
      throw new Error(ollamaProblem(res.status, text, model));
    }
    const data = await res.json();
    run.requests += 1;
    if (data && data.error) throw new Error(ollamaProblem(0, JSON.stringify(data), model));
    const msg = data && data.message;
    if (!msg) throw new Error('Ollama прислала пустой ответ');
    const calls = (Array.isArray(msg.tool_calls) ? msg.tool_calls : []).filter((c) => c && c.function && c.function.name);
    const message = { role: 'assistant', content: msg.content || '' };
    if (calls.length) message.tool_calls = calls.map((c) => ({ type: 'function', function: { ...c.function, arguments: c.function.arguments || {} } }));
    return { message, text: msg.content || '', calls: calls.map((c, i) => ({ id: c.id || `call_${i}`, name: c.function.name, args: c.function.arguments })) };
  }

  /** Перед заданием: Ollama запущена (нет — запустить), модель скачана (нет — скачать), умеет вызывать команды. */
  async _prepareOllama(run) {
    const { url, model } = run.cfg;
    if (!(await this._ollamaVersion(url, run))) {
      if (!LOCAL_URL_RE.test(url)) throw new Error(`Ollama не отвечает по адресу ${url} — проверь, что она запущена на том ПК`);
      this.emit('progress', { text: 'Запускаю Ollama…' });
      const launched = this.env.startOllama ? await this.env.startOllama() : false;
      if (!launched) throw new Error('Ollama не установлена — скачай её с ollama.com (Download → Windows), установи и нажми «Выполнить» ещё раз');
      this.emit('action', { text: 'Ollama не была запущена — запустил' });
      if (!(await this._waitOllama(url, run))) {
        if (run.abort.signal.aborted) throw abortError();
        throw new Error(`Ollama не запустилась за ${duration(this.timings.startWaitMs)} — запусти её из меню «Пуск» и нажми «Выполнить» ещё раз`);
      }
    }
    let info = await this._ollamaShow(url, model, run);
    if (!info) {
      await this._pull(url, model, run);
      info = await this._ollamaShow(url, model, run);
      if (!info) throw new Error(`модель ${model} скачана, но Ollama её не видит — нажми «Выполнить» ещё раз`);
    }
    const caps = Array.isArray(info.capabilities) ? info.capabilities : null;
    if (caps && !caps.includes('tools')) throw new Error(`модель ${model} не умеет вызывать команды (tools) — выбери другую, например ${OLLAMA_MODEL}`);
    run.think = Boolean(caps && caps.includes('thinking'));
  }

  /** Версия Ollama или null (не запущена, нет связи). */
  async _ollamaVersion(url, run, timeoutMs = 3000) {
    try {
      const res = await this._send(`${url}/api/version`, {}, { run, timeoutMs, who: OLLAMA });
      if (!res.ok) return null;
      const data = await res.json().catch(() => ({}));
      return String((data && data.version) || '?');
    } catch (err) {
      if (run && run.abort.signal.aborted) throw err;
      return null;
    }
  }

  /** Только что запущенная Ollama начала отвечать? (ждём до startWaitMs) */
  async _waitOllama(url, run) {
    const until = Date.now() + this.timings.startWaitMs;
    while (Date.now() < until && !run.abort.signal.aborted) {
      await sleep(this.timings.pollMs, run.abort.signal);
      if (!run.abort.signal.aborted && (await this._ollamaVersion(url, run))) return true;
    }
    return false;
  }

  /** Сведения о модели (capabilities…) или null, если её нет в Ollama. */
  async _ollamaShow(url, model, run) {
    const res = await this._send(`${url}/api/show`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model }) },
      { run, timeoutMs: 60 * 1000, who: OLLAMA });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(ollamaProblem(res.status, await res.text().catch(() => ''), model));
    return res.json();
  }

  /** Скачанные модели Ollama (названия). */
  async _ollamaModels(url) {
    const res = await this._send(`${url}/api/tags`, {}, { timeoutMs: 10 * 1000, who: OLLAMA });
    if (!res.ok) throw new Error(ollamaProblem(res.status, await res.text().catch(() => ''), ''));
    const data = await res.json();
    return (Array.isArray(data && data.models) ? data.models : []).map((m) => m && (m.name || m.model)).filter(Boolean);
  }

  /**
   * Скачать модель в Ollama (один раз): ход — в процентах в окошке итога и в консоли через каждые 25 %.
   * «Стоп» обрывает скачивание (Ollama докачает в следующий раз); stallMs без данных — застряло.
   */
  async _pull(url, model, run) {
    this.emit('action', { text: `модели ${model} ещё нет — скачиваю (один раз; «Стоп» прервёт, потом докачается)` });
    this.emit('progress', { text: `Скачиваю модель ${model}…` });
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    run.abort.signal.addEventListener('abort', onStop, { once: true });
    let stalled = false;
    let watchdog = null;
    const kick = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        stalled = true;
        ctl.abort();
      }, this.timings.stallMs);
    };
    const started = Date.now();
    const layers = new Map(); // часть модели (digest) → { total, completed }
    let quarter = 0;
    let shownAt = 0;
    let success = false;
    let first = null; // { at, got } — с чего считать скорость (докачка начинается не с нуля)
    /** «, 1,0 МБ/с, осталось ≈ 35 мин» — когда скорость уже понятна (≥ 5 с скачивания). */
    const pace = (got, total) => {
      if (!first) first = { at: Date.now(), got };
      const s = (Date.now() - first.at) / 1000;
      const speed = s >= 5 ? (got - first.got) / s : 0;
      if (!speed || got >= total) return '';
      const left = (total - got) / speed;
      const eta = left >= 120 ? `${Math.round(left / 60)} мин` : `${Math.max(1, Math.round(left))} с`;
      return `, ${(speed / 1e6).toFixed(1).replace('.', ',')} МБ/с, осталось ≈ ${eta}`;
    };
    const onEvent = (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        return;
      }
      if (ev.error) throw new Error(ollamaProblem(0, String(ev.error), model, { pull: true }));
      if (ev.status === 'success') success = true;
      if (/^verifying/i.test(ev.status || '')) this.emit('progress', { text: `Модель ${model} скачана, проверяю…` });
      if (!ev.digest || !(ev.total > 0)) return;
      layers.set(ev.digest, { total: ev.total, completed: Math.min(ev.total, ev.completed || 0) });
      let total = 0;
      let got = 0;
      for (const l of layers.values()) {
        total += l.total;
        got += l.completed;
      }
      const pct = Math.floor((got / total) * 100);
      const tail = pace(got, total);
      if (Date.now() - shownAt >= 1000 || pct >= 100) {
        shownAt = Date.now();
        this.emit('progress', { text: `Скачиваю модель ${model}: ${pct} % (${gb(got)} из ${gb(total)} ГБ${tail})` });
      }
      const q = Math.floor(pct / 25);
      if (q > quarter && q < 4) {
        quarter = q;
        this.emit('action', { text: `модель ${model}: скачано ${q * 25} % (${gb(got)} из ${gb(total)} ГБ)` });
      }
    };
    try {
      kick();
      let res;
      try {
        res = await this._fetch(`${url}/api/pull`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ model, stream: true }), signal: ctl.signal });
      } catch (err) {
        if (run.abort.signal.aborted || stalled) throw err;
        throw new Error(`${OLLAMA.offline}: ${err && err.message ? err.message : err}`);
      }
      if (!res.ok) throw new Error(ollamaProblem(res.status, await res.text().catch(() => ''), model, { pull: true }));
      await readLines(res.body, onEvent, kick);
    } catch (err) {
      if (run.abort.signal.aborted) throw err;
      if (stalled) throw new Error(`скачивание модели ${model} застряло: ${duration(this.timings.stallMs)} без данных — проверь интернет и нажми «Выполнить» ещё раз (докачается)`);
      throw err;
    } finally {
      clearTimeout(watchdog);
      run.abort.signal.removeEventListener('abort', onStop);
    }
    if (!success) throw new Error(`скачивание модели ${model} оборвалось — нажми «Выполнить» ещё раз (докачается)`);
    this.emit('action', { text: `модель ${model} скачана за ${duration(Date.now() - started)}` });
  }

  /** Боты по словам модели: «all» — null (все в сети); иначе — ники (неизвестные — ошибка). */
  _bots(spec) {
    const s = String(spec || '').trim();
    if (!s || /^(?:all|все|всем|all bots)$/i.test(s)) return { ids: null };
    const known = new Map(this.env.listBots().map((b) => [b.nick.toLowerCase(), b.nick]));
    const nicks = s.split(/[\s,;]+/).filter(Boolean);
    const unknown = nicks.filter((n) => !known.has(n.toLowerCase()));
    if (unknown.length) return { error: `нет таких ботов: ${unknown.join(', ')} (есть: ${[...known.values()].slice(0, 20).join(', ')})` };
    return { ids: nicks.map((n) => known.get(n.toLowerCase())) };
  }

  /** Вызов инструмента моделью: call — { name, args (объект или JSON-строка) }. → текст ответа для модели. */
  async _callTool(call, run) {
    let args = {};
    try {
      args = call.args ? (typeof call.args === 'string' ? JSON.parse(call.args) : call.args) : {};
    } catch (_) {
      return 'Ошибка: аргументы не в формате JSON';
    }
    if (!args || typeof args !== 'object') args = {};
    switch (call.name) {
      case 'list_bots': {
        const bots = this.env.listBots();
        const online = bots.filter((b) => b.state === 'online').length;
        return `Ботов: ${bots.length}, в сети: ${online}\n${bots.map((b) => `${b.nick}: ${b.state}${Number.isFinite(b.ping) ? `, пинг ${b.ping} мс` : ''}`).join('\n')}`;
      }
      case 'run_command': {
        // Маленькие модели иногда берут команду в кавычки: «"#квесты"».
        const command = String(args.command || '').trim().replace(/^["'`«]+|["'`»]+$/g, '').trim();
        if (!/^[#/]/.test(command)) return 'Отказано: только команды «#…» боту или «/…» серверу — обычный текст в чат нельзя';
        if (FORBIDDEN_RE.test(command)) return 'Отказано: команды денег, входа и сообщений игрокам ИИ отдавать нельзя';
        const who = this._bots(args.bots);
        if (who.error) return `Ошибка: ${who.error}`;
        const count = who.ids ? who.ids.length : this.env.listBots().filter((b) => b.state === 'online' || b.state === 'connected').length;
        if (run.commands + count > MAX_COMMANDS) return `Отказано: за одно задание не больше ${MAX_COMMANDS} команд ботам`;
        run.commands += count;
        this.emit('action', { text: `${who.ids ? who.ids.join(', ') : `все боты в сети (${count})`}: ${command}` });
        const results = await this.env.runCommand(who.ids, command, run.abort.signal);
        return formatResults(results);
      }
      case 'start_bots': {
        const who = this._bots(args.bots);
        if (who.error) return `Ошибка: ${who.error}`;
        this.emit('action', { text: `запускаю ботов: ${who.ids ? who.ids.join(', ') : 'всех'}` });
        const n = await this.env.startBots(who.ids);
        return n ? `Запущено ботов: ${n} — входят по очереди, по несколько секунд на каждого` : 'Запускать некого: все уже запущены';
      }
      case 'wait': {
        const s = Math.max(1, Math.min(MAX_WAIT_S, Math.round(Number(args.seconds) || 5)));
        this.emit('action', { text: `жду ${s} с` });
        await sleep(s * 1000, run.abort.signal);
        return `Подождал ${s} с`;
      }
      default:
        return `Ошибка: нет инструмента «${call.name}»`;
    }
  }
}

/**
 * Ответы ботов для модели. Одинаковые ответы — одной строкой со списком ботов (у 70 ботов «Перемещение на ah» —
 * одна строка, а не 70). Ответ целиком (список заданий — все строки), только у очень длинных — начало.
 */
function formatResults(results) {
  const list = Array.isArray(results) ? results : [];
  if (!list.length) return 'Некому отдать команду: ни одного бота в сети';
  const groups = new Map();
  for (const r of list) {
    const message = [].concat(r.message || []).map(String);
    const key = `${r.ok ? 1 : 0}\n${message.join('\n')}`;
    if (!groups.has(key)) groups.set(key, { ok: Boolean(r.ok), message, nicks: [] });
    groups.get(key).nicks.push(r.nick);
  }
  const per = groups.size <= 2 ? 40 : groups.size <= 8 ? 15 : 6; // строк ответа на группу
  const who = (nicks) => (nicks.length > 5 ? `${nicks.slice(0, 5).join(', ')} и ещё ${nicks.length - 5}` : nicks.join(', '));
  const out = [];
  if (list.length >= 3) {
    const ok = list.filter((r) => r.ok).length;
    out.push(`Ботов: ${list.length}, вышло у ${ok}, не вышло у ${list.length - ok}`);
  }
  for (const g of groups.values()) {
    const lines = g.message.slice(0, per);
    if (g.message.length > per) lines.push(`…ещё строк: ${g.message.length - per}`);
    const head = `${who(g.nicks)}: ${g.ok ? 'да' : 'НЕТ'}`;
    if (!lines.length) out.push(`${head} — (без ответа)`);
    else if (lines.length === 1) out.push(`${head} — ${lines[0]}`);
    else out.push(`${head}\n${lines.map((l) => `  ${l}`).join('\n')}`);
  }
  return out.join('\n');
}

module.exports = {
  AiAgent, systemPrompt, formatResults, plainText, fitHistory, formatDuration: duration, TOOLS, DEFAULT_BASE_URL, DEFAULT_MODEL,
  OLLAMA_URL, OLLAMA_MODEL, OLLAMA_CTX, MAX_STEPS, FORBIDDEN_RE,
};
