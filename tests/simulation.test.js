// Skenario Simulasi (alur 3D + field project), data usage contoh, dan daftar "Sesi aktif".
import { describe, expect, it, vi } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { AGENT_NAMES } from '../shared/roster.js';
import { ACTIVE_WINDOW_MS, activeSessions, ago, dropSimSessions, projectOf, trackSession } from '../src/sessions.js';
import {
  SCENARIO, SCENARIO_DURATION, SIM_PROJECTS, SIM_USAGE_TIMELINE, SIM_WEEKLY_LIMIT, buildSimUsage, playScenario,
} from '../src/sim/scenario.js';
import { displayUsage, isLimitWarning, levelFor, usageState, validateUsage } from '../src/usage.js';

const NAMES_3D = ['3d-modeler', '3d-materials', '3d-animator', '3d-render'];

describe('skenario: alur Divisi 3D dan nama proyek', () => {
  it('semua event valid, memakai agen yang ada, dan membawa project', () => {
    for (const { event } of SCENARIO) {
      const r = normalizeEvent({ ...event, source: 'sim' });
      expect(r.ok, JSON.stringify(event)).toBe(true);
      expect(r.event.project).toBe(event.project);
      for (const n of [r.event.from, r.event.to]) expect(['ceo', 'manager', ...AGENT_NAMES]).toContain(n);
    }
    expect(new Set(SCENARIO.map((s) => s.event.project))).toEqual(new Set(Object.values(SIM_PROJECTS)));
  });

  it('alur 3D berurutan: modeler → materials → animator → render, tiap agen ditugaskan lalu selesai', () => {
    const firstAssign = NAMES_3D.map((n) => SCENARIO.find((s) => s.event.type === 'assign' && s.event.to === n));
    for (const s of firstAssign) expect(s.event.project).toBe(SIM_PROJECTS.model);
    const times = firstAssign.map((s) => s.at);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    NAMES_3D.forEach((n, i) => {
      const finish = SCENARIO.find((s) => s.event.from === n && ['done', 'report'].includes(s.event.type));
      expect(finish, n).toBeDefined();
      // tahap berikutnya baru ditugaskan setelah tahap ini selesai
      if (i < NAMES_3D.length - 1) expect(finish.at).toBeLessThan(times[i + 1]);
    });
  });

  it('waktu event naik terus dan SCENARIO_DURATION = event terakhir', () => {
    const ats = SCENARIO.map((s) => s.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(SCENARIO_DURATION).toBe(ats.at(-1));
  });
});

describe('data usage contoh', () => {
  it('timeline naik bertahap: hijau → kuning (lewat 60) → merah (lewat 85)', () => {
    const ps = SIM_USAGE_TIMELINE.map((x) => x.percent);
    expect([...ps].sort((a, b) => a - b)).toEqual(ps);
    const levels = ps.map(levelFor);
    const firstYellow = levels.indexOf('yellow');
    const firstRed = levels.indexOf('red');
    expect(levels[0]).toBe('green');
    expect(firstYellow).toBeGreaterThan(0);
    expect(firstRed).toBeGreaterThan(firstYellow);
    expect(ps[firstYellow]).toBeGreaterThanOrEqual(60);
    expect(ps[firstRed]).toBeGreaterThan(85);
    for (const { at } of SIM_USAGE_TIMELINE) expect(at).toBeLessThanOrEqual(SCENARIO_DURATION);
  });

  it.each(SIM_USAGE_TIMELINE.map((x) => x.percent))('buildSimUsage(%d) lolos validasi kontrak yang sama dengan server', (p) => {
    const now = new Date(2026, 10, 9, 12, 0, 0); // tengah hari waktu lokal: tanggal tidak bergantung zona waktu
    const raw = buildSimUsage(p, { now });
    const r = validateUsage(raw);
    expect(r.ok).toBe(true);
    expect(raw.days).toHaveLength(7);
    expect(raw.days.at(-1).date).toBe('2026-11-09');
    expect(raw.days[0].date).toBe('2026-11-03');
    expect(raw.today).toEqual(raw.days.at(-1));
    expect(r.usage.weekly).toMatchObject({ limit: SIM_WEEKLY_LIMIT, configured: true, level: levelFor(p) });
    expect(r.usage.weekly.percent).toBeCloseTo(p, 1);
    expect(raw.weekly.used).toBe(raw.days.reduce((a, d) => a + d.total, 0));
    for (const d of raw.days) expect(d.total).toBe(d.input + d.output + d.cacheRead + d.cacheCreation);
    expect(r.usage.topAgents).toHaveLength(5);
    expect(raw.perAgent.map((a) => a.agent)).toEqual(expect.arrayContaining(NAMES_3D));
    expect(isLimitWarning(usageState(r))).toBe(p > 85);
  });

  it('playScenario + onUsage: usage contoh dikirim sesuai timeline, stop() membatalkan semua timer', () => {
    const timers = [];
    const cancel = vi.fn();
    const usages = [];
    const ctl = playScenario(() => {}, {
      onUsage: (u) => usages.push(u),
      schedule: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      cancel,
      now: () => new Date('2026-11-09T05:00:00Z'),
    });
    expect(timers).toHaveLength(SCENARIO.length + SIM_USAGE_TIMELINE.length);
    timers.sort((a, b) => a.ms - b.ms).forEach((t) => t.fn());
    expect(usages.map((u) => u.weekly.percent)).toEqual(SIM_USAGE_TIMELINE.map((x) => x.percent));
    expect(usages.map((u) => u.weekly.level)).toContain('red');
    ctl.stop();
    expect(cancel).toHaveBeenCalledTimes(timers.length);
  });

  it('tanpa onUsage hanya event yang dijadwalkan (kompatibel dengan pemakaian lama)', () => {
    const timers = [];
    playScenario(() => {}, { schedule: (fn, ms) => timers.push({ fn, ms }), cancel: () => {} });
    expect(timers).toHaveLength(SCENARIO.length);
  });

  it('data simulasi tidak tercampur: setelah simulasi selesai tampilan kembali ke data server', () => {
    const real = { status: 'unavailable', reason: 'data tidak tersedia' };
    let sim = null;
    const steps = [];
    const timers = [];
    const ctl = playScenario(() => {}, {
      onUsage: (u) => {
        sim = validateUsage(u).usage;
        steps.push(isLimitWarning(displayUsage(real, sim)));
      },
      onFinish: () => {
        sim = null;
      },
      schedule: (fn, ms) => timers.push({ fn, ms }),
      cancel: () => {},
    });
    // jalankan urut waktu (stabil), plus satu timer usage "telat" setelah selesai
    timers.sort((x, y) => x.ms - y.ms).forEach((t) => t.fn());
    expect(steps).toContain(true);
    expect(displayUsage(real, sim)).toBe(real);
    expect(isLimitWarning(displayUsage(real, sim))).toBe(false);
    timers.find((t) => t.ms === 52_000).fn(); // timer telat tidak boleh menghidupkan data simulasi lagi
    expect(sim).toBeNull();
    ctl.stop();
  });

  it('stop() di tengah jalan: tidak ada data simulasi yang keluar sesudahnya', () => {
    const timers = [];
    const got = [];
    const ctl = playScenario((ev) => got.push(ev), {
      onUsage: (u) => got.push(u),
      schedule: (fn, ms) => timers.push({ fn, ms }),
      cancel: () => {},
    });
    ctl.stop();
    timers.forEach((t) => t.fn());
    expect(got).toEqual([]);
  });
});

describe('sesi aktif (field project)', () => {
  const T0 = Date.parse('2026-11-09T05:00:00Z');
  const e = (project, minutesAgo, extra = {}) => ({
    type: 'working', from: 'dev-qa', to: 'manager', project, time: new Date(T0 - minutesAgo * 60000).toISOString(), ...extra,
  });

  it('projectOf: teks dibersihkan & dipotong; tidak ada / bukan teks / kosong → null', () => {
    expect(projectOf({ project: 'toko-online' })).toBe('toko-online');
    expect(projectOf({ project: '  ai\u001b[31m-office​  ' })).toBe('ai-office');
    expect(projectOf({ project: 'x'.repeat(80) })).toHaveLength(40);
    for (const v of [{}, { project: 5 }, { project: '' }, { project: '   ' }, { project: null }, null, undefined]) {
      expect(projectOf(v)).toBeNull();
    }
  });

  it('hanya proyek dengan event dalam 10 menit terakhir, terbaru di atas', () => {
    const m = new Map();
    trackSession(m, e('ai-office', 9.9), T0);
    trackSession(m, e('toko-online', 1), T0);
    trackSession(m, e('lama', 10.1), T0);
    expect(trackSession(m, e(undefined, 0), T0)).toBe(false); // event tanpa project diabaikan
    expect(activeSessions(m, T0).map((s) => s.project)).toEqual(['toko-online', 'ai-office']);
    expect(activeSessions(m, T0 + ACTIVE_WINDOW_MS).map((s) => s.project)).toEqual([]);
    trackSession(m, e('ai-office', 0), T0);
    expect(activeSessions(m, T0)[0]).toMatchObject({ project: 'ai-office', count: 2 });
  });

  it('waktu event di masa depan atau rusak dibatasi ke "sekarang"', () => {
    const m = new Map();
    trackSession(m, e('maju', -60), T0);
    trackSession(m, { ...e('rusak', 0), time: 'kemarin' }, T0);
    expect([...m.values()].map((s) => s.lastAt)).toEqual([T0, T0]);
    expect(activeSessions(m, T0 + ACTIVE_WINDOW_MS + 1)).toEqual([]);
  });

  it('sesi simulasi terpisah dari sesi asli dan dibuang saat simulasi berhenti', () => {
    const m = new Map();
    trackSession(m, e('kopiku-web', 0, { source: 'sim' }), T0);
    trackSession(m, e('kopiku-web', 0, { source: 'hook' }), T0);
    expect(activeSessions(m, T0)).toHaveLength(2);
    expect(dropSimSessions(m)).toBe(true);
    expect(activeSessions(m, T0)).toEqual([expect.objectContaining({ project: 'kopiku-web', sim: false })]);
    expect(dropSimSessions(m)).toBe(false);
  });

  it('ago: teks waktu relatif', () => {
    expect(ago(T0, T0)).toBe('baru saja');
    expect(ago(T0 - 3 * 60000, T0)).toBe('3 mnt lalu');
  });
});
