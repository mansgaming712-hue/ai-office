// Kepribadian hanya untuk tampilan: TIDAK boleh masuk ke prompt agen sungguhan (agents/*.md, templates, runner, hook).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PERSONALITIES } from '../shared/personalities.js';
import { BASE_ARGS, buildArgs } from '../server/runner.js';
import { pluginAgentFiles, discoverDivisions, PACKS_DIR } from '../server/divisions.js';
import { ROOT } from './helpers/testkit.js';

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const read = (p) => readFileSync(p, 'utf8');
const rel = (p) => relative(ROOT, p).replace(/\\/g, '/');

// Semua teks yang bisa dilihat pemain: nama panggilan, sifat, frasa (EN dan ID) dari data bawaan dan contoh plugin.
const exampleLegal = JSON.parse(read(join(PACKS_DIR, 'example-legal', 'division.json'))).personalities;
function texts(personalities) {
  const out = [];
  for (const p of Object.values(personalities)) {
    const list = [p.nickname, ...(p.traits ?? []), ...(p.speech?.phrases ?? [])];
    for (const x of list) {
      if (typeof x === 'string') out.push(x);
      else if (x) out.push(...[x.en, x.id].filter(Boolean));
    }
  }
  return out;
}
const PHRASES = [...new Set([...texts(DEFAULT_PERSONALITIES), ...texts(exampleLegal)])].filter((s) => s.length >= 8);

describe('kepribadian tidak bocor ke prompt agen', () => {
  it('ada cukup frasa untuk diperiksa', () => {
    expect(PHRASES.length).toBeGreaterThan(60);
  });

  it('agents/*.md dan agen di division-packs tidak memuat satu pun frasa atau kata "personality"', () => {
    const files = [
      ...walk(join(ROOT, 'agents')),
      ...walk(PACKS_DIR).filter((f) => f.includes(`${join('agents', '')}`) && f.endsWith('.md')),
    ];
    expect(files.length).toBeGreaterThan(17);
    for (const f of files) {
      const text = read(f);
      expect(text, rel(f)).not.toMatch(/personalit|kepribadian/i);
      for (const p of PHRASES) expect(text.includes(p), `${rel(f)} memuat "${p}"`).toBe(false);
    }
  });

  it('template tugas (server/templates), runner, hook, dan skrip agen tidak menyebut kepribadian', () => {
    const files = [
      ...walk(join(ROOT, 'server', 'templates')),
      join(ROOT, 'server', 'runner.js'),
      join(ROOT, 'server', 'runnerKey.js'),
      join(ROOT, 'server', 'tasks.js'),
      ...walk(join(ROOT, 'hooks')),
      join(ROOT, 'shared', 'hookMapping.js'),
      join(ROOT, 'shared', 'events.js'),
      join(ROOT, 'scripts', 'agent-files.mjs'),
      join(ROOT, 'scripts', 'install-agents.mjs'),
      join(ROOT, 'scripts', 'user-hooks.mjs'),
      join(ROOT, 'scripts', 'install-user-hooks.mjs'),
    ];
    for (const f of files) {
      const text = read(f);
      expect(text, rel(f)).not.toMatch(/personalit|kepribadian/i);
      for (const p of PHRASES) expect(text.includes(p), `${rel(f)} memuat "${p}"`).toBe(false);
    }
  });

  it('di server hanya penemuan divisi yang meneruskan data personalities (untuk tampilan); tidak ada impor shared/personalities', () => {
    const serverFiles = walk(join(ROOT, 'server')).filter((f) => /\.(js|mjs)$/.test(f));
    const mentions = serverFiles.filter((f) => /personalit/i.test(read(f))).map(rel);
    expect(mentions).toEqual(['server/divisions.js']);
    for (const f of serverFiles) expect(read(f), rel(f)).not.toMatch(/from ['"][^'"]*personalities/);
  });

  it('argumen CLI yang dibuat runner (buildArgs) tidak memuat data kepribadian', () => {
    const args = JSON.stringify(buildArgs({}));
    expect(args).not.toMatch(/personalit|kepribadian/i);
    for (const p of PHRASES) expect(args.includes(p)).toBe(false);
    // bahkan bila lingkungan membawa nama kepribadian, runner hanya meneruskan env yang dikenalnya
    const withEnv = JSON.stringify(buildArgs({ AI_OFFICE_PERSONALITY: 'cheerful', AI_OFFICE_RUNNER_TOOLS: '' }));
    expect(withEnv).not.toContain('cheerful');
    expect(JSON.stringify(BASE_ARGS)).not.toMatch(/personalit/i);
  });

  it('agen plugin yang dibaca penemuan (teks yang dipasang sebagai agen) tidak berubah oleh personalities', () => {
    const found = discoverDivisions({ dir: PACKS_DIR });
    const legal = found.divisions.find((d) => d.id === 'example-legal');
    expect(legal.personalities).toBeTruthy();
    for (const f of pluginAgentFiles({ divisions: [legal] })) {
      expect(f.text).toBe(read(f.path)); // persis isi file .md, tanpa tambahan
      expect(f.text).not.toMatch(/personalit|kepribadian/i);
      for (const p of PHRASES) expect(f.text.includes(p)).toBe(false);
    }
  });

  it('template tugas yang dirender tidak memuat nama panggilan atau frasa worker mana pun', () => {
    for (const f of walk(join(ROOT, 'server', 'templates'))) {
      const text = read(f);
      for (const [id, p] of Object.entries(DEFAULT_PERSONALITIES)) {
        for (const lang of ['en', 'id']) {
          for (const ph of p.speech.phrases) expect(text.includes(ph[lang]), `${rel(f)} ${id}`).toBe(false);
        }
      }
    }
  });
});
