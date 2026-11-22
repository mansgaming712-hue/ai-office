// Kepribadian worker: data TAMPILAN saja (nama panggilan, kebiasaan idle, quirk, frasa bubble).
// Tidak pernah dimasukkan ke prompt agen, template, runner, atau hook (dijaga oleh tests/personalityNoLeak.test.js).
// Murni: tanpa I/O dan tanpa import Node, supaya bisa dipakai di server, skrip, dan browser.
//
// Bentuk (semua field opsional, field tak dikenal ditolak):
//   { nickname: "Sari" | { en, id },                 // <= 16 karakter
//     traits: ["teliti" | { en, id }],               // 0-3 item, masing-masing <= 20 karakter
//     speech: { tone: "formal"|"casual"|"cheerful"|"calm"|"dry",
//               phrases: ["..." | { en, id }] },     // 0-6 item, masing-masing <= 40 karakter
//     idle: "coffee"|"stretch"|"phone"|"water"|"snack"|"plant"|"window"|"chat",
//     quirk: "hum"|"pen-spin"|"desk-tap"|"yawn"|"glasses"|"headphones"|"plant-talk"|"doodle" }
//
// validatePersonality(obj) → { ok, value, errors }. Setiap error = { key, params } (kunci namespace "cli" di
// locales/*.json). `value` = salinan bersih: teks selalu { en, id }, panjang dihitung per code point.
import { CEO_ID, MANAGER_ID } from './roster.js';

export const PERSONALITY_LIMITS = Object.freeze({
  nicknameMax: 16,
  traitsMax: 3,
  traitMax: 20,
  phrasesMax: 6,
  phraseMax: 40,
});

export const TONES = Object.freeze(['formal', 'casual', 'cheerful', 'calm', 'dry']);
/** Kebiasaan idle. Setiap nilai WAJIB punya animasi di src/office/quirks.js (IDLE_BEHAVIORS), dijaga oleh test. */
export const IDLE_KINDS = Object.freeze(['coffee', 'stretch', 'phone', 'water', 'snack', 'plant', 'window', 'chat']);
/** Quirk. Setiap nilai WAJIB punya animasi di src/office/quirks.js (QUIRKS), dijaga oleh test. */
export const QUIRKS = Object.freeze(['hum', 'pen-spin', 'desk-tap', 'yawn', 'glasses', 'headphones', 'plant-talk', 'doodle']);
export const PERSONALITY_FIELDS = Object.freeze(['nickname', 'traits', 'speech', 'idle', 'quirk']);
export const SPEECH_FIELDS = Object.freeze(['tone', 'phrases']);

// Karakter kontrol (Cc), format/bidi/zero-width (Cf), surrogate tunggal (Cs), pakai-pribadi (Co), belum-ditetapkan (Cn),
// pemisah baris/paragraf, penanda bidi eksplisit, filler Hangul, braille kosong, dan tumpukan 3+ combining mark.
const BAD_CHARS_RE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u3164\u115f\u1160\uffa0\u2800]|\p{M}{3,}/u;

const err = (key, params = {}) => ({ key, params });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const charLength = (s) => [...s].length;
const clip = (s, n = 40) => {
  const chars = [...String(s ?? '').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '')];
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : chars.join('');
};

/** Teks dua bahasa → { value: { en, id } } atau { error }. String dipakai untuk kedua bahasa. */
// Nama panggilan yang meniru peran atau manajer/CEO bawaan (hanya untuk kepribadian plugin; default bawaan dikecualikan).
const RESERVED_NICKNAMES = new Set([
  'ceo', 'manager', 'manajer', 'boss', 'bos', 'admin', 'system', 'sistem',
  'ratna', 'bu ratna', 'ms. ratna', 'anton', 'pak anton', 'mr. anton',
]);
const isReservedNickname = (text) => RESERVED_NICKNAMES.has(text.replace(/\s+/g, ' ').trim().toLowerCase());

function checkText(field, raw, max, { reserved = false } = {}) {
  let en;
  let id;
  if (typeof raw === 'string') {
    en = raw;
    id = raw;
  } else if (isPlainObject(raw)) {
    for (const k of Object.keys(raw)) if (k !== 'en' && k !== 'id') return { error: err('divisions.err.personalityTextKey', { field, key: clip(k) }) };
    const hasEn = Object.hasOwn(raw, 'en');
    const hasId = Object.hasOwn(raw, 'id');
    if ((!hasEn && !hasId) || (hasEn && typeof raw.en !== 'string') || (hasId && typeof raw.id !== 'string')) {
      return { error: err('divisions.err.personalityTextType', { field }) };
    }
    en = hasEn ? raw.en : raw.id;
    id = hasId ? raw.id : raw.en;
  } else {
    return { error: err('divisions.err.personalityTextType', { field }) };
  }
  const out = {};
  for (const [lang, text] of [['en', en], ['id', id]]) {
    if (BAD_CHARS_RE.test(text)) return { error: err('divisions.err.personalityTextChars', { field }) };
    const v = text.trim();
    if (!v || charLength(v) > max) return { error: err('divisions.err.personalityTextLength', { field, max }) };
    if (reserved && isReservedNickname(v)) return { error: err('divisions.err.personalityNickReserved', { field }) };
    out[lang] = v;
  }
  return { value: out };
}

function checkList(field, raw, maxCount, maxChars, errors) {
  if (!Array.isArray(raw)) {
    errors.push(err('divisions.err.personalityList', { field }));
    return null;
  }
  if (raw.length > maxCount) {
    errors.push(err('divisions.err.personalityCount', { field, max: maxCount }));
    return null;
  }
  const list = [];
  let bad = false;
  raw.forEach((item, i) => {
    const r = checkText(`${field}[${i}]`, item, maxChars);
    if (r.error) {
      errors.push(r.error);
      bad = true;
    } else list.push(r.value);
  });
  return bad ? null : list;
}

/**
 * Validasi satu kepribadian (sudah di-JSON.parse). Tidak pernah melempar. `builtin: true` (hanya untuk data bawaan)
 * melonggarkan larangan nama panggilan yang meniru peran/manajer/CEO; kepribadian plugin selalu ketat.
 */
export function validatePersonality(obj, { builtin = false } = {}) {
  const L = PERSONALITY_LIMITS;
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, value: null, errors: [err('divisions.err.personalityNotObject')] };
  const has = (o, k) => Object.hasOwn(o, k);
  const value = {};

  for (const k of Object.keys(obj)) {
    if (!PERSONALITY_FIELDS.includes(k)) errors.push(err('divisions.err.personalityUnknownField', { field: clip(k) }));
  }

  if (has(obj, 'nickname')) {
    const r = checkText('nickname', obj.nickname, L.nicknameMax, { reserved: !builtin });
    if (r.error) errors.push(r.error);
    else value.nickname = r.value;
  }

  if (has(obj, 'traits')) {
    const list = checkList('traits', obj.traits, L.traitsMax, L.traitMax, errors);
    if (list) value.traits = list;
  }

  if (has(obj, 'speech')) {
    const sp = obj.speech;
    if (!isPlainObject(sp)) errors.push(err('divisions.err.personalityNotObject', { field: 'speech' }));
    else {
      const speech = {};
      for (const k of Object.keys(sp)) {
        if (!SPEECH_FIELDS.includes(k)) errors.push(err('divisions.err.personalityUnknownField', { field: `speech.${clip(k)}` }));
      }
      if (has(sp, 'tone')) {
        if (typeof sp.tone !== 'string' || !TONES.includes(sp.tone)) errors.push(err('divisions.err.personalityEnum', { field: 'speech.tone', allowed: TONES.join(', ') }));
        else speech.tone = sp.tone;
      }
      if (has(sp, 'phrases')) {
        const list = checkList('speech.phrases', sp.phrases, L.phrasesMax, L.phraseMax, errors);
        if (list) speech.phrases = list;
      }
      value.speech = speech;
    }
  }

  for (const [field, allowed] of [['idle', IDLE_KINDS], ['quirk', QUIRKS]]) {
    if (!has(obj, field)) continue;
    if (typeof obj[field] !== 'string' || !allowed.includes(obj[field])) errors.push(err('divisions.err.personalityEnum', { field, allowed: allowed.join(', ') }));
    else value[field] = obj[field];
  }

  if (errors.length) return { ok: false, value: null, errors };
  return { ok: true, value, errors: [] };
}

/** Teks dua bahasa → string untuk `lang` ('id' atau lainnya = 'en'). */
export const localized = (text, lang) => (text ? (lang === 'id' ? text.id : text.en) : '');

// ------------------------------------------------------------------ kepribadian bawaan

const b = (en, id) => ({ en, id });
const P = (nickname, traits, tone, phrases, idle, quirk) => ({ nickname, traits, speech: { tone, phrases }, idle, quirk });

/**
 * Kepribadian bawaan: 17 worker + manajer + CEO. Nama panggilan sama dengan nama karakter di locales (office.char.*).
 * Isinya sopan, khas, dan dua bahasa. Semuanya harus lolos validatePersonality (dites).
 */
const RAW_DEFAULTS = {
  'dev-frontend': P(b('Sari', 'Sari'), [b('meticulous', 'teliti'), b('pixel-perfect', 'rapi sampai piksel')], 'cheerful',
    [b('Pixels aligned, yay!', 'Piksel sudah rapi, yay!'), b('One more tweak...', 'Satu sentuhan lagi...'), b('Looks good on mobile too', 'Di HP juga cakep')],
    'coffee', 'hum'),
  'dev-backend': P(b('Budi', 'Budi'), [b('steady', 'tenang'), b('logical', 'logis')], 'dry',
    [b('It works on the server.', 'Di server jalan kok.'), b('Index added. You are welcome.', 'Indeks sudah ditambah.'), b('Logs never lie.', 'Log tidak pernah bohong.')],
    'snack', 'desk-tap'),
  'dev-qa': P(b('Rina', 'Rina'), [b('careful', 'cermat'), b('curious', 'penasaran')], 'formal',
    [b('Let me check that again.', 'Saya cek sekali lagi.'), b('Edge case found, noted.', 'Kasus tepi ditemukan, dicatat.'), b('Please reproduce it first.', 'Mohon direproduksi dulu.')],
    'water', 'glasses'),
  'dev-security': P(b('Eko', 'Eko'), [b('vigilant', 'waspada'), b('quiet', 'pendiam')], 'calm',
    [b('Better safe than sorry.', 'Lebih baik waspada.'), b('Checking the locks.', 'Mengecek kuncinya.'), b('All quiet for now.', 'Aman terkendali.')],
    'window', 'headphones'),
  'dev-ui-critic': P(b('Dewi', 'Dewi'), [b('sharp eye', 'jeli'), b('honest', 'jujur')], 'dry',
    [b('The spacing is off by a hair.', 'Jaraknya meleset sedikit.'), b('Too many gradients, friend.', 'Gradiennya kebanyakan, Kak.'), b('Less is more.', 'Lebih sedikit lebih baik.')],
    'phone', 'doodle'),
  'dev-devops': P(b('Agus', 'Agus'), [b('easygoing', 'santai'), b('reliable', 'bisa diandalkan')], 'casual',
    [b('Servers are chilling.', 'Servernya adem ayem.'), b('Deploy? Not on Friday.', 'Deploy? Jangan hari Jumat.'), b('Uptime looks nice.', 'Uptime-nya mantap.')],
    'coffee', 'yawn'),
  'dev-docs': P(b('Putri', 'Putri'), [b('patient', 'sabar'), b('tidy', 'rapi')], 'calm',
    [b('A clear page helps everyone.', 'Halaman jelas menolong semua.'), b('Let me fix that typo.', 'Biar saya benahi typo-nya.'), b('Writing it down gently.', 'Menulis pelan-pelan.')],
    'plant', 'plant-talk'),
  'sales-copywriter': P(b('Nadia', 'Nadia'), [b('witty', 'jenaka'), b('expressive', 'ekspresif')], 'cheerful',
    [b('Ooh, I have a headline!', 'Ooh, ada judul bagus!'), b('Short and sweet wins.', 'Singkat dan manis menang.'), b('Let us make it sing.', 'Kita bikin hidup, yuk.')],
    'chat', 'pen-spin'),
  'sales-research': P(b('Fajar', 'Fajar'), [b('thoughtful', 'penuh pertimbangan'), b('thorough', 'teliti')], 'calm',
    [b('Let me look at the data.', 'Saya lihat datanya dulu.'), b('Interesting pattern here.', 'Ada pola menarik di sini.'), b('Sources first.', 'Sumber dulu.')],
    'window', 'glasses'),
  'sales-pricing': P(b('Maya', 'Maya'), [b('precise', 'presisi'), b('practical', 'praktis')], 'formal',
    [b('Let us review the numbers.', 'Mari kita tinjau angkanya.'), b('The margin looks healthy.', 'Marginnya tampak sehat.'), b('A fair price, I believe.', 'Harga yang wajar, menurut saya.')],
    'snack', 'pen-spin'),
  'content-script': P(b('Rizky', 'Rizky'), [b('playful', 'jenaka'), b('quick', 'gesit')], 'casual',
    [b('Hook first, always!', 'Hook dulu, selalu!'), b('Three seconds to grab them.', 'Tiga detik buat menarik.'), b('This one will go viral, maybe.', 'Yang ini bisa viral, mungkin.')],
    'phone', 'hum'),
  'content-animator': P(b('Citra', 'Citra'), [b('creative', 'kreatif'), b('energetic', 'enerjik')], 'cheerful',
    [b('Ease in, ease out!', 'Pelan di awal, pelan di akhir!'), b('Frame by frame, friends.', 'Kita jalan frame demi frame.'), b('Time to stretch, then animate.', 'Regangan dulu, lalu animasi.')],
    'stretch', 'doodle'),
  'research-analyst': P(b('Hendra', 'Hendra'), [b('seasoned', 'berpengalaman'), b('calm', 'tenang')], 'calm',
    [b('Let me cross-check that.', 'Saya cek silang dulu.'), b('Facts, then conclusions.', 'Fakta dulu, baru simpulan.'), b('A sip of water helps thinking.', 'Seteguk air bantu berpikir.')],
    'water', 'yawn'),
  '3d-modeler': P(b('Bayu', 'Bayu'), [b('hands-on', 'telaten'), b('chill', 'santai')], 'casual',
    [b('Just one more vertex.', 'Satu vertex lagi.'), b('Topology looks clean.', 'Topologinya bersih.'), b('Need a quick stretch.', 'Butuh regangan sebentar.')],
    'stretch', 'headphones'),
  '3d-materials': P(b('Tari', 'Tari'), [b('gentle', 'lembut'), b('detail-loving', 'suka detail')], 'calm',
    [b('This surface needs more grain.', 'Permukaan ini butuh serat.'), b('Soft light, soft shine.', 'Cahaya lembut, kilau lembut.'), b('Watering my plant first.', 'Siram tanaman dulu.')],
    'plant', 'doodle'),
  '3d-animator': P(b('Dimas', 'Dimas'), [b('lively', 'lincah'), b('sociable', 'supel')], 'cheerful',
    [b('Look, it bounces!', 'Lihat, memantul!'), b('Anyone up for a chat?', 'Ada yang mau ngobrol?'), b('Twelve frames to go.', 'Tinggal dua belas frame.')],
    'chat', 'pen-spin'),
  '3d-render': P(b('Wulan', 'Wulan'), [b('patient', 'sabar'), b('deadpan', 'datar')], 'dry',
    [b('Render at 3 percent. Riveting.', 'Render baru 3 persen. Seru.'), b('Good things take samples.', 'Yang bagus butuh banyak sampel.'), b('I will be here. Waiting.', 'Saya di sini. Menunggu.')],
    'coffee', 'yawn'),
  [MANAGER_ID]: P(b('Ms. Ratna', 'Bu Ratna'), [b('organized', 'terorganisir'), b('warm', 'hangat')], 'formal',
    [b('Everything is on schedule.', 'Semua sesuai jadwal.'), b('Thank you, team.', 'Terima kasih, Tim.'), b('Let me review the plan.', 'Saya tinjau rencananya.')],
    'coffee', 'glasses'),
  [CEO_ID]: P(b('Mr. Anton', 'Pak Anton'), [b('visionary', 'visioner'), b('friendly', 'ramah')], 'casual',
    [b('Great work, everyone!', 'Kerja bagus, semuanya!'), b('How is the team today?', 'Tim hari ini bagaimana?'), b('Keep it simple, please.', 'Yang sederhana saja, ya.')],
    'chat', 'hum'),
};

/** Salinan beku; kunci = id worker bawaan, `manager`, `ceo`. */
function deepFreeze(o) {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}
export const DEFAULT_PERSONALITIES = deepFreeze(RAW_DEFAULTS);

/** Default netral (tanpa data): perilaku sama dengan sebelum fase kepribadian, tanpa frasa khusus. */
export const NEUTRAL_PERSONALITY = deepFreeze({ nickname: null, traits: [], speech: { tone: null, phrases: [] }, idle: 'coffee', quirk: null });

/** Lengkapi kepribadian tervalidasi (atau null) dengan default netral. */
export function resolvePersonality(value) {
  if (!value) return NEUTRAL_PERSONALITY;
  return {
    nickname: value.nickname ?? null,
    traits: value.traits ?? [],
    speech: { tone: value.speech?.tone ?? null, phrases: value.speech?.phrases ?? [] },
    idle: value.idle ?? NEUTRAL_PERSONALITY.idle,
    quirk: value.quirk ?? null,
  };
}
