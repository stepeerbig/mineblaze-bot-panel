'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQuest, parseQuestMenu, parseOffer, deliverItems, describeQuest, parseNumber, parseDuration, matchesQuery, parseQuestChat, sameTitle,
  questNpc, questRules, MAX_NPC_LEVEL, ITEM_WORDS, mobsOf, MOB_WORDS,
} = require('../src/bot/quests');
const { VERSION } = require('./fake-bot');

test('ответы сервера о заданиях (скриншоты MineBlaze): взял, передал, выполнено, награда', () => {
  assert.deepEqual(parseQuestChat('| Вы взяли задание Ночная прополка.'), { type: 'took', text: 'Ночная прополка' });
  assert.deepEqual(parseQuestChat('| Вы передали Ягодный запас'), { type: 'gave', text: 'Ягодный запас' });
  assert.deepEqual(parseQuestChat('| Задание Лесная кислинка выполнено'), { type: 'done', text: 'Лесная кислинка' });
  assert.deepEqual(parseQuestChat('| Вы получаете награду: 16 печенек'), { type: 'reward', text: '16 печенек' });
  assert.equal(parseQuestChat('[Ender] zJeezy → Вы получаете награду: 1000 монет'), null, 'игрок не может «ответить» за сервер');
  assert.equal(parseQuestChat('| Перемещение на ah.'), null);
  assert.ok(sameTitle('Ночная прополка.', 'Ночная прополка'));
  assert.ok(!sameTitle('Ночная прополка.', 'Лесная кислинка'));
});

test('кнопка уровня (скриншоты 5 ноября): готова — «Доступно улучшение»; ответ сервера — «Уровень доверия повышен»', () => {
  assert.deepEqual(parseQuestChat('| Уровень доверия повышен! Текущий уровень: 4 ↑'), { type: 'level', text: '4', level: 4 });
  assert.deepEqual(parseQuestChat('Уровень доверия повышен!'), { type: 'level', text: '', level: null });
  assert.equal(parseQuestChat('[Ender] zJeezy → Уровень доверия повышен! Текущий уровень: 4'), null, 'игрок не может «ответить» за сервер');

  const sunflower = (title, lore) => [{ slot: 40, title, icon: 'sunflower', lore }];
  // Надпись — в названии предмета или в лоре: годится и так, и так.
  for (const menu of [
    sunflower('Доступно улучшение', ['', 'Нажмите, чтобы перейти на новый уровень!']),
    sunflower('Sunflower', ['Доступно улучшение', '', 'Нажмите, чтобы перейти на новый уровень!']),
  ]) {
    const { level } = parseQuestMenu(menu);
    assert.equal(level && level.slot, 40);
    assert.equal(level.ready, true, JSON.stringify(menu));
  }
  assert.equal(parseQuestMenu(sunflower('Sunflower', ['Ещё не все задания уровня', 'выполнены до конца.'])).level.ready, false);
  // Главное меню NPC — не меню заданий: «Повышайте уровень доверия фермера» — не кнопка уровня.
  const main = [
    { slot: 20, title: 'Покупка', icon: 'hay_block', lore: ['Вам доступны товары 3 уровня'] },
    { slot: 22, title: 'Улучшения', icon: 'experience_bottle', lore: ['Повышайте уровень доверия фермера', 'Вам доступны товары 3 уровня'] },
  ];
  assert.equal(parseQuestMenu(main).level, null);
});

// Меню «Фермер › Уровень 1 → 2» с MineBlaze (из лога панели, #окно; строки описания были через « / »).
const FARMER_LOG = [
  [10, 'Аванс на семена.', 'gold_ingot', 'Фермер потёр ладони и сказал, / что у любой приличной деревни / сначала появляется бюджет, а / потом уже драма. Помоги ему / распродать первую витрину - и / он начнёт относиться к тебе как / к человеку, а не как к ходячей / тыкве. / Купите у Фермера товаров на: 0/12000'],
  [11, 'Грядки без истерики.', 'wheat', 'После последней непогоды огород / выглядит так, будто его / редактировал крипер. Собери / приличный набор урожая, пока / Фермер не начал разговаривать с / морковкой о смысле жизни. / ▪ Награда: 24 хлеба / Передайте пшеницу, морковь, / картофель или свёклу: 0/224'],
  [12, 'Сарай, который мы заслужили.', 'leather', 'Фермер уверяет, что хороший / сарай начинается не с досок, а / с полезного хлама. Притащи всё, / что обычно валяется у животных / под ногами, и сарай внезапно / станет проектом века. / ▪ Награда: 2 поводка / Передайте кожу, белую шерсть, / перья или яйца: 0/96'],
  [13, 'Коровы, умножайтесь.', 'wheat', 'План Фермера прост: если коров / станет больше, все проблемы / автоматически начнут пахнуть / молоком и кожей. Звучит / сомнительно, но на практике / работает на удивление часто. / ▪ Награда: 16 стейков / Разведите коров: 0/12'],
  [14, 'Посиди у костра.', 'clock', 'Фермер говорит, что деревню / нельзя понять бегом. Нужно / иногда просто остаться, / послушать потрескивание костра, / посмотреть на грядки и дать / соседям шанс посплетничать о / тебе без твоего участия. / ▪ Награда: 2 500 монет / Проведите на сервере: 0 м./3 ч. / Нажмите, чтобы взять задание'],
  [15, 'Семенной запас.', 'wheat_seeds', 'Если семена лежат по пяти / сундукам, это не хозяйство, а / квест на терпение. Собери / приличный запас, пока Фермер не / начал сеять надежду вручную. / ▪ Награда: 24 костной муки / Передайте семена пшеницы, / семена тыквы, семена арбуза или / семена свёклы: 0/160'],
  [16, 'Рыбный четверг.', 'cod', 'Фермер решил, что стол без рыбы / - это просто длинный разговор о / картошке. Подкинь улова, и / деревня хотя бы вечером / почувствует себя портовым / городом. / ▪ Награда: 2 костра / Передайте треску или лосося: 0/96'],
  [19, 'Лесная кислинка.', 'sweet_berries', 'Яблоки и ягоды нужны не только / детям и лисам. Фермер уверяет, / что это стратегический десерт. / Спорить опасно, проще принести. / ▪ Награда: 16 печенек / Передайте сладкие ягоды или / яблоки: 0/96'],
  [20, 'Куриная математика.', 'egg', 'У куриц удивительный талант / превращать зерно в хаос и яйца. / Немного помоги этому безумию, и / склад еды станет заметно / веселее. / ▪ Награда: 12 тыквенных пирогов / Разведите куриц: 0/16'],
  [21, 'Ночная прополка.', 'string', 'Пауки считают грядки / общежитием. Покажи им, что / бронь отменена и паутина больше / не входит в сервис. / ▪ Награда: 24 нити / Убейте пауков: 0/20 / Нажмите, чтобы взять задание'],
  [36, 'Назад', 'arrow', ''],
  [40, 'Sunflower', 'sunflower', 'Ещё не все задания уровня / выполнены до конца.'],
].map(([slot, title, icon, lore]) => ({ slot, title, icon, lore: lore ? lore.split(' / ') : [] }));

test('задания Фермера: все 10 разобраны — вид, цель, прогресс, награда, взято или нет', () => {
  const { quests, level } = parseQuestMenu(FARMER_LOG);
  assert.equal(quests.length, 10);
  const by = Object.fromEntries(quests.map((q) => [q.slot, q]));

  assert.deepEqual(
    [by[10].kind, by[10].goal, by[10].have, by[10].need, by[10].reward, by[10].taken],
    ['buy', 'Купите у Фермера товаров на', 0, 12000, null, true],
  );
  assert.deepEqual([by[11].kind, by[11].need, by[11].reward, by[11].items], ['deliver', 224, '24 хлеба', ['wheat', 'carrot', 'potato', 'beetroot']]);
  assert.deepEqual(by[12].items, ['leather', 'white_wool', 'feather', 'egg']);
  assert.deepEqual([by[13].kind, by[13].goal, by[13].need], ['breed', 'Разведите коров', 12]);
  assert.deepEqual(
    [by[14].kind, by[14].have, by[14].need, by[14].unit, by[14].reward, by[14].taken],
    ['time', 0, 180, 'мин', '2 500 монет', false],
  );
  assert.deepEqual(by[15].items, ['wheat_seeds', 'pumpkin_seeds', 'melon_seeds', 'beetroot_seeds']);
  assert.deepEqual(by[16].items, ['cod', 'salmon']);
  assert.deepEqual(by[19].items, ['sweet_berries', 'apple']);
  assert.deepEqual([by[20].kind, by[20].need], ['breed', 16]);
  assert.deepEqual([by[21].kind, by[21].goal, by[21].need, by[21].taken], ['kill', 'Убейте пауков', 20, false]);
  assert.ok(quests.every((q) => !q.done));

  assert.deepEqual(level, { slot: 40, title: 'Sunflower', text: 'Ещё не все задания уровня выполнены до конца.', ready: false });
  assert.equal(
    describeQuest(by[14]),
    '[14] Посиди у костра. — не взято, Проведите на сервере: 0 мин из 3 ч; награда: 2 500 монет',
  );
  assert.equal(
    describeQuest(by[11]),
    '[11] Грядки без истерики. — Передайте пшеницу, морковь, картофель или свёклу (wheat, carrot, potato, beetroot): 0/224; награда: 24 хлеба',
  );
});

// «Алхимик › Уровень 1 → 2» (скриншоты 5 ноября; строки — как переносит сервер).
const ALCHEMIST = [
  [10, 'Расширение лаборатории.', 'gold_ingot', 'Алхимик дорос до стадии «мне / нужен второй стол и ещё три / подозрительные колбы». Помоги / ему прокрутить оборот, чтобы / лаборатория стала похожа на / место силы, а не на кладовку / ведьмы. / Купите у Алхимика товаров на: 0/60000'],
  [11, 'Огненная основа.', 'blaze_rod', 'Без огненных реагентов алхимия / превращается в настой ромашки. / Алхимик просит всё, что горит, / пылает и заставляет брови / исчезать без предупреждения. / ▪ Награда: 24 огненного порошка / Передайте огненные стержни или / огненный порошок: 0/96'],
  [12, 'Грядка из ада.', 'nether_wart', 'Алхимик с нежностью смотрит на / незерский нарост так, как / нормальные люди смотрят на / хорошую зарплату. Собери / побольше - и его глаза снова / будут страшными, но / счастливыми. / ▪ Награда: 16 светокаменной пыли / Передайте незерский нарост: 0/192'],
  [13, 'Крем от всего.', 'magma_cream', 'По словам Алхимика, магмовый / крем нужен буквально везде: в / зельях, в формулах и, возможно, / в его самооценке. Принеси запас / и не спрашивай, зачем столько. / ▪ Награда: 16 огненных зарядов / Передайте магмовый крем: 0/64'],
  [14, 'Перепись пиглинов.', 'golden_sword', 'Алхимик решил, что пиглины / мешают логистике, философии и / вообще всему хорошему. Сходи в / Незер и напомни им, что ты тоже / умеешь устраивать / неконструктивный диалог. / ▪ Награда: 16 золотых морковок / Убейте пиглинов: 21/60'],
  [15, 'Кварцевые полки.', 'quartz', 'Алхимик внезапно решил, что / лаборатория должна быть ещё и / эстетичной. Видимо, без / красивых полок реагенты / работают менее научно. / ▪ Награда: 5 000 монет / Передайте кварц: 0/256'],
  [16, 'Песок души.', 'soul_sand', 'Незер - место странное, но даже / там есть вещи, без которых / опытный алхимик чувствует себя / недособранным. Песок душ как / раз из таких. / ▪ Награда: 16 факелов душ / Передайте песок душ: 0/128'],
  [19, 'Чёрная кладка.', 'blackstone', 'Если лаборатория стоит в / Незере, она обязана выглядеть / так, будто пережила минимум три / плохих решения. Чёрная кладка / поможет. / ▪ Награда: 32 полированных / чернокамня / Передайте чернокамень, / полированный чернокамень или / базальт: 0/192'],
  [20, 'Дежурный в Незере.', 'clock', 'Среди лавы и криков тоже нужна / дисциплина. Побудь в игре ещё / немного и докажи, что умеешь / работать в условиях, где всё / хочет тебя поджарить. / ▪ Награда: 5 500 монет / Проведите на сервере: 2 ч. 10 м./4 ч.'],
  [21, 'Пожарный экзамен.', 'blaze_rod', 'Если ты ещё не обгорел, значит / уже чего-то стоишь. Пора сдать / практику у источника огня и не / забыть принести результат. / ▪ Награда: 24 огненного порошка / Убейте ифритов: 0/45'],
  [36, 'Назад', 'arrow', ''],
].map(([slot, title, icon, lore]) => ({ slot, title, icon, lore: lore ? lore.split(' / ') : [] }));

test('задания Алхимика (скриншоты 5 ноября): все 10 — что сдать из Незера, кого убить, награда в две строки', () => {
  const { quests } = parseQuestMenu(ALCHEMIST);
  const by = Object.fromEntries(quests.map((q) => [q.slot, q]));
  assert.deepEqual(Object.keys(by).map(Number), [10, 11, 12, 13, 14, 15, 16, 19, 20, 21]);
  const row = (q) => [q.kind, q.items, q.have, q.need, q.reward];
  assert.deepEqual(row(by[10]), ['buy', [], 0, 60000, null]);
  assert.deepEqual(row(by[11]), ['deliver', ['blaze_rod', 'blaze_powder'], 0, 96, '24 огненного порошка']);
  assert.deepEqual(row(by[12]), ['deliver', ['nether_wart'], 0, 192, '16 светокаменной пыли']);
  assert.deepEqual(row(by[13]), ['deliver', ['magma_cream'], 0, 64, '16 огненных зарядов']);
  assert.deepEqual(row(by[14]), ['kill', [], 21, 60, '16 золотых морковок']);
  assert.deepEqual(row(by[15]), ['deliver', ['quartz'], 0, 256, '5 000 монет']);
  assert.deepEqual(row(by[16]), ['deliver', ['soul_sand'], 0, 128, '16 факелов душ']);
  assert.deepEqual(row(by[19]), ['deliver', ['blackstone', 'polished_blackstone', 'basalt'], 0, 192, '32 полированных чернокамня']);
  assert.deepEqual(row(by[20]), ['time', [], 130, 240, '5 500 монет']);
  assert.deepEqual(row(by[21]), ['kill', [], 0, 45, '24 огненного порошка']);
  assert.ok(quests.every((q) => q.taken && !q.done));
  // Другие зельевары: составные слова — раньше простых.
  assert.deepEqual(deliverItems('золотую морковь или морковь'), ['golden_carrot', 'carrot']);
  assert.deepEqual(deliverItems('маринованные паучьи глаза'), ['fermented_spider_eye']);
  assert.deepEqual(deliverItems('сверкающие ломтики арбуза, сахар или сахарный тростник'), ['glistering_melon_slice', 'sugar', 'sugar_cane']);
  assert.deepEqual(deliverItems('светокаменную пыль или слёзы гаста'), ['glowstone_dust', 'ghast_tear']);
});

test('кого убить: мобы по-русски в любом падеже, составные раньше простых; задания «Убейте…» знают своих мобов', () => {
  assert.deepEqual(mobsOf('пауков'), ['spider', 'cave_spider']);
  assert.deepEqual(mobsOf('пещерных пауков'), ['cave_spider']);
  assert.deepEqual(mobsOf('пиглинов'), ['piglin', 'piglin_brute']);
  assert.deepEqual(mobsOf('зомбифицированных пиглинов'), ['zombified_piglin']);
  assert.deepEqual(mobsOf('ифритов'), ['blaze']);
  assert.deepEqual(mobsOf('скелетов-иссушителей или зомби'), ['wither_skeleton', 'zombie']);
  assert.deepEqual(mobsOf('коров или куриц'), ['cow', 'chicken']);
  assert.deepEqual(mobsOf('драконов'), []);
  const { quests } = parseQuestMenu(ALCHEMIST);
  const by = Object.fromEntries(quests.map((q) => [q.slot, q]));
  assert.deepEqual(by[14].mobs, ['piglin', 'piglin_brute']);
  assert.deepEqual(by[21].mobs, ['blaze']);
  assert.equal(describeQuest(by[21]), '[21] Пожарный экзамен. — Убейте ифритов (blaze): 0/45; награда: 24 огненного порошка');
  // Все мобы из словаря есть в игре (1.21.11).
  const registry = require('prismarine-registry')(VERSION);
  assert.deepEqual(MOB_WORDS.flatMap(([, ids]) => ids).filter((id) => !registry.entitiesByName[id]), []);
});

test('Оружейник закрыт (уровень 0 → 1): условия «Прокачайте Фермера до 4 уровня» — тоже задания, с прогрессом в уровнях', () => {
  const smith = [
    { slot: 10, title: 'Рекомендация от Фермера.', icon: 'hay_block', lore: ['Оружейник слушает Фермера через', 'силу, но если тот говорит, что', 'ты не бесполезен, это уже', 'весомый аргумент. Добейся', 'максимального доверия у', 'главного по урожаю.', '', 'Прокачайте Фермера до 4 уровня. Выполнено!'] },
    { slot: 11, title: 'Печать Алхимика.', icon: 'brewing_stand', lore: ['Одной рекомендации мало.', 'Оружейник хочет знать, что тебя', 'не расплавит первое же', 'серьёзное испытание, а значит', 'Алхимик тоже должен подтвердить', 'твою ценность.', '', 'Прокачайте Алхимика до 4', 'уровня. 1/4'] },
  ];
  const [farmer, alchemist] = parseQuestMenu(smith).quests;
  assert.deepEqual([farmer.kind, farmer.done, farmer.unlock], ['unlock', true, { npc: 'Фермер', level: 4 }]);
  assert.deepEqual([alchemist.kind, alchemist.have, alchemist.need, alchemist.done, alchemist.unlock], ['unlock', 1, 4, false, { npc: 'Алхимик', level: 4 }]);
  assert.equal(describeQuest(farmer), '[10] Рекомендация от Фермера. — выполнено, Прокачайте Фермера до 4 уровня: 4/4');
  assert.equal(describeQuest(alchemist), '[11] Печать Алхимика. — Прокачайте Алхимика до 4 уровня: 1/4');
});

test('NPC и правила: «у Алхимика» → Алхимик; на 4-м уровне заданий нет; кто когда открывается', () => {
  assert.equal(questNpc('Алхимика'), 'Алхимик');
  assert.equal(questNpc('оружейнику'), 'Оружейник');
  assert.equal(questNpc('Фермер'), 'Фермер');
  assert.equal(questNpc('Кузнец'), null);
  assert.deepEqual(parseQuestChat('| Эта цепочка уже полностью завершена!'), { type: 'finished', text: 'Эта цепочка уже полностью завершена' });
  assert.deepEqual(parseQuestChat('| Цепочка квестов не найдена!'), { type: 'nochain', text: 'Цепочка квестов не найдена' });
  assert.equal(parseQuestChat('[Ender] zJeezy → Эта цепочка уже полностью завершена!'), null);
  assert.equal(MAX_NPC_LEVEL, 4);
  const rules = questRules().join('\n');
  assert.match(rules, /Алхимик открывается, когда Фермер 3-го уровня/);
  assert.match(rules, /Оружейник открывается, когда Фермер 4-го уровня и Алхимик 4-го уровня/);
  // Все предметы из словаря есть в игре (1.21.11) — опечатка в id сразу видна.
  const registry = require('prismarine-registry')(VERSION);
  const missing = ITEM_WORDS.flatMap(([, ids]) => ids).filter((id) => !registry.itemsByName[id]);
  assert.deepEqual(missing, []);
});

test('задания: прогресс с пробелами и временем из частей; выполнено — по числам', () => {
  assert.equal(parseNumber('2 500'), 2500);
  assert.equal(parseNumber('8400.0'), 8400);
  assert.equal(parseDuration('1 ч. 20 м.'), 80);
  const time = parseQuest(1, 'Костёр', ['Проведите на сервере: 1 ч. 20 м./3 ч.']);
  assert.deepEqual([time.have, time.need], [80, 180]);
  const done = parseQuest(2, 'Грядки', ['Передайте пшеницу: 224/224']);
  assert.equal(done.done, true);
  const big = parseQuest(3, 'Аванс', ['Купите у Фермера товаров на: 8 400/12 000']);
  assert.deepEqual([big.have, big.need, big.done], [8400, 12000, false]);
  assert.equal(parseQuest(4, 'Стекло', []), null);
  assert.equal(parseQuest(5, 'Назад', ['Вернуться в меню']), null);
});

test('что принести: слова в любом падеже; короткие основы не находятся внутри других слов', () => {
  assert.deepEqual(deliverItems('какао-бобы или печенье'), ['cocoa_beans', 'cookie']);
  assert.deepEqual(deliverItems('300 редстоуна'), ['redstone']);
  assert.deepEqual(deliverItems('железные слитки и уголь'), ['iron_ingot', 'coal']);
  assert.deepEqual(deliverItems('гранит'), [], '«нит» внутри «гранита» — не нить');
  assert.deepEqual(deliverItems('медь'), [], '«мёд» внутри «меди» — не мёд');
  assert.deepEqual(deliverItems('костяную муку'), ['bone_meal']);
  assert.deepEqual(deliverItems('кости'), ['bone']);
});

test('товар «Покупки»: цена, сколько осталось, можно ли купить', () => {
  const offer = parseOffer({
    slot: 12,
    title: 'Тюк сена',
    icon: 'hay_block',
    count: 32,
    lore: ['Лошадям нравится. Аллергикам - не очень.', '', '‖ Осталось › 6', '‖ Цена › 8400.0', '', '› Нажмите, чтобы купить'],
  });
  assert.deepEqual(offer, { slot: 12, title: 'Тюк сена', icon: 'hay_block', count: 32, price: 8400, left: 6, buyable: true });
  assert.equal(parseOffer({ slot: 1, title: 'Назад', lore: [] }), null);
  assert.ok(matchesQuery('Тюк сена', 'сено'));
  assert.ok(matchesQuery('Тюк сена', 'тюк'));
  assert.ok(!matchesQuery('Тюк сена', 'торт'));
});
