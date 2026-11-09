import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createAiOfficeServer } from '../server/app.js';
import { DEMO_STEPS, runHook } from '../scripts/demo-hooks.mjs';

let app;
let base;
let port;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ai-office-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>AI Office</title>');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'app.js'), 'console.log(1)');
  // dedupWindowMs 0: test di file ini sengaja mengirim event identik berulang (dedup diuji di tests/eventDedup.test.js).
  app = createAiOfficeServer({ host: '127.0.0.1', port: 0, staticDir: dir, dedupWindowMs: 0 });
  const addr = await app.listen();
  port = addr.port;
  base = `http://127.0.0.1:${port}`;
});

afterAll(() => app.close());

const post = (body, headers = { 'Content-Type': 'application/json' }) =>
  fetch(`${base}/api/events`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

/** Request mentah supaya header Host/Origin bisa dipalsukan (fetch tidak mengizinkannya). */
function raw(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function openWs(headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const messages = [];
    const waiters = [];
    ws.on('message', (m) => {
      messages.push(JSON.parse(m.toString()));
      waiters.splice(0).forEach((w) => w());
    });
    ws.on('open', () =>
      resolve({
        ws,
        messages,
        async waitFor(pred, ms = 4000) {
          const end = Date.now() + ms;
          while (Date.now() < end) {
            const hit = messages.find(pred);
            if (hit) return hit;
            await new Promise((r) => {
              waiters.push(r);
              setTimeout(r, 50);
            });
          }
          throw new Error('timeout menunggu pesan WebSocket');
        },
      }),
    );
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => reject(new Error(`ditolak ${res.statusCode}`)));
  });
}

describe('HTTP API', () => {
  it('POST event valid → 202 dan tersimpan di riwayat', async () => {
    const res = await post({ type: 'assign', from: 'manager', to: 'dev-qa', message: 'Uji' });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, accepted: 1 });
    const hist = await (await fetch(`${base}/api/events`)).json();
    expect(hist.events.at(-1)).toMatchObject({ type: 'assign', to: 'dev-qa', id: body.ids[0] });
  });

  it('menerima array event dan kunci bahasa Indonesia', async () => {
    const res = await post([{ tipe: 'working', dari: 'dev-qa', ke: 'manager', pesan: 'a' }, { type: 'done', from: 'dev-qa', to: 'manager' }]);
    expect(res.status).toBe(202);
    expect((await res.json()).accepted).toBe(2);
  });

  it('menolak event tidak valid (400), JSON rusak (400), content-type salah (415), body besar (413)', async () => {
    expect((await post({ type: 'nope', from: 'a', to: 'b' })).status).toBe(400);
    expect((await post('{rusak')).status).toBe(400);
    expect((await post({ type: 'done', from: 'a', to: 'b' }, { 'Content-Type': 'text/plain' })).status).toBe(415);
    const big = JSON.stringify({ type: 'done', from: 'a', to: 'b', message: 'x'.repeat(70 * 1024) });
    const r = await raw('/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(big) }, body: big }).catch((e) => ({ status: e.code }));
    expect([413, 'ECONNRESET', 'EPIPE']).toContain(r.status);
  });

  it('health, 404 API, dan 405 method', async () => {
    const h = await (await fetch(`${base}/api/health`)).json();
    expect(h.ok).toBe(true);
    expect((await fetch(`${base}/api/nope`)).status).toBe(404);
    expect((await fetch(`${base}/api/events`, { method: 'DELETE' })).status).toBe(405);
  });

  it('menolak Host asing (DNS rebinding) dan Origin situs lain', async () => {
    expect((await raw('/api/events', { headers: { Host: 'evil.example' } })).status).toBe(403);
    expect((await raw('/', { headers: { Host: 'evil.example:3000' } })).status).toBe(403);
    const cross = await raw('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ type: 'done', from: 'a', to: 'b' }),
    });
    expect(cross.status).toBe(403);
    const local = await raw('/api/events', { headers: { Origin: `http://localhost:${port}`, Host: `localhost:${port}` } });
    expect(local.status).toBe(200);
  });
});

describe('file statis', () => {
  it('menyajikan index.html dengan header keamanan', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('aset dengan cache panjang, aset hilang 404, rute halaman fallback ke index', async () => {
    const a = await fetch(`${base}/assets/app.js`);
    expect(a.status).toBe(200);
    expect(a.headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${base}/assets/hilang.js`)).status).toBe(404);
    expect((await fetch(`${base}/kantor`)).status).toBe(200);
  });

  it('tidak bisa keluar dari folder dist (path traversal)', async () => {
    for (const p of ['/../package.json', '/%2e%2e/%2e%2e/package.json', '/..%5c..%5cpackage.json', '/assets/../../x.js']) {
      const r = await raw(p);
      expect([400, 403, 404]).toContain(r.status);
      expect(r.body).not.toContain('"name"');
    }
  });
});

describe('WebSocket', () => {
  it('mengirim riwayat saat terhubung lalu meneruskan event baru', async () => {
    const c = await openWs();
    const hello = await c.waitFor((m) => m.kind === 'hello');
    expect(Array.isArray(hello.events)).toBe(true);
    await post({ type: 'blocked', from: 'content-script', to: 'manager', message: 'butuh harga' });
    const msg = await c.waitFor((m) => m.kind === 'event' && m.event.type === 'blocked');
    expect(msg.event).toMatchObject({ from: 'content-script', message: 'butuh harga' });
    expect(msg.event.id).toBeGreaterThan(0);
    c.ws.close();
  });

  it('menyiarkan ke semua klien', async () => {
    const [a, b] = await Promise.all([openWs(), openWs()]);
    await post({ type: 'report', from: 'dev-qa', to: 'manager', message: 'siaran' });
    await a.waitFor((m) => m.event?.message === 'siaran');
    await b.waitFor((m) => m.event?.message === 'siaran');
    a.ws.close();
    b.ws.close();
  });

  it('menolak koneksi dari Origin situs lain', async () => {
    await expect(openWs({ Origin: 'https://evil.example' })).rejects.toThrow(/403|ditolak|Unexpected/);
  });
});

describe('skrip hook (hooks/send-event.mjs)', () => {
  const env = () => ({ ...process.env, AI_OFFICE_URL: `${base}/api/events` });

  it('payload hook asli sampai ke browser lewat WebSocket, tanpa output dan exit 0', async () => {
    const c = await openWs();
    await c.waitFor((m) => m.kind === 'hello');
    const r = await runHook(DEMO_STEPS[0], env());
    expect(r).toMatchObject({ code: 0, out: '' });
    const msg = await c.waitFor((m) => m.kind === 'event' && m.event.source === 'hook' && m.event.type === 'assign');
    expect(msg.event).toMatchObject({ from: 'manager', to: 'dev-backend', message: 'Buat endpoint POST /api/orders' });
    c.ws.close();
  });

  it('seluruh demo hooks diteruskan berurutan', async () => {
    const c = await openWs();
    await c.waitFor((m) => m.kind === 'hello');
    for (const step of DEMO_STEPS) {
      const r = await runHook(step, env());
      expect(r.code).toBe(0);
    }
    const last = await c.waitFor((m) => m.kind === 'event' && m.event.message === 'Write · 2026-11-08-orders.md');
    expect(last.event.from).toBe('manager');
    const hookEvents = c.messages.filter((m) => m.kind === 'event' && m.event.source === 'hook').map((m) => m.event.type);
    expect(hookEvents).toEqual(['assign', 'working', 'working', 'working', 'working', 'done', 'report', 'assign', 'assign', 'working', 'working', 'working', 'working', 'blocked', 'blocked', 'done', 'report', 'working']);
    c.ws.close();
  }, 30000);

  it('tetap exit 0 dengan cepat saat server mati atau input rusak', async () => {
    const t0 = Date.now();
    const dead = await runHook(DEMO_STEPS[0], { ...process.env, AI_OFFICE_URL: 'http://127.0.0.1:9/api/events' });
    expect(dead).toMatchObject({ code: 0, out: '' });
    expect(Date.now() - t0).toBeLessThan(4000);
    const bad = await new Promise((resolve) => {
      import('node:child_process').then(({ spawn }) => {
        const child = spawn(process.execPath, ['hooks/send-event.mjs'], { env: env() });
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('close', (code) => resolve({ code, out }));
        child.stdin.end('ini bukan json');
      });
    });
    expect(bad).toEqual({ code: 0, out: '' });
  });
});
