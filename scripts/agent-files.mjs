// Utilitas bersama untuk membaca dan memvalidasi file agen (frontmatter YAML).
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync, writeFileSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const REPO_AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url));
export const USER_AGENTS_DIR = join(homedir(), '.claude', 'agents');

// Tool bawaan Claude Code yang boleh dipakai spesialis.
// Agent/Task sengaja TIDAK ada: spesialis tidak boleh memanggil agen lain.
export const ALLOWED_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch', 'NotebookEdit', 'TodoWrite',
]);

// Kebijakan agen plugin: hanya tool ini yang dipasang tanpa persetujuan. Tool lain (Bash, PowerShell, WebFetch,
// NotebookEdit, dan yang tidak dikenal) berisiko dan butuh `agents:install --allow-risky-tools`.
export const SAFE_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Write', 'Edit', 'WebSearch', 'TodoWrite']);
export const RISKY_EXIT_CODE = 3; // exit code agents:install bila ada agen plugin berisiko yang dilewati

// Allowlist key frontmatter. Key lain (hooks, mcpServers, permissionMode, ...) bisa memasang hook atau izin
// di ~/.claude, jadi ditolak, baik untuk agen plugin maupun agen bawaan.
export const ALLOWED_FRONTMATTER_KEYS = new Set(['name', 'description', 'tools', 'model']);

/** Daftar tool berisiko (di luar SAFE_TOOLS) dari nilai `tools` frontmatter. */
export function riskyTools(toolsValue) {
  return String(toolsValue ?? '').split(',').map((x) => x.trim()).filter((x) => x && !SAFE_TOOLS.has(x));
}

// Model yang boleh dipakai agen: alias Claude Code, atau ID model lengkap (regex ketat). Satu sumber untuk
// validator dan test. Nilai dibandingkan apa adanya (tanpa trim): huruf besar, spasi, dan newline ditolak.
// Default agen bawaan tetap sonnet/haiku; alias lain hanya boleh dipilih secara eksplisit.
export const MODEL_ALIASES = ['sonnet', 'haiku', 'opus', 'inherit', 'fable'];
export const ALLOWED_MODELS = new Set(MODEL_ALIASES);
export const MODEL_ID_RE = /^claude-[a-z0-9.-]{3,60}$/;
export const isAllowedModel = (m) => typeof m === 'string' && (ALLOWED_MODELS.has(m) || MODEL_ID_RE.test(m));

// Nama agen: huruf kecil/angka di depan (divisi 3D: "3d-modeler"), lalu huruf kecil, angka, atau "-".
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export const REQUIRED_RULE_PHRASES = [
  'Fokus hanya pada keahlianmu',
  'berhenti dan laporkan ke manajer apa yang kurang dan agen siapa yang dibutuhkan',
  'Jangan mencoba memanggil agen lain',
  'STATUS: SELESAI',
  'STATUS: BUTUH BANTUAN',
];

export function parseAgentFile(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) return { error: 'frontmatter tidak ditemukan (harus diawali dan ditutup ---)' };
  let data;
  try {
    data = parseYaml(m[1]);
  } catch (e) {
    // Pesan asli parser memuat potongan isi file; hanya nomor baris (file: frontmatter mulai di baris 2) yang dipakai.
    const line = Number(e?.linePos?.[0]?.line);
    return { error: Number.isInteger(line) && line > 0 ? `YAML frontmatter tidak valid (baris ${line + 1})` : 'YAML frontmatter tidak valid' };
  }
  if (!data || typeof data !== 'object') return { error: 'frontmatter kosong' };
  return { data, body: m[2] };
}

/** Validasi satu file agen. Mengembalikan { errors, data } (errors kosong = valid). */
export function validateAgent(fileName, text) {
  const errors = [];
  const parsed = parseAgentFile(text);
  if (parsed.error) return { errors: [parsed.error], data: null };
  const { data, body } = parsed;

  for (const key of Object.keys(data)) {
    if (!ALLOWED_FRONTMATTER_KEYS.has(key)) {
      errors.push(`key frontmatter "${String(key).replace(/[^ -~]/g, '?').slice(0, 40)}" tidak diizinkan (hanya: ${[...ALLOWED_FRONTMATTER_KEYS].join(', ')})`);
    }
  }

  for (const key of ['name', 'description', 'tools', 'model']) {
    if (typeof data[key] !== 'string' || !data[key].trim()) errors.push(`field "${key}" wajib berupa teks`);
  }
  const name = data.name;
  if (typeof name === 'string') {
    if (!AGENT_NAME_RE.test(name)) errors.push(`name "${name}" harus kebab-case huruf kecil/angka`);
    if (basename(fileName, '.md') !== name) errors.push(`nama file (${fileName}) tidak sama dengan name (${name})`);
  }
  if (typeof data.model === 'string' && data.model.trim() && !isAllowedModel(data.model)) {
    // Nilai dicetak aman (ASCII tercetak, dipotong) karena bisa berisi newline atau teks panjang.
    const shown = data.model.replace(/[^ -~]/g, '?').slice(0, 70);
    errors.push(`model "${shown}" tidak diizinkan (hanya: ${MODEL_ALIASES.join(', ')}, atau ID model lengkap yang cocok ${MODEL_ID_RE})`);
  }
  if (typeof data.description === 'string' && data.description.length < 80) {
    errors.push('description terlalu pendek untuk dipilih otomatis oleh manajer (< 80 karakter)');
  }
  if (typeof data.tools === 'string') {
    const tools = data.tools.split(',').map((t) => t.trim()).filter(Boolean);
    if (!tools.length) errors.push('tools kosong');
    for (const t of tools) if (!ALLOWED_TOOLS.has(t)) errors.push(`tool tidak dikenal/dilarang: ${t}`);
    if (new Set(tools).size !== tools.length) errors.push('tools berisi duplikat');
  }
  for (const phrase of REQUIRED_RULE_PHRASES) {
    if (!body.includes(phrase)) errors.push(`aturan spesialis tidak lengkap, frasa hilang: "${phrase}"`);
  }
  return { errors, data };
}

/**
 * Baca semua *.md di sebuah folder: [{ fileName, path, text }]. Hanya file biasa (lstat, symlink tidak diikuti).
 * Default: entri non-file (symlink, direktori bernama *.md) dilewati diam-diam. Dengan { strict: true } entri itu
 * dikembalikan sebagai { fileName, path, text: '', nonFile: true } supaya installer bisa menolaknya dengan jelas.
 */
export function readAgentDir(dir, { strict = false } = {}) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const path = join(dir, f);
    let st = null;
    try { st = lstatSync(path); } catch { /* hilang di antara list dan lstat */ }
    if (st?.isFile()) out.push({ fileName: f, path, text: readFileSync(path, 'utf8') });
    else if (strict) out.push({ fileName: f, path, text: '', nonFile: true });
  }
  return out;
}

/**
 * Validasi SEMUA agen di folder sumber sebelum ada yang ditulis: validateAgent per file, entri non-file, nama
 * duplikat, dan folder kosong/tidak ada. Mengembalikan { ok, files, errors: [{ fileName, error }] }.
 */
export function checkAgentSet(dir) {
  const files = readAgentDir(dir, { strict: true });
  const errors = [];
  if (!files.length) return { ok: false, files, errors: [{ fileName: dir, error: 'tidak ada file agen (*.md) di folder ini' }] };
  const names = new Map();
  for (const f of files) {
    if (f.nonFile) { errors.push({ fileName: f.fileName, error: 'bukan file biasa (symlink atau direktori), ditolak' }); continue; }
    for (const error of validateAgent(f.fileName, f.text).errors) errors.push({ fileName: f.fileName, error });
    const name = agentNameOf(f.text);
    if (typeof name === 'string') {
      if (names.has(name)) errors.push({ fileName: f.fileName, error: `nama "${name}" dipakai dua kali (${names.get(name)} dan ${f.fileName})` });
      else names.set(name, f.fileName);
    }
  }
  return { ok: !errors.length, files, errors };
}

/** Ambil `name` dari frontmatter tanpa memvalidasi (untuk cek nama bentrok dengan agen lain). */
export function agentNameOf(text) {
  const parsed = parseAgentFile(text);
  return parsed.error ? null : (parsed.data.name ?? null);
}

// Manifest pemasangan: ~/.claude/agents/.ai-office-installed.json = { version: 1, files: { "<nama>.md": "<sha256>" } }.
// Hanya file yang tercatat di sini (dan isinya belum diubah pengguna) boleh ditimpa oleh `agents:install --force`.
export const INSTALL_MANIFEST = '.ai-office-installed.json';
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

const cleanHashMap = (obj) => {
  const out = Object.create(null);
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    for (const [k, v] of Object.entries(obj)) {
      if (/^[a-z0-9][a-z0-9-]*.md$/.test(k) && typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)) out[k] = v;
    }
  }
  return out;
};

/**
 * Baca manifest: { files, approvedRisky }. Rusak atau tidak ada = kosong. Hanya entri berbentuk nama file .md
 * dan hash hex 64 karakter yang dipakai (berlaku untuk files dan approvedRisky).
 * approvedRisky = persetujuan --allow-risky-tools yang terikat ke isi file (hash), bukan ke nama.
 */
export function readInstallManifestFull(dir) {
  try {
    const data = JSON.parse(readFileSync(join(dir, INSTALL_MANIFEST), 'utf8'));
    if (data && typeof data === 'object') return { files: cleanHashMap(data.files), approvedRisky: cleanHashMap(data.approvedRisky) };
  } catch {
    // tidak ada atau rusak: anggap belum ada yang tercatat
  }
  return { files: cleanHashMap(null), approvedRisky: cleanHashMap(null) };
}

/** Hanya bagian files dari manifest (lihat readInstallManifestFull). */
export const readInstallManifest = (dir) => readInstallManifestFull(dir).files;

export function writeInstallManifest(dir, files, approvedRisky = {}) {
  writeFileSync(join(dir, INSTALL_MANIFEST), `${JSON.stringify({ version: 1, files: { ...files }, approvedRisky: { ...approvedRisky } }, null, 2)}
`);
}

/**
 * Klasifikasi gagal-tertutup untuk kebijakan tool: agen yang tidak lolos validateAgent (atau tanpa data) TIDAK
 * dianggap aman. Hasil: { ok: false, reason } atau { ok: true, tools, risky }.
 */
export function classifyAgent(fileName, text) {
  let r;
  try {
    r = validateAgent(fileName, text);
  } catch {
    return { ok: false, reason: 'validasi gagal dijalankan' };
  }
  if (!r || !Array.isArray(r.errors) || r.errors.length || !r.data || typeof r.data.tools !== 'string') {
    return { ok: false, reason: r?.errors?.[0] ?? 'data frontmatter tidak ada' };
  }
  return { ok: true, tools: r.data.tools, risky: riskyTools(r.data.tools) };
}
