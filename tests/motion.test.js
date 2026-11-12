// Tahap 2: gerak berbasis waktu (delta time), easing, tanpa lompatan saat tab kembali aktif, dan reduced motion.
import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import {
  MAX_FRAME_DT, advanceAlongPath, easeInOutQuad, easeOutBack, easeOutCubic, frameDelta,
  nextSpeed, prefersReducedMotion, remainingLength, watchReducedMotion,
} from '../src/motion.js';
import { Office, TUNING } from '../src/office/engine.js';
import { H, W } from '../src/office/layout.js';
import { fitCanvas } from '../src/office/fit.js';

const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;

describe('easing', () => {
  it.each([easeOutCubic, easeInOutQuad, easeOutBack])('%o: 0 → 0 dan 1 → 1, di luar rentang dijepit', (f) => {
    expect(f(0)).toBeCloseTo(0, 10);
    expect(f(1)).toBeCloseTo(1, 10);
    expect(f(-5)).toBeCloseTo(0, 10);
    expect(f(7)).toBeCloseTo(1, 10);
  });

  it('easeOutCubic naik terus dan melambat; easeInOutQuad simetris', () => {
    let prev = 0;
    let prevStep = Infinity;
    for (let i = 1; i <= 20; i++) {
      const v = easeOutCubic(i / 20);
      expect(v).toBeGreaterThan(prev);
      expect(v - prev).toBeLessThanOrEqual(prevStep + 1e-12);
      prevStep = v - prev;
      prev = v;
    }
    for (const t of [0.1, 0.25, 0.4]) expect(easeInOutQuad(t) + easeInOutQuad(1 - t)).toBeCloseTo(1, 10);
  });

  it('easeOutBack sedikit melampaui 1 lalu kembali (membal)', () => {
    const peak = Math.max(...Array.from({ length: 50 }, (_, i) => easeOutBack(i / 49)));
    expect(peak).toBeGreaterThan(1.05);
    expect(peak).toBeLessThan(1.2);
  });
});

describe('kecepatan: ease-in di awal, ease-out di akhir', () => {
  /** Jalan lurus sejauh `dist` dengan langkah waktu dari `dtOf(step)`. */
  function walk(dist, dtOf, target = TUNING.walkSpeed) {
    let pos = { x: 0, y: 0 };
    let path = [{ x: dist, y: 0 }];
    let speed = 0;
    const speeds = [];
    const xs = [];
    let steps = 0;
    while (path.length && steps < 100000) {
      const dt = dtOf(steps++);
      speed = nextSpeed({
        speed, target, remaining: remainingLength(pos, path), dt,
        accel: TUNING.accel, decel: TUNING.decel, minSpeed: TUNING.minSpeed,
      });
      const r = advanceAlongPath(pos, path, speed * dt);
      pos = { x: r.x, y: r.y };
      path = r.path;
      speeds.push(speed);
      xs.push(pos.x);
    }
    return { pos, speeds, xs, steps, done: path.length === 0 };
  }

  it('mulai pelan, mencapai kecepatan jalan, lalu melambat sebelum berhenti', () => {
    const { speeds, done } = walk(300, () => 1 / 60);
    expect(done).toBe(true);
    expect(speeds[0]).toBeLessThan(TUNING.walkSpeed * 0.2); // ease-in
    expect(Math.max(...speeds)).toBeCloseTo(TUNING.walkSpeed, 5);
    expect(Math.max(...speeds)).toBeLessThanOrEqual(TUNING.walkSpeed + 1e-9);
    expect(speeds.at(-1)).toBeLessThan(TUNING.walkSpeed * 0.5); // ease-out
    // sesudah puncak, kecepatan tidak naik lagi
    const peak = speeds.indexOf(Math.max(...speeds));
    for (let i = peak + 1; i < speeds.length - 1; i++) expect(speeds[i]).toBeLessThanOrEqual(speeds[i - 1] + 1e-9);
  });

  it.each([1 / 120, 1 / 60, 1 / 30, 0.1, 0.25, 1, 5, 60])('langkah waktu %f detik tidak pernah melewati tujuan', (dt) => {
    for (const dist of [0.5, 3, 40, 300, 700]) {
      const { pos, xs, done, steps } = walk(dist, () => dt);
      expect(done, `dist ${dist}`).toBe(true);
      expect(steps).toBeLessThan(100000);
      expect(pos.x).toBe(dist); // tepat di tujuan
      for (const x of xs) expect(x).toBeLessThanOrEqual(dist);
      for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]); // tidak mundur
    }
  });

  it('langkah raksasa (tab tertidur lama) sampai di tujuan sekali jalan, bukan melompat melewatinya', () => {
    const r = advanceAlongPath({ x: 0, y: 0 }, [{ x: 10, y: 0 }, { x: 10, y: 30 }], 1e9);
    expect(r).toMatchObject({ x: 10, y: 30, path: [], moved: 40 });
  });

  it('kecepatan tidak pernah negatif atau NaN, juga dengan masukan ganjil', () => {
    for (const speed of [-5, 0, 50, 1e6]) {
      for (const remaining of [-1, 0, 0.001, 10, 1e6]) {
        const v = nextSpeed({ speed, target: 105, remaining, dt: 0.016 });
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(Math.max(105, speed));
      }
    }
  });
});

describe('advanceAlongPath', () => {
  it('maju sebagian dan menyisakan jalur', () => {
    const r = advanceAlongPath({ x: 0, y: 0 }, [{ x: 10, y: 0 }, { x: 10, y: 10 }], 15);
    expect(r.x).toBe(10);
    expect(r.y).toBe(5);
    expect(r.path).toEqual([{ x: 10, y: 10 }]);
    expect(r.moved).toBe(15);
    expect(r.facing).toBe('down');
  });

  it('arah hadap mengikuti segmen terakhir; tidak bergerak → null', () => {
    expect(advanceAlongPath({ x: 5, y: 5 }, [{ x: 0, y: 5 }], 1).facing).toBe('left');
    expect(advanceAlongPath({ x: 5, y: 5 }, [{ x: 9, y: 5 }], 1).facing).toBe('right');
    expect(advanceAlongPath({ x: 5, y: 5 }, [{ x: 5, y: 0 }], 1).facing).toBe('up');
    expect(advanceAlongPath({ x: 5, y: 5 }, [{ x: 5, y: 0 }], 0).facing).toBeNull();
    expect(advanceAlongPath({ x: 5, y: 5 }, [], 10)).toMatchObject({ x: 5, y: 5, moved: 0, path: [] });
  });

  it('budget negatif dianggap nol', () => {
    expect(advanceAlongPath({ x: 0, y: 0 }, [{ x: 4, y: 0 }], -3)).toMatchObject({ x: 0, y: 0, moved: 0 });
  });
});

describe('delta time frame dan tab yang kembali aktif', () => {
  it('selisih waktu dijepit ke [0, 0,1] detik', () => {
    expect(frameDelta(1016, 1000)).toBeCloseTo(0.016, 6);
    expect(frameDelta(61000, 1000)).toBe(MAX_FRAME_DT); // tab tertidur satu menit
    expect(frameDelta(1000, 2000)).toBe(0); // jam mundur
    expect(frameDelta(5, 5)).toBe(0);
    expect(frameDelta(undefined, 5)).toBe(0); // NaN → 0
  });

  it('manajer di tengah jalan: satu frame besar setelah tab kembali hanya menggeser seperlunya', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', '3d-render'));
    for (let i = 0; i < 90; i++) o.update(1 / 60);
    expect(o.manager.state).toBe('walking');
    const before = { x: o.manager.x, y: o.manager.y };
    o.update(frameDelta(120_000, 0)); // dua menit tertidur → satu frame 0,1 detik
    const moved = Math.hypot(o.manager.x - before.x, o.manager.y - before.y);
    expect(moved).toBeLessThanOrEqual(TUNING.rushSpeed * MAX_FRAME_DT + 1e-6);
    expect(o.manager.state).toBe('walking');
  });

  it('update(dt) yang sangat besar atau ganjil tidak merusak posisi manajer', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-qa'));
    for (const dt of [1e9, -3, NaN, Infinity, undefined, 0.5, 100]) {
      o.update(dt);
      expect(Number.isFinite(o.manager.x) && Number.isFinite(o.manager.y)).toBe(true);
      expect(o.manager.x).toBeGreaterThanOrEqual(0);
      expect(o.manager.x).toBeLessThanOrEqual(W);
      expect(o.manager.y).toBeGreaterThanOrEqual(0);
      expect(o.manager.y).toBeLessThanOrEqual(H);
    }
  });
});

describe('gerak manajer di engine memakai easing dan tiba tepat di tujuan', () => {
  it('profil kecepatan: pelan di awal, penuh di tengah, pelan saat tiba; berhenti persis di depan meja', () => {
    const o = new Office();
    const target = o.workers.get('3d-render').front;
    o.handleEvent(ev('assign', 'manager', '3d-render'));
    const speeds = [];
    let arrivedAt = null;
    for (let i = 0; i < 60 * 30 && !arrivedAt; i++) {
      o.update(1 / 60);
      if (o.manager.state === 'walking') speeds.push(o.manager.speed);
      if (o.manager.state === 'talking') arrivedAt = { x: o.manager.x, y: o.manager.y };
    }
    expect(arrivedAt).toEqual({ x: target.x, y: target.y });
    expect(speeds[0]).toBeLessThan(TUNING.walkSpeed * 0.4);
    expect(Math.max(...speeds)).toBeCloseTo(TUNING.walkSpeed, 3);
    expect(speeds.at(-1)).toBeLessThan(TUNING.walkSpeed * 0.5);
  });

  it('tiba juga kalau frame sangat kasar (10 fps) dan sangat halus (240 fps)', () => {
    for (const dt of [0.1, 1 / 240]) {
      const o = new Office();
      const target = o.workers.get('dev-qa').front;
      o.handleEvent(ev('assign', 'manager', 'dev-qa'));
      let arrived = null;
      for (let i = 0; i < 40 / dt && !arrived; i++) {
        o.update(dt);
        if (o.manager.state === 'talking') arrived = { x: o.manager.x, y: o.manager.y };
      }
      expect(arrived, `dt ${dt}`).toEqual({ x: target.x, y: target.y });
    }
  });

  it('antrean tugas: manajer tidak berhenti total di tiap persimpangan jalur, dan tetap tiba semuanya', () => {
    const o = new Office();
    for (const a of ['dev-qa', 'sales-pricing', 'content-script', '3d-modeler']) o.handleEvent(ev('assign', 'manager', a));
    for (let i = 0; i < 60 * 60; i++) o.update(1 / 60);
    expect(o.stats.deliveries).toBe(4);
    expect(o.manager.state).toBe('sitting');
    expect(o.manager.speed).toBe(0);
  });
});

describe('reduced motion', () => {
  const win = (matches, listeners = []) => ({
    matchMedia: (q) => ({
      matches: q.includes('reduce') ? matches : false,
      addEventListener: (t, h) => listeners.push([t, h]),
      removeEventListener: (t, h) => { const i = listeners.findIndex((l) => l[1] === h); if (i >= 0) listeners.splice(i, 1); },
    }),
  });

  it('membaca preferensi sistem; tanpa matchMedia atau saat error → false', () => {
    expect(prefersReducedMotion(win(true))).toBe(true);
    expect(prefersReducedMotion(win(false))).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(prefersReducedMotion({ matchMedia() { throw new Error('x'); } })).toBe(false);
  });

  it('watchReducedMotion memberi tahu perubahan dan bisa dihentikan', () => {
    const listeners = [];
    const seen = [];
    const stop = watchReducedMotion((v) => seen.push(v), win(false, listeners));
    expect(listeners).toHaveLength(1);
    listeners[0][1]({ matches: true });
    listeners[0][1]({ matches: false });
    expect(seen).toEqual([true, false]);
    stop();
    expect(listeners).toHaveLength(0);
    expect(typeof watchReducedMotion(() => {}, {})).toBe('function');
  });

  it('amplop terbang lurus (tanpa lengkung) saat reduced motion; informasi (amplop tiba) tetap sama', () => {
    const fly = (reduced) => {
      const o = new Office();
      o.setReducedMotion(reduced);
      o.handleEvent(ev('assign', 'manager', 'dev-qa'), { instant: true });
      o.handleEvent(ev('done', 'dev-qa', 'manager', 'selesai'));
      expect(o.envelopes).toHaveLength(1);
      const env = o.envelopes[0];
      let maxLift = 0;
      for (let i = 0; i < 200 && o.envelopes.length; i++) {
        o.update(1 / 60);
        const e = o.envelopes[0];
        if (!e) break;
        const linearY = e.from.y + (e.to.y - e.from.y) * e.t;
        maxLift = Math.max(maxLift, linearY - e.y);
      }
      return { maxLift, arrived: o.inbox, env };
    };
    const normal = fly(false);
    const reduced = fly(true);
    expect(normal.maxLift).toBeGreaterThan(5);
    expect(reduced.maxLift).toBeLessThan(1e-9);
    expect(reduced.arrived).toBe(normal.arrived);
    expect(reduced.arrived).toBe(1);
  });

  it('setReducedMotion bertahan setelah reset()', () => {
    const o = new Office();
    o.setReducedMotion(true);
    o.reset();
    expect(o.reducedMotion).toBe(true);
  });
});

describe('ukuran kanvas: skala tajam di layar besar, tidak berubah di layar kecil', () => {
  it('layar kecil (320 sampai 768): memakai ruang yang ada, tanpa pembulatan, tidak melebihi lebar', () => {
    for (let w = 320; w <= 768; w += 8) {
      for (const dpr of [1, 2, 3]) {
        const avail = w - 16 - 12; // padding stage + bingkai ringkas
        const r = fitCanvas({ availW: avail, availH: Infinity, dpr });
        expect(r.snapped, `w ${w} dpr ${dpr}`).toBe(false);
        expect(r.cssW).toBeLessThanOrEqual(avail);
        expect(r.cssW).toBeGreaterThanOrEqual(avail - 1);
        expect(Math.abs(r.cssH - (r.cssW * H) / W)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('lebar sangat sempit tetap memberi kanvas minimum', () => {
    expect(fitCanvas({ availW: 100, availH: Infinity }).cssW).toBe(240);
  });

  it('1440 lebar: dibatasi tinggi, rasio tetap', () => {
    const r = fitCanvas({ availW: 1000, availH: 600 });
    expect(r.cssH).toBeLessThanOrEqual(600);
    expect(r.cssW).toBeLessThanOrEqual(1000);
    expect(Math.abs(r.cssW / r.cssH - W / H)).toBeLessThan(0.01);
    expect(r.snapped).toBe(false);
  });

  it('layar besar: dibulatkan ke kelipatan bulat piksel bila kehilangan ruangnya kecil', () => {
    const r = fitCanvas({ availW: 1450, availH: 2000, dpr: 1 });
    expect(r).toMatchObject({ cssW: 1440, cssH: 1224, scale: 3, snapped: true });
    const hi = fitCanvas({ availW: 1000, availH: 2000, dpr: 2 });
    expect(hi).toMatchObject({ cssW: 960, scale: 4, snapped: true }); // 4 piksel perangkat per piksel logis
  });

  it('layar besar tapi pembulatan akan memangkas banyak: pakai skala pecahan penuh', () => {
    const r = fitCanvas({ availW: 1294, availH: 1100, dpr: 1 }); // 2,7x: dibulatkan ke 2x berarti -26%
    expect(r.snapped).toBe(false);
    expect(r.cssW).toBe(1294);
  });

  it('hasil tidak pernah melebihi ruang yang tersedia, untuk banyak ukuran layar dan DPR', () => {
    for (const dpr of [1, 1.25, 1.5, 2, 3]) {
      for (let w = 300; w <= 3400; w += 97) {
        for (let h = 300; h <= 2000; h += 131) {
          const r = fitCanvas({ availW: w, availH: h, dpr });
          const max = Math.max(240, Math.min(w, (h * W) / H));
          expect(r.cssW, `${w}x${h}@${dpr}`).toBeLessThanOrEqual(max + 1e-6);
          expect(Math.abs(r.cssH * W - r.cssW * H)).toBeLessThanOrEqual(W); // rasio terjaga (≤ 1px)
        }
      }
    }
  });
});
