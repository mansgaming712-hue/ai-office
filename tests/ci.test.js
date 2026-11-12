// Pemeriksaan statis .github/workflows/ci.yml dan .gitattributes (tidak ada yang dijalankan).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { ROOT } from './helpers/testkit.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const WF_TEXT = read('.github/workflows/ci.yml');
const wf = YAML.parse(WF_TEXT);
const steps = (job) => wf.jobs[job].steps;
const runs = (job) => steps(job).map((s) => s.run).filter(Boolean);
const THREE_OS = ['macos-latest', 'ubuntu-latest', 'windows-latest'];

describe('ci.yml', () => {
  it('jalan pada push dan pull_request ke main', () => {
    expect(wf.on.push.branches).toEqual(['main']);
    expect(wf.on.pull_request.branches).toEqual(['main']);
  });

  it('izin hanya baca, tanpa secret, tanpa pull_request_target', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    for (const j of Object.values(wf.jobs)) expect(j.permissions).toBeUndefined();
    expect(WF_TEXT).not.toMatch(/secrets\./);
    expect(WF_TEXT).not.toMatch(/pull_request_target/);
  });

  it('concurrency membatalkan run lama di ref yang sama', () => {
    expect(wf.concurrency['cancel-in-progress']).toBe(true);
    expect(wf.concurrency.group).toContain('github.ref');
  });

  it('job test: matrix 3 OS, fail-fast false, timeout, Node minimum toolchain dan LTS', () => {
    const j = wf.jobs.test;
    expect(j.strategy['fail-fast']).toBe(false);
    expect([...j.strategy.matrix.os].sort()).toEqual(THREE_OS);
    // Node minimum satu angka untuk semuanya: 22.12 (sama dengan engines.node).
    expect([...j.strategy.matrix.node].sort()).toEqual(['22.12', 'lts/*']);
    expect(j['timeout-minutes']).toBeGreaterThan(0);
  });

  it('hanya satu job (test); tidak ada lagi job runtime-min Node 20.12', () => {
    expect(Object.keys(wf.jobs)).toEqual(['test']);
    expect(WF_TEXT).not.toMatch(/20\.12|runtime-min/);
  });

  it('job test: checkout, setup-node dengan cache npm, lalu npm ci, build, test', () => {
    const uses = steps('test').map((s) => s.uses).filter(Boolean);
    expect(uses[0]).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(uses[1]).toMatch(/^actions\/setup-node@[0-9a-f]{40}$/);
    const setup = steps('test').find((s) => /setup-node/.test(s.uses ?? ''));
    expect(setup.with.cache).toBe('npm');
    expect(runs('test')).toEqual(['npm ci', 'npm run build', 'npm test']);
  });

  it('semua action dipin ke SHA commit 40 karakter dengan komentar tag, tanpa kredensial git tersimpan', () => {
    for (const line of WF_TEXT.split('\n').filter((l) => /^\s*uses:/.test(l))) {
      expect(line).toMatch(/uses: actions\/[\w-]+@[0-9a-f]{40} # v\d+/);
    }
    for (const j of Object.values(wf.jobs)) {
      for (const s of j.steps) {
        if (s.uses) expect(s.uses).toMatch(/^actions\/[\w-]+@[0-9a-f]{40}$/);
      }
      const co = j.steps.find((s) => /checkout/.test(s.uses ?? ''));
      expect(co.with['persist-credentials']).toBe(false);
    }
  });

  it('agents:validate tidak dijalankan (memeriksa ~/.claude/agents yang tidak ada di runner)', () => {
    const allRuns = Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.run ?? ''));
    expect(allRuns.join('\n')).not.toMatch(/agents:validate|validate-agents/);
  });

  it('script smoke ada di package.json', () => {
    expect(JSON.parse(read('package.json')).scripts.smoke).toBe('node scripts/smoke.mjs');
  });
});

describe('.gitattributes', () => {
  const lines = read('.gitattributes')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));

  it('mengunci akhiran baris LF untuk semua file dan untuk .ps1/.vbs/.sh', () => {
    expect(lines).toContain('* text=auto eol=lf');
    for (const ext of ['ps1', 'vbs', 'sh']) expect(lines).toContain(`*.${ext} text eol=lf`);
  });

  it('sejalan dengan deploy/.gitattributes (sama-sama LF)', () => {
    expect(read('deploy/.gitattributes')).toMatch(/^\* text eol=lf$/m);
  });
});
