'use strict';

// Охрана бота вне спавна и режим бога (ТЗ этапа 3, сервер MineBlaze).
//
// Охрана. После /home <дом> или /rtp бот раз в 5 секунд пишет /near — сервер отвечает
// «| Окружающие игроки: [Ender] ник(44m), [Игрок] другой(50m)» или «… никого» — и сам следит за игроками,
// которых видит. Ник не из белого списка — сразу /spawn, и охрана не отпускает, пока бот правда не окажется
// на спавне: команду, пришедшую сразу за другой, MineBlaze молча пропускает, а в бою (PvP) не выполняет
// никаких команд — тогда /spawn повторяется, после боя — сразу. Охрана выключается, когда бот на спавне
// или на /warp ah (после телепорта, а не после самой команды).
//
// Режим бога. /god — переключатель: после перехода на сервер режима бот пишет /god и смотрит на ответ;
// если режим выключился, пишет ещё раз. В бою сервер команды не выполняет — /god после боя.

const NEAR_INTERVAL_MS = 5000;
const NEAR_FIRST_MS = 1500; // первая проверка — как только бот оказался на месте после телепорта
const VISIBLE_SCAN_MS = 1000;
// После /home или /rtp охрана ждёт самого телепорта (иначе первая же проверка увидит толпу на спавне).
const TELEPORT_WAIT_MS = 12000;
const TELEPORT_MIN_DISTANCE = 8;
// После /spawn или /warp ah ждём телепорта столько. Нет его — /spawn охраны повторяется, а после /spawn
// человека охрана снова следит.
const LEAVE_CONFIRM_MS = 4000;
const LEAVE_LOG_FIRST = 5; // столько повторов /spawn пишем в консоль подряд, дальше — каждый десятый
// Конец боя сервер пишет в чат, но это сообщение можно и не увидеть. Без новых признаков боя столько —
// считаем, что он кончился (если нет — сервер снова ответит «нельзя во время PvP»).
const PVP_MAX_MS = 60000;

// Ответы сервера. Строки сервера начинаются с «|» (или сразу с текста); сообщения игроков — с ранга и ника,
// поэтому подделать их из чата нельзя: ищем только в начале строки.
const START = String.raw`^\s*(?:[|│▎▍▌▐┃]\s*)?`;
const NEAR_RE = new RegExp(`${START}Окружающие игроки:\\s*(.*)$`, 'i');
const NEAR_ENTRY_RE = /(?:\[[^\]]*\]\s*)?([^\s,()[\]]+)\s*\((\d+)\s*m\)/gi;
const PVP_ON_RE = new RegExp(`${START}Вы вошли в режим PvP`, 'i');
const PVP_OFF_RE = new RegExp(`${START}Вы вышли из режима PvP`, 'i');
// «| Вы не можете использовать команды во время PvP!» — команда не выполнена из-за боя.
const PVP_DENY_RE = new RegExp(`${START}.*не можете.*(?:PvP|в бою|во время боя)`, 'i');
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

// Ники всех ботов панели (config.fleetNicks): один и тот же текст у всех ботов процесса — разбираем его один раз.
let fleetCache = { text: null, set: new Set() };
function fleetSet(text) {
  const s = String(text || '');
  if (fleetCache.text !== s) fleetCache = { text: s, set: parseWhitelist(s) };
  return fleetCache.set;
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
   * @param {Function} ctx.send     (команда, опции) → отправить в чат сервера. Команды идут через очередь
   *                                BotManager (не чаще раза в 1,5 с); опции: quiet — не показывать в чате панели,
   *                                urgent — вперёд очереди, key — одна такая в очереди, origin — кто отправил,
   *                                check — () => нужна ли ещё команда, когда до неё дойдёт очередь
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
    this.armedAt = null; // где был бот, когда ушла /home или /rtp: { pos, dim, world }
    // Бот уходит на спавн: { cmd, arrived, byGuard, attempts, from, waitingPvp }. byGuard — увела охрана
    // (повторяет /spawn до телепорта); иначе /spawn или /warp ah писал человек.
    this.leaving = null;
    this.pvp = false;
    this.pvpAt = -Infinity;
    this.lastNear = null; // { at, players }
    this.waitTimer = null;
    this.leaveTimer = null;
    this.nearTimer = null;
    this.firstTimer = null;
    this.scanTimer = null;
  }

  get enabled() {
    return this.config.guard !== false;
  }

  /** Идёт бой (PvP): сервер не выполняет команды и не телепортирует. */
  get inPvp() {
    return this.pvp && this.now() - this.pvpAt < PVP_MAX_MS;
  }

  /** Бот уходит со спавна (/home, /rtp): охрана заработает, как только он окажется на месте. */
  arm(reason) {
    if (!this.enabled) return;
    const wasArmed = this.armed && !this.leaving;
    this._stopTimers();
    this.leaving = null;
    this.armed = true;
    this.active = false;
    this.armedAt = this._where();
    this.waitTimer = this._unref(this._setTimeout(() => {
      this.waitTimer = null;
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
    const l = this.leaving;
    if (l) {
      // Ушёл на спавн (или на /warp ah): мир спавна или просто телепорт с места, откуда ушла команда.
      if (this.inSpawnWorld() || this._movedFrom(l.from)) this.disarm(l.arrived);
      return;
    }
    if (this.inSpawnWorld()) {
      if (this.active) this.disarm('бот на спавне');
      return; // ещё на спавне — ждём настоящего телепорта
    }
    if (!this.active && this._movedFrom(this.armedAt)) this._activate();
  }

  /** Включить охрану сразу, без телепорта (#охрана вкл: бот уже на месте). false — выключена или бот на спавне. */
  activateNow(reason) {
    if (!this.enabled || this.inSpawnWorld()) return false;
    if (this.active && !this.leaving) return true; // уже следит
    this._stopTimers();
    this.leaving = null;
    this.armed = true;
    this.active = false;
    this._activate(reason);
    return true;
  }

  /** Выключить охрану (бот на спавне или ушёл с сервера). */
  disarm(reason) {
    this._stopTimers();
    this.leaving = null;
    // Телепортом из боя не уйти: раз бот на спавне (или погиб, или ушёл с сервера) — бой для него кончился.
    this.pvp = false;
    this.pvpAt = -Infinity;
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
    this.leaving = null;
    this.pvp = false;
    this.pvpAt = -Infinity;
  }

  /**
   * Команда ушла на сервер (из панели, после входа или от самой охраны — origin 'guard').
   * /home, /rtp — бот уходит со спавна; /spawn, /warp ah — уходит на спавн: охрана ждёт телепорта.
   */
  onCommand(cmd, { origin = null } = {}) {
    const text = String(cmd || '').trim();
    if (DISARM_RE.test(text)) this._leaveSent(text, origin === 'guard');
    else if (ARM_RE.test(text)) this.arm(`после ${text.split(/\s+/).slice(0, 2).join(' ')}`);
  }

  /** Сообщение сервера (не игрока). */
  onChat(text) {
    const line = String(text || '');
    if (PVP_ON_RE.test(line)) {
      this._pvpSeen();
      return;
    }
    if (PVP_DENY_RE.test(line)) {
      this._pvpSeen();
      const l = this.leaving;
      if (l && l.byGuard && !l.waitingPvp) {
        l.waitingPvp = true;
        this.log('warn', 'Охрана: идёт бой (PvP) — сервер не выполнил /spawn. /spawn — сразу после боя');
      }
      return;
    }
    if (PVP_OFF_RE.test(line)) {
      this.resetPvp();
      return;
    }
    const players = parseNear(line);
    if (!players) return;
    this.lastNear = { at: this.now(), players };
    if (!this.active || this.leaving) return;
    const strangers = players.filter((p) => !this.isFriend(p.name));
    if (strangers.length) this._escape(strangers.map((p) => `${p.name} (${p.distance} м)`).join(', '));
  }

  /** Бой кончился (сервер написал «Вы вышли из режима PvP»): если охрана уводит бота на спавн — /spawn сейчас же. */
  resetPvp() {
    this.pvp = false;
    this.pvpAt = -Infinity;
    const l = this.leaving;
    if (l && l.byGuard && this.armed) this._sendSpawn();
  }

  /** Бот погиб: бой для него кончился. /spawn не нужен — бот и так возродится на спавне. */
  onDeath() {
    this.pvp = false;
    this.pvpAt = -Infinity;
  }

  /**
   * Свой ли это: сам бот, ник из белого списка или другой бот панели (config.fleetNicks — все боты из списка
   * «Боты»: у одного склада их много, и охрана каждого не должна уводить его от остальных). В том числе если
   * /near показал не ник, а псевдоним.
   */
  isFriend(name) {
    const n = norm(name);
    if (!n) return true;
    const bot = this.getBot();
    if (bot && (norm(bot.username) === n || norm(displayNameOf(bot.player)) === n)) return true;
    const list = parseWhitelist(this.config.whitelist);
    for (const nick of fleetSet(this.config.fleetNicks)) list.add(nick);
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
    const l = this.leaving;
    let what = 'Охрана ждёт: включится после /home или /rtp';
    if (l && l.byGuard) what = `Охрана уводит бота на спавн: жду телепорта после /spawn${l.attempts > 1 ? ` (попытка ${l.attempts})` : ''}`;
    else if (l) what = `Охрана ждёт телепорта после ${l.cmd}`;
    else if (this.active) what = 'Охрана следит: /near раз в 5 с';
    else if (this.armed) what = 'Охрана ждёт телепорта после /home или /rtp';
    const parts = [what];
    parts.push(`белый список: ${n} ${plural(n, 'ник', 'ника', 'ников')}`);
    if (this.inPvp) parts.push('идёт бой (PvP): сервер не выполняет команды');
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
    this._startChecks(NEAR_FIRST_MS);
    const n = parseWhitelist(this.config.whitelist).size;
    this.log('info', `Охрана включена${note ? ` (${note})` : ''}: /near раз в 5 с, в белом списке ${n} ${plural(n, 'ник', 'ника', 'ников')}`);
  }

  /** /near и взгляд по сторонам: первая проверка через firstMs, дальше /near раз в 5 с. */
  _startChecks(firstMs) {
    this._stopChecks();
    this.firstTimer = this._unref(this._setTimeout(() => {
      this.firstTimer = null;
      this._near();
    }, firstMs));
    this.nearTimer = this._unref(this._setInterval(() => this._near(), NEAR_INTERVAL_MS));
    this.scanTimer = this._unref(this._setInterval(() => this._scanVisible(), VISIBLE_SCAN_MS));
  }

  _unref(t) {
    if (t && typeof t.unref === 'function') t.unref();
    return t;
  }

  /** Где бот сейчас — чтобы потом понять, был ли телепорт. */
  _where() {
    const bot = this.getBot();
    return {
      pos: bot && bot.entity && bot.entity.position ? bot.entity.position.clone() : null,
      dim: bot && bot.game ? bot.game.dimension : null,
      world: bot ? bot.worldName || null : null,
    };
  }

  /** Бот ушёл с места from: другое измерение или мир, или дальше TELEPORT_MIN_DISTANCE блоков. */
  _movedFrom(from) {
    const bot = this.getBot();
    if (!bot) return false;
    if (!from) return true;
    if (bot.game && from.dim && bot.game.dimension !== from.dim) return true;
    if (bot.worldName && from.world && bot.worldName !== from.world) return true;
    const pos = bot.entity && bot.entity.position;
    if (!from.pos || !pos) return true;
    return pos.distanceTo(from.pos) > TELEPORT_MIN_DISTANCE;
  }

  _pvpSeen() {
    this.pvp = true;
    this.pvpAt = this.now();
  }

  _near() {
    if (!this.active || this.leaving || !this.getBot()) return;
    if (this.inSpawnWorld()) {
      this.disarm('бот на спавне');
      return;
    }
    if (this.inPvp) return; // в бою сервер команды не выполняет — смотрим глазами (_scanVisible)
    this.send('/near', {
      quiet: true,
      key: 'near',
      origin: 'guard',
      check: () => this.active && !this.leaving && !this.inPvp,
    });
  }

  _scanVisible() {
    if (!this.active || this.leaving || this.inSpawnWorld()) return;
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

  /** Рядом чужой: остановить действие и уйти на спавн. /spawn повторяется, пока бот правда не окажется там. */
  _escape(who) {
    if (!this.enabled || !this.active || this.leaving || this.inSpawnWorld()) return; // со спавна на спавн не бегаем
    const bot = this.getBot();
    if (bot && bot.actions && typeof bot.actions.stop === 'function') {
      try {
        bot.actions.stop();
      } catch (_) {
        /* остановить действие не вышло — телепорт всё равно важнее */
      }
    }
    this._stopChecks();
    this.leaving = this._leave('/spawn', true);
    if (this.inPvp) {
      this.leaving.waitingPvp = true;
      this.log('warn', `Охрана: рядом чужой — ${who}, но идёт бой (PvP): сервер не даёт телепортироваться. /spawn — сразу после боя`);
      this._restartLeaveTimer();
      return;
    }
    this.log('warn', `Охрана: рядом чужой — ${who}. Ухожу на спавн (/spawn)`);
    this._sendSpawn();
  }

  _leave(cmd, byGuard) {
    return {
      cmd,
      arrived: cmd === '/spawn' ? 'бот на спавне' : 'бот ушёл на /warp ah',
      byGuard,
      attempts: 0,
      from: this._where(),
      waitingPvp: false,
    };
  }

  /** Ушла /spawn или /warp ah (чья угодно): ждём самого телепорта. */
  _leaveSent(text, byGuard) {
    if (!this.armed) return; // охрана и так не работает
    if (!this.leaving) {
      this.leaving = this._leave(/^\/spawn\b/i.test(text) ? '/spawn' : '/warp ah', byGuard);
      this._stopChecks();
    }
    this.leaving.from = this._where();
    this._restartLeaveTimer();
  }

  /** /spawn от охраны (первый или повтор). В бою ждём его конца: сервер команду всё равно не выполнит. */
  _sendSpawn() {
    const l = this.leaving;
    if (!l) return;
    if (this.inPvp) {
      if (!l.waitingPvp) {
        l.waitingPvp = true;
        this.log('warn', 'Охрана: идёт бой (PvP) — сервер не даёт телепортироваться. /spawn — сразу после боя');
      }
      this._restartLeaveTimer(); // и проверим ещё раз: конец боя можно и не увидеть
      return;
    }
    l.waitingPvp = false;
    l.attempts += 1;
    if (l.attempts > 1 && (l.attempts <= LEAVE_LOG_FIRST || l.attempts % 10 === 0)) {
      this.log('warn', `Охрана: телепорта на спавн нет — /spawn ещё раз (попытка ${l.attempts})`);
    }
    this.send('/spawn', { urgent: true, key: 'spawn', origin: 'guard', check: () => this.leaving === l });
    this._restartLeaveTimer(); // ещё раз — когда /spawn правда уйдёт (его может придержать очередь команд)
  }

  _restartLeaveTimer() {
    this._clearTimeout(this.leaveTimer);
    this.leaveTimer = this._unref(this._setTimeout(() => {
      this.leaveTimer = null;
      this._leaveCheck();
    }, LEAVE_CONFIRM_MS));
  }

  /** Телепорта после /spawn (или /warp ah) так и не было. */
  _leaveCheck() {
    const l = this.leaving;
    if (!l || !this.armed) return;
    if (this.inSpawnWorld()) {
      this.disarm(l.arrived);
      return;
    }
    if (l.byGuard) {
      this._sendSpawn();
      return;
    }
    // /spawn или /warp ah писал человек, а телепорта нет (сервер пропустил команду или не пустил) — охрана работает.
    this.leaving = null;
    this.log('warn', `Охрана: после ${l.cmd} телепорта не было — охрана работает дальше`);
    if (this.active) this._startChecks(0);
  }

  _stopChecks() {
    this._clearTimeout(this.firstTimer);
    this._clearInterval(this.nearTimer);
    this._clearInterval(this.scanTimer);
    this.firstTimer = null;
    this.nearTimer = null;
    this.scanTimer = null;
  }

  _stopTimers() {
    this._stopChecks();
    this._clearTimeout(this.waitTimer);
    this._clearTimeout(this.leaveTimer);
    this.waitTimer = null;
    this.leaveTimer = null;
  }
}

const GOD_RETRY_MS = 3000; // повтор /god (на частые команды у сервера бывает задержка)
const GOD_ANSWER_MS = 5000;
// После любого /god (своего или человека) столько не судим по здоровью: сервер ещё выставляет здоровье и сытость.
const GOD_DAMAGE_REPEAT_MS = 10000;
const GOD_AFTER_PVP_MS = 1500;
const PVP_RECHECK_MS = 15000; // /god отложен до конца боя: так часто проверяем, не кончился ли бой

class GodKeeper {
  /**
   * /god — переключатель, а режим бога сервер помнит и после перезахода. Поэтому:
   *  • что сказал сервер последним, помним и между сессиями (remembered): включён — после входа не трогаем;
   *  • бот теряет здоровье или сытость (в режиме бога так не бывает) — режим выключен: пишем /god;
   *  • в лобби (режим «приключение») /god не пишем — там его нет, включим на сервере режима;
   *  • в бою (PvP) сервер команды не выполняет (а режим бога, похоже, снимает) — /god сразу после боя.
   * @param {object}   ctx
   * @param {Function} ctx.send       (команда, опции) → отправить (опции — как у охраны)
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
    this.waiting = false; // ждём ответа на /god
    this.own = false; // и этот /god — свой (не человека)
    this.attempts = 0;
    this.on = remembered === true ? true : null; // true/false — что сказал сервер последним; null — неизвестно
    this.gaveUp = false;
    this.lastToggleAt = -Infinity;
    this.prev = null; // { health, food } — прошлые значения
    this.pvp = false;
    this.pvpAt = -Infinity;
    this.afterPvp = false; // /god отложен до конца боя
  }

  get enabled() {
    return this.config.godMode !== false;
  }

  /** Идёт бой (PvP): сервер не выполняет команды. */
  get inPvp() {
    return this.pvp && this.now() - this.pvpAt < PVP_MAX_MS;
  }

  /** Проверить режим бога через ms (после входа или перехода на другой сервер). Включён — ничего не делаем. */
  schedule(ms) {
    this._clearTimeout(this.timer);
    this.attempts = 0;
    this.gaveUp = false;
    // Новый сервер: бой (если был) остался на старом.
    this.pvp = false;
    this.pvpAt = -Infinity;
    this.afterPvp = false;
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
    this.on = false;
    this.attempts = 0;
    this.gaveUp = false;
    if (this.inPvp) {
      this.afterPvp = true;
      this.log('warn', 'Режим бога, похоже, выключен (бот теряет здоровье) — идёт бой (PvP), /god сразу после боя');
      return;
    }
    this.log('warn', 'Режим бога, похоже, выключен (бот теряет здоровье или сытость) — пишу /god');
    this._toggle();
  }

  stop() {
    this._clearTimeout(this.timer);
    this._clearTimeout(this.answerTimer);
    this.timer = null;
    this.answerTimer = null;
    this.waiting = false;
  }

  /** Ушёл /god — свой (origin 'god') или человека: ждём ответа, а убыль здоровья сразу после /god не считаем. */
  onCommand(cmd, { origin = null } = {}) {
    if (!/^\/god\b/i.test(String(cmd || '').trim())) return;
    this.waiting = true;
    this.own = origin === 'god';
    this.lastToggleAt = this.now();
    this._waitAnswer();
  }

  onChat(text) {
    const line = String(text || '');
    if (PVP_ON_RE.test(line)) {
      this._pvpSeen();
      return;
    }
    if (PVP_DENY_RE.test(line)) {
      this._pvpSeen();
      if (this.waiting) {
        this.waiting = false;
        this._clearTimeout(this.answerTimer);
        if (this.enabled && this.on !== true && !this.afterPvp) {
          this.afterPvp = true;
          this.log('warn', 'Режим бога: идёт бой (PvP), сервер не выполняет команды — /god сразу после боя');
        }
      }
      return;
    }
    if (PVP_OFF_RE.test(line)) {
      this.resetPvp();
      return;
    }
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

  /** Бой кончился (сервер написал «Вы вышли из режима PvP»): отложенный /god — сейчас. */
  resetPvp() {
    this.pvp = false;
    this.pvpAt = -Infinity;
    if (!this.afterPvp) return;
    this.afterPvp = false;
    this.attempts = 0;
    this.gaveUp = false;
    this._later(() => this._toggle(), GOD_AFTER_PVP_MS);
  }

  /** Бот погиб: бой для него кончился (а отложенный /god — после возрождения). */
  onDeath() {
    this.resetPvp();
  }

  _pvpSeen() {
    this.pvp = true;
    this.pvpAt = this.now();
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

  _waitAnswer() {
    this._clearTimeout(this.answerTimer);
    this.answerTimer = this._setTimeout(() => this._noAnswer(), GOD_ANSWER_MS);
    if (this.answerTimer && typeof this.answerTimer.unref === 'function') this.answerTimer.unref();
  }

  _noAnswer() {
    this.answerTimer = null;
    if (!this.waiting) return;
    this.waiting = false;
    if (!this.own) return; // /god писал человек — повторять за него не будем
    // Ответа нет (например, сервер был занят телепортом или пропустил команду). Раз включённым его не видели —
    // пробуем ещё раз, а если и так нет — следим за уроном: он покажет, выключен ли режим.
    if (this.attempts < 2 && this.on !== true) {
      this._later(() => this._toggle(), GOD_RETRY_MS);
      return;
    }
    this.log('warn', 'Режим бога: на /god сервер ничего понятного не ответил — проверь сам; если бот начнёт терять здоровье, бот напишет /god снова');
  }

  _toggle() {
    if (!this.enabled || this.gaveUp || this.on === true) return;
    const bot = this.getBot();
    if (bot && bot.game && bot.game.gameMode === 'adventure') return; // лобби: /god там нет
    if (this.inPvp) {
      this.afterPvp = true;
      this._later(() => this._toggle(), PVP_RECHECK_MS); // конец боя можно и не увидеть
      return;
    }
    this.attempts += 1;
    this.waiting = true;
    this.own = true;
    this.lastToggleAt = this.now();
    this._waitAnswer(); // и ещё раз — когда /god правда уйдёт (его может придержать очередь команд)
    this.send('/god', { key: 'god', origin: 'god' });
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
