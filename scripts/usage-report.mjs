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
import { detectLang, t } from '../shared/i18n.js';
import { createUsageTracker, usageOptionsFromEnv } from '../server/usage.js';

const asJson = process.argv.includes('--json');
const tracker = createUsageTracker({ ...usageOptionsFromEnv(), saveCache: false, maxBytesPerCycle: Infinity });
const usage = await tracker.scanAll();

if (asJson) {
  console.log(JSON.stringify(usage, null, 2));
  process.exit(0);
}

const locale = detectLang() === 'id' ? 'id-ID' : 'en-US';
const fmt = (n) => Number(n).toLocaleString(locale);
const pct = (n) => n.toLocaleString(locale, { maximumFractionDigits: 1 });
const level = (l) => (['green', 'yellow', 'red'].includes(l) ? t(`usage.level.${l}`) : l);
const when = (iso) => new Date(iso).toLocaleString(locale, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

console.log(t('usage.title'));
if (!usage.available) console.log(t('usage.noLog', { reason: usage.reason }));
const today = usage.today;
console.log(t('usage.today', { date: today.date, total: fmt(today.total), input: fmt(today.input), output: fmt(today.output), cacheWrite: fmt(today.cacheCreation), cacheRead: fmt(today.cacheRead) }));
console.log(t('usage.last7'));
const width = Math.max(1, ...usage.days.map((d) => fmt(d.total).length));
for (const d of usage.days) console.log(`  ${d.date}  ${fmt(d.total).padStart(width)}`);
const sum7 = usage.days.reduce((n, d) => n + d.total, 0);
console.log(t('usage.total7', { total: fmt(sum7) }));

const w = usage.weekly;
const since = t('usage.since', { when: when(w.windowStart) });
if (w.limit) {
  const levelText = w.level ? ` [${level(w.level)}]` : '';
  console.log(t('usage.weekly', { used: fmt(w.used), limit: fmt(w.limit), pct: w.percent === null ? '' : ` (${pct(w.percent)}%)`, level: levelText, since }));
  if (w.percent !== null && w.percent > 85) {
    console.log(t('usage.warn', { pct: pct(w.percent) }));
  }
} else {
  const why = t(w.configAvailable ? 'usage.whyZero' : 'usage.whyNoConfig');
  console.log(t('usage.weeklyNoLimit', { used: fmt(w.used), since, why }));
}

if (usage.perAgent.length) {
  console.log(t('usage.perAgent'));
  const nameWidth = Math.max(...usage.perAgent.map((a) => a.agent.length));
  for (const a of usage.perAgent) console.log(`  ${a.agent.padEnd(nameWidth)}  ${fmt(a.total).padStart(14)}  ${t('usage.runs', { n: a.runs })}`);
} else {
  console.log(t('usage.noPerAgent'));
}
process.exit(0);
