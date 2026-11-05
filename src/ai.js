'use strict';

// ИИ-помощник: задание словами («возьми задания у Фермера всеми ботами») → ИИ сам отдаёт ботам команды из списка
// (src/bot/commands.js), читает их ответы, решает, что дальше, и в конце пишет короткий отчёт. Сервис — любой с
// OpenAI-совместимым API: OpenRouter (есть бесплатные модели), Groq, Ollama на своём ПК… Адрес, ключ и модель —
// в настройках панели. Electron здесь не нужен: fetch и доступ к ботам передаются снаружи (main.js), поэтому
// всё проверяется обычными тестами (test/ai.test.js).
//
// События: action { text } — что ИИ делает (команда ботам, ожидание); thought { text } — что он пишет по ходу;
// done { text, requests, partial } — отчёт; error { text }; state { running }.

const EventEmitter = require('events');

const MAX_STEPS = 12; // ходов модели на задание: у бесплатных моделей OpenRouter — 50 запросов в день
const MAX_COMMANDS = 200; // команд ботам за задание — защита от бесконечного цикла
const MAX_WAIT_S = 300;
const REQUEST_TIMEOUT_MS = 90 * 1000;
const RESULT_LIMIT = 12000; // символов ответа инструмента в историю модели (≈ 3–4 тыс. токенов)
const RETRY_WAIT_MS = 4000; // «слишком много запросов» — подождать и попробовать ещё раз
const OPENROUTER_FALLBACK = 'openrouter/free'; // OpenRouter сам выберет свободную бесплатную модель
const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b:free';
const LOCAL_URL_RE = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i; // свой ПК (Ollama) — без ключа

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
    '- В конце — короткий отчёт по-русски: что сделано, что нет и почему, что нужно от пользователя. Простым текстом, ' +
      'без Markdown (без **, # и таблиц); списки — строками с «- ».',
    'Сервер MineBlaze:',
    '- NPC с заданиями (Фермер, Алхимик, Оружейник) стоят у /warp ah. #квесты (все виды) и #купи сами телепортируют бота ' +
      'туда, если NPC не видно, — отдельный /warp ah не нужен. После телепорта ждать (wait) не нужно.',
    '- Ответы сервера начинаются с «| ». «Вы не можете использовать команды во время PvP» — бот в бою, подожди ~30 с.',
    'Команды ботов:',
    commands,
  ].join('\n');
}

const clip = (text, n = RESULT_LIMIT) => (text.length > n ? `${text.slice(0, n)}… (обрезано)` : text);

/** Markdown, который модели пишут по привычке, — в простой текст (панель показывает текст как есть). */
function plainText(text) {
  return String(text || '')
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

class AiAgent extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {Function} opts.getConfig  () => { aiBaseUrl, aiKey, aiModel }
   * @param {object}   opts.env        доступ к ботам: listBots() → [{ nick, state, ping }],
   *                                   runCommand(nicks|null, line, signal) → [{ nick, ok, message }],
   *                                   startBots(nicks|null) → сколько запущено, catalog() — команды ботов
   * @param {Function} [opts.fetch]    fetch (подмена для тестов)
   * @param {object}   [opts.timings]  { retryWaitMs } (для тестов)
   */
  constructor({ getConfig, env, fetch = globalThis.fetch, timings = {} } = {}) {
    super();
    this.getConfig = getConfig;
    this.env = env;
    this._fetch = fetch;
    this.timings = { retryWaitMs: RETRY_WAIT_MS, ...timings };
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
    if (!cfg.aiKey && !LOCAL_URL_RE.test(cfg.aiBaseUrl)) {
      throw new Error('нет ключа ИИ — впиши его в «ИИ-помощник» → «Ключ» (OpenRouter → Keys → Create Key)');
    }
    const run = { abort: new AbortController(), requests: 0, commands: 0, model: cfg.aiModel };
    this.running = run;
    this.emit('state', { running: true });
    return this._loop(run, text);
  }

  async _loop(run, text) {
    try {
      const messages = [{ role: 'system', content: systemPrompt(this.env.catalog()) }, { role: 'user', content: text }];
      for (let step = 0; step < MAX_STEPS; step += 1) {
        if (run.abort.signal.aborted) return this._finish({ text: 'Остановлено', requests: run.requests, partial: true });
        const reply = await this._chat(messages, run);
        messages.push(reply);
        const said = plainText(reply.content);
        if (!reply.tool_calls || !reply.tool_calls.length) {
          return this._finish({ text: said || 'Готово (ИИ ничего не написал)', requests: run.requests, partial: false });
        }
        if (said) this.emit('thought', { text: said });
        for (const call of reply.tool_calls) {
          const result = run.abort.signal.aborted
            ? 'Остановлено пользователем'
            : await this._callTool(call, run).catch((err) => `Ошибка: ${err && err.message ? err.message : err}`);
          messages.push({ role: 'tool', tool_call_id: call.id, content: clip(String(result)) });
        }
      }
      return this._finish({ text: `Ходы кончились (${MAX_STEPS} на задание) — задание, похоже, не закончено. Попробуй разбить его на части.`, requests: run.requests, partial: true });
    } catch (err) {
      if (run.abort.signal.aborted) return this._finish({ text: 'Остановлено', requests: run.requests, partial: true });
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

  /** Бесплатные модели сервиса, которые умеют вызывать инструменты (у OpenRouter — по цене и параметрам). */
  async listModels() {
    const cfg = this._config();
    const res = await this._fetch(`${cfg.aiBaseUrl}/models`, { headers: this._headers(cfg) });
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

  // ---------- внутреннее ----------

  _config() {
    const c = this.getConfig() || {};
    return {
      aiBaseUrl: String(c.aiBaseUrl || DEFAULT_BASE_URL).replace(/\/+$/, ''),
      aiKey: String(c.aiKey || ''),
      aiModel: String(c.aiModel || DEFAULT_MODEL),
    };
  }

  _headers(cfg) {
    const h = { 'Content-Type': 'application/json', 'X-Title': 'MineBlaze Bot Panel' };
    if (cfg.aiKey) h.Authorization = `Bearer ${cfg.aiKey}`;
    return h;
  }

  _finish(result) {
    this.emit('done', result);
    return result;
  }

  /** Один ход модели. «Слишком много запросов» — пауза и ещё раз; у OpenRouter потом — запасная бесплатная модель. */
  async _chat(messages, run) {
    const cfg = this._config();
    let model = run.model;
    for (let attempt = 0; ; attempt += 1) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
      const onStop = () => timeout.abort();
      run.abort.signal.addEventListener('abort', onStop, { once: true });
      let res;
      try {
        res = await this._fetch(`${cfg.aiBaseUrl}/chat/completions`, {
          method: 'POST',
          headers: this._headers(cfg),
          body: JSON.stringify({ model, messages, tools: TOOLS, tool_choice: 'auto', max_tokens: 4000, temperature: 0.2 }),
          signal: timeout.signal,
        });
      } catch (err) {
        if (run.abort.signal.aborted) throw err;
        throw new Error(timeout.signal.aborted ? 'сервис ИИ не ответил за 90 с' : `нет связи с сервисом ИИ: ${err && err.message ? err.message : err}`);
      } finally {
        clearTimeout(timer);
        run.abort.signal.removeEventListener('abort', onStop);
      }
      if (res.status === 429 && attempt === 0) {
        await sleep(this.timings.retryWaitMs, run.abort.signal);
        continue;
      }
      if (res.status === 429 && attempt === 1 && /openrouter\.ai/i.test(cfg.aiBaseUrl) && model !== OPENROUTER_FALLBACK) {
        this.emit('action', { text: `модель ${model} занята — пробую запасную (${OPENROUTER_FALLBACK})` });
        model = OPENROUTER_FALLBACK;
        run.model = model;
        continue;
      }
      if (!res.ok) throw new Error(httpProblem(res.status, await res.text().catch(() => '')));
      const data = await res.json();
      run.requests += 1;
      if (data && data.error) throw new Error(`сервис ИИ: ${data.error.message || JSON.stringify(data.error).slice(0, 200)}`);
      const msg = data && data.choices && data.choices[0] && data.choices[0].message;
      if (!msg) throw new Error('сервис ИИ прислал пустой ответ');
      const reply = { role: 'assistant', content: msg.content === undefined ? null : msg.content };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) reply.tool_calls = msg.tool_calls;
      return reply;
    }
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

  async _callTool(call, run) {
    const fn = call && call.function ? call.function : {};
    let args = {};
    try {
      args = fn.arguments ? (typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments) : {};
    } catch (_) {
      return 'Ошибка: аргументы не в формате JSON';
    }
    switch (fn.name) {
      case 'list_bots': {
        const bots = this.env.listBots();
        const online = bots.filter((b) => b.state === 'online').length;
        return `Ботов: ${bots.length}, в сети: ${online}\n${bots.map((b) => `${b.nick}: ${b.state}${Number.isFinite(b.ping) ? `, пинг ${b.ping} мс` : ''}`).join('\n')}`;
      }
      case 'run_command': {
        const command = String(args.command || '').trim();
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
        return `Ошибка: нет инструмента «${fn.name}»`;
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

module.exports = { AiAgent, systemPrompt, formatResults, plainText, TOOLS, DEFAULT_BASE_URL, DEFAULT_MODEL, MAX_STEPS, FORBIDDEN_RE };
