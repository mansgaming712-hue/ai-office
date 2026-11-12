// Tahap 2: palet kanvas per tema (lantai, dinding, meja, bubble, label) dan reduced motion di renderer.
// Renderer dijalankan dengan canvas palsu yang mencatat setiap fillRect/fillText beserta warnanya.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { DIVISIONS, OTHER_DIVISION } from '../shared/roster.js';
import { STATUS_INFO, UI_STATUSES } from '../src/agentStatus.js';
import { blend, contrast } from '../src/contrast.js';
import { Office } from '../src/office/engine.js';
import { H, W, zoneList } from '../src/office/layout.js';
import { CONTRAST_PAIRS, PALETTES, paletteFor } from '../src/office/palette.js';
import { MARKER_OFFSET, createRenderer } from '../src/office/render.js';

const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;

// ------------------------------------------------------------------ canvas palsu

function fakeCtx(log) {
  const state = { fillStyle: '#000000', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic' };
  return new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 3.5 });
      if (k === 'fillRect') return (...a) => log.push({ op: 'rect', fill: t.fillStyle, alpha: t.globalAlpha, args: a });
      if (k === 'fillText') return (text, x, y) => log.push({ op: 'text', fill: t.fillStyle, text: String(text), x, y });
      return () => {};
    },
    set(t, k, v) {
      t[k] = v;
      return true;
    },
  });
}

let created;
const makeCanvas = (w = W, h = H) => {
  const log = [];
  const ctx = fakeCtx(log);
  const c = { width: w, height: h, log, getContext: () => ctx };
  created.push(c);
  return c;
};

beforeEach(() => {
  created = [];
  globalThis.document = { createElement: () => makeCanvas() };
});
afterEach(() => {
  delete globalThis.document;
});

/** Renderer + akses ke log: pix (lapisan pixel), bg (latar statis), main (teks beresolusi layar). */
function setup(theme) {
  const base = created.length;
  const main = makeCanvas(W * 2, H * 2);
  const r = createRenderer(main, { theme });
  const [pix, bg] = created.slice(base + 1); // urutan pembuatan: pix, lalu bg
  return { r, main, pix, bg };
}

// ------------------------------------------------------------------ palet

describe('palet kanvas per tema', () => {
  it('ada palet terang dan gelap dengan kunci yang sama', () => {
    expect(Object.keys(PALETTES).sort()).toEqual(['dark', 'light']);
    expect(Object.keys(PALETTES.dark).sort()).toEqual(Object.keys(PALETTES.light).sort());
  });

  it('palet tema tak dikenal jatuh ke gelap', () => {
    expect(paletteFor('sepia')).toBe(PALETTES.dark);
    expect(paletteFor(undefined)).toBe(PALETTES.dark);
  });

  it('lantai, dinding, meja, bubble, dan label benar-benar berbeda antar tema', () => {
    for (const k of ['floor', 'wall', 'deskTop', 'deskFront', 'bubblePaper', 'bubbleInk', 'ink', 'winGlass']) {
      expect(PALETTES.dark[k], k).not.toBe(PALETTES.light[k]);
    }
    expect(PALETTES.dark.night).toBe(true);
    expect(PALETTES.light.night).toBe(false);
  });

  it('gelap benar-benar lebih gelap (lantai dan dinding) dan teks label lebih terang dari lantainya', () => {
    const lum = (hex) => contrast(hex, '#000000');
    expect(lum(PALETTES.dark.floor)).toBeLessThan(lum(PALETTES.light.floor));
    expect(lum(PALETTES.dark.wall)).toBeLessThan(lum(PALETTES.light.wall));
    expect(lum(PALETTES.dark.ink)).toBeGreaterThan(lum(PALETTES.dark.floor));
    expect(lum(PALETTES.light.ink)).toBeLessThan(lum(PALETTES.light.floor));
  });

  for (const theme of ['light', 'dark']) {
    it.each(CONTRAST_PAIRS.map(([fg, bg, why]) => [fg, bg, why]))(`tema ${theme}: %s di atas %s (%s) ≥ 4,5:1`, (fg, bg) => {
      const P = PALETTES[theme];
      expect(contrast(P[fg], P[bg])).toBeGreaterThanOrEqual(4.5);
    });

    it(`tema ${theme}: label di atas karpet divisi (lantai + warna divisi) ≥ 4,5:1`, () => {
      const P = PALETTES[theme];
      for (const d of [...DIVISIONS, OTHER_DIVISION]) {
        const tinted = blend(d.color, P.floor, P.zoneFill);
        expect(contrast(P.ink, tinted), `judul ${d.name}`).toBeGreaterThanOrEqual(4.5);
        expect(contrast(P.inkSoft, tinted), `label status di ${d.name}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

// ------------------------------------------------------------------ renderer memakai palet

describe('renderer memakai palet tema aktif', () => {
  it.each(['light', 'dark'])('latar digambar dengan warna lantai, dinding, dan jendela tema %s', (theme) => {
    const { bg } = setup(theme);
    const P = PALETTES[theme];
    const first = bg.log[0];
    expect(first.fill).toBe(P.floor);
    expect(first.args).toEqual([0, 0, W, H]);
    const fills = new Set(bg.log.map((e) => e.fill));
    for (const k of ['wall', 'winGlass', 'rugB', 'doorPanel']) expect(fills.has(P[k]), k).toBe(true);
    const other = PALETTES[theme === 'dark' ? 'light' : 'dark'];
    expect(fills.has(other.floor)).toBe(false);
    expect(fills.has(other.wall)).toBe(false);
  });

  it('kantor malam: bintang dan bulan di jendela hanya ada di tema gelap', () => {
    const star = '#e9e4ff';
    expect(setup('dark').bg.log.some((e) => e.fill === star)).toBe(true);
    created = [];
    expect(setup('light').bg.log.some((e) => e.fill === star)).toBe(false);
  });

  it('setTheme menggambar ulang latar dengan palet baru tanpa membuat renderer baru', () => {
    const { r, bg } = setup('light');
    const before = bg.log.length;
    r.setTheme('dark');
    const second = bg.log.slice(before);
    expect(second[0].fill).toBe(PALETTES.dark.floor);
    r.setTheme('light');
    expect(bg.log.slice(before + second.length)[0].fill).toBe(PALETTES.light.floor);
  });

  it.each(['light', 'dark'])('meja dan monitor memakai warna meja tema %s; label memakai ink tema itu', (theme) => {
    const { r, main, pix } = setup(theme);
    const P = PALETTES[theme];
    const o = new Office();
    o.handleEvent(ev('blocked', 'dev-qa', 'manager', 'macet'), { instant: true });
    o.handleEvent(ev('assign', 'manager', 'dev-frontend'), { instant: true });
    o.update(0.5);
    pix.log.length = 0;
    main.log.length = 0;
    r.draw(o, 1_700_000_000_000);
    const pixFills = new Set(pix.log.map((e) => e.fill));
    expect(pixFills.has(P.deskTop)).toBe(true);
    expect(pixFills.has(P.chairA)).toBe(true);
    const texts = main.log.filter((e) => e.op === 'text');
    expect(texts.find((t) => t.text === 'dev-qa').fill).toBe(P.ink);
    expect(texts.find((t) => t.text === 'error').fill).toBe(P.inkSoft);
    expect(texts.find((t) => t.text === 'DIVISI DEV').fill).toBe(P.ink);
    expect(texts.find((t) => t.text === 'MANAJER').fill).toBe(P.onRug);
  });

  it.each(['light', 'dark'])('bubble memakai kertas dan tinta tema %s', (theme) => {
    const { r, main } = setup(theme);
    const P = PALETTES[theme];
    const o = new Office();
    o.handleEvent(ev('working', 'dev-qa', 'manager', 'halo'), { instant: false });
    o.handleEvent(ev('assign', 'manager', 'dev-qa'), { instant: true });
    o.workers.get('dev-qa').bubble = { text: 'halo', kind: 'working', born: 0, until: 99 };
    o.update(0.5);
    main.log.length = 0;
    r.draw(o, 1_700_000_000_000);
    const text = main.log.find((e) => e.op === 'text' && e.text === 'halo');
    expect(text.fill).toBe(P.bubbleInk);
    expect(main.log.some((e) => e.op === 'rect' && e.fill === P.bubblePaper)).toBe(true);
    expect(main.log.some((e) => e.op === 'rect' && e.fill === P.bubbleBorder)).toBe(true);
  });

  it('bubble peringatan limit memakai kertas dan tinta peringatan', () => {
    const { r, main } = setup('dark');
    const o = new Office();
    o.setLimitWarning(true);
    o.update(0.5);
    main.log.length = 0;
    r.draw(o, 1_700_000_000_000);
    const t = main.log.find((e) => e.op === 'text' && /Limit hampir habis/.test(e.text));
    expect(t.fill).toBe(PALETTES.dark.bubbleWarnInk);
    expect(main.log.some((e) => e.op === 'rect' && e.fill === PALETTES.dark.bubbleWarn)).toBe(true);
  });

  it('warna divisi dan status sama di kedua tema', () => {
    for (const s of UI_STATUSES) expect(STATUS_INFO[s].fill).toMatch(/^#[0-9a-f]{6}$/i);
    const fillsOf = (theme) => {
      created = [];
      const { r, pix } = setup(theme);
      const o = new Office();
      o.handleEvent(ev('blocked', 'dev-qa', 'manager'), { instant: true });
      o.update(0.5);
      pix.log.length = 0;
      r.draw(o, 0);
      return pix.log.map((e) => e.fill);
    };
    for (const theme of ['light', 'dark']) {
      const fills = fillsOf(theme);
      expect(fills).toContain(STATUS_INFO.error.fill);
      expect(fills).toContain(DIVISIONS[0].color);
    }
  });

  it('semua zona divisi diberi tint dengan alpha dari palet', () => {
    const { bg } = setup('dark');
    const tints = bg.log.filter((e) => /^rgba\(/.test(e.fill) && e.fill.endsWith(`,${PALETTES.dark.zoneFill})`));
    expect(tints).toHaveLength(zoneList().length);
  });
});

// ------------------------------------------------------------------ reduced motion di renderer

describe('reduced motion di renderer: dekoratif mati, informasi tetap', () => {
  /** Dua frame pada waktu engine berbeda; kembalikan log lapisan pixel masing-masing. */
  function twoFrames(reduced, theme = 'dark') {
    const { r, pix, main } = setup(theme);
    const o = new Office();
    o.setReducedMotion(reduced);
    o.handleEvent(ev('blocked', 'dev-qa', 'manager', 'macet'), { instant: true });
    o.handleEvent(ev('assign', 'manager', 'dev-frontend'), { instant: true });
    o.update(0.05); // status baru saja berubah: penanda masih dalam gerak masuk
    pix.log.length = 0;
    r.draw(o, 1_700_000_000_000);
    const a = JSON.stringify(pix.log);
    o.update(0.34);
    pix.log.length = 0;
    main.log.length = 0;
    r.draw(o, 1_700_000_000_000);
    return { a, b: JSON.stringify(pix.log), mainLog: main.log, pixLog: [...pix.log] };
  }

  it('tanpa reduced motion: kedip, titik mengetik, dan gerak masuk penanda mengubah gambar antar frame', () => {
    const { a, b } = twoFrames(false);
    expect(a).not.toBe(b);
  });

  it('dengan reduced motion: dua frame pada waktu berbeda menghasilkan gambar identik', () => {
    const { a, b } = twoFrames(true);
    expect(a).toBe(b);
  });

  it('dengan reduced motion informasi tetap tampil: ikon status, label teks, dan warna layar', () => {
    const { pixLog, mainLog } = twoFrames(true);
    const fills = pixLog.map((e) => e.fill);
    expect(fills).toContain(STATUS_INFO.error.fill); // ikon error + layar merah
    expect(fills).toContain(STATUS_INFO.bekerja.fill); // ikon bekerja
    const labels = mainLog.filter((e) => e.op === 'text').map((e) => e.text);
    expect(labels).toContain('error');
    expect(labels).toContain('bekerja');
    expect(labels).toContain('idle');
  });

  it('bubble langsung tampil penuh (tanpa pop/fade) saat reduced motion', () => {
    const alphaOf = (reduced) => {
      const { r, main } = setup('light');
      const o = new Office();
      o.setReducedMotion(reduced);
      o.workers.get('dev-qa').bubble = { text: 'halo', kind: 'working', born: 0, until: 99 };
      main.log.length = 0;
      r.draw(o, 0); // time = 0 → umur bubble 0: tanpa reduced motion masih transparan
      return main.log.find((e) => e.op === 'rect' && e.fill === PALETTES.light.bubblePaper).alpha;
    };
    expect(alphaOf(false)).toBe(0);
    expect(alphaOf(true)).toBe(1);
  });

  it('penanda status naik dari atas saat berubah (gerak masuk) kecuali reduced motion', () => {
    const markerY = (reduced, age) => {
      const { r, pix } = setup('light');
      const o = new Office();
      o.setReducedMotion(reduced);
      for (let i = 0; i < 5; i++) o.update(0.1);
      o.workers.get('dev-qa').status = 'blocked'; // statusSince = 0,5
      for (let i = 0; i < Math.round(age * 100); i++) o.update(0.01);
      pix.log.length = 0;
      r.draw(o, 0);
      const w = o.workers.get('dev-qa');
      // piksel penanda error: baris pertama ikon (satu piksel 'k' di puncak segitiga), di samping kepala
      const ys = pix.log.filter((e) => e.op === 'rect' && e.args[0] === w.seat.x + MARKER_OFFSET.x + 4 && e.args[2] === 1 && e.args[3] === 1 && e.fill === PALETTES.light.bubbleBorder).map((e) => e.args[1]);
      return Math.min(...ys);
    };
    const settled = markerY(false, 0.5);
    expect(markerY(false, 0.02)).toBeLessThan(settled); // masih di atas posisi akhir
    expect(markerY(true, 0.02)).toBe(markerY(true, 0.5)); // reduced motion: langsung di tempat
  });
});
