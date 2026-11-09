// Nama proyek sesi (field opsional `project` di event) dan daftar "Sesi aktif".
// Fungsi murni tanpa DOM supaya bisa dites di Node.
import { stripControl, truncate } from '../shared/events.js';

export const PROJECT_MAX = 40;
export const ACTIVE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Nama proyek yang aman ditampilkan, atau null kalau event tidak membawa `project`.
 * Defensif: hanya teks, karakter kontrol/bidi dibuang, spasi dirapikan, dipotong ke PROJECT_MAX.
 */
export function projectOf(event) {
  const raw = event && typeof event === 'object' ? event.project : undefined;
  if (typeof raw !== 'string') return null;
  const clean = stripControl(raw.replace(/\s+/g, ' ')).replace(/ {2,}/g, ' ').trim();
  return clean ? truncate(clean, PROJECT_MAX) : null;
}

/** Waktu event dalam ms (dibatasi ≤ now supaya jam yang maju tidak membuat sesi "abadi"). */
function eventTimeMs(event, now) {
  const t = Date.parse(event?.time);
  return Number.isFinite(t) ? Math.min(t, now) : now;
}

/**
 * Catat event ke peta sesi (dimutasi). Kunci dipisah antara data asli dan simulasi supaya sesi
 * simulasi bisa dibuang tanpa menyentuh sesi asli. Mengembalikan true kalau peta berubah.
 */
export function trackSession(sessions, event, now = Date.now()) {
  const project = projectOf(event);
  if (!project) return false;
  const sim = event.source === 'sim';
  const key = `${sim ? 'sim' : 'real'}:${project}`;
  const at = eventTimeMs(event, now);
  const prev = sessions.get(key);
  sessions.set(key, {
    project,
    sim,
    lastAt: prev ? Math.max(prev.lastAt, at) : at,
    count: (prev?.count ?? 0) + 1,
    lastAgent: typeof event.from === 'string' ? event.from : prev?.lastAgent ?? null,
  });
  return true;
}

/** Sesi dengan event dalam `windowMs` terakhir, terbaru di atas. */
export function activeSessions(sessions, now = Date.now(), windowMs = ACTIVE_WINDOW_MS) {
  return [...sessions.values()]
    .filter((s) => now - s.lastAt <= windowMs)
    .sort((a, b) => b.lastAt - a.lastAt || a.project.localeCompare(b.project));
}

/** Buang semua sesi simulasi (dipanggil saat simulasi selesai / dihentikan / reset). */
export function dropSimSessions(sessions) {
  let changed = false;
  for (const [key, s] of sessions) {
    if (s.sim) {
      sessions.delete(key);
      changed = true;
    }
  }
  return changed;
}

/** "baru saja", "3 mnt lalu". */
export function ago(ms, now = Date.now()) {
  const min = Math.floor(Math.max(0, now - ms) / 60000);
  return min < 1 ? 'baru saja' : `${min} mnt lalu`;
}
