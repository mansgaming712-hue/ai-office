#!/usr/bin/env node
// Lepas hook AI Office dari settings Claude Code level user (default ~/.claude/settings.json).
//   npm run hooks:uninstall-user
//   AI_OFFICE_USER_SETTINGS=<path>  target lain (untuk uji)
// Hanya entri AI Office (command yang memuat hooks/send-event.mjs proyek ini) yang dihapus; key dan hook
// lain tetap. Backup dulu, tulis atomik; JSON rusak = tidak menulis apa pun, kode keluar 1.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { t } from '../shared/i18n.js';
import { PROJECT_DIR, SettingsError, backupFile, readSettings, removeAiOfficeHooks, userSettingsPath, writeJsonAtomicSync } from './user-hooks.mjs';

const target = userSettingsPath();
const fail = (msg) => {
  console.error(t('hooks.fail', { msg }));
  process.exit(1);
};

let current;
try {
  current = readSettings(target);
} catch (e) {
  if (e instanceof SettingsError) fail(t('hooks.badSettings', { target, reason: e.message }));
  throw e;
}
if (current.text === null) {
  console.log(t('hooks.noFile', { target }));
  process.exit(0);
}

const { settings, removed } = removeAiOfficeHooks(current.settings, PROJECT_DIR);
if (!removed) {
  console.log(t('hooks.noneFound', { target }));
  process.exit(0);
}
try {
  const backup = backupFile(target);
  writeJsonAtomicSync(target, settings);
  console.log(t('hooks.removed', { n: removed, target }));
  console.log(t('hooks.backup', { backup }));
} catch (e) {
  fail(t('hooks.writeFail', { target, code: e.code ?? e.message }));
}
