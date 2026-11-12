// Penjaga: tidak boleh ada literal lengkap berbentuk rahasia di file yang dilacak git.
// Alasan: GitHub Push Protection menolak push bila string contoh (token palsu sekalipun) cocok dengan
// pola penyedia. Di test, rangkai nilai saat runtime lewat glue() dari tests/helpers/testkit.js
// (contoh: glue('AK', 'IA', ...)) sehingga literal lengkapnya tidak pernah tertulis di berkas.
// Regex di bawah dibangun dari potongan string, dan test terakhir membuktikan bahwa berkas ini sendiri bersih.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT, glue } from './helpers/testkit.js';

const alnum = '[A-Za-z0-9]';
const word = '[A-Za-z0-9_-]';

/** Nama pola -> regex. Panjang minimum dibuat sedikit lebih longgar dari token asli supaya token palsu pun tertangkap. */
export const PATTERNS = {
  'GitHub token (gh?_)': new RegExp(`\\bgh[pousr]_${alnum}{20,}`),
  'GitHub fine-grained PAT': new RegExp(`github_pat_${word}{20,}`),
  'GitLab PAT': new RegExp(`glpat-${word}{16,}`),
  'Anthropic key': new RegExp(`sk-ant-${word}{10,}`),
  'OpenAI project key': new RegExp(`sk-proj-${word}{10,}`),
  'OpenAI/sk- key': new RegExp(`\\bsk-${alnum}{16,}`),
  'Stripe key': new RegExp(`\\b[spr]k_(?:live|test)_${alnum}{10,}`),
  'Slack token': new RegExp(`\\bxox[abposr]-${alnum}[A-Za-z0-9-]{9,}`),
  'AWS access key id': new RegExp(`\\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[0-9A-Z]{16}\\b`),
  'Google API key': new RegExp(`AIza${word}{20,}`),
  'npm token': new RegExp(`\\bnpm_${alnum}{20,}`),
  'Docker PAT': new RegExp(`dckr_pat_${word}{16,}`),
  'Hugging Face / Shopify / Linear': new RegExp(`\\b(?:hf_|shpat_|lin_api_)${alnum}{20,}`),
  'Google OAuth': new RegExp(`\\b(?:ya29\\.|GOCSPX-)${word}{20,}`),
  'SendGrid key': new RegExp(`\\bSG\\.${word}{16,}\\.${word}{16,}`),
  'Stripe webhook secret': new RegExp(`\\bwhsec_${alnum}{20,}`),
  JWT: new RegExp(`eyJ${word}{8,}\\.eyJ${word}{8,}\\.${word}{8,}`),
  'PEM private key header': new RegExp(`-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----`),
  'URL dengan user:password@': new RegExp(`[a-z][a-z0-9+.-]*://[^\\s/:@'"\`$\\\\{}<>]+:[^\\s/@'"\`$\\\\{}<>]+@[\\w.-]+`),
  'Slack webhook': new RegExp(`hooks\\.slack\\.com/(?:services|workflows)/[A-Za-z0-9/_-]{8,}`),
  'Discord webhook': new RegExp(`discord(?:app)?\\.com/api/webhooks/\\d+/${word}{8,}`),
  'Azure storage key': new RegExp(`AccountKey=${'[A-Za-z0-9+/=]'}{20,}`),
};

const SKIP_NAMES = new Set(['package-lock.json']);

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'logs', 'data', 'coverage']);

/** Tanpa git (mis. proyek diunduh sebagai zip): telusuri folder, lewati folder keluaran. */
function walk(dir = '') {
  const files = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) files.push(...walk(rel));
    } else if (e.isFile()) files.push(rel);
  }
  return files;
}

/** Berkas terlacak git (plus yang belum dilacak tetapi tidak diabaikan), dipisah NUL supaya nama aneh aman. */
function trackedFiles() {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const list = out.toString('utf8').split('\0').filter(Boolean);
    if (list.length > 0) return list;
  } catch {
    /* git tidak ada atau bukan repositori: pakai penelusuran folder */
  }
  return walk();
}

/** Cari semua literal berbentuk rahasia. Mengembalikan "berkas:baris [pola]" (tanpa menyertakan nilainya). */
export function scan(files = trackedFiles(), read = (f) => readFileSync(join(ROOT, f))) {
  const hits = [];
  for (const f of files) {
    if (SKIP_NAMES.has(f.split('/').pop())) continue;
    let buf;
    try {
      buf = read(f);
    } catch {
      continue; // berkas terlacak yang sudah dihapus dari disk
    }
    if (buf.includes(0)) continue; // biner
    const lines = buf.toString('utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const [name, re] of Object.entries(PATTERNS)) if (re.test(line)) hits.push(`${f}:${i + 1} [${name}]`);
    });
  }
  return hits;
}

describe('tidak ada literal rahasia di berkas terlacak', () => {
  it('semua berkas teks bersih dari literal berbentuk rahasia (nilai dirangkai saat runtime)', () => {
    expect(scan()).toEqual([]);
  });

  it('pemindai sungguh menangkap tiap pola (nilai uji dirangkai saat runtime, bukan ditulis utuh)', () => {
    const A = 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4';
    const samples = {
      'GitHub token (gh?_)': glue('gh', 'p_', A),
      'GitHub fine-grained PAT': glue('github', '_pat_', A),
      'GitLab PAT': glue('glp', 'at-', A),
      'Anthropic key': glue('sk', '-ant-api03-', A),
      'OpenAI project key': glue('sk', '-proj-', A),
      'OpenAI/sk- key': glue('sk', '-', A),
      'Stripe key': glue('sk', '_live_', A),
      'Slack token': glue('xo', 'xb-', '1234567890-', A),
      'AWS access key id': glue('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
      'Google API key': glue('AI', 'za', A),
      'npm token': glue('np', 'm_', A),
      'Docker PAT': glue('dckr', '_pat_', A),
      'Hugging Face / Shopify / Linear': glue('hf', '_', A),
      'Google OAuth': glue('ya', '29.', A),
      'SendGrid key': glue('S', 'G.', A, '.', A),
      'Stripe webhook secret': glue('wh', 'sec_', A),
      JWT: glue('ey', 'Jhbgcioij9.', 'ey', 'Jzdwiioij9.', 'sigsigsig9'),
      'PEM private key header': glue('-----BEG', 'IN RSA PRIVATE KEY-----'),
      'URL dengan user:password@': glue('postgres://', 'alice:', 'hunter22', '@db.internal/x'),
      'Slack webhook': glue('hooks.sl', 'ack.com/services/T000/B000/', 'abcdefgh1234'),
      'Discord webhook': glue('discord', '.com/api/webhooks/', '123456789/', 'abcdefgh_1234'),
      'Azure storage key': glue('Account', 'Key=', 'abcdefghijklmnopqrstuvwxyz=='),
    };
    expect(Object.keys(samples).sort()).toEqual(Object.keys(PATTERNS).sort());
    for (const [name, text] of Object.entries(samples)) {
      expect(scan(['x.txt'], () => Buffer.from(`pakai ${text} ya`)), name).toEqual([`x.txt:1 [${name}]`]);
    }
  });

  it('bukan positif palsu: nama biasa dan potongan pendek tidak ditandai', () => {
    const ok = [
      'npm_config_cache=/x', 'task_test_suite', 'mask_live_view', 'sk-', 'ghp_', 'glpat-', 'AKIA', 'https://example.com/a:b',
      'http://user@host/', 'postgres://admin:${pw}@db', 'ask-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'AIza',
    ];
    for (const s of ok) expect(scan(['x.txt'], () => Buffer.from(s)), s).toEqual([]);
  });

  it('berkas biner dan package-lock.json dilewati', () => {
    const bad = Buffer.concat([Buffer.from([0]), Buffer.from(glue('gh', 'p_', 'A'.repeat(36)))]);
    expect(scan(['a.png'], () => bad)).toEqual([]);
    expect(scan(['package-lock.json'], () => Buffer.from(glue('gh', 'p_', 'A'.repeat(36))))).toEqual([]);
  });

  it('berkas penjaga ini sendiri tidak cocok dengan regex-nya', () => {
    expect(scan(['tests/noSecretLiterals.test.js'])).toEqual([]);
  });
});
