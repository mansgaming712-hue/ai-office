#!/usr/bin/env node
// Pasang hook AI Office di settings Claude Code level user (default ~/.claude/settings.json), supaya
// semua sesi Claude Code (dari folder mana pun) mengirim event ke animasi kantor.
//   npm run hooks:install-user
//   AI_OFFICE_USER_SETTINGS=<path>  target lain (untuk uji; jangan arahkan test ke file asli)
// Merge (tidak menimpa), idempoten, backup settings.json.bak-YYYYMMDD-HHMMSS sebelum menulis, tulis
// atomik. JSON rusak = tidak menulis apa pun, keluar dengan kode 1. Lihat scripts/user-hooks.mjs.
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
import { t } from '../shared/i18n.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  PROJECT_DIR, SettingsError, backupFile, hookCommand, installAiOfficeHooks, projectProblem, readSettings,
  userSettingsPath, writeJsonAtomicSync,
} from './user-hooks.mjs';

const target = userSettingsPath();
const fail = (msg) => {
  console.error(t('hooks.fail', { msg }));
  process.exit(1);
};

const problem = projectProblem(PROJECT_DIR);
if (problem) fail(problem);

let current;
try {
  current = readSettings(target);
} catch (e) {
  if (e instanceof SettingsError) fail(t('hooks.badSettings', { target, reason: e.message }));
  throw e;
}

const command = hookCommand();
const { settings, changed } = installAiOfficeHooks(current.settings, { command });
if (!changed) {
  console.log(t('hooks.already', { target }));
  process.exit(0);
}

try {
  let backup = null;
  if (current.text !== null) backup = backupFile(target);
  else mkdirSync(dirname(target), { recursive: true });
  writeJsonAtomicSync(target, settings);
  console.log(t('hooks.installed', { target }));
  console.log(backup ? t('hooks.backup', { backup }) : t('hooks.noBackup'));
  console.log(t('hooks.command', { command }));
  console.log(t('hooks.events'));
  console.log(t('hooks.takesEffect'));
} catch (e) {
  fail(t('hooks.writeFail', { target, code: e.code ?? e.message }));
}
