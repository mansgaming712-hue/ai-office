// QA tambahan untuk scripts/setup.mjs dan scripts/open.mjs: proses nyata, folder HOME sementara.
// --dry-run tidak boleh mengubah apa pun (repo maupun HOME), dan pesan mengikuti bahasa.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ROOT, cleanEnv, runNode } from './helpers/testkit.js';
import { tempDir } from './helpers/runnerkit.js';
import { loadRunnerKey } from '../server/runnerKey.js';

const SETUP = join(ROOT, 'scripts', 'setup.mjs');
const OPEN = join(ROOT, 'scripts', 'open.mjs');
const temps = [];
const tmp = () => {
  const t = tempDir('ai-office-setup-');
  temps.push(t);
  return t;
};
afterEach(() => {
  while (temps.length) temps.pop().cleanup();
});

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : null);
const snapshot = () => ({
  pkg: mtime(join(ROOT, 'package.json')),
  lock: mtime(join(ROOT, 'package-lock.json')),
  nodeModules: mtime(join(ROOT, 'node_modules')),
  dist: mtime(join(ROOT, 'dist')),
  distIndex: mtime(join(ROOT, 'dist', 'index.html')),
  output: existsSync(join(ROOT, 'output')) ? readdirSync(join(ROOT, 'output')).length : null,
});
const homeEnv = (dir, extra = {}) =>
  cleanEnv({
    HOME: dir,
    USERPROFILE: dir,
    AI_OFFICE_USER_SETTINGS: join(dir, 'settings.json'),
    AI_OFFICE_RUNNER_KEY_FILE: join(dir, 'runner-key'),
    npm_execpath: '',
    ...extra,
  });

describe('scripts/setup.mjs --dry-run (proses nyata)', () => {
  it.each([
    [['--dry-run'], 5],
    [['--dry-run', '--no-claude'], 2],
  ])('%j: exit 0, mencantumkan langkah, tidak mengubah repo maupun HOME', async (argv, steps) => {
    const t = tmp();
    const before = snapshot();
    const r = await runNode([SETUP, ...argv], { env: homeEnv(t.dir, { AI_OFFICE_LANG: 'en' }) });
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out.split('[dry-run] would run:').length - 1).toBe(steps);
    const planned = r.out.split(/\r?\n/).filter((l) => l.includes('would run:')).join(' | ');
    expect(r.out).toContain('npm ci');
    expect(r.out).toContain('npm run build');
    expect(planned.includes('agents:install')).toBe(!argv.includes('--no-claude'));
    expect(planned.includes('hooks:install-user')).toBe(!argv.includes('--no-claude'));
    expect(readdirSync(t.dir)).toEqual([]); // HOME tetap kosong: tidak ada key, settings, atau folder ~/.claude
    expect(snapshot()).toEqual(before);
  });

  it('pesan mengikuti AI_OFFICE_LANG (en dan id), dan opsi salah = exit 2 dengan bantuan', async () => {
    const t = tmp();
    const en = await runNode([SETUP, '--bogus'], { env: homeEnv(t.dir, { AI_OFFICE_LANG: 'en' }) });
    const id = await runNode([SETUP, '--bogus'], { env: homeEnv(t.dir, { AI_OFFICE_LANG: 'id' }) });
    expect([en.code, id.code]).toEqual([2, 2]);
    expect(en.err).toContain('Unknown option: --bogus');
    expect(en.err).toContain('Usage:');
    expect(id.err).toContain('Opsi tidak dikenal: --bogus');
    expect(id.err).toContain('Pemakaian:');
    expect(en.out + id.out).toBe('');
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it('--help: exit 0 di stdout, tidak menjalankan apa pun', async () => {
    const t = tmp();
    const r = await runNode([SETUP, '--help'], { env: homeEnv(t.dir, { AI_OFFICE_LANG: 'en' }) });
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage:');
    expect(readdirSync(t.dir)).toEqual([]);
  });

  it('dijalankan dari folder lain: path proyek tetap benar (tidak bergantung cwd)', async () => {
    const t = tmp();
    const r = await runNode([SETUP, '--dry-run', '--no-claude'], { env: homeEnv(t.dir, { AI_OFFICE_LANG: 'en' }), cwd: t.dir });
    expect(r.code).toBe(0);
    expect(readdirSync(t.dir)).toEqual([]);
  });
});

describe('scripts/open.mjs (proses nyata)', () => {
  it('--print memakai key di folder sementara dan tidak mengubah repo', async () => {
    const t = tmp();
    loadRunnerKey({ file: join(t.dir, 'runner-key') });
    const before = snapshot();
    const r = await runNode([OPEN, '--print'], { env: homeEnv(t.dir, { AI_OFFICE_LANG: 'en', PORT: '3999' }) });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/http:\/\/localhost:3999\/#key=[A-Za-z0-9_-]{43}/);
    expect(readdirSync(t.dir)).toEqual(['runner-key']);
    expect(snapshot()).toEqual(before);
  });

  it('PORT tidak sah (injeksi shell, negatif, nol, desimal) jatuh ke 3000 dan tidak muncul di URL', async () => {
    const t = tmp();
    loadRunnerKey({ file: join(t.dir, 'runner-key') });
    for (const PORT of ['3000; calc', '-1', '0', '1.5', '70000', '$(id)', ' ']) {
      const r = await runNode([OPEN, '--print'], { env: homeEnv(t.dir, { PORT }) });
      expect(r.code, PORT).toBe(0);
      expect(r.out, PORT).toContain('http://localhost:3000/#key=');
      expect(r.out, PORT).not.toMatch(/calc|\$\(/);
    }
  });

  // QA-3: --dry-run dan --print tidak membuat runner-key bila belum ada (tidak ada efek samping).
  it.each(['--dry-run', '--print'])('QA-3 %s tidak membuat berkas runner-key', async (flag) => {
    const t = tmp();
    const before = snapshot();
    const r = await runNode([OPEN, flag], { env: homeEnv(t.dir, { AI_OFFICE_LANG: 'en' }) });
    expect(r.code).toBe(0);
    expect(r.err).toContain('No runner key exists yet');
    expect(readdirSync(t.dir)).toEqual([]);
    expect(snapshot()).toEqual(before);
  });
});
