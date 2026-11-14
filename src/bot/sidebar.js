'use strict';

// Табло справа (sidebar) — строки, как их видит игрок, и баланс из строки «Баланс» (MineBlaze: «• Баланс • $837.7k»).
// Плагины табло рисуют строку по-разному, поэтому текст строки собирается из всего, что бывает:
//  - подпись очка (scoreboard_score.display_name, 1.20.3+) — иначе имя записи;
//  - префикс и суффикс команды (teams), в которую записана эта запись (так рисуют табло старые плагины);
//  - «текст вместо числа» (number_format: fixed) — справа от строки.
// Строки идут сверху вниз по убыванию очков, как в игре. Пакеты читаем сами: mineflayer подпись очка не хранит.

const { chatToText } = require('../chat-utils');

const SIDEBAR = 1; // позиция табло справа в scoreboard_display_objective
const BALANCE_RE = /баланс|balance/i; // не «Коинов»: это другая валюта

const clean = (s) => String(s || '').replace(/§./g, '');

/**
 * Сумма из текста: «$837.7k», «837,7к», «$600», «1.5M», «12 345,67». → { value, safe, text } или null.
 * value — как показано; safe — сколько точно есть: показанное число округлено, поэтому минус половина последнего
 * разряда («837.7k» — это 837 650…837 799: безопасно 837 650).
 */
function parseMoney(text) {
  const s = clean(text);
  const m = /(\d[\d\s ]*(?:[.,]\d+)*)\s*(kkk|ккк|kk|кк|[kкmмbб])?(?![a-zа-яё])/i.exec(s);
  if (!m) return null;
  let num = m[1].replace(/[\s ]/g, '');
  // «12,345.67» — запятые тысяч; «837,7» — дробная запятая; «1.234.567» — точки тысяч.
  if (num.includes('.') && num.includes(',')) num = num.replace(/,/g, '');
  else if ((num.match(/\./g) || []).length > 1) num = num.replace(/\./g, '');
  else num = num.replace(',', '.');
  const value = Number(num);
  if (!Number.isFinite(value)) return null;
  const decimals = num.includes('.') ? num.split('.')[1].length : 0;
  const suffix = (m[2] || '').toLowerCase().replace(/к/g, 'k').replace(/м/g, 'm').replace(/б/g, 'b');
  const mult = { '': 1, k: 1e3, kk: 1e6, m: 1e6, kkk: 1e9, b: 1e9 }[suffix] || 1;
  const step = 10 ** -decimals;
  // Без «k»/«M» и с копейками («$600.25») — число и так точное до копеек; округлённое до целых — минус полрубля.
  const safe = Math.max(0, Math.floor((value - (mult === 1 && decimals >= 2 ? 0 : step / 2)) * mult + 1e-9));
  return { value: value * mult, safe, text: m[0].trim() };
}

/**
 * Следить за табло бота с самого входа (пакеты табло приходят один раз, потом — только изменения).
 * → { lines() — строки сверху вниз, balance() — { value, safe, text, line } или null } (и bot.sidebar).
 * Изменился баланс — событие бота 'balance' ({ value, safe, text }).
 */
function attachSidebar(bot) {
  const objectives = new Map(); // имя → { title }
  const scores = new Map(); // имя табло → Map(запись → { value, display, fixed })
  let shown = null; // какое табло сейчас справа
  let lastBalance = null;
  const c = bot._client;
  const fixedText = (p) => (p && p.number_format === 2 && p.styling !== undefined ? chatToText(p.styling) : '');

  const changed = () => {
    let b = null;
    try {
      b = balance();
    } catch (_) {
      b = null;
    }
    const key = b ? b.text : '';
    if (key === lastBalance) return;
    lastBalance = key;
    if (b) bot.emit('balance', { value: b.value, safe: b.safe, text: b.text });
  };

  if (c && typeof c.on === 'function') {
    c.on('scoreboard_objective', (p) => {
      if (!p) return;
      if (p.action === 1) {
        objectives.delete(p.name);
        scores.delete(p.name);
        if (shown === p.name) shown = null;
      } else {
        objectives.set(p.name, { title: chatToText(p.displayText) });
      }
      changed();
    });
    c.on('scoreboard_display_objective', (p) => {
      if (!p || p.position !== SIDEBAR) return;
      shown = p.name || null;
      changed();
    });
    c.on('scoreboard_score', (p) => {
      if (!p || !p.scoreName) return;
      let map = scores.get(p.scoreName);
      if (!map) scores.set(p.scoreName, (map = new Map()));
      // Подпись и «текст вместо числа» приходят с каждым обновлением очка (как у ванили); нет — значит, их нет.
      map.set(p.itemName, {
        value: p.value,
        display: p.display_name !== undefined && p.display_name !== null ? chatToText(p.display_name) : null,
        fixed: fixedText(p),
      });
      if (p.scoreName === shown) changed();
    });
    c.on('reset_score', (p) => {
      if (!p) return;
      const names = p.objective_name ? [p.objective_name] : [...scores.keys()];
      for (const n of names) {
        const map = scores.get(n);
        if (map) map.delete(p.entity_name);
      }
      changed();
    });
    // Префикс и суффикс команды меняются отдельно от очков (так обновляют табло старые плагины).
    c.on('teams', () => setImmediate(changed));
  }

  /** Текст строки табло: подпись (или имя записи с префиксом и суффиксом команды) и текст вместо числа. */
  function lineText(entry, s) {
    let text = s.display;
    if (text === null || text === undefined) {
      const team = bot.teamMap ? bot.teamMap[entry] : null;
      const part = (m) => {
        if (!m) return '';
        try {
          return clean(typeof m.toString === 'function' ? m.toString() : chatToText(m));
        } catch (_) {
          return '';
        }
      };
      text = team ? `${part(team.prefix)}${clean(entry)}${part(team.suffix)}` : clean(entry);
    }
    return `${text}${s.fixed ? ` ${s.fixed}` : ''}`.replace(/\s+/g, ' ').trim();
  }

  function lines() {
    if (!shown || !scores.has(shown)) return [];
    return [...scores.get(shown)].sort((a, b) => b[1].value - a[1].value).map(([entry, s]) => lineText(entry, s)).filter(Boolean);
  }

  /** Баланс из строки табло со словом «Баланс». → { value, safe, text, line } или null. */
  function balance() {
    for (const line of lines()) {
      const at = line.search(BALANCE_RE);
      if (at < 0) continue;
      const rest = line.slice(at).replace(BALANCE_RE, '').replace(/^[^\d$€₽]+/, '');
      const money = parseMoney(rest);
      // Для показа — как на табло: «$837.7k».
      if (money) return { ...money, text: (rest.match(/^[$€₽]?\s*\S+/) || [money.text])[0].replace(/\s+/g, ''), line };
    }
    return null;
  }

  const api = { lines, balance, title: () => (shown && objectives.has(shown) ? objectives.get(shown).title : '') };
  bot.sidebar = api;
  return api;
}

module.exports = { attachSidebar, parseMoney };
