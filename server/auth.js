// Autentikasi token AI Office (Bagian 4).
//
// - Rahasia bersama: AI_OFFICE_TOKEN. Hooks/curl mengirim `Authorization: Bearer <token>`,
//   browser mengirim token sekali lewat POST /api/login lalu memakai cookie aio_session.
// - Cookie sesi stateless: "v1.<exp>.<sig>"
//     exp = detik Unix kedaluwarsa (7 hari setelah login)
//     sig = base64url(HMAC-SHA256(kunci, "v1.<exp>")), kunci = HKDF-SHA256(token)
//   Restart server tidak membuat pengguna keluar; mengganti token membatalkan semua sesi.
// - Semua perbandingan rahasia memakai crypto.timingSafeEqual atas digest SHA-256, supaya waktu
//   dan panjang input tidak membocorkan isi atau panjang rahasia.
// - Token tidak pernah ditulis ke log, respons, atau URL.
import { createHash, createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { isLoopbackHost } from './net.js';

export const SESSION_COOKIE = 'aio_session';
export const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60; // 604800
export const MIN_OPEN_TOKEN_LENGTH = 32;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
/** Batas jumlah cookie aio_session yang diperiksa per request (cookie palsu tidak bisa menutupi yang sah). */
export const MAX_SESSION_COOKIES = 20;
/** Header Authorization yang lebih panjang dari ini tidak diperiksa (token asli 43 karakter). */
export const MAX_AUTH_HEADER_LENGTH = 1024;
const COOKIE_VERSION = 'v1';

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
  const t = String(token ?? '').trim();
  const loopback = isLoopbackHost(host);
  const shownHost = host === '' ? '(kosong = semua antarmuka)' : host;
  const reasons = [];
  if (!loopback) reasons.push(`HOST=${shownHost} bukan loopback`);
  if (allowedHosts.length > 0) reasons.push('AI_OFFICE_ALLOWED_HOSTS terisi');
  if (trustProxy) reasons.push('AI_OFFICE_TRUST_PROXY=1');
  const open = reasons.length > 0;
  const errors = [];
  if (open && t.length < MIN_OPEN_TOKEN_LENGTH) {
    errors.push(
      `Server tidak dijalankan: mode terbuka (${reasons.join(', ')}) wajib memakai AI_OFFICE_TOKEN ` +
        `minimal ${MIN_OPEN_TOKEN_LENGTH} karakter, sedangkan token ${t ? 'terlalu pendek' : 'kosong'}. ` +
        'Buat token kuat dengan: npm run -s token',
    );
  }
  if (trustProxy && !loopback) {
    errors.push(
      `Server tidak dijalankan: AI_OFFICE_TRUST_PROXY=1 hanya boleh dipakai dengan HOST loopback ` +
        `(127.0.0.1, localhost, atau ::1), sedangkan HOST=${shownHost}. Proxy (Nginx) harus berjalan di ` +
        'mesin yang sama; kalau tidak, klien lain bisa memalsukan X-Real-IP dan X-Forwarded-Proto. ' +
        'Set HOST=127.0.0.1 atau hapus AI_OFFICE_TRUST_PROXY.',
    );
  }
  return { tokenMode: t.length > 0, open, reasons, error: errors.length ? errors.join('\n') : null, token: t };
}

/** Nilai pertama header (sebelum koma pertama), tanpa memecah seluruh header. */
function firstHeader(v) {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return '';
  const i = s.indexOf(',');
  return (i < 0 ? s : s.slice(0, i)).trim();
}

function normalizeIp(ip) {
  const s = String(ip ?? '');
  return s.toLowerCase().startsWith('::ffff:') && isIP(s.slice(7)) === 4 ? s.slice(7) : s;
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
export function createAuth({ token = '', trustProxy = false, now = Date.now } = {}) {
  const secret = String(token ?? '').trim();
  const enabled = secret.length > 0;
  const key = enabled ? Buffer.from(hkdfSync('sha256', secret, 'ai-office/session', 'aio_session v1', 32)) : null;

  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  function issueSessionValue() {
    const exp = Math.floor(now() / 1000) + SESSION_MAX_AGE_S;
    const payload = `${COOKIE_VERSION}.${exp}`;
    return `${payload}.${sign(payload)}`;
  }

  /** Kembalikan detik kedaluwarsa bila nilai cookie sah, atau 0 bila tidak. */
  function verifySessionValue(value) {
    if (!enabled || typeof value !== 'string' || value.length > 200) return 0;
    const parts = value.split('.');
    if (parts.length !== 3 || parts[0] !== COOKIE_VERSION || !/^\d{1,12}$/.test(parts[1])) return 0;
    const payload = `${parts[0]}.${parts[1]}`;
    if (!safeEqual(parts[2], sign(payload))) return 0;
    const exp = Number(parts[1]);
    const nowS = Math.floor(now() / 1000);
    if (exp <= nowS || exp > nowS + SESSION_MAX_AGE_S + 60) return 0;
    return exp;
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

    /** IP klien: X-Real-IP (hanya dengan trustProxy dan bila valid), selain itu alamat soket. */
    clientIp(req) {
      if (trustProxy) {
        const real = firstHeader(req.headers['x-real-ip']);
        if (real && isIP(real)) return normalizeIp(real);
      }
      return normalizeIp(req.socket?.remoteAddress) || 'unknown';
    },

    sessionCookie(req) {
      const secure = isHttps(req) ? '; Secure' : '';
      return `${SESSION_COOKIE}=${issueSessionValue()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_S}${secure}`;
    },

    clearCookie(req) {
      const secure = isHttps(req) ? '; Secure' : '';
      return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`;
    },
  };
}
