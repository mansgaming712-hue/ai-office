import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { inlineParts, parseMarkdown, sortTaskFiles } from '../src/tasks.js';

const text = (parts) => parts.map((p) => p.text).join('');

describe('tabel GFM', () => {
  const md = '| Agen | Tugas | Status | Hasil |\n| --- | --- | --- | --- |\n| content-script | Skrip video TikTok | SELESAI | `tiktok-script.md` |\n';

  it('menjadi blok table dengan header, baris, dan code inline', () => {
    const [t, ...rest] = parseMarkdown(md);
    expect(rest).toEqual([]);
    expect(t.type).toBe('table');
    expect(t.head.map(text)).toEqual(['Agen', 'Tugas', 'Status', 'Hasil']);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0].map(text)).toEqual(['content-script', 'Skrip video TikTok', 'SELESAI', 'tiktok-script.md']);
    expect(t.rows[0][3]).toEqual([{ text: 'tiktok-script.md', bold: false, code: true }]);
    expect(t.align).toEqual([null, null, null, null]);
  });

  it('mendukung \\| di dalam sel dan sel kosong', () => {
    const [t] = parseMarkdown('| A | B | C |\n|---|---|---|\n| a \\| b |  | **x** |\n| hanya satu |\n');
    expect(t.rows[0].map(text)).toEqual(['a | b', '', 'x']);
    expect(t.rows[0][2]).toEqual([{ text: 'x', bold: true }]);
    expect(t.rows[1].map(text)).toEqual(['hanya satu', '', '']);
  });

  it('sel kosong di ujung baris tetap dihitung', () => {
    const [t] = parseMarkdown('| A | B |\n| --- | --- |\n| a | |\n');
    expect(t.rows[0].map(text)).toEqual(['a', '']);
  });

  it('perataan dari baris pemisah', () => {
    const [t] = parseMarkdown('| A | B | C | D |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |');
    expect(t.align).toEqual(['left', 'center', 'right', null]);
  });

  it('tabel berakhir di baris kosong; teks sesudahnya tetap paragraf', () => {
    const blocks = parseMarkdown(`${md}\nSesudah tabel`);
    expect(blocks.map((b) => b.type)).toEqual(['table', 'p']);
  });

  it('baris dengan | tanpa pemisah tetap paragraf', () => {
    expect(parseMarkdown('a | b\nc | d').map((b) => b.type)).toEqual(['p']);
  });
});

describe('daftar', () => {
  it('ol: baris lanjutan digabung dan nomor awal dipertahankan', () => {
    const blocks = parseMarkdown('1. **Rencana dulu.** Baca task.md\n   dibutuhkan, dan mana yang paralel.\n2. **Delegasikan.** Serahkan.\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'ol', start: 1 });
    expect(blocks[0].items).toHaveLength(2);
    expect(text(blocks[0].items[0])).toBe('Rencana dulu. Baca task.md dibutuhkan, dan mana yang paralel.');
    expect(blocks[0].items[0][0]).toEqual({ text: 'Rencana dulu.', bold: true });
  });

  it('ol mulai dari nomor lain', () => {
    const [ol] = parseMarkdown('3. tiga\n4. empat');
    expect(ol.start).toBe(3);
    expect(ol.items).toHaveLength(2);
  });

  it('ul: baris lanjutan digabung ke item sebelumnya', () => {
    const blocks = parseMarkdown('- satu\n  lanjut\n* dua\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe('ul');
    expect(blocks[0].start).toBeUndefined();
    expect(blocks[0].items.map(text)).toEqual(['satu lanjut', 'dua']);
  });

  it('baris tanpa indentasi mengakhiri daftar', () => {
    expect(parseMarkdown('- a\nteks').map((b) => b.type)).toEqual(['ul', 'p']);
  });
});

describe('inline code', () => {
  it('backtick menjadi bagian code tanpa tanda backtick', () => {
    expect(inlineParts('pakai `npm test` ya')).toEqual([
      { text: 'pakai ', bold: false },
      { text: 'npm test', bold: false, code: true },
      { text: ' ya', bold: false },
    ]);
  });

  it('isi code tidak diurai sebagai tebal', () => {
    expect(inlineParts('`**x**`')).toEqual([{ text: '**x**', bold: false, code: true }]);
  });
});

describe('urutan file', () => {
  const f = (...paths) => paths.map((path) => ({ path, bytes: 1 }));
  it('RESULT.md di depan; task.md, CLAUDE.md, run.log di belakang', () => {
    const sorted = sortTaskFiles(f('CLAUDE.md', 'tiktok-script.md', 'run.log', 'RESULT.md', 'a.md', 'task.md'));
    expect(sorted.map((x) => x.path)).toEqual(['RESULT.md', 'a.md', 'tiktok-script.md', 'task.md', 'CLAUDE.md', 'run.log']);
  });

  it('tanpa RESULT.md file hasil tetap lebih dulu dan input tidak diubah', () => {
    const input = f('run.log', 'z.md', 'CLAUDE.md');
    expect(sortTaskFiles(input).map((x) => x.path)).toEqual(['z.md', 'CLAUDE.md', 'run.log']);
    expect(input[0].path).toBe('run.log');
  });
});

describe('tanpa HTML mentah', () => {
  it('HTML di tabel, daftar, dan code tetap teks', () => {
    const blocks = parseMarkdown('| <b>x</b> |\n| --- |\n| <img src=x onerror=alert(1)> |\n\n- <script>1</script>\n\n`<i>c</i>`');
    expect(blocks[0].head[0][0].text).toBe('<b>x</b>');
    expect(blocks[0].rows[0][0][0].text).toBe('<img src=x onerror=alert(1)>');
    expect(blocks[1].items[0][0].text).toBe('<script>1</script>');
    expect(blocks[2].parts[0]).toEqual({ text: '<i>c</i>', bold: false, code: true });
  });

  it('sumber penampil tidak memakai innerHTML, eval, atau tautan', () => {
    const src = readFileSync(new URL('../src/ui/TaskViewer.jsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|\beval\(|<a[\s>]|href=/);
  });
});
