// Otorisasi runner/demo/file tugas (batas keamanan) dan pengurungan path file hasil.
// Mode lokal: header X-AI-Office-Key. Mode token: auth yang sama dengan /api/events. Mode terbuka: nonaktif
// kecuali runnerEnabled. CLI tiruan saja; tidak pernah `claude` sungguhan.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cookieFrom, http, login, randomToken } from './helpers/testkit.js';
import { KEY, startRunnerApp } from './helpers/runnerkit.js';

const apps = [];
const boot = async (o) => {
  const a = await startRunnerApp(o);
  apps.push(a);
  return a;
};
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

const ID = '20260101-000000-contoh';
const JSON_H = { 'Content-Type': 'application/json' };

/** Buat folder tugas contoh langsung di disk (tanpa menjalankan apa pun). */
function seedTask(a) {
  const dir = join(a.outputDir, ID);
  mkdirSync(join(dir, 'sub'), { recursive: true });
  writeFileSync(join(dir, '.ai-office-task.json'), JSON.stringify({ id: ID, title: 'Contoh', kind: 'task', status: 'done', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', summary: 'ringkas' }));
  writeFileSync(join(dir, 'RESULT.md'), '# Hasil\n\nisi hasil\n');
  writeFileSync(join(dir, 'sub', 'a.md'), 'isi a');
  writeFileSync(join(dir, 'x.html'), '<script>alert(1)</script>');
  writeFileSync(join(a.tmp.dir, 'rahasia.txt'), 'RAHASIA-DI-LUAR');
  return dir;
}

const ENDPOINTS = [
  ['GET', '/api/tasks'],
  ['POST', '/api/tasks', { text: 'x' }],
  ['POST', '/api/demo', { lang: 'en' }],
  ['GET', `/api/tasks/${ID}`],
  ['GET', `/api/tasks/${ID}/files/RESULT.md`],
  ['POST', `/api/tasks/${ID}/cancel`, {}],
];

describe('mode lokal: header X-AI-Office-Key wajib', () => {
  it.each(ENDPOINTS)('%s %s tanpa key: 401', async (method, path, body) => {
    const a = await boot();
    seedTask(a);
    const r = await a.api(path, { method, body, key: '' });
    expect(r.status).toBe(401);
    expect(r.json.ok).toBe(false);
    expect(r.body).not.toContain(KEY);
    expect(r.body).not.toContain('RAHASIA');
  });

  it.each(ENDPOINTS)('%s %s dengan key salah: 403', async (method, path, body) => {
    const a = await boot();
    seedTask(a);
    for (const bad of ['salah', 'k'.repeat(42), 'k'.repeat(44), `${KEY.slice(0, 42)}j`, 'x'.repeat(300)]) {
      const r = await a.api(path, { method, body, key: bad });
      expect(r.status).toBe(403);
    }
  });

  it('key benar: daftar dan detail tugas terbaca', async () => {
    const a = await boot();
    seedTask(a);
    const list = await a.api('/api/tasks');
    expect(list.status).toBe(200);
    expect(list.json.tasks.map((t) => t.id)).toEqual([ID]);
    const one = await a.api(`/api/tasks/${ID}`);
    expect(one.json.task).toMatchObject({ id: ID, title: 'Contoh', status: 'done', summary: 'ringkas' });
    expect(one.json.task.files).toEqual([
      { path: 'RESULT.md', bytes: 19 },
      { path: 'sub/a.md', bytes: 5 },
      { path: 'x.html', bytes: 25 },
    ]);
  });

  it('server tanpa runnerKey (null): semua endpoint tertutup walau header ada (fail-closed)', async () => {
    const a = await boot({ opts: { runnerKey: null } });
    const r = await a.api('/api/tasks', { key: KEY });
    expect(r.status).toBe(403);
    expect((await a.api('/api/runner', { key: '' })).json).toMatchObject({ keyRequired: true });
  });

  it('key di query string atau cookie tidak dihitung', async () => {
    const a = await boot();
    expect((await a.api(`/api/tasks?key=${KEY}`, { key: '' })).status).toBe(401);
    expect((await a.api('/api/tasks', { key: '', headers: { Cookie: `aio_session=${KEY}; key=${KEY}` } })).status).toBe(401);
  });

  it('Origin situs lain ditolak walau key benar; Host asing ditolak', async () => {
    const a = await boot();
    const evil = await a.api('/api/tasks', { headers: { Origin: 'https://evil.example' } });
    expect(evil.status).toBe(403);
    const sameSite = await a.api('/api/tasks', { headers: { Origin: `http://127.0.0.1:${a.port}` } });
    expect(sameSite.status).toBe(200);
    const rebind = await http(a.port, '/api/tasks', { headers: { Host: 'evil.example', 'X-AI-Office-Key': KEY } });
    expect(rebind.status).toBe(403);
    const post = await a.api('/api/demo', { method: 'POST', body: { lang: 'en' }, headers: { Origin: 'https://evil.example' } });
    expect(post.status).toBe(403);
  });

  it('metode salah: 405', async () => {
    const a = await boot();
    expect((await a.api('/api/demo')).status).toBe(405);
    expect((await a.api('/api/runner', { method: 'POST', body: {} })).status).toBe(405);
    expect((await a.api(`/api/tasks/${ID}`, { method: 'DELETE' })).status).toBe(405);
  });
});

describe('mode token: auth sama dengan /api/events', () => {
  it('tanpa auth 401; header X-AI-Office-Key saja tidak cukup; Bearer dan cookie lolos', async () => {
    const token = randomToken();
    const a = await boot({ opts: { token } });
    seedTask(a);
    expect((await a.api('/api/tasks', { key: '' })).status).toBe(401);
    expect((await a.api('/api/tasks', { key: KEY })).status).toBe(401);
    expect((await a.api('/api/tasks', { key: '', headers: { Authorization: 'Bearer salah' } })).status).toBe(401);
    const ok = await a.api('/api/tasks', { key: '', headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status).toBe(200);
    const li = await login(a.port, token);
    const cookie = cookieFrom(li);
    const viaCookie = await a.api(`/api/tasks/${ID}/files/RESULT.md`, { key: '', headers: { Cookie: cookie } });
    expect(viaCookie.status).toBe(200);
    expect(viaCookie.body).toContain('isi hasil');
  });

  it('POST demo dan tugas lewat Bearer; /api/runner melaporkan keyRequired false', async () => {
    const token = randomToken();
    const a = await boot({ opts: { token } });
    const r = await a.api('/api/runner', { key: '', headers: { Authorization: `Bearer ${token}` } });
    expect(r.json).toMatchObject({ ok: true, available: true, keyRequired: false });
    const d = await http(a.port, '/api/demo', { method: 'POST', headers: { ...JSON_H, Authorization: `Bearer ${token}` }, body: { lang: 'en' } });
    expect(d.status).toBe(202);
    await a.waitDone(d.json.task.id, { key: '' }).catch(() => {});
  });

  it('GET /api/runner tanpa auth: tidak ada detail tugas aktif', async () => {
    const token = randomToken();
    const a = await boot({ opts: { token }, mode: 'hang' });
    const post = await http(a.port, '/api/tasks', { method: 'POST', headers: { ...JSON_H, Authorization: `Bearer ${token}` }, body: { text: 'rahasia judul tugas' } });
    expect(post.status).toBe(202);
    const anon = await a.api('/api/runner', { key: '' });
    expect(anon.json.active).toBeNull();
    expect(anon.body).not.toContain('rahasia judul tugas');
    await http(a.port, `/api/tasks/${post.json.task.id}/cancel`, { method: 'POST', headers: { ...JSON_H, Authorization: `Bearer ${token}` }, body: {} });
  });
});

describe('mode terbuka (VPS): nonaktif kecuali AI_OFFICE_RUNNER=1', () => {
  const token = randomToken();
  const openOpts = { token, allowedHosts: ['office.example.com'] };
  const hdr = { Host: 'office.example.com', Authorization: `Bearer ${token}`, ...JSON_H };

  it('tanpa runnerEnabled: /api/runner reason disabled; POST tugas, demo, daftar, file semuanya 403', async () => {
    const a = await boot({ opts: openOpts });
    seedTask(a);
    const st = await http(a.port, '/api/runner', { headers: { Host: 'office.example.com' } });
    expect(st.json).toMatchObject({ available: false, reason: 'disabled', keyRequired: false });
    for (const [method, path, body] of ENDPOINTS) {
      const r = await http(a.port, path, { method, headers: hdr, body });
      expect(r.status, `${method} ${path}`).toBe(403);
    }
  });

  it('tanpa auth di mode terbuka: 401 (auth diperiksa sebelum status nonaktif)', async () => {
    const a = await boot({ opts: openOpts });
    const r = await http(a.port, '/api/tasks', { headers: { Host: 'office.example.com' } });
    expect(r.status).toBe(401);
  });

  it('runnerEnabled: demo dan tugas berjalan dengan Bearer', async () => {
    const a = await boot({ opts: { ...openOpts, runnerEnabled: true } });
    const st = await http(a.port, '/api/runner', { headers: { Host: 'office.example.com' } });
    expect(st.json).toMatchObject({ available: true, reason: null });
    const d = await http(a.port, '/api/demo', { method: 'POST', headers: hdr, body: { lang: 'en' } });
    expect(d.status).toBe(202);
  });
});

describe('pengurungan path file hasil', () => {
  const get = (a, rel) => a.api(`/api/tasks/${ID}/files/${rel}`);

  it('file sah: text/plain; charset=utf-8, nosniff, tidak dirender sebagai HTML', async () => {
    const a = await boot();
    seedTask(a);
    for (const [rel, text] of [['RESULT.md', '# Hasil\n\nisi hasil\n'], ['sub/a.md', 'isi a'], ['x.html', '<script>alert(1)</script>']]) {
      const r = await get(a, rel);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(r.headers['x-content-type-options']).toBe('nosniff');
      expect(r.headers['content-security-policy']).toContain("default-src 'none'");
      expect(r.body).toBe(text);
    }
  });

  it.each([
    ['titik-titik literal', '../../rahasia.txt'],
    ['titik-titik di-encode %2e', '%2e%2e/%2e%2e/rahasia.txt'],
    ['campuran %2e.', '%2e./rahasia.txt'],
    ['double encode %252e', '%252e%252e/rahasia.txt'],
    ['garis miring ter-encode %2f', '..%2f..%2frahasia.txt'],
    ['backslash %5c', '..%5c..%5crahasia.txt'],
    ['backslash literal', '..\\rahasia.txt'],
    ['path absolut POSIX', '/etc/passwd'],
    ['path absolut ganda slash', '/rahasia.txt'],
    ['drive Windows', 'C%3A/Windows/win.ini'],
    ['alternate data stream', 'RESULT.md%3Astream'],
    ['NUL', 'RESULT.md%00.txt'],
    ['nama perangkat DOS', 'CON'],
    ['titik di akhir (Windows)', 'RESULT.md.'],
    ['file meta internal', '.ai-office-task.json'],
    ['direktori', 'sub'],
    ['tidak ada', 'tidak-ada.md'],
  ])('ditolak (bukan 200): %s', async (_n, rel) => {
    const a = await boot();
    seedTask(a);
    const r = await get(a, rel);
    expect(r.status).not.toBe(200);
    expect([400, 404]).toContain(r.status);
    expect(r.body).not.toContain('RAHASIA-DI-LUAR');
    expect(r.body).not.toContain('"title"');
  });

  it('id tugas berbahaya: 404 (dan tidak keluar dari output/)', async () => {
    const a = await boot();
    seedTask(a);
    for (const id of ['..', '.', '%2e%2e', 'ABC', 'a'.repeat(65), 'x.y', 'x%20y']) {
      const r = await a.api(`/api/tasks/${id}/files/RESULT.md`);
      expect([400, 404], id).toContain(r.status);
      expect(r.status).not.toBe(200);
    }
    expect((await a.api('/api/tasks/..')).status).toBe(404);
  });

  it('symlink ke file di luar folder: ditolak, dan tidak muncul di daftar file', async () => {
    const a = await boot();
    const dir = seedTask(a);
    let linked = true;
    try {
      symlinkSync(join(a.tmp.dir, 'rahasia.txt'), join(dir, 'tautan.md'), 'file');
    } catch (e) {
      if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
      linked = false; // Windows tanpa hak symlink: bagian ini dilewati, junction folder diuji di bawah
    }
    if (linked) {
      const r = await get(a, 'tautan.md');
      expect(r.status).toBe(404);
      expect(r.body).not.toContain('RAHASIA');
    }
    const detail = await a.api(`/api/tasks/${ID}`);
    expect(detail.json.task.files.map((f) => f.path)).not.toContain('tautan.md');
  });

  it('symlink/junction folder ke luar: file di dalamnya tidak terbaca dan tidak terdaftar', async () => {
    const a = await boot();
    const dir = seedTask(a);
    const outside = join(a.tmp.dir, 'luar');
    mkdirSync(outside);
    writeFileSync(join(outside, 'rahasia.md'), 'RAHASIA-DI-LUAR');
    symlinkSync(outside, join(dir, 'tautan-folder'), 'junction');
    const r = await get(a, 'tautan-folder/rahasia.md');
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('RAHASIA');
    const detail = await a.api(`/api/tasks/${ID}`);
    expect(detail.json.task.files.map((f) => f.path).some((p) => p.startsWith('tautan-folder'))).toBe(false);
  });

  it('folder tugas itu sendiri symlink ke luar: tidak dianggap tugas', async () => {
    const a = await boot();
    seedTask(a);
    const outside = join(a.tmp.dir, 'luar2');
    mkdirSync(outside);
    writeFileSync(join(outside, '.ai-office-task.json'), JSON.stringify({ id: 'x', title: 'luar', status: 'done' }));
    writeFileSync(join(outside, 'RESULT.md'), 'RAHASIA-DI-LUAR');
    symlinkSync(outside, join(a.outputDir, '20260102-000000-tautan'), 'junction');
    const r = await a.api('/api/tasks/20260102-000000-tautan/files/RESULT.md');
    expect(r.status).toBe(404);
    expect((await a.api('/api/tasks')).json.tasks.map((t) => t.id)).toEqual([ID]);
  });

  it('batas 1 MB (413) dan file biner (415)', async () => {
    const a = await boot();
    const dir = seedTask(a);
    writeFileSync(join(dir, 'besar.md'), 'a'.repeat(1024 * 1024 + 1));
    writeFileSync(join(dir, 'tepat.md'), 'a'.repeat(1024 * 1024));
    writeFileSync(join(dir, 'biner.bin'), Buffer.from([1, 2, 0, 3, 4]));
    expect((await get(a, 'besar.md')).status).toBe(413);
    const exact = await get(a, 'tepat.md');
    expect(exact.status).toBe(200);
    expect(exact.body.length).toBe(1024 * 1024);
    expect((await get(a, 'biner.bin')).status).toBe(415);
  });
});
