'use strict';
// Отладка панели через порт отладки (Playwright): подключиться к запущенной панели, показать её страницы и выводить
// в терминал консоль и ошибки окна панели. Страницы проверки «я не робот» (MineBlaze antibot) не трогает — только
// перечисляет.
//
// Панель запущена с --remote-debugging-port=9222 (проще всего — start-debug.bat), затем:
//   node tools/panel-debug/panel-debug.js     (другой порт: ... panel-debug.js 9333)
// playwright-core уже стоит в tools/panel-debug (заново — npm i в этой папке). Свои браузеры Playwright не нужны:
// он подключается к Chromium самой панели.
const { chromium } = require('playwright-core');

const port = Number(process.argv[2]) || 9222;
const isCaptcha = (url) => /antibot|captcha/i.test(url);

(async () => {
  // панель могла ещё не открыться (start-debug.bat запускает её рядом) — пробуем до 60 с
  let browser;
  for (let i = 0; ; i++) {
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
      break;
    } catch (err) {
      if (i === 0) console.log(`Жду панель на порту ${port}…`);
      if (i >= 60) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  console.log(`Подключился к панели через Playwright (порт ${port}): Chromium ${browser.version()}`);

  const pages = browser.contexts().flatMap((ctx) => ctx.pages());
  for (const p of pages) console.log(`${isCaptcha(p.url()) ? '  [проверка, не трогаю]' : '  [страница]'} ${p.url()}`);

  const panel = pages.find((p) => p.url().startsWith('file:') && p.url().includes('renderer'));
  if (!panel) {
    console.log('Окно панели не нашёл.');
    return browser.close(); // для connectOverCDP — только отключиться, панель не закрывается
  }
  panel.on('console', (m) => console.log(`[консоль ${m.type()}] ${m.text()}`));
  panel.on('pageerror', (e) => console.log(`[ошибка] ${e.message}`));
  console.log(`Окно панели: «${await panel.title()}». Слушаю консоль, Ctrl+C — отключиться (панель продолжит работать).`);

  process.on('SIGINT', () => browser.close().finally(() => process.exit(0)));
})().catch((err) => {
  console.error(`Не подключился: ${err.message}. Панель запущена с --remote-debugging-port=${port}?`);
  process.exit(1);
});
