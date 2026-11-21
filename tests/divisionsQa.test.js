// QA Fase 1 (divisi plugin): celah test dan edge case.
// - Test silang validator server (shared/divisions.js) vs klien (src/divisions.js).
// - Penemuan: BOM, CRLF, kunci ganda, huruf besar, homoglyph, desks < workers, md hilang/rusak, 0/12/13 divisi.
// - Layout bawaan, event hook untuk worker plugin, `division:add` dengan path berspasi.
// Perbedaan server/klien yang TERBUKTI sebagai bug fitur ditandai `it.fails` (lulus selama bug ada, gagal
// begitu diperbaiki supaya tandanya dicabut). Detail laporan ada di laporan QA, bukan di sini.
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { validateDivision } from '../shared/divisions.js';
import { normalizeEvent } from '../shared/events.js';
import { DISCOVERY_LIMITS, discoverDivisions, publicDivisions } from '../server/divisions.js';
import { applyDivisionsResponse, resetDivisions, validateDivisionEntry } from '../src/divisions.js';
import { Office } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { ROOT, cleanEnv, runNode } from './helpers/testkit.js';

const GOOD_AGENT = readFileSync(join(ROOT, 'division-packs', 'example-legal', 'agents', 'example-legal-reviewer.md'), 'utf8');
const agentText = (name) => GOOD_AGENT.replace(/^name: .*$/m, `name: ${name}`);

const tmps = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-office-qa-'));
  tmps.push(d);
  return d;
};
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));
afterEach(() => resetDivisions());

const manifest = (id, workers, extra = {}) => ({ id, name: { en: id, id }, color: '#112233', desks: Math.max(2, workers.length), workers, ...extra });
function makeDivision(root, id, workers = [`${id}-a`], { raw, agents = {}, folder = id, man = {} } = {}) {
  const dir = join(root, folder);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'division.json'), raw ?? JSON.stringify(manifest(id, workers, man)));
  for (const w of workers) if (agents[w] !== null) writeFileSync(join(dir, 'agents', `${w}.md`), agents[w] ?? agentText(w));
  return dir;
}
const keys = (r) => r.errors.map((e) => e.key);

// ------------------------------------------------------------------ test silang server vs klien

const base = { id: 'legal', name: { en: 'Legal', id: 'Hukum' }, color: '#8a5a44', desks: 3, workers: ['legal-a'] };
const mk = (over) => ({ ...base, ...over });
const rep = (ch, n) => ch.repeat(n);
const ws = (n) => Array.from({ length: n }, (_, i) => `w${i}`);

/** Bentuk yang dikirim server ke klien: nama selalu {en,id}. Untuk entri tidak valid, pakai bentuk "sebisanya". */
const asEntry = (raw) => {
  const e = { ...raw };
  if (typeof e.name === 'string') e.name = { en: e.name, id: e.name };
  else if (e.name && typeof e.name === 'object' && e.name.id === undefined) e.name = { ...e.name, id: e.name.en };
  return e;
};
const verdicts = (raw) => ({ server: validateDivision(raw).ok, client: validateDivisionEntry(asEntry(raw)).ok });

// Kasus yang HARUS disepakati kedua sisi.
const AGREE = {
  'contoh spesifikasi': [base, true],
  'warna huruf besar': [mk({ color: '#8A5A44' }), true],
  'id 31 karakter': [mk({ id: rep('a', 31) }), true],
  'id 33 karakter': [mk({ id: rep('a', 33) }), false],
  'id huruf besar': [mk({ id: 'Legal' }), false],
  'id homoglyph Kiril': [mk({ id: 'l\u0435gal' }), false],
  'id fullwidth': [mk({ id: '\uff4c\uff45\uff47\uff41\uff4c' }), false],
  'id traversal': [mk({ id: '../x' }), false],
  'id dicadangkan dev': [mk({ id: 'dev' }), false],
  'id dicadangkan other': [mk({ id: 'other' }), false],
  'worker homoglyph': [mk({ workers: ['l\u0435gal'] }), false],
  'worker bawaan': [mk({ workers: ['dev-backend'] }), false],
  'worker huruf besar': [mk({ workers: ['Legal-A'] }), false],
  'worker diawali tanda hubung': [mk({ workers: ['-a'] }), false],
  'worker 64 karakter': [mk({ workers: [rep('a', 64)] }), true],
  'worker 65 karakter': [mk({ workers: [rep('a', 65)] }), false],
  'worker dobel': [mk({ workers: ['a1', 'a1'] }), false],
  '9 worker': [mk({ desks: 8, workers: ws(9) }), false],
  '8 worker 8 meja': [mk({ desks: 8, workers: ws(8) }), true],
  'desks 0': [mk({ desks: 0 }), false],
  'desks 9': [mk({ desks: 9 }), false],
  'desks pecahan': [mk({ desks: 2.5 }), false],
  'desks teks': [mk({ desks: '3' }), false],
  'nama kosong spasi': [mk({ name: { en: '  ', id: 'x' } }), false],
  'nama 41 karakter ASCII': [mk({ name: { en: rep('a', 41), id: 'x' } }), false],
  'nama 40 karakter ASCII': [mk({ name: { en: rep('a', 40), id: 'x' } }), true],
  'warna pendek': [mk({ color: '#fff' }), false],
  'warna tanpa #': [mk({ color: '8a5a44' }), false],
};

describe('test silang: validator server vs klien', () => {
  it.each(Object.entries(AGREE))('sepakat: %s', (_n, [raw, expected]) => {
    expect(verdicts(raw)).toEqual({ server: expected, client: expected });
  });

  it('semua tiga puluh lebih kasus di atas memang berbeda satu sama lain (tabel tidak kosong)', () => {
    expect(Object.keys(AGREE).length).toBeGreaterThan(25);
  });

  // ---- BUG: klien lebih ketat daripada server -> divisi valid di server DIBUANG diam-diam di UI.
  it('(dulu BUG) id 32 karakter (batas atas server): klien juga harus menerima', () => {
    expect(verdicts(mk({ id: rep('a', 32) }))).toEqual({ server: true, client: true });
  });
  it('worker "a-" dan "a--b": server (regex diperketat) dan klien sama-sama menolak', () => {
    for (const w of ['a-', 'a--b']) expect(verdicts(mk({ workers: [w] })), w).toEqual({ server: false, client: false });
  });
  it('(dulu BUG) nama 40 karakter astral (emoji): server menghitung code point, klien code unit', () => {
    expect(verdicts(mk({ name: { en: rep('\u{1F600}', 21), id: 'x' } }))).toEqual({ server: true, client: true });
  });

  // ---- Klien lebih longgar daripada server. Aman selama server menyaring dulu, tetapi kontraknya
  // "keduanya menolak hal yang sama"; ditandai agar terlihat.
  it('klien menolak yang ditolak server: id berawalan angka / 1 karakter / manager / ceo', () => {
    for (const id of ['1legal', 'a', 'manager', 'ceo']) expect(verdicts(mk({ id })), id).toEqual({ server: false, client: false });
  });
  it('klien menolak yang ditolak server: worker ceo/manager/other dan daftar worker kosong', () => {
    for (const workers of [['ceo'], ['manager'], ['other'], []]) expect(verdicts(mk({ workers })), JSON.stringify(workers)).toEqual({ server: false, client: false });
  });
  it('klien menolak yang ditolak server: desks < workers (klien malah membesarkan desks)', () => {
    expect(verdicts(mk({ desks: 1, workers: ['a1', 'b2'] }))).toEqual({ server: false, client: false });
  });
  it('klien menolak yang ditolak server: nama berisi zero-width/bidi', () => {
    for (const en of ['Le\u200bgal', 'Le\u202egal']) expect(verdicts(mk({ name: { en, id: 'x' } })), en).toEqual({ server: false, client: false });
  });

  it('keluaran publicDivisions dari server untuk divisi valid selalu diterima klien (jalur nyata)', () => {
    const root = mkTmp();
    makeDivision(root, 'alpha', ['alpha-a', 'alpha-b']);
    makeDivision(root, 'beta', ['beta-a']);
    const pub = publicDivisions(discoverDivisions({ dir: root }));
    expect(pub.divisions).toHaveLength(2);
    for (const d of pub.divisions) expect(validateDivisionEntry(d).ok, d.id).toBe(true);
    expect(applyDivisionsResponse(200, { ok: true, ...pub })).toBe(true);
  });
});

// ------------------------------------------------------------------ penemuan: edge case

describe('penemuan: format berkas', () => {
  it('division.json dengan BOM UTF-8 dibaca', () => {
    const root = mkTmp();
    makeDivision(root, 'bom', ['bom-a'], { raw: `\uFEFF${JSON.stringify(manifest('bom', ['bom-a']))}` });
    expect(discoverDivisions({ dir: root }).divisions.map((d) => d.id)).toEqual(['bom']);
  });

  it('division.json CRLF dan berformat rapi dibaca', () => {
    const root = mkTmp();
    makeDivision(root, 'crlf', ['crlf-a'], { raw: JSON.stringify(manifest('crlf', ['crlf-a']), null, 2).replaceAll('\n', '\r\n') });
    expect(discoverDivisions({ dir: root }).divisions.map((d) => d.id)).toEqual(['crlf']);
  });

  it('file agen CRLF (frontmatter dan isi) lolos validasi', () => {
    const root = mkTmp();
    makeDivision(root, 'crlf', ['crlf-a'], { agents: { 'crlf-a': agentText('crlf-a').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n') } });
    const r = discoverDivisions({ dir: root });
    expect(r.errors).toEqual([]);
    expect(r.divisions).toHaveLength(1);
  });

  it('file agen dengan BOM lolos validasi', () => {
    const root = mkTmp();
    makeDivision(root, 'bom', ['bom-a'], { agents: { 'bom-a': `\uFEFF${agentText('bom-a')}` } });
    expect(discoverDivisions({ dir: root }).errors).toEqual([]);
  });

  it('kunci ganda di JSON: JSON.parse mengambil yang terakhir; hasil tetap lolos validator (perilaku terdokumentasi)', () => {
    const root = mkTmp();
    const raw = '{"id":"dup","name":"Dup","color":"#112233","desks":2,"workers":["x-one"],"workers":["dup-a"]}';
    makeDivision(root, 'dup', ['dup-a'], { raw });
    const r = discoverDivisions({ dir: root });
    expect(r.errors).toEqual([]);
    expect(r.divisions[0].workers).toEqual(['dup-a']);
  });

  it('kunci ganda "id": yang terakhir menang dan tetap harus cocok dengan nama folder', () => {
    const root = mkTmp();
    makeDivision(root, 'dupid', ['dupid-a'], { raw: JSON.stringify(manifest('dupid', ['dupid-a'])).replace('{"id":"dupid"', '{"id":"other-x","id":"dupid"') });
    expect(discoverDivisions({ dir: root }).divisions).toHaveLength(1);
    const root2 = mkTmp();
    makeDivision(root2, 'dupid', ['dupid-a'], { raw: JSON.stringify(manifest('dupid', ['dupid-a'])).replace('{"id":"dupid"', '{"id":"dupid","id":"lain"') });
    expect(keys(discoverDivisions({ dir: root2 }))).toContain('divisions.err.folderMismatch');
  });

  it('JSON bukan objek / null / array / kosong ditolak tanpa melempar', () => {
    for (const raw of ['null', '[]', '""', '', '   ', '{', '1']) {
      const root = mkTmp();
      makeDivision(root, 'bad', ['bad-a'], { raw });
      const r = discoverDivisions({ dir: root });
      expect(r.divisions, JSON.stringify(raw)).toEqual([]);
      expect(r.errors, JSON.stringify(raw)).toHaveLength(1);
    }
  });
});

describe('penemuan: nama dan id', () => {
  it('folder berhuruf besar dengan id huruf kecil ditolak (juga di Windows yang tidak peka huruf)', () => {
    const root = mkTmp();
    makeDivision(root, 'legal', ['legal-a'], { folder: 'Legal' });
    const r = discoverDivisions({ dir: root });
    expect(r.divisions).toEqual([]);
    expect(keys(r)).toEqual(['divisions.err.folderMismatch']);
  });

  it('id berhuruf besar atau homoglyph ditolak oleh skema, folder Unicode tidak lolos', () => {
    for (const [folder, id] of [['Legal', 'Legal'], ['l\u0435gal', 'l\u0435gal'], ['legal\u200b', 'legal\u200b']]) {
      const root = mkTmp();
      makeDivision(root, id, ['x-one'], { folder, man: { id } });
      const r = discoverDivisions({ dir: root });
      expect(r.divisions, folder).toEqual([]);
      expect(keys(r), folder).toContain('divisions.err.idInvalid');
    }
  });

  it('id mirip id bawaan tetapi bukan sama persis (devs, dev-2) diterima; yang sama persis ditolak', () => {
    const root = mkTmp();
    makeDivision(root, 'devs', ['devs-a']);
    makeDivision(root, 'dev', ['dev-zz']);
    const r = discoverDivisions({ dir: root });
    expect(r.divisions.map((d) => d.id)).toEqual(['devs']);
    expect(keys(r)).toEqual(['divisions.err.idReserved']);
  });

  it('nama worker homoglyph ditolak oleh skema', () => {
    const root = mkTmp();
    makeDivision(root, 'hg', ['hg-a'], { raw: JSON.stringify(manifest('hg', ['hg\u0430-a'])) });
    expect(keys(discoverDivisions({ dir: root }))).toContain('divisions.err.workerName');
  });
});

describe('penemuan: worker, meja, frontmatter', () => {
  it('desks < workers ditolak dengan satu kesalahan yang jelas', () => {
    const root = mkTmp();
    makeDivision(root, 'few', ['few-a', 'few-b', 'few-c'], { man: { desks: 2 } });
    expect(keys(discoverDivisions({ dir: root }))).toEqual(['divisions.err.desksTooFew']);
  });

  it('desks == workers diterima; desks > workers diterima', () => {
    const root = mkTmp();
    makeDivision(root, 'eq', ['eq-a', 'eq-b'], { man: { desks: 2 } });
    makeDivision(root, 'more', ['more-a'], { man: { desks: 6 } });
    expect(discoverDivisions({ dir: root }).divisions.map((d) => d.id)).toEqual(['eq', 'more']);
  });

  it('worker tanpa file .md: seluruh divisi ditolak (tidak muncul setengah jadi), error menyebut worker-nya', () => {
    const root = mkTmp();
    makeDivision(root, 'miss', ['miss-a', 'miss-b'], { agents: { 'miss-b': null } });
    const r = discoverDivisions({ dir: root });
    expect(r.divisions).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ key: 'divisions.err.agentMissing', params: { worker: 'miss-b' } });
  });

  it('file .md ekstra yang tidak ada di workers diabaikan', () => {
    const root = mkTmp();
    const dir = makeDivision(root, 'extra', ['extra-a']);
    writeFileSync(join(dir, 'agents', 'ghost.md'), agentText('ghost'));
    const r = discoverDivisions({ dir: root });
    expect(r.divisions[0].agentFiles.map((f) => f.worker)).toEqual(['extra-a']);
  });

  it.each([
    ['tanpa frontmatter', 'hanya isi biasa'],
    ['frontmatter tidak ditutup', '---\nname: fm-a\ndescription: x\n'],
    ['YAML rusak', '---\nname: [fm-a\n  : : :\n---\nisi'],
    ['file kosong', ''],
    ['frontmatter bukan objek', '---\n- a\n- b\n---\nisi'],
    ['hanya BOM', '\uFEFF'],
  ])('frontmatter rusak (%s): divisi ditolak, tidak melempar, pesan tidak memuat isi berkas', (_n, text) => {
    const root = mkTmp();
    makeDivision(root, 'fm', ['fm-a'], { agents: { 'fm-a': text } });
    const r = discoverDivisions({ dir: root });
    expect(r.divisions).toEqual([]);
    expect(keys(r)).toEqual(['divisions.err.agentInvalid']);
    expect(JSON.stringify(publicDivisions(r))).not.toContain('hanya isi biasa');
  });

  it('agen dengan key frontmatter berbahaya (hooks, mcpServers, permissionMode) ditolak penemuan', () => {
    for (const line of ['permissionMode: bypassPermissions', 'hooks:\n  PreToolUse: []', 'mcpServers:\n  x:\n    command: node']) {
      const root = mkTmp();
      makeDivision(root, 'ev', ['ev-a'], { agents: { 'ev-a': agentText('ev-a').replace(/^model: .*$/m, (m) => `${m}\n${line}`) } });
      expect(keys(discoverDivisions({ dir: root })), line).toEqual(['divisions.err.agentInvalid']);
    }
  });

  it('nama perangkat Windows (con, nul, com1) tidak lolos sebagai id atau worker', () => {
    for (const bad of ['con', 'nul', 'com1', 'lpt1', 'aux', 'prn']) {
      expect(validateDivision(mk({ id: bad })).ok, `id ${bad}`).toBe(false);
      expect(validateDivision(mk({ workers: [bad] })).ok, `worker ${bad}`).toBe(false);
    }
  });
});

describe('penemuan: jumlah divisi dan folder', () => {
  const many = (n) => {
    const root = mkTmp();
    for (let i = 0; i < n; i++) makeDivision(root, `d${String(i).padStart(2, '0')}`, [`d${String(i).padStart(2, '0')}-a`]);
    return root;
  };

  it('0 divisi: folder kosong dan folder hanya berisi berkas biasa', () => {
    const root = mkTmp();
    writeFileSync(join(root, 'README.md'), '# x');
    writeFileSync(join(root, '.gitkeep'), '');
    expect(discoverDivisions({ dir: root })).toEqual({ divisions: [], errors: [] });
    expect(publicDivisions(discoverDivisions({ dir: root }))).toEqual({ divisions: [], errors: [] });
  });

  it('tanpa folder divisions/ (ENOENT) dan jalur berupa berkas: tanpa divisi, tanpa melempar', () => {
    const root = mkTmp();
    expect(discoverDivisions({ dir: join(root, 'tidak-ada') })).toEqual({ divisions: [], errors: [] });
    writeFileSync(join(root, 'berkas'), 'x');
    expect(discoverDivisions({ dir: join(root, 'berkas') }).divisions).toEqual([]);
  });

  it('12 divisi diterima semua, tanpa error', () => {
    const r = discoverDivisions({ dir: many(12) });
    expect(r.divisions).toHaveLength(12);
    expect(r.errors).toEqual([]);
  });

  it('13 divisi: 12 pertama (urut abjad) diterima, yang ke-13 dicatat tooMany; klien juga 12', () => {
    const r = discoverDivisions({ dir: many(13) });
    expect(r.divisions).toHaveLength(12);
    expect(r.divisions.at(-1).id).toBe('d11');
    expect(r.errors).toEqual([expect.objectContaining({ dir: 'd12', key: 'divisions.err.tooMany' })]);
    const pub = publicDivisions(r);
    applyDivisionsResponse(200, { ok: true, ...pub });
    expect(layout.H).toBeGreaterThan(layout.BASE_H);
    expect(DISCOVERY_LIMITS.maxDivisions).toBe(12);
  });

  it('divisi tidak valid tidak memakan jatah 12 (hanya yang diterima dihitung)', () => {
    const root = many(12);
    makeDivision(root, 'aaa-bad', ['aaa-bad-a'], { raw: '{' }); // urut paling awal, rusak
    const r = discoverDivisions({ dir: root });
    expect(r.divisions).toHaveLength(12);
    expect(keys(r)).toEqual(['divisions.err.jsonInvalid']);
  });
});

// ------------------------------------------------------------------ layout bawaan dan event hook

describe('layout bawaan identik dan event hook di meja plugin', () => {
  const FIX = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'layout-builtin.json'), 'utf8'));
  const plain = (v) => JSON.parse(JSON.stringify(v));

  it('setelah memuat 12 divisi lalu menghapusnya, ZONES/H/kursi kembali persis fixture', () => {
    const list = Array.from({ length: 12 }, (_, i) => ({
      id: `p${i + 1}`, name: { en: 'P', id: 'P' }, color: '#112233', desks: 8, workers: ws(8).map((w) => `p${i + 1}-${w}`), source: 'plugin',
    }));
    expect(applyDivisionsResponse(200, { ok: true, divisions: list, errors: [] })).toBe(true);
    resetDivisions();
    expect(layout.H).toBe(FIX.H);
    expect(plain(layout.ZONES)).toEqual(FIX.ZONES);
    expect(plain([...layout.rosterSeats()].map(([n, s]) => [n, s.division.id, s.seat, s.desk, s.front, s.exit, s.hit]))).toEqual(FIX.seats);
  });

  it('event assign/working/report untuk worker plugin menaruh tiap worker di meja urutannya sendiri', () => {
    applyDivisionsResponse(200, {
      ok: true,
      errors: [],
      divisions: [
        { id: 'qa1', name: { en: 'A', id: 'A' }, color: '#112233', desks: 4, workers: ['qa1-a', 'qa1-b', 'qa1-c'], source: 'plugin' },
        { id: 'qa2', name: { en: 'B', id: 'B' }, color: '#223344', desks: 2, workers: ['qa2-a'], source: 'plugin' },
      ],
    });
    const o = new Office();
    const expectSeat = (name, zone, k) => {
      const w = o.workers.get(name);
      expect(w.division.id, name).toBe(zone);
      expect(w.dynamic, name).toBe(false);
      expect(w.seat, name).toEqual({ x: layout.ZONES[zone].seats[k][0], y: layout.ZONES[zone].seats[k][1] });
      expect({ x: w.x, y: w.y }, name).toEqual(w.seat);
    };
    for (const [n, z, k] of [['qa1-a', 'qa1', 0], ['qa1-b', 'qa1', 1], ['qa1-c', 'qa1', 2], ['qa2-a', 'qa2', 0]]) expectSeat(n, z, k);

    for (const e of [
      { type: 'assign', from: 'manager', to: 'qa1-c', message: 'tugas' },
      { type: 'working', from: 'qa2-a', to: 'manager', message: 'kerja' },
      { type: 'report', from: 'qa1-b', to: 'manager', message: 'selesai' },
    ]) {
      const n = normalizeEvent(e);
      expect(n.ok, JSON.stringify(e)).toBe(true);
      o.handleEvent(n.event ?? n.value ?? e, { instant: true });
    }
    expect(o.workers.get('qa1-c').status).toBe('working');
    expect(o.workers.get('qa2-a').status).toBe('working');
    expect(o.workers.get('qa1-b').status).toBe('done');
    expect(o.workers.get('qa1-a').status).toBe('idle');
    // tidak ada worker plugin yang jatuh ke meja tamu
    expect([...o.workers.values()].filter((w) => w.dynamic)).toEqual([]);
    expectSeat('qa1-c', 'qa1', 2);
    expectSeat('qa2-a', 'qa2', 0);
  });
});

// ------------------------------------------------------------------ division:add path berspasi

describe('division:add dengan path berspasi (Windows dan lain-lain)', () => {
  it('AI_OFFICE_DIVISIONS_DIR berspasi dan non-ASCII: membuat divisi yang lolos penemuan', async () => {
    const root = join(mkTmp(), 'Folder Dengan Spasi', 'k\u00e9 \u4e2d');
    const env = cleanEnv({ AI_OFFICE_LANG: 'en', AI_OFFICE_DIVISIONS_DIR: root });
    const add = await runNode([join(ROOT, 'scripts', 'division-add.mjs'), 'spasi-test'], { env });
    expect(add.code, add.err).toBe(0);
    const r = discoverDivisions({ dir: root });
    expect(r.errors).toEqual([]);
    expect(r.divisions.map((d) => d.id)).toEqual(['spasi-test']);
  });

  it('--from dengan path berspasi untuk folder tujuan dan dry-run tidak menulis apa pun', async () => {
    const root = join(mkTmp(), 'My Divisions');
    const env = cleanEnv({ AI_OFFICE_LANG: 'en', AI_OFFICE_DIVISIONS_DIR: root });
    const dry = await runNode([join(ROOT, 'scripts', 'division-add.mjs'), 'legal-x', '--from', 'example-legal', '--dry-run'], { env });
    expect(dry.code, dry.err).toBe(0);
    expect(discoverDivisions({ dir: root }).divisions).toEqual([]);
    const real = await runNode([join(ROOT, 'scripts', 'division-add.mjs'), 'legal-x', '--from', 'example-legal'], { env });
    expect(real.code, real.err).toBe(0);
    expect(discoverDivisions({ dir: root }).divisions.map((d) => d.id)).toEqual(['legal-x']);
  });
});
