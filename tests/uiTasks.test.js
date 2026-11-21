// Panel tugas nyata: validasi respons runner (src/tasks.js) dan lapisan jaringan (src/net.js) dengan
// fetch/WebSocket/sessionStorage distub. Tidak ada request ke server sungguhan.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_HEADER, KEY_STORAGE, cancelTask, captureKeyFromUrl, connect, getRunner, getRunnerKey, getTask,
  getTaskFile, listTasks, parseKeyFragment, postDemo, postTask,
} from '../src/net.js';
import {
  INSTALL_COMMAND, OPEN_COMMAND, bytesParts, failureReason, inlineParts, isMarkdownPath, isTaskId, normalizeTask,
  parseMarkdown, parseRunner, parseStartResponse, parseTaskDetail, reasonNotice, taskFilePath, tasksReducer,
} from '../src/tasks.js';

const KEY = 'k3y-abcdef0123456789';

const memStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
};

const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isTaskId / normalizeTask', () => {
  it.each([
    ['t-1', true], ['abc_DEF-123', true], ['a'.repeat(80), true],
    ['a'.repeat(81), false], ['', false], ['../x', false], ['a/b', false], ['a b', false], ['a.b', false],
    [5, false], [null, false], [undefined, false],
  ])('isTaskId(%j) → %s', (v, ok) => expect(isTaskId(v)).toBe(ok));

  it('tugas valid dinormalisasi; waktu ISO diubah ke ms; judul dibersihkan', () => {
    const n = normalizeTask({
      id: 't1', title: '  Buat\n‮landing   page ', status: 'running', kind: 'demo',
      startedAt: '2026-11-21T10:00:00.000Z', finishedAt: 5, files: [{ path: 'a.md' }, { path: 'b.md' }],
    });
    expect(n).toEqual({ id: 't1', title: 'Buat landing page', status: 'running', kind: 'demo', startedAt: Date.parse('2026-11-21T10:00:00.000Z'), finishedAt: 5, files: 2 });
  });

  it('id tidak sah, status tidak dikenal, atau bukan objek → null; field jelek dilewati', () => {
    expect(normalizeTask(null)).toBeNull();
    expect(normalizeTask([])).toBeNull();
    expect(normalizeTask({ id: '../x', status: 'done' })).toBeNull();
    expect(normalizeTask({ id: 't1', status: 'exploded' })).toBeNull();
    expect(normalizeTask({ id: 't1', title: 5, kind: 'evil', startedAt: 'bukan tanggal', files: -3 })).toEqual({ id: 't1' });
  });
});

describe('tasksReducer', () => {
  it('load: urut terbaru di atas, tugas tidak sah dibuang, tugas WS-saja dipertahankan', () => {
    let s = tasksReducer([], { type: 'upsert', task: { id: 'ws1', status: 'running', title: 'dari WS' }, now: 5000 });
    s = tasksReducer(s, {
      type: 'load',
      tasks: [
        { id: 'a', title: 'A', status: 'done', kind: 'task', startedAt: 1000, files: 2 },
        { id: 'b', title: 'B', status: 'failed', kind: 'demo', startedAt: 3000, files: 0 },
        { id: '../bad', status: 'done' },
        'sampah',
      ],
    });
    expect(s.map((t) => t.id)).toEqual(['ws1', 'b', 'a']);
    expect(s[2]).toMatchObject({ id: 'a', status: 'done', files: 2, kind: 'task' });
  });

  it('upsert: tugas baru masuk di atas; pesan parsial menggabung ke tugas yang ada', () => {
    let s = tasksReducer([], { type: 'upsert', task: { id: 't1', title: 'Judul', status: 'running', kind: 'task' }, now: 100 });
    expect(s[0]).toMatchObject({ id: 't1', status: 'running', startedAt: 100 });
    s = tasksReducer(s, { type: 'upsert', task: { id: 't1', status: 'done', summary: 'selesai' }, now: 999 });
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ id: 't1', title: 'Judul', status: 'done', startedAt: 100, summary: 'selesai' });
  });

  it('pesan tidak dikenal atau tidak sah diabaikan (state sama)', () => {
    const s = [];
    expect(tasksReducer(s, { type: 'upsert', task: { id: 'x y', status: 'done' } })).toBe(s);
    expect(tasksReducer(s, { type: 'upsert', task: { id: 'x', status: 'nope' } })).toBe(s);
    expect(tasksReducer(s, { type: 'load', tasks: 'bukan array' })).toBe(s);
    expect(tasksReducer(s, { type: 'lain' })).toBe(s);
    expect(tasksReducer(s, undefined)).toBe(s);
  });

  it('daftar dibatasi 50', () => {
    let s = [];
    for (let i = 0; i < 70; i++) s = tasksReducer(s, { type: 'upsert', task: { id: `t${i}`, status: 'done' }, now: i });
    expect(s).toHaveLength(50);
    expect(s[0].id).toBe('t69');
  });
});

describe('parseRunner', () => {
  const ok = (extra) => ({ ok: true, available: true, reason: null, keyRequired: false, version: '2.0', active: null, ...extra });

  it('siap', () => {
    expect(parseRunner(200, ok())).toMatchObject({ state: 'ready', reason: null });
  });

  it.each(['cli-not-found', 'disabled', 'busy'])('tidak tersedia: %s', (reason) => {
    expect(parseRunner(200, ok({ available: false, reason }))).toMatchObject({ state: 'unavailable', reason });
  });

  it('butuh key tapi browser tidak punya key → reason key; dengan key → siap', () => {
    expect(parseRunner(200, ok({ keyRequired: true }), { hasKey: false })).toMatchObject({ state: 'unavailable', reason: 'key' });
    expect(parseRunner(200, ok({ keyRequired: true }), { hasKey: true })).toMatchObject({ state: 'ready' });
  });

  it('401/403 → key; server lama, JSON rusak, jaringan putus → unsupported', () => {
    expect(parseRunner(401, undefined)).toMatchObject({ state: 'unavailable', reason: 'key' });
    expect(parseRunner(403, {})).toMatchObject({ state: 'unavailable', reason: 'key' });
    for (const [status, body] of [[404, { ok: false }], [null, undefined], [200, undefined], [200, { ok: false }], [500, ok()], [200, ok({ available: false, reason: 'aneh' })]]) {
      expect(parseRunner(status, body)).toMatchObject({ state: 'unsupported' });
    }
  });

  it('tugas aktif divalidasi', () => {
    expect(parseRunner(200, ok({ active: { id: 't1', title: 'X', startedAt: 1, kind: 'demo' } })).active).toEqual({ id: 't1', title: 'X', kind: 'demo' });
    expect(parseRunner(200, ok({ active: { id: '../x' } })).active).toBeNull();
  });
});

describe('failureReason / parseStartResponse / reasonNotice', () => {
  it.each([
    [401, 'key'], [403, 'key'], [409, 'busy'], [503, 'cli-not-found'], [400, 'invalid'],
    [404, 'unsupported'], [405, 'unsupported'], [501, 'unsupported'], [null, 'unsupported'], [500, 'error'],
  ])('status %s → %s', (status, reason) => expect(failureReason(status)).toBe(reason));

  it('202 dengan task → ok; bentuk salah → error', () => {
    expect(parseStartResponse(202, { ok: true, task: { id: 't1', title: 'Hai', status: 'running' } })).toEqual({
      ok: true,
      task: { title: 'Hai', kind: 'task', status: 'running', id: 't1' },
    });
    expect(parseStartResponse(202, { ok: true, task: { id: '../x' } })).toEqual({ ok: false, reason: 'error' });
    expect(parseStartResponse(202, undefined)).toEqual({ ok: false, reason: 'error' });
  });

  it('error membawa pesan server yang dibersihkan', () => {
    expect(parseStartResponse(400, { ok: false, error: '  teks kosong ' })).toEqual({ ok: false, reason: 'invalid', error: 'teks kosong' });
    expect(parseStartResponse(409, {})).toEqual({ ok: false, reason: 'busy' });
  });

  it('alasan → petunjuk: perintah pasang CLI dan npm run open', () => {
    expect(reasonNotice('cli-not-found')).toEqual({ textKey: 'ui.runner.cliNotFound', command: INSTALL_COMMAND });
    expect(INSTALL_COMMAND).toBe('npm install -g @anthropic-ai/claude-code');
    expect(reasonNotice('key')).toEqual({ textKey: 'ui.runner.key', command: OPEN_COMMAND });
    expect(OPEN_COMMAND).toBe('npm run open');
    expect(reasonNotice('busy').textKey).toBe('ui.runner.busy');
    expect(reasonNotice('disabled').textKey).toBe('ui.runner.disabled');
    expect(reasonNotice('unsupported').textKey).toBe('ui.runner.unsupported');
    expect(reasonNotice(undefined).textKey).toBe('ui.runner.unsupported');
  });
});

describe('penampil hasil: parseTaskDetail, taskFilePath, util', () => {
  it('detail: daftar file divalidasi', () => {
    const r = parseTaskDetail(200, {
      ok: true,
      task: { id: 't1', title: 'T', status: 'done', summary: 'ringkas', files: [{ path: 'a.md', bytes: 10 }, { path: '', bytes: 1 }, { bytes: 3 }, { path: 'dir/b.txt', bytes: 'x' }] },
    });
    expect(r.ok).toBe(true);
    expect(r.files).toEqual([{ path: 'a.md', bytes: 10 }, { path: 'dir/b.txt', bytes: null }]);
    expect(r.task).toMatchObject({ id: 't1', summary: 'ringkas', files: 2 });
    expect(parseTaskDetail(404, { ok: false })).toEqual({ ok: false });
    expect(parseTaskDetail(200, { ok: true, task: { id: '../x', status: 'done' } })).toEqual({ ok: false });
  });

  it('taskFilePath meng-encode tiap segmen dan menolak path berbahaya', () => {
    expect(taskFilePath('t1', 'laporan.md')).toBe('/api/tasks/t1/files/laporan.md');
    expect(taskFilePath('t1', 'dir/file satu#2?.txt')).toBe('/api/tasks/t1/files/dir/file%20satu%232%3F.txt');
    expect(taskFilePath('t1', '../rahasia')).toBeNull();
    expect(taskFilePath('t1', 'a/./b')).toBeNull();
    expect(taskFilePath('t1', '')).toBeNull();
    expect(taskFilePath('../t1', 'a')).toBeNull();
    expect(taskFilePath('t1', 5)).toBeNull();
  });

  it('isMarkdownPath, bytesParts', () => {
    expect(isMarkdownPath('a.md')).toBe(true);
    expect(isMarkdownPath('A.MARKDOWN')).toBe(true);
    expect(isMarkdownPath('a.txt')).toBe(false);
    expect(bytesParts(512)).toEqual({ key: 'ui.viewer.bytes', n: '512' });
    expect(bytesParts(2048)).toEqual({ key: 'ui.viewer.kilobytes', n: '2' });
    expect(bytesParts(-1)).toBeNull();
    expect(bytesParts(null)).toBeNull();
  });
});

describe('markdown sederhana (data murni, bukan HTML)', () => {
  it('judul, daftar, tebal, kode, paragraf', () => {
    const blocks = parseMarkdown('# Judul **besar**\n\nBaris satu\nbaris dua\n\n- a\n- **b**\n\n1. satu\n2. dua\n\n```\n<script>x</script>\n```\n');
    expect(blocks.map((b) => b.type)).toEqual(['h', 'p', 'ul', 'ol', 'code']);
    expect(blocks[0]).toMatchObject({ level: 1, parts: [{ text: 'Judul ', bold: false }, { text: 'besar', bold: true }] });
    expect(blocks[1].parts).toEqual([{ text: 'Baris satu baris dua', bold: false }]);
    expect(blocks[2].items[1]).toEqual([{ text: 'b', bold: true }]);
    expect(blocks[3].items).toHaveLength(2);
    expect(blocks[4].text).toBe('<script>x</script>');
  });

  it('HTML di dalam teks tetap berupa teks biasa', () => {
    const [p] = parseMarkdown('<img src=x onerror=alert(1)> **b**');
    expect(p.parts[0].text).toBe('<img src=x onerror=alert(1)> ');
    expect(JSON.stringify(parseMarkdown('<b>x</b>'))).toContain('<b>x</b>');
  });

  it('masukan aneh tidak melempar', () => {
    expect(parseMarkdown(undefined)).toEqual([]);
    expect(parseMarkdown('```\nbelum ditutup')).toEqual([{ type: 'code', text: 'belum ditutup' }]);
    expect(inlineParts('**a** b **c**').map((p) => p.bold)).toEqual([true, false, true]);
    expect(inlineParts('tanda ** tunggal')).toEqual([{ text: 'tanda ** tunggal', bold: false }]);
  });
});

// ------------------------------------------------------------------ key runner

describe('key runner dari fragmen URL', () => {
  it('parseKeyFragment: ambil key, buang dari fragmen, sisanya dipertahankan', () => {
    expect(parseKeyFragment(`#key=${KEY}`)).toEqual({ key: KEY, rest: '' });
    expect(parseKeyFragment(`#a=1&key=${KEY}&b=2`)).toEqual({ key: KEY, rest: 'a=1&b=2' });
    expect(parseKeyFragment('#key=pendek')).toEqual({ key: null, rest: '' });
    expect(parseKeyFragment('#key=a b c d e f g h i')).toEqual({ key: null, rest: '' });
    expect(parseKeyFragment('#bagian')).toEqual({ key: null, rest: 'bagian' });
    expect(parseKeyFragment('')).toEqual({ key: null, rest: '' });
    expect(parseKeyFragment(undefined)).toEqual({ key: null, rest: '' });
  });

  it('captureKeyFromUrl: simpan di sessionStorage dan hapus fragmen lewat history.replaceState', () => {
    const storage = memStorage();
    const replaceState = vi.fn();
    const loc = { hash: `#key=${KEY}`, pathname: '/app', search: '?x=1' };
    expect(captureKeyFromUrl({ loc, hist: { replaceState, state: { s: 1 } }, storage })).toBe(true);
    expect(storage.data[KEY_STORAGE]).toBe(KEY);
    expect(KEY_STORAGE).toBe('ai-office-key');
    expect(replaceState).toHaveBeenCalledWith({ s: 1 }, '', '/app?x=1');
    expect(replaceState.mock.calls[0][2]).not.toContain(KEY);
  });

  it('fragmen lain dipertahankan; tanpa key tidak menyentuh URL; key jelek dibuang tanpa disimpan', () => {
    const storage = memStorage();
    const replaceState = vi.fn();
    captureKeyFromUrl({ loc: { hash: `#tab=2&key=${KEY}`, pathname: '/', search: '' }, hist: { replaceState }, storage });
    expect(replaceState).toHaveBeenCalledWith(null, '', '/#tab=2');
    replaceState.mockClear();
    expect(captureKeyFromUrl({ loc: { hash: '#tab=2', pathname: '/', search: '' }, hist: { replaceState }, storage })).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
    const s2 = memStorage();
    expect(captureKeyFromUrl({ loc: { hash: '#key=x', pathname: '/', search: '' }, hist: { replaceState }, storage: s2 })).toBe(false);
    expect(s2.data).toEqual({});
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
  });

  it('getRunnerKey membaca sessionStorage dan menolak nilai rusak', () => {
    expect(getRunnerKey(memStorage({ [KEY_STORAGE]: KEY }))).toBe(KEY);
    expect(getRunnerKey(memStorage())).toBeNull();
    expect(getRunnerKey(memStorage({ [KEY_STORAGE]: 'a b\nc' }))).toBeNull();
    expect(getRunnerKey({ getItem() { throw new Error('x'); } })).toBeNull();
  });
});

// ------------------------------------------------------------------ lapisan jaringan (fetch distub)

describe('src/net.js runner (fetch distub)', () => {
  const setup = (responder, key = KEY) => {
    const calls = [];
    vi.stubGlobal('window', { sessionStorage: memStorage(key ? { [KEY_STORAGE]: key } : {}) });
    vi.stubGlobal('fetch', async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return responder(String(url), init);
    });
    return calls;
  };

  it('key dikirim di header X-AI-Office-Key, tidak pernah di URL', async () => {
    const calls = setup(() => jsonRes(200, { ok: true, available: true, keyRequired: true }));
    expect(KEY_HEADER).toBe('X-AI-Office-Key');
    expect((await getRunner()).state).toBe('ready');
    await listTasks();
    await getTask('t1');
    await getTaskFile('t1', 'a b.md');
    await postTask('halo', 'id');
    await postDemo('en');
    await cancelTask('t1');
    expect(calls).toHaveLength(7);
    for (const c of calls) {
      expect(c.url).not.toContain(KEY);
      expect(c.url).not.toMatch(/key=/i);
      expect(c.init.headers[KEY_HEADER]).toBe(KEY);
    }
  });

  it('tanpa key: tidak ada header key', async () => {
    const calls = setup(() => jsonRes(200, { ok: true, available: false, reason: 'cli-not-found' }), null);
    expect(await getRunner()).toMatchObject({ state: 'unavailable', reason: 'cli-not-found' });
    expect(calls[0].init.headers?.[KEY_HEADER]).toBeUndefined();
  });

  it('postTask mengirim { text, lang } sebagai JSON POST dan memetakan hasilnya', async () => {
    const calls = setup(() => jsonRes(202, { ok: true, task: { id: 't9', title: 'Halo', status: 'running' } }));
    const r = await postTask('Buat halaman', 'en');
    expect(r).toMatchObject({ ok: true, task: { id: 't9' } });
    expect(calls[0].url).toBe('/api/tasks');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(calls[0].init.body)).toEqual({ text: 'Buat halaman', lang: 'en' });
    expect(calls[0].init.headers['Content-Type']).toBe('application/json');
  });

  it.each([[409, 'busy'], [503, 'cli-not-found'], [401, 'key'], [403, 'key'], [400, 'invalid'], [404, 'unsupported']])('postTask status %s → %s', async (status, reason) => {
    setup(() => jsonRes(status, { ok: false, error: 'x' }));
    expect(await postTask('a', 'id')).toMatchObject({ ok: false, reason });
  });

  it('jaringan putus → unsupported (tidak melempar)', async () => {
    setup(() => {
      throw new Error('offline');
    });
    expect(await postTask('a', 'id')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(await postDemo('id')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect((await getRunner()).state).toBe('unsupported');
    expect(await listTasks()).toEqual({ ok: false, tasks: [] });
    expect(await getTaskFile('t1', 'a')).toEqual({ ok: false });
    expect(await cancelTask('t1')).toBe(false);
  });

  it('postDemo mengirim { lang }', async () => {
    const calls = setup(() => jsonRes(202, { ok: true, task: { id: 'd1', title: 'Demo', status: 'running', kind: 'demo' } }));
    expect(await postDemo('id')).toMatchObject({ ok: true, task: { id: 'd1', kind: 'demo' } });
    expect(calls[0].url).toBe('/api/demo');
    expect(JSON.parse(calls[0].init.body)).toEqual({ lang: 'id' });
  });

  it('cancelTask / getTask menolak id yang tidak sah tanpa request', async () => {
    const calls = setup(() => jsonRes(200, { ok: true }));
    expect(await cancelTask('../x')).toBe(false);
    expect(await getTask('../x')).toEqual({ ok: false });
    expect(await getTaskFile('../x', 'a')).toEqual({ ok: false });
    expect(await getTaskFile('t1', '../etc/passwd')).toEqual({ ok: false });
    expect(calls).toHaveLength(0);
    expect(await cancelTask('t1')).toBe(true);
    expect(calls[0].url).toBe('/api/tasks/t1/cancel');
  });

  it('getTaskFile membaca isi sebagai teks dengan segmen path ter-encode', async () => {
    const calls = setup(() => ({ ok: true, status: 200, text: async () => '<b>halo</b>' }));
    expect(await getTaskFile('t1', 'dir/a b.md')).toEqual({ ok: true, text: '<b>halo</b>' });
    expect(calls[0].url).toBe('/api/tasks/t1/files/dir/a%20b.md');
    setup(() => ({ ok: false, status: 404, text: async () => 'tidak ada' }));
    expect(await getTaskFile('t1', 'x')).toEqual({ ok: false });
  });

  it('listTasks mengembalikan daftar mentah (divalidasi reducer)', async () => {
    setup(() => jsonRes(200, { ok: true, tasks: [{ id: 'a', status: 'done' }] }));
    expect(await listTasks()).toEqual({ ok: true, tasks: [{ id: 'a', status: 'done' }] });
    setup(() => jsonRes(200, { ok: true, tasks: 'x' }));
    expect(await listTasks()).toEqual({ ok: false, tasks: [] });
  });
});

describe('src/net.js connect: pesan WebSocket { kind: "task" }', () => {
  class FakeWS {
    static OPEN = 1;
    static last = null;
    constructor() {
      FakeWS.last = this;
      this.readyState = 1;
    }
    close() {}
  }

  const open = (handlers) => {
    vi.stubGlobal('WebSocket', FakeWS);
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:9' });
    const net = connect({ onStatus() {}, onEvent() {}, onHistory() {}, ...handlers });
    return { net, ws: FakeWS.last };
  };
  const send = (ws, data) => ws.onmessage({ data: typeof data === 'string' ? data : JSON.stringify(data) });

  it('pesan task diteruskan ke onTask; kind tak dikenal dan JSON rusak diabaikan', () => {
    const onTask = vi.fn();
    const onEvent = vi.fn();
    const { net, ws } = open({ onTask, onEvent });
    send(ws, { kind: 'task', task: { id: 't1', status: 'running' } });
    send(ws, { kind: 'misteri', task: { id: 'x' } });
    send(ws, { kind: 'task' });
    send(ws, '{rusak');
    send(ws, '[]');
    expect(onTask).toHaveBeenCalledTimes(1);
    expect(onTask).toHaveBeenCalledWith({ id: 't1', status: 'running' });
    expect(onEvent).not.toHaveBeenCalled();
    net.close();
  });

  it('tanpa onTask pesan task diabaikan; callback yang melempar tidak memutus koneksi', () => {
    const { net, ws } = open({});
    expect(() => send(ws, { kind: 'task', task: { id: 't1' } })).not.toThrow();
    net.close();
    const bad = open({
      onTask() {
        throw new Error('ui rusak');
      },
    });
    expect(() => send(bad.ws, { kind: 'task', task: { id: 't1' } })).not.toThrow();
    bad.net.close();
  });
});

describe('keamanan tampilan: tidak ada innerHTML', () => {
  it('src tidak memakai innerHTML, dangerouslySetInnerHTML, eval, atau insertAdjacentHTML', () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const root = new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const files = walk(root).filter((f) => /\.(jsx?|mjs)$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function\(/);
    }
  });
});
