// Kontrak autentikasi server (Bagian 4): server/auth.js + server/app.js di dalam proses test, port 0.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAiOfficeServer } from '../server/app.js';
import {
  LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, MIN_OPEN_TOKEN_LENGTH, SESSION_MAX_AGE_S,
  createAuth, createLoginLimiter, resolveAuthMode, safeEqual,
} from '../server/auth.js';
import {
  JSON_HEADERS, cookieFrom, http, login, randomToken, startApp, wsClosed, wsConnect,
} from './helpers/testkit.js';

const EVENT = { type: 'done', from: 'dev-qa', to: 'manager', message: 'uji auth' };
const COOKIE_RE = /^aio_session=v1\.(\d+)\.([A-Za-z0-9_-]+); HttpOnly; SameSite=Strict; Path=\/; Max-Age=604800$/;
const setCookieOf = (res) => [].concat(res.headers['set-cookie'] ?? []);
const postEvent = (port, headers = {}, body = EVENT) =>
  http(port, '/api/events', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const wrongLogin = (port, headers = {}) => login(port, 'salah-sekali', headers);

/** Cookie dari createAuth dengan jam yang digeser (titik injeksi `now`), tanpa meniru format sendiri. */
const cookieIssuedAt = (token, ms) => {
  const header = createAuth({ token, now: () => ms }).sessionCookie({ headers: {}, socket: {} });
  return header.split(';')[0];
};

describe('konstanta kontrak', () => {
  it('nilai sesuai kontrak (7 hari, 32 karakter, 10 kegagalan per 15 menit)', () => {
    expect(SESSION_MAX_AGE_S).toBe(604800);
    expect(MIN_OPEN_TOKEN_LENGTH).toBe(32);
    expect(LOGIN_MAX_FAILURES).toBe(10);
    expect(LOGIN_WINDOW_MS).toBe(15 * 60 * 1000);
  });
});

// ------------------------------------------------------------------------------------ mode lokal
describe('mode lokal (tanpa token): perilaku lama tidak berubah', () => {
  let s;
  beforeAll(async () => {
    s = await startApp();
  });
  afterAll(() => s.close());

  it('GET /api/session → authRequired false, authenticated true', async () => {
    const r = await http(s.port, '/api/session');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, authRequired: false, authenticated: true });
  });

  it('GET/POST /api/events tanpa autentikasi tetap jalan; Bearer acak tidak mengganggu', async () => {
    expect((await postEvent(s.port)).status).toBe(202);
    expect((await postEvent(s.port, bearer('acak'))).status).toBe(202);
    const r = await http(s.port, '/api/events');
    expect(r.status).toBe(200);
    expect(r.json.events.at(-1)).toMatchObject({ type: 'done', message: 'uji auth' });
  });

  it('POST /api/login apa saja → 200 tanpa cookie; logout → 200', async () => {
    const r = await login(s.port, 'apa saja');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(r.headers['set-cookie']).toBeUndefined();
    const out = await http(s.port, '/api/logout', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(out.status).toBe(200);
  });

  it('/api/health tetap memuat jumlah klien dan event', async () => {
    const r = await http(s.port, '/api/health');
    expect(r.json).toMatchObject({ ok: true });
    expect(typeof r.json.clients).toBe('number');
    expect(typeof r.json.events).toBe('number');
  });

  it('WebSocket tanpa autentikasi → hello', async () => {
    const c = await wsConnect(s.port);
    expect(c.status).toBe(101);
    expect(c.hello.kind).toBe('hello');
    c.ws.close();
  });
});

// ------------------------------------------------------------------------- penentuan mode / start
describe('mode terbuka wajib token ≥ 32 karakter', () => {
  const short = randomToken().slice(0, 31);
  const exact = randomToken().slice(0, 32);
  const bad = [
    ['HOST=0.0.0.0 tanpa token', { host: '0.0.0.0' }, /kosong/],
    ['HOST=0.0.0.0 token 31 karakter', { host: '0.0.0.0', token: short }, /terlalu pendek/],
    ['HOST="" (semua antarmuka)', { host: '' }, /kosong/],
    ['HOST=:: tanpa token', { host: '::' }, /kosong/],
    ['allowedHosts terisi tanpa token', { allowedHosts: ['office.example.com'] }, /kosong/],
    ['trustProxy tanpa token', { trustProxy: true }, /kosong/],
    ['trustProxy + token pendek', { trustProxy: true, token: short }, /terlalu pendek/],
    ['token 32 spasi (kosong setelah trim)', { host: '0.0.0.0', token: ' '.repeat(32) }, /kosong/],
    ['token 31 + spasi di tepi (31 setelah trim)', { host: '0.0.0.0', token: `  ${short}  ` }, /terlalu pendek/],
  ];

  it.each(bad)('%s → createAiOfficeServer melempar Error tanpa membocorkan token', (_n, opts, re) => {
    let err;
    try {
      createAiOfficeServer({ port: 0, ...opts });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/mode terbuka/);
    expect(err.message).toMatch(re);
    expect(err.message).toMatch(/32 karakter/);
    if (opts.token?.trim()) expect(err.message).not.toContain(opts.token.trim());
  });

  it('token tepat 32 karakter diterima di mode terbuka (tidak di-listen, hanya dibuat)', async () => {
    const app = createAiOfficeServer({ host: '0.0.0.0', port: 0, token: exact });
    await app.close();
    const app2 = createAiOfficeServer({ allowedHosts: ['office.example.com'], trustProxy: true, port: 0, token: exact });
    await app2.close();
  });

  it('loopback + token pendek tetap boleh (mode token, bukan mode terbuka)', async () => {
    const s = await startApp({ token: 'abc' });
    try {
      expect((await http(s.port, '/api/session')).json).toEqual({ ok: true, authRequired: true, authenticated: false });
      expect((await login(s.port, 'abc')).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('resolveAuthMode: alasan mode terbuka dan pembedaan lokal/token', () => {
    expect(resolveAuthMode({})).toMatchObject({ tokenMode: false, open: false, error: null });
    expect(resolveAuthMode({ host: 'localhost', token: 'x' })).toMatchObject({ tokenMode: true, open: false, error: null });
    expect(resolveAuthMode({ host: '::1' })).toMatchObject({ open: false });
    // Konfigurasi VPS yang sah: HOST loopback di belakang Nginx (2 alasan mode terbuka).
    const vps = resolveAuthMode({ host: '127.0.0.1', allowedHosts: ['a.example'], trustProxy: true, token: exact });
    expect(vps).toMatchObject({ tokenMode: true, open: true, error: null });
    expect(vps.reasons).toEqual(['AI_OFFICE_ALLOWED_HOSTS terisi', 'AI_OFFICE_TRUST_PROXY=1']);
    // HOST bukan loopback tanpa trustProxy tetap boleh (dengan token kuat).
    const direct = resolveAuthMode({ host: '0.0.0.0', allowedHosts: ['a.example'], token: exact });
    expect(direct).toMatchObject({ tokenMode: true, open: true, error: null });
    expect(direct.reasons).toHaveLength(2);
    // R7: ketiga alasan sekaligus (HOST 0.0.0.0 + trustProxy) sekarang DITOLAK walau token kuat.
    const m = resolveAuthMode({ host: '0.0.0.0', allowedHosts: ['a.example'], trustProxy: true, token: exact });
    expect(m).toMatchObject({ tokenMode: true, open: true });
    expect(m.reasons).toHaveLength(3);
    expect(m.error).toMatch(/AI_OFFICE_TRUST_PROXY=1 hanya boleh dipakai dengan HOST loopback/);
    expect(m.error).not.toContain(exact);
  });
});

// ------------------------------------------------------------------------------------ mode token
describe('mode token: login, cookie, dan akses', () => {
  const TOKEN = randomToken();
  let s;
  let cookie;
  let staticDir;
  beforeAll(async () => {
    staticDir = mkdtempSync(join(tmpdir(), 'aio-auth-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>AI Office</title>');
    s = await startApp({ token: TOKEN, staticDir });
    cookie = cookieFrom(await login(s.port, TOKEN));
  });
  afterAll(async () => {
    await s.close();
    rmSync(staticDir, { recursive: true, force: true });
  });

  it('GET /api/session tanpa autentikasi → authRequired true, authenticated false', async () => {
    const r = await http(s.port, '/api/session');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, authRequired: true, authenticated: false });
  });

  it('POST /api/login token benar → 200 + Set-Cookie dengan atribut lengkap, exp ≈ sekarang + 7 hari', async () => {
    const r = await login(s.port, TOKEN);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    const sc = setCookieOf(r);
    expect(sc).toHaveLength(1);
    const m = COOKIE_RE.exec(sc[0]);
    expect(m, sc[0]).not.toBeNull();
    expect(sc[0]).not.toMatch(/Secure/);
    const exp = Number(m[1]);
    const expected = Math.floor(Date.now() / 1000) + 604800;
    expect(Math.abs(exp - expected)).toBeLessThanOrEqual(5);
    expect(sc[0]).not.toContain(TOKEN);
    expect(r.body).not.toContain(TOKEN);
  });

  it('token dengan spasi di tepi (sisa tempel) tetap diterima', async () => {
    expect((await login(s.port, `  ${TOKEN}\n`)).status).toBe(200);
  });

  it('token salah → 401 "Token salah" tanpa cookie; body aneh juga 401/400/415', async () => {
    const r = await wrongLogin(s.port);
    expect(r.status).toBe(401);
    expect(r.json).toEqual({ ok: false, error: 'Token salah' });
    expect(r.headers['set-cookie']).toBeUndefined();
    // Setiap variasi di bawah dihitung terpisah; server ini dipakai banyak test, jadi jumlahnya < 10.
    expect((await http(s.port, '/api/login', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(401);
    expect((await http(s.port, '/api/login', { method: 'POST', headers: JSON_HEADERS, body: { token: 12345 } })).status).toBe(401);
    expect((await http(s.port, '/api/login', { method: 'POST', headers: JSON_HEADERS, body: '{rusak' })).status).toBe(400);
    expect((await http(s.port, '/api/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: TOKEN })).status).toBe(415);
    expect((await http(s.port, '/api/login')).status).toBe(405);
  });

  it('cookie sah membuka /api/events (GET dan POST), /api/session, dan WebSocket', async () => {
    expect(cookie).toMatch(/^aio_session=v1\./);
    expect((await http(s.port, '/api/events', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await postEvent(s.port, { Cookie: cookie })).status).toBe(202);
    expect((await http(s.port, '/api/session', { headers: { Cookie: cookie } })).json).toEqual({ ok: true, authRequired: true, authenticated: true });
    const c = await wsConnect(s.port, { headers: { Cookie: cookie } });
    expect(c.status).toBe(101);
    expect(c.hello.kind).toBe('hello');
    c.ws.close();
  });

  it('cookie bersama cookie lain, dalam tanda kutip, atau didahului cookie palsu tetap dikenali', async () => {
    const v = cookie.slice('aio_session='.length);
    for (const header of [`a=1; ${cookie}; b=2`, `aio_session="${v}"`, `aio_session=v1.1.palsu; ${cookie}`]) {
      expect((await http(s.port, '/api/events', { headers: { Cookie: header } })).status, header).toBe(200);
    }
  });

  it('Bearer token benar membuka /api/events dan WebSocket; "bearer" huruf kecil juga', async () => {
    expect((await http(s.port, '/api/events', { headers: bearer(TOKEN) })).status).toBe(200);
    expect((await postEvent(s.port, { Authorization: `bearer   ${TOKEN}  ` })).status).toBe(202);
    expect((await http(s.port, '/api/session', { headers: bearer(TOKEN) })).json.authenticated).toBe(true);
    const c = await wsConnect(s.port, { headers: bearer(TOKEN) });
    expect(c.status).toBe(101);
    c.ws.close();
  });

  it('tanpa autentikasi: GET/POST /api/events → 401 + WWW-Authenticate: Bearer, event tidak tersimpan', async () => {
    const before = s.app.history.length;
    for (const r of [await http(s.port, '/api/events'), await postEvent(s.port)]) {
      expect(r.status).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Bearer');
      expect(r.json).toEqual({ ok: false, error: 'Butuh autentikasi' });
    }
    expect(s.app.history.length).toBe(before);
  });

  it('kredensial salah: Bearer salah, skema Basic, token sebagai cookie mentah → 401', async () => {
    const tries = [
      bearer(`${TOKEN}x`),
      bearer(TOKEN.slice(0, -1)),
      { Authorization: `Basic ${TOKEN}` },
      { Authorization: TOKEN },
      { Cookie: `aio_session=${TOKEN}` },
    ];
    for (const headers of tries) expect((await http(s.port, '/api/events', { headers })).status).toBe(401);
  });

  it('cookie palsu atau rusak ditolak: tanda tangan acak, exp diubah, versi lain, nama lain, terlalu panjang', async () => {
    const [, exp, sig] = /^aio_session=v1\.(\d+)\.(.+)$/.exec(cookie);
    const fakes = [
      `aio_session=v1.${exp}.${'A'.repeat(sig.length)}`,
      `aio_session=v1.${Number(exp) - 1}.${sig}`,
      `aio_session=v2.${exp}.${sig}`,
      `aio_session=v1.${exp}`,
      `aio_session=v1.${exp}.${sig}.x`,
      `aio_session=v1.-5.${sig}`,
      `aio_session2=v1.${exp}.${sig}`,
      `aio_session=v1.${exp}.${sig}${'A'.repeat(200)}`,
      'aio_session=',
    ];
    for (const c of fakes) {
      expect((await http(s.port, '/api/events', { headers: { Cookie: c } })).status, c).toBe(401);
      expect((await http(s.port, '/api/session', { headers: { Cookie: c } })).json.authenticated, c).toBe(false);
    }
    const ws = await wsConnect(s.port, { headers: { Cookie: fakes[0] } });
    expect(ws.status).toBe(401);
  });

  it('cookie kedaluwarsa atau exp terlalu jauh di masa depan ditolak (jam digeser lewat injeksi now)', async () => {
    const now = Date.now();
    const expired = cookieIssuedAt(TOKEN, now - (SESSION_MAX_AGE_S + 10) * 1000);
    const future = cookieIssuedAt(TOKEN, now + 2 * 60 * 60 * 1000); // exp = sekarang + 7 hari + 2 jam
    const valid = cookieIssuedAt(TOKEN, now - 24 * 60 * 60 * 1000); // sisa 6 hari
    expect((await http(s.port, '/api/events', { headers: { Cookie: expired } })).status).toBe(401);
    expect((await http(s.port, '/api/events', { headers: { Cookie: future } })).status).toBe(401);
    expect((await http(s.port, '/api/events', { headers: { Cookie: valid } })).status).toBe(200);
    expect((await wsConnect(s.port, { headers: { Cookie: expired } })).status).toBe(401);
  });

  it('?token= di query string tidak diterima (events, WebSocket, login)', async () => {
    const q = `?token=${encodeURIComponent(TOKEN)}`;
    expect((await http(s.port, `/api/events${q}`)).status).toBe(401);
    expect((await http(s.port, `/api/events${q}`, { method: 'POST', headers: JSON_HEADERS, body: EVENT })).status).toBe(401);
    expect((await http(s.port, `/api/session${q}`)).json.authenticated).toBe(false);
    expect((await wsConnect(s.port, { path: `/ws${q}` })).status).toBe(401);
  });

  it('method lain ke /api/events: tanpa auth 401 (auth dulu), dengan Bearer 405', async () => {
    expect((await http(s.port, '/api/events', { method: 'DELETE' })).status).toBe(401);
    expect((await http(s.port, '/api/events', { method: 'DELETE', headers: bearer(TOKEN) })).status).toBe(405);
    expect((await http(s.port, '/api/session', { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status).toBe(405);
  });

  it('/api/health di mode token hanya {ok:true}', async () => {
    const r = await http(s.port, '/api/health');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect((await http(s.port, '/api/health', { headers: bearer(TOKEN) })).json).toEqual({ ok: true });
  });

  it('WebSocket: tanpa auth 401 + WWW-Authenticate, Origin asing 403 (meski cookie sah), path lain 403', async () => {
    const none = await wsConnect(s.port);
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect((await wsConnect(s.port, { headers: { Cookie: cookie, Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await wsConnect(s.port, { headers: { ...bearer(TOKEN), Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await wsConnect(s.port, { path: '/wsx', headers: bearer(TOKEN) })).status).toBe(403);
    const ok = await wsConnect(s.port, { headers: { Cookie: cookie, Origin: `http://127.0.0.1:${s.port}` } });
    expect(ok.status).toBe(101);
    ok.ws.close();
  });

  it('Origin asing ditolak di /api/login dan /api/events (403), Host asing 403', async () => {
    expect((await login(s.port, TOKEN, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await http(s.port, '/api/events', { headers: { ...bearer(TOKEN), Origin: 'https://evil.example' } })).status).toBe(403);
    expect((await http(s.port, '/api/session', { headers: { Host: 'evil.example' } })).status).toBe(403);
  });

  it('POST /api/logout → 200 + cookie dihapus (Max-Age=0); body kosong boleh, Content-Type wajib JSON', async () => {
    const r = await http(s.port, '/api/logout', { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookie }, body: '' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(setCookieOf(r)).toEqual(['aio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0']);
    expect((await http(s.port, '/api/logout', { method: 'POST', body: '{}' })).status).toBe(415);
    expect((await http(s.port, '/api/logout')).status).toBe(405);
  });

  it('token tidak pernah muncul di log server', () => {
    expect(s.logs.length).toBeGreaterThan(0);
    for (const line of s.logs) expect(line).not.toContain(TOKEN);
    expect(s.logs.some((l) => l.includes('[auth] login berhasil'))).toBe(true);
    expect(s.logs.some((l) => l.includes('[auth] login gagal'))).toBe(true);
  });

  it('UI statis tetap bisa dibuka tanpa login (supaya layar login tampil)', async () => {
    const r = await http(s.port, '/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('AI Office');
  });
});

// -------------------------------------------------------------------------------- ganti token
describe('ganti token membatalkan cookie lama; restart dengan token sama tidak', () => {
  it('cookie dari token A: ditolak server token B, diterima server baru dengan token A', async () => {
    const A = randomToken();
    const B = randomToken();
    const a = await startApp({ token: A });
    const cookieA = cookieFrom(await login(a.port, A));
    await a.close();

    const b = await startApp({ token: B });
    try {
      expect((await http(b.port, '/api/events', { headers: { Cookie: cookieA } })).status).toBe(401);
      expect((await http(b.port, '/api/session', { headers: { Cookie: cookieA } })).json.authenticated).toBe(false);
      expect((await wsConnect(b.port, { headers: { Cookie: cookieA } })).status).toBe(401);
      expect((await http(b.port, '/api/events', { headers: bearer(A) })).status).toBe(401);
      expect((await login(b.port, A)).status).toBe(401);
    } finally {
      await b.close();
    }

    const a2 = await startApp({ token: A });
    try {
      expect((await http(a2.port, '/api/events', { headers: { Cookie: cookieA } })).status).toBe(200);
    } finally {
      await a2.close();
    }
  });
});

// --------------------------------------------------------------------------------- rate limit
describe('batas percobaan login (10 gagal per IP per 15 menit)', () => {
  it('10× salah → 401, ke-11 → 429 + Retry-After; token benar pun ditolak; Bearer dan cookie tetap jalan', async () => {
    const T = randomToken();
    const s = await startApp({ token: T });
    try {
      const cookie = cookieFrom(await login(s.port, T)); // sukses tidak dihitung
      for (let i = 1; i <= 10; i++) {
        const r = await wrongLogin(s.port);
        expect(r.status, `percobaan ${i}`).toBe(401);
      }
      const blocked = await wrongLogin(s.port);
      expect(blocked.status).toBe(429);
      expect(blocked.json).toEqual({ ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' });
      const ra = Number(blocked.headers['retry-after']);
      expect(Number.isInteger(ra)).toBe(true);
      expect(ra).toBeGreaterThanOrEqual(1);
      expect(ra).toBeLessThanOrEqual(900);
      const right = await login(s.port, T);
      expect(right.status).toBe(429);
      expect(right.headers['set-cookie']).toBeUndefined();
      // IP diblokir hanya untuk login
      expect((await http(s.port, '/api/events', { headers: bearer(T) })).status).toBe(200);
      expect((await postEvent(s.port, bearer(T))).status).toBe(202);
      expect((await http(s.port, '/api/events', { headers: { Cookie: cookie } })).status).toBe(200);
      const ws = await wsConnect(s.port, { headers: bearer(T) });
      expect(ws.status).toBe(101);
      ws.ws.close();
      expect(s.logs.filter((l) => l.includes('diblokir sementara'))).toHaveLength(1);
    } finally {
      await s.close();
    }
  });

  it('25 request salah paralel dari satu IP → tepat 10× 401 dan 15× 429', async () => {
    const s = await startApp({ token: randomToken() });
    try {
      const rs = await Promise.all(Array.from({ length: 25 }, () => wrongLogin(s.port)));
      const count = (st) => rs.filter((r) => r.status === st).length;
      expect({ 401: count(401), 429: count(429) }).toEqual({ 401: 10, 429: 15 });
    } finally {
      await s.close();
    }
  });

  it('login sukses mengosongkan hitungan kegagalan IP itu', async () => {
    const T = randomToken();
    const s = await startApp({ token: T });
    try {
      for (let i = 0; i < 9; i++) expect((await wrongLogin(s.port)).status).toBe(401);
      expect((await login(s.port, T)).status).toBe(200);
      for (let i = 0; i < 10; i++) expect((await wrongLogin(s.port)).status).toBe(401);
      expect((await wrongLogin(s.port)).status).toBe(429);
    } finally {
      await s.close();
    }
  });
});

// ----------------------------------------------------------------------- jam palsu (vi.useFakeTimers)
describe('waktu: kedaluwarsa sesi dan jendela rate limit (Date dipalsukan)', () => {
  const T0 = new Date('2026-11-08T00:00:00Z').getTime();
  afterEach(() => vi.useRealTimers());

  it('cookie sah sampai 7 hari, ditolak tepat saat exp', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const T = randomToken();
    const s = await startApp({ token: T });
    try {
      const cookie = cookieFrom(await login(s.port, T));
      expect(cookie).toBe(`aio_session=v1.${T0 / 1000 + 604800}.${cookie.split('.')[2]}`);
      vi.setSystemTime(T0 + (604800 - 1) * 1000);
      expect((await http(s.port, '/api/events', { headers: { Cookie: cookie } })).status).toBe(200);
      vi.setSystemTime(T0 + 604800 * 1000);
      expect((await http(s.port, '/api/events', { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await http(s.port, '/api/session', { headers: { Cookie: cookie } })).json.authenticated).toBe(false);
      expect((await wsConnect(s.port, { headers: { Cookie: cookie } })).status).toBe(401);
      // Bearer tidak punya masa berlaku
      expect((await http(s.port, '/api/events', { headers: bearer(T) })).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('Retry-After menghitung mundur dan blokir lepas setelah 15 menit', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const T = randomToken();
    const s = await startApp({ token: T });
    try {
      for (let i = 0; i < 10; i++) await wrongLogin(s.port);
      expect((await wrongLogin(s.port)).headers['retry-after']).toBe('900');
      vi.setSystemTime(T0 + 5 * 60 * 1000);
      expect((await wrongLogin(s.port)).headers['retry-after']).toBe('600');
      vi.setSystemTime(T0 + 15 * 60 * 1000 - 1);
      expect((await login(s.port, T)).status).toBe(429);
      vi.setSystemTime(T0 + 15 * 60 * 1000);
      expect((await login(s.port, T)).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('WebSocket dengan cookie ditutup 4401 saat sesi habis; koneksi Bearer tetap terbuka', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T0);
    const T = randomToken();
    const s = await startApp({ token: T });
    try {
      const cookie = cookieFrom(await login(s.port, T));
      const viaCookie = await wsConnect(s.port, { headers: { Cookie: cookie } });
      const viaBearer = await wsConnect(s.port, { headers: bearer(T) });
      expect([viaCookie.status, viaBearer.status]).toEqual([101, 101]);
      const closed = wsClosed(viaCookie.ws);
      vi.setSystemTime(T0 + 604800 * 1000);
      vi.advanceTimersByTime(30000); // satu detak heartbeat
      expect(await closed).toEqual({ code: 4401, reason: 'Sesi kedaluwarsa' });
      expect(viaBearer.ws.readyState).toBe(1);
      viaBearer.ws.close();
    } finally {
      await s.close();
    }
  });
});

// ----------------------------------------------------------------- trust proxy: IP dan HTTPS
describe('trustProxy: X-Real-IP dan X-Forwarded-Proto', () => {
  it('dengan trustProxy: blokir per X-Real-IP, IP lain dan IP soket tidak ikut terblokir', async () => {
    const s = await startApp({ token: randomToken(), trustProxy: true });
    try {
      const A = { 'X-Real-IP': '203.0.113.7' };
      for (let i = 0; i < 10; i++) expect((await wrongLogin(s.port, A)).status).toBe(401);
      expect((await wrongLogin(s.port, A)).status).toBe(429);
      expect((await wrongLogin(s.port, { 'X-Real-IP': '::ffff:203.0.113.7' })).status).toBe(429); // dinormalisasi
      expect((await wrongLogin(s.port, { 'X-Real-IP': '203.0.113.7, 198.51.100.1' })).status).toBe(429); // nilai pertama
      expect((await wrongLogin(s.port, { ...A, 'X-Forwarded-For': '198.51.100.9' })).status).toBe(429); // XFF tidak dipakai
      expect((await wrongLogin(s.port, { 'X-Real-IP': '203.0.113.8' })).status).toBe(401);
      expect((await wrongLogin(s.port)).status).toBe(401); // tanpa header → IP soket
      expect(s.logs.some((l) => l.includes('login gagal dari 203.0.113.7'))).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('dengan trustProxy: X-Real-IP tidak valid → pakai IP soket', async () => {
    const s = await startApp({ token: randomToken(), trustProxy: true });
    try {
      for (let i = 0; i < 10; i++) await wrongLogin(s.port, { 'X-Real-IP': 'bukan-ip' });
      expect((await wrongLogin(s.port)).status).toBe(429);
    } finally {
      await s.close();
    }
  });

  it('tanpa trustProxy: X-Real-IP diabaikan (ganti header tidak melepas blokir)', async () => {
    const s = await startApp({ token: randomToken() });
    try {
      for (let i = 0; i < 10; i++) await wrongLogin(s.port, { 'X-Real-IP': `203.0.113.${i + 1}` });
      expect((await wrongLogin(s.port, { 'X-Real-IP': '198.51.100.77' })).status).toBe(429);
      expect((await wrongLogin(s.port)).status).toBe(429);
      expect(s.logs.some((l) => /203\.0\.113|198\.51\.100/.test(l))).toBe(false);
    } finally {
      await s.close();
    }
  });

  it('Secure hanya bila trustProxy + X-Forwarded-Proto: https (login dan logout)', async () => {
    const T = randomToken();
    const proxied = await startApp({ token: T, trustProxy: true });
    const direct = await startApp({ token: T });
    const https = { 'X-Forwarded-Proto': 'https' };
    try {
      const sc = (r) => setCookieOf(r)[0];
      expect(sc(await login(proxied.port, T, https))).toMatch(/; Secure$/);
      expect(sc(await login(proxied.port, T, { 'X-Forwarded-Proto': 'HTTPS, http' }))).toMatch(/; Secure$/);
      expect(sc(await login(proxied.port, T, { 'X-Forwarded-Proto': 'http' }))).not.toMatch(/Secure/);
      expect(sc(await login(proxied.port, T))).not.toMatch(/Secure/);
      expect(sc(await login(direct.port, T, https))).not.toMatch(/Secure/);
      const out = await http(proxied.port, '/api/logout', { method: 'POST', headers: { ...JSON_HEADERS, ...https }, body: '{}' });
      expect(sc(out)).toBe('aio_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0; Secure');
      const outDirect = await http(direct.port, '/api/logout', { method: 'POST', headers: { ...JSON_HEADERS, ...https }, body: '{}' });
      expect(sc(outDirect)).not.toMatch(/Secure/);
      // Cookie bertanda Secure tetap sama nilainya (dicek server lewat header Cookie biasa)
      const cookie = cookieFrom(await login(proxied.port, T, https));
      expect((await http(proxied.port, '/api/events', { headers: { Cookie: cookie } })).status).toBe(200);
    } finally {
      await proxied.close();
      await direct.close();
    }
  });

  it('allowedHosts: Host/Origin domain publik diterima, domain lain ditolak', async () => {
    const T = randomToken();
    const s = await startApp({ token: T, trustProxy: true, allowedHosts: ['office.example.com'] });
    try {
      const pub = { Host: 'office.example.com', Origin: 'https://office.example.com', 'X-Forwarded-Proto': 'https' };
      expect((await login(s.port, T, pub)).status).toBe(200);
      expect((await http(s.port, '/api/session', { headers: { Host: 'evil.example' } })).status).toBe(403);
      expect((await http(s.port, '/api/session', { headers: { Host: 'office.example.com', Origin: 'https://evil.example' } })).status).toBe(403);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------- unit: auth.js murni
describe('server/auth.js (unit, jam diinjeksi)', () => {
  it('safeEqual membandingkan isi, bukan panjang', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });

  it('createAuth: cookie dari jam X sah sampai X + 7 hari', () => {
    let t = 1_000_000_000_000;
    const auth = createAuth({ token: 'rahasia', now: () => t });
    const v = auth.sessionCookie({ headers: {}, socket: {} }).split(';')[0];
    const req = { headers: { cookie: v }, socket: {} };
    expect(auth.check(req)).toEqual({ ok: true, expiresAtMs: (Math.floor(t / 1000) + 604800) * 1000 });
    t += 604800 * 1000 - 1000;
    expect(auth.check(req).ok).toBe(true);
    t += 1000;
    expect(auth.check(req).ok).toBe(false);
    expect(auth.check({ headers: { authorization: 'Bearer rahasia' }, socket: {} })).toEqual({ ok: true, expiresAtMs: Infinity });
  });

  it('createAuth tanpa token: semua request sah (mode lokal)', () => {
    const auth = createAuth({});
    expect(auth.enabled).toBe(false);
    expect(auth.check({ headers: {} })).toEqual({ ok: true, expiresAtMs: Infinity });
    expect(auth.tokenMatches('')).toBe(false);
  });

  it('createLoginLimiter: jendela tetap, reset, dan batas jumlah entri', () => {
    let t = 0;
    const lim = createLoginLimiter({ maxFailures: 3, windowMs: 1000, maxEntries: 2, now: () => t });
    expect(lim.check('a')).toEqual({ allowed: true });
    lim.fail('a');
    lim.fail('a');
    t = 500;
    expect(lim.fail('a')).toBe(3);
    expect(lim.check('a')).toEqual({ allowed: false, retryAfterS: 1 });
    t = 1000; // jendela dihitung dari kegagalan pertama (t=0)
    expect(lim.check('a')).toEqual({ allowed: true });
    lim.fail('b');
    lim.fail('c');
    lim.fail('d'); // maxEntries 2: yang tertua dibuang
    expect(lim.size).toBe(2);
    lim.reset('d');
    expect(lim.size).toBe(1);
  });

  it('createLoginLimiter: jam mundur (entri tidak urut) tidak membuat blokir abadi', () => {
    let t = 10_000;
    const lim = createLoginLimiter({ maxFailures: 1, windowMs: 1000, now: () => t });
    lim.fail('x'); // resetAt 11000
    t = 5_000; // jam mundur
    lim.fail('y'); // resetAt 6000, disisipkan SETELAH x
    expect(lim.check('y').allowed).toBe(false);
    t = 7_000; // y sudah lewat, x belum: sweep berhenti di x, y dibuang manual
    expect(lim.check('y')).toEqual({ allowed: true });
    expect(lim.check('x')).toEqual({ allowed: false, retryAfterS: 4 });
  });
});
