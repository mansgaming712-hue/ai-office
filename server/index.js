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
// Semua variabel di atas boleh juga ditulis di file .env di root proyek (lihat .env.example).
// Mode terbuka (HOST bukan loopback, ALLOWED_HOSTS terisi, atau TRUST_PROXY=1) wajib memakai
// AI_OFFICE_TOKEN minimal 32 karakter; kalau tidak, server menolak start (exit 1).
import './requireNode.js'; // paling awal: cek versi Node (minimal 20.12)
import { loadProjectEnv } from './loadEnv.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAiOfficeServer } from './app.js';
import { MIN_OPEN_TOKEN_LENGTH, resolveAuthMode } from './auth.js';
import { hostnameOf } from './net.js';
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
    console.error(`Server tidak dijalankan: ${label} ${tokenInfo.problem}.`);
    process.exit(1);
  }
  console.warn(`Peringatan: ${label} ${tokenInfo.problem}; server berjalan seperti tanpa token.`);
}
if (rawProxy && !trustProxy) {
  // Nilainya tidak dicetak: bisa saja token yang salah tempel ke variabel ini.
  console.warn('Peringatan: AI_OFFICE_TRUST_PROXY hanya aktif bila bernilai 1 (nilai sekarang bukan 1, tidak ditampilkan), jadi diabaikan.');
}
// Nilai variabel di bawah juga tidak dicetak (alasan sama dengan TRUST_PROXY), hanya nama dan alasannya.
if (rawLogMessages && !logMessages) {
  console.warn('Peringatan: AI_OFFICE_LOG_MESSAGES hanya aktif bila bernilai 1 (nilai sekarang bukan 1, tidak ditampilkan), jadi diabaikan.');
}
const badHosts = rawHosts.filter((h) => !hostnameOf(h));
if (badHosts.length) {
  console.warn(
    `Peringatan: nilai AI_OFFICE_ALLOWED_HOSTS tidak valid diabaikan: ${badHosts.length} entri bukan hostname yang sah (nilainya tidak ditampilkan).`,
  );
}

const mode = resolveAuthMode({ host, allowedHosts, trustProxy, token });
if (mode.error) {
  console.error(mode.error);
  process.exit(1);
}

if (!existsSync(staticDir)) {
  console.warn('Peringatan: folder dist/ belum ada. Jalankan "npm run build" (atau "npm start" yang otomatis build).');
}

const serverLog = (line) => console.log(`${new Date().toLocaleTimeString('id-ID', { hour12: false })} ${line}`);
// Statistik pemakaian (estimasi lokal dari log Claude Code; tidak memanggil API apa pun).
const usage = createUsageTracker({ ...usageOptionsFromEnv(), log: serverLog });

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
    console.error(`Port ${port} sudah dipakai. Tutup aplikasi lain di port itu atau jalankan dengan PORT=3001.`);
    process.exit(1);
  }
  throw e;
}

const shown = host === '127.0.0.1' || host === '::1' ? 'localhost' : host;
console.log(`AI Office jalan di http://${shown}:${port}`);
if (mode.tokenMode) {
  console.log('Mode: token aktif. Browser wajib login; hooks dan curl memakai header Authorization: Bearer.');
  if (token.length < MIN_OPEN_TOKEN_LENGTH) {
    console.warn(`Peringatan: token lebih pendek dari ${MIN_OPEN_TOKEN_LENGTH} karakter. Buat token kuat dengan: npm run -s token`);
  }
  if (allowedHosts.length) console.log(`Host yang diizinkan: ${allowedHosts.join(', ')}`);
  console.log(trustProxy ? 'Proxy dipercaya: IP dari X-Real-IP, HTTPS dari X-Forwarded-Proto.' : 'Proxy tidak dipercaya: X-Real-IP dan X-Forwarded-Proto diabaikan.');
  if (mode.open && !trustProxy) {
    console.warn(
      'Peringatan: server terbuka di jaringan tanpa AI_OFFICE_TRUST_PROXY=1, artinya tanpa HTTPS dari Nginx. ' +
        'Token dan cookie sesi dikirim tanpa enkripsi dan bisa disadap. Pasang di belakang Nginx + HTTPS lalu set AI_OFFICE_TRUST_PROXY=1.',
    );
  }
  console.log(
    `Hooks: isi AI_OFFICE_URL (mis. http://127.0.0.1:${port}/api/events) dan AI_OFFICE_TOKEN_FILE (path file token) ` +
      'atau AI_OFFICE_TOKEN di .claude/settings.local.json bagian "env".',
  );
} else {
  console.log('Mode: lokal tanpa token (hanya bisa diakses dari komputer ini).');
  console.log(`Hooks mengirim event ke http://127.0.0.1:${port}/api/events`);
}
if (logMessages) console.warn('Peringatan: AI_OFFICE_LOG_MESSAGES=1, isi pesan event ikut ditulis ke log server.');

const shutdown = () => app.close().then(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
