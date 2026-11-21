// Mode demo: memutar satu tugas contoh dari awal sampai beres, dari sisi server (semua klien ikut melihat),
// sekitar 54 detik. Tanpa Claude CLI. Menulis file hasil contoh dari template server/demo/<lang>/*.md ke
// folder tugas. Event membawa source "sim" (diatur oleh server/tasks.js lewat `emit`).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { t } from '../shared/i18n.js';

// Nama file hasil per bahasa (template di server/demo/<lang>/<nama>).
export const DEMO_FILES = {
  en: { script: 'tiktok-script.md', caption: 'caption.md', research: 'price-research.md', result: 'RESULT.md' },
  id: { script: 'tiktok-script.md', caption: 'caption.md', research: 'riset-harga.md', result: 'RESULT.md' },
};

/** Jeda yang bisa dibatalkan. Mengembalikan true bila dibatalkan. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(false);
    }, Math.max(0, ms));
    function onAbort() {
      clearTimeout(timer);
      resolve(true);
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Skenario: [waktu mulai ms, aksi]. Aksi: { ev: [type, from, to, messageKey] } dan/atau { file: 'script' | ... }.
 * Total ±54 detik pada speed 1.
 */
export function scenario() {
  return [
    [0, { ev: ['assign', 'ceo', 'manager', 'title'] }],
    [3000, { ev: ['working', 'manager', 'ceo', 'demo.plan'] }],
    [7000, { ev: ['assign', 'manager', 'content-script', 'demo.assignScript'] }],
    [9500, { ev: ['assign', 'manager', 'sales-copywriter', 'demo.assignCaption'] }],
    [12000, { ev: ['assign', 'manager', 'research-analyst', 'demo.assignResearch'] }],
    [14000, { ev: ['working', 'content-script', 'manager', 'demo.workScript'] }],
    [16000, { ev: ['working', 'sales-copywriter', 'manager', 'demo.workCaption'] }],
    [18000, { ev: ['working', 'research-analyst', 'manager', 'demo.workResearch'] }],
    [30000, { file: 'script', ev: ['done', 'content-script', 'manager', 'demo.doneScript'] }],
    [30800, { ev: ['report', 'content-script', 'manager', 'demo.doneScript'] }],
    [38000, { file: 'caption', ev: ['done', 'sales-copywriter', 'manager', 'demo.doneCaption'] }],
    [38800, { ev: ['report', 'sales-copywriter', 'manager', 'demo.doneCaption'] }],
    [46000, { file: 'research', ev: ['done', 'research-analyst', 'manager', 'demo.doneResearch'] }],
    [46800, { ev: ['report', 'research-analyst', 'manager', 'demo.doneResearch'] }],
    [49500, { ev: ['working', 'manager', 'ceo', 'demo.compile'] }],
    [54000, { file: 'result', ev: ['report', 'manager', 'ceo', 'demo.summary'] }],
  ];
}

/**
 * Putar demo. `emit(type, from, to, message)` memancarkan event (kecuali laporan akhir, lihat di bawah); `speed`
 * mempercepat (uji memakai angka besar).
 * @returns {Promise<{ aborted: boolean, summary: string }>}
 */
export async function playDemo({ lang, dir, title, emit, speed = 1, signal }) {
  const tr = (key, vars) => t(key, vars, lang);
  const names = DEMO_FILES[lang] ?? DEMO_FILES.en;
  const summary = tr('demo.summary');
  const factor = Number.isFinite(speed) && speed > 0 ? speed : 1;
  let last = 0;
  const steps = scenario();
  for (const [index, [at, step]] of steps.entries()) {
    if (await sleep((at - last) / factor, signal)) return { aborted: true, summary };
    last = at;
    if (step.file) {
      const file = names[step.file];
      const body = await readFile(new URL(`./demo/${DEMO_FILES[lang] ? lang : 'en'}/${file}`, import.meta.url), 'utf8');
      await writeFile(join(dir, file), body);
    }
    // Langkah terakhir (laporan manajer → CEO) dipancarkan oleh server/tasks.js setelah status tugas tersimpan.
    if (step.ev && index < steps.length - 1) {
      const [type, from, to, key] = step.ev;
      emit(type, from, to, key === 'title' ? title : tr(key));
    }
  }
  return { aborted: false, summary };
}
