'use strict';

// Переходник для окна проверки «я не робот»: браузер панели (Chromium) умеет SOCKS5 только без логина и пароля, а
// прокси ботов — с ними. Поэтому на 127.0.0.1 слушает свой SOCKS5 без пароля и каждое соединение ведёт дальше через
// прокси бота уже с логином и паролем. Страница проверки так видит тот же IP, с которого заходит бот.

// Начало HTTPS — по частям. 13.11: прокси пула стоят в России (AS39238), и фильтр в их сети (не сайт и не продавец
// прокси: с именем mineblaze.net рвётся даже соединение с серверами Google) обрывает HTTPS, увидев имя сайта в
// первом сообщении TLS (ClientHello). Фильтр смотрит только целое сообщение: если отправить ClientHello двумя
// TLS-записями (стандарт TLS это разрешает — байты рукопожатия те же, сайт получает ровно то же самое) и с паузой,
// имени он не узнаёт. Проверено на обоих прокси: страница проверки mineblaze.net — 200 OK, настоящий сертификат.
// Так переходник отправляет начало каждого HTTPS-соединения.

const net = require('net');
const { SocksClient } = require('socks');

const CONNECT_TIMEOUT_MS = 15000;
const SPLIT_PAUSE_MS = 30; // между двумя частями ClientHello: прокси успевает отправить первую отдельно
const MAX_RECORD = 16384 + 2048; // больше TLS-запись быть не может — значит, это не TLS

/**
 * Первое, что браузер шлёт сайту (buf — всё, что пришло от него до сих пор), — по частям для отправки.
 * → null — первая TLS-запись пришла не целиком, ждать ещё; иначе [Buffer…]: ClientHello — двумя TLS-записями,
 * разрезанными посреди имени сайта host; не TLS — как есть, одним куском.
 */
function splitHello(buf, host) {
  if (!buf.length) return null;
  if (buf[0] !== 0x16) return [buf]; // не TLS (например, http://)
  if (buf.length < 6) return null;
  const len = buf.readUInt16BE(3);
  if (buf[1] !== 3 || len < 2 || len > MAX_RECORD) return [buf];
  if (buf.length < 5 + len) return null;
  const payload = buf.subarray(5, 5 + len);
  const tail = buf.subarray(5 + len);
  if (payload[0] !== 1) return [buf]; // не ClientHello
  const name = host && !net.isIP(host) ? payload.indexOf(Buffer.from(host, 'latin1')) : -1;
  let k = name >= 0 ? name + Math.max(1, Math.floor(host.length / 2)) : Math.floor(len / 2);
  k = Math.min(Math.max(k, 1), len - 1);
  const head = (n) => Buffer.from([0x16, buf[1], buf[2], n >> 8, n & 0xff]);
  return [
    Buffer.concat([head(k), payload.subarray(0, k)]),
    Buffer.concat([head(len - k), payload.subarray(k), tail]),
  ];
}

const decode = (s) => {
  try {
    return decodeURIComponent(s || '');
  } catch (_) {
    return s || '';
  }
};

function ipv6(buf) {
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(i).toString(16));
  return parts.join(':');
}

/**
 * Запустить переходник к прокси upstream { host, port, username, password } (логин и пароль — как в ссылке пула,
 * %-кодированные). → Promise<{ port, close() }>: port — где слушает на 127.0.0.1.
 */
function startRelay(upstream, { timeout = CONNECT_TIMEOUT_MS } = {}) {
  const sockets = new Set();
  const proxy = {
    host: upstream.host,
    port: Number(upstream.port) || 1080,
    type: 5,
    ...(upstream.username ? { userId: decode(upstream.username), password: decode(upstream.password) } : {}),
  };

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    let buf = Buffer.alloc(0);
    let stage = 'hello';
    const fail = (code) => {
      client.end(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 'hello') {
        if (buf.length < 2) return;
        if (buf[0] !== 5) {
          client.destroy();
          return;
        }
        const n = buf[1];
        if (buf.length < 2 + n) return;
        buf = buf.subarray(2 + n);
        client.write(Buffer.from([5, 0])); // без пароля
        stage = 'request';
      }
      if (stage !== 'request' || buf.length < 5) return;
      const atyp = buf[3];
      let host;
      let end;
      if (atyp === 1) {
        end = 8;
        if (buf.length < end + 2) return;
        host = [...buf.subarray(4, 8)].join('.');
      } else if (atyp === 3) {
        end = 5 + buf[4];
        if (buf.length < end + 2) return;
        host = buf.subarray(5, end).toString('utf8');
      } else if (atyp === 4) {
        end = 20;
        if (buf.length < end + 2) return;
        host = ipv6(buf.subarray(4, 20));
      } else {
        stage = 'done';
        fail(8);
        return;
      }
      const port = buf.readUInt16BE(end);
      const rest = buf.subarray(end + 2);
      const cmd = buf[1];
      stage = 'done';
      client.off('data', onData);
      if (cmd !== 1) {
        fail(7); // только CONNECT
        return;
      }
      client.pause();
      SocksClient.createConnection({ proxy, command: 'connect', destination: { host, port }, timeout })
        .then(({ socket }) => {
          if (client.destroyed) {
            socket.destroy();
            return;
          }
          sockets.add(socket);
          socket.on('close', () => {
            sockets.delete(socket);
            client.destroy();
          });
          socket.on('error', () => client.destroy());
          client.on('close', () => socket.destroy());
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          socket.pipe(client);
          // Начало соединения — по частям (splitHello), дальше — как есть.
          let head = rest;
          const first = (chunk) => {
            head = chunk ? Buffer.concat([head, chunk]) : head;
            const parts = splitHello(head, host);
            if (!parts) return;
            client.off('data', first);
            client.pause();
            (async () => {
              for (let i = 0; i < parts.length; i += 1) {
                if (socket.destroyed) return;
                socket.write(parts[i]);
                if (i < parts.length - 1) await new Promise((r) => setTimeout(r, SPLIT_PAUSE_MS));
              }
              if (client.destroyed || socket.destroyed) return;
              client.pipe(socket);
              client.resume();
            })();
          };
          client.on('data', first);
          first(null);
          if (!client.destroyed && client.listenerCount('data')) client.resume();
        })
        .catch(() => {
          if (!client.destroyed) fail(5);
        });
    };
    client.on('data', onData);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        port: server.address().port,
        close() {
          for (const s of sockets) s.destroy();
          server.close();
        },
      });
    });
  });
}

module.exports = { startRelay, splitHello };
