// Regresi perbaikan keamanan putaran 3:
//   B1  server/auth.js bearerOf: header Authorization > 1024 ditolak, regex linear
//   B2  shared/hookMapping.js: pola JWT dengan lookbehind, prepareText memotong input bebas
//   B3  server/net.js requestPathname + server/app.js: target request selain origin-form polos → 400
//   Q1  shared/events.js stripControl: ANSI CSI/OSC dibuang utuh, zero-width/soft hyphen/tag dibuang
//   Info B (//[ tanpa [error]), Info C (looksLikePath/tokenFileLabel), Info D (Host lewat parseHostHeader)
//   tokenSource (a)-(d) dan perubahan perilaku yang disengaja.
// Server di dalam proses: port 0. server/index.js: port 3300-3399 (freePort). Hook: AI_OFFICE_URL selalu
// eksplisit (runHook). Port 3000 dan 3200 tidak pernah disentuh. Semua token di sini acak atau palsu.
// Batas waktu sengaja longgar (puluhan kali hasil ukur) supaya tidak flaky saat suite berjalan paralel;
// pola lama tetap jauh melewatinya (±200 ms per request B1, ±6 detik per 100 KB B2).
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_AUTH_HEADER_LENGTH, createAuth } from '../server/auth.js';
import { parseHostHeader, requestPathname } from '../server/net.js';
import { MAX_TOKEN_FILE_BYTES, decodeTokenBytes, looksLikePath, resolveToken, tokenFileLabel } from '../server/tokenSource.js';
import { normalizeEvent, stripControl } from '../shared/events.js';
import { REDACTED, mapHookToEvents, prepareText, redactSecrets } from '../shared/hookMapping.js';
import { SERVER_ENTRY, captureServer, cleanEnv, freePort, http, randomToken, runHook, runNode, startApp, wsConnect } from './helpers/testkit.js';

const TOKEN = randomToken();
const ESC = '\u001b';
const BS = String.fromCharCode(92); // "\" tunggal, ditulis eksplisit supaya tidak tertukar dengan escape string
const VPS = { allowedHosts: ['office.example.com'], token: TOKEN, trustProxy: true }; // konfigurasi di belakang Nginx
const PUB = ['Host: office.example.com', 'X-Forwarded-Proto: https'];
const BEARER_LINE = `Authorization: Bearer ${TOKEN}`;
const IS_WIN = process.platform === 'win32';

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aio-sec3-'));
  mkdirSync(join(dir, 'static'));
  writeFileSync(join(dir, 'static', 'index.html'), '<!doctype html><title>AI Office</title>');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------------------------------------ helper
/** Teks request HTTP/1.1 mentah (target dikirim persis apa adanya, termasuk "\" dan "*"). */
const reqText = (method, target, headers = [], body = '') =>
  [`${method} ${target} HTTP/1.1`, ...headers, 'Connection: close', `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n');
/** Teks handshake WebSocket mentah. */
const upgradeText = (target, headers = []) =>
  [`GET ${target} HTTP/1.1`, ...headers, 'Upgrade: websocket', 'Connection: Upgrade', 'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', ''].join('\r\n');

/** Body HTTP/1.1 ber-Transfer-Encoding: chunked → teks utuh. */
function dechunk(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const eol = s.indexOf('\r\n', i);
    if (eol < 0) break;
    const size = parseInt(s.slice(i, eol), 16);
    if (!(size > 0)) break;
    out += s.slice(eol + 2, eol + 2 + size);
    i = eol + 2 + size + 2;
  }
  return out;
}

/**
 * Kirim request mentah lewat TCP. Hasil: { status, head, body, ms } dengan `ms` = waktu dari tulis sampai
 * kepala respons lengkap diterima. `untilHead`: putus setelah kepala respons (untuk upgrade 101).
 */
function raw(port, text, { untilHead = false } = {}) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    let data = Buffer.alloc(0);
    let t0 = 0;
    let tHead = -1;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const s = data.toString('utf8');
      const end = s.indexOf('\r\n\r\n');
      const head = end < 0 ? s : s.slice(0, end);
      const rest = end < 0 ? '' : s.slice(end + 4);
      const body = /^transfer-encoding:\s*chunked/im.test(head) ? dechunk(rest) : rest;
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? NaN), head, body, ms: tHead < 0 ? Infinity : tHead - t0 });
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish();
    }, 5000);
    sock.on('error', () => {});
    sock.on('connect', () => {
      t0 = performance.now();
      sock.write(text);
    });
    sock.on('data', (d) => {
      data = Buffer.concat([data, d]);
      if (tHead < 0 && data.includes('\r\n\r\n')) {
        tHead = performance.now();
        if (untilHead) {
          sock.destroy();
          finish();
        }
      }
    });
    sock.on('close', finish);
  });
}

/** Jalankan `fn` n kali berurutan; hasil: median dan maksimum `ms`, dan himpunan status. */
async function timed(n, fn) {
  const rs = [];
  for (let i = 0; i < n; i++) rs.push(await fn());
  const ms = rs.map((r) => r.ms).sort((a, b) => a - b);
  return { median: ms[n >> 1], max: ms.at(-1), statuses: [...new Set(rs.map((r) => r.status))] };
}

/** Waktu eksekusi sinkron dalam ms. */
const msOf = (f) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

/**
 * Jalankan server/index.js (port 3300-3399); setelah "jalan di" muncul, `onReady(port)` dipanggil lalu
 * proses dimatikan. Proses yang menolak start selesai sendiri; batas keras 10 detik (runNode).
 */
async function runServer(env, onReady) {
  const port = await freePort();
  let ready;
  const r = await runNode([SERVER_ENTRY], {
    env: cleanEnv({ PORT: String(port), ...env }),
    timeoutMs: 10000,
    onStdout: (out, child) => {
      if (ready || !out.includes('jalan di')) return;
      ready = Promise.resolve()
        .then(() => onReady?.(port))
        .finally(() => child.kill());
    },
  });
  return { ...r, port, ready: ready ? await ready : undefined, all: r.out + r.err };
}

// ------------------------------------------------------------------------------------------- B1
describe('B1: bearerOf linear — header Authorization > 1024 karakter ditolak tanpa regex', () => {
  let s;
  beforeAll(async () => {
    s = await startApp(VPS);
    for (let i = 0; i < 3; i++) await raw(s.port, reqText('GET', '/api/session', PUB)); // pemanasan JIT/koneksi
  });
  afterAll(() => s.close());

  const EVIL = `Bearer a${' '.repeat(16000)}b`; // pola lama /^\s*Bearer\s+(.+?)\s*$/i: ±200 ms per request

  it('MAX_AUTH_HEADER_LENGTH = 1024', () => {
    expect(MAX_AUTH_HEADER_LENGTH).toBe(1024);
  });

  it.each([
    ['/api/session', 200, () => reqText('GET', '/api/session', [...PUB, `Authorization: ${EVIL}`])],
    ['/api/events', 401, () => reqText('GET', '/api/events', [...PUB, `Authorization: ${EVIL}`])],
    ['upgrade /ws', 401, () => upgradeText('/ws', [...PUB, `Authorization: ${EVIL}`])],
  ])('"Bearer a" + 16 000 spasi + "b" di %s → %i, median 5 request < 50 ms', async (_label, status, mk) => {
    const r = await timed(5, () => raw(s.port, mk(), { untilHead: true }));
    expect(r.statuses).toEqual([status]); // header sampai ke handler (bukan 431 dari parser)
    expect(r.median).toBeLessThan(50);
    expect(r.max).toBeLessThan(1000);
  });

  it('/api/session dengan header jahat: authenticated false (bukan error)', async () => {
    const r = await raw(s.port, reqText('GET', '/api/session', [...PUB, `Authorization: ${EVIL}`]));
    expect(JSON.parse(r.body)).toEqual({ ok: true, authRequired: true, authenticated: false });
  });

  it('auth.check di dalam proses: 20 × tiap header jahat < 100 ms total', () => {
    const auth = createAuth({ token: TOKEN, trustProxy: true });
    for (const h of [EVIL, `Bearer a${' \t'.repeat(8000)}b`, `Bearer ${'a '.repeat(8000)}`, `x${' '.repeat(16000)}Bearer x`, `Bearer ${'a'.repeat(16000)}`]) {
      const ms = msOf(() => {
        for (let i = 0; i < 20; i++) expect(auth.check({ headers: { authorization: h }, socket: {} }).ok).toBe(false);
      });
      expect(ms, JSON.stringify(h.slice(0, 12))).toBeLessThan(100);
    }
  });

  it('10 request jahat paralel tidak menahan event loop: /api/health tetap < 200 ms', async () => {
    const bad = Array.from({ length: 10 }, () => raw(s.port, reqText('GET', '/api/session', [...PUB, `Authorization: ${EVIL}`])));
    const health = await raw(s.port, reqText('GET', '/api/health', PUB));
    const res = await Promise.all(bad);
    expect(health.status).toBe(200);
    expect(health.ms).toBeLessThan(200);
    expect([...new Set(res.map((r) => r.status))]).toEqual([200]);
  });

  it.each([
    ['bearer   T  (huruf kecil, spasi ganda, spasi di akhir)', `bearer   ${TOKEN}  `],
    ['BEARER<tab>T', `BEARER\t${TOKEN}`],
    ['  Bearer T (spasi di awal)', `  Bearer ${TOKEN}`],
    ['<tab>Bearer <spasi><tab><spasi>T<tab>', `\tBearer \t ${TOKEN}\t`],
    ['tepat 1024 karakter (spasi di tengah)', `Bearer${' '.repeat(1024 - 6 - TOKEN.length)}${TOKEN}`],
  ])('Bearer sah tetap diterima: %s (unit, HTTP /api/events, upgrade /ws)', async (_label, value) => {
    expect(value.length).toBeLessThanOrEqual(1024);
    expect(createAuth({ token: TOKEN }).check({ headers: { authorization: value }, socket: {} }).ok).toBe(true);
    expect((await raw(s.port, reqText('GET', '/api/events', [...PUB, `Authorization: ${value}`]))).status).toBe(200);
    expect((await raw(s.port, upgradeText('/ws', [...PUB, `Authorization: ${value}`]), { untilHead: true })).status).toBe(101);
  });

  it.each([
    ['1025 karakter (spasi di tengah)', `Bearer${' '.repeat(1025 - 6 - TOKEN.length)}${TOKEN}`],
    ['token diikuti kata lain', `Bearer ${TOKEN} x`],
    ['"Bearer" saja', 'Bearer'],
    ['tanpa pemisah', `Bearer${TOKEN}`],
    ['skema Basic', `Basic ${TOKEN}`],
  ])('ditolak: %s → 401 (unit dan HTTP)', async (_label, value) => {
    expect(createAuth({ token: TOKEN }).check({ headers: { authorization: value }, socket: {} }).ok).toBe(false);
    expect((await raw(s.port, reqText('GET', '/api/events', [...PUB, `Authorization: ${value}`]))).status).toBe(401);
  });

  it('pemisah selain spasi/tab (NBSP U+00A0) tidak diterima (unit)', () => {
    expect(createAuth({ token: TOKEN }).check({ headers: { authorization: `Bearer\u00a0${TOKEN}` }, socket: {} }).ok).toBe(false);
  });

  const BIG = [
    ['Origin 8 KB', 403, 'GET', '/api/events', [...PUB, BEARER_LINE, `Origin: https://${'a.'.repeat(4096)}example`], ''],
    ['Host 8 KB', 403, 'GET', '/api/events', [`Host: ${'a.'.repeat(4096)}`, 'X-Forwarded-Proto: https', BEARER_LINE], ''],
    ['X-Real-IP 8 KB (login token benar, clientIp dipanggil)', 200, 'POST', '/api/login',
      [...PUB, `X-Real-IP: ${':'.repeat(8192)}`, 'Content-Type: application/json'], JSON.stringify({ token: TOKEN })],
    ['X-Forwarded-Proto 8 KB + Origin (requestScheme dipanggil)', 200, 'GET', '/api/events',
      ['Host: office.example.com', `X-Forwarded-Proto: ${'https,'.repeat(1365)}`, BEARER_LINE, 'Origin: https://office.example.com'], ''],
    ['Cookie 8 KB "aio_session=…;" berulang', 401, 'GET', '/api/events', [...PUB, `Cookie: ${'aio_session=v1.1.x; '.repeat(410)}`], ''],
    ['Cookie 8 KB spasi', 401, 'GET', '/api/events', [...PUB, `Cookie: a=${' '.repeat(8192)}b`], ''],
  ];
  it.each(BIG)('header besar: %s → %i, median 5 request < 50 ms', async (_label, status, method, path, headers, body) => {
    const r = await timed(5, () => raw(s.port, reqText(method, path, headers, body)));
    expect(r.statuses).toEqual([status]);
    expect(r.median).toBeLessThan(50);
    expect(r.max).toBeLessThan(1000);
  });

  it('token tidak muncul di log server', () => {
    expect(s.logs.join('\n')).not.toContain(TOKEN);
    expect(s.logs.filter((l) => l.startsWith('[error]'))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------- B2
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const JWT_TAIL = 'dozjgNryP4J3jVmNHl0w5N';

/** Jalur hook yang membawa teks bebas. `t` disisipkan di posisi yang relevan untuk tiap jalur. */
const PATHS = {
  'Agent.description': (t) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description: `pakai ${t}` } }),
  'Agent.prompt': (t) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', prompt: `pakai ${t}\nbaris lain` } }),
  'Bash.description': (t) => ({ hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'Bash', tool_input: { command: 'npm test', description: `cek ${t}` } }),
  'Bash.command': (t) => ({ hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'Bash', tool_input: { command: `${t} --help` } }),
  'Read.file_path': (t) => ({ hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'Read', tool_input: { file_path: `C:/x/${t}` } }),
  SubagentStop: (t) => ({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: `STATUS: SELESAI\nToken ${t} dipakai` }),
  'PostToolUse Agent': (t) => ({
    hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa' },
    tool_response: { content: [{ type: 'text', text: `STATUS: SELESAI\nToken ${t} dipakai` }] },
  }),
};
const messageOf = (payload) => {
  const evs = mapHookToEvents(payload);
  expect(evs).toHaveLength(1);
  return evs[0].message;
};

describe('B2: teks adversarial 100 KB selesai cepat (redactSecrets dan setiap jalur hook)', () => {
  const N = 100_000;
  const CASES = [
    ['"eyJ-" berulang (dulu 6 detik)', 'eyJ-'.repeat(N / 4)],
    ['"eyJ-x." berulang (JWT dua bagian)', 'eyJ-aaaaaaaaaa.'.repeat(N / 15)],
    ['" eyJ" + segmen 1 + "eyJ-" berulang', ` eyJaaaaaaaaaaaa.${'eyJ-'.repeat(N / 4)}`],
    ['ESC[ berulang', `${ESC}[`.repeat(N / 2)],
    ['ESC[ + 100 K digit tanpa akhir', `${ESC}[${'0'.repeat(N)}`],
    ['ESC] tanpa akhir berulang', `${ESC}]`.repeat(N / 2)],
    ['zero-width + "ghp_" berulang', '\u200b\u200e\ufeffghp_'.repeat(N / 7)],
  ];

  it.each(CASES)('redactSecrets(%s) < 500 ms', (_label, text) => {
    expect(text.length).toBeGreaterThanOrEqual(N - 20);
    expect(msOf(() => redactSecrets(text))).toBeLessThan(500);
  });

  it.each(CASES)('mapHookToEvents semua jalur (%s) < 500 ms per jalur', (_label, text) => {
    for (const [name, mk] of Object.entries(PATHS)) {
      const payload = mk(text);
      let evs;
      const ms = msOf(() => {
        evs = mapHookToEvents(payload);
      });
      expect(ms, name).toBeLessThan(500);
      expect(evs, name).toHaveLength(1);
    }
    const url = { hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'WebFetch', tool_input: { url: `https://${text}` } };
    expect(msOf(() => mapHookToEvents(url)), 'WebFetch.url').toBeLessThan(500);
  });

  it.each([
    ['awal teks', JWT],
    ['setelah spasi', `token ${JWT} ok`],
    ['dalam tanda kutip', `"${JWT}"`],
    ['setelah =', `jwt=${JWT}`],
    ['dalam kurung', `(${JWT})`],
    ['setelah /', `https://x.example/cb/${JWT}`],
    ['di query', `https://x.example/cb?id_token=${JWT}&x=1`],
    ['setelah Bearer', `Authorization: Bearer ${JWT}`],
  ])('JWT sah tetap tersensor: %s', (_label, text) => {
    const out = redactSecrets(text);
    expect(out).toContain(REDACTED);
    expect(out).not.toContain(JWT_TAIL);
  });

  it('JWT sah tersensor di setiap jalur hook (Bash.command: nama program > 40 karakter tidak ditampilkan sama sekali)', () => {
    for (const [name, mk] of Object.entries(PATHS)) {
      const msg = messageOf(mk(JWT));
      expect(msg, name).not.toContain(JWT_TAIL);
      if (name === 'Bash.command') expect(msg).toBe('Bash');
      else expect(msg, name).toContain(REDACTED);
    }
  });

  it('prepareText: dipotong ke `max`, "kata" terakhir yang terpotong dibuang; teks pendek tidak diubah', () => {
    expect(prepareText('halo dunia', 2000)).toBe('halo dunia');
    expect(prepareText('x'.repeat(2000), 2000)).toHaveLength(2000); // tepat batas: tidak dipotong
    expect(prepareText('x'.repeat(2001), 2000)).toBe(''); // satu kata > batas: dibuang seluruhnya
    expect(prepareText(`ab cd${'e'.repeat(10)}`, 8)).toBe('ab ');
    const long = 'kata '.repeat(10_000);
    const cut = prepareText(long, 8000);
    expect(cut.length).toBeLessThanOrEqual(8000);
    expect(cut.endsWith('kata ')).toBe(true);
    // Batas kerja 4 × max SEBELUM dibersihkan: isi setelahnya tidak pernah diproses.
    expect(prepareText(`${'\u200b'.repeat(4 * 2000)}ghp_${'A'.repeat(36)}`, 2000)).toBe('');
    // CR/CRLF/U+2028 → baris baru; tab/VT/FF → spasi (token tidak menempel ke kata di depannya).
    expect(prepareText(`a\r\nb\rc\u2028d\te\u000bf\u000cg`, 100)).toBe('a\nb\nc\nd e f g');
  });

  it('batas per jalur terlihat dari luar: description 2000, command 2000, prompt 8000, laporan 8000', () => {
    const agent = (ti) => messageOf({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', ...ti } });
    const bash = (ti) => messageOf({ hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'Bash', tool_input: ti });
    const stop = (m) => messageOf({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: m });
    // description: 2000 karakter masih dipakai (dipotong 200 untuk tampilan), 2001 → fallback
    expect(agent({ description: 'd'.repeat(2000) })).toBe(`${'d'.repeat(199)}…`);
    expect(agent({ description: 'd'.repeat(2001) })).toBe('Tugas untuk dev-qa');
    expect(bash({ command: 'npm test', description: 'd'.repeat(2000) })).toBe(`Bash · ${'d'.repeat(120 - 1 - 'Bash · '.length)}…`);
    expect(bash({ command: 'npm test', description: 'd'.repeat(2001) })).toBe('Bash · npm');
    // command: penugasan variabel panjang melewati 2000 karakter → nama program tidak terbaca (hanya "Bash")
    expect(bash({ command: `A=${'b'.repeat(1990)} npm test` })).toBe('Bash · npm');
    expect(bash({ command: `A=${'b'.repeat(2100)} npm test` })).toBe('Bash');
    // prompt: baris pertama 8000 karakter masih dipakai, 8001 → fallback
    expect(agent({ prompt: 'p'.repeat(8000) })).toBe(`${'p'.repeat(79)}…`);
    expect(agent({ prompt: 'p'.repeat(8001) })).toBe('Tugas untuk dev-qa');
    // laporan: setelah 8000 karakter, kata terpotong dibuang → hanya baris STATUS tersisa → fallback
    expect(stop(`STATUS: SELESAI\n${'r'.repeat(7000)}`)).toBe(`${'r'.repeat(179)}…`);
    expect(stop(`STATUS: SELESAI\n${'r'.repeat(8000)}`)).toBe('Tugas selesai');
  });

  it('proses hook dengan description 90 K "eyJ-" selesai jauh di bawah timeout hook 5 detik (< 3 detik), event sampai', async () => {
    const cap = await captureServer();
    try {
      const description = `Mulai ${'eyJ-'.repeat(22_500)}`;
      const r = await runHook({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description, prompt: 'x' } }, { AI_OFFICE_URL: cap.url });
      expect(r).toMatchObject({ code: 0, out: '', err: '', timedOut: false });
      expect(r.ms).toBeLessThan(3000);
      expect(cap.received).toHaveLength(1);
      expect(JSON.parse(cap.received[0].body)).toEqual([expect.objectContaining({ type: 'assign', to: 'dev-qa', message: 'Mulai' })]);
    } finally {
      await cap.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- B3 + Info B
describe('B3: requestPathname (unit)', () => {
  it.each([
    ['/api/events', '/api/events'],
    ['/x/../api/events', '/api/events'],
    ['/%2e%2e/api/events', '/api/events'],
    ['/api/events?a=%5c', '/api/events'], // %5c di query boleh
    ['/', '/'],
    [`/x${BS}..${BS}api/events`, null],
    [`/api${BS}events`, null],
    ['/api%5cevents', null],
    ['/api%5Cevents', null],
    ['/x/..%5Capi/events', null],
    [`/api/events?x=${BS}`, null], // "\" mentah di mana pun ditolak
    ['//evil.example/api/events', null],
    ['//[', null],
    ['http://office.example.com/api/events', null],
    ['*', null],
    ['', null],
    [undefined, null],
  ])('%j → %j', (url, want) => {
    expect(requestPathname(url)).toBe(want);
  });
});

describe.each([
  ['lokal', {}, ['Host: localhost']],
  ['VPS (token + allowedHosts + trustProxy)', VPS, [...PUB, BEARER_LINE]],
])('B3 + Info B (mode %s): target request ditolak 400 untuk HTTP dan upgrade', (_mode, opts, H) => {
  let s;
  beforeAll(async () => {
    s = await startApp({ ...opts, staticDir: join(dir, 'static') });
  });
  afterAll(() => s.close());

  it.each([
    ['GET', `/x${BS}..${BS}api/events`],
    ['GET', `/api${BS}events`],
    ['GET', '/api%5cevents'],
    ['GET', '/api%5Cevents'],
    ['GET', '/x/..%5Capi/events'],
    ['GET', `/api/events?x=${BS}`],
    ['GET', '//evil.example/api/events'],
    ['GET', 'http://office.example.com/api/events'],
    ['GET', '*'],
    ['OPTIONS', '*'], // perubahan perilaku yang disengaja
    ['GET', '//['],
    ['GET', '//[/api/events'],
    ['POST', `/api${BS}login`],
    ['POST', `/x/..${BS}api/login`],
  ])('HTTP %s %j → 400 "URL tidak valid"', async (method, target) => {
    const body = method === 'POST' ? JSON.stringify({ token: 'salah' }) : '';
    const r = await raw(s.port, reqText(method, target, [...H, ...(body ? ['Content-Type: application/json'] : [])], body));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'URL tidak valid' });
  });

  it.each([`/x${BS}..${BS}ws`, `/ws${BS}`, '/ws%5c', '/ws%5C', '//x/ws', '//[', 'http://office.example.com/ws'])(
    'upgrade %j → 400',
    async (target) => {
      expect((await raw(s.port, upgradeText(target, H), { untilHead: true })).status).toBe(400);
    },
  );

  it.each([
    ['/api/events', 200],
    ['/x/../api/events', 200],
    ['/%2e%2e/api/events', 200],
    ['/api/events?a=%5c', 200],
    ['/', 200],
  ])('tetap normal: HTTP GET %j → %i', async (target, status) => {
    expect((await raw(s.port, reqText('GET', target, H))).status).toBe(status);
  });

  it.each([
    ['/ws', 101],
    ['/x/../ws', 101],
    ['/ws?x=1', 101],
    ['/wsx', 403],
  ])('tetap normal: upgrade %j → %i', async (target, status) => {
    expect((await raw(s.port, upgradeText(target, H), { untilHead: true })).status).toBe(status);
  });

  it('Info B: tidak ada baris [error] (stack trace) di log setelah semua target di atas', () => {
    expect(s.logs.filter((l) => l.startsWith('[error]'))).toEqual([]);
  });
});

describe('B3: POST /api\\login (400) tidak menyentuh pembatas login', () => {
  it('12 × POST /api\\login token salah → 400; lalu /api/login token salah dari IP yang sama → 401 (bukan 429)', async () => {
    const s = await startApp(VPS);
    try {
      const headers = [...PUB, 'X-Real-IP: 203.0.113.9', 'Content-Type: application/json'];
      const body = JSON.stringify({ token: 'salah' });
      for (let i = 0; i < 12; i++) expect((await raw(s.port, reqText('POST', `/api${BS}login`, headers, body))).status).toBe(400);
      expect((await raw(s.port, reqText('POST', '/api/login', headers, body))).status).toBe(401);
      expect(s.logs.filter((l) => l.startsWith('[auth] login gagal'))).toEqual(['[auth] login gagal dari 203.0.113.9 (1/10)']);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- Q1
const SECRETS = [
  ['ghp_ (44 karakter)', `ghp_${'Fa1KeX9zQ7'.repeat(4)}`, 'Fa1KeX9zQ7'.repeat(4)],
  ['sk_live_ (32 karakter)', `sk_live_${'Zq8Wm3Rt5Y'.repeat(2)}abcd`, `${'Zq8Wm3Rt5Y'.repeat(2)}abcd`],
];
/** Rahasia dianggap bocor bila 12 karakter awal atau akhirnya terlihat (setelah karakter tak terlihat dan tanda baca dibuang). */
const leaked = (msg, secret) => {
  const flat = stripControl(msg).replace(/[^A-Za-z0-9]/g, '');
  return flat.includes(secret.slice(0, 12)) || flat.includes(secret.slice(-12));
};
const ins = (tok, c) => `${tok.slice(0, 2)}${c}${tok.slice(2, 10)}${c}${tok.slice(10)}`;
const Q1_VARIANTS = [
  ['ANSI SGR menempel (ESC[1m … ESC[0m)', (k) => `${ESC}[1m${k}${ESC}[0m`],
  ['ANSI 256 warna (ESC[38;5;196m)', (k) => `${ESC}[38;5;196m${k}${ESC}[0m`],
  ['ANSI di tengah token', (k) => `${k.slice(0, 12)}${ESC}[31m${k.slice(12)}`],
  ['ANSI reset tanpa parameter (ESC[m)', (k) => `${ESC}[m${k}`],
  ['OSC hyperlink diakhiri BEL', (k) => `${ESC}]8;;https://x.example/a\u0007${k}${ESC}]8;;\u0007`],
  ['OSC judul diakhiri ST (ESC \\)', (k) => `${ESC}]0;judul${ESC}${BS}${k}`],
  ['LRM U+200E', (k) => ins(k, '\u200e')],
  ['RLM U+200F', (k) => ins(k, '\u200f')],
  ['ZWSP U+200B', (k) => ins(k, '\u200b')],
  ['ZWNJ U+200C', (k) => ins(k, '\u200c')],
  ['ZWJ U+200D', (k) => ins(k, '\u200d')],
  ['WJ U+2060', (k) => ins(k, '\u2060')],
  ['operator tak terlihat U+2061-U+2064', (k) => ins(k, '\u2061\u2062\u2063\u2064')],
  ['BOM/ZWNBSP U+FEFF', (k) => ins(k, '\ufeff')],
  ['soft hyphen U+00AD', (k) => ins(k, '\u00ad')],
  ['RLO … PDF mengapit', (k) => `\u202e${k}\u202c`],
  ['RLO di tengah', (k) => ins(k, '\u202e')],
  ['karakter tag U+E0020 / U+E007F', (k) => ins(k, '\u{e0020}\u{e007f}')],
  ['NUL + BEL di tengah', (k) => ins(k, '\u0000\u0007')],
];

describe('Q1: token yang diselipi ANSI / bidi / zero-width tetap tersensor di setiap jalur hook', () => {
  it.each(Q1_VARIANTS)('%s', (_label, wrap) => {
    for (const [tokLabel, tok, secret] of SECRETS) {
      for (const [path, mk] of Object.entries(PATHS)) {
        const where = `${tokLabel} lewat ${path}`;
        const msg = messageOf(mk(wrap(tok)));
        expect(leaked(msg, secret), `${where}: ${JSON.stringify(msg)}`).toBe(false);
        // Bash.command menampilkan nama program saja dan hanya bila ≤ 40 karakter: ghp_ (44) tidak tampil sama sekali.
        if (path === 'Bash.command' && tok.length > 40) expect(msg, where).toBe('Bash');
        else expect(msg, where).toContain(REDACTED);
        expect(msg, where).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]|[\u{e0000}-\u{e007f}]/u);
      }
    }
  });

  it('kontrol: token tanpa sisipan juga tersensor di setiap jalur (matriks bukan lulus karena kebetulan)', () => {
    for (const [, tok, secret] of SECRETS) {
      for (const [path, mk] of Object.entries(PATHS)) expect(leaked(messageOf(mk(tok)), secret), path).toBe(false);
      expect(leaked(`pakai ${tok}`, secret)).toBe(true); // pendeteksi kebocoran sendiri bekerja
    }
  });

  it('stripControl: CSI/OSC dibuang utuh, tanpa sisa "[1m" / "]8;;"', () => {
    expect(stripControl(`${ESC}[1mtebal${ESC}[0m`)).toBe('tebal');
    expect(stripControl(`x${ESC}[38;5;196my`)).toBe('xy');
    expect(stripControl(`${ESC}[?25l${ESC}[2K${ESC}[1;31;4mmerah${ESC}[m`)).toBe('merah');
    expect(stripControl(`${ESC}]8;;https://x.example${ESC}${BS}tautan${ESC}]8;;${ESC}${BS}`)).toBe('tautan');
    expect(stripControl(`${ESC}]0;judul\u0007teks`)).toBe('teks');
    expect(stripControl('c\u001bd')).toBe('c'); // ESC + satu byte 0x30-0x7E (Fp/Fe/Fs): dibuang utuh (putaran 4)
  });

  it('stripControl: zero-width, soft hyphen, word joiner, BOM, U+180E, U+206A-U+206F, dan tag dibuang; teks biasa utuh', () => {
    const invisible = '\u00ad\u180e\u200b\u200c\u200d\u2060\u2061\u2062\u2063\u2064\u206a\u206f\ufeff\u{e0001}\u{e0020}\u{e007f}';
    expect(stripControl(`a${invisible}b`)).toBe('ab');
    const text = 'Halo dunia — 9/9 test lulus ✓ 日本語 العربية café';
    expect(stripControl(text)).toBe(text);
  });

  it('end-to-end: hook → server, token ber-ANSI dan ber-ZWJ tidak sampai ke riwayat maupun log server', async () => {
    const s = await startApp({ token: TOKEN, logMessages: true });
    try {
      const env = { AI_OFFICE_URL: `${s.base}/api/events`, AI_OFFICE_TOKEN: TOKEN };
      const [, ghp, ghpSecret] = SECRETS[0];
      const [, sk, skSecret] = SECRETS[1];
      const a = await runHook(PATHS['Agent.description'](`${ESC}[1m${ghp}${ESC}[0m`), env);
      const b = await runHook(PATHS['PostToolUse Agent'](ins(sk, '\u200d')), env);
      expect([a.code, b.code]).toEqual([0, 0]);
      expect(s.app.history).toHaveLength(2);
      const all = `${JSON.stringify(s.app.history)}\n${s.logs.join('\n')}`;
      expect(leaked(all, ghpSecret)).toBe(false);
      expect(leaked(all, skSecret)).toBe(false);
      expect(s.app.history.map((e) => e.message)).toEqual([`pakai ${REDACTED}`, `Token ${REDACTED} dipakai`]);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- Info C
describe('Info C: nilai AI_OFFICE_TOKEN_FILE hanya dicetak bila jelas sebuah path', () => {
  const TOKENISH = [
    ['token base64url 43 karakter', TOKEN],
    ['token base64 dengan "/" "+" "="', 'abc/DEF+ghi/jkl012345678901234567890='],
  ];

  it.each([
    ['~/.ai-office/token', true],
    ['~', true],
    ['/etc/ai-office/token', true],
    ['C:\\Users\\ceo\\token.txt', true],
    ['./token', true],
    [TOKEN, false],
    ['abc/DEF+ghi/jkl012345678901234567890=', false],
    ['token.txt', false], // tanpa "/" atau "\": tidak dianggap path (aman: tidak dicetak)
    ['', false],
  ])('looksLikePath(%j) → %s', (value, want) => {
    expect(looksLikePath(value)).toBe(want);
  });

  it('tokenFileLabel: path wajar dicetak, nilai berbentuk token tidak', () => {
    expect(tokenFileLabel('/etc/ai-office/token', '/etc/ai-office/token')).toBe('AI_OFFICE_TOKEN_FILE (/etc/ai-office/token)');
    const win = `C:${BS}Users${BS}ceo${BS}token.txt`;
    expect(tokenFileLabel(win, win)).toBe(`AI_OFFICE_TOKEN_FILE (${win})`);
    for (const [, v] of TOKENISH) {
      const label = tokenFileLabel(v, v);
      expect(label).not.toContain(v);
      expect(label).toMatch(/nilainya tidak ditampilkan/);
    }
  });

  it.each(TOKENISH)('server/index.js: %s di AI_OFFICE_TOKEN_FILE tidak tercetak (stdout/stderr → journald)', async (_label, value) => {
    const r = await runServer({ AI_OFFICE_TOKEN_FILE: value }, async (port) => (await http(port, '/api/session')).json);
    expect(r.ready).toEqual({ ok: true, authRequired: false, authenticated: true }); // seperti tanpa token
    expect(r.all).toMatch(/AI_OFFICE_TOKEN_FILE \(nilainya tidak ditampilkan karena tidak berbentuk path/);
    expect(r.all).not.toContain(value);
  });

  it.each(TOKENISH)('hook DEBUG=1: %s di AI_OFFICE_TOKEN_FILE tidak tercetak di stderr', async (_label, value) => {
    const cap = await captureServer();
    try {
      const r = await runHook({ hook_event_name: 'SubagentStart', agent_type: 'dev-qa' }, { AI_OFFICE_URL: cap.url, AI_OFFICE_TOKEN_FILE: value, AI_OFFICE_DEBUG: '1' });
      expect(r).toMatchObject({ code: 0, out: '' });
      expect(r.err).toMatch(/nilainya tidak ditampilkan.*; lanjut tanpa token/);
      expect(r.err).not.toContain(value);
      expect(cap.received).toHaveLength(1); // tetap terkirim (tanpa Authorization)
      expect(cap.received[0].headers.authorization).toBeUndefined();
    } finally {
      await cap.close();
    }
  });

  it('server/index.js: path "~/.ai-office/token" yang hilang tetap dicetak (diperluas ke home)', async () => {
    const home = mkdtempSync(join(dir, 'home-'));
    const r = await runServer({ USERPROFILE: home, HOME: home, AI_OFFICE_TOKEN_FILE: '~/.ai-office/token' }, async () => true);
    expect(r.ready).toBe(true);
    expect(r.all).toContain(`AI_OFFICE_TOKEN_FILE (${join(home, '.ai-office', 'token')}) tidak ditemukan; server berjalan seperti tanpa token.`);
  });

  it('hook DEBUG=1: path absolut yang hilang tetap dicetak', async () => {
    const cap = await captureServer();
    try {
      const p = join(dir, 'tidak-ada.txt');
      const r = await runHook({ hook_event_name: 'SubagentStart', agent_type: 'dev-qa' }, { AI_OFFICE_URL: cap.url, AI_OFFICE_TOKEN_FILE: p, AI_OFFICE_DEBUG: '1' });
      expect(r.err).toContain(`AI_OFFICE_TOKEN_FILE (${p}) tidak ditemukan; lanjut tanpa token.`);
    } finally {
      await cap.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- Info D
describe('Info D: header Host divalidasi ketat (parseHostHeader) di hostAllowed', () => {
  it('parseHostHeader menolak userinfo, path, dan fragmen yang diterima parser URL longgar', () => {
    for (const h of ['evil@office.example.com', 'office.example.com/x', 'office.example.com:443@evil.example', 'evil@localhost', 'localhost/x', 'office.example.com#x']) {
      expect(parseHostHeader(h), h).toBeNull();
    }
    expect(parseHostHeader('OFFICE.EXAMPLE.COM:443')).toEqual({ hostname: 'office.example.com', port: '443', host: 'office.example.com:443' });
  });

  it('allowedHosts office.example.com: Host longgar → 403 (HTTP dan WebSocket), Host sah → 200/101', async () => {
    const s = await startApp(VPS);
    try {
      const auth = { Authorization: `Bearer ${TOKEN}`, 'X-Forwarded-Proto': 'https' };
      for (const [host, status] of [
        ['evil@office.example.com', 403],
        ['office.example.com/x', 403],
        ['office.example.com:443@evil.example', 403],
        ['evil@localhost', 403],
        ['office.example.com', 200],
        ['OFFICE.EXAMPLE.COM:443', 200],
        [`localhost:${s.port}`, 200],
        [`[::1]:${s.port}`, 200],
      ]) {
        const r = await http(s.port, '/api/events', { headers: { ...auth, Host: host } });
        expect(r.status, host).toBe(status);
        if (status === 403) expect(r.json, host).toEqual({ ok: false, error: 'Host tidak diizinkan' });
        const ws = await wsConnect(s.port, { headers: { ...auth, Host: host } });
        expect(ws.status, `ws ${host}`).toBe(status === 200 ? 101 : 403);
        ws.ws?.close();
      }
    } finally {
      await s.close();
    }
  });

  it('mode lokal (loopback, tanpa daftar): "evil@localhost" dan "localhost/x" → 403; localhost/[::1] dengan port → 200', async () => {
    const s = await startApp();
    try {
      for (const [host, status] of [
        ['evil@localhost', 403],
        ['localhost/x', 403],
        ['evil.example@127.0.0.1', 403],
        [`localhost:${s.port}`, 200],
        [`[::1]:${s.port}`, 200],
      ]) {
        expect((await http(s.port, '/api/health', { headers: { Host: host } })).status, host).toBe(status);
      }
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- tokenSource
describe('tokenSource: encoding, satu baris, ukuran, dan sumber di pesan', () => {
  let tdir;
  const file = (name, content) => {
    const p = join(tdir, name);
    writeFileSync(p, content);
    return p;
  };
  /** Byte persis seperti `'<token>' > file` di Windows PowerShell 5.1: BOM ff fe, UTF-16LE, CRLF. */
  const ps51Bytes = (t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${t}\r\n`, 'utf16le')]);
  const ENCODED = [
    ['UTF-16 LE + BOM (PowerShell 5.1 ">")', () => ps51Bytes(TOKEN)],
    ['UTF-16 BE + BOM', () => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(`${TOKEN}\r\n`, 'utf16le').swap16()])],
    ['UTF-8 + BOM', () => Buffer.from(`\ufeff${TOKEN}\n`, 'utf8')],
  ];
  beforeAll(() => {
    tdir = mkdtempSync(join(dir, 'tok-'));
  });

  it('ps51Bytes: diawali ff fe, CRLF di akhir (UTF-16LE)', () => {
    const b = ps51Bytes('ab');
    expect(b.toString('hex')).toBe('fffe610062000d000a00');
  });

  it.runIf(IS_WIN)('[Windows] byte buatan identik dengan hasil asli `>` di powershell.exe 5.1', async () => {
    const p = join(tdir, 'ps51-asli.txt');
    const out = await new Promise((resolve, reject) => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `'${TOKEN}' > '${p}'; $PSVersionTable.PSVersion.Major`], { timeout: 12000, windowsHide: true }, (e, stdout) => (e ? reject(e) : resolve(stdout)));
    });
    expect(out.trim()).toBe('5');
    expect(readFileSync(p).equals(ps51Bytes(TOKEN))).toBe(true);
    expect(resolveToken({ tokenFile: p })).toEqual({ token: TOKEN, source: 'file', file: p });
  }, 15000);

  it.each(ENCODED)('(b) %s → token benar (resolveToken, decodeTokenBytes)', (_label, bytes) => {
    const b = bytes();
    expect(decodeTokenBytes(b).trim()).toBe(TOKEN);
    const p = file(`enc-${b[0].toString(16)}-${b[1].toString(16)}`, b);
    expect(resolveToken({ tokenFile: p })).toEqual({ token: TOKEN, source: 'file', file: p });
  });

  it.each(ENCODED)('(b) end-to-end server/index.js: %s → Bearer 200, tanpa token 401, token tidak tercetak', async (label, bytes) => {
    const p = file(`srv-${label.replace(/\W+/g, '-')}`, bytes());
    const r = await runServer({ AI_OFFICE_TOKEN_FILE: p }, async (port) => ({
      none: (await http(port, '/api/events')).status,
      bearer: (await http(port, '/api/events', { headers: { Authorization: `Bearer ${TOKEN}` } })).status,
    }));
    expect(r.ready).toEqual({ none: 401, bearer: 200 });
    expect(r.out).toMatch(/Mode: token aktif/);
    expect(r.all).not.toMatch(/Peringatan: AI_OFFICE_TOKEN_FILE/);
    expect(r.all).not.toContain(TOKEN);
  });

  it.each(ENCODED)('(b) end-to-end hook: %s → event sampai di server mode token', async (label, bytes) => {
    const p = file(`hook-${label.replace(/\W+/g, '-')}`, bytes());
    const s = await startApp({ token: TOKEN });
    try {
      const r = await runHook({ hook_event_name: 'SubagentStart', agent_type: 'dev-qa' }, { AI_OFFICE_URL: `${s.base}/api/events`, AI_OFFICE_TOKEN_FILE: p, AI_OFFICE_DEBUG: '1' });
      expect(r).toMatchObject({ code: 0, out: '', err: '' });
      expect(s.app.history).toEqual([expect.objectContaining({ type: 'working', from: 'dev-qa', source: 'hook' })]);
    } finally {
      await s.close();
    }
  });

  it.each([
    ['LF', `${TOKEN}\nbaris-kedua-rahasia\n`],
    ['CR saja', `${TOKEN}\rbaris-kedua-rahasia`],
    ['CRLF', `${TOKEN}\r\nbaris-kedua-rahasia\r\n`],
    ['UTF-16 LE + BOM', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${TOKEN}\r\nbaris-kedua-rahasia\r\n`, 'utf16le')])],
  ])('(c) dua baris berisi (%s) → ditolak "satu baris", isi file tidak ada di pesan', (_label, content) => {
    const p = file(`dua-${Math.random().toString(36).slice(2)}`, content);
    const r = resolveToken({ tokenFile: p });
    expect(r).toEqual({ token: '', source: 'file', file: p, problem: 'tidak valid: file token harus berisi satu baris (ada 2 baris berisi)' });
    expect(JSON.stringify(r)).not.toContain('baris-kedua-rahasia');
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });

  it('(c) baris kosong / spasi di awal dan akhir boleh', () => {
    for (const content of [`\n\n${TOKEN}\n`, `${TOKEN}\n\n  \r\n`, `\r\n \t \r\n${TOKEN}\r\n\r\n`, `\r\r${TOKEN}\r`]) {
      expect(resolveToken({ tokenFile: file(`kosong-${Math.random().toString(36).slice(2)}`, content) }).token, JSON.stringify(content)).toBe(TOKEN);
    }
  });

  it('NUL (UTF-16 LE/BE tanpa BOM) → ditolak dengan petunjuk encoding, isi tidak ada di pesan', () => {
    for (const b of [Buffer.from(`${TOKEN}\r\n`, 'utf16le'), Buffer.from(`${TOKEN}\r\n`, 'utf16le').swap16()]) {
      const p = file(`nul-${b[0]}`, b);
      const r = resolveToken({ tokenFile: p });
      expect(r).toEqual({ token: '', source: 'file', file: p, problem: 'berisi karakter NUL; simpan sebagai UTF-8 (atau UTF-16 dengan BOM)' });
    }
  });

  it('(a) folder → "bukan file biasa"', () => {
    expect(resolveToken({ tokenFile: tdir })).toMatchObject({ token: '', source: 'file', problem: 'bukan file biasa' });
  });

  it(`(a) batas ${MAX_TOKEN_FILE_BYTES} byte: 4096 diterima, 4097 ditolak (UTF-8 dan UTF-16 + BOM)`, () => {
    expect(MAX_TOKEN_FILE_BYTES).toBe(4096);
    expect(resolveToken({ tokenFile: file('pas-4096', 'a'.repeat(4096)) }).token).toHaveLength(4096);
    expect(resolveToken({ tokenFile: file('lebih-4097', 'a'.repeat(4097)) }).problem).toBe('lebih besar dari 4096 byte');
    const u16 = (chars) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('b'.repeat(chars), 'utf16le')]);
    expect(resolveToken({ tokenFile: file('u16-4096', u16(2047)) }).token).toHaveLength(2047); // 2 + 4094 byte
    expect(resolveToken({ tokenFile: file('u16-4098', u16(2048)) }).problem).toBe('lebih besar dari 4096 byte');
  });

  it.each([
    ['env (AI_OFFICE_TOKEN)', () => ({ AI_OFFICE_TOKEN: 'abc def' }), () => /AI Office hook: AI_OFFICE_TOKEN berisi spasi atau karakter tidak valid; event tidak dikirim\./],
    ['file (AI_OFFICE_TOKEN_FILE)', (p) => ({ AI_OFFICE_TOKEN_FILE: p }), (p) => new RegExp(`AI Office hook: token dari AI_OFFICE_TOKEN_FILE \\(${p.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}\\) berisi spasi`)],
  ])('(d) token berspasi dari %s: pesan hook menyebut sumbernya, event tidak dikirim, token tidak tercetak', async (_label, envOf, reOf) => {
    // Nama file tetap (bukan acak): sejak putaran 4 (N6), segmen path ≥ 16 karakter yang tampak acak
    // (mis. "spasi-2z3h5c7nhdt.txt") sengaja tidak dicetak, sehingga nama acak membuat test ini flaky (±20%).
    const p = file(`spasi-${_label.startsWith('env') ? 'env' : 'file'}.txt`, 'abc def\n');
    const cap = await captureServer();
    try {
      const r = await runHook({ hook_event_name: 'SubagentStart', agent_type: 'dev-qa' }, { AI_OFFICE_URL: cap.url, AI_OFFICE_DEBUG: '1', ...envOf(p) });
      expect(r).toMatchObject({ code: 0, out: '' });
      expect(r.err).toMatch(reOf(p));
      expect(r.err).not.toContain('abc def');
      expect(cap.received).toHaveLength(0);
    } finally {
      await cap.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- perubahan perilaku
describe('Perubahan perilaku yang disengaja', () => {
  it('OPTIONS * → 400 (lihat juga B3)', async () => {
    const s = await startApp();
    try {
      const r = await raw(s.port, reqText('OPTIONS', '*', ['Host: localhost']));
      expect(r.status).toBe(400);
      expect(s.logs.filter((l) => l.startsWith('[error]'))).toEqual([]);
    } finally {
      await s.close();
    }
  });

  it.each([
    ['kosong setelah dibersihkan (hanya ZWJ/ZWSP/ANSI)', `\u200d\u200b${ESC}[0m\u00ad`],
    ['satu kata > 2000 karakter', 'k'.repeat(2001)],
  ])('description %s → fallback', (_label, description) => {
    const agent = (extra) => mapHookToEvents({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description, ...extra } })[0].message;
    expect(agent({})).toBe('Tugas untuk dev-qa');
    expect(agent({ prompt: 'Baris pertama prompt\nlain' })).toBe('Baris pertama prompt');
    const bash = mapHookToEvents({ hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'Bash', tool_input: { command: 'FOO=rahasia npx vitest run', description } })[0];
    expect(bash.message).toBe('Bash · npx');
  });

  it('ZWJ dibuang: urutan emoji ZWJ menjadi emoji terpisah (server dan hook)', () => {
    expect(normalizeEvent({ type: 'done', from: 'a', to: 'b', message: 'tim 👨\u200d👩\u200d👧 siap' }).event.message).toBe('tim 👨👩👧 siap');
    const hook = mapHookToEvents({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description: 'a\u200db' } });
    expect(hook[0].message).toBe('ab');
  });
});
