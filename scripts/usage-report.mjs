#!/usr/bin/env node
// Ringkasan pemakaian token Claude Code di terminal, tanpa server (ESTIMASI dari log lokal).
//   npm run usage
//   npm run usage -- --json         keluaran JSON (bentuk sama dengan GET /api/usage → usage)
//   AI_OFFICE_CLAUDE_DIR=<folder>   folder log lain (mis. tests/fixtures/usage-sample)
//   AI_OFFICE_LIMIT_CONFIG=<file>   limit-config.json lain
// Cache server (data/usage-cache.json) dipakai sebagai titik awal bila cocok dengan folder log, tetapi
// tidak ditulis. Token per agen dibaca dari data/usage-agents.json (diisi server dari event hook).
// Hanya angka dan nama agen yang dicetak: tidak ada path, isi pesan, atau nama sesi.
// Kode keluar selalu 0 (juga saat data tidak tersedia), supaya aman dipakai di skrip.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { createUsageTracker, usageOptionsFromEnv } from '../server/usage.js';

const asJson = process.argv.includes('--json');
const tracker = createUsageTracker({ ...usageOptionsFromEnv(), saveCache: false, maxBytesPerCycle: Infinity });
const usage = await tracker.scanAll();

if (asJson) {
  console.log(JSON.stringify(usage, null, 2));
  process.exit(0);
}

const fmt = (n) => Number(n).toLocaleString('id-ID');
const pct = (n) => n.toLocaleString('id-ID', { maximumFractionDigits: 1 });
const LEVEL = { green: 'hijau', yellow: 'kuning', red: 'merah' };
const when = (iso) => new Date(iso).toLocaleString('id-ID', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

console.log('Pemakaian token Claude Code (ESTIMASI dari log lokal, bukan angka resmi)');
if (!usage.available) console.log(`Data log tidak tersedia: ${usage.reason}.`);
const t = usage.today;
console.log(`Hari ini (${t.date}): ${fmt(t.total)} token  [input ${fmt(t.input)}, output ${fmt(t.output)}, cache tulis ${fmt(t.cacheCreation)}, cache baca ${fmt(t.cacheRead)}]`);
console.log('7 hari terakhir:');
const width = Math.max(1, ...usage.days.map((d) => fmt(d.total).length));
for (const d of usage.days) console.log(`  ${d.date}  ${fmt(d.total).padStart(width)}`);
const sum7 = usage.days.reduce((n, d) => n + d.total, 0);
console.log(`  total 7 hari: ${fmt(sum7)}`);

const w = usage.weekly;
const since = `sejak ${when(w.windowStart)}`;
if (w.limit) {
  const level = w.level ? ` [${LEVEL[w.level] ?? w.level}]` : '';
  console.log(`Mingguan: ${fmt(w.used)} dari ${fmt(w.limit)} token${w.percent === null ? '' : ` (${pct(w.percent)}%)`}${level}, ${since}`);
  if (w.percent !== null && w.percent > 85) {
    console.log(`PERINGATAN: pemakaian mingguan di atas 85% (${pct(w.percent)}%). Hemat limit: tunda tugas besar atau pakai agen seperlunya.`);
  }
} else {
  const why = w.configAvailable ? 'weeklyTokenLimit di limit-config.json masih 0' : 'limit-config.json belum ada atau tidak valid';
  console.log(`Mingguan: ${fmt(w.used)} token, ${since} (tanpa batas: ${why})`);
}

if (usage.perAgent.length) {
  console.log('Per agen, 7 hari (dari hook SubagentStop):');
  const nameWidth = Math.max(...usage.perAgent.map((a) => a.agent.length));
  for (const a of usage.perAgent) console.log(`  ${a.agent.padEnd(nameWidth)}  ${fmt(a.total).padStart(14)}  (${a.runs} run)`);
} else {
  console.log('Per agen: belum ada data dari hook.');
}
process.exit(0);
