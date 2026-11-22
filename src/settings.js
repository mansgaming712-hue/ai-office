// Pengaturan dashboard: tema kantor, mode waktu, gerak, hujan. Satu kunci localStorage (`ai-office-settings`) berisi
// JSON berversi yang divalidasi; semua akses storage memakai try/catch (mode privat, kuota penuh, JSON rusak → bawaan).
// Fungsi murni (storage, root, dan jam disuntik) supaya bisa dites di Node.
//
// Bahasa UI dan tema terang/gelap UI TETAP memakai kunci lamanya (`ai-office-lang` di src/i18n.js, `ai-office-theme`
// di src/theme.js + public/theme-init.js): keduanya dibaca sebelum render pertama dan sudah punya mekanisme sendiri.
// Kunci lama hujan (`ai-office-rain`) dimigrasi ke sini saat pertama kali dimuat.
import { DEFAULT_THEME_ID } from './office/themeRegistry.js';
import { variantOfUiTheme } from './office/palette.js';

export const SETTINGS_KEY = 'ai-office-settings';
export const SETTINGS_VERSION = 1;
export const LEGACY_RAIN_KEY = 'ai-office-rain';

/**
 * Mode waktu: cara memilih varian kantor 'day' | 'night'. Tiap mode = fungsi penentu di TIME_RESOLVERS.
 * Fase 4 cukup menambah nama di TIME_MODES dan fungsinya di TIME_RESOLVERS (mis. 'auto' memakai `now`).
 */
export const TIME_MODES = Object.freeze(['follow', 'day', 'night']);
export const TIME_RESOLVERS = Object.freeze({
  follow: ({ uiTheme }) => variantOfUiTheme(uiTheme), // ikuti tema terang/gelap UI (bawaan)
  day: () => 'day',
  night: () => 'night',
});
export const MOTION_MODES = Object.freeze(['system', 'reduce', 'full']);

export const DEFAULT_SETTINGS = Object.freeze({
  v: SETTINGS_VERSION,
  officeTheme: DEFAULT_THEME_ID,
  timeMode: 'follow',
  motion: 'system',
  rain: false,
});

const THEME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_RAW = 4096; // JSON tersimpan lebih besar dari ini dianggap rusak

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Bentuk pengaturan yang sah dari nilai apa pun: kolom yang rusak jatuh ke bawaan, kolom tak dikenal dibuang. */
export function sanitizeSettings(raw, { timeModes = TIME_MODES } = {}) {
  const out = { ...DEFAULT_SETTINGS };
  if (!isPlain(raw)) return out;
  if (typeof raw.officeTheme === 'string' && THEME_ID.test(raw.officeTheme)) out.officeTheme = raw.officeTheme;
  if (typeof raw.timeMode === 'string' && timeModes.includes(raw.timeMode)) out.timeMode = raw.timeMode;
  if (typeof raw.motion === 'string' && MOTION_MODES.includes(raw.motion)) out.motion = raw.motion;
  if (typeof raw.rain === 'boolean') out.rain = raw.rain;
  return out;
}

/** Teks JSON dari storage → pengaturan, atau null bila tidak ada/rusak/versi tidak dikenal. */
export function parseSettings(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_RAW) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isPlain(data) || data.v !== SETTINGS_VERSION) return null;
  return sanitizeSettings(data);
}

export const serializeSettings = (s) => JSON.stringify({ ...sanitizeSettings(s), v: SETTINGS_VERSION });

function safeGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** true bila teks tersimpan adalah JSON dengan versi angka lebih besar dari SETTINGS_VERSION. */
export function hasNewerVersion(text) {
  if (typeof text !== 'string' || text.length > MAX_RAW) return false;
  try {
    const d = JSON.parse(text);
    return isPlain(d) && typeof d.v === 'number' && d.v > SETTINGS_VERSION;
  } catch {
    return false;
  }
}

/** Simpan; false bila storage menolak (mode privat, kuota penuh). */
export function saveSettings(storage, settings) {
  try {
    if (!storage) return false;
    storage.setItem(SETTINGS_KEY, serializeSettings(settings));
    return true;
  } catch {
    return false;
  }
}

/**
 * Muat pengaturan. Tanpa kunci baru, pilihan hujan lama (`ai-office-rain`) dimigrasi dan langsung ditulis ke kunci baru.
 * @returns {{settings: object, source: 'stored'|'migrated'|'default'|'corrupt'}}
 */
export function loadSettings(storage) {
  const text = safeGet(storage, SETTINGS_KEY);
  if (text !== null) {
    const parsed = parseSettings(text);
    if (parsed) return { settings: parsed, source: 'stored' };
  }
  const legacyRain = safeGet(storage, LEGACY_RAIN_KEY);
  const settings = { ...DEFAULT_SETTINGS, rain: legacyRain === '1' };
  if (text === null && legacyRain !== null) {
    saveSettings(storage, settings);
    return { settings, source: 'migrated' };
  }
  return { settings, source: text === null ? 'default' : 'corrupt' };
}

/** Penyimpanan peramban, atau null bila diblokir. */
export function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Store kecil (kompatibel useSyncExternalStore). `storage` disuntik; pembaruan langsung berlaku di memori
 * walau penyimpanan gagal.
 */
export function createSettingsStore(storage = browserStorage()) {
  let state = loadSettings(storage).settings;
  // Versi lebih baru dari yang didukung (mis. setelah downgrade): jangan ditimpa; perubahan hanya di memori.
  const keepStored = hasNewerVersion(safeGet(storage, SETTINGS_KEY));
  const persist = () => (keepStored ? false : saveSettings(storage, state));
  const listeners = new Set();
  const emit = () => {
    for (const fn of [...listeners]) {
      try {
        fn();
      } catch {
        // pendengar yang rusak tidak boleh menghentikan yang lain
      }
    }
  };
  return {
    get: () => state,
    set(patch) {
      const next = sanitizeSettings({ ...state, ...patch });
      if (JSON.stringify(next) === JSON.stringify(state)) return false;
      state = Object.freeze(next);
      persist();
      emit();
      return true;
    },
    reset() {
      state = Object.freeze({ ...DEFAULT_SETTINGS });
      persist();
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// ------------------------------------------------------------------ penerapan

/** Varian kantor 'day' | 'night' menurut mode waktu. `now` (ms) disuntik untuk mode berbasis jam (Fase 4). */
export function resolveVariant(timeMode, { uiTheme = 'dark', now = Date.now() } = {}) {
  const fn = TIME_RESOLVERS[timeMode] ?? TIME_RESOLVERS.follow;
  const v = fn({ uiTheme, now });
  return v === 'day' ? 'day' : 'night';
}

/** Gerak dikurangi? 'system' mengikuti prefers-reduced-motion; 'reduce'/'full' memaksa. */
export function resolveReducedMotion(motion, systemReduced) {
  if (motion === 'reduce') return true;
  if (motion === 'full') return false;
  return Boolean(systemReduced);
}

/** Tandai pilihan gerak di elemen akar (CSS): 'reduce' | 'full'; 'system' menghapus atribut. */
export function applyMotionAttr(root, motion) {
  if (!root?.setAttribute) return false;
  if (motion === 'reduce' || motion === 'full') root.setAttribute('data-motion', motion);
  else root.removeAttribute?.('data-motion');
  return true;
}

export const settingsStore = createSettingsStore();
