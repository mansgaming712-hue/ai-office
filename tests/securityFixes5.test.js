// Regresi perbaikan kecil putaran 5:
//   L-2  shared/hookMapping.js: sk-/pk-/rk- yang menempel ke kata sebelumnya ("a_sk-…", "OPENAI_KEY_sk-…",
//        "my_pk-…", "Tokensk-…", "x_rk-…") tersensor bila nilainya tampak acak (segmen ≥ 16 huruf+angka);
//        nama kebab-case / snake_case biasa ("task-runner-configuration-v2", "disk-2024-11-08-backup-v3") tidak
//   L-1  pandangan F prepareText: ESC[ / ESC( tanpa byte akhir sendiri di TENGAH token ("AIza ESC[SyD-…",
//        "AKIA ESC(IOSF…") tetap tersensor; keluaran berwarna wajar (vitest, git, grep) tidak tersensor
//   I-2  server/index.js: nilai AI_OFFICE_LOG_MESSAGES / AI_OFFICE_ALLOWED_HOSTS yang tidak valid tidak dicetak
//   I-1  server/net.js requestPathname: karakter kontrol, spasi, DEL di mana pun → null (lapisan kedua di
//        belakang parser HTTP Node)
//   Linear: input adversarial 100 KB (skrip bukti backend redos5.mjs) lewat redactSecrets dan mapHookToEvents
// Server di dalam proses: port 0. server/index.js: port 3300-3399 (freePort). Port 3000 tidak pernah disentuh.
// Semua token di sini acak atau palsu. Batas waktu sengaja longgar supaya tidak flaky saat suite paralel.
import { randomInt } from 'node:crypto';
import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import { requestPathname } from '../server/net.js';
import { stripControl } from '../shared/events.js';
import { REDACTED, mapHookToEvents, redactSecrets } from '../shared/hookMapping.js';
import { SERVER_ENTRY, cleanEnv, freePort, http, glue, randomToken, runNode, startApp } from './helpers/testkit.js';

const E = '\u001b';

// ------------------------------------------------------------------------------------------ helper
const msOf = (f) => {
  const t0 = performance.now();
  f();
  return performance.now() - t0;
};

/** Jalankan server/index.js (port 3300-3399); setelah "jalan di" muncul, `onReady(port)` dipanggil lalu proses dimatikan. */
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

/** Request mentah lewat TCP (target dikirim apa adanya); hasil: status dari baris pertama respons. */
function rawStatus(port, text) {
  return new Promise((resolve) => {
    const sock = connect({ port, host: '127.0.0.1' });
    let data = '';
    const timer = setTimeout(() => sock.destroy(), 5000);
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    sock.on('connect', () => sock.write(text));
    sock.on('data', (d) => (data += d));
    sock.on('close', () => {
      clearTimeout(timer);
      resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(data)?.[1] ?? NaN));
    });
  });
}

/** Jalur hook yang membawa teks bebas (sama dengan securityFixes3/4). */
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
// Tiga jalur yang diminta untuk L-2 / false positive (teks dikirim apa adanya, tanpa kata tambahan di depan).
const agentDesc = (t) => messageOf({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description: t } });
const bashDesc = (t) => messageOf({ hook_event_name: 'PreToolUse', agent_type: 'dev-qa', tool_name: 'Bash', tool_input: { command: 'npm test', description: t } });
const subagentStop = (t) => messageOf({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: `STATUS: SELESAI\n${t}` });

/** Bocor = 10 karakter alfanumerik berurutan dari ekor rahasia tampil (setelah stripControl, tanda baca dibuang). */
function leaked(msg, tail) {
  const flat = stripControl(msg).replace(/[^A-Za-z0-9]/g, '');
  const t = tail.replace(/[^A-Za-z0-9]/g, '');
  for (let i = 0; i + 10 <= t.length; i++) if (flat.includes(t.slice(i, i + 10))) return true;
  return false;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Nilai acak `n` (≥ 16) alfanumerik yang dijamin memuat huruf DAN angka (bentuk kunci API sungguhan). */
function randomAlnum(n = 24) {
  const chars = Array.from({ length: n - 2 }, () => ALNUM[randomInt(ALNUM.length)]);
  chars.splice(randomInt(chars.length + 1), 0, ALNUM[randomInt(52)]); // satu huruf
  chars.splice(randomInt(chars.length + 1), 0, String(randomInt(10))); // satu angka
  const s = chars.join('');
  expect(s).toHaveLength(n);
  expect(s).toMatch(/[A-Za-z]/);
  expect(s).toMatch(/[0-9]/);
  return s;
}

// ------------------------------------------------------------------------------------------- L-2
describe('L-2: sk-/pk-/rk- menempel ke kata sebelumnya tersensor bila nilainya tampak acak', () => {
  it('kasus laporan: "pakai a_sk-ant-api03-…" → "pakai a_[disembunyikan]" (redactSecrets, Agent/Bash description)', () => {
    const text = glue('pakai a_sk', '-ant-api03-q1w2e3r4t5y6u7i8o9p0asdfghjkl');
    expect(redactSecrets(text)).toBe(`pakai a_${REDACTED}`);
    expect(agentDesc(text)).toBe(`pakai a_${REDACTED}`);
    expect(bashDesc(text)).toBe(`Bash · pakai a_${REDACTED}`);
    // Laporan (summarize) membuang "_" markdown, tetapi rahasia tetap tersensor.
    const stop = subagentStop(text);
    expect(stop).toContain(REDACTED);
    expect(leaked(stop, 'q1w2e3r4t5y6u7i8o9p0asdfghjkl')).toBe(false);
  });

  // [label, kata di depan (dipertahankan), rahasia (disensor), ekor rahasia untuk cek bocor]
  const r = { proj: randomAlnum(24), pk: randomAlnum(20), tok: randomAlnum(24), rk: randomAlnum(20) };
  const CASES = [
    ['OPENAI_KEY_sk-proj- (contoh tetap)', 'OPENAI_KEY_', glue('sk', '-proj-A1b2C3d4E5f6G7h8I9j0K1l2'), 'A1b2C3d4E5f6G7h8I9j0K1l2'],
    ['OPENAI_KEY_sk-proj- (acak)', 'OPENAI_KEY_', glue('sk', '-proj-', r.proj), r.proj],
    ['my_pk-live… (acak)', 'my_', `pk-live${r.pk}`, r.pk],
    ['Tokensk-proj-… (acak)', 'Token', glue('sk', '-proj-', r.tok), r.tok],
    ['x_rk-… (acak)', 'x_', `rk-${r.rk}`, r.rk],
    ['a_sk-ant-api03-… (contoh tetap)', 'a_', glue('sk', '-ant-api03-q1w2e3r4t5y6u7i8o9p0asdfghjkl'), 'q1w2e3r4t5y6u7i8o9p0asdfghjkl'],
  ];

  it.each(CASES)('%s: redactSecrets → kata + [disembunyikan]', (_label, word, secret) => {
    expect(redactSecrets(`${word}${secret}`)).toBe(`${word}${REDACTED}`);
    expect(redactSecrets(`pakai ${word}${secret} ok`)).toBe(`pakai ${word}${REDACTED} ok`);
  });

  it.each(CASES)('%s: Agent description, Bash description, SubagentStop tersensor tanpa bocor', (_label, word, secret, tail) => {
    const text = `${word}${secret}`;
    expect(agentDesc(text)).toBe(`${word}${REDACTED}`);
    expect(bashDesc(text)).toBe(`Bash · ${word}${REDACTED}`);
    const stop = subagentStop(text);
    expect(stop, stop).toContain(REDACTED);
    expect(stop.endsWith(REDACTED), stop).toBe(true);
    for (const msg of [agentDesc(text), bashDesc(text), stop]) expect(leaked(msg, tail), msg).toBe(false);
  });

  it.each(CASES)('%s: tidak bocor di ketujuh jalur hook', (_label, word, secret, tail) => {
    for (const [path, mk] of Object.entries(PATHS)) {
      const msg = messageOf(mk(`${word}${secret}`));
      expect(leaked(msg, tail), `${path}: ${msg}`).toBe(false);
      if (path !== 'Bash.command') expect(msg, `${path}: ${msg}`).toContain(REDACTED);
    }
  });

  it('20 nilai acak per prefiks (sk-proj-, pk-live, rk-) menempel ke "a_", "Token", "OPENAI_KEY_" → selalu tersensor', () => {
    const bad = [];
    for (let i = 0; i < 20; i++) {
      for (const pre of ['sk-proj-', 'pk-live', 'rk-']) {
        const tail = randomAlnum(16 + randomInt(16));
        for (const word of ['a_', 'Token', 'OPENAI_KEY_']) {
          const text = `${word}${pre}${tail}`;
          const out = [redactSecrets(text), agentDesc(text), bashDesc(text), subagentStop(text)];
          if (out.some((m) => leaked(m, tail) || !m.includes(REDACTED))) bad.push(`${text} → ${JSON.stringify(out)}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('L-2: tanpa false positive pada nama kebab-case / snake_case biasa', () => {
  const BENIGN = [
    'task-runner-configuration-v2',
    'desk-top-layout-2024-final',
    'disk-usage-report-for-q3-2024',
    'task_test_suite',
    'desk-top-layout',
    'keyJabc',
    'task-runner-configuration',
    'disk-2024-11-08-backup-v3',
    'mask-layer-16px-wide',
  ];

  it.each(BENIGN)('%j tetap utuh di redactSecrets, Agent description, Bash description, SubagentStop', (text) => {
    expect(redactSecrets(text)).toBe(text);
    expect(redactSecrets(`pakai ${text} ok`)).toBe(`pakai ${text} ok`);
    expect(agentDesc(text)).toBe(text);
    expect(bashDesc(text)).toBe(`Bash · ${text}`);
    // summarize membuang "_" markdown ("task_test_suite" → "tasktestsuite"), tetapi tidak menyensor.
    const stop = subagentStop(text);
    expect(stop).not.toContain(REDACTED);
    expect(stop).toBe(text.replace(/_/g, ''));
  });

  it.each(BENIGN)('%j tetap utuh di ketujuh jalur hook (tanpa penanda sensor)', (text) => {
    for (const [path, mk] of Object.entries(PATHS)) expect(messageOf(mk(text)), path).not.toContain(REDACTED);
  });
});

// ------------------------------------------------------------------------------------------- L-1
const L1_TOKENS = [
  ['ghp_', glue('gh', 'p_Fa1KeX9zQ7Fa1KeX9zQ7Fa1KeX9zQ7Fa1KeX9zQ7'), 'Fa1KeX9zQ7Fa1KeX9zQ7Fa1KeX9zQ7Fa1KeX9zQ7'],
  ['AIza', glue('AI', 'zaFakeKey-NotReal_0123456789abcdefghi'), 'FakeKey-NotReal_0123456789abcdefghi'],
  ['AKIA', 'AKIA' + 'IOSFODNN7EXAMPL3', 'IOSFODNN7EXAMPL3'],
];
const L1_INSERTS = [
  ['ESC[', `${E}[`],
  ['ESC(', `${E}(`],
  ['ESC[1', `${E}[1`],
  ['ESC[-', `${E}[-`],
];

describe('L-1: ESC[ / ESC( tanpa byte akhir di tengah token tetap tersensor', () => {
  it('kasus laporan: "pakai AIza ESC[ SyD-…" dan "kunci AKIA ESC( IOSF…"', () => {
    const aiza = `pakai AIza${E}[SyD-9tSrke72PouQMnMX-a7eZSW0jkFMBWY`;
    const akia = `kunci AKIA${E}(IOSFODNN7EXAMPL3`;
    expect(agentDesc(aiza)).toBe(`pakai ${REDACTED}`);
    expect(bashDesc(aiza)).toBe(`Bash · pakai ${REDACTED}`);
    expect(subagentStop(aiza)).toBe(`pakai ${REDACTED}`);
    expect(agentDesc(akia)).toBe(`kunci ${REDACTED}`);
    expect(bashDesc(akia)).toBe(`Bash · kunci ${REDACTED}`);
    expect(subagentStop(akia)).toBe(`kunci ${REDACTED}`);
  });

  it('kontrol: stripControl saja memakan huruf token ("AIzayD-…", "AKIAOSF…"), alasan pandangan F ada', () => {
    expect(stripControl(`AIza${E}[SyD-9tSrke72`)).toBe('AIzayD-9tSrke72');
    expect(stripControl(`AKIA${E}(IOSFODNN7`)).toBe('AKIAOSFODNN7');
  });

  it.each(L1_INSERTS)('satu sisipan %s di setiap offset untuk ghp_, AIza, AKIA × 7 jalur hook → 0 bocor', (_label, ins) => {
    const bad = [];
    let n = 0;
    for (const [tokLabel, tok, tail] of L1_TOKENS) {
      for (let off = 0; off <= tok.length; off++) {
        const text = `${tok.slice(0, off)}${ins}${tok.slice(off)}`;
        for (const [path, mk] of Object.entries(PATHS)) {
          n++;
          const msg = messageOf(mk(text));
          if (leaked(msg, tail)) bad.push(`${tokLabel}@${off} ${path}: ${JSON.stringify(msg)}`);
          else if (path !== 'Bash.command' && !msg.includes(REDACTED)) bad.push(`${tokLabel}@${off} ${path} tanpa sensor: ${JSON.stringify(msg)}`);
        }
      }
    }
    expect(n).toBe(L1_TOKENS.reduce((s, [, tok]) => s + tok.length + 1, 0) * Object.keys(PATHS).length);
    expect(bad.slice(0, 10)).toEqual([]);
  });
});

describe('L-1: keluaran berwarna yang wajar tidak tersensor', () => {
  // Dari skrip bukti backend fp-ansi.mjs: vitest, git log, grep --color, npm WARN, soft hyphen.
  const COLORED = [
    ['build-ESC[1mv2ESC[0m-release', `build-${E}[1mv2${E}[0m-release`, 'build-v2-release'],
    ['build-ESC[1mv2ESC[0m-release ok', `build-${E}[1mv2${E}[0m-release ok`, 'build-v2-release ok'],
    ['vitest ✓ file (N tests) ms',
      `${E}[32m✓${E}[39m tests/hookMapping.test.js ${E}[2m(${E}[22m${E}[2m120 tests${E}[22m${E}[2m)${E}[22m${E}[33m 412${E}[2mms${E}[22m${E}[39m`,
      '✓ tests/hookMapping.test.js (120 tests) 412ms'],
    ['vitest RUN banner', `${E}[1m${E}[46m RUN ${E}[49m${E}[22m ${E}[36mv3.2.4 ${E}[39m${E}[90mC:/x/scratch-2026-11-07-4cf20f${E}[39m`,
      'RUN v3.2.4 C:/x/scratch-2026-11-07-4cf20f'],
    ['git log berwarna (hash 40 hex)', `commit ${E}[33m3f2a9b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90${E}[m (HEAD -> main)`,
      'commit 3f2a9b1c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f90 (HEAD -> main)'],
    ['grep --color', `file${E}[36m:${E}[m12${E}[36m:${E}[mconst x = 1`, 'file:12:const x = 1'],
    ['soft hyphen', 'Donaudampf\u00adschifffahrts\u00adgesellschaft 2024', 'Donaudampfschifffahrtsgesellschaft 2024'],
    ['nama kebab-case tebal', `render ${E}[1mtask-runner-configuration-v2${E}[0m selesai`, 'render task-runner-configuration-v2 selesai'],
    ['npm WARN', `npm ${E}[33mWARN${E}[39m deprecated inflight@1.0.6`, 'npm WARN deprecated inflight@1.0.6'],
  ];

  it.each(COLORED)('%s → warna dibuang, teks utuh, tanpa [disembunyikan]', (_label, input, want) => {
    // Pesan event merapatkan spasi berulang (" RUN  v3…" → "RUN v3…"); stripControl sendiri tidak.
    expect(stripControl(input).replace(/\s+/g, ' ').trim()).toBe(want);
    expect(agentDesc(input)).toBe(want);
    expect(bashDesc(input)).toBe(`Bash · ${want}`);
    expect(subagentStop(input)).not.toContain(REDACTED);
    for (const [path, mk] of Object.entries(PATHS)) expect(messageOf(mk(input)), path).not.toContain(REDACTED);
  });
});

// ------------------------------------------------------------------------------------------- I-2
describe('I-2: server/index.js tidak mencetak nilai AI_OFFICE_LOG_MESSAGES / AI_OFFICE_ALLOWED_HOSTS yang tidak valid', () => {
  const SECRET = `Rahasia${randomToken(24).replace(/[^A-Za-z0-9]/g, 'x')}`;

  it('AI_OFFICE_LOG_MESSAGES berisi token salah tempel → peringatan "tidak ditampilkan", nilai tidak tercetak, log tetap metadata', async () => {
    const r = await runServer({ AI_OFFICE_LOG_MESSAGES: SECRET }, async (port) => (await http(port, '/api/session')).json);
    expect(r.ready).toEqual({ ok: true, authRequired: false, authenticated: true });
    expect(r.err).toMatch(/AI_OFFICE_LOG_MESSAGES hanya aktif bila bernilai 1 \(nilai sekarang bukan 1, tidak ditampilkan\), jadi diabaikan/);
    expect(r.all).not.toMatch(/AI_OFFICE_LOG_MESSAGES=1, isi pesan event ikut ditulis/);
    for (const v of [SECRET, SECRET.slice(0, 12), SECRET.slice(-12)]) expect(r.all).not.toContain(v);
  });

  it('AI_OFFICE_LOG_MESSAGES="yes-RAHASIA123" (skrip env-msg.mjs) → nilai tidak tercetak', async () => {
    const r = await runServer({ AI_OFFICE_LOG_MESSAGES: 'yes-RAHASIA123' }, async () => true);
    expect(r.ready).toBe(true);
    expect(r.err).toMatch(/tidak ditampilkan/);
    expect(r.all).not.toContain('RAHASIA123');
  });

  it('AI_OFFICE_ALLOWED_HOSTS dengan entri tidak valid (token salah tempel, spasi) → jumlah entri dicetak, nilainya tidak', async () => {
    const T = randomToken();
    const hosts = `office.example.com,${SECRET}:x,salah tempel RAHASIA123`;
    const r = await runServer({ AI_OFFICE_TOKEN: T, AI_OFFICE_ALLOWED_HOSTS: hosts }, async (port) => (await http(port, '/api/session', { headers: { Host: 'office.example.com' } })).json);
    expect(r.ready).toEqual({ ok: true, authRequired: true, authenticated: false });
    expect(r.err).toMatch(/Peringatan: nilai AI_OFFICE_ALLOWED_HOSTS tidak valid diabaikan: 2 entri bukan hostname yang sah \(nilainya tidak ditampilkan\)/);
    expect(r.out).toMatch(/Host yang diizinkan: office\.example\.com\r?\n/);
    for (const v of [SECRET, SECRET.slice(0, 12), SECRET.slice(-12), 'RAHASIA123', 'salah tempel', T]) expect(r.all).not.toContain(v);
  });

  it('kombinasi LOG_MESSAGES + ALLOWED_HOSTS tidak valid → kedua peringatan menyebut "tidak ditampilkan"', async () => {
    const T = randomToken();
    const r = await runServer({ AI_OFFICE_TOKEN: T, AI_OFFICE_LOG_MESSAGES: SECRET, AI_OFFICE_ALLOWED_HOSTS: `office.example.com,${SECRET}:x` }, async () => true);
    expect(r.ready).toBe(true);
    const warnings = r.err.split(/\r?\n/).filter((l) => /AI_OFFICE_(LOG_MESSAGES|ALLOWED_HOSTS)/.test(l));
    expect(warnings).toHaveLength(2);
    for (const w of warnings) expect(w).toMatch(/tidak ditampilkan/);
    expect(r.all).not.toContain(SECRET);
    expect(r.all).not.toContain(T);
  });
});

// ------------------------------------------------------------------------------------------- I-1
describe('I-1: requestPathname menolak karakter kontrol, spasi, dan DEL di mana pun', () => {
  it.each([
    '/api/ev\tents',
    '/\t/evil/api/events',
    '/api%\t2fx',
    '/api/events\r\n',
    '/api/events\n',
    '/api/events\r',
    '/?x=a b',
    '/api/events?x=a b',
    '/api/events#a b',
    '/api\x00/events',
    '/\x00',
    '/api\x7f',
    '/\x7f/api/events',
    '/api/events?x=\x7f',
    '/api/events?x=\x00',
    '/ws\x0b',
    '/ws\x1f',
    ' /api/events',
  ])('%j → null', (url) => {
    expect(requestPathname(url)).toBeNull();
  });

  it.each([
    ['/', '/'],
    ['/api/events', '/api/events'],
    ['/api/events?since=1', '/api/events'],
    ['/api/events?x=a%20b', '/api/events'],
    ['/ws?x=1', '/ws'],
    ['/assets/app-abc123.js', '/assets/app-abc123.js'],
    ['/x/../api/events', '/api/events'],
    ['/api/login', '/api/login'],
    ['/caf%C3%A9', '/caf%C3%A9'],
  ])('jalur sah %j → %j', (url, want) => {
    expect(requestPathname(url)).toBe(want);
  });

  it('end-to-end: request mentah dengan tab di target → 400 (parser Node atau requestPathname), tanpa [error] di log; jalur sah 200', async () => {
    const s = await startApp();
    try {
      const req = (target) => `GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`;
      expect(await rawStatus(s.port, req('/api/ev\tents'))).toBe(400);
      expect(await rawStatus(s.port, req('/\t/evil/api/events'))).toBe(400);
      expect(await rawStatus(s.port, req('/api/events\x7f'))).toBe(400);
      expect(await rawStatus(s.port, req('/api/events'))).toBe(200);
      expect(s.logs.filter((l) => l.startsWith('[error]'))).toEqual([]);
    } finally {
      await s.close();
    }
  });
});

// ------------------------------------------------------------------------------------------- Linear
describe('Linear: input adversarial 100 KB (redos5.mjs) lewat redactSecrets dan mapHookToEvents < 500 ms', () => {
  const N = 100_000;
  const rep = (u) => u.repeat(Math.ceil(N / u.length)).slice(0, N);
  const INPUTS = {
    'sk-+a*': `sk-${'a'.repeat(N)}`,
    'sk-+a*1': `sk-${'a'.repeat(N - 4)}1`,
    'xsk-+1*': `xsk-${'1'.repeat(N)}`,
    'sk-aaaa-': rep('sk-aaaa-'),
    'xsk-sk-': rep('xsk-'),
    'a_sk-ab-cd-': rep('a_sk-ab-cd-ef-gh-'),
    'sk-a1*15-': rep('sk-a1a1a1a1a1a1a1a-'),
    'sk-a{15}-1-': rep(`sk-${'a'.repeat(15)}-1-`),
    'sk-(seg-)*+long': `sk-${rep('ab-').slice(0, N / 2)}${'a'.repeat(N / 2)}`,
    'pk-(seg-)*': rep('pk-ab-'),
    'x_rk-a1': rep('x_rk-a1'),
    'ESC[a': rep(`${E}[a`),
    'ESC[-': rep(`${E}[-`),
    'ESC(-': rep(`${E}(-`),
    'ESC[0;': rep(`${E}[0;`),
    'a ESC[1m b1': rep(`a1${E}[1m`),
    'ZWSP a1': rep('a1\u200b'),
    'ESC]8;;': rep(`${E}]8;;`),
    'ESC P': rep(`${E}P`),
    'C1 9b a': rep('\u009ba'),
  };
  const ENTRIES = Object.entries(INPUTS);

  it('semua input benar-benar 100 KB', () => {
    for (const [k, s] of ENTRIES) expect(s.length, k).toBeGreaterThanOrEqual(N);
  });

  it(`redactSecrets × ${ENTRIES.length} input < 500 ms (terukur backend ≤ 15 ms)`, () => {
    const slow = ENTRIES.map(([k, s]) => [k, msOf(() => redactSecrets(s))]).filter(([, ms]) => ms >= 500);
    expect(slow).toEqual([]);
  }, 30_000);

  it(`mapHookToEvents (7 jalur teks bebas) × ${ENTRIES.length} input < 500 ms per panggilan (terukur backend ≤ 41 ms)`, () => {
    let worst = { ms: 0 };
    for (const [k, s] of ENTRIES) {
      for (const [path, mk] of Object.entries(PATHS)) {
        const ms = msOf(() => mapHookToEvents(mk(s)));
        if (ms > worst.ms) worst = { ms, where: `${path} ${k}` };
      }
    }
    expect(worst.ms, worst.where).toBeLessThan(500);
  }, 60_000);
});
