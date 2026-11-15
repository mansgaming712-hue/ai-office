// QA tambahan: (1) semua nama file di dist/ sungguhan lolos requestPathname; (2) Windows: settings read-only
// ditolak dengan pesan jelas tanpa merusak file dan tanpa sisa file sementara.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { requestPathname } from '../server/net.js';
import { writeJsonAtomicSync } from '../scripts/user-hooks.mjs';
import { ROOT } from './helpers/testkit.js';

const DIST = join(ROOT, 'dist');

// dist/ dibuat oleh "npm run build"; tanpa build tidak ada yang bisa diperiksa (npm test dijalankan setelah build).
describe.skipIf(!existsSync(DIST))('nama file dist/ sungguhan', () => {
  it('tidak ada aset build yang dikira nama perangkat', () => {
    const names = [];
    const walk = (dir, rel) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(join(dir, e.name), r);
        else names.push(r);
      }
    };
    walk(DIST, '');
    expect(names.length).toBeGreaterThan(0);
    for (const p of names) expect(requestPathname(encodeURI(p)), p).toBe(encodeURI(p));
  });
});

describe.skipIf(process.platform !== 'win32')('settings read-only (Windows)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'aio-ro-'));
  afterAll(() => {
    try { chmodSync(join(tmp, 's.json'), 0o666); } catch { /* sudah dihapus */ }
    rmSync(tmp, { recursive: true, force: true });
  });
  it('gagal tanpa mengubah isi file dan tanpa meninggalkan file sementara', () => {
    mkdirSync(tmp, { recursive: true });
    const f = join(tmp, 's.json');
    writeFileSync(f, '{"a":1}');
    chmodSync(f, 0o444);
    expect(() => writeJsonAtomicSync(f, { b: 2 })).toThrow();
    expect(readFileSync(f, 'utf8')).toBe('{"a":1}');
    expect(readdirSync(tmp)).toEqual(['s.json']);
  });
});
