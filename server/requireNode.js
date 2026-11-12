// Impor modul ini PALING AWAL di titik masuk yang dijalankan manusia. Bila Node terlalu lama:
// pesan jelas ke stderr lalu exit 1 (modul-modul berikutnya tidak sempat dimuat).
// Sintaks lama saja (lihat nodeVersion.js). Hook Claude Code memakai requireNodeQuiet.js, bukan ini.
import { nodeVersionProblem } from './nodeVersion.js';

var problem = nodeVersionProblem(process.versions.node);
if (problem) {
  console.error(problem);
  process.exit(1);
}
