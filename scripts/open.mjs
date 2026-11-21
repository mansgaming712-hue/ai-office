#!/usr/bin/env node
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
// Buka dasbor AI Office di browser dengan runner key di fragment URL: http://localhost:3000/#key=<key>
// Fragment tidak dikirim ke server dan tidak masuk log akses. Dipakai terutama setelah autostart (server
// berjalan di latar belakang dan tidak mencetak key ke log).
//   npm run open
//   node scripts/open.mjs --print      cetak URL (dengan key) alih-alih membuka browser
//   node scripts/open.mjs --dry-run    tampilkan perintah pembuka browser tanpa menjalankannya (key disamarkan)
//   PORT=3001 npm run open             port lain (default 3000, sama dengan server)
// Pembuka browser dijalankan tanpa shell: Windows `explorer.exe <url>`.
// macOS/Linux: argv proses bisa dibaca akun lain (ps, /proc), jadi URL yang berisi key TIDAK dikirim sebagai argv.
// Sebagai gantinya ditulis berkas HTML sementara (0600) di <repo>/output/ berisi location.replace(URL), lalu
// `open <berkas>` / `xdg-open <berkas>`; berkas dihapus setelah ~20 detik (sisa berkas lama dibersihkan saat
// dijalankan lagi). Bukan di folder tersembunyi atau /tmp karena browser snap (Ubuntu) tidak bisa membacanya.
// --print dan --dry-run tidak membuat apa pun (termasuk runner-key).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { t } from '../shared/i18n.js';
import { loadProjectEnv } from '../server/loadEnv.js';
import { loadRunnerKey } from '../server/runnerKey.js';
import { resolveToken } from '../server/tokenSource.js';

/** Perintah pembuka browser (tanpa shell) untuk `url` di `platform`. */
export function openerFor(url, platform = process.platform) {
  if (platform === 'win32') return { command: 'explorer.exe', args: [url] };
  if (platform === 'darwin') return { command: 'open', args: [url] };
  return { command: 'xdg-open', args: [url] };
}

export const LAUNCHER_PREFIX = 'aio-open-';
export const LAUNCHER_RE = /^aio-open-[0-9a-f]{16}\.html$/;
export const LAUNCHER_TTL_MS = 20_000; // berapa lama berkas pengarah dibiarkan
export const LAUNCHER_STALE_MS = 3 * 60_000; // berkas sisa yang lebih tua dari ini dibersihkan
const DEFAULT_OUTPUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'output');

const LT_ESC = `${String.fromCharCode(92)}u003c`; // "<" sebagai escape JS, supaya tidak menutup <script>
const htmlEsc = (x) => String(x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Isi HTML pengarah: location.replace(url) plus tautan cadangan. */
export function launcherHtml(url) {
  const js = JSON.stringify(url).replace(/</g, `${LT_ESC}`);
  return `<!doctype html>
<meta charset="utf-8"><title>AI Office</title>
<script>location.replace(${js})</script>
<p><a href="${htmlEsc(url)}">${htmlEsc(url.replace(/#key=.*$/, ''))}</a></p>
`;
}

/** Hapus berkas pengarah sisa yang lebih tua dari `maxAgeMs`. Tidak pernah melempar. Mengembalikan jumlah yang dihapus. */
export function cleanStaleLaunchers(dir = DEFAULT_OUTPUT_DIR, { maxAgeMs = LAUNCHER_STALE_MS, nowMs = Date.now() } = {}) {
  let n = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!LAUNCHER_RE.test(name)) continue;
      try {
        const p = join(dir, name);
        if (nowMs - statSync(p).mtimeMs >= maxAgeMs) {
          unlinkSync(p);
          n += 1;
        }
      } catch {
        // dipakai proses lain atau sudah hilang
      }
    }
  } catch {
    // folder belum ada
  }
  return n;
}

/** Tulis berkas pengarah (flag wx, mode 0600, nama acak) dan kembalikan path-nya. */
export function writeLauncher(url, dir = DEFAULT_OUTPUT_DIR) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    // Folder milik pengguna tidak di-chmod. Hanya world-writable yang ditolak (grup boleh: umask 002 umum di Ubuntu);
    // berkas 0600 + flag wx tetap menjaga kerahasiaan key.
    const st = statSync(dir);
    if ((st.mode & 0o002) !== 0) throw Object.assign(new Error('output dir is world-writable'), { code: 'unsafe-dir-permissions' });
  }
  const file = join(dir, `${LAUNCHER_PREFIX}${randomBytes(8).toString('hex')}.html`);
  writeFileSync(file, launcherHtml(url), { flag: 'wx', mode: 0o600 });
  return file;
}

export function dashboardUrl({ port = 3000, key = '' } = {}) {
  const n = Number(port);
  const p = Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 3000;
  return `http://localhost:${p}/${key ? `#key=${key}` : ''}`;
}

/** Jalankan. Dependensi bisa disuntikkan untuk uji: env, platform, loadKey, launch, log, err. */
export async function runOpen(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m) => console.log(m));
  const err = opts.err ?? ((m) => console.error(m));
  const platform = opts.platform ?? process.platform;
  const print = argv.includes('--print');
  const dryRun = argv.includes('--dry-run');
  if (argv.includes('--help') || argv.includes('-h')) {
    log(t('open.usage'));
    return 0;
  }
  const unknown = argv.find((a) => !['--print', '--dry-run', '--help', '-h'].includes(a));
  if (unknown) {
    err(`${t('setup.unknownOpt', { a: unknown })}\n${t('open.usage')}`);
    return 2;
  }

  const tokenMode = resolveToken({ token: env.AI_OFFICE_TOKEN, tokenFile: env.AI_OFFICE_TOKEN_FILE }).token !== '';
  let key = '';
  if (tokenMode) {
    log(t('open.tokenMode'));
  } else {
    try {
      // --print/--dry-run tidak boleh mengubah apa pun: key hanya dibaca, tidak dibuat.
      key = (opts.loadKey ?? ((o) => loadRunnerKey(o)))({ create: !print && !dryRun }) ?? '';
      if (!key && (print || dryRun)) err(t('open.noKey'));
    } catch (e) {
      err(t('open.keyFail', { reason: e.code ?? e.message }));
      return 1;
    }
  }
  const url = dashboardUrl({ port: env.PORT, key });
  if (print) {
    log(t('open.printed', { url }));
    return 0;
  }
  // Windows: argumen proses akun lain tidak terbaca user biasa, jadi URL langsung. Lainnya: berkas pengarah bila ada key.
  const viaFile = platform !== 'win32' && key !== '';
  const outDir = opts.outputDir ?? DEFAULT_OUTPUT_DIR;
  if (dryRun) {
    const shownArgs = viaFile
      ? [join(outDir, `${LAUNCHER_PREFIX}<random>.html`)]
      : openerFor(dashboardUrl({ port: env.PORT, key: key ? '***' : '' }), platform).args;
    log(t('open.dry', { cmd: [openerFor(url, platform).command, ...shownArgs].join(' ') }));
    return 0;
  }
  let launcherFile = null;
  const removeLauncher = () => {
    if (!launcherFile) return;
    try {
      unlinkSync(launcherFile);
    } catch {
      // sudah terhapus
    }
    launcherFile = null;
  };
  if (viaFile) {
    cleanStaleLaunchers(outDir);
    try {
      launcherFile = writeLauncher(url, outDir);
    } catch (e) {
      if (e.code === 'unsafe-dir-permissions') err(t('open.unsafeDir', { dir: outDir }));
      else err(t('open.openFail', { reason: e.code ?? e.message, url: url.replace(/#key=.*$/, '#key=***') }));
      return 1;
    }
  }
  const { command, args } = viaFile ? openerFor(launcherFile, platform) : openerFor(url, platform);
  const launch =
    opts.launch ??
    ((cmd, a) =>
      new Promise((done) => {
        let child;
        try {
          child = spawn(cmd, a, { stdio: 'ignore', detached: true, windowsHide: true, shell: false });
        } catch (e) {
          done({ error: e });
          return;
        }
        child.on('error', (error) => done({ error }));
        child.unref();
        // explorer.exe keluar dengan kode 1 walau berhasil; yang dihitung hanya gagal menjalankan.
        setTimeout(() => done({ error: null }), 300).unref?.();
      }));
  const onSignal = (code) => () => {
    removeLauncher();
    process.exit(code);
  };
  const onInt = onSignal(130);
  const onTerm = onSignal(143);
  const detach = () => {
    process.off('exit', removeLauncher);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
  };
  process.once('exit', removeLauncher);
  if (viaFile) {
    process.once('SIGINT', onInt);
    process.once('SIGTERM', onTerm);
  }
  const r = await launch(command, args);
  if (r.error) {
    removeLauncher();
    detach();
    err(t('open.openFail', { reason: r.error.code ?? r.error.message, url: url.replace(/#key=.*$/, '#key=***') }));
    return 1;
  }
  log(t('open.opening', { url: url.replace(/#key=.*$/, '#key=***') }));
  if (launcherFile) {
    // Beri browser waktu membaca berkas, lalu hapus (proses ini menunggu).
    await (opts.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms))))(opts.launcherTtlMs ?? LAUNCHER_TTL_MS);
    removeLauncher();
  }
  detach();
  return 0;
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  loadProjectEnv();
  process.exitCode = await runOpen();
}
