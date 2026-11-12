// Satu model status agen untuk seluruh UI: idle, bekerja, selesai, error.
// Tipe event dari server tetap lima (assign, working, done, blocked, report); yang berubah hanya
// cara UI menampilkannya. Engine animasi menyimpan status internal (idle/working/done/blocked);
// `uiStatusOf` menerjemahkannya. Fungsi murni tanpa DOM supaya bisa dites di Node.

export const UI_STATUSES = ['idle', 'bekerja', 'selesai', 'error'];

const ENGINE_TO_UI = { idle: 'idle', working: 'bekerja', done: 'selesai', blocked: 'error' };
const EVENT_TO_UI = { assign: 'bekerja', working: 'bekerja', done: 'selesai', report: 'selesai', blocked: 'error' };

/** Status internal engine → status UI. Nilai tak dikenal dianggap idle. */
export function uiStatusOf(engineStatus) {
  return ENGINE_TO_UI[engineStatus] ?? 'idle';
}

/**
 * Status UI sesudah menerima satu event. `report` dari agen yang sedang error tidak menghapus
 * error (agen masih butuh bantuan); tipe tak dikenal tidak mengubah status.
 */
export function statusForEvent(type, previous = 'idle') {
  if (type === 'report' && previous === 'error') return 'error';
  return EVENT_TO_UI[type] ?? previous;
}

/**
 * Bentuk dan warna tiap status. Warna tidak pernah satu-satunya pembeda: tiap status punya
 * label teks dan bitmap ikon (siluet + tanda di tengah) yang berbeda.
 * `fill` dipakai untuk badan ikon, `mark` untuk tanda di dalamnya.
 */
export const STATUS_INFO = {
  idle: { label: 'idle', title: 'Menunggu tugas', fill: '#8b93a1', mark: '#8b93a1' },
  bekerja: { label: 'bekerja', title: 'Sedang bekerja', fill: '#e8b931', mark: '#2a2333' },
  selesai: { label: 'selesai', title: 'Tugas selesai', fill: '#3f9e54', mark: '#ffffff' },
  error: { label: 'error', title: 'Error: agen melapor butuh bantuan', fill: '#e04848', mark: '#ffffff' },
};

export const STATUS_LABEL = Object.fromEntries(UI_STATUSES.map((s) => [s, STATUS_INFO[s].label]));

/**
 * Ikon pixel 9x9. Huruf: k = garis tepi, f = warna status, m = tanda, p = kertas (latar ikon),
 * '.' = transparan. Dipakai bersama oleh kanvas (render.js) dan panel (StatusIcon.jsx).
 *   idle    = belah ketupat kosong dengan garis datar (istirahat)
 *   bekerja = kotak dengan tiga titik (sedang mengetik)
 *   selesai = lingkaran penuh dengan centang
 *   error   = segitiga dengan tanda seru
 */
export const GLYPH_SIZE = 9;
export const GLYPHS = {
  idle: [
    '....k....',
    '...kpk...',
    '..kpppk..',
    '.kpppppk.',
    'kpfffffpk',
    '.kpppppk.',
    '..kpppk..',
    '...kpk...',
    '....k....',
  ],
  bekerja: [
    '.kkkkkkk.',
    'kfffffffk',
    'kfffffffk',
    'kfffffffk',
    'kfmfmfmfk',
    'kfffffffk',
    'kfffffffk',
    'kfffffffk',
    '.kkkkkkk.',
  ],
  selesai: [
    '..kkkkk..',
    '.kfffffk.',
    'kfffffffk',
    'kffffffmk',
    'kfmfffmfk',
    'kffmfmffk',
    'kfffmfffk',
    '.kfffffk.',
    '..kkkkk..',
  ],
  error: [
    '....k....',
    '...kfk...',
    '...kmk...',
    '..kfmfk..',
    '..kfmfk..',
    '.kfffffk.',
    '.kffmffk.',
    'kfffffffk',
    'kkkkkkkkk',
  ],
};

/** Hitung jumlah agen per status dari peta { nama: { status } } (status UI). */
export function countStatuses(statuses) {
  const counts = { idle: 0, bekerja: 0, selesai: 0, error: 0 };
  for (const s of Object.values(statuses ?? {})) {
    const key = s?.status;
    if (key in counts) counts[key]++;
    else counts.idle++;
  }
  return counts;
}

/**
 * Ringkasan teks, mis. "3 bekerja, 1 error". Status berjumlah 0 dan idle dilewati (jumlah idle
 * tampil di chip tersendiri); kalau semua idle: "Semua agen idle" (atau "Belum ada agen" bila kosong).
 */
export function summaryText(counts) {
  const total = UI_STATUSES.reduce((a, s) => a + (counts[s] ?? 0), 0);
  if (total === 0) return 'Belum ada agen';
  const parts = ['bekerja', 'selesai', 'error'].filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${STATUS_LABEL[s]}`);
  return parts.length ? parts.join(', ') : 'Semua agen idle';
}

/**
 * Ikon sebagai path SVG per huruf warna: { k, f, m, p } → "M x y h n v 1 h -n z ..." (satu path
 * per huruf, deretan piksel sebaris digabung). Dipakai StatusIcon.jsx; mudah dites tanpa DOM.
 */
export function glyphPaths(key) {
  const rows = GLYPHS[key] ?? [];
  const out = { k: '', f: '', m: '', p: '' };
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      const ch = row[x];
      let end = x + 1;
      while (end < row.length && row[end] === ch) end++;
      if (ch in out) out[ch] += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return out;
}
