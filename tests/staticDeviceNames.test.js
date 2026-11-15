// Server file statis: nama perangkat DOS Windows (CON, AUX, NUL, COMn, LPTn) ditolak SEBELUM stat/readFile,
// dan hasil stat yang bukan file biasa dijawab 404. fs/promises di-mock (spy) supaya tidak ada perangkat yang
// benar-benar dibuka; test sama di Windows, Linux, dan macOS.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({ fake: null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    stat: vi.fn(async (p, ...rest) => (spies.fake?.(String(p)) ?? real.stat(p, ...rest))),
    readFile: vi.fn((...a) => real.readFile(...a)),
  };
});

const { stat, readFile } = await import('node:fs/promises');
const { hasDeviceSegment, requestPathname } = await import('../server/net.js');
const { http, startApp } = await import('./helpers/testkit.js');

let dir;
let s;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aio-static-dev-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AI Office</title>');
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  s = await startApp({ staticDir: dir });
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  spies.fake = null;
  stat.mockClear();
  readFile.mockClear();
});

const DEVICE_PATHS = [
  '/con', '/CON', '/Con', '/aux.js', '/assets/nul', '/com1', '/COM9', '/lpt9.txt', '/prn', '/nul.js', '/con.txt',
  '/con.', '/%63on', '/%43ON', '/assets/%6eul.js', '/com1.tar.gz', '/conin$', '/CONOUT$', '/con%20', '/con%3Ax',
  // Terminator baris sesudah pemisah (temuan audit ulang dev-security): dulu lolos karena ".*" tidak cocok dengannya.
  '/con.%0a', '/con.%0Ax', '/con:%0d', '/con.%E2%80%A8', '/nul.%E2%80%A9',
];

describe('requestPathname menolak nama perangkat', () => {
  it.each(DEVICE_PATHS)('%s -> null', (p) => {
    expect(requestPathname(p)).toBeNull();
  });

  it('nama biasa yang mirip tetap lolos', () => {
    for (const p of ['/', '/index.html', '/assets/app.js', '/console', '/icon.png', '/com10', '/com0', '/lpt', '/aux-x', '/nulled.js', '/a/b/connect.js', '/api/events']) {
      expect(requestPathname(p), p).toBe(p);
    }
    expect(hasDeviceSegment('/%E0%A4%A')).toBe(false); // persen rusak: bukan urusan fungsi ini (serveStatic -> 400)
  });
});

describe('serveStatic: nama perangkat tidak pernah mencapai stat/readFile', () => {
  it.each(DEVICE_PATHS)('GET %s -> 400, tanpa stat dan readFile', async (p) => {
    const r = await http(s.port, p);
    expect(r.status).toBe(400);
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('HEAD /con juga ditolak', async () => {
    const r = await http(s.port, '/con', { method: 'HEAD' });
    expect(r.status).toBe(400);
    expect(stat).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it('file biasa dan index.html tetap tersaji', async () => {
    const root = await http(s.port, '/');
    expect(root.status).toBe(200);
    expect(root.body).toContain('AI Office');
    const idx = await http(s.port, '/index.html');
    expect(idx.status).toBe(200);
    const asset = await http(s.port, '/assets/app.js');
    expect(asset.status).toBe(200);
    expect(readFile).toHaveBeenCalled();
    expect((await http(s.port, '/halaman-spa')).status).toBe(200); // fallback SPA utuh
    expect((await http(s.port, '/assets/hilang.js')).status).toBe(404);
  });
});

describe('serveStatic: hasil stat yang bukan file biasa -> 404 tanpa readFile', () => {
  it('perangkat/FIFO/socket (isFile false, isDirectory false)', async () => {
    spies.fake = (p) => (p.endsWith('fifo.bin') ? { isDirectory: () => false, isFile: () => false } : undefined);
    const r = await http(s.port, '/assets/fifo.bin');
    expect(r.status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('SPA fallback: index.html yang ternyata bukan file -> 404 tanpa readFile', async () => {
    spies.fake = (p) => (p.endsWith('index.html') ? { isDirectory: () => false, isFile: () => false } : undefined);
    const r = await http(s.port, '/halaman-spa');
    expect(r.status).toBe(404);
    expect(readFile).not.toHaveBeenCalled();
  });
});
