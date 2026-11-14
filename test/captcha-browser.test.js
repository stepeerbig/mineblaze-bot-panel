'use strict';

// Браузер окна проверки «я не робот» (src/captcha-browser.js): какой он по файлам рядом с exe и как его запускать —
// всегда приватное окно, свой профиль бота, прокси бота; у Edge ещё и без автовхода под учётной записью Windows.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { browserKind, browserName, privateArgs, launchArgs, firefoxPrefs, EDGE_NO_AUTO_SIGNIN } = require(path.join(__dirname, '..', 'src', 'captcha-browser.js'));

/** Папка «браузера»: exe и файлы рядом (путь «12.0/x.dll» — в папке версии). → путь к exe. */
function fakeBrowser(exeName, files = [], sub = '') {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mbp-browser-')), sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, exeName), '');
  for (const f of files) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), '');
  }
  return path.join(dir, exeName);
}

test('браузер по файлам рядом: любой на Chromium (*_elf.dll в папке версии), на Firefox (xul.dll); иначе — по имени', () => {
  assert.equal(browserKind(fakeBrowser('msedge.exe', ['157.0.4341.46/msedge_elf.dll'])), 'chromium');
  assert.equal(browserKind(fakeBrowser('superbrowser.exe', ['3.1.0/chrome_elf.dll'])), 'chromium', 'неизвестный по имени, но на Chromium');
  assert.equal(browserKind(fakeBrowser('librewolf.exe', ['xul.dll'])), 'firefox');
  assert.equal(browserKind(fakeBrowser('chrome.exe')), 'chromium', 'файлов нет — по имени');
  assert.equal(browserKind(fakeBrowser('firefox.exe')), 'firefox');
  assert.equal(browserKind(fakeBrowser('notabrowser.exe')), null);
  assert.equal(browserName(fakeBrowser('browser.exe')), 'Яндекс.Браузер');
  assert.equal(browserName(fakeBrowser('launcher.exe', [], 'Opera')), 'Opera');
  assert.equal(browserName(fakeBrowser('superbrowser.exe')), 'superbrowser');
});

test('приватное окно у любого браузера: Edge — InPrivate, Opera — private, Chrome/Яндекс/Brave/Vivaldi — incognito, Firefox — private-window', () => {
  assert.deepEqual(privateArgs('chromium', 'C:\\Edge\\Application\\msedge.exe'), ['--inprivate']);
  assert.ok(privateArgs('chromium', 'C:\\Users\\u\\AppData\\Local\\Programs\\Opera\\launcher.exe').includes('--private'));
  for (const exe of ['C:\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Yandex\\YandexBrowser\\Application\\browser.exe',
    'C:\\BraveSoftware\\Brave-Browser\\Application\\brave.exe', 'C:\\Vivaldi\\Application\\vivaldi.exe', 'C:\\X\\superbrowser.exe']) {
    assert.deepEqual(privateArgs('chromium', exe), ['--incognito'], exe);
  }
  assert.deepEqual(privateArgs('firefox', 'C:\\Mozilla Firefox\\firefox.exe'), ['-private-window']);
});

test('командная строка: свой профиль, приватно, прокси бота, ссылка — последней; Edge — без автовхода под учётной записью', () => {
  const url = 'https://mineblaze.net/antibot/?id=x';
  const edge = launchArgs({ kind: 'chromium', exe: 'C:\\Edge\\msedge.exe', profile: 'P', proxyPort: 5555, url });
  assert.ok(edge.includes('--user-data-dir=P'));
  assert.ok(edge.includes('--inprivate'));
  assert.ok(edge.includes(EDGE_NO_AUTO_SIGNIN));
  assert.equal(EDGE_NO_AUTO_SIGNIN, '--disable-features=msImplicitSignin');
  assert.ok(edge.includes('--proxy-server=socks5://127.0.0.1:5555'));
  assert.deepEqual(edge.slice(-2), ['--new-window', url]);

  const yandex = launchArgs({ kind: 'chromium', exe: 'C:\\Yandex\\browser.exe', profile: 'P', proxyPort: 5555, url });
  assert.ok(yandex.includes('--incognito'));
  assert.ok(!yandex.includes(EDGE_NO_AUTO_SIGNIN), 'ключ Edge — только Edge');

  const noProxy = launchArgs({ kind: 'chromium', exe: 'C:\\Chrome\\chrome.exe', profile: 'P', url });
  assert.ok(noProxy.includes('--no-proxy-server'));

  const ff = launchArgs({ kind: 'firefox', exe: 'C:\\Firefox\\firefox.exe', profile: 'P', proxyPort: 5555, url });
  assert.deepEqual(ff, ['-profile', 'P', '-no-remote', '-private-window', url]);
  const prefs = firefoxPrefs(5555);
  assert.match(prefs, /user_pref\("network\.proxy\.socks_port", 5555\);/);
  assert.match(prefs, /user_pref\("network\.proxy\.socks_remote_dns", true\);/);
});
