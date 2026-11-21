// Pengerasan runner: argv (tanpa alat berkas tanpa specifier, Bash/PowerShell/MCP ditolak), template per bahasa,
// batas baca RESULT.md, /api/runner tanpa auth, dan berkas pengarah scripts/open.mjs di macOS/Linux.
// CLI tiruan saja (tests/fixtures/fake-claude.mjs); tidak menyentuh ~/.claude, ~/.ai-office, atau port 3000.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BROAD_FILE_TOOLS, DEFAULT_TOOLS, DISALLOWED_TOOLS, broadFileTools, buildArgs, killTree, spawnPlan } from '../server/runner.js';
import { MAX_RESULT_BYTES, titleOf } from '../server/tasks.js';
import { LAUNCHER_RE, cleanStaleLaunchers, launcherHtml, runOpen } from '../scripts/open.mjs';
import { KEY, startRunnerApp, tempDir } from './helpers/runnerkit.js';
import { http, randomToken } from './helpers/testkit.js';

const apps = [];
const temps = [];
const boot = async (o) => {
  const a = await startRunnerApp(o);
  apps.push(a);
  return a;
};
const tmp = () => {
  const t = tempDir('ai-office-hard-');
  temps.push(t);
  return t;
};
afterEach(async () => {
  while (apps.length) await apps.pop().close();
  while (temps.length) temps.pop().cleanup();
});
const post = (a, text = 'Tugas uji pengerasan', lang = 'id') => a.api('/api/tasks', { method: 'POST', body: { text, lang } });

describe('argv runner: alat default dan yang ditolak', () => {
  it('DEFAULT_TOOLS tanpa Read/Write/Edit/Glob/Grep; DISALLOWED_TOOLS = Bash,PowerShell,mcp__*', () => {
    expect(DEFAULT_TOOLS).toEqual(['Agent', 'WebSearch', 'WebFetch', 'TodoWrite']);
    expect(DISALLOWED_TOOLS.join(',')).toBe('Bash,PowerShell,mcp__*');
  });

  it('argv yang diterima CLI tiruan: tidak ada alat berkas, --disallowedTools berisi Bash,PowerShell,mcp__* utuh', async () => {
    const a = await boot();
    const r = await post(a);
    expect(r.status).toBe(202);
    await a.waitDone(r.json.task.id);
    const { argv } = a.fakeLog();
    const allowed = argv[argv.indexOf('--allowedTools') + 1].split(',');
    expect(allowed).toEqual(['Agent', 'WebSearch', 'WebFetch', 'TodoWrite']);
    for (const n of ['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'PowerShell']) expect(allowed).not.toContain(n);
    expect(argv[argv.indexOf('--disallowedTools') + 1]).toBe('Bash,PowerShell,mcp__*'); // satu nilai, `*` tidak di-expand
    expect(argv[argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
  });

  it('jalur .cmd Windows: "*" tetap utuh dalam satu baris perintah tanpa shell:true', () => {
    const p = spawnPlan('C:\\x\\claude.cmd', buildArgs({}), { platform: 'win32', comspec: 'C:\\Windows\\System32\\cmd.exe' });
    expect(p.options.windowsVerbatimArguments).toBe(true);
    expect(p.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(p.args[3]).toContain('--disallowedTools Bash,PowerShell,mcp__*');
    expect(p.args).toHaveLength(4);
  });

  it('broadFileTools: env admin yang membuka Read/Write/Edit tanpa specifier dikenali (untuk peringatan saat mulai)', () => {
    expect(broadFileTools({})).toEqual([]);
    expect(broadFileTools({ AI_OFFICE_RUNNER_ALLOWED_TOOLS: 'Agent,Read,Edit,WebFetch' })).toEqual(['Read', 'Edit']);
    expect(broadFileTools({ AI_OFFICE_RUNNER_ALLOWED_TOOLS: 'Bash(x)' })).toEqual([]); // env tidak sah: tidak melempar
    expect(BROAD_FILE_TOOLS).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Glob', 'Grep']));
    // Bash tetap ditolak walau diaktifkan lewat env.
    expect(buildArgs({ AI_OFFICE_RUNNER_ALLOWED_TOOLS: 'Bash,Read' })).toContain('Bash,PowerShell,mcp__*');
  });
});

describe('template CLAUDE.md menurut bahasa tugas', () => {
  it.each([
    ['id', 'Indonesia (id)', 'Sesi ini tidak punya Bash, PowerShell, maupun alat MCP', 'tidak berlaku di sini'],
    ['en', 'English (en)', 'This session has no Bash, no PowerShell, and no MCP tools', 'does not apply here'],
  ])('lang=%s memakai templat yang sesuai dan {{lang}} terisi', async (lang, langName, tools, parent) => {
    const a = await boot();
    const r = await post(a, 'Uji templat', lang);
    await a.waitDone(r.json.task.id);
    const md = readFileSync(join(a.outputDir, r.json.task.id, 'CLAUDE.md'), 'utf8');
    expect(md).toContain(tools);
    expect(md).toContain(parent);
    expect(md).toContain('RESULT.md');
    expect(md).toContain('reports/');
    expect(md).toContain(langName);
    expect(md).not.toContain('{{');
  });

  it('templat en dan id setara: placeholder sama, LF, tanpa placeholder lain', () => {
    const root = join(import.meta.dirname, '..', 'server', 'templates');
    const id = readFileSync(join(root, 'task-claude.md'), 'utf8');
    const en = readFileSync(join(root, 'task-claude.en.md'), 'utf8');
    for (const tpl of [id, en]) {
      expect(tpl).toContain('{{lang}}');
      expect(tpl.replaceAll('{{lang}}', '').includes('{{')).toBe(false);
      expect(tpl.includes('\r')).toBe(false);
    }
    const count = (s, re) => (s.match(re) ?? []).length;
    expect(count(en, /^\d\. /gm)).toBe(count(id, /^\d\. /gm));
    expect(count(en, /^## /gm)).toBe(count(id, /^## /gm));
  });
});

describe('RESULT.md besar dan judul', () => {
  it('RESULT.md > 1 MB tidak dibaca utuh: tugas tetap selesai, ringkasan dari teks result', async () => {
    const a = await boot({ mode: 'huge-result' });
    const r = await post(a);
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('done');
    expect(done.summary).toContain('Ringkasan dari teks result');
    expect(statSync(join(a.outputDir, r.json.task.id, 'RESULT.md')).size).toBeGreaterThan(MAX_RESULT_BYTES);
  });

  it('titleOf: membuang kontrol, bidi, U+2028/2029; baris pertama yang berisi dipakai', () => {
    const bidi = String.fromCharCode(0x202e);
    const ls = String.fromCharCode(0x2028);
    const esc = String.fromCharCode(0x1b);
    expect(titleOf(`a${esc}[31mb${esc}[0m`)).toBe('ab');
    expect(titleOf(`abc${bidi}def`)).toBe('abcdef');
    expect(titleOf(`satu${ls}dua`)).toBe('satu dua');
    expect(titleOf(`${bidi}\n\n  Judul asli  \nbaris dua`)).toBe('Judul asli');
    expect(titleOf('x'.repeat(200))).toHaveLength(80);
  });
});

describe('GET /api/runner tanpa auth: versi dan busy disembunyikan (mode token dan terbuka)', () => {
  it('mode lokal tidak berubah: tanpa key tetap melihat versi dan reason busy', async () => {
    const a = await boot({ mode: 'hang' });
    const r = await post(a);
    const anon = await a.api('/api/runner', { key: '' });
    expect(anon.json).toMatchObject({ version: '9.9.9 (Fake Claude Code)', reason: 'busy', active: null });
    await a.api(`/api/tasks/${r.json.task.id}/cancel`, { method: 'POST', body: {} });
    await a.waitDone(r.json.task.id);
  });

  it('mode token: tanpa auth version null dan reason busy jadi null; dengan Bearer tetap lengkap', async () => {
    const token = randomToken();
    const a = await boot({ opts: { token }, mode: 'hang' });
    const bearer = { Authorization: `Bearer ${token}` };
    const r = await a.api('/api/tasks', { method: 'POST', body: { text: 'Tugas token' }, headers: bearer, key: '' });
    expect(r.status).toBe(202);
    const anon = await a.api('/api/runner', { key: '' });
    expect(anon.json).toMatchObject({ ok: true, version: null, reason: null, active: null, keyRequired: false });
    expect(anon.body).not.toContain('Fake Claude');
    const auth = await a.api('/api/runner', { key: '', headers: bearer });
    expect(auth.json).toMatchObject({ version: '9.9.9 (Fake Claude Code)', reason: 'busy' });
    expect(auth.json.active).not.toBeNull();
    await a.api(`/api/tasks/${r.json.task.id}/cancel`, { method: 'POST', body: {}, headers: bearer, key: '' });
  });

  it('mode terbuka (runner aktif): tanpa auth version null; dengan Bearer versi terlihat', async () => {
    const token = randomToken();
    const host = 'office.example.com';
    const a = await boot({ opts: { token, allowedHosts: [host], runnerEnabled: true } });
    const anon = await http(a.port, '/api/runner', { headers: { Host: host } });
    expect(anon.json).toMatchObject({ available: true, version: null, reason: null });
    const auth = await http(a.port, '/api/runner', { headers: { Host: host, Authorization: `Bearer ${token}` } });
    expect(auth.json.version).toBe('9.9.9 (Fake Claude Code)');
  });
});

describe('scripts/open.mjs: berkas pengarah di macOS/Linux (key tidak masuk argv)', () => {
  const KEY43 = 'a'.repeat(43);
  const URL_KEY = `http://localhost:3456/#key=${KEY43}`;

  function harness(platform, extra = {}) {
    const t = tmp();
    const outDir = join(t.dir, 'output');
    const out = [];
    const errs = [];
    const seen = { launched: [], html: null, existedAtLaunch: false, mode: null, existedAtSleep: false, sleptMs: null };
    const opts = {
      env: { PORT: '3456' },
      platform,
      outputDir: outDir,
      loadKey: () => KEY43,
      launch: async (cmd, args) => {
        seen.launched.push([cmd, args]);
        const file = args[0];
        if (existsSync(file)) {
          seen.existedAtLaunch = true;
          seen.html = readFileSync(file, 'utf8');
          seen.mode = statSync(file).mode & 0o777;
        }
        return { error: extra.launchError ?? null };
      },
      sleep: async (ms) => {
        seen.sleptMs = ms;
        seen.existedAtSleep = seen.launched.length > 0 && existsSync(seen.launched[0][1][0]);
      },
      log: (m) => out.push(m),
      err: (m) => errs.push(m),
      ...extra,
    };
    return { t, outDir, out, errs, seen, opts };
  }

  it.each([
    ['darwin', 'open'],
    ['linux', 'xdg-open'],
  ])('%s: argv hanya berisi path berkas; HTML berisi URL; berkas dihapus setelah ~20 detik', async (platform, cmd) => {
    const h = harness(platform);
    const code = await runOpen([], h.opts);
    expect(code).toBe(0);
    expect(h.seen.launched).toHaveLength(1);
    const [c, args] = h.seen.launched[0];
    expect(c).toBe(cmd);
    expect(args).toHaveLength(1);
    expect(args[0].startsWith(h.outDir)).toBe(true);
    expect(args[0].split(/[\\/]/).pop()).toMatch(LAUNCHER_RE);
    expect(args.join(' ')).not.toContain(KEY43);
    expect(h.seen.existedAtLaunch).toBe(true);
    expect(h.seen.html).toContain(`location.replace("${URL_KEY}")`);
    expect(h.seen.html).toContain(`href="${URL_KEY}"`);
    if (process.platform !== 'win32') expect(h.seen.mode).toBe(0o600);
    expect(h.seen.sleptMs).toBe(20000);
    expect(h.seen.existedAtSleep).toBe(true); // masih ada saat menunggu
    expect(existsSync(args[0])).toBe(false); // sudah dihapus
    expect(readdirSync(h.outDir)).toEqual([]);
    expect(h.out.join('\n')).not.toContain(KEY43);
  });

  it('Windows tidak berubah: URL langsung ke explorer.exe, tanpa berkas', async () => {
    const h = harness('win32');
    expect(await runOpen([], h.opts)).toBe(0);
    expect(h.seen.launched).toEqual([['explorer.exe', [URL_KEY]]]);
    expect(existsSync(h.outDir)).toBe(false);
    expect(h.seen.sleptMs).toBeNull();
  });

  it('mode token (tanpa key di URL): URL langsung, tanpa berkas', async () => {
    const h = harness('linux', { env: { PORT: '3456', AI_OFFICE_TOKEN: randomToken() } });
    expect(await runOpen([], h.opts)).toBe(0);
    expect(h.seen.launched).toEqual([['xdg-open', ['http://localhost:3456/']]]);
    expect(existsSync(h.outDir)).toBe(false);
  });

  it('--dry-run: tidak membuat berkas, key tidak tampil, path berkas disebut', async () => {
    const h = harness('linux');
    expect(await runOpen(['--dry-run'], h.opts)).toBe(0);
    expect(h.seen.launched).toEqual([]);
    expect(existsSync(h.outDir)).toBe(false);
    const text = h.out.join('\n');
    expect(text).toContain('xdg-open');
    expect(text).toContain('aio-open-');
    expect(text).not.toContain(KEY43);
  });

  it('gagal membuka: berkas langsung dihapus, key disamarkan di pesan error, exit 1', async () => {
    const h = harness('linux', { launchError: Object.assign(new Error('x'), { code: 'ENOENT' }) });
    expect(await runOpen([], h.opts)).toBe(1);
    expect(readdirSync(h.outDir)).toEqual([]);
    expect(h.errs.join('\n')).not.toContain(KEY43);
    expect(h.errs.join('\n')).toContain('#key=***');
    expect(h.seen.sleptMs).toBeNull();
  });

  it('berkas sisa lebih tua dari beberapa menit dibersihkan saat dijalankan lagi; yang baru dan berkas lain tetap', async () => {
    const h = harness('linux');
    mkdirSync(h.outDir, { recursive: true });
    const old = join(h.outDir, 'aio-open-0123456789abcdef.html');
    const fresh = join(h.outDir, 'aio-open-fedcba9876543210.html');
    const other = join(h.outDir, 'bukan-pengarah.html');
    for (const f of [old, fresh, other]) writeFileSync(f, 'x');
    const past = new Date(Date.now() - 10 * 60_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(await runOpen([], h.opts)).toBe(0);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(cleanStaleLaunchers(join(h.t.dir, 'tidak-ada'))).toBe(0); // folder hilang: tidak melempar
  });

  it('launcherHtml: URL di-escape untuk <script> dan atribut; tautan cadangan tanpa key terlihat', () => {
    const html = launcherHtml('http://localhost:3000/#key=a"b<c>');
    expect(html).not.toContain('</script><');
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('&quot;');
    expect(html).toContain('u003c');
    const shown = launcherHtml(URL_KEY).split('<a ')[1];
    expect(shown.split('>')[1]).toBe('http://localhost:3456/</a'); // teks tautan tanpa key
  });
});

describe('server tanpa key tidak dipakai', () => {
  it('KEY uji tidak bocor ke argv fake CLI', async () => {
    const a = await boot();
    const r = await post(a);
    await a.waitDone(r.json.task.id);
    expect(a.fakeLog().argv.join(' ')).not.toContain(KEY);
  });
});

describe('N1: killTree Windows tidak menembak PID anak yang sudah keluar', () => {
  it('child sudah exit: taskkill tidak dijalankan (proses lain ber-PID itu tetap hidup)', async () => {
    const { spawn } = await import('node:child_process');
    const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const gone = { exitCode: 0, signalCode: null };
      await killTree(bystander.pid, { platform: 'win32', child: gone });
      expect(bystander.exitCode).toBeNull();
      expect(() => process.kill(bystander.pid, 0)).not.toThrow();
      const killed = { exitCode: null, signalCode: 'SIGKILL' };
      await killTree(bystander.pid, { platform: 'win32', child: killed });
      expect(() => process.kill(bystander.pid, 0)).not.toThrow();
    } finally {
      bystander.kill();
    }
  });
});

describe('N2: open.mjs folder output dan sinyal', () => {
  const KEY43 = 'a'.repeat(43);
  const base = (dir, extra = {}) => {
    const errs = [];
    const state = { launched: 0, sigDuring: null };
    const sigBefore = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
    return {
      errs,
      state,
      sigBefore,
      opts: {
        env: { PORT: '3456' },
        platform: 'linux',
        outputDir: dir,
        loadKey: () => KEY43,
        launch: async () => {
          state.launched += 1;
          state.sigDuring = process.listenerCount('SIGINT') + process.listenerCount('SIGTERM');
          return { error: null };
        },
        sleep: async () => {},
        log: () => {},
        err: (m) => errs.push(m),
        ...extra,
      },
    };
  };

  it.skipIf(process.platform === 'win32')('folder output baru dibuat 0700; world-writable (0777) ditolak tanpa chmod; group-writable (0775) diterima', async () => {
    const t = tmp();
    const fresh = join(t.dir, 'baru');
    const a = base(fresh);
    expect(await runOpen([], a.opts)).toBe(0);
    expect(statSync(fresh).mode & 0o077).toBe(0);

    const open = join(t.dir, 'terbuka');
    mkdirSync(open);
    chmodSync(open, 0o777);
    const b = base(open);
    expect(await runOpen([], b.opts)).toBe(1);
    expect(b.state.launched).toBe(0); // browser tidak dibuka, key tidak masuk argv
    expect(readdirSync(open)).toEqual([]);
    expect(statSync(open).mode & 0o777).toBe(0o777); // tidak di-chmod
    expect(b.errs.join('\n')).toContain('chmod o-w');
    expect(b.errs.join('\n')).not.toContain(KEY43);

    const grp = join(t.dir, 'grup');
    mkdirSync(grp);
    chmodSync(grp, 0o775);
    const seen = {};
    const c = base(grp, {
      launch: async (_cmd, args) => {
        seen.mode = statSync(args[0]).mode & 0o777;
        return { error: null };
      },
    });
    expect(await runOpen([], c.opts)).toBe(0);
    expect(seen.mode).toBe(0o600);
    expect(statSync(grp).mode & 0o777).toBe(0o775);
  });

  it('handler SIGINT/SIGTERM dipasang selama berkas ada, dilepas setelahnya', async () => {
    const t = tmp();
    const a = base(join(t.dir, 'output'));
    expect(await runOpen([], a.opts)).toBe(0);
    expect(a.state.sigDuring).toBe(a.sigBefore + 2);
    expect(process.listenerCount('SIGINT') + process.listenerCount('SIGTERM')).toBe(a.sigBefore);
  });

  it('Windows (tanpa berkas): tidak memasang handler sinyal', async () => {
    const t = tmp();
    const a = base(join(t.dir, 'output'), { platform: 'win32' });
    expect(await runOpen([], a.opts)).toBe(0);
    expect(a.state.sigDuring).toBe(a.sigBefore);
  });
});
