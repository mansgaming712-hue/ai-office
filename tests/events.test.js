import { describe, expect, it } from 'vitest';
import { EVENT_TYPES, LIMITS, makeEvent, normalizeBatch, normalizeEvent, stripControl } from '../shared/events.js';
import { parseCommand } from '../src/command.js';
import { Office } from '../src/office/engine.js';

const fixed = () => new Date('2026-11-08T01:02:03.000Z');

describe('normalizeEvent', () => {
  it('menerima event lengkap dan mengisi waktu bila kosong', () => {
    const r = normalizeEvent({ type: 'assign', from: 'manager', to: 'dev-qa', message: 'Uji' }, { now: fixed });
    expect(r).toEqual({
      ok: true,
      event: { type: 'assign', from: 'manager', to: 'dev-qa', message: 'Uji', time: '2026-11-08T01:02:03.000Z' },
    });
  });

  it('menerima kunci bahasa Indonesia (tipe, dari, ke, pesan, waktu)', () => {
    const r = normalizeEvent({ tipe: 'done', dari: 'dev-qa', ke: 'manajer', pesan: 'ok', waktu: '2026-01-01T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.event).toEqual({ type: 'done', from: 'dev-qa', to: 'manager', message: 'ok', time: '2026-01-01T00:00:00.000Z' });
  });

  it('mengutamakan kunci Inggris bila keduanya ada', () => {
    const r = normalizeEvent({ type: 'done', tipe: 'blocked', from: 'a', to: 'b' });
    expect(r.event.type).toBe('done');
  });

  it.each(EVENT_TYPES)('menerima tipe %s', (type) => {
    expect(normalizeEvent({ type, from: 'a', to: 'b' }).ok).toBe(true);
  });

  it('menolak tipe tak dikenal, nama kosong, dan input bukan objek', () => {
    expect(normalizeEvent({ type: 'hapus', from: 'a', to: 'b' }).ok).toBe(false);
    expect(normalizeEvent({ type: 'done', from: '', to: 'b' }).ok).toBe(false);
    expect(normalizeEvent({ type: 'done', from: 'a' }).ok).toBe(false);
    expect(normalizeEvent({ type: 'done', from: 'a b', to: 'c' }).ok).toBe(false);
    expect(normalizeEvent({ type: 'done', from: '<script>', to: 'c' }).ok).toBe(false);
    expect(normalizeEvent(null).ok).toBe(false);
    expect(normalizeEvent([]).ok).toBe(false);
    expect(normalizeEvent('done').ok).toBe(false);
  });

  it('menolak message objek dan time tidak valid', () => {
    expect(normalizeEvent({ type: 'done', from: 'a', to: 'b', message: { x: 1 } }).ok).toBe(false);
    expect(normalizeEvent({ type: 'done', from: 'a', to: 'b', time: 'kemarin' }).ok).toBe(false);
  });

  it('memotong pesan panjang, merapikan spasi, dan huruf kecil pada nama', () => {
    const r = normalizeEvent({ type: 'report', from: 'Explore', to: 'MANAGER', message: `  a\n\n b ${'x'.repeat(900)}` });
    expect(r.event.from).toBe('explore');
    expect(r.event.to).toBe('manager');
    expect(r.event.message.length).toBe(LIMITS.message);
    expect(r.event.message.startsWith('a b x')).toBe(true);
    expect(r.event.message.endsWith('…')).toBe(true);
  });

  it('membuang field asing tetapi menyimpan source yang dikenal', () => {
    const r = normalizeEvent({ type: 'done', from: 'a', to: 'b', source: 'hook', evil: 1, id: 'x' });
    expect(r.event.source).toBe('hook');
    expect(r.event).not.toHaveProperty('evil');
    expect(r.event).not.toHaveProperty('id');
  });

  it('normalizeBatch atomik dan membatasi jumlah', () => {
    expect(normalizeBatch([{ type: 'done', from: 'a', to: 'b' }, { type: 'x' }]).ok).toBe(false);
    expect(normalizeBatch([]).ok).toBe(false);
    expect(normalizeBatch(Array.from({ length: LIMITS.batch + 1 }, () => ({ type: 'done', from: 'a', to: 'b' }))).ok).toBe(false);
    expect(normalizeBatch({ type: 'done', from: 'a', to: 'b' }).events).toHaveLength(1);
  });

  it('makeEvent melempar error untuk input salah', () => {
    expect(() => makeEvent('nope', 'a', 'b')).toThrow();
    expect(makeEvent('done', 'a', 'b', 'ok').type).toBe('done');
  });
});

describe('parseCommand (kotak perintah)', () => {
  it('teks biasa → perintah CEO ke manajer', () => {
    const r = parseCommand('Buat landing page');
    expect(r.ok).toBe(true);
    expect(r.events[0]).toMatchObject({ type: 'assign', from: 'ceo', to: 'manager', message: 'Buat landing page', source: 'ui' });
  });

  it('@agen tugas → manajer menugaskan agen', () => {
    const r = parseCommand('@dev-qa jalankan semua test');
    expect(r.events[0]).toMatchObject({ type: 'assign', from: 'manager', to: 'dev-qa', message: 'jalankan semua test' });
  });

  it('@agen tanpa tugas dan input kosong ditolak', () => {
    expect(parseCommand('@dev-qa').ok).toBe(false);
    expect(parseCommand('   ').ok).toBe(false);
  });

  it('JSON event mentah diterima, JSON rusak ditolak', () => {
    const r = parseCommand('{"type":"blocked","from":"dev-qa","to":"manager","message":"butuh akses"}');
    expect(r.ok).toBe(true);
    expect(r.events[0]).toMatchObject({ type: 'blocked', from: 'dev-qa', source: 'ui' });
    expect(parseCommand('{rusak').ok).toBe(false);
    expect(parseCommand('{"type":"x","from":"a","to":"b"}').ok).toBe(false);
  });
});

// ------------------------------------------------- R4: nama dan kunci yang juga properti Object.prototype
const PROTO_NAMES = ['constructor', 'tostring', 'hasownproperty', 'valueof', 'isprototypeof'];

describe('R4: nama/kunci dari Object.prototype tidak menghasilkan nilai warisan', () => {
  it.each(PROTO_NAMES)('from/to "%s" tetap string apa adanya', (name) => {
    const r = normalizeEvent({ type: 'done', from: name, to: name, message: 'x' }, { now: fixed });
    expect(r.ok).toBe(true);
    expect(typeof r.event.from).toBe('string');
    expect(r.event).toEqual({ type: 'done', from: name, to: name, message: 'x', time: '2026-11-08T01:02:03.000Z' });
  });

  it('"toString" (huruf besar) dinormalisasi jadi "tostring", "__proto__" ditolak sebagai nama', () => {
    expect(normalizeEvent({ type: 'done', from: 'toString', to: 'b' }).event.from).toBe('tostring');
    expect(normalizeEvent({ type: 'done', from: '__proto__', to: 'b' })).toMatchObject({ ok: false, error: expect.stringMatching(/"from" hanya boleh/) });
    expect(normalizeEvent({ type: 'done', from: 'a', to: '__proto__' }).ok).toBe(false);
  });

  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('kunci input "%s" diabaikan (event hanya berisi field yang dikenal)', (k) => {
    const r = normalizeEvent(JSON.parse(`{"type":"done","from":"a","to":"b","${k}":"x"}`), { now: fixed });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.event).sort()).toEqual(['from', 'message', 'time', 'to', 'type']);
  });

  it('{"__proto__":{type,from,to}} ditolak: field tidak bisa "terwarisi" dari prototype palsu', () => {
    const all = normalizeEvent(JSON.parse('{"__proto__":{"type":"done","from":"a","to":"b"}}'));
    expect(all).toMatchObject({ ok: false, error: expect.stringMatching(/"type" harus salah satu/) });
    const partial = normalizeEvent(JSON.parse('{"__proto__":{"type":"done"},"from":"a","to":"b"}'));
    expect(partial.ok).toBe(false);
    expect(normalizeBatch(JSON.parse('[{"__proto__":{"type":"done","from":"a","to":"b"}}]')).ok).toBe(false);
  });

  it('tipe/source bernama properti prototype ditolak / dibuang', () => {
    expect(normalizeEvent({ type: 'constructor', from: 'a', to: 'b' }).ok).toBe(false);
    expect(normalizeEvent({ type: 'done', from: 'a', to: 'b', source: 'constructor' }).event).not.toHaveProperty('source');
  });

  it('alias Indonesia tetap jalan (kunci dan nama)', () => {
    const r = normalizeEvent(JSON.parse('{"tipe":"assign","dari":"manajer","ke":"dev-qa","pesan":"halo","sumber":"api","waktu":"2026-01-01T00:00:00Z"}'));
    expect(r.event).toEqual({ type: 'assign', from: 'manager', to: 'dev-qa', message: 'halo', time: '2026-01-01T00:00:00.000Z', source: 'api' });
    expect(normalizeEvent({ type: 'done', from: 'orchestrator', to: 'manajer' }).event).toMatchObject({ from: 'manager', to: 'manager' });
  });

  it('Office.handleEvent tidak melempar untuk nama-nama itu (riwayat dan animasi)', () => {
    for (const instant of [true, false]) {
      const o = new Office();
      let id = 1;
      for (const name of PROTO_NAMES) {
        for (const [type, from, to] of [['assign', 'manager', name], ['working', name, 'manager'], ['blocked', name, 'manager'], ['done', name, 'manager'], ['report', name, 'manager'], ['assign', name, 'manager']]) {
          const e = { ...normalizeEvent({ type, from, to, message: 'uji' }).event, id: id++ };
          expect(() => o.handleEvent(JSON.parse(JSON.stringify(e)), { instant }), `${type} ${from}→${to} instant=${instant}`).not.toThrow();
        }
      }
      expect(() => {
        for (let i = 0; i < 60 * 20; i++) o.update(1 / 60);
      }).not.toThrow();
      for (const name of PROTO_NAMES) expect(o.workers.get(name)?.name, name).toBe(name);
      if (instant) expect(o.workers.get('constructor').status).toBe('done');
    }
  });
});

// ------------------------------------------------------------- I4: karakter kontrol dan bidi dibuang
describe('I4: karakter kontrol, bidi, dan LRM/RLM dibuang dari nama dan pesan', () => {
  it('pesan: C0/C1, ESC, DEL, bidi (RLO/PDF/LRI/PDI/ALM), LRM/RLM dibuang; baris baru/tab/VT jadi spasi', () => {
    // "c\u001bd": ESC + satu byte 0x30-0x7E adalah urutan Fp/Fe/Fs, dibuang UTUH (ESC dan "d"); "\u009bg"
    // adalah CSI 8-bit dengan byte akhir "g", juga dibuang utuh (putaran 4). Urutan ANSI lain (CSI
    // "ESC[31m", OSC "ESC]…BEL") juga dibuang utuh: lihat test Q1 di bawah.
    const msg = 'a\u0000b\u0007c\u001bd\u007fe\u0085f\u009bg \u202eterbalik\u202c \u2066iso\u2069 \u200ftanda\u200e\r\nbaris2\tTAB\u000bVT\u061cX\u2028Y';
    const r = normalizeEvent({ type: 'done', from: 'dev-qa\u202e', to: '\u2066manager\u2069', message: msg });
    expect(r.ok).toBe(true);
    expect(r.event.message).toBe('abcef terbalik iso tanda baris2 TAB VTX Y');
    expect([r.event.from, r.event.to]).toEqual(['dev-qa', 'manager']);
    const forbidden = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
    expect(forbidden.test(r.event.message + r.event.from + r.event.to)).toBe(false);
  });

  it('Q1: urutan ANSI CSI/OSC dibuang utuh (tanpa sisa "[31m" / "]0;…"), ESC + satu byte 0x30-0x7E (Fp/Fe/Fs) juga utuh', () => {
    const E = '\u001b';
    const ST = `${E}${String.fromCharCode(92)}`; // ESC \ (string terminator)
    for (const [msg, want] of [
      [`a ${E}[1mtebal${E}[0m b`, 'a tebal b'],
      [`gagal: ${E}[31mmerah${E}[39m`, 'gagal: merah'],
      [`x${E}[38;5;196my`, 'xy'], // 256 warna
      [`${E}[?25l${E}[2K${E}[1;31;4mmerah${E}[m`, 'merah'], // parameter privat, tanpa parameter
      [`${E}]0;judul jendela\u0007teks`, 'teks'], // OSC diakhiri BEL
      [`${E}]8;;https://x.example${ST}tautan${E}]8;;${ST}`, 'tautan'], // hyperlink OSC 8 diakhiri ST
      ['c\u001bd', 'c'], // ESC d (Fs) dibuang bersama byte "d"
    ]) {
      const r = normalizeEvent({ type: 'done', from: 'a', to: 'b', message: msg });
      expect(r.event.message, JSON.stringify(msg)).toBe(want);
      expect(r.event.message).not.toMatch(/\[\d|\]\d/);
    }
  });

  it('baris baru tidak bisa menyisipkan baris log palsu', () => {
    const r = normalizeEvent({ type: 'done', from: 'a', to: 'b', message: 'ok\n[event] palsu manager → ceo\r\n\r\nlagi' });
    expect(r.event.message).toBe('ok [event] palsu manager → ceo lagi');
    expect(r.event.message).not.toMatch(/[\r\n]/);
  });

  it.each([
    ['hanya RLO', '\u202e\u202e'],
    ['hanya LRM', '\u200e'],
    ['hanya RLM + LRI/PDI', '\u200f\u2066\u2069'],
    ['hanya karakter kontrol', '\u0000\u001b\u007f'],
  ])('nama yang %s ditolak sebagai kosong', (_label, name) => {
    expect(normalizeEvent({ type: 'done', from: name, to: 'b' })).toMatchObject({ ok: false, error: '"from" tidak boleh kosong' });
    expect(normalizeEvent({ type: 'done', from: 'a', to: name })).toMatchObject({ ok: false, error: '"to" tidak boleh kosong' });
  });

  it('pesan yang hanya berisi bidi menjadi kosong (event tetap sah)', () => {
    expect(normalizeEvent({ type: 'done', from: 'a', to: 'b', message: '\u202e\u202e' }).event.message).toBe('');
  });

  it('stripControl tidak menyentuh teks biasa, emoji, dan aksara lain', () => {
    const text = 'Halo dunia — 9/9 test lulus ✓ 日本語 العربية';
    expect(stripControl(text)).toBe(text);
  });

  it('kotak perintah (parseCommand) ikut dibersihkan', () => {
    const r = parseCommand('@dev-qa uji\u202e terbalik\u0007');
    expect(r.ok).toBe(true);
    expect(r.events[0].message).toBe('uji terbalik');
  });
});
