#!/usr/bin/env node
// Uji alur hooks tanpa Claude Code: kirim payload contoh (bentuknya sama dengan input hook asli)
// ke hooks/send-event.mjs, yang lalu POST ke server AI Office.
//   node scripts/demo-hooks.mjs            jeda antar langkah ~1.8 detik (enak ditonton)
//   node scripts/demo-hooks.mjs --fast     tanpa jeda
//   node scripts/demo-hooks.mjs --asli     bentuk payload Claude Code terbaru: agen latar belakang
//                                          (PostToolUse "async_launched") dan laporan lewat
//                                          SubagentHandback yang dibaca dari file transkrip
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('../hooks/send-event.mjs', import.meta.url));
const fast = process.argv.includes('--fast');
const session = { session_id: 'demo-session', transcript_path: 'demo.jsonl', cwd: process.cwd(), permission_mode: 'default' };

const report = (status, ringkasan) => `STATUS: ${status}\n\n1. **Ringkasan** — ${ringkasan}\n2. **Yang dikerjakan** — ...`;

export const DEMO_STEPS = [
  { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-backend', description: 'Buat endpoint POST /api/orders', prompt: 'Tugas: ...' } },
  { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'dev-backend' },
  { hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'dev-backend', tool_name: 'Read', tool_input: { file_path: 'C:/proyek/server/routes.js' } },
  { hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'dev-backend', tool_name: 'Edit', tool_input: { file_path: 'C:/proyek/server/orders.js' } },
  { hook_event_name: 'PreToolUse', agent_id: 'a1', agent_type: 'dev-backend', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Jalankan test backend' } },
  { hook_event_name: 'SubagentStop', agent_id: 'a1', agent_type: 'dev-backend', stop_hook_active: false, last_assistant_message: report('SELESAI', 'Endpoint /api/orders dibuat, 6 test lulus.') },
  { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-backend', description: 'Buat endpoint POST /api/orders' }, tool_response: { content: [{ type: 'text', text: report('SELESAI', 'Endpoint /api/orders dibuat, 6 test lulus.') }] } },
  { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description: 'Uji endpoint orders dan edge case' } },
  { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-security', description: 'Audit keamanan endpoint orders' } },
  { hook_event_name: 'SubagentStart', agent_id: 'a2', agent_type: 'dev-qa' },
  { hook_event_name: 'SubagentStart', agent_id: 'a3', agent_type: 'dev-security' },
  { hook_event_name: 'PreToolUse', agent_id: 'a2', agent_type: 'dev-qa', tool_name: 'Bash', tool_input: { command: 'npx vitest run' } },
  { hook_event_name: 'PreToolUse', agent_id: 'a3', agent_type: 'dev-security', tool_name: 'Grep', tool_input: { pattern: 'api_key' } },
  { hook_event_name: 'SubagentStop', agent_id: 'a3', agent_type: 'dev-security', last_assistant_message: report('BUTUH BANTUAN', 'Perlu cek konfigurasi Nginx di server, butuh dev-devops.') },
  { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-security' }, tool_response: { content: [{ type: 'text', text: report('BUTUH BANTUAN', 'Perlu cek konfigurasi Nginx di server, butuh dev-devops.') }] } },
  { hook_event_name: 'SubagentStop', agent_id: 'a2', agent_type: 'dev-qa', last_assistant_message: report('SELESAI', '9/9 test lulus, 2 edge case baru ditambahkan.') },
  { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa' }, tool_response: { content: [{ type: 'text', text: report('SELESAI', '9/9 test lulus, 2 edge case baru ditambahkan.') }] } },
  { hook_event_name: 'SubagentStop', agent_id: 'internal', agent_type: '', last_assistant_message: 'saran prompt' },
  { hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'C:/proyek/reports/2026-11-08-orders.md' } },
];

/** Baris transkrip JSONL subagent (bentuk ringkas dari file transkrip Claude Code). */
function transcriptLines(agentId, prompt, steps) {
  let n = 0;
  const entry = (type, content) => JSON.stringify({ isSidechain: true, agentId, type, uuid: `${agentId}-${++n}`, message: { role: type, content } });
  return [entry('user', prompt), ...steps.map(([type, content]) => entry(type, content))].join('\n') + '\n';
}

/** tool_response PostToolUse Agent untuk agen latar belakang: terpicu saat diluncurkan, bukan saat selesai. */
const asyncLaunched = (agentId, description, prompt) => ({
  isAsync: true,
  status: 'async_launched',
  agentId,
  description,
  prompt,
  outputFile: `C:/Users/demo/.claude/tasks/${agentId}.output`,
  canReadOutputFile: true,
  canContinueAgent: true,
});

/**
 * Langkah dengan bentuk payload asli: dua agen latar belakang, laporan lewat SubagentHandback,
 * dan SubagentStop dengan last_assistant_message kosong + agent_transcript_path.
 * File transkrip ditulis ke `dir`.
 */
export function realisticSteps(dir) {
  const fe = { id: 'a5', type: 'dev-frontend', desc: 'Halaman login token', prompt: 'Tugas: buat form login token...' };
  const ops = { id: 'a6', type: 'dev-devops', desc: 'Konfigurasi Nginx + HTTPS', prompt: 'Tugas: siapkan Nginx di VPS...' };
  const feReport = report('SELESAI', 'Form login token dan tombol keluar selesai, build lulus.');
  const opsReport = report('BUTUH BANTUAN', 'Butuh izin CEO untuk membeli domain dan sertifikat sebelum Nginx dipasang.');
  const fePath = join(dir, `agent-${fe.id}.jsonl`);
  const opsPath = join(dir, `agent-${ops.id}.jsonl`);
  writeFileSync(
    fePath,
    transcriptLines(fe.id, fe.prompt, [
      ['assistant', [{ type: 'text', text: 'Saya baca komponen yang ada dulu.' }]],
      ['assistant', [{ type: 'tool_use', id: 'toolu_fe1', name: 'Edit', input: { file_path: 'C:/proyek/src/LoginForm.jsx' } }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'toolu_fe1', content: 'ok' }]],
      ['assistant', [{ type: 'tool_use', id: 'toolu_fe2', name: 'SubagentHandback', input: { message: feReport } }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'toolu_fe2', content: '{"success":true,"message":"Report delivered to your caller."}' }]],
    ]),
  );
  writeFileSync(
    opsPath,
    transcriptLines(ops.id, ops.prompt, [
      ['assistant', [{ type: 'tool_use', id: 'toolu_op1', name: 'Bash', input: { command: 'nginx -t' } }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'toolu_op1', content: 'syntax is ok' }]],
      ['assistant', [{ type: 'text', text: 'Konfigurasi siap, tapi butuh domain.' }, { type: 'tool_use', id: 'toolu_op2', name: 'SubagentHandback', input: { message: opsReport } }]],
      ['user', [{ type: 'tool_result', tool_use_id: 'toolu_op2', content: '{"success":true}' }]],
    ]),
  );
  const launch = (a) => [
    { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: a.type, description: a.desc, prompt: a.prompt, run_in_background: true } },
    { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: a.type, description: a.desc, prompt: a.prompt, run_in_background: true }, tool_response: asyncLaunched(a.id, a.desc, a.prompt) },
  ];
  const sub = (a, extra) => ({ agent_id: a.id, agent_type: a.type, ...extra });
  return [
    ...launch(fe),
    ...launch(ops),
    sub(fe, { hook_event_name: 'SubagentStart' }),
    sub(ops, { hook_event_name: 'SubagentStart' }),
    sub(fe, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'C:/proyek/src/LoginForm.jsx' } }),
    sub(ops, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'nginx -t', description: 'Cek konfigurasi Nginx' } }),
    sub(fe, { hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: feReport } }),
    sub(fe, { hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: '', agent_transcript_path: fePath }),
    sub(ops, { hook_event_name: 'PreToolUse', tool_name: 'SubagentHandback', tool_input: { message: opsReport } }),
    sub(ops, { hook_event_name: 'SubagentStop', stop_hook_active: false, last_assistant_message: '', agent_transcript_path: opsPath }),
  ];
}

export function runHook(payload, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(JSON.stringify({ ...session, ...payload }));
  });
}

/**
 * Alamat animasi yang ditampilkan di akhir demo, diturunkan dari AI_OFFICE_URL:
 * "https://office.example.com/api/events" → "https://office.example.com". Hanya skema, host, dan
 * awalan path yang dipakai (user:pass, query, dan token tidak pernah ikut tercetak).
 */
export function officeUrlFrom(eventsUrl, token = '') {
  if (!eventsUrl) return 'http://localhost:3000';
  let u;
  try {
    u = new URL(eventsUrl);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const prefix = u.pathname.replace(/\/api\/events\/?$/, '').replace(/\/+$/, '');
  let shown = `${u.protocol}//${u.host}${prefix}`;
  const t = String(token ?? '').trim();
  if (t) shown = shown.split(t).join('[token]');
  return shown;
}

const isMain =
  !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const dir = process.argv.includes('--asli') ? mkdtempSync(join(tmpdir(), 'ai-office-demo-')) : null;
  const steps = dir ? realisticSteps(dir) : DEMO_STEPS;
  try {
    for (const [i, step] of steps.entries()) {
      const label = `${step.hook_event_name}${step.tool_name ? ` ${step.tool_name}` : ''}${step.agent_type ? ` (${step.agent_type})` : ''}`;
      const { code, err } = await runHook(step, { ...process.env, AI_OFFICE_DEBUG: '1' });
      console.log(`${String(i + 1).padStart(2)}. ${label} → exit ${code}${err ? `  ${err.trim()}` : ''}`);
      if (!fast) await sleep(step.hook_event_name === 'PreToolUse' && step.tool_name === 'Agent' ? 2600 : 1600);
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  const office = officeUrlFrom(process.env.AI_OFFICE_URL, process.env.AI_OFFICE_TOKEN);
  console.log(office ? `\nSelesai. Lihat animasi di ${office}` : '\nSelesai. AI_OFFICE_URL tidak valid; buka alamat server AI Office secara manual.');
}
