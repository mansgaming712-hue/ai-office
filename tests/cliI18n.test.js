// i18n CLI/server: deteksi bahasa, katalog locales/*.json namespace "cli", dan pesan berbahasa Inggris.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANG, LANGS, detectLang, langFromLocale, t, translator } from '../shared/i18n.js';
import { nodeVersionProblem, pickLang } from '../server/nodeVersion.js';
import { resolveAuthMode } from '../server/auth.js';
import { ROOT, SERVER_ENTRY, cleanEnv, freePort, runNode, sleep } from './helpers/testkit.js';
import { tempDir } from './helpers/runnerkit.js';

const catalog = (lang) => JSON.parse(readFileSync(join(ROOT, 'locales', `${lang}.json`), 'utf8'));
const NO_INTL = () => '';

describe('deteksi bahasa', () => {
  it.each([
    ['id', 'id'], ['in', 'id'], ['ind', 'id'], ['id_ID.UTF-8', 'id'], ['id-ID', 'id'], ['in_ID', 'id'], ['ID', 'id'],
    ['en', 'en'], ['en_US.UTF-8', 'en'], ['fr_FR', 'en'], ['de', 'en'], ['ja_JP.UTF-8', 'en'], ['xx', 'en'], ['', 'en'],
    ['idx', 'en'], ['indonesian', 'en'],
  ])('langFromLocale(%j) = %s', (v, want) => {
    expect(langFromLocale(v)).toBe(want);
  });

  it('urutan: AI_OFFICE_LANG > LC_ALL > LC_MESSAGES > LANG > Intl', () => {
    expect(detectLang({ AI_OFFICE_LANG: 'en', LC_ALL: 'id_ID', LANG: 'id_ID' }, NO_INTL)).toBe('en');
    expect(detectLang({ AI_OFFICE_LANG: 'id', LC_ALL: 'en_US' }, NO_INTL)).toBe('id');
    expect(detectLang({ LC_ALL: 'id_ID.UTF-8', LC_MESSAGES: 'en_US', LANG: 'en_US' }, NO_INTL)).toBe('id');
    expect(detectLang({ LC_MESSAGES: 'id_ID', LANG: 'en_US' }, NO_INTL)).toBe('id');
    expect(detectLang({ LANG: 'id_ID.UTF-8' }, NO_INTL)).toBe('id');
    expect(detectLang({}, () => 'id-ID')).toBe('id');
    expect(detectLang({}, () => 'en-US')).toBe('en');
  });

  it('nilai kosong, C, dan POSIX dilewati; tidak dikenal berarti Inggris', () => {
    expect(detectLang({ LC_ALL: '', LANG: 'id_ID' }, NO_INTL)).toBe('id');
    expect(detectLang({ LC_ALL: 'C', LANG: 'id_ID' }, NO_INTL)).toBe('id');
    expect(detectLang({ LANG: 'POSIX' }, () => 'id-ID')).toBe('id');
    expect(detectLang({ AI_OFFICE_LANG: 'klingon' }, () => 'id-ID')).toBe('en');
    expect(detectLang({}, NO_INTL)).toBe('en');
    expect(detectLang({}, () => { throw new Error('x'); }) ).toBe('en');
  });

  it('pickLang di nodeVersion.js (sintaks lama) sepakat dengan detectLang', () => {
    for (const env of [{ AI_OFFICE_LANG: 'id' }, { AI_OFFICE_LANG: 'en' }, { LANG: 'in_ID' }, { LC_ALL: 'fr' }, { LC_ALL: 'C', LANG: 'id_ID' }, { AI_OFFICE_LANG: 'zz' }]) {
      expect(pickLang(env), JSON.stringify(env)).toBe(detectLang(env, () => 'en-US'));
    }
  });
});

describe('t()', () => {
  it('kunci datar, interpolasi, paksa bahasa', () => {
    expect(t('start.listening', { url: 'http://x' }, 'id')).toBe('AI Office jalan di http://x');
    expect(t('start.listening', { url: 'http://x' }, 'en')).toBe('AI Office is running at http://x');
    expect(translator('en')('runner.err.busy')).toMatch(/already running/);
  });

  it('variabel yang tidak diberikan dibiarkan; kunci tak dikenal = nama kunci; bahasa tak dikenal = Inggris', () => {
    expect(t('start.listening', {}, 'en')).toContain('{url}');
    expect(t('tidak.ada.kunci', {}, 'id')).toBe('tidak.ada.kunci');
    expect(t('start.listening', { url: 'u' }, 'fr')).toBe(t('start.listening', { url: 'u' }, DEFAULT_LANG));
  });

  it('mengikuti AI_OFFICE_LANG saat dipanggil (test lama memakai id)', () => {
    expect(process.env.AI_OFFICE_LANG).toBe('id');
    expect(t('agents.forceHint')).toBe('Pakai --force untuk menimpa file yang berbeda.');
  });
});

describe('katalog locales/*.json namespace cli', () => {
  const en = catalog('en').cli;
  const id = catalog('id').cli;
  const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('en dan id punya kunci yang sama, semua string tidak kosong', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(id).sort());
    for (const lang of LANGS) {
      for (const [k, v] of Object.entries(catalog(lang).cli)) {
        expect(typeof v, `${lang}:${k}`).toBe('string');
        expect(v.trim().length, `${lang}:${k}`).toBeGreaterThan(0);
      }
    }
  });

  it('placeholder {nama} sama di kedua bahasa', () => {
    for (const k of Object.keys(en)) expect(vars(en[k]), k).toEqual(vars(id[k]));
  });

  it('terjemahan Inggris tidak berisi kata-kata Indonesia umum (bukan salinan)', () => {
    for (const [k, v] of Object.entries(en)) {
      if (/^(start\.hooks|autostart\.status|autostart\.line|autostart\.systemd\.manual3b)/.test(k)) continue;
      expect(v, k).not.toMatch(/\b(tidak|belum|sudah|dengan|yang|atau|jalankan)\b/i);
    }
  });

  it('namespace lain (ui, office) tidak diubah oleh tugas backend: tetap ada', () => {
    expect(Object.keys(catalog('en').ui).length).toBeGreaterThan(0);
    expect(catalog('en')).toHaveProperty('office');
  });
});

describe('pesan berbahasa Inggris', () => {
  it('nodeVersionProblem: en dan id', () => {
    expect(nodeVersionProblem('18.0.0', undefined, 'en')).toMatch(/needs Node\.js 22\.12 or newer, but v18\.0\.0 is installed/);
    expect(nodeVersionProblem('18.0.0', undefined, 'id')).toMatch(/membutuhkan Node\.js 22\.12 atau lebih baru/);
    expect(nodeVersionProblem('22.12.0', undefined, 'en')).toBeNull();
  });

  it('requireNode.js (proses nyata) tidak diganggu: Node cukup = tidak ada output', async () => {
    const r = await runNode(['-e', "import('./server/requireNode.js').then(() => console.log('ok'))"], { env: cleanEnv({ AI_OFFICE_LANG: 'en' }) });
    expect(r.out.trim()).toBe('ok');
  });

  it('resolveAuthMode: galat mode terbuka dalam Inggris', () => {
    const prev = process.env.AI_OFFICE_LANG;
    process.env.AI_OFFICE_LANG = 'en';
    try {
      const m = resolveAuthMode({ host: '0.0.0.0', token: '' });
      expect(m.error).toMatch(/Server not started: open mode \(HOST=0\.0\.0\.0 is not loopback\) requires an AI_OFFICE_TOKEN of at least 32 characters, but the token is empty/);
      expect(m.error).toMatch(/npm run -s token/);
    } finally {
      process.env.AI_OFFICE_LANG = prev;
    }
  });

  async function serverOutput(env) {
    const port = await freePort();
    const keyDir = tempDir('ai-office-i18n-');
    let ready = false;
    const r = await runNode([SERVER_ENTRY], {
      env: cleanEnv({ PORT: String(port), AI_OFFICE_RUNNER_KEY_FILE: join(keyDir.dir, 'k'), ...env }),
      timeoutMs: 10000,
      onStdout: (out, child) => {
        if (ready || !/running at|jalan di/.test(out)) return;
        ready = true;
        sleep(200).then(() => child.kill());
      },
    });
    keyDir.cleanup();
    return { ...r, all: r.out + r.err, port };
  }

  it('server/index.js AI_OFFICE_LANG=en: pesan start dan peringatan berbahasa Inggris', async () => {
    const r = await serverOutput({ AI_OFFICE_LANG: 'en' });
    expect(r.out).toContain(`AI Office is running at http://localhost:${r.port}`);
    expect(r.out).toMatch(/Mode: local without a token/);
    expect(r.all).toMatch(/Warning: local mode without a token can be reached by every account/);
    expect(r.out).toMatch(/npm run open/);
    expect(r.all).not.toMatch(/jalan di|Peringatan/);
  });

  it('server/index.js dipilih lewat LANG bila AI_OFFICE_LANG tidak diisi; LANG=id_ID = Indonesia', async () => {
    const env = { AI_OFFICE_LANG: undefined };
    const base = cleanEnv({ LANG: 'en_US.UTF-8' });
    delete base.AI_OFFICE_LANG;
    const port = await freePort();
    let ready = false;
    const r = await runNode([SERVER_ENTRY], {
      env: { ...base, PORT: String(port), AI_OFFICE_RUNNER_KEY_FILE: base.AI_OFFICE_RUNNER_KEY_FILE },
      timeoutMs: 10000,
      onStdout: (out, child) => {
        if (ready || !out.includes('running at')) return;
        ready = true;
        sleep(150).then(() => child.kill());
      },
    });
    expect(r.out).toContain('AI Office is running at');
    void env;
  });

  it('server/index.js menolak mode terbuka tanpa token (Inggris), exit 1', async () => {
    const port = await freePort();
    const r = await runNode([SERVER_ENTRY], { env: cleanEnv({ PORT: String(port), HOST: '0.0.0.0', AI_OFFICE_LANG: 'en' }), timeoutMs: 10000 });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Server not started: open mode/);
  });

  it('scripts: usage-report, install-user-hooks, uninstall-user-hooks, autostart --dry-run berbahasa Inggris', async () => {
    const dir = tempDir('ai-office-i18n-scripts-');
    const settings = join(dir.dir, 'settings.json');
    const env = cleanEnv({ AI_OFFICE_LANG: 'en', AI_OFFICE_USER_SETTINGS: settings, AI_OFFICE_CLAUDE_DIR: join(dir.dir, 'claude') });
    const usage = await runNode([join(ROOT, 'scripts', 'usage-report.mjs')], { env });
    expect(usage.out).toMatch(/Claude Code token usage \(ESTIMATE from local logs/);
    expect(usage.out).toMatch(/Last 7 days:/);
    const inst = await runNode([join(ROOT, 'scripts', 'install-user-hooks.mjs')], { env });
    expect(inst.code).toBe(0);
    expect(inst.out).toMatch(/AI Office hook installed in/);
    expect(inst.out).toMatch(/Applies to Claude Code sessions started after this/);
    const again = await runNode([join(ROOT, 'scripts', 'install-user-hooks.mjs')], { env });
    expect(again.out).toMatch(/already installed/);
    const un = await runNode([join(ROOT, 'scripts', 'uninstall-user-hooks.mjs')], { env });
    expect(un.out).toMatch(/AI Office hook\(s\) removed from/);
    const un2 = await runNode([join(ROOT, 'scripts', 'uninstall-user-hooks.mjs')], { env });
    expect(un2.out).toMatch(/No AI Office hook in/);
    const auto = await runNode(
      [join(ROOT, 'scripts', 'autostart.mjs'), 'status', '--dry-run', '--platform=linux', `--home=${dir.dir}`, `--project=${dir.dir}`],
      { env },
    );
    expect(auto.out).toMatch(/\[dry-run\] platform: linux, command: status\. Nothing is changed\./);
    expect(auto.out).toMatch(/would check whether this exists/);
    const bad = await runNode([join(ROOT, 'scripts', 'autostart.mjs'), 'bogus'], { env });
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/Unknown command: bogus/);
    expect(bad.err).toMatch(/Usage: node scripts\/autostart\.mjs/);
    const idEnv = { ...env, AI_OFFICE_LANG: 'id' };
    const bad2 = await runNode([join(ROOT, 'scripts', 'autostart.mjs'), 'bogus'], { env: idEnv });
    expect(bad2.err).toMatch(/Perintah tidak dikenal: bogus/);
    dir.cleanup();
  });

  it('install-agents memakai teks Inggris (ke folder agen sementara lewat HOME)', async () => {
    const dir = tempDir('ai-office-i18n-agents-');
    const env = cleanEnv({ AI_OFFICE_LANG: 'en', HOME: dir.dir, USERPROFILE: dir.dir });
    const r = await runNode([join(ROOT, 'scripts', 'install-agents.mjs')], { env });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/installed: /);
    expect(r.out).toMatch(/Done: \d+ copied, \d+ already identical, \d+ skipped\./);
    dir.cleanup();
  });
});
