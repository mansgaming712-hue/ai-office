// Sumber token AI Office (dipakai server/index.js dan hooks/send-event.mjs), tanpa dependensi.
//
//   AI_OFFICE_TOKEN       token langsung (diutamakan bila terisi)
//   AI_OFFICE_TOKEN_FILE  path file berisi token; dibaca hanya bila AI_OFFICE_TOKEN kosong.
//                         "~" di awal = folder home. Isi file: SATU baris token (baris kosong dan
//                         spasi di tepi diabaikan). UTF-8 (dengan/tanpa BOM) atau UTF-16 LE/BE dengan
//                         BOM (mis. hasil `>` di Windows PowerShell 5.1).
//
// Dengan file, token tidak perlu ditaruh di "env" .claude/settings.local.json, sehingga tidak
// diwariskan ke semua subprocess Claude Code. File hilang/tidak bisa dibaca = seperti tanpa token.
// Isi file TIDAK PERNAH dimasukkan ke pesan `problem` (hanya alasan dan kode error). Nilai
// AI_OFFICE_TOKEN_FILE sendiri hanya dicetak bila jelas sebuah path (lihat tokenFileLabel).
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const MAX_TOKEN_FILE_BYTES = 4096;
const TOO_BIG = `lebih besar dari ${MAX_TOKEN_FILE_BYTES} byte`;
// O_NONBLOCK (Linux/macOS): membuka FIFO tidak menunggu penulis. Windows tidak punya (0).
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0);
/** Karakter token yang sah: ASCII terlihat saja (tanpa spasi), sama dengan pemeriksaan di hook. */
export const TOKEN_CHARS_RE = /^[\x21-\x7e]+$/;
export const INVALID_TOKEN =
  'berisi spasi atau karakter tidak valid (token hanya boleh karakter ASCII terlihat 0x21-0x7E, tanpa spasi; buat ulang dengan: npm run -s token)';

/** "~" / "~/x" / "~\x" → folder home pengguna. Path lain dikembalikan apa adanya. */
export function expandHome(path) {
  if (path === '~') return homedir();
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Jumlah pergantian kelas (huruf besar / huruf kecil / angka) di antara dua karakter alfanumerik yang
 * bersebelahan. Teks acak base64/base64url/hex berganti kelas di ±60% posisinya ("YmF6cXV4" → 7);
 * nama wajar hampir tidak pernah ("UTF_16LE_BOM_lone_surrogate" → 1, "aioffice_token_value" → 0).
 */
function classChanges(s) {
  let n = 0;
  let prev = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const k = c >= 65 && c <= 90 ? 1 : c >= 97 && c <= 122 ? 2 : c >= 48 && c <= 57 ? 3 : 0;
    if (k && prev && k !== prev) n++;
    prev = k;
  }
  return n;
}

/** Deretan ≥ 16 karakter yang tampak acak: pergantian kelas ≥ 6 dan ≥ seperempat panjangnya. */
const looksRandom = (s) => s.length >= 16 && classChanges(s) >= Math.max(6, s.length / 4);

/**
 * Apakah segmen path (bagian di antara "/" atau "\") berbentuk token acak, bukan nama file/folder?
 *   - ≥ 64 karakter: ya (tidak ada nama folder wajar sepanjang itu; arah aman = disembunyikan);
 *   - ≥ 16 karakter dan memuat "+" atau "=" (ciri base64): ya;
 *   - ≥ 16 karakter yang tampak acak (looksRandom; mis. token `npm run -s token` atau hex panjang): ya.
 * Nama wajar seperti "ai-office", "token-file", "aioffice_token_value", "token.txt", UUID huruf kecil
 * tidak termasuk.
 */
function isRandomSegment(seg) {
  if (seg.length >= 64) return true;
  if (seg.length < 16) return false;
  return /[+=]/.test(seg) || looksRandom(seg);
}

/**
 * Apakah nilai AI_OFFICE_TOKEN_FILE jelas sebuah path, sehingga boleh dicetak di peringatan/log?
 * Ya bila nilainya "~", atau memuat pemisah "/" atau "\" dan:
 *   - tidak ada segmen yang berbentuk token acak (isRandomSegment), dan
 *   - nilai utuhnya bukan deretan ≥ 24 karakter base64 saja (huruf, angka, + / = _ -) yang tampak acak
 *     (token base64 yang kebetulan memuat beberapa "/" sehingga setiap segmennya pendek).
 * Selain itu (mis. operator menempelkan token ke variabel ini, atau nama tanpa pemisah seperti
 * "token.txt") nilainya tidak dicetak, supaya token tidak masuk journald atau stderr. Arah ragu-ragu
 * selalu "tidak dicetak". Path yang sah seperti "/etc/ai-office/token-file" atau
 * "/var/lib/aioffice/secrets/token" tetap dicetak.
 */
export function looksLikePath(value) {
  const v = String(value ?? '').trim();
  if (v === '~') return true;
  if (!/[\\/]/.test(v)) return false;
  if (v.split(/[\\/]+/).some(isRandomSegment)) return false;
  return !(/^[A-Za-z0-9+/=_-]{24,}$/.test(v) && looksRandom(v));
}

/**
 * Label untuk pesan peringatan: "AI_OFFICE_TOKEN_FILE (<path>)" bila nilainya jelas path, kalau tidak
 * tanpa nilainya sama sekali.
 * @param {string | undefined} rawValue nilai mentah AI_OFFICE_TOKEN_FILE
 * @param {string | undefined} file path yang sudah diperluas (resolveToken(...).file)
 */
export function tokenFileLabel(rawValue, file) {
  if (looksLikePath(rawValue)) return `AI_OFFICE_TOKEN_FILE (${file ?? expandHome(String(rawValue).trim())})`;
  return 'AI_OFFICE_TOKEN_FILE (nilainya tidak ditampilkan karena tidak berbentuk path; isi dengan path file token, bukan tokennya)';
}

/**
 * Baca file token lewat SATU file descriptor: open → fstat (harus file biasa, ≤ batas) → read
 * maksimal MAX_TOKEN_FILE_BYTES + 1 byte. Pemeriksaan memakai fstat atas fd yang sama dengan yang
 * dibaca, jadi file tidak bisa ditukar (symlink/FIFO/file besar) di antara pemeriksaan dan pembacaan.
 * @returns {{ bytes: Buffer } | { problem: string }}
 */
function readTokenFile(file) {
  // stat dulu (tanpa membuka): FIFO/perangkat tidak pernah dibuka sama sekali (membuka perangkat
  // bisa punya efek samping). Pemeriksaan yang menentukan tetap fstat di bawah.
  if (!statSync(file).isFile()) return { problem: 'bukan file biasa' };
  const fd = openSync(file, OPEN_FLAGS);
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return { problem: 'bukan file biasa' };
    if (info.size > MAX_TOKEN_FILE_BYTES) return { problem: TOO_BIG };
    const buf = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r <= 0) break;
      n += r;
    }
    if (n > MAX_TOKEN_FILE_BYTES) return { problem: TOO_BIG }; // file membesar setelah fstat
    return { bytes: buf.subarray(0, n) };
  } finally {
    closeSync(fd);
  }
}

/** Dekode isi file: UTF-16 LE/BE dengan BOM, UTF-8 dengan BOM, selain itu UTF-8. BOM dibuang. */
export function decodeTokenBytes(bytes) {
  const even = (b) => b.subarray(0, b.length - (b.length % 2));
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return even(bytes.subarray(2)).toString('utf16le');
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return Buffer.from(even(bytes.subarray(2))).swap16().toString('utf16le');
  const text = bytes.toString('utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Pemanggil meneruskan nilai env secara eksplisit (process.env.AI_OFFICE_TOKEN dan
 * process.env.AI_OFFICE_TOKEN_FILE), supaya daftar env yang dibaca tetap terlihat di file pemanggil.
 * @param {{ token?: string, tokenFile?: string }} values
 *
 * Token harus berupa karakter ASCII terlihat saja (0x21-0x7E, aturan yang sama dengan hook dan header
 * Authorization: Bearer). Token dengan spasi di tengah, karakter non-ASCII, U+2028, U+FFFD, atau
 * surrogate tunggal ditolak: `token` kosong, `invalid: true`, dan `problem` berisi alasannya (tanpa
 * isi token). Tanpa aturan ini, `safeEqual` (UTF-8) menganggap "a\ud800" sama dengan "a�".
 * Pemanggil memperlakukan `invalid` sebagai kesalahan konfigurasi (server tidak start, hook tidak
 * mengirim), BUKAN seperti tanpa token.
 * @returns {{ token: string, source: 'env' | 'file' | 'none', file?: string, problem?: string, invalid?: true }}
 */
export function resolveToken({ token, tokenFile } = {}) {
  const direct = String(token ?? '').trim();
  if (direct) return TOKEN_CHARS_RE.test(direct) ? { token: direct, source: 'env' } : { token: '', source: 'env', problem: INVALID_TOKEN, invalid: true };
  const raw = String(tokenFile ?? '').trim();
  if (!raw) return { token: '', source: 'none' };
  let file = raw;
  const fail = (problem) => ({ token: '', source: 'file', file, problem });
  try {
    file = expandHome(raw);
    const r = readTokenFile(file);
    if (r.problem) return fail(r.problem);
    const text = decodeTokenBytes(r.bytes);
    // UTF-16 tanpa BOM (atau file biner) terbaca sebagai UTF-8 berisi NUL: tolak dengan petunjuk.
    if (text.includes('\0')) return fail('berisi karakter NUL; simpan sebagai UTF-8 (atau UTF-16 dengan BOM)');
    const lines = text.split(/\r\n|\r|\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return fail('kosong');
    if (lines.length > 1) return fail(`tidak valid: file token harus berisi satu baris (ada ${lines.length} baris berisi)`);
    if (!TOKEN_CHARS_RE.test(lines[0])) return { ...fail(INVALID_TOKEN), invalid: true };
    return { token: lines[0], source: 'file', file };
  } catch (e) {
    return fail(e?.code === 'ENOENT' ? 'tidak ditemukan' : `tidak bisa dibaca (${e?.code ?? 'error'})`);
  }
}
