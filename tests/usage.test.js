// Statistik pemakaian (server/usage.js): parser log, dedup, baca inkremental, baris terpotong, file
// truncate, format tak dikenal, folder hilang, anggaran per siklus, cache, konfigurasi limit, token per
// agen, dan data contoh tests/fixtures/usage-sample. Semua memakai folder sementara; ~/.claude asli dan
// data/ proyek tidak pernah disentuh.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildSample, SAMPLE_DIR } from '../scripts/make-usage-sample.mjs';
import {
  REASONS, aggregateAgents, buildUsage, createUsageTracker, dateKey, hourKey, levelOf, normalizeLimitConfig, readLimitConfig,
  usageOptionsFromEnv, weekWindowStart,
} from '../server/usage.js';
import { createTranscriptTokenSum, usageId, usageOf } from '../shared/tokenUsage.js';

const ROOT_TMP = mkdtempSync(join(tmpdir(), 'aio-usage-'));
afterAll(() => rmSync(ROOT_TMP, { recursive: true, force: true }));

// "Sekarang" dipatok: Senin 9 Nov 2026 15:30 waktu lokal.
const NOW = new Date(2026, 10, 9, 15, 30);
const at = (daysAgo, hour = 10, min = 0) => new Date(2026, 10, 9 - daysAgo, hour, min);
const day = (daysAgo) => dateKey(at(daysAgo));

/** Satu baris log assistant dengan usage. */
function line({ id, ts = at(0), input = 0, output = 0, cacheRead = 0, cacheCreation = 0, type = 'assistant', requestId, uuid, noMessageId = false }) {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'RAHASIA-ISI-PESAN' }], usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation } };
  if (!noMessageId) message.id = id;
  const o = { type, timestamp: ts.toISOString(), sessionId: 'sesi-rahasia', cwd: 'C:\\proyek-rahasia', message };
  if (requestId) o.requestId = requestId;
  if (uuid) o.uuid = uuid;
  return JSON.stringify(o);
}
const userLine = (ts = at(0)) => JSON.stringify({ type: 'user', timestamp: ts.toISOString(), message: { role: 'user', content: 'halo' } });

let n = 0;
/** Folder log baru: <tmp>/claude-N/projects/<proj>/... dan tracker yang menunjuk ke sana. */
function setup(opts = {}) {
  const base = join(ROOT_TMP, `claude-${++n}`);
  const proj = join(base, 'projects', 'C--proyek-rahasia');
  mkdirSync(join(proj, 'sesi-rahasia', 'subagents'), { recursive: true });
  const data = join(base, 'data');
  const write = (rel, text) => {
    const p = join(proj, rel);
    writeFileSync(p, text);
    return p;
  };
  const append = (rel, text) => appendFileSync(join(proj, rel), text);
  const make = (more = {}) =>
    createUsageTracker({
      claudeDir: base,
      cacheFile: join(data, 'usage-cache.json'),
      agentsFile: join(data, 'usage-agents.json'),
      limitConfigFile: join(base, 'limit-config.json'),
      now: () => NOW,
      ...opts,
      ...more,
    });
  return { base, proj, data, write, append, make, tracker: make() };
}

const todayOf = (u) => u.days.at(-1);

describe('shared/tokenUsage.js', () => {
  it('usageOf: angka dikenali, nilai aneh jadi 0, tanpa usage = null', () => {
    expect(usageOf(JSON.parse(line({ id: 'a', input: 1, output: 2, cacheRead: 3, cacheCreation: 4 })))).toEqual({ input: 1, output: 2, cacheRead: 3, cacheCreation: 4 });
    expect(usageOf({ message: { usage: { input_tokens: -5, output_tokens: 'x', cache_read_input_tokens: 2.7 } } })).toEqual({ input: 0, output: 0, cacheRead: 2, cacheCreation: 0 });
    expect(usageOf({ message: { usage: { tokens: 5 } } })).toBeNull();
    expect(usageOf({ message: {} })).toBeNull();
    expect(usageOf(null)).toBeNull();
  });

  it('usageId: message.id, lalu requestId, lalu uuid', () => {
    expect(usageId({ message: { id: 'm' }, requestId: 'r', uuid: 'u' })).toBe('m');
    expect(usageId({ message: {}, requestId: 'r', uuid: 'u' })).toBe('r');
    expect(usageId({ uuid: 'u' })).toBe('u');
    expect(usageId({})).toBeNull();
  });

  it('createTranscriptTokenSum: hanya baris assistant, dedup per id, baris rusak dilewati', () => {
    const s = createTranscriptTokenSum();
    s.addLine(line({ id: 'x', input: 10, output: 5 }));
    s.addLine(line({ id: 'x', input: 10, output: 5 })); // baris streaming kedua
    s.addLine(Buffer.from(line({ id: 'y', cacheRead: 100 })));
    s.addLine(line({ id: 'z', input: 999, type: 'user' })); // bukan assistant
    s.addLine('{"type":"assistant","message":{"usage"'); // rusak
    expect(s.result()).toEqual({ input: 10, output: 5, cacheRead: 100, cacheCreation: 0 });
    expect(createTranscriptTokenSum().result()).toBeNull();
  });
});

describe('parser log dan dedup', () => {
  it('pesan yang sama di beberapa baris, beberapa file, dan subagents/ dihitung sekali', async () => {
    const s = setup();
    const a = line({ id: 'msg_1', input: 10, output: 100, cacheRead: 1000, cacheCreation: 200 });
    s.write('sesi-rahasia.jsonl', [userLine(), a, a, line({ id: 'msg_2', output: 7 })].join('\n') + '\n');
    s.write('sesi-rahasia/subagents/agent-1.jsonl', [line({ id: 'msg_3', input: 1 }), a].join('\n') + '\n');
    s.write('resume.jsonl', `${a}\n`); // sesi yang di-resume mengulang pesan lama
    const u = await s.tracker.scan();
    expect(u.available).toBe(true);
    expect(u.today).toEqual({ date: day(0), input: 11, output: 107, cacheRead: 1000, cacheCreation: 200, total: 1318 });
  });

  it('tanpa message.id: dedup memakai requestId, lalu uuid', async () => {
    const s = setup();
    const r = line({ noMessageId: true, requestId: 'req_1', input: 5 });
    const u1 = line({ noMessageId: true, uuid: 'uuid-1', output: 3 });
    s.write('a.jsonl', [r, r, u1, u1].join('\n') + '\n');
    const u = await s.tracker.scan();
    expect(u.today).toMatchObject({ input: 5, output: 3, total: 8 });
  });

  it('hari dihitung dari timestamp dalam zona waktu lokal; 7 hari urut lama → baru, hari kosong 0', async () => {
    const s = setup();
    s.write('a.jsonl', [
      line({ id: 'd0', ts: at(0, 0, 5), output: 1 }),
      line({ id: 'd2', ts: at(2, 23, 59), output: 20 }),
      line({ id: 'd6', ts: at(6, 12), output: 600 }),
      line({ id: 'd7', ts: at(7, 12), output: 7000 }), // di luar 7 hari
      line({ id: 'd30', ts: at(30, 12), output: 30000 }), // di luar retensi: dilewati
    ].join('\n') + '\n');
    const u = await s.tracker.scan();
    expect(u.days.map((d) => d.date)).toEqual([6, 5, 4, 3, 2, 1, 0].map(day));
    expect(u.days.map((d) => d.output)).toEqual([600, 0, 0, 0, 20, 0, 1]);
    expect(u.today.date).toBe(day(0));
    for (const d of u.days) expect(d.total).toBe(d.input + d.output + d.cacheRead + d.cacheCreation);
  });

  it('respons dan cache tidak memuat path, isi pesan, atau nama sesi', async () => {
    const s = setup();
    s.write('sesi-rahasia.jsonl', `${line({ id: 'p1', input: 1 })}\n`);
    const u = await s.tracker.scan();
    const text = JSON.stringify(u);
    for (const bad of ['RAHASIA', 'rahasia', s.base, 'projects', '.jsonl', 'C:\\']) expect(text).not.toContain(bad);
    const cache = readFileSync(join(s.data, 'usage-cache.json'), 'utf8');
    for (const bad of ['RAHASIA', 'rahasia', 'proyek', '.jsonl']) expect(cache).not.toContain(bad);
  });
});

describe('baca inkremental', () => {
  it('hanya byte baru yang dibaca: baris lama yang diubah di tempat tidak dihitung ulang', async () => {
    const s = setup();
    const filler = userLine(); // > 256 byte bersama baris berikut, supaya sidik jari awal tidak berubah
    const old = line({ id: 'lama', input: 100 });
    s.write('a.jsonl', `${filler}\n${filler}\n${filler}\n${old}\n`);
    expect((await s.tracker.scan()).today.input).toBe(100);
    // Ubah baris lama di tempat (panjang sama) lalu tambah baris baru.
    const p = join(s.proj, 'a.jsonl');
    const changed = readFileSync(p, 'utf8').replace(old, old.replace('"input_tokens":100', '"input_tokens":900'));
    writeFileSync(p, changed);
    appendFileSync(p, `${line({ id: 'baru', input: 5 })}\n`);
    const u = await s.tracker.scan();
    expect(u.today.input).toBe(105); // 100 lama + 5 baru (900 tidak terbaca)
  });

  it('baris terakhir yang belum lengkap tidak dikonsumsi sampai lengkap, lalu dihitung sekali', async () => {
    const s = setup();
    const full = line({ id: 'potong', output: 42 });
    s.write('a.jsonl', `${line({ id: 'utuh', output: 1 })}\n${full.slice(0, 40)}`);
    expect((await s.tracker.scan()).today.output).toBe(1);
    s.append('a.jsonl', full.slice(40)); // masih tanpa "\n"
    expect((await s.tracker.scan()).today.output).toBe(1);
    s.append('a.jsonl', '\n');
    expect((await s.tracker.scan()).today.output).toBe(43);
    expect((await s.tracker.scan()).today.output).toBe(43);
  });

  it('file mengecil (truncate/rewrite): dibaca ulang, id lama tidak dobel', async () => {
    const s = setup();
    const a = line({ id: 'a', input: 1 });
    const b = line({ id: 'b', input: 10 });
    s.write('a.jsonl', `${a}\n${b}\n${line({ id: 'c', input: 100 })}\n`);
    expect((await s.tracker.scan()).today.input).toBe(111);
    s.write('a.jsonl', `${b}\n${line({ id: 'd', input: 1000 })}\n`); // lebih kecil
    expect((await s.tracker.scan()).today.input).toBe(1111);
  });

  it('file ditulis ulang dengan ukuran lebih besar dan awal berbeda: dibaca ulang', async () => {
    const s = setup();
    s.write('a.jsonl', `${line({ id: 'a', input: 1 })}\n`);
    expect((await s.tracker.scan()).today.input).toBe(1);
    s.write('a.jsonl', `${line({ id: 'x', input: 20 })}\n${line({ id: 'a', input: 1 })}\n${line({ id: 'y', input: 300 })}\n`);
    expect((await s.tracker.scan()).today.input).toBe(321);
  });

  it('anggaran byte per siklus: sisa dilanjutkan di siklus berikutnya, hasil akhir sama', async () => {
    const lines = Array.from({ length: 200 }, (_, i) => line({ id: `m${i}`, output: 1 }));
    const s = setup({ maxBytesPerCycle: 4096 });
    s.write('a.jsonl', `${lines.join('\n')}\n`);
    s.write('b.jsonl', `${lines.slice(0, 50).join('\n')}\n`); // duplikat: tidak menambah
    const first = await s.tracker.scan();
    expect(first.today.output).toBeGreaterThan(0);
    expect(first.today.output).toBeLessThan(200);
    const all = await s.tracker.scanAll();
    expect(all.today.output).toBe(200);
  });

  it('file yang tidak berubah sejak sebelum window retensi tidak dibaca', async () => {
    const s = setup();
    const p = s.write('lama.jsonl', `${line({ id: 'x', input: 77 })}\n`);
    const old = (NOW.getTime() - 20 * 86400_000) / 1000;
    utimesSync(p, old, old);
    s.write('baru.jsonl', `${line({ id: 'y', input: 1 })}\n`);
    expect((await s.tracker.scan()).today.input).toBe(1);
    // Ditambah sesudahnya (sesi lama di-resume): hanya bagian baru yang dibaca.
    appendFileSync(p, `${line({ id: 'z', input: 1000 })}\n`);
    expect((await s.tracker.scan()).today.input).toBe(1001);
  });

  it('cache disimpan ke file dan dipakai ulang tanpa menghitung dobel; cache folder lain diabaikan', async () => {
    const s = setup();
    s.write('a.jsonl', `${line({ id: 'a', input: 5 })}\n`);
    await s.tracker.scan();
    expect(existsSync(join(s.data, 'usage-cache.json'))).toBe(true);
    const again = s.make();
    await again.load();
    expect(again.snapshot().today.input).toBe(5); // langsung dari cache, sebelum memindai
    s.append('a.jsonl', `${line({ id: 'b', input: 10 })}\n`);
    expect((await again.scan()).today.input).toBe(15);
    // Cache yang sama, folder log lain: diabaikan (folder lain kosong).
    const other = join(ROOT_TMP, `lain-${++n}`);
    mkdirSync(join(other, 'projects'), { recursive: true });
    const t3 = createUsageTracker({ claudeDir: other, cacheFile: join(s.data, 'usage-cache.json'), agentsFile: null, limitConfigFile: join(other, 'x.json'), now: () => NOW });
    expect((await t3.scan()).reason).toBe(REASONS.empty);
  });

  it('cache rusak diabaikan tanpa crash', async () => {
    const s = setup();
    mkdirSync(s.data, { recursive: true });
    writeFileSync(join(s.data, 'usage-cache.json'), '{rusak');
    writeFileSync(join(s.data, 'usage-agents.json'), '[1,2');
    s.write('a.jsonl', `${line({ id: 'a', input: 5 })}\n`);
    const t = s.make();
    expect((await t.scan()).today.input).toBe(5);
  });
});

describe('ketersediaan data (available / reason)', () => {
  const shapeOk = (u) => {
    expect(Object.keys(u).sort()).toEqual(['available', 'days', 'estimate', 'perAgent', 'reason', 'today', 'updatedAt', 'weekly']);
    expect(u.estimate).toBe(true);
    expect(u.days).toHaveLength(7);
    expect(Object.keys(u.today).sort()).toEqual(['cacheCreation', 'cacheRead', 'date', 'input', 'output', 'total']);
    expect(Object.keys(u.weekly).sort()).toEqual(['configAvailable', 'level', 'limit', 'percent', 'used', 'windowStart']);
    expect(Number.isNaN(Date.parse(u.weekly.windowStart))).toBe(false);
  };

  it('folder log tidak ada → available false, alasan berbahasa Indonesia, field lain 0/null', async () => {
    const t = createUsageTracker({ claudeDir: join(ROOT_TMP, 'tidak-ada'), cacheFile: null, agentsFile: null, limitConfigFile: join(ROOT_TMP, 'x.json'), now: () => NOW });
    const u = await t.scan();
    shapeOk(u);
    expect(u).toMatchObject({ available: false, reason: REASONS.missing });
    expect(u.days.every((d) => d.total === 0)).toBe(true);
    expect(u.weekly).toMatchObject({ used: 0, percent: null, level: null });
  });

  it('folder kosong → "Belum ada file log"', async () => {
    const base = join(ROOT_TMP, `kosong-${++n}`);
    mkdirSync(join(base, 'projects'), { recursive: true });
    const t = createUsageTracker({ claudeDir: base, cacheFile: null, agentsFile: null, limitConfigFile: join(base, 'x.json'), now: () => NOW });
    const u = await t.scan();
    shapeOk(u);
    expect(u).toMatchObject({ available: false, reason: REASONS.empty });
  });

  it('format tak dikenal (tidak ada satu baris usage pun) → available false', async () => {
    const s = setup();
    const lines = Array.from({ length: 30 }, (_, i) => JSON.stringify({ type: 'assistant', timestamp: at(0).toISOString(), message: { id: `x${i}`, tokens: { in: 5 } } }));
    s.write('a.jsonl', `${lines.join('\n')}\n`);
    const u = await s.tracker.scan();
    shapeOk(u);
    expect(u).toMatchObject({ available: false, reason: REASONS.format });
    expect(u.today.total).toBe(0);
  });

  it('sebelum pemindaian pertama → "sedang dihitung"; snapshot tidak pernah melempar', () => {
    const s = setup();
    const u = s.tracker.snapshot();
    shapeOk(u);
    expect(u).toMatchObject({ available: false, reason: REASONS.pending, updatedAt: null });
  });

  it('AI_OFFICE_CLAUDE_DIR tanpa subfolder projects/: folder itu sendiri dipindai', async () => {
    const dir = join(ROOT_TMP, `langsung-${++n}`, 'sesi');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.jsonl'), `${line({ id: 'q', input: 3 })}\n`);
    const opts = usageOptionsFromEnv({ AI_OFFICE_CLAUDE_DIR: join(dir, '..'), AI_OFFICE_LIMIT_CONFIG: join(dir, 'cfg.json') });
    expect(opts).toMatchObject({ claudeDirExplicit: true, limitConfigFile: join(dir, 'cfg.json') });
    const t = createUsageTracker({ ...opts, cacheFile: null, agentsFile: null, now: () => NOW });
    expect((await t.scan()).today.input).toBe(3);
  });
});

describe('limit mingguan dan konfigurasi', () => {
  it('normalizeLimitConfig: nilai tidak sah jatuh ke default', () => {
    expect(normalizeLimitConfig({ weeklyTokenLimit: 0, weekResetDay: null })).toEqual({ weeklyTokenLimit: null, weekResetDay: null, weekResetHour: 0, countCacheRead: false });
    expect(normalizeLimitConfig({ weeklyTokenLimit: 5e6, weekResetDay: 1, weekResetHour: 9, countCacheRead: true })).toEqual({ weeklyTokenLimit: 5e6, weekResetDay: 1, weekResetHour: 9, countCacheRead: true });
    expect(normalizeLimitConfig({ weeklyTokenLimit: -1, weekResetDay: 7, weekResetHour: 24, countCacheRead: 'ya' })).toEqual({ weeklyTokenLimit: null, weekResetDay: null, weekResetHour: 0, countCacheRead: false });
    expect(normalizeLimitConfig([])).toBeNull();
    expect(normalizeLimitConfig(null)).toBeNull();
  });

  it('readLimitConfig: file hilang atau JSON rusak → null tanpa melempar', async () => {
    const f = join(ROOT_TMP, `cfg-${++n}.json`);
    expect(await readLimitConfig(f)).toBeNull();
    writeFileSync(f, '{ rusak');
    expect(await readLimitConfig(f)).toBeNull();
    writeFileSync(f, '\uFEFF{"weeklyTokenLimit": 100}');
    expect(await readLimitConfig(f)).toMatchObject({ weeklyTokenLimit: 100 });
  });

  it('level: hijau < 60%, kuning 60–85%, merah > 85%', () => {
    expect([0, 59.9, 60, 85, 85.1, 120].map(levelOf)).toEqual(['green', 'green', 'yellow', 'yellow', 'red', 'red']);
    expect(levelOf(null)).toBeNull();
  });

  it('weekWindowStart: bergulir 7 hari atau sejak hari/jam reset terakhir', () => {
    expect(weekWindowStart(NOW, null)).toBe(new Date(2026, 10, 2, 15).getTime());
    // NOW = Senin 15:30. Reset Senin 09:00 → hari ini 09:00; reset Senin 18:00 → Senin lalu 18:00.
    expect(weekWindowStart(NOW, { weekResetDay: 1, weekResetHour: 9 })).toBe(new Date(2026, 10, 9, 9).getTime());
    expect(weekWindowStart(NOW, { weekResetDay: 1, weekResetHour: 18 })).toBe(new Date(2026, 10, 2, 18).getTime());
    expect(weekWindowStart(NOW, { weekResetDay: 0, weekResetHour: 0 })).toBe(new Date(2026, 10, 8, 0).getTime());
  });

  it('mingguan: cacheRead hanya ikut bila countCacheRead; persen dan level dari limit; konfigurasi dibaca ulang tiap siklus', async () => {
    const s = setup();
    s.write('a.jsonl', `${line({ id: 'w', ts: at(1), input: 100, output: 400, cacheRead: 10_000, cacheCreation: 500 })}\n`);
    const cfg = (o) => writeFileSync(join(s.base, 'limit-config.json'), JSON.stringify(o));
    let u = await s.tracker.scan();
    expect(u.weekly).toMatchObject({ used: 1000, limit: null, percent: null, level: null, configAvailable: false });
    cfg({ weeklyTokenLimit: 2000, weekResetDay: null, weekResetHour: 0, countCacheRead: false });
    u = await s.tracker.scan();
    expect(u.weekly).toMatchObject({ used: 1000, limit: 2000, percent: 50, level: 'green', configAvailable: true });
    cfg({ weeklyTokenLimit: 1500, countCacheRead: false });
    expect((await s.tracker.scan()).weekly).toMatchObject({ percent: 66.7, level: 'yellow' });
    cfg({ weeklyTokenLimit: 12_000, countCacheRead: true });
    expect((await s.tracker.scan()).weekly).toMatchObject({ used: 11_000, percent: 91.7, level: 'red' });
    // Reset mingguan hari ini (Senin 09:00): pemakaian kemarin tidak masuk window.
    cfg({ weeklyTokenLimit: 12_000, weekResetDay: 1, weekResetHour: 9, countCacheRead: true });
    u = await s.tracker.scan();
    expect(u.weekly).toMatchObject({ used: 0, percent: 0, level: 'green', windowStart: new Date(2026, 10, 9, 9).toISOString() });
    writeFileSync(join(s.base, 'limit-config.json'), '{ rusak');
    u = await s.tracker.scan();
    expect(u.available).toBe(true);
    expect(u.weekly).toMatchObject({ limit: null, percent: null, level: null, configAvailable: false, used: 1000 });
  });

  it('buildUsage: total = input + output + cacheCreation + cacheRead; jam di luar window tidak masuk mingguan', () => {
    const hours = {
      [hourKey(at(0, 9))]: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
      [hourKey(at(0, 11))]: { input: 10, output: 0, cacheRead: 0, cacheCreation: 0 },
      [hourKey(at(8, 11))]: { input: 999, output: 0, cacheRead: 0, cacheCreation: 0 },
    };
    const u = buildUsage({ now: NOW, hours, config: normalizeLimitConfig({ weeklyTokenLimit: 100 }) });
    expect(u.today).toEqual({ date: day(0), input: 11, output: 2, cacheRead: 3, cacheCreation: 4, total: 20 });
    expect(u.weekly).toMatchObject({ used: 17, limit: 100, percent: 17, level: 'green' });
  });
});

describe('token per agen (dari event hook)', () => {
  it('recordEvents: dijumlah per agen, urut menurun, runs dihitung; event tanpa tokens diabaikan', () => {
    const s = setup();
    s.tracker.recordEvents([
      { type: 'done', from: 'dev-qa', to: 'manager', tokens: { input: 10, output: 20, cacheRead: 300, cacheCreation: 40 } },
      { type: 'done', from: 'dev-backend', to: 'manager', tokens: { input: 1000, output: 0, cacheRead: 0, cacheCreation: 0 } },
      { type: 'blocked', from: 'dev-qa', to: 'manager', tokens: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 } },
      { type: 'working', from: 'dev-frontend', to: 'manager' },
    ]);
    expect(s.tracker.snapshot().perAgent).toEqual([
      { agent: 'dev-backend', input: 1000, output: 0, cacheRead: 0, cacheCreation: 0, total: 1000, runs: 1 },
      { agent: 'dev-qa', input: 11, output: 21, cacheRead: 301, cacheCreation: 41, total: 374, runs: 2 },
    ]);
  });

  it('window 7 hari', () => {
    const nowMs = NOW.getTime();
    const rec = (t, agent) => ({ t, agent, input: 1, output: 0, cacheRead: 0, cacheCreation: 0 });
    expect(aggregateAgents([rec(nowMs - 8 * 86400_000, 'dev-qa'), rec(nowMs - 86400_000, 'dev-docs')], nowMs).map((a) => a.agent)).toEqual(['dev-docs']);
  });

  it('disimpan ke usage-agents.json dan dimuat lagi setelah restart', async () => {
    const s = setup();
    s.tracker.recordEvents([{ type: 'done', from: 'dev-docs', to: 'manager', tokens: { input: 3, output: 4, cacheRead: 5, cacheCreation: 6 } }]);
    await s.tracker.stop(); // menyimpan yang tertunda
    const file = join(s.data, 'usage-agents.json');
    expect(JSON.parse(readFileSync(file, 'utf8')).records).toHaveLength(1);
    const again = s.make();
    await again.load();
    expect(again.snapshot().perAgent).toEqual([{ agent: 'dev-docs', input: 3, output: 4, cacheRead: 5, cacheCreation: 6, total: 18, runs: 1 }]);
  });
});

describe('jadwal', () => {
  it('event bertoken memicu pemindaian setelah debounce; onChange dipanggil saat hasil berubah', async () => {
    const s = setup({ debounceMs: 50, intervalMs: 60_000 });
    s.write('a.jsonl', `${line({ id: 'a', input: 1 })}\n`);
    const changes = [];
    s.tracker.onChange((u) => changes.push(u));
    s.tracker.start();
    try {
      await expect.poll(() => changes.at(-1)?.today.input, { timeout: 3000 }).toBe(1);
      s.append('a.jsonl', `${line({ id: 'b', input: 10 })}\n`);
      s.tracker.recordEvents([{ type: 'done', from: 'dev-qa', to: 'manager', tokens: { input: 1, output: 0, cacheRead: 0, cacheCreation: 0 } }]);
      await expect.poll(() => changes.at(-1)?.today.input, { timeout: 3000 }).toBe(11);
      expect(changes.at(-1).perAgent[0]).toMatchObject({ agent: 'dev-qa', runs: 1 });
    } finally {
      await s.tracker.stop();
    }
  });
});

describe('data contoh tests/fixtures/usage-sample', () => {
  it('terbaca: 7 hari sesuai buildSample, dedup dan baris rusak/terpotong ditangani', async () => {
    const base = new Date(2026, 10, 9, 18);
    const t = createUsageTracker({ claudeDir: SAMPLE_DIR, claudeDirExplicit: true, cacheFile: null, agentsFile: null, limitConfigFile: join(ROOT_TMP, 'x.json'), now: () => base });
    const u = await t.scan();
    expect(u.available).toBe(true);
    const { expected } = buildSample(base);
    expect(Object.keys(expected)).toHaveLength(7);
    for (const d of u.days) expect(d, d.date).toMatchObject(expected[d.date]);
    expect(u.today.total).toBeGreaterThan(0);
  });

  it('dibuat ulang relatif ke hari lain: hasil tetap cocok', async () => {
    const dir = join(ROOT_TMP, `sample-${++n}`);
    const { writeSample } = await import('../scripts/make-usage-sample.mjs');
    const base = new Date(2027, 1, 3, 12);
    const expected = writeSample(dir, base);
    const t = createUsageTracker({ claudeDir: dir, cacheFile: null, agentsFile: null, limitConfigFile: join(dir, 'x.json'), now: () => base });
    const u = await t.scan();
    for (const d of u.days) expect(d, d.date).toMatchObject(expected[d.date]);
  });
});
