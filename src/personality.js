// Kepribadian worker di browser (HANYA tampilan): bawaan (shared/personalities.js) + divisi plugin
// (division.json `personalities`, sudah divalidasi ulang di src/divisions.js). Tanpa data = default netral.
// Semua teks dirender sebagai teks (fillText/React), tidak pernah sebagai HTML.
import { DEFAULT_PERSONALITIES, NEUTRAL_PERSONALITY, localized, resolvePersonality } from '../shared/personalities.js';
import { getState } from './divisions.js';
import { getLang, hasKey, t } from './i18n.js';

/** Jumlah frasa cadangan per tone (kunci office.tone.<tone>.1..N di locales). */
export const TONE_LINES = 3;

let cacheVersion = -1;
let cache = new Map();

/** Kepribadian lengkap (sudah dilengkapi default netral) untuk id worker/manager/ceo. Di-cache per versi roster. */
export function personalityOf(id) {
  const version = getState().version;
  if (version !== cacheVersion) {
    cacheVersion = version;
    cache = new Map();
  }
  const key = String(id);
  let p = cache.get(key);
  if (!p) {
    let raw = Object.hasOwn(DEFAULT_PERSONALITIES, key) ? DEFAULT_PERSONALITIES[key] : null;
    if (!raw) {
      for (const d of getState().plugin) {
        if (d.personalities && Object.hasOwn(d.personalities, key)) {
          raw = d.personalities[key];
          break;
        }
      }
    }
    p = raw ? resolvePersonality(raw) : NEUTRAL_PERSONALITY;
    cache.set(key, p);
  }
  return p;
}

/** Nama panggilan untuk bahasa aktif, atau '' bila tidak ada. */
export const nicknameOf = (p, lang = getLang()) => localized(p.nickname, lang);

/** Daftar frasa bubble (string) untuk `lang`: frasa sendiri, atau cadangan sesuai tone; kosong untuk kepribadian netral. */
export function speechLines(p, lang = getLang()) {
  const own = p.speech.phrases.map((x) => localized(x, lang)).filter(Boolean);
  if (own.length) return own;
  const tone = p.speech.tone;
  if (!tone) return [];
  const lines = [];
  for (let n = 1; n <= TONE_LINES; n++) {
    const key = `office.tone.${tone}.${n}`;
    if (hasKey(key, lang)) lines.push(t(key, undefined, lang));
  }
  return lines;
}
