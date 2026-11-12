'use strict';

// Вкладка «Авто фиш» (главный процесс): кто из ботов рыбачит, что делает, сколько поймал. Сведения приходят от
// самих ботов — команда #рыбалка (src/bot/commands.js) шлёт событие «fishing» на каждом шаге и после каждого улова;
// путь: бот → BotManager → процесс ботов → Fleet → сюда. Боты, которые рыбачат, автопилот заданий не трогает.

const EventEmitter = require('events');

const DONE_STATES = new Set(['stopped', 'error', 'done', 'offline']);
const STATE_TEXT = {
  start: 'команда отправлена',
  travel: 'идёт на дом',
  rods: 'берёт удочки',
  search: 'ищет воду',
  walk: 'идёт к воде',
  fishing: 'рыбачит',
  unload: 'разгружает улов',
  stopped: 'остановлен',
  done: 'готово',
  error: 'не вышло',
  offline: 'не в сети',
};

class FishBoard extends EventEmitter {
  constructor({ now = () => Date.now() } = {}) {
    super();
    this.now = now;
    this.bots = new Map(); // номер бота → сведения
  }

  /** Событие от бота: { bot, nick, state, text, caught, casts, last, items, rods, since, spot, home }. */
  update(p) {
    if (!p || !p.bot) return;
    const prev = this.bots.get(p.bot) || {};
    const entry = {
      ...prev,
      ...p,
      at: this.now(),
      active: !DONE_STATES.has(p.state),
    };
    this.bots.set(p.bot, entry);
    this.emit('update');
  }

  /** Панель отправила боту #рыбалка — показать сразу, не дожидаясь ответа. */
  started(bot, nick) {
    const prev = this.bots.get(bot);
    this.update({ bot, nick, state: 'start', text: STATE_TEXT.start, caught: prev && prev.active ? prev.caught : 0, items: prev && prev.active ? prev.items : [] });
  }

  /** Бот вышел из игры — рыбалка у него кончилась (команда прервалась). */
  offline(bot) {
    const e = this.bots.get(bot);
    if (!e || !e.active) return;
    this.update({ bot, state: 'offline', text: 'бот вышел из игры' });
  }

  isActive(bot) {
    const e = this.bots.get(bot);
    return Boolean(e && e.active);
  }

  /** Номера ботов, которые рыбачат сейчас. */
  activeIds() {
    return [...this.bots.values()].filter((e) => e.active).map((e) => e.bot);
  }

  /** Убрать из списка тех, кто уже не рыбачит. */
  clearDone() {
    let n = 0;
    for (const [id, e] of this.bots) {
      if (!e.active) {
        this.bots.delete(id);
        n += 1;
      }
    }
    if (n) this.emit('update');
    return n;
  }

  /** Боты, которых убрали из списка панели, — и отсюда. */
  retain(ids) {
    const keep = new Set(ids);
    let n = 0;
    for (const id of [...this.bots.keys()]) {
      if (!keep.has(id)) {
        this.bots.delete(id);
        n += 1;
      }
    }
    if (n) this.emit('update');
  }

  /** Для окна: [{ bot, nick, state, stateText, text, caught, last, items, rods, active, since }] и сводка. */
  list() {
    const rows = [...this.bots.values()].map((e) => ({
      bot: e.bot,
      nick: e.nick || e.bot,
      state: e.state,
      stateText: STATE_TEXT[e.state] || e.state,
      text: e.text || '',
      caught: e.caught || 0,
      casts: e.casts || 0,
      last: e.last || '',
      items: Array.isArray(e.items) ? e.items.slice(0, 6) : [],
      rods: Number.isFinite(e.rods) ? e.rods : null,
      active: e.active,
      since: e.since || null,
      at: e.at,
    }));
    rows.sort((a, b) => Number(b.active) - Number(a.active) || a.nick.localeCompare(b.nick));
    return {
      rows,
      active: rows.filter((r) => r.active).length,
      caught: rows.reduce((n, r) => n + r.caught, 0),
    };
  }
}

module.exports = { FishBoard, STATE_TEXT };
