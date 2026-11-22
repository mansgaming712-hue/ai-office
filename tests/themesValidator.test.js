// Fase 3: validator tema (shared/themes.js). Tema adalah data murni: tanpa kode, tanpa injeksi CSS, batas ukuran
// dan jumlah, field tak dikenal ditolak, sprite grid divalidasi.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  ALPHA_KEYS, COLOR_KEYS, DECOR_DEFAULTS, DECOR_VOCAB, NUMBER_KEYS, PALETTE_KEYS, PROP_SLOTS, THEME_LIMITS,
  fromRgba, loadThemes, resolvePalette, toRgba, validateTheme,
} from '../shared/themes.js';
import { createRegistry } from '../src/office/themeRegistry.js';

const minimal = () => ({
  id: 'tes',
  name: { en: 'Test', id: 'Tes' },
  palette: { day: { floor: '#aabbcc' }, night: { floor: '#112233' } },
});
const sprite = () => ({ colors: { '.': null, '#': '#ff0000' }, rows: ['.#.', '###', '.#.'] });
const withSprite = (extra = {}) => ({ ...minimal(), sprites: { bintang: sprite() }, ...extra });

const errorsOf = (raw, opts) => {
  const r = validateTheme(raw, opts);
  expect(r.ok, String(JSON.stringify(raw)).slice(0, 80)).toBe(false);
  expect(r.theme).toBeNull();
  return r.errors.join(' | ');
};

describe('tema valid', () => {
  it('tema minimal valid; dekorasi bawaan = Jakarta', () => {
    const r = validateTheme(minimal());
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.theme.id).toBe('tes');
    expect(r.theme.decor).toEqual({ ...DECOR_DEFAULTS, props: [] });
    expect(r.theme.sprites).toEqual({});
  });

  it('semua dekorasi dari kosakata diterima', () => {
    for (const [key, values] of Object.entries(DECOR_VOCAB)) {
      for (const v of values) {
        const r = validateTheme({ ...minimal(), decor: { [key]: v } });
        expect(r.ok, `${key}=${v}`).toBe(true);
        expect(r.theme.decor[key]).toBe(v);
      }
    }
  });

  it('deskripsi, seed, sprite, dan props diterima dan dinormalkan', () => {
    const r = validateTheme(withSprite({
      description: { en: ' Hello ' },
      decor: { seed: 5, props: [{ sprite: 'bintang', slot: 'wall-left' }] },
    }));
    expect(r.ok, r.errors.join()).toBe(true);
    expect(r.theme.description).toEqual({ en: 'Hello' });
    expect(r.theme.decor.seed).toBe(5);
    expect(r.theme.decor.props).toEqual([{ sprite: 'bintang', slot: 'wall-left' }]);
    expect(r.theme.sprites.bintang).toMatchObject({ w: 3, h: 3 });
  });

  it('warna transparan dan bilangan palet diterima', () => {
    const raw = minimal();
    raw.palette.day.shadow = { color: '#000000', alpha: 0.25 };
    raw.palette.day.zoneFill = 0.5;
    expect(validateTheme(raw).ok).toBe(true);
  });

  it('huruf besar di warna diterima (#AABBCC)', () => {
    const raw = minimal();
    raw.palette.day.floor = '#AABBCC';
    expect(validateTheme(raw).ok).toBe(true);
  });

  it('validator tidak mengubah masukan dan hasilnya tidak berbagi referensi sprite', () => {
    const raw = withSprite();
    const before = JSON.stringify(raw);
    const r = validateTheme(raw);
    expect(JSON.stringify(raw)).toBe(before);
    r.theme.sprites.bintang.rows[0] = 'xxx';
    expect(raw.sprites.bintang.rows[0]).toBe('.#.');
  });
});

describe('tema tidak valid: setiap jenis', () => {
  it.each([
    [null], [undefined], [42], ['teks'], [[]], [() => 1],
  ])('bukan objek: %j', (raw) => {
    expect(errorsOf(raw)).toMatch(/objek/);
  });

  it('field tingkat atas tak dikenal ditolak', () => {
    expect(errorsOf({ ...minimal(), script: 'alert(1)' })).toMatch(/script: field tidak dikenal/);
    expect(errorsOf({ ...minimal(), onload: 'x' })).toMatch(/onload/);
  });

  it('kunci __proto__ dan constructor ditolak sebagai field tak dikenal', () => {
    const raw = JSON.parse('{"id":"tes","name":{"en":"T","id":"T"},"palette":{},"__proto__":{"x":1}}');
    expect(errorsOf(raw)).toMatch(/__proto__/);
    const raw2 = minimal();
    raw2.palette.day = JSON.parse('{"__proto__":"#ffffff"}');
    expect(errorsOf(raw2)).toMatch(/kunci palet tidak dikenal/);
  });

  it.each([['Jakarta'], ['has space'], [''], ['-mulai'], ['a'.repeat(33)], ['../etc'], [7], [null]])('id tidak valid: %j', (id) => {
    expect(errorsOf({ ...minimal(), id })).toMatch(/id:/);
  });

  it('nama: wajib, dua bahasa, tidak kosong, tidak terlalu panjang, tanpa karakter kontrol', () => {
    expect(errorsOf({ ...minimal(), name: undefined })).toMatch(/name/);
    expect(errorsOf({ ...minimal(), name: { en: 'x' } })).toMatch(/name.id: wajib/);
    expect(errorsOf({ ...minimal(), name: { en: '  ', id: 'x' } })).toMatch(/tidak boleh kosong/);
    expect(errorsOf({ ...minimal(), name: { en: 'x'.repeat(THEME_LIMITS.maxName + 1), id: 'x' } })).toMatch(/maksimal/);
    expect(errorsOf({ ...minimal(), name: { en: 'a\nb', id: 'x' } })).toMatch(/karakter kontrol/);
    expect(errorsOf({ ...minimal(), name: { en: 'x', id: 'x', fr: 'x' } })).toMatch(/name.fr: field tidak dikenal/);
    expect(errorsOf({ ...minimal(), name: { en: 5, id: 'x' } })).toMatch(/harus teks/);
  });

  it('deskripsi terlalu panjang atau salah bentuk', () => {
    expect(errorsOf({ ...minimal(), description: { en: 'x'.repeat(THEME_LIMITS.maxDescription + 1) } })).toMatch(/maksimal/);
    expect(errorsOf({ ...minimal(), description: 'teks' })).toMatch(/description/);
  });

  it('palette: wajib, hanya day/night, tiap varian objek', () => {
    expect(errorsOf({ ...minimal(), palette: undefined })).toMatch(/palette: wajib/);
    expect(errorsOf({ ...minimal(), palette: { dusk: {} } })).toMatch(/palette.dusk/);
    expect(errorsOf({ ...minimal(), palette: { day: 'merah' } })).toMatch(/palette.day: harus objek/);
  });

  it('kunci palet tak dikenal', () => {
    const raw = minimal();
    raw.palette.day.background = '#ffffff';
    expect(errorsOf(raw)).toMatch(/palette.day.background: kunci palet tidak dikenal/);
  });

  it.each([
    ['red'], ['#fff'], ['#ggg000'], ['#12345'], ['#1234567'], ['rgb(0,0,0)'], ['#aabbcc;} body{display:none'], ['url(x)'],
    ['#aabbcc\n'], [' #aabbcc'], ['expression(1)'], [123], [null], [{}],
  ])('warna tidak valid / injeksi CSS ditolak: %j', (bad) => {
    const raw = minimal();
    raw.palette.day.floor = bad;
    expect(errorsOf(raw)).toMatch(/palette.day.floor: harus #rrggbb/);
  });

  it('warna transparan: bentuk, warna, dan alpha divalidasi', () => {
    const base = () => minimal();
    let raw = base();
    raw.palette.day.shadow = '#000000';
    expect(errorsOf(raw)).toMatch(/shadow: harus objek/);
    raw = base();
    raw.palette.day.shadow = { color: 'red', alpha: 0.5 };
    expect(errorsOf(raw)).toMatch(/shadow.color/);
    for (const alpha of [-0.1, 1.1, NaN, Infinity, '0.5', null]) {
      raw = base();
      raw.palette.day.shadow = { color: '#000000', alpha };
      expect(errorsOf(raw), String(alpha)).toMatch(/shadow.alpha/);
    }
    raw = base();
    raw.palette.day.shadow = { color: '#000000', alpha: 0.5, extra: 1 };
    expect(errorsOf(raw)).toMatch(/shadow.extra/);
  });

  it('bilangan palet (zoneFill, zoneEdge) di luar 0..1', () => {
    for (const bad of [-1, 2, '0.5', NaN]) {
      const raw = minimal();
      raw.palette.night.zoneEdge = bad;
      expect(errorsOf(raw)).toMatch(/zoneEdge/);
    }
  });

  it('tema lengkap (Jakarta) wajib memuat semua kunci kedua varian', () => {
    const e = errorsOf(minimal(), { complete: true });
    expect(e).toMatch(/wajib ada \(tema lengkap\)/);
    expect(errorsOf({ ...minimal(), palette: { day: {} } }, { complete: true })).toMatch(/palette.night: wajib ada/);
  });

  it('dekorasi: nama tak dikenal, nilai di luar kosakata, tipe salah', () => {
    expect(errorsOf({ ...minimal(), decor: { jetpack: 'ya' } })).toMatch(/decor.jetpack: dekorasi tidak dikenal/);
    expect(errorsOf({ ...minimal(), decor: { skyline: 'mars' } })).toMatch(/decor.skyline: pilih salah satu dari city\|neon\|stars\|hills\|none/);
    expect(errorsOf({ ...minimal(), decor: { floor: 5 } })).toMatch(/decor.floor/);
    expect(errorsOf({ ...minimal(), decor: 'banyak' })).toMatch(/decor: harus objek/);
    expect(errorsOf({ ...minimal(), decor: { pantry: '<img onerror=x>' } })).toMatch(/decor.pantry/);
  });

  it.each([[-1], [10000], [1.5], ['3'], [NaN]])('seed tidak valid: %j', (seed) => {
    expect(errorsOf({ ...minimal(), decor: { seed } })).toMatch(/decor.seed/);
  });

  it('props: sprite harus ada, slot dari kosakata, tidak ganda, maksimal jumlah', () => {
    expect(errorsOf(withSprite({ decor: { props: [{ sprite: 'hilang', slot: 'wall-left' }] } }))).toMatch(/props\[0\].sprite/);
    expect(errorsOf(withSprite({ decor: { props: [{ sprite: 'bintang', slot: 'langit' }] } }))).toMatch(/props\[0\].slot/);
    expect(errorsOf(withSprite({ decor: { props: [{ sprite: 'bintang', slot: 'wall-left' }, { sprite: 'bintang', slot: 'wall-left' }] } }))).toMatch(/sudah dipakai/);
    expect(errorsOf(withSprite({ decor: { props: [{ sprite: 'bintang', slot: 'wall-left', x: 1 }] } }))).toMatch(/props\[0\].x/);
    expect(errorsOf(withSprite({ decor: { props: 'x' } }))).toMatch(/decor.props: harus daftar/);
    expect(errorsOf(withSprite({ decor: { props: Array.from({ length: THEME_LIMITS.maxProps + 1 }, () => ({ sprite: 'bintang', slot: PROP_SLOTS[0] })) } }))).toMatch(/maksimal/);
    expect(errorsOf(withSprite({ decor: { props: [7] } }))).toMatch(/props\[0\]/);
  });

  it('batas ukuran tema: JSON lebih dari batas byte ditolak sebelum diperiksa', () => {
    expect(errorsOf({ ...minimal(), isi: 'x'.repeat(THEME_LIMITS.maxBytes) })).toMatch(/terlalu besar/);
    // 8 sprite 32x32 masih jauh di bawah batas
    const sprites = Object.fromEntries(Array.from({ length: 8 }, (_, n) => [`s${n}`, { colors: { '#': '#ffffff' }, rows: Array.from({ length: 32 }, () => '#'.repeat(32)) }]));
    expect(validateTheme({ ...minimal(), sprites }).ok).toBe(true);
  });

  it('tema tidak bisa diserialisasi (siklik) ditolak tanpa melempar', () => {
    const raw = minimal();
    raw.self = raw;
    expect(() => validateTheme(raw)).not.toThrow();
    expect(validateTheme(raw).ok).toBe(false);
  });

  it('objek dengan prototipe aneh (kelas) ditolak', () => {
    class Evil {}
    expect(errorsOf(new Evil())).toMatch(/objek/);
  });
});

describe('sprite: grid dan peta warna', () => {
  const bad = (s) => errorsOf(withSprite({ sprites: { bintang: s } }));

  it('maksimal 8 sprite', () => {
    const sprites = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, sprite()]));
    expect(errorsOf({ ...minimal(), sprites })).toMatch(/sprites: maksimal 8/);
    expect(validateTheme({ ...minimal(), sprites: Object.fromEntries(Object.entries(sprites).slice(0, 8)) }).ok).toBe(true);
  });

  it('32x32 diterima; 33 lebar atau 33 tinggi ditolak', () => {
    const grid = (w, h) => ({ colors: { '#': '#ffffff' }, rows: Array.from({ length: h }, () => '#'.repeat(w)) });
    expect(validateTheme(withSprite({ sprites: { bintang: grid(32, 32) } })).ok).toBe(true);
    expect(bad(grid(33, 4))).toMatch(/lebar 1 sampai 32/);
    expect(bad(grid(4, 33))).toMatch(/1 sampai 32 baris/);
    expect(bad({ colors: { '#': '#ffffff' }, rows: [] })).toMatch(/1 sampai 32 baris/);
    expect(bad({ colors: { '#': '#ffffff' }, rows: [''] })).toMatch(/lebar/);
  });

  it('karakter grid harus ada di peta warna', () => {
    expect(bad({ colors: { '#': '#ff0000' }, rows: ['#x#'] })).toMatch(/karakter "x" tidak ada di peta warna/);
  });

  it('semua baris harus selebar baris pertama', () => {
    expect(bad({ colors: { '#': '#ff0000' }, rows: ['###', '##'] })).toMatch(/rows\[1\]: lebar 2, harus sama \(3\)/);
  });

  it('peta warna: nilai harus #rrggbb atau null; kunci satu karakter; maksimal 16 entri', () => {
    expect(bad({ colors: { '#': 'merah' }, rows: ['#'] })).toMatch(/harus #rrggbb atau null/);
    expect(bad({ colors: { '#': 'url(x)' }, rows: ['#'] })).toMatch(/harus #rrggbb atau null/);
    expect(bad({ colors: { ab: '#ffffff' }, rows: ['a'] })).toMatch(/satu karakter/);
    expect(bad({ colors: { ' ': '#ffffff' }, rows: [' '] })).toMatch(/satu karakter/);
    expect(bad({ colors: {}, rows: ['#'] })).toMatch(/1 sampai 16 entri/);
    const many = Object.fromEntries('abcdefghijklmnopq'.split('').map((c) => [c, '#ffffff']));
    expect(bad({ colors: many, rows: ['a'] })).toMatch(/1 sampai 16 entri/);
    expect(bad(5)).toMatch(/harus objek/);
    expect(bad({ colors: 'x', rows: ['#'] })).toMatch(/colors/);
    expect(bad({ colors: { '#': '#ffffff' }, rows: 'x' })).toMatch(/rows: harus daftar/);
    expect(bad({ colors: { '#': '#ffffff' }, rows: [5] })).toMatch(/harus teks/);
    expect(bad({ colors: { '#': '#ffffff' }, rows: ['#'], extra: 1 })).toMatch(/extra: field tidak dikenal/);
  });

  it('id sprite tidak valid', () => {
    expect(errorsOf({ ...minimal(), sprites: { 'Besar!': sprite() } })).toMatch(/id tidak valid/);
    expect(errorsOf({ ...minimal(), sprites: [] })).toMatch(/sprites: harus objek/);
  });

  it('karakter Unicode di grid dihitung per karakter (bukan per byte)', () => {
    const r = validateTheme(withSprite({ sprites: { bintang: { colors: { '#': '#ffffff' }, rows: ['#é#'] } } }));
    expect(r.ok).toBe(false); // 'é' bukan ASCII di peta
  });
});

describe('palet: penyelesaian dan konversi', () => {
  it('daftar kunci konsisten dan tanpa duplikat', () => {
    expect(new Set(PALETTE_KEYS).size).toBe(PALETTE_KEYS.length);
    expect(PALETTE_KEYS.length).toBe(COLOR_KEYS.length + ALPHA_KEYS.length + NUMBER_KEYS.length);
  });

  it('toRgba dan fromRgba bolak-balik', () => {
    expect(toRgba('#28190a', 0.25)).toBe('rgba(40,25,10,0.25)');
    expect(fromRgba('rgba(40,25,10,0.25)')).toEqual({ color: '#28190a', alpha: 0.25 });
    expect(fromRgba('merah')).toBeNull();
  });

  it('kunci yang tidak ditulis tema diambil dari palet dasar; tanpa dasar melempar', () => {
    const base = Object.fromEntries(PALETTE_KEYS.map((k) => [k, k === 'floor' ? '#000000' : 'dasar']));
    const { theme } = validateTheme(minimal());
    const P = resolvePalette(theme, 'day', base);
    expect(P.floor).toBe('#aabbcc');
    expect(P.wall).toBe('dasar');
    expect(P.night).toBe(false);
    expect(resolvePalette(theme, 'night', base).night).toBe(true);
    expect(() => resolvePalette(theme, 'day')).toThrow(/tidak ada/);
  });
});

describe('loadThemes dan registry', () => {
  const full = (id) => ({ ...minimal(), id });
  it('tema tidak valid dilewati dan dicatat; yang valid tetap dimuat', () => {
    const { themes, problems } = loadThemes({
      '/themes/baik/theme.json': full('baik'),
      '/themes/rusak/theme.json': { ...full('rusak'), skyline: 'x' },
      '/themes/salah-id/theme.json': full('lain'),
      '/themes/baik2/theme.json': { default: full('baik2') },
    }, { defaultId: 'tidak-ada' });
    expect(themes.map((t) => t.id)).toEqual(['baik', 'baik2']);
    expect(problems.map((p) => p.file).sort()).toEqual(['/themes/rusak/theme.json', '/themes/salah-id/theme.json']);
    expect(problems.find((p) => p.file.includes('salah-id')).errors[0]).toMatch(/tidak sama dengan nama folder/);
  });

  it('tema bawaan (lengkap) diurutkan pertama, lalu menurut id; tema bawaan yang tidak lengkap ditolak', () => {
    const jakarta = JSON.parse(readFileSync(new URL('../themes/jakarta/theme.json', import.meta.url), 'utf8'));
    const { themes, problems } = loadThemes({
      '/themes/b/theme.json': full('b'), '/themes/a/theme.json': full('a'), '/themes/jakarta/theme.json': jakarta,
    });
    expect(themes.map((t) => t.id)).toEqual(['jakarta', 'a', 'b']);
    expect(problems).toEqual([]);
    const bad = loadThemes({ '/themes/jakarta/theme.json': full('jakarta') });
    expect(bad.themes).toEqual([]);
    expect(bad.problems[0].errors.join()).toMatch(/lengkap/);
  });

  it('registry nyata: tema rusak menghasilkan peringatan dan masuk problems', async () => {
    const real = (await import('../themes/jakarta/theme.json', { with: { type: 'json' } })).default;
    const warn = vi.fn();
    const reg = createRegistry({
      '/themes/jakarta/theme.json': real,
      '/themes/rusak/theme.json': { id: 'rusak' },
    }, { warn });
    expect(reg.themes.map((t) => t.id)).toEqual(['jakarta']);
    expect(reg.problems).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/rusak.*dilewati/);
    expect(reg.get('tidak-ada')).toBe(reg.defaultTheme);
    expect(reg.has('jakarta')).toBe(true);
  });

  it('registry tanpa Jakarta yang valid melempar (tema bawaan wajib)', () => {
    expect(() => createRegistry({ '/themes/jakarta/theme.json': { id: 'jakarta' } }, { warn: () => {} })).toThrow(/jakarta/);
  });
});

describe('JSON mentah rusak dan pesan error dipangkas', () => {
  const jakartaText = readFileSync(new URL('../themes/jakarta/theme.json', import.meta.url), 'utf8');

  it('loadThemes menerima teks mentah; teks JSON rusak dilewati tanpa melempar', () => {
    const { themes, problems } = loadThemes({
      '/themes/jakarta/theme.json': jakartaText,
      '/themes/patah/theme.json': '{ "id": "patah", ',
      '/themes/kosong/theme.json': '',
      '/themes/koma/theme.json': '{"id":"koma",}',
    });
    expect(themes.map((t) => t.id)).toEqual(['jakarta']);
    expect(problems.map((p) => p.file).sort()).toEqual(['/themes/koma/theme.json', '/themes/kosong/theme.json', '/themes/patah/theme.json']);
    for (const p of problems) expect(p.errors[0]).toMatch(/^JSON rusak/);
  });

  it('registry: teks rusak masuk problems dengan peringatan, jakarta tetap dimuat', () => {
    const warn = vi.fn();
    const reg = createRegistry({ '/themes/jakarta/theme.json': jakartaText, '/themes/x/theme.json': 'bukan json' }, { warn });
    expect(reg.themes.map((t) => t.id)).toEqual(['jakarta']);
    expect(reg.problems).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('jakarta dari teks mentah sama dengan dari objek', () => {
    const a = createRegistry({ '/themes/jakarta/theme.json': jakartaText }, { warn() {} }).defaultTheme;
    const b = createRegistry({ '/themes/jakarta/theme.json': JSON.parse(jakartaText) }, { warn() {} }).defaultTheme;
    expect(a).toEqual(b);
  });

  it('nama kunci buatan penulis dipangkas 40 karakter di pesan error', () => {
    const long = 'k'.repeat(500);
    const raw = minimal();
    raw[long] = 1;
    raw.decor = { [long]: 'x' };
    raw.palette.day[long] = '#ffffff';
    raw.sprites = { [long]: sprite() };
    raw.palette.night.shadow = { color: '#000000', alpha: 0.5, [long]: 1 };
    const e = errorsOf(raw);
    expect(e).not.toContain('k'.repeat(41));
    expect(e).toContain('k'.repeat(40));
    expect(e.length).toBeLessThan(1500);
  });
});
