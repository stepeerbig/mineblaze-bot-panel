'use strict';

// Охрана бота вне спавна и режим бога (ТЗ этапа 3, сервер MineBlaze).
//
// Охрана. После /home <дом> или /rtp бот раз в 5 секунд пишет /near — сервер отвечает
// «| Окружающие игроки: [Ender] ник(44m), [Игрок] другой(50m)» или «… никого» — и сам следит за игроками,
// которых видит. Ник не из белого списка — сразу /spawn. Охрана выключается, когда бот уходит на спавн
// (/spawn) или на /warp ah. В режиме PvP сервер не даёт телепортироваться — тогда /spawn сразу после боя.
//
// Режим бога. /god — переключатель: после перехода на сервер режима бот пишет /god и смотрит на ответ;
// если режим выключился, пишет ещё раз.

const NEAR_INTERVAL_MS = 5000;
const NEAR_FIRST_MS = 1500; // первая проверка — как только бот оказался на месте после телепорта
const VISIBLE_SCAN_MS = 1000;
const ESCAPE_REPEAT_MS = 3000;
// После /home или /rtp охрана ждёт самого телепорта (иначе первая же проверка увидит толпу на спавне).
const TELEPORT_WAIT_MS = 12000;
const TELEPORT_MIN_DISTANCE = 8;

// Ответы сервера. Строки сервера начинаются с «|» (или сразу с текста); сообщения игроков — с ранга и ника,
// поэтому подделать их из чата нельзя: ищем только в начале строки.
const START = String.raw`^\s*(?:[|│▎▍▌▐┃]\s*)?`;
const NEAR_RE = new RegExp(`${START}Окружающие игроки:\\s*(.*)$`, 'i');
const NEAR_ENTRY_RE = /(?:\[[^\]]*\]\s*)?([^\s,()[\]]+)\s*\((\d+)\s*m\)/gi;
const PVP_ON_RE = new RegExp(`${START}Вы вошли в режим PvP`, 'i');
const PVP_OFF_RE = new RegExp(`${START}Вы вышли из режима PvP`, 'i');
// \b в JavaScript понимает только латиницу — граница слова для кириллицы задаётся явно.
const GOD_RE = new RegExp(`${START}(?:Режим бога|Бессмертие|God ?mode)(?![A-Za-zА-Яа-яЁё])(.*)$`, 'i');
const GOD_OFF_RE = /выключ|отключ|disabled|\boff\b/i;
const GOD_ON_RE = /включ|enabled|\bon\b/i;
const DENIED_RE = new RegExp(`${START}.*(?:нет прав|неизвестная команда|unknown (?:or incomplete )?command|no permission|не найдена)`, 'i');

// Команды, после которых бот вне спавна (включают охрану), и команды ухода на спавн (выключают).
const ARM_RE = /^\/(?:home|rtp)\b/i;
const DISARM_RE = /^\/(?:spawn|warp\s+ah)\b/i;

const VALID_NICK = /^[A-Za-z0-9_]{3,16}$/;
// Мир спавна: на MineBlaze (сервер режима) спавн — отдельный мир «minecraft:lobby».
const SPAWN_WORLD_RE = /(?:^|[:_/-])(?:lobby|spawn|hub)$/i;

const norm = (name) => String(name || '').trim().replace(/^~/, '').toLowerCase();

/** Имя мира из пакета login / respawn (1.20.5+ — worldState.name, раньше — worldName), без «minecraft:». */
function worldNameOf(packet) {
  const name = packet && ((packet.worldState && packet.worldState.name) || packet.worldName);
  return typeof name === 'string' && name ? name.replace(/^minecraft:/, '') : null;
}

/** Ответ на /near → список {name, distance}; [] — «никого»; null — это не ответ на /near. */
function parseNear(text) {
  const line = String(text || '').replace(/\s+/g, ' ');
  const m = NEAR_RE.exec(line);
  if (!m) return null;
  const players = [];
  for (const e of m[1].matchAll(NEAR_ENTRY_RE)) players.push({ name: e[1], distance: Number(e[2]) });
  return players;
}

/** Белый список из текста настройки: ники через перенос строки, запятую или пробел. */
function parseWhitelist(text) {
  const out = new Set();
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const name = norm(raw.replace(/^\[[^\]]*\]/, ''));
    if (name) out.add(name);
  }
  return out;
}

/** Текст отображаемого имени игрока из списка Tab (без префикса в квадратных скобках). */
function displayNameOf(player) {
  if (!player || !player.displayName) return '';
  let text = '';
  try {
    text = String(player.displayName.toString ? player.displayName.toString() : player.displayName);
  } catch (_) {
    return '';
  }
  const words = text.replace(/\[[^\]]*\]/g, ' ').trim().split(/\s+/);
  return words.length ? words[words.length - 1] : '';
}

class Guard {
  /**
   * @param {object}   ctx
   * @param {Function} ctx.getBot   бот mineflayer или null
   * @param {Function} ctx.send     (команда, {quiet}) → отправить в чат сервера; quiet — не показывать в чате панели
   * @param {Function} ctx.log      (уровень, текст) → строка в консоль панели
   * @param {object}   ctx.config   живые настройки: guard (вкл/выкл), whitelist (текст)
   * @param {object}   [ctx.timers] подмена таймеров для тестов
   */
  constructor({ getBot, send, log, config, timers = {} }) {
    this.getBot = getBot;
    this.send = send;
    this.log = log;
    this.config = config;
    this.now = timers.now || Date.now;
    this._setInterval = timers.setInterval || setInterval;
    this._clearInterval = timers.clearInterval || clearInterval;
    this._setTimeout = timers.setTimeout || setTimeout;
    this._clearTimeout = timers.clearTimeout || clearTimeout;
    this.armed = false; // бот ушёл (или уходит) со спавна
    this.active = false; // телепорт состоялся — охрана проверяет
    this.armPos = null;
    this.armDim = null;
    this.pvp = false;
    this.escapePending = null; // кто был рядом, когда идёт бой и телепорт запрещён
    this.escapeAt = -Infinity;
    this.lastNear = null; // { at, players }
    this.waitTimer = null;
    this.nearTimer = null;
    this.firstTimer = null;
    this.scanTimer = null;
  }

  get enabled() {
    return this.config.guard !== false;
  }

  /** Бот уходит со спавна (/home, /rtp): охрана заработает, как только он окажется на месте. */
  arm(reason) {
    if (!this.enabled) return;
    const wasArmed = this.armed;
    this._stopTimers();
    this.armed = true;
    this.active = false;
    const bot = this.getBot();
    this.armPos = bot && bot.entity && bot.entity.position ? bot.entity.position.clone() : null;
    this.armDim = bot && bot.game ? bot.game.dimension : null;
    this.armWorld = bot ? bot.worldName || null : null;
    this.waitTimer = this._unref(this._setTimeout(() => {
      // Телепорта не заметили. Бот всё ещё в мире спавна — значит, его и не было (например, сервер не ответил).
      if (this.inSpawnWorld()) this.disarm('телепорт не состоялся — бот на спавне');
      else this._activate('телепорта не заметил — проверяю и так');
    }, TELEPORT_WAIT_MS));
    if (!wasArmed) this.log('info', `Охрана: бот уходит со спавна (${reason}) — начну проверять после телепорта`);
  }

  /** Бот в мире спавна (на MineBlaze — «lobby»): там охрана не нужна. Неизвестный мир — не спавн. */
  inSpawnWorld() {
    const bot = this.getBot();
    return Boolean(bot && bot.worldName && SPAWN_WORLD_RE.test(bot.worldName));
  }

  /** Сервер переместил бота (телепорт или смена мира). */
  onTeleport() {
    if (!this.armed) return;
    if (this.inSpawnWorld()) {
      if (this.active) this.disarm('бот на спавне');
      return; // ещё на спавне — ждём настоящего телепорта
    }
    if (this.active) return;
    const bot = this.getBot();
    const pos = bot && bot.entity && bot.entity.position;
    const dimChanged = Boolean(bot && bot.game && this.armDim && bot.game.dimension !== this.armDim);
    const worldChanged = Boolean(bot && bot.worldName && this.armWorld && bot.worldName !== this.armWorld);
    if (dimChanged || worldChanged || !this.armPos || !pos || pos.distanceTo(this.armPos) > TELEPORT_MIN_DISTANCE) this._activate();
  }

  /** Включить охрану сразу, без телепорта (#охрана вкл: бот уже на месте). false — выключена или бот на спавне. */
  activateNow(reason) {
    if (!this.enabled || this.inSpawnWorld()) return false;
    this.armed = true;
    this._activate(reason);
    return true;
  }

  /** Выключить охрану (бот на спавне или ушёл с сервера). */
  disarm(reason) {
    this._stopTimers();
    this.escapePending = null;
    const was = this.armed;
    this.armed = false;
    this.active = false;
    if (was) this.log('info', `Охрана выключена: ${reason}`);
  }

  /** Конец сессии: всё остановить молча. */
  stop() {
    this._stopTimers();
    this.armed = false;
    this.active = false;
    this.pvp = false;
    this.escapePending = null;
  }

  /** Бот отправил команду серверу (из панели, после входа или сам). */
  onCommand(cmd) {
    const text = String(cmd || '').trim();
    if (DISARM_RE.test(text)) this.disarm(text.startsWith('/spawn') ? 'бот ушёл на спавн' : 'бот ушёл на /warp ah');
    else if (ARM_RE.test(text)) this.arm(`после ${text.split(/\s+/).slice(0, 2).join(' ')}`);
  }

  /** Сообщение сервера (не игрока). */
  onChat(text) {
    const line = String(text || '');
    if (PVP_ON_RE.test(line)) {
      this.pvp = true;
      return;
    }
    if (PVP_OFF_RE.test(line)) {
      this.pvp = false;
      if (this.escapePending) {
        const who = this.escapePending;
        this.escapePending = null;
        this._escape(who);
      }
      return;
    }
    const players = parseNear(line);
    if (!players) return;
    this.lastNear = { at: this.now(), players };
    if (!this.active) return;
    const strangers = players.filter((p) => !this.isFriend(p.name));
    if (strangers.length) {
      this._escape(strangers.map((p) => `${p.name} (${p.distance} м)`).join(', '));
    }
  }

  /** Свой ли это: сам бот или ник из белого списка (в том числе если /near показал не ник, а псевдоним). */
  isFriend(name) {
    const n = norm(name);
    if (!n) return true;
    const bot = this.getBot();
    if (bot && (norm(bot.username) === n || norm(displayNameOf(bot.player)) === n)) return true;
    const list = parseWhitelist(this.config.whitelist);
    if (list.has(n)) return true;
    // Псевдоним из /near → настоящий ник по списку игроков (Tab).
    if (bot && bot.players) {
      for (const p of Object.values(bot.players)) {
        if (p && norm(displayNameOf(p)) === n && (list.has(norm(p.username)) || norm(p.username) === norm(bot.username))) return true;
      }
    }
    return false;
  }

  /** Строка для #охрана. */
  status() {
    if (!this.enabled) return 'Охрана выключена в настройках';
    const n = parseWhitelist(this.config.whitelist).size;
    let what = 'Охрана ждёт: включится после /home или /rtp';
    if (this.active) what = 'Охрана следит: /near раз в 5 с';
    else if (this.armed) what = 'Охрана ждёт телепорта после /home или /rtp';
    const parts = [what];
    parts.push(`белый список: ${n} ${plural(n, 'ник', 'ника', 'ников')}`);
    if (this.pvp) parts.push('идёт бой (PvP): телепорт запрещён');
    if (this.lastNear) {
      const ago = Math.round((this.now() - this.lastNear.at) / 1000);
      const who = this.lastNear.players.length ? this.lastNear.players.map((p) => `${p.name} (${p.distance} м)`).join(', ') : 'никого';
      parts.push(`последний /near ${ago} с назад: ${who}`);
    }
    return parts.join('; ');
  }

  // ---------- внутреннее ----------

  _activate(note) {
    if (!this.armed || this.active) return;
    this._stopTimers();
    this.active = true;
    this.firstTimer = this._unref(this._setTimeout(() => this._near(), NEAR_FIRST_MS));
    this.nearTimer = this._unref(this._setInterval(() => this._near(), NEAR_INTERVAL_MS));
    this.scanTimer = this._unref(this._setInterval(() => this._scanVisible(), VISIBLE_SCAN_MS));
    const n = parseWhitelist(this.config.whitelist).size;
    this.log('info', `Охрана включена${note ? ` (${note})` : ''}: /near раз в 5 с, в белом списке ${n} ${plural(n, 'ник', 'ника', 'ников')}`);
  }

  _unref(t) {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  _near() {
    if (!this.active || !this.getBot()) return;
    if (this.inSpawnWorld()) {
      this.disarm('бот на спавне');
      return;
    }
    this.send('/near', { quiet: true });
  }

  _scanVisible() {
    if (!this.active || this.inSpawnWorld()) return;
    const bot = this.getBot();
    if (!bot || !bot.players || !bot.entity) return;
    for (const p of Object.values(bot.players)) {
      if (!p || !p.entity || !VALID_NICK.test(p.username || '') || p.username === bot.username) continue;
      if (this.isFriend(p.username)) continue;
      const d = p.entity.position && bot.entity.position ? Math.round(p.entity.position.distanceTo(bot.entity.position)) : '?';
      this._escape(`${p.username} (${d} м, виден)`);
      return;
    }
  }

  _escape(who) {
    if (!this.enabled || !this.active || this.inSpawnWorld()) return; // со спавна на спавн не бегаем
    if (this.pvp) {
      if (!this.escapePending) {
        this.log('warn', `Охрана: рядом чужой — ${who}, но идёт бой (PvP), сервер не даст телепортироваться. /spawn — сразу после боя`);
      }
      this.escapePending = who;
      return;
    }
    const now = this.now();
    if (now - this.escapeAt < ESCAPE_REPEAT_MS) return;
    this.escapeAt = now;
    this.log('warn', `Охрана: рядом чужой — ${who}. Ухожу на спавн (/spawn)`);
    const bot = this.getBot();
    if (bot && bot.actions && typeof bot.actions.stop === 'function') {
      try {
        bot.actions.stop();
      } catch (_) {
        /* остановить действие не вышло — телепорт всё равно важнее */
      }
    }
    this.send('/spawn'); // пройдёт через onCommand и выключит охрану
  }

  _stopTimers() {
    this._clearTimeout(this.waitTimer);
    this._clearTimeout(this.firstTimer);
    this._clearInterval(this.nearTimer);
    this._clearInterval(this.scanTimer);
    this.waitTimer = null;
    this.firstTimer = null;
    this.nearTimer = null;
    this.scanTimer = null;
  }
}

const GOD_RETRY_MS = 3000; // повтор /god (на частые команды у сервера бывает задержка)
const GOD_ANSWER_MS = 5000;
const GOD_DAMAGE_REPEAT_MS = 10000;

class GodKeeper {
  /**
   * /god — переключатель, а режим бога сервер помнит и после перезахода. Поэтому:
   *  • что сказал сервер последним, помним и между сессиями (remembered): включён — после входа не трогаем;
   *  • бот теряет здоровье или сытость (в режиме бога так не бывает) — режим выключен: пишем /god;
   *  • в лобби (режим «приключение») /god не пишем — там его нет, включим на сервере режима.
   * @param {object}   ctx
   * @param {Function} ctx.send       (команда) → отправить
   * @param {Function} ctx.log        (уровень, текст)
   * @param {object}   ctx.config     живые настройки: godMode (вкл/выкл)
   * @param {Function} [ctx.getBot]   бот (режим игры: в «приключении» /god не пишем)
   * @param {boolean}  [ctx.remembered] режим был включён в прошлой сессии
   * @param {Function} [ctx.onState]  (вкл/выкл) → запомнить для следующей сессии
   * @param {object}   [ctx.timers]
   */
  constructor({ send, log, config, getBot = () => null, remembered = null, onState = () => {}, timers = {} }) {
    this.send = send;
    this.log = log;
    this.config = config;
    this.getBot = getBot;
    this.onState = onState;
    this._setTimeout = timers.setTimeout || setTimeout;
    this._clearTimeout = timers.clearTimeout || clearTimeout;
    this.now = timers.now || Date.now;
    this.timer = null;
    this.answerTimer = null;
    this.waiting = false; // ждём ответа на свой /god
    this.attempts = 0;
    this.on = remembered === true ? true : null; // true/false — что сказал сервер последним; null — неизвестно
    this.gaveUp = false;
    this.lastToggleAt = -Infinity;
    this.prev = null; // { health, food } — прошлые значения
  }

  get enabled() {
    return this.config.godMode !== false;
  }

  /** Проверить режим бога через ms (после входа или перехода на другой сервер). Включён — ничего не делаем. */
  schedule(ms) {
    this._clearTimeout(this.timer);
    this.attempts = 0;
    this.gaveUp = false;
    if (this.on === true) return;
    this.timer = this._setTimeout(() => this._toggle(), ms);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Здоровье или сытость изменились. Убыль при включённом режиме бога — значит, он на самом деле выключен. */
  onHealth(health, food) {
    const prev = this.prev;
    this.prev = { health, food };
    if (!prev || !this.enabled || this.waiting) return;
    if (!(health < prev.health || food < prev.food)) return;
    if (this.on === false) return; // и так знаем, что выключен (ждём повтора)
    if (this.now() - this.lastToggleAt < GOD_DAMAGE_REPEAT_MS) return;
    this.log('warn', 'Режим бога, похоже, выключен (бот теряет здоровье или сытость) — пишу /god');
    this.on = false;
    this.attempts = 0;
    this.gaveUp = false;
    this._toggle();
  }

  stop() {
    this._clearTimeout(this.timer);
    this._clearTimeout(this.answerTimer);
    this.timer = null;
    this.answerTimer = null;
    this.waiting = false;
  }

  /** Человек сам написал /god — ответ тоже разберём. */
  onCommand(cmd) {
    if (/^\/god\b/i.test(String(cmd || '').trim())) this.waiting = true;
  }

  onChat(text) {
    const line = String(text || '');
    const m = GOD_RE.exec(line);
    if (!m) {
      if (this.waiting && DENIED_RE.test(line)) {
        this.waiting = false;
        this.gaveUp = true;
        this._clearTimeout(this.answerTimer);
        this.log('warn', `Режим бога: сервер не дал выполнить /god — ${line.replace(/^\s*[|│]\s*/, '').trim()}`);
      }
      return;
    }
    this.waiting = false;
    this._clearTimeout(this.answerTimer);
    const rest = m[1] || line;
    if (GOD_OFF_RE.test(rest)) {
      this._setOn(false);
      if (!this.enabled || this.gaveUp) return;
      if (this.attempts >= 3) {
        this.gaveUp = true;
        this.log('warn', 'Режим бога: после трёх /god он всё ещё выключен — больше не пробую до следующего входа');
        return;
      }
      this._later(() => this._toggle(), GOD_RETRY_MS + Math.floor(Math.random() * 600));
    } else if (GOD_ON_RE.test(rest)) {
      if (this.on !== true) this.log('ok', 'Режим бога включён');
      this._setOn(true);
    }
  }

  _setOn(on) {
    this.on = on;
    try {
      this.onState(on);
    } catch (_) {
      /* память — не главное */
    }
  }

  _later(fn, ms) {
    this._clearTimeout(this.timer);
    this.timer = this._setTimeout(fn, ms);
    if (this.timer && typeof this.timer.unref === 'function') this.timer.unref();
  }

  _toggle() {
    if (!this.enabled || this.gaveUp || this.on === true) return;
    const bot = this.getBot();
    if (bot && bot.game && bot.game.gameMode === 'adventure') return; // лобби: /god там нет
    this.attempts += 1;
    this.waiting = true;
    this.lastToggleAt = this.now();
    this.send('/god');
    this._clearTimeout(this.answerTimer);
    this.answerTimer = this._setTimeout(() => {
      if (!this.waiting) return;
      this.waiting = false;
      // Ответа нет (например, сервер был занят телепортом). Раз включённым его не видели — пробуем ещё раз,
      // а если и так нет — следим за уроном: он покажет, выключен ли режим.
      if (this.attempts < 2 && this.on !== true) {
        this._later(() => this._toggle(), GOD_RETRY_MS);
        return;
      }
      this.log('warn', 'Режим бога: на /god сервер ничего понятного не ответил — проверь сам; если бот начнёт терять здоровье, бот напишет /god снова');
    }, GOD_ANSWER_MS);
    if (this.answerTimer && typeof this.answerTimer.unref === 'function') this.answerTimer.unref();
  }
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

module.exports = { Guard, GodKeeper, parseNear, parseWhitelist, displayNameOf, worldNameOf, NEAR_INTERVAL_MS };
