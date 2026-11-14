// test-captcha.js
const { launch } = require('cloakbrowser');

async function main() {
  console.log('Запускаю CloakBrowser...');
  
  const browser = await launch({
    // Вставьте сюда ваш прокси в формате socks5://user:pass@host:port или http://...
    proxy: 'socks5://ВАШ_ПРОКСИ', 
    headless: false, // Обязательно false, некоторые сайты палят headless режим
    humanize: true,  // Включает человекоподобные движения мыши и клавиатуры
    geoip: true,     // Пытается подстроить часовой пояс под IP прокси
  });

  const page = await browser.newPage();
  
  // Ссылка на капчу (можно взять из логов панели)
  const captchaUrl = 'https://mineblaze.net/antibot/?id=...'; 
  
  console.log(`Перехожу по ссылке: ${captchaUrl}`);
  await page.goto(captchaUrl);
  
  // Ждем, пока страница загрузится и появится кнопка "Да" (или другой элемент)
  // Здесь мы просто ждем 30 секунд, чтобы вы могли вручную посмотреть, пройдет ли проверка
  console.log('Жду 30 секунд, чтобы проверить результат...');
  await new Promise(resolve => setTimeout(resolve, 30000));

  console.log('Закрываю браузер.');
  await browser.close();
}

main().catch(console.error);