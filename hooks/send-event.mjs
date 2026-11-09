#!/usr/bin/env node
// Hook Claude Code → AI Office.
// Membaca JSON hook dari stdin, memetakannya ke event AI Office, lalu POST ke server.
// Selalu keluar dengan kode 0 dan tanpa output, supaya Claude Code tidak pernah terhambat
// (server mati, timeout, atau input aneh hanya diabaikan).
//   AI_OFFICE_URL         default http://127.0.0.1:3000/api/events
//   AI_OFFICE_TOKEN       bila terisi, dikirim sebagai header Authorization: Bearer
//   AI_OFFICE_TOKEN_FILE  path file berisi token ("~" = home), dibaca bila AI_OFFICE_TOKEN kosong.
//                         Dianjurkan: token di file tidak ikut diwariskan ke semua subprocess
//                         Claude Code seperti nilai di "env". File hilang = seperti tanpa token.
//   AI_OFFICE_TIMEOUT_MS  batas waktu request (default 800)
//   AI_OFFICE_DEBUG       isi "1" untuk menampilkan error di stderr (token tidak pernah dicetak)
// Event tidak pernah dikirim lewat http:// ke host selain loopback (dengan atau tanpa token):
// isi event dan token bisa disadap. Pakai https:// untuk server di VPS.
// Di komputer CEO, nilai-nilai ini diisi di .claude/settings.local.json bagian "env".
//
// SubagentStop: subagent menyerahkan laporan lewat tool SubagentHandback, sehingga
// last_assistant_message bisa kosong. Bila tidak berisi baris STATUS, laporan diambil dari
// bagian akhir agent_transcript_path (maks 512 KB, dibaca sinkron).
// Token subagent: message.usage dari baris assistant di agent_transcript_path dijumlahkan (dedup per
// message.id; maks 8 MB terakhir, dibaca bertahap per 1 MB) dan dikirim sebagai field `tokens`.
// Field `project`: basename CLAUDE_PROJECT_DIR (bila ada) atau cwd sesi.
import { loadProjectEnv } from '../server/loadEnv.js';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { mapHookToEvents, parseStatus } from '../shared/hookMapping.js';
import { lastReportFromTranscript } from '../shared/transcript.js';
import { transcriptTokens } from './transcript-tokens.mjs';
import { isLoopbackHost } from '../server/net.js';
import { TOKEN_CHARS_RE, resolveToken, tokenFileLabel } from '../server/tokenSource.js';

loadProjectEnv({ quiet: true }); // .env proyek; env dari settings.json tetap menang

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

const URL_ = process.env.AI_OFFICE_URL || 'http://127.0.0.1:3000/api/events';
const tokenInfo = resolveToken({ token: process.env.AI_OFFICE_TOKEN, tokenFile: process.env.AI_OFFICE_TOKEN_FILE });
const TOKEN = tokenInfo.token;
// Label sumber untuk pesan debug. Nilai AI_OFFICE_TOKEN_FILE hanya dicetak bila jelas sebuah path.
const TOKEN_FILE_LABEL = tokenFileLabel(process.env.AI_OFFICE_TOKEN_FILE, tokenInfo.file);
const TOKEN_SOURCE = tokenInfo.source === 'file' ? `token dari ${TOKEN_FILE_LABEL}` : 'AI_OFFICE_TOKEN';
const debug = process.env.AI_OFFICE_DEBUG === '1';
const timeoutRaw = Number(process.env.AI_OFFICE_TIMEOUT_MS);
const TIMEOUT_MS = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(Math.round(timeoutRaw), 60_000) : 800;

/** Pastikan token tidak pernah ikut tercetak, sekalipun muncul di pesan error. */
const redact = (text) => (TOKEN ? String(text).split(TOKEN).join('[token]') : String(text));
const say = (text) => {
  if (debug) console.error(redact(text));
};

const STDIN_MAX_CHARS = 2_000_000;

function readStdin(timeoutMs = 3000) {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => {
      data += c;
      if (data.length > STDIN_MAX_CHARS) {
        // Terlalu besar: selesai segera (destroy() tidak memicu "end"). Data terpotong = JSON tidak sah → diabaikan.
        process.stdin.destroy();
        finish();
      }
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** Baca maksimal `maxBytes` terakhir dari file biasa; baris pertama yang terpotong dibuang. */
function readTail(path, maxBytes) {
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) return '';
    const length = Math.min(info.size, maxBytes);
    const start = info.size - length;
    const buf = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buf, read, length - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    let text = buf.subarray(0, read).toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // potongan awal bukan baris utuh
    return text;
  } finally {
    closeSync(fd);
  }
}

/** Isi last_assistant_message dari transkrip bila pesan aslinya tidak memuat STATUS. */
function enrichSubagentStop(input) {
  if (!input || input.hook_event_name !== 'SubagentStop' || !input.agent_type) return;
  const current = typeof input.last_assistant_message === 'string' ? input.last_assistant_message : '';
  if (parseStatus(current) !== 'unknown') return;
  const path = input.agent_transcript_path;
  if (typeof path !== 'string' || !path) return;
  try {
    const report = lastReportFromTranscript(readTail(path, TRANSCRIPT_TAIL_BYTES));
    if (report && (parseStatus(report) !== 'unknown' || !current.trim())) input.last_assistant_message = report;
  } catch (e) {
    say(`AI Office hook: transkrip tidak bisa dibaca (${e.code ?? e.message}), lanjut tanpa transkrip.`);
  }
}

/** Token subagent untuk SubagentStop, atau undefined (gagal / tidak relevan: dilewati diam-diam). */
function subagentTokens(input) {
  if (!input || input.hook_event_name !== 'SubagentStop' || !input.agent_type) return undefined;
  const path = input.agent_transcript_path;
  if (typeof path !== 'string' || !path) return undefined;
  try {
    return transcriptTokens(path) ?? undefined;
  } catch (e) {
    say(`AI Office hook: token transkrip tidak bisa dihitung (${e.code ?? e.message}).`);
    return undefined;
  }
}

/** Kembalikan alasan menolak mengirim (string) atau null bila aman. */
function transportProblem(target) {
  // Token tidak sah (resolveToken menolaknya: spasi, non-ASCII, dll.) = salah konfigurasi: jangan kirim
  // sama sekali (bukan "lanjut tanpa token"). Pemeriksaan TOKEN di sini hanya jaring pengaman.
  if (tokenInfo.invalid || (TOKEN && !TOKEN_CHARS_RE.test(TOKEN))) return `${TOKEN_SOURCE} berisi spasi atau karakter tidak valid; event tidak dikirim.`;
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return `protokol ${target.protocol} tidak didukung; event tidak dikirim.`;
  if (target.protocol === 'http:' && !isLoopbackHost(target.hostname)) {
    // Ditolak tanpa syarat: tanpa token pun, isi event (nama file, ringkasan laporan) bisa disadap.
    return (
      `${TOKEN ? 'token' : 'event'} tidak dikirim lewat http:// ke host non-loopback (${target.hostname}). ` +
      'Pakai https:// di AI_OFFICE_URL; event tidak dikirim.'
    );
  }
  return null;
}

async function main() {
  if (tokenInfo.problem && !tokenInfo.invalid) say(`AI Office hook: ${TOKEN_FILE_LABEL} ${tokenInfo.problem}; lanjut tanpa token.`);
  const raw = await readStdin();
  const input = JSON.parse(raw);
  enrichSubagentStop(input);
  const events = mapHookToEvents(input, { projectDir: process.env.CLAUDE_PROJECT_DIR, tokens: subagentTokens(input) });
  if (events.length) {
    const target = new URL(URL_);
    const problem = transportProblem(target);
    if (problem) {
      say(`AI Office hook: ${problem}`);
    } else {
      const headers = { 'Content-Type': 'application/json' };
      if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
      const res = await fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify(events),
        redirect: 'error', // jangan pernah ikut redirect (bisa membawa header ke tempat lain)
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (debug && !res.ok) say(`AI Office menolak event: HTTP ${res.status} ${await res.text()}`);
    }
  }
}

try {
  await main();
} catch (e) {
  // Termasuk ECONNREFUSED (server mati) dan timeout: diam kecuali AI_OFFICE_DEBUG=1.
  say(`AI Office hook: ${e.cause?.code ?? e.message}`);
}
process.exit(0);
