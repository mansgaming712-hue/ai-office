import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AGENT_NAMES, DIVISIONS } from '../shared/roster.js';
import {
  REPO_AGENTS_DIR, USER_AGENTS_DIR, agentNameOf, parseAgentFile, readAgentDir, validateAgent,
} from '../scripts/agent-files.mjs';

const repoFiles = readAgentDir(REPO_AGENTS_DIR);

describe('file agen di repo (agents/)', () => {
  it('semua agen sesuai roster (minimal 13 agen awal), tidak ada yang terlewat atau berlebih', () => {
    const names = repoFiles.map((f) => agentNameOf(f.text)).sort();
    expect(names).toEqual([...AGENT_NAMES].sort());
    expect(AGENT_NAMES.length).toBeGreaterThanOrEqual(13);
  });

  it('nama unik', () => {
    const names = repoFiles.map((f) => agentNameOf(f.text));
    expect(new Set(names).size).toBe(names.length);
  });

  it.each(repoFiles.map((f) => [f.fileName, f]))('%s: frontmatter valid dan aturan spesialis lengkap', (_n, f) => {
    const { errors, data } = validateAgent(f.fileName, f.text);
    expect(errors).toEqual([]);
    expect(Object.keys(data).sort()).toEqual(['description', 'model', 'name', 'tools']);
    expect(['haiku', 'sonnet']).toContain(data.model);
    expect(data.tools).not.toMatch(/\b(Agent|Task)\b/);
    expect(data.description).toMatch(/Gunakan/);
  });

  it('pembagian divisi sesuai permintaan (divisi awal tetap utuh; divisi baru boleh ditambah)', () => {
    expect(Object.fromEntries(DIVISIONS.map((d) => [d.id, d.agents.length]))).toMatchObject({ dev: 7, sales: 3, content: 2, research: 1 });
  });
});

describe('validator menangkap kesalahan', () => {
  const good = repoFiles.find((f) => f.fileName === 'dev-qa.md').text;

  it('frontmatter rusak atau hilang', () => {
    expect(validateAgent('dev-qa.md', 'tanpa frontmatter').errors[0]).toMatch(/frontmatter/);
    expect(validateAgent('dev-qa.md', '---\nname: [rusak\n---\nisi').errors[0]).toMatch(/YAML/);
  });

  it('nama tidak sama dengan file, tool terlarang, aturan hilang', () => {
    expect(validateAgent('lain.md', good).errors.join()).toMatch(/nama file/);
    expect(validateAgent('dev-qa.md', good.replace('tools: Read', 'tools: Agent, Read')).errors.join()).toMatch(/Agent/);
    expect(validateAgent('dev-qa.md', good.replace('Jangan mencoba memanggil agen lain', '')).errors.join()).toMatch(/frasa hilang/);
    expect(validateAgent('dev-qa.md', good.replace(/description: .*/, 'description: pendek')).errors.join()).toMatch(/terlalu pendek/);
  });

  it('model wajib ada dan hanya haiku atau sonnet (opus dan lainnya ditolak)', () => {
    const withModel = (m) => good.replace(/^model: .*\r?\n/m, '').replace(/^(name: .*)$/m, m === null ? '$1' : `$1\nmodel: ${m}`);
    expect(validateAgent('dev-qa.md', withModel(null)).errors.join()).toMatch(/field "model" wajib/);
    expect(validateAgent('dev-qa.md', withModel('opus')).errors.join()).toMatch(/model "opus" tidak diizinkan/);
    expect(validateAgent('dev-qa.md', withModel('gpt-4')).errors.join()).toMatch(/tidak diizinkan/);
    expect(validateAgent('dev-qa.md', withModel('claude-opus-4')).errors.join()).toMatch(/tidak diizinkan/);
    for (const m of ['haiku', 'sonnet']) expect(validateAgent('dev-qa.md', withModel(m)).errors.join(), m).not.toMatch(/model/);
  });

  it('nama boleh diawali angka (divisi 3D), tetapi tidak "-" atau huruf besar', () => {
    const named = (n) => good.replace(/^name: .*$/m, `name: ${n}`);
    for (const n of ['3d-modeler', '3d-materials', '3d-animator', '3d-render']) {
      expect(validateAgent(`${n}.md`, named(n)).errors.join(), n).not.toMatch(/kebab-case|nama file/);
    }
    expect(validateAgent('-x.md', named('-x')).errors.join()).toMatch(/kebab-case/);
    expect(validateAgent('Dev-qa.md', named('Dev-qa')).errors.join()).toMatch(/kebab-case/);
  });

  it('parseAgentFile memisahkan frontmatter dan isi', () => {
    const p = parseAgentFile(good);
    expect(p.data.name).toBe('dev-qa');
    expect(p.body).toContain('# Dev QA');
  });
});

describe.runIf(existsSync(USER_AGENTS_DIR))('agen terpasang di ~/.claude/agents', () => {
  const installed = readAgentDir(USER_AGENTS_DIR);

  it('semua agen repo terpasang dan identik dengan repo', () => {
    for (const f of repoFiles) {
      const dest = installed.find((x) => x.fileName === f.fileName);
      expect(dest, `${f.fileName} belum terpasang`).toBeDefined();
      expect(dest.text.replace(/\r\n/g, '\n')).toBe(f.text.replace(/\r\n/g, '\n'));
    }
  });

  it('tidak ada nama yang bentrok dengan agen lain di folder itu', () => {
    const names = installed.map((f) => agentNameOf(f.text)).filter(Boolean);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('CLAUDE.md manajer', () => {
  const md = readFileSync(new URL('../CLAUDE.md', import.meta.url), 'utf8');

  it('memuat 8 aturan manajer', () => {
    for (let i = 1; i <= 8; i++) expect(md).toMatch(new RegExp(`^${i}\\. \\*\\*`, 'm'));
    for (const kata of ['paralel', 'dev-qa', 'dev-security', 'izin CEO', 'Hemat limit', 'reports/']) expect(md).toContain(kata);
  });

  it('menyebut semua agen', () => {
    for (const name of AGENT_NAMES) expect(md).toContain(`\`${name}\``);
  });
});
