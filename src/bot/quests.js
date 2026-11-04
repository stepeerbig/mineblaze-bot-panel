'use strict';

// Задания NPC на MineBlaze (Фермер, Алхимик, Оружейник): разбор меню «Улучшения» (задания) и «Покупка» (товары).
// Здесь только чтение текста предметов меню; клики делают команды (src/bot/commands.js).
//
// Как выглядит задание (лор предмета в меню, строки через « / »):
//   «Грядки без истерики.» — …описание… / ▪ Награда: 24 хлеба / Передайте пшеницу, морковь, / картофель или свёклу: 0/224
//   «Посиди у костра.» — … / ▪ Награда: 2 500 монет / Проведите на сервере: 0 м./3 ч. / Нажмите, чтобы взять задание
// «Нажмите, чтобы взять задание» — задание ещё не взято. Цель — строка «<что сделать>: <сделано>/<нужно>».
// Товар в «Покупке»: «Тюк сена» — … / Осталось › 6 / Цена › 8400.0 / › Нажмите, чтобы купить

// Глагол цели → вид задания.
const VERBS = [
  ['Купите', 'buy'], ['Потратьте', 'buy'],
  ['Передайте', 'deliver'], ['Сдайте', 'deliver'], ['Принесите', 'deliver'], ['Отдайте', 'deliver'],
  ['Разведите', 'breed'], ['Убейте', 'kill'], ['Уничтожьте', 'kill'], ['Проведите', 'time'],
  ['Добудьте', 'other'], ['Поймайте', 'other'], ['Соберите', 'other'], ['Вырастите', 'other'], ['Приготовьте', 'other'],
  ['Скрафтите', 'other'], ['Создайте', 'other'], ['Сломайте', 'other'], ['Выловите', 'other'], ['Наловите', 'other'],
  ['Найдите', 'other'], ['Посетите', 'other'], ['Используйте', 'other'], ['Съешьте', 'other'], ['Выкопайте', 'other'],
];
const KIND_OF = new Map(VERBS.map(([v, k]) => [v.toLowerCase(), k]));
// Число: «12 000» (тысячи через пробел), «224», «8400.0».
const NUM = String.raw`\d{1,3}(?:[  ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?`;
const UNIT = String.raw`(?:м\.|мин\.?|ч\.|сек\.?|с\.)`;
const OBJECTIVE_RE = new RegExp(
  `(${VERBS.map(([v]) => v).join('|')})\\s+([^:]*?):\\s*(${NUM})\\s*(${UNIT})?\\s*\\/\\s*(${NUM})\\s*(${UNIT})?(?=[\\s.!,;]|$)`,
  'iu',
);
// Время: «Проведите на сервере: 1 ч. 20 м./3 ч.» — у сделанного и нужного может быть по нескольку частей.
const DURATION = String.raw`(?:\d+\s*(?:ч|мин|м|сек|с)\.?\s*)+`;
const TIME_RE = new RegExp(`(Проведите\\s+[^:]*?):\\s*(${DURATION})\\/\\s*(${DURATION})`, 'iu');
const TAKE_RE = /нажмите,?\s*чтобы\s*взять\s*задание/i;
const DONE_RE = /задание\s+(?:выполнено|завершено)/i;
const REWARD_RE = /награда:\s*(.+)/i;
const LEVEL_RE = /задания уровня|повысить уровень|следующий уровень|уровень доверия повышен/i;
const BUY_RE = /нажмите,?\s*чтобы\s*купить/i;

/** «2 500» → 2500, «8400.0» → 8400, «1,5» → 1.5. */
function parseNumber(text) {
  const s = String(text || '').replace(/[\s ]/g, '');
  if (!s) return NaN;
  // «8400.0» и «1,5» — дробные; «2.500» как разделитель тысяч на этих меню не встречается.
  return Number(s.replace(',', '.').replace(/\.$/, ''));
}

/** «1 ч. 20 м.» → 80 (минут). */
function parseDuration(text) {
  let min = 0;
  for (const m of String(text || '').matchAll(/(\d+)\s*(ч|мин|м|сек|с)/gi)) {
    const n = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u === 'ч') min += n * 60;
    else if (u === 'сек' || u === 'с') min += n / 60;
    else min += n;
  }
  return min;
}

// Что принести: русские слова (в любом падеже — по началу слова) → предметы. Сначала составные.
// Основы — с начала слова, чтобы «нит» не нашлась в «граните», а «мёд» — в «меди».
const w = (stem) => new RegExp(`(?:^|[\\s-])(?:${stem})`);
const ITEM_WORDS = [
  [w('семен\\S*\\s+пшениц'), ['wheat_seeds']], [w('семен\\S*\\s+тыкв'), ['pumpkin_seeds']], [w('семен\\S*\\s+арбуз'), ['melon_seeds']],
  [w('семен\\S*\\s+св[её]кл'), ['beetroot_seeds']], [w('семен'), ['wheat_seeds']],
  [w('бел\\S*\\s+шерст'), ['white_wool']], [w('шерст'), ['white_wool']],
  [w('светящ\\S*\\s+ягод'), ['glow_berries']], [w('сладк\\S*\\s+ягод|ягод'), ['sweet_berries']],
  [w('сахарн\\S*\\s+тростник|тростник'), ['sugar_cane']], [w('какао'), ['cocoa_beans']],
  [w('золот\\S*\\s+слит'), ['gold_ingot']], [w('железн\\S*\\s+слит'), ['iron_ingot']], [w('медн\\S*\\s+слит'), ['copper_ingot']],
  [w('красн\\S*\\s+пыл|редстоун'), ['redstone']], [w('гнил\\S*\\s+плот'), ['rotten_flesh']], [w('паучь\\S*\\s+глаз'), ['spider_eye']],
  [w('огненн\\S*\\s+стерж|стерж\\S*\\s+ифрит'), ['blaze_rod']], [w('жемчуг|\\S*эндер\\S*\\s+жемчуг'), ['ender_pearl']],
  [w('мембран'), ['phantom_membrane']], [w('шкур\\S*\\s+кролик|кроличь\\S*\\s+шкур'), ['rabbit_hide']],
  [w('кроличь\\S*\\s+лап'), ['rabbit_foot']], [w('жарен\\S*\\s+говядин|стейк'), ['cooked_beef']],
  [w('сыр\\S*\\s+говядин|говядин'), ['beef']], [w('сыр\\S*\\s+свинин|свинин'), ['porkchop']],
  [w('сыр\\S*\\s+курятин|курятин'), ['chicken']], [w('баранин'), ['mutton']], [w('сыр\\S*\\s+крольчатин|крольчатин'), ['rabbit']],
  [w('тыквенн\\S*\\s+пирог'), ['pumpkin_pie']], [w('костян\\S*\\s+мук'), ['bone_meal']],
  [w('пшениц'), ['wheat']], [w('морков'), ['carrot']], [w('картоф|картошк'), ['potato']], [w('св[её]кл'), ['beetroot']],
  [w('тыкв'), ['pumpkin']], [w('арбуз'), ['melon_slice']], [w('кактус'), ['cactus']], [w('бамбук'), ['bamboo']],
  [w('кож(?!ан)'), ['leather']], [w('пер(?:ья|о|ьев)'), ['feather']], [w('яйц|яиц'), ['egg']], [w('молок'), ['milk_bucket']],
  [w('м[её]д(?!ь|н)'), ['honey_bottle']], [w('треск'), ['cod']], [w('лосос'), ['salmon']],
  [w('тропическ\\S*\\s+рыб'), ['tropical_fish']], [w('иглобрюх|рыб\\S*\\s+фуг'), ['pufferfish']],
  [w('яблок'), ['apple']], [w('печень'), ['cookie']], [w('хлеб'), ['bread']], [w('торт'), ['cake']], [w('сен[оа]|тюк'), ['hay_block']],
  [w('угол|угл[яеиь]'), ['coal']], [w('алмаз'), ['diamond']], [w('изумруд'), ['emerald']], [w('лазурит'), ['lapis_lazuli']],
  [w('кварц'), ['quartz']], [w('кост(?!ян)'), ['bone']], [w('нит'), ['string']], [w('порох'), ['gunpowder']],
  [w('слиз'), ['slime_ball']], [w('стрел'), ['arrow']], [w('бр[её]вн|древесин'), ['oak_log']], [w('гриб'), ['brown_mushroom', 'red_mushroom']],
];

/** «пшеницу, морковь, картофель или свёклу» → ['wheat', 'carrot', 'potato', 'beetroot']; неизвестное — пропускается. */
function deliverItems(what) {
  const out = [];
  const parts = String(what || '').toLowerCase().split(/\s*,\s*|\s+или\s+|\s+и\s+/);
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    const hit = ITEM_WORDS.find(([re]) => re.test(part));
    if (hit) for (const id of hit[1]) if (!out.includes(id)) out.push(id);
  }
  return out;
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * Задание из предмета меню. lore — строки описания. null — это не задание (стекло, «Назад», кнопка уровня…).
 */
function parseQuest(slot, title, lore, icon = '') {
  const lines = (Array.isArray(lore) ? lore : []).map(clean).filter(Boolean);
  const text = lines.join(' ');
  let verb;
  let what;
  let have;
  let need;
  let unit = '';
  const t = TIME_RE.exec(text);
  const m = t ? null : OBJECTIVE_RE.exec(text);
  if (t) {
    verb = 'Проведите';
    what = t[1].replace(/^Проведите\s+/i, '');
    have = parseDuration(t[2]);
    need = parseDuration(t[3]);
    unit = 'мин';
  } else if (m) {
    verb = m[1];
    what = m[2];
    have = parseNumber(m[3]);
    need = parseNumber(m[5]);
    if (m[4] || m[6]) {
      have = parseDuration(`${m[3]} ${m[4] || m[6]}`);
      need = parseDuration(`${m[5]} ${m[6] || m[4]}`);
      unit = 'мин';
    }
  } else {
    return null;
  }
  const kind = KIND_OF.get(verb.toLowerCase()) || 'other';
  const rewardLine = lines.find((l) => REWARD_RE.test(l));
  const reward = rewardLine ? clean(REWARD_RE.exec(rewardLine)[1]).replace(/^[▪•·\s]+/, '') : null;
  const goal = clean(`${verb} ${what}`);
  const quest = {
    slot,
    title: clean(title),
    icon,
    kind,
    goal,
    have: Number.isFinite(have) ? have : 0,
    need: Number.isFinite(need) ? need : 0,
    unit,
    reward,
    taken: !TAKE_RE.test(text),
    done: false,
    items: kind === 'deliver' ? deliverItems(what) : [],
  };
  quest.done = (quest.need > 0 && quest.have >= quest.need) || DONE_RE.test(text);
  return quest;
}

/**
 * Меню заданий: { quests, level } — level — кнопка уровня («Ещё не все задания уровня выполнены до конца.»):
 * { slot, text, ready } (ready — можно нажать, чтобы перейти на следующий уровень).
 * slots — [{ slot, title, lore, icon }].
 */
function parseQuestMenu(slots) {
  const quests = [];
  let level = null;
  for (const s of slots) {
    const q = parseQuest(s.slot, s.title, s.lore, s.icon);
    if (q) {
      quests.push(q);
      continue;
    }
    const text = clean((s.lore || []).join(' '));
    if (LEVEL_RE.test(text) || LEVEL_RE.test(s.title || '')) {
      level = { slot: s.slot, title: clean(s.title), text, ready: !/не все|не выполнен/i.test(text) && /нажмите/i.test(text) };
    }
  }
  return { quests, level };
}

/** Товар меню «Покупка»: { slot, title, icon, count, price, left, buyable } или null. */
function parseOffer(s) {
  const lines = (s.lore || []).map(clean);
  const text = lines.join(' ');
  if (!BUY_RE.test(text) && !/цена/i.test(text)) return null;
  const price = /цена\s*[›>:»]?\s*([\d\s .,]+)/i.exec(text);
  const left = /осталось\s*[›>:»]?\s*([\d\s ]+)/i.exec(text);
  return {
    slot: s.slot,
    title: clean(s.title),
    icon: s.icon || '',
    count: s.count || 1,
    price: price ? parseNumber(price[1]) : null,
    left: left ? parseNumber(left[1]) : null,
    buyable: BUY_RE.test(text),
  };
}

// Ответы сервера в чате (MineBlaze, скриншоты пользователя; системные строки начинаются с «|»):
//   «| Вы взяли задание Ночная прополка.»
//   «| Вы передали Ягодный запас» → «| Задание Лесная кислинка выполнено» → «| Вы получаете награду: 16 печенек»
const CHAT_START = String.raw`^\s*(?:[|│▎▍▌▐┃]\s*)?`;
const QUEST_CHAT = [
  ['took', new RegExp(`${CHAT_START}Вы взяли задание\\s+(.+?)\\s*$`, 'i')],
  ['gave', new RegExp(`${CHAT_START}Вы передали\\s+(.+?)\\s*$`, 'i')],
  ['done', new RegExp(`${CHAT_START}Задание\\s+(.+?)\\s+(?:выполнено|завершено)[.!]?\\s*$`, 'i')],
  ['reward', new RegExp(`${CHAT_START}Вы получаете награду:\\s*(.+?)\\s*$`, 'i')],
];

/** Сообщение сервера о задании → { type: took | gave | done | reward, text } или null (не о задании). */
function parseQuestChat(line) {
  const s = clean(line);
  for (const [type, re] of QUEST_CHAT) {
    const m = re.exec(s);
    if (m) return { type, text: m[1].replace(/[.!]+$/, '').trim() };
  }
  return null;
}

/** То же название задания в меню и в чате: «Ночная прополка.» = «Ночная прополка». */
const sameTitle = (a, b) => clean(a).replace(/[.!]+$/, '').toLowerCase() === clean(b).replace(/[.!]+$/, '').toLowerCase();

const KIND_NAMES = { buy: 'купить у NPC', deliver: 'сдать', breed: 'развести', kill: 'убить', time: 'время на сервере', other: 'задание' };

/** Строка о задании для человека. */
function describeQuest(q) {
  const progress = q.unit === 'мин' ? `${fmtMinutes(q.have)} из ${fmtMinutes(q.need)}` : `${fmtNum(q.have)}/${fmtNum(q.need)}`;
  let state = q.taken ? '' : 'не взято, ';
  if (q.done) state = 'выполнено, ';
  const items = q.items.length ? ` (${q.items.join(', ')})` : '';
  return `[${q.slot}] ${q.title} — ${state}${q.goal}${items}: ${progress}${q.reward ? `; награда: ${q.reward}` : ''}`;
}

function fmtNum(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 10) / 10);
}

function fmtMinutes(min) {
  if (min >= 60 && min % 60 === 0) return `${min / 60} ч`;
  if (min >= 60) return `${Math.floor(min / 60)} ч ${Math.round(min % 60)} мин`;
  return `${Math.round(min)} мин`;
}

/** Совпадает ли название с запросом по-русски: «сено» ~ «Тюк сена» (по началу слов). */
function matchesQuery(text, query) {
  const t = String(text || '').toLowerCase().replace(/ё/g, 'е');
  const words = String(query || '').toLowerCase().replace(/ё/g, 'е').split(/\s+/).filter((w) => w.length >= 2);
  if (!words.length) return false;
  return words.every((w) => t.includes(w.length > 4 ? w.slice(0, w.length - 2) : w.slice(0, Math.max(2, w.length - 1))));
}

module.exports = {
  parseQuest, parseQuestMenu, parseOffer, deliverItems, describeQuest, parseNumber, parseDuration, matchesQuery, parseQuestChat, sameTitle, KIND_NAMES,
};
