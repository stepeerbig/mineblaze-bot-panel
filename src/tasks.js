'use strict';

// Задачи ботам. У каждого бота — своя очередь задач; задача — цепочка шагов, по одному в строке:
//   #команда боту       — ждём, пока бот её закончит (#добудь алмазы 5, #положи склад, #квесты принести…);
//   /команда серверу    — отправить и подождать пару секунд (/home база, /g5…);
//   скажи текст         — сообщение в чат;
//   ждать 30 / ждать 2 мин / пауза 1 ч — пауза.
// Задачи идут сами. Бот не в сети (вылетел, переподключается, панель перезапустили) — задача ждёт, пока он снова войдёт
// и будет готов (вход с паролем и команды после входа прошли), и продолжает с того же шага; шаг, который знает, где
// остановился (#добудь — сколько руды ещё осталось), продолжает с этого места. «По кругу» — после последнего шага снова
// с первого. Пауза, продолжить, убрать — у одной задачи или у всех. Задачи хранятся в файле (store): после перезапуска
// панели они продолжаются. Ботами задачи управляют через fleet (src/fleet.js): isReady, commandOne, say, события
// 'ready' и 'state'.

const EventEmitter = require('events');
const { maskSecrets } = require('./chat-utils');

const DEFAULT_TIMINGS = Object.freeze({
  second: 1000, // столько мс в «секунде» шага «ждать» (в тестах — меньше)
  serverGap: 2000, // после «/…» или «скажи» — пауза: следующая команда сразу за другой MineBlaze молча пропускает
  retryMs: 5000, // шаг прервался, а бот в сети (смена мира, телепорт) — повторить через столько
  saveDelay: 500, // сохранять в файл не чаще
});
const MAX_STEPS = 30;
const MAX_TASKS_PER_BOT = 20;
const MAX_INTERRUPTS = 5; // столько раз подряд шаг прервался при боте в сети — это уже ошибка, а не случайность
const KEEP_FINISHED = 40; // готовых задач в списке — не больше (старые уходят)
const MAX_WAIT_MS = 24 * 3600 * 1000;
// Пароли в задачах не храним (файл задач не шифруется): вход и регистрацию делает автовход.
const SECRET_CMD_RE = /^\/(?:l|login|log|reg|register|changepass(?:word)?|cp|unregister)(?:\s|$)/i;
const WAIT_RE = /^(?:ждать|жди|подождать|пауза|wait)\s+(\d+(?:[.,]\d+)?)\s*(с|сек|секунд[аы]?|s|sec|м|мин|минут[аы]?|m|min|ч|час|часа|часов|h)?\.?$/i;
const SAY_RE = /^(?:скажи|сказать|say)\s+(.+)$/i;
const STATES = Object.freeze({
  queued: 'в очереди',
  running: 'идёт',
  waiting: 'ждёт бота',
  paused: 'пауза',
  error: 'ошибка',
  done: 'готово',
});

/** Шаги задачи из текста (по одному в строке). → [{ line, kind: 'cmd' | 'server' | 'chat' | 'wait', ms?, text? }]; ошибка — Error с понятным текстом. */
function parseSteps(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'));
  if (!lines.length) throw new Error('впиши шаги задачи — по одному в строке: #добудь алмазы 5, /home база, ждать 2 мин');
  if (lines.length > MAX_STEPS) throw new Error(`шагов не больше ${MAX_STEPS}`);
  return lines.map((line) => {
    if (line.startsWith('#')) return { line, kind: 'cmd' };
    if (line.startsWith('/')) {
      if (SECRET_CMD_RE.test(line)) throw new Error(`«${line.split(/\s/)[0]}» в задачах нельзя: пароли в задачах не храню — вход и регистрацию делает автовход`);
      return { line, kind: 'server' };
    }
    const w = line.match(WAIT_RE);
    if (w) {
      const n = parseFloat(w[1].replace(',', '.'));
      const unit = (w[2] || 'с').toLowerCase();
      const mult = /^(?:ч|час|часа|часов|h)$/.test(unit) ? 3600 : /^(?:м|мин|минут[аы]?|m|min)$/.test(unit) ? 60 : 1;
      const seconds = n * mult;
      if (!(seconds >= 1) || seconds * 1000 > MAX_WAIT_MS) throw new Error(`«${line}»: пауза — от 1 секунды до 24 часов`);
      return { line, kind: 'wait', seconds };
    }
    const say = line.match(SAY_RE);
    if (say) return { line, kind: 'chat', text: say[1] };
    throw new Error(`строка «${line}»: шаг — это #команда боту, /команда серверу, «скажи текст» или «ждать 30» (секунд; «ждать 2 мин»)`);
  });
}

const shortLine = (line, max = 60) => {
  const s = maskSecrets(String(line || ''));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
const firstLine = (message) => String([].concat(message || [])[0] || '').trim();
const errText = (err) => (err && err.message ? err.message : String(err));

class TaskBoard extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} opts.fleet   isReady(id), get(id), list(), commandOne(id, line, { signal }), say(id, text); события 'ready', 'state'
   * @param {object} [opts.store] { load() → { tasks }, save(state) } — файл задач
   * @param {object} [opts.timings]
   */
  constructor({ fleet, store = null, timings = {} } = {}) {
    super();
    this.fleet = fleet;
    this.store = store;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.tasks = []; // по порядку добавления; у каждого бота идёт первая незаконченная
    this.running = new Map(); // номер бота → { task, ctrl }
    this.retryTimers = new Map(); // номер бота → таймер повтора
    this.nextId = 1;
    this.saveTimer = null;
    this.closed = false;
    this.onReady = (p) => this._pump(p && p.bot);
    this.onState = (p) => {
      if (p && p.bot && p.state !== 'online' && p.state !== 'connected') this._markWaiting(p.bot);
    };
  }

  /** Загрузить задачи из файла и начать. Шаг, который шёл при закрытии панели, продолжится, когда бот будет готов. */
  start() {
    if (this.store) {
      try {
        const saved = this.store.load();
        for (const t of (saved && Array.isArray(saved.tasks) ? saved.tasks : [])) {
          if (!t || !t.bot || !Array.isArray(t.steps) || !t.steps.length) continue;
          const task = { ...t, id: String(this.nextId++) };
          if (task.state === 'running' || task.state === 'queued') task.state = 'waiting';
          if (task.state === 'waiting') task.note = 'ждёт бота: панель перезапущена';
          this.tasks.push(task);
        }
      } catch (_) {
        // файла ещё нет или испорчен — начинаем с пустого списка
      }
    }
    this.fleet.on('ready', this.onReady);
    this.fleet.on('state', this.onState);
    for (const bot of this._bots()) this._pump(bot);
    this._changed();
  }

  stop() {
    this.closed = true;
    this.fleet.removeListener('ready', this.onReady);
    this.fleet.removeListener('state', this.onState);
    for (const t of this.retryTimers.values()) clearTimeout(t);
    this.retryTimers.clear();
    for (const r of this.running.values()) r.ctrl.abort();
    this._saveNow();
  }

  /**
   * Добавить задачу ботам (номера ботов). text — шаги по строке; repeat — по кругу. → { added, tasks } или Error.
   */
  add(bots, text, { repeat = false } = {}) {
    const steps = parseSteps(text);
    const ids = [...new Set((bots || []).map((b) => String(b || '').toLowerCase()).filter(Boolean))];
    if (!ids.length) throw new Error('кому? Выбери бота в списке или «всем»');
    const known = ids.map((id) => this.fleet.get(id)).filter(Boolean);
    for (const b of known) {
      if (this.tasks.filter((t) => t.bot === b.bot && t.state !== 'done').length >= MAX_TASKS_PER_BOT) {
        throw new Error(`у ${b.nick} уже ${MAX_TASKS_PER_BOT} задач — убери ненужные`);
      }
    }
    const added = [];
    for (const b of known) {
      const bot = b.bot;
      const task = {
        id: String(this.nextId++), bot, nick: b.nick, steps: steps.map((s) => ({ ...s })), step: 0, state: 'queued', note: '',
        repeat: Boolean(repeat), rounds: 0, resumeLine: null, waitUntil: null, interrupts: 0, created: Date.now(), updated: Date.now(),
      };
      this.tasks.push(task);
      added.push(task);
    }
    if (!added.length) throw new Error('этих ботов нет в списке');
    for (const t of added) this._pump(t.bot);
    this._changed();
    return { added: added.length, tasks: added.map((t) => this._view(t)) };
  }

  /** Список для окна: [{ id, bot, nick, state, stateText, steps, step, total, current, note, repeat, rounds }]. */
  list() {
    return this.tasks.map((t) => this._view(t));
  }

  /** Есть ли у бота незаконченные задачи (автопилот его тогда не трогает). */
  hasWork(bot) {
    const id = String(bot || '').toLowerCase();
    return this.tasks.some((t) => t.bot === id && t.state !== 'done');
  }

  summary() {
    const out = { total: 0, running: 0, waiting: 0, queued: 0, paused: 0, error: 0, done: 0 };
    for (const t of this.tasks) {
      out.total += 1;
      out[t.state] += 1;
    }
    return out;
  }

  /** Пауза: задача (id) или все (id не задан). Шаг, который идёт, прерывается (боту — #стоп). */
  pause(id = null) {
    let n = 0;
    for (const t of this._pick(id)) {
      if (t.state === 'done' || t.state === 'paused') continue;
      t.state = 'paused';
      t.note = 'пауза';
      t.updated = Date.now();
      this._abort(t);
      n += 1;
    }
    if (n) this._changed();
    return n;
  }

  /** Продолжить задачу (id) или все: с того же шага (после ошибки — повторить его). */
  resume(id = null) {
    let n = 0;
    for (const t of this._pick(id)) {
      if (t.state !== 'paused' && t.state !== 'error') continue;
      t.state = 'queued';
      t.note = '';
      t.interrupts = 0;
      t.updated = Date.now();
      n += 1;
    }
    for (const bot of new Set(this._pick(id).map((t) => t.bot))) this._pump(bot);
    if (n) this._changed();
    return n;
  }

  /** Убрать задачу (id) или все; done — только готовые. */
  cancel(id = null, { done = false } = {}) {
    const gone = this._pick(id).filter((t) => !done || t.state === 'done');
    for (const t of gone) {
      t.state = 'done';
      t.cancelled = true;
      this._abort(t);
    }
    const set = new Set(gone);
    this.tasks = this.tasks.filter((t) => !set.has(t));
    for (const bot of new Set(gone.map((t) => t.bot))) this._pump(bot);
    if (gone.length) this._changed();
    return gone.length;
  }

  // ---------- внутреннее ----------

  _pick(id) {
    return id === null || id === undefined ? this.tasks.slice() : this.tasks.filter((t) => t.id === String(id));
  }

  _bots() {
    return [...new Set(this.tasks.map((t) => t.bot))];
  }

  _view(t) {
    const step = t.steps[Math.min(t.step, t.steps.length - 1)];
    let current = '';
    if (t.state !== 'done' && step) {
      current = shortLine(t.resumeLine || step.line);
      if (step.kind === 'wait' && t.waitUntil && t.state === 'running') {
        const left = Math.max(0, Math.round((t.waitUntil - Date.now()) / this.timings.second));
        current = `${current} (ещё ${left >= 120 ? `${Math.round(left / 60)} мин` : `${left} с`})`;
      } else if (t.resumeLine) {
        current = `${current} (продолжение)`;
      }
    }
    return {
      id: t.id, bot: t.bot, nick: t.nick, state: t.state, stateText: STATES[t.state] || t.state,
      steps: t.steps.map((s) => shortLine(s.line, 40)), step: Math.min(t.step + 1, t.steps.length), total: t.steps.length,
      current, note: t.note || '', repeat: t.repeat, rounds: t.rounds,
    };
  }

  _abort(t) {
    const r = this.running.get(t.bot);
    if (r && r.task === t) r.ctrl.abort();
  }

  /** Бот ушёл из сети: его задача, ждущая очереди, — «ждёт бота» (идущая узнает сама, когда шаг прервётся). */
  _markWaiting(bot) {
    let changed = false;
    for (const t of this.tasks) {
      if (t.bot === bot && t.state === 'queued') {
        t.state = 'waiting';
        t.note = 'ждёт бота: не в сети';
        changed = true;
      }
    }
    if (changed) this._changed();
  }

  /** У бота свободно и он готов — начать (или продолжить) его первую незаконченную задачу. */
  _pump(bot) {
    if (this.closed || !bot || this.running.has(bot) || this.retryTimers.has(bot)) return;
    const task = this.tasks.find((t) => t.bot === bot && t.state !== 'done');
    if (!task || task.state === 'paused' || task.state === 'error') return; // очередь бота стоит, пока человек не решит
    if (!this.fleet.get(bot)) {
      if (task.note !== 'ждёт бота: его нет в списке ботов') {
        task.state = 'waiting';
        task.note = 'ждёт бота: его нет в списке ботов';
        this._changed();
      }
      return;
    }
    if (!this.fleet.isReady(bot)) {
      if (task.state !== 'waiting') {
        task.state = 'waiting';
        task.note = 'ждёт бота: не в сети';
        this._changed();
      }
      return;
    }
    this._run(task).catch((err) => this._log('error', `Задача: ${errText(err)}`, task));
  }

  async _run(task) {
    const ctrl = new AbortController();
    this.running.set(task.bot, { task, ctrl });
    task.state = 'running';
    task.note = '';
    task.updated = Date.now();
    this._changed();
    try {
      while (!ctrl.signal.aborted && task.state === 'running') {
        if (task.step >= task.steps.length) {
          if (!task.repeat) {
            task.state = 'done';
            task.note = task.rounds ? `кругов: ${task.rounds + 1}` : '';
            task.finished = Date.now();
            this._log('ok', `Задача готова: ${this._title(task)}`, task);
            break;
          }
          task.rounds += 1;
          task.step = 0;
          this._log('info', `Задача по кругу: круг ${task.rounds + 1} — ${this._title(task)}`, task);
        }
        if (!this.fleet.isReady(task.bot)) {
          task.state = 'waiting';
          task.note = 'ждёт бота: не в сети';
          break;
        }
        const step = task.steps[task.step];
        const line = task.resumeLine || step.line;
        if (step.kind !== 'wait') {
          this._log('info', `Задача, шаг ${task.step + 1} из ${task.steps.length}: ${maskSecrets(line)}${task.resumeLine ? ' (продолжение)' : ''}`, task);
        }
        this._changed();
        let r;
        try {
          r = await this._exec(task, step, line, ctrl.signal);
        } catch (err) {
          r = { ok: false, code: 'failed', message: errText(err) };
        }
        if (ctrl.signal.aborted || task.state !== 'running') break; // пауза или убрали — уже отмечено
        if (r && r.ok) {
          task.step += 1;
          task.resumeLine = null;
          task.waitUntil = null;
          task.interrupts = 0;
          task.updated = Date.now();
          this._changed();
          continue;
        }
        this._failed(task, r || { ok: false, code: 'failed', message: 'нет ответа' });
        break;
      }
    } finally {
      this.running.delete(task.bot);
      task.updated = Date.now();
      this._changed();
      if (task.state === 'done' && !task.cancelled) this._trimFinished();
      if (!this.closed) setImmediate(() => this._pump(task.bot)); // следующая задача бота (или эта — бот вернулся)
    }
  }

  /** Шаг не удался: бот вышел — ждать его; #стоп или другая команда — пауза; иначе — ошибка (человек решит). */
  _failed(task, r) {
    const code = r.code || 'failed';
    const why = firstLine(r.message);
    if (r.data && typeof r.data.resume === 'string' && r.data.resume.startsWith('#')) task.resumeLine = r.data.resume;
    if (code === 'stopped') {
      task.state = 'paused';
      task.note = 'остановлено командой #стоп — продолжить: ▶';
      this._log('warn', `Задача на паузе (#стоп): ${this._title(task)}`, task);
      return;
    }
    if (code === 'replaced') {
      task.state = 'paused';
      task.note = 'прервана другой командой — продолжить: ▶';
      this._log('warn', `Задача на паузе: бота заняли другой командой — ${this._title(task)}`, task);
      return;
    }
    // «failed» — и обычная ошибка команды («склад полон»), и упавший процесс бота: обрыв — только если бот вышел.
    if (['offline', 'not_ready', 'interrupted', 'failed'].includes(code) && !this.fleet.isReady(task.bot)) {
      task.state = 'waiting';
      task.note = 'ждёт бота: вышел из сети — продолжит с этого шага';
      this._log('warn', `Задача ждёт бота (вышел из сети), продолжит с шага ${task.step + 1}${task.resumeLine ? `: ${maskSecrets(task.resumeLine)}` : ''}`, task);
      return;
    }
    if (['offline', 'not_ready', 'interrupted'].includes(code) && task.interrupts + 1 < MAX_INTERRUPTS) {
      // Бот в сети, а шаг прервался (смена мира, перенос на другой сервер) — повторить чуть позже.
      task.interrupts += 1;
      task.state = 'waiting';
      task.note = `шаг прервался${why ? `: ${why}` : ''} — повтор через ${Math.round(this.timings.retryMs / 1000)} с`;
      this._log('warn', `Задача: шаг прервался${why ? ` (${why})` : ''} — повторю`, task);
      const timer = setTimeout(() => {
        this.retryTimers.delete(task.bot);
        if (task.state === 'waiting') task.state = 'queued';
        this._pump(task.bot);
      }, this.timings.retryMs);
      if (timer.unref) timer.unref();
      this.retryTimers.set(task.bot, timer);
      return;
    }
    task.state = 'error';
    task.note = why || 'шаг не выполнен';
    this._log('error', `Задача остановилась на шаге ${task.step + 1} (${maskSecrets(task.steps[task.step].line)}): ${why || code}. Продолжить (повторить шаг): ▶`, task);
  }

  async _exec(task, step, line, signal) {
    if (step.kind === 'cmd') return this.fleet.commandOne(task.bot, line, { signal });
    if (step.kind === 'wait') {
      const total = step.seconds * this.timings.second;
      if (!task.waitUntil) {
        task.waitUntil = Date.now() + total;
        this._changed();
      }
      await this._sleep(Math.min(total, Math.max(0, task.waitUntil - Date.now())), signal);
      return { ok: true };
    }
    const text = step.kind === 'chat' ? step.text : line;
    const ok = await this.fleet.say(task.bot, text);
    if (!ok) return { ok: false, code: 'offline', message: 'бот не в сети' };
    await this._sleep(this.timings.serverGap, signal);
    return { ok: true };
  }

  _sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal && signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', done);
        resolve();
      }
      if (signal) signal.addEventListener('abort', done, { once: true });
    });
  }

  _title(task) {
    const s = task.steps.map((x) => shortLine(x.line, 30)).join(' → ');
    return s.length > 90 ? `${s.slice(0, 89)}…` : s;
  }

  _trimFinished() {
    const finished = this.tasks.filter((t) => t.state === 'done');
    if (finished.length <= KEEP_FINISHED) return;
    const drop = new Set(finished.sort((a, b) => (a.finished || 0) - (b.finished || 0)).slice(0, finished.length - KEEP_FINISHED));
    this.tasks = this.tasks.filter((t) => !drop.has(t));
  }

  _log(level, text, task) {
    this.emit('log', { level, text, bot: task ? task.bot : null, nick: task ? task.nick : null });
  }

  _changed() {
    this.emit('update');
    if (!this.store || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this._saveNow();
    }, this.timings.saveDelay);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  _saveNow() {
    if (!this.store) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = null;
    try {
      const tasks = this.tasks.map(({ id, bot, nick, steps, step, state, note, repeat, rounds, resumeLine, waitUntil, created, updated, finished }) => ({
        id, bot, nick, steps, step, state, note, repeat, rounds, resumeLine, waitUntil, created, updated, finished,
      }));
      this.store.save({ tasks });
    } catch (err) {
      this.emit('log', { level: 'warn', text: `Задачи: не удалось сохранить список — ${errText(err)}`, bot: null, nick: null });
    }
  }
}

module.exports = { TaskBoard, parseSteps, STATES, MAX_STEPS };
