#!/usr/bin/env node
// Buat divisi plugin baru di divisions/<nama>/ (kerangka, atau salinan starter dari division-packs/<starter>/).
//   npm run division:add <nama> [-- --from <starter>] [--dry-run]
// Tidak pernah menimpa file: folder yang sudah ada ditolak. --dry-run hanya mencetak apa yang akan dibuat.
// Hanya menulis teks dan JSON; tidak ada kode dari starter yang dijalankan.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n.js';
import { DIVISION_ID_RE, checkDivisionId, safeText, validateDivision } from '../shared/divisions.js';
import { PACKS_DIR, discoverDivisions, divisionsDirFromEnv } from '../server/divisions.js';
import { riskyTools, validateAgent } from './agent-files.mjs';

const PALETTE = ['#8a5a44', '#2f7d8c', '#7a5cc0', '#a3883a', '#c05a5a', '#4d8a4d', '#4a6fa5', '#9a5c8a'];

const pretty = (id) => id.split('-').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
const colorFor = (id) => PALETTE[[...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];
const bad = (key, params = {}) => ({ ok: false, error: { key, params } });

function skeletonAgent(id, worker) {
  const label = pretty(id);
  return `---
name: ${worker}
description: Spesialis divisi ${label}. Gunakan untuk tugas di bidang ${label} yang dibebankan manajer; ganti deskripsi ini dengan bidang kerja yang spesifik supaya manajer memilihnya dengan tepat.
tools: Read, Write, Glob, Grep
model: haiku
---

# ${label} Worker

Kamu spesialis divisi ${label} di AI Office. Edit file ini: tulis tanggung jawab, cara kerja, dan batas bidangmu.

## Tanggung jawab

- Tulis di sini apa yang dikerjakan agen ini.

## Cara kerja

- Tulis di sini langkah kerja dan standar kualitasnya.

## Di luar bidangmu (laporkan ke manajer)

- Tulis di sini hal yang bukan tugasmu dan agen siapa yang menanganinya.

## Aturan spesialis (wajib)

> Fokus hanya pada keahlianmu. Kalau tugas terlalu besar, informasinya kurang, atau butuh keahlian lain, berhenti dan laporkan ke manajer apa yang kurang dan agen siapa yang dibutuhkan. Jangan mencoba memanggil agen lain.

- Bidangmu: **tulis bidangmu di sini**. Bagian di luar bidang ini bukan tugasmu, sekecil apa pun.
- Kalau tugas terlalu besar, informasinya kurang, atau butuh keahlian lain: **berhenti**, jangan menebak dan jangan memaksakan. Laporkan dengan \`STATUS: BUTUH BANTUAN\`.
- Jangan mencoba memanggil, menjalankan, atau meniru agen lain. Hanya manajer yang mendelegasikan.
- Jangan melakukan hal berisiko tanpa izin CEO yang diteruskan manajer secara eksplisit: deploy, menghapus data atau file penting, mengubah konfigurasi server, atau apa pun yang mengeluarkan uang.
- Jangan mengklaim berhasil tanpa bukti. Tulis apa yang sudah diverifikasi dan apa yang belum.
- Balas dan tulis hasil kerja dalam bahasa yang dipakai CEO saat memberi tugas (Indonesia atau Inggris). Baris \`STATUS:\` tetap memakai kata kunci di bawah.

## Format laporan ke manajer

Baris pertama laporan WAJIB salah satu dari dua baris ini (dipakai juga oleh animasi AI Office):

- \`STATUS: SELESAI\` — tugas tuntas dan sudah kamu verifikasi.
- \`STATUS: BUTUH BANTUAN\` — kamu berhenti karena tugas terlalu berat atau butuh keahlian lain.

Lalu, berurutan: **Ringkasan**, **Yang dikerjakan**, **Bukti**, **Belum terverifikasi / risiko**, dan **Butuh dari manajer** (wajib kalau \`BUTUH BANTUAN\`).
`;
}

/** Ganti token nama (id starter dan nama worker lama) dengan yang baru, hanya sebagai kata utuh kebab-case. */
export function renameTokens(text, map) {
  const olds = [...map.keys()].sort((a, b) => b.length - a.length);
  if (!olds.length) return text;
  // Nama sudah divalidasi (huruf kecil/angka/"-"), jadi aman dipakai langsung di regex.
  const re = new RegExp(`(?<![a-z0-9-])(${olds.join('|')})(?![a-z0-9-])`, 'g');
  return text.replace(re, (m) => map.get(m));
}

/**
 * Susun isi divisi baru (tanpa menulis apa pun).
 * Hasil: { ok: true, id, files: [{ rel, text }] } atau { ok: false, error: { key, params } }.
 */
export function planDivision({ name, from = null, divisionsDir = divisionsDirFromEnv(), packsDir = PACKS_DIR }) {
  const idErr = checkDivisionId(name);
  if (idErr) return bad(idErr.key, idErr.params);
  const id = name;

  let manifest;
  let agents; // [{ worker, text }]
  if (from === null) {
    const worker = `${id}-worker`;
    manifest = { id, name: { en: pretty(id), id: pretty(id) }, color: colorFor(id), desks: 2, workers: [worker] };
    agents = [{ worker, text: skeletonAgent(id, worker) }];
  } else {
    if (typeof from !== 'string' || !DIVISION_ID_RE.test(from)) return bad('divisions.add.starterInvalid', { from: safeText(from), reason: '' });
    const found = discoverDivisions({ dir: packsDir });
    const starter = found.divisions.find((d) => d.id === from);
    if (!starter) {
      const e = found.errors.find((x) => x.dir === from);
      return bad('divisions.add.starterInvalid', {
        from,
        reason: e ? t(e.key, e.params) : t('divisions.add.starterList', { list: found.divisions.map((d) => d.id).join(', ') || '-' }),
      });
    }
    const map = new Map([[from, id]]);
    const prefix = `${from}-`;
    for (const w of starter.workers) map.set(w, `${id}-${w.startsWith(prefix) ? w.slice(prefix.length) : w}`);
    manifest = {
      id,
      name: { en: pretty(id), id: pretty(id) },
      color: starter.color,
      desks: starter.desks,
      workers: starter.workers.map((w) => map.get(w)),
    };
    if (starter.description !== undefined) manifest.description = renameTokens(starter.description, map);
    agents = starter.agentFiles.map((f) => ({ worker: map.get(f.worker), text: renameTokens(f.text, map) }));
  }

  // Sama persis dengan yang akan dicek server saat menemukan divisi ini.
  const v = validateDivision(manifest);
  if (!v.ok) return bad(v.errors[0].key, v.errors[0].params);
  for (const a of agents) {
    const { errors, data } = validateAgent(`${a.worker}.md`, a.text);
    if (errors.length) return bad('divisions.err.agentInvalid', { worker: a.worker, detail: safeText(errors[0], 160) });
    if (data.name !== a.worker) return bad('divisions.err.agentName', { worker: a.worker });
  }
  // Bentrok nama worker dengan divisi lain yang sudah ada.
  const existing = discoverDivisions({ dir: divisionsDir });
  for (const d of existing.divisions) {
    const clash = d.workers.find((w) => manifest.workers.includes(w));
    if (clash) return bad('divisions.err.workerTaken', { worker: clash, other: d.id });
  }

  // Agen starter dengan tool berisiko: hanya peringatan di sini; agents:install yang menahannya.
  const risky = agents.flatMap((a) => {
    const r = riskyTools(validateAgent(`${a.worker}.md`, a.text).data.tools);
    return r.length ? [`${a.worker}: ${r.join('/')}`] : [];
  });

  return {
    ok: true,
    id,
    ...(risky.length ? { risky } : {}),
    files: [
      { rel: ['division.json'], text: `${JSON.stringify(v.value, null, 2)}\n` },
      ...agents.map((a) => ({ rel: ['agents', `${a.worker}.md`], text: a.text })),
    ],
  };
}

/** Rencanakan lalu (kecuali dryRun) tulis divisi baru. Tidak pernah menimpa. */
export function addDivision({ name, from = null, dryRun = false, divisionsDir = divisionsDirFromEnv(), packsDir = PACKS_DIR } = {}) {
  const idErr = checkDivisionId(name);
  if (idErr) return bad(idErr.key, idErr.params);
  const target = join(divisionsDir, name);

  // lstat (bukan exists): symlink yang rusak juga dianggap ada. Dicek sebelum perencanaan supaya
  // pesannya "sudah ada", bukan bentrok dengan worker divisi itu sendiri.
  let exists = true;
  try {
    lstatSync(target);
  } catch (e) {
    if (e.code === 'ENOENT') exists = false;
  }
  if (exists) return bad('divisions.add.exists', { id: name });

  const plan = planDivision({ name, from, divisionsDir, packsDir });
  if (!plan.ok) return plan;
  const shown = plan.files.map((f) => ['divisions', plan.id, ...f.rel].join('/'));
  if (dryRun) return { ok: true, dryRun: true, id: plan.id, files: shown, ...(plan.risky ? { risky: plan.risky } : {}) };

  try {
    mkdirSync(divisionsDir, { recursive: true });
    mkdirSync(target); // tanpa recursive: gagal bila folder muncul di antara cek dan tulis
    mkdirSync(join(target, 'agents'));
    for (const f of plan.files) writeFileSync(join(target, ...f.rel), f.text, { flag: 'wx' });
  } catch (e) {
    return bad(e.code === 'EEXIST' ? 'divisions.add.exists' : 'divisions.add.writeFailed', { id: plan.id, reason: e.code ?? 'error' });
  }
  return { ok: true, dryRun: false, id: plan.id, files: shown, ...(plan.risky ? { risky: plan.risky } : {}) };
}

/** Argumen CLI: <nama> [--from <starter> | --from=<starter>] [--dry-run]. */
export function parseArgs(argv) {
  const out = { name: null, from: null, dryRun: false, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--from') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) out.error = 'divisions.add.usage';
      else out.from = v;
    } else if (a.startsWith('--from=')) out.from = a.slice(7) || (out.error = 'divisions.add.usage');
    else if (a.startsWith('-')) out.error = 'divisions.add.usage';
    else if (out.name === null) out.name = a;
    else out.error = 'divisions.add.usage';
  }
  if (!out.error && out.name === null) out.error = 'divisions.add.nameMissing';
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.error) {
    console.error(t(args.error));
    console.error(t('divisions.add.usage'));
    return 2;
  }
  const r = addDivision({ name: args.name, from: args.from, dryRun: args.dryRun });
  if (!r.ok) {
    console.error(t(r.error.key, r.error.params));
    return 1;
  }
  console.log(t(r.dryRun ? 'divisions.add.dryRun' : 'divisions.add.created', { id: r.id, n: r.files.length }));
  for (const f of r.files) console.log(`  ${f}`);
  if (r.risky) console.error(`\n${t('divisions.add.riskyWarning', { from: args.from, list: r.risky.join('; ') })}`);
  if (!r.dryRun) console.log(`\n${t('divisions.add.next')}`);
  return 0;
}

const isMain = Boolean(process.argv[1]) && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) process.exitCode = main();
