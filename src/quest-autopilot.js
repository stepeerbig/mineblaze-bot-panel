'use strict';

// Автопилот заданий NPC: каждый бот в сети сам проходит задания Фермера, потом Алхимика и Оружейника (как
// откроются: Алхимик — при Фермере 3-го уровня, Оружейник — при Фермере и Алхимике 4-го). Без ИИ: шаги известны
// заранее, а ИИ на ПК пользователя медленный, в интернете — с дневным лимитом. Делает то же, что человек командами:
//   #квесты у NPC — посмотреть задания и уровень;
//   #квесты принести <склад> [<награды>] у NPC — взять новые, купить «Купите…», принести со склада «Передайте…»,
//     сдать, сложить награды, повысить уровень (склад не задан — #квесты взять и #квесты купить);
//   #бей <моб> <сколько> дом <комната> — «Убейте…», если комната с этими мобами задана в настройках.
// Боты — по очереди, по together сразу (толпа у одного сундука и NPC мешает). Один бот — не чаще раза в pause
// минут; сделать было нечего — всё реже (до 2 ч), но «Проведите на сервере» проверяется, когда время выйдет.
// Что мешает (на складе не хватило, нет денег, нет дома, нет комнаты мобов, незнакомые задания), копится в needs():
// «что нужно от тебя» — так участие человека сводится к тому, чего бот сам сделать не может.
// Electron здесь не нужен: команды ботам, список ботов и хранилище передаются снаружи (main.js), поэтому всё
// проверяется обычными тестами (test/quest-autopilot.test.js).
//
// События: log { level, text, bot, nick } — что автопилот делает; status — поменялось состояние (для панели).

const EventEmitter = require('events');
const { QUEST_NPCS, MAX_NPC_LEVEL, mobsOf, mobName } = require('./bot/quests');
const { parseMobHomes } = require('./config');

const NPC_NAMES = QUEST_NPCS.map((n) => n.name);
// Что из «Передайте…» растёт на ферме — слова для #урожай (предмет → как назвать культуру).
const CROP_WORDS = {
  wheat: 'пшеница', carrot: 'морковь', potato: 'картофель', beetroot: 'свёкла', sweet_berries: 'ягоды', sugar_cane: 'тростник',
  melon_slice: 'арбуз', pumpkin: 'тыква', cocoa_beans: 'какао', nether_wart: 'нарост', cactus: 'кактус', bamboo: 'бамбук',
};
// Что из «Передайте…» добывается из руды — слова для #добудь (слитки нужно плавить — их не добываем).
const ORE_WORDS = {
  coal: 'уголь', redstone: 'редстоун', diamond: 'алмазы', emerald: 'изумруды', lapis_lazuli: 'лазурит', quartz: 'кварц',
  raw_iron: 'железо', raw_copper: 'медь', raw_gold: 'золото',
};
const MAX_PAUSE_MIN = 120; // сделать нечего — проверять всё реже, но не реже раза в 2 ч
const MAX_PASSES = 3; // у одного NPC за ход: новый уровень или новые задания — посмотреть ещё раз
const JOURNAL = 40; // строк журнала автопилота для панели
const DEFAULT_TIMINGS = Object.freeze({ pollMs: 5000, minuteMs: 60 * 1000 });

const lastLine = (r) => {
  const lines = [].concat((r && r.message) || []);
  return String(lines[lines.length - 1] || '').replace(/^Остановился:\s*/, '');
};
/** «Фермер › Уровень 1 → 2» → 1 (текущий уровень NPC); нет числа — null. */
const levelOf = (title) => {
  const m = /уровень\s*(\d+)/i.exec(String(title || ''));
  return m ? Number(m[1]) : null;
};
const who = (nicks, n = 5) => (nicks.length > n ? `${nicks.slice(0, n).join(', ')} и ещё ${nicks.length - n}` : nicks.join(', '));
const plural = (n, one, few, many) => {
  const d = n % 10;
  const h = n % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
};
const bots = (n) => `${n} ${plural(n, 'боту', 'ботам', 'ботам')}`; // «не хватило 2 ботам»
const botsOf = (n) => `${n} ${plural(n, 'бота', 'ботов', 'ботов')}`; // «у 2 ботов»
const botsNum = (n) => `${n} ${plural(n, 'бот', 'бота', 'ботов')}`; // «(2 бота)»

/**
 * Что делать у NPC по его меню заданий (data команды «#квесты у NPC»: { title, quests, level }).
 * → { level, locked, take, buy, deliver, unknown, kill, cant, waitMin, bring }
 */
function planNpc(view) {
  const quests = Array.isArray(view && view.quests) ? view.quests : [];
  const open = quests.filter((q) => !q.done);
  const levelReady = Boolean(view && view.level && view.level.ready);
  // Закрытый NPC (уровень 0 → 1): вместо заданий — условия «Прокачайте Фермера до 3 уровня».
  const locked = open.some((q) => q.kind === 'unlock') && !levelReady;
  const taken = open.filter((q) => q.taken && q.kind !== 'unlock');
  const untaken = open.filter((q) => !q.taken && q.kind !== 'unlock');
  const deliver = taken.filter((q) => q.kind === 'deliver' && q.items && q.items.length);
  const unknown = taken.filter((q) => q.kind === 'deliver' && !(q.items && q.items.length));
  const buy = taken.filter((q) => q.kind === 'buy');
  const left = (q) => Math.max(1, Math.ceil(q.need - q.have));
  const kill = taken.filter((q) => q.kind === 'kill').map((q) => ({ title: q.title, goal: q.goal, mobs: q.mobs || [], left: left(q) }));
  const breed = taken.filter((q) => q.kind === 'breed').map((q) => ({ title: q.title, goal: q.goal, mobs: q.mobs || [], left: left(q) }));
  const cant = taken.filter((q) => q.kind === 'other');
  const time = open.filter((q) => q.kind === 'time');
  const waitMin = time.length ? Math.min(...time.map((q) => Math.max(0, q.need - q.have))) : Infinity;
  const take = untaken.length > 0 || levelReady;
  return {
    level: levelOf(view && view.title),
    locked,
    take,
    buy: buy.length > 0,
    deliver,
    unknown,
    kill,
    breed,
    cant,
    waitMin,
    bring: take || buy.length > 0 || deliver.length > 0,
  };
}

/** Комната для мобов задания: строка настроек, чьи мобы пересекаются с мобами задания. */
function mobHome(rooms, mobs) {
  for (const r of rooms) {
    const ids = mobsOf(r.who);
    if (ids.some((id) => mobs.includes(id))) return r.home;
  }
  return null;
}

/** Что-то сдвинулось (сдали, купили, взяли, новый уровень, кого-то убили)? data — ответ команды. */
function progressOf(d) {
  if (!d) return false;
  return Boolean((d.gave && d.gave.length) || (d.took && d.took.length) || (d.levelUps && d.levelUps.some((u) => u.up))
    || (d.levelUp && d.levelUp.up) || (d.bought && d.bought.spent > 0) || d.spent > 0 || d.total > 0);
}
/** Новый уровень или новые задания — у NPC есть смысл посмотреть ещё раз. */
const changedOf = (d) => Boolean(d && ((d.took && d.took.length) || (d.levelUps && d.levelUps.some((u) => u.up)) || (d.levelUp && d.levelUp.up)));

/** Почему команда не вышла — в «что нужно» (или null: не нужно ничего от человека). */
function problemOfFailure(r, npc) {
  if (!r || r.ok) return null;
  if (r.code === 'no_home') {
    const m = /\/home\s+(\S+)/i.exec([].concat(r.message || []).join(' '));
    return { type: 'no_home', npc, home: m ? m[1] : '?' };
  }
  if (r.code === 'pvp') return { type: 'pvp', npc };
  if (['offline', 'stopped', 'replaced', 'finished', 'no_quests'].includes(r.code)) return null;
  return { type: 'error', npc, text: lastLine(r) };
}

class QuestAutopilot extends EventEmitter {
  /**
   * @param {object}   opts
   * @param {Function} opts.getConfig  () => { questStorage, questRewards, questMobHomes, questTogether, questPause }
   * @param {object}   opts.env        listBots() → [{ bot, nick, state }];
   *                                   runCommand(bot, line, { signal, quiet }) → { ok, code, message, data };
   *                                   busy() → почему сейчас нельзя трогать ботов ('' — можно);
   *                                   autoReconnect() → включён ли автореконнект
   * @param {object}   [opts.store]    { load() → состояние | null, save(состояние) } — между запусками панели
   * @param {object}   [opts.timings]  { pollMs, minuteMs } (для тестов)
   */
  constructor({ getConfig, env, store = null, timings = {} } = {}) {
    super();
    this.getConfig = getConfig;
    this.env = env;
    this.store = store;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.state = { bots: {} };
    try {
      const saved = store && store.load();
      if (saved && saved.bots && typeof saved.bots === 'object') this.state = { bots: saved.bots };
    } catch (_) {
      /* первый запуск или файл повреждён — начнём с нуля */
    }
    this.running = false;
    this.paused = '';
    this.current = new Map(); // номер бота → { nick, npc, what, since, abort }
    this.journal = [];
    this._abort = null;
    this._loop = null;
    this._wake = null;
  }

  /** Включить: боты в сети пойдут по заданиям. */
  start() {
    if (this.running) return false;
    this.running = true;
    this._abort = new AbortController();
    this._log('info', 'Автопилот заданий включён');
    this._loop = this._run()
      .catch((err) => this._log('error', `Автопилот остановился из-за ошибки: ${err && err.message ? err.message : err}`))
      .finally(() => {
        this.running = false;
        this.current.clear();
        this._status();
      });
    this._status();
    return true;
  }

  /** Выключить: новые дела не начинаются, начатое боты бросают (им уходит «#стоп»). */
  async stop() {
    if (!this.running) return false;
    this.running = false;
    this._abort.abort();
    this._kick();
    await this._loop;
    this._log('info', 'Автопилот заданий выключен');
    return true;
  }

  /** Боты нужны другому (ИИ, «по очереди»): начатое бросить; продолжит сам, когда освободятся. */
  interrupt(reason) {
    if (!this.current.size) return false;
    this._log('info', `Пауза: ${reason} — начатое боты бросают, продолжу, когда закончится`);
    for (const c of this.current.values()) c.abort.abort();
    return true;
  }

  /** Проверить всех снова прямо сейчас (положил предметы на склад, дал денег, поставил дома). */
  checkNow() {
    for (const st of Object.values(this.state.bots)) {
      st.nextAt = 0;
      st.idle = 0;
    }
    this._save();
    this._kick();
    this._status();
  }

  /** Что-то поменялось снаружи (бот вошёл или вышел) — посмотреть, кому пора, и обновить панель. */
  refresh() {
    this._kick();
    this._status();
  }

  /** Для панели: включён ли, кто что делает, уровни NPC у ботов, что нужно от человека. */
  status() {
    const list = this.env.listBots();
    const online = list.filter((b) => b.state === 'online');
    const now = Date.now();
    const waits = online.map((b) => this._bot(b).nextAt).filter((t) => t > now);
    return {
      running: this.running,
      paused: this.paused,
      total: list.length,
      online: online.length,
      current: [...this.current.values()].map((c) => ({ nick: c.nick, npc: c.npc, what: c.what, sec: Math.round((now - c.since) / 1000) })),
      nextInSec: waits.length && waits.length === online.length - this.current.size ? Math.round((Math.min(...waits) - now) / 1000) : 0,
      levels: this.levels(list),
      needs: this.needs(),
      journal: this.journal.slice(-JOURNAL),
    };
  }

  /** Уровни NPC у ботов списка: [«Фермер: ур. 1 — 10, ур. 2 — 5, пройден — 3, не смотрели — 2»]. */
  levels(list = this.env.listBots()) {
    const lines = [];
    for (const npc of NPC_NAMES) {
      const counts = new Map();
      const add = (key) => counts.set(key, (counts.get(key) || 0) + 1);
      for (const b of list) {
        const ns = (this.state.bots[b.bot] || { npcs: {} }).npcs[npc];
        if (!ns || (ns.level === undefined && !ns.finished && !ns.locked)) add('не смотрели');
        else if (ns.finished) add('пройден');
        else if (ns.locked) add('закрыт');
        else add(`ур. ${ns.level === null || ns.level === undefined ? '?' : ns.level}`);
      }
      const order = (k) => (k.startsWith('ур.') ? 0 : k === 'пройден' ? 1 : k === 'закрыт' ? 2 : 3);
      const parts = [...counts.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([k, n]) => `${k} — ${n}`);
      if (parts.length) lines.push(`${npc}: ${parts.join(', ')}`);
    }
    return lines;
  }

  /**
   * Что нужно от человека — по всем ботам, одинаковое вместе: [строки]. Только то, чего боты сами не сделают:
   * положить предметы на склад, дать денег, поставить дома, задать комнаты мобов, включить автореконнект…
   */
  needs() {
    const cfg = this._cfg();
    const groups = new Map(); // ключ → { type, nicks: Set, sum, items, extra }
    const add = (key, p, nick, amount = 0) => {
      if (!groups.has(key)) groups.set(key, { ...p, nicks: new Set(), sum: 0, amounts: [] });
      const g = groups.get(key);
      if (!g.nicks.has(nick)) g.amounts.push([nick, amount]);
      g.nicks.add(nick);
      g.sum += amount;
    };
    const listed = new Set(this.env.listBots().map((b) => b.bot));
    for (const [id, st] of Object.entries(this.state.bots)) {
      if (!listed.has(id)) continue; // бота убрали из списка
      for (const p of st.problems || []) {
        if (p.type === 'no_items') add(`items:${p.goal || p.items.join('/')}`, p, st.nick, p.missing);
        else if (p.type === 'no_money') add('money', p, st.nick, p.amount);
        else if (p.type === 'no_home') add(`home:${p.home}`, p, st.nick);
        else if (p.type === 'kill') add(`kill:${p.mobs.join('/')}`, p, st.nick, p.left);
        else if (p.type === 'breed' || p.type === 'no_food' || p.type === 'no_animals') add(`${p.type}:${p.mobs.join('/')}`, p, st.nick);
        else if (p.type === 'kill_none') add(`kill_none:${p.home}`, p, st.nick);
        else if (p.type === 'cant' || p.type === 'unknown_items' || p.type === 'no_ore') add(`${p.type}:${p.goal}`, p, st.nick);
        else add(p.type, p, st.nick);
      }
    }
    const out = [];
    const order = ['no_home', 'no_storage', 'no_items', 'no_money', 'full', 'kill', 'kill_none', 'breed', 'no_food', 'no_animals', 'no_ore', 'unknown_items', 'cant', 'pvp', 'error'];
    const sorted = [...groups.values()].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
    for (const g of sorted) {
      const nicks = [...g.nicks];
      const n = nicks.length;
      switch (g.type) {
        case 'no_home':
          out.push(`Нет дома «${g.home}» у ${botsOf(n)}: ${who(nicks)} — поставь каждому /sethome ${g.home} у сундука (бот должен стоять там)`);
          break;
        case 'no_storage':
          out.push(`Задания «Передайте…» ждут у ${botsOf(n)}, а склад не задан — впиши «Дом склада» в настройках автопилота`);
          break;
        case 'no_items':
          out.push(`Положи на склад${cfg.storage ? ` (/home ${cfg.storage})` : ''} для «${g.goal || g.items.join('/')}»: ещё ${g.sum} — не хватило ${bots(n)}`);
          break;
        case 'no_money': {
          const pays = g.amounts.slice(0, 3).map(([nick, a]) => `/pay ${nick} ${a}`).join(', ');
          out.push(`Дай денег ${bots(n)} для «Купите…» (всего ${g.sum}): ${pays}${n > 3 ? ' …' : ''}`);
          break;
        }
        case 'full':
          out.push(`Инвентарь полон у ${botsOf(n)}: ${who(nicks)} — ${cfg.rewards ? 'освободи сундук наград' : 'задай «Дом наград», туда боты сложат награды'}`);
          break;
        case 'kill':
          out.push(`«${g.goal || g.title}» у ${botsOf(n)}: нужна комната с ними — впиши в «Комнаты мобов» строку «${mobName(g.mobs[0])}: <дом>» и поставь ботам этот дом`);
          break;
        case 'kill_none':
          out.push(`В комнате «${g.home}» боты никого не убили (${botsNum(n)}) — мобы должны подходить к боту на удар`);
          break;
        case 'breed':
          out.push(`«${g.goal || g.title}» у ${botsOf(n)}: нужен загон — впиши «Дом загона» в настройках автопилота и поставь ботам /sethome там`);
          break;
        case 'no_food':
          out.push(`Нет корма для «${g.goal}» (${botsNum(n)}): ${mobName(g.mobs[0])} — дай ботам корм (например, пшеницу коровам и овцам, морковь свиньям, семена курам)`);
          break;
        case 'no_ore':
          out.push(`Шахта «${g.home}»: для «${g.goal}» руды не нашлось (${botsNum(n)}) — ${g.text || 'поставь дом шахты глубже или в другом месте'}`);
          break;
        case 'no_animals':
          out.push(`В загоне «${g.home}» меньше двух взрослых (${mobName(g.mobs[0])}) или их кормили меньше 5 мин назад (${botsNum(n)}) — пригони животных`);
          break;
        case 'unknown_items':
          out.push(`Не знаю, какие это предметы: «${g.goal}» (${botsNum(n)}) — пришли скриншот задания, научу`);
          break;
        case 'cant':
          out.push(`Пока не умею: «${g.goal}» (${botsNum(n)})`);
          break;
        case 'pvp':
          out.push(`В бою (PvP) — не телепортироваться: ${who(nicks)}; продолжат сами после боя`);
          break;
        default:
          out.push(`Ошибки у ${botsOf(n)}: ${g.amounts.slice(0, 2).map(([nick]) => nick).join(', ')} — ${g.text || 'см. консоль'}`);
      }
    }
    if (this.running && !(this.env.autoReconnect && this.env.autoReconnect())) {
      out.push('Включи автореконнект (ON): «Проведите на сервере» идёт, только пока бот в сети, а выпавший сам не вернётся');
    }
    return out;
  }

  // ---------- внутреннее ----------

  _cfg() {
    const c = this.getConfig() || {};
    return {
      storage: String(c.questStorage || ''),
      rewards: String(c.questRewards || ''),
      farm: String(c.questFarm || ''),
      pen: String(c.questPen || ''),
      mine: String(c.questMine || ''),
      rooms: parseMobHomes(c.questMobHomes),
      together: Math.max(1, Math.min(5, Number(c.questTogether) || 2)),
      pause: Math.max(1, Number(c.questPause) || 15),
    };
  }

  _bot(b) {
    if (!this.state.bots[b.bot]) this.state.bots[b.bot] = { nick: b.nick, nextAt: 0, idle: 0, checkedAt: 0, npcs: {}, problems: [] };
    const st = this.state.bots[b.bot];
    st.nick = b.nick;
    return st;
  }

  _log(level, text, b = null) {
    const entry = { time: Date.now(), level, text, bot: b ? b.bot : null, nick: b ? b.nick : null };
    this.journal.push(entry);
    if (this.journal.length > JOURNAL * 2) this.journal.splice(0, this.journal.length - JOURNAL);
    this.emit('log', entry);
  }

  _status() {
    this.emit('status');
  }

  _save() {
    if (!this.store) return;
    try {
      this.store.save(this.state);
    } catch (_) {
      /* не сохранилось — не страшно: автопилот проверит ботов заново */
    }
  }

  _kick() {
    if (this._wake) this._wake();
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this._wake = done;
    });
  }

  /** Кому пора: в сети, не занят, пора по времени — самый «давний». */
  _nextDue() {
    const now = Date.now();
    let best = null;
    let bestAt = Infinity;
    for (const b of this.env.listBots()) {
      if (b.state !== 'online' || this.current.has(b.bot)) continue;
      const at = this._bot(b).nextAt || 0;
      if (at <= now && at < bestAt) {
        best = b;
        bestAt = at;
      }
    }
    return best;
  }

  async _run() {
    const lanes = new Set();
    while (this.running) {
      const busy = this.env.busy ? this.env.busy() : '';
      if (busy !== this.paused) {
        this.paused = busy;
        if (!busy) this._log('info', 'Продолжаю');
        this._status();
      }
      if (!busy) {
        const together = this._cfg().together;
        while (lanes.size < together && this.running) {
          const b = this._nextDue();
          if (!b) break;
          const lane = this._turn(b)
            .catch((err) => this._log('error', `${b.nick}: ${err && err.message ? err.message : err}`, b))
            .finally(() => {
              lanes.delete(lane);
              this._kick();
            });
          lanes.add(lane);
        }
      }
      await this._sleep(this.timings.pollMs);
    }
    await Promise.all(lanes);
  }

  /** Команда боту от автопилота (в панели видно, кто чем занят). */
  async _cmd(b, cur, what, line, quiet = false) {
    cur.what = what;
    this._status();
    if (!quiet) this._log('info', `${cur.npc ? `${cur.npc}: ` : ''}${what} (${line})`, b);
    try {
      return await this.env.runCommand(b.bot, line, { signal: cur.abort.signal, quiet });
    } catch (err) {
      return { ok: false, code: 'failed', message: [err && err.message ? err.message : String(err)], data: null };
    }
  }

  /** Ход одного бота: NPC по порядку (закрытые по правилам — пропуская), у каждого — что можно сделать. */
  async _turn(b) {
    const st = this._bot(b);
    const cfg = this._cfg();
    const cur = { nick: b.nick, npc: null, what: 'начинаю', since: Date.now(), abort: new AbortController() };
    const onStop = () => cur.abort.abort();
    this._abort.signal.addEventListener('abort', onStop, { once: true });
    this.current.set(b.bot, cur);
    this._status();
    const problems = [];
    let progress = false;
    let interrupted = false;
    let waitMin = Infinity;
    try {
      for (const npc of NPC_NAMES) {
        if (cur.abort.signal.aborted) {
          interrupted = true;
          break;
        }
        const ns = st.npcs[npc] || (st.npcs[npc] = {});
        if (ns.finished) continue;
        const lock = this._lockedByRules(st, npc);
        if (lock) {
          Object.assign(ns, { locked: true, lock });
          continue;
        }
        cur.npc = npc;
        const r = await this._npc(b, cur, npc, ns, cfg, problems);
        if (r.progress) progress = true;
        if (Number.isFinite(r.waitMin)) waitMin = Math.min(waitMin, r.waitMin);
        if (r.interrupted) {
          interrupted = true;
          break;
        }
        if (r.halt) break; // бот не может работать дальше (не телепортируется и т.п.) — до следующего раза
      }
    } finally {
      this._abort.signal.removeEventListener('abort', onStop);
      this.current.delete(b.bot);
    }
    st.checkedAt = Date.now();
    if (interrupted) {
      st.nextAt = 0; // прервали — доделает, как только снова можно
    } else {
      st.problems = problems;
      st.idle = progress ? 0 : Math.min((st.idle || 0) + 1, 8);
      let minutes = progress ? cfg.pause : Math.min(MAX_PAUSE_MIN, cfg.pause * 2 ** st.idle);
      if (Number.isFinite(waitMin)) minutes = Math.min(minutes, Math.max(cfg.pause, waitMin + 1)); // время задания выйдет
      st.nextAt = Date.now() + minutes * this.timings.minuteMs;
      if (problems.length) this._log('warn', `Не всё вышло — подробности в «Что нужно от тебя»; следующая проверка через ${Math.round(minutes)} мин`, b);
    }
    this._save();
    this._status();
  }

  /** Закрыт ли NPC по правилам (Алхимик — Фермер 3, Оружейник — Фермер 4 и Алхимик 4): '' — открыт или неизвестно. */
  _lockedByRules(st, npc) {
    const def = QUEST_NPCS.find((n) => n.name === npc);
    for (const o of (def && def.opens) || []) {
      const other = st.npcs[o.npc];
      if (!other) return `сначала ${o.npc}`;
      const level = other.finished ? MAX_NPC_LEVEL : other.level;
      if (!Number.isFinite(level) || level < o.level) return `${o.npc}: нужен ${o.level}-й уровень`;
    }
    return '';
  }

  /** Записать, что видно в меню заданий NPC. */
  _record(ns, view) {
    const level = levelOf(view.title);
    Object.assign(ns, {
      level: level === null ? ns.level : level,
      finished: false,
      at: Date.now(),
      quests: (view.quests || []).map((q) => ({
        title: q.title, kind: q.kind, goal: q.goal, have: q.have, need: q.need, unit: q.unit || '', taken: Boolean(q.taken), done: Boolean(q.done),
      })),
    });
  }

  /**
   * Один NPC: посмотреть задания; есть что делать — сделать; новый уровень или новые задания — посмотреть ещё раз.
   * → { progress, waitMin, interrupted, halt }
   */
  async _npc(b, cur, npc, ns, cfg, problems) {
    let progress = false; // за весь ход у этого NPC
    let waitMin = Infinity;
    let fresh = null; // уже открытое меню заданий (после «смотрю, что вышло») — второй раз не открывать
    const stopped = (r) => (r && (r.code === 'stopped' || r.code === 'replaced')) || cur.abort.signal.aborted;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      // Что мешает у этого NPC — по последнему проходу (прошлые проходы уже устарели).
      const others = problems.filter((p) => p.npc !== npc);
      problems.splice(0, problems.length, ...others);
      const look = fresh || await this._cmd(b, cur, 'смотрю задания', `#квесты у ${npc}`, true);
      fresh = null;
      if (stopped(look)) return { progress, interrupted: true };
      if (look.code === 'finished') {
        Object.assign(ns, { finished: true, locked: false, level: MAX_NPC_LEVEL, quests: [], at: Date.now() });
        if (pass === 0) this._log('ok', `${npc}: все задания пройдены`, b);
        return { progress };
      }
      if (look.code === 'offline') return { progress, interrupted: true };
      if (!look.ok || !look.data) {
        const p = problemOfFailure(look, npc);
        if (p) problems.push(p);
        return { progress, halt: true };
      }
      this._record(ns, look.data);
      const plan = planNpc(look.data);
      ns.locked = plan.locked;
      if (plan.locked) return { progress };
      waitMin = plan.waitMin;
      let changed = false; // новый уровень или новые задания — ещё проход
      let did = false; // в этом проходе что-то сдвинулось
      // «Передайте пшеницу…» — сначала собрать урожай на ферме (принесёт в инвентаре, недостающее — со склада).
      const crops = [...new Set(plan.deliver.flatMap((q) => q.items || []).filter((id) => CROP_WORDS[id]))];
      if (crops.length && cfg.farm) {
        const r = await this._cmd(b, cur, 'собираю урожай на ферме', `#урожай ${crops.map((id) => CROP_WORDS[id]).join(', ')} дом ${cfg.farm}`);
        if (stopped(r)) return { progress, interrupted: true };
        if (r.data && r.data.total > 0) did = true;
        else if (r.code !== 'nothing') {
          const p = problemOfFailure(r, npc);
          if (p) problems.push(p);
        }
      }
      // «Передайте редстоун…» — сначала добыть в шахте (по заданию: сколько ещё нужно).
      if (cfg.mine) {
        for (const q of plan.deliver) {
          const ore = (q.items || []).find((id) => ORE_WORDS[id]);
          if (!ore) continue;
          const need = Math.max(1, Math.ceil(q.need - q.have));
          const r = await this._cmd(b, cur, `добываю: ${ORE_WORDS[ore]}`, `#добудь ${ORE_WORDS[ore]} ${need} дом ${cfg.mine}`);
          if (stopped(r)) return { progress, interrupted: true };
          if (r.data && r.data.mined > 0) did = true;
          else if (r.code === 'not_found') problems.push({ type: 'no_ore', npc, goal: q.goal, home: cfg.mine, text: lastLine(r) });
          else {
            const p = problemOfFailure(r, npc);
            if (p) problems.push(p);
          }
        }
      }
      // Взять, купить, принести со склада, сдать, повысить уровень.
      if (plan.bring && cfg.storage) {
        const line = `#квесты принести ${cfg.storage}${cfg.rewards ? ` ${cfg.rewards}` : ''} у ${npc}`;
        const r = await this._cmd(b, cur, 'беру задания и приношу со склада', line);
        if (stopped(r)) return { progress, interrupted: true };
        const d = r.data || {};
        if (progressOf(d)) did = true;
        if (changedOf(d)) changed = true;
        for (const s of d.short || []) if (s.missing > 0) problems.push({ type: 'no_items', npc, title: s.title, goal: s.goal || '', items: s.items || [], missing: s.missing });
        if (d.bought && d.bought.noMoney && d.bought.left > 0) problems.push({ type: 'no_money', npc, amount: d.bought.left });
        if (d.full) problems.push({ type: 'full', npc });
        const p = problemOfFailure(r, npc);
        if (p) {
          problems.push(p);
          return { progress: progress || did, waitMin, halt: p.type === 'no_home' || p.type === 'pvp' };
        }
      } else {
        if (plan.take) {
          const r = await this._cmd(b, cur, 'беру задания', `#квесты взять у ${npc}`);
          if (stopped(r)) return { progress, interrupted: true };
          if (progressOf(r.data)) did = true;
          if (changedOf(r.data)) changed = true;
          const p = problemOfFailure(r, npc);
          if (p) problems.push(p);
        }
        if (plan.buy) {
          const r = await this._cmd(b, cur, 'покупаю для «Купите…»', `#квесты купить у ${npc}`);
          if (stopped(r)) return { progress, interrupted: true };
          const d = r.data || {};
          if (progressOf(d)) did = true;
          if (changedOf(d)) changed = true;
          if (d.noMoney && d.left > 0) problems.push({ type: 'no_money', npc, amount: d.left });
          else if (r.code !== 'not_bought') {
            const p = problemOfFailure(r, npc);
            if (p) problems.push(p);
          }
        }
        if (plan.deliver.length) problems.push({ type: 'no_storage', npc });
      }
      // «Убейте…» — в комнате с этими мобами, если она задана.
      for (const k of plan.kill) {
        if (!k.mobs.length) {
          problems.push({ type: 'cant', npc, title: k.title, goal: k.goal });
          continue;
        }
        const home = mobHome(cfg.rooms, k.mobs);
        if (!home) {
          problems.push({ type: 'kill', npc, title: k.title, goal: k.goal, mobs: k.mobs, left: k.left });
          continue;
        }
        const r = await this._cmd(b, cur, `бью: ${mobName(k.mobs[0])} ×${k.left}`, `#бей ${mobName(k.mobs[0])} ${k.left} дом ${home}`);
        if (stopped(r)) return { progress, interrupted: true };
        if (r.data && r.data.total > 0) {
          did = true;
          changed = true; // могли выполнить — посмотреть ещё раз (новый уровень)
        } else if (r.code === 'no_targets') {
          problems.push({ type: 'kill_none', npc, home });
        } else {
          const p = problemOfFailure(r, npc);
          if (p) problems.push(p);
        }
      }
      // «Разведите…» — покормить пары в загоне, если он задан (корм — у бота).
      for (const k of plan.breed) {
        if (!k.mobs.length) {
          problems.push({ type: 'cant', npc, title: k.title, goal: k.goal });
          continue;
        }
        if (!cfg.pen) {
          problems.push({ type: 'breed', npc, title: k.title, goal: k.goal, mobs: k.mobs });
          continue;
        }
        const r = await this._cmd(b, cur, `развожу: ${mobName(k.mobs[0])}`, `#разведи ${mobName(k.mobs[0])} ${k.left} дом ${cfg.pen}`);
        if (stopped(r)) return { progress, interrupted: true };
        if (r.data && r.data.pairs > 0) did = true;
        else if (r.code === 'no_food') problems.push({ type: 'no_food', npc, goal: k.goal, mobs: k.mobs });
        else if (r.code === 'no_animals') problems.push({ type: 'no_animals', npc, goal: k.goal, mobs: k.mobs, home: cfg.pen });
        else {
          const p = problemOfFailure(r, npc);
          if (p) problems.push(p);
        }
      }
      for (const q of plan.cant) problems.push({ type: 'cant', npc, title: q.title, goal: q.goal });
      for (const q of plan.unknown) {
        if (!problems.some((p) => p.type === 'unknown_items' && p.goal === q.goal)) problems.push({ type: 'unknown_items', npc, title: q.title, goal: q.goal });
      }
      if (did) progress = true;
      if (!changed) {
        if (did) {
          // Что-то сдали или купили — запомнить новый прогресс (для сводки).
          const after = await this._cmd(b, cur, 'смотрю, что вышло', `#квесты у ${npc}`, true);
          if (stopped(after)) return { progress, interrupted: true };
          if (after.code === 'finished') Object.assign(ns, { finished: true, locked: false, level: MAX_NPC_LEVEL, quests: [] });
          else if (after.ok && after.data) {
            this._record(ns, after.data);
            const again = planNpc(after.data);
            waitMin = again.waitMin;
            if (again.take) {
              fresh = after; // всё выполнено — новый уровень прямо сейчас, меню уже прочитано
              continue;
            }
          }
        }
        return { progress, waitMin };
      }
      // Новый уровень или новые задания — ещё проход: новые задания тоже могут быть по силам сразу.
    }
    return { progress, waitMin };
  }
}

module.exports = { QuestAutopilot, planNpc, mobHome, levelOf };
