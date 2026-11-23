// Fase 4: siklus siang-malam real-time. Jam SELALU disuntik; zona waktu dipin (TZ) di test yang bergantung padanya.
// Mencakup: batas jam fase, pengamat fase (jam + timer palsu), mode waktu (auto/manual/off) dan migrasi pengaturan lama,
// renderer (cache latar per tema|varian|fase, tint per frame, semua tema x lima fase), kontras label di bawah tint, dan
// perilaku worker ngantuk (deterministik, hanya idle, tidak mengubah status).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { blend, contrast } from '../src/contrast.js';
import {
  LAMP_COLOR, PHASES, PHASE_CHECK_MS, PHASE_LOOK, PHASE_START, isPhase, lookOf, phaseAt, sleepinessOf, variantOfPhase, watchPhase,
} from '../src/office/daycycle.js';
import { Office, SLEEPY_LINES } from '../src/office/engine.js';
import { H, W } from '../src/office/layout.js';
import { CONTRAST_PAIRS, paletteForTheme } from '../src/office/palette.js';
import { QUIRKS, YAWN_CHANCE, yawnPhase } from '../src/office/quirks.js';
import { createRenderer, workerSpec } from '../src/office/render.js';
import { registry } from '../src/office/themeRegistry.js';
import { hasKey, t } from '../src/i18n.js';
import {
  LEGACY_TIME_MODES, SETTINGS_KEY, SETTINGS_VERSION, createSettingsStore, loadSettings, normalizeTimeMode, parseSettings,
  resolvePhase, resolveVariant, sanitizeSettings,
} from '../src/settings.js';
import { canvasFactory } from './helpers/recordCanvas.js';

const TZ_PIN = 'Asia/Jakarta'; // UTC+7, tanpa DST
let prevTz;
beforeAll(() => {
  prevTz = process.env.TZ;
  process.env.TZ = TZ_PIN;
});
afterAll(() => {
  if (prevTz === undefined) delete process.env.TZ;
  else process.env.TZ = prevTz;
});

/** Waktu lokal (zona yang dipin) pada 10 Maret 2026. */
const at = (h, m = 0, s = 0) => new Date(2026, 2, 10, h, m, s).getTime();
const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;

// ------------------------------------------------------------------ fase dari jam lokal

describe('phaseAt: batas jam fase (jam lokal)', () => {
  it('tabel batas: tepat di batas dan sedetik sebelumnya', () => {
    const rows = [
      [0, 0, 'malam'], [3, 59, 'malam'], [4, 0, 'subuh'], [5, 59, 'subuh'], [6, 0, 'pagi'], [10, 59, 'pagi'],
      [11, 0, 'siang'], [14, 59, 'siang'], [15, 0, 'sore'], [17, 59, 'sore'], [18, 0, 'malam'], [23, 59, 'malam'],
    ];
    for (const [h, m, want] of rows) expect(phaseAt(at(h, m)), `${h}:${m}`).toBe(want);
    expect(phaseAt(at(3, 59, 59))).toBe('malam');
    expect(phaseAt(at(5, 59, 59))).toBe('subuh');
    expect(phaseAt(at(17, 59, 59))).toBe('sore');
  });

  it('PHASE_START konsisten dengan phaseAt: tiap jam 0-23 masuk tepat satu fase dan urutannya benar', () => {
    const seq = Array.from({ length: 24 }, (_, h) => phaseAt(at(h)));
    expect(new Set(seq)).toEqual(new Set(PHASES));
    for (const p of PHASES) expect(phaseAt(at(PHASE_START[p]))).toBe(p);
    // malam melewati tengah malam: 18..23 dan 0..3 adalah malam yang sama
    expect(seq.slice(18)).toEqual(Array(6).fill('malam'));
    expect(seq.slice(0, 4)).toEqual(Array(4).fill('malam'));
  });

  it('lewat tengah malam: 23:59:59 → 00:00:00 tetap malam, lalu 04:00 subuh', () => {
    expect(phaseAt(at(23, 59, 59))).toBe('malam');
    expect(phaseAt(new Date(2026, 2, 11, 0, 0, 0))).toBe('malam');
    expect(phaseAt(new Date(2026, 2, 11, 4, 0, 0))).toBe('subuh');
  });

  it('memakai jam LOKAL zona yang dipin: instan UTC yang sama = fase berbeda di zona berbeda', () => {
    const utc = Date.UTC(2026, 2, 10, 21, 0, 0); // 21:00 UTC
    process.env.TZ = 'Asia/Jakarta'; // 04:00 lokal
    expect(phaseAt(utc)).toBe('subuh');
    process.env.TZ = 'America/New_York'; // 17:00 lokal (EDT, 10 Maret 2026 sudah DST)
    expect(phaseAt(utc)).toBe('sore');
    process.env.TZ = 'Pacific/Auckland'; // 10:00 lokal (NZDT)
    expect(phaseAt(utc)).toBe('pagi');
    process.env.TZ = TZ_PIN;
    expect(phaseAt(utc)).toBe('subuh');
  });

  it('menerima ms epoch dan Date; nilai tidak sah jatuh ke siang tanpa melempar', () => {
    expect(phaseAt(new Date(at(20)))).toBe('malam');
    for (const bad of [NaN, undefined, 'bukan tanggal', Infinity]) expect(phaseAt(bad)).toBe('siang');
  });

  it('tidak membaca jam global (Date.now) dan murni: hasil sama untuk masukan sama', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      expect([phaseAt(at(7)), phaseAt(at(7)), phaseAt(at(16))]).toEqual(['pagi', 'pagi', 'sore']);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('parameter visual per fase', () => {
  it('lima fase, objek beku, varian palet: subuh/malam = night, pagi/siang/sore = day', () => {
    expect(PHASES).toEqual(['subuh', 'pagi', 'siang', 'sore', 'malam']);
    expect(Object.isFrozen(PHASE_LOOK)).toBe(true);
    expect(Object.keys(PHASE_LOOK)).toEqual(PHASES);
    expect(PHASES.map(variantOfPhase)).toEqual(['night', 'day', 'day', 'day', 'night']);
    for (const p of PHASES) expect(Object.isFrozen(PHASE_LOOK[p])).toBe(true);
  });

  it('lampu menyala di subuh, sore, dan malam; mati di pagi dan siang', () => {
    expect(PHASES.map((p) => PHASE_LOOK[p].lamps > 0)).toEqual([true, false, false, true, true]);
    expect(PHASE_LOOK.malam.lamps).toBe(1);
  });

  it('tint tipis (alpha ≤ 0,2; siang tanpa tint) dengan string CSS siap pakai; cahaya jendela berbeda per fase', () => {
    for (const p of PHASES) {
      const { tint, paneGlow, spill } = PHASE_LOOK[p];
      for (const l of [tint, paneGlow, spill]) {
        expect(l.alpha).toBeGreaterThanOrEqual(0);
        expect(l.css).toMatch(/^rgba\(\d+,\d+,\d+,[\d.]+\)$/);
      }
      expect(tint.alpha).toBeLessThanOrEqual(0.2);
    }
    expect(PHASE_LOOK.siang.tint.alpha).toBe(0);
    const glows = PHASES.map((p) => PHASE_LOOK[p].paneGlow.css);
    expect(new Set(glows).size).toBeGreaterThanOrEqual(4); // siang dan malam sama-sama tanpa cahaya kaca
    expect(new Set(PHASES.map((p) => PHASE_LOOK[p].spill.css)).size).toBe(5);
    expect(PHASE_LOOK.sore.paneGlow.css).not.toBe(PHASE_LOOK.pagi.paneGlow.css);
  });

  it('ngantuk hanya di subuh dan malam (malam penuh)', () => {
    expect(PHASES.map(sleepinessOf)).toEqual([0.6, 0, 0, 0, 1]);
    expect(sleepinessOf('apa')).toBe(0);
    expect(sleepinessOf(null)).toBe(0);
  });

  it('isPhase / lookOf menolak nama tak dikenal (termasuk kunci prototipe)', () => {
    for (const bad of ['auto', 'off', '', 'toString', '__proto__', 5, null, undefined]) {
      expect(isPhase(bad), String(bad)).toBe(false);
      expect(lookOf(bad)).toBeNull();
    }
    expect(isPhase('sore')).toBe(true);
    expect(LAMP_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ------------------------------------------------------------------ pengamat fase (jam dan timer disuntik)

describe('watchPhase: diperiksa per menit, hanya memberi tahu saat fase berganti', () => {
  it('memberi tahu fase awal, lalu hanya saat berganti; jam maju melewati batas', () => {
    let now = at(10, 58);
    let tick = null;
    const timers = [];
    const seen = [];
    const w = watchPhase({
      clock: () => now,
      onChange: (p) => seen.push(p),
      setTimer: (fn, ms) => { tick = fn; timers.push(ms); return 7; },
      clearTimer: vi.fn(),
    });
    expect(seen).toEqual(['pagi']);
    expect(timers).toEqual([PHASE_CHECK_MS]);
    expect(PHASE_CHECK_MS).toBe(60_000);
    now = at(10, 59);
    tick();
    expect(seen).toEqual(['pagi']); // fase sama: tidak ada pemberitahuan
    now = at(11, 0);
    tick();
    expect(seen).toEqual(['pagi', 'siang']);
    now = at(17, 59);
    tick();
    now = at(18, 0, 1);
    tick();
    now = at(23, 59);
    tick();
    now = new Date(2026, 2, 11, 4, 1).getTime();
    tick();
    expect(seen).toEqual(['pagi', 'siang', 'sore', 'malam', 'subuh']);
    expect(w.current()).toBe('subuh');
  });

  it('stop menghapus timer; check manual mengembalikan fase tanpa timer', () => {
    const clearTimer = vi.fn();
    let now = at(9);
    const w = watchPhase({ clock: () => now, setTimer: () => 42, clearTimer });
    now = at(16);
    expect(w.check()).toBe('sore');
    w.stop();
    expect(clearTimer).toHaveBeenCalledWith(42);
  });

  it('dengan timer palsu vitest: fase berganti setelah satu menit nyata maju, tanpa Date.now global', () => {
    vi.useFakeTimers();
    try {
      let now = at(14, 59, 30);
      const seen = [];
      const w = watchPhase({ clock: () => now, onChange: (p) => seen.push(p) });
      now = at(15, 0, 10);
      vi.advanceTimersByTime(PHASE_CHECK_MS);
      expect(seen).toEqual(['siang', 'sore']);
      w.stop();
      now = at(19);
      vi.advanceTimersByTime(PHASE_CHECK_MS * 3);
      expect(seen).toEqual(['siang', 'sore']); // sudah berhenti
    } finally {
      vi.useRealTimers();
    }
  });
});

// ------------------------------------------------------------------ mode waktu dan pengaturan

describe('mode waktu: auto, manual, off', () => {
  it('auto berganti fase dan varian saat jam yang disuntik maju', () => {
    const ph = (h) => resolvePhase('auto', { now: at(h) });
    expect([5, 8, 12, 16, 20, 2].map(ph)).toEqual(['subuh', 'pagi', 'siang', 'sore', 'malam', 'malam']);
    const v = (h, ui = 'light') => resolveVariant('auto', { uiTheme: ui, now: at(h) });
    expect([5, 8, 12, 16, 20, 2].map((h) => v(h))).toEqual(['night', 'day', 'day', 'day', 'night', 'night']);
    expect(v(20, 'light')).toBe('night'); // auto mengabaikan tema UI
    expect(v(12, 'dark')).toBe('day');
  });

  it('auto tidak membaca Date.now bila now disuntik', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      resolvePhase('auto', { now: at(9) });
      resolveVariant('auto', { now: at(9) });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('manual mengunci fase berapa pun jamnya', () => {
    for (const p of PHASES) {
      for (const h of [0, 7, 13, 19]) {
        expect(resolvePhase(p, { now: at(h) })).toBe(p);
        expect(resolveVariant(p, { now: at(h), uiTheme: 'light' })).toBe(variantOfPhase(p));
      }
    }
  });

  it('off = perilaku lama: tanpa fase, varian mengikuti tema terang/gelap UI, jam tidak berpengaruh', () => {
    for (const h of [3, 12, 21]) {
      expect(resolvePhase('off', { now: at(h) })).toBeNull();
      expect(resolveVariant('off', { uiTheme: 'light', now: at(h) })).toBe('day');
      expect(resolveVariant('off', { uiTheme: 'dark', now: at(h) })).toBe('night');
    }
    expect(resolvePhase('tak-dikenal', { now: at(9) })).toBeNull();
    expect(resolvePhase('toString', { now: at(9) })).toBeNull();
  });
});

describe('pengaturan: bawaan, migrasi nilai lama, nilai rusak', () => {
  const stored = (o) => JSON.stringify({ v: SETTINGS_VERSION, ...o });
  const mem = (init = {}) => {
    const m = new Map(Object.entries(init));
    return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), dump: () => Object.fromEntries(m) };
  };

  it('bawaan = off (tampilan lama, tanpa kejutan); versi pengaturan tidak naik', () => {
    expect(sanitizeSettings(undefined).timeMode).toBe('off');
    expect(SETTINGS_VERSION).toBe(1);
  });

  it('nilai lama dimigrasi: follow→off, day→siang, night→malam (tanpa naik versi)', () => {
    expect(LEGACY_TIME_MODES).toEqual({ follow: 'off', day: 'siang', night: 'malam' });
    for (const [old, now] of Object.entries(LEGACY_TIME_MODES)) {
      expect(parseSettings(stored({ timeMode: old })).timeMode).toBe(now);
      expect(normalizeTimeMode(old)).toBe(now);
      expect(resolveVariant(old, { uiTheme: 'dark', now: at(12) })).toBe(resolveVariant(now, { uiTheme: 'dark', now: at(12) }));
    }
    expect(normalizeTimeMode('auto')).toBe('auto');
    expect(normalizeTimeMode(42)).toBe(42);
  });

  it('pengguna lama (day/night tersimpan) tetap mendapat varian yang sama persis seperti dulu', () => {
    for (const ui of ['light', 'dark']) {
      expect(resolveVariant('day', { uiTheme: ui })).toBe('day');
      expect(resolveVariant('night', { uiTheme: ui })).toBe('night');
      expect(resolveVariant('follow', { uiTheme: ui })).toBe(ui === 'light' ? 'day' : 'night');
    }
  });

  it('muat dari storage: nilai lama dimigrasi di memori; storage ditulis ulang bentuk baru hanya saat pengguna mengubah sesuatu', () => {
    const s = mem({ [SETTINGS_KEY]: stored({ officeTheme: 'kafe', timeMode: 'night' }) });
    const store = createSettingsStore(s);
    expect(store.get().timeMode).toBe('malam');
    expect(JSON.parse(s.dump()[SETTINGS_KEY]).timeMode).toBe('night'); // belum ditulis
    store.set({ rain: true });
    expect(JSON.parse(s.dump()[SETTINGS_KEY]).timeMode).toBe('malam');
    expect(loadSettings(s).settings.timeMode).toBe('malam');
  });

  it('semua mode baru valid dan bisa disimpan lalu dimuat', () => {
    for (const m of ['off', 'auto', ...PHASES]) {
      const s = mem();
      createSettingsStore(s).set({ timeMode: m });
      expect(loadSettings(s).settings.timeMode).toBe(m);
    }
  });

  it('nilai rusak jatuh ke bawaan (off); kolom lain tetap', () => {
    for (const bad of [5, null, {}, [], 'Auto', ' auto', 'AUTO', 'senja', '__proto__', 'hasOwnProperty', true]) {
      expect(parseSettings(stored({ timeMode: bad, motion: 'reduce' }))).toMatchObject({ timeMode: 'off', motion: 'reduce' });
    }
  });
});

// ------------------------------------------------------------------ renderer

describe('renderer: fase hari dan cache latar', () => {
  let f;
  beforeEach(() => {
    f = canvasFactory();
    globalThis.document = { createElement: () => f.make(W, H) };
  });
  afterEach(() => {
    delete globalThis.document;
  });

  const setup = (opts = {}) => {
    const base = f.all.length;
    const main = f.make(W * 2, H * 2);
    const r = createRenderer(main, { theme: registry.defaultTheme, variant: 'day', ...opts });
    const [pix, bg] = f.all.slice(base + 1);
    return { r, main, pix, bg };
  };
  const office = () => {
    const o = new Office();
    o.update(0.5);
    return o;
  };
  const tintLines = (log, css) => log.filter((l) => l === `set fillStyle=${JSON.stringify(css)}`).length;

  it('fase berbeda = latar digambar ulang; tema, varian, dan fase sama = tidak digambar ulang', () => {
    const { r, bg } = setup({ phase: 'siang' });
    const n0 = bg.log.length;
    r.setTheme(registry.defaultTheme, 'day', 'siang');
    expect(bg.log.length).toBe(n0); // kunci sama
    r.setTheme(registry.defaultTheme, 'day', 'sore');
    const n1 = bg.log.length;
    expect(n1).toBeGreaterThan(n0); // fase baru: gambar ulang
    r.setTheme(registry.defaultTheme, 'day', 'sore');
    expect(bg.log.length).toBe(n1);
    r.setTheme(registry.defaultTheme, 'day', null);
    expect(bg.log.length).toBeGreaterThan(n1); // mati = kunci lain
    const n2 = bg.log.length;
    r.setTheme(registry.defaultTheme, 'night', null);
    expect(bg.log.length).toBeGreaterThan(n2); // varian beda
    const n3 = bg.log.length;
    r.setTheme(registry.get('kafe'), 'night', null);
    expect(bg.log.length).toBeGreaterThan(n3); // tema beda
  });

  it('nama fase tak dikenal sama dengan tanpa fase (kunci "-", tanpa efek)', () => {
    const { r, bg } = setup();
    const n = bg.log.length;
    r.setTheme(registry.defaultTheme, 'day', 'senja');
    r.setTheme(registry.defaultTheme, 'day', undefined);
    expect(bg.log.length).toBe(n);
  });

  it('latar tidak digambar ulang tiap frame untuk fase yang sama (cahaya fase ikut di-cache)', () => {
    const { r, bg } = setup({ phase: 'malam', variant: 'night' });
    const o = office();
    r.draw(o, at(21));
    const n = bg.log.length;
    for (let i = 0; i < 60; i++) {
      o.update(1 / 60);
      r.draw(o, at(21) + i * 16);
    }
    expect(bg.log.length).toBe(n);
  });

  it('fase menambah cahaya di latar: lampu dan cahaya jendela hanya saat relevan', () => {
    const lampLines = (phase, variant) => {
      const { bg } = setup({ phase, variant });
      return bg.log.filter((l) => l.includes('rgba(255,217,138,')).length; // LAMP_COLOR #ffd98a
    };
    expect(lampLines('malam', 'night')).toBeGreaterThan(0);
    expect(lampLines('sore', 'day')).toBeGreaterThan(0);
    expect(lampLines('subuh', 'night')).toBeGreaterThan(0);
    expect(lampLines('pagi', 'day')).toBe(0);
    expect(lampLines('siang', 'day')).toBe(0);
    expect(lampLines(null, 'night')).toBe(0);
    // cahaya kaca: sore berbeda dari pagi
    const glow = (phase) => setup({ phase, variant: 'day' }).bg.log.filter((l) => l === `set fillStyle=${JSON.stringify(PHASE_LOOK[phase].paneGlow.css)}`).length;
    expect(glow('sore')).toBeGreaterThan(0);
    expect(glow('pagi')).toBeGreaterThan(0);
  });

  it('tint fase: satu fillRect layar penuh per frame di lapisan pixel; tanpa fase / siang tidak ada', () => {
    const { r, pix } = setup({ phase: 'sore' });
    const o = office();
    pix.log.length = 0;
    r.draw(o, at(16));
    expect(tintLines(pix.log, PHASE_LOOK.sore.tint.css)).toBe(1);
    expect(pix.log).toContain(`fillRect(0,0,${W},${H})`);
    pix.log.length = 0;
    r.draw(o, at(16));
    expect(tintLines(pix.log, PHASE_LOOK.sore.tint.css)).toBe(1); // tetap satu per frame, tidak menumpuk
    for (const phase of [null, 'siang']) {
      const x = setup({ phase });
      x.pix.log.length = 0;
      x.r.draw(office(), at(12));
      for (const p of PHASES) if (PHASE_LOOK[p].tint.alpha > 0) expect(tintLines(x.pix.log, PHASE_LOOK[p].tint.css), `${phase}/${p}`).toBe(0);
    }
  });

  it('setTheme mengganti tint tanpa membuat renderer baru', () => {
    const { r, pix } = setup({ phase: 'subuh', variant: 'night' });
    const o = office();
    pix.log.length = 0;
    r.draw(o, at(5));
    expect(tintLines(pix.log, PHASE_LOOK.subuh.tint.css)).toBe(1);
    r.setTheme(registry.defaultTheme, 'night', 'malam');
    pix.log.length = 0;
    r.draw(o, at(20));
    expect(tintLines(pix.log, PHASE_LOOK.subuh.tint.css)).toBe(0);
    expect(tintLines(pix.log, PHASE_LOOK.malam.tint.css)).toBe(1);
  });

  it('semua tema terpasang dirender di kelima fase (dua varian) tanpa error, termasuk reduced motion', () => {
    expect(registry.themes.length).toBeGreaterThanOrEqual(5);
    for (const theme of registry.themes) {
      for (const phase of PHASES) {
        for (const reduced of [false, true]) {
          const { r, pix } = setup({ theme, variant: variantOfPhase(phase), phase });
          const o = office();
          o.setReducedMotion(reduced);
          o.setSleepy(sleepinessOf(phase));
          o.handleEvent(ev('assign', 'manager', 'dev-frontend'), { instant: true });
          for (let i = 0; i < 10; i++) o.update(0.1);
          expect(() => r.draw(o, at(12)), `${theme.id}/${phase}/${reduced}`).not.toThrow();
          expect(pix.log.length).toBeGreaterThan(100);
        }
      }
    }
  });

  it('reduced motion: dua frame pada waktu berbeda menghasilkan gambar identik walau fase aktif (malam)', () => {
    const { r, pix } = setup({ phase: 'malam', variant: 'night' });
    const o = office();
    o.setReducedMotion(true);
    o.setSleepy(1);
    const frame = (dt) => {
      o.update(dt);
      pix.log.length = 0;
      r.draw(o, at(23));
      return JSON.stringify(pix.log);
    };
    expect(frame(0.05)).toBe(frame(7.3));
  });

  it('jam renderer disuntik (clock): jam dinding tidak membaca Date.now', () => {
    const spy = vi.spyOn(Date, 'now');
    try {
      const { r } = setup({ phase: 'sore', clock: () => at(16) });
      r.draw(office(), at(16));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('kontras label tetap AA di bawah tint dan cahaya lampu (semua tema, semua fase)', () => {
  const lampsOnFloor = (floor, a) => {
    let c = floor;
    for (const al of [0.035, 0.04, 0.05]) c = blend(LAMP_COLOR, c, al * a); // tiga lapis kolam cahaya (scene.js)
    return c;
  };

  it('pasangan teks/latar kanvas ≥ 4,5:1 setelah tint fase (lampu dihitung di lantai)', () => {
    for (const theme of registry.themes) {
      for (const phase of PHASES) {
        const look = PHASE_LOOK[phase];
        const P = paletteForTheme(theme, look.variant);
        for (const [fg, bgKey, why] of CONTRAST_PAIRS) {
          let bgc = P[bgKey];
          if (bgKey === 'floor') bgc = lampsOnFloor(bgc, look.lamps);
          const tinted = look.tint.alpha > 0 ? blend(look.tint.color, bgc, look.tint.alpha) : bgc;
          expect(contrast(P[fg], tinted), `${theme.id}/${phase}: ${fg} di ${bgKey} (${why})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

// ------------------------------------------------------------------ perilaku worker ngantuk

describe('menguap: yawnPhase deterministik', () => {
  it('fungsi murni: masukan sama → keluaran sama; reduced motion dan sleepy 0 selalu -1', () => {
    for (let t = 0; t < 200; t += 0.37) {
      expect(yawnPhase(t, 1234, 1)).toBe(yawnPhase(t, 1234, 1));
      expect(yawnPhase(t, 1234, 1, true)).toBe(-1);
      expect(yawnPhase(t, 1234, 0)).toBe(-1);
      expect(yawnPhase(t, 1234, -1)).toBe(-1);
      expect(yawnPhase(t, 1234, NaN)).toBe(-1);
    }
  });

  it('fase di [0,1); malam menguap lebih sering daripada subuh; peluang mendekati YAWN_CHANCE', () => {
    const frac = (sleepy) => {
      let on = 0;
      let total = 0;
      for (let seed = 1; seed <= 200; seed += 7) {
        const off = (seed / 1000) * 2.3; // geser jendela per worker (quirks.js)
        for (let n = 0; n < 80; n++) { // satu sampel per jendela, di awalnya
          const p = yawnPhase(n * 13 - off + 0.5, seed, sleepy);
          total++;
          if (p >= 0) {
            on++;
            expect(p).toBeLessThan(1);
          }
        }
      }
      return on / total;
    };
    const full = frac(1);
    const half = frac(0.6);
    expect(full).toBeGreaterThan(half);
    expect(full).toBeGreaterThan(0.02);
    expect(full).toBeLessThan(YAWN_CHANCE + 0.05);
  });

  it('quirk yawn lama tetap ada dan bisa digambar', () => {
    expect(typeof QUIRKS.yawn.draw).toBe('function');
  });
});

describe('workerSpec: ngantuk hanya tampilan pada worker idle', () => {
  const seatIdle = (o, name = 'dev-qa') => o.workers.get(name);
  const findYawnTime = (seedMs) => {
    for (let t = 0; t < 600; t += 0.1) if (yawnPhase(t, seedMs, 1) >= 0) return t;
    return null;
  };

  it('sleepy 0: spec identik dengan perilaku lama untuk semua waktu', () => {
    const o = new Office();
    const w = seatIdle(o);
    for (let t = 0; t < 120; t += 0.7) expect(workerSpec(w, t, false, 1500, undefined, 0)).toEqual(workerSpec(w, t, false, 1500));
  });

  it('idle di meja: mulut terbuka saat jendela menguap; bukan saat working/blocked/done; tidak saat reduced motion', () => {
    const o = new Office();
    const w = seatIdle(o);
    const seed = 2222;
    const t = findYawnTime(seed);
    expect(t).not.toBeNull();
    // personalitas netral supaya act/quirk tidak mengganggu
    const neutral = { idle: 'coffee', quirk: null };
    const base = workerSpec(w, t, false, seed, neutral, 0);
    const sleepySpec = workerSpec(w, t, false, seed, neutral, 1);
    if (!base.act) expect(sleepySpec.mouth).toBe(true);
    expect(workerSpec(w, t, true, seed, neutral, 1).mouth).toBe(false);
    for (const status of ['working', 'blocked', 'done']) {
      const spec = workerSpec({ ...w, status }, t, false, seed, neutral, 1);
      expect(spec.mouth, status).toBe(workerSpec({ ...w, status }, t, false, seed, neutral, 0).mouth);
    }
  });

  it('worker di pantry minum kopi (sip) saat ngantuk, apa pun kebiasaan idle-nya', () => {
    const o = new Office();
    const w = { ...seatIdle(o), mode: 'pantry', stage: 'drink' };
    const water = { idle: 'water', quirk: null };
    let sip = 0;
    for (let t = 0; t < 4; t += 0.5) if (workerSpec(w, t, false, 10, water, 1).act === 'sip') sip++;
    expect(sip).toBeGreaterThan(0);
    for (let t = 0; t < 4; t += 0.5) expect(workerSpec(w, t, false, 10, water, 0).act).not.toBe('sip');
  });
});

describe('engine: ngantuk di malam/subuh (hanya tampilan, deterministik)', () => {
  const sleepyTexts = () => new Set(Array.from({ length: SLEEPY_LINES }, (_, i) => t(`office.sleepy.${i + 1}`)));

  /** Jalankan office `seconds` detik; hitung perjalanan pantry (seat→out) dan kumpulkan celetukan ngantuk. */
  const simulate = (seconds, { sleepy = 0, seed = 424242, setup = null } = {}) => {
    const o = new Office({ seed });
    if (sleepy !== null) o.setSleepy(sleepy);
    setup?.(o);
    const texts = sleepyTexts();
    const modes = new Map();
    const seen = new Set();
    const bubbles = [];
    const statuses = new Set();
    let trips = 0;
    for (let i = 0; i < seconds * 30; i++) {
      o.update(1 / 30);
      for (const w of o.workers.values()) {
        if (modes.get(w.name) === 'seat' && w.mode === 'out') trips++;
        modes.set(w.name, w.mode);
        statuses.add(w.status);
        const b = w.bubble;
        if (b?.ambient && texts.has(b.text) && !seen.has(`${w.name}@${b.born}`)) {
          seen.add(`${w.name}@${b.born}`);
          bubbles.push({ name: w.name, text: b.text, at: b.born, status: w.status });
        }
      }
    }
    return { o, trips, bubbles, statuses };
  };

  it('tingkat ngantuk dijepit 0..1 dan nilai aneh = 0; dipertahankan saat reset', () => {
    const o = new Office();
    o.setSleepy(5);
    expect(o.sleepy).toBe(1);
    for (const bad of [-3, NaN, undefined, 'x']) {
      o.setSleepy(bad);
      expect(o.sleepy).toBe(0);
    }
    o.setSleepy(0.6);
    o.reset();
    expect(o.sleepy).toBe(0.6);
  });

  it('deterministik: biji sama → perjalanan pantry dan celetukan sama persis', () => {
    const a = simulate(600, { sleepy: 1 });
    const b = simulate(600, { sleepy: 1 });
    expect(a.trips).toBe(b.trips);
    expect(a.bubbles).toEqual(b.bubbles);
    expect(a.bubbles.length).toBeGreaterThan(0);
    expect(simulate(600, { sleepy: 1, seed: 1 }).bubbles).not.toEqual(a.bubbles); // biji lain = urutan lain
  });

  it('malam: lebih sering ke pantry (kopi) daripada siang, pada biji yang sama', () => {
    const day = simulate(900, { sleepy: 0 });
    const night = simulate(900, { sleepy: 1 });
    expect(day.trips).toBeGreaterThan(0);
    expect(night.trips).toBeGreaterThan(day.trips);
  });

  it('sleepy 0 persis perilaku lama: setSleepy(0) tidak mengubah urutan perilaku dan tidak ada celetukan ngantuk', () => {
    const never = simulate(400, { sleepy: null });
    const zero = simulate(400, { sleepy: 0 });
    expect(zero.trips).toBe(never.trips);
    expect([...zero.o.workers.values()].map((w) => `${w.mode}|${w.x}|${w.y}`)).toEqual([...never.o.workers.values()].map((w) => `${w.mode}|${w.x}|${w.y}`));
    expect(zero.bubbles).toEqual([]);
  });

  it('hanya worker idle yang bergumam; yang bekerja tidak tersentuh; status, antrean, dan event tidak berubah', () => {
    const r = simulate(900, {
      sleepy: 1,
      seed: 7,
      setup: (o) => {
        o.handleEvent(ev('assign', 'manager', 'dev-backend'), { instant: true });
        o.handleEvent(ev('working', 'dev-backend', 'manager', 'sedang bekerja'), { instant: true });
      },
    });
    expect(r.bubbles.length).toBeGreaterThan(0);
    for (const b of r.bubbles) {
      expect(b.name).not.toBe('dev-backend');
      expect(b.status).toBe('idle');
    }
    expect(r.o.workers.get('dev-backend').status).toBe('working');
    for (const w of r.o.workers.values()) if (w.name !== 'dev-backend') expect(w.status).toBe('idle');
    expect(r.o.queue).toHaveLength(0);
    expect(r.o.stats.deliveries).toBe(0);
    expect(r.o.stats.events).toBe(simulate(1, { sleepy: 0, seed: 7, setup: (o) => {
      o.handleEvent(ev('assign', 'manager', 'dev-backend'), { instant: true });
      o.handleEvent(ev('working', 'dev-backend', 'manager', 'sedang bekerja'), { instant: true });
    } }).o.stats.events);
  });

  it('tanpa event semua worker tetap idle sepanjang malam', () => {
    expect([...simulate(600, { sleepy: 1 }).statuses]).toEqual(['idle']);
  });

  it('teks ngantuk ada di en dan id; jumlah baris sama dengan SLEEPY_LINES', () => {
    for (const lang of ['en', 'id']) {
      for (let i = 1; i <= SLEEPY_LINES; i++) expect(hasKey(`office.sleepy.${i}`, lang), `${lang} ${i}`).toBe(true);
      expect(hasKey(`office.sleepy.${SLEEPY_LINES + 1}`, lang)).toBe(false);
    }
  });

  it('reduced motion: tidak ada perjalanan pantry walau ngantuk (hanya celetukan teks)', () => {
    const o = new Office({ seed: 3 });
    o.setReducedMotion(true);
    o.setSleepy(1);
    for (let i = 0; i < 30 * 300; i++) {
      o.update(1 / 30);
      for (const w of o.workers.values()) expect(w.mode).toBe('seat');
    }
  });
});
