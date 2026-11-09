// shared/transcript.js (lastReportFromTranscript) dan scripts/demo-hooks.mjs (realisticSteps).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mapHookToEvents, parseStatus } from '../shared/hookMapping.js';
import { lastReportFromTranscript } from '../shared/transcript.js';
import { realisticSteps } from '../scripts/demo-hooks.mjs';
import { REPORT_BLOCKED, REPORT_DONE, entry, handback, jsonl, toolResult } from './helpers/testkit.js';

const text = (t) => entry('assistant', [{ type: 'text', text: t }]);
const prompt = (t = 'Tugas: uji') => entry('user', t);

describe('lastReportFromTranscript', () => {
  it('mengambil input.message dari SubagentHandback terakhir', () => {
    const t = jsonl(prompt(), text('Saya cek dulu.'), handback(REPORT_BLOCKED), toolResult());
    expect(lastReportFromTranscript(t)).toBe(REPORT_BLOCKED);
  });

  it('beberapa handback → yang terakhir; handback dan teks dalam satu pesan → handback', () => {
    const t1 = jsonl(prompt(), handback('STATUS: SELESAI\nlama'), toolResult(), handback(REPORT_DONE), toolResult());
    expect(lastReportFromTranscript(t1)).toBe(REPORT_DONE);
    const both = entry('assistant', [{ type: 'text', text: 'Konfigurasi siap.' }, { type: 'tool_use', name: 'SubagentHandback', input: { message: REPORT_BLOCKED } }]);
    expect(lastReportFromTranscript(jsonl(prompt(), both))).toBe(REPORT_BLOCKED);
  });

  it('tanpa handback → teks assistant terakhir (tool_use lain dilewati)', () => {
    const t = jsonl(prompt(), text('teks lama'), text('STATUS: SELESAI\nteks akhir'), entry('assistant', [{ type: 'tool_use', name: 'Bash', input: {} }]));
    expect(lastReportFromTranscript(t)).toBe('STATUS: SELESAI\nteks akhir');
    expect(lastReportFromTranscript(jsonl(prompt(), entry('assistant', 'konten string')))).toBe('konten string');
  });

  it('handback dengan message kosong/bukan string diabaikan', () => {
    const empty = entry('assistant', [{ type: 'tool_use', name: 'SubagentHandback', input: { message: '   ' } }]);
    const nonStr = entry('assistant', [{ type: 'tool_use', name: 'SubagentHandback', input: { message: 42 } }]);
    expect(lastReportFromTranscript(jsonl(prompt(), text('cadangan'), empty, nonStr))).toBe('cadangan');
  });

  it('entri api-request-blob (salinan request yang memuat handback lama) diabaikan', () => {
    const blob = entry('api-request-blob', [{ type: 'tool_use', name: 'SubagentHandback', input: { message: REPORT_DONE } }]);
    expect(lastReportFromTranscript(jsonl(prompt(), handback(REPORT_BLOCKED), toolResult(), blob))).toBe(REPORT_BLOCKED);
    expect(lastReportFromTranscript(jsonl(prompt(), text('teks asli'), blob))).toBe('teks asli');
    expect(lastReportFromTranscript(jsonl(blob))).toBe('');
  });

  it('hanya type "assistant"/"user": attachment, system, api-request, progress diabaikan', () => {
    const others = ['attachment', 'system', 'api-request', 'progress', 'summary'].map((type) =>
      entry(type, [{ type: 'tool_use', name: 'SubagentHandback', input: { message: `STATUS: SELESAI dari ${type}` } }, { type: 'text', text: type }]),
    );
    expect(lastReportFromTranscript(jsonl(prompt(), text('asli'), ...others))).toBe('asli');
    // entri bertipe lain dengan role user berteks juga bukan batas giliran
    const sysUser = JSON.stringify({ type: 'system', message: { role: 'user', content: 'pesan sistem' } });
    expect(lastReportFromTranscript(jsonl(handback(REPORT_DONE), sysUser))).toBe(REPORT_DONE);
  });

  it('agen dilanjutkan: berhenti di pesan user berteks, handback giliran lama tidak dipakai', () => {
    const resumed = jsonl(
      prompt(), handback(REPORT_DONE), toolResult(),
      entry('user', 'The coordinator sent a message: lanjutkan', { isMeta: true }),
      text('kerja giliran baru'),
    );
    expect(lastReportFromTranscript(resumed)).toBe('kerja giliran baru');
    // baru dilanjutkan, belum ada keluaran → kosong (bukan laporan lama)
    expect(lastReportFromTranscript(jsonl(prompt(), handback(REPORT_DONE), toolResult(), entry('user', [{ type: 'text', text: 'Pesan lanjutan' }])))).toBe('');
    // tool_result (bukan teks) tidak menghentikan pencarian
    expect(lastReportFromTranscript(jsonl(handback(REPORT_BLOCKED), toolResult(), entry('assistant', [{ type: 'tool_use', name: 'Read', input: {} }]), toolResult('isi')))).toBe(REPORT_BLOCKED);
    // pesan user hanya spasi bukan batas giliran
    expect(lastReportFromTranscript(jsonl(handback(REPORT_BLOCKED), entry('user', '   ')))).toBe(REPORT_BLOCKED);
  });

  it('baris rusak/terpotong/biner dilewati; CRLF didukung', () => {
    const t = `ssage":{"role":"assistant"}}\n{rusak\n\u0000\u0001\nnull\n[1,2]\n"string"\n${handback(REPORT_DONE)}\n{"type":"assistant"\n`;
    expect(lastReportFromTranscript(t)).toBe(REPORT_DONE);
    expect(lastReportFromTranscript([prompt(), handback(REPORT_BLOCKED), toolResult()].join('\r\n'))).toBe(REPORT_BLOCKED);
    expect(lastReportFromTranscript(`${handback(REPORT_DONE)}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"terpo`)).toBe(REPORT_DONE);
  });

  it('input kosong / bukan JSONL / bukan string → ""', () => {
    for (const v of ['', 'bukan json sama sekali', undefined, null, '\n\n']) expect(lastReportFromTranscript(v)).toBe('');
    expect(lastReportFromTranscript(jsonl(JSON.stringify({ type: 'assistant' }), JSON.stringify({ type: 'assistant', message: { content: 5 } })))).toBe('');
  });
});

describe('realisticSteps(dir) (scripts/demo-hooks.mjs)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aio-real-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const steps = realisticSteps(dir);

  /** Tiru enrichSubagentStop hook: last_assistant_message kosong → baca transkrip. */
  const enrich = (step) => {
    if (step.hook_event_name !== 'SubagentStop' || parseStatus(step.last_assistant_message) !== 'unknown') return step;
    return { ...step, last_assistant_message: lastReportFromTranscript(readFileSync(step.agent_transcript_path, 'utf8')) };
  };

  it('menulis dua file transkrip ke dir dan mengembalikan 12 langkah', () => {
    expect(steps).toHaveLength(12);
    const paths = steps.filter((s) => s.agent_transcript_path).map((s) => s.agent_transcript_path);
    expect(paths).toEqual([join(dir, 'agent-a5.jsonl'), join(dir, 'agent-a6.jsonl')]);
    for (const p of paths) expect(existsSync(p)).toBe(true);
  });

  it('bentuk payload asli: agen latar belakang async_launched dan SubagentStop tanpa pesan', () => {
    const post = steps.filter((s) => s.hook_event_name === 'PostToolUse');
    expect(post).toHaveLength(2);
    for (const p of post) expect(p.tool_response).toMatchObject({ isAsync: true, status: 'async_launched' });
    for (const s of steps.filter((x) => x.hook_event_name === 'SubagentStop')) expect(s.last_assistant_message).toBe('');
  });

  it('dipetakan (dengan pembacaan transkrip) → urutan event yang diharapkan', () => {
    const types = steps.map((s) => mapHookToEvents(enrich(s)).map((e) => e.type).join(','));
    expect(types).toEqual(['assign', '', 'assign', '', 'working', 'working', 'working', 'working', 'working', 'done', 'working', 'blocked']);
  });

  it('tanpa pembacaan transkrip, kedua SubagentStop jadi "done" generik (alasan transkrip dibaca)', () => {
    const stops = steps.filter((s) => s.hook_event_name === 'SubagentStop').map((s) => mapHookToEvents(s)[0]);
    expect(stops.map((e) => [e.type, e.message])).toEqual([['done', 'Tugas selesai'], ['done', 'Tugas selesai']]);
  });
});
