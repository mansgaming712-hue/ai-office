// Pemetaan input hook Claude Code → event AI Office.
//
//   PreToolUse  (tool Agent/Task)       → assign   manager → <subagent_type>
//   PreToolUse  (SubagentHandback)      → working  <agent_type> → manager "Menyerahkan laporan ke manajer"
//   PreToolUse  (tool lain)             → working  <agent_type | manager> → manager/ceo
//   SubagentStart                       → working  <agent_type> → manager
//   SubagentStop                        → done | blocked (dari baris STATUS di pesan terakhir)
//   PostToolUse (tool Agent/Task)       → report | blocked (dari hasil subagent)
//   PostToolUse (Agent latar belakang)  → tidak ada event: hook ini terpicu saat agen DILUNCURKAN
//                                         (status "async_launched"); laporannya datang dari SubagentStop
//
// Input hook yang tidak relevan (mis. SubagentStop agen internal dengan agent_type kosong)
// menghasilkan array kosong.
//
// Field tambahan pada setiap event:
//   project  basename folder sesi (opsi `projectDir`, mis. env CLAUDE_PROJECT_DIR; cadangan: input.cwd)
//   tokens   hanya event SubagentStop, bila opsi `tokens` terisi (jumlah usage transkrip subagent)
import { blankControl, normalizeEvent, stripControl, stripControlWithMap, truncate } from './events.js';
import { HANDBACK_TOOL } from './transcript.js';

export { HANDBACK_TOOL };
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

/** tool_response PostToolUse Agent untuk agen latar belakang yang baru diluncurkan (belum bekerja). */
export function isAsyncLaunch(toolResponse) {
  if (!toolResponse || typeof toolResponse !== 'object' || Array.isArray(toolResponse)) return false;
  return toolResponse.status === 'async_launched' || toolResponse.isAsync === true;
}

export const REDACTED = '[disembunyikan]';

// Pola rahasia. Grup bernama `pre` / `post` (bila ada) dipertahankan; sisanya diganti REDACTED.
// Semua kuantifier di depan nilai dibatasi panjangnya supaya teks panjang tidak memicu backtracking
// berlebihan. Urutan: blok/format token yang dikenal dulu, lalu pola kontekstual (nama variabel, flag).
const VALUE = String.raw`(?:"[^"\n]*"|'[^'\n]*'|\S+)`;
const SECRET_NAME = String.raw`(?:SECRET|TOKEN|PASSWORD|PASSWD|PWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SESSION[_-]?KEY)`;
const SECRET_PATTERNS = [
  // Blok kunci privat PEM/OpenSSH/PGP sampai baris END (atau sampai akhir teks bila END tidak ada).
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
  // Kredensial di URL: scheme://<user>:<pass>@host atau scheme://<token>@host → ://[disembunyikan]@host
  /(?<pre>:\/\/)[^\s\/?#@:]{1,256}(?::[^\s@]{0,256})?(?<post>@)/g,
  // Format token yang dikenal. Prefiks yang khas TIDAK butuh batas kata (\b): setelah karakter tak
  // terlihat dibuang, token bisa menempel ke kata sebelumnya ("Token<ZWSP>ghp_…" → "Tokenghp_…").
  // Semua pola diawali literal dan diikuti satu kelas karakter tanpa syarat di belakangnya, jadi
  // deretan panjang selalu cocok (dan habis dikonsumsi) atau gagal dalam jarak pendek: linear.
  // Stripe: setelah batas kata, ekor apa pun; menempel ke kata sebelumnya hanya bila ekornya ≥ 16
  // alfanumerik (supaya "task_test_suite" tidak ikut tersensor).
  /\b[sr]k_(?:live|test)_\w+|[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g,
  // OpenAI / Anthropic dan sejenisnya. Prefiks pendek, rawan salah sensor ("disk-…", "task-…"), jadi:
  //   - setelah batas kata: nilai ≥ 12 karakter;
  //   - menempel ke kata sebelumnya (huruf, angka, atau "_": "a_sk-…", "OPENAI_KEY_sk-…", "mysk-…"): hanya
  //     bila nilainya tampak acak, yaitu dalam paling banyak 5 segmen pertama (dipisah "-" atau "_") ada satu segmen
  //     ≥ 16 alfanumerik yang memuat huruf DAN angka ("sk-ant-api03-…", "pk-live9a8b…"). Nama kebab-case
  //     biasa ("task-runner-configuration-v2", "desk-top-layout-2024-final") tidak punya segmen seperti itu.
  //     Segmen acak sesudah "_" juga ("mysk-ant-api03-Ab…", "xsk-Q7_w8E9r0…").
  //     Linear: setiap segmen dibatasi "-"/"_", lookahead berhenti di akhir segmen, dan satu segmen hanya bisa
  //     dicapai dari ≤ 5 awal "sk-" sebelumnya.
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}|(?:sk|pk|rk)-(?:[A-Za-z0-9]+[-_]){0,4}(?=[A-Za-z]*[0-9])(?=[0-9]*[A-Za-z])[A-Za-z0-9]{16,}[A-Za-z0-9_-]*/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
  /glpat-[\w-]{20,}/g, // GitLab
  /npm_(?:[A-Za-z0-9]{30,}|\w{36})/g, // npm
  /AIza[\w-]{35,}/g, // Google API key
  /dckr_pat_[\w-]+/g, // Docker Hub
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /AKIA[0-9A-Z]{16}/g, // AWS access key id (tanpa batas di kedua sisi: kata bisa menempel di depan/belakang)
  // JWT. Tanpa lookbehind dan tanpa \b (token boleh menempel ke "x-", "_", atau kata sebelumnya).
  // Supaya tidak kuadratik ("eyJ-eyJ-eyJ-…" dulu 6 detik per 100 KB), bagian header tidak boleh
  // melewati "eyJ" berikutnya: pemindaian dari setiap awal berhenti di awal berikutnya, sehingga total
  // kerja linear. Header asli yang kebetulan memuat "eyJ" tetap tersensor mulai dari "eyJ" terakhir
  // (header bukan rahasia; tanda tangan di bagian akhir yang penting).
  /eyJ(?:(?!eyJ)[A-Za-z0-9_-]){10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /(?<pre>\baio_session=)[^\s;"']+/g, // cookie sesi AI Office
  // Header Authorization: Basic/Bearer/Token/Digest <nilai>
  /(?<pre>\bAuthorization["']?\s*[:=]\s*(?:(?:Basic|Bearer|Token|Digest)\s+)?)[^\s"']+/gi,
  /(?<pre>\bbearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi,
  // Flag CLI: --password x / --password=x / --auth-token x / --api-key x (termasuk --http-password, dll.)
  new RegExp(String.raw`(?<pre>--(?:[a-z]+-){0,3}(?:password|passwd|auth-token|api-key|apikey|access-token|client-secret|secret|token)(?:=|\s+))${VALUE}`, 'gi'),
  // mysql/mariadb: -p<pass> (menempel). -P (port, huruf besar) tidak disentuh.
  /(?<pre>\b(?:mysql\w*|mariadb[\w-]*)\b[^\n;&|]{0,500}?\s-p)\S+/g,
  // sshpass -p <pass>
  /(?<pre>\bsshpass\b[^\n;&|]{0,200}?\s-p\s*)\S+/g,
  // curl -u user:pass / curl --user user:pass
  /(?<pre>\bcurl\b[^\n;&|]{0,500}?\s(?:-u\s*|--user(?:=|\s+)))\S+/g,
  // Nama variabel/kunci yang MENGANDUNG kata rahasia di posisi mana pun, mis. AWS_SECRET_ACCESS_KEY=...,
  // DB_PASSWORD="...", X-API-KEY: ..., "api_key": "...".
  new RegExp(String.raw`(?<pre>\b[\w.-]{0,40}${SECRET_NAME}[\w.-]{0,40}["']?\s*[=:]\s*)${VALUE}`, 'gi'),
  // Prosa: "password DB = x", "kata sandi admin: x".
  new RegExp(String.raw`(?<pre>\b(?:password|passwd|kata\s+sandi|sandi)\b[^\n=:,;]{0,24}?\s*[=:]\s*)${VALUE}`, 'gi'),
];

/** Sembunyikan pola rahasia yang umum sebelum teks dikirim ke animasi. */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      const groups = args.at(-1);
      const g = groups && typeof groups === 'object' ? groups : {};
      return `${g.pre ?? ''}${REDACTED}${g.post ?? ''}`;
    });
  }
  return out;
}

// Penanda internal (Private Use Area) untuk karakter rahasia di secretMask. Dibuang dari input lebih dulu.
const MASK = '\ue001';
const MASK_RE = /\ue001/g;

/**
 * Pola yang sama dengan redactSecrets, tetapi setiap karakter rahasia diganti MASK satu-per-satu
 * (panjang teks tidak berubah), sehingga posisi rahasia bisa dipetakan kembali ke teks asal.
 * @returns {Uint8Array} 1 = karakter di posisi itu bagian dari rahasia
 */
function secretMask(text) {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (...args) => {
      const groups = args.at(-1);
      const g = groups && typeof groups === 'object' ? groups : {};
      const pre = g.pre ?? '';
      const post = g.post ?? '';
      return `${pre}${MASK.repeat(args[0].length - pre.length - post.length)}${post}`;
    });
  }
  const mask = new Uint8Array(out.length);
  for (let i = out.indexOf(MASK); i >= 0; i = out.indexOf(MASK, i + 1)) mask[i] = 1;
  return mask;
}

/**
 * Buang urutan escape dan karakter tak terlihat (stripControl), tetapi rahasia yang hanya terlihat
 * dalam salah satu dari tujuh "pandangan" teks tetap tersensor:
 *   A: stripControl biasa. Token yang diselipi ESC[1m / ZWSP di tengahnya menyatu lagi di sini.
 *   C: hanya byte ESC/C1 yang dibuang (urutan escape tidak diurai), karakter tak terlihat dibuang.
 *      Untuk ESC tunggal di tengah token ("gh ESC p_…" → A: "gh_…" karena ESC p dibuang sebagai Fs;
 *      C: "ghp_…") dan huruf pertama token yang termakan byte akhir ("ESC[ghp_…" → A: "hp_…"; C: "[ghp_…").
 *   D: setiap karakter yang dibuang jadi spasi, isi urutan escape tetap teks (blankControl): ESC dan
 *      karakter tak terlihat menjadi batas kata ("TOKEN<ZWSP>sk-…", "ESC[--password x" → A: "assword x").
 *   E: urutan escape jadi spasi kecuali byte akhirnya (blankControl keepEscapeFinal): "ESC[1sk-…" →
 *      A: "k-…", C/D: "[1sk-…" (tanpa batas kata), E: "   sk-…".
 *   F: ESC/C1 dan byte pengantarnya ("[", "(") dibuang, karakter token [A-Za-z0-9_.-] di sisa urutan
 *      escape tetap ada (stripControlWithMap keepEscapeTokenChars). Untuk ESC[ / ESC( tanpa byte akhir
 *      sendiri di TENGAH token, yang memakan karakter token sebagai parameter/perantara/byte akhir:
 *      "AIza ESC[SyD-…" → A: "AIzayD-…", F: "AIzaSyD-…"; "AKIA ESC(IOSF…" → A: "AKIAOSF…", F: "AKIAIOSF…".
 *   G/H: urutan escape → hanya byte akhirnya bila karakter token; ESC[ tidak lengkap ikut membuang byte
 *      perantara 0x20-0x2F sesudahnya (G: semua; H: kecuali "-" / "."), yang di A tertinggal dan memutus
 *      token: "ghp_…Fa ESC[-1Ke…" → A: "ghp_…Fa-1Ke…", G: "ghp_…Fa1Ke…"; "AKIA…PL ESC(-3" → A: "AKIA…PL",
 *      G: "AKIA…PL3"; "AIzaSyD ESC[ -9t…" → A: "AIzaSyD -9t…", H: "AIzaSyD-9t…".
 * Rahasia dicari di setiap pandangan (secretMask), posisinya dipetakan ke teks asal. Karakter asal di antara
 * dua karakter rahasia yang berdampingan di satu pandangan ikut tersembunyi (perantara "-" di contoh G).
 * Sambungan: pandangan di atas masing-masing hanya menebak SATU cara urutan escape "memakan" karakter token;
 * bila beberapa sisipan berbeda jenis digabung di satu token, potongan token bisa tampil tanpa prefiksnya
 * utuh ("AKIAIOSF U+009B1m O ESC DNN7…" → A: "AKIAIOSFONN7…", 15 dari 16 karakter). Jadi deretan karakter
 * token [A-Za-z0-9_.-] di hasil A yang (1) di tengahnya ada karakter yang dibuang, tepat di antara dua
 * karakter token, dan (2) panjangnya ≥ 16 serta memuat huruf dan ≥ 2 angka (tampak acak, bukan kata biasa
 * dengan soft hyphen atau warna ANSI seperti "build-ESC[1mv2ESC[0m-release"), ikut disembunyikan seluruhnya. Karakter yang sudah tersensor oleh
 * pandangan mana pun memutus deretan (hideSplicedRuns).
 * Hasil A dikembalikan dengan setiap deretan karakter yang tersensor diganti REDACTED.
 * Hanya dijalankan bila stripControl memang membuang sesuatu. Linear: tujuh kali redaksi + peta posisi.
 */
function stripControlRedacting(text) {
  const a = stripControlWithMap(text);
  const hidden = new Uint8Array(text.length);
  const views = [
    a,
    // C: ESC/C1 diganti DEL lalu dibuang stripControl sebagai karakter kontrol biasa (bukan awal urutan).
    stripControlWithMap(text.replace(/[\x1b\x80-\x9f]/g, '\x7f')),
    // D dan E: panjang sama dengan teks asal, jadi petanya identitas (map: null).
    { text: blankControl(text), map: null },
    { text: blankControl(text, { keepEscapeFinal: true }), map: null },
    // F: ESC/C1 + pengantar dibuang, karakter token di dalam urutan escape tetap (peta posisi seperti A).
    stripControlWithMap(text, { keepEscapeTokenChars: true }),
    // G: urutan escape → hanya byte akhirnya (bila karakter token); ESC[ tidak lengkap ikut membuang
    // perantara 0x20-0x2F sesudahnya ("…Fa ESC[-1Ke…" → "…Fa1Ke…", "…PL ESC(-3" → "…PL3").
    stripControlWithMap(text, { keepEscapeFinal: true }),
    // H: seperti G, tetapi perantara "-" / "." sesudah ESC[ tidak lengkap tetap ("AIzaSyD ESC[ -9t…" → "AIzaSyD-9t…").
    stripControlWithMap(text, { keepEscapeFinal: true, keepTokenIntermediates: true }),
  ];
  for (const view of views) {
    const mask = secretMask(view.text);
    for (let i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      const at = view.map ? view.map[i] : i;
      hidden[at] = 1;
      // Dua karakter rahasia yang berdampingan di pandangan ini: semua yang dibuang di antaranya ikut
      // tersembunyi (di G termasuk perantara "-" / spasi yang masih tampil di hasil A). Peta naik, jadi linear.
      if (view.map && i > 0 && mask[i - 1]) for (let j = view.map[i - 1] + 1; j < at; j++) hidden[j] = 1;
    }
  }
  hideSplicedRuns(a, hidden);
  let out = '';
  for (let i = 0; i < a.text.length; i++) {
    if (!hidden[a.map[i]]) out += a.text[i];
    else if (i === 0 || !hidden[a.map[i - 1]]) out += REDACTED;
  }
  return out;
}

const TOKEN_CHAR = /[A-Za-z0-9_.-]/;
const SPLICE_MIN = 16;

/**
 * Aturan "sambungan" stripControlRedacting: tandai deretan karakter token yang MASIH terlihat di hasil A
 * (karakter yang sudah tersensor memutus deretan, jadi "Token<ZWSP>ghp_…" tetap "Token[disembunyikan]")
 * bila tersambung di atas karakter yang dibuang, panjangnya ≥ SPLICE_MIN, dan memuat huruf dan ≥ 2 angka.
 * Linear: satu lintasan atas hasil A.
 */
function hideSplicedRuns(a, hidden) {
  const { text, map } = a;
  let start = 0;
  let spliced = false;
  let letter = false;
  let digits = 0;
  for (let i = 0; i <= text.length; i++) {
    const c = text[i];
    if (i < text.length && TOKEN_CHAR.test(c) && !hidden[map[i]]) {
      if (i > start && map[i] !== map[i - 1] + 1) spliced = true;
      if (c >= '0' && c <= '9') digits++;
      else if (/[A-Za-z]/.test(c)) letter = true;
      continue;
    }
    if (spliced && letter && digits >= 2 && i - start >= SPLICE_MIN) for (let j = start; j < i; j++) hidden[map[j]] = 1;
    start = i + 1;
    spliced = letter = false;
    digits = 0;
  }
}

/**
 * Setelah teks dipotong: buang bagian kutip yang belum tertutup di baris terakhir (mis. nilai
 * `--password "alpha bravo` yang terpotong sebelum kutip penutup; tanpa ini, pola VALUE hanya menyensor
 * kata pertama dan "bravo" tampil). Kutip " dan ' dilacak seperti shell (di dalam "…", ' biasa saja).
 */
function dropUnclosedQuote(s) {
  let open = -1;
  let quote = '';
  for (let i = s.lastIndexOf('\n') + 1; i < s.length; i++) {
    const c = s[i];
    if (open < 0) {
      if (c === '"' || c === "'") {
        open = i;
        quote = c;
      }
    } else if (c === quote) open = -1;
  }
  return open < 0 ? s : s.slice(0, open);
}

// Batas panjang teks bebas dari hook yang diproses (dinormalisasi lalu diredaksi). Keluarannya toh
// dipotong 80/120/200 karakter, jadi batas ini cukup longgar dan menjaga semua regex tetap cepat
// berapa pun panjang input aslinya.
//   SCAN_CHARS : teks multi-baris (prompt, laporan subagent), untuk beberapa baris awal
//   LINE_CHARS : teks satu baris (description, command, nama file, host)
const SCAN_CHARS = 8000;
const LINE_CHARS = 2000;

/**
 * Siapkan teks bebas dari hook SEBELUM diredaksi:
 *   1. potong ke 4 × max (batas kerja; semua langkah berikutnya linear);
 *   2. CR/CRLF, U+2028, U+2029 → baris baru; tab, VT, FF → spasi (supaya tidak hilang di langkah 3
 *      dan membuat token menempel ke kata di depannya);
 *   3. buang urutan escape terminal utuh dan karakter kontrol/bidi/tak terlihat (stripControl, sama
 *      dengan yang dipakai normalizeEvent), supaya "ESC[1mghp_…" atau "gh<LRM>p_…" tetap dikenali.
 *      Bila memang ada yang dibuang, rahasia yang hanya terlihat SEBELUM pembuangan (mis. "ESC[ghp_…":
 *      huruf "g" termakan sebagai byte akhir CSI) langsung diganti REDACTED (stripControlRedacting);
 *   4. potong ke `max`. Bila ada yang terpotong, "kata" terakhir (yang mungkin separuh token, sehingga
 *      tidak lagi cocok dengan polanya) dibuang, begitu juga kutip yang belum tertutup di baris terakhir.
 */
export function prepareText(value, max) {
  return prepare(value, max, true);
}

/** Isi prepareText. `redactHidden` = false melewati stripControlRedacting (hanya untuk programName). */
function prepare(value, max, redactHidden) {
  const raw = String(value ?? '');
  const head = raw.length > max * 4 ? raw.slice(0, max * 4) : raw;
  const text = head.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\t\v\f]/g, ' ').replace(MASK_RE, '');
  let s = stripControl(text);
  if (redactHidden && s !== text) s = stripControlRedacting(text);
  let cut = head.length < raw.length;
  if (s.length > max) {
    s = s.slice(0, max);
    cut = true;
  }
  if (!cut) return s;
  let end = s.length;
  while (end > 0 && !/\s/.test(s[end - 1])) end--;
  return dropUnclosedQuote(s.slice(0, end));
}

/** Ambil semua teks dari tool_response (bentuknya bisa string, array content, atau objek). */
export function extractText(value, depth = 0) {
  if (value == null || depth > 6) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => extractText(v, depth + 1)).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (typeof value.text === 'string') return value.text;
    const parts = [];
    for (const key of ['content', 'result', 'output', 'message', 'response']) {
      if (key in value) parts.push(extractText(value[key], depth + 1));
    }
    return parts.filter(Boolean).join('\n');
  }
  return '';
}

// Penanda STATUS harus berada di awal baris; di depannya hanya boleh spasi, "#", ">", "-", atau "*"
// (mis. "STATUS: SELESAI", "**STATUS: BUTUH BANTUAN**", "> STATUS: DONE", "## STATUS:** SELESAI").
// Kutipan di tengah kalimat (mis. 'Laporan "STATUS: BUTUH BANTUAN" tampil ...') bukan penanda.
const STATUS_LINE = /^[\s#>*-]*STATUS\s*:\s*(?:\*+\s*)?(BUTUH\s+BANTUAN|BLOCKED|MENTOK|SELESAI|DONE)\b/i;

/**
 * "blocked" | "done" | "unknown" dari penanda STATUS PERTAMA yang berada di awal baris.
 * Baris "STATUS:" dengan nilai lain (mis. "Status: 200") bukan penanda dan dilewati.
 */
export function parseStatus(text) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = STATUS_LINE.exec(line);
    if (m) return /^(SELESAI|DONE)$/i.test(m[1]) ? 'done' : 'blocked';
  }
  return 'unknown';
}

/**
 * Ringkasan satu baris dari laporan (tanpa baris STATUS dan tanpa markdown).
 * Bila baris terpilih diakhiri titik dua (mis. "Kedua bug sudah diperbaiki:"), baris berikutnya
 * ikut digabung supaya ringkasan tidak berhenti di titik dua.
 * Teks mentah (setelah prepareText: dipotong SCAN_CHARS, ANSI/kontrol/bidi dibuang) diredaksi DULU
 * (sebelum "_" dan "*" markdown dibuang, yang bisa merusak pola seperti ghp_..., dan sebelum dipotong
 * per baris, supaya blok kunci privat multi-baris ikut tertutup), lalu diredaksi sekali lagi setelah
 * markdown dibuang (mis. "**password**: x" baru terlihat sesudahnya).
 */
export function summarize(text, max = 180) {
  const lines = redactSecrets(prepareText(text, SCAN_CHARS))
    .split(/\r?\n/)
    .map((l) => l.replace(/[`*_>#|]/g, '').replace(/^\s*[-+]\s+/, '').replace(/^\s*\d+\.\s+/, '').trim())
    // Baris sudah di-trim, jadi "\s*$" di akhir tidak perlu (dua "\s*" berdampingan dulu kuadratik).
    .filter((l) => l && !/^STATUS\s*:/i.test(l) && !/^ringkasan\s*:?$/i.test(l) && !/^-{3,}$/.test(l));
  let first = (lines[0] ?? '').replace(/^ringkasan\s*[:\-–—]\s*/i, '');
  if (first.endsWith(':') && lines.length > 1) first = `${first} ${lines[1]}`;
  return truncate(redactSecrets(first.replace(/\s+/g, ' ')), max);
}

const base = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

/**
 * Nama program pertama dari perintah shell, tanpa argumen: "npm test" → "npm",
 * "FOO=rahasia ./node_modules/.bin/vitest run" → "vitest", '& "C:\x\node.exe" -v' → "node.exe".
 * Penugasan variabel di depan dilewati (nilainya bisa rahasia). Nama yang tidak tampak seperti nama
 * program (mis. "$env:X=...") menghasilkan '' sehingga yang tampil hanya nama tool.
 */
export function programName(command) {
  const name = firstProgramWord(prepareText(command, LINE_CHARS));
  // prepareText bisa sudah menyensor nama program (mis. token yang diawali urutan ANSI). Aturan panjang
  // tetap sama seperti tanpa sensor: penanda REDACTED hanya tampil bila nama aslinya lolos aturan nama
  // program (maks 40 karakter); selain itu kosong (yang tampil hanya nama tool).
  if (name.includes(REDACTED)) return PROGRAM_NAME_RE.test(firstProgramWord(prepare(command, LINE_CHARS, false))) ? REDACTED : '';
  return PROGRAM_NAME_RE.test(name) ? name : '';
}

const PROGRAM_NAME_RE = /^[\w.+-]{1,40}$/;

/** Kata pertama (basename) dari perintah yang sudah disiapkan, setelah penugasan variabel di depan dilewati. */
function firstProgramWord(prepared) {
  let s = prepared;
  for (let guard = 0; guard < 20; guard++) {
    s = s.replace(/^[\s({!&]+/, '');
    const m = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)/.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  let word;
  if (s[0] === '"' || s[0] === "'") {
    const end = s.indexOf(s[0], 1);
    word = s.slice(1, end < 0 ? undefined : end);
  } else {
    word = s.split(/[\s;|&<>()]/)[0];
  }
  return base(word);
}

/**
 * Deskripsi singkat pemakaian tool, mis. "Edit · App.jsx". Sengaja minim data:
 *   Bash/PowerShell → description; kalau kosong, nama program pertama saja (bukan perintah lengkap)
 *   Read/Write/Edit → nama file (basename)      WebFetch → host saja
 *   Grep/Glob/WebSearch dan tool lain → nama tool saja (tanpa pola/kueri)
 */
export function describeTool(toolName, input = {}) {
  const i = input && typeof input === 'object' ? input : {};
  let detail = '';
  switch (toolName) {
    case 'Bash':
    case 'PowerShell': {
      const desc = typeof i.description === 'string' ? prepareText(i.description, LINE_CHARS) : '';
      detail = desc.trim() ? desc : programName(i.command);
      break;
    }
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      // Hanya bagian akhir path yang dibutuhkan (basename). Normalisasi DULU, baru dipecah per "/" atau
      // "\": urutan OSC (mis. hyperlink "ESC]8;;https://…") memuat "/" dan harus dibuang utuh.
      detail = base(prepareText(String(i.file_path || i.notebook_path || '').slice(-SCAN_CHARS), SCAN_CHARS));
      break;
    case 'WebFetch':
      try {
        detail = new URL(String(i.url ?? '').slice(0, SCAN_CHARS)).host;
      } catch {
        detail = '';
      }
      break;
    default:
      detail = '';
  }
  detail = redactSecrets(String(detail).replace(/\s+/g, ' ').trim());
  return truncate(detail ? `${toolName} · ${detail}` : toolName, 120);
}

/** Nama agen apa pun → nama yang lolos validasi event (huruf kecil, tanpa spasi, maks 64). */
export function safeName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 64);
}

const agentOf = (input) => safeName(typeof input.agent_type === 'string' ? input.agent_type : '');
const subagentOf = (toolInput) => safeName(toolInput?.subagent_type) || 'general-purpose';

/**
 * Pesan assign dari tool Agent: `description` (diredaksi, maks 200); kalau kosong, baris pertama
 * yang tidak kosong dari prompt SETELAH seluruh prompt diredaksi, dipotong 80 karakter.
 */
export function assignMessage(toolInput) {
  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const desc = typeof ti.description === 'string' ? prepareText(ti.description, LINE_CHARS).replace(/\s+/g, ' ').trim() : '';
  if (desc) return truncate(redactSecrets(desc), 200);
  const prompt = typeof ti.prompt === 'string' ? redactSecrets(prepareText(ti.prompt, SCAN_CHARS)) : '';
  const line = prompt.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).find(Boolean) ?? '';
  return line ? truncate(line, 80) : '';
}

/**
 * Nama proyek untuk event: basename folder (mis. "C:\Users\x\ai-office" → "ai-office"), dibersihkan
 * seperti nama file di describeTool dan diredaksi, maks 64 karakter. '' bila tidak ada.
 */
export function projectName(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return '';
  const name = base(prepareText(dir.slice(-SCAN_CHARS), SCAN_CHARS));
  return truncate(redactSecrets(name.replace(/\s+/g, ' ').trim()), 64);
}

function makeEvent(raw, now, extra = {}) {
  const r = normalizeEvent({ ...raw, ...extra, source: 'hook' }, { now });
  return r.ok ? [r.event] : [];
}

/**
 * @param {object} input JSON stdin dari hook Claude Code
 * @returns {object[]} event AI Office (0..n)
 */
export function mapHookToEvents(input, { now = () => new Date(), projectDir, tokens } = {}) {
  if (!input || typeof input !== 'object') return [];
  const hook = input.hook_event_name;
  const agent = agentOf(input);
  const project = projectName(typeof projectDir === 'string' && projectDir.trim() ? projectDir : input.cwd);
  const extra = project ? { project } : {};
  const make = (raw, nowFn, more = {}) => makeEvent(raw, nowFn, { ...extra, ...more });

  switch (hook) {
    case 'PreToolUse': {
      const tool = input.tool_name;
      if (SUBAGENT_TOOLS.has(tool)) {
        const ti = input.tool_input ?? {};
        const to = subagentOf(ti);
        return make({ type: 'assign', from: 'manager', to, message: assignMessage(ti) || `Tugas untuk ${to}` }, now);
      }
      if (typeof tool !== 'string' || !tool) return [];
      if (tool === HANDBACK_TOOL) {
        // Status (done/blocked) baru dikirim saat SubagentStop, supaya tidak dobel.
        return make({ type: 'working', from: agent || 'manager', to: agent ? 'manager' : 'ceo', message: 'Menyerahkan laporan ke manajer' }, now);
      }
      return make(
        { type: 'working', from: agent || 'manager', to: agent ? 'manager' : 'ceo', message: describeTool(tool, input.tool_input) },
        now,
      );
    }
    case 'PostToolUse': {
      if (!SUBAGENT_TOOLS.has(input.tool_name)) return [];
      if (isAsyncLaunch(input.tool_response)) return []; // agen latar belakang baru diluncurkan
      const ti = input.tool_input ?? {};
      const from = subagentOf(ti);
      const text = extractText(input.tool_response);
      const status = parseStatus(text);
      return make(
        { type: status === 'blocked' ? 'blocked' : 'report', from, to: 'manager', message: summarize(text) || 'Laporan diterima manajer.' },
        now,
      );
    }
    case 'SubagentStart':
      if (!agent) return [];
      return make({ type: 'working', from: agent, to: 'manager', message: 'Mulai mengerjakan tugas' }, now);
    case 'SubagentStop': {
      if (!agent) return []; // agen internal Claude Code (prompt suggestion, /btw, dll.)
      const text = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
      const status = parseStatus(text);
      return make(
        {
          type: status === 'blocked' ? 'blocked' : 'done',
          from: agent,
          to: 'manager',
          message: summarize(text) || (status === 'blocked' ? 'Butuh bantuan' : 'Tugas selesai'),
        },
        now,
        tokens && typeof tokens === 'object' ? { tokens } : {},
      );
    }
    default:
      return [];
  }
}
