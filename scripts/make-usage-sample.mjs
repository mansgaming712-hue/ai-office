#!/usr/bin/env node
// Buat data contoh log Claude Code untuk statistik pemakaian (tanpa isi percakapan asli).
//   npm run usage:sample                  tulis ulang tests/fixtures/usage-sample/ relatif ke hari ini
//   node scripts/make-usage-sample.mjs <folder> [YYYY-MM-DD]
// Lalu: AI_OFFICE_CLAUDE_DIR=tests/fixtures/usage-sample npm run usage
// Data mencakup 7 hari (hari ini dan 6 hari sebelumnya), sesi utama + subagents/, baris streaming yang
// mengulang message.id yang sama, cadangan requestId, baris rusak, baris tanpa usage, dan baris terakhir
// yang belum lengkap. Waktu memakai jam 12:xx UTC supaya tanggal lokal sama di zona waktu -11..+11.
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_DIR = fileURLToPath(new URL('../tests/fixtures/usage-sample/', import.meta.url));

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/**
 * Isi file contoh + total yang diharapkan per tanggal.
 * @param {Date} base hari terakhir (lokal)
 * @returns {{ files: Record<string, string>, expected: Record<string, {input:number, output:number, cacheRead:number, cacheCreation:number}> }}
 */
export function buildSample(base = new Date()) {
  const main = [];
  const sub = [];
  const toko = [];
  const expected = {};
  const add = (date, u) => {
    const e = (expected[date] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 });
    e.input += u.input_tokens;
    e.output += u.output_tokens;
    e.cacheRead += u.cache_read_input_tokens;
    e.cacheCreation += u.cache_creation_input_tokens;
  };
  const assistant = (ts, id, u, extra = {}) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      requestId: `req_${id}`,
      uuid: `uuid-${id}`,
      ...extra,
      message: { id: `msg_${id}`, role: 'assistant', model: 'contoh', content: [{ type: 'text', text: 'contoh' }], usage: u },
    });
  for (let i = 6; i >= 0; i--) {
    const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() - i);
    const date = ymd(day);
    const at = (min) => new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), 12, min)).toISOString();
    const k = 7 - i; // 1..7, makin besar mendekati hari ini
    main.push(JSON.stringify({ type: 'user', timestamp: at(0), uuid: `u-${date}`, message: { role: 'user', content: 'contoh' } }));
    for (let m = 0; m < 3; m++) {
      const u = { input_tokens: 10 * k, output_tokens: 100 * k + m, cache_read_input_tokens: 1000 * k, cache_creation_input_tokens: 200 * k };
      const id = `main_${date}_${m}`;
      main.push(assistant(at(1 + m), id, u));
      main.push(assistant(at(1 + m), id, u)); // baris streaming kedua untuk pesan yang sama (dedup)
      add(date, u);
    }
    const su = { input_tokens: 5 * k, output_tokens: 40 * k, cache_read_input_tokens: 300 * k, cache_creation_input_tokens: 50 * k };
    sub.push(assistant(at(10), `sub_${date}`, su, { isSidechain: true }));
    add(date, su);
    if (i % 2 === 0) {
      // Tanpa message.id: cadangan requestId (dua baris requestId sama = satu pesan).
      const tu = { input_tokens: 7, output_tokens: 70, cache_read_input_tokens: 0, cache_creation_input_tokens: 700 };
      const line = JSON.stringify({ type: 'assistant', timestamp: at(20), requestId: `req_toko_${date}`, message: { role: 'assistant', usage: tu } });
      toko.push(line, line);
      add(date, tu);
    }
  }
  toko.push('{"type":"assistant","timestamp": rusak');
  toko.push(JSON.stringify({ type: 'system', subtype: 'contoh', timestamp: new Date().toISOString() }));
  // Baris terakhir belum lengkap (tanpa "\n"): tidak dihitung sampai lengkap.
  const partial = '{"type":"assistant","timestamp":"2026-01-01T12:00:00.000Z","message":{"id":"msg_belum_lengkap","usage":{"input_tokens":999';
  return {
    files: {
      'projects/C--contoh-ai-office/sesi-utama.jsonl': `${main.join('\n')}\n`,
      'projects/C--contoh-ai-office/sesi-utama/subagents/agent-contoh1.jsonl': `${sub.join('\n')}\n`,
      'projects/C--contoh-toko/sesi-toko.jsonl': `${toko.join('\n')}\n${partial}`,
    },
    expected,
  };
}

/** Tulis contoh ke `dir` (isi lama di dir/projects dihapus dulu). */
export function writeSample(dir, base = new Date()) {
  const { files, expected } = buildSample(base);
  rmSync(join(dir, 'projects'), { recursive: true, force: true });
  for (const [rel, text] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
    utimesSync(p, base, base); // mtime = hari contoh (file yang lebih tua dari 8 hari tidak dibaca)
  }
  return expected;
}

const isMain = process.argv[1] && resolve(process.argv[1]).toLowerCase() === resolve(fileURLToPath(import.meta.url)).toLowerCase();
if (isMain) {
  const dir = process.argv[2] ? resolve(process.argv[2]) : SAMPLE_DIR;
  const base = process.argv[3] ? new Date(`${process.argv[3]}T12:00:00`) : new Date();
  if (Number.isNaN(base.getTime())) {
    console.error('Tanggal harus YYYY-MM-DD');
    process.exit(1);
  }
  writeSample(dir, base);
  console.log(`Data contoh 7 hari (sampai ${ymd(base)}) ditulis ke ${dir}`);
}
