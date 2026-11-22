// Kepribadian worker (Fase 2): validator, default bawaan, divisi plugin (server dan klien sepakat), netral tanpa data,
// dan semua enum idle/quirk benar-benar punya animasi. Teks sumber tanpa escape unicode: karakter berbahaya dibuat dari kode.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { validateDivision } from '../shared/divisions.js';
import {
  DEFAULT_PERSONALITIES, IDLE_KINDS, NEUTRAL_PERSONALITY, PERSONALITY_LIMITS, QUIRKS as QUIRK_NAMES, TONES,
  localized, resolvePersonality, validatePersonality,
} from '../shared/personalities.js';
import { AGENT_NAMES, CEO_ID, MANAGER_ID } from '../shared/roster.js';
import { discoverDivisions, publicDivisions } from '../server/divisions.js';
import { applyDivisionsResponse, getState, parseDivisions, resetDivisions } from '../src/divisions.js';
import { dictionaries, setLang } from '../src/i18n.js';
import { characterName, deskLabel } from '../src/office/characters.js';
import { Office } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { IDLE_BEHAVIORS, QUIRKS, QUIRK_CYCLE, quirkPhase } from '../src/office/quirks.js';
import { DESK_LABEL_MAX_W, createRenderer } from '../src/office/render.js';
import { buildGrid } from '../src/office/sprites.js';
import { nicknameOf, personalityOf, speechLines } from '../src/personality.js';
import { ROOT, http, startApp } from './helpers/testkit.js';

const ch = (code) => String.fromCharCode(code);
const keys = (r) => r.errors.map((e) => e.key);
const catalog = (lang) => JSON.parse(readFileSync(join(ROOT, 'locales', `${lang}.json`), 'utf8'));

afterEach(() => {
  resetDivisions();
  setLang('en', { persist: false });
});

describe('validatePersonality: valid', () => {
  it('objek kosong valid (semua field opsional)', () => {
    expect(validatePersonality({})).toEqual({ ok: true, value: {}, errors: [] });
  });

  it('contoh lengkap dari spesifikasi diterima; teks string dipakai untuk en dan id', () => {
    const r = validatePersonality({
      nickname: 'Sari',
      traits: ['teliti', { en: 'careful', id: 'cermat' }],
      speech: { tone: 'cheerful', phrases: ['Halo!', { en: 'Hi!', id: 'Hai!' }] },
      idle: 'coffee',
      quirk: 'hum',
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({
      nickname: { en: 'Sari', id: 'Sari' },
      traits: [{ en: 'teliti', id: 'teliti' }, { en: 'careful', id: 'cermat' }],
      speech: { tone: 'cheerful', phrases: [{ en: 'Halo!', id: 'Halo!' }, { en: 'Hi!', id: 'Hai!' }] },
      idle: 'coffee',
      quirk: 'hum',
    });
  });

  it('salinan bersih: mengubah hasil tidak mengubah masukan; teks di-trim; satu bahasa disalin ke yang lain', () => {
    const input = { nickname: { id: '  Dito ' } };
    const r = validatePersonality(input);
    expect(r.value.nickname).toEqual({ en: 'Dito', id: 'Dito' });
    expect(input.nickname.id).toBe('  Dito ');
  });

  it('batas tepat diterima: 16 / 20 / 40 karakter, 3 traits, 6 frasa; dihitung per code point (emoji = 1)', () => {
    const L = PERSONALITY_LIMITS;
    const emoji = String.fromCodePoint(0x1f600);
    const r = validatePersonality({
      nickname: emoji.repeat(L.nicknameMax),
      traits: ['a'.repeat(L.traitMax), emoji.repeat(L.traitMax), 'c'],
      speech: { phrases: Array.from({ length: L.phrasesMax }, (_, i) => String(i).repeat(1).padEnd(L.phraseMax, 'x')) },
    });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect([...r.value.nickname.en]).toHaveLength(16); // 16 code point walau 32 unit UTF-16
  });

  it('semua nilai enum diterima', () => {
    for (const idle of IDLE_KINDS) expect(validatePersonality({ idle }).ok, idle).toBe(true);
    for (const quirk of QUIRK_NAMES) expect(validatePersonality({ quirk }).ok, quirk).toBe(true);
    for (const tone of TONES) expect(validatePersonality({ speech: { tone } }).ok, tone).toBe(true);
  });
});

describe('validatePersonality: setiap jenis tidak valid ditolak dengan kunci kesalahan yang jelas', () => {
  const bad = (obj) => validatePersonality(obj);
  const L = PERSONALITY_LIMITS;

  it('bukan objek', () => {
    for (const v of [null, undefined, 'x', 5, [], true]) {
      const r = bad(v);
      expect(r.ok).toBe(false);
      expect(r.value).toBeNull();
      expect(keys(r)).toEqual(['divisions.err.personalityNotObject']);
    }
  });

  it('field tak dikenal (di atas dan di dalam speech) ditolak', () => {
    expect(keys(bad({ mood: 'x' }))).toEqual(['divisions.err.personalityUnknownField']);
    expect(keys(bad({ speech: { volume: 3 } }))).toEqual(['divisions.err.personalityUnknownField']);
    expect(bad({ __proto__x: 1 }).ok).toBe(false);
    expect(bad(JSON.parse('{"__proto__": {"nickname": "x"}}')).ok).toBe(false);
  });

  it('tipe teks salah, kunci bahasa tak dikenal, objek bahasa kosong', () => {
    for (const nickname of [5, null, true, [], {}, { en: 1 }, { en: 'a', id: 2 }]) {
      expect(keys(bad({ nickname })), JSON.stringify(nickname)).toEqual(['divisions.err.personalityTextType']);
    }
    expect(keys(bad({ nickname: { en: 'a', fr: 'b' } }))).toEqual(['divisions.err.personalityTextKey']);
  });

  it('teks kosong atau kelewat panjang (nickname, trait, frasa)', () => {
    expect(keys(bad({ nickname: '' }))).toEqual(['divisions.err.personalityTextLength']);
    expect(keys(bad({ nickname: '   ' }))).toEqual(['divisions.err.personalityTextLength']);
    expect(keys(bad({ nickname: 'x'.repeat(L.nicknameMax + 1) }))).toEqual(['divisions.err.personalityTextLength']);
    expect(keys(bad({ traits: ['x'.repeat(L.traitMax + 1)] }))).toEqual(['divisions.err.personalityTextLength']);
    expect(keys(bad({ speech: { phrases: ['x'.repeat(L.phraseMax + 1)] } }))).toEqual(['divisions.err.personalityTextLength']);
    expect(keys(bad({ nickname: { en: 'ok', id: 'x'.repeat(17) } }))).toEqual(['divisions.err.personalityTextLength']);
    // panjang per code point: 17 emoji = 17 karakter walau 34 unit UTF-16
    expect(bad({ nickname: String.fromCodePoint(0x1f600).repeat(17) }).ok).toBe(false);
  });

  it('karakter kontrol, bidi, dan zero-width ditolak (juga di bahasa kedua)', () => {
    const evil = [ch(7), ch(0), ch(10), ch(0x202e), ch(0x2066), ch(0x200b), ch(0x200d), ch(0xfeff), ch(0x2028), ch(0x061c), ch(0x200f)];
    for (const c of evil) {
      expect(keys(bad({ nickname: `Sa${c}ri` })), `kode ${c.charCodeAt(0).toString(16)}`).toEqual(['divisions.err.personalityTextChars']);
      expect(keys(bad({ traits: [{ en: 'ok', id: `a${c}` }] }))).toEqual(['divisions.err.personalityTextChars']);
      expect(keys(bad({ speech: { phrases: [`hai${c}`] } }))).toEqual(['divisions.err.personalityTextChars']);
    }
  });

  it('karakter tak terlihat tambahan: surrogate tunggal, pakai-pribadi, belum-ditetapkan, filler Hangul, braille kosong', () => {
    const invisible = [ch(0xd800), ch(0xdfff), ch(0xe000), ch(0xf8ff), String.fromCodePoint(0x10ffff), String.fromCodePoint(0xf0000), ch(0x0378),
      ch(0x3164), ch(0x115f), ch(0x1160), ch(0xffa0), ch(0x2800)];
    for (const c of invisible) {
      const tag = `kode ${c.codePointAt(0).toString(16)}`;
      expect(keys(bad({ nickname: `a${c}x` })), tag).toEqual(['divisions.err.personalityTextChars']);
      expect(keys(bad({ nickname: c })), tag).toEqual(['divisions.err.personalityTextChars']); // hanya karakter tak terlihat
      expect(keys(bad({ traits: [{ en: 'ok', id: `a${c}` }] })), tag).toEqual(['divisions.err.personalityTextChars']);
      expect(keys(bad({ speech: { phrases: [`hai ${c}`] } })), tag).toEqual(['divisions.err.personalityTextChars']);
    }
    expect(keys(bad({ nickname: `${ch(0xd800)}x` }))).toEqual(['divisions.err.personalityTextChars']);
  });

  it('tumpukan combining mark: 3 atau lebih berurutan ditolak; 1-2 mark (huruf beraksen) masih diterima', () => {
    const mark = ch(0x0300);
    expect(keys(bad({ nickname: `a${mark.repeat(15)}` }))).toEqual(['divisions.err.personalityTextChars']);
    expect(keys(bad({ nickname: `a${mark.repeat(3)}` }))).toEqual(['divisions.err.personalityTextChars']);
    expect(keys(bad({ speech: { phrases: [`hai${mark.repeat(5)}`] } }))).toEqual(['divisions.err.personalityTextChars']);
    expect(bad({ nickname: `e${mark}${ch(0x0301)}` }).ok).toBe(true);
    expect(bad({ nickname: `a${mark}b${mark}c${mark}` }).ok).toBe(true); // tidak berurutan
    expect(bad({ nickname: 'Rin' + ch(0x00e9) }).ok).toBe(true);
  });

  it('nama panggilan yang meniru peran atau manajer/CEO ditolak (tanpa beda huruf, setelah trim)', () => {
    const reserved = ['ceo', 'manager', 'manajer', 'boss', 'bos', 'admin', 'system', 'sistem',
      'Ratna', 'Bu Ratna', 'Ms. Ratna', 'Anton', 'Pak Anton', 'Mr. Anton'];
    for (const name of reserved) {
      for (const v of [name, name.toUpperCase(), `  ${name}  `, name.replace(' ', '   ')]) {
        expect(keys(bad({ nickname: v })), JSON.stringify(v)).toEqual(['divisions.err.personalityNickReserved']);
      }
      expect(keys(bad({ nickname: { en: 'Fine', id: name } })), name).toEqual(['divisions.err.personalityNickReserved']);
      expect(keys(bad({ nickname: { en: name, id: 'Fine' } })), name).toEqual(['divisions.err.personalityNickReserved']);
    }
    // kata yang hanya memuat kata terlarang tetap boleh (pencocokan penuh, bukan substring)
    for (const ok of ['Ceo Jr', 'Adminda', 'Antoni', 'Ratnawati', 'Boss Mini', 'Sari']) expect(bad({ nickname: ok }).ok, ok).toBe(true);
    // hanya nickname yang dibatasi
    expect(bad({ traits: ['admin'], speech: { phrases: ['manager'] } }).ok).toBe(true);
  });

  it('larangan nama panggilan tidak berlaku untuk default bawaan (builtin), tetapi berlaku di validateDivision (plugin)', () => {
    expect(validatePersonality(DEFAULT_PERSONALITIES[MANAGER_ID], { builtin: true }).ok).toBe(true);
    expect(validatePersonality(DEFAULT_PERSONALITIES[CEO_ID], { builtin: true }).ok).toBe(true);
    expect(validatePersonality(DEFAULT_PERSONALITIES[MANAGER_ID]).ok).toBe(false); // mode ketat = mode plugin
    // 17 worker bawaan tidak memakai nama terlarang, jadi lolos juga di mode ketat
    for (const id of AGENT_NAMES) expect(validatePersonality(DEFAULT_PERSONALITIES[id]).ok, id).toBe(true);
    const div = { id: 'imp', name: 'Imp', color: '#112233', desks: 2, workers: ['imp-a', 'imp-b'] };
    const r = validateDivision({ ...div, personalities: { 'imp-a': { nickname: 'CEO' }, 'imp-b': { nickname: 'Dewi', quirk: 'hum' } } });
    expect(r.ok).toBe(true); // divisi tetap dimuat
    expect(Object.keys(r.value.personalities)).toEqual(['imp-b']);
    expect(r.warnings).toEqual([{ key: 'divisions.err.personalityIgnored', params: { worker: 'imp-a', field: 'nickname', reason: 'divisions.err.personalityNickReserved' } }]);
  });

  it('server dan klien sepakat: peniru dan teks tak terlihat diabaikan di kedua sisi (nickname tak dipakai, worker tetap tampil)', () => {
    const bodyOf = (personalities) => ({
      ok: true, errors: [],
      divisions: [{ id: 'imp', name: { en: 'I', id: 'I' }, color: '#112233', desks: 3, workers: ['imp-a', 'imp-b', 'imp-c'], source: 'plugin', personalities }],
    });
    const personalities = {
      'imp-a': { nickname: 'Pak Anton', quirk: 'hum' },
      'imp-b': { nickname: `Bo${ch(0x3164)}`, quirk: 'hum' },
      'imp-c': { nickname: `Zo${ch(0x0300).repeat(4)}` },
    };
    // sisi server: validateDivision menolak ketiganya; sisi klien: parseDivisions memakai validator yang sama
    const server = validateDivision({ id: 'imp', name: 'I', color: '#112233', desks: 3, workers: ['imp-a', 'imp-b', 'imp-c'], personalities });
    const client = parseDivisions(bodyOf(personalities));
    expect(server.ok).toBe(true);
    expect(server.value.personalities).toBeUndefined();
    expect(server.warnings).toHaveLength(3);
    expect(client.divisions).toHaveLength(1);
    expect(client.divisions[0].agents).toEqual(['imp-a', 'imp-b', 'imp-c']);
    expect(client.divisions[0].personalities).toBeUndefined();
    // satu valid + satu peniru: hasil sama di kedua sisi
    const mixed = { 'imp-a': { nickname: 'Admin' }, 'imp-b': { nickname: 'Dewi' } };
    const s2 = validateDivision({ id: 'imp', name: 'I', color: '#112233', desks: 3, workers: ['imp-a', 'imp-b', 'imp-c'], personalities: mixed });
    expect(parseDivisions(bodyOf(mixed)).divisions[0].personalities).toEqual(s2.value.personalities);
    applyDivisionsResponse(200, bodyOf(mixed));
    expect(characterName('imp-a')).toBe('imp-a');
    expect(characterName('imp-b')).toBe('Dewi');
  });

  it('daftar: bukan array, terlalu banyak item', () => {
    expect(keys(bad({ traits: 'a' }))).toEqual(['divisions.err.personalityList']);
    expect(keys(bad({ speech: { phrases: 'a' } }))).toEqual(['divisions.err.personalityList']);
    expect(keys(bad({ traits: ['a', 'b', 'c', 'd'] }))).toEqual(['divisions.err.personalityCount']);
    expect(keys(bad({ speech: { phrases: Array(L.phrasesMax + 1).fill('x') } }))).toEqual(['divisions.err.personalityCount']);
  });

  it('enum tidak dikenal (tone, idle, quirk), juga bukan string', () => {
    expect(keys(bad({ speech: { tone: 'angry' } }))).toEqual(['divisions.err.personalityEnum']);
    expect(keys(bad({ idle: 'nap' }))).toEqual(['divisions.err.personalityEnum']);
    expect(keys(bad({ quirk: 'explode' }))).toEqual(['divisions.err.personalityEnum']);
    expect(keys(bad({ idle: 3 }))).toEqual(['divisions.err.personalityEnum']);
    expect(keys(bad({ quirk: ['hum'] }))).toEqual(['divisions.err.personalityEnum']);
    expect(keys(bad({ speech: 'calm' }))).toEqual(['divisions.err.personalityNotObject']);
  });

  it('parameter kesalahan tidak memuat karakter berbahaya dan dipotong pendek', () => {
    const r = bad({ [`x${ch(0x202e)}${'y'.repeat(200)}`]: 1 });
    const field = r.errors[0].params.field;
    expect(field).not.toContain(ch(0x202e));
    expect([...field].length).toBeLessThanOrEqual(40);
  });

  it('semua kunci kesalahan ada di kamus cli kedua bahasa', () => {
    const all = new Set();
    for (const v of [null, { mood: 1 }, { nickname: 5 }, { nickname: { fr: 1 } }, { nickname: '' }, { nickname: `a${ch(7)}` }, { nickname: 'admin' }, { traits: 1 },
      { traits: [1, 2, 3, 4] }, { idle: 'x' }, { speech: 1 }]) for (const e of validatePersonality(v).errors) all.add(e.key);
    for (const k of ['divisions.err.personalitiesInvalid', 'divisions.err.personalityWorker', 'divisions.err.personalityIgnored']) all.add(k);
    expect(all.size).toBeGreaterThanOrEqual(10);
    for (const lang of ['en', 'id']) {
      const cli = catalog(lang).cli;
      for (const k of all) expect(Object.hasOwn(cli, k), `${lang} ${k}`).toBe(true);
    }
  });
});

describe('kepribadian bawaan: 17 worker, manajer, dan CEO', () => {
  const ids = [...AGENT_NAMES, MANAGER_ID, CEO_ID];

  it('ada untuk ke-19 karakter, dan tidak ada kunci lain', () => {
    expect(ids).toHaveLength(19);
    expect(Object.keys(DEFAULT_PERSONALITIES).sort()).toEqual([...ids].sort());
  });

  it('semuanya lolos validatePersonality dan hasilnya sama persis (sudah ternormalisasi)', () => {
    for (const id of ids) {
      const r = validatePersonality(DEFAULT_PERSONALITIES[id], { builtin: true });
      expect(r.ok, `${id}: ${JSON.stringify(r.errors)}`).toBe(true);
      expect(r.value, id).toEqual(DEFAULT_PERSONALITIES[id]);
    }
  });

  it('dua bahasa, lengkap, dan beragam', () => {
    for (const id of ids) {
      const p = DEFAULT_PERSONALITIES[id];
      expect(p.nickname.en && p.nickname.id, id).toBeTruthy();
      expect(p.traits.length, id).toBeGreaterThanOrEqual(1);
      expect(p.speech.phrases.length, id).toBeGreaterThanOrEqual(3);
      for (const x of [...p.traits, ...p.speech.phrases]) expect(x.en && x.id, id).toBeTruthy();
      expect(TONES).toContain(p.speech.tone);
      expect(IDLE_KINDS).toContain(p.idle);
      expect(QUIRK_NAMES).toContain(p.quirk);
    }
    // semua tone, kebiasaan idle, dan quirk dipakai setidaknya sekali
    const all = Object.values(DEFAULT_PERSONALITIES);
    expect(new Set(all.map((p) => p.speech.tone))).toEqual(new Set(TONES));
    expect(new Set(all.map((p) => p.idle))).toEqual(new Set(IDLE_KINDS));
    expect(new Set(all.map((p) => p.quirk))).toEqual(new Set(QUIRK_NAMES));
    // frasa khas: tidak ada dua worker yang berbagi frasa yang sama
    const phrases = all.flatMap((p) => p.speech.phrases.map((x) => x.en));
    expect(new Set(phrases).size).toBe(phrases.length);
    // nama panggilan unik per bahasa
    for (const lang of ['en', 'id']) expect(new Set(all.map((p) => p.nickname[lang])).size).toBe(all.length);
  });

  it('nama panggilan bawaan sama dengan nama karakter di locales (EN dan ID)', () => {
    for (const lang of ['en', 'id']) {
      for (const id of ids) {
        expect(localized(DEFAULT_PERSONALITIES[id].nickname, lang), `${lang} ${id}`).toBe(dictionaries[lang].office[`char.${id}`]);
      }
    }
  });

  it('data bawaan beku (tidak bisa diubah lewat personalityOf)', () => {
    expect(Object.isFrozen(DEFAULT_PERSONALITIES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PERSONALITIES['dev-frontend'].speech.phrases)).toBe(true);
  });

  it('personalityOf mengembalikan bawaan (dilengkapi) untuk worker bawaan', () => {
    const p = personalityOf('dev-frontend');
    expect(p.speech.tone).toBe('cheerful');
    expect(p).toEqual(resolvePersonality(DEFAULT_PERSONALITIES['dev-frontend']));
  });
});

describe('kamus: kunci frasa tone ada dan sama di kedua bahasa', () => {
  it('office.tone.<tone>.1..3 tersedia di EN dan ID, tidak kosong, dalam batas frasa', () => {
    for (const lang of ['en', 'id']) {
      for (const tone of TONES) {
        for (let n = 1; n <= 3; n++) {
          const v = dictionaries[lang].office[`tone.${tone}.${n}`];
          expect(v, `${lang} ${tone} ${n}`).toBeTruthy();
          expect([...v].length).toBeLessThanOrEqual(PERSONALITY_LIMITS.phraseMax);
        }
      }
    }
  });

  it('speechLines: frasa sendiri; tanpa frasa memakai cadangan sesuai tone; netral kosong; ikut bahasa', () => {
    const p = resolvePersonality({ speech: { phrases: [{ en: 'One', id: 'Satu' }] } });
    expect(speechLines(p, 'en')).toEqual(['One']);
    expect(speechLines(p, 'id')).toEqual(['Satu']);
    const tone = resolvePersonality({ speech: { tone: 'calm' } });
    expect(speechLines(tone, 'en')).toHaveLength(3);
    expect(speechLines(tone, 'en')[0]).toBe(dictionaries.en.office['tone.calm.1']);
    expect(speechLines(tone, 'id')[0]).toBe(dictionaries.id.office['tone.calm.1']);
    expect(speechLines(NEUTRAL_PERSONALITY, 'en')).toEqual([]);
  });
});

describe('animasi: setiap enum idle dan quirk benar-benar punya animasi di kanvas', () => {
  const look = { id: 't', skin: 1, hair: 'black', style: 'short', acc: 'none', hijab: 0, hat: 0, glasses: false, beard: false, pants: 0 };
  const grid = (spec) => JSON.stringify(buildGrid(look, 'worker', { dir: 'down', pose: 'sit', frame: 0, ...spec }));
  const base = grid({});

  it('IDLE_BEHAVIORS punya entri untuk setiap IDLE_KINDS (dan tidak lebih)', () => {
    expect(Object.keys(IDLE_BEHAVIORS).sort()).toEqual([...IDLE_KINDS].sort());
  });

  it('pose lengan idle (di meja dan di pantry) menghasilkan gambar sprite yang berbeda dari diam', () => {
    for (const kind of IDLE_KINDS) {
      const b = IDLE_BEHAVIORS[kind];
      expect(typeof b.trip, kind).toBe('boolean');
      if (b.seat === 'turn') expect(grid({ dir: 'up' }), kind).not.toBe(base); // menghadap jendela = tampak belakang
      else expect(grid({ act: b.seat }), `${kind} seat ${b.seat}`).not.toBe(base);
      expect(grid({ act: b.pantry }), `${kind} pantry ${b.pantry}`).not.toBe(base);
    }
  });

  it('kebiasaan idle yang berjalan ke pantry hanyalah kopi, air, camilan, tanaman, ngobrol', () => {
    expect(IDLE_KINDS.filter((k) => IDLE_BEHAVIORS[k].trip).sort()).toEqual(['chat', 'coffee', 'plant', 'snack', 'water']);
  });

  it('QUIRKS punya entri untuk setiap enum quirk, masing-masing dengan efek yang bisa digambar', () => {
    expect(Object.keys(QUIRKS).sort()).toEqual([...QUIRK_NAMES].sort());
    for (const name of QUIRK_NAMES) {
      const q = QUIRKS[name];
      const effects = [q.act, q.mouth, q.phones, q.draw].filter(Boolean);
      expect(effects.length, name).toBeGreaterThanOrEqual(1);
      if (q.act) expect(grid({ act: q.act }), `${name} act`).not.toBe(base);
      if (q.mouth) expect(grid({ mouth: true }), `${name} mouth`).not.toBe(base);
      if (q.phones) expect(grid({ phones: true }), `${name} phones`).not.toBe(base);
      if (q.draw) {
        const calls = [];
        const ctx = { fillRect: (...a) => calls.push(a), set fillStyle(v) {}, set globalAlpha(v) {} };
        q.draw(ctx, { x: 100, headY: 60, desk: { x: 80, y: 80, w: 56, h: 16 }, phase: 0.5, time: 3.3, ink: '#000', soft: '#444' });
        expect(calls.length, `${name} draw`).toBeGreaterThan(0);
        for (const [x, y, w, h] of calls) {
          expect(Number.isFinite(x + y + w + h)).toBe(true);
          expect(w).toBeLessThanOrEqual(8);
          expect(h).toBeLessThanOrEqual(8);
        }
      }
    }
  });

  it('headphones tampak di 4 arah dan satu-satunya efek statis', () => {
    for (const dir of ['down', 'up', 'left', 'right']) {
      const a = JSON.stringify(buildGrid(look, 'worker', { dir, pose: 'stand', frame: 0 }));
      const b = JSON.stringify(buildGrid(look, 'worker', { dir, pose: 'stand', frame: 0, phones: true }));
      expect(b, dir).not.toBe(a);
    }
    expect(QUIRK_NAMES.filter((n) => QUIRKS[n].phones)).toEqual(['headphones']);
  });

  it('quirkPhase: periodik, deterministik, dan selalu mati saat reduced motion', () => {
    let active = 0;
    for (let tt = 0; tt < QUIRK_CYCLE * 4; tt += 0.05) {
      expect(quirkPhase(tt, 1234, true)).toBe(-1);
      const p = quirkPhase(tt, 1234, false);
      expect(p).toBe(quirkPhase(tt, 1234, false));
      if (p >= 0) {
        active++;
        expect(p).toBeLessThan(1);
      }
    }
    expect(active).toBeGreaterThan(0);
    expect(active).toBeLessThan((QUIRK_CYCLE * 4) / 0.05 / 2); // aktif hanya sebagian siklus
  });
});

// ------------------------------------------------------------------ divisi plugin

const tmps = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-office-pers-'));
  tmps.push(d);
  return d;
};
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const GOOD_AGENT = readFileSync(join(ROOT, 'division-packs', 'example-legal', 'agents', 'example-legal-reviewer.md'), 'utf8');
const agentText = (name) => GOOD_AGENT.replace(/^name: .*$/m, `name: ${name}`);
function makeDivision(root, id, workers, extra = {}) {
  const dir = join(root, id);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'division.json'), JSON.stringify({ id, name: { en: id, id }, color: '#112233', desks: Math.max(2, workers.length), workers, ...extra }));
  for (const w of workers) writeFileSync(join(dir, 'agents', `${w}.md`), agentText(w));
}

const okMine = { nickname: 'Mimi', traits: ['rapi'], speech: { tone: 'dry', phrases: [{ en: 'Filed.', id: 'Sudah diarsip.' }] }, idle: 'plant', quirk: 'plant-talk' };

describe('validateDivision: personalities', () => {
  const base = { id: 'legal', name: 'Legal', color: '#8a5a44', desks: 3, workers: ['legal-a', 'legal-b'] };

  it('tanpa personalities: hasil identik dengan sebelumnya (tanpa kunci baru)', () => {
    const r = validateDivision(base);
    expect(r.ok).toBe(true);
    expect(Object.hasOwn(r.value, 'personalities')).toBe(false);
    expect(r.warnings).toBeUndefined();
  });

  it('personalities valid dibersihkan dan disimpan per worker', () => {
    const r = validateDivision({ ...base, personalities: { 'legal-a': okMine } });
    expect(r.ok).toBe(true);
    expect(r.value.personalities['legal-a'].nickname).toEqual({ en: 'Mimi', id: 'Mimi' });
    expect(r.value.personalities['legal-b']).toBeUndefined();
  });

  it('kunci yang bukan worker di divisi itu menolak divisi; bukan objek menolak divisi', () => {
    expect(keys(validateDivision({ ...base, personalities: { ghost: okMine } }))).toEqual(['divisions.err.personalityWorker']);
    expect(keys(validateDivision({ ...base, personalities: { 'dev-frontend': okMine } }))).toEqual(['divisions.err.personalityWorker']);
    for (const bad of [[], 'x', 5, null]) {
      expect(keys(validateDivision({ ...base, personalities: bad })), JSON.stringify(bad)).toEqual(['divisions.err.personalitiesInvalid']);
    }
  });

  it('isi tidak valid diabaikan PER WORKER dengan peringatan; divisi dan worker lain tetap', () => {
    const r = validateDivision({ ...base, personalities: { 'legal-a': okMine, 'legal-b': { idle: 'nap', nickname: 'x' } } });
    expect(r.ok).toBe(true);
    expect(Object.keys(r.value.personalities)).toEqual(['legal-a']);
    expect(r.value.workers).toEqual(['legal-a', 'legal-b']);
    expect(r.warnings).toEqual([{ key: 'divisions.err.personalityIgnored', params: { worker: 'legal-b', field: 'idle', reason: 'divisions.err.personalityEnum' } }]);
  });

  it('kunci __proto__ tidak mencemari prototipe', () => {
    const raw = JSON.parse('{"personalities": {"__proto__": {"nickname": "x"}}}');
    const r = validateDivision({ ...base, ...raw });
    expect(r.ok).toBe(false);
    expect({}.nickname).toBeUndefined();
  });
});

describe('divisi plugin dengan personalities: server dan klien sepakat', () => {
  function build() {
    const root = mkTmp();
    makeDivision(root, 'office', ['office-mimi', 'office-nono', 'office-plain'], {
      personalities: {
        'office-mimi': okMine,
        'office-nono': { nickname: 'Nono', idle: 'nap' }, // tidak valid: diabaikan
      },
    });
    return discoverDivisions({ dir: root });
  }

  it('penemuan memuat divisi, menyimpan yang valid, dan mencatat peringatan untuk yang diabaikan', () => {
    const r = build();
    expect(r.divisions).toHaveLength(1);
    expect(Object.keys(r.divisions[0].personalities)).toEqual(['office-mimi']);
    expect(r.errors.map((e) => e.key)).toEqual(['divisions.err.personalityIgnored']);
    expect(r.divisions[0].workers).toHaveLength(3);
  });

  it('kunci personalities di luar workers membuat divisi dilewati (tidak ada yang dimuat)', () => {
    const root = mkTmp();
    makeDivision(root, 'office', ['office-a'], { personalities: { 'office-zzz': okMine } });
    const r = discoverDivisions({ dir: root });
    expect(r.divisions).toEqual([]);
    expect(r.errors.map((e) => e.key)).toEqual(['divisions.err.personalityWorker']);
  });

  it('publicDivisions meneruskan personalities (tanpa path dan teks agen)', () => {
    const pub = publicDivisions(build());
    expect(pub.divisions[0].personalities['office-mimi'].nickname).toEqual({ en: 'Mimi', id: 'Mimi' });
    expect(JSON.stringify(pub)).not.toMatch(/agentFiles|text:|path/);
    const noPers = publicDivisions({ divisions: [{ id: 'x1', name: { en: 'X', id: 'X' }, color: '#112233', desks: 1, workers: ['x1-a'], source: 'plugin', agentFiles: [] }], errors: [] });
    expect(Object.hasOwn(noPers.divisions[0], 'personalities')).toBe(false);
  });

  it('lewat HTTP GET /api/divisions: body diterima klien dan hasilnya sama dengan data server', async () => {
    const found = build();
    const s = await startApp({ divisions: found });
    try {
      const r = await http(s.port, '/api/divisions');
      expect(r.status).toBe(200);
      const serverPers = r.json.divisions[0].personalities;
      expect(Object.keys(serverPers)).toEqual(['office-mimi']);
      expect(applyDivisionsResponse(r.status, r.json)).toBe(true);
      const client = getState().plugin[0];
      expect(client.personalities).toEqual(serverPers);
      expect(client.agents).toEqual(r.json.divisions[0].workers);
      // kepribadian dipakai klien; worker tanpa data atau dengan data tidak valid tetap tampil, netral
      expect(personalityOf('office-mimi')).toEqual(resolvePersonality(serverPers['office-mimi']));
      expect(personalityOf('office-nono')).toBe(NEUTRAL_PERSONALITY);
      expect(personalityOf('office-plain')).toBe(NEUTRAL_PERSONALITY);
    } finally {
      await s.close();
    }
  });

  it('klien memvalidasi ulang: data personalities rusak dari server (dimanipulasi) diabaikan per worker', () => {
    const body = {
      ok: true,
      errors: [],
      divisions: [{
        id: 'evil', name: { en: 'E', id: 'E' }, color: '#112233', desks: 2, workers: ['evil-a', 'evil-b'], source: 'plugin',
        personalities: {
          'evil-a': { nickname: `<img src=x onerror=alert(1)>${ch(0x202e)}`, quirk: 'hum' },
          'evil-b': { nickname: '<b>ok</b>', idle: 'snack', extra: 1 },
        },
      }],
    };
    const out = parseDivisions(body);
    expect(out.divisions).toHaveLength(1); // divisi tetap tampil
    expect(out.divisions[0].agents).toEqual(['evil-a', 'evil-b']);
    expect(out.divisions[0].personalities).toBeUndefined(); // keduanya tidak valid
    // kunci di luar workers: seluruh entri ditolak oleh klien, sama seperti server
    expect(parseDivisions({ ...body, divisions: [{ ...body.divisions[0], personalities: { ghost: okMine } }] }).divisions).toEqual([]);
  });

  it('teks dari data dirender sebagai teks: nama panggilan HTML tetap string apa adanya', () => {
    applyDivisionsResponse(200, {
      ok: true,
      errors: [],
      divisions: [{ id: 'html', name: { en: 'H', id: 'H' }, color: '#112233', desks: 1, workers: ['html-a'], source: 'plugin', personalities: { 'html-a': { nickname: '<b>Bo</b>' } } }],
    });
    expect(characterName('html-a')).toBe('<b>Bo</b>'); // dikirim ke fillText, tidak pernah innerHTML
    expect(deskLabel('html-a')).toBe('<b>Bo</b> · a');
    const src = ['src/office/render.js', 'src/office/quirks.js', 'src/personality.js', 'src/office/characters.js']
      .map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n');
    expect(src).not.toMatch(/innerHTML|dangerouslySetInnerHTML|insertAdjacentHTML|document\.write/);
  });

  it('nama panggilan plugin mengikuti bahasa; worker bawaan tetap memakai nama locale', () => {
    applyDivisionsResponse(200, {
      ok: true,
      errors: [],
      divisions: [{ id: 'bi', name: { en: 'B', id: 'B' }, color: '#112233', desks: 1, workers: ['bi-a'], source: 'plugin', personalities: { 'bi-a': { nickname: { en: 'Sunny', id: 'Cerah' } } } }],
    });
    expect(characterName('bi-a')).toBe('Sunny');
    setLang('id', { persist: false });
    expect(characterName('bi-a')).toBe('Cerah');
    expect(nicknameOf(personalityOf('bi-a'), 'en')).toBe('Sunny');
    expect(characterName('dev-frontend')).toBe('Sari');
    expect(characterName('manager')).toBe('Bu Ratna');
    setLang('en', { persist: false });
    expect(characterName('manager')).toBe('Ms. Ratna');
  });
});

describe('netral bila tanpa data', () => {
  it('worker plugin tanpa personalities dan agen tamu memakai default netral (kopi, tanpa frasa, tanpa quirk)', () => {
    applyDivisionsResponse(200, {
      ok: true,
      errors: [],
      divisions: [{ id: 'neu', name: { en: 'N', id: 'N' }, color: '#112233', desks: 1, workers: ['neu-a'], source: 'plugin' }],
    });
    for (const id of ['neu-a', 'Explore', 'general-purpose', 'unknown-agent']) {
      const p = personalityOf(id);
      expect(p, id).toBe(NEUTRAL_PERSONALITY);
      expect(p.idle).toBe('coffee');
      expect(p.quirk).toBeNull();
      expect(p.nickname).toBeNull();
      expect(p.speech).toEqual({ tone: null, phrases: [] });
      expect(speechLines(p, 'en')).toEqual([]);
      expect(IDLE_BEHAVIORS[p.idle]).toEqual({ trip: true, seat: 'sip', pantry: 'sip' }); // perilaku lama
    }
    expect(characterName('neu-a')).toBe('neu-a');
    expect(deskLabel('neu-a')).toBe('neu-a');
  });

  it('resolvePersonality melengkapi data sebagian dengan default netral', () => {
    expect(resolvePersonality(null)).toBe(NEUTRAL_PERSONALITY);
    expect(resolvePersonality({ quirk: 'yawn' })).toEqual({ nickname: null, traits: [], speech: { tone: null, phrases: [] }, idle: 'coffee', quirk: 'yawn' });
  });

  it('example-legal: contoh di division-packs valid, tanpa peringatan, dan terpakai di klien', () => {
    const raw = JSON.parse(readFileSync(join(ROOT, 'division-packs', 'example-legal', 'division.json'), 'utf8'));
    const r = validateDivision(raw);
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
    expect(r.warnings).toBeUndefined();
    expect(Object.keys(r.value.personalities).sort()).toEqual([...raw.workers].sort());
    expect(Object.keys(raw.personalities).every((k) => raw.workers.includes(k))).toBe(true);
    const found = discoverDivisions({ dir: join(ROOT, 'division-packs') }).divisions.find((d) => d.id === 'example-legal');
    expect(found.personalities['example-legal-reviewer'].idle).toBe('water');
    applyDivisionsResponse(200, { ok: true, ...publicDivisions({ divisions: [found], errors: [] }) });
    expect(characterName('example-legal-reviewer')).toBe('Lena');
    expect(personalityOf('example-legal-drafter').quirk).toBe('pen-spin');
  });
});

describe('label meja: nickname panjang tidak melebihi lebar slot', () => {
  const PER_CHAR = 3.5; // lebar tiruan per code unit, sama seperti test kanvas lain
  function labelTexts() {
    const texts = [];
    const mk = (w, h) => {
      const ctx = new Proxy({ fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic' }, {
        get(t0, k) {
          if (k in t0) return t0[k];
          if (k === 'measureText') return (x) => ({ width: String(x).length * PER_CHAR });
          if (k === 'fillText') return (x) => { texts.push(String(x)); };
          return () => {};
        },
        set(t0, k, v) {
          t0[k] = v;
          return true;
        },
      });
      return { width: w, height: h, getContext: () => ctx };
    };
    globalThis.document = { createElement: () => mk(layout.W, layout.H) };
    try {
      const o = new Office();
      createRenderer(mk(layout.W * 2, layout.H * 2), { theme: 'dark' }).draw(o, 0);
    } finally {
      delete globalThis.document;
    }
    return texts;
  }

  it('label bawaan tidak berubah (tetap persis "Nama · peran")', () => {
    const texts = labelTexts();
    for (const n of AGENT_NAMES) expect(texts, n).toContain(deskLabel(n));
    for (const n of AGENT_NAMES) expect(deskLabel(n).length * PER_CHAR, n).toBeLessThanOrEqual(DESK_LABEL_MAX_W);
  });

  it('nickname plugin 16 karakter + peran panjang dipotong dengan elipsis dan muat di slot; emoji tidak pecah', () => {
    const long = 'Wolfeschlegelst';
    applyDivisionsResponse(200, {
      ok: true,
      errors: [],
      divisions: [{ id: 'lbl', name: { en: 'L', id: 'L' }, color: '#112233', desks: 2, workers: ['lbl-extremely-long-role', 'lbl-emoji'], source: 'plugin',
        personalities: { 'lbl-extremely-long-role': { nickname: `${long}x` }, 'lbl-emoji': { nickname: String.fromCodePoint(0x1f600).repeat(16) } } }],
    });
    expect([...characterName('lbl-extremely-long-role')]).toHaveLength(16);
    const texts = labelTexts();
    const mine = texts.filter((x) => x.startsWith(long) || x.startsWith(String.fromCodePoint(0x1f600)));
    expect(mine).toHaveLength(2);
    for (const x of mine) {
      expect(x.length * PER_CHAR).toBeLessThanOrEqual(DESK_LABEL_MAX_W);
      expect(x.endsWith(String.fromCharCode(0x2026))).toBe(true);
      expect([...x].some((c) => c.length === 1 && c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdfff)).toBe(false); // tanpa surrogate tunggal
    }
  });

  it('lebar maksimum label lebih kecil dari jarak terkecil antarmeja', () => {
    const seats = [...layout.rosterSeats().values()];
    const gaps = [];
    for (const a of seats) for (const b of seats) if (a !== b && a.division.id === b.division.id && a.seat.y === b.seat.y) gaps.push(Math.abs(a.seat.x - b.seat.x));
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.min(...gaps)).toBeGreaterThan(DESK_LABEL_MAX_W);
  });
});
