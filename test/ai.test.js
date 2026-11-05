'use strict';

// ИИ-помощник (src/ai.js): ход задания, отказы, ошибки сервиса, стоп. Сервис ИИ — подделка fetch с готовыми
// ответами (как у OpenRouter: OpenAI-совместимый chat/completions с tool_calls), боты — подделка env.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { AiAgent, systemPrompt, formatResults, plainText, MAX_STEPS, FORBIDDEN_RE } = require(path.join(__dirname, '..', 'src', 'ai.js'));
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
    getConfig: () => ({ aiBaseUrl: 'https://openrouter.ai/api/v1', aiKey: KEY, aiModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', ...cfg }),
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
  assert.deepEqual(result, { text: 'Готово: Farm01 и Farm02 взяли задания, Farm03 не в сети.', requests: 3, partial: false });

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
  assert.deepEqual(await pending, { text: 'Остановлено', requests: 0, partial: true });
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
});
