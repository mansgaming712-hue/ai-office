// Field event baru (project, tokens), dedup event identik di server, dan hook: token dari transkrip,
// nama proyek, serta keluar cepat (kode 0, tanpa output) saat server mati.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { transcriptTokens } from '../hooks/transcript-tokens.mjs';
import { normalizeBatch, normalizeEvent } from '../shared/events.js';
import { mapHookToEvents, projectName } from '../shared/hookMapping.js';
import { JSON_HEADERS, REPORT_BLOCKED, REPORT_DONE, cleanEnv, entry, freePort, handback, http, jsonl, runHook, runNode, startApp, toolResult } from './helpers/testkit.js';

const TMP = mkdtempSync(join(tmpdir(), 'aio-dedup-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const base = { type: 'done', from: 'dev-qa', to: 'manager', message: 'ok' };
const usageEntry = (id, u, type = 'assistant') =>
  JSON.stringify({ type, uuid: `u-${id}-${Math.random()}`, message: { id, role: type, content: [{ type: 'text', text: 'x' }], usage: u } });
const U = (input, output, cacheRead = 0, cacheCreation = 0) => ({ input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation });

describe('normalizeEvent: project', () => {
  it('opsional; event lama tanpa project tetap valid dan tanpa field project', () => {
    const r = normalizeEvent(base);
    expect(r.ok).toBe(true);
    expect(r.event).not.toHaveProperty('project');
    expect(normalizeEvent({ ...base, project: null }).event).not.toHaveProperty('project');
    expect(normalizeEvent({ ...base, project: '   ' }).event).not.toHaveProperty('project');
  });

  it('dibersihkan seperti message (kontrol, ANSI, bidi, spasi) dan dipotong 64 karakter', () => {
    expect(normalizeEvent({ ...base, project: '  ai-\u001b[31moffice\u202e \n x ' }).event.project).toBe('ai-office x');
    const long = normalizeEvent({ ...base, project: 'p'.repeat(200) }).event.project;
    expect(long.length).toBe(64);
  });

  it('bukan teks → ditolak', () => {
    expect(normalizeEvent({ ...base, project: 5 })).toMatchObject({ ok: false, error: '"project" wajib berupa teks' });
    expect(normalizeEvent({ ...base, project: { a: 1 } }).ok).toBe(false);
  });
});

describe('normalizeEvent: tokens', () => {
  it('angka finite ≥ 0 dibulatkan ke bawah; field hilang = 0; key lain dibuang', () => {
    expect(normalizeEvent({ ...base, tokens: { input: 1.9, output: 2, cacheRead: 0, extra: 5 } }).event.tokens).toEqual({ input: 1, output: 2, cacheRead: 0, cacheCreation: 0 });
    expect(normalizeEvent({ ...base, tokens: { input: 1e12 } }).event.tokens.input).toBe(1e12);
    expect(normalizeEvent(base).event).not.toHaveProperty('tokens');
  });

  it.each([
    ['negatif', { input: -1 }],
    ['NaN', { output: Number.NaN }],
    ['Infinity', { cacheRead: Number.POSITIVE_INFINITY }],
    ['> 1e12', { cacheCreation: 1e12 + 1 }],
    ['teks', { input: '5' }],
    ['array', [1, 2]],
    ['angka', 5],
  ])('%s → ditolak', (_l, tokens) => {
    expect(normalizeEvent({ ...base, tokens }).ok).toBe(false);
  });

  it('batch atomik: satu tokens rusak menggagalkan semua', () => {
    expect(normalizeBatch([base, { ...base, tokens: { input: -1 } }]).ok).toBe(false);
  });
});

describe('hookMapping: project dan tokens', () => {
  it('projectName: basename Windows/POSIX, dibersihkan, maks 64', () => {
    expect(projectName('C:\\Users\\alice\\ai-office')).toBe('ai-office');
    expect(projectName('C:/Users/alice/ai-office/')).toBe('ai-office');
    expect(projectName('/home/x/toko online')).toBe('toko online');
    expect(projectName('/x/\u001b[1mproyek\u200b')).toBe('proyek');
    expect(projectName('')).toBe('');
    expect(projectName(undefined)).toBe('');
    expect(projectName(`/x/${'a'.repeat(100)}`).length).toBeLessThanOrEqual(64);
  });

  it('project dari projectDir (CLAUDE_PROJECT_DIR) diutamakan, cadangan input.cwd', () => {
    const input = { hook_event_name: 'SubagentStart', agent_type: 'dev-qa', cwd: 'C:\\kerja\\toko' };
    expect(mapHookToEvents(input)[0].project).toBe('toko');
    expect(mapHookToEvents(input, { projectDir: 'C:\\Users\\alice\\ai-office' })[0].project).toBe('ai-office');
    expect(mapHookToEvents({ ...input, cwd: undefined })[0]).not.toHaveProperty('project');
  });

  it('tokens hanya ditempel ke event SubagentStop', () => {
    const tokens = { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 };
    const stop = mapHookToEvents({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: REPORT_BLOCKED }, { tokens });
    expect(stop[0]).toMatchObject({ type: 'blocked', tokens });
    const start = mapHookToEvents({ hook_event_name: 'SubagentStart', agent_type: 'dev-qa' }, { tokens });
    expect(start[0]).not.toHaveProperty('tokens');
    const post = mapHookToEvents({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa' }, tool_response: REPORT_DONE }, { tokens });
    expect(post[0]).not.toHaveProperty('tokens');
  });
});

describe('hooks/transcript-tokens.mjs', () => {
  it('jumlah usage baris assistant, dedup per message.id; baris user/rusak dilewati', () => {
    const p = join(TMP, 't1.jsonl');
    writeFileSync(p, jsonl(
      entry('user', 'Tugas'),
      usageEntry('msg_a', U(10, 20, 300, 40)),
      usageEntry('msg_a', U(10, 20, 300, 40)),
      usageEntry('msg_b', U(1, 2, 3, 4)),
      usageEntry('msg_u', U(999, 999), 'user'),
      '{"type":"assistant","message":{"usage":',
    ));
    expect(transcriptTokens(p)).toEqual({ input: 11, output: 22, cacheRead: 303, cacheCreation: 44 });
  });

  it('dibaca bertahap (potongan kecil) dan dibatasi N byte terakhir', () => {
    const p = join(TMP, 't2.jsonl');
    const lines = Array.from({ length: 50 }, (_, i) => usageEntry(`m${i}`, U(1, 0)));
    writeFileSync(p, jsonl(...lines));
    expect(transcriptTokens(p, 1e9, 64).input).toBe(50); // potongan 64 byte: baris melintasi potongan
    const one = Buffer.byteLength(`${lines[0]}\n`);
    const r = transcriptTokens(p, one * 10 + 5, 128); // ~10 baris terakhir, baris pertama potongan dibuang
    expect(r.input).toBeGreaterThanOrEqual(9);
    expect(r.input).toBeLessThanOrEqual(10);
  });

  it('tanpa baris usage → null; file kosong → null', () => {
    const p = join(TMP, 't3.jsonl');
    writeFileSync(p, jsonl(entry('user', 'x'), handback(REPORT_DONE)));
    expect(transcriptTokens(p)).toBeNull();
    writeFileSync(p, '');
    expect(transcriptTokens(p)).toBeNull();
  });
});

describe('server: dedup event identik dalam 3 detik', () => {
  let s;
  beforeAll(async () => {
    s = await startApp();
  });
  afterAll(() => s.close());
  const post = (body) => http(s.port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body });

  it('kiriman kedua yang identik dibuang diam-diam: 202, tidak masuk riwayat, tidak memakai id', async () => {
    const ev = { type: 'working', from: 'dev-qa', to: 'manager', message: 'Edit · a.js', project: 'ai-office', source: 'hook' };
    const before = s.app.history.length;
    const a = await post(ev);
    const b = await post(ev); // mis. hook level proyek + hook level user
    expect(a.status).toBe(202);
    expect(a.json).toMatchObject({ ok: true, accepted: 1 });
    expect(b.status).toBe(202);
    expect(b.json).toMatchObject({ ok: true, accepted: 0, ids: [], duplicates: 1 });
    expect(s.app.history.length - before).toBe(1);
    const c = await post({ type: 'working', from: 'dev-qa', to: 'manager', message: 'Edit · b.js', project: 'ai-office' });
    expect(c.json.ids[0]).toBe(a.json.ids[0] + 1); // id tidak terpakai oleh duplikat
  });

  it('beda type, from, to, message, atau project → bukan duplikat; dalam satu batch juga di-dedup', async () => {
    const ev = { type: 'done', from: 'dev-ui-critic', to: 'manager', message: 'x', project: 'p' };
    const r = await post([ev, ev, { ...ev, type: 'report' }, { ...ev, from: 'dev-docs' }, { ...ev, to: 'ceo' }, { ...ev, message: 'y' }, { ...ev, project: 'q' }, { ...ev, project: undefined }]);
    expect(r.json).toMatchObject({ accepted: 7, duplicates: 1 });
  });

  it('SubagentStop blocked + PostToolUse blocked dengan ringkasan sama → satu event', async () => {
    const stop = mapHookToEvents({ hook_event_name: 'SubagentStop', agent_type: 'dev-security', last_assistant_message: REPORT_BLOCKED, cwd: '/x/ai-office' });
    const postTool = mapHookToEvents({ hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-security' }, tool_response: REPORT_BLOCKED, cwd: '/x/ai-office' });
    expect((await post(stop)).json.accepted).toBe(1);
    expect((await post(postTool)).json).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('setelah 3 detik event yang sama diterima lagi', async () => {
    const t = await startApp({ dedupWindowMs: 150 });
    try {
      const ev = { type: 'assign', from: 'manager', to: 'dev-qa', message: 'ulang' };
      const p = (body) => http(t.port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body });
      expect((await p(ev)).json.accepted).toBe(1);
      expect((await p(ev)).json.accepted).toBe(0);
      await new Promise((r) => setTimeout(r, 200));
      expect((await p(ev)).json.accepted).toBe(1);
    } finally {
      await t.close();
    }
  });

  it('default jendela dedup 3 detik', async () => {
    const t = await startApp();
    try {
      const ev = { type: 'assign', from: 'manager', to: 'dev-qa', message: 'default' };
      const p = (body) => http(t.port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body });
      expect((await p(ev)).json.accepted).toBe(1);
      await new Promise((r) => setTimeout(r, 1000));
      expect((await p(ev)).json.accepted).toBe(0); // masih dalam 3 detik
    } finally {
      await t.close();
    }
  });
});

describe('hook (proses sungguhan): project, tokens, server mati', () => {
  let s;
  beforeAll(async () => {
    s = await startApp({ dedupWindowMs: 0 });
  });
  afterAll(() => s.close());

  it('SubagentStop: tokens dari agent_transcript_path dan project dari CLAUDE_PROJECT_DIR ikut terkirim', async () => {
    const p = join(TMP, 'agent.jsonl');
    writeFileSync(p, jsonl(
      entry('user', 'Tugas'),
      usageEntry('msg_1', U(3, 50, 1000, 200)),
      usageEntry('msg_1', U(3, 50, 1000, 200)),
      usageEntry('msg_2', U(2, 25, 2000, 0)),
      handback(REPORT_DONE),
      toolResult(),
    ));
    const before = s.app.history.length;
    const r = await runHook(
      { hook_event_name: 'SubagentStop', agent_type: 'dev-qa', agent_transcript_path: p, last_assistant_message: '' },
      { AI_OFFICE_URL: `${s.base}/api/events`, CLAUDE_PROJECT_DIR: 'C:\\Users\\x\\toko-online' },
    );
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    const evs = s.app.history.slice(before);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ type: 'done', from: 'dev-qa', project: 'toko-online', tokens: { input: 5, output: 75, cacheRead: 3000, cacheCreation: 200 } });
  });

  it('tanpa CLAUDE_PROJECT_DIR: project dari cwd; transkrip tanpa usage/hilang → tanpa tokens, tetap terkirim', async () => {
    const before = s.app.history.length;
    const r = await runHook(
      { hook_event_name: 'SubagentStop', agent_type: 'dev-qa', agent_transcript_path: join(TMP, 'hilang.jsonl'), last_assistant_message: REPORT_DONE, cwd: '/home/ceo/proyek-a' },
      { AI_OFFICE_URL: `${s.base}/api/events` },
    );
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    const [ev] = s.app.history.slice(before);
    expect(ev).toMatchObject({ type: 'done', project: 'proyek-a' });
    expect(ev).not.toHaveProperty('tokens');
  });

  it('server mati (ECONNREFUSED): exit 0, tanpa stdout/stderr, jauh di bawah 1 detik', async () => {
    const port = await freePort(); // port bebas = tidak ada yang mendengar
    const payloads = [
      { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description: 'x' } },
      { hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: REPORT_DONE },
      { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    ];
    // Waktu start Node sendiri (~100 ms, bisa jauh lebih lama saat seluruh suite berjalan paralel) diukur
    // sebagai pembanding. Bukti utama "tidak menunggu timeout": AI_OFFICE_TIMEOUT_MS dipasang 60 detik,
    // jadi hook yang keluar dalam hitungan ratusan ms pasti keluar karena ECONNREFUSED, bukan timeout.
    const times = [];
    let bestGap = Infinity;
    for (const payload of payloads) {
      for (const timeout of ['60000', undefined]) {
        const baseline = await runNode(['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { env: cleanEnv(), input: '{}' });
        const env = { AI_OFFICE_URL: `http://127.0.0.1:${port}/api/events` };
        if (timeout) env.AI_OFFICE_TIMEOUT_MS = timeout;
        const r = await runHook(payload, env);
        expect(r).toMatchObject({ code: 0, out: '', err: '', timedOut: false });
        expect(r.ms).toBeLessThan(baseline.ms + 3000); // relatif terhadap start Node kosong (stabil saat suite paralel); timeout 60 detik tidak ditunggu
        times.push(`${r.ms} (node kosong ${baseline.ms})`);
        bestGap = Math.min(bestGap, r.ms - baseline.ms);
      }
    }
    expect(bestGap).toBeLessThan(500);
    console.log(`[eventDedup.test] waktu keluar hook saat server mati (ms): ${times.join(', ')}`);
  });

  it('input apa pun → exit 0 tanpa output', async () => {
    const url = { AI_OFFICE_URL: `${s.base}/api/events` };
    for (const raw of ['', 'bukan json', '[]', 'null', '42', '{"hook_event_name":"SubagentStop","agent_type":"dev-qa","agent_transcript_path":5}', '{"hook_event_name":"SubagentStop","agent_type":"x","agent_transcript_path":"C:\\\\"}']) {
      const r = await runHook(raw, url);
      expect(r, raw).toMatchObject({ code: 0, out: '', err: '' });
    }
  });
});
