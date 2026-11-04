'use strict';

// Журнал пакетов: что бот отправил и получил за последнюю минуту. Нужен, чтобы разобраться, за что сервер
// или античит выгнал бота: при кике и при возврате в лобби журнал сохраняется в текстовый файл.
// Пароли из команд входа (/login, /register…) в журнал не попадают.

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { maskSecrets } = require('../chat-utils');

const KEEP_MS = 60 * 1000;
const MAX_ENTRIES = 50000;
const PRUNE_EVERY = 1000; // старые записи выбрасываем пачками, а не по одной

// Входящие пакеты, у которых сохраняем содержимое; у остальных — только имя и размер.
const IN_DETAILS = new Set([
  'login', 'respawn', 'position', 'player_rotation', 'start_configuration', 'finish_configuration',
  'kick_disconnect', 'disconnect', 'transfer', 'game_state_change', 'abilities', 'update_health',
  'explosion', 'keep_alive', 'ping', 'system_chat', 'set_title_text', 'set_title_subtitle', 'action_bar',
  'select_known_packs', 'feature_flags', 'set_ticking_state', 'step_tick', 'vehicle_move', 'set_passengers',
]);
// Пакеты про собственную сущность бота, которые интересны только для неё (у чужих — шум).
const IN_SELF = new Set(['entity_velocity', 'entity_teleport', 'sync_entity_position', 'entity_status', 'entity_effect', 'remove_entity_effect']);
// Частые входящие пакеты, которые в перечне по порядку не показываем (в счётчиках они есть).
const IN_NOISE = new Set([
  'rel_entity_move', 'entity_move_look', 'entity_look', 'entity_head_rotation', 'entity_metadata', 'entity_equipment',
  'entity_update_attributes', 'entity_velocity', 'entity_teleport', 'sync_entity_position', 'entity_status',
  'entity_effect', 'remove_entity_effect', 'spawn_entity', 'entity_destroy', 'animation', 'hurt_animation',
  'damage_event', 'set_passengers', 'attach_entity', 'collect', 'update_time', 'sound_effect',
  'entity_sound_effect', 'stop_sound', 'world_particles', 'world_event', 'bundle_delimiter', 'update_light',
  'chunk_biomes', 'block_change', 'multi_block_change', 'tile_entity_data', 'block_action',
  'block_break_animation', 'player_info', 'player_remove', 'scoreboard_score', 'scoreboard_objective',
  'scoreboard_display_objective', 'reset_score', 'teams', 'boss_bar', 'playerlist_header', 'map',
]);

const ARROW = { out: '→', in: '←', mark: '#' };

const pad = (n, len = 2) => String(n).padStart(len, '0');
const clockOf = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
};
const dateOf = (t) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Делает содержимое пакета пригодным для текста: без огромных буферов, BigInt и бесконечной вложенности. */
function compact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return `<${value.byteLength} байт>`;
  if (typeof value !== 'object') return String(value);
  if (depth >= 4) return Array.isArray(value) ? `[${value.length}]` : '{…}';
  if (Array.isArray(value)) {
    const out = value.slice(0, 20).map((v) => compact(v, depth + 1));
    if (value.length > 20) out.push(`…ещё ${value.length - 20}`);
    return out;
  }
  const out = {};
  let n = 0;
  for (const key of Object.keys(value)) {
    if (n >= 30) {
      out['…'] = 'ещё поля';
      break;
    }
    out[key] = compact(value[key], depth + 1);
    n += 1;
  }
  return out;
}

/** Команды и сообщения в отправленных пакетах — без паролей. */
function outgoingDetails(name, params) {
  if (!params || typeof params !== 'object') return compact(params);
  if ((name === 'chat_command' || name === 'chat_command_signed') && typeof params.command === 'string') {
    return { ...compact(params), command: maskSecrets(`/${params.command}`).slice(1) };
  }
  if (name === 'chat_message' && typeof params.message === 'string') {
    return { ...compact(params), message: maskSecrets(params.message) };
  }
  return compact(params);
}

function countRows(counts, seconds) {
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count, perSecond: count / seconds }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

class PacketJournal {
  /**
   * @param {object}   [opts]
   * @param {number}   [opts.keepMs]      сколько хранить записи
   * @param {number}   [opts.maxEntries]  и не больше стольких
   * @param {Function} [opts.now]         текущее время в мс (подмена для тестов)
   * @param {Function} [opts.getSelfId]   id сущности бота: её пакеты пишем подробно
   */
  constructor({ keepMs = KEEP_MS, maxEntries = MAX_ENTRIES, now, getSelfId } = {}) {
    this.keepMs = keepMs;
    this.maxEntries = maxEntries;
    this._now = typeof now === 'function' ? now : () => performance.timeOrigin + performance.now();
    this._getSelfId = typeof getSelfId === 'function' ? getSelfId : () => null;
    this._entries = [];
    this._sincePrune = 0;
    this.startedAt = this._now();
  }

  /** Начинает записывать пакеты клиента minecraft-protocol. Ничего не делает, если это не он. */
  attach(client) {
    if (!client) return;
    if (typeof client.on === 'function') {
      client.on('packet', (data, meta, buffer) => {
        try {
          this._recordIn(meta, data, buffer);
        } catch (_) {
          /* журнал не должен мешать боту */
        }
      });
    }
    if (typeof client.write === 'function') {
      const write = client.write.bind(client);
      client.write = (name, params) => {
        try {
          this._push({ t: this._now(), dir: 'out', state: client.state, name, data: outgoingDetails(name, params) });
        } catch (_) {
          /* ignore */
        }
        return write(name, params);
      };
    }
  }

  /** Отметка в журнале: что в этот момент заметила панель (кик, возврат в лобби…). */
  mark(text) {
    this._push({ t: this._now(), dir: 'mark', state: '', name: String(text) });
  }

  /** Записи не старше keepMs (и не раньше sinceMs, если он задан). */
  entries(sinceMs) {
    const from = Math.max(this._now() - this.keepMs, Number.isFinite(sinceMs) ? sinceMs : -Infinity);
    return this._entries.filter((e) => e.t >= from);
  }

  /**
   * Сколько пакетов какого вида бот отправил и получил, и насколько ровно шли тики (по tick_end).
   * @param {object} [opts]
   * @param {number} [opts.sinceMs] считать только с этого момента (время в мс, как у now)
   */
  stats({ sinceMs } = {}) {
    const now = this._now();
    const list = this.entries(sinceMs);
    // Окно: с заданного момента (но не раньше, чем хранится журнал), а без него — с первой записи.
    const from = Number.isFinite(sinceMs) ? Math.max(sinceMs, now - this.keepMs) : list.length ? list[0].t : now;
    const seconds = Math.max(0.001, (now - from) / 1000);
    const out = new Map();
    const inc = new Map();
    const tickTimes = [];
    for (const e of list) {
      if (e.dir === 'out') {
        out.set(e.name, (out.get(e.name) || 0) + 1);
        if (e.name === 'tick_end') tickTimes.push(e.t);
      } else if (e.dir === 'in') {
        inc.set(e.name, (inc.get(e.name) || 0) + 1);
      }
    }
    const gaps = [];
    for (let i = 1; i < tickTimes.length; i += 1) gaps.push(tickTimes[i] - tickTimes[i - 1]);
    const ticks = { count: tickTimes.length, gaps: gaps.length };
    if (gaps.length) {
      const sorted = [...gaps].sort((a, b) => a - b);
      ticks.avgMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      ticks.minMs = sorted[0];
      ticks.maxMs = sorted[sorted.length - 1];
      ticks.over70 = gaps.filter((g) => g > 70).length; // тик заметно запоздал
      ticks.under5 = gaps.filter((g) => g < 5).length; // тики пачкой (догоняли после подвисания)
    }
    return { seconds, out: countRows(out, seconds), in: countRows(inc, seconds), ticks };
  }

  /** Текст журнала для файла. meta — строки «Поле: значение» для шапки (без паролей!). */
  format({ reason = '', meta = {} } = {}) {
    const now = this._now();
    const list = this.entries();
    const st = this.stats();
    const lines = [];
    lines.push('Журнал пакетов MineBlaze Bot Panel');
    lines.push(`Сохранён: ${dateOf(now)} ${clockOf(now)}${reason ? ` — ${reason}` : ''}`);
    for (const [key, value] of Object.entries(meta)) lines.push(`${key}: ${value}`);
    lines.push(`Записей: ${list.length} за ${st.seconds.toFixed(1)} с`);
    lines.push('');
    lines.push(`Бот отправил за ${st.seconds.toFixed(1)} с:`);
    if (!st.out.length) lines.push('  ничего');
    for (const r of st.out) lines.push(`  ${r.name.padEnd(26)} ${String(r.count).padStart(7)}   ${r.perSecond.toFixed(2)} в секунду`);
    if (st.ticks.gaps) {
      const t = st.ticks;
      lines.push(
        `Промежутки между tick_end: в среднем ${t.avgMs.toFixed(1)} мс, от ${t.minMs.toFixed(1)} до ${t.maxMs.toFixed(1)} мс; ` +
          `длиннее 70 мс: ${t.over70}, пачкой (меньше 5 мс): ${t.under5}`,
      );
    }
    lines.push('');
    lines.push(`Сервер прислал за ${st.seconds.toFixed(1)} с:`);
    if (!st.in.length) lines.push('  ничего');
    for (const r of st.in.slice(0, 50)) lines.push(`  ${r.name.padEnd(26)} ${String(r.count).padStart(7)}   ${r.perSecond.toFixed(2)} в секунду`);
    lines.push('');
    lines.push('По порядку (→ бот отправил, ← сервер прислал, # отметка панели; частые пакеты о чужих сущностях, звуках и свете опущены):');
    for (const e of list) {
      if (e.dir === 'in' && e.data === undefined && IN_NOISE.has(e.name)) continue;
      let line = `${clockOf(e.t)}  ${ARROW[e.dir] || '?'}  `;
      if (e.dir === 'mark') {
        line += e.name;
      } else {
        line += `${String(e.state || '').padEnd(13)} ${e.name}`;
        if (e.size !== undefined) line += `  ${e.size} Б`;
        if (e.data !== undefined) line += `  ${JSON.stringify(e.data)}`;
      }
      lines.push(line);
    }
    return `${lines.join('\n')}\n`;
  }

  // ---------- внутреннее ----------

  _recordIn(meta, data, buffer) {
    const name = meta && meta.name;
    if (!name) return;
    const entry = { t: this._now(), dir: 'in', state: meta.state, name };
    if (buffer && typeof buffer.length === 'number') entry.size = buffer.length;
    if (IN_DETAILS.has(name)) {
      entry.data = compact(data);
    } else if (IN_SELF.has(name) && data && data.entityId !== undefined && data.entityId === this._getSelfId()) {
      entry.data = compact(data);
    }
    this._push(entry);
  }

  _push(entry) {
    this._entries.push(entry);
    this._sincePrune += 1;
    if (this._sincePrune >= PRUNE_EVERY || this._entries.length > this.maxEntries * 1.2) this._prune();
  }

  _prune() {
    this._sincePrune = 0;
    const from = this._now() - this.keepMs;
    let start = 0;
    while (start < this._entries.length && this._entries[start].t < from) start += 1;
    start = Math.max(start, this._entries.length - this.maxEntries);
    if (start > 0) this._entries = this._entries.slice(start);
  }
}

/**
 * Сохраняет журнал в файл packets-ГГГГ-ММ-ДД_ЧЧ-ММ-СС.txt в папке dir; старые файлы сверх keepFiles удаляет.
 * @returns {string} путь к файлу
 */
function saveJournal(journal, dir, { reason = '', meta = {}, keepFiles = 30, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
  let file = path.join(dir, `packets-${stamp}.txt`);
  for (let i = 2; fs.existsSync(file); i += 1) file = path.join(dir, `packets-${stamp}-${i}.txt`);
  fs.writeFileSync(file, journal.format({ reason, meta }), 'utf8');
  try {
    // По времени в имени, а внутри одной секунды — по номеру (просто по имени «-38.txt» оказался бы после «-38-2.txt»).
    const NAME_RE = /^packets-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:-(\d+))?\.txt$/;
    const old = fs
      .readdirSync(dir)
      .map((f) => ({ f, m: f.match(NAME_RE) }))
      .filter((x) => x.m)
      .sort((a, b) => a.m[1].localeCompare(b.m[1]) || Number(a.m[2] || 1) - Number(b.m[2] || 1))
      .map((x) => x.f);
    for (const f of old.slice(0, Math.max(0, old.length - keepFiles))) fs.rmSync(path.join(dir, f), { force: true });
  } catch (_) {
    /* не удалось почистить старые — не страшно */
  }
  return file;
}

module.exports = { PacketJournal, saveJournal, compact };
