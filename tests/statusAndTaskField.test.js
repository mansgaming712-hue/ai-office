// Alias status Inggris di parseStatus dan field `task` pada event.
import { describe, expect, it } from 'vitest';
import { mapHookToEvents, parseStatus } from '../shared/hookMapping.js';
import { TASK_ID_RE, makeEvent, normalizeBatch, normalizeEvent } from '../shared/events.js';
import { JSON_HEADERS, http, startApp } from './helpers/testkit.js';

describe('parseStatus: alias Inggris', () => {
  it.each([
    ['STATUS: SELESAI', 'done'],
    ['STATUS: DONE', 'done'],
    ['status: done', 'done'],
    ['**STATUS: DONE**', 'done'],
    ['## STATUS: DONE\n\nbody', 'done'],
    ['STATUS: BUTUH BANTUAN', 'blocked'],
    ['STATUS: NEEDS HELP', 'blocked'],
    ['STATUS: needs help', 'blocked'],
    ['STATUS: NEED HELP', 'blocked'],
    ['> STATUS: NEEDS   HELP', 'blocked'],
    ['STATUS: BLOCKED', 'blocked'],
    ['Intro\n\nSTATUS: NEEDS HELP\n\n## Summary', 'blocked'],
    ['STATUS: SELESAI\nSTATUS: NEEDS HELP', 'done'],
  ])('%j → %s', (text, want) => {
    expect(parseStatus(text)).toBe(want);
  });

  it.each([
    'Status: 200',
    'STATUS: HELPFUL',
    'STATUS: DONEZO',
    'laporan "STATUS: NEEDS HELP" di tengah kalimat',
    'STATUS NEEDS HELP',
    '',
  ])('bukan penanda: %j → unknown', (text) => {
    expect(parseStatus(text)).toBe('unknown');
  });

  it('SubagentStop dan PostToolUse Agent memakai alias Inggris', () => {
    const stop = (msg) => mapHookToEvents({ hook_event_name: 'SubagentStop', agent_type: 'dev-backend', last_assistant_message: msg });
    expect(stop('STATUS: NEEDS HELP\n\nI need a staging server.')[0]).toMatchObject({ type: 'blocked', from: 'dev-backend', to: 'manager' });
    expect(stop('STATUS: DONE\n\nAll tests pass.')[0]).toMatchObject({ type: 'done', from: 'dev-backend' });
    const post = mapHookToEvents({
      hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-qa', description: 'x', prompt: 'y' },
      tool_response: { content: [{ type: 'text', text: 'STATUS: NEEDS HELP\n\nBlocked on CI.' }] },
    });
    expect(post[0]).toMatchObject({ type: 'blocked', from: 'dev-qa', to: 'manager' });
  });
});

describe('field task pada event', () => {
  const base = { type: 'assign', from: 'ceo', to: 'manager', message: 'x' };

  it('id sah diterima dan dibawa; tanpa task event lama tidak berubah', () => {
    expect(normalizeEvent({ ...base, task: '20261121-120000-buat-konten' }).event.task).toBe('20261121-120000-buat-konten');
    expect(normalizeEvent({ ...base, task: ' abc ' }).event.task).toBe('abc');
    expect(normalizeEvent(base).event).not.toHaveProperty('task');
    expect(normalizeEvent({ ...base, task: null }).event).not.toHaveProperty('task');
    expect(makeEvent('report', 'manager', 'ceo', 'ok', { task: 'a1', source: 'sim' })).toMatchObject({ task: 'a1', source: 'sim' });
  });

  it.each([123, '', 'ABC', '-abc', 'a b', 'a/b', '../x', 'a'.repeat(65), 'a_b', {}, []])('ditolak: %j', (task) => {
    const r = normalizeEvent({ ...base, task });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/task/);
  });

  it('batas 64 karakter dan regex sama dengan kontrak', () => {
    expect(TASK_ID_RE.source).toBe('^[a-z0-9][a-z0-9-]{0,63}$');
    expect(normalizeEvent({ ...base, task: 'a'.repeat(64) }).ok).toBe(true);
    expect(normalizeBatch([base, { ...base, task: 'Buruk!' }]).error).toMatch(/event #1.*task/);
  });

  it('POST /api/events meneruskan task ke riwayat dan siaran', async () => {
    const s = await startApp();
    try {
      const r = await http(s.port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body: { ...base, task: 'tugas-1' } });
      expect(r.status).toBe(202);
      const list = await http(s.port, '/api/events');
      expect(list.json.events.at(-1)).toMatchObject({ task: 'tugas-1', from: 'ceo' });
      const bad = await http(s.port, '/api/events', { method: 'POST', headers: JSON_HEADERS, body: { ...base, task: 'X Y' } });
      expect(bad.status).toBe(400);
    } finally {
      await s.close();
    }
  });
});
