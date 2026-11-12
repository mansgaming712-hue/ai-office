// Logika state tampilan: loading, kosong, dan koneksi putus. Fungsi murni tanpa DOM supaya bisa dites.
//
// Dua hal berbeda dihitung terpisah:
//   stage  = isi kantor: 'loading' (belum pernah terhubung) | 'empty' (terhubung, belum ada kejadian) | 'ready'
//   banner = masalah koneksi: null | 'reconnecting' (pernah terhubung lalu putus) | 'unreachable' (belum pernah berhasil)
// Reconnect selalu otomatis (src/net.js), jadi kedua banner menyebut "menyambung ulang".

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

export const CONN_LABEL = {
  connecting: 'Menghubungkan…',
  online: 'Terhubung ke server',
  reconnecting: 'Terputus, menyambung ulang…',
  unreachable: 'Server tidak terjangkau, menyambung ulang…',
};

export const BANNER_TEXT = {
  reconnecting: {
    title: 'Koneksi terputus',
    body: 'Menyambung ulang otomatis. Simulasi dan perintah tetap jalan secara lokal.',
  },
  unreachable: {
    title: 'Server tidak terjangkau',
    body: 'Menyambung ulang otomatis. Pastikan server AI Office berjalan. Simulasi tetap bisa dipakai.',
  },
};

export const LOADING_TEXT = { title: 'Menghubungkan ke server…', body: 'Memuat kantor dan riwayat kejadian.' };

export const EMPTY_TEXT = {
  title: 'Kantor masih sepi',
  body: 'Belum ada kejadian. Agen mulai bergerak begitu Claude Code mengirim tugas.',
  simulate: 'Coba simulasi',
  hooksIntro: 'Atau pasang hooks agar sesi asli tampil:',
  hooksCommand: 'npm run hooks:install-user',
};
