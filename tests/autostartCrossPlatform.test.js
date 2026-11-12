// Autostart lintas platform (scripts/autostart.mjs). Tidak ada launchctl/systemctl/powershell sungguhan
// yang dijalankan: platform, home, folder proyek, dan seluruh I/O disuntikkan. Isi plist/unit dites sebagai
// fungsi murni, jadi ikut berjalan di Windows. Platform asli baru terbukti lewat CI (macOS/Linux).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LAUNCHD_LABEL, SYSTEMD_UNIT, launchdPlist, parseArgs, pathProblem, runAutostart, systemdPathValue, systemdQuote,
  systemdUnit, targetsFor, xmlEscape,
} from '../scripts/autostart.mjs';
import { ROOT } from './helpers/testkit.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const MAC = { nodePath: '/opt/homebrew/bin/node', projectDir: '/Users/alice/ai-office' };
const LIN = { nodePath: '/usr/bin/node', projectDir: '/home/alice/ai-office' };

/** I/O palsu: mencatat semua panggilan, tidak menyentuh sistem. */
function fakeIo({ existing = [], status = {}, health = false } = {}) {
  const calls = [];
  const files = new Map();
  const result = (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = Object.entries(status).find(([k]) => key.startsWith(k));
    return hit ? { status: hit[1], stdout: '', stderr: hit[1] ? 'gagal' : '' } : { status: 0, stdout: 'ok', stderr: '' };
  };
  return {
    calls, files,
    exists: (p) => existing.includes(p) || files.has(p),
    mkdir: (p) => calls.push(['mkdir', p]),
    write: (p, c) => { calls.push(['write', p]); files.set(p, c); },
    remove: (p) => { calls.push(['remove', p]); files.delete(p); },
    run: (cmd, args) => { calls.push(['run', [cmd, ...args].join(' ')]); return result(cmd, args); },
    runInherit: (cmd, args) => { calls.push(['inherit', [cmd, ...args].join(' ')]); return result(cmd, args); },
    health: async () => health,
  };
}
const collect = () => {
  const out = [];
  const errs = [];
  return { out, errs, log: (m) => out.push(m), err: (m) => errs.push(m) };
};
const base = (platform, extra = {}) => ({
  platform,
  home: platform === 'darwin' ? '/Users/alice' : '/home/alice',
  uid: 501,
  ...(platform === 'darwin' ? MAC : LIN),
  ...extra,
});
const runCalls = (io) => io.calls.filter((c) => c[0] === 'run').map((c) => c[1]);

describe('pathProblem', () => {
  it('menerima path absolut biasa (termasuk spasi dan path Windows)', () => {
    expect(pathProblem('/home/alice/ai-office')).toBeNull();
    expect(pathProblem('/Users/alice/My Projects/ai-office')).toBeNull();
    expect(pathProblem('C:\\Users\\alice\\ai-office')).toBeNull();
  });
  it.each([
    ['baris baru', '/home/alice/a\nb'],
    ['carriage return', '/home/alice/a\rb'],
    ['NUL', '/home/alice/a\u0000b'],
    ['tab', '/home/alice/a\tb'],
    ['ESC', '/home/alice/a\u001bb'],
    ['DEL', '/home/alice/a\u007fb'],
    ['pemisah baris Unicode', '/home/alice/a\u2028b'],
  ])('menolak %s', (_n, p) => {
    expect(pathProblem(p, 'path proyek')).toMatch(/path proyek memuat baris baru atau karakter kontrol/);
  });
  it('menolak kosong, bukan string, dan path relatif', () => {
    expect(pathProblem('')).toMatch(/kosong/);
    expect(pathProblem(undefined)).toMatch(/kosong/);
    expect(pathProblem('relatif/ai-office')).toMatch(/absolut/);
  });
});

describe('escaping', () => {
  it('xmlEscape: & < > " \'', () => {
    expect(xmlEscape(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });
  it('systemdQuote: kutip ganda, \\ dan " di-escape, % jadi %%, $ jadi $$', () => {
    expect(systemdQuote('/usr/bin/node')).toBe('"/usr/bin/node"');
    expect(systemdQuote('/home/a b/node')).toBe('"/home/a b/node"');
    expect(systemdQuote('/h/a"b')).toBe('"/h/a\\"b"');
    expect(systemdQuote('/h/a\\b')).toBe('"/h/a\\\\b"');
    expect(systemdQuote('/h/100%/x')).toBe('"/h/100%%/x"');
    expect(systemdQuote('/h/$HOME/x')).toBe('"/h/$$HOME/x"');
  });
  it('systemdPathValue: hanya % yang di-escape', () => {
    expect(systemdPathValue('/h/a b/100%')).toBe('/h/a b/100%%');
  });
});

describe('launchdPlist', () => {
  const plist = launchdPlist({ ...MAC, logDir: '/Users/alice/ai-office/logs' });

  it('berisi label, node + server/index.js, WorkingDirectory, RunAtLoad, KeepAlive saat crash, ThrottleInterval, log', () => {
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist')).toBe(true);
    expect(plist).toContain(`<key>Label</key>\n  <string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/homebrew/bin/node</string>\n    <string>/Users/alice/ai-office/server/index.js</string>');
    expect(plist).toContain('<key>WorkingDirectory</key>\n  <string>/Users/alice/ai-office</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
    expect(plist).toContain('<key>ThrottleInterval</key>\n  <integer>10</integer>');
    expect(plist).toContain('<key>StandardOutPath</key>\n  <string>/Users/alice/ai-office/logs/server.log</string>');
    expect(plist).toContain('<key>StandardErrorPath</key>\n  <string>/Users/alice/ai-office/logs/server.log</string>');
  });
  it('tidak menyetel HOST/PORT (default server tetap 127.0.0.1:3000) dan tidak memuat token', () => {
    expect(plist).not.toMatch(/HOST|PORT|TOKEN|EnvironmentVariables/);
  });
  it('men-escape XML pada path (& < > " \')', () => {
    const p = launchdPlist({ nodePath: '/opt/a&b/node', projectDir: `/Users/al<ice>/"x"/it's` });
    expect(p).toContain('<string>/opt/a&amp;b/node</string>');
    expect(p).toContain('<string>/Users/al&lt;ice&gt;/&quot;x&quot;/it&apos;s</string>');
    // Isi elemen <string> tidak boleh memuat & < " ' mentah: semuanya sudah jadi entitas.
    for (const m of p.matchAll(/<string>([^<]*)<\/string>/g)) expect(m[1]).not.toMatch(/["']|&(?!(amp|lt|gt|quot|apos);)/);
  });
  it('menolak path node atau proyek dengan baris baru/karakter kontrol atau relatif', () => {
    expect(() => launchdPlist({ nodePath: '/usr/bin/node\n<x/>', projectDir: MAC.projectDir })).toThrow(/path node/);
    expect(() => launchdPlist({ nodePath: MAC.nodePath, projectDir: '/Users/alice/a\nb' })).toThrow(/path proyek/);
    expect(() => launchdPlist({ nodePath: MAC.nodePath, projectDir: '/Users/alice/a\u0007b' })).toThrow(/karakter kontrol/);
    expect(() => launchdPlist({ nodePath: 'node', projectDir: MAC.projectDir })).toThrow(/absolut/);
  });
});

describe('systemdUnit', () => {
  const unit = systemdUnit(LIN);

  it('berisi ExecStart node + server, WorkingDirectory, Restart=on-failure, RestartSec, batas restart, WantedBy', () => {
    expect(unit).toContain('[Unit]');
    expect(unit).toContain('[Service]');
    expect(unit).toContain('[Install]');
    expect(unit).toContain('ExecStart="/usr/bin/node" "/home/alice/ai-office/server/index.js"');
    expect(unit).toContain('WorkingDirectory=/home/alice/ai-office');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toMatch(/^RestartSec=\d+$/m);
    expect(unit).toMatch(/^StartLimitIntervalSec=\d+$/m);
    expect(unit).toMatch(/^StartLimitBurst=\d+$/m);
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).not.toMatch(/HOST=|PORT=|TOKEN/);
  });
  it('men-escape aturan kutip systemd (spasi, kutip, backslash, %, $)', () => {
    const u = systemdUnit({ nodePath: '/opt/my node/bin/node', projectDir: '/home/al"ice/100%/$x\\y' });
    expect(u).toContain('ExecStart="/opt/my node/bin/node" "/home/al\\"ice/100%%/$$x\\\\y/server/index.js"');
    expect(u).toContain('WorkingDirectory=/home/al"ice/100%%/$x\\y');
  });
  it('menolak path berbahaya (baris baru dapat menyisipkan direktif)', () => {
    expect(() => systemdUnit({ nodePath: LIN.nodePath, projectDir: '/home/a\nExecStartPre=/bin/evil' })).toThrow(/path proyek/);
    expect(() => systemdUnit({ nodePath: '/usr/bin/node\nUser=root', projectDir: LIN.projectDir })).toThrow(/path node/);
    expect(() => systemdUnit({ nodePath: LIN.nodePath, projectDir: '/home/a\u0000b' })).toThrow(/karakter kontrol/);
  });
});

describe('targetsFor', () => {
  it('macOS dan Linux: file di bawah home pengguna', () => {
    expect(targetsFor('darwin', { home: '/Users/alice', projectDir: '/Users/alice/ai-office' }).file).toBe(`/Users/alice/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`);
    expect(targetsFor('linux', { home: '/home/alice', projectDir: '/home/alice/ai-office' }).file).toBe(`/home/alice/.config/systemd/user/${SYSTEMD_UNIT}`);
    expect(targetsFor('linux', { home: '/home/alice', projectDir: '/home/alice/ai-office' }).logDir).toBe('/home/alice/ai-office/logs');
  });
  it('Windows: shortcut di folder Startup (APPDATA)', () => {
    const t = targetsFor('win32', { home: 'C:\\Users\\alice', projectDir: 'C:\\Users\\alice\\ai-office', env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' } });
    expect(t.file).toBe('C:\\Users\\alice\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\AI Office.lnk');
  });
});

describe('parseArgs', () => {
  it('perintah dan --dry-run', () => {
    expect(parseArgs(['install', '--dry-run'])).toMatchObject({ command: 'install', dryRun: true, error: null });
    for (const c of ['install', 'uninstall', 'stop', 'status']) expect(parseArgs([c]).error).toBeNull();
  });
  it('galat: tanpa perintah, perintah/opsi asing, argumen berlebih', () => {
    expect(parseArgs([]).error).toMatch(/belum diberikan/);
    expect(parseArgs(['hapus']).error).toMatch(/tidak dikenal/);
    expect(parseArgs(['install', '--paksa']).error).toMatch(/Opsi tidak dikenal/);
    expect(parseArgs(['install', 'stop']).error).toMatch(/berlebih/);
  });
  it('opsi khusus uji (--platform dll.) ditolak tanpa --dry-run, dan platform harus valid', () => {
    expect(parseArgs(['install', '--platform=linux']).error).toMatch(/hanya boleh bersama --dry-run/);
    expect(parseArgs(['install', '--dry-run', '--platform=linux']).error).toBeNull();
    expect(parseArgs(['install', '--dry-run', '--platform=freebsd']).error).toMatch(/--platform harus/);
  });
});

describe('runAutostart: macOS', () => {
  it('install: tulis plist di ~/Library/LaunchAgents, lalu launchctl bootstrap gui/<uid>', async () => {
    const io = fakeIo();
    const c = collect();
    const code = await runAutostart('install', { ...base('darwin'), io, ...c });
    const plist = '/Users/alice/Library/LaunchAgents/com.ai-office.server.plist';
    expect(code).toBe(0);
    expect(io.files.get(plist)).toBe(launchdPlist({ ...MAC, logDir: '/Users/alice/ai-office/logs' }));
    expect(runCalls(io)).toEqual([
      `launchctl bootout gui/501/${LAUNCHD_LABEL}`,
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
    expect(io.calls.filter((x) => x[0] === 'write').every((x) => x[1].startsWith('/Users/alice/'))).toBe(true);
    expect(io.calls).toContainEqual(['mkdir', '/Users/alice/ai-office/logs']);
  });
  it('install: bootstrap gagal -> fallback launchctl load -w', async () => {
    const io = fakeIo({ status: { 'launchctl bootstrap': 5 } });
    const code = await runAutostart('install', { ...base('darwin'), io, ...collect() });
    expect(code).toBe(0);
    expect(runCalls(io).at(-1)).toBe('launchctl load -w /Users/alice/Library/LaunchAgents/com.ai-office.server.plist');
  });
  it('install: bootstrap dan load gagal -> kode 1 dengan petunjuk manual', async () => {
    const io = fakeIo({ status: { 'launchctl bootstrap': 5, 'launchctl load': 1 } });
    const c = collect();
    expect(await runAutostart('install', { ...base('darwin'), io, ...c })).toBe(1);
    expect(c.errs.join('\n')).toMatch(/launchctl bootstrap gui\/501/);
  });
  it('uninstall: bootout lalu hapus plist; fallback unload bila bootout gagal', async () => {
    const plist = '/Users/alice/Library/LaunchAgents/com.ai-office.server.plist';
    const io = fakeIo({ existing: [plist] });
    expect(await runAutostart('uninstall', { ...base('darwin'), io, ...collect() })).toBe(0);
    expect(runCalls(io)).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(io.calls).toContainEqual(['remove', plist]);
    const io2 = fakeIo({ existing: [plist], status: { 'launchctl bootout': 3 } });
    await runAutostart('uninstall', { ...base('darwin'), io: io2, ...collect() });
    expect(runCalls(io2)).toContain(`launchctl unload -w ${plist}`);
  });
  it('stop: bootout saja, plist tidak dihapus', async () => {
    const io = fakeIo();
    expect(await runAutostart('stop', { ...base('darwin'), io, ...collect() })).toBe(0);
    expect(runCalls(io)).toEqual([`launchctl bootout gui/501/${LAUNCHD_LABEL}`]);
    expect(io.calls.some((x) => x[0] === 'remove' || x[0] === 'write')).toBe(false);
  });
  it('status: hanya membaca (launchctl print + health)', async () => {
    const io = fakeIo({ health: true });
    const c = collect();
    expect(await runAutostart('status', { ...base('darwin'), io, ...c })).toBe(0);
    expect(runCalls(io)).toEqual([`launchctl print gui/501/${LAUNCHD_LABEL}`]);
    expect(io.calls.some((x) => ['write', 'remove', 'mkdir'].includes(x[0]))).toBe(false);
    expect(c.out.join('\n')).toMatch(/Server\s+: menjawab/);
  });
  it('path proyek berbahaya: ditolak sebelum menulis apa pun', async () => {
    const io = fakeIo();
    const c = collect();
    const code = await runAutostart('install', { ...base('darwin'), projectDir: '/Users/alice/a\nb', io, ...c });
    expect(code).toBe(1);
    expect(io.calls).toEqual([]);
    expect(c.errs.join('\n')).toMatch(/baris baru atau karakter kontrol/);
  });
});

describe('runAutostart: Linux', () => {
  const UNIT = '/home/alice/.config/systemd/user/ai-office.service';

  it('install: cek systemd user, tulis unit, daemon-reload, enable --now', async () => {
    const io = fakeIo();
    const c = collect();
    expect(await runAutostart('install', { ...base('linux'), io, ...c })).toBe(0);
    expect(io.files.get(UNIT)).toBe(systemdUnit(LIN));
    expect(runCalls(io)).toEqual([
      'systemctl --user show-environment',
      'systemctl --user daemon-reload',
      `systemctl --user enable --now ${SYSTEMD_UNIT}`,
    ]);
    expect(c.out.join('\n')).toMatch(/loginctl enable-linger/);
  });
  it('install: systemctl --user tidak tersedia -> kode 1, petunjuk manual, tidak menulis apa pun', async () => {
    const io = fakeIo({ status: { 'systemctl --user show-environment': 1 } });
    const c = collect();
    expect(await runAutostart('install', { ...base('linux'), io, ...c })).toBe(1);
    expect(io.calls.some((x) => x[0] === 'write' || x[0] === 'mkdir')).toBe(false);
    const msg = c.errs.join('\n');
    expect(msg).toMatch(/systemd user tidak tersedia/);
    expect(msg).toMatch(/Petunjuk manual/);
    expect(msg).toMatch(/loginctl enable-linger/);
    expect(runCalls(io).some((x) => /loginctl/.test(x))).toBe(false); // hanya disebut, tidak dijalankan
  });
  it('install: perintah systemctl tidak ada sama sekali (error spawn) -> tidak crash', async () => {
    const io = fakeIo();
    io.run = () => ({ status: 127, stdout: '', stderr: '', error: new Error('ENOENT') });
    const c = collect();
    expect(await runAutostart('install', { ...base('linux'), io, ...c })).toBe(1);
    expect(c.errs.join('\n')).toMatch(/systemctl tidak ditemukan/);
  });
  it('install: enable --now gagal -> kode 1 dengan petunjuk journalctl', async () => {
    const io = fakeIo({ status: { 'systemctl --user enable': 1 } });
    const c = collect();
    expect(await runAutostart('install', { ...base('linux'), io, ...c })).toBe(1);
    expect(c.errs.join('\n')).toMatch(/journalctl --user -u ai-office\.service/);
  });
  it('uninstall: disable --now, hapus unit, daemon-reload', async () => {
    const io = fakeIo({ existing: [UNIT] });
    expect(await runAutostart('uninstall', { ...base('linux'), io, ...collect() })).toBe(0);
    expect(runCalls(io)).toEqual([
      'systemctl --user show-environment',
      `systemctl --user disable --now ${SYSTEMD_UNIT}`,
      'systemctl --user daemon-reload',
    ]);
    expect(io.calls).toContainEqual(['remove', UNIT]);
  });
  it('uninstall tanpa systemd user: tetap hapus file unit', async () => {
    const io = fakeIo({ status: { 'systemctl --user show-environment': 1 } });
    expect(await runAutostart('uninstall', { ...base('linux'), io, ...collect() })).toBe(0);
    expect(io.calls).toContainEqual(['remove', UNIT]);
  });
  it('stop: systemctl --user stop saja', async () => {
    const io = fakeIo();
    expect(await runAutostart('stop', { ...base('linux'), io, ...collect() })).toBe(0);
    expect(runCalls(io)).toEqual(['systemctl --user show-environment', `systemctl --user stop ${SYSTEMD_UNIT}`]);
  });
  it('status: hanya membaca', async () => {
    const io = fakeIo();
    expect(await runAutostart('status', { ...base('linux'), io, ...collect() })).toBe(0);
    expect(io.calls.some((x) => ['write', 'remove', 'mkdir'].includes(x[0]))).toBe(false);
    expect(runCalls(io)).toContain(`systemctl --user is-active ${SYSTEMD_UNIT}`);
  });
});

describe('runAutostart: Windows (dispatcher ke scripts/windows, tanpa menjalankan powershell)', () => {
  const win = { platform: 'win32', home: 'C:\\Users\\alice', projectDir: 'C:\\Users\\alice\\ai-office', nodePath: 'C:\\Program Files\\nodejs\\node.exe' };
  it.each([
    ['install', 'install-autostart.ps1'],
    ['uninstall', 'uninstall-autostart.ps1'],
    ['stop', 'stop-ai-office.ps1'],
  ])('%s memanggil %s dengan -File', async (cmd, file) => {
    const io = fakeIo();
    expect(await runAutostart(cmd, { ...win, io, ...collect() })).toBe(0);
    expect(io.calls).toEqual([['inherit', `powershell -NoProfile -ExecutionPolicy Bypass -File C:\\Users\\alice\\ai-office\\scripts\\windows\\${file}`]]);
  });
  it('kode keluar skrip PowerShell diteruskan; powershell tidak ada -> 1 dengan pesan', async () => {
    const io = fakeIo({ status: { powershell: 3 } });
    expect(await runAutostart('install', { ...win, io, ...collect() })).toBe(3);
    const io2 = fakeIo();
    io2.runInherit = () => ({ status: 127, error: new Error('ENOENT') });
    const c = collect();
    expect(await runAutostart('install', { ...win, io: io2, ...c })).toBe(1);
    expect(c.errs.join('\n')).toMatch(/powershell/i);
  });
  it('status: membaca shortcut dan health, tidak memanggil PowerShell', async () => {
    const io = fakeIo({ health: true });
    const c = collect();
    expect(await runAutostart('status', { ...win, env: { APPDATA: 'C:\\Users\\alice\\AppData\\Roaming' }, io, ...c })).toBe(0);
    expect(io.calls).toEqual([]);
    expect(c.out.join('\n')).toMatch(/Windows/);
  });
});

describe('--dry-run', () => {
  const dirs = [];
  afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'aio-autostart-'));
    dirs.push(d);
    return d;
  };

  it.each(['darwin', 'linux', 'win32'])('%s: mencetak rencana, tidak menulis file dan tidak menjalankan apa pun', async (platform) => {
    const home = tmp();
    const c = collect();
    const code = await runAutostart('install', { ...base(platform), home, dryRun: true, ...c });
    const text = c.out.join('\n');
    expect(code).toBe(0);
    expect(text).toMatch(/\[dry-run\]/);
    expect(readdirSync(home)).toEqual([]);
  });
  it('macOS: mencetak isi plist dan perintah launchctl', async () => {
    const c = collect();
    await runAutostart('install', { ...base('darwin'), dryRun: true, ...c });
    const t = c.out.join('\n');
    expect(t).toContain('<key>RunAtLoad</key>');
    expect(t).toContain('launchctl bootstrap gui/501 /Users/alice/Library/LaunchAgents/com.ai-office.server.plist');
  });
  it('Linux: mencetak isi unit dan perintah systemctl, tanpa memeriksa systemd sungguhan', async () => {
    const c = collect();
    await runAutostart('install', { ...base('linux'), dryRun: true, ...c });
    const t = c.out.join('\n');
    expect(t).toContain('Restart=on-failure');
    expect(t).toContain('systemctl --user enable --now ai-office.service');
    expect(t).not.toMatch(/show-environment/);
  });
  it('status --dry-run tidak mengklaim keadaan (hanya mencetak yang akan diperiksa)', async () => {
    const c = collect();
    expect(await runAutostart('status', { ...base('linux'), dryRun: true, ...c })).toBe(0);
    expect(c.out.join('\n')).not.toMatch(/Aktif\s+:|Termuat\s+:/);
  });
  it('platform tidak dikenal ditolak dengan pesan', async () => {
    const c = collect();
    expect(await runAutostart('install', { platform: 'sunos', ...c })).toBe(1);
    expect(c.errs.join('\n')).toMatch(/belum didukung/);
  });
});

describe('CLI (proses sungguhan, hanya --dry-run dan --help)', () => {
  const cli = (...args) => spawnSync(process.execPath, ['scripts/autostart.mjs', ...args], { cwd: ROOT, encoding: 'utf8', timeout: 30000 });

  it('install --dry-run --platform=linux mencetak unit dengan path contoh', () => {
    const r = cli('install', '--dry-run', '--platform=linux', '--home=/home/alice', '--project=/home/alice/ai-office', '--node=/usr/bin/node');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('ExecStart="/usr/bin/node" "/home/alice/ai-office/server/index.js"');
  });
  it('install --dry-run --platform=darwin mencetak plist dengan path contoh', () => {
    const r = cli('install', '--dry-run', '--platform=darwin', '--home=/Users/alice', '--project=/Users/alice/ai-office', '--node=/usr/local/bin/node', '--uid=501');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('<string>/Users/alice/ai-office/server/index.js</string>');
  });
  it('tanpa perintah atau opsi uji tanpa --dry-run: kode 2, tidak mengubah apa pun', () => {
    expect(cli().status).toBe(2);
    const r = cli('install', '--platform=linux');
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/hanya boleh bersama --dry-run/);
  });
  it('install --dry-run di platform ini tidak mengubah apa pun', () => {
    const r = cli('install', '--dry-run');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[dry-run\]/);
  });
});

describe('autostart.mjs: pemeriksaan statis', () => {
  const src = read('scripts/autostart.mjs');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');

  it('ExecutionPolicy Bypass hanya dengan -File skrip yang ada di scripts/windows/', () => {
    expect(code.match(/ExecutionPolicy/g)).toHaveLength(1);
    expect(code).toContain("['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]");
    const files = [...code.matchAll(/'([\w-]+\.ps1)'/g)].map((m) => m[1]);
    expect(files.length).toBe(3);
    for (const f of files) expect(existsSync(join(ROOT, 'scripts/windows', f)), f).toBe(true);
    expect(code).not.toMatch(/-Command|-EncodedCommand/);
  });
  it('tanpa hak admin/root: tidak ada sudo, runas, /etc, /Library (selain ~/Library), dan tidak memakai shell', () => {
    expect(code).not.toMatch(/runas|LaunchDaemons|['"`]\/etc\//);
    expect(code).not.toMatch(/(?:run|runInherit)\(\s*['"`]sudo/);
    expect(code).not.toMatch(/shell:\s*true/);
    expect(code).not.toMatch(/\bexec(Sync|File|FileSync)\(/);
  });
  it('tidak ada token, email, atau path pribadi', () => {
    expect(src).not.toMatch(/AI_OFFICE_TOKEN|Bearer|@[\w-]+\.(com|id|dev)|C:\\Users\\(?!alice)\w+/);
  });
  it('package.json: skrip npm autostart dan engines', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['autostart:status']).toBe('node scripts/autostart.mjs status');
    expect(pkg.engines.node).toBe('>=22.12');
  });
  it('scripts/windows tidak berubah perilaku: shortcut Startup masih menunjuk start-ai-office.vbs', () => {
    expect(read('scripts/windows/ai-office-common.ps1')).toMatch(/AiLauncher\s*=\s*Join-Path \$PSScriptRoot 'start-ai-office\.vbs'/);
  });
});

// Temuan dev-qa (gerbang tahap 1): masukan aneh tidak boleh menghasilkan TypeError, plist rusak, atau unit rusak.
describe('autostart: masukan aneh (temuan QA)', () => {
  it('opsi uji berisi baris baru ditolak dengan pesan, bukan TypeError', () => {
    for (const a of ['--project=/home/alice/a\nb', '--node=/usr/bin/node\r\n', '--home=/home/alice\n']) {
      const r = parseArgs(['install', '--dry-run', a]);
      expect(r.error).toMatch(/baris baru atau karakter kontrol/);
    }
  });

  it('--uid harus angka dan opsi uji tidak boleh kosong', () => {
    expect(parseArgs(['status', '--dry-run', '--uid=abc']).error).toMatch(/--uid harus berupa angka/);
    expect(parseArgs(['status', '--dry-run', '--uid=-1']).error).toMatch(/--uid harus berupa angka/);
    expect(parseArgs(['status', '--dry-run', '--uid=']).error).toMatch(/tidak boleh kosong/);
    expect(parseArgs(['status', '--dry-run', '--home=']).error).toMatch(/tidak boleh kosong/);
    expect(parseArgs(['status', '--dry-run', '--uid=501']).overrides.uid).toBe('501');
  });

  it('CLI: baris baru di --project keluar dengan kode 2 dan tanpa stack trace', () => {
    const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'autostart.mjs'), 'install', '--dry-run', '--platform=linux', '--project=/home/alice/a\nb'], { encoding: 'utf8' });
    expect(r.status).toBe(2);
    expect(r.stderr).not.toMatch(/TypeError|at .*autostart\.mjs/);
  });

  it('karakter yang tidak sah di XML ditolak sebelum plist ditulis', () => {
    expect(pathProblem('/Users/alice/a￾b')).toMatch(/tidak sah/);
    expect(pathProblem('/Users/alice/a￿b')).toMatch(/tidak sah/);
    expect(pathProblem('/Users/alice/a\ud800b')).toMatch(/tidak sah/); // surrogate tanpa pasangan
    expect(pathProblem('/Users/alice/kantor-\u{1F600}')).toBeNull(); // emoji (pasangan surrogate sah) boleh
    expect(() => launchdPlist({ ...MAC, projectDir: '/Users/alice/a￾b' })).toThrow(/tidak sah/);
  });

  it('backslash di path proyek tidak menyambung baris di unit systemd', () => {
    const BS = String.fromCharCode(92); // satu backslash
    // Berakhiran backslash: baris unit akan menyambung ke ExecStart, jadi ditolak.
    expect(() => systemdUnit({ ...LIN, projectDir: `/home/alice/dir${BS}` })).toThrow(/berakhiran backslash/);
    expect(() => systemdUnit({ ...LIN, projectDir: `/home/alice/dir${BS}${BS}` })).toThrow(/berakhiran backslash/);
    // Backslash di tengah path sah di Linux dan tidak di-escape di WorkingDirectory.
    const unit = systemdUnit({ ...LIN, projectDir: `/home/alice/a${BS}b` });
    const lines = unit.split('\n');
    expect(lines).toContain(`WorkingDirectory=/home/alice/a${BS}b`);
    expect(lines.every((l) => !l.endsWith(BS))).toBe(true); // tidak ada baris yang menyambung
    expect(unit).toMatch(/\nExecStart="\/usr\/bin\/node" /);
  });
});
