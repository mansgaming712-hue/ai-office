// Pemasang/pelepas hook: mode file settings dipertahankan, file baru 0600, symlink tetap symlink (target asli
// yang ditulis). SELALU lewat AI_OFFICE_USER_SETTINGS ke folder sementara; ~/.claude asli tidak pernah disentuh.
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cleanEnv, runNode } from './helpers/testkit.js';

const POSIX = process.platform !== 'win32';
const TMP = mkdtempSync(join(tmpdir(), 'aio-userhooks-mode-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function sandbox() {
  const dir = join(TMP, `m${++n}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  const env = cleanEnv({ AI_OFFICE_USER_SETTINGS: file, HOME: dir, USERPROFILE: dir });
  return {
    dir,
    file,
    install: () => runNode(['scripts/install-user-hooks.mjs'], { env }),
    uninstall: () => runNode(['scripts/uninstall-user-hooks.mjs'], { env }),
    backups: () => readdirSync(dir).filter((f) => f.startsWith('settings.json.bak-')),
    leftovers: () => readdirSync(dir).filter((f) => f.includes('.tmp-')),
  };
}
const modeOf = (p) => statSync(p).mode & 0o777;
const SEED = JSON.stringify({ env: { DUMMY: 'alice' } }, null, 2);

describe.skipIf(!POSIX)('mode file settings (POSIX)', () => {
  it.each([0o600, 0o640, 0o660, 0o644])('mode %o tetap sama setelah install lalu uninstall', async (mode) => {
    const sb = sandbox();
    writeFileSync(sb.file, SEED);
    chmodSync(sb.file, mode);
    const i = await sb.install();
    expect(i.code, i.err).toBe(0);
    expect(modeOf(sb.file)).toBe(mode);
    expect(readFileSync(sb.file, 'utf8')).toContain('send-event.mjs');
    const u = await sb.uninstall();
    expect(u.code, u.err).toBe(0);
    expect(modeOf(sb.file)).toBe(mode);
    expect(readFileSync(sb.file, 'utf8')).not.toContain('send-event.mjs');
    expect(sb.leftovers()).toEqual([]);
  });

  it('file baru (belum ada) dibuat 0600', async () => {
    const sb = sandbox();
    const i = await sb.install();
    expect(i.code, i.err).toBe(0);
    expect(modeOf(sb.file)).toBe(0o600);
    expect(sb.backups()).toEqual([]); // belum ada file, tidak ada backup
  });

  it('symlink: target asli yang ditulis, symlink tetap symlink, mode target tetap', async () => {
    const sb = sandbox();
    const real = join(sb.dir, 'dotfiles');
    mkdirSync(real);
    const target = join(real, 'settings.real.json');
    writeFileSync(target, SEED);
    chmodSync(target, 0o600);
    symlinkSync(target, sb.file);
    const i = await sb.install();
    expect(i.code, i.err).toBe(0);
    expect(lstatSync(sb.file).isSymbolicLink()).toBe(true);
    expect(readlinkSync(sb.file)).toBe(target);
    expect(readFileSync(target, 'utf8')).toContain('send-event.mjs');
    expect(modeOf(target)).toBe(0o600);
    expect(readdirSync(real).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(sb.leftovers()).toEqual([]);
    const u = await sb.uninstall();
    expect(u.code, u.err).toBe(0);
    expect(lstatSync(sb.file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).not.toContain('send-event.mjs');
    expect(modeOf(target)).toBe(0o600);
  });

  it('symlink patah: ditolak dengan pesan jelas, tidak ada yang ditulis', async () => {
    const sb = sandbox();
    symlinkSync(join(sb.dir, 'tidak-ada.json'), sb.file);
    const i = await sb.install();
    expect(i.code).not.toBe(0);
    expect(lstatSync(sb.file).isSymbolicLink()).toBe(true);
    expect(sb.leftovers()).toEqual([]);
  });
});

describe('perilaku umum (semua OS)', () => {
  it('backup .bak-* tetap dibuat dan isinya persis file lama; isi settings lain utuh', async () => {
    const sb = sandbox();
    writeFileSync(sb.file, SEED);
    const i = await sb.install();
    expect(i.code, i.err).toBe(0);
    const baks = sb.backups();
    expect(baks).toHaveLength(1);
    expect(readFileSync(join(sb.dir, baks[0]), 'utf8')).toBe(SEED);
    expect(JSON.parse(readFileSync(sb.file, 'utf8')).env).toEqual({ DUMMY: 'alice' });
    expect(sb.leftovers()).toEqual([]);
  });

  it('file baru: install berhasil dan menghasilkan JSON sah', async () => {
    const sb = sandbox();
    const i = await sb.install();
    expect(i.code, i.err).toBe(0);
    expect(JSON.parse(readFileSync(sb.file, 'utf8')).hooks.SubagentStart).toBeTruthy();
  });
});
