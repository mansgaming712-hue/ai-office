// Runner (server/runner.js + server/tasks.js) dengan CLI TIRUAN (tests/fixtures/fake-claude.mjs).
// `claude` sungguhan tidak dipakai dan tidak terpasang di mesin ini: tidak ada run nyata yang diverifikasi di sini.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildArgs, extraArgs, allowedTools, findClaude, spawnPlan, childEnv, killTreeSync, timeoutFromEnv, createLineParser, DEFAULT_TOOLS } from '../server/runner.js';
import { slugify } from '../server/outputStore.js';
import { FAKE_CLAUDE, KEY, eventsOf, startRunnerApp } from './helpers/runnerkit.js';
import { cleanEnv, sleep } from './helpers/testkit.js';

const apps = [];
const boot = async (o) => {
  const a = await startRunnerApp(o);
  apps.push(a);
  return a;
};
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

const post = (a, text = 'Buat landing page kopi', lang = 'id') => a.api('/api/tasks', { method: 'POST', body: { text, lang } });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe('GET /api/runner: deteksi CLI tiruan', () => {
  it('tersedia: versi dari --version, keyRequired true, active null', async () => {
    const a = await boot();
    const r = await a.api('/api/runner');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, available: true, reason: null, keyRequired: true, version: '9.9.9 (Fake Claude Code)', active: null });
  });

  it('CLI tidak ada: reason cli-not-found dan POST /api/tasks 503', async () => {
    const a = await boot({ bin: join(process.cwd(), 'tidak-ada', 'claude.exe') });
    const r = await a.api('/api/runner');
    expect(r.json).toMatchObject({ available: false, reason: 'cli-not-found', version: null });
    const p = await post(a);
    expect(p.status).toBe(503);
    expect(p.json.ok).toBe(false);
  });

  it('tanpa key: tidak membocorkan path/key, hanya available/reason/keyRequired/version', async () => {
    const a = await boot();
    const r = await a.api('/api/runner', { key: '' });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(['active', 'available', 'keyRequired', 'ok', 'reason', 'version']);
    expect(r.body).not.toContain(KEY);
    expect(r.body).not.toContain('fake-claude');
  });

  it('findClaude: AI_OFFICE_CLAUDE_BIN menang; PATH dicari claude.exe/.cmd/.ps1 (Windows) atau claude (POSIX)', async () => {
    expect(findClaude({ env: { AI_OFFICE_CLAUDE_BIN: FAKE_CLAUDE } })).toBe(FAKE_CLAUDE);
    expect(findClaude({ env: { AI_OFFICE_CLAUDE_BIN: join(process.cwd(), 'nope') } })).toBeNull();
    const t = await boot();
    const dir = join(t.tmp.dir, 'bin');
    mkdirSync(dir);
    writeFileSync(join(dir, 'claude.cmd'), '@echo off');
    writeFileSync(join(dir, 'claude.ps1'), '');
    writeFileSync(join(dir, 'claude'), '');
    expect(findClaude({ env: { PATH: dir }, platform: 'win32' })).toBe(join(dir, 'claude.cmd'));
    expect(findClaude({ env: { PATH: dir }, platform: 'linux' })).toBe(join(dir, 'claude'));
    expect(findClaude({ env: { PATH: join(t.tmp.dir, 'kosong') }, platform: 'linux' })).toBeNull();
  });
});

describe('argumen CLI: konstanta, teks tugas lewat stdin', () => {
  it('buildArgs default dan override env divalidasi', () => {
    const args = buildArgs({});
    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits',
      '--allowedTools', DEFAULT_TOOLS.join(','), '--disallowedTools', 'Bash,PowerShell,mcp__*',
    ]);
    expect(DEFAULT_TOOLS).toEqual(['Agent', 'WebSearch', 'WebFetch', 'TodoWrite']);
    expect(allowedTools({ AI_OFFICE_RUNNER_ALLOWED_TOOLS: 'Read, Write ,Read' })).toEqual(['Read', 'Write']);
    expect(extraArgs({ AI_OFFICE_RUNNER_EXTRA_ARGS: '--model sonnet --max-turns=20' })).toEqual(['--model', 'sonnet', '--max-turns=20']);
  });

  it.each([
    'Read;calc', 'Read&&calc', 'Read|x', 'Read$(x)', 'Read`x`', 'Read"x', 'Bash(git:*)', 'Re ad!', '../x', 'Read\nWrite',
  ])('ALLOWED_TOOLS berbahaya ditolak: %j', (v) => {
    expect(() => allowedTools({ AI_OFFICE_RUNNER_ALLOWED_TOOLS: v })).toThrow();
  });

  it.each([
    '--model;calc', '--model $(x)', '--model `x`', '--model "a b"', '--model a&b', '--model a|b', '--model a>b', '--model %PATH%',
    '--dangerously-skip-permissions', '--permission-mode bypassPermissions', '--allowedTools Bash', '--settings x', '-p',
  ])('EXTRA_ARGS berbahaya ditolak: %j', (v) => {
    expect(() => extraArgs({ AI_OFFICE_RUNNER_EXTRA_ARGS: v })).toThrow();
  });

  it('konfigurasi env tidak sah: /api/runner reason disabled dan POST 503 (tanpa menjalankan CLI)', async () => {
    const a = await boot({ env: { AI_OFFICE_RUNNER_ALLOWED_TOOLS: 'Read;calc' } });
    expect((await a.api('/api/runner')).json).toMatchObject({ available: false, reason: 'disabled' });
    expect((await post(a)).status).toBe(503);
    expect(existsSync(a.logFile)).toBe(false);
  });

  it('teks tugas hanya lewat stdin; argv tidak memuat teks pengguna; cwd = folder tugas', async () => {
    const a = await boot();
    const text = 'Rahasia $(calc) && "kutip" `x` ; rm -rf / <script> %PATH% pengguna-unik-12345';
    const r = await post(a, text);
    expect(r.status).toBe(202);
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('done');
    const log = a.fakeLog();
    expect(log.argv.join(' ')).not.toContain('pengguna-unik-12345');
    expect(log.argv.join(' ')).not.toContain('calc');
    expect(log.argv).toEqual(buildArgs({}));
    expect(log.stdin).toContain(text);
    expect(log.cwd.toLowerCase()).toBe(join(a.outputDir, r.json.task.id).toLowerCase());
  });

  it('env anak: AI_OFFICE_URL = server ini, tanpa AI_OFFICE_RUNNER*, env pengguna diwariskan', async () => {
    const a = await boot({ env: { ZZ_USER_AUTH_PROBE: 'ada' } });
    const r = await post(a);
    await a.waitDone(r.json.task.id);
    const { env } = a.fakeLog();
    expect(env.AI_OFFICE_URL).toBe(`http://127.0.0.1:${a.port}/api/events`);
    expect(Object.keys(env).filter((k) => k.startsWith('AI_OFFICE_RUNNER'))).toEqual([]);
    expect(JSON.stringify(env)).not.toContain(KEY);
    expect(JSON.stringify(env)).not.toContain('must-not-reach-child');
    // env pengguna diwariskan (bukan hanya AI_OFFICE_*): HOME dari env uji sampai ke anak lewat childEnv
    const e = childEnv({ A: '1', AI_OFFICE_RUNNER_KEY_FILE: 'x', AI_OFFICE_RUNNER: '1', CLAUDE_PROJECT_DIR: 'y' }, 'http://127.0.0.1:1/api/events');
    expect(e).toEqual({ A: '1', AI_OFFICE_URL: 'http://127.0.0.1:1/api/events' });
  });

  it('spawnPlan: .mjs lewat node; .cmd lewat cmd.exe tanpa shell dan path berbahaya ditolak', () => {
    expect(spawnPlan('C:/x/fake.mjs', ['-p'], { platform: 'linux' })).toMatchObject({ command: process.execPath, args: ['C:/x/fake.mjs', '-p'] });
    const cmd = spawnPlan('C:\\Users\\alice\\bin\\claude.cmd', ['-p', '--verbose'], { platform: 'win32', comspec: 'cmd.exe' });
    expect(cmd.command).toBe('cmd.exe');
    expect(cmd.args).toEqual(['/d', '/s', '/c', '""C:\\Users\\alice\\bin\\claude.cmd" -p --verbose"']);
    expect(cmd.options.windowsVerbatimArguments).toBe(true);
    expect(() => spawnPlan('C:\\a&calc\\claude.cmd', [], { platform: 'win32' })).toThrow();
    expect(() => spawnPlan('C:\\a%PATH%\\claude.cmd', [], { platform: 'win32' })).toThrow();
    expect(spawnPlan('/usr/bin/claude', ['-p'], { platform: 'linux' })).toMatchObject({ command: '/usr/bin/claude', args: ['-p'] });
  });

  it.skipIf(process.platform !== 'win32')('Windows: shim .cmd tanpa shell:true, teks tetap lewat stdin', async () => {
    const t = await boot();
    const shim = join(t.tmp.dir, 'bin dengan spasi', 'claude.cmd');
    mkdirSync(join(t.tmp.dir, 'bin dengan spasi'));
    writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${FAKE_CLAUDE}" %*\r\n`);
    const a = await boot({ bin: shim });
    expect((await a.api('/api/runner')).json).toMatchObject({ available: true, version: '9.9.9 (Fake Claude Code)' });
    const r = await post(a, 'lewat shim "kutip" & calc');
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('done');
    expect(a.fakeLog().stdin).toContain('lewat shim "kutip" & calc');
    expect(a.fakeLog().argv).toEqual(buildArgs({}));
  });

  it('timeoutFromEnv: default 30 menit, nilai tidak sah memakai default', () => {
    expect(timeoutFromEnv({})).toBe(30 * 60 * 1000);
    expect(timeoutFromEnv({ AI_OFFICE_RUNNER_TIMEOUT_MS: '5000' })).toBe(5000);
    expect(timeoutFromEnv({ AI_OFFICE_RUNNER_TIMEOUT_MS: 'abc' })).toBe(30 * 60 * 1000);
    expect(timeoutFromEnv({ AI_OFFICE_RUNNER_TIMEOUT_MS: '-5' })).toBe(30 * 60 * 1000);
  });
});

describe('tugas sukses: folder output, event, WebSocket', () => {
  it('202 + folder berisi task.md, CLAUDE.md, run.log, RESULT.md; status done', async () => {
    const a = await boot();
    const r = await post(a, 'Buat konten TikTok kopi susu', 'id');
    expect(r.status).toBe(202);
    expect(r.json).toMatchObject({ ok: true, task: { title: 'Buat konten TikTok kopi susu', status: 'running' } });
    const id = r.json.task.id;
    expect(id).toMatch(/^\d{8}-\d{6}-buat-konten-tiktok-kopi-susu$/);
    const done = await a.waitDone(id);
    expect(done).toMatchObject({ id, status: 'done', kind: 'task' });
    expect(done.summary).toBe('semua beres.');
    expect(done.files.map((f) => f.path).sort()).toEqual(['CLAUDE.md', 'RESULT.md', 'run.log', 'task.md']);
    const dir = join(a.outputDir, id);
    expect(readFileSync(join(dir, 'task.md'), 'utf8')).toMatch(/Buat konten TikTok kopi susu[\s\S]*Language: id|Language: id[\s\S]*Buat konten TikTok kopi susu/);
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toMatch(/RESULT\.md/);
    expect(claudeMd).toMatch(/bahasa yang dipakai CEO/);
    expect(claudeMd).toMatch(/dev-qa/);
    expect(claudeMd).toMatch(/Indonesia \(id\)/);
    expect(readFileSync(join(dir, 'run.log'), 'utf8')).toContain('"type":"result"');
    expect(readFileSync(join(dir, 'RESULT.md'), 'utf8')).toContain('Ringkasan: semua beres.');
  });

  it('event assign ceo→manager lalu report manager→ceo, keduanya membawa task id', async () => {
    const a = await boot();
    const r = await post(a, 'Tugas event');
    const id = r.json.task.id;
    await a.waitDone(id);
    const ev = eventsOf(a, id);
    expect(ev[0]).toMatchObject({ type: 'assign', from: 'ceo', to: 'manager', message: 'Tugas event', task: id });
    const last = ev.at(-1);
    expect(last).toMatchObject({ type: 'report', from: 'manager', to: 'ceo', task: id, message: 'semua beres.' });
  });

  it('GET /api/tasks: terbaru dulu, status/kind/files; WebSocket menyiarkan kind:task', async () => {
    const a = await boot();
    const msgs = [];
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/ws`);
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    await new Promise((res) => ws.once('open', res));
    const r1 = await post(a, 'Pertama');
    await a.waitDone(r1.json.task.id);
    await sleep(1100); // stempel waktu folder per detik
    const r2 = await post(a, 'Kedua');
    await a.waitDone(r2.json.task.id);
    await sleep(50);
    ws.close();
    const list = await a.api('/api/tasks');
    expect(list.json.ok).toBe(true);
    expect(list.json.tasks.map((t) => t.title)).toEqual(['Kedua', 'Pertama']);
    expect(list.json.tasks[0]).toMatchObject({ status: 'done', kind: 'task', files: 4 });
    expect(typeof list.json.tasks[0].startedAt).toBe('string');
    expect(typeof list.json.tasks[0].finishedAt).toBe('string');
    const taskMsgs = msgs.filter((m) => m.kind === 'task').map((m) => `${m.task.title}:${m.task.status}`);
    expect(taskMsgs).toEqual(['Pertama:running', 'Pertama:done', 'Kedua:running', 'Kedua:done']);
    expect(msgs.find((m) => m.kind === 'task' && m.task.status === 'done').task.summary).toBe('semua beres.');
  });

  it('manajer menulis RESULT.md sendiri: tidak ditimpa', async () => {
    const a = await boot({ mode: 'writes-result' });
    const r = await post(a);
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('done');
    expect(readFileSync(join(a.outputDir, r.json.task.id, 'RESULT.md'), 'utf8')).toContain('Ini ditulis manajer sendiri.');
  });

  it('slug ASCII aman, maks 40 karakter', () => {
    expect(slugify('Buat Konten TikTok: Kopi Susu!!')).toBe('buat-konten-tiktok-kopi-susu');
    expect(slugify('../../etc/passwd')).toBe('etc-passwd');
    expect(slugify('日本語 ñandú')).toBe('nandu');
    expect(slugify('???')).toBe('task');
    expect(slugify('a'.repeat(100)).length).toBe(40);
    expect(slugify('x '.repeat(40)).endsWith('-')).toBe(false);
  });
});

describe('fallback event subagent bila hook belum terpasang', () => {
  it('hook belum terpasang: parser stream-json memancarkan assign/working/done per subagent', async () => {
    const a = await boot({ mode: 'agents' });
    const r = await post(a, 'Tugas banyak agen');
    const id = r.json.task.id;
    await a.waitDone(id);
    const ev = eventsOf(a, id).map((e) => `${e.type}:${e.from}>${e.to}`);
    expect(ev).toEqual([
      'assign:ceo>manager',
      'assign:manager>dev-backend',
      'working:dev-backend>manager',
      'done:dev-backend>manager',
      'assign:manager>dev-qa',
      'working:dev-qa>manager',
      'blocked:dev-qa>manager',
      'report:manager>ceo',
    ]);
    const done = eventsOf(a, id).find((e) => e.type === 'done');
    expect(done.message).toBe('endpoint login jadi.');
    // prompt subagent tidak pernah masuk event
    expect(JSON.stringify(a.app.history)).not.toContain('rahasia-prompt');
  });

  it('hook sudah terpasang: tidak dobel (hanya assign dan report dari runner)', async () => {
    const a = await boot({ mode: 'agents', task: { hooksInstalled: () => true } });
    const r = await post(a, 'Tugas dengan hook');
    const id = r.json.task.id;
    await a.waitDone(id);
    expect(eventsOf(a, id).map((e) => `${e.type}:${e.from}>${e.to}`)).toEqual(['assign:ceo>manager', 'report:manager>ceo']);
  });

  it('deteksi hook memakai settings pengguna (env AI_OFFICE_USER_SETTINGS), bukan ~/.claude asli', async () => {
    const { userHooksInstalled } = await import('../server/tasks.js');
    const { hookCommand } = await import('../scripts/user-hooks.mjs');
    const t = await boot();
    const file = join(t.tmp.dir, 'settings-x.json');
    expect(userHooksInstalled({ AI_OFFICE_USER_SETTINGS: file })).toBe(false);
    writeFileSync(file, JSON.stringify({ hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: hookCommand() }] }] } }));
    expect(userHooksInstalled({ AI_OFFICE_USER_SETTINGS: file })).toBe(true);
    writeFileSync(file, '{rusak');
    expect(userHooksInstalled({ AI_OFFICE_USER_SETTINGS: file })).toBe(false);
  });
});

describe('gagal, timeout, batal, sibuk', () => {
  it('CLI exit 3: status failed + event blocked dengan alasan; run.log memuat stderr', async () => {
    const a = await boot({ mode: 'fail' });
    const r = await post(a);
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('failed');
    const last = eventsOf(a, r.json.task.id).at(-1);
    expect(last).toMatchObject({ type: 'blocked', from: 'manager', to: 'ceo' });
    expect(last.message).toContain('3');
    expect(readFileSync(join(a.outputDir, r.json.task.id, 'run.log'), 'utf8')).toContain('[stderr] boom');
    expect(existsSync(join(a.outputDir, r.json.task.id, 'RESULT.md'))).toBe(false);
  });

  it('event result is_error: failed', async () => {
    const a = await boot({ mode: 'error-result' });
    const r = await post(a);
    expect((await a.waitDone(r.json.task.id)).status).toBe('failed');
  });

  it('timeout: proses dibunuh, status failed, event blocked menyebut batas waktu', async () => {
    const a = await boot({ mode: 'hang', task: { timeoutMs: 700 } });
    const r = await post(a, 'Tugas menggantung');
    const done = await a.waitDone(r.json.task.id, { timeoutMs: 15000 });
    expect(done.status).toBe('failed');
    const { pid } = a.fakeLog();
    await sleep(300);
    expect(alive(pid)).toBe(false);
    expect(eventsOf(a, r.json.task.id).at(-1)).toMatchObject({ type: 'blocked' });
  });

  it('batal: pohon proses (termasuk cucu) mati, status cancelled, event blocked', async () => {
    const a = await boot({ mode: 'hang-tree' });
    const r = await post(a, 'Tugas dibatalkan');
    const id = r.json.task.id;
    for (let i = 0; i < 100 && !existsSync(a.logFile); i++) await sleep(50);
    const { pid, grandchild } = a.fakeLog();
    expect(alive(pid) && alive(grandchild)).toBe(true);
    const c = await a.api(`/api/tasks/${id}/cancel`, { method: 'POST', body: {} });
    expect(c.status).toBe(200);
    expect(c.json).toEqual({ ok: true });
    expect((await a.waitDone(id)).status).toBe('cancelled');
    await sleep(300);
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    expect(eventsOf(a, id).at(-1)).toMatchObject({ type: 'blocked', from: 'manager', to: 'ceo' });
    // setelah batal slot bebas lagi
    expect((await a.api('/api/runner')).json.active).toBeNull();
  });

  it('batal pada id yang tidak berjalan: 404', async () => {
    const a = await boot();
    const c = await a.api('/api/tasks/20260101-000000-x/cancel', { method: 'POST', body: {} });
    expect(c.status).toBe(404);
  });

  it('tugas kedua saat sibuk: 409, /api/runner reason busy dengan active; demo juga 409', async () => {
    const a = await boot({ mode: 'hang' });
    const r = await post(a, 'Tugas pertama menggantung');
    expect(r.status).toBe(202);
    const second = await post(a, 'Tugas kedua');
    expect(second.status).toBe(409);
    expect(second.json.ok).toBe(false);
    const demo = await a.api('/api/demo', { method: 'POST', body: { lang: 'en' } });
    expect(demo.status).toBe(409);
    const st = await a.api('/api/runner');
    expect(st.json).toMatchObject({ available: false, reason: 'busy', active: { id: r.json.task.id, title: 'Tugas pertama menggantung', kind: 'task' } });
    expect(typeof st.json.active.startedAt).toBe('string');
    // tanpa key: reason busy tetap terlihat tetapi detail tugas tidak
    const anon = await a.api('/api/runner', { key: '' });
    expect(anon.json).toMatchObject({ reason: 'busy', active: null });
    await a.api(`/api/tasks/${r.json.task.id}/cancel`, { method: 'POST', body: {} });
    await a.waitDone(r.json.task.id);
  });

  it('server berhenti: anak ikut dihentikan', async () => {
    const a = await boot({ mode: 'hang-tree' });
    const r = await post(a, 'Tugas saat server berhenti');
    expect(r.status).toBe(202);
    for (let i = 0; i < 100 && !existsSync(a.logFile); i++) await sleep(50);
    const { pid, grandchild } = a.fakeLog();
    await a.app.close();
    await sleep(300);
    expect(alive(pid)).toBe(false);
    expect(alive(grandchild)).toBe(false);
    apps.pop(); // sudah ditutup; bersihkan folder saja
    a.tmp.cleanup();
  });

  it('run.log dibatasi 5 MB', async () => {
    const a = await boot({ mode: 'flood' });
    const r = await post(a);
    const done = await a.waitDone(r.json.task.id, { timeoutMs: 20000 });
    expect(done.status).toBe('done');
    const size = statSync(join(a.outputDir, r.json.task.id, 'run.log')).size;
    expect(size).toBeLessThanOrEqual(5 * 1024 * 1024 + 200);
    expect(size).toBeGreaterThan(4 * 1024 * 1024);
    expect(readFileSync(join(a.outputDir, r.json.task.id, 'run.log'), 'utf8')).toContain('run.log truncated');
  });

  it('tugas yang masih "running" di disk setelah server mati dilaporkan failed', async () => {
    const a = await boot();
    const dir = join(a.outputDir, '20250101-000000-lama');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.ai-office-task.json'), JSON.stringify({ id: '20250101-000000-lama', title: 'Lama', kind: 'task', status: 'running', startedAt: '2025-01-01T00:00:00.000Z' }));
    const g = await a.api('/api/tasks/20250101-000000-lama');
    expect(g.json.task.status).toBe('failed');
  });
});

describe('validasi masukan POST /api/tasks', () => {
  it.each([
    ['tanpa text', {}],
    ['text bukan string', { text: 123 }],
    ['text kosong', { text: '   ' }],
    ['text 2001 karakter', { text: 'a'.repeat(2001) }],
    ['lang tidak dikenal', { text: 'ok', lang: 'fr' }],
    ['NUL di teks', { text: 'a\u0000b' }],
  ])('400: %s', async (_n, body) => {
    const a = await boot();
    const r = await a.api('/api/tasks', { method: 'POST', body });
    expect(r.status).toBe(400);
    expect(r.json.ok).toBe(false);
  });

  it('teks tepat 2000 karakter diterima', async () => {
    const a = await boot();
    const r = await post(a, 'a'.repeat(2000));
    expect(r.status).toBe(202);
    await a.waitDone(r.json.task.id);
  });

  it('body bukan JSON: 400; Content-Type salah: 415', async () => {
    const a = await boot();
    expect((await a.api('/api/tasks', { method: 'POST', body: '{rusak', headers: { 'Content-Type': 'application/json' } })).status).toBe(400);
    expect((await a.api('/api/tasks', { method: 'POST', body: 'x', headers: { 'Content-Type': 'text/plain' } })).status).toBe(415);
  });

  it('pesan error mengikuti lang permintaan', async () => {
    const a = await boot();
    const en = await a.api('/api/tasks', { method: 'POST', body: { text: '', lang: 'en' } });
    const id = await a.api('/api/tasks', { method: 'POST', body: { text: '', lang: 'id' } });
    expect(en.json.error).toMatch(/non-empty/);
    expect(id.json.error).toMatch(/tidak kosong/);
  });
});

describe('parser stream-json', () => {
  it('baris utuh, baris terpotong antar chunk, sampah dilewati, baris terlalu panjang dibuang', () => {
    const got = [];
    const p = createLineParser((o) => got.push(o), { maxLine: 50 });
    p.push('{"a":1}\nsampah\n{"b"');
    p.push(':2}\n');
    p.push(`{"panjang":"${'x'.repeat(200)}"}\n{"c":3}\n`);
    p.push('{"d":4}');
    p.end();
    expect(got).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }, { d: 4 }]);
  });

  it('killTreeSync menolak PID tidak sah tanpa melempar', () => {
    expect(() => killTreeSync(0)).not.toThrow();
    expect(() => killTreeSync(-5)).not.toThrow();
    expect(() => killTreeSync('1; calc')).not.toThrow();
    expect(() => killTreeSync(NaN)).not.toThrow();
  });
});

describe('cleanEnv (guard uji)', () => {
  it('env uji memakai runner key sementara dan bahasa Indonesia', () => {
    const e = cleanEnv();
    expect(e.AI_OFFICE_LANG).toBe('id');
    expect(e.AI_OFFICE_RUNNER_KEY_FILE).toBeTruthy();
    expect(e.AI_OFFICE_RUNNER_KEY_FILE.toLowerCase()).not.toContain('.ai-office');
  });
});
