#!/usr/bin/env node
// Pasang hook AI Office di settings Claude Code level user (default ~/.claude/settings.json), supaya
// semua sesi Claude Code (dari folder mana pun) mengirim event ke animasi kantor.
//   npm run hooks:install-user
//   AI_OFFICE_USER_SETTINGS=<path>  target lain (untuk uji; jangan arahkan test ke file asli)
// Merge (tidak menimpa), idempoten, backup settings.json.bak-YYYYMMDD-HHMMSS sebelum menulis, tulis
// atomik. JSON rusak = tidak menulis apa pun, keluar dengan kode 1. Lihat scripts/user-hooks.mjs.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 20.12)
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PROJECT_DIR, SettingsError, backupFile, hookCommand, installAiOfficeHooks, projectProblem, readSettings,
  userSettingsPath, writeJsonAtomicSync,
} from './user-hooks.mjs';

const target = userSettingsPath();
const fail = (msg) => {
  console.error(`Gagal: ${msg}`);
  process.exit(1);
};

const problem = projectProblem(PROJECT_DIR);
if (problem) fail(problem);

let current;
try {
  current = readSettings(target);
} catch (e) {
  if (e instanceof SettingsError) fail(`${target} ${e.message}. Tidak ada yang ditulis; perbaiki file itu dulu.`);
  throw e;
}

const command = hookCommand();
const { settings, changed } = installAiOfficeHooks(current.settings, { command });
if (!changed) {
  console.log(`Hook AI Office sudah terpasang di ${target}. Tidak ada perubahan.`);
  process.exit(0);
}

try {
  let backup = null;
  if (current.text !== null) backup = backupFile(target);
  else mkdirSync(dirname(target), { recursive: true });
  writeJsonAtomicSync(target, settings);
  console.log(`Hook AI Office dipasang di ${target}.`);
  console.log(backup ? `Backup: ${backup}` : 'File belum ada sebelumnya, jadi tidak ada backup.');
  console.log(`Command: ${command}`);
  console.log('Event: SubagentStart, SubagentStop, PreToolUse (Agent|Task + tool lain async), PostToolUse (Agent|Task); timeout 3 detik.');
  console.log('Berlaku untuk sesi Claude Code yang dimulai sesudah ini.');
} catch (e) {
  fail(`tidak bisa menulis ${target} (${e.code ?? e.message}).`);
}
