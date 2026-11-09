// R6: server/tokenSource.js (resolveToken / expandHome) dipakai server/index.js dan hooks/send-event.mjs.
// Semua file uji ditulis di folder sementara; folder home asli tidak pernah ditulisi.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_TOKEN_FILE_BYTES, expandHome, resolveToken } from '../server/tokenSource.js';
import { randomToken } from './helpers/testkit.js';

const TOKEN = randomToken();
let dir;
const file = (name, content) => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};
/** Path "~/…" menuju file di folder sementara (relatif dari home; berlaku juga bila tmp di luar home). */
const viaTilde = (p, sep = '/') => `~${sep}${relative(homedir(), p).split(/[\\/]/).join(sep)}`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aio-token-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('R6: resolveToken membaca AI_OFFICE_TOKEN_FILE', () => {
  it('BOM, spasi, dan CRLF di tepi di-trim', () => {
    const p = file('bom-crlf', `﻿  ${TOKEN}\r\n`);
    expect(resolveToken({ tokenFile: p })).toEqual({ token: TOKEN, source: 'file', file: p });
  });

  it('tanpa BOM/baris baru juga terbaca persis', () => {
    expect(resolveToken({ tokenFile: file('polos', TOKEN) }).token).toBe(TOKEN);
  });

  it('"~/" (dan "~\\" di Windows) diperluas ke folder home', () => {
    const p = file('tilde', `${TOKEN}\n`);
    // Di Linux/macOS "\" bukan pemisah path, jadi hanya "~/" yang bermakna di sana.
    for (const sep of process.platform === 'win32' ? ['/', '\\'] : ['/']) {
      const r = resolveToken({ tokenFile: viaTilde(p, sep) });
      expect(r, sep).toMatchObject({ token: TOKEN, source: 'file' });
      expect(r.file.toLowerCase(), sep).toBe(p.toLowerCase());
    }
  });

  it('expandHome: hanya "~" di awal yang diganti', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/a/b')).toBe(join(homedir(), 'a', 'b'));
    expect(expandHome('~\\a')).toBe(join(homedir(), 'a'));
    expect(expandHome('a/~/b')).toBe('a/~/b');
    expect(expandHome('~user/x')).toBe('~user/x');
  });

  it('path AI_OFFICE_TOKEN_FILE dengan spasi di tepi tetap dipakai', () => {
    const p = file('spasi-path', TOKEN);
    expect(resolveToken({ tokenFile: `  ${p}  ` }).token).toBe(TOKEN);
  });

  it(`batas ukuran: tepat ${MAX_TOKEN_FILE_BYTES} byte diterima, lebih 1 byte ditolak`, () => {
    expect(MAX_TOKEN_FILE_BYTES).toBe(4096);
    expect(resolveToken({ tokenFile: file('pas', 'a'.repeat(4096)) }).token).toHaveLength(4096);
    const big = file('besar', 'R'.repeat(4097));
    expect(resolveToken({ tokenFile: big })).toEqual({ token: '', source: 'file', file: big, problem: 'lebih besar dari 4096 byte' });
  });

  it.each([
    ['folder', () => dir, 'bukan file biasa'],
    ['"~" saja (folder home)', () => '~', 'bukan file biasa'],
    ['file hilang', () => join(dir, 'tidak-ada'), 'tidak ditemukan'],
    ['file kosong', () => file('kosong', ''), 'kosong'],
    ['hanya spasi/CRLF', () => file('spasi', ' \r\n\t '), 'kosong'],
    ['hanya BOM', () => file('bom', '﻿'), 'kosong'],
  ])('%s → tanpa token, dengan alasan', (_label, path, problem) => {
    const r = resolveToken({ tokenFile: path() });
    expect(r).toMatchObject({ token: '', source: 'file', problem });
  });

  it('AI_OFFICE_TOKEN (env) diutamakan atas file; env kosong/spasi → file dipakai', () => {
    const p = file('kalah', TOKEN);
    expect(resolveToken({ token: '  token-env  ', tokenFile: p })).toEqual({ token: 'token-env', source: 'env' });
    expect(resolveToken({ token: '   ', tokenFile: p })).toMatchObject({ token: TOKEN, source: 'file' });
  });

  it('tanpa keduanya / path kosong → source "none"', () => {
    expect(resolveToken({})).toEqual({ token: '', source: 'none' });
    expect(resolveToken()).toEqual({ token: '', source: 'none' });
    expect(resolveToken({ token: '', tokenFile: '   ' })).toEqual({ token: '', source: 'none' });
  });

  it('isi file tidak pernah masuk ke pesan problem (hanya path dan alasan)', () => {
    const secret = randomToken();
    for (const p of [file('besar-rahasia', `${secret}\n`.repeat(200)), file('rahasia-kosong-tidak', ' ')]) {
      const r = resolveToken({ tokenFile: p });
      expect(JSON.stringify({ ...r, token: undefined })).not.toContain(secret);
      expect(r.problem).toBeTruthy();
    }
  });
});
