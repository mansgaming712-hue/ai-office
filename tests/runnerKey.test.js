// Runner key (server/runnerKey.js) dan pencetakan URL dasbor oleh server/index.js, scripts/open.mjs.
// Semua path key di folder sementara: ~/.ai-office asli tidak disentuh.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNER_KEY_RE, loadRunnerKey, runnerKeyPath } from '../server/runnerKey.js';
import { dashboardUrl, openerFor, runOpen } from '../scripts/open.mjs';
import { SERVER_ENTRY, ROOT, cleanEnv, freePort, randomToken, runNode, sleep } from './helpers/testkit.js';
import { tempDir } from './helpers/runnerkit.js';

const temps = [];
const tmp = () => {
  const t = tempDir('ai-office-key-');
  temps.push(t);
  return t;
};
afterEach(() => {
  while (temps.length) temps.pop().cleanup();
});

describe('loadRunnerKey', () => {
  it('membuat 32 byte acak base64url (43 karakter), lalu membaca ulang yang sama', () => {
    const t = tmp();
    const file = join(t.dir, 'sub', 'runner-key');
    const k1 = loadRunnerKey({ file });
    expect(k1).toMatch(RUNNER_KEY_RE);
    expect(Buffer.from(k1, 'base64url').length).toBe(32);
    expect(loadRunnerKey({ file })).toBe(k1);
    expect(readFileSync(file, 'utf8').trim()).toBe(k1);
  });

  it('dua key berbeda untuk dua file (acak)', () => {
    const t = tmp();
    expect(loadRunnerKey({ file: join(t.dir, 'a') })).not.toBe(loadRunnerKey({ file: join(t.dir, 'b') }));
  });

  it.skipIf(process.platform === 'win32')('POSIX: file 0600, mode longgar diperbaiki saat dibaca', async () => {
    const { chmodSync } = await import('node:fs');
    const t = tmp();
    const file = join(t.dir, 'runner-key');
    loadRunnerKey({ file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    chmodSync(file, 0o644);
    loadRunnerKey({ file });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('file ada tetapi isinya sampah: tidak ditimpa diam-diam (melempar)', () => {
    const t = tmp();
    const file = join(t.dir, 'runner-key');
    writeFileSync(file, 'bukan-key');
    expect(() => loadRunnerKey({ file })).toThrow();
    expect(readFileSync(file, 'utf8')).toBe('bukan-key');
    expect(loadRunnerKey({ file, create: false })).toBeNull();
  });

  it('create:false tidak membuat file', () => {
    const t = tmp();
    expect(loadRunnerKey({ file: join(t.dir, 'x'), create: false })).toBeNull();
    expect(() => statSync(join(t.dir, 'x'))).toThrow();
  });

  it('proses paralel yang berlomba membuat key mendapat key yang sama', async () => {
    const t = tmp();
    const file = join(t.dir, 'runner-key');
    const code = `import('${new URL('../server/runnerKey.js', import.meta.url).href}').then((m) => console.log(m.loadRunnerKey({ file: process.argv[1] })))`;
    const runs = await Promise.all(Array.from({ length: 6 }, () => runNode(['--input-type=module', '-e', code, file], { env: cleanEnv() })));
    const keys = runs.map((r) => r.out.trim());
    expect(keys.every((k) => RUNNER_KEY_RE.test(k))).toBe(true);
    expect(new Set(keys).size).toBe(1);
    expect(readFileSync(file, 'utf8').trim()).toBe(keys[0]);
  });

  it('runnerKeyPath: env AI_OFFICE_RUNNER_KEY_FILE, atau ~/.ai-office/runner-key', () => {
    expect(runnerKeyPath({ AI_OFFICE_RUNNER_KEY_FILE: join(ROOT, 'k') })).toBe(join(ROOT, 'k'));
    expect(runnerKeyPath({}, join('/home', 'alice'))).toBe(join('/home', 'alice', '.ai-office', 'runner-key'));
  });
});

describe('server/index.js (mode lokal): URL dasbor dengan key di fragment', () => {
  async function start(env) {
    const port = await freePort();
    const keyFile = join(tmp().dir, 'runner-key');
    let ready = false;
    const r = await runNode([SERVER_ENTRY], {
      env: cleanEnv({ PORT: String(port), AI_OFFICE_RUNNER_KEY_FILE: keyFile, ...env }),
      timeoutMs: 10000,
      onStdout: (out, child) => {
        if (ready || !out.includes('jalan di')) return;
        ready = true;
        sleep(250).then(() => child.kill());
      },
    });
    return { ...r, port, keyFile, all: r.out + r.err };
  }

  it('AI_OFFICE_PRINT_KEY=1: mencetak http://localhost:<port>/#key=<key> yang sama dengan file key', async () => {
    const r = await start({ AI_OFFICE_PRINT_KEY: '1' });
    const key = readFileSync(r.keyFile, 'utf8').trim();
    expect(key).toMatch(RUNNER_KEY_RE);
    expect(r.out).toContain(`http://localhost:${r.port}/#key=${key}`);
  });

  it('stdout bukan terminal (autostart/log): key TIDAK dicetak, hanya petunjuk npm run open', async () => {
    const r = await start({});
    const key = readFileSync(r.keyFile, 'utf8').trim();
    expect(r.all).not.toContain(key);
    expect(r.all).not.toContain('#key=');
    expect(r.out).toMatch(/npm run open/);
  });

  it('mode token: tidak membuat dan tidak mencetak runner key', async () => {
    const r = await start({ AI_OFFICE_TOKEN: randomToken(), AI_OFFICE_PRINT_KEY: '1' });
    expect(r.all).not.toContain('#key=');
    expect(() => statSync(r.keyFile)).toThrow();
  });

  it('mode terbuka tanpa AI_OFFICE_RUNNER: log menyebut runner nonaktif', async () => {
    const r = await start({ AI_OFFICE_TOKEN: randomToken(), AI_OFFICE_ALLOWED_HOSTS: 'office.example.com' });
    expect(r.out).toMatch(/AI_OFFICE_RUNNER=1/);
    const on = await start({ AI_OFFICE_TOKEN: randomToken(), AI_OFFICE_ALLOWED_HOSTS: 'office.example.com', AI_OFFICE_RUNNER: '1' });
    expect(on.out).not.toMatch(/nonaktif di mode terbuka/);
  });
});

describe('scripts/open.mjs', () => {
  it('openerFor: tanpa shell, URL hanya sebagai satu argumen', () => {
    expect(openerFor('http://localhost:3000/#key=abc', 'win32')).toEqual({ command: 'explorer.exe', args: ['http://localhost:3000/#key=abc'] });
    expect(openerFor('http://localhost:3000/', 'darwin')).toEqual({ command: 'open', args: ['http://localhost:3000/'] });
    expect(openerFor('http://localhost:3000/', 'linux')).toEqual({ command: 'xdg-open', args: ['http://localhost:3000/'] });
  });

  it('dashboardUrl: port tidak sah jatuh ke 3000 (tidak ada karakter shell di URL)', () => {
    expect(dashboardUrl({ port: '3001', key: 'k' })).toBe('http://localhost:3001/#key=k');
    expect(dashboardUrl({ port: '3000; calc', key: 'k' })).toBe('http://localhost:3000/#key=k');
    expect(dashboardUrl({ port: undefined, key: '' })).toBe('http://localhost:3000/');
  });

  const KEY = 'a'.repeat(43);
  const run = async (argv, opts = {}) => {
    const out = [];
    const errs = [];
    const launched = [];
    const code = await runOpen(argv, {
      env: { PORT: '3456' },
      platform: 'win32',
      loadKey: () => KEY,
      launch: async (cmd, args) => {
        launched.push([cmd, args]);
        return { error: opts.launchError ?? null };
      },
      log: (m) => out.push(m),
      err: (m) => errs.push(m),
      ...opts,
    });
    return { code, out, errs, launched };
  };

  it('membuka browser dengan URL berisi key di fragment; log menyamarkan key', async () => {
    const r = await run([]);
    expect(r.code).toBe(0);
    expect(r.launched).toEqual([['explorer.exe', [`http://localhost:3456/#key=${KEY}`]]]);
    expect(r.out.join('\n')).not.toContain(KEY);
  });

  it('--print mencetak URL lengkap tanpa membuka browser', async () => {
    const r = await run(['--print']);
    expect(r.out.join('\n')).toContain(`http://localhost:3456/#key=${KEY}`);
    expect(r.launched).toEqual([]);
  });

  it('--dry-run tidak membuka dan menyamarkan key', async () => {
    const r = await run(['--dry-run']);
    expect(r.launched).toEqual([]);
    expect(r.out.join('\n')).toContain('explorer.exe');
    expect(r.out.join('\n')).not.toContain(KEY);
  });

  it('mode token: tidak memakai key', async () => {
    const r = await run([], { env: { PORT: '3000', AI_OFFICE_TOKEN: randomToken() } });
    expect(r.launched[0][1]).toEqual(['http://localhost:3000/']);
  });

  it('browser gagal dibuka: exit 1 dan URL dicetak ke pengguna; opsi asing: exit 2', async () => {
    const f = await run([], { launchError: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    expect(f.code).toBe(1);
    expect(f.errs.join('\n')).not.toContain(KEY); // key disamarkan juga di pesan gagal (L5)
    expect(f.errs.join('\n')).toContain('#key=***');
    expect((await run(['--aneh'])).code).toBe(2);
  });

  it('gagal membuat key: exit 1 dengan pesan', async () => {
    const r = await run([], { loadKey: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    expect(r.code).toBe(1);
    expect(r.errs.join('\n')).toMatch(/EACCES/);
  });

  it('proses nyata: --print memakai file key sementara dan tidak menyentuh ~/.ai-office', async () => {
    const t = tmp();
    const keyFile = join(t.dir, 'runner-key');
    mkdirSync(t.dir, { recursive: true });
    loadRunnerKey({ file: keyFile });
    const r = await runNode([join(ROOT, 'scripts', 'open.mjs'), '--print'], { env: cleanEnv({ AI_OFFICE_RUNNER_KEY_FILE: keyFile, PORT: '3777' }) });
    expect(r.code).toBe(0);
    const key = readFileSync(keyFile, 'utf8').trim();
    expect(r.out).toContain(`http://localhost:3777/#key=${key}`);
  });
});
