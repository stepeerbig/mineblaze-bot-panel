'use strict';

// «Отпечатки» предметов для кликов в меню (Minecraft 1.21.5+).
//
// В пакете клика (window_click) клиент сообщает серверу, что, по его расчёту, теперь лежит в изменившихся
// ячейках и в курсоре. Сами предметы не передаются: только вид, количество и для каждого компонента
// (название, описание, зачарования…) — CRC32C от его значения, закодированного так же, как в игре
// (net.minecraft.util.HashOps). Сервер сверяет эти отпечатки со своими предметами.
// mineflayer вместо отпечатков шлёт нули, а пустую ячейку — как «воздух, 0 штук»: так не делает ни один
// настоящий клиент. Здесь — подсчёт настоящих отпечатков для распространённых компонентов.

// ---------- CRC32C (Castagnoli), как Hashing.crc32c() в Guava ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC32C байтов; результат — int32 (как HashCode.asInt() в Java). */
function crc32c(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c | 0;
}

/** Накопитель байтов как Hasher из Guava: числа — в порядке little-endian, строки — UTF-16LE. */
class Hasher {
  constructor() {
    this.bytes = [];
  }

  byte(v) {
    this.bytes.push(v & 0xff);
    return this;
  }

  short(v) {
    return this.byte(v).byte(v >> 8);
  }

  int(v) {
    return this.byte(v).byte(v >> 8).byte(v >> 16).byte(v >> 24);
  }

  raw(buf) {
    for (const b of buf) this.byte(b);
    return this;
  }

  long(v) {
    const b = Buffer.alloc(8);
    b.writeBigInt64LE(BigInt.asIntN(64, BigInt(v)));
    return this.raw(b);
  }

  float(v) {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    return this.raw(b);
  }

  double(v) {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(v);
    return this.raw(b);
  }

  chars(s) {
    for (let i = 0; i < s.length; i += 1) this.short(s.charCodeAt(i));
    return this;
  }

  hash() {
    return crc32c(this.bytes);
  }
}

// ---------- HashOps: значение → отпечаток (int32) ----------

const TAG = {
  EMPTY: 1, MAP_START: 2, MAP_END: 3, LIST_START: 4, LIST_END: 5, BYTE: 6, SHORT: 7, INT: 8, LONG: 9, FLOAT: 10,
  DOUBLE: 11, STRING: 12, BOOLEAN: 13, BYTE_ARRAY_START: 14, BYTE_ARRAY_END: 15, INT_ARRAY_START: 16,
  INT_ARRAY_END: 17, LONG_ARRAY_START: 18, LONG_ARRAY_END: 19,
};

const h = {
  empty: () => new Hasher().byte(TAG.EMPTY).hash(),
  bool: (v) => new Hasher().byte(TAG.BOOLEAN).byte(v ? 1 : 0).hash(),
  byte: (v) => new Hasher().byte(TAG.BYTE).byte(v).hash(),
  short: (v) => new Hasher().byte(TAG.SHORT).short(v).hash(),
  int: (v) => new Hasher().byte(TAG.INT).int(v).hash(),
  long: (v) => new Hasher().byte(TAG.LONG).long(v).hash(),
  float: (v) => new Hasher().byte(TAG.FLOAT).float(v).hash(),
  double: (v) => new Hasher().byte(TAG.DOUBLE).double(v).hash(),
  str: (s) => new Hasher().byte(TAG.STRING).int(s.length).chars(s).hash(),
  /** Список: отпечатки элементов по порядку. */
  list: (items) => {
    const x = new Hasher().byte(TAG.LIST_START);
    for (const item of items) x.int(item);
    return x.byte(TAG.LIST_END).hash();
  },
  /** Словарь: пары [отпечаток ключа, отпечаток значения], порядок — по отпечаткам (как сортирует HashOps). */
  map: (entries) => {
    const u = (v) => v >>> 0;
    const sorted = [...entries].sort((a, b) => u(a[0]) - u(b[0]) || u(a[1]) - u(b[1]));
    const x = new Hasher().byte(TAG.MAP_START);
    for (const [k, v] of sorted) x.int(k).int(v);
    return x.byte(TAG.MAP_END).hash();
  },
  /** Словарь с текстовыми ключами (так кодируются записи и поля компонентов). */
  fields: (obj) => h.map(Object.entries(obj).filter(([, v]) => v !== undefined).map(([k, v]) => [h.str(k), v])),
  byteArray: (bytes) => new Hasher().byte(TAG.BYTE_ARRAY_START).raw(bytes).byte(TAG.BYTE_ARRAY_END).hash(),
  intArray: (ints) => {
    const x = new Hasher().byte(TAG.INT_ARRAY_START);
    for (const v of ints) x.int(v);
    return x.byte(TAG.INT_ARRAY_END).hash();
  },
  longArray: (longs) => {
    const x = new Hasher().byte(TAG.LONG_ARRAY_START);
    for (const v of longs) x.long(v);
    return x.byte(TAG.LONG_ARRAY_END).hash();
  },
};
const EMPTY_MAP = h.map([]);

// ---------- NBT (prismarine-nbt) → отпечаток ----------

const toBigInt = (v) => (Array.isArray(v) ? (BigInt(v[0]) << 32n) | BigInt(v[1] >>> 0) : BigInt(v));

// Поля текста, которые в игре — логические (в NBT их не отличить от чисел: там это байты 0/1).
const TEXT_BOOLEANS = new Set(['bold', 'italic', 'underlined', 'strikethrough', 'obfuscated', 'interpret']);

/**
 * Отпечаток значения в виде NBT. booleans — имена полей, которые надо считать логическими (у текста);
 * для «сырых» NBT (custom_data) — пусто: там байт — это байт.
 */
function nbtHash(tag, booleans = null, key = null) {
  if (!tag || typeof tag !== 'object') throw new Error('не NBT');
  const { type, value } = tag;
  switch (type) {
    case 'compound':
      return h.map(Object.entries(value).map(([k, v]) => [h.str(k), nbtHash(v, booleans, k)]));
    case 'list': {
      const items = (value && value.value) || [];
      return h.list(
        items.map((raw) => {
          let el = { type: value.type, value: raw };
          // С 1.21.5 в списке могут быть значения разных видов: в сети каждое завёрнуто в {"": значение}.
          if (value.type === 'compound' && raw && typeof raw === 'object') {
            const keys = Object.keys(raw);
            if (keys.length === 1 && keys[0] === '') el = raw[''];
          }
          return nbtHash(el, booleans, null);
        }),
      );
    }
    case 'string':
      return h.str(String(value));
    case 'byte':
      return booleans && booleans.has(key) ? h.bool(value !== 0) : h.byte(value);
    case 'short':
      return h.short(value);
    case 'int':
      return h.int(value);
    case 'long':
      return h.long(toBigInt(value));
    case 'float':
      return h.float(value);
    case 'double':
      return h.double(value);
    case 'byteArray':
      return h.byteArray(value);
    case 'intArray':
      return h.intArray(value);
    case 'longArray':
      return h.longArray(value.map(toBigInt));
    case 'end':
      return h.empty();
    default:
      throw new Error(`неизвестный вид NBT ${type}`);
  }
}

/** Текст (название, строка описания) — как ComponentSerialization.CODEC. */
const textHash = (tag) => nbtHash(tag, TEXT_BOOLEANS);

// ---------- компоненты предметов ----------

const ns = (name) => (String(name).includes(':') ? String(name) : `minecraft:${name}`);

/**
 * Отпечаток одного компонента предмета (значение — как его разбирает minecraft-protocol).
 * names — справочник имён по номерам: { enchantment(id), component(id) }.
 * Возвращает int32 или null, если такой компонент считать не умеем.
 */
function componentHash(type, data, names = {}) {
  switch (type) {
    case 'custom_name':
    case 'item_name':
      return textHash(data);
    case 'lore':
      return h.list(data.map(textHash));
    case 'custom_data':
    case 'bucket_entity_data':
      return nbtHash(data);
    case 'max_stack_size':
    case 'max_damage':
    case 'damage':
    case 'repair_cost':
    case 'map_id':
    case 'dyed_color':
    case 'map_color':
    case 'ominous_bottle_amplifier':
      return h.int(data);
    case 'unbreakable':
    case 'creative_slot_lock':
    case 'glider':
    case 'intangible_projectile':
      return EMPTY_MAP;
    case 'enchantment_glint_override':
      return h.bool(Boolean(data));
    case 'rarity':
    case 'item_model':
    case 'tooltip_style':
      return h.str(type === 'rarity' ? String(data) : ns(data));
    case 'enchantments':
    case 'stored_enchantments': {
      const list = (data && data.enchantments) || [];
      const entries = [];
      for (const e of list) {
        const name = names.enchantment ? names.enchantment(e.id) : null;
        if (!name) return null;
        entries.push([h.str(ns(name)), h.int(e.level)]);
      }
      return h.map(entries);
    }
    case 'tooltip_display': {
      const hidden = [];
      for (const id of (data && data.hiddenComponents) || []) {
        const name = names.component ? names.component(id) : null;
        if (!name) return null;
        hidden.push(h.str(ns(name)));
      }
      return h.fields({
        hide_tooltip: data && data.hideTooltip ? h.bool(true) : undefined,
        hidden_components: hidden.length ? h.list(hidden) : undefined,
      });
    }
    case 'custom_model_data': {
      const d = data || {};
      const listOf = (arr, fn) => (arr && arr.length ? h.list(arr.map(fn)) : undefined);
      return h.fields({
        floats: listOf(d.floats, h.float),
        flags: listOf(d.flags, (v) => h.bool(Boolean(v))),
        strings: listOf(d.strings, (v) => h.str(String(v))),
        colors: listOf(d.colors, h.int),
      });
    }
    case 'minimum_attack_charge':
    case 'potion_duration_scale':
      return h.float(data);
    default:
      return null;
  }
}

/**
 * Предмет из Item.toNotch (обычный формат ячейки) → формат HashedSlot для window_click.
 * Пустая ячейка → undefined (в пакете — «ничего»). onUnknown(type) — компонент, который считать не умеем
 * (тогда отпечаток 0, как раньше у mineflayer).
 */
function toHashedSlot(slot, { names = {}, onUnknown = null } = {}) {
  if (!slot || typeof slot !== 'object') return undefined;
  const count = slot.itemCount !== undefined ? slot.itemCount : slot.count;
  const itemId = slot.itemId;
  if (!count || count <= 0 || itemId === undefined || itemId === null || itemId <= 0) return undefined;
  const components = [];
  for (const c of slot.components || []) {
    if (!c || !c.type) continue;
    let hash = null;
    if (Number.isInteger(c.hash)) {
      hash = c.hash; // уже отпечаток
    } else {
      try {
        hash = componentHash(c.type, c.data, names);
      } catch (_) {
        hash = null;
      }
    }
    if (hash === null) {
      if (onUnknown) onUnknown(c.type);
      hash = 0;
    }
    components.push({ type: c.type, hash });
  }
  const removeComponents = (slot.removeComponents || []).filter((c) => c && c.type).map((c) => ({ type: c.type }));
  return { itemId, itemCount: count, components, removeComponents };
}

module.exports = { crc32c, Hasher, h, nbtHash, textHash, componentHash, toHashedSlot, TEXT_BOOLEANS };
