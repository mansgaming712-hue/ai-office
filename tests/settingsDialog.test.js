// Fase 3: dialog pengaturan yang aksesibel. Markup (role, label, grup radio), jebakan fokus, Esc, teks i18n,
// dan kepatuhan (tanpa innerHTML). Penangan fokus murni diuji dengan elemen palsu; markup lewat render server.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getLang, hasKey, setLang, t } from '../src/i18n.js';
import { registry } from '../src/office/themeRegistry.js';
import { PHASES } from '../src/office/daycycle.js';
import { DEFAULT_SETTINGS, MOTION_MODES, SETTINGS_KEY, createSettingsStore, loadSettings } from '../src/settings.js';
import SettingsDialog, { TIME_CHOICES, phaseRange, timeChoiceOf, timeModeForChoice } from '../src/ui/SettingsDialog.jsx';
import { FOCUSABLE, createKeyHandler, focusableIn, isEscape, isTab, trapTarget } from '../src/ui/dialogA11y.js';

const SRC = new URL('../src/', import.meta.url);
const read = (rel) => readFileSync(new URL(rel, SRC), 'utf8');

const render = (props = {}, lang = 'id') => {
  const prev = getLang();
  setLang(lang, { persist: false });
  try {
    return renderToStaticMarkup(createElement(SettingsDialog, {
      open: true, onClose() {}, settings: DEFAULT_SETTINGS, onChange() {}, onReset() {}, themes: registry.themes,
      problems: [], lang, onLangChange() {}, reducedMotion: false, ...props,
    }));
  } finally {
    setLang(prev, { persist: false });
  }
};

afterEach(() => setLang('id', { persist: false }));

describe('markup dialog', () => {
  it('tertutup: tidak merender apa pun', () => {
    expect(render({ open: false })).toBe('');
  });

  it('role=dialog, aria-modal, dan dilabeli judul serta deskripsi yang ada di dokumen', () => {
    const html = render();
    expect(html).toMatch(/role="dialog"/);
    expect(html).toMatch(/aria-modal="true"/);
    const labelled = /aria-labelledby="([^"]+)"/.exec(html)[1];
    const described = /aria-describedby="settings-desc"/.exec(html);
    expect(described).not.toBeNull();
    expect(html).toContain(`id="${labelled}"`);
    expect(html).toMatch(new RegExp(`<h2 id="${labelled}">Pengaturan</h2>`));
    expect(html).toMatch(/id="settings-desc"/);
    expect(html).toMatch(/tabindex="-1"/); // wadah bisa menerima fokus bila tak ada elemen lain
  });

  it('empat grup (fieldset + legend): tema, bahasa, waktu, gerak; tiap radio punya label teks', () => {
    const html = render();
    expect((html.match(/<fieldset/g) ?? []).length).toBe(4);
    expect(html).toMatch(/<legend>Tema kantor<\/legend>/);
    expect(html).toMatch(/<legend>Bahasa antarmuka<\/legend>/);
    expect(html).toMatch(/<legend>Waktu di kantor<\/legend>/);
    expect(html).toMatch(/<legend>Gerak<\/legend>/);
    const radios = html.match(/<input type="radio"[^>]*>/g);
    expect(radios).toHaveLength(registry.themes.length + 2 + TIME_CHOICES.length + MOTION_MODES.length);
    // setiap input dibungkus <label> (label implisit): jumlah label >= jumlah radio + 1 checkbox
    expect((html.match(/<label/g) ?? []).length).toBe(radios.length + 1);
    for (const r of radios) expect(r).toMatch(/name="[a-z-]+"/);
  });

  it('pilihan saat ini ditandai checked sesuai pengaturan (bawaan: jakarta, waktu mati, ikuti sistem)', () => {
    const html = render();
    const checked = (html.match(/<input type="radio"[^>]*checked[^>]*>/g) ?? []).map((x) => /value="([^"]+)"/.exec(x)[1]);
    expect(checked.sort()).toEqual(['id', 'jakarta', 'off', 'system']);
    const html2 = render({ settings: { ...DEFAULT_SETTINGS, officeTheme: 'kafe', timeMode: 'auto', motion: 'reduce' }, lang: 'en' }, 'en');
    const checked2 = (html2.match(/<input type="radio"[^>]*checked[^>]*>/g) ?? []).map((x) => /value="([^"]+)"/.exec(x)[1]);
    expect(checked2.sort()).toEqual(['auto', 'en', 'kafe', 'reduce']);
  });

  it('daftar tema memuat semua tema bawaan dengan nama menurut bahasa dan penanda bawaan', () => {
    const id = render();
    expect(id).toContain('Startup Nyaman');
    expect(id).toContain('Stasiun Luar Angkasa');
    expect(id).toContain('Jakarta (bawaan)');
    const en = render({ lang: 'en' }, 'en');
    expect(en).toContain('Cozy Startup');
    expect(en).toContain('Space Station');
    expect(en).toContain('Jakarta (default)');
    for (const th of registry.themes) expect(en).toContain(`value="${th.id}"`);
  });

  it('pratinjau warna tema dekoratif (aria-hidden) dengan teks siang/malam untuk pembaca layar', () => {
    const html = render();
    expect(html).toContain('Pratinjau siang');
    expect(html).toContain('Pratinjau malam');
    expect(html).toMatch(/class="set-sw-box" aria-hidden="true"/);
    expect(html).toMatch(/style="background:#[0-9a-f]{6}"/);
  });

  it('teks mode waktu dan gerak sesuai spesifikasi, di dua bahasa', () => {
    const id = render();
    expect(id).toContain('Mati: ikuti tema terang/gelap (bawaan)');
    expect(id).toContain('Otomatis: jam real-time');
    expect(id).toContain('Manual: pilih fase');
    expect(id).toContain('Ikuti sistem (bawaan)');
    expect(id).toContain('Kurangi gerak');
    expect(id).toContain('Gerak penuh');
    const en = render({ lang: 'en' }, 'en');
    expect(en).toContain('Off: follow light/dark theme (default)');
    expect(en).toContain('Automatic: real-time clock');
    expect(en).toContain('Manual: pick a phase');
    expect(en).toContain('Follow system (default)');
    expect(en).toContain('Reduce motion');
    expect(en).toContain('Full motion');
  });

  it('opsi bahasa memberi atribut lang pada namanya', () => {
    const html = render();
    expect(html).toMatch(/<span class="set-opt-label" lang="en">/);
    expect(html).toMatch(/<span class="set-opt-label" lang="id">/);
  });

  it('tombol tutup punya nama aksesibel; ada tombol Selesai dan Pulihkan bawaan', () => {
    const html = render({}, 'en');
    expect(html).toMatch(/<button[^>]*aria-label="Close settings"/);
    expect(html).toContain('Restore defaults');
    expect(html).toContain('>Done<');
    expect((html.match(/<button type="button"/g) ?? []).length).toBe(3);
  });

  it('hujan: kotak centang berlabel; mati dan dijelaskan saat gerak dikurangi', () => {
    const on = render({ settings: { ...DEFAULT_SETTINGS, rain: true } });
    expect(on).toMatch(/<input type="checkbox" checked=""/);
    expect(on).not.toContain('disabled');
    const off = render({ settings: { ...DEFAULT_SETTINGS, rain: true }, reducedMotion: true });
    expect(off).toMatch(/<input type="checkbox"[^>]*disabled=""/);
    expect(off).not.toMatch(/<input type="checkbox"[^>]*checked=""/); // hujan tidak tampil menyala saat gerak dikurangi
    expect(off).toMatch(/aria-describedby="settings-rain-note"/);
    expect(off).toContain('id="settings-rain-note"');
  });

  it('tema yang dilewati ditampilkan di panel dengan alasan; teks diloloskan (bukan HTML)', () => {
    const html = render({ problems: [{ file: '/themes/rusak/theme.json', errors: ['decor.skyline: <img src=x onerror=alert(1)>'] }] });
    expect(html).toContain('Tema dilewati');
    expect(html).toContain('/themes/rusak/theme.json');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
    expect(render()).not.toContain('Tema dilewati');
  });

  it('nama tema dari JSON dirender sebagai teks (diloloskan)', () => {
    const evil = { ...registry.get('kafe'), id: 'evil', name: { en: '<b>x</b>', id: '<b>x</b>' }, description: { en: '"><script>1</script>', id: '' } };
    const html = render({ themes: [registry.defaultTheme, evil] });
    expect(html).not.toContain('<b>x</b>');
    expect(html).not.toContain('<script>');
  });
});

describe('siklus siang-malam (Fase 4): Otomatis / Manual + fase / Mati', () => {
  const checkedOf = (html) => (html.match(/<input type="radio"[^>]*checked[^>]*>/g) ?? []).map((x) => /value="([^"]+)"/.exec(x)[1]);

  it('tiga pilihan mode (off, auto, manual) dengan label EN dan ID; bawaan = Mati', () => {
    expect(TIME_CHOICES).toEqual(['off', 'auto', 'manual']);
    const id = render();
    const radios = (id.match(/<input type="radio" name="time-mode"[^>]*>/g) ?? []).map((x) => /value="([^"]+)"/.exec(x)[1]);
    expect(radios).toEqual(['off', 'auto', 'manual']);
    expect(checkedOf(id)).toContain('off');
    expect(id).not.toContain('<select'); // Mati: tanpa pemilih fase
  });

  it('Otomatis: menampilkan fase aktif (role=status) dan batas jam; tanpa pemilih fase', () => {
    const id = render({ settings: { ...DEFAULT_SETTINGS, timeMode: 'auto' }, livePhase: 'malam' });
    expect(checkedOf(id)).toContain('auto');
    expect(id).toMatch(/<p class="set-note" role="status">Sekarang: Malam<\/p>/);
    expect(id).toContain('Fase mengikuti jam lokal');
    expect(id).not.toContain('<select');
    const en = render({ settings: { ...DEFAULT_SETTINGS, timeMode: 'auto' }, livePhase: 'sore', lang: 'en' }, 'en');
    expect(en).toContain('Now: Afternoon');
    expect(en).toContain('Phases follow this device');
  });

  it('Manual: daftar pilih fase (label terhubung via for/id) memuat lima fase dengan jamnya; fase tersimpan terpilih', () => {
    const html = render({ settings: { ...DEFAULT_SETTINGS, timeMode: 'sore' } });
    expect(checkedOf(html)).toContain('manual');
    const sel = /<label class="set-select" for="([^"]+)"><span>Fase<\/span><select id="\1"/.exec(html);
    expect(sel).not.toBeNull();
    const opts = html.match(/<option [^>]*>[^<]*<\/option>/g);
    expect(opts).toHaveLength(5);
    expect(opts.map((o) => /value="([^"]+)"/.exec(o)[1])).toEqual(PHASES);
    expect(html).toMatch(/<option value="sore" selected="">Sore \(15:00-17:59\)<\/option>/);
    expect(html).toContain('Malam (18:00-03:59)');
    expect(html).toContain('Subuh (04:00-05:59)');
    expect(render({ settings: { ...DEFAULT_SETTINGS, timeMode: 'pagi' }, lang: 'en' }, 'en')).toContain('Morning (06:00-10:59)');
  });

  it('phaseRange sesuai batas jam di daycycle (selesai = jam mulai fase berikutnya - 1 menit)', () => {
    expect(PHASES.map(phaseRange)).toEqual(['04:00-05:59', '06:00-10:59', '11:00-14:59', '15:00-17:59', '18:00-03:59']);
  });

  it('pilihan UI ↔ nilai tersimpan: manual mulai dari fase yang sedang tampil, atau siang', () => {
    expect(['off', 'auto', ...PHASES, 'rusak', undefined].map(timeChoiceOf)).toEqual(['off', 'auto', ...Array(5).fill('manual'), 'off', 'off']);
    expect(timeModeForChoice('off')).toBe('off');
    expect(timeModeForChoice('auto', 'malam')).toBe('auto');
    expect(timeModeForChoice('manual', 'malam')).toBe('malam');
    expect(timeModeForChoice('manual')).toBe('siang');
    expect(timeModeForChoice('manual', 'toString')).toBe('siang');
  });

  it('memilih opsi menyimpan pilihan ke storage dan dimuat lagi', () => {
    const m = new Map();
    const storage = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
    const store = createSettingsStore(storage);
    store.set({ timeMode: timeModeForChoice('auto') });
    expect(loadSettings(storage).settings.timeMode).toBe('auto');
    store.set({ timeMode: timeModeForChoice('manual', 'subuh') });
    expect(JSON.parse(m.get(SETTINGS_KEY)).timeMode).toBe('subuh');
    store.set({ timeMode: 'pagi' }); // dari pemilih fase
    expect(loadSettings(storage).settings.timeMode).toBe('pagi');
    store.set({ timeMode: timeModeForChoice('off') });
    expect(loadSettings(storage).settings.timeMode).toBe('off');
  });

  it('kode dialog: pemilih fase memakai <label htmlFor> + <select>, tanpa teks literal', () => {
    const code = read('ui/SettingsDialog.jsx');
    expect(code).toMatch(/htmlFor=\{phaseId\}/);
    expect(code).toMatch(/<select id=\{phaseId\}/);
    expect(code).not.toMatch(/>\s*(Subuh|Pagi|Siang|Sore|Malam|Dawn|Morning|Night)\s*</);
  });
});

describe('jebakan fokus dan Esc', () => {
  const el = (name) => ({ name, focus: vi.fn() });
  const ev = (key, extra = {}) => ({ key, shiftKey: false, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...extra });

  it('trapTarget: Tab di elemen terakhir kembali ke pertama; Shift+Tab di pertama ke terakhir; di tengah biarkan', () => {
    const [a, b, c] = [el('a'), el('b'), el('c')];
    const list = [a, b, c];
    expect(trapTarget(list, c, false)).toBe(a);
    expect(trapTarget(list, a, true)).toBe(c);
    expect(trapTarget(list, b, false)).toBeNull();
    expect(trapTarget(list, b, true)).toBeNull();
    expect(trapTarget(list, a, false)).toBeNull();
    expect(trapTarget(list, c, true)).toBeNull();
  });

  it('fokus di luar daftar (mis. wadah dialog atau di luar dialog) ditarik masuk', () => {
    const [a, b] = [el('a'), el('b')];
    const outside = el('luar');
    expect(trapTarget([a, b], outside, false)).toBe(a);
    expect(trapTarget([a, b], outside, true)).toBe(b);
  });

  it('daftar kosong: fokus ke wadah; satu elemen: Tab dan Shift+Tab tetap di sana', () => {
    expect(trapTarget([], null, false)).toBe('container');
    const only = el('x');
    expect(trapTarget([only], only, false)).toBe(only);
    expect(trapTarget([only], only, true)).toBe(only);
  });

  it('createKeyHandler: Esc menutup dan menghentikan perambatan', () => {
    const onClose = vi.fn();
    const h = createKeyHandler({ getBox: () => ({}), getActive: () => null, onClose });
    const e = ev('Escape');
    h(e);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(e.stopPropagation).toHaveBeenCalled();
    h(ev('Esc'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('createKeyHandler: tombol lain tidak melakukan apa pun', () => {
    const onClose = vi.fn();
    const h = createKeyHandler({ getBox: () => ({}), getActive: () => null, onClose });
    for (const k of ['Enter', ' ', 'a', 'ArrowDown']) {
      const e = ev(k);
      h(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(onClose).not.toHaveBeenCalled();
  });

  it('createKeyHandler: Tab berputar di dalam dialog (maju dan mundur) dan tidak menutup', () => {
    const [a, b, c] = [el('a'), el('b'), el('c')];
    const box = { querySelectorAll: () => [a, b, c], focus: vi.fn() };
    let active = c;
    const onClose = vi.fn();
    const h = createKeyHandler({ getBox: () => box, getActive: () => active, onClose });
    const fwd = ev('Tab');
    h(fwd);
    expect(fwd.preventDefault).toHaveBeenCalled();
    expect(a.focus).toHaveBeenCalledTimes(1);
    active = a;
    const back = ev('Tab', { shiftKey: true });
    h(back);
    expect(back.preventDefault).toHaveBeenCalled();
    expect(c.focus).toHaveBeenCalledTimes(1);
    active = b;
    const mid = ev('Tab');
    h(mid);
    expect(mid.preventDefault).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('createKeyHandler: tanpa elemen fokus, Tab menahan fokus di wadah', () => {
    const box = { querySelectorAll: () => [], focus: vi.fn() };
    const h = createKeyHandler({ getBox: () => box, getActive: () => null, onClose() {} });
    const e = ev('Tab');
    h(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(box.focus).toHaveBeenCalled();
  });

  it('focusableIn memakai selector tombol/input/tautan aktif dan membuang yang tersembunyi', () => {
    const visible = { hidden: false, getAttribute: () => null };
    const hidden = { hidden: true, getAttribute: () => null };
    const ariaHidden = { hidden: false, getAttribute: (k) => (k === 'aria-hidden' ? 'true' : null) };
    let selector = '';
    const box = { querySelectorAll: (s) => { selector = s; return [visible, hidden, ariaHidden]; } };
    expect(focusableIn(box)).toEqual([visible]);
    expect(selector).toBe(FOCUSABLE);
    expect(FOCUSABLE).toMatch(/button:not\(\[disabled\]\)/);
    expect(FOCUSABLE).toMatch(/input:not\(\[disabled\]\)/);
    expect(focusableIn(null)).toEqual([]);
  });

  it('isEscape / isTab', () => {
    expect(isEscape({ key: 'Escape' })).toBe(true);
    expect(isEscape({ key: 'Enter' })).toBe(false);
    expect(isEscape(undefined)).toBe(false);
    expect(isTab({ key: 'Tab' })).toBe(true);
    expect(isTab({ key: 'a' })).toBe(false);
  });

  it('dialog memasang penangan keydown, fokus awal ke dalam, dan mengembalikan fokus ke pembuka (kode)', () => {
    const code = read('ui/dialogA11y.js');
    expect(code).toMatch(/opener = document\.activeElement/);
    expect(code).toMatch(/opener\.focus/);
    expect(code).toMatch(/first\?\.focus/);
    const dlg = read('ui/SettingsDialog.jsx');
    expect(dlg).toMatch(/onKeyDown=\{onKeyDown\}/);
    expect(dlg).toMatch(/onMouseDown=\{\(e\) => \{ if \(e\.target === e\.currentTarget\) onClose\(\)/);
  });
});

describe('teks (i18n) dan kepatuhan', () => {
  const KEYS = [
    'open', 'title', 'close', 'intro', 'theme', 'lang', 'time', 'motion', 'rain', 'rainOff', 'reset', 'done', 'skipped', 'skippedNote',
    ...TIME_CHOICES.map((m) => `time.${m}`), 'time.phase', 'time.now', 'time.hours', ...PHASES.map((p) => `phase.${p}`),
    ...MOTION_MODES.map((m) => `motion.${m}`),
  ];

  it.each(KEYS)('ui.settings.%s ada dan berbeda dari kuncinya di en dan id', (k) => {
    for (const lang of ['en', 'id']) {
      expect(hasKey(`ui.settings.${k}`, lang)).toBe(true);
      expect(t(`ui.settings.${k}`, undefined, lang)).not.toBe(`ui.settings.${k}`);
    }
  });

  it.each(['day', 'night', 'default'])('office.theme.%s ada di en dan id', (k) => {
    for (const lang of ['en', 'id']) expect(hasKey(`office.theme.${k}`, lang)).toBe(true);
  });

  it('semua teks dialog lewat t(); tidak ada teks UI literal di JSX', () => {
    const dlg = read('ui/SettingsDialog.jsx');
    expect(dlg).not.toMatch(/>\s*(Settings|Pengaturan|Done|Selesai|Close|Tutup)\s*</);
    expect((dlg.match(/\bt\(/g) ?? []).length).toBeGreaterThan(15);
  });

  it('tanpa innerHTML / dangerouslySetInnerHTML di src/ dan tanpa eval', () => {
    const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const files = walk(fileURLToPath(SRC)).filter((p) => /\.(jsx?|mjs)$/.test(p));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    }
  });

  it('tombol pengaturan di panel kanan (aria-haspopup=dialog) dan tombol hujan di kanvas tetap ada', () => {
    const app = read('ui/App.jsx');
    expect(app).toMatch(/aria-haspopup="dialog"/);
    expect(app).toMatch(/<SettingsDialog/);
    expect(app).toMatch(/<LangToggle \/>/); // tombol EN/ID lama tetap ada
    const canvas = read('ui/OfficeCanvas.jsx');
    expect(canvas).toMatch(/className="rain-toggle"/);
    expect(canvas).toMatch(/onToggleRain/);
  });

  it('CSS: gaya dialog, fokus terlihat pada opsi, dan atribut data-motion', () => {
    const css = readFileSync(new URL('./styles.css', SRC), 'utf8');
    expect(css).toMatch(/\.dlg-backdrop/);
    expect(css).toMatch(/\.set-opt:has\(input:focus-visible\)/);
    expect(css).toMatch(/:root\[data-motion='reduce'\]/);
    expect(css).toMatch(/:root:not\(\[data-motion='full'\]\)/);
    expect(css).toMatch(/max-height: calc\(100dvh - 1rem\)/); // muat di layar kecil
  });
});
