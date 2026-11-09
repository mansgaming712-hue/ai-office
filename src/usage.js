// Panel "Pemakaian Limit": validasi data /api/usage dan pesan WebSocket { kind: "usage" },
// format angka, dan pemilihan warna bar. Fungsi murni tanpa DOM supaya bisa dites di Node.
// Dashboard tidak memanggil model atau API AI apa pun: data hanya dibaca dari server AI Office.
import { stripControl, truncate } from '../shared/events.js';

export const USAGE_LABEL = 'Estimasi, angka resmi cek /usage';
export const UNAVAILABLE_TEXT = 'data tidak tersedia';
export const CONFIG_HINT = 'Isi weeklyTokenLimit di limit-config.json';
export const WARNING_TEXT = 'Limit hampir habis, hemat mode';
export const POLL_MS = 60_000;
export const TOP_AGENTS = 5;
export const CHART_DAYS = 7;

export const LEVELS = ['green', 'yellow', 'red'];
export const LEVEL_INFO = {
  green: { label: 'Aman', color: '#45a85a' },
  yellow: { label: 'Waspada', color: '#e8b931' },
  red: { label: 'Kritis', color: '#e04848' },
};

const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheCreation', 'total'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 200; // batas defensif untuk days/perAgent

// ------------------------------------------------------------------ format angka

const nf = (digits) => new Intl.NumberFormat('id-ID', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
const NF0 = nf(0);
const NF1 = nf(1);
const UNITS = [
  [1e3, 'rb'],
  [1e6, 'jt'],
  [1e9, 'M'],
];

/** Angka token ringkas gaya Indonesia: 845, "12,3 rb", "845 rb", "1,2 jt", "3 M". Nilai rusak → "–". */
export function formatTokens(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '–';
  if (Math.round(n) < 1000) return NF0.format(Math.round(n));
  for (let i = 0; i < UNITS.length; i++) {
    const [unit, label] = UNITS[i];
    const v = n / unit;
    const digits = v < 100 ? 1 : 0;
    const rounded = Number(v.toFixed(digits));
    if (rounded >= 1000 && i < UNITS.length - 1) continue; // 999.950 → "1 jt", bukan "1.000 rb"
    return `${(digits ? NF1 : NF0).format(rounded)} ${label}`;
  }
  return '–';
}

/** Angka penuh dengan pemisah ribuan id-ID: "1.234.567". */
export function formatFull(n) {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? NF0.format(Math.round(n)) : '–';
}

/** "72%" / "12,5%". */
export function formatPercent(p) {
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0) return '–';
  return `${(p < 10 ? NF1 : NF0).format(Number(p.toFixed(p < 10 ? 1 : 0)))}%`;
}

// ------------------------------------------------------------------ level warna

/** Hijau < 60, kuning 60–85 (85 masih kuning), merah > 85. Nilai rusak → null. */
export function levelFor(percent) {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0) return null;
  if (percent > 85) return 'red';
  if (percent >= 60) return 'yellow';
  return 'green';
}

// ------------------------------------------------------------------ validasi

const isCount = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function tokens(o) {
  if (!isObj(o)) return null;
  const out = {};
  for (const f of TOKEN_FIELDS) {
    if (!isCount(o[f])) return null;
    out[f] = o[f];
  }
  return out;
}

function day(o) {
  const t = tokens(o);
  if (!t || typeof o.date !== 'string' || !DATE_RE.test(o.date)) return null;
  return { date: o.date, ...t };
}

const cleanText = (v, max) => {
  if (typeof v !== 'string') return null;
  const s = stripControl(v.replace(/\s+/g, ' ')).trim();
  return s ? truncate(s, max) : null;
};

function weeklyView(w) {
  if (!isObj(w)) return null;
  if (!isCount(w.used)) return null;
  if (w.limit !== null && !(isCount(w.limit) && w.limit > 0)) return null;
  if (w.percent !== null && !isCount(w.percent)) return null;
  if (w.level !== null && !LEVELS.includes(w.level)) return null;
  if (typeof w.configAvailable !== 'boolean') return null;
  const configured = w.configAvailable && w.limit !== null;
  let percent = null;
  let level = null;
  if (configured) {
    percent = w.percent ?? (w.used / w.limit) * 100;
    level = w.level ?? levelFor(percent); // utamakan level dari server, cadangan: hitung dari percent
  }
  return { used: w.used, limit: configured ? w.limit : null, percent, level, configured };
}

const unavailable = (reason) => ({ ok: false, reason: cleanText(reason, 120) ?? UNAVAILABLE_TEXT });

/**
 * Validasi objek `usage` (kontrak dev-backend). Tidak pernah melempar.
 * @returns {{ ok: true, usage: object } | { ok: false, reason: string }}
 */
export function validateUsage(raw) {
  try {
    if (!isObj(raw)) return unavailable();
    if (raw.available !== true) return unavailable(raw.reason);
    const today = day(raw.today);
    if (!today) return unavailable();
    if (!Array.isArray(raw.days) || raw.days.length > MAX_LIST) return unavailable();
    const days = raw.days.map(day);
    if (days.some((d) => !d)) return unavailable();
    const weekly = weeklyView(raw.weekly);
    if (!weekly) return unavailable();
    if (!Array.isArray(raw.perAgent) || raw.perAgent.length > MAX_LIST) return unavailable();
    const perAgent = [];
    for (const a of raw.perAgent) {
      const t = tokens(a);
      const agent = isObj(a) ? cleanText(a.agent, 64) : null;
      if (!t || !agent || !isCount(a.runs)) return unavailable();
      perAgent.push({ agent, ...t, runs: a.runs });
    }
    perAgent.sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent));
    const updated = typeof raw.updatedAt === 'string' ? Date.parse(raw.updatedAt) : NaN;
    return {
      ok: true,
      usage: {
        estimate: raw.estimate !== false,
        updatedAt: Number.isFinite(updated) ? new Date(updated).toISOString() : null,
        today,
        days: days.slice(-CHART_DAYS),
        weekly,
        topAgents: perAgent.slice(0, TOP_AGENTS),
        agentCount: perAgent.length,
      },
    };
  } catch {
    return unavailable();
  }
}

/** Respons GET /api/usage ({ ok, usage }) → hasil validateUsage. status null = fetch gagal. */
export function parseUsageResponse(status, body) {
  if (status !== 200 || !isObj(body) || body.ok !== true) return unavailable();
  return validateUsage(body.usage);
}

/** State panel dari hasil validasi. */
export function usageState(result) {
  return result.ok ? { status: 'ok', usage: result.usage } : { status: 'unavailable', reason: result.reason };
}

/**
 * State yang ditampilkan panel: data simulasi (kalau sedang diputar) menimpa tampilan SAJA;
 * data server tetap disimpan terpisah dan langsung tampil lagi begitu `sim` kembali null.
 */
export function displayUsage(real, sim) {
  return sim ? { status: 'ok', usage: sim, sim: true } : real;
}

/** Peringatan manajer: hanya kalau data valid, limit terisi, dan level merah (> 85%). */
export function isLimitWarning(state) {
  return state?.status === 'ok' && state.usage.weekly.configured && state.usage.weekly.level === 'red';
}

// ------------------------------------------------------------------ grafik 7 hari

const WEEKDAY = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

/** Batang grafik: tinggi relatif (0–100) terhadap hari terbesar, plus label hari & tanggal. */
export function chartBars(days) {
  const max = Math.max(0, ...days.map((d) => d.total));
  return days.map((d) => {
    const dt = new Date(`${d.date}T00:00:00Z`);
    const valid = !Number.isNaN(dt.getTime());
    return {
      date: d.date,
      total: d.total,
      height: max > 0 ? (d.total / max) * 100 : 0,
      weekday: valid ? WEEKDAY[dt.getUTCDay()] : '?',
      short: valid ? `${d.date.slice(8, 10)}/${d.date.slice(5, 7)}` : d.date,
    };
  });
}
