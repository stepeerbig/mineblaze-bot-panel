'use strict';

/*
 * Разбирает строку с кодами форматирования Minecraft на сегменты
 * { text, color, bold, italic, underline, strike }.
 * Понимает «§a», «§l», «§r», hex-цвета mineflayer «§#RRGGBB» и Bukkit «§x§R§R§G§G§B§B».
 * В HTML ничего не вставляется — интерфейс собирает элементы через textContent.
 */

const MC_COLORS = {
  0: '#7b8292', // чёрный, подсвечен: иначе не виден на тёмном фоне
  1: '#5d70ff', // тёмно-синий, подсвечен
  2: '#00aa00',
  3: '#00aaaa',
  4: '#e0483e', // тёмно-красный, подсвечен
  5: '#c24fd6', // фиолетовый, подсвечен
  6: '#ffaa00',
  7: '#aaaaaa',
  8: '#8a919c', // тёмно-серый, подсвечен
  9: '#5555ff',
  a: '#55ff55',
  b: '#55ffff',
  c: '#ff5555',
  d: '#ff55ff',
  e: '#ffff55',
  f: '#ffffff',
};

const HEX_MINECRAFT = /^§#([0-9a-f]{6})/i; // формат prismarine-chat (toMotd)
const HEX_BUKKIT = /^§x§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])§([0-9a-f])/i;

// Относительная яркость по WCAG.
function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Слишком тёмные hex-цвета (например, тёмно-синий в градиенте префикса) подмешиваем к белому,
 * пока контраст с фоном чата не станет не ниже 3:1. Остальные цвета не трогаем.
 */
function readableHex(hex) {
  const n = parseInt(hex, 16);
  const base = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  let rgb = base;
  for (let k = 0.1; luminance(rgb) < 0.14 && k < 1; k += 0.1) {
    rgb = base.map((v) => Math.round(v + (255 - v) * k));
  }
  return `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function parseMotd(input) {
  const text = String(input === null || input === undefined ? '' : input);
  const segments = [];
  const style = { color: null, bold: false, italic: false, underline: false, strike: false };
  let buf = '';

  const flush = () => {
    if (buf) segments.push({ text: buf, ...style });
    buf = '';
  };
  const resetStyle = () => {
    style.color = null;
    style.bold = false;
    style.italic = false;
    style.underline = false;
    style.strike = false;
  };
  const setColor = (color) => {
    flush();
    resetStyle(); // как в игре: цвет сбрасывает жирный/курсив и т.п.
    style.color = color;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== '§' || i + 1 >= text.length) {
      buf += ch;
      continue;
    }

    const code = text[i + 1].toLowerCase();

    if (code === '#') {
      const m = HEX_MINECRAFT.exec(text.slice(i, i + 8));
      if (m) {
        setColor(readableHex(m[1]));
        i += 7;
        continue;
      }
    }

    if (code === 'x') {
      const m = HEX_BUKKIT.exec(text.slice(i, i + 14));
      if (m) {
        setColor(readableHex(m.slice(1, 7).join('')));
        i += 13;
        continue;
      }
    }

    if (Object.prototype.hasOwnProperty.call(MC_COLORS, code)) {
      setColor(MC_COLORS[code]);
      i += 1;
      continue;
    }

    switch (code) {
      case 'l': flush(); style.bold = true; break;
      case 'o': flush(); style.italic = true; break;
      case 'n': flush(); style.underline = true; break;
      case 'm': flush(); style.strike = true; break;
      case 'r': flush(); resetStyle(); break;
      default: break; // §k (мерцающий текст) и неизвестные коды пропускаем
    }
    i += 1;
  }

  flush();
  return segments;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { parseMotd, readableHex };
