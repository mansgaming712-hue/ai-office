// Gerbang QA (update: hook level user, statistik pemakaian, divisi 3D, UI usage).
// Menutup celah yang tidak ditangkap test lain: hook dengan input/transkrip aneh, pemasang hook dengan
// hook user bermatcher sama, usage dengan nilai/cache/konfigurasi aneh, dan batas level.
// Test berjudul "Bx (diperbaiki)" mengunci perilaku yang benar setelah bug B1-B4 diperbaiki (putaran 2).
// Semua file/folder sementara; ~/.claude asli, limit-config.json asli, dan port 3000 tidak disentuh.
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { transcriptTokens } from '../hooks/transcript-tokens.mjs';
import { projectName } from '../shared/hookMapping.js';
import { buildUsage, createUsageTracker, dateKey } from '../server/usage.js';
import { levelFor } from '../src/usage.js';
import { cleanEnv, freePort, http, runHook, runNode, startApp } from './helpers/testkit.js';

const TMP = mkdtempSync(join(tmpdir(), 'aio-qagate-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));
let n = 0;
const dir = (name = 'd') => {
  const d = join(TMP, `${name}${++n}`);
  mkdirSync(d, { recursive: true });
  return d;
};

// ------------------------------------------------------------------------------------------ hook
describe('hook: input dan transkrip aneh (proses sungguhan, server mati)', () => {
  let dead;
  const env = async () => {
    dead ??= `http://127.0.0.1:${await freePort(3350, 3399)}/api/events`; // tidak ada yang mendengarkan
    return { AI_OFFICE_URL: dead };
  };
  const stop = (extra = {}) => ({ hook_event_name: 'SubagentStop', agent_type: 'dev-qa', last_assistant_message: '', ...extra });
  const line = (i) => `${JSON.stringify({ type: 'assistant', message: { id: `m${i}`, usage: { input_tokens: 1, output_tokens: 2 } } })}\n`;

  it.each([
    ['stdin kosong', ''],
    ['spasi saja', '  \n'],
    ['JSON terpotong', '{"hook_event_name":'],
    ['array', '[1,2]'],
    ['null', 'null'],
    ['angka', '5'],
  ])('%s → kode 0, tanpa output, cepat', async (_l, input) => {
    const r = await runHook(input, await env());
    expect(r.code).toBe(0);
    expect(r.out + r.err).toBe('');
    expect(r.ms).toBeLessThan(3000);
  });

  it('agent_transcript_path: hilang, direktori, bukan string, berisi NUL → kode 0 tanpa output', async () => {
    const d = dir();
    for (const p of [join(d, 'tidak-ada.jsonl'), d, 123, 'a\u0000b', '']) {
      const r = await runHook(stop({ agent_transcript_path: p }), await env());
      expect(r.code, String(p)).toBe(0);
      expect(r.out + r.err).toBe('');
    }
  });

  it('transkrip 40 MB dan satu baris 20 MB tanpa newline: kode 0 dan < 3 detik', async () => {
    const d = dir();
    const big = join(d, 'big.jsonl');
    const chunk = Array.from({ length: 4000 }, (_, i) => line(i)).join('');
    writeFileSync(big, '');
    for (let i = 0; i < Math.ceil((40 * 1024 * 1024) / chunk.length); i++) appendFileSync(big, chunk);
    const one = join(d, 'one.jsonl');
    writeFileSync(one, `{"type":"assistant","message":{"usage":{"input_tokens":1}},"pad":"${'x'.repeat(20 * 1024 * 1024)}`);
    for (const p of [big, one]) {
      const r = await runHook(stop({ agent_transcript_path: p }), await env());
      expect(r.code).toBe(0);
      expect(r.out + r.err).toBe('');
      expect(r.ms).toBeLessThan(3000);
    }
  });

  it('B1 (diperbaiki): stdin > 2 MB -> hook langsung keluar 0, tidak menunggu timer readStdin 3 detik', async () => {
    const payload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: 'a'.repeat(2_500_000) } });
    const baseline = (await runNode(['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'], { env: cleanEnv(), input: '{}' })).ms;
    const r = await runHook(payload, await env());
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    // Dulu ~3 detik di atas start Node (menunggu timer); sekarang selisihnya jauh di bawah itu.
    expect(r.ms - baseline).toBeLessThan(2000);
  });
});

describe('transcriptTokens: transkrip rusak', () => {
  const write = (text) => {
    const f = join(dir(), 't.jsonl');
    writeFileSync(f, text);
    return f;
  };

  it('CRLF dan nilai aneh: negatif/teks → 0; semua tidak valid → null', () => {
    const ok = '{"type":"assistant","message":{"id":"a","usage":{"input_tokens":7}}}\r\n{"type":"assistant","message":{"id":"b","usage":{"input_tokens":3}}}\r\n';
    expect(transcriptTokens(write(ok))).toMatchObject({ input: 10 });
    expect(transcriptTokens(write('{"type":"assistant","message":{"id":"a","usage":{"input_tokens":-5,"output_tokens":"9"}}}\n'))).toBeNull();
    expect(transcriptTokens(write('{"type":"assistant","message":{"id":"a","usage":{"input_tokens":-5,"output_tokens":4}}}\n'))).toMatchObject({ input: 0, output: 4 });
  });

  it('baris rusak bercampur baris valid: yang valid tetap dihitung', () => {
    const text = `{"usage":{{\n"usage"\n${'{"type":"assistant","message":{"id":"z","usage":{"input_tokens":5}}}'}\n[[[["usage"\n`;
    expect(transcriptTokens(write(text))).toMatchObject({ input: 5 });
  });

  it('B2 (diperbaiki): ribuan baris rusak yang memuat "usage" -> berhenti cepat (batas parse gagal + deadline), tanpa tokens', () => {
    const f = write('{"usage":{\n'.repeat(750_000)); // ~8,3 MB; dulu ~12,9 detik
    const t0 = Date.now();
    expect(transcriptTokens(f)).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000); // target ~0,5 detik; longgar untuk mesin sibuk
  });

  it('B2: hasil parsial dipakai bila ada baris valid sebelum baris rusak membanjir', () => {
    const good = '{"type":"assistant","message":{"id":"p1","usage":{"input_tokens":9}}}\n';
    const f = write(good + '{"usage":{\n'.repeat(100_000));
    expect(transcriptTokens(f)).toMatchObject({ input: 9 });
  });
});

describe('projectName: bentuk path', () => {
  it.each([
    ['C:\\Users\\alice\\My Project', 'My Project'],
    ['C:\\Users\\alice\\proyek-é日本\\', 'proyek-é日本'],
    ['/home/a b/c/', 'c'],
    ['\\\\server\\share\\proj', 'proj'],
    ['E:\\work\\ai-office', 'ai-office'],
    ['C:\\', 'C:'],
    ['C:/', 'C:'],
    ['/', ''],
    ['   ', ''],
    ['a/b\\c', 'c'],
  ])('%j → %j', (input, expected) => {
    expect(projectName(input)).toBe(expected);
  });
});

// ------------------------------------------------------------------------------------------ pemasang
describe('pemasang hook: hook user bermatcher sama dan kegagalan', () => {
  const userHook = { type: 'command', command: 'node C:/lain/hook.js' };
  const original = {
    model: 'opus',
    hooks: {
      PreToolUse: [{ matcher: 'Agent|Task', hooks: [userHook] }, { matcher: 'Bash', hooks: [userHook] }],
      SubagentStop: [{ hooks: [userHook] }],
      Stop: [{ hooks: [userHook] }],
    },
  };
  const sandbox = (content) => {
    const d = dir('inst');
    const file = join(d, 'settings.json');
    if (content !== undefined) writeFileSync(file, content);
    const env = cleanEnv({ AI_OFFICE_USER_SETTINGS: file, HOME: d, USERPROFILE: d });
    return {
      file,
      d,
      run: (script) => runNode([`scripts/${script}`], { env }),
      json: () => JSON.parse(readFileSync(file, 'utf8')),
      files: () => readdirSync(d),
    };
  };

  it('install → install → uninstall → install → uninstall: hook user utuh, hasil akhir = asli, grup user (matcher sama) tidak dibuang', async () => {
    const s = sandbox(JSON.stringify(original, null, 2));
    for (const script of ['install-user-hooks.mjs', 'install-user-hooks.mjs', 'uninstall-user-hooks.mjs', 'install-user-hooks.mjs']) {
      const r = await s.run(script);
      expect(r.code, r.err).toBe(0);
      const text = JSON.stringify(s.json());
      expect(text.split('C:/lain/hook.js').length - 1).toBe(4);
    }
    expect(JSON.stringify(s.json()).split('hooks/send-event.mjs').length - 1).toBe(5);
    expect((await s.run('uninstall-user-hooks.mjs')).code).toBe(0);
    expect(s.json()).toEqual(original);
    expect(s.files().filter((f) => f.includes('.tmp-'))).toEqual([]);
  });

  it.each([
    ['CRLF', JSON.stringify(original, null, 2).replace(/\n/g, '\r\n')],
    ['BOM', `\uFEFF${JSON.stringify(original)}`],
  ])('%s diterima dan isi user tetap', async (_l, content) => {
    const s = sandbox(content);
    expect((await s.run('install-user-hooks.mjs')).code).toBe(0);
    expect((await s.run('uninstall-user-hooks.mjs')).code).toBe(0);
    expect(s.json()).toEqual(original);
  });

  it.each([
    ['JSON rusak', '{"hooks": {'],
    ['root array', '[]'],
    ['root null', 'null'],
    ['hooks array', '{"hooks": []}'],
    ['event bukan array', '{"hooks": {"PreToolUse": {}}}'],
  ])('%s → kode 1, file tidak berubah, tanpa backup/tmp', async (_l, content) => {
    const s = sandbox(content);
    for (const script of ['install-user-hooks.mjs', 'uninstall-user-hooks.mjs']) {
      const r = await s.run(script);
      expect(r.code).toBe(1);
      expect(r.err).toContain('Gagal');
    }
    expect(readFileSync(s.file, 'utf8')).toBe(content);
    expect(s.files()).toEqual(['settings.json']);
  });

  it('file kosong / spasi saja diperlakukan seperti {}', async () => {
    for (const content of ['', '  \n']) {
      const s = sandbox(content);
      expect((await s.run('install-user-hooks.mjs')).code).toBe(0);
      expect(Object.keys(s.json().hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SubagentStart', 'SubagentStop']);
    }
  });
});

// ------------------------------------------------------------------------------------------ usage
describe('usage: nilai aneh, hari, cache, level', () => {
  const now = new Date();
  const row = (ts, id, u = {}) =>
    `${JSON.stringify({ type: 'assistant', ...(ts === undefined ? {} : { timestamp: ts }), message: { id, usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4, ...u } } })}\n`;
  const tracker = (d, extra = {}) =>
    createUsageTracker({ claudeDir: d, cacheFile: join(d, 'cache.json'), agentsFile: null, limitConfigFile: join(d, 'limit.json'), ...extra });
  const logs = (d) => {
    const f = join(d, 'projects', 'p');
    mkdirSync(f, { recursive: true });
    return join(f, 'a.jsonl');
  };

  it('tanpa timestamp / timestamp rusak / negatif / string / null: aman dan konsisten', async () => {
    const d = dir('u');
    writeFileSync(
      logs(d),
      row(undefined, 'n1') + row('bukan-tanggal', 'n2') + row(now.toISOString(), 'ok') +
        row(now.toISOString(), 'neg', { input_tokens: -100 }) + row(now.toISOString(), 'str', { input_tokens: '50', output_tokens: 5 }) +
        row(now.toISOString(), 'nul', { output_tokens: null }),
    );
    const s = await tracker(d).scanAll();
    // ok: 1+2+3+4=10, neg: 0+2+3+4=9, str: 0+5+3+4=12, nul: 1+0+3+4=8; baris tanpa timestamp valid tidak dihitung
    expect(s.today.total).toBe(10 + 9 + 12 + 8);
    expect(s.available).toBe(true);
  });

  it('pergantian hari: 23:59:59 kemarin dan 00:00:00 hari ini masuk hari masing-masing (jam lokal)', async () => {
    const d = dir('u');
    const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 23, 59, 59);
    const t0 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    writeFileSync(logs(d), row(y.toISOString(), 'y') + row(t0.toISOString(), 't0'));
    const s = await tracker(d).scanAll();
    expect(s.days[5]).toMatchObject({ date: dateKey(y), total: 10 });
    expect(s.days[6]).toMatchObject({ date: dateKey(t0), total: 10 });
  });

  it('baris dilengkapi bertahap, truncate lalu ditulis ulang: tidak ada hitungan ganda', async () => {
    const d = dir('u');
    const f = logs(d);
    const iso = now.toISOString();
    writeFileSync(f, row(iso, 'a1') + row(iso, 'a2'));
    const t = tracker(d);
    expect((await t.scanAll()).today.total).toBe(20);
    appendFileSync(f, `${row(iso, 'a3')}{"type":"assistant","timestamp":"${iso}","message":{"id":"half","usa`);
    expect((await t.scanAll()).today.total).toBe(30);
    appendFileSync(f, 'ge":{"input_tokens":1,"output_tokens":2,"cache_read_input_tokens":3,"cache_creation_input_tokens":4}}}\n');
    expect((await t.scanAll()).today.total).toBe(40);
    writeFileSync(f, row(iso, 'a1') + row(iso, 'baru'));
    expect((await t.scanAll()).today.total).toBe(50);
  });

  it('cache dengan bentuk rusak (kosong, array, null, files berupa teks) tidak membuat crash dan data dihitung dari log', async () => {
    for (const content of ['', '[]', 'null', '{"version":1,"files":"abc","hours":5,"seen":7}', '{{{']) {
      const d = dir('u');
      writeFileSync(logs(d), row(now.toISOString(), 'a1'));
      writeFileSync(join(d, 'cache.json'), content);
      const s = await tracker(d).scanAll();
      expect(s.available, content).toBe(true);
      expect(s.today.total, content).toBe(10);
    }
  });

  it('limit-config aneh: negatif/teks → tanpa batas; weekResetDay 9/"1"/1.5 → window bergulir; hasil tidak melempar', async () => {
    const d = dir('u');
    writeFileSync(logs(d), row(now.toISOString(), 'a1'));
    const rolling = (await tracker(d).scanAll()).weekly.windowStart;
    for (const cfg of [{ weeklyTokenLimit: -5 }, { weeklyTokenLimit: '1000' }, { weeklyTokenLimit: null }]) {
      writeFileSync(join(d, 'limit.json'), JSON.stringify(cfg));
      const w = (await tracker(d).scanAll()).weekly;
      expect(w).toMatchObject({ limit: null, percent: null, level: null, configAvailable: true });
    }
    for (const day of [9, '1', 1.5, -1]) {
      writeFileSync(join(d, 'limit.json'), JSON.stringify({ weeklyTokenLimit: 100, weekResetDay: day }));
      const w = (await tracker(d).scanAll()).weekly;
      expect(w.windowStart).toBe(rolling);
      expect(w.limit).toBe(100);
    }
    for (const raw of ['', '{bad', '[]', '"x"', 'null']) {
      writeFileSync(join(d, 'limit.json'), raw);
      expect((await tracker(d).scanAll()).weekly).toMatchObject({ limit: null, percent: null });
    }
  });

  const used = (u, limit) => {
    const key = `${dateKey(now)}T00`;
    return buildUsage({ now, hours: { [key]: { input: u, output: 0, cacheRead: 0, cacheCreation: 0 } }, config: { weeklyTokenLimit: limit, weekResetDay: null, weekResetHour: 0, countCacheRead: false } }).weekly;
  };

  it.each([
    [59, 'green'], [60, 'yellow'], [85, 'yellow'], [86, 'red'],
  ])('batas warna server dan UI sama untuk %i%% → %s', (pct, level) => {
    expect(used(pct * 10, 1000)).toMatchObject({ percent: pct, level });
    expect(levelFor(pct)).toBe(level);
  });

  it('B3 (diperbaiki): level dari persen yang sudah dibulatkan (59,96% -> 60 kuning; 85,04% -> 85 kuning; 85,06% -> 85,1 merah)', () => {
    expect(used(5996, 10000)).toMatchObject({ percent: 60, level: 'yellow' });
    expect(used(8504, 10000)).toMatchObject({ percent: 85, level: 'yellow' });
    expect(used(8506, 10000)).toMatchObject({ percent: 85.1, level: 'red' });
  });

  it('tiga siklus dengan anggaran kecil menghasilkan total yang sama seperti tanpa batas', async () => {
    const d = dir('u');
    let text = '';
    for (let i = 0; i < 3000; i++) text += row(now.toISOString(), `x${i}`);
    writeFileSync(logs(d), text);
    const full = (await tracker(d, { cacheFile: null }).scanAll()).today.total;
    const small = tracker(d, { cacheFile: null, maxBytesPerCycle: Math.ceil(statSync(logs(d)).size / 3) });
    let cycles = 0;
    do {
      await small.scan();
      cycles++;
    } while (cycles < 20 && small.snapshot().today.total < full);
    expect(small.snapshot().today.total).toBe(full);
    expect(cycles).toBeGreaterThanOrEqual(3);
  });
});

describe('server: dedup 3 detik dan token agen', () => {
  it('B4 (diperbaiki): event dengan token berbeda dalam 3 detik tetap masuk dan tercatat; token identik tetap dibuang', async () => {
    const d = dir('srv');
    const usage = createUsageTracker({ claudeDir: d, claudeDirExplicit: true, cacheFile: null, agentsFile: null, limitConfigFile: join(d, 'x.json') });
    const t = await startApp({ usage });
    try {
      const ev = (tokens) => ({ type: 'done', from: 'dev-qa', to: 'manager', message: 'selesai', tokens });
      const post = (body) => http(t.port, '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      expect((await post(ev({ input: 100, output: 100 }))).json).toMatchObject({ accepted: 1 });
      const second = await post(ev({ input: 5000, output: 5000 }));
      expect(second.json).toMatchObject({ accepted: 1 });
      const dup = await post(ev({ input: 5000, output: 5000 })); // dobel dari hook lain dengan token identik
      expect(dup.json).toMatchObject({ accepted: 0, duplicates: 1 });
      expect(usage.snapshot().perAgent[0]).toMatchObject({ agent: 'dev-qa', total: 10200, runs: 2 });
    } finally {
      await t.close();
    }
  });
});
