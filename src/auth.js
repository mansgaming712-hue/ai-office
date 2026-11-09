// Logika keputusan autentikasi UI. Fungsi murni: tanpa DOM, tanpa fetch, tanpa React,
// supaya bisa dites dengan vitest di environment node.
//
// Konvensi `status`: angka status HTTP, atau `null` kalau request gagal sebelum ada respons
// (jaringan putus, timeout). `body`: hasil JSON.parse, atau `undefined` kalau JSON rusak/kosong.

export const MESSAGES = Object.freeze({
  sessionExpired: 'Sesi berakhir, silakan masuk lagi.',
  loggedOut: 'Kamu sudah keluar.',
  tokenEmpty: 'Token akses wajib diisi.',
  wrongToken: 'Token salah.',
  tooMany: 'Terlalu banyak percobaan. Coba lagi nanti.',
  network: 'Tidak bisa menghubungi server. Periksa koneksi lalu coba lagi.',
  unknownResponse: 'Respons server tidak dikenal. Coba lagi.',
  cookieBlocked: 'Token diterima, tetapi sesi tidak tersimpan. Pastikan cookie diizinkan dan alamat memakai HTTPS.',
  logoutNetwork: 'Keluar belum tercatat di server (koneksi gagal). Sesi mungkin masih aktif.',
});

const MAX_SERVER_MESSAGE = 200;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Pesan `error` dari server kalau ada dan wajar; selain itu string kosong. */
export function serverMessage(body) {
  if (!isObject(body) || typeof body.error !== 'string') return '';
  const text = body.error.trim();
  return text.length > 0 && text.length <= MAX_SERVER_MESSAGE ? text : '';
}

/**
 * Respons GET /api/session → state sesi.
 * `known: false` berarti server tidak menjawab sesuai kontrak (404 versi lama, error jaringan,
 * JSON rusak); sesuai kontrak, itu dianggap mode lokal (authRequired false).
 * @returns {{ known: boolean, authRequired: boolean, authenticated: boolean }}
 */
export function parseSession(status, body) {
  if (status === 200 && isObject(body) && body.ok === true && typeof body.authRequired === 'boolean') {
    return { known: true, authRequired: body.authRequired, authenticated: body.authenticated === true };
  }
  return { known: false, authRequired: false, authenticated: false };
}

/** Harus menampilkan layar login? */
export const needsLogin = (session) => Boolean(session?.authRequired && !session?.authenticated);

/** Setelah cek ulang sesi (WebSocket ditolak / POST 401): boleh reconnect? */
export const shouldReconnect = (session) => !needsLogin(session);

/**
 * Validasi isi field token sebelum dikirim. Spasi di awal/akhir (sisa tempel) dibuang.
 * @returns {{ ok: true, token: string } | { ok: false, error: string }}
 */
export function prepareToken(raw) {
  const token = typeof raw === 'string' ? raw.trim() : '';
  if (!token) return { ok: false, error: MESSAGES.tokenEmpty };
  return { ok: true, token };
}

/**
 * Respons POST /api/login → hasil untuk layar login.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function loginResult(status, body) {
  if (status == null) return { ok: false, error: MESSAGES.network };
  if (status === 200 && isObject(body) && body.ok === true) return { ok: true };
  const fromServer = serverMessage(body);
  if (status === 401) return { ok: false, error: fromServer || MESSAGES.wrongToken };
  if (status === 429) return { ok: false, error: fromServer || MESSAGES.tooMany };
  if (status >= 200 && status < 300) return { ok: false, error: MESSAGES.unknownResponse };
  return { ok: false, error: fromServer || `Gagal masuk (HTTP ${status}). Coba lagi.` };
}

/**
 * Gabungkan hasil login dengan cek sesi sesudahnya. Kalau server menerima token tapi
 * sesi tetap belum sah, cookie tidak tersimpan (mis. cookie Secure dibuka lewat http).
 * Sesi yang tidak diketahui (cek gagal) tidak menggagalkan login.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function resolveLogin(login, session) {
  if (!login?.ok) return login ?? { ok: false, error: MESSAGES.unknownResponse };
  if (session?.known && needsLogin(session)) return { ok: false, error: MESSAGES.cookieBlocked };
  return { ok: true };
}

/**
 * Respons POST /api/logout → hasil. 401 berarti sesi memang sudah tidak ada: dianggap berhasil.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function logoutResult(status, body) {
  if (status == null) return { ok: false, error: MESSAGES.logoutNetwork };
  if ((status === 200 && isObject(body) && body.ok === true) || status === 401) return { ok: true };
  const fromServer = serverMessage(body);
  return { ok: false, error: `Keluar gagal (${fromServer || `HTTP ${status}`}). Sesi mungkin masih aktif.` };
}

// ------------------------------------------------------------------ state machine
//
// phase:  'checking' → 'login' | 'app';  lalu 'login' ⇄ 'app'.
// epoch:  naik setiap masuk fase 'app'; hasil cek ulang milik sesi lama diabaikan.
// notice: pesan untuk layar login, { kind: 'info' | 'warn' | 'error', text } atau null.

export const initialAuthState = Object.freeze({ phase: 'checking', authRequired: false, epoch: 0, notice: null });

export function authReducer(state, action) {
  switch (action?.type) {
    case 'session-checked': {
      // Cek pertama saat app dibuka.
      if (state.phase !== 'checking') return state;
      const s = action.session;
      if (needsLogin(s)) return { ...state, phase: 'login', authRequired: true, notice: null };
      return { ...state, phase: 'app', authRequired: Boolean(s?.authRequired), epoch: state.epoch + 1, notice: null };
    }
    case 'session-rechecked': {
      // Cek ulang setelah POST /api/events 401 atau WebSocket tertutup sebelum hello.
      if (state.phase !== 'app' || action.epoch !== state.epoch) return state;
      const s = action.session;
      if (!s?.known) return state; // server tidak bisa ditanya: biarkan reconnect biasa
      if (needsLogin(s)) {
        return { ...state, phase: 'login', authRequired: true, notice: { kind: 'warn', text: MESSAGES.sessionExpired } };
      }
      return s.authRequired === state.authRequired ? state : { ...state, authRequired: s.authRequired };
    }
    case 'login-succeeded': {
      if (state.phase !== 'login') return state;
      const s = action.session;
      const authRequired = s?.known ? s.authRequired : true;
      return { ...state, phase: 'app', authRequired, epoch: state.epoch + 1, notice: null };
    }
    case 'logged-out': {
      if (state.phase !== 'app') return state;
      const r = action.result;
      const notice = r?.ok
        ? { kind: 'info', text: MESSAGES.loggedOut }
        : { kind: 'error', text: r?.error || MESSAGES.logoutNetwork };
      return { ...state, phase: 'login', authRequired: true, notice };
    }
    default:
      return state;
  }
}
