// Folder hasil tugas: output/<YYYYMMDD-HHMMSS>-<slug>/ di root proyek. Satu folder = satu tugas; id tugas =
// nama folder (cocok dengan ^[a-z0-9][a-z0-9-]{0,63}$). Status disimpan di .ai-office-task.json di dalam folder
// (file ini tidak muncul di daftar file dan tidak bisa dibaca lewat API).
//
// Pembacaan file lewat API dikurung: id harus cocok regex, tiap segmen path divalidasi (tanpa "..", ".", kosong,
// "\", ":", NUL), path akhir harus sama persis dengan realpath-nya (artinya tidak ada symlink di rantai path),
// harus file biasa, maksimal 1 MB, dan harus teks (tanpa byte NUL di awal).
import { lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { TASK_ID_RE } from '../shared/events.js';

export const META_FILE = '.ai-office-task.json';
export const MAX_FILE_BYTES = 1024 * 1024;
export const MAX_LIST = 50;
const MAX_FILES_PER_TASK = 200;
const MAX_DEPTH = 6;
const pad = (n) => String(n).padStart(2, '0');

export const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Slug ASCII aman dari judul: huruf kecil, angka, "-"; maks `max` karakter; tidak pernah kosong. */
export function slugify(title, max = 40) {
  const s = String(title ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, max)
    .replace(/-+$/, '');
  return s || 'task';
}

export class StoreError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Segmen path relatif yang aman, atau null. `rel` sudah didekode persen. */
export function safeSegments(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.length > 400) return null;
  if (/[\x00-\x1f\x7f\\:]/.test(rel) || rel.startsWith('/')) return null;
  const parts = rel.split('/');
  if (parts.length > MAX_DEPTH + 1) return null;
  for (const p of parts) {
    if (p === '' || p === '.' || p === '..' || p.length > 200) return null;
    if (/[. ]$/.test(p)) return null; // Windows membuang titik/spasi di akhir nama
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)) return null; // perangkat DOS
  }
  return parts;
}

export function createOutputStore({ dir }) {
  const root = resolve(dir);

  async function ensureRoot() {
    await mkdir(root, { recursive: true });
  }

  /** Buat folder tugas baru. Mengembalikan { id, dir }. */
  async function createTaskDir({ slug, now = new Date() }) {
    await ensureRoot();
    const base = `${stamp(now)}-${slug}`.slice(0, 60).replace(/-+$/, '');
    for (let i = 1; i < 100; i++) {
      const id = i === 1 ? base : `${base}-${i}`;
      try {
        await mkdir(join(root, id));
        return { id, dir: join(root, id) };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new Error('cannot allocate a task folder');
  }

  const dirOf = (id) => join(root, id);

  // Windows: rename gagal sementara (EPERM/EBUSY/EACCES) bila file tujuan sedang dibaca (mis. GET daftar tugas
  // pada saat yang sama). Dicoba ulang beberapa kali; bila tetap gagal, tulis langsung (jangan sampai status
  // "running" tertinggal di disk dan tugas yang selesai terbaca sebagai gagal).
  async function writeMeta(id, meta) {
    const file = join(dirOf(id), META_FILE);
    const tmp = `${file}.tmp`;
    const text = `${JSON.stringify(meta, null, 2)}\n`;
    await writeFile(tmp, text);
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await rename(tmp, file);
        return;
      } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
      }
    }
    await writeFile(file, text);
    await unlink(tmp).catch(() => {});
  }

  async function readMeta(id) {
    try {
      const m = JSON.parse(await readFile(join(dirOf(id), META_FILE), 'utf8'));
      return m && typeof m === 'object' ? m : null;
    } catch {
      return null;
    }
  }

  /** Daftar file biasa di folder tugas (tanpa symlink, tanpa META_FILE), urut nama. */
  async function listFiles(id) {
    const base = dirOf(id);
    const out = [];
    async function walk(rel, depth) {
      if (out.length >= MAX_FILES_PER_TASK || depth > MAX_DEPTH) return;
      let entries;
      try {
        entries = await readdir(join(base, ...rel), { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        if (out.length >= MAX_FILES_PER_TASK) return;
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          await walk([...rel, e.name], depth + 1);
        } else if (e.isFile()) {
          if (rel.length === 0 && (e.name === META_FILE || e.name === `${META_FILE}.tmp`)) continue;
          if (!safeSegments([...rel, e.name].join('/'))) continue; // daftar harus sepakat dengan pembaca
          const st = await lstat(join(base, ...rel, e.name)).catch(() => null);
          if (st?.isFile()) out.push({ path: [...rel, e.name].join('/'), bytes: st.size });
        }
      }
    }
    await walk([], 0);
    return out;
  }

  /** Folder tugas yang valid (bukan symlink), atau null. */
  async function existingDir(id) {
    if (typeof id !== 'string' || !TASK_ID_RE.test(id)) return null;
    const st = await lstat(dirOf(id)).catch(() => null);
    return st?.isDirectory() ? dirOf(id) : null;
  }

  /** Ringkasan satu tugas dari meta + isi folder. `activeId`: id tugas yang masih berjalan di proses ini. */
  async function describe(id, activeId, { withFiles = false } = {}) {
    if (!(await existingDir(id))) return null;
    const meta = await readMeta(id);
    if (!meta) return null; // folder bukan buatan AI Office
    const files = await listFiles(id);
    let status = typeof meta.status === 'string' ? meta.status : 'failed';
    if (status === 'running' && id !== activeId) status = 'failed'; // server berhenti saat tugas berjalan
    const task = {
      id,
      title: String(meta.title ?? id),
      status,
      kind: meta.kind === 'demo' ? 'demo' : 'task',
      startedAt: meta.startedAt ?? null,
      finishedAt: status === 'running' ? null : (meta.finishedAt ?? null),
      files: withFiles ? files : files.length,
    };
    if (withFiles) task.summary = typeof meta.summary === 'string' ? meta.summary : '';
    return task;
  }

  async function list(activeId) {
    let names;
    try {
      names = await readdir(root);
    } catch {
      return [];
    }
    const ids = names.filter((n) => TASK_ID_RE.test(n)).sort().reverse().slice(0, MAX_LIST * 2);
    const tasks = [];
    for (const id of ids) {
      const t = await describe(id, activeId);
      if (t) tasks.push(t);
    }
    // Id diawali stempel waktu, jadi urutan nama terbalik = terbaru dulu.
    return tasks.slice(0, MAX_LIST);
  }

  /** Isi file teks. Melempar StoreError(status, kode) bila ditolak. */
  async function readTaskFile(id, rel) {
    const taskDir = await existingDir(id);
    if (!taskDir) throw new StoreError(404, 'not-found');
    const segments = safeSegments(rel);
    if (!segments) throw new StoreError(400, 'bad-path');
    if (segments.length === 1 && segments[0] === META_FILE) throw new StoreError(404, 'not-found');
    let realBase;
    let real;
    const target = join(taskDir, ...segments);
    try {
      realBase = await realpath(taskDir);
      real = await realpath(target);
    } catch {
      throw new StoreError(404, 'not-found');
    }
    // Tidak ada symlink di rantai path: path akhir harus persis realBase + segmen yang diminta.
    if (real !== join(realBase, ...segments) || !real.startsWith(realBase + sep)) throw new StoreError(404, 'not-found');
    const st = await lstat(target).catch(() => null);
    if (!st || st.isSymbolicLink() || !st.isFile()) throw new StoreError(404, 'not-found');
    if (st.size > MAX_FILE_BYTES) throw new StoreError(413, 'too-large');
    let handle;
    try {
      handle = await open(target, 'r');
      const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      const data = buf.subarray(0, bytesRead);
      if (data.subarray(0, 8192).includes(0)) throw new StoreError(415, 'not-text');
      return data.toString('utf8');
    } catch (e) {
      if (e instanceof StoreError) throw e;
      throw new StoreError(404, 'not-found');
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  return { root, ensureRoot, createTaskDir, dirOf, writeMeta, readMeta, listFiles, describe, list, readTaskFile };
}
