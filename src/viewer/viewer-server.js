'use strict';

// Локальный сервер окна «Экран бота»: отдаёт страницу, готовый 3D-клиент prismarine-viewer
// и поток мира вокруг бота (чанки, сущности, позиция) через socket.io.
// Слушает только 127.0.0.1 на случайном порту; все адреса — под случайным токеном.

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const EventEmitter = require('events');
const express = require('express');
const { Server } = require('socket.io');
const { Vec3 } = require('vec3');
const { pickViewerVersion, createStateTranslator, fixChunkJson } = require('./block-translator');
const { patchIndexBundle, patchWorkerBundle } = require('./bundle-patches');

const VIEWER_DIR = path.dirname(require.resolve('prismarine-viewer/package.json'));
const DEFAULT_PUBLIC_DIR = path.join(VIEWER_DIR, 'public');
const { supportedVersions: SUPPORTED_VERSIONS } = require('prismarine-viewer/viewer/lib/version.js');

const MODES = ['first', 'third'];
const normalizeMode = (mode) => (mode === 'third' ? 'third' : 'first');
const LOOK_POLL_MS = 250; // как часто проверяем повороты головы без движения
const CHUNK_BUDGET_MS = 8; // сколько подряд готовим чанки, прежде чем отдать управление боту
const PAGE_FILES = { 'ui.js': 'application/javascript; charset=utf-8', 'ui.css': 'text/css; charset=utf-8' };

// Переводчики номеров блоков общие для всех сессий: создавать их недёшево.
const translators = new Map();
function translatorFor(from, to) {
  const key = `${from}>${to}`;
  if (!translators.has(key)) translators.set(key, createStateTranslator(from, to));
  return translators.get(key);
}

const chunkKey = (x, z) => `${x},${z}`;
const toChunk = (v) => Math.floor(v / 16);
const plainPos = (p) => ({ x: p.x, y: p.y, z: p.z });

/** Поток мира для одной открытой страницы (одного сокета). */
class ViewSession {
  constructor(server, socket, bot, view) {
    this.server = server;
    this.socket = socket;
    this.bot = bot;
    this.translator = view.translator;
    this.viewerVersion = view.viewerVersion;
    this.radius = Math.max(1, server.viewDistance - 1); // чанков в каждую сторону от бота
    this.sent = new Set(); // ключи чанков, уже отправленных странице
    this.queue = []; // ключи чанков, ждущих отправки (ближние первыми)
    this.pumping = false;
    this.closed = false;
    this.center = null;
    this.lastPos = '';
    this.listeners = {};
    this.lookTimer = null;
  }

  start() {
    const { bot, socket } = this;
    socket.emit('version', this.viewerVersion);
    // Сущности, которые уже рядом (сам бот рисуется отдельно, через 'position').
    for (const e of Object.values(bot.entities || {})) {
      if (e && e !== bot.entity) socket.emit('entity', this.entityInfo(e));
    }
    this.on('move', () => this.updatePosition(false));
    this.on('forcedMove', () => this.updatePosition(true));
    this.on('entitySpawn', (e) => {
      if (e && e !== bot.entity) socket.emit('entity', this.entityInfo(e));
    });
    this.on('entityMoved', (e) => {
      if (e && e !== bot.entity) socket.emit('entity', this.entityInfo(e));
    });
    this.on('entityGone', (e) => {
      if (e && e !== bot.entity) socket.emit('entity', { id: e.id, delete: true });
    });
    this.on('chunkColumnLoad', (p) => {
      if (!p) return;
      const key = chunkKey(p.x, p.z);
      this.sent.delete(key); // сервер прислал колонку заново — отправим свежую
      if (this.inView(p.x, p.z)) this.enqueue([key]);
    });
    this.on('chunkColumnUnload', (p) => {
      if (!p) return;
      const key = chunkKey(p.x, p.z);
      this.queue = this.queue.filter((k) => k !== key);
      if (this.sent.delete(key)) socket.emit('unloadChunk', { x: p.x, z: p.z });
    });
    this.on('blockUpdate', (oldBlock, newBlock) => this.blockUpdate(oldBlock, newBlock));
    socket.on('disconnect', () => this.stop());
    // Повороты головы без шага 'move' не дают — проверяем позицию и взгляд сами.
    this.lookTimer = setInterval(() => this.safe('позиция', () => this.updatePosition(false)), LOOK_POLL_MS);
    this.updatePosition(true);
  }

  /** Подписка на событие бота: ошибки внутри никогда не уходят в mineflayer. */
  on(event, handler) {
    const wrapped = (...args) => this.safe(event, () => handler(...args));
    this.listeners[event] = wrapped;
    this.bot.on(event, wrapped);
  }

  safe(what, fn) {
    if (this.closed) return;
    try {
      fn();
    } catch (err) {
      this.server._warnOnce(`session:${what}`, 'warn', `ошибка при обработке «${what}»: ${err && err.message ? err.message : err}`);
    }
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.lookTimer);
    for (const [event, listener] of Object.entries(this.listeners)) this.bot.removeListener(event, listener);
    this.listeners = {};
    this.queue = [];
    this.server._sessions.delete(this);
  }

  entityInfo(e) {
    return {
      id: e.id,
      name: e.name,
      username: e.username,
      pos: e.position ? plainPos(e.position) : undefined,
      width: e.width,
      height: e.height,
      yaw: e.yaw,
      pitch: e.pitch,
    };
  }

  inView(x, z) {
    if (!this.center) return false;
    return Math.abs(toChunk(x) - this.center.x) <= this.radius && Math.abs(toChunk(z) - this.center.z) <= this.radius;
  }

  /** Позиция и взгляд бота; при переходе в другой чанк — обновляем набор видимых чанков. */
  updatePosition(force) {
    const ent = this.bot.entity;
    if (!ent || !ent.position) return;
    const p = ent.position;
    const sig = `${p.x},${p.y},${p.z},${ent.yaw},${ent.pitch}`;
    if (force || sig !== this.lastPos) {
      this.lastPos = sig;
      const packet = this.server.mode === 'third'
        ? { pos: plainPos(p), yaw: ent.yaw, addMesh: true }
        : { pos: plainPos(p), yaw: ent.yaw, pitch: ent.pitch };
      this.socket.emit('position', packet);
    }
    const cx = toChunk(p.x);
    const cz = toChunk(p.z);
    if (this.center && this.center.x === cx && this.center.z === cz && !force) return;
    this.center = { x: cx, z: cz };
    // Ушедшие из вида чанки убираем со страницы.
    for (const key of [...this.sent]) {
      const [x, z] = key.split(',').map(Number);
      if (!this.inView(x, z)) {
        this.sent.delete(key);
        this.socket.emit('unloadChunk', { x, z });
      }
    }
    this.queue = this.queue.filter((key) => {
      const [x, z] = key.split(',').map(Number);
      return this.inView(x, z);
    });
    // Новые — в очередь, ближние первыми.
    const wanted = [];
    for (let dx = -this.radius; dx <= this.radius; dx++) {
      for (let dz = -this.radius; dz <= this.radius; dz++) wanted.push([dx, dz]);
    }
    wanted.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]));
    this.enqueue(wanted.map(([dx, dz]) => chunkKey((cx + dx) * 16, (cz + dz) * 16)));
  }

  enqueue(keys) {
    const queued = new Set(this.queue);
    for (const key of keys) {
      if (!this.sent.has(key) && !queued.has(key)) {
        this.queue.push(key);
        queued.add(key);
      }
    }
    if (!this.pumping && this.queue.length) {
      this.pumping = true;
      setImmediate(() => this.pump());
    }
  }

  /** Готовит чанки порциями, чтобы бот (он в этом же процессе) не подвисал. */
  async pump() {
    const started = Date.now();
    try {
      while (!this.closed && this.queue.length && Date.now() - started < CHUNK_BUDGET_MS) {
        const key = this.queue.shift();
        if (this.sent.has(key)) continue;
        const [x, z] = key.split(',').map(Number);
        if (!this.inView(x, z)) continue;
        await this.sendChunk(x, z, key);
      }
    } finally {
      if (!this.closed && this.queue.length) setImmediate(() => this.pump());
      else this.pumping = false;
    }
  }

  async sendChunk(x, z, key) {
    let column;
    try {
      column = await this.bot.world.getColumnAt(new Vec3(x, 0, z));
    } catch (_) {
      column = null; // мир бота как раз сменился
    }
    if (!column || this.closed) return;
    try {
      const json = column.toJson();
      const chunk = this.translator ? this.translator.chunkJson(json) : fixChunkJson(json);
      this.socket.emit('loadChunk', { x, z, chunk });
      this.sent.add(key);
      this.server._reportUnknown(this.translator);
    } catch (err) {
      this.server._warnOnce('chunk', 'warn', `не удалось подготовить часть мира для показа: ${err && err.message ? err.message : err}`);
    }
  }

  blockUpdate(oldBlock, newBlock) {
    const block = newBlock || oldBlock;
    if (!block || !block.position) return;
    const pos = block.position;
    if (!this.sent.has(chunkKey(toChunk(pos.x) * 16, toChunk(pos.z) * 16))) return; // чанк ещё не на странице
    let stateId = 0;
    if (newBlock) {
      stateId = typeof newBlock.stateId === 'number'
        ? newBlock.stateId
        : ((newBlock.type << 4) | (newBlock.metadata || 0)); // версии до 1.13
    }
    if (this.translator) stateId = this.translator.stateId(stateId);
    this.socket.emit('blockUpdate', { pos: plainPos(pos), stateId });
  }
}

class ViewerServer extends EventEmitter {
  constructor({ mode = 'first', viewDistance = 6, log = () => {}, publicDir = DEFAULT_PUBLIC_DIR, pageDir = path.join(__dirname, 'page') } = {}) {
    super();
    this._mode = normalizeMode(mode);
    this.viewDistance = Math.max(2, Math.min(16, Number(viewDistance) || 6));
    this._log = typeof log === 'function' ? log : () => {};
    this.publicDir = publicDir;
    this.pageDir = pageDir;
    this._bot = null;
    this._botListeners = {};
    this._view = null; // { viewerVersion, translator } или null, если версия не поддерживается
    this._generation = 1;
    this._sessions = new Set();
    this._warned = new Set();
    this._reportedUnknown = new WeakMap();
    this._bundles = new Map(); // имя файла -> промис { body, etag }
    this._startPromise = null;
    this._http = null;
    this._io = null;
    this._url = null;
  }

  get url() {
    return this._url;
  }

  get mode() {
    return this._mode;
  }

  // ---------- запуск и остановка ----------

  start() {
    if (!this._startPromise) {
      this._startPromise = this._listen().catch((err) => {
        this._startPromise = null;
        throw err;
      });
    }
    return this._startPromise;
  }

  async _listen() {
    const token = crypto.randomBytes(16).toString('hex');
    const app = express();
    app.disable('x-powered-by');
    app.set('etag', false); // ETag ставим сами там, где он нужен
    const server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const { port } = server.address();
    const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    const origins = new Set([...hosts].map((h) => `http://${h}`));
    server.on('error', (err) => this._warnOnce('http', 'warn', `ошибка локального сервера: ${err.message}`));

    // Чужой Host — значит, запрос пришёл не из нашего окна (защита от DNS rebinding).
    app.use((req, res, next) => {
      if (!hosts.has(String(req.headers.host || '').toLowerCase())) return res.status(403).type('text').send('Forbidden');
      return next();
    });
    app.use(`/${token}`, this._router(token));
    app.use((req, res) => res.status(404).type('text').send('Not found'));
    // Без стека вызовов в ответе.
    app.use((err, req, res, _next) => {
      const status = err && (err.status || err.statusCode);
      res.status(status >= 400 && status < 600 ? status : 500).type('text').send(status === 404 ? 'Not found' : 'Error');
    });

    const io = new Server(server, {
      path: `/${token}/socket.io`,
      serveClient: false,
      maxHttpBufferSize: 1e5,
      allowRequest: (req, callback) => {
        const hostOk = hosts.has(String(req.headers.host || '').toLowerCase());
        const origin = req.headers.origin;
        callback(null, hostOk && (!origin || origins.has(String(origin).toLowerCase())));
      },
    });
    io.on('connection', (socket) => this._onConnection(socket));

    this._http = server;
    this._io = io;
    this._url = `http://127.0.0.1:${port}/${token}/`;
    return this._url;
  }

  _router(token) {
    const router = express.Router({ strict: true });
    const noStore = (res) => res.set('Cache-Control', 'no-store');

    router.get('/', (req, res, next) => {
      // Страница должна открываться с «/» на конце: от этого зависят все относительные адреса.
      if (req.originalUrl.split('?')[0] === `/${token}`) return res.redirect(301, `/${token}/`);
      noStore(res);
      return res.sendFile(path.join(this.pageDir, 'index.html'), (err) => err && next(err));
    });
    for (const [name, type] of Object.entries(PAGE_FILES)) {
      router.get(`/${name}`, (req, res, next) => {
        noStore(res);
        res.type(type).sendFile(path.join(this.pageDir, name), (err) => err && next(err));
      });
    }
    // Готовые бандлы клиента с нашими правками (CSP-заголовок не ставим: worker.js нужен eval).
    router.get('/index.js', (req, res, next) => this._sendBundle('index.js', req, res, next));
    router.get('/worker.js', (req, res, next) => this._sendBundle('worker.js', req, res, next));
    // Текстуры и описания блоков: файлы не меняются, пусть браузер держит их в кэше.
    const staticOpts = { dotfiles: 'deny', index: false, redirect: false, fallthrough: false, maxAge: '1d', immutable: true };
    router.use('/textures', express.static(path.join(this.publicDir, 'textures'), staticOpts));
    router.use('/blocksStates', express.static(path.join(this.publicDir, 'blocksStates'), staticOpts));

    router.get('/state', (req, res) => {
      noStore(res);
      res.json(this.getState());
    });
    router.post('/mode', express.json({ limit: '1kb' }), (req, res) => {
      noStore(res);
      const mode = req.body && req.body.mode;
      if (!MODES.includes(mode)) return res.status(400).json({ error: 'mode' });
      this.setMode(mode);
      return res.json(this.getState());
    });
    return router;
  }

  async _sendBundle(name, req, res, next) {
    let bundle;
    try {
      bundle = await this._bundle(name);
    } catch (err) {
      this._warnOnce(`bundle:${name}`, 'error', `не удалось прочитать ${name}: ${err.message}`);
      return next(err);
    }
    res.set({
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'private, max-age=86400, immutable',
      ETag: bundle.etag,
    });
    if (req.headers['if-none-match'] === bundle.etag) return res.status(304).end();
    return res.send(bundle.body);
  }

  /** Читает бандл один раз, правит и держит в памяти, пока сервер работает. */
  _bundle(name) {
    if (!this._bundles.has(name)) {
      const promise = fs.promises.readFile(path.join(this.publicDir, name), 'utf8').then((source) => {
        const result = name === 'worker.js' ? patchWorkerBundle(source) : patchIndexBundle(source);
        if (result.skipped.length) {
          const list = result.skipped.map((s) => `${s.name} (найдено ${s.found} из ${s.expected})`).join(', ');
          this._log('warn', `не все правки просмотрщика применились (${name}: ${list}); часть мира может не отображаться`);
        }
        const body = Buffer.from(result.code, 'utf8'); // строка worker.js в памяти вдвое больше буфера
        const etag = `"${crypto.createHash('sha1').update(body).digest('hex')}"`;
        return { body, etag };
      });
      promise.catch(() => this._bundles.delete(name)); // в следующий раз попробуем снова
      this._bundles.set(name, promise);
    }
    return this._bundles.get(name);
  }

  async close() {
    const startPromise = this._startPromise;
    this._startPromise = null;
    if (startPromise) await startPromise.catch(() => {});
    this._detachBot();
    this._bot = null;
    this._view = null;
    for (const session of [...this._sessions]) session.stop();
    const io = this._io;
    const server = this._http;
    this._io = null;
    this._http = null;
    this._url = null;
    this._bundles.clear();
    if (io) io.disconnectSockets(true);
    if (server) {
      await new Promise((resolve) => {
        if (io) io.close(() => resolve());
        else server.close(() => resolve());
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
    }
  }

  // ---------- бот и режим ----------

  setBot(bot) {
    const next = bot && typeof bot === 'object' ? bot : null;
    if (next === this._bot) return;
    this._detachBot();
    this._dropSessions();
    this._bot = next;
    this._view = null;
    if (next) {
      this._view = this._resolveView(next.version);
      // На respawn/смену измерения и вход на другой сервер за прокси mineflayer меняет мир —
      // проще всего перезагрузить страницу целиком.
      const reload = () => {
        this._bump();
        this._dropSessions();
      };
      this._botListeners = { respawn: reload, login: reload };
      for (const [event, listener] of Object.entries(this._botListeners)) next.on(event, listener);
    }
    this._bump();
  }

  setMode(mode) {
    const next = normalizeMode(mode);
    if (next === this._mode) return next;
    this._mode = next;
    this._bump();
    this._dropSessions();
    this.emit('mode', next);
    return next;
  }

  getState() {
    const bot = this._bot;
    const online = Boolean(bot && bot.entity);
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const round1 = (v) => Math.round(v * 10) / 10;
    const p = online && bot.entity.position;
    const dimension = online && bot.game && bot.game.dimension ? String(bot.game.dimension).replace(/^minecraft:/, '') : null;
    return {
      online,
      generation: this._generation,
      mode: this._mode,
      username: online && typeof bot.username === 'string' ? bot.username : null,
      health: online ? num(bot.health) : null,
      food: online ? num(bot.food) : null,
      position: p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: round1(p.x), y: round1(p.y), z: round1(p.z) } : null,
      dimension,
      viewerVersion: online && this._view ? this._view.viewerVersion : null,
      botVersion: online && bot.version ? String(bot.version) : null,
      unsupported: online && !this._view,
    };
  }

  // ---------- внутреннее ----------

  _resolveView(version) {
    try {
      const picked = pickViewerVersion(version, SUPPORTED_VERSIONS);
      if (!picked) {
        this._log('warn', `версия ${version} не поддерживается окном просмотра`);
        return null;
      }
      const translator = picked.translate ? translatorFor(version, picked.viewerVersion) : null;
      return { viewerVersion: picked.viewerVersion, translator };
    } catch (err) {
      this._log('warn', `не удалось подготовить показ версии ${version}: ${err.message}`);
      return null;
    }
  }

  _onConnection(socket) {
    const bot = this._bot;
    if (!bot || !bot.entity || !bot.world || !this._view) {
      socket.disconnect(true); // показывать нечего; страница узнает об этом из 'state'
      return;
    }
    const session = new ViewSession(this, socket, bot, this._view);
    this._sessions.add(session);
    try {
      session.start();
    } catch (err) {
      this._warnOnce('session:start', 'warn', `не удалось начать показ: ${err.message}`);
      session.stop();
      socket.disconnect(true);
    }
  }

  _dropSessions() {
    for (const session of [...this._sessions]) {
      session.stop();
      session.socket.disconnect(true);
    }
  }

  _detachBot() {
    if (this._bot) {
      for (const [event, listener] of Object.entries(this._botListeners)) this._bot.removeListener(event, listener);
    }
    this._botListeners = {};
  }

  _bump() {
    this._generation += 1;
  }

  _warnOnce(key, level, text) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    this._log(level, text);
  }

  _reportUnknown(translator) {
    if (!translator || !translator.unknownNames || !translator.unknownNames.size) return;
    const seen = this._reportedUnknown.get(translator) || 0;
    if (translator.unknownNames.size <= seen) return;
    this._reportedUnknown.set(translator, translator.unknownNames.size);
    const names = [...translator.unknownNames].slice(0, 10).join(', ');
    this._log('info', `блоки без пары в версии ${translator.toVersion} показаны камнем или пустотой: ${names}`);
  }
}

module.exports = { ViewerServer };
