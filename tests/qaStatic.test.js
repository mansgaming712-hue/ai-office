// Pemeriksaan statis konsistensi: kunci i18n yang dipakai server/skrip, string UI yang masih hardcoded,
// dokumentasi (README, REFERENCE) vs package.json dan kode, dan berkas template runner/demo.
// Tidak menjalankan server dan tidak menyentuh jaringan.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_FILES } from '../server/demo.js';
import { ROOT } from './helpers/testkit.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir, exts, out = []) => {
  for (const n of readdirSync(join(ROOT, dir))) {
    if (['node_modules', 'dist', '.git', 'output', 'logs'].includes(n)) continue;
    const rel = `${dir}/${n}`;
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, exts, out);
    else if (exts.some((e) => n.endsWith(e))) out.push(rel);
  }
  return out;
};
const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v, `${p}${k}.`) : [[`${p}${k}`, v]]));
const locales = { en: JSON.parse(read('locales/en.json')), id: JSON.parse(read('locales/id.json')) };
const pkg = JSON.parse(read('package.json'));
const uniq = (a) => [...new Set(a)].sort();

describe('i18n: kunci yang dipakai kode Node ada di kedua bahasa', () => {
  const files = ['server', 'scripts', 'shared', 'hooks'].flatMap((d) => walk(d, ['.js', '.mjs']));
  const keys = [];
  for (const f of files) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // komentar memuat contoh t('...')
    for (const m of code.matchAll(/\b(?:t|tr)\(\s*'([a-z][\w.]*)'/g)) keys.push([f, m[1]]);
  }

  it('ada kunci yang dipindai (pemindai tidak buta)', () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  it.each(['en', 'id'])('semua t(\'...\') literal di server/, scripts/, shared/, hooks/ ada di %s.json namespace cli', (lang) => {
    const have = new Set(flat(locales[lang].cli).map(([k]) => k));
    const missing = keys.filter(([, k]) => !have.has(k)).map(([f, k]) => `${f}: ${k}`);
    expect(missing).toEqual([]);
  });

  it('kunci runner.* yang dipilih lewat ternary juga ada (keyBad/noKey/tooLarge/notText/agentDone/agentBlocked)', () => {
    for (const lang of ['en', 'id']) {
      const have = new Set(flat(locales[lang].cli).map(([k]) => k));
      for (const k of ['runner.err.keyBad', 'runner.err.noKey', 'runner.err.keyMissing', 'runner.err.tooLarge', 'runner.err.notText', 'runner.err.badPath', 'runner.err.notFound', 'runner.agentDone', 'runner.agentBlocked']) {
        expect(have.has(k), `${lang}: ${k}`).toBe(true);
      }
    }
  });
});

describe('i18n: tidak ada string UI hardcoded di JSX', () => {
  const jsx = walk('src', ['.jsx']);

  it('daftar JSX tidak kosong dan memuat berkas baru', () => {
    for (const f of ['src/ui/TaskPanel.jsx', 'src/ui/TaskViewer.jsx', 'src/ui/LangToggle.jsx']) expect(jsx).toContain(f);
  });

  it('tidak ada teks literal di antara tag (selain merek "AI Office")', () => {
    const bad = [];
    for (const f of jsx) {
      const code = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const m of code.matchAll(/>([^<>{}]*[A-Za-z]{2,}[^<>{}]*)</g)) {
        const text = m[1].replace(/&nbsp;/g, ' ').trim();
        // "=>" dan ekspresi JS (mis. "(p.bold ?") bukan teks JSX
        if (text && text !== 'AI Office' && !/^[=>-]+$/.test(text) && !/[()?=;]/.test(text)) bad.push(`${f}: ${text.slice(0, 60)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('atribut title/aria-label/placeholder/alt tidak berisi teks literal', () => {
    const bad = [];
    for (const f of jsx) {
      for (const m of read(f).matchAll(/\b(title|aria-label|placeholder|alt)="([^"]*[A-Za-z]{2,}[^"]*)"/g)) bad.push(`${f}: ${m[1]}="${m[2]}"`);
    }
    expect(bad).toEqual([]);
  });
});

describe('dokumentasi sesuai kode', () => {
  const docs = ['README.md', 'README.id.md', 'docs/REFERENCE.md', 'docs/REFERENCE.id.md', 'CONTRIBUTING.md'];
  const scripts = Object.keys(pkg.scripts);

  it.each(docs)('%s: setiap "npm run <skrip>" dan "npm <start|test>" ada di package.json', (doc) => {
    const text = read(doc);
    const names = [];
    for (const m of text.matchAll(/\bnpm (?:run (?:-s )?([\w:-]+)|(start|test|stop))\b/g)) names.push(m[1] ?? m[2]);
    expect(names.filter((n) => !scripts.includes(n))).toEqual([]);
  });

  it('variabel AI_OFFICE_* yang dibaca server/ dan shared/ terdokumentasi di REFERENCE.md dan REFERENCE.id.md', () => {
    const used = uniq(['server', 'shared'].flatMap((d) => walk(d, ['.js', '.mjs'])).flatMap((f) => read(f).match(/AI_OFFICE_[A-Z][A-Z_]*[A-Z]/g) ?? []));
    for (const doc of ['docs/REFERENCE.md', 'docs/REFERENCE.id.md']) {
      const text = read(doc);
      expect(used.filter((v) => !text.includes(v)), doc).toEqual([]);
    }
  });

  it('variabel AI_OFFICE_* di dokumen ada di kode (tidak ada variabel hantu)', () => {
    const codeText = ['server', 'shared', 'scripts', 'hooks', 'src'].flatMap((d) => walk(d, ['.js', '.mjs', '.jsx'])).map(read).join('\n');
    for (const doc of docs) {
      const vars = uniq(read(doc).match(/AI_OFFICE_[A-Z][A-Z_]*[A-Z]\b/g) ?? []);
      expect(vars.filter((v) => !codeText.includes(v)), doc).toEqual([]);
    }
  });

  it('REFERENCE.md dan REFERENCE.id.md memuat himpunan variabel, endpoint, dan skrip npm yang sama', () => {
    const ids = (t) => ({
      vars: uniq(t.match(/AI_OFFICE_[A-Z][A-Z_]*[A-Z]\b/g) ?? []),
      api: uniq((t.match(/\/api\/[a-z]+(?:\/<[a-z]+>)?(?:\/[a-z]+(?:\/<[a-z]+>)?)?/g) ?? [])),
      npm: uniq([...t.matchAll(/\bnpm run (?:-s )?([\w:-]+)/g)].map((m) => m[1])),
      headings: (t.match(/^#{1,4} /gm) ?? []).length,
      codeFences: (t.match(/^```/gm) ?? []).length,
    });
    const en = ids(read('docs/REFERENCE.md'));
    const id = ids(read('docs/REFERENCE.id.md'));
    expect(id.vars).toEqual(en.vars);
    expect(id.api).toEqual(en.api);
    expect(id.npm).toEqual(en.npm);
    expect(id.headings).toBe(en.headings);
    expect(id.codeFences).toBe(en.codeFences);
  });

  it('semua rute runner di server/app.js tertulis di kedua REFERENCE', () => {
    const app = read('server/app.js');
    const routes = ['/api/runner', '/api/demo', '/api/tasks', '/files/', '/cancel', 'X-AI-Office-Key', '#key='];
    for (const r of routes) expect(app.includes(r) || r === '#key=', r).toBe(true);
    for (const doc of ['docs/REFERENCE.md', 'docs/REFERENCE.id.md']) {
      const text = read(doc);
      for (const r of ['/api/runner', '/api/demo', '/api/tasks', '/cancel', '/files/', 'X-AI-Office-Key', 'AI_OFFICE_RUNNER']) expect(text, `${doc}: ${r}`).toContain(r);
    }
  });

  it('batas yang diklaim dokumen sama dengan kode: 2000 karakter, 1 MB, 50 tugas, 30 menit, 64 KB', async () => {
    const { MAX_TASK_CHARS } = await import('../server/tasks.js');
    const { MAX_FILE_BYTES, MAX_LIST } = await import('../server/outputStore.js');
    const { DEFAULT_TIMEOUT_MS } = await import('../server/runner.js');
    expect([MAX_TASK_CHARS, MAX_FILE_BYTES, MAX_LIST, DEFAULT_TIMEOUT_MS]).toEqual([2000, 1024 * 1024, 50, 1_800_000]);
    for (const doc of ['docs/REFERENCE.md', 'docs/REFERENCE.id.md']) {
      const text = read(doc);
      expect(text, doc).toContain('2000');
      expect(text, doc).toContain('1800000');
      expect(text, doc).toMatch(/64 KB/);
    }
  });

  it('.env.example menyebut variabel runner yang dibaca server', () => {
    const env = read('.env.example');
    for (const v of ['AI_OFFICE_RUNNER', 'AI_OFFICE_CLAUDE_BIN', 'AI_OFFICE_RUNNER_TIMEOUT_MS', 'AI_OFFICE_LANG']) expect(env, v).toContain(v);
  });
});

describe('template runner dan demo', () => {
  it('server/templates/task-claude.md memuat {{lang}} dan tidak memuat placeholder lain', () => {
    const tpl = read('server/templates/task-claude.md');
    expect(tpl).toContain('{{lang}}');
    expect(tpl.replaceAll('{{lang}}', '').includes('{{')).toBe(false);
    expect(tpl.includes('\r')).toBe(false);
  });

  it.each(['en', 'id'])('server/demo/%s: tepat berkas yang disebut DEMO_FILES, tidak kosong, akhir baris LF', (lang) => {
    const dir = join(ROOT, 'server', 'demo', lang);
    const have = readdirSync(dir).sort();
    expect(have).toEqual(Object.values(DEMO_FILES[lang]).sort());
    for (const f of have) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text.trim().length, f).toBeGreaterThan(50);
      expect(text.includes('\r'), `${f} berisi CR`).toBe(false);
      expect(text.includes('\u0000'), f).toBe(false);
    }
  });

  it('berkas demo dua bahasa tidak identik (terjemahan sungguhan)', () => {
    for (const f of ['tiktok-script.md', 'caption.md', 'RESULT.md']) {
      expect(read(`server/demo/en/${f}`)).not.toBe(read(`server/demo/id/${f}`));
    }
  });

  it('semua berkas di server/ dan scripts/ yang menulis path memakai join/resolve (tanpa pemisah Windows literal)', () => {
    const bad = [];
    for (const f of ['server/runner.js', 'server/tasks.js', 'server/outputStore.js', 'server/runnerKey.js', 'server/demo.js', 'scripts/setup.mjs', 'scripts/open.mjs']) {
      const code = read(f).replace(/\/\/.*$/gm, '');
      if (/['"`][A-Za-z]:\\\\|['"`]\\\\/.test(code.replace(/'\\\\'|"\\\\"/g, ''))) bad.push(relative(ROOT, join(ROOT, f)));
    }
    expect(bad).toEqual([]);
  });
});
