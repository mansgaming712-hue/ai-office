#!/usr/bin/env node
// Jalankan server AI Office.  Variabel lingkungan:
//   PORT (default 3000), HOST (default 127.0.0.1 — hanya bisa diakses dari komputer ini)
//   AI_OFFICE_TOKEN          rahasia bersama; mengaktifkan login (buat dengan: npm run -s token)
//   AI_OFFICE_TOKEN_FILE     path file berisi token ("~" = home); dipakai bila AI_OFFICE_TOKEN kosong
//   AI_OFFICE_ALLOWED_HOSTS  hostname dipisah koma yang boleh muncul di header Host/Origin
//   AI_OFFICE_DEV_ORIGINS    Origin dev server dipisah koma (mis. http://localhost:5173) yang boleh di mode lokal
//   AI_OFFICE_TRUST_PROXY=1  server di belakang Nginx di mesin yang sama (HOST wajib loopback):
//                            pakai X-Real-IP dan X-Forwarded-Proto
//   AI_OFFICE_LOG_MESSAGES=1 ikut mencatat isi pesan event di log (default: hanya metadata)
//   AI_OFFICE_CLAUDE_DIR     folder dasar log Claude Code untuk statistik pemakaian (default ~/.claude)
//   AI_OFFICE_LIMIT_CONFIG   path limit-config.json (default: root proyek); lihat server/usage.js
//   AI_OFFICE_LANG           bahasa pesan: id atau en (default: dari LC_ALL/LANG/sistem)
//   AI_OFFICE_RUNNER=1       mode terbuka (VPS): aktifkan runner dan demo (default: nonaktif)
//   AI_OFFICE_CLAUDE_BIN, AI_OFFICE_RUNNER_ALLOWED_TOOLS, AI_OFFICE_RUNNER_EXTRA_ARGS, AI_OFFICE_RUNNER_TIMEOUT_MS
//                            pengaturan runner (lihat server/runner.js)
//   AI_OFFICE_PRINT_KEY=1    cetak URL dasbor dengan runner key walau stdout bukan terminal (default: hanya di terminal)
// Semua variabel di atas boleh juga ditulis di file .env di root proyek (lihat .env.example).
// Mode terbuka (HOST bukan loopback, ALLOWED_HOSTS terisi, atau TRUST_PROXY=1) wajib memakai
// AI_OFFICE_TOKEN minimal 32 karakter; kalau tidak, server menolak start (exit 1).
import './requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { loadProjectEnv } from './loadEnv.js';
import { existsSync } from 'node:fs';
import { detectLang, t } from '../shared/i18n.js';
import { fileURLToPath } from 'node:url';
import { createAiOfficeServer } from './app.js';
import { MIN_OPEN_TOKEN_LENGTH, resolveAuthMode } from './auth.js';
import { hostnameOf } from './net.js';
import { loadRunnerKey } from './runnerKey.js';
import { broadFileTools } from './runner.js';
import { resolveToken, tokenFileLabel } from './tokenSource.js';
import { createUsageTracker, usageOptionsFromEnv } from './usage.js';

loadProjectEnv(); // .env di root proyek, tanpa menimpa env yang sudah ada

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const tokenInfo = resolveToken({ token: process.env.AI_OFFICE_TOKEN, tokenFile: process.env.AI_OFFICE_TOKEN_FILE });
const token = tokenInfo.token;
const rawProxy = (process.env.AI_OFFICE_TRUST_PROXY ?? '').trim();
const trustProxy = rawProxy === '1';
const rawLogMessages = (process.env.AI_OFFICE_LOG_MESSAGES ?? '').trim();
const logMessages = rawLogMessages === '1';
const rawHosts = (process.env.AI_OFFICE_ALLOWED_HOSTS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const allowedHosts = [...new Set(rawHosts.map(hostnameOf).filter(Boolean))];
const devOrigins = (process.env.AI_OFFICE_DEV_ORIGINS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
const staticDir = fileURLToPath(new URL('../dist/', import.meta.url));

if (tokenInfo.problem) {
  // Isi token/file tidak pernah dicetak, hanya alasannya. Path hanya dicetak bila nilai variabelnya
  // jelas sebuah path (bukan token yang salah tempel), supaya token tidak masuk journald.
  const label = tokenInfo.source === 'env' ? 'AI_OFFICE_TOKEN' : tokenFileLabel(process.env.AI_OFFICE_TOKEN_FILE, tokenInfo.file);
  if (tokenInfo.invalid) {
    // Token ada tetapi tidak sah (spasi, non-ASCII, surrogate tunggal, ...): salah konfigurasi, jangan
    // diam-diam berjalan tanpa token.
    console.error(t('start.tokenInvalid', { label, problem: tokenInfo.problem }));
    process.exit(1);
  }
  console.warn(t('start.tokenIgnored', { label, problem: tokenInfo.problem }));
}
if (rawProxy && !trustProxy) {
  // Nilainya tidak dicetak: bisa saja token yang salah tempel ke variabel ini.
  console.warn(t('start.proxyIgnored'));
}
// Nilai variabel di bawah juga tidak dicetak (alasan sama dengan TRUST_PROXY), hanya nama dan alasannya.
if (rawLogMessages && !logMessages) {
  console.warn(t('start.logMessagesIgnored'));
}
const badHosts = rawHosts.filter((h) => !hostnameOf(h));
if (badHosts.length) {
  console.warn(t('start.badHosts', { n: badHosts.length }));
}

const mode = resolveAuthMode({ host, allowedHosts, trustProxy, token });
if (mode.error) {
  console.error(mode.error);
  process.exit(1);
}

if (!existsSync(staticDir)) {
  console.warn(t('start.noDist'));
}

const timeLocale = detectLang() === 'id' ? 'id-ID' : 'en-GB';
const serverLog = (line) => console.log(`${new Date().toLocaleTimeString(timeLocale, { hour12: false })} ${line}`);
// Statistik pemakaian (estimasi lokal dari log Claude Code; tidak memanggil API apa pun).
const usage = createUsageTracker({ ...usageOptionsFromEnv(), log: serverLog });

// Runner key (mode lokal tanpa token): header X-AI-Office-Key untuk endpoint runner, demo, dan file tugas.
let runnerKey = null;
if (!mode.tokenMode) {
  try {
    runnerKey = loadRunnerKey();
  } catch (e) {
    console.warn(t('start.runnerKeyFail', { reason: e.code ?? e.message }));
  }
}
const runnerEnabled = (process.env.AI_OFFICE_RUNNER ?? '').trim() === '1';
if (!mode.open || runnerEnabled) {
  const broad = broadFileTools(process.env);
  if (broad.length) console.warn(t('start.broadTools', { tools: broad.join(', ') }));
}

let app;
try {
  app = createAiOfficeServer({
    host,
    port,
    staticDir,
    allowedHosts,
    token,
    trustProxy,
    logMessages,
    devOrigins,
    usage,
    runnerKey,
    runnerEnabled,
    log: serverLog,
  });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

try {
  await app.listen();
} catch (e) {
  if (e.code === 'EADDRINUSE') {
    console.error(t('start.portInUse', { port }));
    process.exit(1);
  }
  throw e;
}

const LOCAL_MODE_WARNING = t('start.localWarning');

const shown = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
console.log(t('start.listening', { url: `http://${shown}:${port}` }));
if (mode.tokenMode) {
  console.log(t('start.modeToken'));
  if (token.length < MIN_OPEN_TOKEN_LENGTH) {
    console.warn(t('start.shortToken', { min: MIN_OPEN_TOKEN_LENGTH }));
  }
  if (allowedHosts.length) console.log(t('start.allowedHosts', { hosts: allowedHosts.join(', ') }));
  console.log(t(trustProxy ? 'start.proxyTrusted' : 'start.proxyNotTrusted'));
  if (mode.open && !trustProxy) {
    console.warn(t('start.openNoProxy'));
  }
  console.log(t('start.hooksToken', { port }));
  if (mode.open && !runnerEnabled) console.log(t('start.runnerOffOpen'));
} else {
  console.log(t('start.modeLocal'));
  console.log(t('start.hooksLocal', { port }));
  console.warn(LOCAL_MODE_WARNING);
  if (runnerKey) {
    // URL dengan key di FRAGMENT (#key=...): fragment tidak dikirim ke server dan tidak masuk log akses.
    // Key hanya dicetak di terminal (atau bila AI_OFFICE_PRINT_KEY=1): stdout autostart/service masuk file log.
    if (process.stdout.isTTY || (process.env.AI_OFFICE_PRINT_KEY ?? '').trim() === '1') {
      console.log(t('start.dashboardUrl', { url: `http://${shown}:${port}/#key=${runnerKey}` }));
    } else {
      console.log(t('start.openHint'));
    }
  }
}
if (logMessages) console.warn(t('start.logMessagesOn'));

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
