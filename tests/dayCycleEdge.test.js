// Fase 4 (QA tambahan): DST, batas milidetik, Date tidak sah, kunci tersimpan berbahaya, dan penghentian timer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PHASES, phaseAt, watchPhase } from '../src/office/daycycle.js';
import { parseSettings, resolvePhase, resolveVariant, sanitizeSettings } from '../src/settings.js';

let prevTz;
beforeAll(() => { prevTz = process.env.TZ; });
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

const HOUR = 3600_000;
const sweep = (startUtc, hours) => Array.from({ length: hours }, (_, i) => startUtc + i * HOUR);

describe('phaseAt di sekitar DST (jam lokal lompat/mundur)', () => {
  it('NY spring-forward 2026-03-08: jam 02 tidak ada, fase tetap sah dan urut', () => {
    process.env.TZ = 'America/New_York';
    const hours = sweep(Date.UTC(2026, 2, 8, 3), 6).map((ms) => new Date(ms).getHours()); // 22:00 lokal tgl 7 dst
    expect(hours).not.toContain(2);
    for (const ms of sweep(Date.UTC(2026, 2, 8, 3), 8)) expect(PHASES).toContain(phaseAt(ms));
    // 01:59 EST dan 03:00 EDT (1 jam nyata kemudian) sama-sama malam; subuh baru mulai 04:00 lokal
    expect(phaseAt(Date.UTC(2026, 2, 8, 6, 59))).toBe('malam');
    expect(phaseAt(Date.UTC(2026, 2, 8, 7, 0))).toBe('malam');
    expect(phaseAt(Date.UTC(2026, 2, 8, 8, 0))).toBe('subuh'); // 04:00 EDT
  });

  it('NY fall-back 2026-11-01: jam 01 terjadi dua kali, tidak melempar, fase konsisten', () => {
    process.env.TZ = 'America/New_York';
    const h = sweep(Date.UTC(2026, 10, 1, 4), 6).map((ms) => new Date(ms).getHours());
    expect(h.filter((x) => x === 1)).toHaveLength(2);
    expect(phaseAt(Date.UTC(2026, 10, 1, 5, 30))).toBe('malam');
    expect(phaseAt(Date.UTC(2026, 10, 1, 6, 30))).toBe('malam');
    expect(phaseAt(Date.UTC(2026, 10, 1, 9, 0))).toBe('subuh'); // 04:00 EST
  });

  it('Auckland (belahan selatan) melewati DST tanpa fase tidak sah', () => {
    process.env.TZ = 'Pacific/Auckland';
    for (const ms of sweep(Date.UTC(2026, 8, 26), 72)) expect(PHASES).toContain(phaseAt(ms));
  });
});

describe('batas milidetik dan masukan tidak sah', () => {
  it('03:59:59.999 masih malam, 04:00:00.000 subuh', () => {
    process.env.TZ = 'Asia/Jakarta';
    expect(phaseAt(new Date(2026, 2, 10, 3, 59, 59, 999))).toBe('malam');
    expect(phaseAt(new Date(2026, 2, 10, 4, 0, 0, 0))).toBe('subuh');
    expect(phaseAt(new Date(2026, 2, 10, 17, 59, 59, 999))).toBe('sore');
  });

  it('Date tidak sah, null, objek, dan clock yang mengembalikan NaN tidak melempar', () => {
    for (const bad of [new Date(NaN), null, {}, [], -8.64e15 * 2, Symbol.for('x').description]) {
      expect(() => phaseAt(bad)).not.toThrow();
    }
    expect(phaseAt(new Date('x'))).toBe('siang');
    const seen = [];
    const w = watchPhase({ clock: () => NaN, onChange: (p) => seen.push(p), setTimer: () => 1, clearTimer: () => {} });
    expect(seen).toEqual(['siang']);
    w.check();
    expect(seen).toEqual(['siang']);
  });

  it('resolvePhase/resolveVariant tahan nilai aneh', () => {
    for (const m of ['__proto__', 'constructor', 'toString', 'x'.repeat(100_000), 5, null, undefined, {}]) {
      expect(resolvePhase(m, { now: 0 })).toBeNull();
      expect(['day', 'night']).toContain(resolveVariant(m, { uiTheme: 'dark', now: 0 }));
    }
  });
});

describe('localStorage rusak / lama', () => {
  it('timeMode lama dimigrasi; nilai rusak, __proto__, dan string panjang jatuh ke bawaan', () => {
    expect(sanitizeSettings({ timeMode: 'follow' }).timeMode).toBe('off');
    expect(sanitizeSettings({ timeMode: 'day' }).timeMode).toBe('siang');
    expect(sanitizeSettings({ timeMode: 'night' }).timeMode).toBe('malam');
    for (const m of ['__proto__', 'constructor', 'x'.repeat(5000), '', 7, ['auto']]) {
      expect(sanitizeSettings({ timeMode: m }).timeMode).toBe('off');
    }
    expect(sanitizeSettings(JSON.parse('{"__proto__":{"timeMode":"auto"},"timeMode":"auto"}')).timeMode).toBe('auto');
    expect(({}).timeMode).toBeUndefined();
  });

  it('JSON tersimpan rusak/terlalu besar tidak melempar', () => {
    for (const raw of ['{', 'null', '[]', '"auto"', `{"timeMode":"${'a'.repeat(9000)}"}`]) {
      expect(() => parseSettings(raw)).not.toThrow();
    }
  });
});

describe('watchPhase: tidak ada timer bocor', () => {
  it('stop membersihkan tepat satu timer; berpindah mode berulang tidak menyisakan timer aktif', () => {
    const active = new Set();
    let n = 0;
    const setTimer = () => { n += 1; active.add(n); return n; };
    const clearTimer = (id) => active.delete(id);
    for (let i = 0; i < 5; i += 1) {
      const w = watchPhase({ clock: () => 0, onChange: () => {}, setTimer, clearTimer });
      expect(active.size).toBe(1);
      w.stop();
      expect(active.size).toBe(0);
    }
  });
});
