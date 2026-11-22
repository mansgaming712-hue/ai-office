#!/usr/bin/env node
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
// Mode pengembangan UI: `npm run dev`. Menjalankan server event (port 3000) dan Vite dev server (port 5173).
// Port 5173 hanya dibuka di mode ini: server dijalankan dengan AI_OFFICE_DEV_ORIGINS yang memuat
// http://localhost:5173 dan http://127.0.0.1:5173 (digabung dengan nilai milik pengguna, dari env atau .env).
// Produksi (npm start / serve / autostart / deploy) tidak pernah menerima Origin itu kecuali env diset sendiri.
// Ctrl+C mematikan kedua proses.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { t } from '../shared/i18n.js';
import { loadProjectEnv } from '../server/loadEnv.js';

export const DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173'];

/** Nilai AI_OFFICE_DEV_ORIGINS untuk server: origin dev bawaan + nilai pengguna, tanpa duplikat. */
export function devOriginsEnv(existing = '') {
  const user = String(existing ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...DEV_ORIGINS, ...user])].join(',');
}

/** Env untuk proses server dev (env asal tidak diubah). */
export function serverEnv(env = process.env) {
  return { ...env, AI_OFFICE_DEV_ORIGINS: devOriginsEnv(env.AI_OFFICE_DEV_ORIGINS) };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function runDev() {
  loadProjectEnv(); // supaya AI_OFFICE_DEV_ORIGINS di .env ikut tergabung
  const env = serverEnv();
  const viteBin = join(dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const children = [
    { name: 'server', proc: spawn(process.execPath, [resolve(ROOT, 'server/index.js')], { cwd: ROOT, env, stdio: 'inherit' }) },
    { name: 'vite', proc: spawn(process.execPath, [viteBin], { cwd: ROOT, env: process.env, stdio: 'inherit' }) },
  ];
  let stopping = false;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    for (const c of children) if (c.proc.exitCode === null && !c.proc.killed) c.proc.kill();
    setTimeout(() => process.exit(code), 3000).unref();
    Promise.all(children.map((c) => new Promise((done) => (c.proc.exitCode !== null ? done() : c.proc.once('exit', done))))).then(() => process.exit(code));
  };
  for (const c of children) {
    c.proc.on('error', (e) => {
      console.error(t('dev.exited', { name: c.name, reason: e.code ?? e.message }));
      stop(1);
    });
    c.proc.on('exit', (code, signal) => {
      if (stopping) return;
      console.error(t('dev.exited', { name: c.name, reason: signal ?? `exit ${code}` }));
      stop(code || 1);
    });
  }
  process.on('SIGINT', () => stop(130));
  process.on('SIGTERM', () => stop(143));
  console.log(t('dev.ready', { port: env.PORT ?? 3000 }));
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) runDev();
