'use strict';

// ИИ-помощник (src/ai.js): ход задания, отказы, ошибки сервиса, стоп. Сервис ИИ — подделка fetch с готовыми
// ответами: интернет-сервис (как у OpenRouter: OpenAI-совместимый chat/completions с tool_calls) и Ollama на этом
// ПК (родной API: /api/chat, /api/show, /api/pull…), боты — подделка env.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { AiAgent, systemPrompt, formatResults, plainText, fitHistory, MAX_STEPS, FORBIDDEN_RE, OLLAMA_CTX } = require(path.join(__dirname, '..', 'src', 'ai.js'));
const { catalog } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));
const { sanitize, DEFAULT_CONFIG } = require(path.join(__dirname, '..', 'src', 'config.js'));

const KEY = 'sk-or-v1-test';
let callId = 0;
const toolCall = (name, args = {}) => ({ id: `call_${(callId += 1)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const say = (content, calls) => ({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }] });
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

/** fetch-подделка: отвечает по очереди из replies (объект — 200 с этим JSON, функция — сама решает). */
function fakeFetch(replies) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, headers: opts.headers || {}, body, signal: opts.signal });
    const next = replies.shift();
    if (!next) throw new Error('лишний запрос к ИИ');
    return typeof next === 'function' ? next({ url, body, signal: opts.signal }) : json(next);
  };
  return { fetch, calls };
}

function makeEnv(bots = [{ nick: 'Farm01', state: 'online', ping: 40 }, { nick: 'Farm02', state: 'online', ping: 55 }, { nick: 'Farm03', state: 'offline', ping: null }]) {
  const commands = [];
  const env = {
    listBots: () => bots,
    runCommand: async (ids, line, signal) => {
      commands.push({ ids, line, signal });
      const who = ids || bots.filter((b) => b.state === 'online').map((b) => b.nick);
      return who.map((nick) => ({ nick, ok: true, message: [`${line}: готово у ${nick}`] }));
    },
    startBots: async (ids) => (ids ? ids.length : bots.filter((b) => b.state === 'offline').length),
    catalog,
  };
  return { env, commands };
}

function makeAgent(replies, { cfg = {}, env } = {}) {
  const fake = fakeFetch(replies);
  const e = env || makeEnv();
  const agent = new AiAgent({
    getConfig: () => ({ aiProvider: 'openai', aiBaseUrl: 'https://openrouter.ai/api/v1', aiKey: KEY, aiModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', ...cfg }),
    env: e.env,
    fetch: fake.fetch,
    timings: { retryWaitMs: 5 },
  });
  const events = [];
  for (const name of ['action', 'thought', 'done', 'error', 'state']) agent.on(name, (p) => events.push([name, p]));
  return { agent, calls: fake.calls, commands: e.commands, events };
}

test('ИИ: задание — список ботов, команда всем, итог; запрос как у OpenAI (ключ, модель, инструменты)', async () => {
  const { agent, calls, commands, events } = makeAgent([
    say('', [toolCall('list_bots')]),
    say('Беру задания у всех.', [toolCall('run_command', { bots: 'all', command: '#квесты взять' })]),
    say('Готово: Farm01 и Farm02 взяли задания, Farm03 не в сети.'),
  ]);
  const result = await agent.run('возьми задания у Фермера всеми ботами');
  assert.deepEqual({ ...result, ms: undefined }, { text: 'Готово: Farm01 и Farm02 взяли задания, Farm03 не в сети.', requests: 3, partial: false, provider: 'openai', ms: undefined });
  assert.ok(Number.isFinite(result.ms));

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.equal(calls[0].headers['X-Title'], 'MineBlaze Bot Panel');
  assert.equal(calls[0].body.model, 'nvidia/nemotron-3-ultra-550b-a55b:free');
  assert.deepEqual(calls[0].body.tools.map((t) => t.function.name), ['list_bots', 'run_command', 'start_bots', 'wait']);
  assert.equal(calls[0].body.messages[0].role, 'system');
  assert.match(calls[0].body.messages[0].content, /#квесты принести урожай награды/);
  assert.deepEqual(calls[0].body.messages[1], { role: 'user', content: 'возьми задания у Фермера всеми ботами' });

  // Ответ инструмента — в историю модели, с тем же id вызова.
  const second = calls[1].body.messages;
  const listed = second[second.length - 1];
  assert.equal(listed.role, 'tool');
  assert.equal(listed.tool_call_id, second[second.length - 2].tool_calls[0].id);
  assert.match(listed.content, /^Ботов: 3, в сети: 2\nFarm01: online, пинг 40 мс\nFarm02: online, пинг 55 мс\nFarm03: offline$/);

  assert.equal(commands.length, 1);
  assert.equal(commands[0].ids, null, 'all — все в сети');
  assert.equal(commands[0].line, '#квесты взять');
  assert.ok(commands[0].signal instanceof AbortSignal);
  const ran = calls[2].body.messages[calls[2].body.messages.length - 1].content;
  assert.equal(ran, 'Farm01: да — #квесты взять: готово у Farm01\nFarm02: да — #квесты взять: готово у Farm02');

  assert.deepEqual(events.filter(([n]) => n === 'state').map(([, p]) => p.running), [true, false]);
  assert.ok(events.some(([n, p]) => n === 'action' && p.text === 'все боты в сети (2): #квесты взять'));
  assert.ok(events.some(([n, p]) => n === 'thought' && p.text === 'Беру задания у всех.'));
  assert.equal(agent.busy, false);
});

test('ИИ: отказы — обычный текст в чат, деньги и вход, неизвестный бот; ники — в любом регистре', async () => {
  const { agent, calls, commands } = makeAgent([
    say('', [
      toolCall('run_command', { bots: 'Farm01', command: 'всем привет' }),
      toolCall('run_command', { bots: 'Farm01', command: '/pay BARABYLKAyt 100000' }),
      toolCall('run_command', { bots: 'farm01', command: '/login 12345' }),
      toolCall('run_command', { bots: 'Steve', command: '#где' }),
      toolCall('run_command', { bots: 'farm02, FARM01', command: '#где' }),
      toolCall('teleport', {}),
    ]),
    say('Сделал что мог.'),
  ]);
  await agent.run('проверка');
  const results = calls[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(results[0], /^Отказано: только команды/);
  assert.match(results[1], /^Отказано: команды денег, входа/);
  assert.match(results[2], /^Отказано: команды денег, входа/);
  assert.match(results[3], /^Ошибка: нет таких ботов: Steve \(есть: Farm01, Farm02, Farm03\)/);
  assert.equal(results[4], 'Farm02: да — #где: готово у Farm02\nFarm01: да — #где: готово у Farm01');
  assert.equal(results[5], 'Ошибка: нет инструмента «teleport»');
  assert.deepEqual(commands.map((c) => [c.ids, c.line]), [[['Farm02', 'Farm01'], '#где']], 'боты получили только разрешённое');

  for (const ok of ['/warp ah', '/home урожай', '/near', '/spawn', '/god']) assert.ok(!FORBIDDEN_RE.test(ok), ok);
  for (const bad of ['/pay a 1', '/msg Steve hi', '/m Steve hi', '/r hi', '/l pass', '/register a a', '/money', '/trade Steve']) assert.ok(FORBIDDEN_RE.test(bad), bad);
});

test('ИИ: запуск ботов и ожидание; ошибка от панели (не настроены боты) — модели текстом, а не обрыв', async () => {
  const env = makeEnv();
  env.env.startBots = async () => {
    throw new Error('Не указан ник бота');
  };
  const { agent, calls } = makeAgent([
    say('', [toolCall('start_bots', { bots: 'all' }), toolCall('wait', { seconds: 0.001 })]),
    say('Не вышло: в панели не указаны боты.'),
  ], { env });
  const result = await agent.run('запусти всех');
  assert.equal(result.partial, false);
  const results = calls[1].body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.deepEqual(results, ['Ошибка: Не указан ник бота', 'Подождал 1 с']);
});

test('ИИ: ошибки сервиса — ключ не принят, лимит (пауза, потом запасная бесплатная модель), нет ключа, занят', async () => {
  const bad = makeAgent([() => json({ error: { message: 'No auth credentials found', code: 401 } }, 401)]);
  assert.equal(await bad.agent.run('что-нибудь'), null);
  assert.match(bad.events.find(([n]) => n === 'error')[1].text, /не принял ключ \(401\)/);
  assert.equal(bad.agent.busy, false);

  const limited = makeAgent([
    () => json({ error: { message: 'Rate limit exceeded', code: 429 } }, 429),
    () => json({ error: { message: 'Rate limit exceeded', code: 429 } }, 429),
    say('Готово.'),
  ]);
  assert.equal((await limited.agent.run('что-нибудь')).text, 'Готово.');
  assert.deepEqual(limited.calls.map((c) => c.body.model), ['nvidia/nemotron-3-ultra-550b-a55b:free', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter/free']);
  assert.ok(limited.events.some(([n, p]) => n === 'action' && /пробую запасную \(openrouter\/free\)/.test(p.text)));

  const exhausted = makeAgent([429, 429, 429].map((s) => () => json({ error: { message: 'limit' } }, s)));
  assert.equal(await exhausted.agent.run('что-нибудь'), null);
  assert.match(exhausted.events.find(([n]) => n === 'error')[1].text, /лимит запросов к ИИ \(429\)/);

  const noKey = makeAgent([], { cfg: { aiKey: '' } });
  assert.throws(() => noKey.agent.run('что-нибудь'), /нет ключа ИИ/);
  assert.throws(() => noKey.agent.run('  '), /напиши, что сделать/);
  const local = makeAgent([say('Привет')], { cfg: { aiKey: '', aiBaseUrl: 'http://localhost:11434/v1' } });
  assert.equal((await local.agent.run('привет')).text, 'Привет', 'свой ПК (Ollama) — без ключа');
  assert.equal(local.calls[0].headers.Authorization, undefined);

  const busy = makeAgent([say('Готово.')]);
  const first = busy.agent.run('раз');
  assert.throws(() => busy.agent.run('два'), /уже выполняет задание/);
  await first;
});

test('ИИ: «Стоп» — запрос к сервису обрывается, итог «Остановлено»; ходы кончились — так и сказано', async () => {
  const { agent, events } = makeAgent([
    ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  ]);
  const pending = agent.run('долгое задание');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(agent.stop(), true);
  const stopped = await pending;
  assert.deepEqual([stopped.text, stopped.requests, stopped.partial], ['Остановлено', 0, true]);
  assert.ok(!events.some(([n]) => n === 'error'), 'стоп — не ошибка');
  assert.equal(agent.stop(), false, 'уже не работает');

  // Стоп, пока боты выполняют команду: сигнал уходит флоту (он пошлёт ботам «#стоп»).
  const env = makeEnv();
  let seen = null;
  env.env.runCommand = (ids, line, signal) => new Promise((resolve) => {
    seen = signal;
    signal.addEventListener('abort', () => resolve([{ nick: 'Farm01', ok: false, code: 'stopped', message: ['Остановлено'] }]));
  });
  const busy = makeAgent([say('', [toolCall('run_command', { bots: 'Farm01', command: '#квесты принести' })])], { env });
  const running = busy.agent.run('принеси');
  await new Promise((r) => setTimeout(r, 20));
  busy.agent.stop();
  assert.equal((await running).text, 'Остановлено');
  assert.equal(seen.aborted, true);

  const loop = makeAgent(Array.from({ length: MAX_STEPS }, () => say('', [toolCall('list_bots')])));
  const r = await loop.agent.run('по кругу');
  assert.equal(r.partial, true);
  assert.match(r.text, /^Ходы кончились \(12 на задание\)/);
  assert.equal(r.requests, MAX_STEPS);
});

test('ИИ: список моделей — только бесплатные и умеющие вызывать инструменты', async () => {
  const { agent, calls } = makeAgent([{
    data: [
      { id: 'nvidia/nemotron-3-ultra-550b-a55b:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools', 'temperature'] },
      { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] },
      { id: 'some/paid-model', pricing: { prompt: '0.000001', completion: '0.000002' }, supported_parameters: ['tools'] },
      { id: 'some/free-no-tools:free', pricing: { prompt: '0', completion: '0' }, supported_parameters: ['temperature'] },
      { id: 'openrouter/auto', pricing: { prompt: '-1', completion: '-1' }, supported_parameters: ['tools'] },
    ],
  }]);
  assert.deepEqual(await agent.listModels(), ['nvidia/nemotron-3-ultra-550b-a55b:free', 'openrouter/free']);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/models');

  // Сервис без цен (Ollama и т.п.) — все модели.
  const local = makeAgent([{ data: [{ id: 'qwen3:8b' }, { id: 'llama3.1' }] }], { cfg: { aiBaseUrl: 'http://127.0.0.1:11434/v1/' } });
  assert.deepEqual(await local.agent.listModels(), ['qwen3:8b', 'llama3.1']);
  assert.equal(local.calls[0].url, 'http://127.0.0.1:11434/v1/models');
});

test('ИИ: подсказка модели — все команды ботов с правилами NPC; ответы многих ботов — коротко', () => {
  const prompt = systemPrompt(catalog());
  for (const c of catalog()) assert.ok(prompt.includes(c.usage[0]), c.usage[0]);
  assert.match(prompt, /Правила: .*Алхимик/);
  assert.match(prompt, /\/warp ah/);

  // Одинаковые ответы многих ботов — одной строкой; разные — каждый целиком.
  const many = Array.from({ length: 30 }, (_, i) => ({ nick: `Farm${i + 1}`, ok: i % 10 !== 3, message: [i % 10 === 3 ? 'после /warp ah телепорта не было' : '| Перемещение на ah.'] }));
  assert.equal(formatResults(many), [
    'Ботов: 30, вышло у 27, не вышло у 3',
    'Farm1, Farm2, Farm3, Farm5, Farm6 и ещё 22: да — | Перемещение на ah.',
    'Farm4, Farm14, Farm24: НЕТ — после /warp ah телепорта не было',
  ].join('\n'));
  const quests = ['Фермер › Уровень 1 → 2, заданий: 4', '1. Ночная прополка — 64/224', '2. Ягодный запас — 0/128', '3. Купите на 0/12000', '4. Проведите 1 ч из 3 ч'];
  assert.equal(formatResults([{ nick: 'Farm01', ok: true, message: quests }]), `Farm01: да\n${quests.map((l) => `  ${l}`).join('\n')}`, 'все строки, а не начало');
  assert.equal(formatResults([]), 'Некому отдать команду: ни одного бота в сети');
});

test('ИИ: итог — простым текстом (Markdown модели убирается, команды «#…» остаются)', () => {
  const md = '## Итог\n\n**Задания Фермера** у ботов (Farm01, Farm02):\n\n* **Ночная прополка** — *(взято)*\n* `#квесты взять` — взять остальные\n#квесты принести урожай награды';
  assert.equal(plainText(md), 'Итог\n\nЗадания Фермера у ботов (Farm01, Farm02):\n\n- Ночная прополка — (взято)\n- #квесты взять — взять остальные\n#квесты принести урожай награды');
  assert.equal(plainText('2 * 3 = 6, а 5*4 — 20'), '2 * 3 = 6, а 5*4 — 20', 'умножение — не курсив');
});

test('настройки ИИ: адрес — только https (http — лишь свой ПК), ключ без пробелов, пустая модель — по умолчанию', () => {
  assert.equal(sanitize({ aiBaseUrl: ' https://openrouter.ai/api/v1/ ' }).aiBaseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(sanitize({ aiBaseUrl: 'http://localhost:11434/v1' }).aiBaseUrl, 'http://localhost:11434/v1');
  assert.equal(sanitize({ aiBaseUrl: 'http://evil.example/v1' }).aiBaseUrl, undefined, 'ключ по сети открытым текстом — нет');
  assert.equal(sanitize({ aiBaseUrl: 'javascript:alert(1)' }).aiBaseUrl, undefined);
  assert.equal(sanitize({ aiBaseUrl: '' }).aiBaseUrl, DEFAULT_CONFIG.aiBaseUrl);
  assert.equal(sanitize({ aiKey: ' sk-or-v1-abc\n' }).aiKey, 'sk-or-v1-abc');
  assert.equal(sanitize({ aiModel: '  ' }).aiModel, DEFAULT_CONFIG.aiModel);
  assert.equal(sanitize({ aiModel: ' openrouter/free ' }).aiModel, 'openrouter/free');

  // Ollama: по умолчанию ИИ — на этом ПК; адрес — этот ПК или другой в домашней сети (ключа у Ollama нет).
  assert.equal(DEFAULT_CONFIG.aiProvider, 'ollama');
  assert.equal(sanitize({ aiProvider: 'openai' }).aiProvider, 'openai');
  assert.equal(sanitize({ aiProvider: 'cloud' }).aiProvider, undefined);
  assert.equal(sanitize({ ollamaUrl: ' http://192.168.1.5:11434/ ' }).ollamaUrl, 'http://192.168.1.5:11434');
  assert.equal(sanitize({ ollamaUrl: 'http://localhost:11434' }).ollamaUrl, 'http://localhost:11434');
  assert.equal(sanitize({ ollamaUrl: 'http://example.com:11434' }).ollamaUrl, undefined, 'чужой адрес по http — нет');
  assert.equal(sanitize({ ollamaUrl: '' }).ollamaUrl, DEFAULT_CONFIG.ollamaUrl);
  assert.equal(sanitize({ ollamaModel: '  ' }).ollamaModel, DEFAULT_CONFIG.ollamaModel);
  assert.equal(sanitize({ ollamaModel: ' qwen3:8b ' }).ollamaModel, 'qwen3:8b');
});

// ---------- Ollama на этом ПК (родной API) ----------

const ocall = (name, args = {}) => ({ function: { name, arguments: args } });
const osay = (content, calls) => ({ model: 'qwen3:4b-instruct', message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) }, done: true, done_reason: 'stop' });

/** Ollama-подделка по адресам: /api/version, /api/tags, /api/show, /api/pull (NDJSON), /api/chat (ответы по очереди). */
function fakeOllama({ running = true, models = { 'qwen3:4b-instruct': ['completion', 'tools'] }, chats = [], pull = null } = {}) {
  const state = { running, models: { ...models } };
  const calls = [];
  const fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ path: u.pathname, url, headers: opts.headers || {}, body, signal: opts.signal });
    if (!state.running) throw new TypeError('fetch failed'); // порт закрыт, как у net.fetch: ERR_CONNECTION_REFUSED
    switch (u.pathname) {
      case '/api/version': return json({ version: '0.40.14' });
      case '/api/tags': return json({ models: Object.keys(state.models).map((name) => ({ name, model: name, size: 2.5e9 })) });
      case '/api/show': {
        const caps = state.models[body.model];
        return caps ? json({ capabilities: caps, details: { parameter_size: '4.0B' } }) : json({ error: `model '${body.model}' not found` }, 404);
      }
      case '/api/pull': return pull({ body, signal: opts.signal, state });
      case '/api/chat': {
        const next = chats.shift();
        if (!next) throw new Error('лишний запрос к ИИ');
        return typeof next === 'function' ? next({ body, signal: opts.signal }) : json(next);
      }
      default: return json({ error: 'not found' }, 404);
    }
  };
  return { fetch, calls, state };
}

/** Тело ответа /api/pull — строки NDJSON; hang — не заканчивать, пока не оборвут (signal). */
function ndjson(lines, { signal, hang = false } = {}) {
  const enc = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const l of lines) controller.enqueue(enc.encode(`${JSON.stringify(l)}\n`));
      if (!hang) controller.close();
      else if (signal) signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    },
  }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

function makeLocal(fake, { cfg = {}, env, timings = {} } = {}) {
  const e = env || makeEnv();
  const agent = new AiAgent({
    getConfig: () => ({ aiProvider: 'ollama', ollamaUrl: 'http://127.0.0.1:11434', ollamaModel: 'qwen3:4b-instruct', ...cfg }),
    env: e.env,
    fetch: fake.fetch,
    timings: { retryWaitMs: 5, startWaitMs: 300, pollMs: 5, stallMs: 60, ...timings },
  });
  const events = [];
  for (const name of ['action', 'thought', 'progress', 'done', 'error', 'state']) agent.on(name, (p) => events.push([name, p]));
  return { agent, events, commands: e.commands, env: e.env };
}

const errorOf = (events) => (events.find(([n]) => n === 'error') || [null, {}])[1].text;

test('Ollama: родной API — окно контекста, инструменты, ответ инструмента по имени, без ключа', async () => {
  const fake = fakeOllama({
    chats: [
      osay('', [ocall('list_bots')]),
      osay('Беру задания.', [ocall('run_command', { bots: 'all', command: '#квесты взять' })]),
      osay('Готово: Farm01 и Farm02 взяли задания.'),
    ],
  });
  const { agent, events, commands } = makeLocal(fake);
  const result = await agent.run('возьми задания у Фермера всеми ботами');
  assert.deepEqual([result.text, result.provider, result.requests, result.partial], ['Готово: Farm01 и Farm02 взяли задания.', 'ollama', 3, false]);

  assert.deepEqual(fake.calls.map((c) => c.path), ['/api/version', '/api/show', '/api/chat', '/api/chat', '/api/chat']);
  const chat = fake.calls.filter((c) => c.path === '/api/chat');
  assert.equal(chat[0].url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(chat[0].headers.Authorization, undefined, 'ключ Ollama не нужен');
  assert.equal(chat[0].body.model, 'qwen3:4b-instruct');
  assert.equal(chat[0].body.stream, false);
  assert.equal(chat[0].body.options.num_ctx, OLLAMA_CTX, 'окно контекста больше 4096 по умолчанию');
  assert.ok(chat[0].body.keep_alive);
  assert.equal('think' in chat[0].body, false, 'модель не умеет думать вслух — think не шлём');
  assert.deepEqual(chat[0].body.tools.map((t) => t.function.name), ['list_bots', 'run_command', 'start_bots', 'wait']);
  assert.match(chat[0].body.messages[0].content, /#квесты принести урожай награды/);

  const hist = chat[2].body.messages;
  assert.deepEqual(hist[hist.length - 2].tool_calls, [{ type: 'function', function: { name: 'run_command', arguments: { bots: 'all', command: '#квесты взять' } } }]);
  assert.deepEqual(hist[hist.length - 1], { role: 'tool', tool_name: 'run_command', content: 'Farm01: да — #квесты взять: готово у Farm01\nFarm02: да — #квесты взять: готово у Farm02' });
  assert.deepEqual(chat[1].body.messages[chat[1].body.messages.length - 1].tool_name, 'list_bots');
  assert.deepEqual(commands.map((c) => [c.ids, c.line]), [[null, '#квесты взять']]);
  assert.ok(events.some(([n, p]) => n === 'progress' && /^ИИ думает… Первое задание на процессоре/.test(p.text)));
  assert.ok(events.some(([n, p]) => n === 'progress' && p.text === 'ИИ думает… (ход 2)'));
});

test('Ollama: модель, которая думает вслух, — без размышлений (think: false); команда в кавычках — без кавычек', async () => {
  const fake = fakeOllama({
    models: { 'qwen3:4b': ['completion', 'tools', 'thinking'] },
    chats: [osay('', [ocall('run_command', { bots: 'Farm01', command: '"#где"' })]), osay('<think>хм</think>Farm01 на спавне.')],
  });
  const { agent, commands } = makeLocal(fake, { cfg: { ollamaModel: 'qwen3:4b' } });
  assert.equal((await agent.run('где Farm01?')).text, 'Farm01 на спавне.');
  assert.equal(fake.calls.find((c) => c.path === '/api/chat').body.think, false);
  assert.deepEqual(commands.map((c) => c.line), ['#где']);
});

test('Ollama не запущена — панель запускает её; модели нет — скачивает (ход в процентах), потом задание', async () => {
  const fake = fakeOllama({
    running: false,
    models: {},
    chats: [osay('Готово.')],
    pull: ({ body, state }) => {
      state.models[body.model] = ['completion', 'tools'];
      const layer = (completed) => ({ status: 'pulling 85e4a5b7b8ef', digest: 'sha256:85e4', total: 2500000000, completed });
      return ndjson([
        { status: 'pulling manifest' }, layer(0), layer(700000000), layer(1300000000), layer(2500000000),
        { status: 'pulling eade0a07cac7', digest: 'sha256:eade', total: 1200, completed: 1200 },
        { status: 'verifying sha256 digest' }, { status: 'writing manifest' }, { status: 'success' },
      ]);
    },
  });
  const env = makeEnv();
  let launched = 0;
  env.env.startOllama = async () => {
    launched += 1;
    setTimeout(() => {
      fake.state.running = true; // программа запускается не сразу
    }, 20);
    return true;
  };
  const { agent, events } = makeLocal(fake, { env });
  const result = await agent.run('сколько ботов в сети?');
  assert.equal(result.text, 'Готово.');
  assert.equal(launched, 1);
  assert.deepEqual(fake.calls.find((c) => c.path === '/api/pull').body, { model: 'qwen3:4b-instruct', stream: true });
  const actions = events.filter(([n]) => n === 'action').map(([, p]) => p.text);
  assert.ok(actions.includes('Ollama не была запущена — запустил'), actions.join('\n'));
  assert.ok(actions.some((t) => /^модели qwen3:4b-instruct ещё нет — скачиваю/.test(t)));
  assert.ok(actions.includes('модель qwen3:4b-instruct: скачано 25 % (0,7 из 2,5 ГБ)'), actions.join('\n'));
  assert.ok(actions.includes('модель qwen3:4b-instruct: скачано 50 % (1,3 из 2,5 ГБ)'));
  assert.ok(actions.some((t) => /^модель qwen3:4b-instruct скачана за \d+ с$/.test(t)));
  const progress = events.filter(([n]) => n === 'progress').map(([, p]) => p.text);
  assert.ok(progress.includes('Запускаю Ollama…'));
  assert.ok(progress.includes('Скачиваю модель qwen3:4b-instruct: 100 % (2,5 из 2,5 ГБ)'), progress.join('\n'));
});

test('Ollama: скачивание модели — скорость и сколько осталось (часы подменены)', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000000 });
  const total = 2500000000;
  // Скачано через каждые 10 с. Поток просит следующую порцию, когда предыдущую забрали, но ещё не разобрали, —
  // часы сдвигаются перед каждой следующей порцией: строка с 0 разбирается на 10-й секунде, со 100 МБ — на 20-й…
  const steps = [0, 100e6, 200e6, 1250e6];
  const enc = new TextEncoder();
  const fake = fakeOllama({
    models: {},
    chats: [osay('Готово.')],
    pull: ({ body, state }) => {
      state.models[body.model] = ['completion', 'tools'];
      let i = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (i > 0) t.mock.timers.tick(10000);
          if (i < steps.length) {
            controller.enqueue(enc.encode(`${JSON.stringify({ status: 'pulling 85e4', digest: 'sha256:85e4', total, completed: steps[i] })}\n`));
          } else {
            controller.enqueue(enc.encode('{"status":"success"}\n'));
            controller.close();
          }
          i += 1;
        },
      }), { status: 200 });
    },
  });
  const { agent, events } = makeLocal(fake);
  assert.equal((await agent.run('привет')).text, 'Готово.');
  const progress = events.filter(([n]) => n === 'progress').map(([, p]) => p.text);
  assert.ok(progress.includes('Скачиваю модель qwen3:4b-instruct: 0 % (0,0 из 2,5 ГБ)'), progress.join('\n'));
  assert.ok(progress.includes('Скачиваю модель qwen3:4b-instruct: 4 % (0,1 из 2,5 ГБ, 10,0 МБ/с, осталось ≈ 4 мин)'), progress.join('\n'));
  assert.ok(progress.includes('Скачиваю модель qwen3:4b-instruct: 50 % (1,3 из 2,5 ГБ, 41,7 МБ/с, осталось ≈ 30 с)'), progress.join('\n'));
});

test('Ollama: не установлена, на другом ПК не отвечает, модель без инструментов, нет памяти — понятные причины', async () => {
  const none = makeEnv();
  none.env.startOllama = async () => false;
  const missing = makeLocal(fakeOllama({ running: false }), { env: none });
  assert.equal(await missing.agent.run('привет'), null);
  assert.match(errorOf(missing.events), /^Ollama не установлена — скачай её с ollama\.com/);
  assert.equal(missing.agent.busy, false);

  const remoteEnv = makeEnv();
  remoteEnv.env.startOllama = async () => assert.fail('чужой ПК панель не запускает');
  const remote = makeLocal(fakeOllama({ running: false }), { env: remoteEnv, cfg: { ollamaUrl: 'http://192.168.1.5:11434' } });
  assert.equal(await remote.agent.run('привет'), null);
  assert.match(errorOf(remote.events), /не отвечает по адресу http:\/\/192\.168\.1\.5:11434/);

  const noTools = makeLocal(fakeOllama({ models: { 'gemma3:4b': ['completion', 'vision'] } }), { cfg: { ollamaModel: 'gemma3:4b' } });
  assert.equal(await noTools.agent.run('привет'), null);
  assert.match(errorOf(noTools.events), /модель gemma3:4b не умеет вызывать команды \(tools\)/);

  const memory = makeLocal(fakeOllama({ chats: [() => json({ error: 'model requires more system memory (5.1 GiB) than is available (3.2 GiB)' }, 500)] }));
  assert.equal(await memory.agent.run('привет'), null);
  assert.match(errorOf(memory.events), /^не хватает памяти для модели qwen3:4b-instruct/);
});

test('Ollama: скачивание — нет такой модели, «Стоп» посреди, застряло без данных', async () => {
  const typo = makeLocal(fakeOllama({
    models: {},
    pull: () => ndjson([{ status: 'pulling manifest' }, { error: 'pull model manifest: file does not exist' }]),
  }), { cfg: { ollamaModel: 'qwen3:4b-instrukt' } });
  assert.equal(await typo.agent.run('привет'), null);
  assert.match(errorOf(typo.events), /^в Ollama нет модели «qwen3:4b-instrukt»/);

  const half = (signal) => ndjson([{ status: 'pulling 85e4', digest: 'sha256:85e4', total: 2500000000, completed: 100000000 }], { signal, hang: true });
  const stopped = makeLocal(fakeOllama({ models: {}, pull: ({ signal }) => half(signal) }), { timings: { stallMs: 60 * 1000 } });
  const running = stopped.agent.run('привет');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(stopped.agent.stop(), true);
  assert.equal((await running).text, 'Остановлено');
  assert.ok(!stopped.events.some(([n]) => n === 'error'));

  const stuck = makeLocal(fakeOllama({ models: {}, pull: ({ signal }) => half(signal) }), { timings: { stallMs: 40 } });
  assert.equal(await stuck.agent.run('привет'), null);
  assert.match(errorOf(stuck.events), /^скачивание модели qwen3:4b-instruct застряло/);
});

test('Ollama: состояние для панели и список моделей; «qwen3» — это «qwen3:latest»', async () => {
  const off = makeLocal(fakeOllama({ running: false }));
  off.env.ollamaInstalled = () => true;
  assert.deepEqual(await off.agent.status(), {
    provider: 'ollama', model: 'qwen3:4b-instruct', url: 'http://127.0.0.1:11434', local: true, gpu: true, running: false, installed: true,
  });

  const on = makeLocal(fakeOllama({ models: { 'qwen3:latest': ['completion', 'tools'] } }), { cfg: { ollamaModel: 'qwen3' } });
  const s = await on.agent.status();
  assert.deepEqual([s.running, s.version, s.hasModel, s.models], [true, '0.40.14', true, ['qwen3:latest']]);
  assert.deepEqual(await on.agent.listModels(), ['qwen3:latest', 'qwen3:4b-instruct'], 'скачанные и рекомендуемая');

  const fresh = makeLocal(fakeOllama({ models: {} }));
  assert.equal((await fresh.agent.status()).hasModel, false);

  const online = makeAgent([], { cfg: { aiKey: '' } });
  assert.equal((await online.agent.status()).keyMissing, true, 'интернет-сервис без ключа');
});

test('Ollama упала на видеокарте (старый драйвер) — тот же ход на процессоре, панель запоминает', async () => {
  // Так падала Ollama 0.40 на GTX 1060 с драйвером 560.94.
  const crash = 'llama-server process has terminated: exit status 0xc0000409: The system detected an overrun of a stack-based buffer in this application.: CUDA error: the provided PTX was compiled with an unsupported toolchain.';
  const fake = fakeOllama({ chats: [() => json({ error: crash }, 500), osay('', [ocall('list_bots')]), osay('В сети двое.')] });
  const env = makeEnv();
  let disabled = 0;
  env.env.disableGpu = () => {
    disabled += 1;
  };
  const { agent, events } = makeLocal(fake, { env });
  const result = await agent.run('сколько ботов в сети?');
  assert.deepEqual([result.text, result.requests], ['В сети двое.', 2], 'упавший ход — не ход');
  const chats = fake.calls.filter((c) => c.path === '/api/chat');
  assert.deepEqual(chats.map((c) => c.body.options.num_gpu), [undefined, 0, 0], 'сначала — как решит Ollama, потом только процессор');
  assert.equal(disabled, 1);
  assert.ok(events.some(([n, p]) => n === 'action' && /^видеокарта не подошла Ollama/.test(p.text)));

  // Видеокарта выключена в настройках — сразу процессор; другие ошибки — без повтора.
  const cpu = makeLocal(fakeOllama({ chats: [osay('Ок')] }), { cfg: { ollamaGpu: false } });
  await cpu.agent.run('привет');
  assert.equal(cpu.agent.getConfig().ollamaGpu, false);
  const noRetry = makeLocal(fakeOllama({ chats: [() => json({ error: 'model requires more system memory (5.1 GiB) than is available (3.2 GiB)' }, 500)] }));
  assert.equal(await noRetry.agent.run('привет'), null);
  assert.match(errorOf(noRetry.events), /^не хватает памяти/);
});

test('Ollama: длинная история — старые ответы ботов сокращаются, подсказка, задание и два последних ответа целы', () => {
  const big = 'x'.repeat(5000);
  const msgs = [
    { role: 'system', content: 'S'.repeat(6000) },
    { role: 'user', content: 'задание' },
    { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'list_bots', arguments: {} } }] },
    { role: 'tool', tool_name: 'list_bots', content: big },
    { role: 'tool', tool_name: 'run_command', content: big },
    { role: 'tool', tool_name: 'run_command', content: big },
    { role: 'tool', tool_name: 'run_command', content: big },
  ];
  const total = fitHistory(msgs, 18000);
  assert.ok(total <= 18000, String(total));
  assert.match(msgs[3].content, /старый ответ сокращён/);
  assert.match(msgs[4].content, /старый ответ сокращён/);
  assert.deepEqual([msgs[5].content, msgs[6].content], [big, big]);
  assert.deepEqual([msgs[0].content.length, msgs[1].content], [6000, 'задание']);
  assert.equal(fitHistory(msgs, 100000), total, 'влезает — не трогаем');
});
