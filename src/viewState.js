// Logika state tampilan: loading, kosong, dan koneksi putus. Fungsi murni tanpa DOM supaya bisa dites.
//
// Dua hal berbeda dihitung terpisah:
//   stage  = isi kantor: 'loading' (belum pernah terhubung) | 'empty' (terhubung, belum ada kejadian) | 'ready'
//   banner = masalah koneksi: null | 'reconnecting' (pernah terhubung lalu putus) | 'unreachable' (belum pernah berhasil)
// Reconnect selalu otomatis (src/net.js), jadi kedua banner menyebut "menyambung ulang".

import { t } from './i18n.js';

export const initialLink = { conn: 'connecting', everOnline: false, failed: false, everHello: false };

/**
 * Reducer status koneksi. Aksi: { type: 'status', status: 'connecting' | 'online' | 'offline' } dan
 * { type: 'hello' } (riwayat dari server sudah diterima, walau kosong).
 */
export function linkReducer(state, action) {
  if (action.type === 'hello') return state.everHello ? state : { ...state, everHello: true };
  if (action.type !== 'status') return state;
  const conn = action.status;
  if (conn === 'online') return { ...state, conn, everOnline: true };
  if (conn === 'offline') return { ...state, conn, failed: true };
  if (conn === 'connecting') return { ...state, conn };
  return state;
}

/** 'online' | 'connecting' | 'reconnecting' | 'unreachable'. */
export function linkView(link) {
  if (link.conn === 'online') return 'online';
  if (link.everOnline) return 'reconnecting';
  if (link.failed) return 'unreachable';
  return 'connecting';
}

/**
 * Tahap tampilan kantor + banner koneksi.
 * Simulasi yang sedang berjalan selalu dianggap "ready" (data lokal tidak butuh server).
 */
export function stageState({ link, hasEvents, simRunning = false }) {
  const view = linkView(link);
  const banner = view === 'reconnecting' || view === 'unreachable' ? view : null;
  let stage = 'ready';
  if (!simRunning && !hasEvents) {
    if (!link.everHello && (view === 'connecting' || view === 'online')) stage = 'loading';
    else if (view === 'online') stage = 'empty';
  }
  return { stage, banner, view };
}

// Teks tampilan dibaca lewat getter supaya selalu mengikuti bahasa aktif (src/i18n.js, namespace `ui`).
const lazy = (map) =>
  Object.defineProperties(
    {},
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, { enumerable: true, get: typeof v === 'function' ? v : () => t(v) }])),
  );

export const CONN_LABEL = lazy({
  connecting: 'ui.conn.connecting',
  online: 'ui.conn.online',
  reconnecting: 'ui.conn.reconnecting',
  unreachable: 'ui.conn.unreachable',
});

export const BANNER_TEXT = {
  reconnecting: lazy({ title: 'ui.banner.reconnecting.title', body: 'ui.banner.reconnecting.body' }),
  unreachable: lazy({ title: 'ui.banner.unreachable.title', body: 'ui.banner.unreachable.body' }),
};

export const LOADING_TEXT = lazy({ title: 'ui.loading.title', body: 'ui.loading.body' });

export const EMPTY_TEXT = lazy({
  title: 'ui.empty.title',
  body: 'ui.empty.body',
  simulate: 'ui.empty.simulate',
  hooksIntro: 'ui.empty.hooksIntro',
  hooksCommand: () => 'npm run hooks:install-user',
});
