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
