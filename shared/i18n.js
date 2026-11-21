// i18n untuk Node (CLI, skrip, server): membaca locales/<lang>.json, namespace "cli".
//
//   t('runner.busy')                       → teks sesuai bahasa terdeteksi
//   t('setup.step', { n: 2, name: 'npm' }) → "{n}" dan "{name}" diganti
//   t('runner.busy', {}, 'en')             → paksa bahasa
//
// Bahasa: env AI_OFFICE_LANG, lalu LC_ALL / LC_MESSAGES / LANG, lalu Intl. Nilai pertama yang terisi (dan
// bukan "C"/"POSIX") menentukan: kode "id", "in", atau "ind" = Indonesia; selain itu Inggris.
// Kunci yang tidak ada di bahasa terpilih jatuh ke Inggris, lalu ke nama kuncinya sendiri.
// Dibaca ulang dari env setiap pemanggilan (murah), supaya test bisa mengganti AI_OFFICE_LANG.
import { readFileSync } from 'node:fs';

export const LANGS = ['en', 'id'];
export const DEFAULT_LANG = 'en';

/** "id_ID.UTF-8" / "id-ID" / "in" → 'id'; yang lain (termasuk kosong atau tidak dikenal) → 'en'. */
export function langFromLocale(value) {
  const m = /^([a-z]{2,3})(?:[-_.@]|$)/i.exec(String(value ?? '').trim());
  const code = m ? m[1].toLowerCase() : '';
  return code === 'id' || code === 'in' || code === 'ind' ? 'id' : 'en';
}

function intlLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return '';
  }
}

/** Bahasa pengguna: 'en' atau 'id'. `intl` bisa disuntikkan untuk uji. */
export function detectLang(env = process.env, intl = intlLocale) {
  for (const k of ['AI_OFFICE_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const v = typeof env[k] === 'string' ? env[k].trim() : '';
    if (!v || v === 'C' || v === 'POSIX') continue;
    return langFromLocale(v);
  }
  try {
    return langFromLocale(intl());
  } catch {
    return DEFAULT_LANG;
  }
}

const cache = new Map();

function catalog(lang) {
  if (cache.has(lang)) return cache.get(lang);
  let cli = {};
  try {
    cli = JSON.parse(readFileSync(new URL(`../locales/${lang}.json`, import.meta.url), 'utf8')).cli ?? {};
  } catch {
    // file hilang atau rusak: pakai kunci apa adanya
  }
  cache.set(lang, cli);
  return cli;
}

function lookup(cli, key) {
  // Kunci datar bertitik ("runner.err.busy" sebagai satu kunci, seperti namespace "ui"), lalu objek bersarang.
  if (Object.hasOwn(cli, key)) return typeof cli[key] === 'string' ? cli[key] : undefined;
  let cur = cli;
  for (const part of String(key).split('.')) {
    if (cur === null || typeof cur !== 'object' || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return typeof cur === 'string' ? cur : undefined;
}

/** Hapus cache katalog (untuk uji yang menulis ulang locales). */
export function resetI18nCache() {
  cache.clear();
}

/** Terjemahkan kunci di namespace "cli". `lang` opsional; default dari detectLang(). */
export function t(key, vars = {}, lang = detectLang()) {
  const l = LANGS.includes(lang) ? lang : DEFAULT_LANG;
  const text = lookup(catalog(l), key) ?? lookup(catalog(DEFAULT_LANG), key) ?? String(key);
  return text.replace(/\{(\w+)\}/g, (m, name) => (Object.hasOwn(vars, name) ? String(vars[name]) : m));
}

/** Pengikat bahasa: const tr = translator('en'); tr('runner.busy'). */
export function translator(lang) {
  return (key, vars) => t(key, vars, lang);
}
