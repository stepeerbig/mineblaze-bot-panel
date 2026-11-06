'use strict';

// Сервер «Экрана бота»: HTTP-маршруты, защита, поток мира через socket.io. Без сети и сервера Minecraft.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const EventEmitter = require('node:events');
const { io } = require('socket.io-client');
const { Vec3 } = require('vec3');

const { ViewerServer } = require(path.join(__dirname, '..', 'src', 'viewer', 'viewer-server.js'));

const VERSION = '1.21.11';
const mcData = require('minecraft-data')(VERSION);
const Block = require('prismarine-block')(VERSION);
const Chunk = require('prismarine-chunk')(VERSION);
const World = require('prismarine-world')(VERSION);
const ViewerChunk = require('prismarine-chunk')('1.21.4');
const ViewerBlock = require('prismarine-block')('1.21.4');

// ---------- заготовки ----------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-server-test-'));
const pageDir = path.join(tmp, 'page');
const publicDir = path.join(tmp, 'public');
fs.mkdirSync(pageDir, { recursive: true });
fs.mkdirSync(path.join(publicDir, 'textures'), { recursive: true });
fs.mkdirSync(path.join(publicDir, 'blocksStates'), { recursive: true });
fs.writeFileSync(path.join(pageDir, 'index.html'), '<!doctype html><title>Экран бота</title><script src="index.js"></script>');
fs.writeFileSync(path.join(pageDir, 'ui.js'), '/* ui */');
fs.writeFileSync(path.join(pageDir, 'ui.css'), '/* css */');
fs.writeFileSync(path.join(pageDir, 'secret.txt'), 'nope');
// Маленькие «бандлы» с теми же местами, что правит bundle-patches.js
fs.writeFileSync(path.join(publicDir, 'index.js'),
  'for(let i=0;i<256;i+=16){a()}for(let i=0;i<256;i+=16){b()}if(t.y>0&&s&&(h.target.set(t.x,t.y,t.z),q()))x();');
fs.writeFileSync(path.join(publicDir, 'worker.js'),
  'i&&i.sections[Math.floor(a/16)]?1:2;l&&l.sections[Math.floor(n/16)];if(g.position.y<0)continue;if(n.position.y<0)continue}');
fs.writeFileSync(path.join(publicDir, 'textures', '1.21.4.png'), 'PNG');
fs.writeFileSync(path.join(publicDir, 'blocksStates', '1.21.4.json'), '{}');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sid = (name, props) => (props ? Block.fromProperties(name, props, 0).stateId : mcData.blocksByName[name].defaultState);

function makeWorld() {
  const world = new World(null);
  for (let cx = -1; cx <= 1; cx++) {
    for (let cz = -1; cz <= 1; cz++) {
      const c = new Chunk({ minY: -64, worldHeight: 384 });
      const p = new Vec3(0, 0, 0);
      for (p.x = 0; p.x < 16; p.x++) for (p.z = 0; p.z < 16; p.z++) for (p.y = 60; p.y <= 63; p.y++) c.setBlockStateId(p, sid('stone'));
      world.sync.setColumn(cx, cz, c);
    }
  }
  // Блок 1.21.5+, которого нет в 1.21.4: должен прийти как pink_petals
  world.sync.setBlockStateId(new Vec3(2, 64, 3), sid('wildflowers', { facing: 'east', flower_amount: 3 }));
  world.sync.setBlockStateId(new Vec3(-5, -20, -5), sid('deepslate_diamond_ore'));
  return world;
}

function makeBot(version = VERSION) {
  const bot = new EventEmitter();
  bot.setMaxListeners(50);
  bot.version = version;
  bot.username = 'ViewBot';
  bot.health = 19.5;
  bot.food = 18;
  bot.game = { dimension: 'minecraft:overworld' };
  bot.world = makeWorld().sync;
  bot.entity = { id: 1, name: 'player', position: new Vec3(8.5, 64, 8.5), yaw: 1.5, pitch: -0.25, width: 0.6, height: 1.8 };
  bot.entities = {
    1: bot.entity,
    7: { id: 7, name: 'zombie', position: new Vec3(3, 64, 3), yaw: 0, pitch: 0, width: 0.6, height: 1.95 },
  };
  return bot;
}

async function startServer(opts = {}) {
  const server = new ViewerServer({ pageDir, publicDir, viewDistance: 3, ...opts });
  const url = await server.start();
  const { port, pathname } = new URL(url);
  return { server, url, port, token: pathname.split('/')[1], origin: `http://127.0.0.1:${port}` };
}

function connect(ctx) {
  return io(ctx.origin, { path: `/${ctx.token}/socket.io`, transports: ['websocket'], reconnection: false, forceNew: true });
}

function waitFor(socket, event, predicate = () => true, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`нет события ${event} за ${ms} мс`));
    }, ms);
    function handler(data) {
      if (!predicate(data)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(data);
    }
    socket.on(event, handler);
  });
}

function rawGet(port, pathName, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, headers: { host } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

const BOT_EVENTS = ['move', 'forcedMove', 'entitySpawn', 'entityMoved', 'entityGone', 'chunkColumnLoad', 'chunkColumnUnload', 'blockUpdate', 'respawn', 'login'];
const listenerTotal = (bot) => BOT_EVENTS.reduce((n, e) => n + bot.listenerCount(e), 0);

// ---------- тесты ----------

test('запуск: адрес на 127.0.0.1 со случайным токеном, повторный start() даёт тот же адрес', async () => {
  const { server, url } = await startServer();
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}\/$/);
    assert.strictEqual(await server.start(), url);
    assert.strictEqual(server.url, url);
    assert.strictEqual(server._http.address().address, '127.0.0.1');
  } finally {
    await server.close();
  }
});

test('HTTP: страница, файлы интерфейса, текстуры; чужое и лишнее закрыто', async () => {
  const ctx = await startServer();
  const { url, origin, token, port, server } = ctx;
  try {
    const page = await fetch(url);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.strictEqual(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /Экран бота/);

    const noSlash = await fetch(`${origin}/${token}`, { redirect: 'manual' });
    assert.strictEqual(noSlash.status, 301);
    assert.strictEqual(noSlash.headers.get('location'), `/${token}/`);

    assert.strictEqual((await fetch(`${url}ui.js`)).status, 200);
    assert.strictEqual((await fetch(`${url}ui.css`)).status, 200);
    assert.strictEqual((await fetch(`${url}secret.txt`)).status, 404, 'из папки страницы отдаются только ui.js и ui.css');
    assert.strictEqual((await fetch(`${url}textures/1.21.4.png`)).status, 200);
    assert.strictEqual((await fetch(`${url}blocksStates/1.21.4.json`)).status, 200);
    assert.strictEqual((await fetch(`${url}textures/missing.png`)).status, 404);
    assert.notStrictEqual((await fetch(`${url}textures/..%2f..%2fpage%2fsecret.txt`)).status, 200);
    assert.strictEqual((await fetch(`${origin}/${'0'.repeat(32)}/`)).status, 404, 'чужой токен');
    assert.strictEqual((await fetch(`${origin}/`)).status, 404);

    assert.strictEqual(await rawGet(port, `/${token}/`, `127.0.0.1:${port}`), 200);
    assert.strictEqual(await rawGet(port, `/${token}/`, `localhost:${port}`), 200);
    assert.strictEqual(await rawGet(port, `/${token}/`, `evil.example:${port}`), 403, 'чужой Host');
  } finally {
    await server.close();
  }
});

test('бандлы клиента отдаются с правками, ETag и кэшем', async () => {
  const { url, server } = await startServer();
  try {
    const index = await fetch(`${url}index.js`);
    assert.strictEqual(index.status, 200);
    assert.match(index.headers.get('content-type'), /javascript/);
    const indexCode = await index.text();
    assert.ok(indexCode.includes('for(let i=-64;i<320;i+=16)'));
    assert.ok(indexCode.includes('if(s&&(h.target.set(t.x,t.y,t.z)'));
    assert.strictEqual(index.headers.get('content-security-policy'), null);

    const worker = await fetch(`${url}worker.js`);
    const workerCode = await worker.text();
    assert.ok(workerCode.includes('i.sections[Math.floor((a-(i.minY||0))/16)]'));
    assert.ok(workerCode.includes('g.position.y<-64)continue'));

    const etag = worker.headers.get('etag');
    assert.ok(etag);
    assert.match(worker.headers.get('cache-control'), /max-age/);
    const again = await fetch(`${url}worker.js`, { headers: { 'if-none-match': etag } });
    assert.strictEqual(again.status, 304);
  } finally {
    await server.close();
  }
});

test('state и mode: без бота «не в сети», переключение режима', async () => {
  const { url, server } = await startServer({ mode: 'first' });
  try {
    const s0 = await (await fetch(`${url}state`)).json();
    assert.strictEqual(s0.online, false);
    assert.strictEqual(s0.mode, 'first');
    assert.strictEqual(s0.unsupported, false);

    const modes = [];
    server.on('mode', (m) => modes.push(m));
    const bad = await fetch(`${url}mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"x"}' });
    assert.strictEqual(bad.status, 400);
    const ok = await fetch(`${url}mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"mode":"third"}' });
    assert.strictEqual(ok.status, 200);
    const s1 = await ok.json();
    assert.strictEqual(s1.mode, 'third');
    assert.ok(s1.generation > s0.generation);
    assert.deepStrictEqual(modes, ['third']);
    assert.strictEqual(server.setMode('third'), 'third');
    assert.deepStrictEqual(modes, ['third'], 'тот же режим — без события');
    assert.strictEqual(server.setMode('что угодно'), 'first');
  } finally {
    await server.close();
  }
});

test('без бота сокет сразу закрывается', async () => {
  const ctx = await startServer();
  const socket = connect(ctx);
  try {
    const reason = await waitFor(socket, 'disconnect');
    assert.strictEqual(reason, 'io server disconnect');
  } finally {
    socket.close();
    await ctx.server.close();
  }
});

test('с ботом: версия просмотра, переведённые чанки, сущности, позиция и обновления', async () => {
  const ctx = await startServer({ mode: 'first' });
  const bot = makeBot();
  ctx.server.setBot(bot);
  const state = ctx.server.getState();
  assert.strictEqual(state.online, true);
  assert.strictEqual(state.viewerVersion, '1.21.4');
  assert.strictEqual(state.username, 'ViewBot');
  assert.strictEqual(state.dimension, 'overworld');
  assert.deepStrictEqual(state.position, { x: 8.5, y: 64, z: 8.5 });

  const socket = connect(ctx);
  const chunks = new Map();
  socket.on('loadChunk', (d) => chunks.set(`${d.x},${d.z}`, d.chunk));
  try {
    const versionP = waitFor(socket, 'version');
    const entityP = waitFor(socket, 'entity', (e) => e.id === 7);
    const posP = waitFor(socket, 'position');
    assert.strictEqual(await versionP, '1.21.4');
    const zombie = await entityP;
    assert.strictEqual(zombie.name, 'zombie');
    const pos = await posP;
    assert.deepStrictEqual(pos.pos, { x: 8.5, y: 64, z: 8.5 });
    assert.strictEqual(pos.pitch, -0.25);
    assert.strictEqual(pos.addMesh, undefined);

    // Все 9 колонок мира (радиус 2 вокруг бота, остальных в мире нет)
    const t0 = Date.now();
    while (chunks.size < 9 && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(chunks.size, 9);
    const col = ViewerChunk.fromJson(chunks.get('0,0'));
    const flower = col.getBlock(new Vec3(2, 64, 3));
    assert.strictEqual(flower.name, 'pink_petals');
    const props = flower.getProperties();
    assert.strictEqual(props.facing, 'east');
    assert.strictEqual(String(props.flower_amount), '3'); // в 1.21.4 числовые свойства приходят строкой
    assert.strictEqual(col.getBlock(new Vec3(5, 62, 5)).name, 'stone');
    const deep = ViewerChunk.fromJson(chunks.get('-16,-16'));
    assert.strictEqual(deep.getBlock(new Vec3(11, -20, 11)).name, 'deepslate_diamond_ore', 'блоки ниже y=0 доходят до страницы');

    // Шаг бота
    bot.entity.position = new Vec3(9.5, 64, 8.5);
    const moved = waitFor(socket, 'position', (p) => p.pos.x === 9.5);
    bot.emit('move');
    await moved;

    // Обновление блока: медный сундук 1.21.9+ приходит как обычный сундук
    const where = new Vec3(4, 64, 4);
    const old = bot.world.getBlock(where);
    bot.world.setBlockStateId(where, sid('copper_chest', { facing: 'north', type: 'single', waterlogged: false }));
    const upd = waitFor(socket, 'blockUpdate');
    bot.emit('blockUpdate', old, bot.world.getBlock(where));
    const u = await upd;
    assert.deepStrictEqual(u.pos, { x: 4, y: 64, z: 4 });
    const chest = ViewerBlock.fromStateId(u.stateId, 0);
    assert.strictEqual(chest.name, 'chest');
    assert.strictEqual(chest.getProperties().facing, 'north');
    bot.emit('blockUpdate', null, null); // ничего не ломается

    // Сущности
    const spawned = waitFor(socket, 'entity', (e) => e.id === 8 && e.name === 'skeleton');
    bot.emit('entitySpawn', { id: 8, name: 'skeleton', position: new Vec3(1, 64, 1), width: 0.6, height: 2 });
    await spawned;
    const gone = waitFor(socket, 'entity', (e) => e.id === 8 && e.delete === true);
    bot.emit('entityGone', { id: 8 });
    await gone;

    // Сервер выгрузил колонку
    const unloaded = waitFor(socket, 'unloadChunk', (d) => d.x === 16 && d.z === 16);
    bot.emit('chunkColumnUnload', new Vec3(16, 0, 16));
    await unloaded;
  } finally {
    socket.close();
    await ctx.server.close();
  }
  assert.strictEqual(listenerTotal(bot), 0, 'после закрытия на боте не осталось слушателей');
});

test('вид со стороны: позиция с addMesh', async () => {
  const ctx = await startServer({ mode: 'third' });
  const bot = makeBot();
  ctx.server.setBot(bot);
  const socket = connect(ctx);
  try {
    const pos = await waitFor(socket, 'position');
    assert.strictEqual(pos.addMesh, true);
    assert.strictEqual(pos.pitch, undefined);
  } finally {
    socket.close();
    await ctx.server.close();
  }
});

test('смена бота, respawn и вход на другой сервер перезагружают вид; слушатели снимаются', async () => {
  const ctx = await startServer();
  const bot = makeBot();
  ctx.server.setBot(bot);
  const g1 = ctx.server.getState().generation;
  ctx.server.setBot(bot); // тот же бот — ничего не меняется
  assert.strictEqual(ctx.server.getState().generation, g1);

  let socket = connect(ctx);
  try {
    await waitFor(socket, 'version');
    const dropped = waitFor(socket, 'disconnect');
    bot.emit('respawn');
    await dropped;
    const g2 = ctx.server.getState().generation;
    assert.ok(g2 > g1);
    assert.strictEqual(bot.listenerCount('move'), 0, 'сессия закрыта вместе с сокетом');

    socket = connect(ctx);
    await waitFor(socket, 'version');
    const dropped2 = waitFor(socket, 'disconnect');
    bot.emit('login');
    await dropped2;
    assert.ok(ctx.server.getState().generation > g2);

    socket = connect(ctx);
    await waitFor(socket, 'version');
    const dropped3 = waitFor(socket, 'disconnect');
    ctx.server.setBot(null);
    await dropped3;
    const s = ctx.server.getState();
    assert.strictEqual(s.online, false);
    assert.strictEqual(s.username, null);
    assert.strictEqual(listenerTotal(bot), 0);
  } finally {
    socket.close();
    await ctx.server.close();
  }
});

test('неподдерживаемая версия: «unsupported» в state, сокет закрывается', async () => {
  const ctx = await startServer();
  const bot = makeBot();
  bot.version = '1.7.10';
  ctx.server.setBot(bot);
  const socket = connect(ctx);
  try {
    const s = ctx.server.getState();
    assert.strictEqual(s.online, true);
    assert.strictEqual(s.unsupported, true);
    assert.strictEqual(s.viewerVersion, null);
    await waitFor(socket, 'disconnect');
  } finally {
    socket.close();
    await ctx.server.close();
  }
});

test('close() можно звать много раз, после него start() поднимает сервер заново', async () => {
  const { server, url } = await startServer();
  await server.close();
  await server.close();
  assert.strictEqual(server.url, null);
  await assert.rejects(fetch(url));
  const url2 = await server.start();
  assert.notStrictEqual(url2, url);
  assert.strictEqual((await fetch(`${url2}state`)).status, 200);
  await server.close();
});

test('рентген: настройки (POST — событие xray, те же от панели — тишина), поиск только с окном, руду выкопали — найдено заново', async () => {
  const ctx = await startServer({ xray: { enabled: true, radius: 1 } });
  const bot = makeBot();
  bot.heldItem = { name: 'gold_ore' };
  bot.blockAtCursor = () => ({ name: 'stone' });
  ctx.server.setBot(bot);
  const get = async (p) => (await fetch(`${ctx.url}${p}`)).json();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (check) => {
    for (let i = 0; i < 100; i++) {
      const v = await check();
      if (v) return v;
      await sleep(20);
    }
    throw new Error('не дождался');
  };
  const events = [];
  ctx.server.on('xray', (s) => events.push(s));
  let socket = null;
  try {
    const s0 = await get('xray');
    assert.strictEqual(s0.settings.enabled, true);
    assert.strictEqual(s0.settings.radius, 1);
    assert.ok(s0.settings.blocks.some((b) => b.name === 'diamond_ore'), 'список по умолчанию');
    assert.strictEqual((await get('xray/result')).result, null, 'окно не открыто — не ищет');

    socket = connect(ctx);
    await waitFor(socket, 'version');
    // Глубинная алмазная руда (-5 -20 -5) — в строке «Алмазы» (вместе с deepslate_…).
    const first = await until(async () => {
      const r = await get('xray/result');
      return r.result ? r : null;
    });
    const diamonds = first.result.groups.find((g) => g.key === 'diamond_ore');
    assert.deepEqual([diamonds.count, diamonds.positions], [1, [-5, -20, -5]]);
    assert.strictEqual(diamonds.label, 'Алмазы');
    assert.strictEqual(ctx.server.getState().xray.rev, first.rev);
    assert.deepEqual(ctx.server.getState().xray, { enabled: true, overlay: true, radius: 1, rev: first.rev });

    // Руду выкопали — ищет заново, её больше нет.
    const at = new Vec3(-5, -20, -5);
    const old = bot.world.getBlock(at);
    bot.world.setBlockStateId(at, 0);
    bot.emit('blockUpdate', old, bot.world.getBlock(at));
    const after = await until(async () => {
      const r = await get('xray/result');
      return r.rev !== first.rev && r.result ? r : null;
    });
    assert.strictEqual(after.result.groups.find((g) => g.key === 'diamond_ore').count, 0);

    // Поменяли в меню окна — событие xray (панель запомнит); те же от панели — без события.
    const res = await fetch(`${ctx.url}xray`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: { ...s0.settings, lava: true, blocks: [{ name: 'Minecraft:Spawner', label: '  Спавнер ', color: '#C34BFF' }] } }),
    });
    const saved = (await res.json()).settings;
    assert.deepEqual(saved.blocks, [{ name: 'spawner', label: 'Спавнер', color: '#c34bffff', on: true, same: true }]);
    assert.strictEqual(saved.lava, true);
    assert.strictEqual(events.length, 1);
    assert.deepEqual(events[0], saved);
    ctx.server.setXray(saved);
    assert.strictEqual(events.length, 1);
    for (const body of ['{"settings":[1]}', '{"x":1}', 'не json']) {
      const bad = await fetch(`${ctx.url}xray`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.strictEqual(bad.status, 400, body);
    }

    // Имена блоков для «Добавить блок» (без воздуха) и что бот держит, на что смотрит.
    const { blocks } = await get('xray/blocks');
    assert.ok(blocks.some(([n, title]) => n === 'diamond_ore' && title === 'Diamond Ore'));
    assert.ok(!blocks.some(([n]) => /air$/.test(n)));
    assert.deepEqual(await get('xray/pick'), { hand: 'gold_ore', look: 'stone' });
    bot.heldItem = { name: 'stick' };
    assert.deepEqual(await get('xray/pick'), { hand: null, look: 'stone' });
  } finally {
    if (socket) socket.close();
    await ctx.server.close();
  }
  assert.strictEqual(listenerTotal(bot), 0, 'слежка рентгена снята вместе с окном');
});