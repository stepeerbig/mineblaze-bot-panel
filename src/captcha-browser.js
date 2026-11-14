'use strict';

// Браузер для проверки «я не робот» (main.js, openInBrowser): какой он и как его запустить. Окно — всегда приватное
// (инкогнито): без учётной записи человека, без синхронизации, cookie не остаются. 13.11: в обычном окне Edge сам
// входил в новый профиль под учётной записью Microsoft из Windows и подтягивал её избранное. Ещё у каждого бота свой
// профиль (чтобы уже открытый браузер человека не забрал ссылку себе, без прокси) и прокси бота.

const fs = require('fs');
const path = require('path');

// Известные по имени (если не нашлось признаков по файлам рядом). browser.exe — Яндекс.Браузер, launcher.exe — Opera.
const CHROMIUM_EXE = /^(msedge|chrome|browser|opera|launcher|brave|vivaldi|chromium|thorium|arc)\.exe$/i;
const FIREFOX_EXE = /^(firefox|waterfox|librewolf|floorp|zen|palemoon|mullvadbrowser)\.exe$/i;
const NAMES = {
  'msedge.exe': 'Edge',
  'chrome.exe': 'Chrome',
  'browser.exe': 'Яндекс.Браузер',
  'opera.exe': 'Opera',
  'brave.exe': 'Brave',
  'vivaldi.exe': 'Vivaldi',
  'firefox.exe': 'Firefox',
};

const isOpera = (exe) => /opera/i.test(exe);

/**
 * Какой это браузер по файлам рядом с ним: 'chromium' (Edge, Chrome, Яндекс, Opera, Brave, Vivaldi и любой другой на
 * Chromium — у всех рядом, обычно в папке версии, лежит *_elf.dll), 'firefox' (Firefox и браузеры на нём — xul.dll),
 * null — не знаем, как задать ему прокси и приватное окно.
 */
function browserKind(exe) {
  const dir = path.dirname(exe);
  const file = path.basename(exe);
  try {
    if (fs.existsSync(path.join(dir, 'xul.dll')) || fs.existsSync(path.join(dir, 'omni.ja'))) return 'firefox';
    const elf = (d) => fs.readdirSync(d).some((f) => /_elf\.dll$/i.test(f));
    if (elf(dir)) return 'chromium';
    for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
      if (sub.isDirectory() && /^\d+\./.test(sub.name) && elf(path.join(dir, sub.name))) return 'chromium';
    }
  } catch (_) {
    /* папку не прочитать — по имени */
  }
  if (CHROMIUM_EXE.test(file)) return 'chromium';
  if (FIREFOX_EXE.test(file)) return 'firefox';
  return null;
}

function browserName(exe) {
  const file = path.basename(exe).toLowerCase();
  if (file === 'launcher.exe' && isOpera(exe)) return 'Opera';
  return NAMES[file] || path.basename(exe).replace(/\.exe$/i, '');
}

// Edge сам входит в новый профиль под учётной записью Microsoft из Windows — даже когда открыто только окно InPrivate
// (окно её не использует, но запросы входа login.live.com шли через прокси бота, т. е. с IP прокси). Ключ ниже это
// выключает (13.11, Edge 157: без него вход — в каждом из 7 прогонов, с ним — ни в одном из 4). Настройки профиля
// signin.allowed и edge_implicit_sign_in_enabled, как и гостевой режим --guest, не помогали.
const EDGE_NO_AUTO_SIGNIN = '--disable-features=msImplicitSignin';

/** Ключ приватного окна: Edge — InPrivate, Opera — «приватное окно», остальные на Chromium — инкогнито. */
function privateArgs(kind, exe) {
  if (kind === 'firefox') return ['-private-window'];
  const file = path.basename(exe).toLowerCase();
  if (file === 'msedge.exe') return ['--inprivate'];
  if (isOpera(exe)) return ['--private', '--incognito'];
  return ['--incognito'];
}

/**
 * Командная строка браузера: свой профиль бота, приватное окно, прокси (переходник src/proxy-relay.js на 127.0.0.1:
 * proxyPort; нет — без прокси), ссылка. У Firefox прокси — в user.js профиля (firefoxPrefs).
 */
function launchArgs({ kind, exe, profile, proxyPort = null, url }) {
  if (kind === 'firefox') return ['-profile', profile, '-no-remote', ...privateArgs(kind, exe), url];
  const args = [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', ...privateArgs(kind, exe)];
  if (path.basename(exe).toLowerCase() === 'msedge.exe') args.push(EDGE_NO_AUTO_SIGNIN);
  // socks5:// — имя сайта браузер отдаёт прокси, адрес ищет сам прокси (как у бота)
  if (proxyPort) args.push(`--proxy-server=socks5://127.0.0.1:${proxyPort}`, '--proxy-bypass-list=<-loopback>');
  else args.push('--no-proxy-server');
  args.push('--new-window', url);
  return args;
}

/** user.js профиля Firefox: прокси (remote_dns — адрес сайта ищет сам прокси, как у бота), без приветствий. */
function firefoxPrefs(proxyPort = null) {
  const prefs = proxyPort
    ? [['network.proxy.type', 1], ['network.proxy.socks', '127.0.0.1'], ['network.proxy.socks_port', proxyPort],
      ['network.proxy.socks_version', 5], ['network.proxy.socks_remote_dns', true], ['network.proxy.no_proxies_on', ''],
      ['network.trr.mode', 5]]
    : [['network.proxy.type', 0]];
  prefs.push(['browser.shell.checkDefaultBrowser', false], ['browser.aboutwelcome.enabled', false],
    ['datareporting.policy.dataSubmissionEnabled', false]);
  return prefs.map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n';
}

module.exports = { browserKind, browserName, privateArgs, launchArgs, firefoxPrefs, EDGE_NO_AUTO_SIGNIN };
