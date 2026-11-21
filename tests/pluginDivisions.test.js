// Divisi plugin di frontend: roster dinamis (src/divisions.js), tata letak dinamis (layout.js), engine, peringatan UI.
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DIVISIONS, OTHER_DIVISION } from '../shared/roster.js';
import {
  agentNames, applyDivisionsResponse, divisionOf, getState, parseDivisions, resetDivisions, subscribe,
} from '../src/divisions.js';
import { divisionName, setLang } from '../src/i18n.js';
import { getDivisions } from '../src/net.js';
import { Office } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { findPath } from '../src/office/pathfinding.js';
import DivisionsNotice from '../src/ui/DivisionsNotice.jsx';

const { BASE_H, MANAGER_SPOT, W, ZONES, computePluginLayout, obstacles, otherSeat, rosterSeats, zoneList } = layout;

const FIX = JSON.parse(readFileSync(new URL('./fixtures/layout-builtin.json', import.meta.url), 'utf8'));
const COLORS = ['#e11d48', '#0ea5e9', '#16a34a', '#a855f7', '#f59e0b', '#14b8a6'];

const plugin = (i, over = {}) => ({
  id: `p${i}`,
  name: { en: `Plugin ${i}`, id: `Plugin ${i} ID` },
  color: COLORS[i % COLORS.length],
  desks: (i % 8) + 1,
  workers: [`p${i}-a`, `p${i}-b`].slice(0, (i % 8) + 1),
  source: 'plugin',
  ...over,
});
const body = (list, errors = []) => ({ ok: true, divisions: list, errors });
const load = (n) => applyDivisionsResponse(200, body(Array.from({ length: n }, (_, i) => plugin(i + 1))));

afterEach(() => {
  resetDivisions();
  setLang('en');
  vi.unstubAllGlobals();
});

const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const plain = (v) => JSON.parse(JSON.stringify(v));

describe('tata letak bawaan tidak berubah', () => {
  it('tanpa plugin: W, H, zona, meja, dan kursi tamu sama dengan fixture sebelum fitur ini', () => {
    expect(W).toBe(FIX.W);
    expect(layout.H).toBe(FIX.H);
    expect(BASE_H).toBe(FIX.H);
    expect(plain(ZONES)).toEqual(FIX.ZONES);
    expect(zoneList().map((z) => ({ id: z.division.id, rect: z.rect }))).toEqual(FIX.zones);
    const seats = [...rosterSeats()].map(([n, s]) => [n, s.division.id, s.seat, s.desk, s.front, s.exit, s.hit]);
    expect(plain(seats)).toEqual(FIX.seats);
    const other = [0, 1, 2, 3, 4, 5].map((i) => {
      const s = otherSeat(i);
      return [s.division.id, s.seat, s.desk];
    });
    expect(plain(other)).toEqual(FIX.other);
  });

  it('memuat lalu mengosongkan plugin mengembalikan layout persis seperti semula', () => {
    load(3);
    expect(layout.H).toBeGreaterThan(BASE_H);
    resetDivisions();
    expect(layout.H).toBe(FIX.H);
    expect(plain(ZONES)).toEqual(FIX.ZONES);
  });
});

describe('layout dengan divisi plugin', () => {
  it.each([1, 2, 6, 12])('%i divisi plugin: tidak ada zona atau meja yang tumpang tindih, semua di dalam kanvas', (n) => {
    load(n);
    const zones = zoneList();
    expect(zones).toHaveLength(6 + n);
    expect(layout.H).toBeGreaterThan(BASE_H);
    for (let i = 0; i < zones.length; i++) {
      const r = zones[i].rect;
      expect(r.x).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(W);
      expect(r.y + r.h).toBeLessThanOrEqual(layout.H);
      for (let j = i + 1; j < zones.length; j++) {
        expect(overlap(r, zones[j].rect), `${zones[i].division.id} x ${zones[j].division.id}`).toBe(false);
      }
    }
    const desks = [];
    for (const z of zones) {
      const seats = ZONES[z.division.id].seats;
      if (z.division.source === 'plugin') expect(seats).toHaveLength(z.division.desks);
      for (const [sx, sy] of seats) {
        const box = { x: sx - 18, y: sy - 10, w: 36, h: 38 }; // kursi + meja + label di bawahnya
        expect(box.x).toBeGreaterThanOrEqual(z.rect.x);
        expect(box.x + box.w).toBeLessThanOrEqual(z.rect.x + z.rect.w);
        expect(box.y).toBeGreaterThanOrEqual(z.rect.y);
        expect(box.y + box.h).toBeLessThanOrEqual(z.rect.y + z.rect.h);
        desks.push(box);
      }
    }
    for (let i = 0; i < desks.length; i++) {
      for (let j = i + 1; j < desks.length; j++) expect(overlap(desks[i], desks[j])).toBe(false);
    }
  });

  it('deterministik: input sama menghasilkan layout dan tinggi yang sama', () => {
    const list = Array.from({ length: 7 }, (_, i) => plugin(i + 1));
    const parsed = parseDivisions(body(list)).divisions;
    expect(computePluginLayout(parsed)).toEqual(computePluginLayout(parsed));
  });

  it('12 divisi x 8 meja: semua worker punya meja dan manajer bisa berjalan ke setiap meja', () => {
    const list = Array.from({ length: 12 }, (_, i) =>
      plugin(i + 1, { desks: 8, workers: Array.from({ length: 8 }, (_, k) => `p${i + 1}-w${k}`) }));
    applyDivisionsResponse(200, body(list));
    const o = new Office();
    expect(o.workers.size).toBe(17 + 96);
    for (const w of o.workers.values()) expect(findPath(o.grid, MANAGER_SPOT.seat, w.front), w.name).not.toBeNull();
    expect(obstacles([...o.workers.values()]).length).toBeGreaterThan(0);
  });
});

describe('divisionOf dan roster gabungan', () => {
  it('mengenali worker plugin; yang tak dikenal tetap Tamu/Lainnya; bawaan tidak berubah', () => {
    load(2);
    expect(divisionOf('p1-a').id).toBe('p1');
    expect(divisionOf('p1-a').color).toBe(COLORS[1]);
    expect(divisionOf('dev-qa').id).toBe('dev');
    expect(divisionOf('Explore')).toBe(OTHER_DIVISION);
    expect(agentNames()).toEqual([...DIVISIONS.flatMap((d) => d.agents), 'p1-a', 'p1-b', 'p2-a', 'p2-b']);
  });

  it('nama divisi plugin mengikuti bahasa UI', () => {
    load(1);
    const d = divisionOf('p1-a');
    setLang('en');
    expect(divisionName(d)).toBe('Plugin 1');
    setLang('id');
    expect(divisionName(d)).toBe('Plugin 1 ID');
  });

  it('engine: worker plugin duduk di mejanya, tamu yang sudah ada dipindah saat roster berubah', () => {
    const o = new Office();
    o.ensureWorker('p1-a');
    expect(o.workers.get('p1-a').division.id).toBe('other');
    load(1);
    o.syncRoster();
    const w = o.workers.get('p1-a');
    expect(w.division.id).toBe('p1');
    expect(w.dynamic).toBe(false);
    expect(w.seat).toEqual({ x: ZONES.p1.seats[0][0], y: ZONES.p1.seats[0][1] });
    w.status = 'working';
    resetDivisions();
    o.syncRoster();
    expect(o.workers.get('p1-a').division.id).toBe('other');
    expect(o.workers.get('p1-a').dynamic).toBe(true);
  });

  it('reset() (simulasi) memakai roster saat ini', () => {
    load(2);
    const o = new Office();
    o.reset();
    expect(o.workers.has('p2-b')).toBe(true);
  });

  it('subscribe: pendengar dipanggil saat roster berubah, tidak saat data sama', () => {
    const fn = vi.fn();
    const off = subscribe(fn);
    load(1);
    load(1);
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    resetDivisions();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('fallback bila ambil data gagal', () => {
  it.each([
    ['404 server lama', 404, { ok: false }],
    ['500', 500, undefined],
    ['jaringan gagal', null, undefined],
    ['200 tapi bukan JSON', 200, undefined],
    ['200 tanpa daftar divisi', 200, { ok: true }],
    ['200 divisions bukan array', 200, { ok: true, divisions: 'x' }],
    ['ok false', 200, { ok: false, divisions: [] }],
  ])('%s: roster dan layout tidak berubah', (_n, status, b) => {
    const before = getState();
    expect(applyDivisionsResponse(status, b)).toBe(false);
    expect(getState()).toBe(before);
    expect(getState().plugin).toHaveLength(0);
    expect(layout.H).toBe(BASE_H);
  });

  it('getDivisions tidak melempar saat fetch gagal', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    await expect(getDivisions()).resolves.toEqual({ status: null, body: undefined });
  });

  it('kegagalan setelah data termuat tidak menghapus roster terakhir', () => {
    load(2);
    expect(applyDivisionsResponse(500, undefined)).toBe(false);
    expect(getState().plugin).toHaveLength(2);
  });
});

describe('validasi ulang di klien', () => {
  const bad = [
    ['id kosong', { id: '' }],
    ['id huruf besar', { id: 'Abc' }],
    ['id bentrok divisi bawaan', { id: 'dev' }],
    ['id other', { id: 'other' }],
    ['id __proto__', { id: '__proto__' }],
    ['nama berupa angka', { name: 5 }],
    ['worker diakhiri tanda hubung', { workers: ['a-'] }],
    ['id manager', { id: 'manager' }],
    ['daftar worker kosong', { workers: [] }],
    ['nama id kosong', { name: { en: 'A', id: '  ' } }],
    ['nama berisi karakter kontrol', { name: { en: 'A\u0007', id: 'B' } }],
    ['nama terlalu panjang', { name: { en: 'x'.repeat(41), id: 'B' } }],
    ['warna bukan hex 6', { color: 'red' }],
    ['warna injeksi', { color: '#fff;}</style>' }],
    ['desks 0', { desks: 0 }],
    ['desks 9', { desks: 9 }],
    ['desks pecahan', { desks: 2.5 }],
    ['workers bukan array', { workers: 'a' }],
    ['worker lebih dari 8', { workers: Array.from({ length: 9 }, (_, i) => `w${i}`) }],
    ['nama worker tidak kebab', { workers: ['Bad_Name'] }],
    ['nama worker bentrok bawaan', { workers: ['dev-qa'] }],
    ['worker ganda', { workers: ['x-a', 'x-a'] }],
  ];
  it.each(bad)('membuang entri: %s', (_n, over) => {
    applyDivisionsResponse(200, body([plugin(1, over), plugin(9)]));
    expect(getState().plugin.map((d) => d.id)).toEqual(['p9']);
    expect(getState().errors).toHaveLength(1);
  });

  it('entri bukan objek dibuang', () => {
    applyDivisionsResponse(200, body([null, 5, 'x', [], plugin(1)]));
    expect(getState().plugin).toHaveLength(1);
    expect(getState().errors).toHaveLength(4);
  });

  it('id dobel dan worker dobel antar plugin: yang kedua dibuang', () => {
    applyDivisionsResponse(200, body([plugin(1), plugin(1, { workers: ['z'] }), plugin(2, { workers: ['p1-a'] })]));
    expect(getState().plugin.map((d) => d.id)).toEqual(['p1']);
  });

  it('lebih dari 12 divisi: sisanya dibuang', () => {
    load(15);
    expect(getState().plugin).toHaveLength(12);
    expect(getState().errors).toHaveLength(3);
  });

  it('desks lebih kecil dari jumlah worker: ditolak (sama dengan server)', () => {
    applyDivisionsResponse(200, body([plugin(1, { desks: 1, workers: ['a-1', 'a-2', 'a-3'] })]));
    expect(getState().plugin).toHaveLength(0);
    expect(getState().errors).toHaveLength(1);
  });

  it('field `source` dari server diterima; field tak dikenal lain membuat entri ditolak', () => {
    applyDivisionsResponse(200, body([plugin(1), { ...plugin(2), html: '<img onerror=x>' }]));
    expect(getState().plugin.map((d) => d.id)).toEqual(['p1']);
    const d = getState().plugin[0];
    expect(Object.keys(d).sort()).toEqual(['agents', 'color', 'desks', 'id', 'name', 'names', 'source']);
    expect(d.source).toBe('plugin');
  });

  it('errors dari server disanitasi: hanya teks, dibatasi panjang dan jumlah', () => {
    const many = Array.from({ length: 40 }, () => ({ dir: 'd', message: 'x' }));
    applyDivisionsResponse(200, body([], [{ dir: 'a', message: 'm'.repeat(500) }, 5, { dir: 3, message: {} }, ...many]));
    const errs = getState().errors;
    expect(errs.length).toBeLessThanOrEqual(20);
    expect(errs[0].message).toHaveLength(200);
    expect(errs[1]).toEqual({ dir: '', message: '' });
  });
});

describe('tidak ada HTML mentah', () => {
  const evil = '<img src=x onerror=alert(1)>';

  it('peringatan merender teks server sebagai teks yang di-escape', () => {
    const html = renderToStaticMarkup(
      createElement(DivisionsNotice, { errors: [{ dir: evil, message: `<script>alert(1)</script>${evil}` }] }),
    );
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
    expect(html).toContain('<details');
    expect(html).toContain('1 division(s) not loaded');
  });

  it('tanpa error tidak ada yang dirender', () => {
    expect(renderToStaticMarkup(createElement(DivisionsNotice, { errors: [] }))).toBe('');
  });

  it('nama berisi markup tetap string biasa; UI tidak memakai API HTML mentah', () => {
    applyDivisionsResponse(200, body([plugin(1, { name: { en: '<b>x</b>', id: '<i>y</i>' } })]));
    expect(divisionName(divisionOf('p1-a'))).toBe('<b>x</b>');
    for (const f of ['../src/ui/App.jsx', '../src/ui/DivisionsNotice.jsx', '../src/ui/OfficeCanvas.jsx', '../src/divisions.js']) {
      const src = readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML/);
    }
  });
});

describe('kartu panggung (.stage-card)', () => {
  it('tanpa plugin: tidak ada gaya tambahan (posisi CSS bawaan persis seperti sekarang)', async () => {
    const { stageCardBottom } = await import('../src/office/fit.js');
    expect(stageCardBottom()).toBeNull();
    expect(stageCardBottom(BASE_H)).toBeNull();
    const { EmptyCard } = await import('../src/ui/StageNotices.jsx');
    expect(renderToStaticMarkup(createElement(EmptyCard, { onSimulate() {} }))).not.toContain('style=');
  });

  it('dengan plugin: bawah kartu dihitung dari tinggi layout, di dasar kantor bawaan', async () => {
    const { stageCardBottom } = await import('../src/office/fit.js');
    const { EmptyCard } = await import('../src/ui/StageNotices.jsx');
    load(4);
    const pct = parseFloat(stageCardBottom());
    const expected = 1 + ((layout.H - BASE_H) / layout.H) * 100;
    expect(pct).toBeCloseTo(expected, 2);
    expect(pct).toBeGreaterThan(1);
    // tepi atas kartu tidak boleh melewati baris pertama zona plugin (y = BASE_H di koordinat kanvas)
    expect(renderToStaticMarkup(createElement(EmptyCard, { onSimulate() {} }))).toContain(`bottom:${stageCardBottom()}`);
    resetDivisions();
    expect(stageCardBottom()).toBeNull();
  });
});
