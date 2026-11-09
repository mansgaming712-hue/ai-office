// Format event AI Office — dipakai bersama oleh browser, server, hook, dan simulasi.
//
//   { "type": "assign" | "working" | "done" | "blocked" | "report",
//     "from": "manager", "to": "dev-frontend",
//     "message": "Bangun landing page", "time": "2026-11-08T02:30:00.000Z" }
//
// Kunci berbahasa Indonesia juga diterima dan dinormalisasi:
//   tipe → type, dari → from, ke → to, pesan → message, waktu → time
// Field tambahan opsional: id (diberikan server), source ("hook" | "sim" | "ui" | "api"),
//   project  nama folder sesi Claude Code (teks, maks 64 karakter; dibersihkan seperti message)
//   tokens   { input, output, cacheRead, cacheCreation }: bilangan bulat ≥ 0 (maks 1e12), dari hook
//            SubagentStop (jumlah message.usage di transkrip subagent)
// Event lama tanpa project/tokens tetap valid.

export const EVENT_TYPES = ['assign', 'working', 'done', 'blocked', 'report'];
export const EVENT_SOURCES = ['hook', 'sim', 'ui', 'api'];
export const LIMITS = { name: 64, message: 500, batch: 50, project: 64 };
export const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheCreation'];
export const MAX_TOKEN_COUNT = 1e12;

// Peta alias: objek tanpa prototype + Object.hasOwn, supaya nama seperti "constructor" atau
// "toString" tidak mengambil fungsi dari Object.prototype.
const KEY_ALIASES = Object.freeze(Object.assign(Object.create(null), { tipe: 'type', dari: 'from', ke: 'to', pesan: 'message', waktu: 'time', sumber: 'source' }));
const NAME_ALIASES = Object.freeze(Object.assign(Object.create(null), { manajer: 'manager', orchestrator: 'manager' }));
const NAME_RE = /^[a-z0-9][a-z0-9_.:-]*$/;
const aliasOf = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);

// Urutan escape terminal (ECMA-48) dibuang UTUH (bukan hanya byte ESC-nya), supaya sisa seperti "[1m"
// atau "(B" tidak menempel di teks (dan tidak menghalangi redaksi rahasia di hook):
//   CSI          : (ESC [ | U+009B) <parameter 0x30-0x3f>* <perantara 0x20-0x2f>* <akhir 0x40-0x7e>
//                  (mis. ESC[1m, ESC[0;31m, ESC[m, U+009B 1m)
//   OSC/DCS/SOS/PM/APC: (ESC ] | ESC P | ESC X | ESC ^ | ESC _ | U+009D | U+0090 | U+0098 | U+009E | U+009F)
//                  <isi tanpa BEL/ESC/C1> diakhiri BEL, ESC \ atau U+009C (ST)   (mis. judul, hyperlink)
//   nF           : ESC <perantara 0x20-0x2f>+ <akhir 0x30-0x7e>                  (mis. ESC(B dari `tput sgr0`)
//   Fp/Fe/Fs     : ESC <satu byte 0x30-0x7e>                                     (mis. ESC7, ESC8, ESC=, ESCc)
// Urutan alternatif penting: bentuk panjang dicoba dulu, ESC + satu byte paling akhir. Urutan yang tidak
// lengkap (mis. OSC tanpa akhir) jatuh ke bentuk Fe (ESC ] dibuang, isinya tetap tampil sebagai teks).
// Linear: setiap alternatif diawali ESC/C1 dan kelas karakter di tiap bagian saling lepas (isi OSC/DCS
// tidak boleh memuat ESC atau C1, jadi pemindaian dari satu awal berhenti di awal berikutnya).
const ANSI_SEQUENCE_RE = new RegExp(
  [
    String.raw`(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]`,
    String.raw`(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])[^\x07\x1b\x80-\x9f]*(?:\x07|\x1b\\|\x9c)`,
    String.raw`\x1b[ -/]+[0-~]`,
    String.raw`\x1b[0-~]`,
  ].join('|'),
  'g',
);
// Untuk stripControlWithMap keepEscapeTokenChars: awal urutan string (OSC/DCS/SOS/PM/APC) dan karakter token.
const STRING_SEQUENCE_START_RE = /^(?:\x1b[\]PX^_]|[\x90\x98\x9d\x9e\x9f])/;
const TOKEN_CHAR_RE = /[A-Za-z0-9_.-]/;

// Karakter yang dibuang (setelah urutan escape di atas):
//   - kontrol C0/C1 kecuali tab dan baris baru (keduanya dijadikan spasi oleh normalizeEvent): ESC,
//     CR, DEL, dll. Mencegah injeksi log/terminal.
//   - pengarah teks (bidi): U+061C ALM, U+200E LRM, U+200F RLM, U+202A-U+202E, U+2066-U+2069.
//     Mencegah teks yang tampil terbalik.
//   - karakter tak terlihat (zero-width/format/pengisi kosong): U+00AD soft hyphen, U+034F CGJ,
//     U+115F/U+1160/U+3164/U+FFA0 (pengisi Hangul), U+17B4/U+17B5 (vokal Khmer tak terlihat),
//     U+180B-U+180F (pemilih variasi Mongol, U+180E), U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ,
//     U+2060-U+2064 (word joiner, operator tak terlihat), U+206A-U+206F, U+2800 (Braille kosong),
//     U+FE00-U+FE0F dan U+E0100-U+E01EF (pemilih variasi), U+FEFF (BOM), U+FFF9-U+FFFB (anotasi
//     interlinear), U+1D173-U+1D17A (format notasi musik), U+E0000-U+E007F (karakter tag).
//     Bisa dipakai menyisip di tengah token sehingga pola redaksi tidak cocok padahal token tampil utuh.
const CONTROL_BIDI_RE =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/** Buang urutan escape terminal utuh, lalu karakter kontrol, bidi, dan tak terlihat (lihat di atas). */
export function stripControl(text) {
  return String(text).replace(ANSI_SEQUENCE_RE, '').replace(CONTROL_BIDI_RE, '');
}

/**
 * Sama dengan stripControl, plus peta posisi: `map[i]` = indeks (UTF-16) di `text` asal untuk
 * karakter ke-i hasil. Dipakai hook untuk menggabungkan hasil redaksi dari dua "pandangan" teks yang
 * sama (lihat prepareText di shared/hookMapping.js). Tanpa opsi, hasil `text` selalu identik dengan
 * stripControl.
 *   keepEscapeTokenChars = true: urutan escape TIDAK dibuang utuh. Byte ESC/C1 dan byte pengantarnya
 *     ("[" pada ESC[, "(" pada ESC() dibuang, lalu dari sisanya (parameter, perantara, byte akhir) hanya
 *     karakter token [A-Za-z0-9_.-] yang dipertahankan. Urutan string (OSC/DCS/SOS/PM/APC) dan ESC + satu
 *     byte tetap dibuang utuh. Untuk redaksi di hook: "AIza ESC[SyD…" (huruf "S" termakan sebagai byte
 *     akhir) → "AIzaSyD…", "glpat ESC[-xY9…" ("-" perantara, "x" akhir) → "glpat-xY9…".
 *   keepEscapeFinal = true: urutan escape dibuang KECUALI byte akhirnya bila karakter token (parameter dan
 *     perantara ikut dibuang; urutan string tetap dibuang utuh). ESC[ yang tidak lengkap (hanya cocok
 *     sebagai ESC + "[") ikut membuang byte perantara 0x20-0x2F yang langsung mengikutinya. Untuk redaksi
 *     di hook: "ghp_…Fa ESC[-1Ke…" (stripControl: "ghp_…Fa-1Ke…") → "ghp_…Fa1Ke…", "AKIA…PL ESC(-3"
 *     (stripControl: "AKIA…PL") → "AKIA…PL3", "ghp_…Fa ESC[ 1Ke…" → "ghp_…Fa1Ke…".
 *   keepTokenIntermediates = true (bersama keepEscapeFinal): perantara sesudah ESC[ tidak lengkap yang
 *     berupa karakter token ("-", ".") tetap ada, hanya sisanya (spasi, "!", "#", …) yang dibuang:
 *     "AIzaSyD ESC[ -9tS…" → "AIzaSyD-9tS…" (dengan keepEscapeFinal saja: "AIzaSyD9tS…").
 * @returns {{ text: string, map: number[] }}
 */
export function stripControlWithMap(text, { keepEscapeTokenChars = false, keepEscapeFinal = false, keepTokenIntermediates = false } = {}) {
  const src = String(text);
  const kept = []; // indeks asal yang lolos langkah 1 (urutan escape)
  let last = 0;
  for (const m of src.matchAll(ANSI_SEQUENCE_RE)) {
    for (let i = last; i < m.index; i++) kept.push(i);
    last = m.index + m[0].length;
    if (STRING_SEQUENCE_START_RE.test(m[0])) continue;
    if (keepEscapeTokenChars) {
      for (let i = m.index + (m[0][0] === '\x1b' ? 2 : 1); i < last; i++) if (TOKEN_CHAR_RE.test(src[i])) kept.push(i);
    } else if (keepEscapeFinal) {
      if (m[0] === '\x1b[') {
        // Perantara bukan ESC/C1, jadi urutan berikutnya tidak mungkin dimulai di dalamnya.
        for (; last < src.length && src.charCodeAt(last) >= 0x20 && src.charCodeAt(last) <= 0x2f; last++) {
          if (keepTokenIntermediates && TOKEN_CHAR_RE.test(src[last])) kept.push(last);
        }
      } else if (TOKEN_CHAR_RE.test(src[last - 1])) kept.push(last - 1);
    }
  }
  for (let i = last; i < src.length; i++) kept.push(i);
  const step1 = kept.length === src.length ? src : kept.map((i) => src[i]).join('');
  let out = '';
  const map = [];
  last = 0;
  for (const m of step1.matchAll(CONTROL_BIDI_RE)) {
    for (let i = last; i < m.index; i++) map.push(kept[i]);
    out += step1.slice(last, m.index);
    last = m.index + m[0].length;
  }
  for (let i = last; i < step1.length; i++) map.push(kept[i]);
  out += step1.slice(last);
  return { text: out, map };
}

/**
 * "Pandangan kosong" untuk redaksi di hook: setiap karakter yang dibuang stripControl diganti spasi
 * (per unit kode UTF-16, jadi panjang dan posisi sama persis dengan teks asal). Karakter tak terlihat
 * menjadi batas kata ("TOKEN<ZWSP>sk-…" → "TOKEN sk-…").
 *   keepEscapeFinal = false: isi urutan escape tetap ada sebagai teks, hanya ESC/C1-nya yang jadi spasi
 *                            ("ESC[--password x" → " [--password x").
 *   keepEscapeFinal = true : urutan escape utuh jadi spasi KECUALI byte akhirnya bila 0x30-0x7E
 *                            ("ESC[1sk-…" → "   sk-…"), supaya huruf pertama token yang "termakan" sebagai
 *                            byte akhir tetap terlihat dan berdiri di batas kata.
 */
export function blankControl(text, { keepEscapeFinal = false } = {}) {
  let s = String(text);
  if (keepEscapeFinal) {
    s = s.replace(ANSI_SEQUENCE_RE, (m) => {
      const f = m.charCodeAt(m.length - 1);
      return ' '.repeat(m.length - 1) + (f >= 0x30 && f <= 0x7e ? m[m.length - 1] : ' ');
    });
  }
  return s.replace(CONTROL_BIDI_RE, (m) => ' '.repeat(m.length));
}

export function truncate(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function normalizeName(value, field) {
  if (typeof value !== 'string') return { error: `"${field}" wajib berupa teks` };
  let name = stripControl(value).trim().toLowerCase();
  if (!name) return { error: `"${field}" tidak boleh kosong` };
  if (name.length > LIMITS.name) return { error: `"${field}" maksimal ${LIMITS.name} karakter` };
  if (!NAME_RE.test(name)) return { error: `"${field}" hanya boleh huruf, angka, - _ . :` };
  name = aliasOf(NAME_ALIASES, name) ?? name;
  return { value: name };
}

/** Teks bebas satu baris: spasi jadi satu, kontrol/bidi dibuang, dipotong `max`. */
function cleanLine(text, max) {
  return truncate(stripControl(text.replace(/\s+/g, ' ')).replace(/ {2,}/g, ' ').trim(), max);
}

/** `tokens` opsional: objek dengan angka finite 0..1e12 (dibulatkan ke bawah); field hilang = 0. */
function normalizeTokens(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: '"tokens" harus berupa objek' };
  const out = {};
  for (const k of TOKEN_KEYS) {
    const v = Object.hasOwn(value, k) ? value[k] : undefined;
    if (v === undefined || v === null) {
      out[k] = 0;
      continue;
    }
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TOKEN_COUNT) {
      return { error: `"tokens.${k}" harus angka 0 sampai ${MAX_TOKEN_COUNT}` };
    }
    out[k] = Math.floor(v);
  }
  return { value: out };
}

/**
 * Validasi + normalisasi satu event.
 * @returns {{ok: true, event: object} | {ok: false, error: string}}
 */
export function normalizeEvent(input, { now = () => new Date() } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'event harus berupa objek JSON' };
  }
  // Tanpa prototype: kunci "__proto__" dari JSON tidak bisa mengganti prototype `raw`, dan field
  // yang tidak dikirim tidak bisa "terwarisi" dari Object.prototype.
  const raw = Object.create(null);
  for (const [k, v] of Object.entries(input)) {
    const alias = aliasOf(KEY_ALIASES, k);
    const key = alias ?? k;
    if (!Object.hasOwn(raw, key) || alias === undefined) raw[key] = v;
  }

  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  if (!EVENT_TYPES.includes(type)) {
    return { ok: false, error: `"type" harus salah satu dari: ${EVENT_TYPES.join(', ')}` };
  }

  const from = normalizeName(raw.from, 'from');
  if (from.error) return { ok: false, error: from.error };
  const to = normalizeName(raw.to, 'to');
  if (to.error) return { ok: false, error: to.error };

  let message = '';
  if (raw.message !== undefined && raw.message !== null) {
    if (typeof raw.message === 'number' || typeof raw.message === 'boolean') message = String(raw.message);
    else if (typeof raw.message === 'string') message = raw.message;
    else return { ok: false, error: '"message" wajib berupa teks' };
  }
  // Spasi/baris baru jadi satu spasi dulu (CR, VT, FF ikut), baru karakter kontrol lain dan bidi dibuang.
  message = cleanLine(message, LIMITS.message);

  let project = '';
  if (raw.project !== undefined && raw.project !== null) {
    if (typeof raw.project !== 'string') return { ok: false, error: '"project" wajib berupa teks' };
    project = cleanLine(raw.project, LIMITS.project);
  }

  let tokens = null;
  if (raw.tokens !== undefined && raw.tokens !== null) {
    const t = normalizeTokens(raw.tokens);
    if (t.error) return { ok: false, error: t.error };
    tokens = t.value;
  }

  let time;
  if (raw.time === undefined || raw.time === null || raw.time === '') {
    time = now().toISOString();
  } else {
    const d = typeof raw.time === 'number' || typeof raw.time === 'string' ? new Date(raw.time) : null;
    if (!d || Number.isNaN(d.getTime())) return { ok: false, error: '"time" harus tanggal ISO 8601 atau epoch ms' };
    time = d.toISOString();
  }

  const event = { type, from: from.value, to: to.value, message, time };
  if (typeof raw.source === 'string' && EVENT_SOURCES.includes(raw.source)) event.source = raw.source;
  if (Number.isInteger(raw.id) && raw.id > 0) event.id = raw.id;
  if (project) event.project = project;
  if (tokens) event.tokens = tokens;
  return { ok: true, event };
}

/** Terima satu event atau array event. Semua harus valid (atomik). */
export function normalizeBatch(input, opts) {
  const list = Array.isArray(input) ? input : [input];
  if (list.length === 0) return { ok: false, error: 'tidak ada event' };
  if (list.length > LIMITS.batch) return { ok: false, error: `maksimal ${LIMITS.batch} event per kiriman` };
  const events = [];
  for (let i = 0; i < list.length; i++) {
    const r = normalizeEvent(list[i], opts);
    if (!r.ok) return { ok: false, error: list.length > 1 ? `event #${i}: ${r.error}` : r.error };
    events.push(r.event);
  }
  return { ok: true, events };
}

export function makeEvent(type, from, to, message = '', extra = {}) {
  const r = normalizeEvent({ type, from, to, message, ...extra });
  if (!r.ok) throw new Error(r.error);
  return r.event;
}
