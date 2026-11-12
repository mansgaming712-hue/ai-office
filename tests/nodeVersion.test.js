// Pembanding versi Node dan modul cek versi (server/nodeVersion.js, requireNode.js, requireNodeQuiet.js).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_NODE, compareVersions, isNodeSupported, nodeVersionProblem, parseVersion } from '../server/nodeVersion.js';
import { ROOT } from './helpers/testkit.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

describe('nodeVersion: pembanding', () => {
  it('minimal 22.12.0 dan sama dengan engines.node di package.json', () => {
    expect(MIN_NODE).toBe('22.12.0');
    expect(JSON.parse(read('package.json')).engines.node).toBe('>=22.12');
  });

  it.each([
    ['18.19.0', false],
    ['v18.19.0', false],
    ['20.11.1', false],
    ['20.0.0', false],
    ['20.12.0', false],
    ['20.19.0', false],
    ['22.x', false],
    ['22.0.0', false],
    ['22.11.0', false],
    ['22.12.0', true],
    ['v22.12.0', true],
    ['22.12.1', true],
    ['23.0.0', true],
    ['24.x', true],
    ['24.19.0', true],
    ['100.0.0', true],
  ])('isNodeSupported(%s) = %s', (v, expected) => {
    expect(isNodeSupported(v)).toBe(expected);
  });

  it('parseVersion: awalan v, bagian hilang atau x dianggap 0; sampah = null', () => {
    expect(parseVersion('v20.12.3')).toEqual([20, 12, 3]);
    expect(parseVersion('22.x')).toEqual([22, 0, 0]);
    expect(parseVersion('22')).toEqual([22, 0, 0]);
    expect(parseVersion('abc')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });

  it('compareVersions: urutan numerik (bukan string): 20.9 < 20.12', () => {
    expect(compareVersions('20.9.0', '20.12.0')).toBe(-1);
    expect(compareVersions('20.12.0', '20.12.0')).toBe(0);
    expect(compareVersions('21.0.0', '20.12.0')).toBe(1);
    expect(compareVersions('x', '20.12.0')).toBeNull();
  });

  it('versi yang tidak bisa dibaca tidak memblokir', () => {
    expect(isNodeSupported('aneh')).toBe(true);
    expect(nodeVersionProblem('aneh')).toBeNull();
  });

  it('nodeVersionProblem: null bila cukup; bila kurang memuat versi sekarang, minimal, dan cara upgrade', () => {
    expect(nodeVersionProblem('22.12.0')).toBeNull();
    const msg = nodeVersionProblem('v20.19.0');
    expect(msg).toContain('22.12');
    expect(msg).toContain('v20.19.0');
    expect(msg).toMatch(/nodejs\.org/);
    expect(msg).toMatch(/upgrade/i);
  });
});

describe('nodeVersion: titik masuk', () => {
  const MANUSIA = [
    'server/index.js',
    'scripts/autostart.mjs',
    'scripts/install-user-hooks.mjs',
    'scripts/uninstall-user-hooks.mjs',
    'scripts/usage-report.mjs',
    'scripts/install-agents.mjs',
  ];
  /** Import statis pertama di file. */
  const firstImport = (text) => /^import\s.*$/m.exec(text)?.[0] ?? '';

  it.each(MANUSIA)('%s mengimpor requireNode.js paling awal', (f) => {
    expect(firstImport(read(f))).toMatch(/^import '(\.\.\/server\/|\.\/)requireNode\.js';/);
  });

  it('hooks/send-event.mjs mengimpor versi DIAM paling awal (bukan yang mencetak galat)', () => {
    expect(firstImport(read('hooks/send-event.mjs'))).toMatch(/^import '\.\.\/server\/requireNodeQuiet\.js';/);
    expect(read('hooks/send-event.mjs')).not.toMatch(/requireNode\.js/);
  });

  it('requireNode.js: galat ke stderr + exit 1; requireNodeQuiet.js: exit 0 tanpa output', () => {
    expect(read('server/requireNode.js')).toMatch(/console\.error\(problem\);\s*process\.exit\(1\)/);
    const quiet = read('server/requireNodeQuiet.js');
    expect(quiet).toMatch(/process\.exit\(0\)/);
    expect(quiet).not.toMatch(/console\./);
  });

  it('modul versi hanya memakai sintaks lama (tanpa ?. ?? => const let class async)', () => {
    for (const f of ['server/nodeVersion.js', 'server/requireNode.js', 'server/requireNodeQuiet.js']) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, '');
      expect(code, f).not.toMatch(/\?\.|\?\?|=>|\b(const|let|class|async|await)\b|`/);
    }
  });

  it('Node yang sekarang lolos: skrip bantuan jalan (exit 0) tanpa galat versi', () => {
    const r = spawnSync(process.execPath, ['scripts/autostart.mjs', '--help'], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });
});

// prebuild/pretest memakai cek versi yang sama (satu angka minimum untuk semuanya).
describe('nodeVersion: cek sebelum build dan test', () => {
  it('package.json menjalankan cek versi sebelum build dan test', () => {
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts.prebuild).toBe('node scripts/check-toolchain-node.mjs build');
    expect(scripts.pretest).toBe('node scripts/check-toolchain-node.mjs test');
    expect(firstImportOf(read('scripts/check-toolchain-node.mjs'))).toBe("import '../server/requireNode.js';");
  });

  it('skrip cek lolos tanpa output di Node yang menjalankan test ini', () => {
    for (const kind of ['build', 'test']) {
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-toolchain-node.mjs'), kind], { encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toBe('');
    }
  });

  it('tidak ada lagi tingkat versi terpisah untuk runtime dan toolchain', async () => {
    const mod = await import('../server/nodeVersion.js');
    expect(mod.toolchainNodeProblem).toBeUndefined();
    expect(mod.isToolchainNodeSupported).toBeUndefined();
  });
});

const firstImportOf = (text) => /^import\s.*$/m.exec(text)?.[0] ?? '';
