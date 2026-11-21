// Gerbang QA tambahan untuk runner, tugas, dan file hasil: celah yang belum dicakup runner.test.js,
// runnerAuth.test.js, dan demo.test.js. CLI tiruan saja (tests/fixtures/fake-claude.mjs); tidak pernah `claude`
// sungguhan, tidak menyentuh ~/.claude atau ~/.ai-office, dan tidak memakai port 3000.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TASK_ID_RE } from '../shared/events.js';
import { createAgentTracker, createLineParser, extraArgs, spawnPlan, buildArgs, childEnv, findClaude, detectVersion, killTree } from '../server/runner.js';
import { safeSegments } from '../server/outputStore.js';
import { KEY, eventsOf, startRunnerApp, tempDir } from './helpers/runnerkit.js';
import { cookieFrom, http, login, randomToken, sleep } from './helpers/testkit.js';

const apps = [];
const boot = async (o) => {
  const a = await startRunnerApp(o);
  apps.push(a);
  return a;
};
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

const post = (a, text = 'Tugas uji QA', lang = 'id') => a.api('/api/tasks', { method: 'POST', body: { text, lang } });
const cancel = (a, id) => a.api(`/api/tasks/${id}/cancel`, { method: 'POST', body: {} });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFile = async (file) => {
  for (let i = 0; i < 200 && !existsSync(file); i++) await sleep(25);
  return existsSync(file);
};
const countDirs = (a) => (existsSync(a.outputDir) ? readdirSync(a.outputDir).length : 0);
const metaOf = (a, id) => JSON.parse(readFileSync(join(a.outputDir, id, '.ai-office-task.json'), 'utf8'));

describe('antrean: satu tugas aktif', () => {
  it('lima POST serentak: tepat satu 202, sisanya 409 (tidak ada dua proses CLI)', async () => {
    const a = await boot({ mode: 'hang' });
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => post(a, `Tugas serentak ${i}`)));
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([202, 409, 409, 409, 409]);
    const id = rs.find((r) => r.status === 202).json.task.id;
    expect(readdirSync(a.outputDir)).toEqual([id]); // folder hanya untuk tugas yang menang
    await cancel(a, id);
    await a.waitDone(id);
  });

  it('POST tugas dan POST demo serentak: tepat satu menang', async () => {
    const a = await boot({ mode: 'hang', task: { demoSpeed: 1 } });
    const [t, d] = await Promise.all([post(a), a.api('/api/demo', { method: 'POST', body: { lang: 'en' } })]);
    expect([t.status, d.status].sort()).toEqual([202, 409]);
    const winner = (t.status === 202 ? t : d).json.task.id;
    await cancel(a, winner);
    await a.waitDone(winner);
  });

  it('tugas saat demo berjalan: 409; batal demo lalu tugas baru langsung diterima', async () => {
    const a = await boot({ task: { demoSpeed: 1 } });
    const d = await a.api('/api/demo', { method: 'POST', body: { lang: 'id' } });
    expect(d.status).toBe(202);
    expect((await post(a)).status).toBe(409);
    expect((await cancel(a, d.json.task.id)).status).toBe(200);
    const t = await post(a);
    expect(t.status).toBe(202);
    expect((await a.waitDone(t.json.task.id)).status).toBe('done');
    expect(metaOf(a, d.json.task.id).status).toBe('cancelled');
  });

  it('batal lalu kirim tugas baru: slot bebas, folder berbeda, anak lama mati', async () => {
    const a = await boot({ mode: 'hang' });
    const first = await post(a, 'Tugas pertama');
    expect(await waitFile(a.logFile)).toBe(true);
    const { pid } = a.fakeLog();
    const t0 = Date.now();
    expect((await cancel(a, first.json.task.id)).status).toBe(200);
    const cancelMs = Date.now() - t0;
    expect(cancelMs).toBeLessThan(8000);
    expect((await a.waitDone(first.json.task.id)).status).toBe('cancelled');
    const second = await post(a, 'Tugas kedua');
    expect(second.status).toBe(202);
    expect(second.json.task.id).not.toBe(first.json.task.id);
    expect(alive(pid)).toBe(false);
    await cancel(a, second.json.task.id);
    await a.waitDone(second.json.task.id);
  });

  it('batal dua kali: yang kedua 404, status tetap cancelled', async () => {
    const a = await boot({ mode: 'hang' });
    const r = await post(a);
    expect((await cancel(a, r.json.task.id)).status).toBe(200);
    expect((await cancel(a, r.json.task.id)).status).toBe(404);
    expect((await a.waitDone(r.json.task.id)).status).toBe('cancelled');
  });

  it('CLI mengabaikan SIGTERM: tetap mati setelah batal (eskalasi ke SIGKILL / taskkill /F)', async () => {
    const a = await boot({ mode: 'ignore-term' });
    const r = await post(a);
    expect(await waitFile(a.logFile)).toBe(true);
    const { pid } = a.fakeLog();
    expect((await cancel(a, r.json.task.id)).status).toBe(200);
    expect((await a.waitDone(r.json.task.id)).status).toBe('cancelled');
    await sleep(300);
    expect(alive(pid)).toBe(false);
  });

  it('timeout lewat env AI_OFFICE_RUNNER_TIMEOUT_MS kecil (bukan opsi kode): failed + blocked', async () => {
    const a = await boot({ mode: 'hang', env: { AI_OFFICE_RUNNER_TIMEOUT_MS: '700' } });
    const r = await post(a);
    const done = await a.waitDone(r.json.task.id, { timeoutMs: 15000 });
    expect(done.status).toBe('failed');
    expect(eventsOf(a, r.json.task.id).at(-1)).toMatchObject({ type: 'blocked', from: 'manager', to: 'ceo' });
    expect((await a.api('/api/runner')).json.reason).toBeNull(); // slot bebas
  });

  it('server ditutup saat demo berjalan: meta di disk "cancelled", bukan "running"', async () => {
    const a = await boot({ task: { demoSpeed: 1 } });
    const r = await a.api('/api/demo', { method: 'POST', body: { lang: 'en' } });
    await sleep(100);
    await a.app.close();
    apps.pop();
    expect(metaOf(a, r.json.task.id).status).toBe('cancelled');
    a.tmp.cleanup();
  });

  it('dua tugas beruntun pada detik yang sama: id unik, sah menurut TASK_ID_RE', async () => {
    const fixed = new Date(2026, 0, 2, 3, 4, 5);
    const a = await boot({ task: { now: () => fixed } });
    const ids = [];
    for (let i = 0; i < 3; i++) {
      const r = await post(a, 'Judul sama');
      expect(r.status).toBe(202);
      ids.push(r.json.task.id);
      await a.waitDone(r.json.task.id);
    }
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(TASK_ID_RE);
    expect(ids[0]).toBe('20260102-030405-judul-sama');
    expect(ids[1]).toBe('20260102-030405-judul-sama-2');
  });

  it('judul non-ASCII / emoji / sangat panjang: id tetap sah dan <= 64 karakter', async () => {
    const a = await boot();
    for (const text of ['日本語のタスク', '🔥🔥🔥', 'Ünïcödé façade', `${'kata '.repeat(60)}`, '../../etc/passwd', 'CON', 'a:b\\c*?"<>|']) {
      const r = await post(a, text);
      expect(r.status, text).toBe(202);
      expect(r.json.task.id, text).toMatch(TASK_ID_RE);
      await a.waitDone(r.json.task.id);
      expect(readdirSync(a.outputDir).every((n) => TASK_ID_RE.test(n))).toBe(true);
    }
  });
});

describe('aliran stream-json rusak atau tidak lazim', () => {
  it('sampah + JSON terpotong + byte NUL, exit 0 tanpa result: tugas selesai (done) dan tidak crash', async () => {
    const a = await boot({ mode: 'garbage' });
    const r = await post(a);
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('done');
    expect(existsSync(join(a.outputDir, r.json.task.id, 'RESULT.md'))).toBe(true);
    expect((await a.api('/api/runner')).json.reason).toBeNull();
  });

  it('tanpa output sama sekali, exit 0: done dengan RESULT.md pengganti', async () => {
    const a = await boot({ mode: 'silent' });
    const r = await post(a);
    expect((await a.waitDone(r.json.task.id)).status).toBe('done');
    expect(readFileSync(join(a.outputDir, r.json.task.id, 'RESULT.md'), 'utf8').trim().length).toBeGreaterThan(0);
  });

  it('event result tanpa newline penutup tetap terbaca (ringkasan dari result)', async () => {
    const a = await boot({ mode: 'no-newline' });
    const r = await post(a);
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('done');
    const detail = await a.api(`/api/tasks/${r.json.task.id}`);
    expect(detail.json.task.summary).toContain('Tanpa newline');
  });

  it('flood: server tetap responsif selama CLI menulis > 6 MB', async () => {
    const a = await boot({ mode: 'flood' });
    const r = await post(a);
    let worst = 0;
    for (let i = 0; i < 20; i++) {
      const t0 = Date.now();
      const s = await a.api('/api/runner');
      worst = Math.max(worst, Date.now() - t0);
      expect(s.status).toBe(200);
      const d = await a.api(`/api/tasks/${r.json.task.id}`);
      if (d.json.task.status !== 'running') break;
      await sleep(50);
    }
    expect((await a.waitDone(r.json.task.id, { timeoutMs: 20000 })).status).toBe('done');
    expect(worst).toBeLessThan(5000);
  });

  it('createLineParser: CRLF, UTF-8 multibyte terbelah antar chunk, array/skalar dilewati', () => {
    const got = [];
    const p = createLineParser((o) => got.push(o));
    p.push('{"a":"é"}\r\n[1]\r\n"x"\r\n123\r\n{"b":');
    p.push('"日本"}\r\n');
    p.end();
    expect(got).toEqual([{ a: 'é' }, { b: '日本' }]);
  });

  it('createAgentTracker: input aneh (nama agen jahat, id ganda, bukan objek) tidak melempar dan tidak meledak', () => {
    const events = [];
    const tr = (k) => k;
    const tr1 = createAgentTracker({ emit: (e) => events.push(e), taskId: 'x1', tr });
    const use = (id, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Agent', input }] } });
    expect(() => {
      tr1.handle(null);
      tr1.handle(42);
      tr1.handle({ type: 'assistant', message: { content: 'bukan array' } });
      tr1.handle(use('a', null));
      tr1.handle(use('b', { subagent_type: '../../etc/passwd' }));
      tr1.handle(use('c', { subagent_type: 'X'.repeat(500), description: 'y'.repeat(5000) }));
      tr1.handle(use('d', { subagent_type: { toString: 1 } }));
      tr1.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tidak-ada', content: 'x' }] } });
    }).not.toThrow();
    for (const e of events) {
      expect(e.task).toBe('x1');
      expect(e.message.length).toBeLessThanOrEqual(500);
    }
    // nama agen tidak sah jatuh ke general-purpose
    expect(events.some((e) => e.to === 'general-purpose')).toBe(true);
    expect(events.some((e) => /passwd/.test(`${e.from}${e.to}`))).toBe(false);
  });
});

describe('validasi masukan: sisi yang belum diuji', () => {
  // QA-1: judul tugas dibersihkan dari karakter kontrol/bidi (server/tasks.js titleOf).
  it.each([
    ['ESC dan kode warna ANSI', 'merah \u001b[31mteks\u001b[0m'],
    ['BEL dan DEL', 'a\u0007b\u007fc'],
    ['override RTL U+202E', 'abc\u202edef'],
  ])('QA-1 karakter kontrol: %s diterima tanpa merusak judul, event, id, atau meta', async (_n, text) => {
    const a = await boot();
    const r = await post(a, text);
    expect(r.status).toBe(202);
    const id = r.json.task.id;
    await a.waitDone(id);
    expect(id).toMatch(TASK_ID_RE);
    // eslint-disable-next-line no-control-regex
    const BAD = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/;
    expect(r.json.task.title, 'judul di respons').not.toMatch(BAD);
    expect(metaOf(a, id).title, 'judul di meta').not.toMatch(BAD);
    for (const e of eventsOf(a, id)) expect(e.message, `event ${e.type}`).not.toMatch(BAD);
    const list = await a.api('/api/tasks');
    expect(list.json.tasks[0].title).not.toMatch(BAD);
  });

  it.each([
    ['null', null],
    ['angka', 123],
    ['string kosong', ''],
    ['huruf besar', 'EN'],
    ['array', ['en']],
    ['objek', {}],
    ['dengan spasi', 'en '],
  ])('lang %s: 400 di POST /api/tasks dan POST /api/demo (kecuali null = bahasa server)', async (_n, lang) => {
    const a = await boot();
    const t = await a.api('/api/tasks', { method: 'POST', body: { text: 'ok', lang } });
    const d = await a.api('/api/demo', { method: 'POST', body: { lang } });
    if (lang === null) {
      expect(t.status).toBe(202);
      expect(d.status).toBe(409); // tugas di atas masih berjalan atau baru selesai; yang penting bukan 400
      await a.waitDone(t.json.task.id);
      return;
    }
    expect(t.status).toBe(400);
    expect(d.status).toBe(400);
    expect(countDirs(a)).toBe(0); // ditolak sebelum membuat folder
  });

  it.each([
    ['array kosong', '[]'],
    ['null', 'null'],
    ['string JSON', '"teks"'],
    ['angka', '123'],
    ['body kosong', ''],
    ['JSON terpotong', '{"text":'],
  ])('body %s: 400 (bukan 500, tidak ada folder)', async (_n, body) => {
    const a = await boot();
    const r = await a.api('/api/tasks', { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    expect(r.status).toBe(400);
    expect(r.json?.ok).toBe(false);
    expect(countDirs(a)).toBe(0);
  });

  it('body > 64 KB: ditolak (413 atau koneksi diputus), tidak ada tugas', async () => {
    const a = await boot();
    const big = JSON.stringify({ text: 'a'.repeat(70 * 1024) });
    let status;
    try {
      status = (await a.api('/api/tasks', { method: 'POST', body: big, headers: { 'Content-Type': 'application/json' } })).status;
    } catch {
      status = 'reset';
    }
    expect([413, 'reset']).toContain(status);
    expect(countDirs(a)).toBe(0);
  });

  it('teks 2000 karakter multibyte (emoji) dihitung per karakter, bukan per byte', async () => {
    const a = await boot();
    const r = await post(a, 'é'.repeat(2000));
    expect(r.status).toBe(202);
    await a.waitDone(r.json.task.id);
    const over = await post(a, 'é'.repeat(2001));
    expect(over.status).toBe(400);
  });

  it('teks adalah seluruh isi stdin, utuh (baris baru, Unicode, "{{lang}}")', async () => {
    const a = await boot();
    const text = 'Baris 1\nBaris 2 {{lang}} é 日本 $(whoami) `id` "q" \'s\' %PATH% ^&|<>';
    const r = await post(a, text);
    await a.waitDone(r.json.task.id);
    expect(a.fakeLog().stdin).toContain(text);
    const task = readFileSync(join(a.outputDir, r.json.task.id, 'task.md'), 'utf8');
    expect(task).toContain(text);
    expect(readFileSync(join(a.outputDir, r.json.task.id, 'CLAUDE.md'), 'utf8')).not.toContain('{{lang}}');
  });

  it('metode dan jalur aneh: tidak pernah 500', async () => {
    const a = await boot();
    for (const [method, path] of [
      ['DELETE', '/api/tasks'], ['PUT', '/api/tasks/x'], ['PATCH', '/api/demo'], ['GET', '/api/tasks/'],
      ['GET', '/api/tasks//'], ['POST', '/api/tasks/abc/cancel/'], ['GET', '/api/tasks/abc/files'], ['GET', '/api/tasks/abc/files/'],
      ['POST', '/api/tasks/abc/files/x'], ['GET', '/api/tasks/abc/lain'], ['GET', '/api/runner/x'], ['OPTIONS', '/api/tasks'],
    ]) {
      const r = await a.api(path, { method, body: method === 'POST' ? {} : undefined });
      expect(r.status, `${method} ${path}`).toBeLessThan(500);
      expect(r.status, `${method} ${path}`).not.toBe(200);
    }
  });
});

describe('file hasil: celah tambahan', () => {
  const ID = '20260101-000000-uji';
  function seed(a) {
    const dir = join(a.outputDir, ID);
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, '.ai-office-task.json'), JSON.stringify({ id: ID, title: 'Uji', kind: 'task', status: 'done', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: '2026-01-01T00:01:00.000Z', summary: '' }));
    writeFileSync(join(dir, 'RESULT.md'), '# Hasil\n');
    writeFileSync(join(dir, 'sub', 'a.md'), 'a');
    return dir;
  }
  const get = (a, rel, o) => a.api(`/api/tasks/${ID}/files/${rel}`, o);

  it('huruf besar-kecil nama file: "result.md" ditolak di semua OS (perilaku sama di Windows, macOS, Linux)', async () => {
    const a = await boot();
    seed(a);
    expect((await get(a, 'RESULT.md')).status).toBe(200);
    expect((await get(a, 'result.md')).status).toBe(404);
    expect((await get(a, 'SUB/a.md')).status).toBe(404);
  });

  it('nama pendek 8.3 Windows dan varian ADS/lainnya tidak membuka file', async () => {
    const a = await boot();
    seed(a);
    for (const rel of ['RESULT~1.MD', 'RESULT.md::$DATA', 'RESULT.md%3A%3A%24DATA', 'RESULT.md%20', 'sub./a.md', 'sub%20/a.md', 'sub//a.md']) {
      const r = await get(a, rel);
      expect([400, 404], rel).toContain(r.status);
    }
  });

  it('terlalu dalam (> 7 segmen) atau terlalu panjang: 400', async () => {
    const a = await boot();
    seed(a);
    expect((await get(a, 'a/b/c/d/e/f/g/h.md')).status).toBe(400);
    expect((await get(a, `${'x'.repeat(201)}.md`)).status).toBe(400);
    expect((await get(a, `${'y/'.repeat(250)}z.md`)).status).toBe(400);
  });

  it('files/ kosong: 400; POST ke file: 405; HEAD: header sama, tanpa body', async () => {
    const a = await boot();
    seed(a);
    expect((await get(a, '')).status).toBe(400);
    expect((await get(a, 'RESULT.md', { method: 'POST', body: {} })).status).toBe(405);
    const h = await get(a, 'RESULT.md', { method: 'HEAD' });
    expect(h.status).toBe(200);
    expect(h.body).toBe('');
    expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect((await get(a, '..%2f..%2frahasia', { method: 'HEAD' })).status).not.toBe(200);
  });

  it('tanpa key: HEAD dan GET file 401 (tidak membocorkan keberadaan file)', async () => {
    const a = await boot();
    seed(a);
    for (const method of ['GET', 'HEAD']) {
      expect((await get(a, 'RESULT.md', { method, key: '' })).status).toBe(401);
      expect((await get(a, 'tidak-ada.md', { method, key: '' })).status).toBe(401);
    }
  });

  it('nama file Unicode (NFC) dan karakter URL khusus (# ? % spasi) terbaca bila di-encode', async () => {
    const a = await boot();
    const dir = seed(a);
    const names = ['laporan é.md', 'kopi 100%.md', 'a#b.md', '日本語.md', 'a+b.md', 'a&b=c.md'];
    for (const n of names) writeFileSync(join(dir, n), `isi ${n}`);
    const detail = await a.api(`/api/tasks/${ID}`);
    const listed = detail.json.task.files.map((f) => f.path);
    for (const n of names) {
      expect(listed, n).toContain(n);
      const r = await get(a, encodeURIComponent(n));
      expect(r.status, n).toBe(200);
      expect(r.body).toBe(`isi ${n}`);
    }
  });

  // QA-2: listFiles() melewati nama yang ditolak readTaskFile() (":", backslash, spasi/titik di akhir, perangkat DOS).
  it('QA-2 semua file yang DIDAFTARKAN detail tugas bisa dibaca lewat API (daftar dan pembaca sepakat)', async () => {
    const a = await boot();
    const dir = seed(a);
    // Nama sah di POSIX tetapi ditolak pembaca (":", "\", spasi/titik di akhir, perangkat DOS).
    // Di Windows nama seperti ini tidak bisa dibuat, jadi hanya dicoba bila OS mengizinkan.
    const odd = ['a:b.md', 'back\\slash.md', 'akhir.', 'akhir ', 'nul.md', 'aux', 'com1.txt'];
    for (const n of odd) {
      try {
        writeFileSync(join(dir, n), 'x');
      } catch {
        // OS menolak membuat nama ini
      }
    }
    const detail = await a.api(`/api/tasks/${ID}`);
    const listed = detail.json.task.files.map((f) => f.path);
    for (const p of listed) {
      expect(safeSegments(p), `${p} lolos daftar tetapi ditolak safeSegments`).not.toBeNull();
      const r = await get(a, p.split('/').map(encodeURIComponent).join('/'));
      expect([200], `${p} terdaftar tetapi tidak terbaca (${r.status})`).toContain(r.status);
    }
    if (process.platform !== 'win32') {
      // POSIX bisa membuat semua nama ini, jadi tak satu pun boleh terdaftar; berkas biasa tetap terdaftar.
      for (const n of odd) expect(listed, n).not.toContain(n);
      expect(listed).toContain('RESULT.md');
    }
  });

  it('safeSegments: tabel keputusan', () => {
    expect(safeSegments('a/b.md')).toEqual(['a', 'b.md']);
    for (const bad of ['', '/a', 'a//b', './a', 'a/..', 'a\\b', 'a:b', 'a\u0000', 'a\n', 'CON', 'con.txt', 'lpt1', 'Nul.x', 'a.', 'a ', 'dir./x', 123, null, undefined, 'a/'.repeat(8)]) {
      expect(safeSegments(bad), String(bad)).toBeNull();
    }
    expect(safeSegments('console.md')).not.toBeNull(); // awalan "con" tanpa titik/akhir bukan perangkat
    expect(safeSegments('com10.md')).not.toBeNull();
    expect(safeSegments('...a')).not.toBeNull();
  });
});

describe('otorisasi: celah tambahan', () => {
  it('key: kosong 401, salah 403, kepanjangan 403, spasi/huruf berbeda 403, Bearer di mode lokal 401', async () => {
    const a = await boot();
    const h = (extra) => a.api('/api/tasks', { key: '', headers: extra });
    expect((await h({ 'X-AI-Office-Key': '' })).status).toBe(401);
    expect((await h({ 'X-AI-Office-Key': 'k'.repeat(42) })).status).toBe(403);
    expect((await h({ 'X-AI-Office-Key': 'k'.repeat(44) })).status).toBe(403);
    expect((await h({ 'X-AI-Office-Key': 'k'.repeat(257) })).status).toBe(403);
    expect((await h({ 'X-AI-Office-Key': `${KEY} ` })).status).toBe(200); // Node memangkas spasi tepi header
    expect((await h({ 'X-AI-Office-Key': KEY.toUpperCase() })).status).toBe(403);
    expect((await h({ 'X-AI-Office-Key': 'x'.repeat(10_000) })).status).toBe(403);
    expect((await h({ Authorization: `Bearer ${KEY}` })).status).toBe(401);
    expect((await h({ 'x-ai-office-key': KEY })).status).toBe(200); // nama header tidak peka huruf
  });

  it('key salah tidak mengubah apa pun: tidak ada folder, tidak ada event, tidak ada proses', async () => {
    const a = await boot();
    for (const key of ['', 'salah', 'k'.repeat(44)]) {
      await a.api('/api/tasks', { method: 'POST', body: { text: 'x' }, key });
      await a.api('/api/demo', { method: 'POST', body: {}, key });
    }
    expect(countDirs(a)).toBe(0);
    expect(a.app.history.length).toBe(0);
    expect(existsSync(a.logFile)).toBe(false);
  });

  it('mode token + key: Bearer sah dengan key salah tetap lolos; key sah tanpa Bearer ditolak', async () => {
    const token = randomToken();
    const a = await boot({ opts: { token } });
    const bearer = { Authorization: `Bearer ${token}` };
    expect((await a.api('/api/tasks', { key: 'salah', headers: bearer })).status).toBe(200);
    expect((await a.api('/api/tasks', { key: KEY })).status).toBe(401);
    const lg = await login(a.port, token);
    const cookie = cookieFrom(lg);
    expect((await a.api('/api/tasks', { key: '', headers: { Cookie: cookie } })).status).toBe(200);
    // cookie dari asal lain (CSRF) tidak boleh memulai tugas
    const csrf = await a.api('/api/tasks', { method: 'POST', body: { text: 'x' }, key: '', headers: { Cookie: cookie, Origin: 'http://evil.example' } });
    expect(csrf.status).toBe(403);
    expect(countDirs(a)).toBe(0);
  });

  it('GET /api/runner tanpa auth: tidak membocorkan judul/id tugas aktif, path, atau key (mode lokal dan token)', async () => {
    for (const opts of [{}, { token: randomToken() }]) {
      const a = await boot({ mode: 'hang', opts });
      const headers = opts.token ? { Authorization: `Bearer ${opts.token}` } : {};
      const r = await a.api('/api/tasks', { method: 'POST', body: { text: 'Rahasia-Judul-Tugas' }, headers });
      expect(r.status).toBe(202);
      const anon = await http(a.port, '/api/runner');
      expect(anon.status).toBe(200);
      expect(anon.json.active).toBeNull();
      expect(anon.body).not.toContain('Rahasia-Judul-Tugas');
      expect(anon.body).not.toContain(r.json.task.id);
      expect(anon.body).not.toContain(a.outputDir);
      expect(anon.body).not.toContain(KEY);
      expect(Object.keys(anon.json).sort()).toEqual(['active', 'available', 'ok', 'keyRequired', 'reason', 'version'].sort());
      await a.api(`/api/tasks/${r.json.task.id}/cancel`, { method: 'POST', body: {}, headers });
      for (let i = 0; i < 200; i++) {
        const d = await a.api(`/api/tasks/${r.json.task.id}`, { headers });
        if (d.json?.task?.status !== 'running') break;
        await sleep(40);
      }
    }
  });

  it('WebSocket tanpa auth tidak menerima pesan task (mode token)', async () => {
    const token = randomToken();
    const a = await boot({ opts: { token } });
    const { wsConnect } = await import('./helpers/testkit.js');
    const w = await wsConnect(a.port);
    expect(w.status).toBe(401);
  });
});

describe('runner.js: unit tambahan (lintas OS)', () => {
  it.each([
    ['--allowed-tools=Bash'], ['--allowedTools'], ['--ALLOWEDTOOLS=Bash'], ['-p'], ['--print'], ['--dangerously-skip-permissions'],
    ['--allow-dangerously-skip-permissions'], ['--permission-mode'], ['--permission-mode=bypassPermissions'], ['--PERMISSION-MODE'],
    ['--permission-prompt-tool'], ['--disallowedTools'], ['--disallowed-tools'], ['--tools'], ['--mcp-config'], ['--settings'],
    ['--add-dir'], ['--append-system-prompt'], ['--system-prompt-file'], ['--plugin-dir'], ['--input-format'], ['--output-format'],
    ['--verbose'],
  ])('EXTRA_ARGS menolak flag pelemah keamanan: %s', (flag) => {
    expect(() => extraArgs({ AI_OFFICE_RUNNER_EXTRA_ARGS: `--model opus ${flag}` })).toThrow();
  });

  it.each([
    ['$(calc)'], ['a;b'], ['a&b'], ['`id`'], ['--model=opus|x'], ['"x"'], ['--a=../../x'], ['-'], ['--'],
  ])('EXTRA_ARGS menolak token berbahaya: %s', (tok) => {
    expect(() => extraArgs({ AI_OFFICE_RUNNER_EXTRA_ARGS: `--model ${tok}` })).toThrow();
  });

  it('EXTRA_ARGS sah dan > 20 token', () => {
    expect(extraArgs({ AI_OFFICE_RUNNER_EXTRA_ARGS: '--model opus --max-turns 5' })).toEqual(['--model', 'opus', '--max-turns', '5']);
    expect(() => extraArgs({ AI_OFFICE_RUNNER_EXTRA_ARGS: Array(21).fill('a').join(' ') })).toThrow();
  });

  it('buildArgs: Bash, PowerShell, dan mcp__* selalu di --disallowedTools walau ada di ALLOWED_TOOLS; teks tugas tidak pernah di argv', () => {
    const args = buildArgs({ AI_OFFICE_RUNNER_ALLOWED_TOOLS: 'Bash,Read' });
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash,PowerShell,mcp__*');
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args.join(' ')).not.toMatch(/bypass|dangerously/i);
  });

  it('spawnPlan Windows: .cmd/.BAT dengan spasi dan kurung dikutip benar; ".CMD" huruf besar sama; POSIX tidak memakai cmd.exe', () => {
    const args = ['-p', '--allowedTools', 'Agent,Read'];
    const win = { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe' };
    for (const bin of ['C:\\Program Files (x86)\\npm\\claude.cmd', 'C:\\x\\CLAUDE.CMD', 'C:\\x\\run.bat']) {
      const p = spawnPlan(bin, args, win);
      expect(p.command).toBe(win.comspec);
      expect(p.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
      expect(p.args[3]).toBe(`"\"${bin}\" ${args.join(' ')}"`);
      expect(p.options.windowsVerbatimArguments).toBe(true);
    }
    for (const bad of ['C:\\x&calc\\c.cmd', 'C:\\x%PATH%\\c.cmd', 'C:\\x^y\\c.cmd', 'C:\\a"b\\c.cmd', 'C:\\a|b\\c.cmd', 'C:\\a<b\\c.cmd', 'C:\\a!b\\c.cmd']) {
      expect(() => spawnPlan(bad, args, win), bad).toThrow();
    }
    const posix = spawnPlan('/usr/local/bin/claude', args, { platform: 'linux' });
    expect(posix).toEqual({ command: '/usr/local/bin/claude', args, options: {} });
    const posixCmd = spawnPlan('/opt/x/run.cmd', args, { platform: 'darwin' });
    expect(posixCmd.command).toBe('/opt/x/run.cmd'); // ".cmd" di POSIX hanyalah nama file
  });

  it('spawnPlan: .ps1 lewat powershell -File tanpa shell; .mjs/.js/.cjs lewat node', () => {
    const ps = spawnPlan('C:\\x y\\claude.ps1', ['-p'], { platform: 'win32' });
    expect(ps.command).toBe('powershell.exe');
    expect(ps.args).toContain('-File');
    expect(ps.args).toContain('C:\\x y\\claude.ps1');
    for (const f of ['/a/b.mjs', '/a/b.js', '/a/b.cjs']) expect(spawnPlan(f, ['-p'], { platform: 'linux' }).command).toBe(process.execPath);
  });

  it('childEnv: membuang AI_OFFICE_RUNNER* (huruf besar/kecil) dan CLAUDE_PROJECT_DIR; tidak mengubah env asal', () => {
    const base = { PATH: '/bin', AI_OFFICE_RUNNER_KEY_FILE: '/x', ai_office_runner: '1', Ai_Office_Runner_Timeout_Ms: '5', AI_OFFICE_TOKEN_FILE: '/t', CLAUDE_PROJECT_DIR: '/p', HOME: '/h' };
    const before = JSON.stringify(base);
    const env = childEnv(base, 'http://127.0.0.1:1/api/events');
    expect(Object.keys(env).filter((k) => /^AI_OFFICE_RUNNER/i.test(k))).toEqual([]);
    expect(env.CLAUDE_PROJECT_DIR).toBeUndefined();
    expect(env.AI_OFFICE_URL).toBe('http://127.0.0.1:1/api/events');
    expect(env.AI_OFFICE_TOKEN_FILE).toBe('/t');
    expect(JSON.stringify(base)).toBe(before);
  });

  it('findClaude: PATH kosong/aneh, entri berkutip, bukan file (folder bernama claude) -> null atau file nyata', () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, 'claude')); // folder bernama claude bukan CLI
      expect(findClaude({ env: { PATH: t.dir }, platform: 'linux' })).toBeNull();
      expect(findClaude({ env: { PATH: '' }, platform: 'linux' })).toBeNull();
      expect(findClaude({ env: {}, platform: 'linux' })).toBeNull();
      writeFileSync(join(t.dir, 'claude.exe'), 'x');
      expect(findClaude({ env: { PATH: `"${t.dir}"` }, platform: 'win32' })).toBe(join(t.dir, 'claude.exe'));
      expect(findClaude({ env: { Path: t.dir }, platform: 'win32' })).toBe(join(t.dir, 'claude.exe'));
      expect(findClaude({ env: { AI_OFFICE_CLAUDE_BIN: join(t.dir, 'tidak-ada') }, platform: 'linux' })).toBeNull();
      expect(findClaude({ env: { AI_OFFICE_CLAUDE_BIN: t.dir }, platform: 'linux' })).toBeNull(); // folder
    } finally {
      t.cleanup();
    }
  });

  it('detectVersion: biner yang menggantung -> null dalam batas waktu; exit != 0 -> null; keluaran dibersihkan dan dipotong', async () => {
    const t = tempDir();
    try {
      const mk = (name, src) => {
        const p = join(t.dir, name);
        writeFileSync(p, src);
        return p;
      };
      const hang = mk('hang.mjs', 'setInterval(() => {}, 1000);');
      const bad = mk('bad.mjs', 'console.log("1.2.3"); process.exit(2);');
      const noisy = mk('noisy.mjs', 'process.stdout.write("\\u001b[31m" + "v".repeat(200) + "\\u0007\\n");');
      const empty = mk('empty.mjs', '');
      const t0 = Date.now();
      expect(await detectVersion(hang, { timeoutMs: 400 })).toBeNull();
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(await detectVersion(bad)).toBeNull();
      expect(await detectVersion(empty)).toBeNull();
      const v = await detectVersion(noisy);
      expect(v.length).toBeLessThanOrEqual(64);
      // eslint-disable-next-line no-control-regex
      expect(v).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(await detectVersion(join(t.dir, 'tidak-ada.mjs'))).toBeNull();
    } finally {
      t.cleanup();
    }
  });
});

describe('killTree (POSIX: SIGTERM lalu SIGKILL setelah masa tenggang)', () => {
  // QA-4: killTree selesai segera setelah proses keluar (tidak menunggu seluruh `graceMs`) dan timer SIGKILL dibatalkan.
  it('QA-4 selesai segera setelah proses mati, tidak menunggu seluruh masa tenggang', async () => {
    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await sleep(300);
    const t0 = Date.now();
    await killTree(child.pid, { platform: 'linux', graceMs: 1500 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(alive(child.pid)).toBe(false);
  });
});
