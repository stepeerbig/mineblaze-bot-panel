'use strict';

// Точка входа процесса бота (Electron utilityProcess, запускает src/bot-client.js из главного процесса).
// Здесь работают BotManager и экран бота; с главным процессом — только сообщения (см. src/bot-host.js).

const { createBotHost } = require('./bot-host');

const parentPort = process.parentPort;
if (!parentPort) {
  // Запустили не из Electron (например, просто node) — работать не с кем.
  console.error('src/bot-process.js запускается только из главного процесса панели');
  process.exit(1);
}

const host = createBotHost({
  port: {
    on: (handler) => parentPort.on('message', (event) => handler(event.data)),
    post: (message) => parentPort.postMessage(message),
  },
  exit: (code) => process.exit(code),
});

// Ошибка, которую никто не поймал, не должна молча убивать бота: сообщаем в консоль панели.
const report = (err) => host.log('error', `Необработанная ошибка в процессе бота: ${err && err.stack ? err.stack.split('\n')[0] : err}`);
process.on('uncaughtException', report);
process.on('unhandledRejection', report);
