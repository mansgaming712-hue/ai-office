#!/usr/bin/env node
// CLI Claude Code TIRUAN untuk test runner (server/runner.js). Meniru `claude -p --output-format stream-json`:
// membaca prompt dari stdin dan menulis satu objek JSON per baris ke stdout. Tidak memanggil API apa pun.
//
// Perilaku diatur env FAKE_CLAUDE_MODE:
//   success        (default) init, teks asisten, result sukses
//   agents         dua tool_use Agent/Task beserta tool_result (satu SELESAI, satu BUTUH BANTUAN), lalu result
//   writes-result  menulis RESULT.md sendiri di cwd, lalu result dengan teks lain
//   huge-result    menulis RESULT.md 2 MB (uji batas baca 1 MB), lalu result sukses
//   fail           stderr "boom", exit 3
//   error-result   event result is_error, exit 1
//   hang           init lalu menunggu selamanya (uji timeout dan batal)
//   hang-tree      seperti hang, plus proses cucu yang juga menunggu (uji bunuh pohon proses)
//   flood          menulis > 6 MB ke stdout lalu result (uji batas run.log)
//   garbage        baris bukan JSON, JSON tidak utuh, byte aneh, lalu exit 0 tanpa event result
//   silent         tanpa output sama sekali, exit 0
//   ignore-term    mengabaikan SIGTERM dan menunggu selamanya (uji eskalasi ke SIGKILL di POSIX)
//   no-newline     event result tanpa baris baru penutup (baris terakhir tetap harus terbaca)
// FAKE_CLAUDE_LOG: path file JSON yang diisi { argv, stdin, cwd, env, pid, grandchild } begitu stdin selesai dibaca.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  console.log('9.9.9 (Fake Claude Code)');
  process.exit(0);
}

const mode = process.env.FAKE_CLAUDE_MODE || 'success';
const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (stdin += c));
await new Promise((resolve) => process.stdin.on('end', resolve));

let grandchild = null;
if (mode === 'hang-tree') {
  const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  grandchild = g.pid;
}

if (process.env.FAKE_CLAUDE_LOG) {
  const keys = Object.keys(process.env).filter((k) => k.startsWith('AI_OFFICE_') || k === 'CLAUDE_PROJECT_DIR');
  writeFileSync(
    process.env.FAKE_CLAUDE_LOG,
    JSON.stringify({ argv, stdin, cwd: process.cwd(), env: Object.fromEntries(keys.map((k) => [k, process.env[k]])), pid: process.pid, grandchild }),
  );
}

out({ type: 'system', subtype: 'init', session_id: 'fake-session', cwd: process.cwd() });

const toolUse = (id, name, input) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
const toolResult = (id, text) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] } });

switch (mode) {
  case 'hang':
  case 'hang-tree':
    setInterval(() => {}, 1000);
    break;
  case 'ignore-term':
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    break;
  case 'garbage':
    process.stdout.write('bukan json\n{"type":"assistant",\n[1,2,3]\n\u0000\u0001\u0002\n{"type":"result"\n');
    break;
  case 'silent':
    break;
  case 'no-newline':
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'STATUS: SELESAI\n\nTanpa newline penutup.' }));
    break;
  case 'fail':
    process.stderr.write('boom: sesuatu rusak\n');
    process.exit(3);
    break;
  case 'error-result':
    out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'tidak bisa menyelesaikan tugas' });
    process.exit(1);
    break;
  case 'flood': {
    const line = `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1000) }] } })}\n`;
    for (let i = 0; i < 6500; i++) process.stdout.write(line);
    out({ type: 'result', subtype: 'success', is_error: false, result: 'flood selesai' });
    break;
  }
  case 'agents':
    out(toolUse('toolu_1', 'Agent', { subagent_type: 'dev-backend', description: 'Bangun endpoint login', prompt: 'rahasia-prompt' }));
    out(toolResult('toolu_1', 'STATUS: SELESAI\n\n1. **Ringkasan** — endpoint login jadi.'));
    out(toolUse('toolu_2', 'Task', { subagent_type: 'dev-qa', description: 'Uji endpoint', prompt: 'x' }));
    out(toolResult('toolu_2', 'STATUS: BUTUH BANTUAN\n\nButuh server staging.'));
    out({ type: 'result', subtype: 'success', is_error: false, result: 'STATUS: SELESAI\n\nRingkasan akhir dari manajer tiruan.' });
    break;
  case 'writes-result':
    writeFileSync('RESULT.md', '# Hasil dari manajer\n\nIni ditulis manajer sendiri.\n');
    out({ type: 'result', subtype: 'success', is_error: false, result: 'teks result yang berbeda' });
    break;
  case 'huge-result':
    writeFileSync('RESULT.md', 'x'.repeat(2 * 1024 * 1024));
    out({ type: 'result', subtype: 'success', is_error: false, result: 'STATUS: SELESAI\n\nRingkasan dari teks result.' });
    break;
  default:
    out({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Saya mulai bekerja.' }] } });
    out({ type: 'result', subtype: 'success', is_error: false, result: 'STATUS: SELESAI\n\nRingkasan: semua beres.\n\nDetail lain.' });
}
