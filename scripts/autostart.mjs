#!/usr/bin/env node
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
// Autostart AI Office lintas platform, tanpa hak admin/root dan hanya menulis di folder home + proyek.
//   npm run autostart:install | autostart:uninstall | autostart:stop | autostart:status
//   node scripts/autostart.mjs <install|uninstall|stop|status> [--dry-run]
//
//   Windows : skrip PowerShell yang sudah ada di scripts/windows/ (shortcut di folder Startup).
//   macOS   : LaunchAgent ~/Library/LaunchAgents/<label>.plist (launchctl bootstrap/bootout).
//   Linux   : unit systemd user ~/.config/systemd/user/ai-office.service (systemctl --user).
//
// --dry-run: hanya mencetak apa yang akan ditulis/dijalankan; tidak ada yang diubah.
// Khusus uji, hanya bersama --dry-run: --platform=win32|darwin|linux, --home=<dir>, --project=<dir>,
// --node=<path>, --uid=<angka>. Server tetap `node server/index.js` di 127.0.0.1:3000 (mode lokal).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n.js';

export const PROJECT_DIR = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
export const LAUNCHD_LABEL = 'com.ai-office.server';
export const SYSTEMD_UNIT = 'ai-office.service';
export const COMMANDS = ['install', 'uninstall', 'stop', 'status'];
export const PLATFORMS = ['win32', 'darwin', 'linux'];
const WIN_SCRIPTS = { install: 'install-autostart.ps1', uninstall: 'uninstall-autostart.ps1', stop: 'stop-ai-office.ps1' };

// ---------------------------------------------------------------------------------------------
// Fungsi murni (dites tanpa menyentuh sistem)
// ---------------------------------------------------------------------------------------------

/** Alasan menolak sebuah path (baris baru/karakter kontrol, kosong, bukan absolut), atau null. */
export function pathProblem(value, label = 'path') {
  if (typeof value !== 'string' || value === '') return t('autostart.pathEmpty', { label });
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return t('autostart.pathControl', { label });
  // Karakter yang tidak sah di XML 1.0 (U+FFFE, U+FFFF, surrogate tanpa pasangan) membuat plist tidak valid.
  if (/[\ufffe\uffff]/.test(value) || !value.isWellFormed()) return t('autostart.pathInvalid', { label });
  if (!path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)) return t('autostart.pathNotAbsolute', { label });
  return null;
}

function assertPaths(entries) {
  for (const [label, value] of entries) {
    const problem = pathProblem(value, label);
    if (problem) throw new Error(t('autostart.notInstalled', { problem }));
  }
}

/** Escape teks untuk isi elemen XML. */
export function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Kutip satu argumen untuk ExecStart= systemd: "..." dengan \ dan " di-escape, % jadi %%, $ jadi $$. */
export function systemdQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
}

/**
 * Nilai path untuk WorkingDirectory= (tanpa kutip; hanya % yang harus di-escape). Nilai ini tidak
 * di-unescape oleh systemd, jadi backslash di tengah path tetap apa adanya. Backslash di AKHIR baris
 * berarti "sambung ke baris berikutnya" dan tidak bisa di-escape: path seperti itu ditolak di systemdUnit.
 */
export function systemdPathValue(s) {
  return String(s).replace(/%/g, '%%');
}

/** Isi LaunchAgent plist (macOS). Melempar Error bila path berbahaya. */
export function launchdPlist({ label = LAUNCHD_LABEL, nodePath, projectDir, logDir, throttleSeconds = 10 }) {
  assertPaths([[t('autostart.label.node'), nodePath], [t('autostart.label.project'), projectDir]]);
  const server = path.posix.join(String(projectDir).replace(/\\/g, '/'), 'server', 'index.js');
  const logs = logDir ?? `${String(projectDir).replace(/\\/g, '/')}/logs`;
  assertPaths([[t('autostart.label.logs'), logs]]);
  const log = `${logs}/server.log`;
  const s = (v) => `<string>${xmlEscape(v)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  ${s(label)}`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    ${s(nodePath)}`,
    `    ${s(server)}`,
    '  </array>',
    '  <key>WorkingDirectory</key>',
    `  ${s(projectDir)}`,
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    `  <integer>${Number(throttleSeconds) | 0}</integer>`,
    '  <key>StandardOutPath</key>',
    `  ${s(log)}`,
    '  <key>StandardErrorPath</key>',
    `  ${s(log)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** Isi unit systemd user (Linux). Melempar Error bila path berbahaya. */
export function systemdUnit({ nodePath, projectDir, restartSeconds = 5, burst = 5, intervalSeconds = 300 }) {
  assertPaths([[t('autostart.label.node'), nodePath], [t('autostart.label.project'), projectDir]]);
  if (/\\$/.test(String(projectDir))) {
    // Baris unit yang berakhiran "\" disambung dengan baris berikutnya, sehingga ExecStart ikut tertelan.
    throw new Error(t('autostart.backslashEnd'));
  }
  const server = `${String(projectDir).replace(/\/+$/, '')}/server/index.js`;
  return [
    '[Unit]',
    'Description=AI Office (server animasi kantor, hanya lokal 127.0.0.1:3000)',
    'After=network.target',
    `StartLimitIntervalSec=${Number(intervalSeconds) | 0}`,
    `StartLimitBurst=${Number(burst) | 0}`,
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${systemdPathValue(projectDir)}`,
    `ExecStart=${systemdQuote(nodePath)} ${systemdQuote(server)}`,
    'Restart=on-failure',
    `RestartSec=${Number(restartSeconds) | 0}`,
    'NoNewPrivileges=true',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

/** Letak file/target per platform. `home`/`projectDir`/`env` bisa disuntikkan. */
export function targetsFor(platform, { home = homedir(), projectDir = PROJECT_DIR, env = process.env } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const h = platform === 'win32' ? home : String(home).replace(/\\/g, '/');
  const proj = platform === 'win32' ? projectDir : String(projectDir).replace(/\\/g, '/');
  if (platform === 'darwin') {
    return { kind: 'launchd', file: p.join(h, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`), logDir: p.join(proj, 'logs') };
  }
  if (platform === 'linux') {
    return { kind: 'systemd', file: p.join(h, '.config', 'systemd', 'user', SYSTEMD_UNIT), logDir: p.join(proj, 'logs') };
  }
  const appData = env.APPDATA || p.join(h, 'AppData', 'Roaming');
  return {
    kind: 'windows',
    file: p.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'AI Office.lnk'),
    logDir: p.join(proj, 'logs'),
    scriptDir: p.join(proj, 'scripts', 'windows'),
  };
}

/** Parse argumen CLI. Mengembalikan { command, dryRun, overrides, error }. */
export function parseArgs(argv) {
  const out = { command: null, dryRun: false, overrides: {}, help: false, error: null };
  for (const a of argv) {
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (/^--(platform|home|project|node|uid)=/.test(a)) {
      const [, k, v] = /^--(\w+)=([\s\S]*)$/.exec(a);
      if (v === '') out.error = t('autostart.optEmpty', { k });
      else if (k === 'uid' && !/^\d{1,10}$/.test(v)) out.error = t('autostart.uidNumber');
      // eslint-disable-next-line no-control-regex
      else if (/[\u0000-\u001f\u007f]/.test(v)) out.error = t('autostart.optControl', { k });
      else out.overrides[k] = v;
    } else if (a.startsWith('-')) out.error = t('autostart.optUnknown', { a });
    else if (out.command === null) out.command = a;
    else out.error = t('autostart.argExtra', { a });
  }
  if (!out.error && !out.help) {
    if (out.command === null) out.error = t('autostart.cmdMissing');
    else if (!COMMANDS.includes(out.command)) out.error = t('autostart.cmdUnknown', { command: out.command });
  }
  if (!out.error && Object.keys(out.overrides).length && !out.dryRun) {
    out.error = t('autostart.optDryOnly', { k: Object.keys(out.overrides)[0] });
  }
  if (!out.error && out.overrides.platform && !PLATFORMS.includes(out.overrides.platform)) {
    out.error = t('autostart.platformOneOf', { list: PLATFORMS.join(', ') });
  }
  return out;
}

/** Teks bantuan menurut bahasa pengguna (dibaca saat dipakai, bukan saat impor). */
export const usageText = () => t('autostart.usage');
/** Bahasa Indonesia, untuk pemakai lama yang mengimpor USAGE. */
export const USAGE = t('autostart.usage', {}, 'id');

// ---------------------------------------------------------------------------------------------
// Lapisan I/O (bisa diganti saat uji)
// ---------------------------------------------------------------------------------------------

/** Cek GET /api/health -> true bila {"ok":true}. */
export function checkHealth(port = 3000, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/api/health', method: 'GET', timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 4096) body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body).ok === true); } catch { resolve(false); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

function realIo() {
  return {
    exists: (p) => existsSync(p),
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    write: (p, content) => writeFileSync(p, content, { encoding: 'utf8', mode: 0o644 }),
    remove: (p) => rmSync(p, { force: true }),
    run: (cmd, args) => {
      const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      return { status: r.error ? 127 : r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
    },
    runInherit: (cmd, args) => {
      const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true });
      return { status: r.error ? 127 : r.status ?? 1, error: r.error };
    },
    health: checkHealth,
  };
}

/** I/O untuk --dry-run: mencetak, tidak mengubah apa pun, dan menganggap perintah berhasil. */
function dryIo(log) {
  return {
    exists: () => false,
    mkdir: (p) => log(t('autostart.dryMkdir', { p })),
    write: (p, content) => log(t('autostart.dryWrite', { p, content: content.replace(/\n$/, '') })),
    remove: (p) => log(t('autostart.dryRemove', { p })),
    run: (cmd, args) => { log(t('autostart.dryRun', { cmd: [cmd, ...args].join(' ') })); return { status: 0, stdout: '', stderr: '' }; },
    runInherit: (cmd, args) => { log(t('autostart.dryRun', { cmd: [cmd, ...args].join(' ') })); return { status: 0 }; },
    health: async () => false,
  };
}

// ---------------------------------------------------------------------------------------------
// Implementasi per platform. Semua mengembalikan kode keluar (0 = sukses).
// ---------------------------------------------------------------------------------------------

function windowsCommand(ctx, command) {
  const script = path.win32.join(ctx.projectDir, 'scripts', 'windows', WIN_SCRIPTS[command]);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
  const r = ctx.io.runInherit('powershell', args);
  if (r.error) {
    ctx.err(t('autostart.psMissing'));
    return 1;
  }
  return r.status;
}

function macInstall(ctx) {
  const tg = ctx.targets;
  const plist = launchdPlist({ nodePath: ctx.nodePath, projectDir: ctx.projectDir, logDir: tg.logDir });
  const domain = `gui/${ctx.uid}`;
  ctx.log(t('autostart.mac.installing'));
  ctx.log(t('autostart.line.node', { v: ctx.nodePath }));
  ctx.log(t('autostart.line.project', { v: ctx.projectDir }));
  ctx.log(t('autostart.line.plist', { v: tg.file }));
  if (!ctx.io.exists(path.posix.join(ctx.projectDir, 'dist', 'index.html')) && !ctx.dryRun) {
    ctx.log(t('autostart.noDist'));
  }
  ctx.io.mkdir(path.posix.dirname(tg.file));
  ctx.io.mkdir(tg.logDir);
  // Lepas dulu bila sudah termuat (aman dijalankan berulang); kegagalan diabaikan.
  ctx.io.run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  ctx.io.write(tg.file, plist);
  let r = ctx.io.run('launchctl', ['bootstrap', domain, tg.file]);
  if (r.status !== 0) {
    ctx.log(t('autostart.mac.bootstrapFailed'));
    r = ctx.io.run('launchctl', ['load', '-w', tg.file]);
  }
  if (r.status !== 0) {
    ctx.err(t('autostart.mac.loadFailed', { reason: String(r.stderr ?? '').trim() || t('autostart.code', { code: r.status }) }));
    ctx.err(t('autostart.mac.plistWritten', { file: tg.file, domain }));
    return 1;
  }
  ctx.log(t('autostart.done'));
  ctx.log(t('autostart.mac.log', { dir: tg.logDir }));
  return 0;
}

function macUninstall(ctx) {
  const tg = ctx.targets;
  const domain = `gui/${ctx.uid}`;
  ctx.log(t('autostart.mac.uninstalling'));
  const r = ctx.io.run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  if (r.status !== 0 && ctx.io.exists(tg.file)) ctx.io.run('launchctl', ['unload', '-w', tg.file]);
  ctx.io.remove(tg.file);
  ctx.log(t('autostart.uninstalled'));
  return 0;
}

function macStop(ctx) {
  const domain = `gui/${ctx.uid}`;
  const r = ctx.io.run('launchctl', ['bootout', `${domain}/${LAUNCHD_LABEL}`]);
  if (r.status !== 0) {
    ctx.log(t('autostart.mac.notLoaded'));
    return 0;
  }
  ctx.log(t('autostart.mac.stopped'));
  return 0;
}

async function macStatus(ctx) {
  const tg = ctx.targets;
  ctx.log(t('autostart.mac.platform', { label: LAUNCHD_LABEL }));
  ctx.log(t('autostart.status.plist', { state: t(ctx.io.exists(tg.file) ? 'autostart.exists' : 'autostart.notExists'), file: tg.file }));
  const r = ctx.io.run('launchctl', ['print', `gui/${ctx.uid}/${LAUNCHD_LABEL}`]);
  ctx.log(t('autostart.status.loaded', { v: t(r.status === 0 ? 'autostart.yes' : 'autostart.no') }));
  return healthLine(ctx);
}

function systemctlUser(ctx, ...args) {
  return ctx.io.run('systemctl', ['--user', ...args]);
}

function systemdUnavailable(ctx, reason) {
  const tg = ctx.targets;
  ctx.err(t('autostart.systemd.unavailable', { reason }));
  ctx.err(t('autostart.systemd.manualHeader'));
  ctx.err(t('autostart.systemd.manual1', { dir: ctx.projectDir }));
  ctx.err(t('autostart.systemd.manual2'));
  ctx.err(t('autostart.systemd.manual3', { file: tg.file }));
  ctx.err(t('autostart.systemd.manual3b'));
  ctx.err(t('autostart.systemd.linger'));
  return 1;
}

function linuxInstall(ctx) {
  const tg = ctx.targets;
  const unit = systemdUnit({ nodePath: ctx.nodePath, projectDir: ctx.projectDir });
  ctx.log(t('autostart.linux.installing'));
  ctx.log(t('autostart.line.node', { v: ctx.nodePath }));
  ctx.log(t('autostart.line.project', { v: ctx.projectDir }));
  ctx.log(t('autostart.line.unit', { v: tg.file }));
  if (!ctx.dryRun) {
    const probe = systemctlUser(ctx, 'show-environment');
    if (probe.status !== 0) {
      return systemdUnavailable(ctx, t(probe.error ? 'autostart.systemd.reasonMissing' : 'autostart.systemd.reasonNoSession'));
    }
  }
  if (!ctx.io.exists(path.posix.join(ctx.projectDir, 'dist', 'index.html')) && !ctx.dryRun) {
    ctx.log(t('autostart.noDist'));
  }
  ctx.io.mkdir(path.posix.dirname(tg.file));
  ctx.io.mkdir(tg.logDir);
  ctx.io.write(tg.file, unit);
  let r = systemctlUser(ctx, 'daemon-reload');
  if (r.status === 0) r = systemctlUser(ctx, 'enable', '--now', SYSTEMD_UNIT);
  if (r.status !== 0) {
    ctx.err(t('autostart.linux.failed', { reason: String(r.stderr ?? '').trim() || t('autostart.code', { code: r.status }), file: tg.file }));
    ctx.err(t('autostart.linux.why', { unit: SYSTEMD_UNIT }));
    return 1;
  }
  ctx.log(t('autostart.done'));
  ctx.log(t('autostart.linux.log', { unit: SYSTEMD_UNIT }));
  ctx.log(t('autostart.linux.linger'));
  return 0;
}

function linuxUninstall(ctx) {
  const tg = ctx.targets;
  ctx.log(t('autostart.linux.uninstalling'));
  const probe = ctx.dryRun ? { status: 0 } : systemctlUser(ctx, 'show-environment');
  if (probe.status === 0) systemctlUser(ctx, 'disable', '--now', SYSTEMD_UNIT);
  else ctx.log(t('autostart.linux.noSystemctl'));
  ctx.io.remove(tg.file);
  if (probe.status === 0) systemctlUser(ctx, 'daemon-reload');
  ctx.log(t('autostart.uninstalled'));
  return 0;
}

function linuxStop(ctx) {
  const probe = ctx.dryRun ? { status: 0 } : systemctlUser(ctx, 'show-environment');
  if (probe.status !== 0) return systemdUnavailable(ctx, t('autostart.systemd.reasonUnusable'));
  const r = systemctlUser(ctx, 'stop', SYSTEMD_UNIT);
  if (r.status !== 0) {
    ctx.log(t('autostart.linux.notRunning'));
    return 0;
  }
  ctx.log(t('autostart.linux.stopped'));
  return 0;
}

async function linuxStatus(ctx) {
  const tg = ctx.targets;
  ctx.log(t('autostart.linux.platform', { unit: SYSTEMD_UNIT }));
  ctx.log(t('autostart.status.unit', { state: t(ctx.io.exists(tg.file) ? 'autostart.exists' : 'autostart.notExists'), file: tg.file }));
  const probe = systemctlUser(ctx, 'show-environment');
  if (probe.status !== 0) {
    ctx.log(t('autostart.linux.noSession'));
  } else {
    const active = systemctlUser(ctx, 'is-active', SYSTEMD_UNIT);
    const enabled = systemctlUser(ctx, 'is-enabled', SYSTEMD_UNIT);
    ctx.log(t('autostart.status.active', { v: String(active.stdout).trim() || t('autostart.unknown') }));
    ctx.log(t('autostart.status.enabled', { v: String(enabled.stdout).trim() || t('autostart.unknown') }));
  }
  return healthLine(ctx);
}

async function windowsStatus(ctx) {
  const tg = ctx.targets;
  ctx.log(t('autostart.win.platform'));
  ctx.log(t('autostart.status.shortcut', { state: t(ctx.io.exists(tg.file) ? 'autostart.exists' : 'autostart.notExists'), file: tg.file }));
  return healthLine(ctx);
}

async function healthLine(ctx) {
  const ok = await ctx.io.health(ctx.port);
  ctx.log(t('autostart.status.server', { v: t(ok ? 'autostart.answers' : 'autostart.noAnswer'), url: `http://127.0.0.1:${ctx.port}/api/health` }));
  return 0;
}

const IMPL = {
  win32: { install: (c) => windowsCommand(c, 'install'), uninstall: (c) => windowsCommand(c, 'uninstall'), stop: (c) => windowsCommand(c, 'stop'), status: windowsStatus },
  darwin: { install: macInstall, uninstall: macUninstall, stop: macStop, status: macStatus },
  linux: { install: linuxInstall, uninstall: linuxUninstall, stop: linuxStop, status: linuxStatus },
};

/**
 * Jalankan satu perintah. Semua ketergantungan bisa disuntikkan (untuk uji):
 *   platform, home, projectDir, nodePath, uid, env, io, log, err, dryRun, port.
 * Mengembalikan kode keluar.
 */
export async function runAutostart(command, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const impl = IMPL[platform];
  const log = opts.log ?? ((m) => console.log(m));
  const err = opts.err ?? ((m) => console.error(m));
  if (!impl) {
    err(t('autostart.platformUnsupported', { platform }));
    return 1;
  }
  if (!COMMANDS.includes(command)) {
    err(t('autostart.cmdUnknown', { command }));
    return 2;
  }
  const home = opts.home ?? homedir();
  const projectDir = opts.projectDir ?? PROJECT_DIR;
  const nodePath = opts.nodePath ?? process.execPath;
  const dryRun = Boolean(opts.dryRun);
  const portEnv = (opts.env ?? process.env).AI_OFFICE_AUTOSTART_PORT;
  const ctx = {
    platform, dryRun, log, err, home, projectDir, nodePath,
    uid: opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 501),
    port: opts.port ?? (/^\d+$/.test(portEnv ?? '') ? Number(portEnv) : 3000),
    targets: targetsFor(platform, { home, projectDir, env: opts.env ?? process.env }),
    io: opts.io ?? (dryRun ? dryIo(log) : realIo()),
  };
  if (platform !== 'win32' && command !== 'status' && command !== 'stop') {
    const problem = pathProblem(nodePath, 'path node') ?? pathProblem(projectDir, 'path proyek');
    if (problem) { err(t('autostart.failNotInstalled', { problem })); return 1; }
  }
  if (dryRun) log(t('autostart.dryHeader', { platform, command }));
  if (dryRun && command === 'status') {
    // Status hanya membaca; pada dry-run cukup tampilkan apa yang akan diperiksa.
    log(t('autostart.dryCheckFile', { file: ctx.targets.file }));
    if (platform === 'darwin') log(t('autostart.dryRun', { cmd: `launchctl print gui/${ctx.uid}/${LAUNCHD_LABEL}` }));
    if (platform === 'linux') log(t('autostart.dryRunBoth', { unit: SYSTEMD_UNIT }));
    log(t('autostart.dryHealth', { url: `http://127.0.0.1:${ctx.port}/api/health` }));
    return 0;
  }
  try {
    return await impl[command](ctx);
  } catch (e) {
    err(t('autostart.fail', { msg: e.message }));
    return 1;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) { console.log(usageText()); return 0; }
  if (args.error) { console.error(`${args.error}\n${usageText()}`); return 2; }
  const o = args.overrides;
  return runAutostart(args.command, {
    dryRun: args.dryRun,
    platform: o.platform,
    home: o.home,
    projectDir: o.project,
    nodePath: o.node,
    uid: o.uid === undefined ? undefined : Number(o.uid),
  });
}

function isDirectRun() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  process.exitCode = await main();
}
