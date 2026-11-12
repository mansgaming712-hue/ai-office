#!/usr/bin/env node
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 20.12)
// Uji asap runtime: nyalakan server di port bebas (mode lokal, 127.0.0.1), tunggu GET /api/health
// menjawab {"ok":true}, lalu matikan. Hanya butuh dependensi produksi (npm ci --omit=dev), jadi bisa
// dijalankan di Node 20.12 yang belum cukup baru untuk vite/vitest. Dipakai oleh CI; tidak menyentuh port 3000.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { checkHealth } from './autostart.mjs';

const SERVER = fileURLToPath(new URL('../server/index.js', import.meta.url));
const TIMEOUT_MS = 20000;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const env = { ...process.env, PORT: String(port), HOST: '127.0.0.1' };
for (const k of Object.keys(env)) if (k.startsWith('AI_OFFICE_')) delete env[k];

const child = spawn(process.execPath, [SERVER], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = '';
for (const stream of [child.stdout, child.stderr]) stream.on('data', (c) => { if (output.length < 8192) output += c; });
let exited = null;
child.on('exit', (code) => { exited = code; });

let ok = false;
const deadline = Date.now() + TIMEOUT_MS;
while (Date.now() < deadline && exited === null) {
  if (await checkHealth(port, 1000)) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 250));
}
child.kill();

if (ok) {
  console.log(`smoke OK: server menjawab di 127.0.0.1:${port} (Node ${process.versions.node})`);
  process.exit(0);
}
console.error(`smoke GAGAL: server ${exited === null ? 'tidak menjawab dalam batas waktu' : `berhenti dengan kode ${exited}`}.`);
console.error(output.trim());
process.exit(1);
