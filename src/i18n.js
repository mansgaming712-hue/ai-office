// Terjemahan antarmuka (Inggris dan Indonesia). Tanpa dependensi, tanpa DOM wajib: aman dimuat di Node (test).
//
// File terjemahan bersama: locales/en.json dan locales/id.json (namespace `cli` milik server,
// `ui` dan `office` milik browser). Kunci ditulis "namespace.kunci" dan boleh bertitik di dalam
// namespace (mis. "ui.btn.simulate"). Fallback: bahasa aktif, lalu Inggris, lalu kunci itu sendiri.
import { useSyncExternalStore } from 'react';
// Import bernama supaya bundel browser hanya memuat namespace ui dan office (namespace cli milik server).
import { office as enOffice, ui as enUi } from '../locales/en.json';
import { office as idOffice, ui as idUi } from '../locales/id.json';

export const LANGS = ['en', 'id'];
export const LANG_STORAGE_KEY = 'ai-office-lang';
const DEFAULT_LANG = 'en';
const DICTS = { en: { ui: enUi, office: enOffice }, id: { ui: idUi, office: idOffice } };

const has = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);

/** 'en' | 'id' kalau persis salah satunya (nilai tersimpan), selain itu null. */
export function validLang(value) {
  return typeof value === 'string' && LANGS.includes(value) ? value : null;
}

/**
 * Bahasa dari daftar preferensi browser (navigator.languages / navigator.language).
 * Entri pertama yang berupa teks menentukan: awalan "id" atau "in" (kode lama) → Indonesia;
 * selain itu, kosong, atau tidak dikenal → Inggris.
 */
export function detectLang(languages) {
  const list = Array.isArray(languages) ? languages : languages == null ? [] : [languages];
  const first = list.find((l) => typeof l === 'string' && l.trim());
  if (!first) return DEFAULT_LANG;
  const primary = first.trim().toLowerCase().split(/[-_]/)[0];
  return primary === 'id' || primary === 'in' ? 'id' : DEFAULT_LANG;
}

function browserStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

function browserLanguages() {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** Pilihan manual yang tersimpan (menang atas deteksi), atau null. Tidak pernah melempar. */
export function readStoredLang(storage = browserStorage()) {
  try {
    return validLang(storage?.getItem(LANG_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** Bahasa awal: pilihan tersimpan > deteksi browser. Di luar browser (Node/test): env AI_OFFICE_LANG, lalu Indonesia. */
export function resolveInitialLang({ storage = browserStorage(), languages = browserLanguages(), browser = typeof window !== 'undefined' } = {}) {
  const stored = readStoredLang(storage);
  if (stored) return stored;
  if (!browser) {
    const fromEnv = typeof process !== 'undefined' ? validLang(process.env?.AI_OFFICE_LANG) : null;
    return fromEnv ?? 'id';
  }
  return detectLang(languages);
}

function applyDocumentLang(lang) {
  if (typeof document !== 'undefined' && document.documentElement) document.documentElement.lang = lang;
}

let current = resolveInitialLang();
applyDocumentLang(current);
const listeners = new Set();

export const getLang = () => current;

/** Ganti bahasa. Pilihan disimpan (kecuali persist: false), <html lang> diperbarui, pendengar diberi tahu. */
export function setLang(lang, { persist = true } = {}) {
  const next = validLang(lang);
  if (!next) return false;
  if (persist) {
    try {
      browserStorage()?.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // penyimpanan diblokir: pilihan tetap berlaku selama halaman terbuka
    }
  }
  applyDocumentLang(next);
  if (next === current) return true;
  current = next;
  for (const fn of [...listeners]) {
    try {
      fn(next);
    } catch {
      // pendengar yang rusak tidak boleh menghentikan yang lain
    }
  }
  return true;
}

/** Daftarkan pendengar perubahan bahasa. Mengembalikan fungsi untuk berhenti. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function lookup(lang, key) {
  const dot = key.indexOf('.');
  if (dot < 1) return undefined;
  const ns = DICTS[lang]?.[key.slice(0, dot)];
  const rest = key.slice(dot + 1);
  if (has(ns, rest) && typeof ns[rest] === 'string') return ns[rest];
  let node = ns; // cadangan: kunci bersarang
  for (const part of rest.split('.')) node = has(node, part) ? node[part] : undefined;
  return typeof node === 'string' ? node : undefined;
}

/** Ada terjemahan (di bahasa aktif atau Inggris) untuk kunci ini? */
export const hasKey = (key, lang = current) => typeof key === 'string' && (lookup(lang, key) ?? lookup(DEFAULT_LANG, key)) !== undefined;

/**
 * Terjemahan kunci "namespace.kunci" dengan interpolasi {nama}. Variabel yang tidak diberikan
 * dibiarkan apa adanya. Fallback: Inggris, lalu kunci itu sendiri.
 */
export function t(key, vars, lang = current) {
  const text = lookup(lang, String(key)) ?? lookup(DEFAULT_LANG, String(key)) ?? String(key);
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, name) => (has(vars, name) && vars[name] != null ? String(vars[name]) : m));
}

/** Nama divisi untuk tampilan: terjemahan `office.zone.<id>`, cadangan nama bawaan dari roster. */
export function divisionName(division) {
  const n = division.names; // divisi plugin: nama dua bahasa dari server (teks biasa)
  if (n && typeof n === 'object') return n[current] || n[DEFAULT_LANG] || division.name;
  const key = `office.zone.${division.id}`;
  return hasKey(key) ? t(key) : division.name;
}

/** Hook React: komponen dirender ulang saat bahasa berganti. Mengembalikan kode bahasa aktif. */
export function useLang() {
  return useSyncExternalStore(onLangChange, getLang, getLang);
}

/** Locale untuk Intl (angka dan waktu). */
export const intlLocale = (lang = current) => (lang === 'id' ? 'id-ID' : 'en-US');

/** Daftar kunci (tanpa namespace cli) per bahasa: dipakai test kelengkapan. */
export const dictionaries = DICTS;
