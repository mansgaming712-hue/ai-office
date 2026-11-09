// Skenario contoh untuk tombol "Simulasi" — berjalan penuh di browser, tanpa Claude Code.
// `at` = detik sejak simulasi dimulai. Event worker yang datang sebelum manajer tiba
// otomatis ditahan oleh engine sampai tugasnya diserahkan.
//
// Dua sesi proyek berjalan bersamaan (field `project`): "kopiku-web" (landing page, harga, skrip)
// dan "kopiku-3d" (alur Divisi 3D: modeler → materials → animator → render).
// Data usage contoh naik bertahap melewati 60% (kuning) lalu 85% (merah + peringatan manajer).
// Semua data simulasi hanya untuk tampilan: App menyimpannya terpisah dari data server.
import { normalizeEvent } from '../../shared/events.js';
import { levelFor } from '../usage.js';

export const SIM_PROJECTS = { web: 'kopiku-web', model: 'kopiku-3d' };
const WEB = SIM_PROJECTS.web;
const M3D = SIM_PROJECTS.model;

const s = (at, type, from, to, message, project = WEB) => ({ at, event: { type, from, to, message, project } });

export const SCENARIO = [
  s(0, 'assign', 'ceo', 'manager', 'Luncurkan produk KopiKu minggu ini: landing page, harga paket, dan video promo.'),
  s(4, 'working', 'manager', 'ceo', 'Menyusun rencana: Dev, Sales, dan Konten jalan paralel.'),
  s(6.5, 'assign', 'manager', 'dev-frontend', 'Bangun landing page KopiKu yang responsif dan aksesibel.'),
  s(6.6, 'assign', 'manager', 'content-script', 'Tulis skrip Reels 30 detik untuk peluncuran KopiKu.'),
  s(6.7, 'assign', 'manager', 'sales-copywriter', 'Tulis copy landing page: headline, 3 benefit, CTA.'),
  s(7, 'working', 'dev-frontend', 'manager', 'Membuat komponen Hero dan Navbar…'),
  s(7.2, 'working', 'content-script', 'manager', 'Menyusun hook 3 detik pertama…'),
  s(7.4, 'working', 'sales-copywriter', 'manager', 'Menulis headline dan 3 benefit…'),
  s(9, 'assign', 'ceo', 'manager', 'Sesi kedua: render 3D kemasan KopiKu untuk iklan Reels.', M3D),
  s(12, 'assign', 'manager', '3d-modeler', 'Modelkan kemasan kopi 250 g, low-poly yang rapi.', M3D),
  s(13, 'working', '3d-modeler', 'manager', 'Blocking bentuk kemasan…', M3D),
  s(19, 'working', 'dev-frontend', 'manager', 'Layout mobile beres, lanjut desktop.'),
  s(20, 'done', '3d-modeler', 'manager', 'Model kemasan jadi, 2.400 poligon.', M3D),
  s(21, 'blocked', 'content-script', 'manager', 'Butuh daftar harga paket. Tolong minta sales-pricing.'),
  s(21.5, 'assign', 'manager', '3d-materials', 'Beri material kertas kraft dan label KopiKu.', M3D),
  s(22.5, 'working', '3d-materials', 'manager', 'Membuat tekstur kraft dan label…', M3D),
  s(23, 'done', 'sales-copywriter', 'manager', 'Copy siap: headline, 3 benefit, CTA, dan FAQ.'),
  s(25, 'assign', 'manager', 'sales-pricing', 'Susun 3 paket harga KopiKu berdasarkan harga kompetitor.'),
  s(26, 'working', 'sales-pricing', 'manager', 'Membandingkan harga 5 kompetitor…'),
  s(29, 'done', '3d-materials', 'manager', 'Material kraft dan label selesai.', M3D),
  s(30, 'assign', 'manager', '3d-animator', 'Animasikan kemasan berputar 6 detik.', M3D),
  s(31, 'working', '3d-animator', 'manager', 'Menyusun keyframe putaran…', M3D),
  s(33, 'report', 'sales-pricing', 'manager', '3 paket: Hemat 25rb, Favorit 45rb, Sultan 80rb.'),
  s(35, 'assign', 'manager', 'content-script', 'Harga sudah ada: Hemat 25rb, Favorit 45rb, Sultan 80rb. Lanjutkan skrip.'),
  s(36, 'working', 'content-script', 'manager', 'Menulis adegan dan CTA…'),
  s(37, 'done', 'dev-frontend', 'manager', 'Landing page jadi, build lulus tanpa error.'),
  s(38, 'report', '3d-animator', 'manager', 'Animasi putar 6 detik siap, 24 fps.', M3D),
  s(39, 'assign', 'manager', 'dev-qa', 'Uji landing page: test otomatis dan edge case.'),
  s(39.1, 'assign', 'manager', 'dev-security', 'Audit keamanan dan dependensi landing page.'),
  s(40, 'working', 'dev-qa', 'manager', 'Menjalankan 18 test…'),
  s(40.2, 'working', 'dev-security', 'manager', 'npm audit dan cek header keamanan…'),
  s(41, 'assign', 'manager', '3d-render', 'Render 1080x1920 untuk Reels, 144 frame.', M3D),
  s(42, 'working', '3d-render', 'manager', 'Render frame 1–144…', M3D),
  s(46, 'done', 'content-script', 'manager', 'Skrip Reels 30 detik selesai, siap dianimasikan.'),
  s(50, 'report', 'dev-qa', 'manager', '18/18 test lulus. 1 bug kecil di form sudah diperbaiki dev-frontend.'),
  s(52, 'report', 'dev-security', 'manager', 'Tidak ada temuan kritis. 0 kerentanan dependensi.'),
  s(53, 'done', '3d-render', 'manager', 'Render 144 frame selesai, file siap diunggah.', M3D),
  s(56, 'report', 'manager', 'ceo', 'Semua beres. Laporan di reports/. Butuh keputusan CEO: setujui harga paket?'),
  s(58, 'report', 'manager', 'ceo', 'Render 3D kemasan siap untuk iklan Reels.', M3D),
];

export const SCENARIO_DURATION = SCENARIO[SCENARIO.length - 1].at;

// ------------------------------------------------------------------ data usage contoh

export const SIM_WEEKLY_LIMIT = 5_000_000;

/** Persen pemakaian mingguan sepanjang simulasi: hijau → kuning (≥ 60) → merah (> 85). */
export const SIM_USAGE_TIMELINE = [
  { at: 0, percent: 18 },
  { at: 8, percent: 34 },
  { at: 16, percent: 49 },
  { at: 24, percent: 58 },
  { at: 30, percent: 63 },
  { at: 36, percent: 72 },
  { at: 42, percent: 81 },
  { at: 46, percent: 87 },
  { at: 52, percent: 92 },
];

const PREV_DAYS_SHARE = 0.15; // 6 hari sebelumnya = 15% limit, sisanya terpakai hari ini
const PREV_DAYS_WEIGHTS = [0.12, 0.18, 0.1, 0.22, 0.16, 0.22];
const AGENT_WEIGHTS = [
  ['dev-frontend', 22, 6],
  ['3d-render', 18, 3],
  ['3d-modeler', 14, 4],
  ['sales-copywriter', 11, 3],
  ['content-script', 10, 4],
  ['3d-materials', 9, 2],
  ['dev-qa', 8, 5],
  ['3d-animator', 8, 2],
];

function split(total) {
  const input = Math.round(total * 0.3);
  const output = Math.round(total * 0.15);
  const cacheCreation = Math.round(total * 0.05);
  const cacheRead = Math.max(0, total - input - output - cacheCreation);
  return { input, output, cacheRead, cacheCreation, total: input + output + cacheRead + cacheCreation };
}

// Tanggal lokal (YYYY-MM-DD), sama seperti server yang menghitung "hari ini" menurut zona waktu komputer.
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * Objek usage contoh dengan bentuk yang sama persis dengan kontrak server (`usage` dari /api/usage),
 * sehingga melewati validasi yang sama. `percent` = pemakaian mingguan.
 */
export function buildSimUsage(percent, { now = new Date(), limit = SIM_WEEKLY_LIMIT } = {}) {
  const p = Math.max(0, Number(percent) || 0);
  const used = Math.round((limit * p) / 100);
  const prevTotal = Math.min(used, Math.round(limit * PREV_DAYS_SHARE));
  const dayMs = 24 * 60 * 60 * 1000;
  const days = PREV_DAYS_WEIGHTS.map((w, i) => ({
    // lewat kalender (bukan - 24 jam) supaya pergantian DST tidak membuat tanggal ganda
    date: isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - i), 12)),
    ...split(Math.round(prevTotal * w)),
  }));
  const prevSum = days.reduce((a, d) => a + d.total, 0);
  const today = { date: isoDate(now), ...split(Math.max(0, used - prevSum)) };
  days.push(today);
  const weightSum = AGENT_WEIGHTS.reduce((a, [, w]) => a + w, 0);
  const perAgent = AGENT_WEIGHTS.map(([agent, w, runs]) => ({
    agent,
    ...split(Math.round((today.total * w) / weightSum)),
    runs,
  }));
  const weeklyUsed = days.reduce((a, d) => a + d.total, 0);
  const weeklyPercent = Number(((weeklyUsed / limit) * 100).toFixed(1));
  return {
    available: true,
    reason: null,
    estimate: true,
    updatedAt: now.toISOString(),
    today,
    days,
    weekly: {
      used: weeklyUsed,
      limit,
      percent: weeklyPercent,
      level: levelFor(weeklyPercent),
      windowStart: new Date(now.getTime() - 6 * dayMs).toISOString(),
      configAvailable: true,
    },
    perAgent,
  };
}

/**
 * Putar skenario. onEvent dipanggil dengan event yang sudah dinormalisasi (source: "sim").
 * onUsage (opsional) dipanggil dengan objek usage contoh sesuai SIM_USAGE_TIMELINE.
 * Mengembalikan { stop() }. `schedule`, `cancel`, dan `now` bisa diganti di test.
 */
export function playScenario(
  onEvent,
  { speed = 1, onFinish, onUsage, schedule = setTimeout, cancel = clearTimeout, now = () => new Date() } = {},
) {
  // Setelah selesai/dihentikan, tidak ada lagi data simulasi yang boleh keluar (walau timer telat jalan).
  let ended = false;
  const timers = SCENARIO.map(({ at, event }, i) =>
    schedule(() => {
      if (ended) return;
      const r = normalizeEvent({ ...event, source: 'sim' });
      if (r.ok) onEvent(r.event);
      if (i === SCENARIO.length - 1) {
        ended = true;
        onFinish?.();
      }
    }, (at * 1000) / speed),
  );
  if (onUsage) {
    for (const { at, percent } of SIM_USAGE_TIMELINE) {
      timers.push(
        schedule(() => {
          if (!ended) onUsage(buildSimUsage(percent, { now: now() }));
        }, (at * 1000) / speed),
      );
    }
  }
  return {
    stop() {
      ended = true;
      timers.forEach((t) => cancel(t));
    },
  };
}
