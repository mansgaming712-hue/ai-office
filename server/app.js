// Server AI Office: menyajikan UI (dist/), menerima event lewat HTTP POST, dan
// meneruskannya ke semua browser lewat WebSocket.
//
//   POST /api/events   body: satu event atau array event (Content-Type: application/json)
//   GET  /api/events   riwayat event terakhir
//   GET  /api/usage    statistik pemakaian token (estimasi lokal, lihat server/usage.js)
//   GET  /api/health   status server
//   GET  /api/divisions divisi plugin (folder divisions/, opsi `divisions` = hasil discoverDivisions); auth seperti /api/usage
//   GET  /api/session  { ok, authRequired, authenticated }
//   POST /api/login    body { token } → cookie aio_session (mode token)
//   GET  /api/runner, POST /api/tasks, POST /api/demo, GET /api/tasks[/<id>[/files/<path>]], POST /api/tasks/<id>/cancel
//                      runner Claude Code dan demo (server/tasks.js). Otorisasi: mode token = auth yang sama dengan
//                      /api/events; mode lokal = header X-AI-Office-Key (runner key); mode terbuka = nonaktif kecuali
//                      opsi runnerEnabled (AI_OFFICE_RUNNER=1). GET /api/runner boleh tanpa key (tanpa detail tugas aktif).
//   POST /api/logout   hapus cookie aio_session
//   WS   /ws           { kind: "hello", events: [...] }, { kind: "usage", usage } (bila opsi usage),
//                      lalu { kind: "event", event }, { kind: "usage", usage } setiap statistik berubah, dan
//                      { kind: "task", task: { id, title, status, kind, summary? } } setiap status tugas berubah
//
// Mode token (opsi `token` terisi): /api/events, /api/usage, dan /ws butuh `Authorization: Bearer <token>`
// atau cookie aio_session sah. Lihat server/auth.js.
//
// Dedup POST: satu sesi bisa punya hook level proyek DAN level user, jadi event identik (type, from, to,
// message, project, tokens) dalam `dedupWindowMs` (default 3 detik) terakhir dibuang diam-diam: tidak masuk
// riwayat, tidak disiarkan, tidak memakai id. Respons tetap 202 (`accepted` = jumlah yang disimpan).
//
// Opsi `usage`: tracker dari createUsageTracker (server/usage.js). Dijalankan saat listen(), dihentikan
// saat close(). Tanpa opsi ini /api/usage menjawab available: false.
//
// Target request (HTTP dan upgrade): hanya origin-form "/..." tanpa "\", dan bagian path-nya tanpa
// "%5c", "%2f", maupun "//"; selain itu 400 (lihat requestPathname di server/net.js), supaya Node dan
// Nginx melihat path yang sama dan batas laju /api/ dan /ws di Nginx tidak bisa dilewati.
// Header Host (anti DNS rebinding, divalidasi ketat dengan parseHostHeader):
//   allowedHosts terisi → hanya host di daftar itu, plus loopback bila server mendengar di loopback
//   tanpa allowedHosts  → loopback saja bila mendengar di loopback; host apa pun bila tidak
// Header Origin (browser dari situs lain tidak boleh membaca atau mengirim event):
//   mode lokal / token di loopback → hanya Origin loopback (http/https) dengan port soket server sendiri atau
//                                     port di opsi devPorts (bawaan [], tidak ada), plus origin di devOrigins
//                                     (env AI_OFFICE_DEV_ORIGINS). Port dev Vite 5173 TIDAK otomatis diterima:
//                                     hanya lewat `npm run dev` (scripts/dev.mjs) atau env itu. Origin "null" /
//                                     skema lain ditolak.
//   mode terbuka                    → Origin harus sama persis (skema + host + port) dengan alamat yang
//                                     dibuka browser, dan hostname-nya harus host yang diizinkan
// Log: default hanya metadata event ("[event] type from → to (N karakter)"). Isi pesan ikut dicatat
// hanya bila opsi `logMessages` true (server/index.js: AI_OFFICE_LOG_MESSAGES=1).
import { createServer as createHttpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { TASK_ID_RE, normalizeBatch } from '../shared/events.js';
import { t } from '../shared/i18n.js';
import { createAuth, createLoginLimiter, resolveAuthMode, safeEqual } from './auth.js';
import { publicDivisions } from './divisions.js';
import { StoreError } from './outputStore.js';
import { TaskError, createTaskService } from './tasks.js';
import { REASONS, unavailableUsage } from './usage.js';
import { hostnameOf, isLoopbackHost, parseHostHeader, requestPathname } from './net.js';

export { hostnameOf, isLoopbackHost, requestPathname };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export function createAiOfficeServer({
  host = '127.0.0.1',
  port = 3000,
  staticDir = null,
  historyLimit = 300,
  maxBodyBytes = 64 * 1024,
  allowedHosts = [],
  token = '',
  trustProxy = false,
  logMessages = false,
  dedupWindowMs = 3000,
  devOrigins: devOriginList = [],
  devPorts = [], // port loopback tambahan yang diterima di mode lokal; kosong = hanya port server sendiri (5173 hanya lewat devOrigins)
  usage = null,
  runnerKey = null,
  runnerEnabled = false,
  taskOptions = {},
  divisions = null, // hasil discoverDivisions() (server/divisions.js); null = tanpa divisi plugin
  log = () => {},
} = {}) {
  // Mode terbuka (bukan loopback / allowedHosts / trustProxy) tanpa token ≥ 32 karakter ditolak,
  // begitu juga trustProxy dengan host bukan loopback.
  const mode = resolveAuthMode({ host, allowedHosts, trustProxy, token });
  if (mode.error) throw new Error(mode.error);
  const auth = createAuth({ token: mode.token, trustProxy, open: mode.open });
  const limiter = createLoginLimiter();
  let warnedNoClientIp = false;

  const history = [];
  let nextId = 1;
  const root = staticDir ? resolve(staticDir) : null;
  const localOnly = isLoopbackHost(host);
  const openMode = mode.open;
  const extraHosts = new Set(allowedHosts.map((h) => String(h).toLowerCase()));
  // Origin dev server (mis. http://localhost:5173) yang diizinkan di mode lokal; kosong secara default.
  const devOrigins = new Set();
  for (const v of devOriginList) {
    try {
      devOrigins.add(new URL(String(v)).origin);
    } catch {
      // entri tidak sah diabaikan
    }
  }

  const devPortSet = new Set(devPorts.map((p) => String(Number(p))));

  // Hostname dari header Host yang lolos validasi ketat (parseHostHeader), atau '' bila tidak sah.
  // Parser URL yang longgar (hostnameOf) tidak dipakai di sini: ia menerima "evil@office.example.com"
  // atau "office.example.com/x" sebagai office.example.com.
  const requestHostname = (req) => parseHostHeader(req.headers.host)?.hostname ?? '';

  // Lindungi dari DNS rebinding. Dengan allowedHosts, hanya daftar itu (+ loopback bila server
  // mendengar di loopback, untuk health check lokal) yang diterima.
  const hostAllowed = (req) => {
    if (extraHosts.size === 0 && !localOnly) return true; // server menerima host apa pun (perilaku lama)
    const h = requestHostname(req);
    if (extraHosts.size > 0) return extraHosts.has(h) || (localOnly && isLoopbackHost(h));
    return isLoopbackHost(h);
  };

  /** Origin yang mungkin dipakai browser untuk alamat di header Host (skema + host + port). */
  function expectedOrigins(req) {
    const h = parseHostHeader(req.headers.host);
    if (!h) return [];
    const scheme = auth.requestScheme(req);
    const out = [];
    for (const s of scheme ? [scheme] : ['https', 'http']) {
      try {
        out.push(new URL(`${s}://${h.host}`).origin);
      } catch {
        // host tidak bisa diurai sebagai URL: tidak ada origin yang cocok
      }
    }
    return out;
  }

  // Browser dari situs lain tidak boleh membaca atau mengirim event.
  const originAllowed = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true; // klien non-browser (hook, curl)
    if (!openMode) {
      // Mode lokal / token di loopback: Origin loopback harus memakai port soket server sendiri; localhost,
      // 127.0.0.1, dan [::1] dianggap setara. Port loopback lain ditolak, termasuk 5173 (Vite). Origin dev
      // server hanya lewat opsi devOrigins (AI_OFFICE_DEV_ORIGINS, diisi oleh `npm run dev`) atau devPorts.
      let o;
      try {
        o = new URL(origin);
      } catch {
        return false; // termasuk Origin "null"
      }
      if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
      if (devOrigins.has(o.origin)) return true;
      // Hanya Origin loopback (hostname hasil `new URL`: userinfo "localhost:5173@evil" sudah dibuang) dengan
      // port soket server sendiri atau port dev server (devPorts). Port loopback lain ditolak.
      if (!isLoopbackHost(o.hostname.replace(/^\[|\]$/g, ''))) return false;
      const scheme = auth.requestScheme(req); // null = tidak diketahui (di belakang proxy tanpa X-Forwarded-Proto)
      if (scheme && o.protocol !== `${scheme}:`) return false;
      const originPort = o.port || (o.protocol === 'https:' ? '443' : '80');
      return originPort === String(req.socket?.localPort) || devPortSet.has(originPort);
    }
    // Mode terbuka: Origin loopback tidak otomatis diizinkan.
    let o;
    try {
      o = new URL(origin);
    } catch {
      return false; // termasuk Origin "null"
    }
    if (o.protocol !== 'http:' && o.protocol !== 'https:') return false;
    const name = o.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (extraHosts.size > 0 ? !extraHosts.has(name) : name !== requestHostname(req)) return false;
    return expectedOrigins(req).includes(o.origin);
  };

  function send(res, status, body, headers = {}) {
    const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
    res.writeHead(status, {
      'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(isJson ? JSON.stringify(body) : body);
  }

  function securityHeaders(req) {
    // connect-src hanya dari header Host yang lolos validasi ketat (tanpa ";" atau spasi); kalau tidak
    // sah, cukup 'self' (browser modern juga mencocokkan ws/wss same-origin dengan 'self').
    const h = parseHostHeader(req.headers.host)?.host;
    return {
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': [
        "default-src 'self'",
        h ? `connect-src 'self' ws://${h} wss://${h}` : "connect-src 'self'",
        "img-src 'self' data:",
        "style-src 'self'",
        "font-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "frame-ancestors 'none'",
      ].join('; '),
    };
  }

  function readBody(req) {
    return new Promise((resolveBody, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBodyBytes) {
          reject(Object.assign(new Error('body terlalu besar'), { status: 413 }));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  // Kunci event yang baru diterima lewat POST → waktu terima (ms), untuk dedup.
  const recent = new Map();
  const dedupKey = (e) => JSON.stringify([e.type, e.from, e.to, e.message, e.project ?? '', e.tokens ?? null]);

  /** Buang event yang identik dengan kiriman ≤ dedupWindowMs terakhir (termasuk di batch yang sama). */
  function dropDuplicates(events) {
    if (!(dedupWindowMs > 0)) return { fresh: events, dropped: 0 };
    const t = Date.now();
    for (const [k, at] of recent) {
      if (t - at < dedupWindowMs && at <= t) break; // Map urut waktu sisip: sisanya masih baru
      recent.delete(k);
    }
    const fresh = [];
    for (const e of events) {
      const k = dedupKey(e);
      const at = recent.get(k);
      if (at !== undefined && t - at < dedupWindowMs && at <= t) continue;
      recent.delete(k); // sisip ulang supaya urutan Map tetap urut waktu
      recent.set(k, t);
      fresh.push(e);
    }
    return { fresh, dropped: events.length - fresh.length };
  }

  /** Snapshot usage yang aman: tidak pernah melempar. */
  function usageSnapshot() {
    if (!usage) return unavailableUsage(REASONS.disabled);
    try {
      return usage.snapshot();
    } catch (e) {
      log(`[usage] snapshot gagal (${e.message})`);
      return unavailableUsage(REASONS.error);
    }
  }

  function broadcast(msg) {
    for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
  }

  function publish(events) {
    const stored = events.map((e) => ({ ...e, id: nextId++ }));
    for (const e of stored) {
      history.push(e);
      if (history.length > historyLimit) history.shift();
      const msg = JSON.stringify({ kind: 'event', event: e });
      for (const client of wss.clients) if (client.readyState === 1) client.send(msg);
      log(eventLogLine(e));
    }
    return stored;
  }

  /** Default hanya metadata (log di VPS masuk journald/disk); isi pesan hanya dengan logMessages. */
  function eventLogLine(e) {
    const text = typeof e.message === 'string' ? e.message : '';
    const head = `[event] ${e.type} ${e.from} → ${e.to}`;
    if (logMessages) return text ? `${head}: ${text}` : head;
    return `${head} (${text.length} karakter)`;
  }

  const httpError = (status, message) => Object.assign(new Error(message), { status });

  /** Cek Content-Type JSON, baca body (dengan batas ukuran), lalu parse bila `parse` true. */
  async function readJsonBody(req, { parse = true } = {}) {
    const type = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json')) throw httpError(415, 'Content-Type harus application/json');
    let text;
    try {
      text = await readBody(req);
    } catch (e) {
      throw httpError(e.status ?? 400, e.message);
    }
    if (!parse) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw httpError(400, 'JSON tidak valid');
    }
  }

  const sendError = (res, e) => send(res, e.status ?? 400, { ok: false, error: e.message });

  function sendUnauthorized(res) {
    return send(res, 401, { ok: false, error: 'Butuh autentikasi' }, { 'WWW-Authenticate': 'Bearer' });
  }

  async function handlePost(req, res) {
    let data;
    try {
      data = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e);
    }
    const r = normalizeBatch(data);
    if (!r.ok) return send(res, 400, { ok: false, error: r.error });
    const { fresh, dropped } = dropDuplicates(r.events);
    const stored = publish(fresh);
    if (usage) {
      try {
        usage.recordEvents(stored);
      } catch (e) {
        log(`[usage] event token tidak tercatat (${e.message})`);
      }
    }
    const body = { ok: true, accepted: stored.length, ids: stored.map((e) => e.id) };
    if (dropped) body.duplicates = dropped;
    return send(res, 202, body);
  }

  async function handleLogin(req, res) {
    let data;
    try {
      data = await readJsonBody(req);
    } catch (e) {
      return sendError(res, e);
    }
    if (!auth.enabled) return send(res, 200, { ok: true }); // mode lokal: tidak ada yang perlu dicek
    // Cek batas, bandingkan, dan catat kegagalan dalam satu blok sinkron, supaya request paralel
    // tidak bisa melewati batas 10 percobaan.
    const ip = auth.clientIp(req);
    if (ip === null) {
      // trustProxy aktif tetapi proxy tidak mengirim X-Real-IP yang sah: salah konfigurasi. Jangan
      // jatuh ke IP soket (semua klien jadi satu kunci, satu penyerang mengunci semua pengguna).
      if (!warnedNoClientIp) {
        warnedNoClientIp = true;
        log(t('auth.noClientIpLog'));
      }
      return send(res, 503, { ok: false, error: t('auth.noClientIp') });
    }
    const gate = limiter.check(ip);
    if (!gate.allowed) {
      return send(res, 429, { ok: false, error: 'Terlalu banyak percobaan. Coba lagi nanti.' }, { 'Retry-After': String(gate.retryAfterS) });
    }
    const given = data && typeof data === 'object' && typeof data.token === 'string' ? data.token.trim() : '';
    if (!auth.tokenMatches(given)) {
      const n = limiter.fail(ip);
      log(`[auth] login gagal dari ${ip} (${n}/${limiter.maxFailures})`);
      if (n === limiter.maxFailures) log(`[auth] ${ip} diblokir sementara (15 menit)`);
      return send(res, 401, { ok: false, error: 'Token salah' });
    }
    limiter.reset(ip);
    log(`[auth] login berhasil dari ${ip}`);
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.sessionCookie(req) });
  }

  async function handleLogout(req, res) {
    try {
      await readJsonBody(req, { parse: false }); // body boleh kosong; header JSON dan batas ukuran tetap dicek
    } catch (e) {
      return sendError(res, e);
    }
    auth.revoke(req); // cabut sesi di sisi server (hanya cookie bertanda tangan sah)
    return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie(req) });
  }

  // ---------------------------------------------------------------- runner, demo, file tugas
  const methodNotAllowed = (res, allow) => send(res, 405, { ok: false, error: 'Method tidak diizinkan' }, { Allow: allow });

  /** Bagian otorisasi (tanpa cek runner aktif): { ok: true } atau { ok: false, status, error }. */
  function runnerAuthorization(req) {
    if (auth.enabled) return auth.check(req).ok ? { ok: true } : { ok: false, status: 401, error: 'Butuh autentikasi' };
    const given = req.headers['x-ai-office-key'];
    if (typeof given !== 'string' || given === '') return { ok: false, status: 401, error: t('runner.err.keyMissing') };
    if (!runnerKey || given.length > 256 || !safeEqual(given, runnerKey)) {
      return { ok: false, status: 403, error: t(runnerKey ? 'runner.err.keyBad' : 'runner.err.noKey') };
    }
    return { ok: true };
  }

  /** Otorisasi penuh untuk endpoint runner/demo/file: true bila lolos, selain itu respons sudah dikirim. */
  function runnerGate(req, res) {
    const a = runnerAuthorization(req);
    if (!a.ok) {
      send(res, a.status, { ok: false, error: a.error }, a.status === 401 && auth.enabled ? { 'WWW-Authenticate': 'Bearer' } : {});
      return false;
    }
    if (!tasks.enabled) {
      send(res, 403, { ok: false, error: t('runner.err.disabled') });
      return false;
    }
    return true;
  }

  const sendTaskError = (res, e) => {
    if (e instanceof TaskError) return send(res, e.status, { ok: false, error: e.message });
    if (e instanceof StoreError) {
      const key = { 'bad-path': 'runner.err.badPath', 'too-large': 'runner.err.tooLarge', 'not-text': 'runner.err.notText' }[e.message] ?? 'runner.err.notFound';
      return send(res, e.status, { ok: false, error: t(key) });
    }
    return sendError(res, e);
  };

  async function handleTasks(req, res, pathname) {
    if (pathname === '/api/runner') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      const authorized = runnerAuthorization(req).ok;
      const st = await tasks.status({ showActive: authorized });
      // Tanpa auth di mode token/terbuka: jangan bocorkan versi CLI maupun status sibuk. Mode lokal tidak berubah.
      const hide = !authorized && (auth.enabled || openMode);
      return send(res, 200, {
        ok: true,
        available: st.available,
        reason: hide && st.reason === 'busy' ? null : st.reason,
        keyRequired: !auth.enabled,
        version: hide ? null : st.version,
        active: st.active,
      });
    }
    if (pathname === '/api/demo') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!runnerGate(req, res)) return undefined;
      let data;
      try {
        data = await readJsonBody(req);
      } catch (e) {
        return sendError(res, e);
      }
      try {
        const task = await tasks.startDemo({ lang: data && typeof data === 'object' ? data.lang : undefined });
        return send(res, 202, { ok: true, task });
      } catch (e) {
        return sendTaskError(res, e);
      }
    }
    if (pathname === '/api/tasks') {
      if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
      if (!runnerGate(req, res)) return undefined;
      if (req.method === 'GET') return send(res, 200, { ok: true, tasks: await tasks.list() });
      let data;
      try {
        data = await readJsonBody(req);
      } catch (e) {
        return sendError(res, e);
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) return send(res, 400, { ok: false, error: t('runner.err.badText') });
      try {
        const task = await tasks.startTask({ text: data.text, lang: data.lang });
        return send(res, 202, { ok: true, task });
      } catch (e) {
        return sendTaskError(res, e);
      }
    }
    // /api/tasks/<id>, /api/tasks/<id>/cancel, /api/tasks/<id>/files/<path...>
    const parts = pathname.split('/'); // ['', 'api', 'tasks', id, ...]
    const id = parts[3];
    const rest = parts.slice(4);
    if (rest.length === 0 || (rest.length === 1 && rest[0] === '')) {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
      if (!runnerGate(req, res)) return undefined;
      const task = TASK_ID_RE.test(id) ? await tasks.get(id) : null;
      return task ? send(res, 200, { ok: true, task }) : send(res, 404, { ok: false, error: t('runner.err.notFound') });
    }
    if (rest.length === 1 && rest[0] === 'cancel') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
      if (!runnerGate(req, res)) return undefined;
      req.resume();
      try {
        return send(res, 200, await tasks.cancel(id));
      } catch (e) {
        return sendTaskError(res, e);
      }
    }
    if (rest[0] === 'files' && rest.length >= 2) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return methodNotAllowed(res, 'GET');
      if (!runnerGate(req, res)) return undefined;
      let rel;
      try {
        rel = rest.slice(1).map((seg) => decodeURIComponent(seg)).join('/');
      } catch {
        return send(res, 400, { ok: false, error: t('runner.err.badPath') });
      }
      try {
        const text = await tasks.readFile(id, rel);
        return send(res, 200, req.method === 'HEAD' ? '' : text, {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Disposition': 'inline',
        });
      } catch (e) {
        return sendTaskError(res, e);
      }
    }
    return send(res, 404, { ok: false, error: 'Endpoint tidak ada' });
  }

  /** `urlPath`: pathname yang sudah lolos requestPathname (origin-form, tanpa "\" / "%5c" / "%2f" / "//"). */
  async function serveStatic(req, res, urlPath) {
    if (!root) return send(res, 404, 'Not found');
    let pathname;
    try {
      pathname = decodeURIComponent(urlPath);
    } catch {
      return send(res, 400, 'Bad request');
    }
    if (pathname.includes('\0')) return send(res, 400, 'Bad request');
    const rel = normalize(pathname).replace(/^([/\\])+/, '');
    let file = resolve(join(root, rel || 'index.html'));
    if (file !== root && !file.startsWith(root + sep)) return send(res, 403, 'Forbidden');
    let info = await stat(file).catch(() => null);
    if (info?.isDirectory()) {
      file = join(file, 'index.html');
      info = await stat(file).catch(() => null);
    }
    // Selain file biasa (perangkat, FIFO, socket, direktori tanpa index) diperlakukan seperti tidak ada.
    if (info && !info.isFile()) return send(res, 404, 'Not found');
    if (!info) {
      // Fallback SPA hanya untuk navigasi halaman, bukan aset yang hilang.
      if (extname(pathname)) return send(res, 404, 'Not found');
      file = join(root, 'index.html');
      info = await stat(file).catch(() => null);
      if (!info) return send(res, 503, 'UI belum di-build. Jalankan: npm run build');
      if (!info.isFile()) return send(res, 404, 'Not found');
    }
    const body = await readFile(file);
    const isAsset = file.includes(`${sep}assets${sep}`);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...securityHeaders(req),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  const server = createHttpServer(async (req, res) => {
    try {
      // Target request yang bentuknya ditolak (lihat requestPathname di net.js): 400 tanpa stack trace.
      const pathname = requestPathname(req.url);
      if (pathname === null) return send(res, 400, { ok: false, error: 'URL tidak valid' });
      if (!hostAllowed(req)) return send(res, 403, { ok: false, error: 'Host tidak diizinkan' });
      if (pathname.startsWith('/api/')) {
        if (!originAllowed(req)) return send(res, 403, { ok: false, error: 'Origin tidak diizinkan' });
        if (pathname === '/api/events') {
          if (auth.enabled && !auth.check(req).ok) return sendUnauthorized(res);
          if (req.method === 'POST') return await handlePost(req, res);
          if (req.method === 'GET') return send(res, 200, { ok: true, events: history });
          return send(res, 405, { ok: false, error: 'Method tidak diizinkan' }, { Allow: 'GET, POST' });
        }
        if (pathname === '/api/usage') {
          if (auth.enabled && !auth.check(req).ok) return sendUnauthorized(res);
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method tidak diizinkan' }, { Allow: 'GET' });
          return send(res, 200, { ok: true, usage: usageSnapshot() });
        }
        if (pathname === '/api/divisions') {
          // Hasil penemuan divisi plugin saat server mulai (server/divisions.js). Aturan auth sama dengan /api/usage.
          if (auth.enabled && !auth.check(req).ok) return sendUnauthorized(res);
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method tidak diizinkan' }, { Allow: 'GET' });
          return send(res, 200, { ok: true, ...publicDivisions(divisions ?? { divisions: [], errors: [] }) });
        }
        if (pathname === '/api/session') {
          if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'Method tidak diizinkan' }, { Allow: 'GET' });
          return send(res, 200, { ok: true, authRequired: auth.enabled, authenticated: auth.check(req).ok });
        }
        if (pathname === '/api/login' || pathname === '/api/logout') {
          if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'Method tidak diizinkan' }, { Allow: 'POST' });
          return pathname === '/api/login' ? await handleLogin(req, res) : await handleLogout(req, res);
        }
        if (pathname === '/api/runner' || pathname === '/api/demo' || pathname === '/api/tasks' || pathname.startsWith('/api/tasks/')) {
          return await handleTasks(req, res, pathname);
        }
        if (pathname === '/api/health' && req.method === 'GET') {
          // Mode token: endpoint publik ini tidak membuka jumlah klien/event.
          if (auth.enabled) return send(res, 200, { ok: true });
          return send(res, 200, { ok: true, clients: wss.clients.size, events: history.length });
        }
        return send(res, 404, { ok: false, error: 'Endpoint tidak ada' });
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
      return await serveStatic(req, res, pathname);
    } catch (e) {
      log(`[error] ${e.stack ?? e}`);
      if (!res.headersSent) send(res, 500, { ok: false, error: 'Kesalahan server' });
      else res.end();
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 });
  // Dengan noServer, wss biasanya tidak memancarkan 'error'; listener ini hanya jaring pengaman
  // supaya error apa pun tidak menjadi "Unhandled 'error' event" yang mematikan proses.
  wss.on('error', (e) => log(`[ws] error server WebSocket: ${e.code ?? e.message}`));

  function rejectUpgrade(socket, statusLine, extraHeaders = '') {
    if (socket.destroyed) return;
    socket.once('finish', () => socket.destroy());
    socket.end(`HTTP/1.1 ${statusLine}\r\n${extraHeaders}Connection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  server.on('upgrade', (req, socket, head) => {
    // Klien bisa memutus kapan saja (sebelum, selama, atau sesudah handshake); error soket tidak
    // boleh menjatuhkan proses. Setelah upgrade, ws memasang listener-nya sendiri juga.
    socket.on('error', () => socket.destroy());
    try {
      // Sama dengan HTTP: "\", "%5c", "//...", dan bentuk selain origin-form → 400.
      const pathname = requestPathname(req.url);
      if (pathname === null) return rejectUpgrade(socket, '400 Bad Request');
      if (pathname !== '/ws' || !hostAllowed(req) || !originAllowed(req)) return rejectUpgrade(socket, '403 Forbidden');
      const session = auth.check(req); // mode lokal selalu ok
      if (!session.ok) return rejectUpgrade(socket, '401 Unauthorized', 'WWW-Authenticate: Bearer\r\n');
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.authExpiresAtMs = session.expiresAtMs;
        wss.emit('connection', ws, req);
      });
    } catch (e) {
      log(`[error] upgrade: ${e.stack ?? e}`);
      rejectUpgrade(socket, '500 Internal Server Error');
    }
  });
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    // Pesan > maxPayload (4 KB), frame UTF-8 rusak, atau error protokol lain memancarkan 'error'
    // pada koneksi ini. Tanpa listener, Node melempar dan seluruh server mati. Di sini hanya koneksi
    // itu yang ditutup: ws sudah mengirim close frame (mis. 1009/1007); bila handshake penutupan
    // tidak selesai dalam 2 detik, koneksi diputus paksa.
    ws.on('error', (e) => {
      log(`[ws] koneksi ditutup karena error: ${e.code ?? e.message}`);
      if (ws.readyState === ws.CLOSED) return;
      const t = setTimeout(() => ws.terminate(), 2000);
      t.unref();
      ws.once('close', () => clearTimeout(t));
    });
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('message', () => {}); // browser hanya mendengar; kirim event lewat POST
    ws.send(JSON.stringify({ kind: 'hello', events: history }));
    if (usage) ws.send(JSON.stringify({ kind: 'usage', usage: usageSnapshot() }));
  });
  const offUsage = usage ? usage.onChange((u) => broadcast(JSON.stringify({ kind: 'usage', usage: u }))) : () => {};
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const ws of wss.clients) {
      // Sesi cookie habis selama koneksi terbuka: tutup, klien harus login ulang.
      if (ws.authExpiresAtMs !== undefined && now >= ws.authExpiresAtMs) {
        ws.close(4401, 'Sesi kedaluwarsa');
        continue;
      }
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30000);
  heartbeat.unref();

  const tasks = createTaskService({
    outputDir: fileURLToPath(new URL('../output/', import.meta.url)),
    publish: (events) => publish(events),
    broadcast: (obj) => broadcast(JSON.stringify(obj)),
    getPort: () => server.address()?.port,
    enabled: !openMode || runnerEnabled,
    log,
    ...taskOptions,
  });

  return {
    server,
    wss,
    history,
    publish,
    usage,
    tasks,
    listen() {
      return new Promise((ok, fail) => {
        server.once('error', fail);
        server.listen(port, host, () => {
          server.off('error', fail);
          // Setelah mendengar, error server (mis. accept gagal karena EMFILE) cukup dicatat.
          if (server.listenerCount('error') === 0) server.on('error', (e) => log(`[error] server: ${e.code ?? e.message}`));
          try {
            usage?.start();
          } catch (e) {
            log(`[usage] tidak bisa dimulai (${e.message})`);
          }
          ok(server.address());
        });
      });
    },
    async close() {
      await tasks.shutdown().catch(() => {});
      clearInterval(heartbeat);
      offUsage();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise((ok) => server.close(() => ok()));
      if (usage) await Promise.resolve(usage.stop()).catch(() => {});
    },
  };
}
