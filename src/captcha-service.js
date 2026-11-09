// src/captcha-service.js
const { chromium } = require('playwright');
const EventEmitter = require('events');
const path = require('path');
const ProxyChain = require('proxy-chain'); // <--- ДОБАВЛЕНА БИБЛИОТЕКА

class CaptchaService extends EventEmitter {
  constructor() {
    super();
    this.queue = [];
    this.isProcessing = false;
  }

  async solve(url, proxy) {
    return new Promise((resolve) => {
      this.queue.push({ url, proxy, resolve });
      this.processQueue();
    });
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    const task = this.queue.shift();
    let browser = null;
    let anonymizedProxyUrl = null;
      
    try {
      this.emit('log', { level: 'info', text: `[CAPTCHA] Запускаю браузер...` });

       let proxyConfig = {
     server: `socks5://127.0.0.1:1080`
   };
   this.emit('log', { level: 'info', text: `[CAPTCHA] Использую локальный релей: 127.0.0.1:1080` });

      // === УМНЫЙ ПУТЬ К БРАУЗЕРУ (для exe и npm start) ===
      let executablePath = chromium.executablePath();
      if (executablePath.includes('app.asar')) {
        executablePath = executablePath.replace('app.asar', 'app.asar.unpacked');
      }
      
      this.emit('log', { level: 'info', text: `[CAPTCHA] Использую браузер: ${executablePath}` });

      // Запускаем браузер. Теперь он думает, что прокси без пароля.
     // Запускаем браузер с маскировкой от ботов
      browser = await chromium.launch({ 
        headless: false, 
        proxy: proxyConfig,
        executablePath: executablePath,
        args: [
          '--disable-blink-features=AutomationControlled', // Скрываем, что это Playwright
          '--disable-infobars', // Убираем плашку "Chrome управляется автоматизированным ПО"
          '--no-sandbox',
          '--disable-setuid-sandbox'
        ]
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', // Свежий User-Agent
        viewport: { width: 1280, height: 720 }
      });

      const page = await context.newPage();
      
      this.emit('log', { level: 'info', text: `[CAPTCHA] Переход по ссылке...` });
      await page.goto(task.url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      
      // Ждем 7 секунд
      await page.waitForTimeout(7000);

      // ДЕЛАЕМ СКРИНШОТ ДЛЯ ОТЛАДКИ
      const screenshotPath = path.join(process.cwd(), 'antibot-debug.png');
      await page.screenshot({ path: screenshotPath, fullPage: true });
      this.emit('log', { level: 'warn', text: `[CAPTCHA] Скриншот сохранен в: ${screenshotPath}` });

      const content = await page.content();
      
      // Проверяем, не пройдена ли капча
      if (content.includes('успешно') || content.includes('пропускаем')) {
        this.emit('log', { level: 'ok', text: `[CAPTCHA] Проверка пройдена!` });
      } else {
        const button = await page.$('button:has-text("Да"), input[type="submit"][value="Да"], button:has-text("Подтвердить")');
        if (button) {
          this.emit('log', { level: 'info', text: `[CAPTCHA] Найдена кнопка, кликаю...` });
          await button.click();
          await page.waitForTimeout(5000);
        } else {
          this.emit('log', { level: 'warn', text: `[CAPTCHA] Кнопки "Да" нет. Возможно, капча с картинками.` });
        }
      }

      task.resolve(true);

    } catch (error) {
      this.emit('log', { level: 'error', text: `[CAPTCHA] Ошибка: ${error.message}` });
      task.resolve(false);
    } finally {
      if (browser) {
        await browser.close().catch(() => {});
      }
      // Важно: закрываем локальный туннель, чтобы не копились порты
      if (anonymizedProxyUrl) {
        await ProxyChain.closeAnonymizedProxy(anonymizedProxyUrl, true).catch(() => {});
      }
      this.isProcessing = false;
      setTimeout(() => this.processQueue(), 2000); 
    }
  }
}

module.exports = { CaptchaService };