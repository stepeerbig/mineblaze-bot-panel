'use strict';

// Переходник окна проверки «я не робот» (src/proxy-relay.js): SOCKS5 без пароля на 127.0.0.1 → прокси бота с
// логином и паролем. Здесь «прокси бота» — свой маленький SOCKS5 с паролем, «сайт» — эхо-сервер.

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const path = require('node:path');
const { SocksClient } = require('socks');

const { startRelay } = require(path.join(__dirname, '..', 'src', 'proxy-relay.js'));

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

/** SOCKS5 с логином/паролем (RFC 1929): запоминает, с каким логином и куда просили. */
function authProxy(user, pass) {
  const seen = [];
  const server = net.createServer((c) => {
    c.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 0;
    c.on('data', function onData(chunk) {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        const methods = [...buf.subarray(2, 2 + buf[1])];
        buf = buf.subarray(2 + buf[1]);
        if (!methods.includes(2)) return c.end(Buffer.from([5, 0xff]));
        c.write(Buffer.from([5, 2]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 2) {
        const ul = buf[1];
        if (buf.length < 3 + ul) return undefined;
        const pl = buf[2 + ul];
        if (buf.length < 3 + ul + pl) return undefined;
        const u = buf.subarray(2, 2 + ul).toString();
        const p = buf.subarray(3 + ul, 3 + ul + pl).toString();
        buf = buf.subarray(3 + ul + pl);
        if (u !== user || p !== pass) return c.end(Buffer.from([1, 1]));
        c.write(Buffer.from([1, 0]));
        stage = 2;
      }
      if (stage === 2 && buf.length >= 7) {
        let host;
        let end;
        if (buf[3] === 3) {
          end = 5 + buf[4];
          host = buf.subarray(5, end).toString();
        } else {
          end = 8;
          host = [...buf.subarray(4, 8)].join('.');
        }
        if (buf.length < end + 2) return undefined;
        const port = buf.readUInt16BE(end);
        seen.push({ user: u0(user), host, port });
        c.off('data', onData);
        const out = net.connect(port, host === 'localhost' ? '127.0.0.1' : host, () => {
          c.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          out.pipe(c);
          c.pipe(out);
        });
        out.on('error', () => c.destroy());
        stage = 3;
      }
      return undefined;
    });
  });
  const u0 = (x) => x;
  return { server, seen };
}

function echoServer() {
  return net.createServer((c) => {
    c.on('error', () => {});
    c.pipe(c);
  });
}

test('переходник: браузер без пароля → прокси бота с логином и паролем (и %-коды в пароле), данные ходят в обе стороны', async () => {
  const echo = echoServer();
  const echoPort = await listen(echo);
  const { server, seen } = authProxy('WVBKWT', 'p@ss:1');
  const proxyPort = await listen(server);
  const relay = await startRelay({ host: '127.0.0.1', port: proxyPort, username: 'WVBKWT', password: 'p%40ss%3A1' });
  try {
    // Как Chromium: SOCKS5 без пароля к 127.0.0.1:relay, просит соединение по имени хоста.
    const { socket } = await SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: relay.port, type: 5 },
      command: 'connect',
      destination: { host: 'localhost', port: echoPort },
    });
    const got = await new Promise((resolve) => {
      socket.once('data', (d) => resolve(d.toString()));
      socket.write('привет');
    });
    socket.destroy();
    assert.equal(got, 'привет');
    assert.deepEqual(seen, [{ user: 'WVBKWT', host: 'localhost', port: echoPort }]);
  } finally {
    relay.close();
    server.close();
    echo.close();
  }
});

test('переходник: прокси бота не пустил (неверный пароль) — браузеру отказ, а не зависание', async () => {
  const { server } = authProxy('WVBKWT', 'right');
  const proxyPort = await listen(server);
  const relay = await startRelay({ host: '127.0.0.1', port: proxyPort, username: 'WVBKWT', password: 'wrong' });
  try {
    await assert.rejects(SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: relay.port, type: 5 },
      command: 'connect',
      destination: { host: 'example.com', port: 443 },
      timeout: 5000,
    }));
  } finally {
    relay.close();
    server.close();
  }
});

// ---------- начало HTTPS по частям (фильтр в сети прокси рвёт соединение, увидев имя сайта в ClientHello) ----------

const tls = require('node:tls');
const { splitHello } = require(path.join(__dirname, '..', 'src', 'proxy-relay.js'));

/** TLS-записи подряд из buf → [{ type, payload }]. */
function records(buf) {
  const out = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const len = buf.readUInt16BE(i + 3);
    out.push({ type: buf[i], payload: buf.subarray(i + 5, i + 5 + len) });
    i += 5 + len;
  }
  return out;
}

/** Похожее на ClientHello: заголовок рукопожатия (1 — ClientHello) и имя сайта внутри. */
function fakeHello(host) {
  const body = Buffer.concat([Buffer.alloc(40, 7), Buffer.from(host), Buffer.alloc(60, 9)]);
  const hs = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1, hs.length >> 8, hs.length & 255]), hs]);
}

test('начало HTTPS: ClientHello — двумя TLS-записями, разрез посреди имени сайта; байты рукопожатия те же', () => {
  const hello = fakeHello('mineblaze.net');
  const parts = splitHello(hello, 'mineblaze.net');
  assert.equal(parts.length, 2);
  const recs = records(Buffer.concat(parts));
  assert.equal(recs.length, 2);
  assert.ok(recs.every((r) => r.type === 0x16));
  assert.deepEqual(Buffer.concat(recs.map((r) => r.payload)), hello.subarray(5)); // сайт получает то же самое
  // ни в одном куске имени целиком нет — фильтру не за что зацепиться
  assert.ok(parts.every((p) => !p.includes('mineblaze.net')));
  assert.ok(parts[0].includes('mine'));
});

test('начало HTTPS: не целиком — ждать; не TLS и не ClientHello — как есть', () => {
  const hello = fakeHello('mineblaze.net');
  assert.equal(splitHello(hello.subarray(0, 3), 'mineblaze.net'), null);
  assert.equal(splitHello(hello.subarray(0, 50), 'mineblaze.net'), null);
  const http = Buffer.from('GET / HTTP/1.1\r\nHost: mineblaze.net\r\n\r\n');
  assert.deepEqual(splitHello(http, 'mineblaze.net'), [http]);
  const alert = Buffer.from([0x15, 3, 3, 0, 2, 2, 40]);
  assert.deepEqual(splitHello(alert, 'x'), [alert]);
  // имени нет (адрес вместо имени) — режем посередине, всё равно две записи
  const parts = splitHello(fakeHello('10.0.0.1'), '10.0.0.1');
  assert.equal(records(Buffer.concat(parts)).length, 2);
});

test('переходник: настоящий ClientHello от TLS доходит до сайта двумя записями, остальное — без изменений', async () => {
  let got = Buffer.alloc(0);
  let gotResolve;
  const enough = new Promise((r) => { gotResolve = r; });
  const site = net.createServer((c) => {
    c.on('error', () => {});
    c.on('data', (d) => {
      got = Buffer.concat([got, d]);
      const recs = records(got);
      const total = recs.reduce((n, r) => n + 5 + r.payload.length, 0);
      if (recs.length >= 2 && total === got.length) gotResolve();
    });
  });
  const sitePort = await listen(site);
  const { server } = authProxy('u', 'p');
  const proxyPort = await listen(server);
  const relay = await startRelay({ host: '127.0.0.1', port: proxyPort, username: 'u', password: 'p' });
  let s;
  try {
    const { socket } = await SocksClient.createConnection({
      proxy: { host: '127.0.0.1', port: relay.port, type: 5 },
      command: 'connect',
      destination: { host: 'localhost', port: sitePort },
    });
    s = tls.connect({ socket, servername: 'localhost', rejectUnauthorized: false });
    s.on('error', () => {});
    await Promise.race([enough, new Promise((_, no) => setTimeout(() => no(new Error('сайт не получил ClientHello')), 5000))]);
    const recs = records(got);
    assert.equal(recs.length, 2);
    assert.ok(recs.every((r) => r.type === 0x16 && !r.payload.includes('localhost')));
    const hs = Buffer.concat(recs.map((r) => r.payload));
    assert.equal(hs[0], 1); // ClientHello
    assert.equal(hs.readUIntBE(1, 3) + 4, hs.length); // сообщение целое — склеивается из двух записей
    assert.ok(hs.includes('localhost'));
  } finally {
    if (s) s.destroy();
    relay.close();
    server.close();
    site.close();
  }
});
