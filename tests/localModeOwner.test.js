// Mode lokal tanpa token: (a) supervisor Windows memeriksa pemilik listener port, (b) peringatan saat server
// start, hanya di mode lokal. Skrip PowerShell diuji statis; bila powershell.exe ada di Windows, fungsi pemeriksa
// pemilik dijalankan dengan input dummy dan port acak (port 3000 sungguhan tidak pernah disentuh).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { ROOT, SERVER_ENTRY, cleanEnv, freePort, randomToken, runNode, sleep } from './helpers/testkit.js';

const DIR = 'scripts/windows';
const strip = (t) =>
  t
    .split(/\r?\n/)
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
const COMMON = strip(readFileSync(join(ROOT, DIR, 'ai-office-common.ps1'), 'utf8'));
const SUP = strip(readFileSync(join(ROOT, DIR, 'ai-office-supervisor.ps1'), 'utf8'));
const COMMON_PATH = join(ROOT, DIR, 'ai-office-common.ps1');

describe('supervisor Windows: pemeriksaan pemilik port (statis)', () => {
  it('common memakai Get-NetTCPConnection (Listen) -> OwningProcess -> pemilik proses', () => {
    expect(COMMON).toMatch(/Get-NetTCPConnection\s+-LocalPort\s+\$port\s+-State\s+Listen/);
    expect(COMMON).toMatch(/OwningProcess/);
    expect(COMMON).toMatch(/GetOwner/);
    expect(COMMON).toMatch(/WindowsIdentity\]::GetCurrent\(\)/);
    expect(COMMON).toMatch(/function Resolve-AiOwnerState/);
  });

  it('Test-AiHealth hanya true bila pemilik listener sama dengan akun berjalan', () => {
    const fn = COMMON.slice(COMMON.indexOf('function Test-AiHealth'), COMMON.indexOf('function Test-AiPortOpen'));
    expect(fn).toMatch(/Get-AiPortOwnerState/);
    expect(fn).toMatch(/State\s+-eq\s+'same'/);
  });

  it('pemilik asing atau tidak terbaca: peringatan jelas di log dan exit 1 (bukan exit 0)', () => {
    expect(SUP).toMatch(/PERINGATAN: port .*dipakai proses milik akun lain/);
    expect(SUP).toMatch(/State -eq 'other' -or \$o\.State -eq 'unknown'/);
    expect(SUP).toMatch(/if \(Test-AiPortForeign\) \{ exit 1 \}/);
    expect(SUP).toMatch(/if \(Test-AiPortForeign\) \{\s*\$mutex\.ReleaseMutex\(\)\s*exit 1\s*\}/);
  });

  it('pemeriksaan pemilik dilakukan SEBELUM Test-AiHealth (awal dan di dalam loop)', () => {
    const first = SUP.indexOf('if (Test-AiPortForeign) { exit 1 }');
    expect(first).toBeGreaterThan(-1);
    expect(first).toBeLessThan(SUP.indexOf('if (Test-AiHealth) {'));
    const loop = SUP.indexOf('while ($true) {');
    const inLoop = SUP.indexOf('Test-AiPortForeign', loop);
    expect(inLoop).toBeGreaterThan(loop);
    expect(inLoop).toBeLessThan(SUP.indexOf('Test-AiHealth', loop));
  });

  it('perilaku akun yang sama dipertahankan (exit 0 bila server sendiri sudah menjawab)', () => {
    expect(SUP).toMatch(/if \(Test-AiHealth\) \{[^}]*exit 0/s);
  });

  it('antarmuka file tidak berubah: peluncur vbs tetap memanggil supervisor yang sama', () => {
    expect(readFileSync(join(ROOT, DIR, 'start-ai-office.vbs'), 'utf8')).toMatch(/ai-office-supervisor\.ps1/);
  });
});

function findPowerShell() {
  if (process.platform !== 'win32') return null;
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '1'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    if (r.status === 0) return exe;
  }
  return null;
}
const PWSH = findPowerShell();

function ps(script) {
  const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', `. '${COMMON_PATH}'; ${script}`], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    env: cleanEnv(),
  });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

// Tiap test memanggil PowerShell sungguhan (start ~1-3 dtk, lebih lambat saat mesin sibuk): batas waktu dilonggarkan.
describe.skipIf(!PWSH)('pemeriksa pemilik (PowerShell sungguhan, input dummy)', { timeout: 60000 }, () => {
  it('Resolve-AiOwnerState: same / other / unknown', () => {
    const r = ps(
      "$a = Resolve-AiOwnerState 'PC\\alice' 'pc\\ALICE'; $b = Resolve-AiOwnerState 'PC\\bob' 'PC\\alice'; " +
        "$c = Resolve-AiOwnerState '' 'PC\\alice'; $d = Resolve-AiOwnerState $null 'PC\\alice'; $e = Resolve-AiOwnerState 'PC\\alice' ''; " +
        "Write-Output \"$a,$b,$c,$d,$e\"",
    );
    expect(r.err).toBe('');
    expect(r.out).toBe('same,other,unknown,unknown,unknown');
  });

  it('port acak tanpa listener -> none; listener milik proses akun ini -> same', async () => {
    const free = await freePort();
    expect(ps(`(Get-AiPortOwnerState ${free}).State`).out).toBe('none');
    const srv = createServer((s) => s.end());
    await new Promise((res) => srv.listen(0, '127.0.0.1', res));
    try {
      const { port } = srv.address();
      expect(ps(`(Get-AiPortOwnerState ${port}).State`).out).toBe('same');
    } finally {
      await new Promise((res) => srv.close(res));
    }
  });
});

describe('peringatan mode lokal saat server start', () => {
  const WARN = /mode lokal tanpa token bisa diakses semua akun dan proses di komputer ini.*AI_OFFICE_TOKEN_FILE/i;

  async function run(env) {
    const port = await freePort();
    let ready = false;
    const r = await runNode([SERVER_ENTRY], {
      env: cleanEnv({ PORT: String(port), ...env }),
      timeoutMs: 10000,
      onStdout: (out, child) => {
        if (ready || !out.includes('jalan di')) return;
        ready = true;
        sleep(150).then(() => child.kill());
      },
    });
    return { ...r, all: r.out + r.err };
  }

  it('tercetak di mode lokal, tanpa nilai rahasia', async () => {
    const r = await run({});
    expect(r.out).toMatch(/Mode: lokal tanpa token/);
    expect(r.all).toMatch(WARN);
  });

  it('tidak muncul di mode token, dan token tidak tercetak', async () => {
    const T = randomToken();
    const r = await run({ AI_OFFICE_TOKEN: T });
    expect(r.out).toMatch(/Mode: token aktif/);
    expect(r.all).not.toMatch(WARN);
    expect(r.all).not.toContain(T);
  });
});

describe('README memuat catatan mode lokal', () => {
  it.each([
    ['README.md', /every account and every process on this computer.*port 3000.*AI_OFFICE_TOKEN_FILE/s],
    ['README.id.md', /semua akun dan proses di komputer ini.*port 3000.*AI_OFFICE_TOKEN_FILE/s],
  ])('%s', (f, re) => {
    expect(readFileSync(join(ROOT, f), 'utf8')).toMatch(re);
  });
});
