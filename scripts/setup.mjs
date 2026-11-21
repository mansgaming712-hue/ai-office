#!/usr/bin/env node
import '../server/requireNode.js'; // paling awal: cek versi Node (minimal 22.12)
// Satu perintah pasang: npm run setup
//   1. cek versi Node         2. npm ci            3. npm run build
//   4. npm run agents:install 5. npm run hooks:install-user
//   6. deteksi Claude Code CLI, cetak status dan langkah berikutnya
// Opsi:
//   --no-claude  lewati langkah 4-6 (pemasangan agen, hook, dan deteksi CLI)
//   --dry-run    cetak langkahnya saja; tidak ada yang dijalankan
// Gagal di langkah mana pun = pesan jelas dan exit bukan 0.
// Perintah dijalankan lewat spawn TANPA shell bila mungkin (node + npm-cli.js); hanya bila npm-cli.js tidak
// ditemukan di Windows dipakai npm.cmd dengan shell, dan argumennya konstanta (tidak ada masukan pengguna).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t } from '../shared/i18n.js';
import { RISKY_EXIT_CODE } from './agent-files.mjs';
import { discoverDivisions, divisionsDirFromEnv, riskyPluginAgents } from '../server/divisions.js';
import { nodeVersionProblem } from '../server/nodeVersion.js';
import { detectVersion, findClaude } from '../server/runner.js';

export const PROJECT_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)));

export function parseArgs(argv) {
  const out = { noClaude: false, dryRun: false, help: false, error: null };
  for (const a of argv) {
    if (a === '--no-claude') out.noClaude = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.error = t('setup.unknownOpt', { a });
  }
  return out;
}

/** Cara menjalankan npm: { command, prefix, shell }. Argumen perintah ditambahkan setelah `prefix`. */
export function npmInvocation({ env = process.env, platform = process.platform, execPath = process.execPath, exists = existsSync } = {}) {
  const fromEnv = typeof env.npm_execpath === 'string' ? env.npm_execpath : '';
  if (/\.(?:c|m)?js$/i.test(fromEnv) && exists(fromEnv)) return { command: execPath, prefix: [fromEnv], shell: false };
  const beside = [
    join(dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), // Windows
    join(dirname(execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), // macOS/Linux
  ].find((p) => exists(p));
  if (beside) return { command: execPath, prefix: [beside], shell: false };
  // Node ≥ 22 menolak spawn .cmd tanpa shell di Windows; argumen di sini konstanta.
  return platform === 'win32' ? { command: 'npm.cmd', prefix: [], shell: true } : { command: 'npm', prefix: [], shell: false };
}

/** Jalankan perintah dengan stdio diwariskan. Mengembalikan { status, error }. */
export function defaultRun(command, args, { cwd, shell = false, env = process.env } = {}) {
  return new Promise((resolveRun) => {
    let child;
    try {
      child = spawn(command, args, { cwd, shell, env, stdio: 'inherit', windowsHide: true });
    } catch (error) {
      resolveRun({ status: null, error });
      return;
    }
    child.on('error', (error) => resolveRun({ status: null, error }));
    child.on('close', (status) => resolveRun({ status, error: null }));
  });
}

async function defaultDetect(env) {
  const bin = findClaude({ env });
  if (!bin) return { found: false, version: null };
  const version = await detectVersion(bin, { env });
  return version ? { found: true, version } : { found: false, version: null };
}

/**
 * Jalankan setup. Semua ketergantungan bisa disuntikkan (untuk uji): env, platform, run, detect, log, err,
 * nodeVersion, projectDir, npm. Mengembalikan kode keluar.
 */
export async function runSetup(argv = process.argv.slice(2), opts = {}) {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((m) => console.log(m));
  const err = opts.err ?? ((m) => console.error(m));
  const run = opts.run ?? defaultRun;
  const detect = opts.detect ?? (() => defaultDetect(env));
  const projectDir = opts.projectDir ?? PROJECT_DIR;
  const npm = opts.npm ?? npmInvocation({ env, platform: opts.platform });
  const args = parseArgs(argv);
  if (args.help) {
    log(t('setup.usage'));
    return 0;
  }
  if (args.error) {
    err(`${args.error}\n${t('setup.usage')}`);
    return 2;
  }

  const npmStep = (id, npmArgs) => ({ id, label: `npm ${npmArgs.join(' ')}`, args: npmArgs });
  const steps = [
    { id: 'node' },
    npmStep('install', ['ci']),
    npmStep('build', ['run', 'build']),
    ...(args.noClaude ? [] : [npmStep('agents', ['run', 'agents:install']), npmStep('hooks', ['run', 'hooks:install-user']), { id: 'claude' }]),
  ];

  log(t('setup.intro'));
  if (args.dryRun) log(t('setup.dryRun'));
  let claude = null;
  let riskyStatus = 0; // agents:install melaporkan agen plugin berisiko yang dilewati: setup lanjut, tapi diringkas di akhir
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const name = t(`setup.s.${step.id}`);
    log(`\n${t('setup.step', { n: i + 1, total: steps.length, name })}`);
    const fail = (reason) => {
      err(t('setup.failed', { name, reason }));
      return 1;
    };
    if (step.id === 'node') {
      const version = opts.nodeVersion ?? process.versions.node;
      const problem = nodeVersionProblem(version);
      if (problem) {
        err(problem);
        return fail(`Node.js v${version}`);
      }
      log(t('setup.nodeOk', { version }));
      continue;
    }
    if (step.id === 'claude') {
      if (args.dryRun) {
        log(t('setup.dryStep', { cmd: 'claude --version' }));
        continue;
      }
      claude = await detect();
      log(claude.found ? t('setup.claudeFound', { version: claude.version }) : t('setup.claudeMissing'));
      continue;
    }
    if (args.dryRun) {
      log(t('setup.dryStep', { cmd: step.label }));
      continue;
    }
    const r = await run(npm.command, [...npm.prefix, ...step.args], { cwd: projectDir, shell: npm.shell, env });
    if (r.error) return fail(t('setup.spawnError', { code: r.error.code ?? r.error.message }));
    if (step.id === 'agents' && r.status === RISKY_EXIT_CODE) {
      riskyStatus = RISKY_EXIT_CODE;
      continue;
    }
    if (r.status !== 0) return fail(t('setup.exitCode', { code: r.status }));
  }

  log(`\n${t('setup.done')}`);
  if (args.noClaude) log(t('setup.skipClaude'));
  log(t('setup.next'));
  log(t('setup.next1'));
  log(t('setup.next2'));
  log(t('setup.next3'));
  if (args.noClaude) log(t('setup.nextNoClaude'));
  if (riskyStatus) {
    const skipped = (opts.riskyAgents ?? (() => riskyPluginAgents(discoverDivisions({ dir: divisionsDirFromEnv(env) }))))();
    err(`
${t('setup.agentsRisky', { n: skipped.length, names: skipped.map((a) => a.worker).join(', ') || '?' })}`);
    return riskyStatus;
  }
  return 0;
}

function isDirectRun() {
  try {
    return Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isDirectRun()) process.exitCode = await runSetup();
