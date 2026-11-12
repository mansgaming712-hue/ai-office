// Versi diam untuk hooks/send-event.mjs: hook tidak boleh mengganggu sesi Claude Code, jadi di Node
// yang terlalu lama hook berhenti tanpa output dan keluar dengan kode 0. Impor paling awal.
import { isNodeSupported } from './nodeVersion.js';

if (!isNodeSupported(process.versions.node)) process.exit(0);
