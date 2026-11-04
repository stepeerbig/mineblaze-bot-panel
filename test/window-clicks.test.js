'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('events');
const { crc32c, componentHash, toHashedSlot, nbtHash } = require('../src/bot/item-hash');
const { windowClicksPlugin } = require('../src/bot/window-clicks');

const registry = require('prismarine-registry')('1.21.11');
const names = {
  enchantment: (id) => registry.enchantments[id].name,
  component: (id) => registry.protocol.types.SlotComponentType[1].mappings[id],
};

// NBT в том виде, как его разбирает minecraft-protocol.
const str = (value) => ({ type: 'string', value });
const byte = (value) => ({ type: 'byte', value });
const compound = (value) => ({ type: 'compound', value });

test('CRC32C как в Guava (Hashing.crc32c)', () => {
  assert.equal(crc32c(Buffer.from('123456789')) >>> 0, 0xe3069283);
  assert.equal(crc32c(Buffer.alloc(0)), 0);
});

// Эталоны сверены с сервером Paper 1.21.11 (npm run stand:check -- --clicks): с этими отпечатками сервер
// не поправляет ни одного клика, а с неверными — поправляет каждый.
test('отпечатки компонентов совпадают с игрой', () => {
  assert.equal(componentHash('custom_name', str('Аванс на семена.')), 11974938);
  assert.equal(
    componentHash('custom_name', compound({ italic: byte(0), color: str('yellow'), text: str('Грядки без истерики.') })),
    1866726954,
  );
  assert.equal(
    componentHash('custom_name', compound({ italic: byte(0), bold: byte(1), color: str('#FFAA00'), shadow_color: { type: 'int', value: -16777216 }, text: str('Улучшения') })),
    -306867690,
  );
  // Описание из трёх строк; во второй — список вперемешку (текст и строка), в сети строка завёрнута в {"": …}.
  const lore = [
    compound({ italic: byte(0), color: str('gray'), text: str('После последней непогоды огород') }),
    compound({
      italic: byte(0),
      extra: { type: 'list', value: { type: 'compound', value: [{ color: str('white'), text: str('Передайте пшеницу: ') }, { '': str('0/224') }] } },
      text: str(''),
    }),
    compound({ italic: byte(0), bold: byte(1), color: str('green'), text: str('Нажмите, чтобы взять задание') }),
  ];
  assert.equal(componentHash('lore', lore), 1017613987);
  assert.equal(componentHash('enchantments', { enchantments: [{ id: 33, level: 5 }, { id: 40, level: 3 }] }, names), 1231404551);
  assert.equal(
    componentHash(
      'custom_data',
      compound({
        quest: str('farmer_1'),
        PublicBukkitValues: compound({ 'plugin:key': str('v') }),
        nums: { type: 'intArray', value: [1, 2, 3] },
        level: byte(2),
        list: { type: 'list', value: { type: 'int', value: [1, 2, 3] } },
      }),
    ),
    -1431139963,
  );
  assert.equal(componentHash('tooltip_display', { hideTooltip: true, hiddenComponents: [] }, names), 14016722);
  assert.equal(componentHash('tooltip_display', { hideTooltip: false, hiddenComponents: [13] }, names), -2064977432);
  assert.equal(componentHash('custom_model_data', { floats: [1.5], flags: [true], strings: ['a'], colors: [16711680] }), -1412649611);
  assert.equal(componentHash('unbreakable', undefined), -982207288);
  assert.equal(componentHash('enchantment_glint_override', true), -1019818302);
  assert.equal(componentHash('rarity', 'epic'), -292715907);
  assert.equal(componentHash('damage', 10), -919192125);
  assert.equal(componentHash('item_model', 'minecraft:golden_apple'), 977699611);
});

test('отпечаток словаря не зависит от порядка полей; у текста байт 0/1 — логическое значение, у данных — байт', () => {
  const a = compound({ text: str('x'), color: str('red'), italic: byte(0) });
  const b = compound({ italic: byte(0), color: str('red'), text: str('x') });
  assert.equal(componentHash('custom_name', a), componentHash('custom_name', b));
  assert.notEqual(componentHash('custom_name', a), nbtHash(a), 'в custom_data тот же байт считается числом');
});

test('предмет для пакета клика: пустая ячейка — «ничего», неизвестный компонент — отпечаток 0 и сигнал', () => {
  assert.equal(toHashedSlot(null), undefined);
  assert.equal(toHashedSlot({ itemCount: 0, components: [], removeComponents: [] }), undefined, 'пустая — не «воздух, 0 штук»');
  assert.equal(toHashedSlot({ itemCount: 1, itemId: 0 }), undefined);

  const unknown = [];
  const slot = toHashedSlot(
    {
      present: true,
      itemCount: 3,
      itemId: 908,
      addedComponentCount: 2,
      removedComponentCount: 1,
      components: [{ type: 'custom_name', data: str('Аванс на семена.') }, { type: 'profile', data: { whatever: 1 } }],
      removeComponents: [{ type: 'food' }],
    },
    { names, onUnknown: (t) => unknown.push(t) },
  );
  assert.deepEqual(slot, {
    itemId: 908,
    itemCount: 3,
    components: [{ type: 'custom_name', hash: 11974938 }, { type: 'profile', hash: 0 }],
    removeComponents: [{ type: 'food' }],
  });
  assert.deepEqual(unknown, ['profile']);
});

/** Бот-заглушка: клиент с записью отправленного и mineflayer-подобные окна. */
function fakeBot(extra = null) {
  const client = new EventEmitter();
  client.sent = [];
  client.write = (name, params) => client.sent.push({ name, params });
  const bot = new EventEmitter();
  bot._client = client;
  bot.registry = registry;
  bot.inventory = { id: 0, selectedItem: null, slots: [] };
  bot.currentWindow = null;
  if (extra) extra(bot);
  windowClicksPlugin(bot);
  return { bot, client };
}
/** То же, но с тем, что нужно для времени копания (как у mineflayer после плагина digging). */
fakeBot.withDig = () =>
  fakeBot((bot) => {
    const { Vec3 } = require('vec3');
    bot.digTime = () => {
      throw new Error('должен быть заменён плагином');
    };
    bot.game = { gameMode: 'survival' };
    bot.entity = { position: new Vec3(0, 64, 0), eyeHeight: 1.62, onGround: true, effects: {} };
    bot.blockAt = () => null;
    bot.getEquipmentDestSlot = () => 5;
  });

test('клик несёт номер состояния своего окна, а не последнего пришедшего пакета', () => {
  const { bot, client } = fakeBot();
  client.emit('open_window', { windowId: 3 });
  client.emit('window_items', { windowId: 3, stateId: 1, items: [] });
  client.emit('set_slot', { windowId: 0, stateId: 8, slot: 45 }); // Paper: вторая рука из инвентаря
  bot.currentWindow = { id: 3, selectedItem: null };

  // mineflayer подставил бы 8 (последний пакет) — уходит 1, номер окна 3.
  client.write('window_click', { windowId: 3, stateId: 8, slot: 0, mouseButton: 0, mode: 0, changedSlots: [], cursorItem: { itemCount: 0, components: [], removeComponents: [] } });
  const click = client.sent.at(-1).params;
  assert.equal(click.stateId, 1);
  assert.equal(click.cursorItem, undefined, 'пустой курсор — «ничего»');

  client.emit('set_slot', { windowId: 3, stateId: 2, slot: 0 });
  client.write('window_click', { windowId: 3, stateId: 99, slot: 0, mouseButton: 0, mode: 0, changedSlots: [] });
  assert.equal(client.sent.at(-1).params.stateId, 2);

  // -1 mineflayer ставит нарочно (просьба прислать окно заново) — не трогаем.
  client.write('window_click', { windowId: 3, stateId: -1, slot: -999, mouseButton: 2, mode: 5, changedSlots: [] });
  assert.equal(client.sent.at(-1).params.stateId, -1);

  // Новое окно с тем же номером — старый счёт забыт.
  client.emit('open_window', { windowId: 3 });
  client.write('window_click', { windowId: 3, stateId: 5, slot: 0, mouseButton: 0, mode: 0, changedSlots: [] });
  assert.equal(client.sent.at(-1).params.stateId, 5);

  // Остальные пакеты не трогаем.
  client.write('chat_message', { message: 'привет' });
  assert.deepEqual(client.sent.at(-1), { name: 'chat_message', params: { message: 'привет' } });
});

test('изменившиеся ячейки в клике — с отпечатками', () => {
  const { client } = fakeBot();
  client.write('window_click', {
    windowId: 1,
    stateId: 4,
    slot: 21,
    mouseButton: 0,
    mode: 0,
    changedSlots: [{ location: 21, item: { itemCount: 0, components: [], removeComponents: [] } }],
    cursorItem: { present: true, itemCount: 1, itemId: 908, components: [{ type: 'custom_name', data: str('Аванс на семена.') }], removeComponents: [] },
  });
  const p = client.sent.at(-1).params;
  assert.deepEqual(p.changedSlots, [{ location: 21, item: undefined }]);
  assert.deepEqual(p.cursorItem, { itemId: 908, itemCount: 1, components: [{ type: 'custom_name', hash: 11974938 }], removeComponents: [] });
});

test('время копания зачарованной киркой (у mineflayer падало: «enchantments is not iterable»)', () => {
  const Item = require('prismarine-item')(registry);
  const Block = require('prismarine-block')(registry);
  const { Vec3 } = require('vec3');
  const stone = Block.fromStateId(registry.blocksByName.stone.defaultState, 0);
  const pickaxe = registry.itemsByName.iron_pickaxe.id;
  const efficiency = registry.enchantmentsByName.efficiency.id;

  const { bot } = fakeBot.withDig();
  bot.heldItem = Item.fromNotch({ itemCount: 1, itemId: pickaxe, components: [], removeComponents: [] });
  const plain = bot.digTime(stone);
  bot.heldItem = Item.fromNotch({
    itemCount: 1,
    itemId: pickaxe,
    components: [{ type: 'enchantments', data: { enchantments: [{ id: efficiency, level: 5 }] } }],
    removeComponents: [],
  });
  assert.throws(() => [...bot.heldItem.enchants], /iterable/, 'сам prismarine-item отдаёт не список');
  const fast = bot.digTime(stone);
  assert.ok(fast < plain, `с «Эффективностью V» быстрее: ${fast} < ${plain}`);
  assert.deepEqual(bot.enchantsOf(bot.heldItem), [{ name: 'efficiency', lvl: 5 }]);

  bot.entity.onGround = false; // в прыжке — дольше, как в игре
  assert.ok(bot.digTime(stone) > fast);
  void Vec3;
});

test('сервер поправил курсор (set_cursor_item) — бот верит серверу', () => {
  const { bot, client } = fakeBot();
  const win = { id: 2, selectedItem: { name: 'string', count: 1 } }; // прогноз mineflayer: «взял» задание
  bot.currentWindow = win;
  const seen = [];
  bot.on('cursorItem', (it) => seen.push(it));
  client.emit('set_cursor_item', { contents: { itemCount: 0 } });
  assert.equal(win.selectedItem, null, 'курсор пуст, как говорит сервер');
  assert.deepEqual(seen, [null]);

  bot.currentWindow = null;
  client.emit('set_cursor_item', { contents: { itemCount: 2, itemId: 908, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] } });
  assert.equal(bot.inventory.selectedItem.name, 'gold_ingot');
  assert.equal(bot.inventory.selectedItem.count, 2);
});
