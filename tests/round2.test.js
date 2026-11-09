// Putaran 2: Origin ketat di mode lokal (M1), perAgent hanya roster (L2), batas parse transkrip (B2).
import { afterAll, describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '../shared/roster.js';
import { createUsageTracker } from '../server/usage.js';
import { http, startApp, wsConnect } from './helpers/testkit.js';

const ev = { type: 'done', from: 'dev-qa', to: 'manager', message: 'x' };
const post = (port, headers) => http(port, '/api/events', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: ev });

describe('M1: Origin mode lokal harus sama dengan Host', () => {
  it('port lain di loopback ditolak (HTTP GET/POST dan WS); Origin sama dengan Host diterima', async () => {
    const s = await startApp();
    try {
      const rows = [];
      for (const [origin, host] of [
        ['http://localhost:8080', undefined],
        ['http://127.0.0.1:8080', undefined],
        ['http://localhost:5173', undefined],
        [`http://localhost:${s.port}`, undefined],
        [`http://127.0.0.1:${s.port}`, undefined],
        [`http://127.0.0.1:${s.port}`, `localhost:${s.port}`],
        [`https://localhost:${s.port}`, undefined],
        ['http://evil.example', undefined],
        [undefined, undefined],
      ]) {
        const h = { ...(origin ? { Origin: origin } : {}), ...(host ? { Host: host } : {}) };
        const g = await http(s.port, '/api/events', { headers: h });
        const p = await post(s.port, h);
        const w = await wsConnect(s.port, { headers: h });
        w.ws?.close();
        rows.push([origin ?? '(tanpa)', g.status, p.status, w.status]);
      }
      console.log('[M1] Origin -> GET, POST, WS:', JSON.stringify(rows));
      const ok = (r) => r[1] === 200 && r[2] === 202 && r[3] === 101;
      const no = (r) => r[1] === 403 && r[2] === 403 && r[3] === 403;
      expect(rows.map((r) => (ok(r) ? 'ok' : no(r) ? 'ditolak' : `?${r}`))).toEqual(
        ['ditolak', 'ditolak', 'ditolak', 'ok', 'ok', 'ok', 'ditolak', 'ditolak', 'ok'],
      );
    } finally {
      await s.close();
    }
  });

  it('devOrigins eksplisit mengizinkan Origin dev server; yang lain tetap ditolak', async () => {
    const s = await startApp({ devOrigins: ['http://localhost:5173'] });
    try {
      expect((await http(s.port, '/api/events', { headers: { Origin: 'http://localhost:5173' } })).status).toBe(200);
      const w = await wsConnect(s.port, { headers: { Origin: 'http://localhost:5173' } });
      expect(w.status).toBe(101);
      w.ws.close();
      expect((await http(s.port, '/api/events', { headers: { Origin: 'http://localhost:8080' } })).status).toBe(403);
    } finally {
      await s.close();
    }
  });
});

describe('L2: perAgent hanya memuat nama roster', () => {
  it('nama di luar roster digabung ke "lainnya"; nama roster tetap', () => {
    const t = createUsageTracker({ claudeDir: 'x', claudeDirExplicit: true, cacheFile: null, agentsFile: null });
    const tk = { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 };
    t.recordEvents([
      { from: 'dev-qa', tokens: tk },
      { from: 'palsu-1', tokens: tk },
      { from: 'palsu-2', tokens: tk },
      { from: 'x'.repeat(500), tokens: tk },
    ]);
    const names = t.snapshot().perAgent.map((a) => a.agent).sort();
    expect(names).toEqual(['dev-qa', 'lainnya']);
    expect(t.snapshot().perAgent.find((a) => a.agent === 'lainnya')).toMatchObject({ runs: 3, total: 6 });
    expect(AGENT_NAMES).toContain('dev-qa');
    return t.stop();
  });
});
