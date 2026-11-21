// Runner: menjalankan Claude Code headless (`claude -p --output-format stream-json`) sebagai manajer.
// Modul ini hanya berisi bagian tingkat rendah (deteksi CLI, argumen, spawn, bunuh pohon proses, parser
// stream-json). Koordinasi tugas (folder, status, event, batas satu tugas) ada di server/tasks.js.
//
// Keamanan:
//   - Argumen CLI hanya konstanta (atau dari env admin yang divalidasi ketat: AI_OFFICE_RUNNER_ALLOWED_TOOLS,
//     AI_OFFICE_RUNNER_EXTRA_ARGS). Teks tugas dikirim lewat STDIN, tidak pernah lewat argv.
//   - Tanpa shell: .exe/.js langsung; .cmd (Windows) lewat cmd.exe dengan baris perintah yang hanya berisi
//     path CLI (divalidasi tanpa karakter khusus cmd) dan argumen konstanta; .ps1 lewat powershell -File.
//   - Env anak mewarisi env pengguna (perlu untuk autentikasi Claude Code) kecuali AI_OFFICE_RUNNER*.
import { spawn, spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeEvent } from '../shared/events.js';
import { extractText, parseStatus, summarize } from '../shared/hookMapping.js';

// Sengaja TANPA Read/Write/Edit/Glob/Grep: aturan allow tanpa specifier membuka seluruh disk (prompt injection dari
// halaman web bisa membaca ~/.ssh, .env, runner-key atau menulis ke hooks/ dan server/). Baca/tulis di folder
// tugas tetap jalan lewat aturan bawaan Claude Code (Read/Grep/Glob di working directory) dan acceptEdits.
export const DEFAULT_TOOLS = ['Agent', 'WebSearch', 'WebFetch', 'TodoWrite'];
// Nilai ini dikirim sebagai satu argumen; `*` tidak di-expand shell karena tidak ada shell (lihat spawnPlan).
export const DISALLOWED_TOOLS = ['Bash', 'PowerShell', 'mcp__*'];
// Alat berkas tanpa specifier: bila diaktifkan lewat env, berlaku untuk seluruh disk.
export const BROAD_FILE_TOOLS = ['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'];
export const BASE_ARGS = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits'];
export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_LOG_BYTES = 5 * 1024 * 1024;
export const VERSION_TIMEOUT_MS = 5000;

const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const EXTRA_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9_.:=,@+-]{0,99}$|^--?[A-Za-z][A-Za-z0-9-]{0,62}(?:=[A-Za-z0-9_.:,@+-]{0,100})?$/;
// Flag yang melemahkan batas keamanan runner tidak boleh lewat EXTRA_ARGS.
const FORBIDDEN_EXTRA = /^--?(?:dangerously|allow-dangerously|permission|allowed-?tools|disallowed-?tools|tools|settings|mcp-config|add-dir|append-system-prompt|system-prompt|plugin-dir|input-format|output-format|print|p$|verbose)/i;

export class RunnerConfigError extends Error {
  constructor(code, detail) {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = detail;
  }
}

/** Daftar alat dari env (dipisah koma) atau default. Melempar RunnerConfigError bila ada nama tidak sah. */
export function allowedTools(env = process.env) {
  const raw = typeof env.AI_OFFICE_RUNNER_ALLOWED_TOOLS === 'string' ? env.AI_OFFICE_RUNNER_ALLOWED_TOOLS.trim() : '';
  if (!raw) return [...DEFAULT_TOOLS];
  const names = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (names.length === 0 || names.length > 40) throw new RunnerConfigError('bad-tools', 'AI_OFFICE_RUNNER_ALLOWED_TOOLS');
  for (const n of names) {
    if (!TOOL_NAME_RE.test(n)) throw new RunnerConfigError('bad-tools', 'AI_OFFICE_RUNNER_ALLOWED_TOOLS');
  }
  return [...new Set(names)];
}

/** Alat berkas tanpa specifier yang diaktifkan lewat AI_OFFICE_RUNNER_ALLOWED_TOOLS (untuk peringatan saat mulai). */
export function broadFileTools(env = process.env) {
  try {
    return allowedTools(env).filter((n) => BROAD_FILE_TOOLS.includes(n));
  } catch {
    return [];
  }
}

/** Argumen tambahan dari env (dipisah spasi). Setiap token divalidasi; flag pelemah keamanan ditolak. */
export function extraArgs(env = process.env) {
  const raw = typeof env.AI_OFFICE_RUNNER_EXTRA_ARGS === 'string' ? env.AI_OFFICE_RUNNER_EXTRA_ARGS.trim() : '';
  if (!raw) return [];
  const tokens = raw.split(/\s+/);
  if (tokens.length > 20) throw new RunnerConfigError('bad-extra-args', 'AI_OFFICE_RUNNER_EXTRA_ARGS');
  for (const tok of tokens) {
    if (!EXTRA_ARG_RE.test(tok) || FORBIDDEN_EXTRA.test(tok)) throw new RunnerConfigError('bad-extra-args', 'AI_OFFICE_RUNNER_EXTRA_ARGS');
  }
  return tokens;
}

/** Argumen lengkap CLI (tanpa teks tugas). */
export function buildArgs(env = process.env) {
  return [
    ...BASE_ARGS,
    '--allowedTools', allowedTools(env).join(','),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
    ...extraArgs(env),
  ];
}

/** Timeout tugas (ms) dari env, default 30 menit; nilai tidak sah memakai default. */
export function timeoutFromEnv(env = process.env) {
  const n = Number(env.AI_OFFICE_RUNNER_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 100 && n <= 24 * 3600 * 1000 ? Math.round(n) : DEFAULT_TIMEOUT_MS;
}

// ------------------------------------------------------------------ deteksi CLI
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * Cari CLI Claude Code. Urutan: AI_OFFICE_CLAUDE_BIN, lalu PATH. Windows: claude.exe, claude.cmd, claude.ps1;
 * POSIX: claude. Mengembalikan path absolut atau null. Bila AI_OFFICE_CLAUDE_BIN terisi tetapi bukan file,
 * hasilnya null (konfigurasi eksplisit yang salah tidak diam-diam diganti).
 */
export function findClaude({ env = process.env, platform = process.platform } = {}) {
  const fromEnv = typeof env.AI_OFFICE_CLAUDE_BIN === 'string' ? env.AI_OFFICE_CLAUDE_BIN.trim() : '';
  if (fromEnv) return isAbsolute(fromEnv) && isFile(fromEnv) ? fromEnv : isFile(resolve(fromEnv)) ? resolve(fromEnv) : null;
  const names = platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.ps1'] : ['claude'];
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  for (const dir of String(pathVar).split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const p = join(dir.replace(/^"|"$/g, ''), name);
      if (isFile(p)) return p;
    }
  }
  return null;
}

// Karakter yang bermakna bagi cmd.exe; path CLI yang memuatnya ditolak (path sah di Windows tidak memuatnya
// kecuali "%", "^", "&", yang memang berbahaya di baris perintah cmd).
const CMD_UNSAFE = /["%^&|<>!\r\n\x00]/;

/**
 * Perintah spawn untuk path CLI + argumen. Mengembalikan { command, args, options } tanpa shell.
 * Melempar RunnerConfigError('bad-bin') bila path tidak aman dipakai.
 */
export function spawnPlan(bin, args, { platform = process.platform, comspec = process.env.ComSpec } = {}) {
  const ext = extname(bin).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [bin, ...args], options: {} };
  }
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    if (CMD_UNSAFE.test(bin)) throw new RunnerConfigError('bad-bin', 'AI_OFFICE_CLAUDE_BIN');
    // Semua argumen konstanta/tervalidasi (tanpa spasi atau karakter cmd); hanya path CLI yang dikutip.
    const line = `"${bin}" ${args.join(' ')}`;
    return { command: comspec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  if (platform === 'win32' && ext === '.ps1') {
    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', bin, ...args], options: {} };
  }
  return { command: bin, args, options: {} };
}

/** Env anak: warisi env pengguna, buang AI_OFFICE_RUNNER* (runner key tidak pernah diteruskan), set AI_OFFICE_URL. */
export function childEnv(base, eventsUrl) {
  const env = { ...base };
  for (const k of Object.keys(env)) {
    if (/^AI_OFFICE_RUNNER/i.test(k)) delete env[k];
  }
  delete env.CLAUDE_PROJECT_DIR; // supaya hook memakai folder kerja tugas, bukan folder sesi pemanggil
  if (eventsUrl) env.AI_OFFICE_URL = eventsUrl;
  return env;
}

/** Versi CLI dari `--version` (baris pertama, dibersihkan), atau null bila gagal/timeout. */
export function detectVersion(bin, { env = process.env, timeoutMs = VERSION_TIMEOUT_MS, platform = process.platform } = {}) {
  return new Promise((resolveVersion) => {
    let plan;
    try {
      plan = spawnPlan(bin, ['--version'], { platform });
    } catch {
      resolveVersion(null);
      return;
    }
    let child;
    try {
      child = spawn(plan.command, plan.args, {
        ...plan.options, env: childEnv(env), cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, shell: false,
      });
    } catch {
      resolveVersion(null);
      return;
    }
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveVersion(v);
    };
    const timer = setTimeout(() => {
      killTreeSync(child.pid);
      finish(null);
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (out.length < 2048) out += d;
    });
    child.on('error', () => finish(null));
    child.on('close', (code) => {
      const line = out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
      // eslint-disable-next-line no-control-regex
      const clean = line.replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 64);
      finish(code === 0 && clean ? clean : null);
    });
  });
}

// ------------------------------------------------------------------ bunuh pohon proses
/** Bunuh proses dan semua turunannya. Sinkron (dipakai juga saat proses server keluar). */
export function killTreeSync(pid, { platform = process.platform } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (platform === 'win32') {
    // PID numerik tervalidasi, tanpa shell.
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // grup proses (anak dijalankan detached)
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // sudah mati
    }
  }
}

/**
 * Versi tidak memblokir: POSIX mencoba SIGTERM dulu lalu SIGKILL setelah `graceMs`; Windows taskkill /T /F.
 * Di POSIX selesai segera begitu proses keluar (pantau 'exit' bila `child` diberikan, kalau tidak cek PID
 * berkala), dan timer SIGKILL dibatalkan. Sisa anggota grup proses dibersihkan sekali setelah pemimpin keluar.
 */
export function killTree(pid, { platform = process.platform, graceMs = 2000, child = null } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (platform === 'win32') {
    // Anak sudah keluar: PID-nya bisa sudah dipakai proses lain, jangan di-taskkill.
    if (child && (child.exitCode !== null || child.signalCode !== null)) return Promise.resolve();
    return new Promise((done) => {
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
      k.on('error', () => done());
      k.on('close', () => done());
    });
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      return Promise.resolve();
    }
  }
  return new Promise((done) => {
    let finished = false;
    let timer;
    let poll;
    const finish = (sweep) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearInterval(poll);
      child?.off?.('exit', onExit);
      if (sweep && process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGKILL'); // sisa anggota grup (kalau ada)
        } catch {
          // grup sudah kosong
        }
      }
      done();
    };
    const onExit = () => finish(true);
    const isAlive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return e.code === 'EPERM';
      }
    };
    if (child && typeof child.once === 'function') {
      if (child.exitCode !== null || child.signalCode !== null) return finish(true);
      child.once('exit', onExit);
    } else {
      poll = setInterval(() => {
        if (!isAlive()) finish(true);
      }, 25);
      poll.unref?.();
    }
    timer = setTimeout(() => {
      killTreeSync(pid, { platform });
      finish(false);
    }, graceMs);
    timer.unref?.();
  });
}

// ------------------------------------------------------------------ parser stream-json
/**
 * Pengurai stream-json Claude Code. `onLine(obj)` dipanggil untuk setiap baris JSON utuh; baris yang
 * lebih panjang dari `maxLine` dibuang (tanpa menahan memori).
 */
export function createLineParser(onLine, { maxLine = 4 * 1024 * 1024 } = {}) {
  let buf = '';
  let skipping = false;
  const handle = (line) => {
    const s = line.trim();
    if (!s || s[0] !== '{') return;
    try {
      onLine(JSON.parse(s));
    } catch {
      // baris bukan JSON: diabaikan
    }
  };
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (skipping) skipping = false;
        else if (line.length <= maxLine) handle(line);
      }
      if (buf.length > maxLine) {
        buf = '';
        skipping = true;
      }
    },
    end() {
      if (!skipping) handle(buf);
      buf = '';
    },
  };
}

/**
 * Pelacak subagent dari stream-json: tool_use bernama Agent/Task → assign + working; tool_result bersangkutan →
 * done / blocked (dari baris STATUS). Hanya pesan tingkat atas (tanpa parent_tool_use_id). Dipakai bila hook
 * AI Office belum terpasang. `emit(event)` menerima event yang sudah dinormalisasi.
 */
export function createAgentTracker({ emit, taskId, tr }) {
  const open = new Map(); // tool_use_id → { agent }
  const make = (type, from, to, message) => {
    try {
      emit(makeEvent(type, from, to, message, { source: 'api', task: taskId }));
    } catch {
      // nama agen tidak sah: dilewati
    }
  };
  const agentName = (input) => {
    const raw = input && typeof input === 'object' ? (input.subagent_type ?? input.agent ?? input.name) : '';
    const name = typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : 'general-purpose';
    return /^[a-z0-9][a-z0-9_.:-]{0,63}$/.test(name) ? name : 'general-purpose';
  };
  return {
    handle(ev) {
      if (!ev || typeof ev !== 'object' || ev.parent_tool_use_id) return;
      const content = ev.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (ev.type === 'assistant' && block.type === 'tool_use' && (block.name === 'Agent' || block.name === 'Task')) {
          const agent = agentName(block.input);
          const what = typeof block.input?.description === 'string' ? block.input.description : '';
          open.set(String(block.id), { agent });
          make('assign', 'manager', agent, summarize(what) || tr('runner.assignDefault'));
          make('working', agent, 'manager', tr('runner.working'));
        } else if (ev.type === 'user' && block.type === 'tool_result' && open.has(String(block.tool_use_id))) {
          const { agent } = open.get(String(block.tool_use_id));
          open.delete(String(block.tool_use_id));
          const text = extractText(block.content);
          const status = block.is_error ? 'blocked' : parseStatus(text);
          const blocked = status === 'blocked';
          make(blocked ? 'blocked' : 'done', agent, 'manager', summarize(text) || tr(blocked ? 'runner.agentBlocked' : 'runner.agentDone'));
        }
      }
    },
  };
}
