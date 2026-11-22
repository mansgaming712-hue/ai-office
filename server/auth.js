// Autentikasi token AI Office (Bagian 4).
//
// - Rahasia bersama: AI_OFFICE_TOKEN. Hooks/curl mengirim `Authorization: Bearer <token>`,
//   browser mengirim token sekali lewat POST /api/login lalu memakai cookie aio_session.
// - Cookie sesi bertanda tangan: "v2.<exp>.<sid>.<sig>"
//     exp = detik Unix kedaluwarsa (24 jam setelah login)
//     sid = 16 byte acak (base64url), ikut ditandatangani
//     sig = base64url(HMAC-SHA256(kunci, "v2.<exp>.<sid>")), kunci = HKDF-SHA256(token)
//   Restart server tidak membuat pengguna keluar; mengganti token membatalkan semua sesi.
//   Logout mencabut sid di daftar cabut dalam memori (hilang saat restart; cookie tetap mati sendiri
//   saat exp). Cookie v1 lama ditolak (login ulang).
// - Semua perbandingan rahasia memakai crypto.timingSafeEqual atas digest SHA-256, supaya waktu
//   dan panjang input tidak membocorkan isi atau panjang rahasia.
// - Token tidak pernah ditulis ke log, respons, atau URL.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { t } from '../shared/i18n.js';
import { isLoopbackHost } from './net.js';

export const SESSION_COOKIE = 'aio_session';
export const SESSION_MAX_AGE_S = 24 * 60 * 60; // 86400
/** Batas daftar cabut sesi di memori; yang tertua dibuang bila penuh. */
export const MAX_REVOKED_SESSIONS = 10_000;
export const MIN_OPEN_TOKEN_LENGTH = 32;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Batas jumlah cookie aio_session yang diperiksa per request (cookie palsu tidak bisa menutupi yang sah). */
export const MAX_SESSION_COOKIES = 20;
/** Header Authorization yang lebih panjang dari ini tidak diperiksa (token asli 43 karakter). */
export const MAX_AUTH_HEADER_LENGTH = 1024;
const COOKIE_VERSION = 'v2';

// Di-hash sebagai UTF-16LE (unit kode apa adanya), bukan UTF-8: UTF-8 mengganti surrogate tunggal
// dengan U+FFFD, sehingga "a\ud800" dan "a�" dulu dianggap sama. Token sendiri sudah dibatasi
// ke ASCII terlihat (resolveToken), ini jaring pengaman untuk nilai dari request.
const sha256 = (s) => createHash('sha256').update(String(s), 'utf16le').digest();

/** Bandingkan dua string dalam waktu konstan (lewat digest SHA-256, jadi panjang tidak bocor). */
export function safeEqual(a, b) {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * Tentukan mode server dari opsinya.
 *   lokal  : host loopback, tanpa allowedHosts, tanpa trustProxy, tanpa token → tanpa autentikasi
 *   token  : token terisi (host mana pun)
 *   terbuka: host bukan loopback ATAU allowedHosts terisi ATAU trustProxy → token ≥ 32 karakter wajib
 * trustProxy hanya boleh dengan host loopback: proxy (Nginx) harus berada di mesin yang sama, kalau
 * tidak, siapa pun yang bisa menjangkau port ini bisa memalsukan X-Real-IP / X-Forwarded-Proto.
 * Mengembalikan { tokenMode, open, reasons, error } — error berisi pesan bila konfigurasi ditolak.
 */
export function resolveAuthMode({ host = '127.0.0.1', allowedHosts = [], trustProxy = false, token = '' } = {}) {
  const tok = String(token ?? '').trim();
  const loopback = isLoopbackHost(host);
  const shownHost = host === '' ? t('auth.hostAll') : host;
  const reasons = [];
  if (!loopback) reasons.push(t('auth.reasonNotLoopback', { host: shownHost }));
  if (allowedHosts.length > 0) reasons.push(t('auth.reasonAllowedHosts'));
  if (trustProxy) reasons.push('AI_OFFICE_TRUST_PROXY=1');
  const open = reasons.length > 0;
  const errors = [];
  if (open && tok.length < MIN_OPEN_TOKEN_LENGTH) {
    errors.push(t('auth.openNeedsToken', { reasons: reasons.join(', '), min: MIN_OPEN_TOKEN_LENGTH, state: t(tok ? 'auth.tokenShort' : 'auth.tokenEmpty') }));
  }
  if (trustProxy && !loopback) {
    errors.push(t('auth.proxyNeedsLoopback', { host: shownHost }));
  }
  return { tokenMode: tok.length > 0, open, reasons, error: errors.length ? errors.join('\n') : null, token: tok };
}

/** Nilai pertama header (sebelum koma pertama), tanpa memecah seluruh header. */
function firstHeader(v) {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return '';
  const i = s.indexOf(',');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

/** Uraikan IPv6 valid menjadi 8 hextet (angka), atau null. Zone id dibuang, ekor IPv4 diubah jadi dua hextet. */
function ipv6Groups(ip) {
  let s = ip.toLowerCase().split('%')[0];
  if (s.includes('.')) {
    const c = s.lastIndexOf(':');
    const o = s.slice(c + 1).split('.').map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, c + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [head, tail, extra] = s.split('::');
  if (extra !== undefined) return null;
  const h = head ? head.split(':') : [];
  const t = tail === undefined ? [] : tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  if (tail !== undefined && fill < 1) return null;
  const groups = [...h, ...Array(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Kunci rate limit dari satu alamat. IPv4 apa adanya; IPv4-mapped (::ffff:a.b.c.d maupun bentuk hex
 * ::ffff:102:304) menjadi IPv4; IPv6 lain menjadi prefix /64 ("2001:db8:0:1::/64"), karena satu
 * klien biasanya memegang satu /64.
 */
function normalizeIp(ip) {
  const s = String(ip ?? '');
  if (isIP(s) !== 6) return s;
  const g = ipv6Groups(s);
  if (!g) return s;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Pembatas percobaan login gagal per IP, di memori.
 * Jendela tetap: dihitung sejak kegagalan pertama, berlaku `windowMs`. Setelah `maxFailures`
 * kegagalan, percobaan berikutnya ditolak sampai jendela habis.
 * Ukuran dibatasi `maxEntries`; entri kedaluwarsa dibuang setiap kali dipakai. Karena semua entri
 * memakai panjang jendela yang sama, urutan sisip Map = urutan kedaluwarsa, sehingga pembersihan
 * cukup berjalan dari depan sampai menemukan entri yang masih aktif.
 */
export function createLoginLimiter({
  maxFailures = LOGIN_MAX_FAILURES,
  windowMs = LOGIN_WINDOW_MS,
  maxEntries = 10_000,
  now = Date.now,
} = {}) {
  const entries = new Map(); // ip → { count, resetAt }

  function sweep(t) {
    for (const [ip, e] of entries) {
      if (e.resetAt > t) break;
      entries.delete(ip);
    }
  }
  function live(ip, t) {
    sweep(t);
    const e = entries.get(ip);
    if (e && e.resetAt <= t) {
      entries.delete(ip); // jam mundur: entri tidak urut, buang manual
      return undefined;
    }
    return e;
  }

  return {
    /** { allowed: true } atau { allowed: false, retryAfterS } */
    check(ip) {
      const t = now();
      const e = live(ip, t);
      if (e && e.count >= maxFailures) return { allowed: false, retryAfterS: Math.max(1, Math.ceil((e.resetAt - t) / 1000)) };
      return { allowed: true };
    },
    /** Catat satu kegagalan, kembalikan jumlah kegagalan di jendela ini. */
    fail(ip) {
      const t = now();
      let e = live(ip, t);
      if (!e) {
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value); // buang yang tertua
        e = { count: 0, resetAt: t + windowMs };
        entries.set(ip, e);
      }
      e.count += 1;
      return e.count;
    },
    reset(ip) {
      entries.delete(ip);
    },
    get size() {
      return entries.size;
    },
    maxFailures,
  };
}

/**
 * Buat pemeriksa autentikasi untuk satu token. Bila token kosong, `enabled` false dan semua
 * request dianggap sah (mode lokal).
 */
export function createAuth({ token = '', trustProxy = false, open = false, now = Date.now } = {}) {
  const secret = String(token ?? '').trim();
  const enabled = secret.length > 0;
  const key = enabled ? Buffer.from(hkdfSync('sha256', secret, 'ai-office/session', 'aio_session v1', 32)) : null;

  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  // Daftar cabut: sid -> exp (detik). Entri dibuang begitu exp lewat (cookienya sudah mati sendiri).
  const revoked = new Map();
  function sweepRevoked(nowS) {
    for (const [sid, exp] of revoked) if (exp <= nowS) revoked.delete(sid);
  }

  function issueSessionValue() {
    const exp = Math.floor(now() / 1000) + SESSION_MAX_AGE_S;
    const payload = `${COOKIE_VERSION}.${exp}.${randomBytes(16).toString('base64url')}`;
    return `${payload}.${sign(payload)}`;
  }

  /** { exp, sid } bila tanda tangan dan masa berlaku sah (tanpa cek daftar cabut), atau null. */
  function parseSessionValue(value) {
    if (!enabled || typeof value !== 'string' || value.length > 200) return null;
    const parts = value.split('.');
    if (parts.length !== 4 || parts[0] !== COOKIE_VERSION || !/^\d{1,12}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{22}$/.test(parts[2])) return null;
    const payload = `${parts[0]}.${parts[1]}.${parts[2]}`;
    if (!safeEqual(parts[3], sign(payload))) return null;
    const exp = Number(parts[1]);
    const nowS = Math.floor(now() / 1000);
    if (exp <= nowS || exp > nowS + SESSION_MAX_AGE_S + 60) return null;
    return { exp, sid: parts[2] };
  }

  /** Kembalikan detik kedaluwarsa bila nilai cookie sah dan belum dicabut, atau 0 bila tidak. */
  function verifySessionValue(value) {
    const s = parseSessionValue(value);
    if (!s) return 0;
    sweepRevoked(Math.floor(now() / 1000));
    return revoked.has(s.sid) ? 0 : s.exp;
  }

  function cookieValues(req) {
    const header = req.headers.cookie;
    if (!header) return [];
    const out = [];
    for (const part of String(header).split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() !== SESSION_COOKIE) continue;
      let v = part.slice(i + 1).trim();
      if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      out.push(v);
      if (out.length >= MAX_SESSION_COOKIES) break;
    }
    return out;
  }

  /**
   * Nilai token dari "Authorization: Bearer <token>", atau null.
   * Berjalan SEBELUM autentikasi untuk setiap request, jadi harus linear: header di atas
   * MAX_AUTH_HEADER_LENGTH langsung ditolak, lalu trim() dan satu regex tanpa kuantifier yang
   * saling tumpang tindih ([ \t]+ dan \S+ saling lepas). Pola lama /^\s*Bearer\s+(.+?)\s*$/i
   * kuadratik terhadap spasi di tengah (16 000 spasi = ±200 ms per request).
   */
  function bearerOf(req) {
    const h = req.headers.authorization;
    if (typeof h !== 'string' || h.length > MAX_AUTH_HEADER_LENGTH) return null;
    const m = /^Bearer[ \t]+(\S+)$/i.exec(h.trim());
    return m ? m[1] : null;
  }

  /** Request dianggap HTTPS bila soketnya TLS, atau (hanya dengan trustProxy) X-Forwarded-Proto: https. */
  function isHttps(req) {
    if (req.socket?.encrypted) return true;
    return trustProxy && firstHeader(req.headers['x-forwarded-proto']).toLowerCase() === 'https';
  }

  /**
   * Skema yang dilihat browser: 'https' | 'http', atau null bila tidak bisa dipastikan
   * (trustProxy aktif tetapi proxy tidak mengirim X-Forwarded-Proto yang dikenal).
   */
  function requestScheme(req) {
    if (req.socket?.encrypted) return 'https';
    if (!trustProxy) return 'http';
    const p = firstHeader(req.headers['x-forwarded-proto']).toLowerCase();
    return p === 'https' || p === 'http' ? p : null;
  }

  return {
    enabled,

    tokenMatches(candidate) {
      return enabled && safeEqual(String(candidate ?? ''), secret);
    },

    /**
     * Periksa request: header Authorization Bearer atau cookie aio_session sah.
     * { ok: true, expiresAtMs } (Infinity untuk Bearer / mode lokal) atau { ok: false }.
     */
    check(req) {
      if (!enabled) return { ok: true, expiresAtMs: Infinity };
      const bearer = bearerOf(req);
      if (bearer !== null && safeEqual(bearer, secret)) return { ok: true, expiresAtMs: Infinity };
      for (const v of cookieValues(req)) {
        const exp = verifySessionValue(v);
        if (exp) return { ok: true, expiresAtMs: exp * 1000 };
      }
      return { ok: false };
    },

    isHttps,
    requestScheme,

    /**
     * Kunci IP klien untuk rate limit (IPv6 -> prefix /64). Dengan trustProxy hanya X-Real-IP yang
     * dipakai; bila hilang/tidak valid hasilnya null (salah konfigurasi proxy), BUKAN IP soket.
     */
    clientIp(req) {
      if (trustProxy) {
        const real = firstHeader(req.headers['x-real-ip']);
        return real && isIP(real) ? normalizeIp(real) : null;
      }
      return normalizeIp(req.socket?.remoteAddress) || 'unknown';
    },

    /** Cabut sesi dari cookie yang dikirim request (cookie harus bertanda tangan sah). */
    revoke(req) {
      sweepRevoked(Math.floor(now() / 1000));
      for (const v of cookieValues(req)) {
        const s = parseSessionValue(v);
        if (!s) continue;
        if (revoked.size >= MAX_REVOKED_SESSIONS) revoked.delete(revoked.keys().next().value);
        revoked.set(s.sid, s.exp);
      }
    },

    sessionCookie(req) {
      const secure = isHttps(req) || open ? '; Secure' : ''; // mode terbuka: Secure selalu
      return `${SESSION_COOKIE}=${issueSessionValue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}${secure}`;
    },

    clearCookie(req) {
      const secure = isHttps(req) || open ? '; Secure' : '';
      return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
    },
  };
}
