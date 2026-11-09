// GET /api/usage dan pesan WebSocket { kind: "usage" }: kontrak respons, auth mode token, siaran saat
// berubah, server tidak crash / tidak 500 walau tracker bermasalah. Folder log = folder sementara.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REASONS, createUsageTracker } from '../server/usage.js';
import WebSocket from 'ws';
import { JSON_HEADERS, http, randomToken, startApp } from './helpers/testkit.js';

const TMP = mkdtempSync(join(tmpdir(), 'aio-usage-api-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function logDir() {
  const base = join(TMP, `c${++n}`);
  const proj = join(base, 'projects', 'C--rahasia-proyek');
  mkdirSync(proj, { recursive: true });
  const usageLine = (id, input) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sesi-rahasia', message: { id, content: 'ISI-RAHASIA', usage: { input_tokens: input, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  writeFileSync(join(proj, 'sesi.jsonl'), `${usageLine('m1', 10)}\n`);
  const tracker = createUsageTracker({
    claudeDir: base,
    cacheFile: join(base, 'data', 'usage-cache.json'),
    agentsFile: join(base, 'data', 'usage-agents.json'),
    limitConfigFile: join(base, 'limit-config.json'),
    debounceMs: 50,
  });
  return { base, proj, tracker, usageLine };
}

const CONTRACT_KEYS = ['available', 'days', 'estimate', 'perAgent', 'reason', 'today', 'updatedAt', 'weekly'];

/** Buka WebSocket dan kumpulkan SEMUA pesan sejak awal (hello dan usage bisa tiba dalam satu tick). */
function wsConnect(port, { headers = {} } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers });
    const messages = [];
    ws.on('message', (m) => {
      messages.push(JSON.parse(m.toString()));
      if (messages.length === 1) resolve({ status: 101, ws, hello: messages[0], messages });
    });
    ws.on('error', () => resolve({ status: 'error' }));
    ws.on('unexpected-response', (_req, res) => resolve({ status: res.statusCode }));
  });
}

describe('GET /api/usage (mode lokal)', () => {
  let s;
  let d;
  beforeAll(async () => {
    d = logDir();
    s = await startApp({ usage: d.tracker });
    // Tunggu pemindaian pertama (dimulai saat listen).
    for (let i = 0; i < 100 && !(await http(s.port, '/api/usage')).json.usage.available; i++) await new Promise((r) => setTimeout(r, 50));
  });
  afterAll(() => s.close());

  it('200 dengan bentuk kontrak; angka dari log; tidak ada path/isi pesan/nama sesi', async () => {
    const r = await http(s.port, '/api/usage');
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    const u = r.json.usage;
    expect(Object.keys(u).sort()).toEqual(CONTRACT_KEYS);
    expect(u).toMatchObject({ available: true, reason: null, estimate: true });
    expect(u.today).toMatchObject({ input: 10, output: 1, total: 11 });
    expect(u.days).toHaveLength(7);
    expect(Number.isNaN(Date.parse(u.updatedAt))).toBe(false);
    for (const bad of ['RAHASIA', 'rahasia', d.base, '.jsonl']) expect(r.body).not.toContain(bad);
  });

  it('log server tidak memuat path log, nama sesi, atau isi pesan', () => {
    for (const l of s.logs) for (const bad of [d.base, 'rahasia', 'RAHASIA', '.jsonl']) expect(l).not.toContain(bad);
  });

  it('method selain GET → 405', async () => {
    const r = await http(s.port, '/api/usage', { method: 'POST', headers: JSON_HEADERS, body: '{}' });
    expect(r.status).toBe(405);
  });

  it('WS: { kind: "usage" } dikirim setelah hello, lalu dikirim lagi saat event bertoken masuk', async () => {
    const c = await wsConnect(s.port);
    expect(c.status).toBe(101);
    expect(c.hello.kind).toBe('hello');
    const { messages } = c;
    await expect.poll(() => messages.find((m) => m.kind === 'usage'), { timeout: 3000 }).toBeTruthy();
    expect(messages[1].kind).toBe('usage'); // langsung sesudah hello
    expect(Object.keys(messages.find((m) => m.kind === 'usage').usage).sort()).toEqual(CONTRACT_KEYS);
    const post = await http(s.port, '/api/events', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: { type: 'done', from: 'dev-qa', to: 'manager', message: 'selesai', tokens: { input: 5, output: 6, cacheRead: 7, cacheCreation: 8 } },
    });
    expect(post.status).toBe(202);
    await expect.poll(() => messages.filter((m) => m.kind === 'usage').at(-1)?.usage.perAgent[0]?.agent, { timeout: 3000 }).toBe('dev-qa');
    expect(messages.filter((m) => m.kind === 'usage').at(-1).usage.perAgent[0]).toEqual({ agent: 'dev-qa', input: 5, output: 6, cacheRead: 7, cacheCreation: 8, total: 26, runs: 1 });
    // Log bertambah lalu event bertoken → pemindaian ulang (debounce) → siaran dengan angka baru.
    writeFileSync(join(d.proj, 'sesi2.jsonl'), `${d.usageLine('m2', 100)}\n`);
    await http(s.port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body: { type: 'done', from: 'dev-qa', to: 'manager', message: 'lagi', tokens: { input: 1 } } });
    await expect.poll(() => messages.filter((m) => m.kind === 'usage').at(-1)?.usage.today.input, { timeout: 4000 }).toBe(110);
    // Event biasa tetap { kind: "event" } (klien lama hanya memproses hello/event).
    expect(messages.some((m) => m.kind === 'event' && m.event.tokens?.input === 5)).toBe(true);
    c.ws.close();
  });
});

describe('GET /api/usage mode token: auth sama dengan GET /api/events', () => {
  const TOKEN = randomToken();
  let s;
  beforeAll(async () => {
    s = await startApp({ token: TOKEN, usage: logDir().tracker });
  });
  afterAll(() => s.close());

  it('tanpa token → 401 (tanpa data); dengan Bearer → 200', async () => {
    const no = await http(s.port, '/api/usage');
    expect(no.status).toBe(401);
    expect(no.body).not.toContain('today');
    const ev = await http(s.port, '/api/events');
    expect(ev.status).toBe(401);
    const yes = await http(s.port, '/api/usage', { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(yes.status).toBe(200);
    expect(Object.keys(yes.json.usage).sort()).toEqual(CONTRACT_KEYS);
  });

  it('WS dengan token menerima usage setelah hello', async () => {
    const c = await wsConnect(s.port, { headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(c.status).toBe(101);
    await expect.poll(() => c.messages.some((m) => m.kind === 'usage'), { timeout: 3000 }).toBe(true);
    c.ws.close();
  });
});

describe('/api/usage tanpa tracker atau tracker bermasalah: tidak pernah 500', () => {
  it('tanpa opsi usage → 200, available false "tidak aktif"; WS tidak mengirim usage', async () => {
    const s = await startApp();
    try {
      const r = await http(s.port, '/api/usage');
      expect(r.status).toBe(200);
      expect(Object.keys(r.json.usage).sort()).toEqual(CONTRACT_KEYS);
      expect(r.json.usage).toMatchObject({ available: false, reason: REASONS.disabled });
      const c = await wsConnect(s.port);
      await new Promise((r2) => setTimeout(r2, 200));
      expect(c.messages.some((m) => m.kind === 'usage')).toBe(false);
      c.ws.close();
    } finally {
      await s.close();
    }
  });

  it('folder log hilang → 200 available false dengan alasan', async () => {
    const t = createUsageTracker({ claudeDir: join(TMP, 'tidak-ada'), cacheFile: null, agentsFile: null, limitConfigFile: join(TMP, 'x.json') });
    const s = await startApp({ usage: t });
    try {
      await expect.poll(async () => (await http(s.port, '/api/usage')).json.usage.reason, { timeout: 3000 }).toBe(REASONS.missing);
    } finally {
      await s.close();
    }
  });

  it('snapshot melempar → 200 available false; POST event tetap 202', async () => {
    const broken = {
      start() {},
      stop() {},
      onChange: () => () => {},
      snapshot() {
        throw new Error('rusak');
      },
      recordEvents() {
        throw new Error('rusak');
      },
    };
    const s = await startApp({ usage: broken });
    try {
      const r = await http(s.port, '/api/usage');
      expect(r.status).toBe(200);
      expect(r.json.usage).toMatchObject({ available: false, reason: REASONS.error });
      const p = await http(s.port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body: { type: 'done', from: 'a', to: 'b', tokens: { input: 1 } } });
      expect(p.status).toBe(202);
      const c = await wsConnect(s.port);
      expect(c.status).toBe(101); // hello tetap terkirim
      c.ws.close();
    } finally {
      await s.close();
    }
  });
});
