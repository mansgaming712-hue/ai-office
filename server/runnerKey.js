// Runner key: rahasia lokal yang membuktikan bahwa pemanggil endpoint runner/demo/file tugas adalah
// pemilik komputer ini (mode lokal tanpa token). Tanpa ini, akun atau proses lokal lain yang bisa
// menjangkau 127.0.0.1 bisa menyuruh Claude Code bekerja atas nama pemilik.
//
//   - 32 byte acak, base64url (43 karakter), disimpan di ~/.ai-office/runner-key
//     (env AI_OFFICE_RUNNER_KEY_FILE mengganti path; dipakai uji).
//   - Dibuat atomik: ditulis ke file sementara (flag wx, mode 0600) lalu di-link ke path akhir, sehingga
//     dua proses yang berlomba tidak pernah saling menimpa dan pembaca tidak pernah melihat file setengah jadi.
//   - POSIX: folder 0700, file 0600 (mode yang terlalu longgar diperbaiki). Windows: bit mode tidak
//     bermakna; file ada di profil pengguna (ACL bawaan profil membatasi akses ke pemilik).
//   - Nilai key tidak pernah dicetak ke log, tidak pernah dikirim ke proses anak runner.
import { randomBytes } from 'node:crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const RUNNER_KEY_HEADER = 'x-ai-office-key';
export const RUNNER_KEY_RE = /^[A-Za-z0-9_-]{43}$/;

export function runnerKeyPath(env = process.env, home = homedir()) {
  const v = typeof env.AI_OFFICE_RUNNER_KEY_FILE === 'string' ? env.AI_OFFICE_RUNNER_KEY_FILE.trim() : '';
  return v ? resolve(v) : join(home, '.ai-office', 'runner-key');
}

function readKey(file) {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return RUNNER_KEY_RE.test(key) ? key : null;
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function tightenMode(file) {
  if (process.platform === 'win32') return;
  try {
    if ((statSync(file).mode & 0o077) !== 0) chmodSync(file, 0o600);
  } catch {
    // tidak kritis: key tetap dibaca
  }
}

/**
 * Baca key; bila belum ada dan `create` true, buat. Mengembalikan string key.
 * Melempar Error bila file ada tetapi tidak bisa dibaca atau tidak bisa dibuat.
 */
export function loadRunnerKey({ file = runnerKeyPath(), create = true } = {}) {
  const existing = readKey(file);
  if (existing) {
    tightenMode(file);
    return existing;
  }
  if (!create) return null;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('base64url');
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, `${key}\n`, { flag: 'wx', mode: 0o600 });
  try {
    try {
      linkSync(tmp, file); // atomik; gagal EEXIST bila proses lain sudah membuatnya
      return key;
    } catch (e) {
      if (e.code === 'EEXIST') {
        const other = readKey(file);
        if (other) return other;
        throw new Error('runner key file exists but is invalid');
      }
      // Filesystem tanpa hard link: tulis langsung (wx = tidak menimpa).
      try {
        writeFileSync(file, `${key}\n`, { flag: 'wx', mode: 0o600 });
        return key;
      } catch (e2) {
        if (e2.code === 'EEXIST') {
          const other = readKey(file);
          if (other) return other;
        }
        throw e2;
      }
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // sudah hilang
    }
  }
}
