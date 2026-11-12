// Tahap 2: logika loading / kosong / terputus (src/viewState.js) dan keadaan panel pemakaian yang selaras.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BANNER_TEXT, CONN_LABEL, EMPTY_TEXT, LOADING_TEXT, initialLink, linkReducer, linkView, stageState,
} from '../src/viewState.js';
import { CONFIG_HINT, UNAVAILABLE_TEXT, displayUsage, usageState, validateUsage } from '../src/usage.js';

const apply = (...actions) => actions.reduce(linkReducer, initialLink);
const status = (s) => ({ type: 'status', status: s });
const hello = { type: 'hello' };

describe('status koneksi (linkReducer / linkView)', () => {
  it('awal: menghubungkan; belum pernah online, belum gagal, belum ada riwayat', () => {
    expect(initialLink).toEqual({ conn: 'connecting', everOnline: false, failed: false, everHello: false });
    expect(linkView(initialLink)).toBe('connecting');
  });

  it('online → terhubung', () => {
    expect(linkView(apply(status('online')))).toBe('online');
  });

  it('gagal sebelum pernah terhubung → server tidak terjangkau (juga saat percobaan ulang sedang menghubungkan)', () => {
    expect(linkView(apply(status('offline')))).toBe('unreachable');
    expect(linkView(apply(status('offline'), status('connecting')))).toBe('unreachable');
    expect(linkView(apply(status('offline'), status('connecting'), status('offline')))).toBe('unreachable');
  });

  it('putus setelah pernah terhubung → menyambung ulang', () => {
    const l = apply(status('online'), hello, status('offline'));
    expect(linkView(l)).toBe('reconnecting');
    expect(linkView(linkReducer(l, status('connecting')))).toBe('reconnecting');
    expect(linkView(linkReducer(l, status('online')))).toBe('online'); // tersambung lagi
  });

  it('riwayat (hello) hanya dicatat sekali dan bertahan saat koneksi putus', () => {
    const l = apply(status('online'), hello, hello, status('offline'));
    expect(l.everHello).toBe(true);
  });

  it('aksi tak dikenal tidak mengubah state', () => {
    expect(linkReducer(initialLink, { type: 'aneh' })).toBe(initialLink);
    expect(linkReducer(initialLink, status('aneh'))).toBe(initialLink);
  });
});

describe('tahap tampilan kantor (stageState)', () => {
  const st = (link, over = {}) => stageState({ link, hasEvents: false, simRunning: false, ...over });

  it('loading: belum terhubung, atau online tapi riwayat belum datang', () => {
    expect(st(initialLink)).toMatchObject({ stage: 'loading', banner: null });
    expect(st(apply(status('online')))).toMatchObject({ stage: 'loading', banner: null });
  });

  it('kosong: terhubung, riwayat sudah datang, belum ada kejadian', () => {
    expect(st(apply(status('online'), hello))).toMatchObject({ stage: 'empty', banner: null });
  });

  it('siap: ada kejadian (dari riwayat atau event baru)', () => {
    expect(st(apply(status('online'), hello), { hasEvents: true })).toMatchObject({ stage: 'ready', banner: null });
  });

  it('siap: simulasi berjalan, apa pun status koneksinya (tidak loading, tidak kosong)', () => {
    for (const link of [initialLink, apply(status('online')), apply(status('online'), hello), apply(status('offline'))]) {
      expect(st(link, { simRunning: true }).stage).toBe('ready');
    }
  });

  it('server tidak terjangkau sejak awal: tidak terjebak di loading; banner tampil', () => {
    expect(st(apply(status('offline')))).toMatchObject({ stage: 'ready', banner: 'unreachable', view: 'unreachable' });
  });

  it('terputus setelah terhubung: banner reconnecting; kantor tetap tampil dengan data terakhir', () => {
    const l = apply(status('online'), hello, status('offline'));
    expect(st(l, { hasEvents: true })).toMatchObject({ stage: 'ready', banner: 'reconnecting' });
    expect(st(l)).toMatchObject({ stage: 'ready', banner: 'reconnecting' }); // tanpa kejadian: bukan "kosong" saat offline
  });

  it('banner juga tampil saat simulasi berjalan; hilang begitu tersambung lagi', () => {
    const down = apply(status('online'), hello, status('offline'));
    expect(st(down, { simRunning: true }).banner).toBe('reconnecting');
    expect(st(linkReducer(down, status('online')), { hasEvents: true }).banner).toBeNull();
  });

  it('terhubung kembali tanpa riwayat baru tidak kembali ke loading', () => {
    const l = apply(status('online'), hello, status('offline'), status('connecting'), status('online'));
    expect(st(l).stage).toBe('empty');
  });
});

describe('teks keadaan (bahasa Indonesia, jelas, dan memberi jalan keluar)', () => {
  it('label koneksi untuk keempat tampilan', () => {
    expect(Object.keys(CONN_LABEL).sort()).toEqual(['connecting', 'online', 'reconnecting', 'unreachable']);
    expect(CONN_LABEL.reconnecting).toMatch(/menyambung ulang/i);
    expect(CONN_LABEL.unreachable).toMatch(/tidak terjangkau/i);
  });

  it('banner menyebut penyebab dan bahwa reconnect otomatis', () => {
    for (const kind of ['reconnecting', 'unreachable']) {
      expect(BANNER_TEXT[kind].title.length).toBeGreaterThan(5);
      expect(BANNER_TEXT[kind].body).toMatch(/menyambung ulang otomatis/i);
      expect(BANNER_TEXT[kind].body).toMatch(/simulasi/i);
    }
    expect(BANNER_TEXT.unreachable.title).toMatch(/server tidak terjangkau/i);
    expect(BANNER_TEXT.reconnecting.title).toMatch(/koneksi terputus/i);
  });

  it('keadaan kosong menawarkan simulasi dan perintah pasang hooks yang memang ada di package.json', () => {
    expect(EMPTY_TEXT.simulate).toMatch(/simulasi/i);
    expect(EMPTY_TEXT.hooksCommand).toBe('npm run hooks:install-user');
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(pkg.scripts['hooks:install-user']).toBeTruthy();
    expect(EMPTY_TEXT.hooksIntro).toMatch(/hooks/i);
    expect(LOADING_TEXT.title).toMatch(/menghubungkan/i);
  });
});

describe('panel pemakaian: loading, tidak tersedia, dan limit belum diisi tetap selaras', () => {
  const day = (date) => ({ date, input: 1, output: 1, cacheRead: 1, cacheCreation: 1, total: 4 });
  const usage = (weekly) => ({
    available: true, reason: null, estimate: true, updatedAt: '2026-11-09T02:00:00.000Z',
    today: day('2026-11-09'), days: [day('2026-11-09')], perAgent: [],
    weekly: { used: 1000, limit: null, percent: null, level: null, windowStart: '2026-11-03T00:00:00.000Z', configAvailable: false, ...weekly },
  });

  it('data tidak tersedia → state unavailable dengan alasan; bukan crash', () => {
    const s = usageState(validateUsage({ available: false, reason: 'Folder log tidak ditemukan' }));
    expect(s).toEqual({ status: 'unavailable', reason: 'Folder log tidak ditemukan' });
    expect(usageState(validateUsage(null)).reason).toBe(UNAVAILABLE_TEXT);
  });

  it('limit belum diisi → data valid, weekly.configured false, tanpa persen/level', () => {
    const r = validateUsage(usage({}));
    expect(r.ok).toBe(true);
    expect(r.usage.weekly).toMatchObject({ configured: false, limit: null, percent: null, level: null });
    expect(CONFIG_HINT).toMatch(/weeklyTokenLimit/);
  });

  it('simulasi menimpa tampilan, data server tetap utuh', () => {
    const real = { status: 'unavailable', reason: 'x' };
    const sim = validateUsage(usage({})).usage;
    expect(displayUsage(real, sim)).toMatchObject({ status: 'ok', sim: true });
    expect(displayUsage(real, null)).toBe(real);
  });

  it('UsagePanel memakai satu komponen Notice untuk ketiga keadaan (bentuk seragam)', () => {
    const src = readFileSync(new URL('../src/ui/UsagePanel.jsx', import.meta.url), 'utf8');
    expect(src).toMatch(/<Notice kind="config"/);
    expect(src).toMatch(/<Notice kind="unavailable"/);
    expect(src).toMatch(/usage-state us-loading/);
    expect(src).not.toMatch(/usage-empty|usage-config/); // gaya lama dihapus
  });

  it('bar pemakaian bertransisi halus, dan transisi mati saat reduced motion (CSS)', () => {
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    expect(css).toMatch(/\.usage-fill\s*\{[^}]*transition:\s*width/);
    expect(css).toMatch(/\.usage-col-fill\s*\{[^}]*transition:\s*height/);
    const rm = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(rm).toMatch(/transition-duration:\s*0\.001ms\s*!important/);
  });
});

// Temuan dev-qa: nama agen sangat panjang mendorong lebar halaman; tombol Rincian di bawah 24px.
describe('gaya: temuan QA', () => {
  it('rute di log boleh dipatahkan dan tombol Rincian punya tinggi minimal', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
    // Isi blok aturan pertama yang selektornya persis `sel` di awal baris.
    const rule = (sel) => {
      const line = css.split('\n').findIndex((l) => l.startsWith(`${sel} {`));
      if (line < 0) return '';
      const rest = css.split('\n').slice(line).join('\n');
      return rest.slice(rest.indexOf('{') + 1, rest.indexOf('}'));
    };
    expect(rule('.route')).toMatch(/overflow-wrap:\s*anywhere/);
    expect(rule('.route')).toMatch(/min-width:\s*0/);
    expect(rule('.usage-toggle')).toMatch(/min-height:\s*1\.75rem/);
  });
});
