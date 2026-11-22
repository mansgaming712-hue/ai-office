// agents:install memvalidasi semua agen repo sebelum menulis apa pun. CLI dijalankan pada salinan scripts/,
// server/, shared/, locales/ di folder sementara (REPO_AGENTS_DIR relatif ke import.meta.url, jadi agents/ asli
// tidak tersentuh) dengan HOME/USERPROFILE dialihkan ke folder sementara (tidak pernah menyentuh ~/.claude asli).
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_AGENTS_DIR, RISKY_EXIT_CODE, readAgentDir, checkAgentSet } from '../scripts/agent-files.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const repo = readAgentDir(REPO_AGENTS_DIR);
const [a, b] = repo;
const bad = {
  'kunci asing': (t) => t.replace(/^tools:/m, 'hacker: yes\ntools:'),
  'model tidak valid': (t) => t.replace(/^model: .*$/m, 'model: Opus'),
  'tools terlarang': (t) => t.replace(/^tools:.*$/m, 'tools: Read, Agent'),
};

let root, fake, home, agentsHome;
const put = (name, text) => writeFileSync(join(fake, 'agents', name), text);
const envFor = (lang) => ({ ...process.env, HOME: home, USERPROFILE: home, AI_OFFICE_LANG: lang, AI_OFFICE_DIVISIONS_DIR: join(root, 'nodivs') });
const cli = (...args) => spawnSync(process.execPath, [join(fake, 'scripts', 'install-agents.mjs'), ...args], {
  encoding: 'utf8', cwd: root, env: envFor('id'),
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'install-validate-'));
  fake = join(root, 'fake'); home = join(root, 'home'); agentsHome = join(home, '.claude', 'agents');
  mkdirSync(join(fake, 'agents'), { recursive: true }); mkdirSync(home);
  for (const d of ['scripts', 'server', 'shared', 'locales']) cpSync(join(ROOT, d), join(fake, d), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(fake, 'package.json'));
  symlinkSync(join(ROOT, 'node_modules'), join(fake, 'node_modules'), 'junction'); // agar 'yaml' ter-resolve
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('agents:install: agen repo divalidasi dulu', () => {
  for (const [label, mutate] of Object.entries(bad)) {
    it(`${label}: exit 1, error per file, tidak ada salinan (juga dengan --force --allow-risky-tools)`, () => {
      put(a.fileName, a.text);
      put(b.fileName, mutate(b.text));
      for (const args of [[], ['--force', '--allow-risky-tools']]) {
        const r = cli(...args);
        expect(r.status, r.stderr).toBe(1);
        expect(r.status).not.toBe(RISKY_EXIT_CODE);
        expect(r.stdout).toContain(b.fileName);
        expect(r.stdout).not.toContain(`${a.fileName}:`);
        expect(r.stdout).toContain('Tidak ada file yang disalin');
        expect(existsSync(join(home, '.claude'))).toBe(false);
      }
    });
  }

  it('pesan mengikuti bahasa (Inggris)', () => {
    put(a.fileName, bad['kunci asing'](a.text));
    const r = spawnSync(process.execPath, [join(fake, 'scripts', 'install-agents.mjs')], { encoding: 'utf8', cwd: root, env: envFor('en') });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('No files were copied.');
  });

  it('nama duplikat ditolak', () => {
    put(a.fileName, a.text);
    put('salinan.md', a.text);
    const r = cli();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/dipakai dua kali/);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('folder agents/ kosong atau tidak ada: exit 1 dengan pesan jelas, tanpa membuat ~/.claude', () => {
    let r = cli();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('tidak ada file agen');
    rmSync(join(fake, 'agents'), { recursive: true });
    r = cli();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('tidak ada file agen');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('direktori bernama *.md ditolak tanpa crash EISDIR dan tanpa salinan', () => {
    put(a.fileName, a.text);
    mkdirSync(join(fake, 'agents', 'folder.md'));
    const r = cli();
    expect(r.status).toBe(1);
    expect(r.stderr).not.toMatch(/EISDIR/);
    expect(r.stdout).toMatch(/folder\.md: bukan file biasa/);
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('symlink file *.md di agents/ ditolak (skip bila symlink tidak didukung)', (ctx) => {
    const target = join(root, 'target.md');
    writeFileSync(target, a.text);
    try { symlinkSync(target, join(fake, 'agents', a.fileName), 'file'); } catch (e) { return ctx.skip(`symlink file tidak didukung tanpa hak khusus: ${e.code}`); }
    const r = cli();
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('bukan file biasa');
    expect(existsSync(join(home, '.claude'))).toBe(false);
  });

  it('semua valid: exit 0 dan tersalin ke HOME sementara; alias/ID model baru lolos', () => {
    put(a.fileName, a.text.replace(/^model: .*$/m, 'model: claude-fable-5-1'));
    put(b.fileName, b.text.replace(/^model: .*$/m, 'model: fable'));
    const r = cli();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readdirSync(agentsHome).filter((f) => f.endsWith('.md')).sort()).toEqual([a.fileName, b.fileName].sort());
  });
});

describe('agents:install: tujuan symlink/direktori tidak diikuti', () => {
  it('direktori bernama <agen>.md di tujuan dilewati (juga dengan --force), file lain tetap terpasang', () => {
    put(a.fileName, a.text); put(b.fileName, b.text);
    mkdirSync(join(agentsHome, a.fileName), { recursive: true });
    for (const args of [[], ['--force']]) {
      const r = cli(...args);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('symlink atau direktori');
      expect(lstatSync(join(agentsHome, a.fileName)).isDirectory()).toBe(true);
      expect(readFileSync(join(agentsHome, b.fileName), 'utf8')).toBe(b.text);
    }
  });

  it('symlink di tujuan tidak diikuti: file target tidak berubah (skip bila symlink tidak didukung)', (ctx) => {
    put(a.fileName, a.text);
    mkdirSync(agentsHome, { recursive: true });
    const victim = join(root, 'victim.md');
    writeFileSync(victim, 'MILIK-SAYA');
    try { symlinkSync(victim, join(agentsHome, a.fileName), 'file'); } catch (e) { return ctx.skip(`symlink file tidak didukung tanpa hak khusus: ${e.code}`); }
    for (const args of [[], ['--force']]) {
      const r = cli(...args);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('symlink atau direktori');
      expect(readFileSync(victim, 'utf8')).toBe('MILIK-SAYA');
      expect(lstatSync(join(agentsHome, a.fileName)).isSymbolicLink()).toBe(true);
    }
  });
});

describe('readAgentDir dan checkAgentSet', () => {
  it('non-strict melewati direktori *.md; strict menandainya nonFile', () => {
    put(a.fileName, a.text);
    mkdirSync(join(fake, 'agents', 'folder.md'));
    const dir = join(fake, 'agents');
    expect(readAgentDir(dir).map((f) => f.fileName)).toEqual([a.fileName]);
    expect(readAgentDir(dir, { strict: true }).filter((f) => f.nonFile).map((f) => f.fileName)).toEqual(['folder.md']);
    expect(checkAgentSet(dir).ok).toBe(false);
  });

  it('agents/ repo asli lolos checkAgentSet', () => {
    expect(checkAgentSet(REPO_AGENTS_DIR)).toMatchObject({ ok: true, errors: [] });
  });
});
