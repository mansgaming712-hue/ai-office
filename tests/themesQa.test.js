// QA Fase 3 (tema + pengaturan): celah yang tidak dicakup test fitur. Fokus: tema rusak/ganda/tidak rata, pengaturan
// menunjuk tema hilang, versi masa depan, storage melempar, ganti tema berulang (cache), plugin + ganti tema,
// gerak penuh/kurangi vs sistem, mode waktu vs tema UI, kepribadian + reduced motion, i18n, dan pengguna lama.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadThemes, validateTheme } from '../shared/themes.js';
import { applyDivisionsResponse, resetDivisions } from '../src/divisions.js';
import { hasKey, t } from '../src/i18n.js';
import { Office } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { paletteForTheme } from '../src/office/palette.js';
import { createRenderer } from '../src/office/render.js';
import { createRegistry, registry } from '../src/office/themeRegistry.js';
import {
  DEFAULT_SETTINGS, SETTINGS_KEY, applyMotionAttr, createSettingsStore, loadSettings, resolveReducedMotion, resolveVariant,
  saveSettings,
} from '../src/settings.js';
import { canvasFactory, sha } from './helpers/recordCanvas.js';
import { FIXED_NOW, scenarioOffice } from './helpers/sceneSnapshot.js';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const jakartaRaw = () => JSON.parse(read('../themes/jakarta/theme.json'));
const kafeRaw = () => JSON.parse(read('../themes/kafe/theme.json'));
const mem = (init = {}) => {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), m };
};
const minimal = (over = {}) => ({
  id: 'mini', name: { en: 'Mini', id: 'Mini' }, palette: { day: { floor: '#112233' }, night: {} }, ...over,
});

describe('QA tema: berkas rusak, ganda, tidak rata', () => {
  const mods = (extra) => ({ '/themes/jakarta/theme.json': jakartaRaw(), ...extra });

  it('isi theme.json bukan objek (null, teks, angka, daftar, kosong) dilewati tanpa melempar dan jakarta tetap dimuat', () => {
    const bad = { '/themes/a/theme.json': null, '/themes/b/theme.json': 'teks', '/themes/c/theme.json': 42, '/themes/d/theme.json': [], '/themes/e/theme.json': {}, '/themes/f/theme.json': undefined };
    const { themes, problems } = loadThemes(mods(bad));
    expect(themes.map((x) => x.id)).toEqual(['jakarta']);
    expect(problems).toHaveLength(6);
  });

  it('modul import dengan bentuk { default } juga dikenali dan yang rusak dilewati', () => {
    const { themes, problems } = loadThemes(mods({ '/themes/kafe/theme.json': { default: kafeRaw() }, '/themes/x/theme.json': { default: 'rusak' } }));
    expect(themes.map((x) => x.id)).toEqual(['jakarta', 'kafe']);
    expect(problems.map((p) => p.file)).toEqual(['/themes/x/theme.json']);
  });

  it('tema terlalu besar (> 65536) dilewati; tepat di batas masih diperiksa isinya', () => {
    const huge = minimal({ description: { en: 'x'.repeat(70000) } });
    const { themes, problems } = loadThemes(mods({ '/themes/mini/theme.json': huge }));
    expect(themes).toHaveLength(1);
    expect(problems[0].errors[0]).toMatch(/terlalu besar/);
  });

  it('dua berkas dengan id/folder sama: yang kedua dilewati sebagai ganda, yang pertama tetap', () => {
    const k = kafeRaw();
    const { themes, problems } = loadThemes(mods({ '/themes/kafe/theme.json': k, '/x/themes/kafe/theme.json': k }));
    expect(themes.filter((x) => x.id === 'kafe')).toHaveLength(1);
    expect(problems.some((p) => p.errors.some((e) => /ganda/.test(e)))).toBe(true);
  });

  it('folder lain tetapi id sama dengan tema lain ditolak (id harus = nama folder, jadi tidak bisa menimpa)', () => {
    const k = kafeRaw();
    const { themes, problems } = loadThemes(mods({ '/themes/kafe/theme.json': k, '/themes/salinan/theme.json': k }));
    expect(themes.map((x) => x.id)).toEqual(['jakarta', 'kafe']);
    expect(problems[0].errors[0]).toMatch(/tidak sama dengan nama folder/);
  });

  it('tema dengan id "jakarta" di folder lain tidak bisa menggeser tema bawaan', () => {
    const fake = { ...kafeRaw(), id: 'jakarta' };
    const { themes, problems } = loadThemes(mods({ '/themes/palsu/theme.json': fake }));
    expect(themes.map((x) => x.id)).toEqual(['jakarta']);
    expect(problems).toHaveLength(1);
  });

  it('registry: peringatan dicatat untuk tema rusak, bukan melempar', () => {
    const warns = [];
    const r = createRegistry(mods({ '/themes/rusak/theme.json': { id: 1 } }), { warn: (m) => warns.push(m) });
    expect(r.themes).toHaveLength(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('rusak');
  });

  it('sprite tidak rata: baris lebih pendek, lebih panjang, kosong, dan baris bukan teks ditolak', () => {
    const colors = { a: '#ffffff', b: null };
    for (const rows of [['aa', 'a'], ['aa', 'aaa'], ['aa', ''], ['', ''], ['aa', 5], ['aa', null], [], 'aa']) {
      const r = validateTheme(minimal({ sprites: { s: { colors, rows } } }));
      expect(r.ok, JSON.stringify(rows)).toBe(false);
    }
  });

  it('sprite: baris pertama kosong menolak walau semua baris sama-sama kosong; emoji dihitung per karakter, tapi di luar peta warna ditolak', () => {
    expect(validateTheme(minimal({ sprites: { s: { colors: { a: '#ffffff' }, rows: ['', ''] } } })).ok).toBe(false);
    expect(validateTheme(minimal({ sprites: { s: { colors: { a: '#ffffff' }, rows: ['a😀'] } } })).ok).toBe(false);
  });

  it('sprite dengan kunci peta warna __proto__/constructor tidak lolos sebagai karakter valid', () => {
    const colors = JSON.parse('{"__proto__": "#ffffff"}');
    expect(validateTheme(minimal({ sprites: { s: { colors, rows: ['a'] } } })).ok).toBe(false);
    // karakter grid "c" tidak boleh dianggap ada lewat prototipe objek
    expect(validateTheme(minimal({ sprites: { s: { colors: { a: '#ffffff' }, rows: ['c'] } } })).ok).toBe(false);
  });

  it('warna dengan injeksi CSS atau bentuk singkat ditolak di palet dan sprite', () => {
    for (const bad of ['#fff', 'red', '#12345g', 'url(x)', '#112233; background:red', 'rgba(0,0,0,1)', '#1122334']) {
      expect(validateTheme(minimal({ palette: { day: { floor: bad }, night: {} } })).ok, bad).toBe(false);
      expect(validateTheme(minimal({ sprites: { s: { colors: { a: bad }, rows: ['a'] } } })).ok, bad).toBe(false);
    }
  });

  it('nilai ekstrem: NaN/Infinity/negatif di alpha, seed pecahan, nama hanya spasi', () => {
    for (const alpha of [NaN, Infinity, -0.1, 1.01, '0.5']) {
      expect(validateTheme(minimal({ palette: { day: { shadow: { color: '#000000', alpha } }, night: {} } })).ok).toBe(false);
    }
    for (const seed of [1.5, -1, 10000, NaN, '3']) expect(validateTheme(minimal({ decor: { seed } })).ok).toBe(false);
    expect(validateTheme(minimal({ name: { en: '   ', id: 'x' } })).ok).toBe(false);
  });
});

describe('QA pengaturan: tema hilang, versi masa depan, storage melempar', () => {
  it('pengaturan menunjuk tema yang sudah tidak ada: registry.get jatuh ke jakarta, pengaturan tersimpan tidak diubah', () => {
    const storage = mem({ [SETTINGS_KEY]: JSON.stringify({ v: 1, officeTheme: 'tema-dihapus', timeMode: 'night', motion: 'full', rain: true }) });
    const { settings } = loadSettings(storage);
    expect(settings.officeTheme).toBe('tema-dihapus');
    expect(registry.has(settings.officeTheme)).toBe(false);
    expect(registry.get(settings.officeTheme)).toBe(registry.defaultTheme);
    expect(registry.get(settings.officeTheme).id).toBe('jakarta');
    expect(settings.timeMode).toBe('night'); // kolom lain tidak ikut hilang
  });

  it('nama bawaan Object (constructor, toString, hasOwnProperty) sebagai id tema tidak membocorkan prototipe', () => {
    for (const id of ['constructor', 'tostring', 'hasownproperty', 'valueof']) {
      const s = createSettingsStore(mem({ [SETTINGS_KEY]: JSON.stringify({ v: 1, officeTheme: id }) })).get();
      expect(registry.get(s.officeTheme)).toBe(registry.defaultTheme);
    }
    for (const id of ['__proto__', 'Kafe', '', ' kafe', 'kafe ', 'a'.repeat(33), 5, null, ['kafe']]) {
      const s = createSettingsStore(mem({ [SETTINGS_KEY]: JSON.stringify({ v: 1, officeTheme: id }) })).get();
      expect(s.officeTheme, String(id)).toBe('jakarta');
    }
  });

  it('versi masa depan (v:2, v:"1", v:1.5, tanpa v): bawaan, kunci di storage tidak ditimpa saat dimuat', () => {
    for (const v of [2, 99, '1', 1.5, null, undefined, -1]) {
      const raw = JSON.stringify({ v, officeTheme: 'kafe', rain: true });
      const storage = mem({ [SETTINGS_KEY]: raw });
      const { settings, source } = loadSettings(storage);
      expect(settings, String(v)).toEqual(DEFAULT_SETTINGS);
      expect(source).toBe('corrupt');
      expect(storage.m.get(SETTINGS_KEY)).toBe(raw);
    }
  });

  it('versi masa depan + store: dimuat sebagai bawaan dan perubahan tanpa efek (sama dengan bawaan) tidak menimpa data v2', () => {
    const raw = JSON.stringify({ v: 2, officeTheme: 'kafe' });
    const storage = mem({ [SETTINGS_KEY]: raw });
    const store = createSettingsStore(storage);
    expect(store.set({ officeTheme: 'jakarta' })).toBe(false);
    expect(storage.m.get(SETTINGS_KEY)).toBe(raw);
  });

  it('JSON bukan objek, terlalu besar (>4096), atau literal aneh: bawaan tanpa melempar', () => {
    for (const raw of ['null', '[]', '"teks"', '12', 'true', '{', '', JSON.stringify({ v: 1, junk: 'x'.repeat(5000) })]) {
      expect(() => loadSettings(mem({ [SETTINGS_KEY]: raw }))).not.toThrow();
      expect(loadSettings(mem({ [SETTINGS_KEY]: raw })).settings).toEqual(DEFAULT_SETTINGS);
    }
  });

  it('getItem DAN setItem sama-sama melempar: store bekerja di memori, reset tidak melempar, pendengar dipanggil', () => {
    const boom = () => { throw new DOMException('denied', 'SecurityError'); };
    const store = createSettingsStore({ getItem: boom, setItem: boom, removeItem: boom });
    let n = 0;
    store.subscribe(() => n++);
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(() => store.set({ officeTheme: 'kafe', motion: 'full' })).not.toThrow();
    expect(store.get().officeTheme).toBe('kafe');
    expect(() => store.reset()).not.toThrow();
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
    expect(n).toBe(2);
    expect(saveSettings({ setItem: boom }, DEFAULT_SETTINGS)).toBe(false);
  });

  it('akses properti localStorage sendiri melempar (getter SecurityError) tidak membuat modul gagal dimuat', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', { configurable: true, get() { throw new Error('SecurityError'); } });
    try {
      const mod = await import('../src/settings.js');
      expect(mod.browserStorage()).toBeNull();
      expect(() => mod.createSettingsStore()).not.toThrow();
    } finally {
      if (saved) Object.defineProperty(globalThis, 'window', saved);
      else delete globalThis.window;
    }
  });

  it('migrasi hujan lama saat setItem melempar: nilai hasil migrasi tetap ada di memori', () => {
    const s = { getItem: (k) => (k === 'ai-office-rain' ? '1' : null), setItem() { throw new Error('quota'); } };
    expect(createSettingsStore(s).get().rain).toBe(true);
  });

  it('store membekukan state sehingga komponen tidak bisa memutasi pengaturan', () => {
    const store = createSettingsStore(mem());
    store.set({ rain: true });
    expect(Object.isFrozen(store.get())).toBe(true);
    store.reset();
    expect(Object.isFrozen(store.get())).toBe(true);
  });
});

describe('QA gerak dan mode waktu', () => {
  it('"penuh" menang atas prefers-reduced-motion sistem; "kurangi" menang atas sistem non-reduced', () => {
    expect(resolveReducedMotion('full', true)).toBe(false);
    expect(resolveReducedMotion('reduce', false)).toBe(true);
    expect(resolveReducedMotion('system', true)).toBe(true);
    expect(resolveReducedMotion('system', false)).toBe(false);
    expect(resolveReducedMotion('system', undefined)).toBe(false);
  });

  it('CSS: reduced-motion sistem dibatalkan oleh data-motion=full dan data-motion=reduce memaksa tanpa media query', () => {
    const css = read('../src/styles.css');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root:not\(\[data-motion='full'\]\)/);
    expect(css).toMatch(/:root\[data-motion='reduce'\] \*/);
    // tidak ada media query prefers-reduced-motion lain di luar blok yang sudah menghormati data-motion
    const blocks = css.split('@media (prefers-reduced-motion: reduce)').slice(1);
    for (const b of blocks) expect(b.slice(0, 200)).toContain("data-motion='full'");
  });

  it('atribut data-motion: berganti full -> reduce -> system membersihkan atribut; root tanpa setAttribute aman', () => {
    const attrs = new Map();
    const root = { setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) };
    applyMotionAttr(root, 'full');
    expect(attrs.get('data-motion')).toBe('full');
    applyMotionAttr(root, 'reduce');
    expect(attrs.get('data-motion')).toBe('reduce');
    applyMotionAttr(root, 'system');
    expect(attrs.has('data-motion')).toBe(false);
    applyMotionAttr(root, 'ngawur');
    expect(attrs.has('data-motion')).toBe(false);
    expect(applyMotionAttr(null, 'full')).toBe(false);
    expect(applyMotionAttr({}, 'full')).toBe(false);
  });

  it('App: reducedMotion dihitung dari settings.motion + sistem, dan data-motion dipasang dari settings.motion', () => {
    const app = read('../src/ui/App.jsx');
    expect(app).toMatch(/resolveReducedMotion\(settings\.motion, systemReduced\)/);
    expect(app).toMatch(/applyMotionAttr\(document\.documentElement, settings\.motion\)/);
  });

  it('mode waktu "selalu siang/malam" tidak terpengaruh tema UI; "ikuti" mengikutinya', () => {
    for (const ui of ['light', 'dark', undefined, 'ngawur']) {
      expect(resolveVariant('day', { uiTheme: ui })).toBe('day');
      expect(resolveVariant('night', { uiTheme: ui })).toBe('night');
    }
    expect(resolveVariant('follow', { uiTheme: 'light' })).toBe('day');
    expect(resolveVariant('follow', { uiTheme: 'dark' })).toBe('night');
  });

  it('palet kanvas tidak membaca tema UI: siang di UI gelap tetap palet siang (tema Jakarta)', () => {
    const v = resolveVariant('day', { uiTheme: 'dark' });
    expect(paletteForTheme(registry.defaultTheme, v).night).toBe(false);
  });
});

describe('QA kepribadian (Fase 2) + reduced motion hasil pengaturan', () => {
  const pers = { nickname: { en: 'Sun' }, traits: ['a'], speech: { tone: 'dry', phrases: ['p1'] }, idle: 'coffee', quirk: 'yawn' };
  const run = (reduced) => {
    const o = new Office({ seed: 5, personalityFor: () => pers });
    o.setReducedMotion(reduced);
    for (let i = 0; i < 400; i++) o.update(0.05);
    return o;
  };

  it('reducedMotion hasil resolveReducedMotion("reduce") mematikan jalan-jalan idle dan semua pekerja di meja', () => {
    const o = run(resolveReducedMotion('reduce', false));
    for (const w of o.workers.values()) {
      expect(w.status).not.toBe('walking');
      expect(Math.hypot(w.x - w.seat.x, w.y - w.seat.y)).toBeLessThan(1);
    }
  });

  it('"penuh" di sistem reduced: office bergerak seperti normal (berbeda dari reduced), deterministik', () => {
    const full1 = run(resolveReducedMotion('full', true));
    const full2 = run(resolveReducedMotion('full', true));
    const snap = (o) => JSON.stringify([...o.workers.values()].map((w) => [w.x, w.y, w.status]));
    expect(snap(full1)).toBe(snap(full2));
    expect(full1.reducedMotion).toBe(false);
  });

  it('ganti tema tidak mengubah state kantor (kepribadian/quirk) dan reduced motion tetap menang di renderer', () => {
    const f = canvasFactory();
    globalThis.document = { createElement: () => f.make() };
    try {
      const main = f.make(900, 900);
      const r = createRenderer(main, { theme: registry.get('kafe'), variant: 'day' });
      const o = new Office({ seed: 5, personalityFor: () => pers });
      o.setReducedMotion(true);
      for (let i = 0; i < 100; i++) o.update(0.05);
      const before = JSON.stringify([...o.workers.values()].map((w) => [w.x, w.y, w.status]));
      r.draw(o, FIXED_NOW);
      r.setTheme(registry.get('cyberpunk'), 'night');
      r.draw(o, FIXED_NOW);
      expect(JSON.stringify([...o.workers.values()].map((w) => [w.x, w.y, w.status]))).toBe(before);
      expect(o.reducedMotion).toBe(true);
    } finally {
      delete globalThis.document;
    }
  });
});

describe('QA renderer: ganti tema berulang dan plugin', () => {
  let f;
  beforeEach(() => {
    f = canvasFactory();
    globalThis.document = { createElement: () => f.make() };
  });
  afterEach(() => {
    delete globalThis.document;
    resetDivisions();
  });

  const setup = (theme, variant) => {
    const main = f.make(layout.W * 2, layout.H * 2);
    const r = createRenderer(main, { theme, variant });
    const [pix, bg] = f.all.slice(f.all.indexOf(main) + 1);
    return { r, main, pix, bg };
  };
  const lastBg = (bg, from) => sha(bg.log.slice(from));

  it('ganti tema 60x berputar: latar akhir identik dengan renderer baru (tidak ada sisa state dari tema sebelumnya)', () => {
    const ids = registry.themes.map((x) => x.id);
    const { r, bg } = setup(registry.get('jakarta'), 'day');
    const o = scenarioOffice(5);
    let from = 0;
    for (let i = 0; i < 60; i++) {
      const id = ids[(i * 3 + 1) % ids.length];
      const variant = i % 2 ? 'night' : 'day';
      from = bg.log.length;
      r.setTheme(registry.get(id), variant);
      r.draw(o, FIXED_NOW);
      // satu pergantian = satu gambar ulang penuh dengan log berukuran sama untuk (tema, varian) yang sama
      const fresh = canvasFactory();
      globalThis.document = { createElement: () => fresh.make() };
      const m2 = fresh.make(layout.W * 2, layout.H * 2);
      createRenderer(m2, { theme: registry.get(id), variant });
      const bg2 = fresh.all[fresh.all.indexOf(m2) + 2];
      globalThis.document = { createElement: () => f.make() };
      expect(lastBg(bg, from), `${id}/${variant} putaran ${i}`).toBe(sha(bg2.log));
    }
  });

  it('kembali ke jakarta setelah semua tema: hash latar sama dengan fixture emas (rnd/seed tidak bocor)', () => {
    const golden = JSON.parse(read('./fixtures/jakarta-golden.json'));
    const { r, bg } = setup(registry.get('jakarta'), 'day');
    for (const th of registry.themes) r.setTheme(th, 'night');
    const from = bg.log.length;
    r.setTheme(registry.get('jakarta'), 'day');
    const day = sha(bg.log.slice(from));
    expect(day).toBe(golden.light.background.sha);
    const from2 = bg.log.length;
    r.setTheme(registry.get('kafe'), 'night');
    r.setTheme(registry.get('jakarta'), 'night');
    expect(sha(bg.log.slice(bg.log.length - (bg.log.length - from2 > 0 ? golden.dark.background.n : 0)))).toBe(golden.dark.background.sha);
  });

  it('ganti tema berulang: setelah satu putaran pemanasan, tidak ada kanvas baru yang dibuat (tidak bocor)', () => {
    const { r } = setup(registry.get('kafe'), 'day');
    const o = scenarioOffice(3);
    const cycle = (i) => {
      r.setTheme(registry.get(i % 2 ? 'kafe' : 'cyberpunk'), i % 2 ? 'day' : 'night');
      r.draw(o, FIXED_NOW);
    };
    for (let i = 0; i < 4; i++) cycle(i);
    const n = f.all.length;
    for (let i = 0; i < 40; i++) cycle(i);
    expect(f.all.length).toBe(n);
  });

  it('setTheme sebelum draw pertama dan beruntun tanpa draw tidak melempar', () => {
    const { r } = setup(registry.get('kafe'), 'day');
    expect(() => {
      r.setTheme(registry.get('stasiun-luar-angkasa'), 'night');
      r.setTheme(registry.get('startup-cozy'), 'day');
      r.setTheme(undefined, undefined);
    }).not.toThrow();
  });

  it('plugin menambah tinggi kanvas: ganti tema sesudahnya menggambar latar pada tinggi baru', () => {
    const { r, pix, bg } = setup(registry.get('kafe'), 'day');
    const o = scenarioOffice(3);
    r.draw(o, FIXED_NOW);
    const baseH = layout.H;
    applyDivisionsResponse(200, {
      ok: true, errors: [],
      divisions: [1, 2, 3].map((i) => ({ id: `p${i}`, name: { en: `P${i}`, id: `P${i}` }, color: '#0ea5e9', desks: 3, workers: [`p${i}-a`], source: 'plugin' })),
    });
    expect(layout.H).toBeGreaterThan(baseH);
    r.setTheme(registry.get('cyberpunk'), 'night'); // ganti tema SEBELUM draw yang menyinkronkan roster
    r.draw(scenarioOffice(3), FIXED_NOW);
    expect(pix.height).toBe(layout.H);
    expect(bg.height).toBe(layout.H);
    // latar terakhir digambar dengan palet cyberpunk malam (bukan kafe) pada tinggi baru
    const floor = paletteForTheme(registry.get('cyberpunk'), 'night').floor;
    expect(bg.log.some((l) => l === `set fillStyle="${floor}"`)).toBe(true);
    // ganti tema lagi dengan plugin aktif: tinggi tetap, tanpa lapisan cadangan berukuran lama
    r.setTheme(registry.get('kafe'), 'day');
    r.draw(scenarioOffice(3), FIXED_NOW);
    expect(bg.height).toBe(layout.H);
    const backups = f.all.filter((c) => c !== pix && c !== bg && c.width === layout.W && c.height > 1);
    for (const c of backups) expect(c.height).toBe(layout.H);
  });

  it('plugin dihapus kembali (tinggi menyusut) lalu ganti tema: kanvas kembali ke tinggi dasar', () => {
    const { r, pix, bg } = setup(registry.get('kafe'), 'day');
    applyDivisionsResponse(200, { ok: true, errors: [], divisions: [{ id: 'p1', name: { en: 'P', id: 'P' }, color: '#0ea5e9', desks: 2, workers: ['p1-a'], source: 'plugin' }] });
    r.draw(scenarioOffice(3), FIXED_NOW);
    expect(pix.height).toBeGreaterThan(layout.BASE_H);
    resetDivisions();
    r.setTheme(registry.get('cyberpunk'), 'day');
    r.draw(scenarioOffice(3), FIXED_NOW);
    expect(layout.H).toBe(layout.BASE_H);
    expect(pix.height).toBe(layout.BASE_H);
    expect(bg.height).toBe(layout.BASE_H);
  });
});

describe('QA i18n tema dan pengaturan', () => {
  it('semua kunci ui.settings.* dan office.theme.* ada di en dan id, setara satu sama lain', () => {
    const en = JSON.parse(read('../locales/en.json'));
    const id = JSON.parse(read('../locales/id.json'));
    const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
    const pick = (o) => flat(o).filter((k) => /(^|\.)(settings|theme)\./.test(k) || k.startsWith('ui.settings') || k.startsWith('office.theme'));
    const a = pick(en).sort();
    const b = pick(id).sort();
    expect(a.length).toBeGreaterThan(15);
    expect(b).toEqual(a);
  });

  it('seluruh kunci locale en dan id identik (tidak ada kunci yatim di salah satu bahasa)', () => {
    const en = Object.keys(JSON.parse(read('../locales/en.json'))).sort();
    const id = Object.keys(JSON.parse(read('../locales/id.json'))).sort();
    expect(id.filter((k) => !en.includes(k))).toEqual([]);
    expect(en.filter((k) => !id.includes(k))).toEqual([]);
  });

  it('nilai teks pengaturan tidak kosong dan tidak sama dengan kuncinya di kedua bahasa; tidak ada sisa {placeholder}', () => {
    for (const lang of ['en', 'id']) {
      const data = JSON.parse(read(`../locales/${lang}.json`));
      for (const [k, v] of Object.entries(data)) {
        if (!/settings\.|office\.theme\./.test(k)) continue;
        expect(typeof v, k).toBe('string');
        expect(v.trim().length, k).toBeGreaterThan(0);
        expect(v, k).not.toMatch(/\{\w+\}/);
        expect(hasKey(k, lang)).toBe(true);
      }
    }
    expect(t('ui.settings.title', undefined, 'en')).not.toBe(t('ui.settings.title', undefined, 'id'));
  });

  it('setiap t("...") literal di SettingsDialog/App untuk pengaturan merujuk kunci yang ada di kedua bahasa', () => {
    const src = read('../src/ui/SettingsDialog.jsx') + read('../src/ui/App.jsx');
    const keys = [...src.matchAll(/\bt\('((?:ui\.settings|office\.theme)[\w.]*)'/g)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(10);
    for (const k of new Set(keys)) for (const lang of ['en', 'id']) expect(hasKey(k, lang), `${k}/${lang}`).toBe(true);
  });

  it('semua tema punya nama dan deskripsi (jika ada) dalam en dan id, tanpa HTML', () => {
    for (const th of registry.themes) {
      for (const lang of ['en', 'id']) {
        expect(th.name[lang].length).toBeGreaterThan(0);
        expect(th.name[lang]).not.toMatch(/[<>]/);
        if (th.description) expect(th.description[lang] ?? '').not.toMatch(/[<>]/);
      }
    }
  });
});

describe('QA pengguna lama tanpa pengaturan', () => {
  it('tanpa kunci apa pun: bawaan = jakarta/ikuti/sistem/tanpa hujan, tidak menulis ke storage, tema UI menentukan varian', () => {
    const storage = mem();
    const { settings, source } = loadSettings(storage);
    expect(source).toBe('default');
    expect(storage.m.size).toBe(0);
    expect(settings).toEqual({ v: 1, officeTheme: 'jakarta', timeMode: 'follow', motion: 'system', rain: false });
    expect(resolveVariant(settings.timeMode, { uiTheme: 'light' })).toBe('day');
    expect(resolveVariant(settings.timeMode, { uiTheme: 'dark' })).toBe('night');
    expect(resolveReducedMotion(settings.motion, true)).toBe(true);
    expect(registry.get(settings.officeTheme)).toBe(registry.defaultTheme);
  });

  it('pengguna lama dengan hujan "1": hujan tetap menyala setelah migrasi, sisanya bawaan; tidak ada data-motion', () => {
    const storage = mem({ 'ai-office-rain': '1' });
    const { settings, source } = loadSettings(storage);
    expect(source).toBe('migrated');
    expect(settings).toEqual({ ...DEFAULT_SETTINGS, rain: true });
    const attrs = new Map();
    applyMotionAttr({ setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k) }, settings.motion);
    expect(attrs.size).toBe(0);
  });

  it('dashboard pengguna lama identik: palet siang/malam jakarta sama dengan palet lama dan kanvas tidak diberi kunci tema baru', () => {
    const light = paletteForTheme(registry.defaultTheme, 'day');
    const dark = paletteForTheme(registry.defaultTheme, 'night');
    expect(light.night).toBe(false);
    expect(dark.night).toBe(true);
    const legacy = JSON.parse(read('./fixtures/palettes-legacy.json'));
    for (const [k, v] of Object.entries(legacy.light ?? {})) expect(light[k], `light.${k}`).toBe(v);
    for (const [k, v] of Object.entries(legacy.dark ?? {})) expect(dark[k], `dark.${k}`).toBe(v);
  });

  it('index.html / theme-init tidak membaca atau menulis kunci pengaturan baru (tema UI tetap kunci lama)', () => {
    const init = read('../public/theme-init.js');
    expect(init).not.toMatch(/ai-office-settings/);
    expect(init).toMatch(/ai-office-theme/);
  });
});
