// Panel tugas nyata (runner): validasi respons API, state daftar tugas, alasan runner tidak tersedia,
// dan penguraian markdown sederhana. Fungsi murni tanpa DOM supaya bisa dites di Node.
// Kontrak API: lihat server runner (GET /api/runner, /api/tasks, POST /api/tasks, /api/demo, ...).
import { stripControl, truncate } from '../shared/events.js';

export const TASK_STATUSES = ['running', 'done', 'failed', 'cancelled'];
export const TASK_KINDS = ['task', 'demo'];
export const RUNNER_REASONS = ['cli-not-found', 'disabled', 'busy'];
export const TASKS_LIMIT = 50;
export const TITLE_MAX = 120;
export const FILE_VIEW_MAX = 200_000; // karakter yang ditampilkan dari satu file

export const INSTALL_COMMAND = 'npm install -g @anthropic-ai/claude-code';
export const OPEN_COMMAND = 'npm run open';

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Id tugas yang aman dipakai di URL dan sebagai kunci (hanya huruf, angka, _ dan -). */
export const isTaskId = (v) => typeof v === 'string' && ID_RE.test(v);

const cleanTitle = (v) => {
  if (typeof v !== 'string') return null;
  const s = stripControl(v.replace(/\s+/g, ' ')).trim();
  return s ? truncate(s, TITLE_MAX) : null;
};

const toMs = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
};

const fileCount = (v) => (Array.isArray(v) ? v.length : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);

/**
 * Bagian tugas yang valid dari objek mentah (server/WebSocket). null kalau id tidak sah atau
 * status tidak dikenal. Field yang tidak valid atau tidak ada dilewati (pesan WS boleh parsial).
 */
export function normalizeTask(raw) {
  if (!isObj(raw) || !isTaskId(raw.id)) return null;
  const out = { id: raw.id };
  if (raw.status !== undefined) {
    if (!TASK_STATUSES.includes(raw.status)) return null;
    out.status = raw.status;
  }
  const title = cleanTitle(raw.title);
  if (title) out.title = title;
  if (TASK_KINDS.includes(raw.kind)) out.kind = raw.kind;
  const started = toMs(raw.startedAt);
  if (started !== null) out.startedAt = started;
  const finished = toMs(raw.finishedAt);
  if (finished !== null) out.finishedAt = finished;
  const files = fileCount(raw.files);
  if (files !== null) out.files = files;
  const summary = typeof raw.summary === 'string' ? stripControl(raw.summary).trim() : '';
  if (summary) out.summary = summary.slice(0, 4000);
  return out;
}

const FULL_DEFAULTS = { title: '', kind: 'task', status: 'running', startedAt: 0, finishedAt: null, files: 0 };

const sortTasks = (list) => [...list].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0)).slice(0, TASKS_LIMIT);

/**
 * Reducer daftar tugas. Aksi: { type: 'load', tasks: [...] } (GET /api/tasks) dan
 * { type: 'upsert', task, now } (pesan WebSocket { kind: 'task' }, boleh parsial). Tugas tidak sah diabaikan.
 */
export function tasksReducer(state, action) {
  if (action?.type === 'load') {
    if (!Array.isArray(action.tasks)) return state;
    const byId = new Map(state.map((t) => [t.id, t]));
    const loaded = action.tasks.map(normalizeTask).filter(Boolean).map((n) => ({ ...FULL_DEFAULTS, ...byId.get(n.id), ...n }));
    // Tugas yang hanya dikenal dari WebSocket (belum ada di daftar server) tetap dipertahankan.
    const ids = new Set(loaded.map((t) => t.id));
    return sortTasks([...loaded, ...state.filter((t) => !ids.has(t.id))]);
  }
  if (action?.type === 'upsert') {
    const n = normalizeTask(action.task);
    if (!n) return state;
    const prev = state.find((t) => t.id === n.id);
    const next = prev
      ? { ...prev, ...n }
      : { ...FULL_DEFAULTS, startedAt: toMs(action.now) ?? Date.now(), ...n };
    return sortTasks([next, ...state.filter((t) => t.id !== n.id)]);
  }
  return state;
}

export const isRunning = (task) => task?.status === 'running';

// ------------------------------------------------------------------ runner

/**
 * Respons GET /api/runner → { state, reason, keyRequired, active }.
 *   state 'ready'       : teks biasa bisa dikirim sebagai tugas nyata.
 *   state 'unavailable' : reason = 'cli-not-found' | 'disabled' | 'busy' | 'key'.
 *   state 'unsupported' : server lama / tanpa runner / tidak terjangkau (perilaku animasi saja).
 * `hasKey`: apakah browser punya key (sessionStorage). Tanpa key padahal server memintanya → reason 'key'.
 */
export function parseRunner(status, body, { hasKey = false } = {}) {
  const base = { state: 'unsupported', reason: null, keyRequired: false, active: null };
  if (status === 401 || status === 403) return { ...base, state: 'unavailable', reason: 'key', keyRequired: true };
  if (status !== 200 || !isObj(body) || body.ok !== true) return base;
  const keyRequired = body.keyRequired === true;
  const active = isObj(body.active) && isTaskId(body.active.id) ? { id: body.active.id, title: cleanTitle(body.active.title) ?? '', kind: body.active.kind === 'demo' ? 'demo' : 'task' } : null;
  const out = { ...base, keyRequired, active };
  if (keyRequired && !hasKey) return { ...out, state: 'unavailable', reason: 'key' };
  if (body.available === true) return { ...out, state: 'ready' };
  if (RUNNER_REASONS.includes(body.reason)) return { ...out, state: 'unavailable', reason: body.reason };
  return out;
}

/** Kode kegagalan POST /api/tasks atau /api/demo → alasan untuk UI. */
export function failureReason(status) {
  if (status === 401 || status === 403) return 'key';
  if (status === 409) return 'busy';
  if (status === 503) return 'cli-not-found';
  if (status === 400) return 'invalid';
  if (status === null || status === 404 || status === 405 || status === 501) return 'unsupported';
  return 'error';
}

/**
 * Respons POST /api/tasks atau /api/demo → { ok: true, task } | { ok: false, reason, error? }.
 * Sukses = 202 (atau 200) dengan { ok: true, task: { id } }.
 */
export function parseStartResponse(status, body) {
  if ((status === 202 || status === 200) && isObj(body) && body.ok === true) {
    const task = normalizeTask(body.task);
    if (task) return { ok: true, task: { title: '', kind: 'task', status: 'running', ...task } };
    return { ok: false, reason: 'error' };
  }
  const error = isObj(body) && typeof body.error === 'string' ? truncate(stripControl(body.error).trim(), 200) : '';
  return { ok: false, reason: failureReason(status), ...(error ? { error } : {}) };
}

/** Teks bantuan untuk alasan runner tidak tersedia: { textKey, command? } (kunci di namespace ui). */
export function reasonNotice(reason) {
  switch (reason) {
    case 'cli-not-found':
      return { textKey: 'ui.runner.cliNotFound', command: INSTALL_COMMAND };
    case 'key':
      return { textKey: 'ui.runner.key', command: OPEN_COMMAND };
    case 'busy':
      return { textKey: 'ui.runner.busy' };
    case 'disabled':
      return { textKey: 'ui.runner.disabled' };
    case 'invalid':
      return { textKey: 'ui.runner.invalid' };
    default:
      return { textKey: 'ui.runner.unsupported' };
  }
}

// ------------------------------------------------------------------ penampil hasil

/** Respons GET /api/tasks/<id> → { ok, task, files }. File tanpa path teks dibuang. */
export function parseTaskDetail(status, body) {
  if (status !== 200 || !isObj(body) || body.ok !== true || !isObj(body.task)) return { ok: false };
  const base = normalizeTask(body.task);
  if (!base) return { ok: false };
  const files = (Array.isArray(body.task.files) ? body.task.files : [])
    .filter((f) => isObj(f) && typeof f.path === 'string' && f.path && f.path.length <= 300)
    .map((f) => ({ path: f.path, bytes: typeof f.bytes === 'number' && Number.isFinite(f.bytes) && f.bytes >= 0 ? f.bytes : null }));
  return { ok: true, task: { ...FULL_DEFAULTS, ...base, files: files.length }, files };
}

/** Path URL (tanpa origin) untuk isi file tugas; setiap segmen di-encode. null kalau id tidak sah. */
export function taskFilePath(id, relpath) {
  if (!isTaskId(id) || typeof relpath !== 'string' || !relpath) return null;
  const segments = relpath.split('/').filter((s) => s !== '');
  if (!segments.length || segments.some((s) => s === '.' || s === '..')) return null;
  return `/api/tasks/${id}/files/${segments.map(encodeURIComponent).join('/')}`;
}

export const isMarkdownPath = (p) => /\.(md|markdown)$/i.test(String(p));

/** Ukuran file ringkas: kunci terjemahan + angka. */
export function bytesParts(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null;
  if (n < 1024) return { key: 'ui.viewer.bytes', n: String(Math.round(n)) };
  return { key: 'ui.viewer.kilobytes', n: String(Math.round((n / 1024) * 10) / 10) };
}

// ------------------------------------------------------------------ markdown sederhana

/** Bagi teks menjadi potongan { text, bold } (+ code: true untuk `kode`). Selalu teks biasa, tidak pernah HTML. */
export function inlineParts(text) {
  const parts = [];
  const re = /`([^`\n]+)`|\*\*([^*\n]+?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), bold: false });
    if (m[1] !== undefined) parts.push({ text: m[1], bold: false, code: true });
    else parts.push({ text: m[2], bold: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), bold: false });
  return parts.length ? parts : [{ text: '', bold: false }];
}

const FILE_TAIL = ['task.md', 'CLAUDE.md', 'run.log'];

/** Urutan tombol file: RESULT.md, file hasil lain (alfabetis), lalu task.md, CLAUDE.md, run.log. */
export function sortTaskFiles(files) {
  const rank = (f) => {
    if (f.path === 'RESULT.md') return 0;
    const i = FILE_TAIL.indexOf(f.path);
    return i < 0 ? 1 : 2 + i;
  };
  return [...files].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Pisahkan baris tabel GFM menjadi sel; `\|` tetap menjadi karakter | di dalam sel. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells = [];
  let cur = '';
  let closed = false; // baris berakhir tepat setelah pipa pembatas
  for (let i = 0; i < s.length; i++) {
    closed = false;
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
      closed = true;
    } else cur += s[i];
  }
  if (!closed) cells.push(cur.trim());
  return cells;
}

const isDelimiterRow = (cells) => cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));

/**
 * Markdown sederhana → blok data: { type: 'h', level, parts } | { type: 'ul' | 'ol', items: parts[], start? } |
 * { type: 'code', text } | { type: 'table', head, align, rows } | { type: 'p', parts }.
 * Judul (#), daftar (-, *, 1.) dengan baris lanjutan beridentasi, kode berpagar, tabel GFM, `kode`, dan **tebal**.
 * Hasilnya data murni; komponen React membuat elemen dari teks, jadi tidak ada HTML yang pernah dirakit.
 */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let para = [];
  let list = null; // { type, start?, raw: string[] }
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'p', parts: inlineParts(para.join(' ')) });
    para = [];
  };
  const flushList = () => {
    if (list) {
      const { raw, ...rest } = list;
      blocks.push({ ...rest, items: raw.map(inlineParts) });
    }
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      const code = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-')) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]);
      if (head.length > 0 && head.length === delim.length && isDelimiterRow(delim)) {
        flushPara();
        flushList();
        const align = delim.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : null));
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
          const cells = splitRow(lines[i]);
          rows.push(head.map((_, k) => inlineParts(cells[k] ?? '')));
          i++;
        }
        i--;
        blocks.push({ type: 'table', head: head.map(inlineParts), align, rows });
        continue;
      }
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({ type: 'h', level: heading[1].length, parts: inlineParts(heading[2].trim()) });
    } else if (bullet || numbered) {
      flushPara();
      const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      list ??= type === 'ol' ? { type, start: Number(numbered[1]), raw: [] } : { type, raw: [] };
      list.raw.push((bullet ? bullet[1] : numbered[2]).trim());
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else if (list && /^\s/.test(line)) {
      list.raw[list.raw.length - 1] += ` ${line.trim()}`;
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks;
}
