// scripts/setup.mjs (npm run setup): urutan langkah, --no-claude, --dry-run, gagal = exit bukan 0.
// Perintah dijalankan lewat `run` tiruan: tidak ada npm ci/build/pemasangan hook sungguhan.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { npmInvocation, parseArgs, runSetup } from '../scripts/setup.mjs';
import { ROOT, cleanEnv, runNode } from './helpers/testkit.js';

const NPM = { command: 'NPM', prefix: ['CLI'], shell: false };

async function setup(argv, { fail = null, claude = { found: true, version: '2.0.0 (Claude Code)' }, nodeVersion } = {}) {
  const out = [];
  const errs = [];
  const calls = [];
  const code = await runSetup(argv, {
    npm: NPM,
    nodeVersion,
    projectDir: ROOT,
    run: async (command, args, o) => {
      calls.push({ command, args, cwd: o.cwd, shell: o.shell });
      const cmd = args.slice(1).join(' ');
      if (fail && cmd === fail.cmd) return fail.result;
      return { status: 0, error: null };
    },
    detect: async () => claude,
    log: (m) => out.push(m),
    err: (m) => errs.push(m),
  });
  return { code, out: out.join('\n'), err: errs.join('\n'), calls };
}

describe('npm run setup', () => {
  it('urutan: npm ci, build, agents:install, hooks:install-user, lalu deteksi CLI; exit 0', async () => {
    const r = await setup([]);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.args.slice(1).join(' '))).toEqual(['ci', 'run build', 'run agents:install', 'run hooks:install-user']);
    expect(r.calls.every((c) => c.command === 'NPM' && c.args[0] === 'CLI' && c.cwd === ROOT && c.shell === false)).toBe(true);
    expect(r.out).toMatch(/\[1\/6\] Memeriksa versi Node\.js/);
    expect(r.out).toMatch(/\[6\/6\] Mendeteksi Claude Code CLI/);
    expect(r.out).toMatch(/Claude Code CLI ditemukan: 2\.0\.0 \(Claude Code\)/);
    expect(r.out).toMatch(/Setup selesai\./);
    expect(r.out).toMatch(/npm start/);
    expect(r.out).toMatch(/npm run open/);
  });

  it('CLI tidak ada: setup tetap sukses, status dan langkah berikutnya dicetak', async () => {
    const r = await setup([], { claude: { found: false, version: null } });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Claude Code CLI tidak ditemukan di PATH/);
    expect(r.out).toMatch(/AI_OFFICE_CLAUDE_BIN/);
    expect(r.out).toMatch(/mode demo tetap bisa dipakai/);
  });

  it('--no-claude: melewati agen, hook, dan deteksi CLI', async () => {
    const r = await setup(['--no-claude']);
    expect(r.code).toBe(0);
    expect(r.calls.map((c) => c.args.slice(1).join(' '))).toEqual(['ci', 'run build']);
    expect(r.out).toMatch(/\[3\/3\] Membangun UI/);
    expect(r.out).toMatch(/Dilewati \(--no-claude\)/);
    expect(r.out).toMatch(/npm run agents:install && npm run hooks:install-user/);
    expect(r.out).not.toMatch(/Mendeteksi Claude Code CLI/);
  });

  it.each([
    ['ci', 'npm ci'],
    ['run build', 'Membangun UI'],
    ['run agents:install', 'Memasang agen'],
    ['run hooks:install-user', 'Memasang hook'],
  ])('gagal di "%s": pesan jelas, exit 1, langkah berikutnya tidak dijalankan', async (cmd, name) => {
    const r = await setup([], { fail: { cmd, result: { status: 2, error: null } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(new RegExp(`GAGAL di langkah ".*${name}.*": perintah keluar dengan kode 2\\. Setup dihentikan\\.`));
    const ran = r.calls.map((c) => c.args.slice(1).join(' '));
    expect(ran.at(-1)).toBe(cmd);
    expect(r.out).not.toMatch(/Setup selesai/);
  });

  it('perintah tidak bisa dijalankan (ENOENT): exit 1', async () => {
    const r = await setup([], { fail: { cmd: 'ci', result: { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) } } });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/tidak bisa dijalankan \(ENOENT\)/);
    expect(r.calls).toHaveLength(1);
  });

  it('Node terlalu lama: berhenti di langkah 1, tidak menjalankan apa pun, exit 1', async () => {
    const r = await setup([], { nodeVersion: '18.19.0' });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.err).toMatch(/membutuhkan Node\.js 22\.12/);
    expect(r.err).toMatch(/GAGAL di langkah/);
  });

  it('--dry-run: mencetak rencana, tidak menjalankan apa pun', async () => {
    const r = await setup(['--dry-run']);
    expect(r.code).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.out).toMatch(/\[dry-run\] akan menjalankan: npm ci/);
    expect(r.out).toMatch(/\[dry-run\] akan menjalankan: npm run hooks:install-user/);
  });

  it('opsi tidak dikenal: exit 2 dengan bantuan', async () => {
    const r = await setup(['--aneh']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Opsi tidak dikenal: --aneh/);
    expect(r.err).toMatch(/Pemakaian: node scripts\/setup\.mjs/);
    expect(r.calls).toEqual([]);
  });

  it('pesan berbahasa Inggris dengan AI_OFFICE_LANG=en', async () => {
    const prev = process.env.AI_OFFICE_LANG;
    process.env.AI_OFFICE_LANG = 'en';
    try {
      const r = await setup([], { fail: { cmd: 'run build', result: { status: 1, error: null } } });
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/Setting up AI Office/);
      expect(r.err).toMatch(/FAILED at step "Building the UI \(npm run build\)": the command exited with code 1\. Setup stopped\./);
    } finally {
      process.env.AI_OFFICE_LANG = prev;
    }
  });

  it('parseArgs', () => {
    expect(parseArgs(['--no-claude', '--dry-run'])).toMatchObject({ noClaude: true, dryRun: true, error: null });
    expect(parseArgs(['x']).error).toMatch(/x/);
  });

  it('npmInvocation: npm_execpath .js dipakai lewat node tanpa shell; Windows tanpa npm-cli.js memakai npm.cmd dengan shell', () => {
    const exists = (p) => p === '/n/npm-cli.js';
    expect(npmInvocation({ env: { npm_execpath: '/n/npm-cli.js' }, execPath: '/usr/bin/node', exists })).toEqual({ command: '/usr/bin/node', prefix: ['/n/npm-cli.js'], shell: false });
    expect(npmInvocation({ env: {}, platform: 'win32', execPath: 'C:\\node\\node.exe', exists: () => false })).toEqual({ command: 'npm.cmd', prefix: [], shell: true });
    expect(npmInvocation({ env: {}, platform: 'linux', execPath: '/usr/bin/node', exists: () => false })).toEqual({ command: 'npm', prefix: [], shell: false });
    expect(npmInvocation({ env: { npm_execpath: '/n/npm.exe' }, platform: 'linux', execPath: '/usr/bin/node', exists: () => true }).prefix[0]).toMatch(/npm-cli\.js$/);
  });

  it('proses nyata: node scripts/setup.mjs --dry-run keluar 0 tanpa menjalankan npm', async () => {
    const r = await runNode([join(ROOT, 'scripts', 'setup.mjs'), '--dry-run', '--no-claude'], { env: cleanEnv() });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[dry-run\] akan menjalankan: npm run build/);
    const bad = await runNode([join(ROOT, 'scripts', 'setup.mjs'), '--aneh'], { env: cleanEnv({ AI_OFFICE_LANG: 'en' }) });
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/Unknown option: --aneh/);
  });

  it('package.json: perintah setup dan open terdaftar', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.setup).toBe('node scripts/setup.mjs');
    expect(pkg.scripts.open).toBe('node scripts/open.mjs');
    expect(pkg.scripts.start).toBe('node server/index.js');
    expect(pkg.scripts.prestart).toBe('npm run build');
  });
});
