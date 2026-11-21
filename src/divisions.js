// Roster dinamis di browser: divisi bawaan (shared/roster.js) + divisi plugin dari GET /api/divisions.
// State kecil dengan subscribe. Setiap entri dari server DIVALIDASI ULANG di sini (server bisa lama, rusak,
// atau dimanipulasi); yang tidak valid dibuang. String dari server hanya boleh dirender sebagai teks (React meng-escape).
import { validateDivision } from '../shared/divisions.js';
import { DIVISIONS, OTHER_DIVISION } from '../shared/roster.js';

export const MAX_PLUGIN_DIVISIONS = 12;
const MAX_ERRORS = 20;
const MAX_ERR_TEXT = 200;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Bentuk divisi untuk UI dari hasil validateDivision (validator tunggal: shared/divisions.js). */
function toDivision(v) {
  return { id: v.id, name: v.name.en, names: { en: v.name.en, id: v.name.id }, color: v.color, desks: v.desks, agents: v.workers, source: 'plugin' };
}

/** Validasi satu entri (hanya lewat validateDivision server) → { ok, division } | { ok: false, reason }. */
export function validateDivisionEntry(raw) {
  // Server menambahkan `source: "plugin"` (bukan bagian skema division.json): dibuang sebelum validasi.
  let entry = raw;
  if (isObj(raw) && Object.hasOwn(raw, 'source')) {
    entry = { ...raw };
    delete entry.source;
  }
  const r = validateDivision(entry);
  return r.ok ? { ok: true, division: toDivision(r.value) } : { ok: false, reason: r.errors[0]?.key ?? 'invalid' };
}

/**
 * Body GET /api/divisions → { divisions, errors }, atau null bila bentuk body salah. errors = [{ dir, message, key? }]
 * (teks biasa, dibatasi). Validasi entri HANYA lewat validateDivision (sama dengan server). Penyesuaian khusus klien,
 * sesudah validasi: batas 12 divisi, dan id/worker yang bentrok dengan entri sebelumnya (agar zona dan meja tidak ganda).
 */
export function parseDivisions(body) {
  if (!isObj(body) || body.ok !== true || !Array.isArray(body.divisions)) return null;
  const out = { divisions: [], errors: [] };
  const ids = new Set();
  const workers = new Set();
  const fail = (dir, key, message = '') => {
    if (out.errors.length < MAX_ERRORS) out.errors.push({ dir, key, message });
  };
  body.divisions.forEach((raw, i) => {
    const label = isObj(raw) && typeof raw.id === 'string' && /^[a-z0-9-]{1,32}$/.test(raw.id) ? raw.id : `#${i}`;
    const r = validateDivisionEntry(raw);
    if (!r.ok) return fail(label, 'ui.divisions.invalidEntry', r.reason);
    if (out.divisions.length >= MAX_PLUGIN_DIVISIONS) return fail(label, 'ui.divisions.tooMany');
    const v = r.division;
    if (ids.has(v.id) || v.agents.some((w) => workers.has(w))) return fail(label, 'ui.divisions.invalidEntry', 'duplicate');
    ids.add(v.id);
    v.agents.forEach((w) => workers.add(w));
    out.divisions.push(v);
  });
  if (Array.isArray(body.errors)) {
    for (const e of body.errors) {
      if (out.errors.length >= MAX_ERRORS) break;
      if (!isObj(e)) continue;
      out.errors.push({
        dir: typeof e.dir === 'string' ? e.dir.slice(0, MAX_ERR_TEXT) : '',
        message: typeof e.message === 'string' ? e.message.slice(0, MAX_ERR_TEXT) : '',
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------ state + subscribe

const EMPTY = Object.freeze({ plugin: Object.freeze([]), errors: Object.freeze([]), version: 0 });
let state = EMPTY;
const listeners = new Set();

export const getState = () => state;
export const getPluginDivisions = () => state.plugin;

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function commit(plugin, errors) {
  if (JSON.stringify([plugin, errors]) === JSON.stringify([state.plugin, state.errors])) return false;
  state = { plugin, errors, version: state.version + 1 };
  for (const fn of [...listeners]) {
    try {
      fn(state);
    } catch {
      // satu pendengar rusak tidak boleh menghentikan yang lain
    }
  }
  return true;
}

/** Terapkan body respons server (divalidasi ulang). Body tak berbentuk benar diabaikan (state lama tetap). */
export function applyDivisionsResponse(status, body) {
  if (status !== 200) return false;
  const parsed = parseDivisions(body);
  if (!parsed) return false;
  return commit(parsed.divisions, parsed.errors);
}

/** Kembali ke roster bawaan saja (untuk test dan reset). */
export function resetDivisions() {
  return commit([], []);
}

// ------------------------------------------------------------------ roster gabungan

export const allDivisions = () => [...DIVISIONS, ...state.plugin];
export const agentNames = () => allDivisions().flatMap((d) => d.agents);

export function divisionOf(name) {
  const n = String(name);
  return allDivisions().find((d) => d.agents.includes(n)) ?? OTHER_DIVISION;
}

export { OTHER_DIVISION };
