// Jumlah token subagent dari agent_transcript_path (dipakai hooks/send-event.mjs). I/O sinkron bertahap:
// hook adalah proses pendek, dan pembacaan dibatasi 8 MB terakhir, per potongan 1 MB.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { createTranscriptTokenSum } from '../shared/tokenUsage.js';

export const TOKEN_SCAN_BYTES = 8 * 1024 * 1024;
export const TOKEN_CHUNK_BYTES = 1024 * 1024;
export const TOKEN_DEADLINE_MS = 300; // hook SubagentStop sinkron ber-timeout 3 detik
export const TOKEN_MAX_PARSE_FAILURES = 200; // baris memuat "usage" tapi bukan JSON sah

/**
 * Jumlah token dari transkrip subagent: { input, output, cacheRead, cacheCreation }, atau null bila tidak
 * ada baris usage. Hanya `maxBytes` terakhir yang dibaca (per `chunkBytes`); bila mulai di tengah file,
 * potongan baris pertama dibuang. Baris rusak/terpotong dilewati. Error I/O dilempar ke pemanggil.
 */
export function transcriptTokens(path, maxBytes = TOKEN_SCAN_BYTES, chunkBytes = TOKEN_CHUNK_BYTES, deadlineMs = TOKEN_DEADLINE_MS) {
  const deadline = performance.now() + deadlineMs;
  const fd = openSync(path, 'r');
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size === 0) return null;
    const start = Math.max(0, info.size - maxBytes);
    const sum = createTranscriptTokenSum({ maxParseFailures: TOKEN_MAX_PARSE_FAILURES });
    const buf = Buffer.alloc(Math.max(1, Math.min(chunkBytes, info.size - start)));
    let skipFirst = false;
    if (start > 0) {
      // Mulai tepat sesudah "\n" = awal baris utuh; selain itu potongan baris pertama dibuang.
      const prev = Buffer.alloc(1);
      skipFirst = readSync(fd, prev, 0, 1, start - 1) !== 1 || prev[0] !== 10;
    }
    let pos = start;
    let carry = null;
    let lines = 0;
    // Batas waktu atau terlalu banyak baris rusak: berhenti, pakai hasil parsial (null bila belum ada).
    const stop = () => sum.exhausted || performance.now() > deadline;
    outer: while (pos < info.size) {
      if (stop()) return sum.result();
      const n = readSync(fd, buf, 0, Math.min(buf.length, info.size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const data = carry ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let from = 0;
      for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10, from)) {
        if (skipFirst) skipFirst = false;
        else sum.addLine(data.subarray(from, nl));
        from = nl + 1;
        if ((++lines & 255) === 0 && stop()) break outer;
      }
      carry = from < data.length ? Buffer.from(data.subarray(from)) : null;
    }

    // Baris terakhir tanpa "\n": dicoba juga (JSON yang terpotong gagal di-parse dan dilewati).
    if (carry && !skipFirst && !stop()) sum.addLine(carry);
    return sum.result();
  } finally {
    closeSync(fd);
  }
}
