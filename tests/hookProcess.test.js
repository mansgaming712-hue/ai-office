// hooks/send-event.mjs sebagai proses sungguhan terhadap server mode token (port 0, di proses test).
// Setiap runHook WAJIB memakai AI_OFFICE_URL eksplisit, jadi tidak ada yang terkirim ke port 3000.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { realisticSteps } from '../scripts/demo-hooks.mjs';
import {
  JSON_HEADERS, REPORT_BLOCKED, REPORT_DONE, ROOT, captureServer, cleanEnv, entry, handback, http, jsonl,
  randomToken, runHook, runNode, startApp, toolResult,
} from './helpers/testkit.js';

const TOKEN = randomToken();
const CAN_BIND_127_0_0_2 = await new Promise((resolve) => {
  const probe = createNetServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.2', () => probe.close(() => resolve(true)));
});
/** Lama start+exit proses node kosong (ms): pembanding waktu yang ikut membengkak saat suite berjalan paralel. */
async function nodeBaseline() {
  return (await runNode(['-e', '0'], { env: cleanEnv() })).ms;
}
/** Tunggu sampai `cond()` benar (maks 3 detik). */
async function waitFor(cond) {
  for (let i = 0; i < 120 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
}

const ASSIGN = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'dev-backend', description: 'Uji hook token' } };
const stop = (extra) => ({ hook_event_name: 'SubagentStop', agent_id: 'a7', agent_type: 'dev-qa', stop_hook_active: false, last_assistant_message: '', ...extra });

let s;
let url;
let dir;
beforeAll(async () => {
  s = await startApp({ token: TOKEN, dedupWindowMs: 0 }); // payload identik dikirim berulang dengan sengaja
  url = `${s.base}/api/events`;
  dir = mkdtempSync(join(tmpdir(), 'aio-hook-'));
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Jalankan hook lalu kembalikan event yang masuk ke server selama hook berjalan. */
async function viaHook(payload, env = {}) {
  const before = s.app.history.length;
  const r = await runHook(payload, { AI_OFFICE_URL: url, ...env });
  return { ...r, events: s.app.history.slice(before) };
}

describe('hook → server mode token', () => {
  it('dengan AI_OFFICE_TOKEN: event sampai, exit 0, stdout kosong', async () => {
    const r = await viaHook(ASSIGN, { AI_OFFICE_TOKEN: TOKEN });
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'assign', from: 'manager', to: 'dev-backend', message: 'Uji hook token', source: 'hook' });
  });

  it('token dengan spasi/baris baru di tepi tetap dipakai (di-trim)', async () => {
    const r = await viaHook(ASSIGN, { AI_OFFICE_TOKEN: `  ${TOKEN}\n` });
    expect(r.code).toBe(0);
    expect(r.events).toHaveLength(1);
  });

  it('tanpa token: server menolak (401), hook tetap exit 0 tanpa output; DEBUG=1 menjelaskan di stderr', async () => {
    const quiet = await viaHook(ASSIGN);
    expect(quiet).toMatchObject({ code: 0, out: '', err: '', events: [] });
    const loud = await viaHook(ASSIGN, { AI_OFFICE_DEBUG: '1' });
    expect(loud).toMatchObject({ code: 0, out: '', events: [] });
    expect(loud.err).toMatch(/HTTP 401/);
  });

  it('token salah: ditolak, exit 0, token (benar maupun salah) tidak tercetak di stderr', async () => {
    const wrong = randomToken();
    const r = await viaHook(ASSIGN, { AI_OFFICE_TOKEN: wrong, AI_OFFICE_DEBUG: '1' });
    expect(r).toMatchObject({ code: 0, out: '', events: [] });
    expect(r.err).toMatch(/HTTP 401/);
    expect(r.err).not.toContain(wrong);
    expect(r.err).not.toContain(TOKEN);
  });

  it('log server tidak memuat token', () => {
    for (const line of s.logs) expect(line).not.toContain(TOKEN);
  });
});

describe('R5: hook tidak pernah mengirim event lewat http:// ke host non-loopback (dengan atau tanpa token)', () => {
  // 127.0.0.2 tidak termasuk daftar loopback hook (localhost, 127.0.0.1, ::1), tetapi bisa dijangkau
  // tanpa membuka port ke jaringan, sehingga "tidak terkirim" bisa dibuktikan dengan kontrol positif.
  // macOS tidak mengaktifkan 127.0.0.2 secara default: test 127.0.0.2 dilewati dengan pesan jelas.
  let cap;
  let loop;
  beforeAll(async () => {
    loop = await captureServer({ host: '127.0.0.1' });
    if (CAN_BIND_127_0_0_2) cap = await captureServer({ host: '127.0.0.2' });
    else console.warn('[hookProcess.test] 127.0.0.2 tidak bisa di-bind: uji "tidak ada request" dilewati.');
  });
  afterAll(async () => {
    await loop?.close();
    await cap?.close();
  });
  const skipNote = CAN_BIND_127_0_0_2 ? '' : ' [DILEWATI: 127.0.0.2 tidak tersedia]';

  it.skipIf(!CAN_BIND_127_0_0_2)(`kontrol: penangkap di 127.0.0.2 bisa dijangkau langsung dari test${skipNote}`, async () => {
    cap.received.length = 0;
    const r = await http(cap.port, '/api/events', { method: 'POST', host: '127.0.0.2', headers: JSON_HEADERS, body: '[]' });
    expect(r.status).toBe(202);
    expect(cap.received).toHaveLength(1);
  });

  it.skipIf(!CAN_BIND_127_0_0_2)(`tanpa token: event ke http://127.0.0.2 TIDAK terkirim (0 request), DEBUG menjelaskan${skipNote}`, async () => {
    cap.received.length = 0;
    const quiet = await runHook(ASSIGN, { AI_OFFICE_URL: cap.url });
    expect(quiet).toMatchObject({ code: 0, out: '', err: '' });
    const loud = await runHook(ASSIGN, { AI_OFFICE_URL: cap.url, AI_OFFICE_DEBUG: '1' });
    expect(loud).toMatchObject({ code: 0, out: '' });
    expect(loud.err).toMatch(/event tidak dikirim lewat http:\/\/ ke host non-loopback \(127\.0\.0\.2\)/);
    expect(cap.received).toHaveLength(0);
  });

  it('kontrol positif: tanpa token ke loopback http://127.0.0.1 tetap terkirim (tanpa Authorization)', async () => {
    loop.received.length = 0;
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: loop.url });
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    expect(loop.received).toHaveLength(1);
    expect(loop.received[0].headers.authorization).toBeUndefined();
    expect(JSON.parse(loop.received[0].body)).toMatchObject([{ type: 'assign', to: 'dev-backend', source: 'hook' }]);
  });

  it('kontrol positif: dengan token ke loopback http://127.0.0.1 terkirim dengan Bearer', async () => {
    loop.received.length = 0;
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: loop.url, AI_OFFICE_TOKEN: TOKEN });
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    expect(loop.received).toHaveLength(1);
    expect(loop.received[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.skipIf(!CAN_BIND_127_0_0_2)(`https:// ke host non-loopback tidak diblokir aturan ini (koneksi TLS dicoba)${skipNote}`, async () => {
    // Penangkap TCP mentah: menghitung koneksi masuk tanpa pernah menjawab handshake TLS.
    let conns = 0;
    const sockets = new Set();
    const raw = createNetServer((sock) => {
      conns++;
      sockets.add(sock);
      sock.on('error', () => {});
    });
    await new Promise((resolve) => raw.listen(0, '127.0.0.2', resolve));
    try {
      const r = await runHook(ASSIGN, { AI_OFFICE_URL: `https://127.0.0.2:${raw.address().port}/api/events`, AI_OFFICE_TIMEOUT_MS: '500' });
      expect(r).toMatchObject({ code: 0, out: '' });
      expect(conns).toBeGreaterThanOrEqual(1);
    } finally {
      for (const sock of sockets) sock.destroy();
      await new Promise((resolve) => raw.close(resolve));
    }
  });

  it('http:// ke 0.0.0.0 dan ke IP LAN juga ditolak tanpa koneksi', async () => {
    for (const target of ['http://0.0.0.0:9/api/events', 'http://192.0.2.10/api/events', 'http://127.0.0.1.nip.io/api/events']) {
      const r = await runHook(ASSIGN, { AI_OFFICE_URL: target, AI_OFFICE_DEBUG: '1' });
      expect(r).toMatchObject({ code: 0, out: '' });
      expect(r.err, target).toMatch(/event tidak dikirim lewat http:\/\/ ke host non-loopback/);
    }
  });

  it.skipIf(!CAN_BIND_127_0_0_2)(`dengan token: tidak ada request sama sekali, exit 0, DEBUG menjelaskan tanpa membocorkan token${skipNote}`, async () => {
    cap.received.length = 0;
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: cap.url, AI_OFFICE_TOKEN: TOKEN, AI_OFFICE_DEBUG: '1' });
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(cap.received).toHaveLength(0);
    expect(r.err).toMatch(/token tidak dikirim lewat http:\/\/ ke host non-loopback \(127\.0\.0\.2\)/);
    expect(r.err).not.toContain(TOKEN);
  });

  it('dengan token ke domain publik via http://: dilewati tanpa koneksi (cepat), exit 0', async () => {
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: 'http://office.example.com/api/events', AI_OFFICE_TOKEN: TOKEN, AI_OFFICE_DEBUG: '1' });
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(r.err).toMatch(/host non-loopback \(office\.example\.com\)/);
    expect(r.err).not.toContain(TOKEN);
  });

  it('token berisi spasi di tengah atau protokol bukan http(s): tidak dikirim', async () => {
    const spaced = await runHook(ASSIGN, { AI_OFFICE_URL: 'http://127.0.0.1:9/api/events', AI_OFFICE_TOKEN: 'abc def', AI_OFFICE_DEBUG: '1' });
    expect(spaced).toMatchObject({ code: 0, out: '' });
    expect(spaced.err).toMatch(/spasi atau karakter tidak valid/);
    const ftp = await runHook(ASSIGN, { AI_OFFICE_URL: 'ftp://127.0.0.1/api/events', AI_OFFICE_TOKEN: TOKEN, AI_OFFICE_DEBUG: '1' });
    expect(ftp).toMatchObject({ code: 0, out: '' });
    expect(ftp.err).toMatch(/protokol ftp: tidak didukung/);
    expect(ftp.err).not.toContain(TOKEN);
  });
});

describe('token tidak pernah tercetak, termasuk dengan AI_OFFICE_DEBUG=1', () => {
  let echo;
  beforeAll(async () => {
    // Server jahat/rusak yang memantulkan header Authorization di body error.
    echo = await captureServer({
      handler: (req, _body, res) => res.writeHead(500, JSON_HEADERS).end(JSON.stringify({ ok: false, error: `ditolak: ${req.headers.authorization}` })),
    });
  });
  afterAll(() => echo.close());

  it.each([
    ['server memantulkan token di body error', () => echo.url],
    ['server mati (koneksi ditolak)', () => 'http://127.0.0.1:9/api/events'],
    ['URL tidak valid yang memuat token', () => `bukan url ${TOKEN}`],
    ['token di path URL', () => `http://127.0.0.1:9/${TOKEN}/api/events`],
  ])('%s', async (_n, target) => {
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: target(), AI_OFFICE_TOKEN: TOKEN, AI_OFFICE_DEBUG: '1' });
    expect(r.code).toBe(0);
    expect(r.out).toBe('');
    expect(r.err.length).toBeGreaterThan(0); // memang ada pesan debug
    expect(r.err).not.toContain(TOKEN);
  });

  it('body error yang memantulkan token disamarkan sebagai [token]', async () => {
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: echo.url, AI_OFFICE_TOKEN: TOKEN, AI_OFFICE_DEBUG: '1' });
    expect(r.err).toMatch(/HTTP 500/);
    expect(r.err).toContain('Bearer [token]');
  });

  it('input stdin rusak / kosong dengan DEBUG=1: exit 0, stdout kosong, token tidak tercetak', async () => {
    for (const input of ['ini bukan json', '', '{"hook_event_name":']) {
      const r = await runNode([join(ROOT, 'hooks', 'send-event.mjs')], {
        env: cleanEnv({ AI_OFFICE_URL: url, AI_OFFICE_TOKEN: TOKEN, AI_OFFICE_DEBUG: '1' }),
        input,
      });
      expect(r.code).toBe(0);
      expect(r.out).toBe('');
      expect(r.err).not.toContain(TOKEN);
    }
  });
});

describe('AI_OFFICE_TIMEOUT_MS', () => {
  let slow;
  beforeAll(async () => {
    // Menahan respons 2,5 detik.
    slow = await captureServer({ handler: (_req, _body, res) => setTimeout(() => res.writeHead(202, JSON_HEADERS).end('{"ok":true}'), 2500) });
  });
  afterAll(() => slow.close());

  it('300 ms: hook memutus request sebelum server menjawab dan exit 0', async () => {
    slow.received.length = 0;
    const baseline = await nodeBaseline();
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: slow.url, AI_OFFICE_TIMEOUT_MS: '300' });
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(slow.received).toHaveLength(1);
    // Bukti utama: hook memutus koneksi sebelum server menjawab (jawaban baru dikirim setelah 2,5 detik).
    await waitFor(() => slow.received[0].aborted);
    expect(slow.received[0].aborted).toBe(true);
    expect(r.ms).toBeLessThan(baseline + 2500); // relatif terhadap start Node kosong (stabil saat suite paralel)
  });

  it('5000 ms: hook menunggu jawaban 2,5 detik (lebih lama dari default 800 ms)', async () => {
    slow.received.length = 0;
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: slow.url, AI_OFFICE_TIMEOUT_MS: '5000' });
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(r.ms).toBeGreaterThanOrEqual(2400);
    expect(slow.received[0].aborted).toBe(false);
  });

  it('nilai tidak valid → default 800 ms (tetap memutus sebelum 2,5 detik)', async () => {
    slow.received.length = 0;
    const baseline = await nodeBaseline();
    const r = await runHook(ASSIGN, { AI_OFFICE_URL: slow.url, AI_OFFICE_TIMEOUT_MS: 'abc' });
    expect(r.code).toBe(0);
    await waitFor(() => slow.received[0]?.aborted);
    expect(slow.received[0].aborted).toBe(true);
    expect(r.ms).toBeLessThan(baseline + 2500);
  });
});

describe('SubagentStop membaca ekor agent_transcript_path', () => {
  const write = (name, text) => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  const env = () => ({ AI_OFFICE_TOKEN: TOKEN });

  it('last_assistant_message kosong + transkrip SubagentHandback BUTUH BANTUAN → event blocked', async () => {
    const p = write('blocked.jsonl', jsonl(
      entry('user', 'Tugas: uji login'),
      entry('assistant', [{ type: 'text', text: 'Saya jalankan test.' }]),
      entry('assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }]),
      entry('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }]),
      handback(REPORT_BLOCKED),
      toolResult(),
    ));
    const r = await viaHook(stop({ agent_transcript_path: p }), env());
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'blocked', from: 'dev-qa', to: 'manager', message: 'Uji login butuh server staging dari dev-devops.' });
  });

  it('transkrip SubagentHandback SELESAI → done dengan ringkasan laporan', async () => {
    const p = write('done.jsonl', jsonl(entry('user', 'Tugas'), handback(REPORT_DONE), toolResult()));
    const r = await viaHook(stop({ agent_transcript_path: p }), env());
    expect(r.events[0]).toMatchObject({ type: 'done', message: '12 test auth ditambahkan, semua lulus.' });
  });

  it('pesan mengutip STATUS di tengah kalimat → transkrip yang dipakai', async () => {
    const p = write('quoted.jsonl', jsonl(entry('user', 'Tugas'), handback(REPORT_BLOCKED)));
    const r = await viaHook(stop({ last_assistant_message: 'Laporan berformat "STATUS: SELESAI" sudah diserahkan.', agent_transcript_path: p }), env());
    expect(r.events[0]).toMatchObject({ type: 'blocked' });
  });

  it('pesan sudah berpenanda STATUS di awal baris → transkrip diabaikan', async () => {
    const p = write('ignored.jsonl', jsonl(entry('user', 'Tugas'), handback(REPORT_BLOCKED)));
    const r = await viaHook(stop({ last_assistant_message: REPORT_DONE, agent_transcript_path: p }), env());
    expect(r.events[0]).toMatchObject({ type: 'done' });
  });

  it('transkrip > 512 KB dengan handback di akhir → tetap terbaca (ekor file)', async () => {
    const filler = entry('assistant', [{ type: 'text', text: 'x'.repeat(2000) }]);
    const p = write('big.jsonl', jsonl(entry('user', 'Tugas'), ...Array.from({ length: 1500 }, () => filler), handback(REPORT_BLOCKED), toolResult()));
    const r = await viaHook(stop({ agent_transcript_path: p }), env());
    expect(r.events[0]).toMatchObject({ type: 'blocked' });
  });

  it('transkrip hilang, berupa folder, atau biner rusak → done "Tugas selesai", exit 0', async () => {
    const folder = join(dir, 'folder.jsonl');
    mkdirSync(folder);
    const binary = join(dir, 'rusak.jsonl');
    writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x7b, 0x0a, 0x80, 0x81]));
    for (const p of [join(dir, 'hilang.jsonl'), folder, binary]) {
      const r = await viaHook(stop({ agent_transcript_path: p }), { ...env(), AI_OFFICE_DEBUG: '1' });
      expect(r).toMatchObject({ code: 0, out: '' });
      expect(r.events).toHaveLength(1);
      expect(r.events[0]).toMatchObject({ type: 'done', message: 'Tugas selesai' });
    }
  });

  it('agent_type kosong (agen internal) → tidak ada event walau transkrip ada', async () => {
    const p = write('internal.jsonl', jsonl(handback(REPORT_BLOCKED)));
    const r = await viaHook(stop({ agent_type: '', agent_transcript_path: p }), env());
    expect(r).toMatchObject({ code: 0, out: '', events: [] });
  });
});

describe('alur realistis (realisticSteps dan demo-hooks --asli) lewat hook sungguhan', () => {
  const EXPECTED = ['assign', 'assign', 'working', 'working', 'working', 'working', 'working', 'done', 'working', 'blocked'];

  it('realisticSteps(dir): setiap langkah lewat hook → urutan event sesuai, laporan diambil dari transkrip', async () => {
    const d = mkdtempSync(join(dir, 'real-'));
    const before = s.app.history.length;
    for (const step of realisticSteps(d)) {
      const r = await runHook(step, { AI_OFFICE_URL: url, AI_OFFICE_TOKEN: TOKEN });
      expect(r).toMatchObject({ code: 0, out: '' });
    }
    const evs = s.app.history.slice(before);
    expect(evs.map((e) => e.type)).toEqual(EXPECTED);
    expect(evs[7]).toMatchObject({ type: 'done', from: 'dev-frontend', message: 'Form login token dan tombol keluar selesai, build lulus.' });
    expect(evs[9]).toMatchObject({ type: 'blocked', from: 'dev-devops', message: 'Butuh izin CEO untuk membeli domain dan sertifikat sebelum Nginx dipasang.' });
    expect(evs[6]).toMatchObject({ type: 'working', from: 'dev-frontend', message: 'Menyerahkan laporan ke manajer' });
  }, 30000);

  it('node scripts/demo-hooks.mjs --asli --fast: exit 0, event sesuai, folder sementara dihapus, token tidak tercetak', async () => {
    const demoDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('ai-office-demo-')).sort();
    const dirsBefore = demoDirs();
    const before = s.app.history.length;
    const r = await runNode(['scripts/demo-hooks.mjs', '--asli', '--fast'], {
      env: cleanEnv({ AI_OFFICE_URL: url, AI_OFFICE_TOKEN: TOKEN }),
      timeoutMs: 30000,
    });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/12\. SubagentStop \(dev-devops\) → exit 0/);
    expect(r.out + r.err).not.toContain(TOKEN);
    expect(s.app.history.slice(before).map((e) => e.type)).toEqual(EXPECTED);
    expect(demoDirs()).toEqual(dirsBefore);
  }, 30000);
});

describe('R6: hook membaca token dari AI_OFFICE_TOKEN_FILE', () => {
  // Folder home palsu (USERPROFILE untuk Windows, HOME untuk Linux/macOS) supaya "~" tidak menyentuh home asli.
  let home;
  const homeEnv = () => ({ USERPROFILE: home, HOME: home });
  const WRONG = randomToken();
  beforeAll(() => {
    home = mkdtempSync(join(dir, 'home-'));
    mkdirSync(join(home, '.ai-office'));
    writeFileSync(join(home, '.ai-office', 'token'), `\uFEFF  ${TOKEN}\r\n`); // BOM + spasi + CRLF
    writeFileSync(join(home, 'salah.txt'), `${WRONG}\n`);
    writeFileSync(join(home, 'besar.txt'), `${WRONG}\n`.repeat(200)); // > 4 KB
    mkdirSync(join(home, 'folder'));
  });

  it('"~/.ai-office/token" (BOM + spasi + CRLF) → event sampai dengan token dari file, tanpa output', async () => {
    const r = await viaHook(ASSIGN, { ...homeEnv(), AI_OFFICE_TOKEN_FILE: '~/.ai-office/token' });
    expect(r).toMatchObject({ code: 0, out: '', err: '' });
    expect(r.events).toHaveLength(1);
    expect(r.events[0]).toMatchObject({ type: 'assign', to: 'dev-backend', source: 'hook' });
  });

  it('file berisi token salah → server menolak (401), isi file tidak tercetak walau DEBUG=1', async () => {
    const r = await viaHook(ASSIGN, { ...homeEnv(), AI_OFFICE_TOKEN_FILE: '~/salah.txt', AI_OFFICE_DEBUG: '1' });
    expect(r).toMatchObject({ code: 0, out: '', events: [] });
    expect(r.err).toMatch(/HTTP 401/);
    expect(r.err).not.toContain(WRONG);
    expect(r.err).not.toContain(TOKEN);
  });

  it.each([
    ['hilang', '~/tidak-ada.txt', /tidak ditemukan; lanjut tanpa token/],
    ['berupa folder', '~/folder', /bukan file biasa; lanjut tanpa token/],
    ['lebih dari 4 KB', '~/besar.txt', /lebih besar dari 4096 byte; lanjut tanpa token/],
  ])('file %s → lanjut tanpa token (401), exit 0; DEBUG menyebut path dan alasan, bukan isinya', async (_label, path, re) => {
    const quiet = await viaHook(ASSIGN, { ...homeEnv(), AI_OFFICE_TOKEN_FILE: path });
    expect(quiet).toMatchObject({ code: 0, out: '', err: '', events: [] });
    const loud = await viaHook(ASSIGN, { ...homeEnv(), AI_OFFICE_TOKEN_FILE: path, AI_OFFICE_DEBUG: '1' });
    expect(loud).toMatchObject({ code: 0, out: '', events: [] });
    expect(loud.err).toMatch(re);
    expect(loud.err).toContain(home); // path yang sudah diperluas
    expect(loud.err).toMatch(/HTTP 401/);
    expect(loud.err).not.toContain(WRONG);
  });

  it('AI_OFFICE_TOKEN (env) diutamakan atas file', async () => {
    const envWins = await viaHook(ASSIGN, { ...homeEnv(), AI_OFFICE_TOKEN: TOKEN, AI_OFFICE_TOKEN_FILE: '~/salah.txt' });
    expect(envWins.events).toHaveLength(1);
    const envWrong = await viaHook(ASSIGN, { ...homeEnv(), AI_OFFICE_TOKEN: WRONG, AI_OFFICE_TOKEN_FILE: '~/.ai-office/token' });
    expect(envWrong.events).toHaveLength(0);
  });

  it('token dari file tetap tidak dikirim lewat http:// ke host non-loopback', async () => {
    const r = await runHook(ASSIGN, { ...homeEnv(), AI_OFFICE_URL: 'http://office.example.com/api/events', AI_OFFICE_TOKEN_FILE: '~/.ai-office/token', AI_OFFICE_DEBUG: '1' });
    expect(r).toMatchObject({ code: 0, out: '' });
    expect(r.err).toMatch(/token tidak dikirim lewat http:\/\/ ke host non-loopback/);
    expect(r.err).not.toContain(TOKEN);
  });
});
