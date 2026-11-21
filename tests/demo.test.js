// Mode demo: skenario diputar dari sisi server, menulis file hasil contoh, event source "sim" membawa task id.
// Tidak butuh Claude CLI (CLI tidak ada di sini dan demo tetap jalan).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { DEMO_FILES, scenario } from '../server/demo.js';
import { startRunnerApp, eventsOf } from './helpers/runnerkit.js';
import { sleep } from './helpers/testkit.js';

const apps = [];
const boot = async (o) => {
  const a = await startRunnerApp(o);
  apps.push(a);
  return a;
};
afterEach(async () => {
  while (apps.length) await apps.pop().close();
});

const SERVER_DIR = new URL('../server/demo/', import.meta.url);

describe('skenario', () => {
  it('berdurasi 45-60 detik dengan urutan CEO → manajer → meja → laporan → CEO', () => {
    const s = scenario();
    const total = s.at(-1)[0];
    expect(total).toBeGreaterThanOrEqual(45000);
    expect(total).toBeLessThanOrEqual(60000);
    const times = s.map(([at]) => at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    const evs = s.map(([, step]) => step.ev).filter(Boolean);
    expect(evs[0].slice(0, 3)).toEqual(['assign', 'ceo', 'manager']);
    expect(evs.at(-1).slice(0, 3)).toEqual(['report', 'manager', 'ceo']);
    const desks = new Set(evs.filter((e) => e[0] === 'assign' && e[1] === 'manager').map((e) => e[2]));
    expect(desks).toEqual(new Set(['content-script', 'sales-copywriter', 'research-analyst']));
  });

  it.each(['en', 'id'])('template %s ada untuk semua file demo dan tidak kosong', (lang) => {
    for (const file of Object.values(DEMO_FILES[lang])) {
      const p = new URL(`${lang}/${file}`, SERVER_DIR);
      expect(existsSync(p), `${lang}/${file}`).toBe(true);
      expect(readFileSync(p, 'utf8').trim().length).toBeGreaterThan(100);
    }
    expect(readdirSync(new URL(`${lang}/`, SERVER_DIR)).sort()).toEqual(Object.values(DEMO_FILES[lang]).sort());
  });
});

describe('POST /api/demo', () => {
  it.each([
    ['id', 'riset-harga.md', /kopi susu gula aren/i],
    ['en', 'price-research.md', /palm sugar/i],
  ])('lang=%s: 202, selesai, menulis RESULT.md, tiktok-script.md, caption.md, %s', async (lang, research, titleRe) => {
    const a = await boot({ bin: join(process.cwd(), 'tidak-ada', 'claude.exe') }); // tanpa CLI
    const msgs = [];
    const ws = new WebSocket(`ws://127.0.0.1:${a.port}/ws`);
    ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
    await new Promise((res) => ws.once('open', res));
    const r = await a.api('/api/demo', { method: 'POST', body: { lang } });
    expect(r.status).toBe(202);
    expect(r.json.task).toMatchObject({ status: 'running' });
    expect(r.json.task.title).toMatch(titleRe);
    const id = r.json.task.id;
    expect(id).toMatch(/^\d{8}-\d{6}-demo-/);
    const done = await a.waitDone(id);
    ws.close();
    expect(done).toMatchObject({ status: 'done', kind: 'demo' });
    expect(done.files.map((f) => f.path).sort()).toEqual(['RESULT.md', 'caption.md', research, 'tiktok-script.md'].sort());
    const dir = join(a.outputDir, id);
    for (const f of ['RESULT.md', 'tiktok-script.md', 'caption.md', research]) {
      expect(readFileSync(join(dir, f), 'utf8')).toBe(readFileSync(new URL(`${lang}/${f}`, SERVER_DIR), 'utf8'));
    }
    // file bisa dibaca lewat API file
    const file = await a.api(`/api/tasks/${id}/files/${research}`);
    expect(file.status).toBe(200);
    expect(file.body).toContain('|');

    const ev = eventsOf(a, id);
    expect(ev.length).toBeGreaterThanOrEqual(14);
    expect(ev.every((e) => e.source === 'sim' && e.task === id)).toBe(true);
    expect(ev[0]).toMatchObject({ type: 'assign', from: 'ceo', to: 'manager' });
    expect(ev.at(-1)).toMatchObject({ type: 'report', from: 'manager', to: 'ceo' });
    const agents = new Set(ev.filter((e) => e.type === 'done').map((e) => e.from));
    expect(agents).toEqual(new Set(['content-script', 'sales-copywriter', 'research-analyst']));
    expect(done.summary).toBe(ev.at(-1).message);

    const statuses = msgs.filter((m) => m.kind === 'task').map((m) => `${m.task.kind}:${m.task.status}`);
    expect(statuses).toEqual(['demo:running', 'demo:done']);
  });

  it('teks event mengikuti bahasa', async () => {
    const en = await boot();
    const r = await en.api('/api/demo', { method: 'POST', body: { lang: 'en' } });
    await en.waitDone(r.json.task.id);
    expect(eventsOf(en, r.json.task.id)[1].message).toMatch(/Splitting the task/);
  });

  it('lang tidak valid: 400; tanpa lang memakai bahasa server', async () => {
    const a = await boot();
    expect((await a.api('/api/demo', { method: 'POST', body: { lang: 'fr' } })).status).toBe(400);
    const ok = await a.api('/api/demo', { method: 'POST', body: {} });
    expect(ok.status).toBe(202); // AI_OFFICE_LANG=id di env uji
    expect(ok.json.task.title).toMatch(/kopi susu/i);
    await a.waitDone(ok.json.task.id);
  });

  it('hanya satu demo atau tugas aktif: 409; batal menghentikan skenario (status cancelled)', async () => {
    const a = await boot({ task: { demoSpeed: 1 } });
    const r = await a.api('/api/demo', { method: 'POST', body: { lang: 'en' } });
    expect(r.status).toBe(202);
    expect((await a.api('/api/demo', { method: 'POST', body: { lang: 'en' } })).status).toBe(409);
    expect((await a.api('/api/tasks', { method: 'POST', body: { text: 'x' } })).status).toBe(409);
    const st = await a.api('/api/runner');
    expect(st.json).toMatchObject({ available: false, reason: 'busy', active: { id: r.json.task.id, kind: 'demo' } });
    await sleep(100);
    const c = await a.api(`/api/tasks/${r.json.task.id}/cancel`, { method: 'POST', body: {} });
    expect(c.json).toEqual({ ok: true });
    const done = await a.waitDone(r.json.task.id);
    expect(done.status).toBe('cancelled');
    expect(eventsOf(a, r.json.task.id).at(-1)).toMatchObject({ type: 'blocked', from: 'manager', to: 'ceo' });
    // bebas lagi
    const again = await a.api('/api/demo', { method: 'POST', body: { lang: 'en' } });
    expect(again.status).toBe(202);
    await a.api(`/api/tasks/${again.json.task.id}/cancel`, { method: 'POST', body: {} });
  });

  it('server berhenti saat demo berjalan: tidak ada timer menggantung (close selesai)', async () => {
    const a = await boot({ task: { demoSpeed: 1 } });
    const r = await a.api('/api/demo', { method: 'POST', body: { lang: 'id' } });
    expect(r.status).toBe(202);
    const t0 = Date.now();
    await a.app.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    apps.pop();
    a.tmp.cleanup();
  });
});
