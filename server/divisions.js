// Penemuan divisi plugin: memindai <root>/<id>/division.json dan <root>/<id>/agents/<worker>.md.
//
// Keamanan: paket hanya dibaca sebagai TEKS. Hanya JSON.parse dan validator di shared/divisions.js yang
// menyentuh isinya; tidak ada import(), require, eval, atau eksekusi apa pun dari paket. Folder yang
// symlink/junction ditolak, file di dalam divisi harus punya realpath di dalam folder divisi itu, ukuran
// dibatasi, dan nama folder harus sama dengan id. Divisi tidak valid dilewati (server tetap jalan).
import {
  closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n.js';
import { safeText, validateDivision } from '../shared/divisions.js';
import { riskyTools, validateAgent } from '../scripts/agent-files.mjs';

export const ROOT_DIR = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_DIVISIONS_DIR = join(ROOT_DIR, 'divisions');
export const PACKS_DIR = join(ROOT_DIR, 'division-packs');

export const DISCOVERY_LIMITS = Object.freeze({
  maxDivisions: 12,
  manifestBytes: 16 * 1024,
  agentBytes: 64 * 1024,
  maxFolders: 100, // folder yang diperiksa; sisanya dicatat sebagai satu galat
});

/** Folder divisi: env AI_OFFICE_DIVISIONS_DIR (untuk test) atau <repo>/divisions. */
export function divisionsDirFromEnv(env = process.env) {
  const v = typeof env.AI_OFFICE_DIVISIONS_DIR === 'string' ? env.AI_OFFICE_DIVISIONS_DIR.trim() : '';
  return v ? resolve(v) : DEFAULT_DIVISIONS_DIR;
}

const fail = (dir, key, params = {}) => ({ dir: safeText(dir, 64), key, params });

/** Apakah `child` berada di dalam `base` (keduanya sudah realpath)? Perbandingan huruf besar/kecil mengikuti OS. */
function isInside(base, child) {
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const a = ci ? base.toLowerCase() : base;
  const b = ci ? child.toLowerCase() : child;
  const rel = relative(a, b);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Baca file teks reguler maksimal `max` byte. Hasil: { text } atau { error: 'missing' | 'outside' | 'notFile' | 'tooLarge' | 'unreadable' }.
 * `realBase` = realpath folder yang wajib memuat file ini (setelah symlink diselesaikan).
 */
function readLimited(path, realBase, max) {
  let real;
  try {
    real = realpathSync(path);
  } catch (e) {
    return { error: e.code === 'ENOENT' || e.code === 'ENOTDIR' ? 'missing' : 'unreadable' };
  }
  if (!isInside(realBase, real)) return { error: 'outside' };
  let fd;
  try {
    // lstat pada realpath: FIFO/perangkat tidak boleh dibuka (open() bisa menggantung).
    if (!lstatSync(real).isFile()) return { error: 'notFile' };
    fd = openSync(real, 'r');
    if (!fstatSync(fd).isFile()) return { error: 'notFile' };
    const buf = Buffer.alloc(max + 1);
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
    }
    if (n > max) return { error: 'tooLarge' };
    return { text: buf.subarray(0, n).toString('utf8').replace(/^﻿/, '') };
  } catch {
    return { error: 'unreadable' };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Salin error validator ke bentuk error penemuan ({ dir, key, params }). */
const fromValidator = (dir, errors) => errors.map((e) => fail(dir, e.key, e.params));

/**
 * Pindai satu folder divisi. Mengembalikan { division } atau { errors }.
 * `taken` = Map nama worker → id divisi yang sudah memakainya (diisi oleh pemanggil bila valid).
 */
function loadDivision(rootReal, name, taken) {
  const L = DISCOVERY_LIMITS;
  const folder = join(rootReal, name);
  let st;
  try {
    st = lstatSync(folder);
  } catch {
    return { errors: [fail(name, 'divisions.err.unreadable')] };
  }
  if (st.isSymbolicLink()) return { errors: [fail(name, 'divisions.err.folderSymlink')] };
  if (!st.isDirectory()) return { skip: true };
  let divReal;
  try {
    divReal = realpathSync(folder);
  } catch {
    return { errors: [fail(name, 'divisions.err.unreadable')] };
  }
  if (!isInside(rootReal, divReal)) return { errors: [fail(name, 'divisions.err.folderSymlink')] };

  const manifest = readLimited(join(folder, 'division.json'), divReal, L.manifestBytes);
  if (manifest.error) {
    const key = {
      missing: 'divisions.err.manifestMissing',
      outside: 'divisions.err.fileOutside',
      tooLarge: 'divisions.err.jsonTooLarge',
    }[manifest.error] ?? 'divisions.err.unreadable';
    return { errors: [fail(name, key, { file: 'division.json', max: Math.round(L.manifestBytes / 1024) })] };
  }
  let parsed;
  try {
    parsed = JSON.parse(manifest.text);
  } catch {
    return { errors: [fail(name, 'divisions.err.jsonInvalid')] };
  }
  const v = validateDivision(parsed);
  if (!v.ok) return { errors: fromValidator(name, v.errors) };
  const value = v.value;
  if (value.id !== name) return { errors: [fail(name, 'divisions.err.folderMismatch', { id: value.id })] };

  const problems = [];
  const agentFiles = [];
  const agentsDir = join(folder, 'agents');
  for (const worker of value.workers) {
    const owner = taken.get(worker);
    if (owner) {
      problems.push(fail(name, 'divisions.err.workerTaken', { worker, other: owner }));
      continue;
    }
    const fileName = `${worker}.md`;
    const r = readLimited(join(agentsDir, fileName), divReal, L.agentBytes);
    if (r.error) {
      const key = {
        missing: 'divisions.err.agentMissing',
        outside: 'divisions.err.fileOutside',
        tooLarge: 'divisions.err.agentTooLarge',
      }[r.error] ?? 'divisions.err.unreadable';
      problems.push(fail(name, key, { worker, file: fileName, max: Math.round(L.agentBytes / 1024) }));
      continue;
    }
    const { errors, data } = validateAgent(fileName, r.text);
    if (errors.length) {
      problems.push(fail(name, 'divisions.err.agentInvalid', { worker, detail: safeText(errors[0], 160) }));
      continue;
    }
    if (data.name !== worker) {
      problems.push(fail(name, 'divisions.err.agentName', { worker }));
      continue;
    }
    agentFiles.push({ worker, fileName, path: join(agentsDir, fileName), text: r.text });
  }
  if (problems.length) return { errors: problems };
  return { division: { ...value, source: 'plugin', agentFiles }, warnings: v.warnings ? fromValidator(name, v.warnings) : [] };
}

/**
 * Temukan semua divisi plugin di `dir`.
 * Hasil: { divisions: [{ id, name, color, desks, workers, description?, personalities?, source: 'plugin', agentFiles }], errors: [{ dir, key, params }] }
 * `agentFiles` ([{ worker, fileName, path, text }]) hanya untuk skrip lokal; jangan dikirim lewat API.
 */
export function discoverDivisions({ dir = divisionsDirFromEnv(), log = () => {} } = {}) {
  const L = DISCOVERY_LIMITS;
  const divisions = [];
  const errors = [];
  const note = (list) => {
    for (const e of list) {
      errors.push(e);
      log(`[divisions] ${e.dir}: ${t(e.key, e.params)}`);
    }
  };

  let rootReal;
  let names;
  let overflow = false;
  try {
    rootReal = realpathSync(resolve(dir));
    names = readdirSync(rootReal)
      .filter((n) => !n.startsWith('.'))
      .sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    // Potong ke batas SEBELUM diproses: folder berlebih tidak pernah di-lstat atau dibaca.
    overflow = names.length > L.maxFolders;
    names = names.slice(0, L.maxFolders);
  } catch (e) {
    if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') note([fail('.', 'divisions.err.rootUnreadable')]);
    return { divisions, errors };
  }

  const taken = new Map();
  for (const name of names) {
    if (divisions.length >= L.maxDivisions) {
      // Batas divisi valid tercapai: berhenti membaca isi folder; cukup tandai folder yang dilewati.
      let isDir = false;
      try {
        isDir = !lstatSync(join(rootReal, name)).isFile();
      } catch {
        // tidak terbaca: abaikan
      }
      if (isDir) note([fail(name, 'divisions.err.tooMany', { max: L.maxDivisions })]);
      continue;
    }
    const r = loadDivision(rootReal, name, taken);
    if (r.skip) continue; // file biasa (README.md, .gitkeep)
    if (r.errors) {
      note(r.errors);
      continue;
    }
    for (const w of r.division.workers) taken.set(w, r.division.id);
    divisions.push(r.division);
    if (r.warnings?.length) note(r.warnings); // kepribadian yang diabaikan: divisi tetap dimuat
  }
  if (overflow) note([fail('.', 'divisions.err.tooManyFolders', { max: L.maxFolders })]);
  return { divisions, errors };
}

/** Semua file agen worker dari hasil penemuan: [{ division, worker, fileName, path, text }]. */
export function pluginAgentFiles(result) {
  return result.divisions.flatMap((d) => d.agentFiles.map((f) => ({ division: d.id, ...f })));
}

/** Agen plugin dengan tool berisiko: [{ division, worker, risky: [tool, ...] }] (lihat riskyTools di agent-files.mjs). */
export function riskyPluginAgents(result) {
  return pluginAgentFiles(result).flatMap((f) => {
    const risky = riskyTools(validateAgent(f.fileName, f.text).data?.tools);
    return risky.length ? [{ division: f.division, worker: f.worker, risky }] : [];
  });
}

/** Bentuk publik (tanpa path dan teks agen) untuk GET /api/divisions. */
export function publicDivisions(result, tr = t) {
  return {
    divisions: result.divisions.map((d) => ({
      id: d.id, name: { en: d.name.en, id: d.name.id }, color: d.color, desks: d.desks, workers: [...d.workers], source: 'plugin',
      ...(d.personalities ? { personalities: structuredClone(d.personalities) } : {}), // data tampilan saja
    })),
    errors: result.errors.map((e) => ({ dir: e.dir, message: tr(e.key, e.params) })),
  };
}
