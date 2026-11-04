'use strict';

// Что бот сообщает о себе серверу при входе («профиль» клиента).
// Обычный клиент 1.20.2+ сразу после входа, в фазе настройки, один раз присылает бренд («vanilla») и свои
// настройки (язык, дальность прорисовки…). mineflayer делает иначе: настройки уходят дважды и с разными
// значениями (en_us и 10 чанков при входе, en_US и 12 — после каждого входа в мир), а бренд — только после
// входа в мир и заново при каждом переходе между серверами через прокси. Здесь — как у обычного клиента.

const BRAND = 'vanilla';
const BRAND_CHANNELS = new Set(['minecraft:brand', 'MC|Brand']);

// Настройки обычного клиента с русским языком.
const CLIENT_SETTINGS = Object.freeze({
  locale: 'ru_ru',
  viewDistance: 10,
  chatFlags: 0, // чат виден целиком
  chatColors: true,
  skinParts: 0x7f, // все части скина
  mainHand: 1, // правая рука
  enableTextFiltering: false,
  enableServerListing: true,
});

const CHAT_BITS = { enabled: 0, commandsOnly: 1, disabled: 2 };
const HAND_BITS = { left: 0, right: 1 };
const VIEW_DISTANCE_BITS = { far: 12, normal: 10, short: 8, tiny: 6 };

/** Строка протокола: длина (varint) и байты UTF-8. */
function encodeString(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const len = [];
  let n = bytes.length;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    len.push(b);
  } while (n);
  return Buffer.concat([Buffer.from(len), bytes]);
}

/** Опции createBot: настройки для фазы настройки (их шлёт minecraft-protocol) и бренд. */
function profileOptions() {
  return { brand: BRAND, clientSettings: { ...CLIENT_SETTINGS } };
}

/**
 * Плагин вместо встроенного settings из mineflayer: то же bot.settings и bot.setSettings(), но настройки не
 * отправляются заново после каждого входа в мир — только когда их меняют через bot.setSettings().
 */
function settingsPlugin(bot) {
  bot.settings = {
    chat: 'enabled',
    colorsEnabled: CLIENT_SETTINGS.chatColors,
    viewDistance: CLIENT_SETTINGS.viewDistance,
    difficulty: 2,
    skinParts: {
      showCape: true,
      showJacket: true,
      showLeftSleeve: true,
      showRightSleeve: true,
      showLeftPants: true,
      showRightPants: true,
      showHat: true,
    },
    mainHand: 'right',
    enableTextFiltering: CLIENT_SETTINGS.enableTextFiltering,
    enableServerListing: CLIENT_SETTINGS.enableServerListing,
    particleStatus: 'all',
    locale: CLIENT_SETTINGS.locale,
  };

  bot.setSettings = (settings) => {
    Object.assign(bot.settings, settings);
    const s = bot.settings;
    const chatFlags = CHAT_BITS[s.chat];
    if (chatFlags === undefined) throw new Error(`invalid chat setting: ${s.chat}`);
    const viewDistance = typeof s.viewDistance === 'string' ? VIEW_DISTANCE_BITS[s.viewDistance] : s.viewDistance;
    if (!(viewDistance > 0)) throw new Error(`invalid view distance setting: ${s.viewDistance}`);
    const mainHand = HAND_BITS[s.mainHand];
    if (mainHand === undefined) throw new Error(`invalid main hand: ${s.mainHand}`);
    const p = s.skinParts;
    const skinParts =
      (p.showCape << 0) | (p.showJacket << 1) | (p.showLeftSleeve << 2) | (p.showRightSleeve << 3) |
      (p.showLeftPants << 4) | (p.showRightPants << 5) | (p.showHat << 6);
    bot._client.write('settings', {
      locale: s.locale,
      viewDistance,
      chatFlags,
      chatColors: s.colorsEnabled,
      skinParts,
      mainHand,
      enableTextFiltering: s.enableTextFiltering,
      enableServerListing: s.enableServerListing,
      particleStatus: s.particleStatus,
    });
  };
}

/**
 * Бренд — как у обычного клиента: один раз, в фазе настройки сразу перед настройками клиента. Бренд, который
 * mineflayer шлёт после каждого входа в мир, на сервер не уходит. На старых версиях (без фазы настройки) ничего
 * не меняется: там бренд после входа в мир — это нормально.
 */
function applyClientProfile(client) {
  if (!client || typeof client.write !== 'function') return;
  const write = client.write.bind(client);
  let brandSent = false;
  client.write = (name, params) => {
    if (name === 'settings' && client.state === 'configuration' && !brandSent) {
      brandSent = true;
      write('custom_payload', { channel: 'minecraft:brand', data: encodeString(BRAND) });
    } else if (brandSent && name === 'custom_payload' && params && BRAND_CHANNELS.has(params.channel)) {
      return undefined; // бренд уже ушёл при входе
    }
    return write(name, params);
  };
}

module.exports = { BRAND, CLIENT_SETTINGS, profileOptions, settingsPlugin, applyClientProfile, encodeString };
