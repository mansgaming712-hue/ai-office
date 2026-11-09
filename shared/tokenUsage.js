// Membaca pemakaian token dari baris log/transkrip JSONL Claude Code (fungsi murni, tanpa I/O).
// Dipakai hook (token per agen dari agent_transcript_path) dan server/usage.js (statistik harian).
//
// Satu baris yang dikenali berbentuk (field lain diabaikan):
//   { "type": "assistant", "timestamp": "ISO", "requestId": "...", "uuid": "...",
//     "message": { "id": "msg_...", "usage": { "input_tokens": 1, "output_tokens": 2,
//                  "cache_read_input_tokens": 3, "cache_creation_input_tokens": 4 } } }
// Satu pesan bisa muncul di beberapa baris (satu per blok konten, atau sesi yang di-resume), jadi
// penjumlahan selalu di-dedup per message.id (cadangan: requestId, lalu uuid).

export const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation'];
export const MAX_TOKENS = 1e12;

const SOURCE_KEYS = {
  input: 'input_tokens',
  output: 'output_tokens',
  cacheRead: 'cache_read_input_tokens',
  cacheCreation: 'cache_creation_input_tokens',
};

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const clampCount = (v) => (isCount(v) ? Math.min(Math.floor(v), MAX_TOKENS) : 0);

export const zeroTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });

/** Jumlah keempat field (input + output + cacheRead + cacheCreation). */
export const tokenTotal = (t) => t.input + t.output + t.cacheRead + t.cacheCreation;

/** Tambahkan `b` ke `a` (mutasi `a`), tiap field dibatasi MAX_TOKENS. */
export function addTokens(a, b) {
  for (const k of TOKEN_FIELDS) a[k] = Math.min(a[k] + b[k], MAX_TOKENS);
  return a;
}

/**
 * Pemakaian dari satu entri log yang sudah di-parse, atau null bila entri tidak punya
 * message.usage dengan paling sedikit satu angka token yang dikenal.
 */
export function usageOf(entry) {
  const u = entry && typeof entry === 'object' ? entry.message?.usage : undefined;
  if (!u || typeof u !== 'object' || Array.isArray(u)) return null;
  if (!Object.values(SOURCE_KEYS).some((k) => isCount(u[k]))) return null;
  const out = zeroTokens();
  for (const k of TOKEN_FIELDS) out[k] = clampCount(u[SOURCE_KEYS[k]]);
  return out;
}

/** Kunci dedup: message.id, lalu requestId, lalu uuid (teks ≤ 200 karakter), atau null. */
export function usageId(entry) {
  for (const v of [entry?.message?.id, entry?.requestId, entry?.uuid]) {
    if (typeof v === 'string' && v && v.length <= 200) return v;
  }
  return null;
}

/**
 * Penjumlah untuk transkrip satu subagent: hanya baris `type: "assistant"`, dedup per id.
 * `addLine` menerima string atau Buffer satu baris; baris yang rusak atau bukan JSON dilewati.
 */
export function createTranscriptTokenSum({ maxParseFailures = Infinity } = {}) {
  const seen = new Set();
  const sum = zeroTokens();
  let found = 0;
  let failures = 0;
  return {
    /** true bila batas parse gagal terlampaui: penelusuran sebaiknya dihentikan (hasil parsial dipakai). */
    get exhausted() {
      return failures > maxParseFailures;
    },
    addLine(line) {
      if (!line || failures > maxParseFailures) return;
      if (!line.includes('"usage"')) return; // cepat: baris tanpa usage tidak di-parse
      let entry;
      try {
        entry = JSON.parse(line.toString());
      } catch {
        failures++;
        return;
      }
      if (!entry || typeof entry !== 'object' || entry.type !== 'assistant') return;
      const usage = usageOf(entry);
      if (!usage) return;
      const id = usageId(entry);
      if (id !== null) {
        if (seen.has(id)) return;
        seen.add(id);
      }
      addTokens(sum, usage);
      found++;
    },
    /** Hasil, atau null bila tidak ada satu pun baris usage yang dikenali. */
    result() {
      return found ? { ...sum } : null;
    },
  };
}
