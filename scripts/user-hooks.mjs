// Logika bersama pemasang/pelepas hook AI Office di settings Claude Code level user
// (~/.claude/settings.json). Dipakai scripts/install-user-hooks.mjs dan scripts/uninstall-user-hooks.mjs.
//
// Prinsip:
//   - merge, tidak menimpa: key lain dan hook lain milik user dibiarkan apa adanya;
//   - entri AI Office dikenali dari command yang memuat path absolut hooks/send-event.mjs proyek ini;
//   - idempoten: entri lama AI Office dibuang dulu lalu dipasang ulang, jadi tidak pernah dobel;
//   - JSON rusak atau bentuk tak terduga = berhenti tanpa menulis apa pun;
//   - backup settings.json.bak-YYYYMMDD-HHMMSS sebelum menulis, lalu tulis atomik (tmp lalu rename).
import { constants, copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const HOOK_TIMEOUT_S = 3;

export const toSlash = (p) => String(p).replace(/\\/g, '/');

/** Target settings: env AI_OFFICE_USER_SETTINGS (untuk uji) atau ~/.claude/settings.json. */
export function userSettingsPath(env = process.env) {
  const v = typeof env.AI_OFFICE_USER_SETTINGS === 'string' ? env.AI_OFFICE_USER_SETTINGS.trim() : '';
  return v ? resolve(v) : join(homedir(), '.claude', 'settings.json');
}

/** Alasan menolak memasang dari folder proyek ini, atau null. */
export function projectProblem(projectDir = PROJECT_DIR) {
  const p = String(projectDir);
  if (/["\r\n]/.test(p)) return 'Path proyek memuat tanda kutip atau baris baru; hook tidak dipasang.';
  // Command dijalankan lewat shell (cmd atau bash): karakter yang bisa diekspansi di dalam tanda kutip
  // ganda ($, backtick, %, !) ditolak supaya path folder tidak bisa menyisipkan perintah.
  if (/[$`%!]/.test(p)) return 'Path proyek memuat karakter $ ` % atau ! yang bisa diekspansi shell; pindahkan proyek ke folder lain.';
  return null;
}

/** Path node yang dipakai command: process.execPath bila benar-benar node, selain itu "node". */
export function nodeCommand(execPath = process.execPath) {
  if (execPath && /^node(\.exe)?$/i.test(basename(execPath)) && !/["\r\n]/.test(execPath) && existsSync(execPath)) return toSlash(execPath);
  return 'node';
}

export const hookScriptPath = (projectDir = PROJECT_DIR) => toSlash(join(projectDir, 'hooks', 'send-event.mjs'));

/** Command hook: node (absolut bila bisa) + path absolut skrip, forward slash, berkutip. */
export function hookCommand({ projectDir = PROJECT_DIR, nodePath = nodeCommand() } = {}) {
  const node = nodePath === 'node' ? 'node' : `"${nodePath}"`;
  return `${node} "${hookScriptPath(projectDir)}"`;
}

/** Event dan matcher yang sama dengan blok hooks lama di .claude/settings.json proyek. */
export function desiredHooks(command) {
  const h = (extra = {}) => ({ type: 'command', command, timeout: HOOK_TIMEOUT_S, ...extra });
  return {
    SubagentStart: [{ hooks: [h()] }],
    SubagentStop: [{ hooks: [h()] }],
    PreToolUse: [
      { matcher: 'Agent|Task', hooks: [h()] },
      { matcher: '^(?!(Agent|Task)$).*', hooks: [h({ async: true })] },
    ],
    PostToolUse: [{ matcher: 'Agent|Task', hooks: [h()] }],
  };
}

/** Apakah command ini hook AI Office dari folder proyek `projectDir`. */
export function isAiOfficeCommand(command, projectDir = PROJECT_DIR) {
  if (typeof command !== 'string') return false;
  const norm = (s) => {
    const t = toSlash(s);
    return process.platform === 'win32' ? t.toLowerCase() : t;
  };
  return norm(command).includes(norm(hookScriptPath(projectDir)));
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export class SettingsError extends Error {}

/** Pastikan bentuk settings bisa di-merge dengan aman; melempar SettingsError bila tidak. */
function checkShape(settings) {
  if (!isPlainObject(settings)) throw new SettingsError('isi settings bukan objek JSON');
  if (settings.hooks === undefined) return;
  if (!isPlainObject(settings.hooks)) throw new SettingsError('"hooks" bukan objek');
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) throw new SettingsError(`"hooks.${event}" bukan array`);
  }
}

/**
 * Buang semua hook AI Office (proyek ini) dari settings. Grup yang jadi kosong karena itu ikut dibuang,
 * begitu juga event dan objek "hooks" yang jadi kosong. Grup/hook lain tidak disentuh.
 * @returns {{ settings: object, removed: number }} settings baru (salinan)
 */
export function removeAiOfficeHooks(settings, projectDir = PROJECT_DIR) {
  checkShape(settings);
  const out = structuredClone(settings);
  let removed = 0;
  if (!out.hooks) return { settings: out, removed };
  for (const event of Object.keys(out.hooks)) {
    const groups = out.hooks[event];
    const kept = [];
    for (const g of groups) {
      if (!isPlainObject(g) || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const hooks = g.hooks.filter((h) => !(isPlainObject(h) && isAiOfficeCommand(h.command, projectDir)));
      const n = g.hooks.length - hooks.length;
      removed += n;
      if (n === 0) kept.push(g);
      else if (hooks.length) kept.push({ ...g, hooks });
    }
    if (kept.length) out.hooks[event] = kept;
    else if (groups.length) delete out.hooks[event]; // jadi kosong karena entri AI Office
  }
  if (removed && Object.keys(out.hooks).length === 0) delete out.hooks;
  return { settings: out, removed };
}

/**
 * Pasang hook AI Office: buang entri lama AI Office, lalu tambahkan entri baru di akhir tiap event.
 * @returns {{ settings: object, changed: boolean }}
 */
export function installAiOfficeHooks(settings, { projectDir = PROJECT_DIR, command = hookCommand({ projectDir }) } = {}) {
  const { settings: out, removed } = removeAiOfficeHooks(settings, projectDir);
  const desired = desiredHooks(command);
  // Sudah terpasang persis (setiap grup yang diinginkan ada utuh, tanpa entri AI Office lain): tidak diubah,
  // walau user menaruh hook lain sesudahnya.
  const wanted = Object.values(desired).reduce((n, groups) => n + groups.reduce((m, g) => m + g.hooks.length, 0), 0);
  const present = Object.entries(desired).every(([event, groups]) =>
    groups.every((g) => (settings.hooks?.[event] ?? []).some((x) => JSON.stringify(x) === JSON.stringify(g))),
  );
  if (present && removed === wanted) return { settings: structuredClone(settings), changed: false };
  out.hooks ??= {};
  for (const [event, groups] of Object.entries(desired)) {
    out.hooks[event] = [...(out.hooks[event] ?? []), ...groups];
  }
  return { settings: out, changed: JSON.stringify(out) !== JSON.stringify(settings) };
}

/** Baca settings: { text: null } bila file belum ada; melempar SettingsError bila JSON rusak. */
export function readSettings(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { text: null, settings: {} };
    throw new SettingsError(`tidak bisa dibaca (${e.code ?? e.message})`);
  }
  const body = text.replace(/^\uFEFF/, '');
  if (!body.trim()) return { text, settings: {} };
  let settings;
  try {
    settings = JSON.parse(body);
  } catch (e) {
    throw new SettingsError(`JSON rusak (${e.message})`);
  }
  checkShape(settings);
  return { text, settings };
}

const pad = (n) => String(n).padStart(2, '0');
export const backupStamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Salin file ke <file>.bak-YYYYMMDD-HHMMSS (tidak pernah menimpa backup lain). Mengembalikan path backup. */
export function backupFile(file, now = new Date()) {
  const base = `${file}.bak-${backupStamp(now)}`;
  for (let i = 0; i < 100; i++) {
    const target = i ? `${base}-${i}` : base;
    try {
      copyFileSync(file, target, constants.COPYFILE_EXCL);
      return target;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('tidak bisa membuat nama file backup');
}

/** Tulis JSON secara atomik: file sementara di folder yang sama, lalu rename. */
export function writeJsonAtomicSync(file, data) {
  const tmp = join(dirname(file), `.${basename(file)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // file sementara mungkin belum terbuat
    }
    throw e;
  }
}
