// Palet kanvas per tema kantor. Sumbernya data: themes/<id>/theme.json (divalidasi shared/themes.js).
// Tema bawaan "jakarta" = tampilan asli: day = kantor siang (terang), night = kantor malam (gelap).
// Hanya warna lingkungan (lantai, dinding, meja, bubble, label); warna divisi, status, dan karakter tetap sama di semua
// tema supaya maknanya konsisten. CONTRAST_PAIRS dipakai tests/themesBuiltin.test.js: semua teks di kanvas harus lolos WCAG AA (4,5:1).
import { resolvePalette } from '../../shared/themes.js';
import { registry } from './themeRegistry.js';

const cache = new WeakMap(); // objek tema → { day, night }

/** Palet siap pakai untuk tema (objek hasil validasi) dan varian 'day' | 'night'. Hasilnya di-cache. */
export function paletteForTheme(theme, variant) {
  const v = variant === 'day' ? 'day' : 'night';
  let entry = cache.get(theme);
  if (!entry) {
    entry = {};
    cache.set(theme, entry);
  }
  if (!entry[v]) {
    const base = theme === registry.defaultTheme ? null : paletteForTheme(registry.defaultTheme, v);
    entry[v] = Object.freeze(resolvePalette(theme, v, base));
  }
  return entry[v];
}

/** Palet Jakarta lama: terang = siang, gelap = malam. Dipertahankan untuk kode dan test yang memakai nama tema UI. */
export const PALETTES = {
  light: paletteForTheme(registry.defaultTheme, 'day'),
  dark: paletteForTheme(registry.defaultTheme, 'night'),
};

export const paletteFor = (theme) => PALETTES[theme] ?? PALETTES.dark;

/** Tema UI (light/dark) → varian waktu kantor. */
export const variantOfUiTheme = (ui) => (ui === 'light' ? 'day' : 'night');

/** [teks, latar, keterangan]: pasangan warna teks di kanvas yang wajib minimal 4,5:1. */
export const CONTRAST_PAIRS = [
  ['ink', 'floor', 'nama agen di lantai'],
  ['inkSoft', 'floor', 'label status di lantai'],
  ['onRug', 'rugB', 'label manajer di karpet'],
  ['onRug', 'rugA', 'label manajer di karpet (tepi)'],
  ['onDoor', 'doorPanel', 'label di pintu masuk'],
  ['onTray', 'trayIn', 'jumlah surat di baki'],
  ['bubbleInk', 'bubblePaper', 'teks bubble'],
  ['bubbleTag', 'bubblePaper', 'nama proyek di bubble'],
  ['bubbleWarnInk', 'bubbleWarn', 'teks bubble peringatan'],
  ['posterInk', 'posterPaper', 'teks poster di dinding'],
  ['signInk', 'signPaper', 'plakat Pantry dan ruang rapat'],
];
