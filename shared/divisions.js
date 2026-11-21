// Skema dan validator divisi buatan pengguna (plugin berupa data, bukan kode).
// Murni: tanpa I/O dan tanpa import Node, supaya bisa dipakai di server, skrip, dan browser.
//
// Format divisions/<id>/division.json:
//   { "id": "legal", "name": { "en": "Legal", "id": "Hukum" }, "color": "#8a5a44", "desks": 3,
//     "workers": ["legal-reviewer", "legal-drafter"], "description": "opsional" }
//
// validateDivision(obj) → { ok, value, errors }. Setiap error = { key, params }: `key` adalah kunci
// namespace "cli" di locales/*.json (dipetakan ke teks lewat t(key, params)); `params` hanya berisi
// teks yang sudah dibersihkan (tanpa karakter kontrol/bidi, dipotong pendek).
import { AGENT_NAMES, CEO_ID, DIVISIONS, MANAGER_ID, OTHER_DIVISION } from './roster.js';

export const DIVISION_LIMITS = Object.freeze({
  idMin: 2,
  idMax: 32,
  nameMax: 40,
  descriptionMax: 200,
  desksMin: 1,
  desksMax: 8,
  workersMin: 1,
  workersMax: 8,
  workerNameMax: 64,
});

export const DIVISION_ID_RE = /^[a-z][a-z0-9-]{1,31}$/;
export const WORKER_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const DIVISION_FIELDS = Object.freeze(['id', 'name', 'color', 'desks', 'workers', 'description']);

/** id yang tidak boleh dipakai divisi plugin. */
export const RESERVED_DIVISION_IDS = Object.freeze([...DIVISIONS.map((d) => d.id), OTHER_DIVISION.id, MANAGER_ID, CEO_ID]);
/** Nama worker yang tidak boleh dipakai: agen bawaan dan nama khusus event. */
export const RESERVED_WORKER_NAMES = Object.freeze([...AGENT_NAMES, OTHER_DIVISION.id, MANAGER_ID, CEO_ID]);

// Karakter kontrol (Cc), format/bidi/zero-width (Cf), pemisah baris/paragraf, dan penanda bidi eksplisit.
const BAD_CHARS_RE = /[\p{Cc}\p{Cf}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const BAD_CHARS_GLOBAL_RE = /[\p{Cc}\p{Cf}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

// Nama perangkat Windows: file/folder dengan nama ini (juga "con.md") membuka perangkat, bukan file.
export const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
export const isWindowsDeviceName = (s) => typeof s === 'string' && WINDOWS_DEVICE_RE.test(s);

export const hasBadChars = (s) => BAD_CHARS_RE.test(s);

/** Teks aman untuk dimasukkan ke pesan/log: karakter berbahaya dibuang, dipotong `max` karakter. */
export function safeText(value, max = 40) {
  const s = String(value ?? '').replace(BAD_CHARS_GLOBAL_RE, '').replace(/\s+/g, ' ').trim();
  const chars = [...s];
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : s;
}

const err = (key, params = {}) => ({ key, params });
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const charLength = (s) => [...s].length;

/** Cek id divisi saja (dipakai juga oleh `npm run division:add`). Mengembalikan error atau null. */
export function checkDivisionId(id) {
  if (typeof id !== 'string') return err('divisions.err.idInvalid');
  if (RESERVED_DIVISION_IDS.includes(id) || isWindowsDeviceName(id)) return err('divisions.err.idReserved', { id: safeText(id) });
  if (!DIVISION_ID_RE.test(id)) return err('divisions.err.idInvalid');
  return null;
}

function checkName(raw) {
  const L = DIVISION_LIMITS;
  let en;
  let id;
  if (typeof raw === 'string') {
    en = raw;
    id = raw;
  } else if (isPlainObject(raw)) {
    for (const k of Object.keys(raw)) if (k !== 'en' && k !== 'id') return { error: err('divisions.err.nameField', { field: safeText(k) }) };
    if (typeof raw.en !== 'string') return { error: err('divisions.err.nameInvalid') };
    if (raw.id !== undefined && typeof raw.id !== 'string') return { error: err('divisions.err.nameInvalid') };
    en = raw.en;
    id = raw.id ?? raw.en;
  } else {
    return { error: err('divisions.err.nameInvalid') };
  }
  const out = {};
  for (const [lang, text] of [['en', en], ['id', id]]) {
    if (hasBadChars(text)) return { error: err('divisions.err.nameChars') };
    const v = text.trim();
    if (!v || charLength(v) > L.nameMax) return { error: err('divisions.err.nameLength', { max: L.nameMax }) };
    out[lang] = v;
  }
  return { value: out };
}

/**
 * Validasi isi division.json (sudah di-JSON.parse). Tidak pernah melempar.
 * `value` hanya terisi bila ok; berisi salinan bersih { id, name: {en, id}, color, desks, workers, description? }.
 */
export function validateDivision(obj) {
  const L = DIVISION_LIMITS;
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, value: null, errors: [err('divisions.err.notObject')] };

  for (const k of Object.keys(obj)) {
    if (!DIVISION_FIELDS.includes(k)) errors.push(err('divisions.err.unknownField', { field: safeText(k) }));
  }
  const has = (k) => Object.hasOwn(obj, k);

  // id
  let id = null;
  if (!has('id')) errors.push(err('divisions.err.idInvalid'));
  else {
    const e = checkDivisionId(obj.id);
    if (e) errors.push(e);
    else id = obj.id;
  }

  // name
  let name = null;
  if (!has('name')) errors.push(err('divisions.err.nameInvalid'));
  else {
    const r = checkName(obj.name);
    if (r.error) errors.push(r.error);
    else name = r.value;
  }

  // color
  let color = null;
  if (!has('color') || typeof obj.color !== 'string' || !COLOR_RE.test(obj.color)) errors.push(err('divisions.err.colorInvalid'));
  else color = obj.color.toLowerCase();

  // workers
  let workers = null;
  if (!has('workers') || !Array.isArray(obj.workers) || obj.workers.length < L.workersMin || obj.workers.length > L.workersMax) {
    errors.push(err('divisions.err.workersInvalid', { min: L.workersMin, max: L.workersMax }));
  } else {
    let okWorkers = true;
    const seen = new Set();
    for (const w of obj.workers) {
      if (typeof w !== 'string' || w.length > L.workerNameMax || !WORKER_NAME_RE.test(w)) {
        errors.push(err('divisions.err.workerName', { worker: safeText(w) }));
        okWorkers = false;
      } else if (seen.has(w)) {
        errors.push(err('divisions.err.workerDuplicate', { worker: w }));
        okWorkers = false;
      } else if (RESERVED_WORKER_NAMES.includes(w) || isWindowsDeviceName(w)) {
        errors.push(err('divisions.err.workerReserved', { worker: w }));
        okWorkers = false;
      } else seen.add(w);
    }
    if (okWorkers) workers = [...obj.workers];
  }

  // desks
  let desks = null;
  if (!has('desks') || !Number.isInteger(obj.desks) || obj.desks < L.desksMin || obj.desks > L.desksMax) {
    errors.push(err('divisions.err.desksInvalid', { min: L.desksMin, max: L.desksMax }));
  } else if (Array.isArray(obj.workers) && obj.workers.length <= L.workersMax && obj.desks < obj.workers.length) {
    errors.push(err('divisions.err.desksTooFew', { desks: obj.desks, workers: obj.workers.length }));
  } else desks = obj.desks;

  // description (opsional)
  let description;
  if (has('description')) {
    const d = obj.description;
    if (typeof d !== 'string' || charLength(d) > L.descriptionMax || hasBadChars(d)) {
      errors.push(err('divisions.err.descriptionInvalid', { max: L.descriptionMax }));
    } else description = d;
  }

  if (errors.length) return { ok: false, value: null, errors };
  const value = { id, name, color, desks, workers };
  if (description !== undefined) value.description = description;
  return { ok: true, value, errors: [] };
}
