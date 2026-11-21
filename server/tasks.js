// Layanan tugas: menjalankan tugas CEO lewat Claude Code (server/runner.js) atau memutar demo (server/demo.js),
// dengan satu slot aktif, folder hasil (server/outputStore.js), event ke animasi, dan pesan WebSocket "task".
//
// Event: saat mulai `assign` ceo → manager (pesan = judul); saat selesai `report` manager → ceo (ringkasan);
// saat gagal/dibatalkan `blocked` manager → ceo. Semua membawa `task: <id>`. Bila hook AI Office belum
// terpasang di settings Claude Code level user, event subagent (assign/working/done) dipancarkan dari
// parser stream-json; bila sudah terpasang, hook yang mengirimnya (tidak dobel).
import { appendFileSync } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { makeEvent, stripControl } from '../shared/events.js';
import { extractText, parseStatus, summarize } from '../shared/hookMapping.js';
import { detectLang, LANGS, t } from '../shared/i18n.js';
import { playDemo } from './demo.js';
import { createOutputStore, slugify } from './outputStore.js';
import {
  MAX_LOG_BYTES, RunnerConfigError, buildArgs, childEnv, createAgentTracker, createLineParser, detectVersion, findClaude,
  killTree, killTreeSync, spawnPlan, timeoutFromEnv,
} from './runner.js';
import { PROJECT_DIR, isAiOfficeCommand, readSettings, userSettingsPath } from '../scripts/user-hooks.mjs';

export const MAX_TASK_CHARS = 2000;
const DETECT_TTL_MS = 30_000;

export class TaskError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Hook AI Office terpasang di settings Claude Code level user? Tidak pernah melempar. */
export function userHooksInstalled(env = process.env) {
  try {
    const { settings } = readSettings(userSettingsPath(env));
    for (const groups of Object.values(settings.hooks ?? {})) {
      for (const g of groups) {
        if (g && Array.isArray(g.hooks) && g.hooks.some((h) => h && isAiOfficeCommand(h.command, PROJECT_DIR))) return true;
      }
    }
  } catch {
    // settings hilang atau rusak: anggap belum terpasang
  }
  return false;
}

const TEMPLATE_URLS = {
  id: new URL('./templates/task-claude.md', import.meta.url),
  en: new URL('./templates/task-claude.en.md', import.meta.url),
};
export const MAX_RESULT_BYTES = 1024 * 1024;

/** Judul satu baris dari teks tugas (maks 80 karakter). */
export function titleOf(text) {
  // Buang kontrol/bidi (ESC, DEL, U+202A-202E, ...) dan pemisah baris Unicode U+2028/2029.
  const line = String(text).split(/\r?\n/).map((l) => stripControl(l).replace(/[\u2028\u2029]/g, ' ').trim()).find(Boolean) ?? '';
  const clean = line.replace(/\s+/g, ' ');
  return clean.length > 80 ? `${clean.slice(0, 79).trimEnd()}…` : clean;
}

/** Ringkasan satu baris untuk laporan: baris judul markdown dilewati. */
export function summaryOf(text) {
  const body = String(text ?? '').split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).join('\n');
  return summarize(body) || summarize(text);
}

export function createTaskService({
  outputDir,
  publish,
  broadcast = () => {},
  getPort,
  enabled = true,
  env = process.env,
  log = () => {},
  timeoutMs,
  hooksInstalled = () => userHooksInstalled(env),
  demoSpeed = 1,
  now = () => new Date(),
} = {}) {
  const store = createOutputStore({ dir: outputDir });
  const effectiveTimeout = () => timeoutMs ?? timeoutFromEnv(env);
  let active = null; // { id, title, startedAt, kind, cancel(): Promise<void>, finished: Promise<void> }
  let reserved = false;
  let detected = null; // { at, value: { bin, version } | null }
  let detecting = null;
  let shuttingDown = false;

  const eventsUrl = () => `http://127.0.0.1:${getPort?.() ?? 3000}/api/events`;

  async function detect() {
    const t0 = Date.now();
    if (detected && t0 - detected.at < DETECT_TTL_MS) return detected.value;
    if (detecting) return detecting;
    detecting = (async () => {
      const bin = findClaude({ env });
      let value = null;
      if (bin) {
        const version = await detectVersion(bin, { env });
        if (version) value = { bin, version };
      }
      detected = { at: Date.now(), value };
      return value;
    })().finally(() => {
      detecting = null;
    });
    return detecting;
  }

  const activeInfo = () => (active ? { id: active.id, title: active.title, startedAt: active.startedAt, kind: active.kind } : null);

  /** { available, reason, version, active } untuk GET /api/runner. `showActive`: sertakan detail tugas aktif. */
  async function status({ showActive = true } = {}) {
    let configOk = true;
    try {
      buildArgs(env);
    } catch (e) {
      if (!(e instanceof RunnerConfigError)) throw e;
      configOk = false;
    }
    const found = enabled && configOk ? await detect() : null;
    let reason = null;
    if (!enabled || !configOk) reason = 'disabled';
    else if (!found) reason = 'cli-not-found';
    else if (active || reserved) reason = 'busy';
    return {
      available: reason === null,
      reason,
      version: found?.version ?? null,
      active: showActive ? activeInfo() : null,
    };
  }

  function normLang(lang) {
    if (lang === undefined || lang === null) return detectLang(env);
    if (typeof lang !== 'string' || !LANGS.includes(lang)) return null;
    return lang;
  }

  function validateText(text, lang) {
    if (typeof text !== 'string') throw new TaskError(400, t('runner.err.badText', {}, lang), 'bad-text');
    const trimmed = text.trim();
    // eslint-disable-next-line no-control-regex
    if (!trimmed || /\x00/.test(trimmed)) throw new TaskError(400, t('runner.err.badText', {}, lang), 'bad-text');
    if (trimmed.length > MAX_TASK_CHARS) throw new TaskError(400, t('runner.err.textTooLong', { max: MAX_TASK_CHARS }, lang), 'too-long');
    return trimmed;
  }

  const emitEvent = (type, from, to, message, taskId, source = 'api') => {
    try {
      publish([makeEvent(type, from, to, message, { source, task: taskId })]);
    } catch (e) {
      log(`[task] event gagal (${e.message})`);
    }
  };

  const taskMsg = (rec, status, summary) => {
    const task = { id: rec.id, title: rec.title, status, kind: rec.kind };
    if (summary !== undefined) task.summary = summary;
    try {
      broadcast({ kind: 'task', task });
    } catch {
      // klien WebSocket bermasalah tidak boleh menghentikan tugas
    }
  };

  /** Pesan "task" + meta di disk + lepas slot, lalu event. Dipanggil tepat sekali per tugas. */
  async function finalize(rec, status, { summary = '', eventType, eventMessage }) {
    const finishedAt = now().toISOString();
    await store
      .writeMeta(rec.id, { id: rec.id, title: rec.title, kind: rec.kind, lang: rec.lang, status, startedAt: rec.startedAt, finishedAt, summary })
      .catch((e) => log(`[task] meta gagal (${e.code ?? e.message})`));
    if (active?.id === rec.id) active = null;
    reserved = false;
    taskMsg(rec, status, summary);
    if (eventType) emitEvent(eventType, 'manager', 'ceo', eventMessage, rec.id, rec.kind === 'demo' ? 'sim' : 'api');
    log(`[task] ${rec.id} ${status}`);
  }

  async function reserveSlot(lang) {
    if (shuttingDown || active || reserved) throw new TaskError(409, t('runner.err.busy', {}, lang), 'busy');
    reserved = true;
  }

  // ---------------------------------------------------------------- tugas sungguhan
  async function startTask({ text, lang } = {}) {
    const l = normLang(lang);
    if (l === null) throw new TaskError(400, t('runner.err.badLang'), 'bad-lang');
    const body = validateText(text, l);
    if (!enabled) throw new TaskError(403, t('runner.err.disabled', {}, l), 'disabled');
    let args;
    try {
      args = buildArgs(env);
    } catch (e) {
      if (e instanceof RunnerConfigError) throw new TaskError(503, t('runner.err.config', { detail: e.detail ?? e.code }, l), 'config');
      throw e;
    }
    if (shuttingDown || active || reserved) throw new TaskError(409, t('runner.err.busy', {}, l), 'busy');
    const found = await detect();
    if (!found) throw new TaskError(503, t('runner.err.cliNotFound', {}, l), 'cli-not-found');
    await reserveSlot(l);

    let plan;
    let rec;
    try {
      plan = spawnPlan(found.bin, args);
      const title = titleOf(body);
      const started = now();
      const { id, dir } = await store.createTaskDir({ slug: slugify(title), now: started });
      rec = { id, dir, title, kind: 'task', lang: l, startedAt: started.toISOString() };
      await writeTaskFiles(rec, body);
      await store.writeMeta(id, { id, title, kind: 'task', lang: l, status: 'running', startedAt: rec.startedAt, finishedAt: null, summary: '' });
    } catch (e) {
      reserved = false;
      if (e instanceof RunnerConfigError) throw new TaskError(503, t('runner.err.config', { detail: e.detail ?? e.code }, l), 'config');
      log(`[task] gagal menyiapkan folder (${e.code ?? e.message})`);
      throw new TaskError(500, t('runner.err.startFailed', {}, l), 'start-failed');
    }
    launch(rec, plan, body, l);
    return { id: rec.id, title: rec.title, status: 'running' };
  }

  async function writeTaskFiles(rec, body) {
    const tpl = await readFile(TEMPLATE_URLS[rec.lang === 'en' ? 'en' : 'id'], 'utf8');
    const langName = rec.lang === 'id' ? 'Indonesia (id)' : 'English (en)';
    await writeFile(join(rec.dir, 'CLAUDE.md'), tpl.replaceAll('{{lang}}', langName));
    await writeFile(
      join(rec.dir, 'task.md'),
      `# Task: ${rec.title}\n\n- Date: ${rec.startedAt}\n- Language: ${rec.lang}\n\n## Text\n\n${body}\n`,
    );
  }

  function launch(rec, plan, body, lang) {
    const tr = (key, vars) => t(key, vars, lang);
    const trackAgents = !hooksInstalled();
    const logFile = join(rec.dir, 'run.log');
    let logBytes = 0;
    let truncated = false;
    const writeLog = (chunk) => {
      if (truncated) return;
      try {
        const buf = Buffer.from(chunk);
        if (logBytes + buf.length > MAX_LOG_BYTES) {
          const room = Math.max(0, MAX_LOG_BYTES - logBytes);
          appendFileSync(logFile, `${buf.subarray(0, room).toString('utf8')}\n[run.log truncated at ${MAX_LOG_BYTES} bytes]\n`);
          truncated = true;
          return;
        }
        appendFileSync(logFile, buf);
        logBytes += buf.length;
      } catch {
        truncated = true;
      }
    };

    const tracker = trackAgents ? createAgentTracker({ emit: (e) => publish([e]), taskId: rec.id, tr }) : null;
    let resultEvent = null;
    let lastAssistantText = '';
    const parser = createLineParser((ev) => {
      if (ev.type === 'result') resultEvent = ev;
      else if (ev.type === 'assistant' && !ev.parent_tool_use_id) {
        const txt = extractText(ev.message?.content?.filter?.((b) => b?.type === 'text'));
        if (txt) lastAssistantText = txt;
      }
      try {
        tracker?.handle(ev);
      } catch (e) {
        log(`[task] tracker gagal (${e.message})`);
      }
    });

    let stderrTail = '';
    let child;
    let finished = false;
    let cancelled = false;
    let timedOut = false;
    let timer = null;
    let safety = null;
    let resolveFinished;
    const finishedPromise = new Promise((r) => {
      resolveFinished = r;
    });
    const exitKill = () => killTreeSync(child?.pid);

    const done = async (code, spawnError) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(safety);
      process.off('exit', exitKill);
      parser.end();
      try {
        if (cancelled) {
          await finalize(rec, 'cancelled', { eventType: 'blocked', eventMessage: tr('runner.cancelled') });
        } else if (timedOut) {
          await finalize(rec, 'failed', { eventType: 'blocked', eventMessage: tr('runner.timeout', { min: Math.max(1, Math.round(effectiveTimeout() / 60000)) }) });
        } else if (spawnError) {
          await finalize(rec, 'failed', { eventType: 'blocked', eventMessage: tr('runner.spawnFailed') });
        } else if (code !== 0 || resultEvent?.is_error) {
          const why = summarize(stderrTail) || (typeof resultEvent?.result === 'string' ? summarize(resultEvent.result) : '');
          const base = tr('runner.failed', { code: code ?? '?' });
          await finalize(rec, 'failed', { eventType: 'blocked', eventMessage: why ? `${base} ${why}` : base });
        } else {
          const resultText = typeof resultEvent?.result === 'string' && resultEvent.result.trim() ? resultEvent.result : lastAssistantText;
          const resultPath = join(rec.dir, 'RESULT.md');
          const exists = await stat(resultPath).then((s) => s.isFile()).catch(() => false);
          if (!exists) await writeFile(resultPath, `${resultText.trim() || tr('runner.noResult')}\n`).catch(() => {});
          // RESULT.md ditulis model: batasi ukuran sebelum dibaca (hanya awal berkas dipakai untuk ringkasan).
          const size = exists ? await stat(resultPath).then((s) => s.size).catch(() => 0) : 0;
          const fileText = exists && size <= MAX_RESULT_BYTES ? await readFile(resultPath, 'utf8').catch(() => '') : exists ? '' : resultText;
          const summary = summaryOf(resultText || fileText) || tr('runner.doneDefault');
          const blocked = parseStatus(resultText) === 'blocked';
          await finalize(rec, 'done', { summary, eventType: blocked ? 'blocked' : 'report', eventMessage: summary });
        }
      } finally {
        resolveFinished();
      }
    };

    const cancel = async () => {
      if (finished) return;
      cancelled = true;
      await killTree(child?.pid, { child });
      // Jaring pengaman: bila 'close' tidak datang (proses menggantung), selesaikan paksa.
      safety = setTimeout(() => void done(null, false), 5000);
      safety.unref?.();
      await finishedPromise;
    };

    active = { id: rec.id, title: rec.title, startedAt: rec.startedAt, kind: 'task', cancel, finished: finishedPromise };
    reserved = false;
    taskMsg(rec, 'running');
    emitEvent('assign', 'ceo', 'manager', rec.title, rec.id);

    try {
      child = spawn(plan.command, plan.args, {
        ...plan.options,
        cwd: rec.dir,
        env: childEnv(env, eventsUrl()),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      log(`[task] spawn gagal (${e.code ?? e.message})`);
      void done(null, true);
      return;
    }
    process.on('exit', exitKill);
    child.on('error', (e) => {
      log(`[task] proses CLI error (${e.code ?? e.message})`);
      void done(null, true);
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      writeLog(chunk);
      parser.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      writeLog(`[stderr] ${chunk}${chunk.endsWith('\n') ? '' : '\n'}`);
      stderrTail = (stderrTail + chunk).slice(-2000);
    });
    child.on('close', (code) => void done(code, false));
    child.stdin.on('error', () => {}); // EPIPE bila CLI keluar sebelum membaca stdin
    // Teks tugas HANYA lewat stdin.
    child.stdin.end(`${tr('runner.prompt')}\n${body}\n`);
    timer = setTimeout(() => {
      timedOut = true;
      void killTree(child.pid, { child });
      safety = setTimeout(() => void done(null, false), 5000);
      safety.unref?.();
    }, effectiveTimeout());
    timer.unref?.();
  }

  // ---------------------------------------------------------------- demo
  async function startDemo({ lang } = {}) {
    const l = normLang(lang);
    if (l === null) throw new TaskError(400, t('runner.err.badLang'), 'bad-lang');
    if (!enabled) throw new TaskError(403, t('runner.err.disabled', {}, l), 'disabled');
    await reserveSlot(l);
    let rec;
    try {
      const title = t('demo.title', {}, l);
      const started = now();
      const { id, dir } = await store.createTaskDir({ slug: slugify(`demo ${title}`), now: started });
      rec = { id, dir, title, kind: 'demo', lang: l, startedAt: started.toISOString() };
      await store.writeMeta(id, { id, title, kind: 'demo', lang: l, status: 'running', startedAt: rec.startedAt, finishedAt: null, summary: '' });
    } catch (e) {
      reserved = false;
      log(`[demo] gagal menyiapkan folder (${e.code ?? e.message})`);
      throw new TaskError(500, t('runner.err.startFailed', {}, l), 'start-failed');
    }
    const ac = new AbortController();
    let resolveFinished;
    const finishedPromise = new Promise((r) => {
      resolveFinished = r;
    });
    active = {
      id: rec.id, title: rec.title, startedAt: rec.startedAt, kind: 'demo', finished: finishedPromise,
      cancel: async () => {
        ac.abort();
        await finishedPromise;
      },
    };
    reserved = false;
    taskMsg(rec, 'running');
    void (async () => {
      try {
        const out = await playDemo({
          lang: l,
          dir: rec.dir,
          title: rec.title,
          speed: demoSpeed,
          signal: ac.signal,
          emit: (type, from, to, message) => {
            try {
              publish([makeEvent(type, from, to, message, { source: 'sim', task: rec.id })]);
            } catch (e) {
              log(`[demo] event gagal (${e.message})`);
            }
          },
        });
        if (out.aborted) {
          await finalize(rec, 'cancelled', { eventType: 'blocked', eventMessage: t('runner.cancelled', {}, l) });
        } else {
          await finalize(rec, 'done', { summary: out.summary, eventType: 'report', eventMessage: out.summary });
        }
      } catch (e) {
        log(`[demo] gagal (${e.code ?? e.message})`);
        await finalize(rec, 'failed', { eventType: 'blocked', eventMessage: t('runner.failed', { code: '?' }, l) });
      } finally {
        resolveFinished();
      }
    })();
    return { id: rec.id, title: rec.title, status: 'running' };
  }

  // ---------------------------------------------------------------- batal, baca, berhenti
  async function cancel(id, lang) {
    if (!active || active.id !== id) throw new TaskError(404, t('runner.err.notRunning', {}, lang), 'not-running');
    await active.cancel();
    return { ok: true };
  }

  async function list() {
    return store.list(active?.id);
  }

  async function get(id) {
    return store.describe(id, active?.id, { withFiles: true });
  }

  async function shutdown() {
    shuttingDown = true;
    const a = active;
    if (!a) return;
    await Promise.race([a.cancel().catch(() => {}), new Promise((r) => setTimeout(r, 6000).unref?.())]);
    await Promise.race([a.finished, new Promise((r) => setTimeout(r, 2000).unref?.())]);
  }

  return {
    store,
    enabled,
    status,
    startTask,
    startDemo,
    cancel,
    list,
    get,
    readFile: (id, rel) => store.readTaskFile(id, rel),
    shutdown,
    get active() {
      return activeInfo();
    },
  };
}
