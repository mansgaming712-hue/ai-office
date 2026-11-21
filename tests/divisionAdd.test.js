// npm run division:add, agents:install, agents:validate untuk divisi plugin.
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { discoverDivisions } from '../server/divisions.js';
import { addDivision, parseArgs, planDivision, renameTokens } from '../scripts/division-add.mjs';
import { ROOT, cleanEnv, runNode } from './helpers/testkit.js';

const PACKS = join(ROOT, 'division-packs');
const ADD = join(ROOT, 'scripts', 'division-add.mjs');
const tmps = [];
const mkTmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'ai-office-add-'));
  tmps.push(d);
  return d;
};
afterAll(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const listFiles = (dir) => readdirSync(dir, { recursive: true }).map((p) => p.replaceAll('\\', '/')).sort();
const snapshot = (dir) => Object.fromEntries(listFiles(dir).filter((f) => f.includes('.')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

describe('parseArgs', () => {
  it('nama, --from (dua bentuk), --dry-run', () => {
    expect(parseArgs(['legal'])).toMatchObject({ name: 'legal', from: null, dryRun: false, error: null });
    expect(parseArgs(['legal', '--from', 'dev-team', '--dry-run'])).toMatchObject({ name: 'legal', from: 'dev-team', dryRun: true, error: null });
    expect(parseArgs(['--from=dev-team', 'x1'])).toMatchObject({ name: 'x1', from: 'dev-team' });
  });
  it('argumen salah menghasilkan error pemakaian', () => {
    expect(parseArgs([]).error).toBe('divisions.add.nameMissing');
    expect(parseArgs(['a1', 'b2']).error).toBe('divisions.add.usage');
    expect(parseArgs(['a1', '--from']).error).toBe('divisions.add.usage');
    expect(parseArgs(['a1', '--from', '--dry-run']).error).toBe('divisions.add.usage');
    expect(parseArgs(['a1', '--force']).error).toBe('divisions.add.usage');
  });
});

describe('addDivision: kerangka', () => {
  it('membuat division.json dan <nama>-worker.md yang lolos penemuan server', () => {
    const root = mkTmp();
    const r = addDivision({ name: 'legal', divisionsDir: root });
    expect(r).toEqual({ ok: true, dryRun: false, id: 'legal', files: ['divisions/legal/division.json', 'divisions/legal/agents/legal-worker.md'] });
    expect(listFiles(join(root, 'legal'))).toEqual(['agents', 'agents/legal-worker.md', 'division.json']);
    const found = discoverDivisions({ dir: root });
    expect(found.errors).toEqual([]);
    expect(found.divisions).toHaveLength(1);
    expect(found.divisions[0]).toMatchObject({ id: 'legal', workers: ['legal-worker'], desks: 2, name: { en: 'Legal', id: 'Legal' } });
    expect(JSON.parse(readFileSync(join(root, 'legal', 'division.json'), 'utf8')).color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('nama dengan tanda hubung: judul dan worker mengikuti', () => {
    const root = mkTmp();
    expect(addDivision({ name: 'tim-hukum-2', divisionsDir: root }).ok).toBe(true);
    const d = discoverDivisions({ dir: root }).divisions[0];
    expect(d.name.en).toBe('Tim Hukum 2');
    expect(d.workers).toEqual(['tim-hukum-2-worker']);
  });

  it.each(['Legal', 'a', 'dev', 'sales', 'content', 'research', '3d', 'other', 'manager', 'ceo', '../x', 'a/b', 'a\\b', 'a b', '', '-ab', 'a_b', 'x'.repeat(33), '.hidden'])(
    'nama tidak valid ditolak dan tidak ada yang dibuat: %j',
    (name) => {
      const root = mkTmp();
      const r = addDivision({ name, divisionsDir: join(root, 'divisions') });
      expect(r.ok).toBe(false);
      expect(r.error.key).toMatch(/^divisions\.err\.id(Invalid|Reserved)$/);
      expect(existsSync(join(root, 'divisions'))).toBe(false);
      expect(listFiles(root)).toEqual([]);
    },
  );

  it('menolak folder yang sudah ada dan tidak pernah menimpa file', () => {
    const root = mkTmp();
    expect(addDivision({ name: 'legal', divisionsDir: root }).ok).toBe(true);
    writeFileSync(join(root, 'legal', 'division.json'), 'EDITAN PENGGUNA');
    const before = snapshot(root);
    const r = addDivision({ name: 'legal', divisionsDir: root });
    expect(r).toEqual({ ok: false, error: { key: 'divisions.add.exists', params: { id: 'legal' } } });
    expect(snapshot(root)).toEqual(before);
    // juga untuk folder kosong dan --dry-run
    mkdirSync(join(root, 'kosong'));
    expect(addDivision({ name: 'kosong', divisionsDir: root }).error.key).toBe('divisions.add.exists');
    expect(addDivision({ name: 'legal', divisionsDir: root, dryRun: true }).error.key).toBe('divisions.add.exists');
  });

  it('--dry-run mencantumkan file tetapi tidak menulis apa pun (folder induk pun tidak dibuat)', () => {
    const root = mkTmp();
    const dir = join(root, 'divisions');
    const r = addDivision({ name: 'legal', divisionsDir: dir, dryRun: true });
    expect(r).toEqual({ ok: true, dryRun: true, id: 'legal', files: ['divisions/legal/division.json', 'divisions/legal/agents/legal-worker.md'] });
    expect(existsSync(dir)).toBe(false);
  });

  it('bentrok nama worker dengan divisi yang sudah ada ditolak', () => {
    const root = mkTmp();
    mkdirSync(join(root, 'foo', 'agents'), { recursive: true });
    expect(addDivision({ name: 'foo', divisionsDir: root }).error.key).toBe('divisions.add.exists');
    // divisi "ab" punya worker "cd-worker" (nama bebas), lalu "cd" akan menghasilkan "cd-worker" juga
    expect(addDivision({ name: 'ab', divisionsDir: root }).ok).toBe(true);
    const man = join(root, 'ab', 'division.json');
    const j = JSON.parse(readFileSync(man, 'utf8'));
    j.workers = ['cd-worker'];
    writeFileSync(man, JSON.stringify(j));
    rmSync(join(root, 'ab', 'agents', 'ab-worker.md'));
    writeFileSync(join(root, 'ab', 'agents', 'cd-worker.md'), planDivision({ name: 'cd', divisionsDir: join(root, 'nada') }).files[1].text);
    const r = addDivision({ name: 'cd', divisionsDir: root });
    expect(r).toEqual({ ok: false, error: { key: 'divisions.err.workerTaken', params: { worker: 'cd-worker', other: 'ab' } } });
    expect(existsSync(join(root, 'cd'))).toBe(false);
  });
});

describe('addDivision: --from <starter>', () => {
  it.each(['dev-team', 'content-team', 'research-team', 'example-legal'])('%s: salinan valid dengan id dan awalan worker baru', (starter) => {
    const root = mkTmp();
    const before = snapshot(PACKS);
    const r = addDivision({ name: 'acme', from: starter, divisionsDir: root });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const found = discoverDivisions({ dir: root });
    expect(found.errors).toEqual([]);
    const d = found.divisions[0];
    expect(d.id).toBe('acme');
    expect(d.workers.length).toBeGreaterThanOrEqual(2);
    for (const w of d.workers) expect(w.startsWith('acme-')).toBe(true);
    // tidak ada sisa nama starter di file hasil
    for (const f of d.agentFiles) {
      expect(f.text).not.toContain(starter);
      expect(f.text).toContain(`name: ${f.worker}\n`);
    }
    expect(JSON.stringify(readFileSync(join(root, 'acme', 'division.json'), 'utf8'))).not.toContain(starter);
    expect(snapshot(PACKS)).toEqual(before); // starter tidak berubah
    expect(listFiles(join(root, 'acme', 'agents')).sort()).toEqual(d.workers.map((w) => `${w}.md`).sort());
  });

  it('dev-team: rujukan antarworker di isi agen ikut diganti, rujukan ke agen bawaan tidak', () => {
    const root = mkTmp();
    addDivision({ name: 'acme', from: 'dev-team', divisionsDir: root });
    const planner = readFileSync(join(root, 'acme', 'agents', 'acme-planner.md'), 'utf8');
    expect(planner).toContain('`acme-builder`');
    expect(planner).toContain('`acme-reviewer`');
    expect(planner).toContain('`dev-security`'); // agen bawaan tetap
    const man = JSON.parse(readFileSync(join(root, 'acme', 'division.json'), 'utf8'));
    expect(man.workers).toEqual(['acme-planner', 'acme-builder', 'acme-reviewer']);
    expect(man.name).toEqual({ en: 'Acme', id: 'Acme' });
    expect(man.color).toBe('#3b7fb6');
  });

  it('dua salinan dari starter yang sama tidak bentrok; salinan ketiga dengan nama sama ditolak', () => {
    const root = mkTmp();
    expect(addDivision({ name: 'one', from: 'research-team', divisionsDir: root }).ok).toBe(true);
    expect(addDivision({ name: 'two', from: 'research-team', divisionsDir: root }).ok).toBe(true);
    expect(addDivision({ name: 'one', from: 'research-team', divisionsDir: root }).error.key).toBe('divisions.add.exists');
    const found = discoverDivisions({ dir: root });
    expect(found.errors).toEqual([]);
    expect(found.divisions.map((d) => d.id)).toEqual(['one', 'two']);
  });

  it('--dry-run dengan --from tidak menulis apa pun dan mencantumkan semua file', () => {
    const root = mkTmp();
    const r = addDivision({ name: 'acme', from: 'dev-team', dryRun: true, divisionsDir: join(root, 'd') });
    expect(r.files).toEqual([
      'divisions/acme/division.json', 'divisions/acme/agents/acme-planner.md', 'divisions/acme/agents/acme-builder.md', 'divisions/acme/agents/acme-reviewer.md',
    ]);
    expect(listFiles(root)).toEqual([]);
  });

  it.each(['nope', '../division-packs', '..', 'dev-team/../dev-team', 'DEV-TEAM', 'a\\b', ''])('starter tidak ada atau tidak sah: %j', (from) => {
    const root = mkTmp();
    const r = addDivision({ name: 'acme', from, divisionsDir: root });
    expect(r.ok).toBe(false);
    expect(r.error.key).toBe('divisions.add.starterInvalid');
    expect(listFiles(root)).toEqual([]);
  });

  it('starter rusak dilaporkan alasannya dan tidak menulis apa pun', () => {
    const packs = mkTmp();
    mkdirSync(join(packs, 'bad', 'agents'), { recursive: true });
    writeFileSync(join(packs, 'bad', 'division.json'), '{');
    const root = mkTmp();
    const r = addDivision({ name: 'acme', from: 'bad', divisionsDir: root, packsDir: packs });
    expect(r.error.key).toBe('divisions.add.starterInvalid');
    expect(r.error.params.reason).toMatch(/JSON/);
    expect(listFiles(root)).toEqual([]);
  });

  it('nama yang menghasilkan id dicadangkan tetap ditolak walau memakai --from', () => {
    expect(addDivision({ name: 'dev', from: 'dev-team', divisionsDir: mkTmp() }).error.key).toBe('divisions.err.idReserved');
  });

  it('renameTokens hanya mengganti kata utuh kebab-case', () => {
    const map = new Map([['dev-team', 'acme'], ['dev-team-planner', 'acme-planner']]);
    expect(renameTokens('`dev-team-planner` di dev-team, bukan dev-teams atau my-dev-team atau dev-team-x', map))
      .toBe('`acme-planner` di acme, bukan dev-teams atau my-dev-team atau dev-team-x');
  });
});

describe('CLI division:add', () => {
  const run = (args, lang = 'en') => {
    const root = mkTmp();
    const env = cleanEnv({ AI_OFFICE_LANG: lang, AI_OFFICE_DIVISIONS_DIR: join(root, 'divisions') });
    return runNode([ADD, ...args], { env }).then((r) => ({ ...r, root }));
  };

  it('membuat divisi dan memberi petunjuk selanjutnya (en)', async () => {
    const r = await run(['legal']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Division "legal" created \(2 files\):/);
    expect(r.out).toContain('divisions/legal/agents/legal-worker.md');
    expect(r.out).toMatch(/Next: edit the files/);
    expect(r.out).not.toContain(r.root);
    expect(existsSync(join(r.root, 'divisions', 'legal', 'division.json'))).toBe(true);
  });

  it('--from dan --dry-run (id)', async () => {
    const r = await run(['legal', '--from', 'example-legal', '--dry-run'], 'id');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\[dry-run\] Tidak ada yang ditulis\. Divisi "legal" akan membuat 3 file:/);
    expect(r.out).toContain('divisions/legal/agents/legal-reviewer.md');
    expect(existsSync(join(r.root, 'divisions'))).toBe(false);
  });

  it('nama tidak valid: exit 1, pesan di stderr dua bahasa', async () => {
    const en = await run(['Dev']);
    expect(en.code).toBe(1);
    expect(en.err).toMatch(/"id" must be 2-32 characters/);
    const id = await run(['dev'], 'id');
    expect(id.code).toBe(1);
    expect(id.err).toMatch(/id "dev" dicadangkan/);
  });

  it('tanpa nama atau argumen salah: exit 2 dan pemakaian', async () => {
    const none = await run([]);
    expect(none.code).toBe(2);
    expect(none.err).toMatch(/Missing division name\./);
    expect(none.err).toMatch(/Usage: npm run division:add/);
    const odd = await run(['a1', '--bogus'], 'id');
    expect(odd.code).toBe(2);
    expect(odd.err).toMatch(/Pemakaian: npm run division:add/);
  });

  it('folder sudah ada: exit 1 dan isinya tidak berubah', async () => {
    const root = mkTmp();
    const env = cleanEnv({ AI_OFFICE_LANG: 'en', AI_OFFICE_DIVISIONS_DIR: root });
    expect((await runNode([ADD, 'legal'], { env })).code).toBe(0);
    const before = snapshot(root);
    const again = await runNode([ADD, 'legal'], { env });
    expect(again.code).toBe(1);
    expect(again.err).toMatch(/already exists\. Nothing was changed\./);
    expect(snapshot(root)).toEqual(before);
  });
});

describe('agents:install dan agents:validate dengan divisi plugin', () => {
  const INSTALL = join(ROOT, 'scripts', 'install-agents.mjs');
  const VALIDATE = join(ROOT, 'scripts', 'validate-agents.mjs');
  const setup = () => {
    const home = mkTmp();
    const divs = join(home, 'divisions');
    return { home, divs, env: cleanEnv({ AI_OFFICE_LANG: 'en', HOME: home, USERPROFILE: home, AI_OFFICE_DIVISIONS_DIR: divs }), agents: join(home, '.claude', 'agents') };
  };

  it('install menyalin agen divisi valid; validate lulus; salinan yang berubah terdeteksi', async () => {
    const s = setup();
    addDivision({ name: 'acme', from: 'dev-team', divisionsDir: s.divs });
    const inst = await runNode([INSTALL, '--allow-risky-tools'], { env: s.env, timeoutMs: 30000 });
    expect(inst.code, inst.err).toBe(0);
    for (const w of ['acme-planner', 'acme-builder', 'acme-reviewer']) {
      expect(readFileSync(join(s.agents, `${w}.md`), 'utf8')).toBe(readFileSync(join(s.divs, 'acme', 'agents', `${w}.md`), 'utf8'));
    }
    expect(existsSync(join(s.agents, 'dev-qa.md'))).toBe(true);
    expect(inst.out).toMatch(/Done: 20 copied, 0 already identical, 0 skipped\./);

    const val = await runNode([VALIDATE], { env: s.env, timeoutMs: 30000 });
    expect(val.code, val.out).toBe(0);
    expect(val.out).toMatch(/Plugin divisions \(1 valid\)/);
    expect(val.out).toContain('✓ acme-planner');
    expect(val.out).toMatch(/Semua 20 agen valid, unik, dan terpasang\./);

    const again = await runNode([INSTALL, '--allow-risky-tools'], { env: s.env, timeoutMs: 30000 });
    expect(again.out).toMatch(/Done: 0 copied, 20 already identical, 0 skipped\./);

    writeFileSync(join(s.agents, 'acme-builder.md'), `${readFileSync(join(s.agents, 'acme-builder.md'), 'utf8')}\nubahan`);
    const drift = await runNode([VALIDATE], { env: s.env, timeoutMs: 30000 });
    expect(drift.code).toBe(1);
    expect(drift.out).toMatch(/acme-builder\.md berbeda dengan salinan di repo/);
  }, 60000);

  it('divisi tidak valid dilewati (peringatan di stderr, install tetap lulus), validate gagal', async () => {
    const s = setup();
    mkdirSync(join(s.divs, 'broken'), { recursive: true });
    writeFileSync(join(s.divs, 'broken', 'division.json'), '{ rusak');
    addDivision({ name: 'good', divisionsDir: s.divs });
    const inst = await runNode([INSTALL], { env: s.env, timeoutMs: 30000 });
    expect(inst.code).toBe(0);
    expect(existsSync(join(s.agents, 'good-worker.md'))).toBe(true);
    expect(existsSync(join(s.agents, 'broken-worker.md'))).toBe(false);
    expect(inst.err).toMatch(/skipped division "broken": division\.json is not valid JSON\./);
    expect(inst.err).not.toContain(s.home);
    const val = await runNode([VALIDATE], { env: s.env, timeoutMs: 30000 });
    expect(val.code).toBe(1);
    expect(val.out).toMatch(/✗ broken: division\.json is not valid JSON\./);
  }, 60000);

  it('tanpa divisi plugin perilaku lama tidak berubah (17 agen bawaan)', async () => {
    const s = setup();
    const inst = await runNode([INSTALL], { env: s.env, timeoutMs: 30000 });
    expect(inst.code).toBe(0);
    expect(inst.out).toMatch(/Done: 17 copied/);
    expect(inst.err).toBe('');
    const val = await runNode([VALIDATE], { env: s.env, timeoutMs: 30000 });
    expect(val.code).toBe(0);
    expect(val.out).toMatch(/Semua 17 agen valid/);
  }, 60000);
});
