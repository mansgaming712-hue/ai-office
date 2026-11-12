// Tahap 2: model status agen di UI (idle, bekerja, selesai, error) dan pemetaannya dari event server.
import { describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '../shared/roster.js';
import { EVENT_TYPES, normalizeEvent } from '../shared/events.js';
import {
  GLYPHS, GLYPH_SIZE, STATUS_INFO, STATUS_LABEL, UI_STATUSES,
  countStatuses, glyphPaths, statusForEvent, summaryText, uiStatusOf,
} from '../src/agentStatus.js';
import { Office, STATUS_LABEL as ENGINE_LABEL } from '../src/office/engine.js';
import { STATUS_COLOR } from '../src/office/render.js';

const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;

describe('model status UI', () => {
  it('tepat empat status: idle, bekerja, selesai, error', () => {
    expect(UI_STATUSES).toEqual(['idle', 'bekerja', 'selesai', 'error']);
    expect(Object.keys(STATUS_LABEL)).toEqual(UI_STATUSES);
  });

  it('tipe event dari server tetap lima (kontrak tidak berubah)', () => {
    expect([...EVENT_TYPES].sort()).toEqual(['assign', 'blocked', 'done', 'report', 'working']);
  });

  it.each([
    ['assign', 'bekerja'],
    ['working', 'bekerja'],
    ['done', 'selesai'],
    ['report', 'selesai'],
    ['blocked', 'error'],
  ])('event %s → status %s', (type, expected) => {
    expect(statusForEvent(type, 'idle')).toBe(expected);
  });

  it('report dari agen yang sedang error tidak menghapus error; event lain menimpanya', () => {
    expect(statusForEvent('report', 'error')).toBe('error');
    expect(statusForEvent('working', 'error')).toBe('bekerja');
    expect(statusForEvent('done', 'error')).toBe('selesai');
    expect(statusForEvent('report', 'bekerja')).toBe('selesai');
  });

  it('tipe tak dikenal tidak mengubah status', () => {
    expect(statusForEvent('lain', 'bekerja')).toBe('bekerja');
    expect(statusForEvent(undefined)).toBe('idle');
  });

  it('status internal engine diterjemahkan ke status UI', () => {
    expect(uiStatusOf('idle')).toBe('idle');
    expect(uiStatusOf('working')).toBe('bekerja');
    expect(uiStatusOf('done')).toBe('selesai');
    expect(uiStatusOf('blocked')).toBe('error');
    expect(uiStatusOf('aneh')).toBe('idle');
    expect(uiStatusOf(undefined)).toBe('idle');
  });

  it('label engine dan warna kanvas memakai model yang sama', () => {
    expect(ENGINE_LABEL).toEqual({ idle: 'idle', working: 'bekerja', done: 'selesai', blocked: 'error' });
    expect(STATUS_COLOR.blocked).toBe(STATUS_INFO.error.fill);
    expect(STATUS_COLOR.working).toBe(STATUS_INFO.bekerja.fill);
  });
});

describe('engine mengikuti pemetaan event → status UI', () => {
  const sequences = [
    ['working', 'done'],
    ['working', 'blocked', 'report'],
    ['blocked', 'working', 'report'],
    ['done', 'working'],
    ['report'],
    ['blocked', 'done'],
  ];

  it.each(sequences)('urutan event worker (mode instan): %s', (...types) => {
    for (const agent of ['dev-qa', '3d-render', 'research-analyst']) {
      const o = new Office();
      let expected = 'idle';
      for (const t of types) {
        o.handleEvent(ev(t, agent, 'manager'), { instant: true });
        expected = statusForEvent(t, expected);
        expect(uiStatusOf(o.workers.get(agent).status), `${agent} setelah ${t}`).toBe(expected);
      }
    }
  });

  it('assign (instan) membuat agen bekerja; agen lain tetap idle', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-frontend'), { instant: true });
    expect(uiStatusOf(o.workers.get('dev-frontend').status)).toBe('bekerja');
    expect(uiStatusOf(o.workers.get('dev-backend').status)).toBe('idle');
  });

  it('alur penuh dengan animasi: tugas diterima → bekerja → error (blocked) → selesai', () => {
    const o = new Office();
    const run = (s) => { for (let t = 0; t < s; t += 1 / 60) o.update(1 / 60); };
    o.handleEvent(ev('assign', 'manager', 'dev-qa'));
    expect(uiStatusOf(o.workers.get('dev-qa').status)).toBe('idle'); // manajer belum tiba
    run(20);
    expect(uiStatusOf(o.workers.get('dev-qa').status)).toBe('bekerja');
    o.handleEvent(ev('blocked', 'dev-qa', 'manager', 'butuh bantuan'));
    expect(uiStatusOf(o.workers.get('dev-qa').status)).toBe('error');
    o.handleEvent(ev('done', 'dev-qa', 'manager'));
    run(0.1);
    expect(uiStatusOf(o.workers.get('dev-qa').status)).toBe('selesai');
  });

  it('setiap perubahan status mencatat statusSince untuk animasi penanda', () => {
    const o = new Office();
    for (let i = 0; i < 10; i++) o.update(0.1);
    const w = o.workers.get('dev-qa');
    expect(w.statusSince).toBe(-Infinity);
    w.status = 'working';
    expect(w.statusSince).toBeCloseTo(1, 5);
    for (let i = 0; i < 5; i++) o.update(0.1);
    w.status = 'working'; // sama: tidak mengubah waktu
    expect(w.statusSince).toBeCloseTo(1, 5);
    w.status = 'blocked';
    expect(w.statusSince).toBeCloseTo(1.5, 5);
  });

  it('snapshot tetap memakai status internal (kontrak dengan test lama)', () => {
    const o = new Office();
    o.handleEvent(ev('blocked', 'dev-qa', 'manager'), { instant: true });
    expect(o.snapshot().workers['dev-qa'].status).toBe('blocked');
  });
});

describe('ringkasan jumlah per status', () => {
  const st = (...list) => Object.fromEntries(list.map((s, i) => [`a${i}`, { status: s, division: 'dev' }]));

  it('menghitung per status', () => {
    expect(countStatuses(st('idle', 'bekerja', 'bekerja', 'error', 'selesai'))).toEqual({ idle: 1, bekerja: 2, selesai: 1, error: 1 });
  });

  it('semua 17 agen roster idle di awal', () => {
    const o = new Office();
    const statuses = Object.fromEntries([...o.workers.values()].map((w) => [w.name, { status: uiStatusOf(w.status) }]));
    expect(Object.keys(statuses)).toHaveLength(AGENT_NAMES.length);
    expect(countStatuses(statuses)).toEqual({ idle: 17, bekerja: 0, selesai: 0, error: 0 });
  });

  it('teks ringkasan: hanya status yang ada, tanpa idle', () => {
    expect(summaryText({ idle: 13, bekerja: 3, selesai: 0, error: 1 })).toBe('3 bekerja, 1 error');
    expect(summaryText({ idle: 14, bekerja: 2, selesai: 1, error: 0 })).toBe('2 bekerja, 1 selesai');
    expect(summaryText({ idle: 16, bekerja: 0, selesai: 0, error: 1 })).toBe('1 error');
  });

  it('semua idle dan kosong punya teks sendiri', () => {
    expect(summaryText({ idle: 17, bekerja: 0, selesai: 0, error: 0 })).toBe('Semua agen idle');
    expect(summaryText({ idle: 0, bekerja: 0, selesai: 0, error: 0 })).toBe('Belum ada agen');
  });

  it('input rusak tidak melempar', () => {
    expect(countStatuses(undefined)).toEqual({ idle: 0, bekerja: 0, selesai: 0, error: 0 });
    expect(countStatuses({ a: null, b: { status: 'aneh' } })).toEqual({ idle: 2, bekerja: 0, selesai: 0, error: 0 });
  });
});

describe('status tidak dibedakan warna saja', () => {
  it('tiap status punya label teks dan keterangan sendiri', () => {
    const labels = UI_STATUSES.map((s) => STATUS_INFO[s].label);
    expect(new Set(labels).size).toBe(4);
    for (const s of UI_STATUSES) {
      expect(STATUS_INFO[s].label.length).toBeGreaterThan(0);
      expect(STATUS_INFO[s].title.length).toBeGreaterThan(STATUS_INFO[s].label.length);
    }
  });

  it('tiap status punya bitmap ikon 9x9 yang berbeda bentuknya', () => {
    const shapes = new Set();
    for (const s of UI_STATUSES) {
      const rows = GLYPHS[s];
      expect(rows).toHaveLength(GLYPH_SIZE);
      for (const r of rows) {
        expect(r).toHaveLength(GLYPH_SIZE);
        expect(r).toMatch(/^[kfmp.]+$/);
      }
      // siluet = piksel yang terisi (bukan '.'), tanpa membedakan huruf warna
      shapes.add(rows.map((r) => r.replace(/[kfmp]/g, '#')).join('/'));
      expect(rows.join('')).toContain('k'); // selalu ada garis tepi
    }
    expect(shapes.size).toBe(4);
  });

  it('bitmap berbeda satu sama lain bahkan bila warna diabaikan (selain tanda)', () => {
    const marks = new Set(UI_STATUSES.map((s) => GLYPHS[s].join('|')));
    expect(marks.size).toBe(4);
  });

  it('glyphPaths menghasilkan path SVG per huruf warna, kosong untuk status tak dikenal', () => {
    for (const s of UI_STATUSES) {
      const p = glyphPaths(s);
      expect(p.k).toMatch(/^M\d+ \d+h\d+v1h-\d+z/);
      expect(p.k.length).toBeGreaterThan(10);
    }
    expect(glyphPaths('error').m.length).toBeGreaterThan(0); // tanda seru
    expect(glyphPaths('bekerja').m.length).toBeGreaterThan(0); // titik
    expect(glyphPaths('aneh')).toEqual({ k: '', f: '', m: '', p: '' });
  });

  it('jumlah piksel path sama dengan jumlah piksel bitmap', () => {
    for (const s of UI_STATUSES) {
      const total = GLYPHS[s].join('').replace(/\./g, '').length;
      const p = glyphPaths(s);
      let sum = 0;
      for (const d of Object.values(p)) for (const m of d.matchAll(/h(\d+)v1/g)) sum += Number(m[1]);
      expect(sum).toBe(total);
    }
  });
});
