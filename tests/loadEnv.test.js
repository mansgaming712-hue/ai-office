// server/loadEnv.js: memuat .env proyek tanpa menimpa env yang sudah ada.
// Semua file .env di sini ada di folder sementara; .env asli di root proyek tidak pernah dibuat/dibaca/diubah.
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadProjectEnv } from '../server/loadEnv.js';
import { ROOT, captureServer, cleanEnv, runNode } from './helpers/testkit.js';

const TMP = mkdtempSync(join(tmpdir(), 'aio-loadenv-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
const envFile = (content) => {
  const file = join(TMP, `env-${++n}`);
  writeFileSync(file, content);
  return file;
};

const KEYS = ['AIO_TEST_LOAD_A', 'AIO_TEST_LOAD_B', 'AIO_TEST_LOAD_SECRET'];
const clearKeys = () => KEYS.forEach((k) => delete process.env[k]);
afterEach(() => {
  clearKeys();
  vi.restoreAllMocks();
});

describe('loadProjectEnv (in-proses)', () => {
  it('memuat nilai .env ke process.env dan mengembalikan true', () => {
    const file = envFile('AIO_TEST_LOAD_A=satu\nAIO_TEST_LOAD_B="dua tiga"\n');
    expect(loadProjectEnv({ file })).toBe(true);
    expect(process.env.AIO_TEST_LOAD_A).toBe('satu');
    expect(process.env.AIO_TEST_LOAD_B).toBe('dua tiga');
  });

  it('env yang sudah ada TIDAK ditimpa, yang belum ada tetap diisi', () => {
    process.env.AIO_TEST_LOAD_A = 'dari-shell';
    const file = envFile('AIO_TEST_LOAD_A=dari-file\nAIO_TEST_LOAD_B=baru\n');
    expect(loadProjectEnv({ file })).toBe(true);
    expect(process.env.AIO_TEST_LOAD_A).toBe('dari-shell');
    expect(process.env.AIO_TEST_LOAD_B).toBe('baru');
  });

  it('nilai kosong di shell (string kosong) juga dianggap sudah ada dan tidak ditimpa', () => {
    process.env.AIO_TEST_LOAD_A = '';
    expect(loadProjectEnv({ file: envFile('AIO_TEST_LOAD_A=dari-file\n') })).toBe(true);
    expect(process.env.AIO_TEST_LOAD_A).toBe('');
  });

  it('file tidak ada: false, tanpa melempar dan tanpa output', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(loadProjectEnv({ file: join(TMP, 'tidak-ada', '.env') })).toBe(false);
    expect(err).not.toHaveBeenCalled();
  });

  it('path berupa folder: tidak crash (false atau true), tanpa melempar', () => {
    const dir = join(TMP, 'sebuah-folder');
    mkdirSync(dir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => loadProjectEnv({ file: dir })).not.toThrow();
  });

  it('.env kosong: true dan tidak mengubah apa pun', () => {
    expect(loadProjectEnv({ file: envFile('') })).toBe(true);
    for (const k of KEYS) expect(process.env[k]).toBeUndefined();
  });

  it('process.loadEnvFile tidak tersedia: dilewati (false) tanpa output dan env tidak berubah', () => {
    const orig = process.loadEnvFile;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.loadEnvFile = undefined;
    try {
      expect(loadProjectEnv({ file: envFile('AIO_TEST_LOAD_A=x\n') })).toBe(false);
    } finally {
      process.loadEnvFile = orig;
    }
    expect(process.env.AIO_TEST_LOAD_A).toBeUndefined();
    expect(err).not.toHaveBeenCalled();
  });

  it('.env rusak: false, tidak crash, stderr tidak memuat isi file', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Isi rusak sengaja dibuat; node melempar untuk file yang tidak bisa diurai (mis. byte NUL / format tak valid).
    const SECRET = 'RAHASIA-JANGAN-BOCOR-12345';
    const bad = envFile(`AIO_TEST_LOAD_SECRET=${SECRET}\n\0\0=\n"tidak ditutup ${SECRET}\n`);
    const orig = process.loadEnvFile;
    // Paksa jalur rusak secara deterministik (parser Node cenderung toleran): lempar error yang membawa isi file.
    process.loadEnvFile = () => {
      throw Object.assign(new SyntaxError(`format salah: ${SECRET}`), { code: 'ERR_INVALID_ARG_VALUE' });
    };
    let r;
    try {
      r = loadProjectEnv({ file: bad });
    } finally {
      process.loadEnvFile = orig;
    }
    expect(r).toBe(false);
    expect(err).toHaveBeenCalledTimes(1);
    const msg = err.mock.calls.flat().join(' ');
    expect(msg).toMatch(/\.env/);
    expect(msg).not.toContain(SECRET);
  });

  it('quiet: true membuat .env rusak benar-benar senyap', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const orig = process.loadEnvFile;
    process.loadEnvFile = () => {
      throw new Error('rusak');
    };
    try {
      expect(loadProjectEnv({ file: envFile('x'), quiet: true })).toBe(false);
    } finally {
      process.loadEnvFile = orig;
    }
    expect(err).not.toHaveBeenCalled();
  });
});

describe('loadProjectEnv: .env rusak sungguhan (proses node terpisah)', () => {
  it('file biner/rusak dari parser asli Node: tidak crash dan stderr tanpa isi file', async () => {
    const SECRET = 'RAHASIA-BIN-98765';
    const bad = envFile(`AIO_TEST_LOAD_SECRET=${SECRET}\n\0\x01\x02 =\n'${SECRET}\n`);
    const script = `import { loadProjectEnv } from ${JSON.stringify(new URL('../server/loadEnv.js', import.meta.url).href)};
const r = loadProjectEnv({ file: ${JSON.stringify(bad)} });
console.log('hasil=' + r);`;
    const file = join(TMP, 'probe.mjs');
    writeFileSync(file, script);
    const r = await runNode([file], { env: cleanEnv() });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/hasil=(true|false)/);
    expect(r.err).not.toContain(SECRET);
    expect(r.out).not.toContain(SECRET);
  });
});

describe('hooks/send-event.mjs memuat .env (proses nyata, salinan proyek di folder sementara)', () => {
  // ENV_FILE selalu <root>/.env relatif ke server/loadEnv.js. Agar tidak menyentuh .env asli di root proyek,
  // hook dijalankan dari salinan hooks/, server/, shared/ di folder temp, dengan .env sementara di rootnya.
  let proj;
  let cap;
  const ASSIGN = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-backend', description: 'Uji .env' } };
  const payload = JSON.stringify({ session_id: 'test', transcript_path: 'main.jsonl', cwd: ROOT, permission_mode: 'default', ...ASSIGN });

  beforeAll(async () => {
    proj = join(TMP, 'proj');
    mkdirSync(proj);
    for (const d of ['hooks', 'server', 'shared']) cpSync(join(ROOT, d), join(proj, d), { recursive: true });
    cpSync(join(ROOT, 'package.json'), join(proj, 'package.json'));
    cap = await captureServer();
  });
  afterAll(async () => {
    await cap?.close();
  });

  const runCopy = (env) => runNode([join(proj, 'hooks', 'send-event.mjs')], { cwd: proj, env: cleanEnv(env), input: payload });

  it('.env valid: hook keluar 0 tanpa output, dan AI_OFFICE_URL dari .env dipakai (event sampai)', async () => {
    writeFileSync(join(proj, '.env'), `AI_OFFICE_URL=${cap.url}\n`);
    cap.received.length = 0;
    const r = await runCopy({});
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    expect(cap.received.length).toBeGreaterThan(0);
  });

  it('env proses menang atas .env (tidak ditimpa)', async () => {
    const other = await captureServer();
    try {
      writeFileSync(join(proj, '.env'), `AI_OFFICE_URL=${cap.url}\n`);
      cap.received.length = 0;
      const r = await runCopy({ AI_OFFICE_URL: other.url });
      expect(r).toMatchObject({ code: 0, out: '', err: '' });
      expect(other.received.length).toBeGreaterThan(0);
      expect(cap.received).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it('tanpa .env: hook tetap keluar 0 tanpa output', async () => {
    rmSync(join(proj, '.env'), { force: true });
    const r = await runCopy({ AI_OFFICE_URL: cap.url });
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
  });

  it('.env sampah/biner: hook tetap keluar 0 tanpa output (quiet) dan tidak membocorkan isi', async () => {
    writeFileSync(join(proj, '.env'), 'RAHASIA-HOOK-555\n\0\x01="\n\'unclosed RAHASIA-HOOK-555\n');
    const r = await runCopy({ AI_OFFICE_URL: cap.url });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err).not.toContain('RAHASIA-HOOK-555');
    expect(r.err).toBe('');
  });
});
