// Fase 3: pengaturan dashboard (src/settings.js): satu kunci berversi, validasi, localStorage yang rusak atau melempar,
// migrasi kunci lama, serta penerapan mode waktu dan gerak.
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SETTINGS, LEGACY_RAIN_KEY, MOTION_MODES, SETTINGS_KEY, SETTINGS_VERSION, TIME_MODES, TIME_RESOLVERS,
  applyMotionAttr, createSettingsStore, hasNewerVersion, loadSettings, parseSettings, resolveReducedMotion, resolveVariant,
  sanitizeSettings, saveSettings, serializeSettings,
} from '../src/settings.js';
import { LANG_STORAGE_KEY } from '../src/i18n.js';
import { THEME_KEY } from '../src/theme.js';

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => void m.set(k, String(v)),
    removeItem: (k) => void m.delete(k),
    dump: () => Object.fromEntries(m),
  };
};
const throwing = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
});
const stored = (o) => JSON.stringify({ v: SETTINGS_VERSION, ...o });

describe('bawaan', () => {
  it('bawaan = tampilan sekarang: jakarta, ikuti tema UI, gerak ikuti sistem, tanpa hujan', () => {
    expect(DEFAULT_SETTINGS).toEqual({ v: 1, officeTheme: 'jakarta', timeMode: 'follow', motion: 'system', rain: false });
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(SETTINGS_KEY).toBe('ai-office-settings');
  });

  it('tanpa penyimpanan apa pun: bawaan, tidak menulis apa-apa', () => {
    const s = memStorage();
    expect(loadSettings(s)).toEqual({ settings: DEFAULT_SETTINGS, source: 'default' });
    expect(s.dump()).toEqual({});
  });

  it('storage null/undefined: bawaan', () => {
    expect(loadSettings(null).settings).toEqual(DEFAULT_SETTINGS);
    expect(loadSettings(undefined).settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('simpan dan muat', () => {
  it('simpan lalu muat mengembalikan nilai yang sama, dalam satu kunci berversi', () => {
    const s = memStorage();
    const value = { v: 1, officeTheme: 'kafe', timeMode: 'night', motion: 'reduce', rain: true };
    expect(saveSettings(s, value)).toBe(true);
    expect(Object.keys(s.dump())).toEqual([SETTINGS_KEY]);
    expect(JSON.parse(s.dump()[SETTINGS_KEY])).toEqual(value);
    expect(loadSettings(s)).toEqual({ settings: value, source: 'stored' });
  });

  it('serialize selalu menulis versi dan hanya kolom yang dikenal', () => {
    const text = serializeSettings({ officeTheme: 'kafe', hack: '<script>', v: 99 });
    expect(JSON.parse(text)).toEqual({ ...DEFAULT_SETTINGS, officeTheme: 'kafe' });
  });

  it('kolom yang rusak jatuh ke bawaan satu per satu, kolom lain dipertahankan', () => {
    const s = memStorage({ [SETTINGS_KEY]: stored({ officeTheme: 'KAFE!', timeMode: 'malam', motion: 'reduce', rain: 'ya' }) });
    expect(loadSettings(s).settings).toEqual({ ...DEFAULT_SETTINGS, motion: 'reduce' });
  });

  it('kolom tak dikenal dibuang', () => {
    const p = parseSettings(stored({ officeTheme: 'kafe', evil: { a: 1 }, __proto__: { x: 1 } }));
    expect(p).toEqual({ ...DEFAULT_SETTINGS, officeTheme: 'kafe' });
    expect('evil' in p).toBe(false);
  });

  it('id tema yang tidak lagi terpasang tetap disimpan (resolusi ke bawaan terjadi saat dipakai)', () => {
    expect(parseSettings(stored({ officeTheme: 'tema-lama' })).officeTheme).toBe('tema-lama');
  });
});

describe('JSON rusak dan nilai tak terduga', () => {
  it.each([
    ['{'], ['bukan json'], ['null'], ['42'], ['"teks"'], ['[]'], ['[1,2]'], [''], ['{"v":2}'], ['{"v":"1"}'], ['{}'],
    [JSON.stringify({ v: 1, pad: 'x'.repeat(5000) })],
  ])('parseSettings(%j) → null', (text) => {
    expect(parseSettings(text)).toBeNull();
  });

  it('JSON rusak di storage: jatuh ke bawaan dan ditandai corrupt; tidak menimpa storage', () => {
    const s = memStorage({ [SETTINGS_KEY]: '{rusak' });
    expect(loadSettings(s)).toEqual({ settings: DEFAULT_SETTINGS, source: 'corrupt' });
    expect(s.dump()[SETTINGS_KEY]).toBe('{rusak');
  });

  it('versi tidak dikenal: bawaan (pilihan pengguna tidak ditimpa sampai ia mengubah sesuatu)', () => {
    const s = memStorage({ [SETTINGS_KEY]: JSON.stringify({ v: 7, officeTheme: 'kafe' }) });
    expect(loadSettings(s).settings).toEqual(DEFAULT_SETTINGS);
  });

  it.each([[undefined], [null], [5], ['x'], [[]], [true]])('sanitizeSettings(%j) → bawaan', (raw) => {
    expect(sanitizeSettings(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it('prototype pollution lewat JSON tidak berpengaruh', () => {
    const p = parseSettings('{"v":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}');
    expect(p).toEqual(DEFAULT_SETTINGS);
    expect({}.polluted).toBeUndefined();
  });

  it('mode waktu tak dikenal ditolak; mode baru bisa diizinkan lewat daftar (Fase 4)', () => {
    expect(sanitizeSettings({ timeMode: 'auto' }).timeMode).toBe('follow');
    expect(sanitizeSettings({ timeMode: 'auto' }, { timeModes: [...TIME_MODES, 'auto'] }).timeMode).toBe('auto');
  });
});

describe('localStorage melempar (mode privat, kuota penuh)', () => {
  it('muat: getItem melempar → bawaan', () => {
    expect(loadSettings(throwing())).toEqual({ settings: DEFAULT_SETTINGS, source: 'default' });
  });

  it('simpan: setItem melempar → false, tanpa melempar', () => {
    expect(saveSettings(throwing(), DEFAULT_SETTINGS)).toBe(false);
    expect(saveSettings(null, DEFAULT_SETTINGS)).toBe(false);
  });

  it('store tetap bekerja di memori dan memberi tahu pendengar walau penyimpanan gagal', () => {
    const store = createSettingsStore(throwing());
    const fn = vi.fn();
    store.subscribe(fn);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(store.set({ officeTheme: 'cyberpunk', rain: true })).toBe(true);
    expect(store.get()).toMatchObject({ officeTheme: 'cyberpunk', rain: true });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('migrasi saat storage hanya bisa dibaca: tetap menghasilkan nilai hasil migrasi di memori', () => {
    const s = { getItem: (k) => (k === LEGACY_RAIN_KEY ? '1' : null), setItem() { throw new Error('penuh'); } };
    expect(loadSettings(s)).toEqual({ settings: { ...DEFAULT_SETTINGS, rain: true }, source: 'migrated' });
  });
});

describe('migrasi kunci lama', () => {
  it('hujan lama "1" dimigrasi ke kunci baru dan ditulis; kunci lama tidak dihapus', () => {
    const s = memStorage({ [LEGACY_RAIN_KEY]: '1' });
    const r = loadSettings(s);
    expect(r).toEqual({ settings: { ...DEFAULT_SETTINGS, rain: true }, source: 'migrated' });
    expect(JSON.parse(s.dump()[SETTINGS_KEY]).rain).toBe(true);
    expect(s.dump()[LEGACY_RAIN_KEY]).toBe('1');
  });

  it('hujan lama "0" atau nilai aneh → hujan mati', () => {
    for (const v of ['0', 'ya', 'true', '']) {
      expect(loadSettings(memStorage({ [LEGACY_RAIN_KEY]: v })).settings.rain, v).toBe(false);
    }
  });

  it('kunci baru menang atas kunci lama', () => {
    const s = memStorage({ [LEGACY_RAIN_KEY]: '1', [SETTINGS_KEY]: stored({ rain: false }) });
    expect(loadSettings(s)).toEqual({ settings: DEFAULT_SETTINGS, source: 'stored' });
  });

  it('kunci baru rusak + hujan lama menyala: hujan lama tetap dihormati (tanpa menimpa)', () => {
    const s = memStorage({ [LEGACY_RAIN_KEY]: '1', [SETTINGS_KEY]: '{' });
    expect(loadSettings(s).settings.rain).toBe(true);
    expect(s.dump()[SETTINGS_KEY]).toBe('{');
  });

  it('bahasa dan tema UI tetap di kunci lamanya (tidak disentuh pengaturan baru)', () => {
    const s = memStorage({ [LANG_STORAGE_KEY]: 'id', [THEME_KEY]: 'light' });
    const store = createSettingsStore(s);
    store.set({ officeTheme: 'kafe', timeMode: 'day', motion: 'full', rain: true });
    expect(s.dump()[LANG_STORAGE_KEY]).toBe('id');
    expect(s.dump()[THEME_KEY]).toBe('light');
    expect(Object.keys(s.dump()).sort()).toEqual([LANG_STORAGE_KEY, SETTINGS_KEY, THEME_KEY].sort());
    expect(JSON.parse(s.dump()[SETTINGS_KEY])).not.toHaveProperty('lang');
  });
});

describe('store', () => {
  it('set menyimpan, memberi tahu, dan mengabaikan perubahan kosong', () => {
    const s = memStorage();
    const store = createSettingsStore(s);
    const fn = vi.fn();
    const off = store.subscribe(fn);
    expect(store.set({ motion: 'reduce' })).toBe(true);
    expect(JSON.parse(s.dump()[SETTINGS_KEY]).motion).toBe('reduce');
    expect(store.set({ motion: 'reduce' })).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    store.set({ motion: 'full' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('nilai tidak sah dibersihkan sebelum disimpan', () => {
    const store = createSettingsStore(memStorage());
    store.set({ motion: 'zzz', officeTheme: '../../x', rain: 'ya' });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('reset mengembalikan bawaan', () => {
    const s = memStorage();
    const store = createSettingsStore(s);
    store.set({ officeTheme: 'kafe', rain: true });
    store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(s.dump()[SETTINGS_KEY])).toEqual(DEFAULT_SETTINGS);
  });

  it('pendengar yang melempar tidak menghentikan pendengar lain', () => {
    const store = createSettingsStore(memStorage());
    const ok = vi.fn();
    store.subscribe(() => { throw new Error('rusak'); });
    store.subscribe(ok);
    store.set({ rain: true });
    expect(ok).toHaveBeenCalled();
  });

  it('memuat nilai tersimpan saat dibuat', () => {
    const store = createSettingsStore(memStorage({ [SETTINGS_KEY]: stored({ officeTheme: 'cyberpunk' }) }));
    expect(store.get().officeTheme).toBe('cyberpunk');
  });
});

describe('mode waktu diterapkan', () => {
  it('ikuti tema terang/gelap UI (bawaan): terang → siang, gelap → malam', () => {
    expect(resolveVariant('follow', { uiTheme: 'light' })).toBe('day');
    expect(resolveVariant('follow', { uiTheme: 'dark' })).toBe('night');
  });

  it('selalu siang / selalu malam mengabaikan tema UI', () => {
    for (const ui of ['light', 'dark']) {
      expect(resolveVariant('day', { uiTheme: ui })).toBe('day');
      expect(resolveVariant('night', { uiTheme: ui })).toBe('night');
    }
  });

  it('mode tak dikenal jatuh ke "ikuti tema UI"', () => {
    expect(resolveVariant('auto', { uiTheme: 'light' })).toBe('day');
    expect(resolveVariant(undefined, { uiTheme: 'dark' })).toBe('night');
  });

  it('setiap mode terdaftar punya penentu; diperluas dengan menambah penentu berbasis jam (Fase 4) tanpa mengubah model', () => {
    expect([...TIME_MODES]).toEqual(Object.keys(TIME_RESOLVERS));
    const resolvers = { ...TIME_RESOLVERS, auto: ({ now }) => (new Date(now).getHours() >= 18 ? 'night' : 'day') };
    expect(resolvers.auto({ now: new Date(2026, 0, 1, 20).getTime() })).toBe('night');
    expect(resolvers.auto({ now: new Date(2026, 0, 1, 9).getTime() })).toBe('day');
  });

  it('jam disuntik ke penentu (parameter now), tidak dibaca dari global', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      resolveVariant('day', { uiTheme: 'dark', now: 123 });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('perubahan mode waktu di store mengubah varian yang dihitung', () => {
    const store = createSettingsStore(memStorage());
    expect(resolveVariant(store.get().timeMode, { uiTheme: 'dark' })).toBe('night');
    store.set({ timeMode: 'day' });
    expect(resolveVariant(store.get().timeMode, { uiTheme: 'dark' })).toBe('day');
  });
});

describe('gerak diterapkan', () => {
  it('ikuti sistem (bawaan): nilai prefers-reduced-motion', () => {
    expect(resolveReducedMotion('system', true)).toBe(true);
    expect(resolveReducedMotion('system', false)).toBe(false);
    expect(resolveReducedMotion('system', undefined)).toBe(false);
  });

  it('kurangi gerak memaksa true; gerak penuh memaksa false, apa pun kata sistem', () => {
    for (const sys of [true, false]) {
      expect(resolveReducedMotion('reduce', sys)).toBe(true);
      expect(resolveReducedMotion('full', sys)).toBe(false);
    }
  });

  it('nilai tak dikenal diperlakukan sebagai ikuti sistem', () => {
    expect(resolveReducedMotion('apa', true)).toBe(true);
    expect(MOTION_MODES).toEqual(['system', 'reduce', 'full']);
  });

  it('atribut data-motion di elemen akar: reduce/full dipasang, system menghapus', () => {
    const attrs = new Map();
    const root = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
    expect(applyMotionAttr(root, 'reduce')).toBe(true);
    expect(attrs.get('data-motion')).toBe('reduce');
    applyMotionAttr(root, 'full');
    expect(attrs.get('data-motion')).toBe('full');
    applyMotionAttr(root, 'system');
    expect(attrs.has('data-motion')).toBe(false);
    expect(applyMotionAttr(null, 'reduce')).toBe(false);
  });
});

describe('versi lebih baru di storage tidak ditimpa', () => {
  const newer = JSON.stringify({ v: SETTINGS_VERSION + 1, officeTheme: 'kafe', masaDepan: true });

  it('set dan reset hanya mengubah memori; teks tersimpan utuh', () => {
    const s = memStorage({ [SETTINGS_KEY]: newer });
    const store = createSettingsStore(s);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    const fn = vi.fn();
    store.subscribe(fn);
    expect(store.set({ rain: true })).toBe(true);
    expect(store.get().rain).toBe(true);
    expect(fn).toHaveBeenCalled();
    store.reset();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(s.dump()[SETTINGS_KEY]).toBe(newer);
  });

  it('hasNewerVersion hanya benar untuk v angka lebih besar', () => {
    expect(hasNewerVersion(newer)).toBe(true);
    for (const x of [stored({}), '{', null, '[]', '{"v":"9"}', '{"v":0}', undefined]) expect(hasNewerVersion(x)).toBe(false);
  });

  it('versi sama atau JSON rusak tetap boleh ditimpa saat pengguna mengubah pengaturan', () => {
    for (const text of [stored({}), '{rusak']) {
      const s = memStorage({ [SETTINGS_KEY]: text });
      createSettingsStore(s).set({ rain: true });
      expect(JSON.parse(s.dump()[SETTINGS_KEY]).rain).toBe(true);
    }
  });
});
