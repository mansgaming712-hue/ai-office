#!/usr/bin/env node
// Lepas hook AI Office dari settings Claude Code level user (default ~/.claude/settings.json).
//   npm run hooks:uninstall-user
//   AI_OFFICE_USER_SETTINGS=<path>  target lain (untuk uji)
// Hanya entri AI Office (command yang memuat hooks/send-event.mjs proyek ini) yang dihapus; key dan hook
// lain tetap. Backup dulu, tulis atomik; JSON rusak = tidak menulis apa pun, kode keluar 1.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { PROJECT_DIR, SettingsError, backupFile, readSettings, removeAiOfficeHooks, userSettingsPath, writeJsonAtomicSync } from './user-hooks.mjs';

const target = userSettingsPath();
const fail = (msg) => {
  console.error(`Gagal: ${msg}`);
  process.exit(1);
};

let current;
try {
  current = readSettings(target);
} catch (e) {
  if (e instanceof SettingsError) fail(`${target} ${e.message}. Tidak ada yang ditulis; perbaiki file itu dulu.`);
  throw e;
}
if (current.text === null) {
  console.log(`${target} tidak ada. Tidak ada yang perlu dilepas.`);
  process.exit(0);
}

const { settings, removed } = removeAiOfficeHooks(current.settings, PROJECT_DIR);
if (!removed) {
  console.log(`Tidak ada hook AI Office di ${target}. Tidak ada perubahan.`);
  process.exit(0);
}
try {
  const backup = backupFile(target);
  writeJsonAtomicSync(target, settings);
  console.log(`${removed} hook AI Office dilepas dari ${target}.`);
  console.log(`Backup: ${backup}`);
} catch (e) {
  fail(`tidak bisa menulis ${target} (${e.code ?? e.message}).`);
}
