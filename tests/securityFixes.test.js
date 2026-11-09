// Regresi perbaikan keamanan server/app.js + server/auth.js (S1, S3, R7, I1, I2, I3).
// Semua server di dalam proses test, port 0. 127.0.0.2 dipakai sebagai alamat "bukan loopback" yang
// tetap tidak membuka port ke jaringan; bila tidak bisa di-bind (macOS), test terkait dilewati dengan pesan.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAiOfficeServer } from '../server/app.js';
import { MAX_SESSION_COOKIES, resolveAuthMode } from '../server/auth.js';
import { JSON_HEADERS, cookieFrom, http, login, randomToken, startApp, wsClosed, wsConnect } from './helpers/testkit.js';

const TOKEN = randomToken();
const BEARER = { Authorization: `Bearer ${TOKEN}` };
const CAN_BIND_127_0_0_2 = await new Promise((resolve) => {
  const probe = createNetServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.2', () => probe.close(() => resolve(true)));
});
if (!CAN_BIND_127_0_0_2) console.warn('[securityFixes.test] 127.0.0.2 tidak bisa di-bind: test HOST bukan loopback dilewati.');
const SKIP_NOTE = CAN_BIND_127_0_0_2 ? '' : ' [DILEWATI: 127.0.0.2 tidak tersedia]';

const postEvents = (port, body, headers = {}) => http(port, '/api/events', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body });

/** Kirim ping setelah `send`; hasil 'pong' bila koneksi masih terbuka, atau kode close bila ditutup. */
function aliveAfter(ws, send, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), timeoutMs);
    ws.once('pong', () => {
      clearTimeout(t);
      resolve('pong');
    });
    ws.once('close', (code) => {
      clearTimeout(t);
      resolve(code);
    });
    send(ws);
    ws.ping();
  });
}

/**
 * Klien WebSocket mentah yang "nakal": handshake, kirim frame teks 5000 byte, lalu TIDAK pernah membalas
 * close frame dan tidak pernah menutup sisinya (allowHalfOpen). Hasil (setelah close frame diterima):
 * { closeCode, sock }. Pemanggil mengukur kapan server benar-benar membuang koneksinya.
 */
function misbehavingClient(port, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const sock = connect({ port, host: '127.0.0.1', allowHalfOpen: true });
    const t = setTimeout(() => {
      sock.destroy();
      reject(new Error('tidak ada close frame dari server dalam 5 detik'));
    }, 5000);
    let buf = Buffer.alloc(0);
    let upgraded = false;
    let done = false;
    sock.on('error', () => {});
    sock.on('end', () => {}); // sengaja tidak menutup sisi klien
    sock.on('connect', () => {
      const extra = Object.entries(extraHeaders).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      sock.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`,
      );
    });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        if (!buf.subarray(0, end).toString().startsWith('HTTP/1.1 101')) {
          clearTimeout(t);
          sock.destroy();
          reject(new Error(`upgrade ditolak: ${buf.subarray(0, end).toString().split('\r\n')[0]}`));
          return;
        }
        upgraded = true;
        buf = buf.subarray(end + 4);
        // FIN + teks, masked, panjang 16-bit = 5000 (> maxPayload 4096). Payload ikut dikirim.
        const header = Buffer.from([0x81, 0x80 | 126, 0x13, 0x88, 1, 2, 3, 4]);
        sock.write(Buffer.concat([header, Buffer.alloc(5000, 0x78)]));
      }
      // Cari close frame (opcode 0x8) dari server; sengaja tidak dibalas.
      const i = buf.indexOf(0x88);
      if (!done && i >= 0 && buf.length >= i + 4) {
        done = true;
        clearTimeout(t);
        resolve({ closeCode: buf.readUInt16BE(i + 2), sock });
      }
    });
  });
}

/** Tunggu sampai `pred()` benar; kembalikan lama menunggu (ms) atau -1 bila habis waktu. */
async function msUntil(pred, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (pred()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 25));
  }
  return -1;
}

// ------------------------------------------------------------------------------------------- S1
describe.each([
  ['lokal', {}, {}],
  ['token', { token: TOKEN }, BEARER],
])('S1 (mode %s): pesan WebSocket bermasalah hanya menutup koneksi pengirimnya', (_mode, opts, auth) => {
  let s;
  beforeAll(async () => {
    s = await startApp(opts);
  });
  afterAll(() => s.close());

  async function open() {
    const c = await wsConnect(s.port, { headers: auth });
    expect(c.status).toBe(101);
    return c.ws;
  }

  it('batas 4 KB: 4096 byte tetap terbuka, 4097 byte → close 1009', async () => {
    const a = await open();
    expect(await aliveAfter(a, (ws) => ws.send('x'.repeat(4096)))).toBe('pong');
    a.close();
    const b = await open();
    const closed = wsClosed(b, 3000);
    b.send('x'.repeat(4097));
    expect((await closed).code).toBe(1009);
  });

  it('5 KB teks dan 5 KB biner → close 1009', async () => {
    for (const [data, binary] of [['x'.repeat(5000), false], [Buffer.alloc(5000), true]]) {
      const ws = await open();
      const closed = wsClosed(ws, 3000);
      ws.send(data, { binary });
      expect((await closed).code, binary ? 'biner' : 'teks').toBe(1009);
    }
  });

  it('frame teks UTF-8 rusak (c3 28) → close 1007', async () => {
    const ws = await open();
    const closed = wsClosed(ws, 3000);
    ws.send(Buffer.from([0xc3, 0x28]), { binary: false });
    expect((await closed).code).toBe(1007);
  });

  it('server tetap hidup: /api/health 200 dan klien lain tetap menerima event baru', async () => {
    const good = await open();
    for (const bad of ['x'.repeat(5000), Buffer.from([0xc3, 0x28])]) {
      const ws = await open();
      const closed = wsClosed(ws, 3000);
      ws.send(bad, { binary: false });
      expect([1007, 1009]).toContain((await closed).code);
    }
    expect((await http(s.port, '/api/health')).status).toBe(200);
    const got = new Promise((resolve) => good.once('message', (m) => resolve(JSON.parse(m.toString()))));
    expect((await postEvents(s.port, { type: 'done', from: 'dev-qa', to: 'manager', message: 'masih hidup' }, auth)).status).toBe(202);
    expect((await got).event).toMatchObject({ type: 'done', message: 'masih hidup' });
    expect(good.readyState).toBe(1);
    good.close();
  });

  it('error dicatat sebagai baris [ws] (kode error saja, tanpa isi pesan)', () => {
    const ws = s.logs.filter((l) => l.startsWith('[ws]'));
    expect(ws).toContain('[ws] koneksi ditutup karena error: WS_ERR_UNSUPPORTED_MESSAGE_LENGTH');
    expect(ws).toContain('[ws] koneksi ditutup karena error: WS_ERR_INVALID_UTF8');
    expect(s.logs.join('\n')).not.toContain('xxxxxxxx');
  });
});

describe('S1: klien yang tidak menyelesaikan penutupan dibuang server dalam ~2 detik (bukan 30 detik bawaan ws)', () => {
  it.each([
    ['lokal', {}, {}],
    ['token', { token: TOKEN }, BEARER],
  ])('mode %s', async (_mode, opts, headers) => {
    const s = await startApp(opts);
    let sock;
    try {
      const r = await misbehavingClient(s.port, headers);
      sock = r.sock;
      expect(r.closeCode).toBe(1009);
      expect(s.app.wss.clients.size).toBe(1); // masih menunggu klien menutup
      const ms = await msUntil(() => s.app.wss.clients.size === 0, 8000);
      expect(ms, 'koneksi tidak pernah dibuang dalam 8 detik').toBeGreaterThanOrEqual(0);
      expect(ms).toBeGreaterThanOrEqual(1500);
      expect(ms).toBeLessThan(6000);
      expect((await http(s.port, '/api/health')).status).toBe(200);
    } finally {
      sock?.destroy();
      await s.close();
    }
  }, 15000);
});

// ------------------------------------------------------------------------------------------- S3
describe('S3: log event default hanya metadata, isi pesan hanya dengan logMessages', () => {
  const secretMsg = `Bash · psql postgres://admin:${randomToken(12)}@db.internal/prod`;
  const batch = [
    { type: 'working', from: 'dev-backend', to: 'manager', message: secretMsg },
    { type: 'assign', from: 'manager', to: 'dev-qa' },
  ];
  const eventLines = (logs) => logs.filter((l) => l.startsWith('[event]'));

  it.each([
    ['lokal', {}, {}],
    ['token', { token: TOKEN }, BEARER],
  ])('default (mode %s): "[event] type from → to (N karakter)" tanpa isi', async (_mode, opts, headers) => {
    const s = await startApp(opts);
    try {
      expect((await postEvents(s.port, batch, headers)).status).toBe(202);
      expect(eventLines(s.logs)).toEqual([
        `[event] working dev-backend → manager (${secretMsg.length} karakter)`,
        '[event] assign manager → dev-qa (0 karakter)',
      ]);
      expect(s.logs.join('\n')).not.toContain('psql');
    } finally {
      await s.close();
    }
  });

  it('logMessages: true → isi pesan ikut dicatat', async () => {
    const s = await startApp({ logMessages: true });
    try {
      await postEvents(s.port, batch);
      expect(eventLines(s.logs)).toEqual([`[event] working dev-backend → manager: ${secretMsg}`, '[event] assign manager → dev-qa']);
    } finally {
      await s.close();
    }
  });

  it('karakter kontrol di pesan tidak bisa memecah baris log (I4 + S3)', async () => {
    const s = await startApp({ logMessages: true });
    try {
      await postEvents(s.port, { type: 'done', from: 'a', to: 'b', message: 'ok\n[event] palsu manager → ceo\u001b\r\n' });
      const lines = eventLines(s.logs);
      expect(lines).toEqual(['[event] done a → b: ok [event] palsu manager → ceo']);
      expect(lines[0]).not.toMatch(/[\r\n\u001b]/);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- R7
describe('R7: trustProxy hanya boleh dengan HOST loopback', () => {
  it.each(['0.0.0.0', '127.0.0.2', '', '::', '192.168.1.10', 'office.example.com'])('HOST=%j + trustProxy + token kuat → Error', (host) => {
    let err;
    try {
      createAiOfficeServer({ host, port: 0, token: TOKEN, trustProxy: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/AI_OFFICE_TRUST_PROXY=1 hanya boleh dipakai dengan HOST loopback/);
    expect(err.message).not.toContain(TOKEN);
    expect(resolveAuthMode({ host, trustProxy: true, token: TOKEN }).error).toMatch(/HOST loopback/);
  });

  it.each(['127.0.0.1', 'localhost', '::1'])('HOST=%s + trustProxy + token kuat → boleh', async (host) => {
    expect(resolveAuthMode({ host, trustProxy: true, token: TOKEN }).error).toBeNull();
    const app = createAiOfficeServer({ host, port: 0, token: TOKEN, trustProxy: true });
    await app.close();
  });

  it('token pendek + HOST bukan loopback + trustProxy: kedua alasan penolakan disebut', () => {
    const m = resolveAuthMode({ host: '0.0.0.0', trustProxy: true, token: 'pendek' });
    expect(m.error).toMatch(/terlalu pendek/);
    expect(m.error).toMatch(/HOST loopback/);
  });
});

describe('R7: AI_OFFICE_ALLOWED_HOSTS hanya menerima host di daftar', () => {
  it('HOST loopback: host di daftar + loopback diterima, host lain 403 (HTTP dan WebSocket)', async () => {
    const s = await startApp({ allowedHosts: ['office.example.com'], token: TOKEN, trustProxy: true });
    try {
      for (const [host, status] of [
        ['office.example.com', 200],
        ['OFFICE.EXAMPLE.COM', 200],
        [`127.0.0.1:${s.port}`, 200],
        [`localhost:${s.port}`, 200],
        ['[::1]', 200],
        ['attacker-rebind.example', 403],
        ['office.example.com.evil', 403],
      ]) {
        expect((await http(s.port, '/api/health', { headers: { Host: host } })).status, host).toBe(status);
      }
      expect((await wsConnect(s.port, { headers: { ...BEARER, Host: 'attacker-rebind.example' } })).status).toBe(403);
      const ok = await wsConnect(s.port, { headers: { ...BEARER, Host: 'office.example.com' } });
      expect(ok.status).toBe(101);
      ok.ws.close();
    } finally {
      await s.close();
    }
  });

  it.skipIf(!CAN_BIND_127_0_0_2)(`HOST 127.0.0.2 + daftar: hanya host di daftar; localhost, attacker, dan IP sendiri → 403${SKIP_NOTE}`, async () => {
    const s = await startApp({ host: '127.0.0.2', allowedHosts: ['office.example.com'], token: TOKEN });
    try {
      for (const [host, status] of [
        ['office.example.com', 200],
        ['localhost', 403],
        [`localhost:${s.port}`, 403],
        ['attacker-rebind.example', 403],
        [`127.0.0.2:${s.port}`, 403],
        [`127.0.0.1:${s.port}`, 403],
      ]) {
        const r = await http(s.port, '/api/session', { host: '127.0.0.2', headers: { Host: host } });
        expect(r.status, host).toBe(status);
        if (status === 403) expect(r.json).toEqual({ ok: false, error: 'Host tidak diizinkan' });
      }
    } finally {
      await s.close();
    }
  });

  it.skipIf(!CAN_BIND_127_0_0_2)(`HOST 127.0.0.2 tanpa daftar: host apa pun diterima (perilaku lama)${SKIP_NOTE}`, async () => {
    const s = await startApp({ host: '127.0.0.2', token: TOKEN });
    try {
      expect((await http(s.port, '/api/health', { host: '127.0.0.2', headers: { Host: 'apa.saja.example' } })).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- I1
const connectSrc = (res) => (res.headers['content-security-policy'] ?? '').split('; ').find((d) => d.startsWith('connect-src'));

describe('I1: CSP connect-src hanya dari header Host yang lolos validasi', () => {
  let staticDir;
  beforeAll(() => {
    staticDir = mkdtempSync(join(tmpdir(), 'aio-csp-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>AI Office</title>');
  });
  afterAll(() => rmSync(staticDir, { recursive: true, force: true }));

  it('loopback: Host sah → \'self\' ws://h wss://h (termasuk IPv6 dalam kurung)', async () => {
    const s = await startApp({ staticDir });
    try {
      const v4 = await http(s.port, '/', { headers: { Host: `127.0.0.1:${s.port}` } });
      expect(connectSrc(v4)).toBe(`connect-src 'self' ws://127.0.0.1:${s.port} wss://127.0.0.1:${s.port}`);
      const v6 = await http(s.port, '/', { headers: { Host: `[::1]:${s.port}` } });
      expect(connectSrc(v6)).toBe(`connect-src 'self' ws://[::1]:${s.port} wss://[::1]:${s.port}`);
    } finally {
      await s.close();
    }
  });

  describe.skipIf(!CAN_BIND_127_0_0_2)(`server yang menerima Host apa pun (HOST 127.0.0.2, tanpa daftar)${SKIP_NOTE}`, () => {
    let s;
    beforeAll(async () => {
      s = await startApp({ host: '127.0.0.2', token: TOKEN, staticDir });
    });
    afterAll(() => s?.close());
    const get = (host) => http(s.port, '/', { host: '127.0.0.2', headers: { Host: host } });

    it.each([
      ['office.example.com', 'office.example.com'],
      ['Office.Example.COM:8443', 'office.example.com:8443'],
      ['[::1]:3000', '[::1]:3000'],
    ])('Host %j sah → ws://%s', async (host, normalized) => {
      const r = await get(host);
      expect(r.status).toBe(200);
      expect(connectSrc(r)).toBe(`connect-src 'self' ws://${normalized} wss://${normalized}`);
    });

    it.each([
      "evil.example;script-src 'unsafe-inline'",
      'a.example;report-uri=https://evil.example/r',
      "a.example 'unsafe-eval'",
      'a.example:99999',
      'a.example:0',
      'a.example,b.example',
    ])('Host %j tidak sah → connect-src \'self\' saja, tanpa sisipan', async (host) => {
      const r = await get(host);
      expect(r.status).toBe(200);
      const csp = r.headers['content-security-policy'];
      expect(connectSrc(r)).toBe("connect-src 'self'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|report-uri|evil|b\.example/);
      expect(csp.split('; ')).toHaveLength(9); // jumlah direktif tetap
      expect(csp).toMatch(/script-src 'self'; object-src 'none'/);
    });
  });
});

// ------------------------------------------------------------------------------------------- I2
describe('I2: mode terbuka — Origin harus sama persis (skema + host + port) dengan alamat publik', () => {
  let s;
  beforeAll(async () => {
    s = await startApp({ allowedHosts: ['office.example.com'], trustProxy: true, token: TOKEN });
  });
  afterAll(() => s.close());
  const pub = { Host: 'office.example.com', 'X-Forwarded-Proto': 'https', ...BEARER };

  it.each([
    ['tanpa Origin (hook/curl)', undefined, true],
    ['https://office.example.com', 'https://office.example.com', true],
    ['https://office.example.com:443 (port bawaan)', 'https://office.example.com:443', true],
    ['https://OFFICE.example.com (huruf besar)', 'https://OFFICE.example.com', true],
    ['http://office.example.com (skema beda)', 'http://office.example.com', false],
    ['https://office.example.com:8443 (port beda)', 'https://office.example.com:8443', false],
    ['http://localhost:5173 (dev server)', 'http://localhost:5173', false],
    ['http://127.0.0.1:3000 (loopback)', 'http://127.0.0.1:3000', false],
    ['null', 'null', false],
    ['https://evil.example', 'https://evil.example', false],
    ['https://office.example.com.evil', 'https://office.example.com.evil', false],
    ['https://sub.office.example.com', 'https://sub.office.example.com', false],
    ['file://', 'file://', false],
  ])('%s → /api/events dan /ws %s', async (_label, origin, allowed) => {
    const headers = { ...pub, ...(origin ? { Origin: origin } : {}) };
    const api = await http(s.port, '/api/events', { headers });
    expect(api.status).toBe(allowed ? 200 : 403);
    if (!allowed) expect(api.json).toEqual({ ok: false, error: 'Origin tidak diizinkan' });
    const ws = await wsConnect(s.port, { headers });
    expect(ws.status).toBe(allowed ? 101 : 403);
    ws.ws?.close();
  });

  it('POST /api/login memakai aturan yang sama', async () => {
    const noAuth = { Host: 'office.example.com', 'X-Forwarded-Proto': 'https' };
    expect((await login(s.port, TOKEN, { ...noAuth, Origin: 'https://office.example.com' })).status).toBe(200);
    expect((await login(s.port, TOKEN, { ...noAuth, Origin: 'http://localhost:5173' })).status).toBe(403);
    expect((await login(s.port, TOKEN, { ...noAuth, Origin: 'http://office.example.com' })).status).toBe(403);
  });

  it('X-Forwarded-Proto: http → hanya Origin http:// yang cocok', async () => {
    const h = { Host: 'office.example.com', 'X-Forwarded-Proto': 'http', ...BEARER };
    expect((await http(s.port, '/api/events', { headers: { ...h, Origin: 'http://office.example.com' } })).status).toBe(200);
    expect((await http(s.port, '/api/events', { headers: { ...h, Origin: 'https://office.example.com' } })).status).toBe(403);
  });

  it('tanpa X-Forwarded-Proto (skema tak pasti): http/https host itu diterima, host lain tetap 403', async () => {
    const h = { Host: 'office.example.com', ...BEARER };
    expect((await http(s.port, '/api/events', { headers: { ...h, Origin: 'https://office.example.com' } })).status).toBe(200);
    expect((await http(s.port, '/api/events', { headers: { ...h, Origin: 'http://office.example.com' } })).status).toBe(200);
    expect((await http(s.port, '/api/events', { headers: { ...h, Origin: 'http://localhost:5173' } })).status).toBe(403);
  });
});

describe.each([
  ['lokal', {}, {}],
  ['token di loopback', { token: 'pendek-loopback' }, { Authorization: 'Bearer pendek-loopback' }],
])('I2/M1: mode %s: Origin harus sama dengan Host (port lain di loopback ditolak)', (_mode, opts, auth) => {
  let s;
  beforeAll(async () => {
    s = await startApp(opts);
  });
  afterAll(() => s.close());

  it.each([
    ['http://localhost:5173', false],
    ['http://127.0.0.1:5173', false],
    ['http://localhost:8080', false],
    ['same-origin', true],
    ['same-origin-127', true],
    ['https://evil.example', false],
    ['null', false],
  ])('Origin %s → %s', async (origin, allowed) => {
    const o = origin === 'same-origin' ? `http://localhost:${s.port}` : origin === 'same-origin-127' ? `http://127.0.0.1:${s.port}` : origin;
    const headers = { ...auth, Origin: o };
    expect((await http(s.port, '/api/events', { headers })).status).toBe(allowed ? 200 : 403);
    const ws = await wsConnect(s.port, { headers });
    expect(ws.status).toBe(allowed ? 101 : 403);
    ws.ws?.close();
  });
});

// ------------------------------------------------------------------------------------------- I3
describe('I3: cookie aio_session palsu di depan tidak bisa menutupi cookie sah', () => {
  let s;
  let cookie;
  beforeAll(async () => {
    s = await startApp({ token: TOKEN });
    cookie = cookieFrom(await login(s.port, TOKEN));
  });
  afterAll(() => s.close());
  const withFakes = (n, between = '') =>
    [...Array.from({ length: n }, (_, i) => `aio_session=v1.1.palsu${i}${between}`), cookie].join('; ');

  it('batas pemeriksaan 20 cookie aio_session per request', () => {
    expect(MAX_SESSION_COOKIES).toBe(20);
    expect(cookie).toMatch(/^aio_session=v1\./);
  });

  it.each([
    [0, 200],
    [1, 200],
    [19, 200],
    [20, 401],
    [30, 401],
  ])('%i cookie palsu lalu cookie sah → %i', async (n, status) => {
    expect((await http(s.port, '/api/events', { headers: { Cookie: withFakes(n) } })).status).toBe(status);
    expect((await http(s.port, '/api/session', { headers: { Cookie: withFakes(n) } })).json.authenticated).toBe(status === 200);
  });

  it('cookie lain (bukan aio_session) di antaranya tidak ikut dihitung', async () => {
    expect((await http(s.port, '/api/events', { headers: { Cookie: withFakes(19, '; lain=1; x=2') } })).status).toBe(200);
  });

  it('WebSocket: 19 palsu → 101, 20 palsu → 401', async () => {
    const ok = await wsConnect(s.port, { headers: { Cookie: withFakes(19) } });
    expect(ok.status).toBe(101);
    ok.ws.close();
    expect((await wsConnect(s.port, { headers: { Cookie: withFakes(20) } })).status).toBe(401);
  });

  it('Bearer tetap jalan walau ada 30 cookie palsu', async () => {
    expect((await http(s.port, '/api/events', { headers: { ...BEARER, Cookie: withFakes(30) } })).status).toBe(200);
  });
});
