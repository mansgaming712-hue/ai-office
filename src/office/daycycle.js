// Siklus siang-malam (Fase 4): fase hari dari jam LOKAL browser + parameter visual per fase.
// Modul murni: tidak membaca Date.now() sendiri. Jam (ms epoch atau Date) selalu disuntik oleh pemanggil, jadi
// semua fungsi di sini bisa dites dengan jam tetap. "Jam lokal" = zona waktu proses/browser (Date#getHours).
//
// Batas jam (mulai inklusif, selesai eksklusif; jam lokal 24 jam):
//   subuh 04:00-05:59 | pagi 06:00-10:59 | siang 11:00-14:59 | sore 15:00-17:59 | malam 18:00-03:59 (lewat tengah malam)
// Fase dihitung dari jam penuh saja (menit tidak berpengaruh); pemanggil cukup memeriksa ulang sekali per menit.
//
// Parameter visual diturunkan dari palet day/night tema yang sudah ada, jadi SEMUA tema (bawaan dan buatan pengguna)
// jalan tanpa field baru di theme.json: `variant` memilih palet, `tint` = lapisan warna tipis di atas seluruh kantor,
// `paneGlow` = cahaya di kaca jendela, `spill` = berkas cahaya dari jendela ke lantai, `lamps` = intensitas lampu
// kantor (0 = mati), `sleepy` = 0..1 seberapa ngantuk para pekerja (hanya tampilan).

export const PHASES = Object.freeze(['subuh', 'pagi', 'siang', 'sore', 'malam']);

/** Jam mulai tiap fase (urutan menaik; malam melewati tengah malam sampai subuh berikutnya). */
export const PHASE_START = Object.freeze({ subuh: 4, pagi: 6, siang: 11, sore: 15, malam: 18 });

const rgb = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const layer = (hex, alpha) => {
  const [r, g, b] = rgb(hex);
  return Object.freeze({ color: hex, alpha, css: `rgba(${r},${g},${b},${alpha})` });
};
const NONE = Object.freeze({ color: '#000000', alpha: 0, css: 'rgba(0,0,0,0)' });

/** Parameter visual per fase (objek beku; tidak dialokasi ulang per frame). */
export const PHASE_LOOK = Object.freeze({
  subuh: Object.freeze({ variant: 'night', tint: layer('#6b5b95', 0.1), paneGlow: layer('#ff9f80', 0.3), spill: layer('#ffb199', 0.06), lamps: 0.9, sleepy: 0.6 }),
  pagi: Object.freeze({ variant: 'day', tint: layer('#ffe9a8', 0.03), paneGlow: layer('#fff1b8', 0.18), spill: layer('#ffe9a8', 0.1), lamps: 0, sleepy: 0 }),
  siang: Object.freeze({ variant: 'day', tint: NONE, paneGlow: NONE, spill: layer('#ffffff', 0.07), lamps: 0, sleepy: 0 }),
  sore: Object.freeze({ variant: 'day', tint: layer('#ff9a3c', 0.05), paneGlow: layer('#ff8a3c', 0.3), spill: layer('#ffa04a', 0.12), lamps: 0.5, sleepy: 0 }),
  malam: Object.freeze({ variant: 'night', tint: layer('#1c2a6b', 0.08), paneGlow: NONE, spill: layer('#9fb4ff', 0.05), lamps: 1, sleepy: 1 }),
});

/** Warna cahaya lampu kantor (hangat), dipakai renderer saat `lamps` > 0. */
export const LAMP_COLOR = '#ffd98a';

export const isPhase = (p) => typeof p === 'string' && Object.hasOwn(PHASE_LOOK, p);

/** Jam lokal 0..23 dari `now` (ms epoch, Date, atau string tanggal); tidak sah → null. */
function localHour(now) {
  const d = now instanceof Date ? now : new Date(now);
  const h = d.getHours();
  return Number.isInteger(h) ? h : null;
}

/** Fase hari untuk waktu `now` (jam lokal). Waktu tidak sah (NaN) jatuh ke 'siang' (netral, tanpa tint). */
export function phaseAt(now) {
  const h = localHour(now);
  if (h === null) return 'siang';
  if (h >= PHASE_START.malam || h < PHASE_START.subuh) return 'malam';
  if (h >= PHASE_START.sore) return 'sore';
  if (h >= PHASE_START.siang) return 'siang';
  if (h >= PHASE_START.pagi) return 'pagi';
  return 'subuh';
}

/** Parameter visual fase; nama tak dikenal → null (tanpa efek). */
export const lookOf = (phase) => (isPhase(phase) ? PHASE_LOOK[phase] : null);

/** Varian palet 'day' | 'night' untuk fase. */
export const variantOfPhase = (phase) => lookOf(phase)?.variant ?? 'day';

/** Tingkat ngantuk 0..1 untuk fase (0 = tidak ada efek). */
export const sleepinessOf = (phase) => lookOf(phase)?.sleepy ?? 0;

/** Seberapa sering fase diperiksa ulang (ms): sekali per menit, bukan per frame. */
export const PHASE_CHECK_MS = 60_000;

/**
 * Pengamat fase hari: memanggil `onChange(fase)` sekali saat dimulai, lalu hanya ketika fase berganti. Jam dan timer
 * disuntik (`clock`, `setTimer`, `clearTimer`) supaya bisa dites tanpa menunggu. `stop()` menghentikan timer.
 * @returns {{ check: () => string, stop: () => void, current: () => string }}
 */
export function watchPhase({
  clock = Date.now, onChange, intervalMs = PHASE_CHECK_MS, setTimer = setInterval, clearTimer = clearInterval,
}) {
  let phase = null;
  const check = () => {
    const next = phaseAt(clock());
    if (next !== phase) {
      phase = next;
      onChange?.(next);
    }
    return phase;
  };
  check();
  const id = setTimer(check, intervalMs);
  return { check, current: () => phase, stop: () => clearTimer(id) };
}
