// Fase 3: lima tema bawaan (themes/<id>/theme.json): valid, khas, kontras terbaca, dan Jakarta = palet lama.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DIVISIONS, OTHER_DIVISION } from '../shared/roster.js';
import { PALETTE_KEYS, validateTheme } from '../shared/themes.js';
import { blend, contrast } from '../src/contrast.js';
import { CONTRAST_PAIRS, PALETTES, paletteFor, paletteForTheme } from '../src/office/palette.js';
import { DEFAULT_THEME_ID, registry } from '../src/office/themeRegistry.js';

const BUILTIN = ['jakarta', 'startup-cozy', 'cyberpunk', 'kafe', 'stasiun-luar-angkasa'];
const THEMES_DIR = new URL('../themes/', import.meta.url);
const legacy = JSON.parse(readFileSync(new URL('./fixtures/palettes-legacy.json', import.meta.url), 'utf8'));

describe('lima tema bawaan', () => {
  it('folder themes/ berisi tepat lima tema, masing-masing hanya theme.json (tanpa kode)', () => {
    const dirs = readdirSync(THEMES_DIR, { withFileTypes: true });
    expect(dirs.every((d) => d.isDirectory())).toBe(true);
    expect(dirs.map((d) => d.name).sort()).toEqual([...BUILTIN].sort());
    for (const d of dirs) expect(readdirSync(new URL(`${d.name}/`, THEMES_DIR))).toEqual(['theme.json']);
  });

  it('semua valid; registry memuat kelimanya tanpa masalah; jakarta default dan pertama', () => {
    expect(registry.problems).toEqual([]);
    expect(registry.themes.map((t) => t.id)).toEqual(['jakarta', ...BUILTIN.slice(1).sort()]);
    expect(DEFAULT_THEME_ID).toBe('jakarta');
    expect(registry.defaultTheme.id).toBe('jakarta');
  });

  it.each(BUILTIN)('%s: file JSON valid menurut validator (jakarta wajib lengkap), dua bahasa, deskripsi', (id) => {
    const raw = JSON.parse(readFileSync(new URL(`${id}/theme.json`, THEMES_DIR), 'utf8'));
    const r = validateTheme(raw, { complete: id === 'jakarta' });
    expect(r.errors).toEqual([]);
    expect(r.theme.id).toBe(id);
    for (const lang of ['en', 'id']) {
      expect(r.theme.name[lang].length).toBeGreaterThan(0);
      expect(r.theme.description[lang].length).toBeGreaterThan(10);
    }
    expect(JSON.stringify(raw)).not.toMatch(/<script|javascript:|url\(|expression\(/i);
  });

  it('dekorasi khas: skyline, lantai, dinding, dan lampu berbeda di setiap tema', () => {
    for (const key of ['skyline', 'floor', 'wall', 'lights']) {
      const values = registry.themes.map((t) => t.decor[key]);
      expect(new Set(values).size, `${key}: ${values}`).toBe(values.length);
    }
  });

  it('setiap tema selain jakarta berbeda dari jakarta di sedikitnya 5 dekorasi dan punya sprite props', () => {
    const base = registry.defaultTheme.decor;
    for (const t of registry.themes.filter((x) => x.id !== 'jakarta')) {
      const diff = ['skyline', 'windowStyle', 'floor', 'wall', 'plants', 'posters', 'pantry', 'lights'].filter((k) => t.decor[k] !== base[k]);
      expect(diff.length, t.id).toBeGreaterThanOrEqual(5);
      expect(Object.keys(t.sprites).length, t.id).toBeGreaterThanOrEqual(1);
      expect(t.decor.props.length, t.id).toBeGreaterThanOrEqual(1);
    }
    expect(registry.defaultTheme.decor.props).toEqual([]);
  });

  it('palet khas: tidak ada dua tema dengan lantai+dinding sama; siang dan malam berbeda di tiap tema', () => {
    const seen = new Set();
    for (const t of registry.themes) {
      const day = paletteForTheme(t, 'day');
      const night = paletteForTheme(t, 'night');
      for (const k of ['floor', 'wall', 'skyTop', 'deskTop', 'ink']) expect(day[k], `${t.id} ${k}`).not.toBe(night[k]);
      expect(day.night).toBe(false);
      expect(night.night).toBe(true);
      for (const P of [day, night]) {
        const sig = `${P.floor}|${P.wall}`;
        expect(seen.has(sig), `${t.id} ${sig}`).toBe(false);
        seen.add(sig);
      }
    }
  });

  it('palet lengkap: setiap tema punya semua kunci palet di kedua varian', () => {
    for (const t of registry.themes) {
      for (const v of ['day', 'night']) {
        const P = paletteForTheme(t, v);
        for (const k of PALETTE_KEYS) expect(P[k], `${t.id} ${v} ${k}`).toBeDefined();
      }
    }
  });

  it('paletteForTheme di-cache dan dibekukan', () => {
    const t = registry.get('kafe');
    expect(paletteForTheme(t, 'day')).toBe(paletteForTheme(t, 'day'));
    expect(Object.isFrozen(paletteForTheme(t, 'night'))).toBe(true);
  });
});

describe('jakarta = tampilan lama', () => {
  it('palet jakarta sama persis dengan palet lama (siang = terang, malam = gelap)', () => {
    expect(PALETTES.light).toMatchObject(legacy.light);
    expect(PALETTES.dark).toMatchObject(legacy.dark);
    expect(paletteForTheme(registry.defaultTheme, 'day')).toBe(PALETTES.light);
    expect(paletteFor('light')).toBe(PALETTES.light);
    expect(paletteFor('dark')).toBe(PALETTES.dark);
  });

  it('kunci tambahan di jakarta hanya kunci dekorasi baru', () => {
    const extra = Object.keys(PALETTES.light).filter((k) => !(k in legacy.light));
    expect(extra.sort()).toEqual(['accentA', 'accentB', 'accentC', 'star', 'sun']);
  });
});

describe.each(['day', 'night'])('kontras teks kanvas, varian %s, semua tema', (variant) => {
  for (const id of BUILTIN) {
    describe(id, () => {
      const P = () => paletteForTheme(registry.get(id), variant);

      it.each(CONTRAST_PAIRS.map(([fg, bg, why]) => [fg, bg, why]))('%s di atas %s (%s) >= 4,5:1', (fg, bg) => {
        expect(contrast(P()[fg], P()[bg])).toBeGreaterThanOrEqual(4.5);
      });

      it('label divisi di atas karpet (lantai + warna divisi) >= 4,5:1', () => {
        for (const d of [...DIVISIONS, OTHER_DIVISION]) {
          const tinted = blend(d.color, P().floor, P().zoneFill);
          expect(contrast(P().ink, tinted), `judul ${d.name}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(P().inkSoft, tinted), `status di ${d.name}`).toBeGreaterThanOrEqual(4.5);
        }
      });

      it('lantai papan catur: teks juga terbaca di atas kotak gelapnya (floorLine)', () => {
        // wood/tile/metal memakai floorLine hanya sebagai garis 1 piksel; checker mengisi setengah lantai dengannya
        for (const bg of registry.get(id).decor.floor === 'checker' ? ['floorLine'] : []) {
          expect(contrast(P().ink, P()[bg]), `ink/${bg}`).toBeGreaterThanOrEqual(4.5);
          expect(contrast(P().inkSoft, P()[bg]), `inkSoft/${bg}`).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }
});
