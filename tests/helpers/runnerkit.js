// Helper test runner/demo (bukan file test). Server dijalankan di dalam proses test (port 0) dengan:
//   - CLI tiruan tests/fixtures/fake-claude.mjs (AI_OFFICE_CLAUDE_BIN), tidak pernah `claude` sungguhan;
//   - folder output, runner key, dan HOME di folder sementara (tidak menyentuh ~/.claude atau ~/.ai-office asli);
//   - hook "belum terpasang" kecuali test meminta lain.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSON_HEADERS, cleanEnv, http, sleep, startApp } from './testkit.js';

export const FAKE_CLAUDE = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url));
export const KEY = 'k'.repeat(43);

/** Folder sementara baru; `cleanup()` menghapusnya. */
export function tempDir(prefix = 'ai-office-rt-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Mulai server uji dengan runner. `mode` = FAKE_CLAUDE_MODE. `opts`: opsi createAiOfficeServer tambahan
 * (mis. token, runnerKey, runnerEnabled, host), `env` (tambahan env runner), `task` (taskOptions).
 */
export async function startRunnerApp({ mode = 'success', opts = {}, env = {}, task = {}, bin = FAKE_CLAUDE } = {}) {
  const tmp = tempDir();
  const outputDir = join(tmp.dir, 'output');
  const logFile = join(tmp.dir, 'fake-claude.json');
  mkdirSync(tmp.dir, { recursive: true });
  const taskEnv = cleanEnv({
    HOME: tmp.dir,
    USERPROFILE: tmp.dir,
    AI_OFFICE_USER_SETTINGS: join(tmp.dir, 'settings.json'),
    AI_OFFICE_CLAUDE_BIN: bin,
    FAKE_CLAUDE_MODE: mode,
    FAKE_CLAUDE_LOG: logFile,
    AI_OFFICE_RUNNER_KEY_FILE: join(tmp.dir, 'runner-key'),
    AI_OFFICE_RUNNER_SECRET_PROBE: 'must-not-reach-child',
    ...env,
  });
  const srv = await startApp({
    runnerKey: KEY,
    taskOptions: { outputDir, env: taskEnv, hooksInstalled: () => false, demoSpeed: 400, ...task },
    ...opts,
  });
  const headers = (extra = {}) => ({ 'X-AI-Office-Key': KEY, ...extra });
  const api = (path, { method = 'GET', body, key = KEY, headers: h = {} } = {}) =>
    http(srv.port, path, {
      method,
      headers: { ...(key ? { 'X-AI-Office-Key': key } : {}), ...(body !== undefined ? JSON_HEADERS : {}), ...h },
      body,
    });
  const fakeLog = () => JSON.parse(readFileSync(logFile, 'utf8'));
  /** Tunggu CLI tiruan menulis log (pid/cucu) secara utuh. */
  const waitFakeLog = (opts) => waitFor(() => fakeLog(), { what: 'log CLI tiruan', ...opts });
  /** Tunggu sampai status tugas bukan "running". */
  async function waitDone(id, { timeoutMs = 10000, key = KEY } = {}) {
    const t0 = Date.now();
    for (;;) {
      const r = await api(`/api/tasks/${id}`, { key });
      if (r.json?.task && r.json.task.status !== 'running') return r.json.task;
      if (Date.now() - t0 > timeoutMs) throw new Error(`tugas ${id} belum selesai: ${r.body}`);
      await sleep(40);
    }
  }
  return { ...srv, tmp, outputDir, logFile, headers, api, fakeLog, waitFakeLog, waitDone, close: async () => { await srv.close(); tmp.cleanup(); } };
}

/** Kumpulkan event dari riwayat server (ditambah pesan WebSocket bila perlu). */
export const eventsOf = (srv, id) => srv.app.history.filter((e) => e.task === id);

/** Tunggu sampai `cond()` truthy (polling), bukan jeda tetap: deterministik saat mesin sibuk. */
export async function waitFor(cond, { timeoutMs = 20000, stepMs = 25, what = 'kondisi' } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await cond();
    } catch {
      v = false; // mis. file log belum ada atau baru separuh tertulis
    }
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor: ${what} tidak terpenuhi dalam ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}

/** Proses `pid` masih hidup? */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
