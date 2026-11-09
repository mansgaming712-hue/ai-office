// Koneksi browser ↔ server: WebSocket untuk menerima event, HTTP POST untuk mengirim.
import { loginResult, logoutResult, parseSession } from './auth.js';

/**
 * `onClosedBeforeHello` (opsional): dipanggil saat WebSocket tertutup sebelum pesan hello
 * (mis. upgrade ditolak karena sesi tidak sah). Kembalikan `false` (atau Promise false)
 * untuk menghentikan reconnect; nilai lain → reconnect seperti biasa.
 */
/**
 * `onUsage` (opsional): dipanggil dengan objek `usage` mentah dari pesan { kind: "usage", usage }.
 * Validasi dilakukan pemanggil (src/usage.js). Tanpa callback ini, pesan usage diabaikan.
 */
export function connect({ onEvent, onHistory, onStatus, onClosedBeforeHello, onUsage }) {
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
      else if (data.kind === 'usage' && onUsage) {
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
