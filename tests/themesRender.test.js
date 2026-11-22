// Fase 3: renderer dengan tema. Jakarta identik dengan renderer lama (hash perintah gambar dari fixture yang dibuat
// SEBELUM sistem tema), tema lain menghasilkan gambar berbeda, cache latar direset saat tema ganti, jam dan RNG bisa
// disuntik, reduced motion dihormati, dan waktu per frame < 1 ms untuk setiap tema.
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Office } from '../src/office/engine.js';
import { H, W } from '../src/office/layout.js';
import { paletteFor, paletteForTheme } from '../src/office/palette.js';
import { createRenderer, resolveScene } from '../src/office/render.js';
import { drawBackground, drawClock, drawSkyFx, drawSteam, makeRnd } from '../src/office/scene.js';
import { t } from '../src/i18n.js';
import { registry } from '../src/office/themeRegistry.js';
import { canvasFactory, recordingCtx, sha } from './helpers/recordCanvas.js';
import { FIXED_NOW, scenarioOffice, snapshot } from './helpers/sceneSnapshot.js';

const golden = JSON.parse(readFileSync(new URL('./fixtures/jakarta-golden.json', import.meta.url), 'utf8'));
const jakarta = registry.defaultTheme;
const VARIANT_OF = { light: 'day', dark: 'night' };

const hashBg = (theme, variant, rng) => {
  const log = [];
  drawBackground(recordingCtx(log), paletteForTheme(theme, variant), theme.decor, theme.sprites, rng);
  return sha(log);
};

describe('jakarta identik dengan renderer lama', () => {
  it('API lama (string light/dark, tanpa dekorasi): sama dengan hash fixture dari renderer sebelum tema', () => {
    const api = { palette: paletteFor, background: drawBackground, themeArg: (k) => k, fxOpts: {} };
    expect(snapshot(api, 'light')).toEqual(golden.light);
    expect(snapshot(api, 'dark')).toEqual(golden.dark);
  });

  it('API tema: objek tema jakarta + varian day/night menghasilkan hash yang sama', () => {
    const api = {
      palette: (k) => paletteForTheme(jakarta, VARIANT_OF[k]),
      background: (c, P) => drawBackground(c, P, jakarta.decor, jakarta.sprites),
      themeArg: () => jakarta,
      variantArg: (k) => VARIANT_OF[k],
      fxOpts: { decor: jakarta.decor },
    };
    expect(snapshot(api, 'light')).toEqual(golden.light);
    expect(snapshot(api, 'dark')).toEqual(golden.dark);
  });

  it('fixture mencakup latar, efek langit, jam, uap, dan frame penuh', () => {
    for (const v of ['light', 'dark']) {
      expect(Object.keys(golden[v]).sort()).toEqual(['background', 'clock', 'clockReduced', 'frames', 'skyDay', 'skyRain', 'skyReduced', 'steam']);
      expect(golden[v].background.n).toBeGreaterThan(1000);
      expect(golden[v].frames.n).toBeGreaterThan(1000);
    }
  });
});

describe('resolveScene', () => {
  it("string tema UI lama: 'light' → jakarta siang, 'dark' → jakarta malam, tak dikenal → malam", () => {
    expect(resolveScene('light')).toEqual({ theme: jakarta, variant: 'day' });
    expect(resolveScene('dark')).toEqual({ theme: jakarta, variant: 'night' });
    expect(resolveScene('sepia')).toEqual({ theme: jakarta, variant: 'night' });
    expect(resolveScene(undefined)).toEqual({ theme: jakarta, variant: 'night' });
  });

  it('objek tema + varian', () => {
    const kafe = registry.get('kafe');
    expect(resolveScene(kafe, 'day')).toEqual({ theme: kafe, variant: 'day' });
    expect(resolveScene(kafe, 'apa-saja').variant).toBe('night');
  });
});

describe('tema lain menghasilkan gambar berbeda', () => {
  const others = registry.themes.filter((t) => t.id !== 'jakarta');

  it('latar setiap tema dan varian punya hash unik (10 gambar berbeda)', () => {
    const hashes = new Map();
    for (const t of registry.themes) {
      for (const v of ['day', 'night']) {
        const h = hashBg(t, v);
        expect(hashes.has(h), `${t.id}/${v} sama dengan ${hashes.get(h)}`).toBe(false);
        hashes.set(h, `${t.id}/${v}`);
      }
    }
    expect(hashes.size).toBe(registry.themes.length * 2);
  });

  it.each(others.map((t) => [t.id]))('%s: latar, efek langit, dan frame penuh berbeda dari jakarta', (id) => {
    const theme = registry.get(id);
    for (const key of ['light', 'dark']) {
      const api = {
        palette: (k) => paletteForTheme(theme, VARIANT_OF[k]),
        background: (c, P) => drawBackground(c, P, theme.decor, theme.sprites),
        themeArg: () => theme,
        variantArg: (k) => VARIANT_OF[k],
        fxOpts: { decor: theme.decor },
      };
      const snap = snapshot(api, key);
      expect(snap.background.sha).not.toBe(golden[key].background.sha);
      expect(snap.frames.sha).not.toBe(golden[key].frames.sha);
      expect(snap.skyDay.sha).not.toBe(golden[key].skyDay.sha);
    }
  });

  it('dekorasi benar-benar digambar: mengganti satu dekorasi mengubah latar', () => {
    const kafe = registry.get('kafe');
    const base = hashBg(kafe, 'day');
    for (const [key, alt] of [['skyline', 'stars'], ['windowStyle', 'blinds'], ['floor', 'tile'], ['wall', 'circuit'], ['plants', 'crystal'],
      ['posters', 'neon'], ['pantry', 'galley'], ['lights', 'fairy'], ['seed', 99], ['props', []]]) {
      const changed = { ...kafe, decor: { ...kafe.decor, [key]: alt } };
      expect(hashBg(changed, 'day'), key).not.toBe(base);
    }
  });

  it('semua kombinasi kosakata dekorasi bisa digambar tanpa error', () => {
    // setiap nilai kosakata dipasang bergantian pada tema jakarta
    for (const [key, values] of Object.entries({
      skyline: ['city', 'neon', 'stars', 'hills', 'none'], windowStyle: ['classic', 'plain', 'blinds'],
      floor: ['wood', 'tile', 'metal', 'carpet', 'checker'], wall: ['plain', 'brick', 'panel', 'stripe', 'circuit'],
      plants: ['leafy', 'cactus', 'crystal', 'none'], posters: ['classic', 'neon', 'art', 'none'],
      pantry: ['kopi', 'bar', 'espresso', 'galley'], lights: ['none', 'fairy', 'neon', 'pendant', 'strip'],
    })) {
      for (const v of values) {
        for (const variant of ['day', 'night']) {
          const t = { ...jakarta, decor: { ...jakarta.decor, [key]: v } };
          expect(() => hashBg(t, variant), `${key}=${v}`).not.toThrow();
          const log = [];
          expect(() => drawSkyFx(recordingCtx(log), paletteForTheme(t, variant), 2, { decor: t.decor, rain: 0.5 })).not.toThrow();
        }
      }
    }
  });

  it('sprite props menggambar piksel berwarna sprite pada titik pasangnya', () => {
    const theme = registry.get('startup-cozy');
    const log = [];
    drawBackground(recordingCtx(log), paletteForTheme(theme, 'day'), theme.decor, theme.sprites);
    const roket = theme.sprites.rocket.colors.R;
    expect(log.some((l, i) => l === `set fillStyle="${roket}"` && log[i + 1].startsWith('fillRect('))).toBe(true);
    const without = [];
    drawBackground(recordingCtx(without), paletteForTheme(theme, 'day'), { ...theme.decor, props: [] }, theme.sprites);
    expect(without.length).toBeLessThan(log.length);
  });

  it('props yang menunjuk sprite tak ada dilewati (tanpa error)', () => {
    const t = { ...jakarta, decor: { ...jakarta.decor, props: [{ sprite: 'hilang', slot: 'wall-left' }, { sprite: 'x', slot: 'tidak-ada' }] } };
    expect(() => hashBg(t, 'day')).not.toThrow();
    expect(hashBg(t, 'day')).toBe(hashBg(jakarta, 'day'));
  });
});

describe('RNG dan jam bisa disuntik', () => {
  it('tidak memakai Math.random di mana pun (deterministik): dua kali gambar sama persis', () => {
    const spy = vi.spyOn(Math, 'random');
    try {
      for (const t of registry.themes) for (const v of ['day', 'night']) expect(hashBg(t, v)).toBe(hashBg(t, v));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('rng yang disuntik dipakai: berbeda dari bawaan, deterministik, dan seed tema menggeser deret', () => {
    const cyber = registry.get('cyberpunk');
    const base = hashBg(cyber, 'night');
    const injected = hashBg(cyber, 'night', () => 0.5);
    expect(injected).not.toBe(base);
    expect(hashBg(cyber, 'night', () => 0.5)).toBe(injected);
    expect(hashBg({ ...cyber, decor: { ...cyber.decor, seed: 24 } }, 'night')).not.toBe(base);
    expect(makeRnd(0)(5)).toBe(makeRnd()(5));
    expect(makeRnd(3)(5)).not.toBe(makeRnd(0)(5));
    expect(makeRnd(3)(5)).toBe(makeRnd(3)(5));
    for (let i = 0; i < 50; i++) expect(makeRnd(7)(i)).toBeGreaterThanOrEqual(0);
  });

  it('rng disuntik ke efek langit juga', () => {
    const P = paletteForTheme(jakarta, 'night');
    const a = []; const b = [];
    drawSkyFx(recordingCtx(a), P, 3, { decor: jakarta.decor });
    drawSkyFx(recordingCtx(b), P, 3, { decor: jakarta.decor, rng: () => 0.9 });
    expect(sha(a)).not.toBe(sha(b));
  });

  describe('jam renderer', () => {
    let created;
    beforeEach(() => {
      created = canvasFactory();
      globalThis.document = { createElement: () => created.make() };
    });
    afterEach(() => {
      delete globalThis.document;
    });

    it('opsi clock dipakai untuk jarum jam; Date.now tidak dipanggil saat clock disuntik', () => {
      const dateNow = vi.spyOn(Date, 'now');
      try {
        const office = scenarioOffice(5);
        const run = (clock) => {
          const main = created.make(W * 2, H * 2);
          const r = createRenderer(main, { theme: 'light', clock });
          const pix = created.all[created.all.indexOf(main) + 1]; // lapisan piksel: jam dinding digambar di sini
          pix.log.length = 0;
          r.draw(office);
          return sha(pix.log);
        };
        const a = run(() => FIXED_NOW);
        const b = run(() => FIXED_NOW + 17 * 60 * 1000);
        expect(a).not.toBe(b);
        expect(run(() => FIXED_NOW)).toBe(a);
        expect(dateNow).not.toHaveBeenCalled();
      } finally {
        dateNow.mockRestore();
      }
    });
  });
});

describe('pergantian tema mereset cache latar', () => {
  let f;
  beforeEach(() => {
    f = canvasFactory();
    globalThis.document = { createElement: () => f.make() };
  });
  afterEach(() => {
    delete globalThis.document;
  });

  const setup = (theme, variant) => {
    const main = f.make(W * 2, H * 2);
    const r = createRenderer(main, { theme, variant });
    const [pix, bg] = f.all.slice(f.all.indexOf(main) + 1); // urutan pembuatan: pix, lalu latar
    return { r, main, pix, bg };
  };


  it('latar digambar sekali per tema/varian, bukan tiap frame', () => {
    const { r, bg } = setup(registry.get('kafe'), 'day');
    const office = scenarioOffice(5);
    const n = bg.log.length;
    expect(n).toBeGreaterThan(1000);
    for (let i = 0; i < 20; i++) {
      office.update(0.016);
      r.draw(office, FIXED_NOW);
    }
    expect(bg.log.length).toBe(n);
  });

  it('setTheme dengan tema/varian lain menggambar ulang latar; yang sama tidak', () => {
    const { r, bg } = setup(registry.get('kafe'), 'day');
    const n0 = bg.log.length;
    r.setTheme(registry.get('kafe'), 'day');
    expect(bg.log.length).toBe(n0);
    r.setTheme(registry.get('kafe'), 'night');
    const n1 = bg.log.length;
    expect(n1).toBeGreaterThan(n0);
    r.setTheme(registry.get('cyberpunk'), 'night');
    expect(bg.log.length).toBeGreaterThan(n1);
    // gambar ulang memakai palet baru: warna lantai cyberpunk malam muncul di log latar
    const floor = paletteForTheme(registry.get('cyberpunk'), 'night').floor;
    expect(bg.log.slice(n1).some((l) => l === `set fillStyle="${floor}"`)).toBe(true);
  });

  it('setTheme menerima string tema UI lama (kompatibel)', () => {
    const { r, bg } = setup('dark');
    const n = bg.log.length;
    r.setTheme('light');
    expect(bg.log.length).toBeGreaterThan(n);
    const n2 = bg.log.length;
    r.setTheme('light');
    expect(bg.log.length).toBe(n2);
  });

  it('transisi: latar lama dipudarkan ke latar baru; reduced motion langsung ganti tanpa pudar', () => {
    const { r, pix } = setup(registry.get('kafe'), 'day');
    const office = scenarioOffice(5);
    r.draw(office, FIXED_NOW);
    const before = f.all.length;
    r.setTheme(registry.get('kafe'), 'night');
    expect(f.all.length).toBe(before + 1); // kanvas cadangan (latar lama) dibuat
    expect(f.all[before].log.some((l) => l.startsWith('drawImage('))).toBe(true);
    const bgDraws = () => pix.log.filter((l) => l === `drawImage(canvas(${W}x${H}),0,0)`).length;
    pix.log.length = 0;
    r.draw(office, FIXED_NOW);
    expect(bgDraws()).toBe(2); // latar baru + latar lama yang memudar
    r.setTheme(registry.get('cyberpunk'), 'night');
    office.setReducedMotion(true);
    pix.log.length = 0;
    r.draw(office, FIXED_NOW);
    expect(bgDraws()).toBe(1); // reduced motion: tanpa lapisan pudar
  });

  it('label poster hanya digambar bila tema punya poster', () => {
    const word = t('office.poster.1').split(' ')[0];
    const labelTexts = (theme) => {
      const main = f.make(W * 2, H * 2);
      const r = createRenderer(main, { theme, variant: 'day' });
      r.draw(scenarioOffice(3), FIXED_NOW);
      const labels = f.all[f.all.indexOf(main) + 3]; // urutan: pix, latar, lapisan label
      return labels.log.filter((l) => l.startsWith('fillText(')).join(' ');
    };
    expect(registry.get('stasiun-luar-angkasa').decor.posters).toBe('none');
    expect(labelTexts(registry.get('kafe'))).toContain(word);
    expect(labelTexts(registry.get('stasiun-luar-angkasa'))).not.toContain(word);
  });
});

describe('reduced motion dihormati di setiap tema', () => {
  it('efek langit statis: waktu berbeda menghasilkan perintah yang sama', () => {
    for (const t of registry.themes) {
      for (const v of ['day', 'night']) {
        const P = paletteForTheme(t, v);
        const run = (time, rain = 0) => {
          const log = [];
          drawSkyFx(recordingCtx(log), P, time, { reduced: true, rain, decor: t.decor });
          return sha(log);
        };
        expect(run(1), `${t.id}/${v}`).toBe(run(77.3));
      }
    }
  });

  it('tanpa reduced motion, awan/bintang/lalu lintas bergerak seiring waktu', () => {
    for (const t of registry.themes) {
      const P = paletteForTheme(t, 'night');
      const run = (time) => {
        const log = [];
        drawSkyFx(recordingCtx(log), P, time, { reduced: false, decor: t.decor });
        return sha(log);
      };
      expect(run(1), t.id).not.toBe(run(40));
    }
  });

  it('renderer: dengan reduced motion hujan tidak digambar walau hujan menyala; uap dan jarum detik mati', () => {
    const f = canvasFactory();
    globalThis.document = { createElement: () => f.make() };
    try {
      const frameHash = (rain, reduced) => {
        const main = f.make(W * 2, H * 2);
        const r = createRenderer(main, { theme: registry.get('cyberpunk'), variant: 'night' });
        const o = scenarioOffice(5);
        o.setReducedMotion(reduced);
        o.rainLevel = rain;
        const pix = f.all[f.all.indexOf(main) + 1];
        pix.log.length = 0;
        r.draw(o, FIXED_NOW);
        return sha(pix.log);
      };
      expect(frameHash(1, true)).toBe(frameHash(0, true));
      expect(frameHash(1, false)).not.toBe(frameHash(0, false));
    } finally {
      delete globalThis.document;
    }
  });
});

describe('performa per frame (< 1 ms) untuk setiap tema', () => {
  // Konteks tanpa operasi: mengukur biaya JavaScript pembuat perintah gambar (bukan rasterisasi peramban).
  const fastCanvas = (w = 1, h = 1) => {
    const ctx = {
      measureText: (s) => ({ width: String(s).length * 3.5 }),
      fillRect() {}, drawImage() {}, setTransform() {}, clearRect() {}, fillText() {}, save() {}, restore() {}, beginPath() {},
      rect() {}, clip() {}, translate() {}, scale() {}, fill() {}, stroke() {}, moveTo() {}, lineTo() {},
    };
    return { width: w, height: h, getContext: () => ctx };
  };

  const timings = {};
  const FRAMES = 300;
  const mean = (fn) => {
    for (let i = 0; i < 60; i++) fn(i); // pemanasan JIT
    const runs = [];
    for (let b = 0; b < 5; b++) {
      const t0 = performance.now();
      for (let i = 0; i < FRAMES; i++) fn(i);
      runs.push((performance.now() - t0) / FRAMES);
    }
    return Math.min(...runs); // terbaik dari 5 gelombang: tahan terhadap jeda GC/penjadwal
  };

  beforeEach(() => {
    globalThis.document = { createElement: () => fastCanvas() };
  });
  afterEach(() => {
    delete globalThis.document;
  });

  it.each(registry.themes.map((t) => [t.id]))('%s: frame penuh (siang dan malam, ada hujan) rata-rata < 1 ms', (id) => {
    const theme = registry.get(id);
    timings[id] = {};
    for (const variant of ['day', 'night']) {
      const main = fastCanvas(W * 2, H * 2);
      const r = createRenderer(main, { theme, variant });
      const office = scenarioOffice(10);
      office.rainLevel = 0.8;
      const ms = mean((i) => {
        office.update(0.016);
        r.draw(office, FIXED_NOW + i * 16);
      });
      timings[id][variant] = Number(ms.toFixed(3));
      expect(ms, `${id}/${variant}`).toBeLessThan(1);
    }
  });

  it.each(registry.themes.map((t) => [t.id]))('%s: bagian yang bergantung tema (langit, jam, uap) < 0,5 ms per frame', (id) => {
    const theme = registry.get(id);
    const ctx = fastCanvas().getContext();
    for (const variant of ['day', 'night']) {
      const P = paletteForTheme(theme, variant);
      const ms = mean((i) => {
        drawSkyFx(ctx, P, i * 0.016, { decor: theme.decor, rain: 0.8 });
        drawClock(ctx, P, FIXED_NOW, false);
        drawSteam(ctx, P, i * 0.016);
      });
      expect(ms, `${id}/${variant}`).toBeLessThan(0.5);
    }
  });

  it('menggambar ulang latar (hanya saat ganti tema) tetap cepat dan tercatat', () => {
    for (const t of registry.themes) {
      const ctx = fastCanvas().getContext();
      const P = paletteForTheme(t, 'night');
      const t0 = performance.now();
      drawBackground(ctx, P, t.decor, t.sprites);
      expect(performance.now() - t0, t.id).toBeLessThan(100);
    }
    if (process.env.THEME_PERF_OUT) writeFileSync(process.env.THEME_PERF_OUT, JSON.stringify(timings, null, 2));
  });
});
