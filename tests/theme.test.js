// Tahap 2: tema gelap/terang. Pemilihan + penyimpanan, skrip anti-kilatan (public/theme-init.js) yang harus
// sepakat dengan src/theme.js, kontras AA token CSS di kedua tema, dan kepatuhan CSP (tanpa skrip/gaya inline).
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { contrast } from '../src/contrast.js';
import {
  THEMES, THEME_KEY, appliedTheme, applyTheme, initialTheme, isTheme, otherTheme,
  readStoredTheme, resolveTheme, storeTheme, systemPrefersDark,
} from '../src/theme.js';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

/** localStorage palsu. */
const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), dump: () => Object.fromEntries(m) };
};
const throwingStorage = () => ({
  getItem() { throw new Error('SecurityError'); },
  setItem() { throw new Error('QuotaExceededError'); },
});
const fakeWin = ({ stored, dark, noMatchMedia = false, badStorage = false } = {}) => ({
  localStorage: badStorage ? throwingStorage() : memStorage(stored === undefined ? {} : { [THEME_KEY]: stored }),
  ...(noMatchMedia ? {} : { matchMedia: (q) => ({ matches: q.includes('dark') ? dark : false }) }),
});

describe('pemilihan dan penyimpanan tema', () => {
  it('dua tema: gelap dan terang', () => {
    expect(THEMES).toEqual(['dark', 'light']);
    expect(isTheme('dark')).toBe(true);
    expect(isTheme('sepia')).toBe(false);
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });

  it('pilihan tersimpan menang atas preferensi sistem', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('tanpa pilihan: ikuti prefers-color-scheme; tidak diketahui → gelap', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
    expect(resolveTheme(null, undefined)).toBe('dark');
    expect(resolveTheme('rusak', false)).toBe('light');
  });

  it('membaca dan menyimpan lewat storage', () => {
    const s = memStorage();
    expect(readStoredTheme(s)).toBeNull();
    expect(storeTheme(s, 'light')).toBe(true);
    expect(s.dump()).toEqual({ [THEME_KEY]: 'light' });
    expect(readStoredTheme(s)).toBe('light');
  });

  it('nilai rusak di storage diabaikan; tema tidak sah tidak disimpan', () => {
    expect(readStoredTheme(memStorage({ [THEME_KEY]: '<script>' }))).toBeNull();
    const s = memStorage();
    expect(storeTheme(s, 'neon')).toBe(false);
    expect(s.dump()).toEqual({});
  });

  it('storage yang melempar (mode privat/kuota) tidak merusak apa pun', () => {
    expect(readStoredTheme(throwingStorage())).toBeNull();
    expect(storeTheme(throwingStorage(), 'dark')).toBe(false);
    expect(readStoredTheme(null)).toBeNull();
    expect(initialTheme(fakeWin({ badStorage: true, dark: false }))).toBe('light');
  });

  it('initialTheme menggabungkan storage dan matchMedia', () => {
    expect(initialTheme(fakeWin({ dark: true }))).toBe('dark');
    expect(initialTheme(fakeWin({ dark: false }))).toBe('light');
    expect(initialTheme(fakeWin({ stored: 'light', dark: true }))).toBe('light');
    expect(initialTheme(fakeWin({ noMatchMedia: true }))).toBe('dark');
    expect(systemPrefersDark(fakeWin({ dark: false }))).toBe(false);
    expect(systemPrefersDark(undefined)).toBe(true);
  });

  it('applyTheme memasang atribut data-theme dan hanya menerima tema sah', () => {
    const attrs = {};
    const root = { setAttribute: (k, v) => (attrs[k] = v), getAttribute: (k) => attrs[k] ?? null };
    expect(appliedTheme(root)).toBeNull();
    expect(applyTheme(root, 'light')).toBe(true);
    expect(attrs['data-theme']).toBe('light');
    expect(appliedTheme(root)).toBe('light');
    expect(applyTheme(root, 'x')).toBe(false);
    expect(applyTheme(null, 'dark')).toBe(false);
    expect(attrs['data-theme']).toBe('light');
  });
});

describe('public/theme-init.js (anti-kilatan) sepakat dengan src/theme.js', () => {
  const code = read('public/theme-init.js');

  /** Jalankan skrip klasik di konteks terisolasi; kembalikan data-theme yang dipasang. */
  function runInit(win) {
    const attrs = {};
    const ctx = { window: win, document: { documentElement: { setAttribute: (k, v) => (attrs[k] = v) } } };
    ctx.window.document = ctx.document;
    runInNewContext(code, ctx);
    return attrs['data-theme'];
  }

  const cases = [];
  for (const stored of [undefined, 'dark', 'light', 'rusak']) {
    for (const dark of [true, false]) {
      for (const noMatchMedia of [false, true]) {
        for (const badStorage of [false, true]) cases.push({ stored, dark, noMatchMedia, badStorage });
      }
    }
  }

  it.each(cases.map((c) => [JSON.stringify(c), c]))('hasil sama dengan initialTheme: %s', (_, c) => {
    expect(runInit(fakeWin(c))).toBe(initialTheme(fakeWin(c)));
  });

  it('selalu memasang tema sah, juga saat matchMedia melempar', () => {
    const win = { localStorage: memStorage(), matchMedia() { throw new Error('x'); } };
    expect(isTheme(runInit(win))).toBe(true);
  });

  it('tidak memakai eval, gaya inline, atau sumber eksternal', () => {
    expect(code).not.toMatch(/\beval\s*\(|new Function|innerHTML|document\.write|https?:\/\//);
  });
});

describe('index.html patuh CSP (script-src/style-src self)', () => {
  const html = read('index.html');

  it('memuat theme-init.js sinkron di <head>, sebelum bundel modul', () => {
    const headEnd = html.indexOf('</head>');
    const init = html.indexOf('<script src="/theme-init.js"></script>');
    const mod = html.indexOf('type="module"');
    expect(init).toBeGreaterThan(-1);
    expect(init).toBeLessThan(headEnd);
    expect(mod).toBeGreaterThan(init);
    // sinkron: tanpa defer/async/type=module
    expect(html.slice(init, html.indexOf('</script>', init))).not.toMatch(/defer|async|module/);
  });

  it('semua <script> punya src; tidak ada <style>, atribut style, atau handler on*', () => {
    for (const m of html.matchAll(/<script\b[^>]*>/g)) expect(m[0]).toMatch(/\ssrc=/);
    expect(html).not.toMatch(/<style\b/i);
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/(?:src|href)="https?:\/\//i);
  });

  it('mendeklarasikan color-scheme gelap dan terang', () => {
    expect(html).toMatch(/<meta name="color-scheme" content="dark light"/);
  });

  it('public/theme-init.js ada dan akan disalin ke dist', () => {
    expect(read('public/theme-init.js').length).toBeGreaterThan(50);
  });
});

describe('kode sumber UI patuh CSP', () => {
  const files = ['src/main.jsx', 'src/net.js', 'src/ui/App.jsx', 'src/ui/OfficeCanvas.jsx', 'src/ui/StageNotices.jsx',
    'src/ui/Skeleton.jsx', 'src/ui/StatusIcon.jsx', 'src/ui/ThemeToggle.jsx', 'src/ui/UsagePanel.jsx', 'src/ui/useTheme.js',
    'src/office/render.js', 'src/styles.css'];

  it.each(files)('%s: tanpa eval, atribut style string, innerHTML, atau URL eksternal', (f) => {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/\beval\s*\(|new Function\s*\(|dangerouslySetInnerHTML|\.innerHTML\s*=|setAttribute\(\s*['"]style['"]/);
    expect(src).not.toMatch(/(?:url\(|src=|href=|import\s+['"])\s*['"]?https?:\/\//);
    expect(src).not.toMatch(/@import\s+url|@font-face/); // font dibundel lewat @fontsource di main.jsx
  });
});

// ------------------------------------------------------------------ kontras token CSS

/** Ambil blok custom properties dari src/styles.css. */
function tokens(selectorRe) {
  const css = read('src/styles.css');
  const m = css.match(selectorRe);
  if (!m) throw new Error(`blok tidak ditemukan: ${selectorRe}`);
  const out = {};
  for (const d of m[1].matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[d[1]] = d[2].trim();
  return out;
}
const dark = tokens(/^:root\s*\{([\s\S]*?)^\}/m);
const light = { ...dark, ...tokens(/^:root\[data-theme='light'\]\s*\{([\s\S]*?)^\}/m) };

// [teks, latar]: pasangan token yang benar-benar dipakai di styles.css, wajib minimal 4,5:1 (WCAG AA).
const TEXT_PAIRS = [
  ['ink', 'bg'], ['ink', 'panel'], ['ink', 'panel-2'], ['ink', 'panel-3'], ['ink', 'input-bg'],
  ['muted', 'bg'], ['muted', 'panel'], ['muted', 'panel-2'], ['muted', 'panel-3'], ['muted', 'col-track'],
  ['placeholder', 'input-bg'],
  ['accent', 'panel'], ['accent', 'panel-2'], ['accent', 'panel-3'],
  ['ok-text', 'panel'], ['ok-text', 'panel-2'],
  ['warn-text', 'panel'], ['warn-text', 'panel-2'], ['warn-text', 'panel-3'], ['warn-text', 'input-bg'],
  ['bad-text', 'panel'], ['bad-text', 'panel-2'],
  ['violet-text', 'panel'], ['violet-text', 'panel-2'],
  ['badge-ink', 'badge-assign'], ['badge-ink', 'badge-working'], ['badge-ink', 'badge-done'],
  ['badge-ink', 'badge-blocked'], ['badge-ink', 'badge-report'],
  ['btn-ink', 'btn-primary'], ['btn-ink', 'btn-primary-hi'], ['btn-ink', 'btn-stop'],
  ['alert-ink', 'alert-bg'], ['warn-ink', 'warn-bg'],
];

describe('kontras teks token CSS: WCAG AA di kedua tema', () => {
  for (const [name, set] of [['gelap', dark], ['terang', light]]) {
    it.each(TEXT_PAIRS)(`tema ${name}: %s di atas %s ≥ 4,5:1`, (fg, bg) => {
      expect(set[fg], `token --${fg}`).toBeTruthy();
      expect(set[bg], `token --${bg}`).toBeTruthy();
      expect(contrast(set[fg], set[bg])).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('judul divisi di panel memakai warna ink (kontras ≥ 4,5:1), bukan warna divisi (sekitar 3:1)', () => {
    const css = read('src/styles.css');
    const rule = css.match(/\.roster-group h2\s*\{([^}]*)\}/)[1];
    expect(rule).toMatch(/color:\s*var\(--ink\)/);
    const app = read('src/ui/App.jsx');
    expect(app).not.toMatch(/<h2 style=\{\{\s*color/);
    for (const set of [dark, light]) expect(contrast(set.ink, set.panel)).toBeGreaterThanOrEqual(4.5);
  });

  it('batas kolom isian dan cincin fokus minimal 3:1 (WCAG 1.4.11) di kedua tema', () => {
    for (const set of [dark, light]) {
      expect(contrast(set['control-line'], set['input-bg'])).toBeGreaterThanOrEqual(3);
      expect(contrast(set['control-line'], set['panel-3'])).toBeGreaterThanOrEqual(3);
      expect(contrast(set.focus, set.panel)).toBeGreaterThanOrEqual(3);
      expect(contrast(set.focus, set.bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it('terang dan gelap benar-benar berbeda (bukan salinan)', () => {
    for (const k of ['bg', 'panel', 'ink', 'muted']) expect(light[k]).not.toBe(dark[k]);
    expect(contrast(dark.ink, dark.bg)).toBeGreaterThan(7);
    expect(contrast(light.ink, light.bg)).toBeGreaterThan(7);
  });

  it('semua token berwarna di tema gelap juga ditimpa (atau sengaja sama) di tema terang', () => {
    const lightOnly = tokens(/^:root\[data-theme='light'\]\s*\{([\s\S]*?)^\}/m);
    const colorKeys = Object.keys(dark).filter((k) => /^#/.test(dark[k]));
    const missing = colorKeys.filter((k) => !(k in lightOnly));
    expect(missing).toEqual([]);
  });
});

describe('responsif dan reduced motion di CSS', () => {
  const css = read('src/styles.css');

  it('ukuran teks dalam rem dan html font-size tumbuh di layar besar', () => {
    expect(css).toMatch(/html\s*\{[^}]*font-size:\s*clamp\(16px,[^)]*vw[^}]*\}/);
  });

  it('panel punya lebar clamp dan tata letak punya lebar maksimum', () => {
    expect(css).toMatch(/--panel-w:\s*clamp\(/);
    expect(css).toMatch(/\.app\s*\{[^}]*max-width:\s*\d+px/);
  });

  it('breakpoint satu kolom (960px) dan sempit (600px) tetap ada', () => {
    expect(css).toMatch(/@media \(max-width: 960px\)/);
    expect(css).toMatch(/@media \(max-width: 600px\)/);
  });

  it('kanvas pixelated dan bingkai di luar kanvas (skala piksel bulat)', () => {
    expect(css).toMatch(/\.office-canvas\s*\{[^}]*image-rendering:\s*pixelated/);
    expect(css).toMatch(/\.office-frame\s*\{[^}]*border:/);
    expect(css).not.toMatch(/\.office-canvas\s*\{[^}]*border:/);
  });

  it('prefers-reduced-motion mematikan animasi dan transisi', () => {
    const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(block).toMatch(/animation-duration:\s*0\.001ms\s*!important/);
    expect(block).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
    expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
  });

  it('overlay yang muncul lewat animasi tetap tampil saat reduced motion (fill-mode forwards)', () => {
    for (const sel of ['.stage-loading', '.auth-loading']) {
      const rule = css.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))[1];
      expect(rule).toMatch(/animation:\s*show[^;]*forwards/);
    }
  });
});
