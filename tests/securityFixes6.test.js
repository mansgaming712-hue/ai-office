// Perbaikan keamanan: cookie v2 + daftar cabut, rate limit login IPv6 /64 + X-Real-IP wajib di belakang proxy,
// dan Origin loopback hanya untuk port server sendiri / devPorts.
// Server di dalam proses dengan port 0; token acak. Tidak menyentuh port 3000.
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MAX_REVOKED_SESSIONS, SESSION_COOKIE, createAuth } from '../server/auth.js';
import { JSON_HEADERS, cookieFrom, http, login, randomToken, startApp, wsConnect } from './helpers/testkit.js';

const TOKEN = randomToken();
const reqOf = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress } });
const ipKey = (ip, opts = {}) =>
  createAuth({ token: TOKEN, ...opts }).clientIp(opts.trustProxy ? reqOf({ 'x-real-ip': ip }) : reqOf({}, ip));
const cookieOf = (setCookie) => /^aio_session=([^;]*)/.exec(setCookie)[1];
const cookieReq = (v) => reqOf({ cookie: `${SESSION_COOKIE}=${v}` });

describe('cookie v2: format, masa berlaku, atribut', () => {
  it('v2.<exp>.<sid>.<sig>, sid acak 16 byte base64url, sid berbeda tiap login, Max-Age 86400', () => {
    const a = createAuth({ token: TOKEN });
    const c1 = a.sessionCookie(reqOf());
    const c2 = a.sessionCookie(reqOf());
    const re = /^aio_session=v2\.(\d+)\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43}); HttpOnly; SameSite=Strict; Path=\/; Max-Age=86400$/;
    expect(c1).toMatch(re);
    expect(re.exec(c1)[2]).not.toBe(re.exec(c2)[2]);
    expect(c1).not.toMatch(/__Host-/);
  });
  it('sid ikut ditandatangani: mengganti sid membatalkan tanda tangan', () => {
    const a = createAuth({ token: TOKEN });
    const v = cookieOf(a.sessionCookie(reqOf()));
    const [ver, exp, sid, sig] = v.split('.');
    expect(a.check(cookieReq(v)).ok).toBe(true);
    expect(sid).toHaveLength(22);
    expect(a.check(cookieReq(`${ver}.${exp}.${'A'.repeat(22)}.${sig}`)).ok).toBe(false);
  });
  it('Secure selalu di mode terbuka (open), juga untuk cookie penghapus; tidak di mode lokal', () => {
    const open = createAuth({ token: TOKEN, open: true });
    expect(open.sessionCookie(reqOf())).toMatch(/; Secure$/);
    expect(open.clearCookie(reqOf())).toMatch(/Max-Age=0; Secure$/);
    const local = createAuth({ token: TOKEN });
    expect(local.sessionCookie(reqOf())).not.toMatch(/Secure/);
  });
  it('server terbuka (allowedHosts + trustProxy) mengirim Secure walau X-Forwarded-Proto: http', async () => {
    const s = await startApp({ token: TOKEN, trustProxy: true, allowedHosts: ['office.example.com'] });
    try {
      const r = await login(s.port, TOKEN, { Host: 'office.example.com', 'X-Forwarded-Proto': 'http', 'X-Real-IP': '203.0.113.9', Origin: 'http://office.example.com' });
      expect(r.status).toBe(200);
      expect([].concat(r.headers['set-cookie'])[0]).toMatch(/; Secure$/);
    } finally {
      await s.close();
    }
  });
});

describe('cookie lama / rusak ditolak rapi', () => {
  const a = createAuth({ token: TOKEN });
  const forgeV1 = () => {
    // format v1 (sebelum perubahan): v1.<exp>.<sig>
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const payload = `v1.${exp}`;
    return `${payload}.${createHmac('sha256', 'x').update(payload).digest('base64url')}`;
  };
  it.each([
    ['v1 tiga bagian', forgeV1()],
    ['tanpa titik', 'abc'],
    ['kosong', ''],
    ['empat bagian sampah', 'a.b.c.d'],
    ['versi lain', `v3.${Math.floor(Date.now() / 1000) + 60}.${'A'.repeat(22)}.sig`],
    ['sangat panjang', 'v2.' + '9'.repeat(5000)],
    ['karakter aneh', 'v2.\u0000.‮.\ud800'],
  ])('%s -> ok:false tanpa melempar', (_n, v) => {
    expect(a.check(cookieReq(v))).toEqual({ ok: false });
    expect(() => a.revoke(cookieReq(v))).not.toThrow();
  });
  it('server: cookie v1 -> 401 di /api/events, bukan 500', async () => {
    const s = await startApp({ token: TOKEN });
    try {
      const r = await http(s.port, '/api/events', { headers: { Cookie: `${SESSION_COOKIE}=${forgeV1()}` } });
      expect(r.status).toBe(401);
    } finally {
      await s.close();
    }
  });
  it('cookie sah mati setelah 24 jam', () => {
    let t = 1_000_000_000_000;
    const b = createAuth({ token: TOKEN, now: () => t });
    const v = cookieOf(b.sessionCookie(reqOf()));
    expect(b.check(cookieReq(v)).ok).toBe(true);
    t += 86_400_000 + 1000;
    expect(b.check(cookieReq(v)).ok).toBe(false);
  });
});

describe('clientIp: kunci IPv4 / IPv6 /64', () => {
  it('::1 dan alamat terkompresi', () => {
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::')).toBe('0:0:0:0::/64');
    expect(ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:0DB8:0:1:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:0:1::/64');
    expect(ipKey('2001:db8:0:1::')).toBe('2001:db8:0:1::/64');
    expect(ipKey('1:2:3:4:5:6:7::')).toBe('1:2:3:4::/64');
    expect(ipKey('::2:3:4:5:6:7:8')).toBe('0:2:3:4::/64');
  });
  it('satu /64 berbagi kunci, /64 lain tidak', () => {
    expect(ipKey('2001:db8:0:1::1')).toBe(ipKey('2001:db8:0:1:ffff:ffff:ffff:ffff'));
    expect(ipKey('2001:db8:0:1::1')).not.toBe(ipKey('2001:db8:0:2::1'));
  });
  it('zone id dibuang', () => {
    expect(ipKey('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });
  it('IPv4-mapped (titik dan hex, huruf besar) menjadi IPv4 biasa', () => {
    expect(ipKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(ipKey('::FFFF:1.2.3.4')).toBe('1.2.3.4');
    expect(ipKey('::ffff:102:304')).toBe('1.2.3.4');
    expect(ipKey('::FFFF:0102:0304')).toBe('1.2.3.4');
    expect(ipKey('0:0:0:0:0:ffff:cb00:7109')).toBe('203.0.113.9');
    expect(ipKey('::ffff:102:304')).not.toBe(ipKey('::1'));
    expect(ipKey('::ffff:102:304')).toBe(ipKey('1.2.3.4'));
  });
  it('ekor IPv4 non-mapped tetap /64', () => {
    expect(ipKey('64:ff9b::1.2.3.4')).toBe('64:ff9b:0:0::/64');
    expect(ipKey('::1.2.3.4')).toBe('0:0:0:0::/64');
    expect(ipKey('1:2:3:4:5:6:1.2.3.4')).toBe('1:2:3:4::/64');
  });
  it('IPv4 apa adanya; trustProxy: X-Real-IP IPv6 juga /64', () => {
    expect(ipKey('203.0.113.9')).toBe('203.0.113.9');
    expect(ipKey('2001:db8:0:1::5', { trustProxy: true })).toBe('2001:db8:0:1::/64');
  });
  it('trustProxy: X-Real-IP hilang/tidak valid -> null, tanpa fallback ke soket', () => {
    const a = createAuth({ token: TOKEN, trustProxy: true });
    expect(a.clientIp(reqOf({}, '10.0.0.1'))).toBeNull();
    expect(a.clientIp(reqOf({ 'x-real-ip': 'bukan-ip' }))).toBeNull();
    expect(a.clientIp(reqOf({ 'x-real-ip': '' }))).toBeNull();
    expect(a.clientIp(reqOf({ 'x-real-ip': '1.2.3.4, 5.6.7.8' }))).toBe('1.2.3.4');
    expect(a.clientIp(reqOf({ 'x-real-ip': ['1.2.3.4'] }))).toBe('1.2.3.4');
  });
  it('soket tanpa remoteAddress -> "unknown"', () => {
    expect(createAuth({ token: TOKEN }).clientIp({ headers: {}, socket: {} })).toBe('unknown');
  });
});

describe('daftar cabut', () => {
  it('cabut satu sesi tidak memengaruhi sesi lain; revoke tanpa cookie / ganda aman', () => {
    const a = createAuth({ token: TOKEN });
    const v1 = cookieOf(a.sessionCookie(reqOf()));
    const v2 = cookieOf(a.sessionCookie(reqOf()));
    a.revoke(reqOf());
    a.revoke(cookieReq('sampah'));
    a.revoke(cookieReq(v1));
    expect(a.check(cookieReq(v1)).ok).toBe(false);
    expect(a.check(cookieReq(v2)).ok).toBe(true);
    a.revoke(cookieReq(v1));
    expect(a.check(cookieReq(v1)).ok).toBe(false);
  });
  it('hanya cookie bertanda tangan sah yang masuk daftar (tanda tangan palsu tidak mencabut apa pun)', () => {
    const a = createAuth({ token: TOKEN });
    const v = cookieOf(a.sessionCookie(reqOf()));
    const [ver, exp, sid] = v.split('.');
    a.revoke(cookieReq(`${ver}.${exp}.${sid}.${'A'.repeat(43)}`));
    expect(a.check(cookieReq(v)).ok).toBe(true);
  });
  it('penuh: tidak crash, yang terbaru tetap tercabut, tertua dibuang (batas desain)', () => {
    const a = createAuth({ token: TOKEN });
    const vals = [];
    for (let i = 0; i < MAX_REVOKED_SESSIONS + 5; i++) {
      const v = cookieOf(a.sessionCookie(reqOf()));
      vals.push(v);
      a.revoke(cookieReq(v));
    }
    expect(a.check(cookieReq(vals.at(-1))).ok).toBe(false);
    expect(a.check(cookieReq(vals.at(-2))).ok).toBe(false);
    // dokumentasi perilaku: sesi tertua keluar dari daftar sehingga cookienya hidup lagi (maks. 24 jam)
    expect(a.check(cookieReq(vals[0])).ok).toBe(true);
  });
  it('entri kedaluwarsa dibersihkan dan tidak menimbulkan error', () => {
    let t = 1_000_000_000_000;
    const a = createAuth({ token: TOKEN, now: () => t });
    const v = cookieOf(a.sessionCookie(reqOf()));
    a.revoke(cookieReq(v));
    t += 86_400_000 + 120_000;
    expect(a.check(cookieReq(v)).ok).toBe(false);
    expect(() => a.revoke(reqOf())).not.toThrow();
  });
  it('end-to-end: logout mencabut cookie yang dikirim ulang; Bearer tetap sah', async () => {
    const s = await startApp({ token: TOKEN });
    try {
      const cookie = cookieFrom(await login(s.port, TOKEN));
      expect((await http(s.port, '/api/events', { headers: { Cookie: cookie } })).status).toBe(200);
      const out = await http(s.port, '/api/logout', { method: 'POST', headers: { ...JSON_HEADERS, Cookie: cookie }, body: '{}' });
      expect(out.status).toBe(200);
      expect((await http(s.port, '/api/events', { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await wsConnect(s.port, { headers: { Cookie: cookie } })).status).toBe(401);
      expect((await http(s.port, '/api/events', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('Origin loopback: hanya port server sendiri atau devPorts', () => {
  const statusOf = async (opts, origin, extra = {}) => {
    const s = await startApp({ token: TOKEN, ...opts });
    try {
      const headers = { Authorization: `Bearer ${TOKEN}`, Origin: origin(s.port), ...extra };
      const api = (await http(s.port, '/api/session', { headers })).status;
      const ws = await wsConnect(s.port, { headers });
      ws.ws?.close();
      return [api, ws.status];
    } finally {
      await s.close();
    }
  };
  const ALLOW = [200, 101];
  const DENY = [403, 403];

  it('port soket sendiri (localhost, 127.0.0.1, [::1]) diterima untuk /api dan /ws', async () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(await statusOf({}, (p) => `http://${host}:${p}`)).toEqual(ALLOW);
  });
  it('devPorts bawaan 5173 diterima; port lain ditolak; devPorts kustom menggantikan bawaan', async () => {
    expect(await statusOf({}, () => 'http://localhost:5173')).toEqual(ALLOW);
    expect(await statusOf({}, () => 'http://127.0.0.1:5174')).toEqual(DENY);
    expect(await statusOf({ devPorts: [] }, () => 'http://localhost:5173')).toEqual(DENY);
    expect(await statusOf({ devPorts: [4000] }, () => 'http://localhost:4000')).toEqual(ALLOW);
    expect(await statusOf({ devPorts: [4000] }, () => 'http://localhost:5173')).toEqual(DENY);
  });
  it('port 80/443 eksplisit atau tersirat ditolak walau Host tanpa port', async () => {
    expect(await statusOf({}, () => 'http://localhost:80', { Host: 'localhost' })).toEqual(DENY);
    expect(await statusOf({}, () => 'http://localhost', { Host: 'localhost' })).toEqual(DENY);
    expect(await statusOf({}, () => 'https://localhost:443', { Host: 'localhost' })).toEqual(DENY);
  });
  it('Origin userinfo / host menyerupai loopback ditolak', async () => {
    expect(await statusOf({}, () => 'http://localhost:5173' + '@evil.example')).toEqual(DENY);
    expect(await statusOf({}, (p) => `http://127.0.0.1:${p}` + '@evil.example')).toEqual(DENY);
    expect(await statusOf({}, () => 'http://evil.example:5173')).toEqual(DENY);
    expect(await statusOf({}, () => 'http://localhost.evil.example:5173')).toEqual(DENY);
    expect(await statusOf({}, () => 'http://[::ffff:7f00:1]:5173')).toEqual(DENY);
  });
  it('skema https di server HTTP biasa ditolak', async () => {
    expect(await statusOf({}, () => 'https://localhost:5173')).toEqual(DENY);
  });
  it.each(['null', 'file:///etc/passwd', 'chrome-extension://abc', 'javascript:alert(1)', 'http://', 'http://localhost:99999', 'ftp://localhost:5173', '%%%'])(
    'Origin %s ditolak',
    async (o) => {
      expect(await statusOf({}, () => o)).toEqual(DENY);
    },
  );
  it('tanpa Origin (hook / curl) tetap diterima', async () => {
    const s = await startApp({ token: TOKEN });
    try {
      expect((await http(s.port, '/api/session', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    } finally {
      await s.close();
    }
  });
});

describe('login tanpa X-Real-IP di belakang proxy', () => {
  it('503 berpesan salah konfigurasi, tanpa cookie, log sekali; X-Real-IP valid -> 200', async () => {
    const s = await startApp({ token: TOKEN, trustProxy: true, allowedHosts: ['office.example.com'] });
    try {
      const h = { Host: 'office.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://office.example.com' };
      const r = await login(s.port, TOKEN, h);
      expect(r.status).toBe(503);
      expect(r.json.error).toMatch(/X-Real-IP/);
      expect(r.headers['set-cookie']).toBeUndefined();
      await login(s.port, 'salah', h);
      await login(s.port, TOKEN, { ...h, 'X-Real-IP': 'bukan-ip' });
      expect(s.logs.filter((l) => /X-Real-IP/i.test(l))).toHaveLength(1);
      const ok = await login(s.port, TOKEN, { ...h, 'X-Real-IP': '2001:db8::7' });
      expect(ok.status).toBe(200);
    } finally {
      await s.close();
    }
  });
  it('rate limit login per /64: dua alamat di /64 yang sama berbagi hitungan', async () => {
    const s = await startApp({ token: TOKEN, trustProxy: true, allowedHosts: ['office.example.com'] });
    try {
      const h = { Host: 'office.example.com', 'X-Forwarded-Proto': 'https', Origin: 'https://office.example.com' };
      for (let i = 0; i < 10; i++) expect((await login(s.port, 'salah', { ...h, 'X-Real-IP': `2001:db8:0:1::${i + 1}` })).status).toBe(401);
      expect((await login(s.port, 'salah', { ...h, 'X-Real-IP': '2001:db8:0:1:ffff::1' })).status).toBe(429);
      expect((await login(s.port, 'salah', { ...h, 'X-Real-IP': '2001:db8:0:2::1' })).status).toBe(401);
      // bentuk IPv4-mapped hex = IPv4 yang sama
      for (let i = 0; i < 10; i++) await login(s.port, 'salah', { ...h, 'X-Real-IP': '1.2.3.4' });
      expect((await login(s.port, 'salah', { ...h, 'X-Real-IP': '::ffff:102:304' })).status).toBe(429);
    } finally {
      await s.close();
    }
  });
});
