// UI login: fungsi murni src/auth.js dan lapisan jaringan src/net.js (fetch/WebSocket/location distub).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGES, authReducer, initialAuthState, loginResult, logoutResult, needsLogin, parseSession,
  prepareToken, resolveLogin, serverMessage, shouldReconnect,
} from '../src/auth.js';
import { connect, getSession, postLogin, postLogout } from '../src/net.js';

const UNKNOWN = { known: false, authRequired: false, authenticated: false };
const S = (authRequired, authenticated, known = true) => ({ known, authRequired, authenticated });

describe('MESSAGES dan initialAuthState', () => {
  it('beku (tidak bisa diubah tanpa sengaja)', () => {
    expect(Object.isFrozen(MESSAGES)).toBe(true);
    expect(Object.isFrozen(initialAuthState)).toBe(true);
    expect(initialAuthState).toEqual({ phase: 'checking', authRequired: false, epoch: 0, notice: null });
  });
});

describe('serverMessage', () => {
  it.each([
    [undefined, ''], [null, ''], ['teks', ''], [['x'], ''], [{}, ''], [{ error: 5 }, ''],
    [{ error: '   ' }, ''], [{ error: 'x'.repeat(201) }, ''],
    [{ error: '  Token salah  ' }, 'Token salah'], [{ error: 'x'.repeat(200) }, 'x'.repeat(200)],
  ])('%j → %j', (body, expected) => expect(serverMessage(body)).toBe(expected));
});

describe('parseSession', () => {
  it.each([
    [200, { ok: true, authRequired: true, authenticated: false }, S(true, false)],
    [200, { ok: true, authRequired: true, authenticated: true }, S(true, true)],
    [200, { ok: true, authRequired: false, authenticated: true }, S(false, true)],
    [200, { ok: true, authRequired: true, authenticated: 'true' }, S(true, false)],
    [200, { ok: true, authRequired: true }, S(true, false)],
    [200, { ok: false, authRequired: true, authenticated: true }, UNKNOWN],
    [200, { ok: true, authRequired: 'true', authenticated: true }, UNKNOWN],
    [200, { ok: true }, UNKNOWN],
    [200, undefined, UNKNOWN],
    [200, [{ ok: true, authRequired: true }], UNKNOWN],
    [404, { ok: false, error: 'Endpoint tidak ada' }, UNKNOWN],
    [500, { ok: true, authRequired: true, authenticated: true }, UNKNOWN],
    [null, undefined, UNKNOWN],
  ])('status %j body %j', (status, body, expected) => expect(parseSession(status, body)).toEqual(expected));
});

describe('needsLogin / shouldReconnect', () => {
  it.each([
    [S(true, false), true], [S(true, true), false], [S(false, false), false], [UNKNOWN, false],
    [undefined, false], [null, false],
  ])('%j → needsLogin %s', (session, expected) => {
    expect(needsLogin(session)).toBe(expected);
    expect(shouldReconnect(session)).toBe(!expected);
  });
});

describe('prepareToken', () => {
  it('kosong, spasi, atau bukan string → error token wajib diisi', () => {
    for (const v of ['', '   ', '\n\t', undefined, null, 123, {}]) expect(prepareToken(v)).toEqual({ ok: false, error: MESSAGES.tokenEmpty });
  });
  it('spasi di tepi dibuang, isi tidak diubah', () => {
    expect(prepareToken('  abc def \n')).toEqual({ ok: true, token: 'abc def' });
  });
});

describe('loginResult (semua cabang)', () => {
  it.each([
    ['jaringan gagal (null)', null, undefined, { ok: false, error: MESSAGES.network }],
    ['jaringan gagal (undefined)', undefined, undefined, { ok: false, error: MESSAGES.network }],
    ['200 ok', 200, { ok: true }, { ok: true }],
    ['200 ok:false', 200, { ok: false }, { ok: false, error: MESSAGES.unknownResponse }],
    ['200 JSON rusak', 200, undefined, { ok: false, error: MESSAGES.unknownResponse }],
    ['204', 204, undefined, { ok: false, error: MESSAGES.unknownResponse }],
    ['401 pesan server', 401, { ok: false, error: 'Token salah' }, { ok: false, error: 'Token salah' }],
    ['401 tanpa pesan', 401, undefined, { ok: false, error: MESSAGES.wrongToken }],
    ['401 pesan terlalu panjang', 401, { error: 'x'.repeat(500) }, { ok: false, error: MESSAGES.wrongToken }],
    ['429 pesan server', 429, { ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' }, { ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' }],
    ['429 tanpa pesan', 429, {}, { ok: false, error: MESSAGES.tooMany }],
    ['403 Origin', 403, { ok: false, error: 'Origin tidak diizinkan' }, { ok: false, error: 'Origin tidak diizinkan' }],
    ['500 tanpa pesan', 500, undefined, { ok: false, error: 'Gagal masuk (HTTP 500). Coba lagi.' }],
    ['404 server lama', 404, 'Not found', { ok: false, error: 'Gagal masuk (HTTP 404). Coba lagi.' }],
    ['302', 302, undefined, { ok: false, error: 'Gagal masuk (HTTP 302). Coba lagi.' }],
  ])('%s', (_n, status, body, expected) => expect(loginResult(status, body)).toEqual(expected));
});

describe('resolveLogin', () => {
  it.each([
    ['login gagal diteruskan apa adanya', { ok: false, error: 'Token salah.' }, S(true, false), { ok: false, error: 'Token salah.' }],
    ['login undefined', undefined, S(true, true), { ok: false, error: MESSAGES.unknownResponse }],
    ['sukses + sesi sah', { ok: true }, S(true, true), { ok: true }],
    ['sukses tapi sesi belum sah → cookie diblokir', { ok: true }, S(true, false), { ok: false, error: MESSAGES.cookieBlocked }],
    ['sukses + cek sesi gagal (unknown) → tetap sukses', { ok: true }, UNKNOWN, { ok: true }],
    ['sukses + sesi undefined', { ok: true }, undefined, { ok: true }],
    ['sukses + server ternyata mode lokal', { ok: true }, S(false, true), { ok: true }],
  ])('%s', (_n, login, session, expected) => expect(resolveLogin(login, session)).toEqual(expected));
});

describe('logoutResult (semua cabang)', () => {
  it.each([
    ['jaringan gagal', null, undefined, { ok: false, error: MESSAGES.logoutNetwork }],
    ['200 ok', 200, { ok: true }, { ok: true }],
    ['401 (sesi memang sudah tidak ada)', 401, { ok: false, error: 'Butuh autentikasi' }, { ok: true }],
    ['200 ok:false', 200, { ok: false }, { ok: false, error: 'Keluar gagal (HTTP 200). Sesi mungkin masih aktif.' }],
    ['200 JSON rusak', 200, undefined, { ok: false, error: 'Keluar gagal (HTTP 200). Sesi mungkin masih aktif.' }],
    ['415 dengan pesan', 415, { ok: false, error: 'Content-Type harus application/json' }, { ok: false, error: 'Keluar gagal (Content-Type harus application/json). Sesi mungkin masih aktif.' }],
    ['500 tanpa pesan', 500, undefined, { ok: false, error: 'Keluar gagal (HTTP 500). Sesi mungkin masih aktif.' }],
  ])('%s', (_n, status, body, expected) => expect(logoutResult(status, body)).toEqual(expected));
});

describe('authReducer', () => {
  const freeze = (s) => Object.freeze({ ...s });
  const app = (over = {}) => freeze({ phase: 'app', authRequired: true, epoch: 1, notice: null, ...over });
  const loginPhase = (over = {}) => freeze({ phase: 'login', authRequired: true, epoch: 1, notice: null, ...over });

  it('session-checked: perlu login → login; tidak perlu → app (epoch naik)', () => {
    expect(authReducer(initialAuthState, { type: 'session-checked', session: S(true, false) })).toEqual({ phase: 'login', authRequired: true, epoch: 0, notice: null });
    expect(authReducer(initialAuthState, { type: 'session-checked', session: S(true, true) })).toEqual({ phase: 'app', authRequired: true, epoch: 1, notice: null });
    expect(authReducer(initialAuthState, { type: 'session-checked', session: S(false, true) })).toEqual({ phase: 'app', authRequired: false, epoch: 1, notice: null });
    expect(authReducer(initialAuthState, { type: 'session-checked', session: UNKNOWN })).toMatchObject({ phase: 'app', authRequired: false });
    expect(authReducer(initialAuthState, { type: 'session-checked' })).toMatchObject({ phase: 'app', authRequired: false, epoch: 1 });
  });

  it('session-checked di luar fase checking diabaikan (state sama persis)', () => {
    const a = app();
    expect(authReducer(a, { type: 'session-checked', session: S(true, false) })).toBe(a);
    const l = loginPhase();
    expect(authReducer(l, { type: 'session-checked', session: S(false, true) })).toBe(l);
  });

  it('session-rechecked: epoch basi diabaikan', () => {
    const a = app({ epoch: 2 });
    expect(authReducer(a, { type: 'session-rechecked', epoch: 1, session: S(true, false) })).toBe(a);
    expect(authReducer(a, { type: 'session-rechecked', session: S(true, false) })).toBe(a); // epoch hilang
  });

  it('session-rechecked: sesi habis → login + peringatan; sesi tidak diketahui → tetap', () => {
    const a = app({ epoch: 3 });
    expect(authReducer(a, { type: 'session-rechecked', epoch: 3, session: S(true, false) })).toEqual({
      phase: 'login', authRequired: true, epoch: 3, notice: { kind: 'warn', text: MESSAGES.sessionExpired },
    });
    expect(authReducer(a, { type: 'session-rechecked', epoch: 3, session: UNKNOWN })).toBe(a);
    expect(authReducer(a, { type: 'session-rechecked', epoch: 3 })).toBe(a);
  });

  it('session-rechecked: authRequired berubah diperbarui, sama → state sama', () => {
    const a = app({ epoch: 1, authRequired: true });
    expect(authReducer(a, { type: 'session-rechecked', epoch: 1, session: S(true, true) })).toBe(a);
    expect(authReducer(a, { type: 'session-rechecked', epoch: 1, session: S(false, true) })).toEqual({ ...a, authRequired: false });
  });

  it('session-rechecked di luar fase app diabaikan', () => {
    const l = loginPhase();
    expect(authReducer(l, { type: 'session-rechecked', epoch: 1, session: S(true, false) })).toBe(l);
    expect(authReducer(initialAuthState, { type: 'session-rechecked', epoch: 0, session: S(true, false) })).toBe(initialAuthState);
  });

  it('login-succeeded: login → app, epoch naik, notice hilang; authRequired dari sesi bila diketahui', () => {
    const l = loginPhase({ epoch: 4, notice: { kind: 'warn', text: 'x' } });
    expect(authReducer(l, { type: 'login-succeeded', session: S(true, true) })).toEqual({ phase: 'app', authRequired: true, epoch: 5, notice: null });
    expect(authReducer(l, { type: 'login-succeeded', session: S(false, true) })).toMatchObject({ authRequired: false });
    expect(authReducer(l, { type: 'login-succeeded', session: UNKNOWN })).toMatchObject({ phase: 'app', authRequired: true });
    expect(authReducer(l, { type: 'login-succeeded' })).toMatchObject({ phase: 'app', authRequired: true });
    const a = app();
    expect(authReducer(a, { type: 'login-succeeded', session: S(true, true) })).toBe(a);
  });

  it('logged-out: sukses → info; gagal → error dengan pesan; di luar app diabaikan', () => {
    const a = app({ epoch: 2 });
    expect(authReducer(a, { type: 'logged-out', result: { ok: true } })).toEqual({ phase: 'login', authRequired: true, epoch: 2, notice: { kind: 'info', text: MESSAGES.loggedOut } });
    expect(authReducer(a, { type: 'logged-out', result: { ok: false, error: 'Keluar gagal (HTTP 500).' } }).notice).toEqual({ kind: 'error', text: 'Keluar gagal (HTTP 500).' });
    expect(authReducer(a, { type: 'logged-out', result: { ok: false } }).notice).toEqual({ kind: 'error', text: MESSAGES.logoutNetwork });
    expect(authReducer(a, { type: 'logged-out' }).notice).toEqual({ kind: 'error', text: MESSAGES.logoutNetwork });
    const l = loginPhase();
    expect(authReducer(l, { type: 'logged-out', result: { ok: true } })).toBe(l);
  });

  it('aksi tidak dikenal / kosong → state sama', () => {
    const a = app();
    expect(authReducer(a, { type: 'apa-ini' })).toBe(a);
    expect(authReducer(a, undefined)).toBe(a);
    expect(authReducer(a, null)).toBe(a);
  });

  it('alur lengkap: buka → app → sesi habis → login → app epoch baru → cek ulang basi diabaikan', () => {
    let st = authReducer(initialAuthState, { type: 'session-checked', session: S(true, true) });
    expect(st).toMatchObject({ phase: 'app', epoch: 1 });
    const staleEpoch = st.epoch;
    st = authReducer(st, { type: 'session-rechecked', epoch: 1, session: S(true, false) });
    expect(st).toMatchObject({ phase: 'login', notice: { kind: 'warn' } });
    st = authReducer(st, { type: 'login-succeeded', session: S(true, true) });
    expect(st).toMatchObject({ phase: 'app', epoch: 2, notice: null });
    const before = st;
    st = authReducer(st, { type: 'session-rechecked', epoch: staleEpoch, session: S(true, false) });
    expect(st).toBe(before);
    st = authReducer(st, { type: 'logged-out', result: { ok: true } });
    expect(st).toMatchObject({ phase: 'login', notice: { kind: 'info' } });
  });
});

// ------------------------------------------------------------------------------ src/net.js
describe('src/net.js: getSession / postLogin / postLogout (fetch distub)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const respond = (status, body) => vi.fn(async () => ({
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError('JSON rusak');
      return body;
    },
  }));

  it('getSession: GET /api/session no-store + same-origin → parseSession', async () => {
    const f = respond(200, { ok: true, authRequired: true, authenticated: false });
    vi.stubGlobal('fetch', f);
    expect(await getSession()).toEqual(S(true, false));
    const [path, init] = f.mock.calls[0];
    expect(path).toBe('/api/session');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(init.method).toBeUndefined();
  });

  it('getSession tidak pernah melempar: jaringan putus / JSON rusak / 404 → unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    expect(await getSession()).toEqual(UNKNOWN);
    vi.stubGlobal('fetch', respond(200, undefined));
    expect(await getSession()).toEqual(UNKNOWN);
    vi.stubGlobal('fetch', respond(404, { ok: false }));
    expect(await getSession()).toEqual(UNKNOWN);
  });

  it('postLogin: token hanya di body JSON POST (bukan URL) → loginResult', async () => {
    const f = respond(401, { ok: false, error: 'Token salah' });
    vi.stubGlobal('fetch', f);
    expect(await postLogin('rahasia-123')).toEqual({ ok: false, error: 'Token salah' });
    const [path, init] = f.mock.calls[0];
    expect(path).toBe('/api/login');
    expect(path).not.toContain('rahasia');
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' } });
    expect(JSON.parse(init.body)).toEqual({ token: 'rahasia-123' });
    vi.stubGlobal('fetch', respond(200, { ok: true }));
    expect(await postLogin('x')).toEqual({ ok: true });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await postLogin('x')).toEqual({ ok: false, error: MESSAGES.network });
  });

  it('postLogout: POST /api/logout {} → logoutResult', async () => {
    const f = respond(200, { ok: true });
    vi.stubGlobal('fetch', f);
    expect(await postLogout()).toEqual({ ok: true });
    expect(f.mock.calls[0][0]).toBe('/api/logout');
    expect(f.mock.calls[0][1]).toMatchObject({ method: 'POST', body: '{}' });
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    expect(await postLogout()).toEqual({ ok: false, error: MESSAGES.logoutNetwork });
  });
});

describe('src/net.js: connect + onClosedBeforeHello (WebSocket distub, timer palsu)', () => {
  class FakeWS {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      FakeWS.instances.push(this);
    }
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
    message(data) {
      this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
  }

  const setup = (protocol = 'http:') => {
    FakeWS.instances = [];
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol, host: 'office.example.com' });
  };
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  const handlers = (extra = {}) => ({ onEvent: vi.fn(), onHistory: vi.fn(), onStatus: vi.fn(), ...extra });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('URL ws:// untuk http dan wss:// untuk https', () => {
    setup('http:');
    connect(handlers()).close();
    expect(FakeWS.instances[0].url).toBe('ws://office.example.com/ws');
    setup('https:');
    connect(handlers()).close();
    expect(FakeWS.instances[0].url).toBe('wss://office.example.com/ws');
  });

  it('ditolak sebelum hello + callback false → tidak reconnect lagi', async () => {
    setup();
    const onClosedBeforeHello = vi.fn(async () => false);
    const h = handlers({ onClosedBeforeHello });
    const c = connect(h);
    FakeWS.instances[0].close();
    await flush();
    vi.advanceTimersByTime(60000);
    expect(onClosedBeforeHello).toHaveBeenCalledTimes(1);
    expect(FakeWS.instances).toHaveLength(1);
    expect(h.onStatus.mock.calls.map((x) => x[0])).toEqual(['connecting', 'offline']);
    expect(c.isOnline()).toBe(false);
  });

  it('ditolak sebelum hello + callback true/undefined/melempar → reconnect dengan backoff', async () => {
    for (const cb of [async () => true, () => undefined, async () => {
      throw new Error('cek gagal');
    }]) {
      setup();
      const c = connect(handlers({ onClosedBeforeHello: cb }));
      FakeWS.instances[0].close();
      await flush();
      vi.advanceTimersByTime(499);
      expect(FakeWS.instances).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(FakeWS.instances).toHaveLength(2);
      c.close();
      vi.useRealTimers();
    }
  });

  it('setelah hello, penutupan tidak memanggil onClosedBeforeHello dan langsung reconnect', async () => {
    setup();
    const onClosedBeforeHello = vi.fn(async () => false);
    const h = handlers({ onClosedBeforeHello });
    const c = connect(h);
    const ws = FakeWS.instances[0];
    ws.open();
    expect(c.isOnline()).toBe(true);
    ws.message({ kind: 'hello', events: [{ id: 1 }] });
    ws.message('{rusak');
    ws.message({ kind: 'event', event: { id: 2 } });
    expect(h.onHistory).toHaveBeenCalledWith([{ id: 1 }]);
    expect(h.onEvent).toHaveBeenCalledWith({ id: 2 });
    ws.close();
    await flush();
    expect(onClosedBeforeHello).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances).toHaveLength(2);
    c.close();
  });

  it('close() saat cek sesi masih berjalan → tidak reconnect', async () => {
    setup();
    let release;
    const c = connect(handlers({ onClosedBeforeHello: () => new Promise((r) => (release = r)) }));
    FakeWS.instances[0].close();
    await flush();
    c.close();
    release(true);
    await flush();
    vi.advanceTimersByTime(60000);
    expect(FakeWS.instances).toHaveLength(1);
  });

  it('tanpa onClosedBeforeHello (kompatibel lama) → reconnect biasa', async () => {
    setup();
    const c = connect(handlers());
    FakeWS.instances[0].close();
    await flush();
    vi.advanceTimersByTime(500);
    expect(FakeWS.instances).toHaveLength(2);
    c.close();
  });
});
