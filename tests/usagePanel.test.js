// Panel "Pemakaian Limit" (UI, src/usage.js): format angka, warna bar, validasi data rusak, pemicu
// peringatan, dan jalur data src/net.js (pesan WebSocket { kind: "usage" } + GET /api/usage).
// (Test statistik di sisi server ada di tests/usage.test.js milik dev-backend.)
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connect, getUsage } from '../src/net.js';
import {
  CONFIG_HINT, LEVEL_INFO, UNAVAILABLE_TEXT, USAGE_LABEL, WARNING_TEXT,
  chartBars, displayUsage, formatFull, formatPercent, formatTokens, isLimitWarning, levelFor,
  parseUsageResponse, usageState, validateUsage,
} from '../src/usage.js';

const tok = (total, extra = {}) => ({ input: total * 0.3, output: total * 0.2, cacheRead: total * 0.4, cacheCreation: total * 0.1, total, ...extra });

/** Usage valid sesuai kontrak dev-backend. */
function sample(over = {}) {
  const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-0${i + 3}`, ...tok(1000 * (i + 1)) }));
  return {
    available: true,
    reason: null,
    estimate: true,
    updatedAt: '2026-11-09T02:00:00.000Z',
    today: { date: '2026-11-09', ...tok(1_234_567) },
    days,
    weekly: { used: 3_600_000, limit: 5_000_000, percent: 72, level: 'yellow', windowStart: '2026-11-03T00:00:00.000Z', configAvailable: true },
    perAgent: [
      { agent: 'dev-qa', ...tok(100), runs: 2 },
      { agent: '3d-render', ...tok(900), runs: 1 },
      { agent: 'dev-frontend', ...tok(500), runs: 3 },
      { agent: 'sales-pricing', ...tok(50), runs: 1 },
      { agent: '3d-modeler', ...tok(700), runs: 1 },
      { agent: 'content-script', ...tok(10), runs: 1 },
    ],
    ...over,
  };
}
const weekly = (w) => sample({ weekly: { ...sample().weekly, ...w } });

describe('formatTokens: angka ringkas gaya Indonesia', () => {
  it.each([
    [0, '0'],
    [7, '7'],
    [845, '845'],
    [999, '999'],
    [999.6, '1 rb'],
    [1000, '1 rb'],
    [1234, '1,2 rb'],
    [12_345, '12,3 rb'],
    [845_000, '845 rb'],
    [999_950, '1 jt'],
    [1_234_567, '1,2 jt'],
    [12_500_000, '12,5 jt'],
    [345_000_000, '345 jt'],
    [2_000_000_000, '2 M'],
  ])('%d → %s', (n, out) => {
    expect(formatTokens(n)).toBe(out);
  });

  it.each([[NaN], [-1], [Infinity], ['5'], [null], [undefined], [{}]])('nilai rusak %j → "–" tanpa melempar', (n) => {
    expect(formatTokens(n)).toBe('–');
    expect(formatFull(n)).toBe('–');
  });

  it('formatFull memakai pemisah ribuan titik; formatPercent memakai koma desimal', () => {
    expect(formatFull(1_234_567)).toBe('1.234.567');
    expect(formatPercent(72)).toBe('72%');
    expect(formatPercent(7.25)).toBe('7,3%');
    expect(formatPercent(-3)).toBe('–');
  });
});

describe('warna bar mingguan: hijau < 60, kuning 60–85, merah > 85', () => {
  it.each([
    [0, 'green'],
    [59, 'green'],
    [59.9, 'green'],
    [60, 'yellow'],
    [85, 'yellow'],
    [85.1, 'red'],
    [86, 'red'],
    [140, 'red'],
  ])('levelFor(%d) = %s', (p, level) => {
    expect(levelFor(p)).toBe(level);
  });

  it.each([[NaN], [-1], [null], ['70']])('levelFor(%j) = null', (p) => {
    expect(levelFor(p)).toBeNull();
  });

  it.each([
    [59, 'green'],
    [60, 'yellow'],
    [85, 'yellow'],
    [86, 'red'],
  ])('level dari server null → dihitung dari percent %d → %s', (percent, level) => {
    const r = validateUsage(weekly({ percent, level: null }));
    expect(r.ok).toBe(true);
    expect(r.usage.weekly).toMatchObject({ percent, level, configured: true });
  });

  it('level dari server diutamakan bila ada', () => {
    expect(validateUsage(weekly({ percent: 50, level: 'yellow' })).usage.weekly.level).toBe('yellow');
  });

  it('percent null tapi limit ada → percent dihitung dari used/limit', () => {
    const r = validateUsage(weekly({ used: 4_500_000, limit: 5_000_000, percent: null, level: null }));
    expect(r.usage.weekly).toMatchObject({ percent: 90, level: 'red' });
  });

  it('limit null atau configAvailable false → tanpa bar persen (configured false)', () => {
    for (const w of [{ limit: null, percent: null, level: null }, { configAvailable: false }]) {
      const r = validateUsage(weekly(w));
      expect(r.ok).toBe(true);
      expect(r.usage.weekly).toMatchObject({ configured: false, percent: null, level: null, limit: null });
      expect(isLimitWarning(usageState(r))).toBe(false);
    }
    expect(CONFIG_HINT).toBe('Isi weeklyTokenLimit di limit-config.json');
  });

  it('setiap level punya label teks (warna tidak berdiri sendiri)', () => {
    expect(Object.keys(LEVEL_INFO)).toEqual(['green', 'yellow', 'red']);
    for (const info of Object.values(LEVEL_INFO)) expect(info.label).toMatch(/\w/);
  });
});

describe('validateUsage: data valid', () => {
  it('menormalkan ringkasan hari ini, 7 hari, dan 5 agen teratas', () => {
    const r = validateUsage(sample());
    expect(r.ok).toBe(true);
    expect(r.usage.today.total).toBe(1_234_567);
    expect(r.usage.days).toHaveLength(7);
    expect(r.usage.topAgents.map((a) => a.agent)).toEqual(['3d-render', '3d-modeler', 'dev-frontend', 'dev-qa', 'sales-pricing']);
    expect(r.usage.agentCount).toBe(6);
    expect(r.usage.estimate).toBe(true);
    expect(USAGE_LABEL).toBe('Estimasi, angka resmi cek /usage');
  });

  it('lebih dari 7 hari → hanya 7 terakhir; nama agen dibersihkan dari karakter kontrol', () => {
    const days = Array.from({ length: 9 }, (_, i) => ({ date: `2026-10-${String(i + 10)}`, ...tok(i) }));
    const r = validateUsage(sample({ days, perAgent: [{ agent: 'dev\u001b[31m-qa​', ...tok(5), runs: 1 }] }));
    expect(r.usage.days.map((d) => d.date)).toEqual(days.slice(-7).map((d) => d.date));
    expect(r.usage.topAgents[0].agent).toBe('dev-qa');
  });

  it('chartBars: tinggi relatif terhadap hari terbesar + label hari Indonesia', () => {
    const bars = chartBars(validateUsage(sample()).usage.days);
    expect(bars.at(-1).height).toBe(100);
    expect(bars[0].height).toBeCloseTo(100 / 7);
    expect(bars[0]).toMatchObject({ weekday: 'Sel', short: '03/11' }); // 3 Nov 2026 = Selasa
    expect(chartBars([{ date: '2026-11-09', total: 0 }])[0].height).toBe(0);
  });
});

describe('validateUsage: data rusak → "data tidak tersedia", tidak pernah melempar', () => {
  const broken = {
    'null': null,
    'array': [],
    'teks': 'usage',
    'available false': { ...sample(), available: false },
    'available "true" (teks)': { ...sample(), available: 'true' },
    'today hilang': sample({ today: undefined }),
    'today.total NaN': sample({ today: { date: '2026-11-09', ...tok(1), total: NaN } }),
    'today.input negatif': sample({ today: { date: '2026-11-09', ...tok(1), input: -1 } }),
    'today.output Infinity': sample({ today: { date: '2026-11-09', ...tok(1), output: Infinity } }),
    'today.cacheRead teks': sample({ today: { date: '2026-11-09', ...tok(1), cacheRead: '5' } }),
    'today.date salah': sample({ today: { ...tok(1), date: '9 Nov' } }),
    'days bukan array': sample({ days: { 0: tok(1) } }),
    'days berisi null': sample({ days: [null] }),
    'days total negatif': sample({ days: [{ date: '2026-11-09', ...tok(1), total: -5 }] }),
    'weekly hilang': sample({ weekly: null }),
    'weekly.used NaN': weekly({ used: NaN }),
    'weekly.limit 0': weekly({ limit: 0 }),
    'weekly.limit negatif': weekly({ limit: -5 }),
    'weekly.limit teks': weekly({ limit: '5000000' }),
    'weekly.percent negatif': weekly({ percent: -1 }),
    'weekly.percent Infinity': weekly({ percent: Infinity }),
    'weekly.level asing': weekly({ level: 'purple' }),
    'weekly.configAvailable teks': weekly({ configAvailable: 'yes' }),
    'perAgent bukan array': sample({ perAgent: 'dev-qa' }),
    'perAgent tanpa nama': sample({ perAgent: [{ ...tok(1), runs: 1 }] }),
    'perAgent runs negatif': sample({ perAgent: [{ agent: 'dev-qa', ...tok(1), runs: -1 }] }),
    'perAgent total NaN': sample({ perAgent: [{ agent: 'dev-qa', ...tok(1), total: NaN, runs: 1 }] }),
  };

  it.each(Object.entries(broken))('%s', (_label, raw) => {
    const r = validateUsage(raw);
    expect(r.ok).toBe(false);
    expect(typeof r.reason).toBe('string');
    const st = usageState(r);
    expect(st.status).toBe('unavailable');
    expect(isLimitWarning(st)).toBe(false);
  });

  it('getter yang melempar tetap ditangani (tidak ada exception)', () => {
    const evil = sample();
    Object.defineProperty(evil, 'weekly', { get() { throw new Error('boom'); } });
    expect(() => validateUsage(evil)).not.toThrow();
    expect(validateUsage(evil)).toEqual({ ok: false, reason: UNAVAILABLE_TEXT });
  });

  it('available false: alasan dari server (dibersihkan) dipakai bila ada, selain itu "data tidak tersedia"', () => {
    expect(validateUsage({ available: false, reason: 'no-transcripts\u001b[0m' })).toEqual({ ok: false, reason: 'no-transcripts' });
    expect(validateUsage({ available: false, reason: null }).reason).toBe(UNAVAILABLE_TEXT);
    expect(UNAVAILABLE_TEXT).toBe('data tidak tersedia');
  });

  it('parseUsageResponse: fetch gagal, HTTP error, atau ok:false → tidak tersedia', () => {
    expect(parseUsageResponse(null, undefined).ok).toBe(false);
    expect(parseUsageResponse(500, { ok: true, usage: sample() }).ok).toBe(false);
    expect(parseUsageResponse(401, { error: 'unauthorized' }).ok).toBe(false);
    expect(parseUsageResponse(200, { ok: false }).ok).toBe(false);
    expect(parseUsageResponse(200, 'html').ok).toBe(false);
    expect(parseUsageResponse(200, { ok: true, usage: { available: true } }).ok).toBe(false);
    expect(parseUsageResponse(200, { ok: true, usage: sample() }).ok).toBe(true);
  });
});

describe('pemicu peringatan manajer (> 85%)', () => {
  const st = (w) => usageState(validateUsage(weekly(w)));
  it.each([
    [{ percent: 59, level: 'green' }, false],
    [{ percent: 60, level: 'yellow' }, false],
    [{ percent: 85, level: 'yellow' }, false],
    [{ percent: 86, level: 'red' }, true],
    [{ percent: 86, level: null }, true],
    [{ percent: 85, level: null }, false],
    [{ percent: 99, level: 'red', configAvailable: false }, false],
  ])('%j → %s', (w, on) => {
    expect(isLimitWarning(st(w))).toBe(on);
  });

  it('loading / kosong / tidak tersedia → tanpa peringatan', () => {
    expect(isLimitWarning({ status: 'loading' })).toBe(false);
    expect(isLimitWarning(null)).toBe(false);
    expect(isLimitWarning(undefined)).toBe(false);
    expect(isLimitWarning({ status: 'unavailable', reason: 'x' })).toBe(false);
    expect(WARNING_TEXT).toBe('Limit hampir habis, hemat mode');
  });

  it('displayUsage: data simulasi hanya menimpa tampilan; null → kembali ke data server', () => {
    const real = usageState(validateUsage(weekly({ percent: 30, level: 'green' })));
    const sim = validateUsage(weekly({ percent: 92, level: 'red' })).usage;
    const shown = displayUsage(real, sim);
    expect(shown).toMatchObject({ status: 'ok', sim: true });
    expect(isLimitWarning(shown)).toBe(true);
    expect(displayUsage(real, null)).toBe(real);
    expect(isLimitWarning(displayUsage(real, null))).toBe(false);
    expect(real.usage.weekly.percent).toBe(30); // data asli tidak tersentuh
  });
});

// ------------------------------------------------------------------------------ src/net.js

describe('src/net.js: pesan WebSocket usage + GET /api/usage', () => {
  class FakeWS {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      FakeWS.instances.push(this);
    }
    message(data) {
      this.onmessage?.({ data: typeof data === 'string' ? data : JSON.stringify(data) });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const setup = () => {
    FakeWS.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol: 'http:', host: 'office.example.com' });
  };
  const handlers = (extra = {}) => ({ onEvent: vi.fn(), onHistory: vi.fn(), onStatus: vi.fn(), ...extra });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('{ kind: "usage" } → onUsage dipanggil; callback lama tetap jalan', () => {
    setup();
    const onUsage = vi.fn();
    const h = handlers({ onUsage });
    const c = connect(h);
    const ws = FakeWS.instances[0];
    ws.message({ kind: 'hello', events: [] });
    ws.message({ kind: 'usage', usage: sample() });
    ws.message({ kind: 'event', event: { type: 'done' } });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0][0].today.total).toBe(1_234_567);
    expect(h.onHistory).toHaveBeenCalledTimes(1);
    expect(h.onEvent).toHaveBeenCalledTimes(1);
    c.close();
  });

  it('tanpa onUsage, pesan usage diabaikan; callback yang melempar atau JSON null tidak memutus koneksi', () => {
    setup();
    const h = handlers();
    const c = connect(h);
    const ws = FakeWS.instances[0];
    expect(() => ws.message({ kind: 'usage', usage: sample() })).not.toThrow();
    expect(() => ws.message('null')).not.toThrow();
    expect(() => ws.message('42')).not.toThrow();
    c.close();
    setup();
    const c2 = connect(handlers({ onUsage: () => { throw new Error('ui rusak'); } }));
    expect(() => FakeWS.instances[0].message({ kind: 'usage', usage: {} })).not.toThrow();
    c2.close();
  });

  it('getUsage: GET /api/usage tanpa cache; fetch gagal → status null (tidak melempar)', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, json: async () => ({ ok: true, usage: sample() }) }));
    vi.stubGlobal('fetch', fetchMock);
    const r = await getUsage();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/usage');
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: 'no-store', credentials: 'same-origin' });
    expect(parseUsageResponse(r.status, r.body).ok).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('offline');
    }));
    const bad = await getUsage();
    expect(bad).toEqual({ status: null, body: undefined });
    expect(parseUsageResponse(bad.status, bad.body)).toEqual({ ok: false, reason: UNAVAILABLE_TEXT });
  });
});
