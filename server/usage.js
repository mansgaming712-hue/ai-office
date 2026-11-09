// Statistik pemakaian token Claude Code (ESTIMASI, lokal, tanpa API apa pun).
//
// Sumber 1: log sesi Claude Code `<folder dasar>/projects/**/*.jsonl` (termasuk `subagents/`).
//   Folder dasar default ~/.claude; bisa diganti env AI_OFFICE_CLAUDE_DIR (bila folder itu tidak punya
//   subfolder `projects/`, folder itu sendiri yang dipindai). Baris dengan message.usage dihitung
//   (input, output, cache read, cache creation), dedup global per message.id (cadangan requestId, uuid),
//   dikelompokkan per JAM lokal (zona waktu mesin) supaya window mingguan bisa mulai di jam mana pun.
// Sumber 2: field `tokens` di event hook (SubagentStop) → token per agen (`from`), window 7 hari,
//   disimpan di data/usage-agents.json.
//
// Inkremental: per file disimpan offset byte, ukuran, mtime, dan sidik jari awal file. Tiap pemindaian
// hanya membaca byte baru; baris terakhir yang belum lengkap tidak dikonsumsi; file yang mengecil atau
// awalnya berubah dibaca ulang (id yang sudah terhitung tetap di-dedup). File yang tidak berubah sejak
// sebelum window retensi (8 hari) tidak dibaca sama sekali. Maks `maxBytesPerCycle` per siklus; sisanya
// dilanjutkan di siklus berikutnya (segera, 1 detik kemudian). Cache: data/usage-cache.json (path file
// disimpan sebagai hash, bukan path asli).
//
// Konfigurasi limit: limit-config.json di root proyek (env AI_OFFICE_LIMIT_CONFIG), dibaca ulang tiap
// siklus; JSON rusak = konfigurasi tidak tersedia.
//
// Privasi: hasil (snapshot) dan log hanya berisi angka dan nama agen. Tidak ada path, isi pesan, atau
// nama sesi.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_NAMES } from '../shared/roster.js';
import { TOKEN_FIELDS, addTokens, tokenTotal, usageId, usageOf, zeroTokens } from '../shared/tokenUsage.js';

export const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_CACHE_FILE = join(ROOT_DIR, 'data', 'usage-cache.json');
export const DEFAULT_AGENTS_FILE = join(ROOT_DIR, 'data', 'usage-agents.json');
export const DEFAULT_LIMIT_CONFIG = join(ROOT_DIR, 'limit-config.json');

const CACHE_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_DAYS = 8; // agregat dan id disimpan ~8 hari (window mingguan maks 7 hari ke belakang)
const AGENT_WINDOW_MS = 7 * DAY_MS;
const MAX_AGENT_RECORDS = 5_000; // 7 hari x ratusan run/hari sudah jauh di atas pemakaian nyata
export const OTHER_AGENT = 'lainnya';
const ROSTER = new Set(AGENT_NAMES);
/** Nama agen untuk statistik: hanya nama di roster; selain itu digabung ke "lainnya" (cegah pemalsuan/pembengkakan). */
const agentLabel = (name) => (ROSTER.has(name) ? name : OTHER_AGENT);
const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 32 * 1024 * 1024; // baris lebih panjang dari ini dilewati (bukan baris usage)
const HEAD_BYTES = 256; // sidik jari awal file untuk mendeteksi file yang ditulis ulang
const MAX_DEPTH = 8;
const MAX_FILES = 50_000;
// "Format tidak dikenali" baru dilaporkan setelah sekian baris tanpa satu pun usage (sesi yang baru mulai
// hanya punya beberapa baris user/sistem).
const MIN_LINES_FOR_FORMAT = 10;

export const REASONS = {
  disabled: 'Statistik pemakaian tidak aktif',
  pending: 'Statistik sedang dihitung',
  missing: 'Folder log Claude Code tidak ditemukan',
  unreadable: 'Folder log Claude Code tidak bisa dibaca',
  empty: 'Belum ada file log Claude Code',
  format: 'Format log Claude Code tidak dikenali',
  error: 'Statistik pemakaian gagal dihitung',
};

/** Folder dasar log dari env (atau ~/.claude). */
export function claudeBaseDir(env = process.env) {
  const v = typeof env.AI_OFFICE_CLAUDE_DIR === 'string' ? env.AI_OFFICE_CLAUDE_DIR.trim() : '';
  return v ? { dir: resolve(v), explicit: true } : { dir: join(homedir(), '.claude'), explicit: false };
}

/** Opsi tracker dari env: AI_OFFICE_CLAUDE_DIR dan AI_OFFICE_LIMIT_CONFIG. */
export function usageOptionsFromEnv(env = process.env) {
  const base = claudeBaseDir(env);
  const cfg = typeof env.AI_OFFICE_LIMIT_CONFIG === 'string' ? env.AI_OFFICE_LIMIT_CONFIG.trim() : '';
  return { claudeDir: base.dir, claudeDirExplicit: base.explicit, limitConfigFile: cfg ? resolve(cfg) : DEFAULT_LIMIT_CONFIG };
}

// ------------------------------------------------------------------------------------- waktu lokal
const pad = (n, w = 2) => String(n).padStart(w, '0');
export const dateKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hourKey = (d) => `${dateKey(d)}T${pad(d.getHours())}`;
const HOUR_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})$/;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Awal jam lokal dari kunci "YYYY-MM-DDTHH" (ms), atau NaN. */
export function hourStartMs(key) {
  const m = HOUR_KEY_RE.exec(key);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4])).getTime() : NaN;
}
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
/** Batas bawah retensi: awal hari lokal (RETENTION_DAYS - 1) hari sebelum hari ini, minus 1 hari cadangan. */
const retentionCutoff = (now) => addDays(startOfDay(now), -RETENTION_DAYS).getTime();

// ------------------------------------------------------------------------------------- konfigurasi
/** Normalisasi isi limit-config.json. Nilai yang tidak sah jatuh ke default. */
export function normalizeLimitConfig(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const limit = typeof data.weeklyTokenLimit === 'number' && Number.isFinite(data.weeklyTokenLimit) && data.weeklyTokenLimit > 0 ? data.weeklyTokenLimit : null;
  const day = Number.isInteger(data.weekResetDay) && data.weekResetDay >= 0 && data.weekResetDay <= 6 ? data.weekResetDay : null;
  const hour = Number.isInteger(data.weekResetHour) && data.weekResetHour >= 0 && data.weekResetHour <= 23 ? data.weekResetHour : 0;
  return { weeklyTokenLimit: limit, weekResetDay: day, weekResetHour: hour, countCacheRead: data.countCacheRead === true };
}

/** Baca limit-config.json; null bila tidak ada, tidak terbaca, atau JSON rusak (tidak pernah melempar). */
export async function readLimitConfig(file) {
  try {
    const text = await readFile(file, 'utf8');
    return normalizeLimitConfig(JSON.parse(text.replace(/^﻿/, '')));
  } catch {
    return null;
  }
}

/** Awal window mingguan (ms). Bergulir 7 hari (dibulatkan ke awal jam) atau sejak hari/jam reset terakhir. */
export function weekWindowStart(now, config) {
  if (config && config.weekResetDay !== null && config.weekResetDay !== undefined) {
    const back = (now.getDay() - config.weekResetDay + 7) % 7;
    let start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back, config.weekResetHour ?? 0);
    if (start.getTime() > now.getTime()) start = new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7, config.weekResetHour ?? 0);
    return start.getTime();
  }
  const t = new Date(now.getTime() - 7 * DAY_MS);
  return new Date(t.getFullYear(), t.getMonth(), t.getDate(), t.getHours()).getTime();
}

export function levelOf(percent) {
  if (percent === null) return null;
  if (percent < 60) return 'green';
  if (percent <= 85) return 'yellow';
  return 'red';
}

// ------------------------------------------------------------------------------------- snapshot
const dayRow = (date, t = zeroTokens()) => ({ date, ...pickTokens(t), total: tokenTotal(t) });
const pickTokens = (t) => ({ input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation });

/**
 * Bentuk respons /api/usage (kontrak dengan UI). Semua field selalu ada.
 * @param {object} p
 * @param {Date} p.now
 * @param {Record<string, object>} [p.hours] agregat per jam lokal { "YYYY-MM-DDTHH": tokens }
 * @param {object|null} [p.config] hasil normalizeLimitConfig
 * @param {object[]} [p.perAgent]
 * @param {string|null} [p.reason] null = tersedia
 * @param {string|null} [p.updatedAt]
 */
export function buildUsage({ now, hours = {}, config = null, perAgent = [], reason = null, updatedAt = null }) {
  const available = reason === null;
  const byDay = new Map();
  const windowStart = weekWindowStart(now, config);
  const week = zeroTokens();
  if (available) {
    for (const [key, t] of Object.entries(hours)) {
      const day = key.slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, zeroTokens());
      addTokens(byDay.get(day), t);
      const at = hourStartMs(key);
      if (at >= windowStart && at <= now.getTime()) addTokens(week, t);
    }
  }
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = dateKey(addDays(now, -i));
    days.push(dayRow(d, byDay.get(d)));
  }
  const countCacheRead = config?.countCacheRead === true;
  const used = week.input + week.output + week.cacheCreation + (countCacheRead ? week.cacheRead : 0);
  const limit = config?.weeklyTokenLimit ?? null;
  const percent = available && limit ? Math.round((used / limit) * 1000) / 10 : null;
  return {
    available,
    reason,
    estimate: true,
    updatedAt,
    today: { ...days[6] },
    days,
    weekly: {
      used: available ? used : 0,
      limit,
      percent,
      level: levelOf(percent),
      windowStart: new Date(windowStart).toISOString(),
      configAvailable: config !== null,
    },
    perAgent,
  };
}

/** Snapshot "tidak tersedia" tanpa tracker (mis. server dibuat tanpa opsi usage). */
export function unavailableUsage(reason = REASONS.disabled, now = new Date()) {
  return buildUsage({ now, reason });
}

/** Jumlahkan catatan token per agen (window 7 hari), urut menurun per total. */
export function aggregateAgents(records, nowMs) {
  const map = new Map();
  for (const r of records) {
    if (r.t < nowMs - AGENT_WINDOW_MS || r.t > nowMs + 60_000) continue;
    const name = agentLabel(r.agent);
    let a = map.get(name);
    if (!a) map.set(name, (a = { agent: name, ...zeroTokens(), total: 0, runs: 0 }));
    addTokens(a, r);
    a.runs++;
  }
  const out = [...map.values()];
  for (const a of out) a.total = tokenTotal(a);
  return out.sort((x, y) => y.total - x.total || (x.agent < y.agent ? -1 : 1));
}

// ------------------------------------------------------------------------------------- file JSON
async function readJson(file) {
  try {
    return JSON.parse((await readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/** Tulis JSON secara atomik (file sementara lalu rename). */
export async function writeJsonAtomic(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

const hashOf = (text) => createHash('sha256').update(text).digest('base64url').slice(0, 22);
const isTokens = (t) => t && typeof t === 'object' && TOKEN_FIELDS.every((k) => typeof t[k] === 'number' && Number.isFinite(t[k]) && t[k] >= 0);

/** Validasi isi usage-cache.json; null bila rusak / versi lain / folder lain. */
function loadCacheData(data, baseHash) {
  if (!data || typeof data !== 'object' || data.version !== CACHE_VERSION || data.base !== baseHash) return null;
  const files = new Map();
  for (const [k, f] of Object.entries(data.files ?? {})) {
    if (f && Number.isFinite(f.offset) && Number.isFinite(f.size) && Number.isFinite(f.mtimeMs) && f.offset >= 0) {
      files.set(k, { offset: f.offset, size: f.size, mtimeMs: f.mtimeMs, head: typeof f.head === 'string' ? f.head : '', more: f.more === true, skip: f.skip === true });
    }
  }
  const hours = new Map();
  for (const [k, t] of Object.entries(data.hours ?? {})) if (HOUR_KEY_RE.test(k) && isTokens(t)) hours.set(k, { ...pickTokens(t) });
  const seen = new Map();
  for (const [day, ids] of Object.entries(data.seen ?? {})) {
    if (!DATE_KEY_RE.test(day) || !Array.isArray(ids)) continue;
    for (const id of ids) if (typeof id === 'string') seen.set(id, day);
  }
  const stats = { lines: Number(data.stats?.lines) || 0, recognized: Number(data.stats?.recognized) || 0 };
  return { files, hours, seen, stats };
}

// ------------------------------------------------------------------------------------- tracker
/**
 * @param {object} opts
 * @param {string} opts.claudeDir folder dasar (berisi projects/) atau folder log langsung bila claudeDirExplicit
 * @param {boolean} [opts.claudeDirExplicit] true = dari env/opsi: tanpa projects/, folder itu sendiri dipindai
 * @param {string|null} [opts.cacheFile] null = cache hanya di memori
 * @param {boolean} [opts.saveCache] false = cache dibaca tetapi tidak ditulis (CLI)
 * @param {string|null} [opts.agentsFile]
 * @param {string} [opts.limitConfigFile]
 * @param {number} [opts.intervalMs] 60 detik
 * @param {number} [opts.debounceMs] 2 detik (setelah event yang membawa tokens)
 * @param {number} [opts.continueMs] jeda lanjutan bila masih ada sisa byte
 * @param {number} [opts.maxBytesPerCycle] 64 MB; Infinity = tanpa batas (CLI)
 * @param {() => Date} [opts.now]
 * @param {(line: string) => void} [opts.log]
 */
export function createUsageTracker({
  claudeDir,
  claudeDirExplicit = false,
  cacheFile = DEFAULT_CACHE_FILE,
  saveCache = true,
  agentsFile = DEFAULT_AGENTS_FILE,
  limitConfigFile = DEFAULT_LIMIT_CONFIG,
  intervalMs = 60_000,
  debounceMs = 2_000,
  continueMs = 1_000,
  maxBytesPerCycle = 64 * 1024 * 1024,
  now = () => new Date(),
  log = () => {},
} = {}) {
  if (!claudeDir) claudeDir = claudeBaseDir().dir;
  const baseHash = hashOf(resolve(claudeDir).toLowerCase());
  const emptyState = () => ({ files: new Map(), hours: new Map(), seen: new Map(), stats: { lines: 0, recognized: 0 } });
  let state = emptyState();
  let agentRecords = [];
  let config = null;
  let dirStatus = 'pending'; // pending | ok | missing | unreadable | empty | error
  let updatedAt = null;
  let loaded = false;
  let running = null;
  let again = false;
  let stopped = true;
  let interval = null;
  let debounceTimer = null;
  let continueTimer = null;
  let agentsSaveTimer = null;
  let lastKey = null;
  let backlogLeft = false; // siklus terakhir berhenti karena anggaran byte habis
  const listeners = new Set();
  // Pesan gagal simpan (mis. EROFS di VPS dengan ProtectSystem=strict) hanya dicatat sekali per jenis.
  const warned = new Set();
  const warnOnce = (line) => {
    if (warned.has(line)) return;
    warned.add(line);
    log(line);
  };

  async function loadPersisted() {
    if (loaded) return;
    loaded = true;
    if (cacheFile) {
      const c = loadCacheData(await readJson(cacheFile), baseHash);
      if (c) {
        state = c;
        dirStatus = c.files.size ? 'ok' : 'pending';
      }
    }
    if (agentsFile) {
      const a = await readJson(agentsFile);
      if (Array.isArray(a?.records)) {
        agentRecords = a.records
          .filter((r) => r && typeof r.agent === 'string' && r.agent && r.agent.length <= 64 && Number.isFinite(r.t) && isTokens(r))
          .map((r) => ({ t: r.t, agent: agentLabel(r.agent), ...pickTokens(r) }))
          .slice(-MAX_AGENT_RECORDS);
      }
    }
  }

  async function logDir() {
    const projects = join(claudeDir, 'projects');
    if (!claudeDirExplicit) return projects;
    const info = await stat(projects).catch(() => null);
    return info?.isDirectory() ? projects : claudeDir;
  }

  /** Semua *.jsonl di bawah `dir` (rekursif, tanpa symlink). Melempar bila `dir` sendiri tidak terbaca. */
  async function listFiles(dir) {
    const out = [];
    const walk = async (d, depth, isRoot) => {
      let entries;
      try {
        entries = await readdir(d, { withFileTypes: true });
      } catch (e) {
        if (isRoot) throw e;
        return;
      }
      for (const ent of entries) {
        if (out.length >= MAX_FILES) return;
        const p = join(d, ent.name);
        if (ent.isDirectory()) {
          if (depth < MAX_DEPTH) await walk(p, depth + 1, false);
        } else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(p);
      }
    };
    await walk(dir, 0, true);
    return out;
  }

  function addLine(buf, cutoff) {
    if (buf.length === 0) return;
    // Baris kosong / spasi saja tidak dihitung.
    let i = 0;
    while (i < buf.length && (buf[i] === 32 || buf[i] === 9 || buf[i] === 13)) i++;
    if (i === buf.length) return;
    state.stats.lines++;
    if (!buf.includes('"usage"')) return;
    let entry;
    try {
      entry = JSON.parse(buf.toString('utf8'));
    } catch {
      return;
    }
    const usage = usageOf(entry);
    if (!usage) return;
    state.stats.recognized++;
    const ts = typeof entry.timestamp === 'string' || typeof entry.timestamp === 'number' ? new Date(entry.timestamp) : null;
    if (!ts || Number.isNaN(ts.getTime()) || ts.getTime() < cutoff) return;
    const id = usageId(entry);
    const day = dateKey(ts);
    if (id !== null) {
      if (state.seen.has(id)) return;
      state.seen.set(id, day);
    }
    const key = hourKey(ts);
    if (!state.hours.has(key)) state.hours.set(key, zeroTokens());
    addTokens(state.hours.get(key), usage);
  }

  async function readHead(fh, size) {
    const n = Math.min(HEAD_BYTES, size);
    if (n <= 0) return '';
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return hashOf(buf.subarray(0, bytesRead).toString('latin1'));
  }

  /** Baca byte baru satu file. Mengembalikan jumlah byte yang dibaca. */
  async function readFileIncrement(path, key, info, budget, cutoff) {
    let entry = state.files.get(key);
    const fh = await open(path, 'r');
    try {
      if (entry && entry.offset > 0) {
        // File mengecil atau awalnya berubah (ditulis ulang): baca ulang dari awal.
        const shrunk = info.size < entry.offset;
        if (shrunk || (entry.head && (await readHead(fh, entry.offset)) !== entry.head)) {
          entry = { offset: 0, size: 0, mtimeMs: 0, head: '', more: false, skip: false };
        }
      }
      if (!entry) entry = { offset: 0, size: 0, mtimeMs: 0, head: '', more: false, skip: false };
      let pos = entry.offset;
      let consumed = pos;
      let carry = null;
      let skip = entry.skip;
      let read = 0;
      const end = Math.min(info.size, pos + Math.max(budget, 0));
      const buf = Buffer.alloc(CHUNK_BYTES);
      while (pos < end) {
        const want = Math.min(CHUNK_BYTES, end - pos);
        const { bytesRead } = await fh.read(buf, 0, want, pos);
        if (bytesRead <= 0) break;
        pos += bytesRead;
        read += bytesRead;
        const data = carry ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
        const base = pos - data.length; // posisi file untuk data[0]
        let from = 0;
        for (let nl = data.indexOf(10); nl >= 0; nl = data.indexOf(10, from)) {
          if (skip) skip = false; // akhir baris raksasa yang dilewati
          else addLine(data.subarray(from, nl), cutoff);
          from = nl + 1;
          consumed = base + from;
        }
        carry = from < data.length ? Buffer.from(data.subarray(from)) : null;
        if (carry && carry.length > MAX_LINE_BYTES) {
          // Baris terlalu panjang (bukan baris usage): lewati sampai "\n" berikutnya.
          carry = null;
          skip = true;
          consumed = pos;
        }
      }
      // Baris terakhir yang belum lengkap (carry) TIDAK dikonsumsi: dibaca lagi di siklus berikutnya.
      const head = consumed > 0 ? await readHead(fh, consumed) : '';
      state.files.set(key, { offset: consumed, size: info.size, mtimeMs: info.mtimeMs, head, more: pos < info.size, skip });
      return read;
    } finally {
      await fh.close();
    }
  }

  function prune(nowDate) {
    const cutoff = retentionCutoff(nowDate);
    const cutoffDay = dateKey(new Date(cutoff));
    for (const k of state.hours.keys()) if (hourStartMs(k) < cutoff) state.hours.delete(k);
    for (const [id, day] of state.seen) if (day < cutoffDay) state.seen.delete(id);
    const nowMs = nowDate.getTime();
    agentRecords = agentRecords.filter((r) => r.t >= nowMs - AGENT_WINDOW_MS);
  }

  async function persistCache() {
    if (!cacheFile || !saveCache) return;
    const seen = {};
    for (const [id, day] of state.seen) (seen[day] ??= []).push(id);
    await writeJsonAtomic(cacheFile, {
      version: CACHE_VERSION,
      base: baseHash,
      files: Object.fromEntries(state.files),
      hours: Object.fromEntries(state.hours),
      stats: state.stats,
      seen,
    });
  }

  async function scanOnce() {
    const nowDate = now();
    await loadPersisted();
    config = await readLimitConfig(limitConfigFile);
    const cutoff = retentionCutoff(nowDate);
    let dir;
    let files;
    try {
      dir = await logDir();
      files = await listFiles(dir);
    } catch (e) {
      dirStatus = e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable';
      state = emptyState();
      prune(nowDate);
      updatedAt = nowDate.toISOString();
      return false;
    }
    let budget = maxBytesPerCycle;
    let backlog = false;
    const present = new Set();
    const infos = [];
    for (const p of files) {
      const info = await stat(p).catch(() => null);
      if (info?.isFile()) infos.push({ p, info, key: hashOf(p) });
    }
    // Terbaru dulu, supaya data hari ini cepat tersedia bila anggaran habis.
    infos.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    for (const { p, info, key } of infos) {
      present.add(key);
      const entry = state.files.get(key);
      if (!entry && info.mtimeMs < cutoff) {
        // Tidak berubah sejak sebelum window: isinya pasti lebih tua dari retensi, tidak perlu dibaca.
        state.files.set(key, { offset: info.size, size: info.size, mtimeMs: info.mtimeMs, head: '', more: false, skip: false });
        continue;
      }
      if (entry && !entry.more && entry.size === info.size && entry.mtimeMs === info.mtimeMs) continue;
      if (budget <= 0) {
        backlog = true;
        continue;
      }
      try {
        budget -= await readFileIncrement(p, key, info, budget, cutoff);
        if (state.files.get(key)?.more) backlog = true;
      } catch (e) {
        warnOnce(`[usage] file log dilewati (${e.code ?? 'error'})`);
      }
      await new Promise((r) => setImmediate(r)); // beri kesempatan event loop
    }
    for (const k of state.files.keys()) if (!present.has(k)) state.files.delete(k);
    dirStatus = infos.length ? 'ok' : 'empty';
    prune(nowDate);
    updatedAt = now().toISOString();
    try {
      await persistCache();
    } catch (e) {
      warnOnce(`[usage] cache tidak bisa disimpan (${e.code ?? 'error'})`);
    }
    return backlog;
  }

  function reasonNow() {
    if (dirStatus === 'pending') return REASONS.pending;
    if (dirStatus !== 'ok') return REASONS[dirStatus] ?? REASONS.error;
    if (state.stats.lines >= MIN_LINES_FOR_FORMAT && state.stats.recognized === 0) return REASONS.format;
    return null;
  }

  function snapshot() {
    const nowDate = now();
    try {
      return buildUsage({
        now: nowDate,
        hours: Object.fromEntries(state.hours),
        config,
        perAgent: aggregateAgents(agentRecords, nowDate.getTime()),
        reason: reasonNow(),
        updatedAt,
      });
    } catch (e) {
      log(`[usage] snapshot gagal (${e.message})`);
      return unavailableUsage(REASONS.error, nowDate);
    }
  }

  function notifyIfChanged() {
    const snap = snapshot();
    const { updatedAt: _ignored, ...rest } = snap;
    const key = JSON.stringify(rest);
    if (key === lastKey) return false;
    lastKey = key;
    for (const fn of listeners) {
      try {
        fn(snap);
      } catch (e) {
        log(`[usage] pendengar gagal (${e.message})`);
      }
    }
    return true;
  }

  /** Satu siklus pemindaian. Pemanggilan paralel digabung (siklus berikutnya menyusul bila perlu). */
  function scan() {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      let backlog = false;
      try {
        backlog = await scanOnce();
        backlogLeft = backlog;
      } catch (e) {
        dirStatus = 'error';
        log(`[usage] pemindaian gagal (${e.code ?? e.message})`);
      } finally {
        running = null;
      }
      notifyIfChanged();
      if (!stopped && (backlog || again)) {
        again = false;
        clearTimeout(continueTimer);
        continueTimer = setTimeout(() => scan(), backlog ? continueMs : 0);
        continueTimer.unref?.();
      }
      return snapshot();
    })();
    return running;
  }

  /** Pindai sampai tidak ada sisa (CLI). */
  async function scanAll(maxCycles = 1000) {
    for (let i = 0; i < maxCycles; i++) {
      await scan();
      if (!backlogLeft) break;
    }
    return snapshot();
  }

  function scheduleSoon() {
    if (stopped) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => scan(), debounceMs);
    debounceTimer.unref?.();
  }

  function saveAgentsSoon() {
    if (!agentsFile) return;
    clearTimeout(agentsSaveTimer);
    agentsSaveTimer = setTimeout(() => {
      agentsSaveTimer = null;
      saveAgents().catch((e) => warnOnce(`[usage] data token agen tidak bisa disimpan (${e.code ?? 'error'})`));
    }, 500);
    agentsSaveTimer.unref?.();
  }

  const saveAgents = () => (agentsFile ? writeJsonAtomic(agentsFile, { version: 1, records: agentRecords }) : Promise.resolve());

  /**
   * Catat event yang sudah tersimpan. Event dengan `tokens` (SubagentStop) menambah token agen
   * `from` dan memicu pemindaian log ~2 detik kemudian (debounce).
   */
  function recordEvents(events) {
    let any = false;
    const t = now().getTime();
    for (const e of events ?? []) {
      if (!e || !e.tokens || typeof e.from !== 'string' || !isTokens(e.tokens)) continue;
      agentRecords.push({ t, agent: agentLabel(e.from), ...pickTokens(e.tokens) });
      any = true;
    }
    if (!any) return false;
    if (agentRecords.length > MAX_AGENT_RECORDS) agentRecords.splice(0, agentRecords.length - MAX_AGENT_RECORDS);
    saveAgentsSoon();
    notifyIfChanged();
    scheduleSoon();
    return true;
  }

  return {
    snapshot,
    scan,
    scanAll,
    recordEvents,
    /** fn(snapshot) dipanggil setiap hasil berubah. Mengembalikan fungsi pelepas. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async load() {
      await loadPersisted();
    },
    start() {
      if (!stopped) return;
      stopped = false;
      scan();
      interval = setInterval(() => scan(), intervalMs);
      interval.unref?.();
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      clearTimeout(debounceTimer);
      clearTimeout(continueTimer);
      if (running) await running.catch(() => {});
      if (agentsSaveTimer) {
        clearTimeout(agentsSaveTimer);
        agentsSaveTimer = null;
        await saveAgents().catch(() => {});
      }
    },
    /** Untuk test/diagnosis: angka internal saja (tanpa path). */
    stats() {
      return { files: state.files.size, ids: state.seen.size, hours: state.hours.size, ...state.stats, dirStatus };
    },
  };
}
