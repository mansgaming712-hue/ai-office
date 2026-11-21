// Divisi plugin: skema (shared/divisions.js), penemuan (server/divisions.js), API, dan starter pack.
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '../shared/roster.js';
import { t } from '../shared/i18n.js';
import {
  DIVISION_LIMITS, RESERVED_DIVISION_IDS, safeText, validateDivision,
} from '../shared/divisions.js';
import { DISCOVERY_LIMITS, discoverDivisions, publicDivisions } from '../server/divisions.js';
import { parseAgentFile, validateAgent } from '../scripts/agent-files.mjs';
import { ROOT, http, randomToken, startApp } from './helpers/testkit.js';

const PACKS = join(ROOT, 'division-packs');
const catalog = (lang) => JSON.parse(readFileSync(join(ROOT, 'locales', `${lang}.json`), 'utf8')).cli;
const GOOD_AGENT = readFileSync(join(PACKS, 'example-legal', 'agents', 'example-legal-reviewer.md'), 'utf8');

const tmps = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-office-div-'));
  tmps.push(d);
  return d;
};
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const agentText = (name) => GOOD_AGENT.replace(/^name: .*$/m, `name: ${name}`);
const manifest = (id, workers, extra = {}) => ({ id, name: { en: id, id: id }, color: '#112233', desks: Math.max(2, workers.length), workers, ...extra });

/** Buat divisions/<id>/ lengkap. `mutate` boleh mengubah manifest/agen sebelum ditulis. */
function makeDivision(root, id, workers = [`${id}-a`], { man = {}, agents = {}, folder = id, rawManifest } = {}) {
  const dir = join(root, folder);
  mkdirSync(join(dir, 'agents'), { recursive: true });
  writeFileSync(join(dir, 'division.json'), rawManifest ?? JSON.stringify(manifest(id, workers, man)));
  for (const w of workers) {
    if (agents[w] === null) continue;
    writeFileSync(join(dir, 'agents', `${w}.md`), agents[w] ?? agentText(w));
  }
  return dir;
}

const keysOf = (r) => r.errors.map((e) => e.key);

describe('validateDivision', () => {
  const ok = { id: 'legal', name: { en: 'Legal', id: 'Hukum' }, color: '#8a5a44', desks: 3, workers: ['legal-reviewer', 'legal-drafter'], description: 'opsional' };

  it('menerima contoh dari spesifikasi dan mengembalikan salinan bersih', () => {
    const r = validateDivision(ok);
    expect(r).toMatchObject({ ok: true, errors: [] });
    expect(r.value).toEqual(ok);
    expect(r.value).not.toBe(ok);
  });

  it('name boleh string (dipakai untuk en dan id), color dinormalkan ke huruf kecil, description opsional', () => {
    const r = validateDivision({ id: 'ab', name: '  Hukum ', color: '#ABCDEF', desks: 1, workers: ['w1'] });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ id: 'ab', name: { en: 'Hukum', id: 'Hukum' }, color: '#abcdef', desks: 1, workers: ['w1'] });
    expect(validateDivision({ ...ok, name: { en: 'Only EN' } }).value.name).toEqual({ en: 'Only EN', id: 'Only EN' });
  });

  it('batas atas valid: 8 worker, 8 meja, id 32 karakter, nama 40, deskripsi 200', () => {
    const workers = Array.from({ length: 8 }, (_, i) => `w-${i}`);
    const r = validateDivision({ ...ok, id: `a${'b'.repeat(31)}`, name: 'x'.repeat(40), desks: 8, workers, description: 'd'.repeat(200) });
    expect(r.ok, JSON.stringify(r.errors)).toBe(true);
  });

  it.each([null, undefined, [], 'teks', 5, true])('bukan objek: %j', (v) => {
    const r = validateDivision(v);
    expect(r.ok).toBe(false);
    expect(keysOf(r)).toEqual(['divisions.err.notObject']);
    expect(r.value).toBeNull();
  });

  it('field tak dikenal ditolak (termasuk __proto__ dari JSON.parse) dan namanya dibersihkan', () => {
    expect(keysOf(validateDivision({ ...ok, script: 'x' }))).toEqual(['divisions.err.unknownField']);
    const proto = validateDivision(JSON.parse('{"__proto__": {"x": 1}, "id":"legal","name":"L","color":"#000000","desks":1,"workers":["w1"]}'));
    expect(keysOf(proto)).toEqual(['divisions.err.unknownField']);
    const dirty = validateDivision({ ...ok, ['bad‮field\n']: 1 });
    expect(dirty.errors[0].params.field).toBe('badfield');
  });

  it.each([
    ['huruf besar', 'Legal'], ['satu karakter', 'a'], ['33 karakter', `a${'b'.repeat(32)}`], ['diawali angka', '1abc'],
    ['garis bawah', 'a_b'], ['spasi', 'a b'], ['traversal', '../x'], ['kosong', ''], ['bukan teks', 5],
  ])('id tidak valid: %s', (_n, id) => {
    expect(keysOf(validateDivision({ ...ok, id }))).toEqual(['divisions.err.idInvalid']);
  });

  it.each(['dev', 'sales', 'content', 'research', '3d', 'other', 'manager', 'ceo'])('id %s dicadangkan', (id) => {
    expect(keysOf(validateDivision({ ...ok, id }))).toEqual(['divisions.err.idReserved']);
  });

  it('daftar id yang dicadangkan memuat semua divisi bawaan', () => {
    expect(RESERVED_DIVISION_IDS).toEqual(expect.arrayContaining(['dev', 'sales', 'content', 'research', '3d', 'other', 'manager', 'ceo']));
  });

  it.each([
    ['angka', 5, 'nameInvalid'], ['kosong', '', 'nameLength'], ['spasi saja', '   ', 'nameLength'],
    ['41 karakter', 'x'.repeat(41), 'nameLength'], ['karakter kontrol', 'a\nb', 'nameChars'], ['tab', 'a\tb', 'nameChars'],
    ['bidi RLO', 'abc‮def', 'nameChars'], ['bidi isolate', 'a⁦b', 'nameChars'], ['zero-width', 'a​b', 'nameChars'],
    ['objek tanpa en', { id: 'x' }, 'nameInvalid'], ['en bukan teks', { en: 1 }, 'nameInvalid'],
    ['kunci lain', { en: 'a', fr: 'b' }, 'nameField'], ['id 41 karakter', { en: 'a', id: 'x'.repeat(41) }, 'nameLength'],
    ['larik', ['a'], 'nameInvalid'],
  ])('name tidak valid: %s', (_n, name, key) => {
    expect(keysOf(validateDivision({ ...ok, name }))).toEqual([`divisions.err.${key}`]);
  });

  it.each(['#fff', 'ff0000', '#gggggg', '#12345', '#1234567', 'red', 5, null])('color tidak valid: %j', (color) => {
    expect(keysOf(validateDivision({ ...ok, color }))).toEqual(['divisions.err.colorInvalid']);
  });

  it.each([0, 9, 1.5, '3', -1, NaN, null])('desks tidak valid: %j', (desks) => {
    expect(keysOf(validateDivision({ ...ok, desks }))).toEqual(['divisions.err.desksInvalid']);
  });

  it('desks harus >= jumlah workers', () => {
    const r = validateDivision({ ...ok, desks: 1 });
    expect(r.errors).toEqual([{ key: 'divisions.err.desksTooFew', params: { desks: 1, workers: 2 } }]);
    expect(validateDivision({ ...ok, desks: 2 }).ok).toBe(true);
  });

  it.each([
    ['kosong', [], 'workersInvalid'], ['9 worker', Array.from({ length: 9 }, (_, i) => `w${i}`), 'workersInvalid'],
    ['bukan larik', 'w1', 'workersInvalid'], ['elemen bukan teks', [5], 'workerName'], ['huruf besar', ['Worker'], 'workerName'],
    ['traversal', ['../evil'], 'workerName'], ['diawali -', ['-x'], 'workerName'], ['garis miring', ['a/b'], 'workerName'],
    ['duplikat', ['w1', 'w1'], 'workerDuplicate'], ['nama agen bawaan', ['dev-qa'], 'workerReserved'],
    ['nama manager', ['manager'], 'workerReserved'], ['nama 65 karakter', ['a'.repeat(65)], 'workerName'],
  ])('workers tidak valid: %s', (_n, workers, key) => {
    const r = validateDivision({ ...ok, desks: 8, workers });
    expect(keysOf(r)).toEqual([`divisions.err.${key}`]);
  });

  it.each([['201 karakter', 'd'.repeat(201)], ['kontrol', 'a\nb'], ['bidi', 'a‮b'], ['bukan teks', 5]])('description tidak valid: %s', (_n, description) => {
    expect(keysOf(validateDivision({ ...ok, description }))).toEqual(['divisions.err.descriptionInvalid']);
  });

  it('semua kesalahan dikumpulkan sekaligus', () => {
    const r = validateDivision({ id: 'Bad', name: 5, color: 'x', desks: 0, workers: [] });
    expect(keysOf(r).sort()).toEqual(['divisions.err.colorInvalid', 'divisions.err.desksInvalid', 'divisions.err.idInvalid', 'divisions.err.nameInvalid', 'divisions.err.workersInvalid']);
  });

  it('safeText membuang karakter berbahaya dan memotong', () => {
    expect(safeText('a‮b\nc')).toBe('abc');
    expect([...safeText('x'.repeat(100), 10)]).toHaveLength(10);
    expect(DIVISION_LIMITS.nameMax).toBe(40);
  });
});

describe('pesan error dua bahasa', () => {
  const KEYS = [];
  beforeAll(() => {
    // Kumpulkan semua kunci yang bisa muncul dari validator dan penemuan.
    for (const k of Object.keys(catalog('en'))) if (k.startsWith('divisions.') || k === 'start.divisions') KEYS.push(k);
  });

  it('en dan id punya himpunan kunci divisions.* yang sama, tidak ada yang kosong', () => {
    const en = Object.keys(catalog('en')).filter((k) => k.startsWith('divisions.')).sort();
    const id = Object.keys(catalog('id')).filter((k) => k.startsWith('divisions.')).sort();
    expect(id).toEqual(en);
    expect(en.length).toBeGreaterThan(30);
    for (const k of en) {
      expect(catalog('en')[k].length, k).toBeGreaterThan(5);
      expect(catalog('id')[k].length, k).toBeGreaterThan(5);
    }
    expect(KEYS.length).toBeGreaterThan(30);
  });

  it('placeholder di en dan id sama', () => {
    const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
    for (const k of Object.keys(catalog('en')).filter((x) => x.startsWith('divisions.'))) expect(ph(catalog('id')[k]), k).toBe(ph(catalog('en')[k]));
  });

  it('setiap error dari validator punya teks (bukan kunci mentah) di kedua bahasa, tanpa {param} tersisa', () => {
    const cases = [
      null, { id: 'Bad' }, { id: 'dev' }, { id: 'ab', name: 5 }, { id: 'ab', name: 'x'.repeat(50) }, { id: 'ab', name: 'a\nb' },
      { id: 'ab', name: { en: 'a', zz: 1 } }, { id: 'ab', name: 'a', color: 'x' }, { id: 'ab', name: 'a', color: '#000000', desks: 0 },
      { id: 'ab', name: 'a', color: '#000000', desks: 1, workers: ['a', 'b'] }, { id: 'ab', name: 'a', color: '#000000', desks: 3, workers: ['A', 'a', 'a', 'dev-qa'] },
      { id: 'ab', description: 'x'.repeat(300), zzz: 1 },
    ];
    for (const c of cases) {
      for (const e of validateDivision(c).errors) {
        for (const lang of ['en', 'id']) {
          const msg = t(e.key, e.params, lang);
          expect(msg, `${lang} ${e.key}`).not.toBe(e.key);
          expect(msg, `${lang} ${e.key}`).not.toMatch(/\{\w+\}/);
        }
      }
    }
  });
});

describe('discoverDivisions', () => {
  const logs = [];
  const discover = (dir) => discoverDivisions({ dir, log: (l) => logs.push(l) });
  afterEach(() => { logs.length = 0; });

  it('folder tidak ada atau kosong: tanpa divisi dan tanpa error', () => {
    expect(discover(join(mkTmp(), 'nope'))).toEqual({ divisions: [], errors: [] });
    const root = mkTmp();
    writeFileSync(join(root, 'README.md'), '# x');
    writeFileSync(join(root, '.gitkeep'), '');
    mkdirSync(join(root, '.hidden'));
    expect(discover(root)).toEqual({ divisions: [], errors: [] });
  });

  it('divisi valid ditemukan, diurutkan, dan bentuk publiknya tidak membocorkan path atau isi agen', () => {
    const root = mkTmp();
    makeDivision(root, 'zeta', ['zeta-a', 'zeta-b'], { man: { desks: 3, description: 'hai' } });
    makeDivision(root, 'alpha');
    const r = discover(root);
    expect(r.errors).toEqual([]);
    expect(r.divisions.map((d) => d.id)).toEqual(['alpha', 'zeta']);
    const pub = publicDivisions(r);
    expect(pub.divisions[1]).toEqual({ id: 'zeta', name: { en: 'zeta', id: 'zeta' }, color: '#112233', desks: 3, workers: ['zeta-a', 'zeta-b'], source: 'plugin' });
    const json = JSON.stringify(pub);
    expect(json).not.toContain(root);
    expect(json).not.toContain('agentFiles');
    expect(json).not.toContain('Aturan spesialis');
  });

  it('nama folder harus sama dengan id', () => {
    const root = mkTmp();
    makeDivision(root, 'legal', ['legal-a'], { folder: 'hukum' });
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors).toEqual([{ dir: 'hukum', key: 'divisions.err.folderMismatch', params: { id: 'legal' } }]);
    expect(logs.join('\n')).toMatch(/hukum/);
  });

  it('id traversal dan nama worker traversal ditolak oleh skema', () => {
    const root = mkTmp();
    makeDivision(root, 'evil', ['evil-a'], { man: { id: '../evil' } });
    makeDivision(root, 'evil2', ['evil2-a'], { man: { workers: ['../../outside'] } });
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors.map((e) => e.key)).toEqual(expect.arrayContaining(['divisions.err.idInvalid', 'divisions.err.workerName']));
  });

  it('folder divisi berupa symlink/junction ke luar ditolak', () => {
    const outside = mkTmp();
    makeDivision(outside, 'ghost');
    const root = mkTmp();
    symlinkSync(join(outside, 'ghost'), join(root, 'ghost'), 'junction');
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors).toEqual([{ dir: 'ghost', key: 'divisions.err.folderSymlink', params: {} }]);
  });

  it('folder agents/ yang menunjuk ke luar divisi ditolak', () => {
    const outside = mkTmp();
    mkdirSync(join(outside, 'agents'));
    writeFileSync(join(outside, 'agents', 'leak-a.md'), agentText('leak-a'));
    const root = mkTmp();
    const dir = makeDivision(root, 'leak', ['leak-a'], { agents: { 'leak-a': null } });
    rmSync(join(dir, 'agents'), { recursive: true });
    symlinkSync(join(outside, 'agents'), join(dir, 'agents'), 'junction');
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors.map((e) => e.key)).toEqual(['divisions.err.fileOutside']);
  });

  it('symlink file agen atau division.json ke luar ditolak (dilewati bila OS tidak mengizinkan symlink file)', () => {
    const outside = mkTmp();
    writeFileSync(join(outside, 'x.md'), agentText('sym-a'));
    writeFileSync(join(outside, 'm.json'), JSON.stringify(manifest('sym2', ['sym2-a'])));
    const root = mkTmp();
    const d1 = makeDivision(root, 'sym', ['sym-a'], { agents: { 'sym-a': null } });
    const d2 = makeDivision(root, 'sym2', ['sym2-a']);
    try {
      symlinkSync(join(outside, 'x.md'), join(d1, 'agents', 'sym-a.md'), 'file');
      rmSync(join(d2, 'division.json'));
      symlinkSync(join(outside, 'm.json'), join(d2, 'division.json'), 'file');
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') return; // Windows tanpa mode developer
      throw e;
    }
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors.map((e) => `${e.dir}:${e.key}`).sort()).toEqual(['sym2:divisions.err.fileOutside', 'sym:divisions.err.fileOutside']);
  });

  it('division.json lebih dari 16 KB ditolak; tepat 16 KB masih dibaca', () => {
    const root = mkTmp();
    const base = JSON.stringify(manifest('big', ['big-a']));
    makeDivision(root, 'big', ['big-a'], { rawManifest: `${base}${' '.repeat(DISCOVERY_LIMITS.manifestBytes - base.length + 1)}` });
    makeDivision(root, 'edge', ['edge-a'], { rawManifest: `${JSON.stringify(manifest('edge', ['edge-a']))}${' '.repeat(DISCOVERY_LIMITS.manifestBytes - JSON.stringify(manifest('edge', ['edge-a'])).length)}` });
    const r = discover(root);
    expect(r.divisions.map((d) => d.id)).toEqual(['edge']);
    expect(r.errors).toEqual([{ dir: 'big', key: 'divisions.err.jsonTooLarge', params: { file: 'division.json', max: 16 } }]);
  });

  it('file agen lebih dari 64 KB ditolak', () => {
    const root = mkTmp();
    makeDivision(root, 'fat', ['fat-a'], { agents: { 'fat-a': `${agentText('fat-a')}\n${'x'.repeat(DISCOVERY_LIMITS.agentBytes)}` } });
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors[0]).toMatchObject({ dir: 'fat', key: 'divisions.err.agentTooLarge', params: { worker: 'fat-a', max: 64 } });
  });

  it('JSON rusak, division.json hilang, file agen hilang', () => {
    const root = mkTmp();
    makeDivision(root, 'broken', ['broken-a'], { rawManifest: '{ bukan json' });
    mkdirSync(join(root, 'empty'));
    makeDivision(root, 'noagent', ['noagent-a'], { agents: { 'noagent-a': null } });
    const r = discover(root);
    expect(Object.fromEntries(r.errors.map((e) => [e.dir, e.key]))).toEqual({
      broken: 'divisions.err.jsonInvalid', empty: 'divisions.err.manifestMissing', noagent: 'divisions.err.agentMissing',
    });
    expect(JSON.stringify(r.errors)).not.toContain(root);
  });

  it('agen divalidasi dengan validateAgent: name beda, model opus, aturan hilang', () => {
    const root = mkTmp();
    makeDivision(root, 'm1', ['m1-a'], { agents: { 'm1-a': agentText('lain-nama') } });
    makeDivision(root, 'm2', ['m2-a'], { agents: { 'm2-a': agentText('m2-a').replace(/^model: .*$/m, 'model: opus') } });
    makeDivision(root, 'm3', ['m3-a'], { agents: { 'm3-a': agentText('m3-a').replace('STATUS: SELESAI', 'x') } });
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors.map((e) => e.key)).toEqual(['divisions.err.agentInvalid', 'divisions.err.agentInvalid', 'divisions.err.agentInvalid']);
    expect(r.errors[0].params.detail).toMatch(/nama file/);
    expect(r.errors[1].params.detail).toMatch(/opus/);
  });

  it('worker yang bentrok dengan agen bawaan ditolak', () => {
    const root = mkTmp();
    for (const name of ['dev-qa', 'research-analyst']) {
      expect(AGENT_NAMES).toContain(name);
      makeDivision(root, `x-${name}`, [name]);
    }
    const r = discover(root);
    expect(r.divisions).toEqual([]);
    expect(r.errors.map((e) => e.key)).toEqual(['divisions.err.workerReserved', 'divisions.err.workerReserved']);
  });

  it('worker yang bentrok dengan divisi lain: yang urutan awal menang, yang kedua ditolak', () => {
    const root = mkTmp();
    makeDivision(root, 'aaa', ['shared-w']);
    makeDivision(root, 'bbb', ['shared-w', 'bbb-b']);
    const r = discover(root);
    expect(r.divisions.map((d) => d.id)).toEqual(['aaa']);
    expect(r.errors).toEqual([{ dir: 'bbb', key: 'divisions.err.workerTaken', params: { worker: 'shared-w', other: 'aaa' } }]);
  });

  it('maksimal 12 divisi; sisanya dicatat dan dilewati', () => {
    const root = mkTmp();
    for (let i = 0; i < 14; i++) makeDivision(root, `d${String(i).padStart(2, '0')}`);
    const r = discover(root);
    expect(r.divisions).toHaveLength(DISCOVERY_LIMITS.maxDivisions);
    expect(r.divisions.at(-1).id).toBe('d11');
    expect(r.errors.map((e) => `${e.dir}:${e.key}`)).toEqual(['d12:divisions.err.tooMany', 'd13:divisions.err.tooMany']);
  });

  it('jumlah folder yang diperiksa dibatasi', () => {
    const root = mkTmp();
    for (let i = 0; i < DISCOVERY_LIMITS.maxFolders + 5; i++) mkdirSync(join(root, `f${String(i).padStart(3, '0')}`));
    const r = discover(root);
    expect(r.errors.at(-1).key).toBe('divisions.err.tooManyFolders');
    expect(r.errors.length).toBe(DISCOVERY_LIMITS.maxFolders + 1);
  });

  it('isi paket tidak pernah dieksekusi', () => {
    const root = mkTmp();
    const dir = makeDivision(root, 'inert');
    writeFileSync(join(dir, 'evil.mjs'), "globalThis.__aiOfficeDivisionPwned = true; throw new Error('dijalankan');");
    writeFileSync(join(dir, 'index.js'), "globalThis.__aiOfficeDivisionPwned = true;");
    expect(discover(root).divisions).toHaveLength(1);
    expect(globalThis.__aiOfficeDivisionPwned).toBeUndefined();
    const src = readFileSync(join(ROOT, 'server', 'divisions.js'), 'utf8').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\beval\s*\(|new Function|child_process/);
  });

  it('log server memakai bahasa server dan tidak memuat path absolut', () => {
    const root = mkTmp();
    makeDivision(root, 'oops', ['oops-a'], { rawManifest: 'x' });
    discover(root);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^\[divisions\] oops: /);
    expect(logs[0]).not.toContain(root);
  });
});

describe('GET /api/divisions', () => {
  const closers = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()();
    delete process.env.AI_OFFICE_LANG;
  });
  const start = async (opts) => {
    const s = await startApp(opts);
    closers.push(s.close);
    return s;
  };

  it('tanpa opsi divisions: daftar kosong', async () => {
    const s = await start();
    const r = await http(s.port, '/api/divisions');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, divisions: [], errors: [] });
    expect(r.headers['content-type']).toMatch(/application\/json/);
  });

  it('mengirim divisi plugin dan error sesuai kontrak, pesan mengikuti bahasa server, tanpa path', async () => {
    const root = mkTmp();
    makeDivision(root, 'legal', ['legal-a', 'legal-b'], { man: { desks: 3, name: { en: 'Legal', id: 'Hukum' } } });
    makeDivision(root, 'rusak', ['rusak-a'], { rawManifest: '{' });
    const result = discoverDivisions({ dir: root });
    const s = await start({ divisions: result });
    process.env.AI_OFFICE_LANG = 'en';
    const en = await http(s.port, '/api/divisions');
    expect(en.json.divisions).toEqual([{ id: 'legal', name: { en: 'Legal', id: 'Hukum' }, color: '#112233', desks: 3, workers: ['legal-a', 'legal-b'], source: 'plugin' }]);
    expect(en.json.errors).toEqual([{ dir: 'rusak', message: 'division.json is not valid JSON.' }]);
    process.env.AI_OFFICE_LANG = 'id';
    const id = await http(s.port, '/api/divisions');
    expect(id.json.errors).toEqual([{ dir: 'rusak', message: 'division.json bukan JSON yang valid.' }]);
    expect(en.body).not.toContain(root);
  });

  it('hanya GET', async () => {
    const s = await start();
    const r = await http(s.port, '/api/divisions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: {} });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe('GET');
  });

  it('mode token: wajib login seperti /api/usage', async () => {
    const token = randomToken();
    const s = await start({ token, divisions: { divisions: [], errors: [] } });
    const denied = await http(s.port, '/api/divisions');
    expect(denied.status).toBe(401);
    const bad = await http(s.port, '/api/divisions', { headers: { Authorization: 'Bearer salah' } });
    expect(bad.status).toBe(401);
    const good = await http(s.port, '/api/divisions', { headers: { Authorization: `Bearer ${token}` } });
    expect(good.status).toBe(200);
    expect(good.json.ok).toBe(true);
    expect((await http(s.port, '/api/usage')).status).toBe(401);
  });

  it('Host palsu ditolak seperti endpoint lain', async () => {
    const s = await start();
    const r = await http(s.port, '/api/divisions', { headers: { Host: 'evil.example.com' } });
    expect(r.status).toBe(403);
  });
});

describe('starter pack di division-packs/', () => {
  const packIds = readdirSync(PACKS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  it('ada tepat empat paket yang dijanjikan', () => {
    expect(packIds).toEqual(['content-team', 'dev-team', 'example-legal', 'research-team']);
  });

  it('semuanya lolos penemuan tanpa error (urutan, batas, bentrok nama antar paket)', () => {
    const r = discoverDivisions({ dir: PACKS });
    expect(r.errors).toEqual([]);
    expect(r.divisions.map((d) => d.id).sort()).toEqual(packIds);
  });

  it.each(packIds)('%s: division.json valid, id = nama folder, worker berawalan id, jumlah file agen cocok', (id) => {
    const raw = JSON.parse(readFileSync(join(PACKS, id, 'division.json'), 'utf8'));
    const v = validateDivision(raw);
    expect(v.errors).toEqual([]);
    expect(v.value.id).toBe(id);
    expect(v.value.workers.length).toBeGreaterThanOrEqual(2);
    expect(v.value.workers.length).toBeLessThanOrEqual(3);
    for (const w of v.value.workers) expect(w.startsWith(`${id}-`), w).toBe(true);
    expect(readdirSync(join(PACKS, id, 'agents')).sort()).toEqual(v.value.workers.map((w) => `${w}.md`).sort());
  });

  const agentFiles = packIds.flatMap((id) => readdirSync(join(PACKS, id, 'agents')).map((f) => [`${id}/${f}`, join(PACKS, id, 'agents', f), f]));
  it.each(agentFiles)('%s: gaya dan aturan spesialis sama dengan agents/*.md', (_n, path, f) => {
    const text = readFileSync(path, 'utf8');
    const { errors, data } = validateAgent(f, text);
    expect(errors).toEqual([]);
    expect(Object.keys(data).sort()).toEqual(['description', 'model', 'name', 'tools']);
    expect(['haiku', 'sonnet']).toContain(data.model);
    expect(data.tools).not.toMatch(/\b(Agent|Task)\b/);
    expect(data.description).toMatch(/Gunakan/);
    expect(AGENT_NAMES).not.toContain(data.name);
    const { body } = parseAgentFile(text);
    for (const h of ['## Tanggung jawab', '## Cara kerja', '## Di luar bidangmu', '## Aturan spesialis (wajib)', '## Format laporan ke manajer']) expect(body).toContain(h);
  });

  it('repo ini tidak membawa divisi aktif (divisions/ hanya README.md dan .gitkeep)', () => {
    expect(readdirSync(join(ROOT, 'divisions')).sort()).toEqual(['.gitkeep', 'README.md']);
    expect(discoverDivisions({ dir: join(ROOT, 'divisions') })).toEqual({ divisions: [], errors: [] });
    expect(readFileSync(join(ROOT, '.gitignore'), 'utf8')).not.toMatch(/^\/?divisions\/?\s*$/m);
  });
});

describe('event hook untuk worker plugin', () => {
  const common = { session_id: 's1', transcript_path: 't.jsonl', cwd: '/x', permission_mode: 'default' };
  const WORKERS = ['legal-reviewer', 'acme-planner', 'dev-team-builder', 'research-team-synthesizer'];

  it.each(WORKERS)('mapHookToEvents menerima %s (assign, working, report)', async (w) => {
    const { mapHookToEvents } = await import('../shared/hookMapping.js');
    const { normalizeEvent } = await import('../shared/events.js');
    const assign = mapHookToEvents({ ...common, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: w, description: 'tugas' } });
    expect(assign[0]).toMatchObject({ type: 'assign', from: 'manager', to: w });
    const start = mapHookToEvents({ ...common, hook_event_name: 'SubagentStart', agent_id: 'a', agent_type: w });
    expect(start[0]).toMatchObject({ type: 'working', from: w });
    const post = mapHookToEvents({
      ...common, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_input: { subagent_type: w, description: 'x' },
      tool_response: { content: [{ type: 'text', text: 'STATUS: SELESAI\nok' }] },
    });
    expect(post[0]).toMatchObject({ from: w });
    for (const e of [assign[0], start[0], post[0]]) expect(normalizeEvent(e).ok, JSON.stringify(e)).toBe(true);
  });

  it('POST /api/events menerima nama worker plugin', async () => {
    const s = await startApp({ dedupWindowMs: 0 });
    try {
      const r = await http(s.port, '/api/events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { type: 'assign', from: 'manager', to: 'legal-reviewer', message: 'tinjau kontrak' },
      });
      expect(r.status).toBe(202);
      const got = await http(s.port, '/api/events');
      expect(got.json.events.at(-1)).toMatchObject({ type: 'assign', to: 'legal-reviewer' });
    } finally {
      await s.close();
    }
  });
});
