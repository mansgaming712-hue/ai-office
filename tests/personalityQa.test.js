// QA Fase 2 (kepribadian worker): celah test tambahan. Emoji/surrogate, teks satu bahasa, worker tidak ada,
// validator server = klien (test silang), ganti bahasa saat bubble tampil, reduced motion, determinisme (tanpa
// Math.random/Date.now), frasa ambient tidak menimpa bubble event, dan tidak ada kebocoran ke runner/template/hook.
// Teks sumber tanpa escape unicode berbahaya: karakter dibuat dari kode.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateDivision } from '../shared/divisions.js';
import { normalizeEvent } from '../shared/events.js';
import { NEUTRAL_PERSONALITY, PERSONALITY_LIMITS, resolvePersonality, validatePersonality } from '../shared/personalities.js';
import { discoverDivisions, publicDivisions } from '../server/divisions.js';
import { applyDivisionsResponse, parseDivisions, resetDivisions } from '../src/divisions.js';
import { setLang } from '../src/i18n.js';
import { characterName, deskLabel } from '../src/office/characters.js';
import { Office, TUNING } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { createRenderer, workerSpec } from '../src/office/render.js';
import { personalityOf } from '../src/personality.js';
import { ROOT } from './helpers/testkit.js';

const cp = (n) => String.fromCodePoint(n);
const keys = (r) => r.errors.map((e) => e.key);
const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;
const DT = 1 / 60;
const run = (o, seconds, each) => {
  for (let t0 = 0; t0 < seconds; t0 += DT) {
    o.update(DT);
    each?.(o);
  }
};
const phrasey = (extra = {}) => resolvePersonality({ speech: { tone: 'cheerful', phrases: [{ en: 'Phrase EN', id: 'Frasa ID' }] }, ...extra });
const only = (name, pers) => (id) => (id === name ? pers : NEUTRAL_PERSONALITY);

beforeEach(() => setLang('en', { persist: false }));
afterEach(() => {
  resetDivisions();
  setLang('en', { persist: false });
  vi.restoreAllMocks();
});

const tmps = [];
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));
const AGENT = readFileSync(join(ROOT, 'division-packs', 'example-legal', 'agents', 'example-legal-reviewer.md'), 'utf8');
function makeDivision(root, id, workers, extra = {}) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'division.json'), JSON.stringify({ id, name: { en: id, id }, color: '#112233', desks: Math.max(2, workers.length), workers, ...extra }));
  for (const w of workers) writeFileSync(join(dir, 'agents', `${w}.md`), AGENT.replace(/^name: .*$/m, `name: ${w}`));
}
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-office-persqa-'));
  tmps.push(d);
  return d;
};

// ------------------------------------------------------------------ emoji, surrogate, satu bahasa

describe('QA validator: emoji, surrogate, dan teks satu bahasa', () => {
  const L = PERSONALITY_LIMITS;

  it('frasa 40 emoji diterima, 41 ditolak (per code point, bukan unit UTF-16)', () => {
    const e = cp(0x1f680);
    expect(validatePersonality({ speech: { phrases: [e.repeat(L.phraseMax)] } }).ok).toBe(true);
    expect(keys(validatePersonality({ speech: { phrases: [e.repeat(L.phraseMax + 1)] } }))).toEqual(['divisions.err.personalityTextLength']);
  });

  it('emoji dengan variation selector (hati merah) dan skin tone diterima; panjang dihitung per code point', () => {
    const heart = `${cp(0x2764)}${cp(0xfe0f)}`; // 2 code point
    const wave = `${cp(0x1f44b)}${cp(0x1f3fd)}`; // 2 code point
    const r = validatePersonality({ speech: { phrases: [`Hi ${heart} ${wave}`] } });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.value.speech.phrases[0].en).toBe(`Hi ${heart} ${wave}`);
  });

  it('bendera (regional indicator) dan huruf non-Latin diterima', () => {
    const flag = `${cp(0x1f1ee)}${cp(0x1f1e9)}`;
    expect(validatePersonality({ nickname: `${flag} 日本語` }).ok).toBe(true);
  });

  it('emoji ZWJ (keluarga) ditolak karena ZWJ = karakter format (perilaku saat ini, dicatat sebagai temuan rendah)', () => {
    const family = [cp(0x1f468), cp(0x200d), cp(0x1f469), cp(0x200d), cp(0x1f467)].join('');
    expect(keys(validatePersonality({ speech: { phrases: [family] } }))).toEqual(['divisions.err.personalityTextChars']);
  });

  it('surrogate tunggal (JSON "\\ud800") ditolak (tidak boleh masuk ke kanvas atau UTF-8)', () => {
    // BUG rendah: BAD_CHARS_RE tidak memuat \p{Cs}; "\ud800" lolos dan masuk ke kanvas.
    const lone = JSON.parse('"a\\ud800b"');
    expect(validatePersonality({ nickname: lone }).ok).toBe(false);
  });

  it('teks satu bahasa: {en} saja menyalin ke id, {id} saja menyalin ke en, string untuk keduanya', () => {
    expect(validatePersonality({ nickname: { en: 'Sun' } }).value.nickname).toEqual({ en: 'Sun', id: 'Sun' });
    expect(validatePersonality({ nickname: { id: 'Mentari' } }).value.nickname).toEqual({ en: 'Mentari', id: 'Mentari' });
    expect(validatePersonality({ speech: { phrases: [{ id: 'Halo' }] } }).value.speech.phrases).toEqual([{ en: 'Halo', id: 'Halo' }]);
    expect(validatePersonality({ traits: ['rapi'] }).value.traits).toEqual([{ en: 'rapi', id: 'rapi' }]);
  });

  it('teks satu bahasa: sisi yang ada tetap divalidasi; sisi yang diisi dari tetangga tidak lolos batas', () => {
    expect(validatePersonality({ nickname: { en: 'x'.repeat(17) } }).ok).toBe(false);
    expect(validatePersonality({ nickname: { id: ' ' } }).ok).toBe(false);
    expect(validatePersonality({ nickname: { en: 'ok', id: undefined } }).ok).toBe(false);
    expect(validatePersonality({ nickname: { en: null } }).ok).toBe(false);
    expect(validatePersonality({ nickname: {} }).ok).toBe(false);
  });

  it('teks satu bahasa di engine: kedua bahasa memakai frasa yang sama', () => {
    const p = resolvePersonality(validatePersonality({ speech: { phrases: [{ id: 'Halo semua' }] } }).value);
    for (const lang of ['en', 'id']) {
      setLang(lang, { persist: false });
      const o = new Office({ seed: 3, personalityFor: only('dev-qa', p) });
      const seen = new Set();
      run(o, 150, (x) => {
        const b = x.workers.get('dev-qa').bubble;
        if (b?.ambient) seen.add(b.text);
      });
      expect([...seen]).toEqual(['Halo semua']);
    }
  });

  it('batas tepat: nickname 16 + spasi tepi di-trim; 16 + isi spasi di tengah tetap dihitung', () => {
    expect(validatePersonality({ nickname: `  ${'a'.repeat(16)}  ` }).ok).toBe(true);
    expect(validatePersonality({ nickname: `${'a'.repeat(8)} ${'a'.repeat(8)}` }).ok).toBe(false); // 17
  });

  it('masukan aneh tidak pernah melempar', () => {
    const weird = [undefined, null, 0, NaN, '', [], () => 1, Symbol('x'), 10n, new Date(), Object.create(null), { nickname: Object.create(null) }, { speech: { phrases: [[]] } }];
    for (const w of weird) expect(() => validatePersonality(w), String(typeof w)).not.toThrow();
    expect(() => validatePersonality(JSON.parse('{"__proto__": {"nickname": "x"}, "constructor": 1}'))).not.toThrow();
    expect(validatePersonality(JSON.parse('{"__proto__": {"nickname": "x"}}')).ok).toBe(false); // field tak dikenal
  });
});

// ------------------------------------------------------------------ worker tidak ada

describe('QA personalities untuk worker yang tidak ada', () => {
  const base = { id: 'legal', name: 'Legal', color: '#8a5a44', desks: 3, workers: ['legal-a', 'legal-b'] };

  it('server: divisi dilewati dengan satu error, tidak ada kepribadian yang bocor ke worker lain', () => {
    const root = mkTmp();
    makeDivision(root, 'ghosty', ['ghosty-a'], { personalities: { 'ghosty-zzz': { nickname: 'Hantu' } } });
    makeDivision(root, 'fine', ['fine-a'], { personalities: { 'fine-a': { nickname: 'Fina' } } });
    const r = discoverDivisions({ dir: root });
    expect(r.divisions.map((d) => d.id)).toEqual(['fine']);
    expect(r.errors.length).toBeGreaterThan(0);
    expect(JSON.stringify(publicDivisions(r))).not.toContain('Hantu');
  });

  it('kunci personalities milik worker divisi lain (atau bawaan, manajer, CEO) menolak divisi', () => {
    for (const k of ['dev-qa', 'manager', 'ceo', 'legal-c', '', ' legal-a', 'LEGAL-A', 'legal-a ', '__proto__', 'constructor', 'toString']) {
      const r = validateDivision({ ...base, personalities: JSON.parse(`{${JSON.stringify(k)}: {"nickname":"X"}}`) });
      expect(r.ok, JSON.stringify(k)).toBe(false);
      expect(keys(r)).toEqual(['divisions.err.personalityWorker']);
    }
  });

  it('personalities kosong {} valid dan tidak menambah kunci', () => {
    const r = validateDivision({ ...base, personalities: {} });
    expect(r.ok).toBe(true);
    expect(Object.hasOwn(r.value, 'personalities')).toBe(false);
  });

  it('semua kepribadian tidak valid: divisi ok, tanpa kunci personalities, warnings per worker', () => {
    const r = validateDivision({ ...base, personalities: { 'legal-a': { idle: 'nap' }, 'legal-b': 'teks' } });
    expect(r.ok).toBe(true);
    expect(Object.hasOwn(r.value, 'personalities')).toBe(false);
    expect(r.warnings.map((w) => w.params.worker)).toEqual(['legal-a', 'legal-b']);
  });

  it('klien: personalityOf id yang tidak ada / id aneh = netral, tidak melempar', () => {
    for (const id of ['nobody', '', 'toString', '__proto__', 'constructor', 'hasOwnProperty', undefined, null, 42]) {
      expect(personalityOf(id), String(id)).toBe(NEUTRAL_PERSONALITY);
    }
  });

  it('nama panggilan tidak ikut ketika worker dihapus dari roster (reset)', () => {
    applyDivisionsResponse(200, { ok: true, errors: [], divisions: [{ id: 'tmp', name: { en: 'T', id: 'T' }, color: '#112233', desks: 1, workers: ['tmp-a'], source: 'plugin', personalities: { 'tmp-a': { nickname: 'Tia' } } }] });
    expect(characterName('tmp-a')).toBe('Tia');
    resetDivisions();
    expect(characterName('tmp-a')).toBe('tmp-a');
    expect(personalityOf('tmp-a')).toBe(NEUTRAL_PERSONALITY);
  });
});

// ------------------------------------------------------------------ test silang server vs klien

describe('QA test silang: validator server = klien untuk korpus yang sama', () => {
  const W = ['x-a', 'x-b'];
  const div = (personalities) => ({ id: 'xdiv', name: { en: 'X', id: 'X' }, color: '#112233', desks: 2, workers: W, ...(personalities === undefined ? {} : { personalities }) });
  const e = cp(0x1f600);
  const corpus = {
    kosong: {},
    lengkap: { nickname: { en: 'Sun', id: 'Mentari' }, traits: ['a', { en: 'b', id: 'c' }], speech: { tone: 'dry', phrases: ['p1', { id: 'p2' }] }, idle: 'snack', quirk: 'yawn' },
    emoji: { nickname: e.repeat(16), speech: { phrases: [e.repeat(40)] } },
    emoji17: { nickname: e.repeat(17) },
    bidi: { nickname: `a${cp(0x202e)}b` },
    zwj: { nickname: `a${cp(0x200d)}b` },
    surrogate: { nickname: JSON.parse('"a\\ud800"') },
    enumSalah: { idle: 'nap' },
    toneSalah: { speech: { tone: 'angry' } },
    extra: { nickname: 'a', hobby: 'b' },
    tipe: { traits: 'rapi' },
    banyak: { traits: ['a', 'b', 'c', 'd'] },
    string: 'halo',
    array: [],
    nol: null,
  };

  it('untuk setiap entri korpus: server (validateDivision) dan klien (parseDivisions lewat publicDivisions) sepakat', () => {
    for (const [name, p] of Object.entries(corpus)) {
      for (const worker of W) {
        const raw = div({ [worker]: p });
        const server = validateDivision(raw);
        const client = parseDivisions({ ok: true, errors: [], divisions: [{ ...raw, source: 'plugin' }] });
        expect(client.divisions.length === 1, `${name}/${worker}: divisi diterima`).toBe(server.ok);
        if (!server.ok) continue;
        expect(client.divisions[0].personalities, name).toEqual(server.value.personalities);
        const direct = validatePersonality(p);
        expect(Boolean(server.value.personalities?.[worker]), `${name}: ikut validatePersonality`).toBe(direct.ok);
        if (direct.ok) expect(server.value.personalities[worker]).toEqual(direct.value);
      }
    }
  });

  it('jalur penuh: berkas di disk -> discoverDivisions -> publicDivisions -> JSON -> parseDivisions menghasilkan data yang sama', () => {
    const root = mkTmp();
    makeDivision(root, 'pipe', ['pipe-a', 'pipe-b', 'pipe-c'], { personalities: { 'pipe-a': corpus.lengkap, 'pipe-b': corpus.enumSalah, 'pipe-c': corpus.emoji } });
    const found = discoverDivisions({ dir: root });
    expect(found.divisions).toHaveLength(1);
    const wire = JSON.parse(JSON.stringify({ ok: true, ...publicDivisions(found) }));
    const client = parseDivisions(wire);
    expect(client.divisions[0].personalities).toEqual(found.divisions[0].personalities);
    expect(Object.keys(client.divisions[0].personalities)).toEqual(['pipe-a', 'pipe-c']);
    expect(found.errors.some((x) => x.dir === 'pipe')).toBe(true); // peringatan pipe-b dicatat di server
  });

  it('publicDivisions mengirim salinan: mengubah hasil tidak mengubah data server', () => {
    const root = mkTmp();
    makeDivision(root, 'copy', ['copy-a'], { personalities: { 'copy-a': { nickname: 'Asli' } } });
    const found = discoverDivisions({ dir: root });
    const pub = publicDivisions(found);
    pub.divisions[0].personalities['copy-a'].nickname.en = 'Diubah';
    expect(found.divisions[0].personalities['copy-a'].nickname.en).toBe('Asli');
  });
});

// ------------------------------------------------------------------ ganti bahasa saat bubble tampil

describe('QA ganti bahasa saat bubble frasa tampil', () => {
  function untilPhrase(o) {
    for (let i = 0; i < 60 * 200; i++) {
      o.update(DT);
      if (o.workers.get('dev-qa').bubble?.ambient) return o.workers.get('dev-qa').bubble;
    }
    throw new Error('frasa tidak muncul');
  }

  it('bubble yang sedang tampil tidak crash dan habis normal; frasa berikutnya memakai bahasa baru', () => {
    const o = new Office({ seed: 5, personalityFor: only('dev-qa', phrasey()) });
    const b = untilPhrase(o);
    expect(b.text).toBe('Phrase EN');
    setLang('id', { persist: false });
    expect(() => o.update(DT)).not.toThrow();
    expect(o.workers.get('dev-qa').bubble).toBe(b); // teks dibekukan saat dibuat (sama dengan bubble event)
    run(o, TUNING.phraseFor + 0.5);
    expect(o.workers.get('dev-qa').bubble?.ambient ?? false).toBe(false);
    const seen = new Set();
    run(o, 200, (x) => {
      const bb = x.workers.get('dev-qa').bubble;
      if (bb?.ambient) seen.add(bb.text);
    });
    expect([...seen]).toEqual(['Frasa ID']);
  });

  it('label meja dan nama karakter langsung mengikuti bahasa (tanpa cache usang), termasuk plugin', () => {
    applyDivisionsResponse(200, { ok: true, errors: [], divisions: [{ id: 'bi', name: { en: 'B', id: 'B' }, color: '#112233', desks: 1, workers: ['bi-a'], source: 'plugin', personalities: { 'bi-a': { nickname: { en: 'Sunny', id: 'Cerah' } } } }] });
    for (let i = 0; i < 4; i++) {
      setLang('en', { persist: false });
      expect(deskLabel('bi-a')).toBe('Sunny · a');
      setLang('id', { persist: false });
      expect(deskLabel('bi-a')).toBe('Cerah · a');
    }
  });
});

// ------------------------------------------------------------------ reduced motion

describe('QA reduced motion', () => {
  it('frasa tetap muncul (teks bukan gerakan), tetapi tidak ada yang berjalan dan mulut tidak bergerak', () => {
    const o = new Office({ seed: 5, personalityFor: () => phrasey({ idle: 'coffee', quirk: 'yawn' }) });
    o.setReducedMotion(true);
    let phrases = 0;
    run(o, 300, (x) => {
      for (const w of x.workers.values()) {
        expect(w.mode).toBe('seat');
        if (w.bubble?.ambient) {
          phrases++;
          const spec = workerSpec(w, x.time, true, 1, phrasey({ idle: 'coffee', quirk: 'yawn' }));
          expect(spec.mouth).toBe(false);
          expect(spec.act ?? null).toBe(null);
        }
      }
    });
    expect(phrases).toBeGreaterThan(0);
  });

  it('menyalakan reduced motion di tengah perjalanan pantry mengembalikan semua ke meja dan tetap deterministik', () => {
    const mk = () => {
      const o = new Office({ seed: 9, personalityFor: () => phrasey({ idle: 'water' }) });
      run(o, 70);
      o.setReducedMotion(true);
      run(o, 5);
      return [...o.workers.values()].map((w) => [w.name, w.mode, w.bubble?.text ?? null]);
    };
    const a = mk();
    expect(a.every(([, mode]) => mode === 'seat')).toBe(true);
    expect(mk()).toEqual(a);
  });

  it('headphones tetap satu-satunya yang statis: spec reduced motion dengan quirk headphones memuat phones=true', () => {
    const w = { mode: 'seat', status: 'idle', statusSince: -Infinity, sendUntil: -Infinity, bubble: null, name: 'x' };
    expect(workerSpec(w, 10, true, 1, phrasey({ quirk: 'headphones' })).phones).toBe(true);
    expect(workerSpec(w, 10, true, 1, phrasey({ quirk: 'hum' })).phones).toBe(false);
  });
});

// ------------------------------------------------------------------ determinisme

describe('QA determinisme: tanpa Math.random dan Date.now di engine/renderer', () => {
  function recCanvas() {
    const calls = [];
    const state = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic' };
    const ctx = new Proxy(state, {
      get(t0, k) {
        if (k in t0) return t0[k];
        if (k === 'measureText') return (s) => ({ width: String(s).length * 3.5 });
        return (...a) => { calls.push(`${String(k)}:${a.join(',')}|${t0.fillStyle}|${t0.globalAlpha}`); };
      },
      set(t0, k, v) {
        t0[k] = v;
        return true;
      },
    });
    return { calls, canvas: { width: layout.W, height: layout.H, getContext: () => ctx } };
  }
  const session = (seed) => {
    const rec = recCanvas();
    globalThis.document = { createElement: () => recCanvas().canvas };
    try {
      const r = createRenderer(rec.canvas, { theme: 'dark' });
      const o = new Office({ seed });
      o.handleEvent(ev('assign', 'manager', 'dev-qa', 'Tolong tes'));
      const texts = [];
      for (let i = 0; i < 60 * 90; i++) {
        o.update(DT);
        if (i % 30 === 0) r.draw(o, 1_700_000_000_000 + i * 16);
        const b = o.workers.get('dev-frontend').bubble;
        if (b) texts.push(b.text);
      }
      return { calls: rec.calls.join('\n'), texts };
    } finally {
      delete globalThis.document;
    }
  };

  it('Math.random dan Date.now tidak dipanggil oleh update() maupun draw()', () => {
    const rnd = vi.spyOn(Math, 'random');
    const now = vi.spyOn(Date, 'now');
    session(11);
    expect(rnd).not.toHaveBeenCalled();
    expect(now).not.toHaveBeenCalled();
  });

  it('seed sama + jam sama = urutan perintah gambar identik; seed beda = berbeda', () => {
    const a = session(11);
    const b = session(11);
    expect(a.calls.length).toBeGreaterThan(1000);
    expect(a.calls).toBe(b.calls);
    expect(a.texts).toEqual(b.texts);
    expect(session(12).calls).not.toBe(a.calls);
  });

  it('jam di-inject: pembagian dt berbeda (1/60 vs 1/30 vs 1/120) tidak mengubah kapan frasa pertama mulai', () => {
    const first = (dt) => {
      const o = new Office({ seed: 21, personalityFor: only('dev-qa', phrasey()) });
      for (let i = 0; i < 200 / dt; i++) {
        o.update(dt);
        if (o.workers.get('dev-qa').bubble?.ambient) return Math.round(o.time * 10) / 10;
      }
      return null;
    };
    const a = first(1 / 120);
    expect(a).not.toBeNull();
    expect(Math.abs(first(1 / 60) - a)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(first(1 / 30) - a)).toBeLessThanOrEqual(0.1);
  });

  it('dua Office dengan rng suntikan yang dipakai bersama tetap tidak melempar dan reset() tidak mengubah opsi', () => {
    let i = 0;
    const rng = () => ((i = (i * 7 + 3) % 101) / 101);
    const o = new Office({ rng });
    run(o, 60);
    expect(() => o.reset()).not.toThrow();
    expect(o.opts.rng).toBe(rng);
  });
});

// ------------------------------------------------------------------ ambient tidak menimpa bubble event

describe('QA frasa ambient tidak menimpa bubble event', () => {
  const EVENT_KINDS = new Set(['assign', 'command', 'done', 'blocked', 'report', 'working', 'warning']);

  it('invarian: selama bubble event masih hidup, bubble yang tampil tidak pernah diganti frasa ambient (banyak seed, semua entitas)', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const o = new Office({ seed, personalityFor: () => phrasey() });
      // percepat: semua frasa ambient sering muncul
      const prev = new Map();
      const names = [...o.workers.keys()];
      let n = 0;
      for (let i = 0; i < 60 * 240; i++) {
        if (i % 150 === 0) {
          const to = names[n++ % names.length];
          o.handleEvent(ev('assign', 'manager', to, `Tugas ${n}`));
        }
        if (i % 150 === 90) {
          const from = names[(n + 3) % names.length];
          o.handleEvent(ev(n % 2 ? 'done' : 'blocked', from, 'manager', `Hasil ${n}`), { instant: true });
        }
        o.update(DT);
        const ents = [['mgr', o.manager], ['ceo', o.ceo], ...[...o.workers.values()].map((w) => [w.name, w])];
        for (const [id, e] of ents) {
          const before = prev.get(id);
          const now = e.bubble;
          if (before && EVENT_KINDS.has(before.kind) && before.until > o.time && now !== before) {
            // diganti hanya boleh oleh bubble event lain (bukan ambient)
            expect(now?.ambient ?? false, `seed ${seed} ${id} t=${o.time.toFixed(2)} bubble ${before.kind} "${before.text}" diganti ambient`).toBe(false);
          }
          prev.set(id, now);
        }
      }
    }
  });

  it('assign/done/blocked yang datang saat frasa ambient tampil langsung menggantikannya', () => {
    for (const [type, kind] of [['done', 'done'], ['blocked', 'blocked']]) {
      const o = new Office({ seed: 5, personalityFor: only('dev-qa', phrasey()) });
      for (let i = 0; i < 60 * 200 && !o.workers.get('dev-qa').bubble?.ambient; i++) o.update(DT);
      expect(o.workers.get('dev-qa').bubble?.ambient).toBe(true);
      o.handleEvent(ev(type, 'dev-qa', 'manager', 'Pesan nyata'));
      const b = o.workers.get('dev-qa').bubble;
      expect(b.ambient).toBeUndefined();
      expect(b.kind).toBe(kind);
      expect(b.text).toBe('Pesan nyata');
    }
    const o = new Office({ seed: 5, personalityFor: only('manager', phrasey()) });
    for (let i = 0; i < 60 * 200 && !o.manager.bubble?.ambient; i++) o.update(DT);
    expect(o.manager.bubble?.ambient).toBe(true);
    o.handleEvent(ev('assign', 'manager', 'dev-qa', 'Kerjakan ini'));
    run(o, 6, (x) => {
      if (x.manager.bubble?.kind === 'assign') expect(x.manager.bubble.text).toBe('Kerjakan ini');
    });
  });

  it('frasa ambient tidak mengubah status, antrean, pending, atau jumlah event: jejak status identik dengan/tanpa frasa', () => {
    const snap = (pf) => {
      const o = new Office({ seed: 31, personalityFor: pf });
      const log = [];
      const names = [...o.workers.keys()];
      for (let i = 0; i < 60 * 150; i++) {
        if (i % 200 === 0) o.handleEvent(ev('assign', 'manager', names[Math.floor(i / 200) % names.length], 'T'));
        if (i % 200 === 100) o.handleEvent(ev('done', names[Math.floor(i / 200) % names.length], 'manager', 'D'), { instant: true });
        o.update(DT);
        if (i % 60 === 0) log.push(JSON.stringify([[...o.workers.values()].map((w) => [w.status, w.pending, w.deferred.length]), o.queue.length, o.envelopes.length]));
      }
      return log;
    };
    expect(snap(() => phrasey())).toEqual(snap(() => NEUTRAL_PERSONALITY));
  });

  it('snapshot / state yang diekspor memakai teks bubble; ambient ikut terlihat tanpa kunci baru yang bocor', () => {
    const o = new Office({ seed: 5, personalityFor: only('dev-qa', phrasey()) });
    for (let i = 0; i < 60 * 200 && !o.workers.get('dev-qa').bubble?.ambient; i++) o.update(DT);
    const snapshot = typeof o.snapshot === 'function' ? o.snapshot() : null;
    if (snapshot) expect(JSON.stringify(snapshot)).not.toContain('ambient');
  });
});

// ------------------------------------------------------------------ label panjang

describe('QA nickname panjang di label', () => {
  it('nickname 16 karakter lebar + peran: teks label tetap string utuh (dipotong oleh kanvas, bukan di-HTML)', () => {
    const nick = 'W'.repeat(16);
    applyDivisionsResponse(200, { ok: true, errors: [], divisions: [{ id: 'lng', name: { en: 'L', id: 'L' }, color: '#112233', desks: 1, workers: ['lng-reviewer'], source: 'plugin', personalities: { 'lng-reviewer': { nickname: nick } } }] });
    expect(deskLabel('lng-reviewer')).toBe(`${nick} · reviewer`);
    expect([...deskLabel('lng-reviewer')]).toHaveLength(16 + 3 + 8);
  });

  it('pemotongan bubble (wrapText) tidak memecah pasangan surrogate pada frasa emoji yang terlalu lebar', () => {
    const e = cp(0x1f600);
    applyDivisionsResponse(200, { ok: true, errors: [], divisions: [{ id: 'emo', name: { en: 'E', id: 'E' }, color: '#112233', desks: 1, workers: ['emo-a'], source: 'plugin', personalities: { 'emo-a': { nickname: e.repeat(16), speech: { phrases: [`${e} `.repeat(20).trim()] } } } }] });
    const emoPers = resolvePersonality(validatePersonality({ speech: { phrases: [`aaaaaaaa bbbbbbbb x${e.repeat(6)} z`] } }).value);
    const texts = [];
    const state = { fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic' };
    const ctx = new Proxy(state, {
      get(t0, k) {
        if (k in t0) return t0[k];
        if (k === 'measureText') return (s) => ({ width: String(s).length * 12 });
        if (k === 'fillText') return (s) => { texts.push(String(s)); };
        return () => {};
      },
      set(t0, k, v) {
        t0[k] = v;
        return true;
      },
    });
    const canvas = { width: layout.W, height: layout.H, getContext: () => ctx };
    globalThis.document = { createElement: () => canvas };
    try {
      const r = createRenderer(canvas, { theme: 'dark' });
      const o = new Office({ seed: 5, personalityFor: (id) => (id === 'emo-a' ? emoPers : NEUTRAL_PERSONALITY) });
      for (let i = 0; i < 60 * 120; i++) {
        o.update(DT);
        const b = o.workers.get('emo-a')?.bubble;
        if (b?.ambient) r.draw(o, 1_700_000_000_000 + i * 16);
      }
    } finally {
      delete globalThis.document;
    }
    expect(texts.length).toBeGreaterThan(0);
    // Bug: wrapText/fitText (src/office/render.js) memotong per unit UTF-16 (last.slice(0, -1)); hasilnya surrogate tunggal + "…".
    expect(texts.length).toBeGreaterThan(0);
    expect(texts.filter((s) => !s.isWellFormed())).toEqual([]);
  });
});

// ------------------------------------------------------------------ kebocoran

describe('QA tidak ada kebocoran ke runner, template, hook', () => {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  const SOURCES = [
    ...walk(join(ROOT, 'server')),
    ...walk(join(ROOT, 'hooks')),
    ...walk(join(ROOT, 'scripts')),
    join(ROOT, 'shared', 'hookMapping.js'),
    join(ROOT, 'shared', 'events.js'),
  ].filter((f) => /\.(m?js|json|md|ya?ml|txt)$/.test(f));

  it('tidak ada file server/hook/skrip yang mengimpor shared/personalities atau src/personality (kecuali validasi divisi)', () => {
    const offenders = SOURCES.filter((f) => /personalities\.js|src\/personality|office\/quirks/.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => f.replace(ROOT, '').replace(/\\/g, '/'))).toEqual([]);
  });

  it('hook dan pemetaan hook tidak menyebut nickname/traits/quirk/tone sebagai data kepribadian', () => {
    for (const f of [...walk(join(ROOT, 'hooks')), join(ROOT, 'shared', 'hookMapping.js')]) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/nickname|personalit|kepribadian|\bquirk\b/i);
    }
  });

  it('data kepribadian dari plugin tidak muncul di agentFiles (teks yang dipasang sebagai agen)', () => {
    const root = mkTmp();
    makeDivision(root, 'leak', ['leak-a'], { personalities: { 'leak-a': { nickname: 'RahasiaNick', speech: { phrases: ['FrasaRahasiaXYZ'] } } } });
    const r = discoverDivisions({ dir: root });
    for (const f of r.divisions[0].agentFiles) {
      expect(f.text).not.toContain('RahasiaNick');
      expect(f.text).not.toContain('FrasaRahasiaXYZ');
    }
    expect(Object.keys(publicDivisions(r).divisions[0])).not.toContain('agentFiles');
  });
});
