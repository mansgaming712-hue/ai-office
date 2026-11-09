// Utilitas bersama untuk membaca dan memvalidasi file agen (frontmatter YAML).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

export const REPO_AGENTS_DIR = fileURLToPath(new URL('../agents/', import.meta.url));
export const USER_AGENTS_DIR = join(homedir(), '.claude', 'agents');

// Tool bawaan Claude Code yang boleh dipakai spesialis.
// Agent/Task sengaja TIDAK ada: spesialis tidak boleh memanggil agen lain.
export const ALLOWED_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'WebSearch', 'WebFetch', 'NotebookEdit',
]);

// Model yang boleh dipakai spesialis. Model termahal (opus) sengaja dilarang untuk worker.
export const ALLOWED_MODELS = new Set(['haiku', 'sonnet']);

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
    return { error: `YAML frontmatter tidak valid: ${e.message}` };
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

  for (const key of ['name', 'description', 'tools', 'model']) {
    if (typeof data[key] !== 'string' || !data[key].trim()) errors.push(`field "${key}" wajib berupa teks`);
  }
  const name = data.name;
  if (typeof name === 'string') {
    if (!AGENT_NAME_RE.test(name)) errors.push(`name "${name}" harus kebab-case huruf kecil/angka`);
    if (basename(fileName, '.md') !== name) errors.push(`nama file (${fileName}) tidak sama dengan name (${name})`);
  }
  if (typeof data.model === 'string' && data.model.trim() && !ALLOWED_MODELS.has(data.model.trim())) {
    errors.push(`model "${data.model}" tidak diizinkan (hanya: ${[...ALLOWED_MODELS].join(', ')})`);
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

/** Baca semua *.md di sebuah folder: [{ fileName, path, text }]. */
export function readAgentDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => ({ fileName: f, path: join(dir, f), text: readFileSync(join(dir, f), 'utf8') }));
}

/** Ambil `name` dari frontmatter tanpa memvalidasi (untuk cek nama bentrok dengan agen lain). */
export function agentNameOf(text) {
  const parsed = parseAgentFile(text);
  return parsed.error ? null : (parsed.data.name ?? null);
}
