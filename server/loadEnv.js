// Muat file .env di root proyek (bila ada) ke process.env, sebelum modul lain membaca variabelnya.
// Variabel yang sudah ada di environment TIDAK ditimpa, jadi systemd/shell/settings.json tetap menang.
// File .env tidak ikut ke git (.gitignore); salin dari .env.example lalu isi.
// Node < 20.12 tidak punya process.loadEnvFile: .env dilewati diam-diam (pakai env biasa).
// Isi .env tidak pernah dicetak; kalau formatnya rusak, hanya pesan singkat ke stderr (kecuali `quiet`).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url));

export function loadProjectEnv({ file = ENV_FILE, quiet = false } = {}) {
  if (typeof process.loadEnvFile !== 'function' || !existsSync(file)) return false;
  try {
    process.loadEnvFile(file);
    return true;
  } catch (e) {
    if (!quiet) console.error(`AI Office: .env tidak bisa dibaca (${e.code ?? 'format tidak valid'}), dilewati.`);
    return false;
  }
}
