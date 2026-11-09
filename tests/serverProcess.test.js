// server/index.js sebagai proses sungguhan: penolakan start (exit 1) dan start mode token.
// Port 3300-3399 (bukan 3000 / 3200-3299). Setiap proses dibunuh di akhir test.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  JSON_HEADERS, SERVER_ENTRY, cleanEnv, freePort, http, login, randomToken, runNode, sleep, wsClosed, wsConnect,
} from './helpers/testkit.js';

/**
 * Jalankan server; bila sudah mendengar, `onReady(port, { waitForOutput })` dipanggil lalu proses
 * dimatikan. `waitForOutput(re)` menunggu sampai stdout memuat pola (supaya log sempat tertulis).
 */
async function runServer(env, { onReady, timeoutMs = 10000 } = {}) {
  const port = await freePort();
  let readyPromise = null;
  let latest = '';
  const waitForOutput = async (re, ms = 5000) => {
    const t0 = Date.now();
    while (!re.test(latest)) {
      if (Date.now() - t0 > ms) throw new Error(`stdout server tidak memuat ${re}`);
      await sleep(25);
    }
  };
  const r = await runNode([SERVER_ENTRY], {
    env: cleanEnv({ PORT: String(port), ...env }),
    timeoutMs,
    onStdout: (out, child) => {
      latest = out;
      if (readyPromise || !out.includes('jalan di')) return;
      readyPromise = Promise.resolve()
        .then(() => onReady?.(port, { waitForOutput }))
        .finally(() => child.kill());
    },
  });
  const ready = readyPromise ? await readyPromise : undefined;
  return { ...r, port, ready, all: r.out + r.err };
}

describe('server/index.js menolak start di mode terbuka tanpa token kuat (exit 1)', () => {
  const short = randomToken().slice(0, 20);
  const cases = [
    ['HOST=0.0.0.0 tanpa token', { HOST: '0.0.0.0' }, /kosong/],
    ['HOST=0.0.0.0 + token 20 karakter', { HOST: '0.0.0.0', AI_OFFICE_TOKEN: short }, /terlalu pendek/],
    ['AI_OFFICE_ALLOWED_HOSTS tanpa token', { AI_OFFICE_ALLOWED_HOSTS: 'office.example.com' }, /ALLOWED_HOSTS terisi.*kosong/s],
    ['AI_OFFICE_TRUST_PROXY=1 tanpa token', { AI_OFFICE_TRUST_PROXY: '1' }, /TRUST_PROXY=1.*kosong/s],
    ['ALLOWED_HOSTS + token 31 karakter', { AI_OFFICE_ALLOWED_HOSTS: 'office.example.com', AI_OFFICE_TOKEN: randomToken().slice(0, 31) }, /terlalu pendek/],
  ];

  it.each(cases)('%s', async (_n, env, re) => {
    const r = await runServer(env);
    expect(r.timedOut).toBe(false);
    expect(r.ready).toBeUndefined(); // tidak pernah mendengar
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Server tidak dijalankan: mode terbuka/);
    expect(r.err).toMatch(re);
    expect(r.err).toMatch(/npm run -s token/);
    if (env.AI_OFFICE_TOKEN) expect(r.all).not.toContain(env.AI_OFFICE_TOKEN);
  });
});

describe('server/index.js start normal', () => {
  it('mode token (loopback, token 43 karakter): login wajib, token tidak tercetak', async () => {
    const T = randomToken();
    const r = await runServer({ AI_OFFICE_TOKEN: T }, {
      onReady: async (port) => ({
        session: (await http(port, '/api/session')).json,
        events: (await http(port, '/api/events')).status,
        withBearer: (await http(port, '/api/events', { headers: { Authorization: `Bearer ${T}` } })).status,
        health: (await http(port, '/api/health')).json,
      }),
    });
    expect(r.ready).toEqual({ session: { ok: true, authRequired: true, authenticated: false }, events: 401, withBearer: 200, health: { ok: true } });
    expect(r.out).toMatch(/Mode: token aktif/);
    expect(r.all).not.toContain(T);
  });

  it('mode terbuka dengan token kuat (ALLOWED_HOSTS, HOST tetap 127.0.0.1): start + peringatan tanpa proxy', async () => {
    const T = randomToken();
    const r = await runServer({ AI_OFFICE_TOKEN: T, AI_OFFICE_ALLOWED_HOSTS: ' Office.Example.com , ,bukan host valid' }, {
      onReady: async (port) => (await http(port, '/api/session', { headers: { Host: 'office.example.com' } })).status,
    });
    expect(r.ready).toBe(200);
    expect(r.out).toMatch(/Host yang diizinkan: office\.example\.com/);
    expect(r.err).toMatch(/tanpa AI_OFFICE_TRUST_PROXY=1/);
    expect(r.err).toMatch(/AI_OFFICE_ALLOWED_HOSTS tidak valid diabaikan/);
    expect(r.all).not.toContain(T);
  });

  it('token pendek di loopback: start dengan peringatan, token tidak tercetak', async () => {
    const T = randomToken().slice(0, 12);
    const r = await runServer({ AI_OFFICE_TOKEN: T }, { onReady: async (port) => (await http(port, '/api/session')).json.authRequired });
    expect(r.ready).toBe(true);
    expect(r.err).toMatch(/token lebih pendek dari 32 karakter/);
    expect(r.all).not.toContain(T);
  });

  it('AI_OFFICE_TRUST_PROXY selain "1" diabaikan dengan peringatan (tetap mode lokal)', async () => {
    const r = await runServer({ AI_OFFICE_TRUST_PROXY: 'true' }, { onReady: async (port) => (await http(port, '/api/session')).json });
    expect(r.ready).toEqual({ ok: true, authRequired: false, authenticated: true });
    expect(r.err).toMatch(/hanya aktif bila bernilai 1/);
    expect(r.out).toMatch(/Mode: lokal tanpa token/);
  });
});

describe('scripts/gen-token.mjs (npm run -s token)', () => {
  it('mencetak token base64url 43 karakter yang lolos batas mode terbuka, acak tiap kali', async () => {
    const [a, b] = await Promise.all([runNode(['scripts/gen-token.mjs'], { env: cleanEnv() }), runNode(['scripts/gen-token.mjs'], { env: cleanEnv() })]);
    for (const r of [a, b]) {
      expect(r.code).toBe(0);
      expect(r.err).toBe('');
      expect(r.out).toMatch(/^[A-Za-z0-9_-]{43}\n$/);
    }
    expect(a.out).not.toBe(b.out);
  });
});

// ------------------------------------------------------------------ regresi perbaikan keamanan (proses)
describe('R7: server/index.js dan AI_OFFICE_TRUST_PROXY', () => {
  it('HOST bukan loopback (127.0.0.2) + TRUST_PROXY=1 + token kuat → exit 1, tidak pernah mendengar', async () => {
    const T = randomToken();
    const r = await runServer({ HOST: '127.0.0.2', AI_OFFICE_TRUST_PROXY: '1', AI_OFFICE_TOKEN: T });
    expect(r.timedOut).toBe(false);
    expect(r.ready).toBeUndefined();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/AI_OFFICE_TRUST_PROXY=1 hanya boleh dipakai dengan HOST loopback/);
    expect(r.err).toMatch(/HOST=127\.0\.0\.2/);
    expect(r.err).not.toMatch(/mode terbuka/); // token kuat: satu-satunya alasan adalah trustProxy
    expect(r.all).not.toContain(T);
  });

  it('konfigurasi VPS (HOST=127.0.0.1 + TRUST_PROXY=1 + ALLOWED_HOSTS + token kuat) → start tanpa peringatan proxy', async () => {
    const T = randomToken();
    const r = await runServer({ AI_OFFICE_TRUST_PROXY: '1', AI_OFFICE_ALLOWED_HOSTS: 'office.example.com', AI_OFFICE_TOKEN: T }, {
      onReady: async (port) => (await http(port, '/api/session', { headers: { Host: 'office.example.com', 'X-Forwarded-Proto': 'https' } })).json,
    });
    expect(r.ready).toEqual({ ok: true, authRequired: true, authenticated: false });
    expect(r.out).toMatch(/Proxy dipercaya/);
    expect(r.err).not.toMatch(/tanpa AI_OFFICE_TRUST_PROXY=1/);
    expect(r.all).not.toContain(T);
  });
});

describe('S3: AI_OFFICE_LOG_MESSAGES di server/index.js', () => {
  const MSG = 'Bash · isi-pesan-rahasia-klien';
  const EV = { type: 'working', from: 'dev-backend', to: 'manager', message: MSG };

  it.each([
    ['(tidak diisi)', undefined, false, null],
    ['1', '1', true, /Peringatan: AI_OFFICE_LOG_MESSAGES=1, isi pesan event ikut ditulis ke log server/],
    // Nilai yang bukan 1 sengaja tidak dicetak (bisa token yang salah tempel), hanya alasannya.
    ['yes', 'yes', false, /AI_OFFICE_LOG_MESSAGES hanya aktif bila bernilai 1 \(nilai sekarang bukan 1, tidak ditampilkan\), jadi diabaikan/],
    ['true', 'true', false, /AI_OFFICE_LOG_MESSAGES hanya aktif bila bernilai 1 \(nilai sekarang bukan 1, tidak ditampilkan\), jadi diabaikan/],
    [' 1 (spasi di tepi)', ' 1 ', true, /isi pesan event ikut ditulis/],
  ])('AI_OFFICE_LOG_MESSAGES=%s', async (_label, value, logsContent, warn) => {
    const r = await runServer(value === undefined ? {} : { AI_OFFICE_LOG_MESSAGES: value }, {
      onReady: async (port, { waitForOutput }) => {
        const res = await http(port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body: EV });
        await waitForOutput(/\[event\]/);
        return res.status;
      },
    });
    expect(r.ready).toBe(202);
    const line = r.out.split(/\r?\n/).find((l) => l.includes('[event]'));
    if (logsContent) {
      expect(line.endsWith(`[event] working dev-backend → manager: ${MSG}`), line).toBe(true);
    } else {
      expect(line.endsWith(`[event] working dev-backend → manager (${MSG.length} karakter)`), line).toBe(true);
      expect(r.all).not.toContain('isi-pesan-rahasia');
    }
    if (warn) expect(r.err).toMatch(warn);
    else expect(r.err).not.toMatch(/AI_OFFICE_LOG_MESSAGES/);
    if (value !== undefined && !logsContent) expect(r.all).not.toContain(value);
  });
});

describe('R6: server/index.js dengan AI_OFFICE_TOKEN_FILE', () => {
  const T = randomToken();
  const SECRET = randomToken();
  let home;
  const homeEnv = () => ({ USERPROFILE: home, HOME: home });
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'aio-srv-home-'));
    mkdirSync(join(home, '.ai-office'));
    writeFileSync(join(home, '.ai-office', 'token'), `﻿  ${T}\r\n`); // BOM + spasi + CRLF
    writeFileSync(join(home, 'besar.txt'), `${SECRET}\n`.repeat(200)); // > 4 KB
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  it('"~/.ai-office/token" → mode token: login wajib, token dari file diterima, token tidak tercetak', async () => {
    const r = await runServer({ ...homeEnv(), AI_OFFICE_TOKEN_FILE: '~/.ai-office/token' }, {
      onReady: async (port) => ({
        session: (await http(port, '/api/session')).json,
        tanpaAuth: (await http(port, '/api/events')).status,
        bearer: (await http(port, '/api/events', { headers: { Authorization: `Bearer ${T}` } })).status,
        login: (await login(port, T)).status,
      }),
    });
    expect(r.ready).toEqual({ session: { ok: true, authRequired: true, authenticated: false }, tanpaAuth: 401, bearer: 200, login: 200 });
    expect(r.out).toMatch(/Mode: token aktif/);
    expect(r.err).not.toMatch(/AI_OFFICE_TOKEN_FILE \(/);
    expect(r.all).not.toContain(T);
  });

  it('AI_OFFICE_TOKEN (env) diutamakan atas file', async () => {
    const E = randomToken();
    const r = await runServer({ ...homeEnv(), AI_OFFICE_TOKEN: E, AI_OFFICE_TOKEN_FILE: '~/.ai-office/token' }, {
      onReady: async (port) => ({
        env: (await http(port, '/api/events', { headers: { Authorization: `Bearer ${E}` } })).status,
        file: (await http(port, '/api/events', { headers: { Authorization: `Bearer ${T}` } })).status,
      }),
    });
    expect(r.ready).toEqual({ env: 200, file: 401 });
  });

  it('file hilang di loopback → peringatan (path + alasan), jalan seperti tanpa token', async () => {
    const r = await runServer({ ...homeEnv(), AI_OFFICE_TOKEN_FILE: '~/tidak-ada.txt' }, {
      onReady: async (port) => (await http(port, '/api/session')).json.authRequired,
    });
    expect(r.ready).toBe(false);
    expect(r.out).toMatch(/Mode: lokal tanpa token/);
    expect(r.err).toMatch(/Peringatan: AI_OFFICE_TOKEN_FILE \(.*tidak-ada\.txt\) tidak ditemukan; server berjalan seperti tanpa token/);
  });

  it('file hilang + ALLOWED_HOSTS (mode terbuka) → peringatan lalu exit 1 (token kosong)', async () => {
    const r = await runServer({ ...homeEnv(), AI_OFFICE_TOKEN_FILE: '~/tidak-ada.txt', AI_OFFICE_ALLOWED_HOSTS: 'office.example.com' });
    expect(r.ready).toBeUndefined();
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/tidak ditemukan/);
    expect(r.err).toMatch(/Server tidak dijalankan: mode terbuka.*kosong/s);
  });

  it('file > 4 KB → peringatan tanpa isi file, tanpa token', async () => {
    // Start proses server bisa sangat lambat saat suite berjalan paralel: batas waktu longgar (isi tetap diuji).
    const r = await runServer({ ...homeEnv(), AI_OFFICE_TOKEN_FILE: '~/besar.txt' }, {
      onReady: async (port) => (await http(port, '/api/session')).json.authRequired,
      timeoutMs: 40000,
    });
    expect(r.ready).toBe(false);
    expect(r.err).toMatch(/lebih besar dari 4096 byte/);
    expect(r.all).not.toContain(SECRET);
  }, 60000);
});

describe('S1: proses server/index.js tetap hidup setelah pesan WebSocket bermasalah', () => {
  it.each(['lokal', 'token'])('mode %s: 5 KB → 1009, UTF-8 rusak → 1007, lalu /api/health 200 dan WebSocket baru tetap bisa', async (mode) => {
    const T = randomToken();
    const env = mode === 'token' ? { AI_OFFICE_TOKEN: T } : {};
    const headers = mode === 'token' ? { Authorization: `Bearer ${T}` } : {};
    const r = await runServer(env, {
      onReady: async (port) => {
        const codes = [];
        for (const data of ['x'.repeat(5000), Buffer.from([0xc3, 0x28])]) {
          const c = await wsConnect(port, { headers });
          if (c.status !== 101) return { error: `upgrade ${c.status}` };
          const closed = wsClosed(c.ws, 3000);
          c.ws.send(data, { binary: false });
          codes.push((await closed).code);
        }
        await sleep(200);
        const health = (await http(port, '/api/health')).status;
        const again = await wsConnect(port, { headers });
        again.ws?.close();
        return { codes, health, again: again.status };
      },
    });
    expect(r.ready).toEqual({ codes: [1009, 1007], health: 200, again: 101 });
    expect(r.out).toMatch(/\[ws\] koneksi ditutup karena error: WS_ERR_UNSUPPORTED_MESSAGE_LENGTH/);
    expect(r.out).toMatch(/\[ws\] koneksi ditutup karena error: WS_ERR_INVALID_UTF8/);
    expect(r.err).not.toMatch(/Unhandled|RangeError|Invalid WebSocket frame/);
  });
});
