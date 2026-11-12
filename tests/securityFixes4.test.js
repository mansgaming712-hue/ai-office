// Regresi perbaikan keamanan putaran 4:
//   N1  server/net.js requestPathname: "//" di mana pun dan %2f/%2F/%5c di bagian path → 400 (HTTP + upgrade),
//       termasuk POST /api//../login yang tidak menyentuh pembatas login
//   P2  shared/events.js: Fp/Fe/Fs (ESC + 1 byte) dan CSI 8-bit dibuang utuh; prepareText menyensor token
//       yang huruf pertamanya "termakan" urutan escape (ESC[, ESC(B ESC[m, ESC7, U+009B 1m, ESC[1 + sk-, ...)
//   P3  karakter tak terlihat baru dibuang (U+034F, pengisi Hangul, Khmer, Mongol FVS, VS, Braille kosong, ...)
//   N2a prefiks token khas tersensor walau menempel ke kata (Token<ZWSP>ghp_…, Tokenghp_…)
//   N2b JWT setelah "x-", "-", "a_", "x"
//   N4  /^ringkasan\s*:?$/i linear (dulu kuadratik)
//   N5  nilai rahasia bertanda kutip yang terpotong batas prepareText tidak bocor
//   Linear: pola redaksi dan mapHookToEvents pada input adversarial 100 KB
//   N6  looksLikePath + server/index.js tidak mencetak nilai acak di AI_OFFICE_TOKEN_FILE / AI_OFFICE_TRUST_PROXY
//   N7  token tidak sah (surrogate tunggal, U+2028, byte 0xff, spasi) → invalid: server exit 1, hook tidak kirim
// Server di dalam proses: port 0. server/index.js: port 3300-3399 (freePort). Hook: AI_OFFICE_URL selalu
// eksplisit (runHook). Port 3000 tidak pernah disentuh. Semua token di sini acak atau palsu.
// Batas waktu sengaja longgar (belasan kali hasil ukur) supaya tidak flaky saat suite berjalan paralel.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { safeEqual } from '../server/auth.js';
import { requestPathname } from '../server/net.js';
import { INVALID_TOKEN, looksLikePath, resolveToken, tokenFileLabel } from '../server/tokenSource.js';
import { normalizeEvent, stripControl } from '../shared/events.js';
import { REDACTED, mapHookToEvents, prepareText, redactSecrets, summarize } from '../shared/hookMapping.js';
import { ROOT, SERVER_ENTRY, captureServer, cleanEnv, freePort, glue, http, randomToken, runHook, runNode, startApp } from './helpers/testkit.js';

const TOKEN = randomToken();
const E = '\u001b';
const BS = String.fromCharCode(92); // "\" tunggal
const ST = `${E}${BS}`; // ESC \ (string terminator)
const VPS = { allowedHosts: ['office.example.com'], token: TOKEN, trustProxy: true };
const PUB = ['Host: office.example.com', 'X-Forwarded-Proto: https'];
const BEARER_LINE = `Authorization: Bearer ${TOKEN}`;
const FORBIDDEN_IN_MESSAGE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\u2800\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{1d173}-\u{1d17a}\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/u;

let dir;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'aio-sec4-'));
  mkdirSync(join(dir, 'static', 'assets'), { recursive: true });
  writeFileSync(join(dir, 'static', 'index.html'), '<!doctype html><title>AI Office</title>');
  writeFileSync(join(dir, 'static', 'assets', 'app-abc123.js'), 'console.log(1);');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// ------------------------------------------------------------------------------------------ helper
const reqText = (method, target, headers = [], body = '') =>
  [`${method} ${target} HTTP/1.1`, ...headers, 'Connection: close', `Content-Length: ${Buffer.byteLength(body)}`, '', body].join('\r\n');
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

/** Request mentah lewat TCP (target dikirim apa adanya). `untilHead`: putus setelah kepala respons. */
function raw(port, text, { untilHead = false } = {}) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    let data = '';
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const end = data.indexOf('\r\n\r\n');
      const head = end < 0 ? data : data.slice(0, end);
      const rest = end < 0 ? '' : data.slice(end + 4);
      const body = /^transfer-encoding:\s*chunked/im.test(head) ? dechunk(rest) : rest;
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? NaN), head, body });
    };
    const timer = setTimeout(() => {
      sock.destroy();
      finish();
    }, 5000);
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('connect', () => sock.write(text));
    sock.on('data', (d) => {
      data += d;
      if (untilHead && data.includes('\r\n\r\n')) {
        sock.destroy();
        finish();
      }
    });
    sock.on('close', finish);
  });
}

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

/** Jalur hook yang membawa teks bebas (sama dengan securityFixes3). */
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

/** Token palsu: [label, prefiks, ekor rahasia]. */
const TOKENS = [
  ['ghp_', 'ghp_', 'Fa1KeX9zQ7Fa1KeX9zQ7Fa1KeX9zQ7Fa1KeX9zQ7'],
  ['sk-ant', 'sk-ant-api03-', 'q1w2e3r4t5y6u7i8o9p0asdfghjkl'],
  ['sk_live_', 'sk_live_', 'Zq8Wm3Rt5YZq8Wm3Rt5Yabcd'],
  ['JWT', 'eyJ', 'hbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'],
];
const JWT = TOKENS[3][1] + TOKENS[3][2];

/** Bocor = 10 karakter alfanumerik berurutan dari ekor rahasia tampil (setelah stripControl, tanda baca dibuang). */
function leaked(msg, tail) {
  const flat = stripControl(msg).replace(/[^A-Za-z0-9]/g, '');
  const t = tail.replace(/[^A-Za-z0-9]/g, '');
  for (let i = 0; i + 10 <= t.length; i++) if (flat.includes(t.slice(i, i + 10))) return true;
  return false;
}

/** Periksa satu teks (berisi token) di setiap jalur hook: tidak bocor, tersensor, tanpa karakter kontrol/tak terlihat. */
function expectHiddenEverywhere(text, tail, where) {
  for (const [path, mk] of Object.entries(PATHS)) {
    const msg = messageOf(mk(text));
    const at = `${where} lewat ${path}: ${JSON.stringify(msg)}`;
    expect(leaked(msg, tail), at).toBe(false);
    // Bash.command hanya menampilkan nama program (kata pertama ≤ 40 karakter, penugasan variabel dilewati),
    // jadi di sana cukup "tidak bocor"; jalur lain wajib menampilkan penanda sensor.
    if (path !== 'Bash.command') expect(msg, at).toContain(REDACTED);
    expect(msg, at).not.toMatch(FORBIDDEN_IN_MESSAGE);
  }
}

// ------------------------------------------------------------------------------------------- N1
const REJECTED_HTTP = [
  ['GET', '/api//../events'],
  ['GET', '/api/x//../../events'],
  ['GET', '/api//events'],
  ['GET', '/a%2fb/../api/events'],
  ['GET', '/a%2Fb/../api/events'],
  ['GET', '/api/..%2fz/../events'],
  ['GET', '/api/%2e%2e%2fz/../events'],
  ['GET', '/api%2fevents'],
  ['GET', '/api/events%2F'],
  ['GET', '/api%5cevents'],
  ['GET', '/assets/..%2f..%2fpackage.json'],
  ['GET', '/api//../events?since=1'],
  ['POST', '/api//../login'],
  ['POST', '/a%2fb/../api/login'],
  ['POST', '/api/x//../../login'],
];
const REJECTED_UPGRADE = ['/x//../ws', '//ws', '/a%2fb/../ws', '/a%2Fb/../ws', '/ws%2f', '/ws%5c', '/x//../ws?x=1'];

describe('N1: requestPathname (unit) — "//" di mana pun dan %2f/%2F/%5c di bagian path → null', () => {
  it.each([...REJECTED_HTTP.map(([, t]) => t), ...REJECTED_UPGRADE, '/a//b', '/x//', '//', '/api/events//?since=1'])('%j → null', (url) => {
    expect(requestPathname(url)).toBeNull();
  });

  it.each([
    ['/', '/'],
    ['/index.html', '/index.html'],
    ['/assets/app-abc123.js', '/assets/app-abc123.js'],
    ['/api/events?since=1', '/api/events'],
    ['/ws?x=1', '/ws'],
    ['/x/../api/events', '/api/events'],
    ['/api/events?next=//x', '/api/events'], // "//" di query boleh
    ['/api/events?a=%2f', '/api/events'], // %2f di query boleh
    ['/api/events#%2f//', '/api/events'], // ...begitu juga di fragmen
    ['/x/', '/x/'], // satu "/" di akhir bukan "//"
  ])('jalur sah %j → %j', (url, want) => {
    expect(requestPathname(url)).toBe(want);
  });

  it('fuzz model Nginx (merge_slashes, dekode %XX, resolusi ".."): tidak ada target yang dilayani Node sebagai endpoint dengan zona Nginx berbeda', () => {
    // Model $uri Nginx disederhanakan (dari skrip bukti backend): %XX didekode sekali (%25/%23/%3f literal),
    // "//" digabung, "." dan ".." diselesaikan, naik di atas root = ditolak 400.
    const nginxUri = (target) => {
      const p = target.split(/[?#]/)[0];
      let dec = '';
      for (let i = 0; i < p.length; i++) {
        if (p[i] === '%' && /^[0-9a-f]{2}$/i.test(p.slice(i + 1, i + 3))) {
          const c = String.fromCharCode(parseInt(p.slice(i + 1, i + 3), 16));
          dec += c === '%' || c === '#' || c === '?' ? '\u0001' : c;
          i += 2;
        } else dec += p[i];
      }
      const segs = dec.split('/').slice(1).filter((s, idx, a) => s !== '' || idx === a.length - 1);
      const out = [];
      for (const s of segs) {
        if (s === '.') continue;
        if (s === '..') {
          if (!out.length) return null;
          out.pop();
          continue;
        }
        out.push(s);
      }
      return `/${out.join('/')}`;
    };
    const zone = (u) => (u === null ? '400' : u === '/api/login' ? 'login' : u === '/ws' ? 'ws' : u.startsWith('/api/') ? 'api' : 'none');
    const nodeZone = (p) => (p === '/api/login' ? 'login' : p === '/ws' ? 'ws' : ['/api/events', '/api/session', '/api/logout', '/api/health'].includes(p) ? 'api' : 'none');
    const parts = ['api', 'events', 'login', 'ws', 'x', '.', '..', '%2e', '%2E%2e', '', '%2f', 'a%2fb', '%2F..', '..%2fz', '%5c', ';', '%3f', '%61pi'];
    const bad = [];
    let n = 0;
    const walk = (depth, acc) => {
      if (acc.length) {
        n++;
        const url = `/${acc.join('/')}`;
        const p = requestPathname(url);
        if (p !== null) {
          const nz = nodeZone(p);
          const ng = zone(nginxUri(url));
          if (nz !== 'none' && ng !== '400' && ng !== nz) bad.push(`${url} → Node ${p} / Nginx ${nginxUri(url)}`);
        }
      }
      if (depth > 0) for (const part of parts) walk(depth - 1, [...acc, part]);
    };
    walk(4, []);
    expect(n).toBeGreaterThan(100_000);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe.each([
  ['lokal', {}, ['Host: localhost']],
  ['VPS (token + allowedHosts + trustProxy)', VPS, [...PUB, BEARER_LINE]],
])('N1 (mode %s): HTTP dan upgrade ditolak 400, jalur sah tetap normal', (_mode, opts, H) => {
  let s;
  beforeAll(async () => {
    s = await startApp({ ...opts, staticDir: join(dir, 'static') });
  });
  afterAll(() => s.close());

  it.each(REJECTED_HTTP)('HTTP %s %j → 400 "URL tidak valid"', async (method, target) => {
    const body = method === 'POST' ? JSON.stringify({ token: 'salah' }) : '';
    const r = await raw(s.port, reqText(method, target, [...H, ...(body ? ['Content-Type: application/json'] : [])], body));
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body)).toEqual({ ok: false, error: 'URL tidak valid' });
  });

  it.each(REJECTED_UPGRADE)('upgrade %j → 400', async (target) => {
    expect((await raw(s.port, upgradeText(target, H), { untilHead: true })).status).toBe(400);
  });

  it.each([
    ['/', 200],
    ['/assets/app-abc123.js', 200],
    ['/api/events?since=1', 200],
    ['/x/../api/events', 200],
    ['/api/health', 200],
  ])('tetap normal: HTTP GET %j → %i', async (target, status) => {
    expect((await raw(s.port, reqText('GET', target, H))).status).toBe(status);
  });

  it.each([
    ['/ws', 101],
    ['/ws?x=1', 101],
    ['/x/../ws', 101],
  ])('tetap normal: upgrade %j → %i', async (target, status) => {
    expect((await raw(s.port, upgradeText(target, H), { untilHead: true })).status).toBe(status);
  });

  it('tidak ada baris [error] (stack trace) di log setelah semua target di atas', () => {
    expect(s.logs.filter((l) => l.startsWith('[error]'))).toEqual([]);
  });
});

describe('N1: POST /api//../login (400) tidak menyentuh pembatas login', () => {
  it('12 × POST /api//../login token salah → 400, tanpa log login gagal; lalu /api/login token salah dari IP yang sama → 401 (1/10, bukan 429)', async () => {
    const s = await startApp(VPS);
    try {
      const headers = [...PUB, 'X-Real-IP: 203.0.113.10', 'Content-Type: application/json'];
      const body = JSON.stringify({ token: 'salah' });
      const statuses = [];
      for (let i = 0; i < 12; i++) statuses.push((await raw(s.port, reqText('POST', '/api//../login', headers, body))).status);
      expect(statuses).toEqual(Array(12).fill(400));
      expect(s.logs.filter((l) => l.startsWith('[auth] login gagal'))).toEqual([]);
      expect((await raw(s.port, reqText('POST', '/api/login', headers, body))).status).toBe(401);
      expect(s.logs.filter((l) => l.startsWith('[auth] login gagal'))).toEqual(['[auth] login gagal dari 203.0.113.10 (1/10)']);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------------------- Poin 2: escape
describe('Poin 2: urutan escape dibuang utuh (stripControl / normalizeEvent)', () => {
  it.each([
    ['Fs ESC7 / ESC8', `a${E}7b${E}8c`, 'abc'],
    ['Fp ESC= / Fs ESCc', `a${E}=b${E}cd`, 'abd'],
    ['ESC tunggal + huruf (Fs)', 'c\u001bd', 'c'],
    ['nF ESC(B (tput sgr0)', `x${E}(B${E}[my`, 'xy'],
    ['CSI tanpa parameter ESC[m', `x${E}[my`, 'xy'],
    ['CSI 8-bit U+009B 1m', 'x\u009b1my', 'xy'],
    ['CSI 8-bit U+009B ?25l', 'x\u009b?25ly', 'xy'],
    ['DCS ESC P … ST', `x${E}Pq#0${ST}y`, 'xy'],
    ['DCS 8-bit U+0090 … U+009C', 'x\u0090q\u009cy', 'xy'],
    ['APC ESC _ … ST', `x${E}_isi${ST}y`, 'xy'],
    ['OSC 8-bit U+009D … U+009C', 'x\u009d0;judul\u009cy', 'xy'],
    ['OSC ESC]0;judul tanpa akhir → isinya tetap teks', `${E}]0;judul`, '0;judul'],
    ['ESC di akhir teks', `abc${E}`, 'abc'],
  ])('%s', (_label, input, want) => {
    expect(stripControl(input)).toBe(want);
    expect(normalizeEvent({ type: 'done', from: 'a', to: 'b', message: input }).event.message).toBe(want);
  });

  it('ESC]0;judul tanpa akhir → "0;judul" juga di prepareText dan jalur hook', () => {
    expect(prepareText(`${E}]0;judul`, 100)).toBe('0;judul');
    expect(messageOf(PATHS['Agent.description'](`${E}]0;judul`))).toBe('pakai 0;judul');
    expect(messageOf(PATHS.SubagentStop(`${E}]0;judul`))).toBe('Token 0;judul dipakai');
  });
});

const ESC_PREFIXES = [
  ['ESC[ (CSI tanpa parameter, huruf pertama token jadi byte akhir)', `${E}[`],
  ['ESC(B ESC[m (tput sgr0)', `${E}(B${E}[m`],
  ['ESC(B', `${E}(B`],
  ['ESC7', `${E}7`],
  ['ESC (tunggal)', E],
  ['U+009B 1m', '\u009b1m'],
  ['U+009B (tunggal)', '\u009b'],
  ['ESC[1 (parameter tanpa akhir)', `${E}[1`],
  ['ESC[? (parameter privat)', `${E}[?`],
  ['OSC ESC]8;; tanpa akhir', `${E}]8;;`],
  ['OSC ESC]0;judul tanpa akhir', `${E}]0;judul `],
  ['DCS ESC P tanpa akhir', `${E}P`],
  ['APC ESC _ tanpa akhir', `${E}_`],
  ['DCS 8-bit U+0090 tanpa akhir', '\u0090'],
  ['OSC 8-bit U+009D tanpa akhir', '\u009d'],
];
const ESC_INSERTS = [
  ['ESC tunggal', E],
  ['ESC[m', `${E}[m`],
  ['ESC(B', `${E}(B`],
  ['ESC7', `${E}7`],
  ['U+009B 1m', '\u009b1m'],
  ['U+009B tunggal', '\u009b'],
  ['OSC tanpa akhir', `${E}]`],
  ['DCS tanpa akhir', `${E}P`],
  ['APC tanpa akhir', `${E}_`],
];

describe('Poin 2: token dengan awalan / sisipan escape tidak bocor di setiap jalur hook', () => {
  it.each(ESC_PREFIXES)('awalan %s', (_label, pre) => {
    for (const [tokLabel, p, tail] of TOKENS) expectHiddenEverywhere(`${pre}${p}${tail}`, tail, tokLabel);
  });

  it.each(ESC_INSERTS)('sisipan %s di tengah token (offset 1, 2, 3, 6, 12)', (_label, ins) => {
    for (const [tokLabel, p, tail] of TOKENS) {
      const tok = p + tail;
      for (const n of [1, 2, 3, 6, 12]) expectHiddenEverywhere(`${tok.slice(0, n)}${ins}${tok.slice(n)}`, tail, `${tokLabel}@${n}`);
    }
  });

  it('ESC[1 + sk-… dan ESC[ + sk_live_… (kasus laporan backend) tersensor di prepareText + redactSecrets', () => {
    const sk = `${TOKENS[1][1]}${TOKENS[1][2]}`;
    const live = `${TOKENS[2][1]}${TOKENS[2][2]}`;
    expect(redactSecrets(prepareText(`pakai ${E}[1${sk} ok`, 2000))).toBe(`pakai ${REDACTED} ok`);
    expect(redactSecrets(prepareText(`pakai ${E}[${live} ok`, 2000))).toBe(`pakai ${REDACTED} ok`);
    expect(redactSecrets(prepareText(`pakai ${E}(B${E}[m${TOKENS[0][1]}${TOKENS[0][2]} ok`, 2000))).toBe(`pakai ${REDACTED} ok`);
  });

  it('kontrol: tanpa prepareText, redactSecrets saja tidak mengenali "ESC[" + ghp_… setelah stripControl (alasan pandangan C/E ada)', () => {
    const tok = `${TOKENS[0][1]}${TOKENS[0][2]}`;
    const stripped = stripControl(`${E}[${tok}`);
    expect(stripped).toBe(tok.slice(1)); // "g" termakan sebagai byte akhir CSI
    expect(redactSecrets(stripped)).toBe(stripped); // "hp_…" bukan pola token
    expect(prepareText(`${E}[${tok}`, 2000)).toBe(REDACTED);
  });
});

// ------------------------------------------------------------------------------------- Poin 3
const NEW_INVISIBLE = [
  ['U+034F CGJ', '\u034f'],
  ['U+115F pengisi Hangul choseong', '\u115f'],
  ['U+1160 pengisi Hangul jungseong', '\u1160'],
  ['U+3164 pengisi Hangul', '\u3164'],
  ['U+FFA0 pengisi Hangul halfwidth', '\uffa0'],
  ['U+17B4 vokal Khmer', '\u17b4'],
  ['U+17B5 vokal Khmer', '\u17b5'],
  ['U+180B Mongol FVS1', '\u180b'],
  ['U+180C Mongol FVS2', '\u180c'],
  ['U+180D Mongol FVS3', '\u180d'],
  ['U+180E Mongol vowel separator', '\u180e'],
  ['U+180F Mongol FVS4', '\u180f'],
  ['U+FE00 VS1', '\ufe00'],
  ['U+FE0F VS16', '\ufe0f'],
  ['U+E0100 VS17', '\u{e0100}'],
  ['U+E01EF VS256', '\u{e01ef}'],
  ['U+1D173 musik begin beam', '\u{1d173}'],
  ['U+1D17A musik end phrase', '\u{1d17a}'],
  ['U+FFF9 anotasi interlinear', '\ufff9'],
  ['U+FFFA anotasi interlinear', '\ufffa'],
  ['U+FFFB anotasi interlinear', '\ufffb'],
  ['U+2800 Braille kosong', '\u2800'],
];

describe('Poin 3: karakter tak terlihat baru dibuang, token yang diselipi tetap tersensor', () => {
  it.each(NEW_INVISIBLE)('stripControl / normalizeEvent membuang %s', (_label, c) => {
    expect(stripControl(`a${c}b${c}${c}c`)).toBe('abc');
    expect(normalizeEvent({ type: 'done', from: 'a', to: 'b', message: `x${c}y` }).event.message).toBe('xy');
    expect(normalizeEvent({ type: 'done', from: `dev${c}-qa`, to: 'b' }).event.from).toBe('dev-qa');
  });

  it('rentang lengkap U+180B-U+180F, U+FE00-U+FE0F, U+E0100-U+E01EF, U+1D173-U+1D17A, U+FFF9-U+FFFB dibuang', () => {
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCodePoint(a + i)).join('');
    const all = [range(0x180b, 0x180f), range(0xfe00, 0xfe0f), range(0xe0100, 0xe01ef), range(0x1d173, 0x1d17a), range(0xfff9, 0xfffb)].join('');
    expect(stripControl(`a${all}b`)).toBe('ab');
    // Tetangga rentang yang terlihat tidak ikut dibuang.
    const neighbours = '\u180a\u1810\u{1d172}\u{1d17b}\ufff8\ufffc\u2801\u3165\u034e';
    expect(stripControl(neighbours)).toBe(neighbours);
  });

  it.each(NEW_INVISIBLE)('token diselipi %s (offset 2 dan 6) tidak bocor di setiap jalur hook', (_label, c) => {
    for (const [tokLabel, p, tail] of TOKENS) {
      const tok = p + tail;
      for (const n of [2, 6]) expectHiddenEverywhere(`${tok.slice(0, n)}${c}${tok.slice(n)}`, tail, `${tokLabel}@${n}`);
    }
  });

  it('teks biasa (emoji tanpa VS, aksara lain, Braille berisi) tidak berubah', () => {
    const text = 'Halo dunia — 9/9 test lulus ✓ 日本語 العربية 한국어 ⠁⠃ café';
    expect(stripControl(text)).toBe(text);
  });
});

// ------------------------------------------------------------------------------------- N2a / N2b
describe('N2a: token menempel ke kata lewat karakter yang dibuang tetap tersensor', () => {
  const GLUE = [
    ['Token<ZWSP>', 'Token\u200b'],
    ['TOKEN<ZWSP>', 'TOKEN\u200b'],
    ['Token<LRM>', 'Token\u200e'],
    ['Token<ESC[0m>', `Token${E}[0m`],
    ['Token<ESC[1m>', `Token${E}[1m`],
    ['Token<NEL U+0085>', 'Token\u0085'],
    ['Token<U+3164>', 'Token\u3164'],
    ['Token (langsung)', 'Token'],
  ];
  it.each(GLUE)('%s + token', (_label, glue) => {
    for (const [tokLabel, p, tail] of TOKENS) expectHiddenEverywhere(`${glue}${p}${tail}`, tail, tokLabel);
  });

  it('kasus laporan: Token<ZWSP>ghp_… dan TOKEN<ZWSP>sk-… lewat SubagentStop', () => {
    const ghp = glue('gh', 'p_', 'Fa1KeX9zQ7'.repeat(4));
    const sk = glue('sk', '-ant-api03-', 'q1w2e3r4t5'.repeat(3));
    expect(messageOf(PATHS['Agent.description'](`Token\u200b${ghp}`))).toBe(`pakai Token${REDACTED}`);
    const stop = messageOf({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: `STATUS: SELESAI\nTOKEN\u200b${sk} dipakai` });
    expect(stop).not.toContain('q1w2e3r4t5');
    expect(stop).toContain(REDACTED);
  });

  const GLUED = [
    ['ghp_', glue('gh', 'p_', 'A1b2C3d4E5'.repeat(4))],
    ['gho_', glue('gh', 'o_', 'A1b2C3d4E5'.repeat(4))],
    ['ghu_', glue('gh', 'u_', 'A1b2C3d4E5'.repeat(4))],
    ['ghs_', glue('gh', 's_', 'A1b2C3d4E5'.repeat(4))],
    ['ghr_', glue('gh', 'r_', 'A1b2C3d4E5'.repeat(4))],
    ['github_pat_', glue('github', '_pat_11ABCDEFG0123456789_', 'abcdefghij'.repeat(3))],
    ['glpat-', 'glpat' + '-xY9zW8vU7tS6rQ5pO4nM'],
    ['xoxa-', glue('xo', 'xa-1234567890-abcdefghijKL')],
    ['xoxb-', glue('xo', 'xb-1234567890-abcdefghijKL')],
    ['xoxp-', glue('xo', 'xp-1234567890-abcdefghijKL')],
    ['xoxr-', glue('xo', 'xr-1234567890-abcdefghijKL')],
    ['xoxs-', glue('xo', 'xs-1234567890-abcdefghijKL')],
    ['AKIA', 'AKIA' + 'IOSFODNN7EXAMPL3'],
    ['npm_', glue('np', 'm_aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2')],
    ['AIza', glue('AI', 'zaFakeKey-NotReal_0123456789abcdefghi')],
    ['dckr_pat_', glue('dckr', '_pat_Xy7Zw6Vu5Ts4Rq3Po2Nm1')],
    ['sk_live_ (ekor 16)', 'sk_' + 'live_Zq8Wm3Rt5YZq8Wm3R'],
    ['sk_test_ (ekor 24)', 'sk_' + 'test_Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0'],
    ['rk_live_ (ekor 24)', 'rk_' + 'live_Qw1Er2Ty3Ui4Op5As6Df7Gh8'],
  ];
  it.each(GLUED)('prefiks khas %s tersensor walau menempel ke kata ("Token…", "abc…", "x_…")', (_label, tok) => {
    const tail = tok.slice(-12);
    for (const word of ['Token', 'abc', 'x_', 'X9']) {
      const out = redactSecrets(`${word}${tok} ok`);
      expect(out, `${word}${tok}`).toContain(REDACTED);
      expect(out, `${word}${tok}`).not.toContain(tail);
      expect(out.endsWith(' ok')).toBe(true);
    }
    expectHiddenEverywhere(`Token\u200b${tok}`, tok.slice(4), _label);
  });

  it.each([
    'task_test_suite',
    'task_test_suite gagal',
    'desk-top-layout',
    'keyJabc',
    'task-runner-configuration',
    'run mask_live_view',
    'pakai npm_config',
    'the AKIA prefix',
    'file eyJ.txt',
  ])('tanpa false positive: %j tidak disensor (redactSecrets dan jalur hook)', (text) => {
    expect(redactSecrets(text)).toBe(text);
    expect(messageOf(PATHS['Agent.description'](text))).toBe(`pakai ${text}`);
    expect(messageOf(PATHS['Bash.description'](text))).toBe(`Bash · cek ${text}`);
    // Laporan (summarize) membuang "_" markdown, tetapi tidak menyensor.
    expect(messageOf(PATHS.SubagentStop(text))).not.toContain(REDACTED);
  });
});

describe('N2b: JWT menempel ke "x-", "-", "a_", "x" tetap tersensor', () => {
  it.each(['x-', '-', 'a_', 'x', 'Token', 'id_token='])('%j + JWT', (pre) => {
    expect(redactSecrets(`${pre}${JWT}`)).toBe(`${pre}${REDACTED}`);
    expect(redactSecrets(`lihat ${pre}${JWT} ok`)).toBe(`lihat ${pre}${REDACTED} ok`);
    expectHiddenEverywhere(`${pre}${JWT}`, TOKENS[3][2], `JWT setelah ${JSON.stringify(pre)}`);
  });
});

// ------------------------------------------------------------------------------------- N4
describe('N4: judul "Ringkasan" linear dan perilakunya tetap', () => {
  const N = 100_000;
  // Regex judul "ringkasan" diambil langsung dari sumber (summarize), supaya yang diuji persis regex yang dipakai:
  // lewat summarize, baris dipotong 8000 karakter dulu, sehingga pola lama kuadratik (±400 ms per 20 KB) tidak
  // terlihat jelas dari luar.
  const src = readFileSync(join(ROOT, 'shared', 'hookMapping.js'), 'utf8');
  const literals = [...src.matchAll(/\/(\^ringkasan(?:\\.|[^/\\\n])*)\/([a-z]*)/g)].map((m) => new RegExp(m[1], m[2].replace('g', '')));

  it('regex judul ringkasan ditemukan di shared/hookMapping.js (filter dan pembuang awalan)', () => {
    expect(literals.length).toBeGreaterThanOrEqual(2);
    expect(literals.map((r) => r.source)).toContain('^ringkasan\\s*:?$');
  });

  it.each([
    ['spasi + "x"', `ringkasan${' '.repeat(N)}x`],
    ['spasi + ":" + spasi + "x"', `ringkasan${' '.repeat(N / 2)}:${' '.repeat(N / 2)}x`],
    ['tab + "x"', `ringkasan${'\t'.repeat(N)}x`],
    ['" :" berulang', `ringkasan${' :'.repeat(N / 2)}x`],
  ])('setiap regex judul ringkasan pada "ringkasan" + 100 KB %s < 100 ms', (_label, text) => {
    for (const re of literals) expect(msOf(() => re.test(text)), re.source).toBeLessThan(100);
  });

  it('end-to-end: summarize / SubagentStop / PostToolUse dengan "ringkasan" + 100 KB spasi < 100 ms', () => {
    const text = `ringkasan${' '.repeat(N)}x`;
    expect(msOf(() => summarize(text))).toBeLessThan(100);
    expect(msOf(() => mapHookToEvents({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: `STATUS: SELESAI\n${text}` }))).toBeLessThan(100);
    expect(msOf(() => mapHookToEvents(PATHS['PostToolUse Agent'](text)))).toBeLessThan(100);
  });

  it.each([
    ['STATUS: SELESAI\nRingkasan\nSemua test lulus', 'Semua test lulus'],
    ['STATUS: SELESAI\nRingkasan:\nSemua test lulus', 'Semua test lulus'],
    ['STATUS: SELESAI\nRingkasan :\nSemua test lulus', 'Semua test lulus'],
    ['STATUS: SELESAI\n## Ringkasan\nSemua test lulus', 'Semua test lulus'],
    ['STATUS: SELESAI\n**Ringkasan:**\nSemua test lulus', 'Semua test lulus'],
    ['STATUS: SELESAI\nringkasan\t:\nSemua test lulus', 'Semua test lulus'],
    ['STATUS: SELESAI\nRingkasan: 12 test lulus', '12 test lulus'],
    ['STATUS: SELESAI\nRingkasan — 12 test lulus', '12 test lulus'],
    ['STATUS: SELESAI\nRingkasan pekerjaan hari ini', 'Ringkasan pekerjaan hari ini'],
  ])('summarize(%j) → %j', (text, want) => {
    expect(summarize(text)).toBe(want);
  });
});

// ------------------------------------------------------------------------------------- N5
describe('N5: nilai rahasia bertanda kutip yang terpotong batas prepareText tidak bocor (semua offset)', () => {
  const VALUES = ['--password "alpha bravo charlie"', "--password 'alpha bravo charlie'", 'DB_PASSWORD="alpha bravo charlie"', 'password: "alpha bravo charlie"'];
  // Potongan 3 huruf dari setiap kata di dalam kutip (kata yang terpotong di tengah juga terhitung bocor).
  const WINDOWS = ['alpha', 'bravo', 'charlie'].flatMap((w) => Array.from({ length: w.length - 2 }, (_, i) => w.slice(i, i + 3)));
  const leakedWord = (msg) => WINDOWS.find((w) => msg.includes(w));
  const RUNS = [
    // [jalur, batas, pembuat payload dari padding + nilai]
    ['SubagentStop (8000)', 8000, (pad, v) => ({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: `${'\n'.repeat(pad)}${v} ekor` })],
    ['PostToolUse Agent (8000)', 8000, (pad, v) => PATHS['PostToolUse Agent'](`${'\n'.repeat(pad - 16)}${v}`)],
    ['Agent.prompt (8000)', 8000, (pad, v) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', prompt: `${'\n'.repeat(pad)}${v} ekor` } })],
    ['Agent.description (2000)', 2000, (pad, v) => ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description: `${' '.repeat(pad)}${v} ekor` } })],
    ['Bash.description (2000)', 2000, (pad, v) => ({ hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'Bash', tool_input: { command: 'npm test', description: `${' '.repeat(pad)}${v} ekor` } })],
  ];

  it('kontrol: nilai utuh tersensor seluruhnya, dan pendeteksi kebocoran bekerja', () => {
    expect(summarize('STATUS: SELESAI\n--password "alpha bravo charlie" ok')).toBe(`--password ${REDACTED} ok`);
    expect(leakedWord('--password "alpha')).toBe('alp');
    expect(leakedWord(`--password ${REDACTED} ok`)).toBeUndefined();
  });

  it.each(RUNS)('%s: setiap offset di sekitar batas', (_label, max, mk) => {
    const bad = [];
    for (const v of VALUES) {
      for (let off = -3; off <= v.length + 3; off++) {
        const evs = mapHookToEvents(mk(max - off, v));
        expect(evs).toHaveLength(1);
        const w = leakedWord(evs[0].message);
        if (w) bad.push(`${v} @${off}: ${JSON.stringify(evs[0].message)} (memuat "${w}")`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('prepareText langsung: --password "alpha bravo charlie" dipotong di dalam kutip → kutip terbuka dibuang', () => {
    const v = '--password "alpha bravo charlie"';
    for (let cut = v.indexOf('"') + 1; cut < v.length; cut++) {
      const out = prepareText(`${v.slice(0, cut)}${'x'.repeat(50)}`, cut);
      expect(out, `cut ${cut}`).not.toContain('"');
      expect(leakedWord(redactSecrets(out)), `cut ${cut}: ${out}`).toBeUndefined();
    }
  });
});

// ------------------------------------------------------------------------------------- Linear
describe('Linear: pola redaksi dan mapHookToEvents pada input adversarial 100 KB', () => {
  const N = 100_000;
  const fill = (u) => u.repeat(Math.ceil(N / u.length)).slice(0, N);
  const ADV = [
    'eyJ-', 'eyJ', 'eyJa', 'eyJaaaaaaaaaaa.', 'eyJaaaaaaaaaaa.bbbbbbbbbbbb', '-eyJ', 'xeyJ', 'eyJeyJ.', 'a.',
    'sk-', 'xsk-', 'ask-', 'ask-a', 'ask-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'sk-sk-', 'sk_live_', 'xsk_live_', glue('sk', '_test_aaaaaaaaaaaaaaa_'),
    'ghp_', 'ghp_a', 'glpat-', 'github_pat_', 'npm_', 'npm_a', 'AIza', 'dckr_pat_', 'xoxb-', 'AKIA', 'AKIAA',
    `${E}[`, `${E}[0`, `${E}(`, `${E}( `, `${E}]`, `${E}]a`, `${E}P`, '\u009b', '\u009b0', '\u0090a', '\u009da', E, `${E}${E}[1`,
    '\u200b', '\u200bghp_', `${E}[1mghp_`, `${E}ghp_`, '\u3164ghp_', '"', "'", 'a "', '--password "', 'x\n',
    // unit terburuk dari fuzz regex backend
    'mysql ', 'Tokensk-', 'curl ', '://a', 'kata sandi ', 'sshpass ', 'password ', 'TOKEN', 'Authorization: ', 'bearer ',
  ];
  const INPUTS = ADV.map((u) => [JSON.stringify(u.slice(0, 16)), fill(u)]);

  // SECRET_PATTERNS diambil dari sumber, supaya setiap pola diuji terpisah (di redactSecrets, pola awal bisa
  // mengubah teks sebelum pola berikutnya melihatnya).
  const src = readFileSync(join(ROOT, 'shared', 'hookMapping.js'), 'utf8');
  const block = src.slice(src.indexOf('const VALUE'), src.indexOf('];', src.indexOf('const SECRET_PATTERNS')) + 2);
  const PATTERNS = new Function(`${block}; return SECRET_PATTERNS;`)();

  it('SECRET_PATTERNS terbaca dari sumber dan identik dengan yang dipakai redactSecrets', () => {
    expect(PATTERNS.length).toBeGreaterThanOrEqual(20);
    // Satu sampel per jenis: hasil penerapan berurutan sama dengan redactSecrets.
    const sample = `${glue('gh', 'p_', 'A'.repeat(36))} ${JWT} --password x DB_PASSWORD=y ${glue('sk', '_live_', 'z'.repeat(20))}`;
    let out = sample;
    for (const re of PATTERNS) out = out.replace(re, (...a) => `${a.at(-1)?.pre ?? ''}${REDACTED}${a.at(-1)?.post ?? ''}`);
    expect(out).toBe(redactSecrets(sample));
  });

  it(`setiap pola redaksi × ${ADV.length} input adversarial 100 KB < 500 ms (terukur backend ≤ 36 ms)`, () => {
    const slow = [];
    for (const [i, re] of PATTERNS.entries()) {
      for (const [label, text] of INPUTS) {
        re.lastIndex = 0;
        const ms = msOf(() => text.replace(re, ''));
        if (ms >= 500) slow.push(`SECRET_PATTERNS[${i}] ${label}: ${ms.toFixed(0)} ms`);
      }
    }
    expect(slow).toEqual([]);
  }, 60_000);

  it('redactSecrets utuh × input adversarial 100 KB < 500 ms', () => {
    const slow = INPUTS.map(([label, text]) => [label, msOf(() => redactSecrets(text))]).filter(([, ms]) => ms >= 500);
    expect(slow).toEqual([]);
  }, 30_000);

  it('mapHookToEvents terburuk (7 jalur teks bebas + WebFetch.url) × input adversarial 100 KB < 500 ms', () => {
    let worst = { ms: 0 };
    for (const [label, text] of INPUTS) {
      const payloads = [
        ...Object.entries(PATHS).map(([k, mk]) => [k, mk(text)]),
        ['WebFetch.url', { hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'WebFetch', tool_input: { url: `https://${text}` } }],
      ];
      for (const [path, payload] of payloads) {
        const ms = msOf(() => mapHookToEvents(payload));
        if (ms > worst.ms) worst = { ms, where: `${path} ${label}` };
      }
    }
    expect(worst.ms, worst.where).toBeLessThan(500);
  }, 60_000);
});

// ------------------------------------------------------------------------------------- N6
describe('N6: looksLikePath — path wajar dicetak, token acak berbentuk path tidak', () => {
  it.each([
    ['/etc/ai-office/token-file', true],
    ['/var/lib/aioffice/secrets/token', true],
    ['/etc/ai-office/ai-office-token-file', true],
    ['/run/secrets/aioffice_token_value', true],
    ['C:/Users/ceo/.ai-office/token', true],
    ['Zm9v.YmFy/YmF6cXV4cXV1eHh5enp5eHh4eHh4', false],
    ['Zm9v/YmFyYmF6cXV4cXV1eHh5enp5eHh4eHh4eHh4', false],
    ['~Zm9vYmFyYmF6cXV4cXV1eHh5enp5eHh4eHh4', false],
    ['  Zm9v/YmFyYmF6cXV4cXV1eHh5enp5eHh4eHh4eHh4  ', false],
    ['/etc/ai-office/Qm9vYmFyYmF6cXV4cXV1eHh5enp5', false], // segmen acak di dalam path wajar
  ])('looksLikePath(%j) → %s', (value, want) => {
    expect(looksLikePath(value)).toBe(want);
    const label = tokenFileLabel(value);
    if (want) expect(label).toContain(value.trim());
    else expect(label).not.toContain(value.trim());
  });

  it('server/index.js: nilai acak di AI_OFFICE_TOKEN_FILE dan nilai aneh di AI_OFFICE_TRUST_PROXY tidak tercetak', async () => {
    const tokenFile = 'Zm9v.YmFy/YmF6cXV4cXV1eHh5enp5eHh4eHh4';
    const proxy = 'Rk9PYmFyQmF6UXV4LXRydXN0LXByb3h5LTEyMw';
    const r = await runServer({ AI_OFFICE_TOKEN_FILE: tokenFile, AI_OFFICE_TRUST_PROXY: proxy }, async (port) => (await http(port, '/api/session')).json);
    expect(r.ready).toEqual({ ok: true, authRequired: false, authenticated: true }); // seperti tanpa token, lokal
    expect(r.all).toMatch(/AI_OFFICE_TOKEN_FILE \(nilainya tidak ditampilkan karena tidak berbentuk path/);
    expect(r.all).toMatch(/AI_OFFICE_TRUST_PROXY hanya aktif bila bernilai 1 \(nilai sekarang bukan 1, tidak ditampilkan\)/);
    for (const v of [tokenFile, proxy, 'Zm9v', 'YmF6cXV4', 'Rk9PYmFy']) expect(r.all).not.toContain(v);
  });

  it('server/index.js: path wajar yang hilang tetap dicetak', async () => {
    const p = join(dir, 'etc', 'ai-office', 'token-file');
    const r = await runServer({ AI_OFFICE_TOKEN_FILE: p }, async () => true);
    expect(r.ready).toBe(true);
    expect(r.all).toContain(`AI_OFFICE_TOKEN_FILE (${p}) tidak ditemukan; server berjalan seperti tanpa token.`);
  });
});

// ------------------------------------------------------------------------------------- N7
describe('N7: token tidak sah → invalid (bukan "seperti tanpa token"), tanpa isi token di pesan', () => {
  const BASE = 'Qx7_' + 'k9Lm'.repeat(10); // 44 karakter ASCII terlihat
  const INVALID_ENV = [
    ['surrogate tunggal', `${BASE}\ud800`],
    ['U+2028', `${BASE.slice(0, 20)}\u2028${BASE.slice(20)}`],
    ['U+00FF (byte 0xff sebagai Latin-1)', `${BASE.slice(0, 20)}\u00ff${BASE.slice(20)}`],
    ['U+FFFD', `${BASE}\ufffd`],
    ['spasi di tengah', `${BASE.slice(0, 20)} ${BASE.slice(20)}`],
    ['tab di tengah', `${BASE.slice(0, 20)}\t${BASE.slice(20)}`],
  ];
  const le = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, 'utf16le')]);
  const INVALID_FILE = [
    ['UTF-16LE + surrogate tunggal', () => Buffer.concat([le(BASE), Buffer.from([0x00, 0xd8])])],
    ['UTF-16LE + U+2028 di tengah', () => le(`${BASE.slice(0, 20)}\u2028${BASE.slice(20)}`)],
    ['UTF-8 dengan byte 0xff di tengah', () => Buffer.concat([Buffer.from(BASE.slice(0, 20)), Buffer.from([0xff]), Buffer.from(BASE.slice(20))])],
    ['spasi di tengah', () => Buffer.from(`${BASE.slice(0, 20)} ${BASE.slice(20)}\n`)],
  ];
  let tdir;
  beforeAll(() => {
    tdir = mkdtempSync(join(dir, 'tok4-'));
  });
  const fileOf = (label, bytes) => {
    const p = join(tdir, label.replace(/\W+/g, '-'));
    writeFileSync(p, bytes);
    return p;
  };
  const noTokenIn = (r) => {
    const s = JSON.stringify(r);
    expect(s).not.toContain(BASE.slice(0, 20));
    expect(s).not.toContain(BASE.slice(20));
  };

  it.each(INVALID_ENV)('resolveToken env: %s → invalid', (_label, token) => {
    const r = resolveToken({ token });
    expect(r).toEqual({ token: '', source: 'env', problem: INVALID_TOKEN, invalid: true });
    noTokenIn(r);
  });

  it.each(INVALID_FILE)('resolveToken file: %s → invalid', (label, bytes) => {
    const p = fileOf(label, bytes());
    const r = resolveToken({ tokenFile: p });
    expect(r).toEqual({ token: '', source: 'file', file: p, problem: INVALID_TOKEN, invalid: true });
    noTokenIn(r);
  });

  it('kontrol: token ASCII sah (env dan file) diterima, spasi di tepi diabaikan', () => {
    expect(resolveToken({ token: `  ${BASE}  ` })).toEqual({ token: BASE, source: 'env' });
    const p = fileOf('sah', Buffer.from(`\n${BASE}\r\n`));
    expect(resolveToken({ tokenFile: p })).toEqual({ token: BASE, source: 'file', file: p });
  });

  it('safeEqual: surrogate tunggal tidak sama dengan U+FFFD (dan dengan surrogate lain)', () => {
    expect(safeEqual('a\ud800', 'a\ufffd')).toBe(false);
    expect(safeEqual('a\ud800', 'a\udbff')).toBe(false);
    expect(safeEqual('a\ud800', 'a\ud800')).toBe(true);
    expect(safeEqual(BASE, BASE)).toBe(true);
  });

  it.each([
    ['env spasi di tengah', () => ({ AI_OFFICE_TOKEN: INVALID_ENV[4][1] })],
    ['env U+00FF', () => ({ AI_OFFICE_TOKEN: INVALID_ENV[2][1] })],
    ['file UTF-16LE + surrogate tunggal', () => ({ AI_OFFICE_TOKEN_FILE: fileOf('srv-lone', INVALID_FILE[0][1]()) })],
    ['file byte 0xff', () => ({ AI_OFFICE_TOKEN_FILE: fileOf('srv-ff', INVALID_FILE[2][1]()) })],
  ])('server/index.js dengan token tidak sah (%s) → exit 1, pesan tanpa token', async (_label, mkEnv) => {
    const env = mkEnv();
    const r = await runServer(env, async () => 'tidak boleh jalan');
    expect(r.ready).toBeUndefined();
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Server tidak dijalankan: AI_OFFICE_TOKEN(_FILE \(.*\))? berisi spasi atau karakter tidak valid/);
    expect(r.all).not.toContain(BASE.slice(0, 20));
    expect(r.all).not.toContain(BASE.slice(20));
  });

  it.each([
    ['env spasi di tengah', () => ({ AI_OFFICE_TOKEN: INVALID_ENV[4][1] })],
    ['env U+2028', () => ({ AI_OFFICE_TOKEN: INVALID_ENV[1][1] })],
    ['file UTF-16LE + surrogate tunggal', () => ({ AI_OFFICE_TOKEN_FILE: fileOf('hook-lone', INVALID_FILE[0][1]()) })],
    ['file byte 0xff', () => ({ AI_OFFICE_TOKEN_FILE: fileOf('hook-ff', INVALID_FILE[2][1]()) })],
  ])('hook dengan token tidak sah (%s) → event tidak dikirim, exit 0, stderr DEBUG tanpa token', async (_label, mkEnv) => {
    const cap = await captureServer();
    try {
      const r = await runHook({ hook_event_name: 'SubagentStart', agent_type: 'dev-qa' }, { AI_OFFICE_URL: cap.url, AI_OFFICE_DEBUG: '1', ...mkEnv() });
      expect(r).toMatchObject({ code: 0, out: '', timedOut: false });
      expect(cap.received).toEqual([]);
      expect(r.err).toMatch(/berisi spasi atau karakter tidak valid; event tidak dikirim/);
      expect(r.err).not.toContain(BASE.slice(0, 20));
      expect(r.err).not.toContain(BASE.slice(20));
    } finally {
      await cap.close();
    }
  });

  it('kontrol: hook dengan token sah dari file yang sama bentuknya → event sampai dengan Bearer', async () => {
    const cap = await captureServer();
    try {
      const p = fileOf('hook-sah', le(`${BASE}\r\n`));
      const r = await runHook({ hook_event_name: 'SubagentStart', agent_type: 'dev-qa' }, { AI_OFFICE_URL: cap.url, AI_OFFICE_TOKEN_FILE: p });
      expect(r).toMatchObject({ code: 0, out: '', err: '' });
      expect(cap.received).toHaveLength(1);
      expect(cap.received[0].headers.authorization).toBe(`Bearer ${BASE}`);
    } finally {
      await cap.close();
    }
  });
});
