// Helper bersama untuk test Bagian 4 (bukan file test: tidak cocok dengan pola tests/**/*.test.js).
// Semua server uji memakai port 0 (acak) atau 3300-3399; port 3000 (animasi live) tidak pernah disentuh.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { createAiOfficeServer } from '../../server/app.js';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const HOOK = fileURLToPath(new URL('../../hooks/send-event.mjs', import.meta.url));
export const SERVER_ENTRY = fileURLToPath(new URL('../../server/index.js', import.meta.url));

/** Token acak 43 karakter (base64url), sama dengan scripts/gen-token.mjs. Hanya hidup di memori. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Variabel lingkungan yang memengaruhi server/hook: dibuang dari env warisan supaya test deterministik. */
const AFFECTING = ['HOST', 'PORT', 'CLAUDE_PROJECT_DIR', 'NODE_USE_ENV_PROXY', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy'];
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('AI_OFFICE_') || AFFECTING.includes(k)) delete env[k];
  return { ...env, ...extra };
}

/** Jalankan server AI Office di dalam proses test (port 0). */
export async function startApp(opts = {}) {
  const logs = [];
  const app = createAiOfficeServer({ host: '127.0.0.1', port: 0, log: (l) => logs.push(l), ...opts });
  const addr = await app.listen();
  return { app, port: addr.port, logs, base: `http://127.0.0.1:${addr.port}`, close: () => app.close() };
}

/** Request HTTP mentah (header Host/Origin/Cookie bebas diatur). */
export function http(port, path, { method = 'GET', headers = {}, body, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const h = { ...headers };
    if (payload !== undefined && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(payload);
    const req = request({ host, port, path, method, headers: h, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export const login = (port, token, headers = {}) =>
  http(port, '/api/login', { method: 'POST', headers: { ...JSON_HEADERS, ...headers }, body: { token } });

/** Ambil "aio_session=<nilai>" dari header Set-Cookie respons login. */
export function cookieFrom(res) {
  const sc = [].concat(res.headers['set-cookie'] ?? [])[0] ?? '';
  const m = /^aio_session=([^;]*)/.exec(sc);
  return m ? `aio_session=${m[1]}` : null;
}

/**
 * Buka WebSocket. Hasil: { status: 101, ws, hello } bila terhubung dan pesan pertama diterima,
 * { status: <kode HTTP>, headers } bila upgrade ditolak, atau { status: 'error' | 'timeout' }.
 * Batas waktu memakai setTimeout (aman dipakai saat hanya Date yang dipalsukan).
 */
export function wsConnect(port, { path = '/ws', headers = {}, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      ws.terminate();
      finish({ status: 'timeout' });
    }, timeoutMs);
    ws.on('error', (error) => finish({ status: 'error', error }));
    ws.once('unexpected-response', (req, res) => {
      res.resume();
      finish({ status: res.statusCode, headers: res.headers });
      req.destroy();
    });
    ws.once('message', (m) => finish({ status: 101, ws, hello: JSON.parse(m.toString()) }));
  });
}

/** Tunggu event 'close' WebSocket, kembalikan { code, reason }. */
export function wsClosed(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve({ code: 'already-closed' });
    const t = setTimeout(() => resolve({ code: 'timeout' }), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(t);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/**
 * Jalankan skrip Node sebagai proses sungguhan. Selalu dibunuh setelah `timeoutMs`.
 * @returns {Promise<{ code: number|null, out: string, err: string, ms: number, timedOut: boolean }>}
 */
export function runNode(args, { env, input, cwd = ROOT, timeoutMs = 15000, onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
      onStdout?.(out, child);
    });
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, ms: Date.now() - t0, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/**
 * Jalankan hooks/send-event.mjs dengan payload hook. AI_OFFICE_URL WAJIB diisi supaya hook tidak
 * pernah jatuh ke default http://127.0.0.1:3000 (server animasi live).
 */
export function runHook(payload, env) {
  if (!env?.AI_OFFICE_URL) throw new Error('runHook: AI_OFFICE_URL wajib diisi (jangan kirim ke port 3000)');
  const input = typeof payload === 'string'
    ? payload
    : JSON.stringify({ session_id: 'test', transcript_path: 'main.jsonl', cwd: ROOT, permission_mode: 'default', ...payload });
  return runNode([HOOK], { env: cleanEnv(env), input, timeoutMs: 15000 });
}

/** Port bebas di rentang 3300-3399 (untuk proses server/index.js yang butuh PORT eksplisit). */
export async function freePort(from = 3300, to = 3399) {
  const start = from + Math.floor(Math.random() * (to - from + 1));
  for (let i = 0; i <= to - from; i++) {
    const p = from + ((start - from + i) % (to - from + 1));
    const ok = await new Promise((resolve) => {
      const s = createNetServer();
      s.once('error', () => resolve(false));
      s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
    });
    if (ok) return p;
  }
  throw new Error(`tidak ada port bebas di ${from}-${to}`);
}

/** Server HTTP penangkap sederhana. `handler(req, body, res)` boleh menulis respons sendiri. */
export async function captureServer({ host = '127.0.0.1', handler } = {}) {
  const { createServer } = await import('node:http');
  const received = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const entry = { method: req.method, url: req.url, headers: req.headers, body, aborted: false };
      received.push(entry);
      res.on('close', () => {
        if (!res.writableFinished) entry.aborted = true;
      });
      if (handler) return handler(req, body, res, entry);
      res.writeHead(202, JSON_HEADERS).end('{"ok":true}');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  return {
    received,
    port,
    url: `http://${host}:${port}/api/events`,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ transkrip JSONL buatan
/** Satu baris transkrip subagent (bentuk ringkas file transkrip Claude Code). */
export const entry = (type, content, extra = {}) =>
  JSON.stringify({ type, isSidechain: true, uuid: `u-${Math.random().toString(36).slice(2)}`, ...extra, message: { role: type === 'user' ? 'user' : 'assistant', content } });
export const handback = (message, extra = {}) =>
  entry('assistant', [{ type: 'tool_use', id: 'toolu_hb', name: 'SubagentHandback', input: { message } }], extra);
export const toolResult = (content = '{"success":true}') => entry('user', [{ type: 'tool_result', tool_use_id: 'toolu_hb', content }]);
export const jsonl = (...lines) => `${lines.join('\n')}\n`;

export const REPORT_BLOCKED = 'STATUS: BUTUH BANTUAN\n\n## Ringkasan\nUji login butuh server staging dari dev-devops.\n\n## Yang dikerjakan\n...';
export const REPORT_DONE = 'STATUS: SELESAI\n\n1. **Ringkasan** — 12 test auth ditambahkan, semua lulus.';
