// Tema gelap/terang: pemilihan, penyimpanan, dan penerapan. Fungsi murni (storage dan root
// disuntik) supaya bisa dites di Node. Logika yang sama dipakai public/theme-init.js (skrip
// klasik kecil yang jalan sebelum render pertama, supaya tidak ada kilatan tema yang salah);
// tests/theme.test.js memastikan keduanya selalu sepakat.

export const THEME_KEY = 'ai-office-theme';
export const THEMES = ['dark', 'light'];
export const DEFAULT_THEME = 'dark';

export const isTheme = (v) => THEMES.includes(v);
export const otherTheme = (t) => (t === 'dark' ? 'light' : 'dark');

/** Pilihan tersimpan, atau null (storage kosong, nilai rusak, atau storage tidak bisa diakses). */
export function readStoredTheme(storage) {
  try {
    const v = storage?.getItem(THEME_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null;
  }
}

/** Simpan pilihan. Mengembalikan false kalau storage menolak (mode privat, kuota). */
export function storeTheme(storage, theme) {
  if (!isTheme(theme)) return false;
  try {
    storage.setItem(THEME_KEY, theme);
    return true;
  } catch {
    return false;
  }
}

/** Pilihan tersimpan menang; kalau tidak ada, ikuti prefers-color-scheme (tidak diketahui → gelap). */
export function resolveTheme(stored, prefersDark = true) {
  if (isTheme(stored)) return stored;
  return prefersDark === false ? 'light' : DEFAULT_THEME;
}

/** Baca preferensi sistem dari `win.matchMedia`; true bila gelap atau tidak bisa diketahui. */
export function systemPrefersDark(win = globalThis.window) {
  try {
    const mq = win?.matchMedia?.('(prefers-color-scheme: dark)');
    return mq ? mq.matches : true;
  } catch {
    return true;
  }
}

/** Tema awal dari storage + preferensi sistem. */
export function initialTheme(win = globalThis.window) {
  let storage = null;
  try {
    storage = win?.localStorage ?? null;
  } catch {
    storage = null;
  }
  return resolveTheme(readStoredTheme(storage), systemPrefersDark(win));
}

/** Pasang tema di elemen akar (atribut data-theme; semua warna lewat CSS custom properties). */
export function applyTheme(root, theme) {
  if (!root || !isTheme(theme)) return false;
  root.setAttribute('data-theme', theme);
  return true;
}

/** Tema yang sedang terpasang di elemen akar (dipasang public/theme-init.js), atau null. */
export function appliedTheme(root) {
  const v = root?.getAttribute?.('data-theme');
  return isTheme(v) ? v : null;
}
