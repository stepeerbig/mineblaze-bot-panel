'use strict';

// Выжить за работой (src/bot/survival.js): кого бить первым, щит от крипера, что есть.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { fakeClock, makeWorld, physicsBot, autoServer, teleport, take, runFor, VERSION } = require('./fake-bot');

const { defend, pickFood, needsFood, threats } = require(path.join(__dirname, '..', 'src', 'bot', 'survival.js'));

function setup() {
  const clock = fakeClock();
  const world = makeWorld(require('prismarine-registry')(VERSION));
  const bot = physicsBot({ clock, world, actions: true });
  autoServer(bot, world);
  bot.emit('login');
  teleport(bot);
  clock.advance(100);
  take(bot);
  return { clock, world, bot };
}

test('отпор: крипер подальше — не цель (к нему не идёт), бьёт зомби рядом; крипер подошёл — закрывается щитом', async () => {
  const { clock, bot } = setup();
  bot.inventory.slots[36] = { name: 'iron_sword', count: 1 };
  bot.inventory.slots[45] = { name: 'shield', count: 1 };
  const zombie = { id: 701, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 2.4), width: 0.6, height: 1.95, hp: 3 };
  // В 4,8 блока: щит ещё рано (ближе 4,5), идти к нему нельзя — взорвётся рядом.
  const creeper = { id: 702, type: 'hostile', name: 'creeper', position: new Vec3(0.5, 64, -4.3), width: 0.6, height: 1.7 };
  bot.entities[701] = zombie;
  bot.entities[702] = creeper;
  const hits = [];
  let shieldUp = null;
  let tick = 0;
  bot.on('physicsTick', () => {
    tick += 1;
    if (shieldUp !== null && tick - shieldUp === 20) delete bot.entities[702]; // взорвался о щит
  });
  const write = bot._client.write;
  bot._client.write = (name, params) => {
    write(name, params);
    if (name === 'use_entity' && params.mouse === 1) {
      hits.push(params.target);
      if (params.target === 701 && (zombie.hp -= 1) <= 0) {
        delete bot.entities[701];
        bot.emit('entityDead', zombie);
        creeper.position = new Vec3(0.5, 64, -2.6); // зомби нет — крипер подошёл
      }
    }
    if (name === 'use_item' && params.hand === 1) shieldUp = tick;
  };
  const z0 = bot.entity.position.z;
  const res = await runFor(clock, defend(bot), 120000);
  assert.ifError(res.error);
  assert.deepEqual(hits, [701, 701, 701], 'бил только зомби');
  assert.equal(res.value.kills, 1);
  assert.equal(res.value.blocked, 1, 'от подошедшего крипера — щит');
  assert.ok(Math.abs(bot.entity.position.z - z0) < 0.5, `к криперу не ходил: z ${z0.toFixed(2)} → ${bot.entity.position.z.toFixed(2)}`);
  assert.equal(bot.heldItem && bot.heldItem.name, 'iron_sword');
});

test('отпор: пока бот ждёт зомби (или подходит к нему), рядом оказался крипер — бросает это и сразу закрывается щитом', async () => {
  const { clock, bot } = setup();
  bot.inventory.slots[36] = { name: 'iron_sword', count: 1 };
  bot.inventory.slots[45] = { name: 'shield', count: 1 };
  // Зомби не достать и он не подходит (застрял за краем): бот ждёт, потом подходит рывками.
  const zombie = { id: 711, type: 'hostile', name: 'zombie', position: new Vec3(0.5, 64, 4.8), width: 0.6, height: 1.95 };
  const creeper = { id: 712, type: 'hostile', name: 'creeper', position: new Vec3(20.5, 64, 20.5), width: 0.6, height: 1.7 };
  bot.entities[711] = zombie;
  bot.entities[712] = creeper;
  let tick = 0;
  let cameAt = null;
  let shieldAt = null;
  bot.on('physicsTick', () => {
    tick += 1;
    if (tick === 50) {
      creeper.position = bot.entity.position.offset(0, 0, -2.5); // подкрался сзади
      cameAt = tick;
    }
    if (shieldAt !== null && tick - shieldAt === 20) {
      delete bot.entities[712]; // взорвался о щит — и зомби с ним
      delete bot.entities[711];
    }
  });
  const write = bot._client.write;
  bot._client.write = (name, params) => {
    write(name, params);
    if (name === 'use_item' && params.hand === 1 && shieldAt === null) shieldAt = tick;
  };
  const res = await runFor(clock, defend(bot), 120000);
  assert.ifError(res.error);
  assert.equal(res.value.blocked, 1);
  assert.ok(shieldAt !== null && shieldAt - cameAt <= 12, `щит — сразу, как подошёл крипер: через ${shieldAt - cameAt} тиков`);
});

test('еда: сначала хорошая (хлеб, мясо); плоды и сырое — нужны для заданий — только когда совсем голоден; сытый не ест', () => {
  const bot = { inventory: { slots: [] }, food: 12 };
  bot.inventory.slots[36] = { name: 'carrot', count: 64 };
  assert.equal(pickFood(bot), null, 'морковь — для заданий Фермера: при сытости 12 не трогает');
  bot.inventory.slots[37] = { name: 'bread', count: 5 };
  assert.equal(pickFood(bot), 'bread');
  assert.equal(needsFood(bot), true);
  bot.food = 18;
  assert.equal(needsFood(bot), false, 'сыт');
  bot.food = 5;
  delete bot.inventory.slots[37];
  assert.equal(pickFood(bot), 'carrot', 'совсем голоден — годится и морковь');
});

test('враги: только видимые и рядом (стрелки — дальше), не с именем; в соседней пещере за стеной — не враг', () => {
  const { bot, world } = setup();
  const mob = (id, name, x, z, extra = {}) => ({ id, type: 'hostile', name, position: new Vec3(x, 64, z), width: 0.6, height: 1.9, ...extra });
  bot.entities[1] = mob(1, 'zombie', 0.5, 4.5);
  bot.entities[2] = mob(2, 'zombie', 0.5, 9.5); // далеко
  bot.entities[3] = mob(3, 'skeleton', 0.5, -9.5); // стрелок — и в 10 блоках враг
  bot.entities[4] = mob(4, 'zombie', 4.5, 0.5); // за стеной
  bot.entities[5] = mob(5, 'zombie', -3.5, 0.5, { getCustomName: () => ({ toString: () => 'Боб' }) });
  bot.entities[6] = { ...mob(6, 'cow', 2.5, 2.5), type: 'animal' };
  for (const y of [64, 65, 66]) for (let z = -2; z <= 2; z += 1) world.set(new Vec3(3, y, z), 'stone');
  assert.deepEqual(threats(bot).map((e) => e.id), [1, 3]);
});

test('еда: любая еда игры (мёд, пирог), кроме вредной (гнилая плоть, паучий глаз); золотое яблоко — только когда совсем голоден', () => {
  const { isFood } = require(path.join(__dirname, '..', 'src', 'bot', 'survival.js'));
  const registry = require('prismarine-registry')(VERSION);
  const bot = { registry, inventory: { slots: [] }, food: 12 };
  bot.inventory.slots[36] = { name: 'rotten_flesh', count: 10 };
  bot.inventory.slots[37] = { name: 'spider_eye', count: 3 };
  assert.equal(pickFood(bot), null, 'вредное не ест');
  bot.inventory.slots[38] = { name: 'golden_apple', count: 1 };
  assert.equal(pickFood(bot), null, 'золотое яблоко — не на перекус');
  bot.food = 4;
  assert.equal(pickFood(bot), 'golden_apple', 'совсем голоден — годится');
  bot.food = 12;
  bot.inventory.slots[39] = { name: 'honey_bottle', count: 2 };
  assert.equal(pickFood(bot), 'honey_bottle');
  assert.equal(isFood('cod_bucket', registry), false);
  assert.equal(isFood('pumpkin_pie', registry), true);
  assert.equal(isFood('chorus_fruit', registry), false);
});

test('огонь: горит без огнестойкости — сторож пьёт зелье огнестойкости (долгое — первым), не воду; зелий нет — отмечает', async () => {
  const { createGuard, burning, fireResPotions } = require(path.join(__dirname, '..', 'src', 'bot', 'survival.js'));
  const { potionOf } = require(path.join(__dirname, '..', 'src', 'bot', 'item-hash.js'));
  const { bot } = setup();
  const potion = (id) => ({ name: 'potion', count: 1, components: [{ type: 'potion_contents', data: { potionId: id, customEffects: [] } }] });
  bot.inventory.slots[36] = potion(0); // вода
  bot.inventory.slots[37] = potion(11);
  bot.inventory.slots[38] = potion(12); // долгая
  const drank = [];
  bot.actions.drink = async (it) => {
    drank.push(potionOf(it));
    bot.entity.effects[11] = { id: 11, amplifier: 0, duration: 9600 };
    bot.inventory.slots[bot.inventory.slots.indexOf(it)] = { name: 'glass_bottle', count: 1 };
  };
  bot.entity.metadata = [0x01]; // горит
  assert.equal(burning(bot), true);
  assert.deepEqual(fireResPotions(bot).map(potionOf), ['long_fire_resistance', 'fire_resistance']);
  const guard = createGuard(bot);
  assert.equal(guard.wants(), 'fire');
  await guard.handle();
  assert.deepEqual(drank, ['long_fire_resistance']);
  assert.equal(guard.stats.drank, 1);
  assert.equal(guard.wants(), null, 'огнестойкость действует — больше не пьёт');
  guard.stop();

  // Горит, а зелий нет — отмечает (в отчёте #добудь: «положи их на склад»).
  const t = setup();
  t.bot.entity.metadata = [0x01];
  const g2 = createGuard(t.bot);
  assert.equal(g2.wants(), null);
  assert.equal(g2.stats.burnedNoPotion, true);
  g2.stop();
});

test('Незер: пиглин — враг без золота на боте, с золотом — нет (пока бот не копает золото); зомби-пиглин — только разозлённый', () => {
  const { createGuard } = require(path.join(__dirname, '..', 'src', 'bot', 'survival.js'));
  const { bot } = setup();
  const mob = (id, name, x, z) => ({ id, type: 'hostile', name, position: new Vec3(x, 64, z), width: 0.6, height: 1.95 });
  bot.entities[11] = mob(11, 'piglin', 0.5, 4.5);
  bot.entities[12] = mob(12, 'zombified_piglin', -2.5, 2.5);
  bot.entities[13] = mob(13, 'zombified_piglin', -3.5, -2.5);
  assert.deepEqual(threats(bot).map((e) => e.id), [11], 'без золота пиглин нападает, зомби-пиглины — нет');
  bot.inventory.slots[8] = { name: 'golden_boots', count: 1 };
  assert.deepEqual(threats(bot).map((e) => e.id), [], 'в золотых ботинках пиглин не враг');
  const g = createGuard(bot, { hostile: ['piglin'] });
  assert.deepEqual(threats(bot, new Map(), g.ctx).map((e) => e.id), [11], 'копает золото — пиглины злятся');
  assert.equal(g.provoke(), 2, 'ударил зомби-пиглин — злятся и такие же рядом');
  assert.deepEqual(threats(bot, new Map(), g.ctx).map((e) => e.id).sort(), [11, 12, 13]);
  g.stop();
});

test('Незер: огненный шар гаста летит к боту — первым делом; улетает — не цель', () => {
  const { bot } = setup();
  const p = bot.entity.position;
  bot.entities[21] = { id: 21, type: 'hostile', name: 'zombie', position: p.offset(0, 0, 3), width: 0.6, height: 1.95 };
  const fb = { id: 22, type: 'projectile', name: 'fireball', position: p.offset(0, 1.5, -7), width: 1, height: 1 };
  bot.entities[22] = fb;
  assert.deepEqual(threats(bot).map((e) => e.id), [22, 21]);
  fb.position = p.offset(0, 1.5, -5); // ближе — летит к боту
  assert.deepEqual(threats(bot).map((e) => e.id), [22, 21]);
  fb.position = p.offset(0, 1.5, -6); // отбит — летит прочь
  assert.deepEqual(threats(bot).map((e) => e.id), [21]);
});

test('мало здоровья — золотое яблоко и сытым', () => {
  const registry = require('prismarine-registry')(VERSION);
  const bot = { registry, inventory: { slots: [] }, food: 20, health: 6 };
  bot.inventory.slots[36] = { name: 'bread', count: 10 };
  bot.inventory.slots[37] = { name: 'golden_apple', count: 1 };
  assert.equal(needsFood(bot), true);
  assert.equal(pickFood(bot), 'golden_apple');
  bot.health = 18;
  assert.equal(needsFood(bot), false);
});

test('слова: «золото ада», «адское золото», «золото в аду» — золото Незера; «золото» — обычное', () => {
  const { oreOf } = require(path.join(__dirname, '..', 'src', 'bot', 'commands.js'));
  assert.equal(oreOf('золото ада'), 'nether_gold');
  assert.equal(oreOf('адское золото'), 'nether_gold');
  assert.equal(oreOf('золото в аду'), 'nether_gold');
  assert.equal(oreOf('незерское золото'), 'nether_gold');
  assert.equal(oreOf('золото'), 'gold');
});
