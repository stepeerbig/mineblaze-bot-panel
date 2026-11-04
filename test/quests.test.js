'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseQuest, parseQuestMenu, parseOffer, deliverItems, describeQuest, parseNumber, parseDuration, matchesQuery, parseQuestChat, sameTitle,
} = require('../src/bot/quests');

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
