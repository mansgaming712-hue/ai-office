// Koneksi browser ↔ server: WebSocket untuk menerima event, HTTP POST untuk mengirim.
import { loginResult, logoutResult, parseSession } from './auth.js';
import { isTaskId, parseRunner, parseStartResponse, parseTaskDetail, taskFilePath } from './tasks.js';

/**
 * `onClosedBeforeHello` (opsional): dipanggil saat WebSocket tertutup sebelum pesan hello
 * (mis. upgrade ditolak karena sesi tidak sah). Kembalikan `false` (atau Promise false)
 * untuk menghentikan reconnect; nilai lain → reconnect seperti biasa.
 */
/**
 * `onUsage` (opsional): dipanggil dengan objek `usage` mentah dari pesan { kind: "usage", usage }.
 * Validasi dilakukan pemanggil (src/usage.js). Tanpa callback ini, pesan usage diabaikan.
 */
/**
 * `onTask` (opsional): dipanggil dengan objek `task` mentah dari pesan { kind: "task", task }.
 * Validasi dilakukan pemanggil (src/tasks.js). Pesan dengan kind tak dikenal diabaikan.
 */
export function connect({ onEvent, onHistory, onStatus, onClosedBeforeHello, onUsage, onTask }) {
  let ws = null;
  let retry = 0;
  let timer = null;
  let closed = false;
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;

  const scheduleReconnect = () => {
    timer = setTimeout(open, Math.min(10000, 500 * 2 ** retry++));
  };

  function open() {
    let gotHello = false;
    onStatus('connecting');
    ws = new WebSocket(url);
    ws.onopen = () => {
      retry = 0;
      onStatus('online');
    };
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return;
      }
      if (!data || typeof data !== 'object') return;
      if (data.kind === 'hello') gotHello = true;
      if (data.kind === 'hello' && Array.isArray(data.events)) onHistory(data.events);
      else if (data.kind === 'event' && data.event) onEvent(data.event);
      else if (data.kind === 'task' && data.task && onTask) {
        try {
          onTask(data.task);
        } catch {
          // callback UI tidak boleh memutus koneksi
        }
      } else if (data.kind === 'usage' && onUsage) {
        try {
          onUsage(data.usage);
        } catch {
          // callback UI tidak boleh memutus koneksi
        }
      }
    };
    ws.onclose = async () => {
      onStatus('offline');
      if (closed) return;
      if (!gotHello && onClosedBeforeHello) {
        let keep = true;
        try {
          keep = (await onClosedBeforeHello()) !== false;
        } catch {
          keep = true;
        }
        if (closed) return;
        if (!keep) {
          closed = true;
          return;
        }
      }
      scheduleReconnect();
    };
    ws.onerror = () => ws.close();
  }

  open();
  return {
    isOnline: () => ws?.readyState === WebSocket.OPEN,
    close() {
      closed = true;
      clearTimeout(timer);
      ws?.close();
    },
  };
}

export async function postEvents(events) {
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(events),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// ------------------------------------------------------------------ sesi (cookie HttpOnly)

const REQUEST_TIMEOUT_MS = 10000;
const timeoutSignal = () =>
  typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;

/** fetch + JSON tanpa melempar: { status: number | null, body: any }. */
async function requestJson(path, init = {}) {
  try {
    const res = await fetch(path, { cache: 'no-store', credentials: 'same-origin', signal: timeoutSignal(), ...init });
    const body = await res.json().catch(() => undefined);
    return { status: res.status, body };
  } catch {
    return { status: null, body: undefined };
  }
}

const postJson = (path, data) =>
  requestJson(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** GET /api/session → { known, authRequired, authenticated }. Tidak pernah melempar. */
export async function getSession() {
  const { status, body } = await requestJson('/api/session');
  return parseSession(status, body);
}

/** GET /api/usage → { status, body } (status null = gagal/timeout). Tidak pernah melempar. */
export function getUsage() {
  return requestJson('/api/usage');
}

/** POST /api/login. Token hanya ada di body request ini. → { ok } | { ok: false, error } */
export async function postLogin(token) {
  const { status, body } = await postJson('/api/login', { token });
  return loginResult(status, body);
}

/** POST /api/logout → { ok } | { ok: false, error } */
export async function postLogout() {
  const { status, body } = await postJson('/api/logout', {});
  return logoutResult(status, body);
}

// ------------------------------------------------------------------ runner tugas nyata
//
// Mode lokal: key dari fragmen URL (#key=...) disimpan di sessionStorage lalu fragmen dihapus.
// Key dikirim HANYA lewat header X-AI-Office-Key (tidak pernah di query string). Mode token: cookie sesi cukup.

export const KEY_STORAGE = 'ai-office-key';
export const KEY_HEADER = 'X-AI-Office-Key';
const KEY_RE = /^[A-Za-z0-9._~+/=-]{8,512}$/;

function sessionStore() {
  try {
    return typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** Ambil key dari teks fragmen ("#key=abc&x=1"). → { key, rest } (rest = fragmen tanpa key, tanpa '#'). */
export function parseKeyFragment(hash) {
  const raw = String(hash ?? '').replace(/^#/, '');
  if (!raw) return { key: null, rest: '' };
  const kept = [];
  let key = null;
  for (const part of raw.split('&')) {
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (name === 'key') {
      let value = eq < 0 ? '' : part.slice(eq + 1);
      try {
        value = decodeURIComponent(value);
      } catch {
        value = '';
      }
      if (KEY_RE.test(value)) key = value;
    } else if (part) kept.push(part);
  }
  return { key, rest: kept.join('&') };
}

/**
 * Dipanggil sekali saat halaman dibuka. Kalau URL berisi #key=..., simpan di sessionStorage dan
 * hapus key dari URL (history.replaceState, tanpa memuat ulang). Mengembalikan true bila ada key baru.
 */
export function captureKeyFromUrl({ loc = globalThis.location, hist = globalThis.history, storage = sessionStore() } = {}) {
  if (!loc || typeof loc.hash !== 'string' || !/(^|[#&])key=/.test(loc.hash)) return false;
  const { key, rest } = parseKeyFragment(loc.hash);
  let stored = false;
  if (key) {
    try {
      storage?.setItem(KEY_STORAGE, key);
      stored = true;
    } catch {
      // penyimpanan diblokir: key hanya dibuang dari URL
    }
  }
  try {
    hist?.replaceState?.(hist.state ?? null, '', `${loc.pathname}${loc.search ?? ''}${rest ? `#${rest}` : ''}`);
  } catch {
    // replaceState gagal: biarkan
  }
  return stored;
}

/** Key runner dari sessionStorage, atau null. */
export function getRunnerKey(storage = sessionStore()) {
  try {
    const v = storage?.getItem(KEY_STORAGE);
    return typeof v === 'string' && KEY_RE.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** Request ke endpoint runner/demo/file: menambahkan header key bila ada. */
function runnerRequest(path, init = {}) {
  const key = getRunnerKey();
  const headers = { ...(init.headers ?? {}), ...(key ? { [KEY_HEADER]: key } : {}) };
  return requestJson(path, { ...init, headers });
}

const runnerPost = (path, data) =>
  runnerRequest(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });

/** GET /api/runner → state runner (lihat parseRunner). Tidak pernah melempar. */
export async function getRunner() {
  const { status, body } = await runnerRequest('/api/runner');
  return parseRunner(status, body, { hasKey: getRunnerKey() !== null });
}

/** POST /api/tasks { text, lang } → { ok: true, task } | { ok: false, reason, error? }. */
export async function postTask(text, lang) {
  const { status, body } = await runnerPost('/api/tasks', { text, lang });
  return parseStartResponse(status, body);
}

/** POST /api/demo { lang } → sama seperti postTask. */
export async function postDemo(lang) {
  const { status, body } = await runnerPost('/api/demo', { lang });
  return parseStartResponse(status, body);
}

/** POST /api/tasks/<id>/cancel → boolean. */
export async function cancelTask(id) {
  if (!isTaskId(id)) return false;
  const path = `/api/tasks/${id}/cancel`;
  const { status, body } = await runnerPost(path, {});
  return status === 200 && body?.ok === true;
}

/** GET /api/tasks → { ok, tasks }. */
export async function listTasks() {
  const { status, body } = await runnerRequest('/api/tasks');
  return status === 200 && body?.ok === true && Array.isArray(body.tasks) ? { ok: true, tasks: body.tasks } : { ok: false, tasks: [] };
}

/** GET /api/tasks/<id> → { ok, task, files }. */
export async function getTask(id) {
  if (!isTaskId(id)) return { ok: false };
  const path = `/api/tasks/${id}`;
  const { status, body } = await runnerRequest(path);
  return parseTaskDetail(status, body);
}

/** GET /api/tasks/<id>/files/<path> → { ok: true, text } | { ok: false }. Isi selalu dibaca sebagai teks. */
export async function getTaskFile(id, relpath) {
  const path = taskFilePath(id, relpath);
  if (!path) return { ok: false };
  try {
    const key = getRunnerKey();
    const res = await fetch(path, {
      cache: 'no-store',
      credentials: 'same-origin',
      signal: timeoutSignal(),
      headers: { Accept: 'text/plain', ...(key ? { [KEY_HEADER]: key } : {}) },
    });
    if (!res.ok) return { ok: false };
    return { ok: true, text: await res.text() };
  } catch {
    return { ok: false };
  }
}
