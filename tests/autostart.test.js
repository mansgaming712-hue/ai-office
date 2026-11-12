// Autostart Windows (scripts/windows/): pemeriksaan statis. Tidak ada skrip autostart yang dijalankan;
// powershell.exe hanya dipakai untuk Parser::ParseFile (cek sintaks, tidak mengeksekusi isi skrip).
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from './helpers/testkit.js';

const DIR = 'scripts/windows';
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const EXPECTED = [
  'ai-office-common.ps1',
  'ai-office-supervisor.ps1',
  'install-autostart.ps1',
  'start-ai-office.vbs',
  'stop-ai-office.ps1',
  'uninstall-autostart.ps1',
];
const FILES = readdirSync(join(ROOT, DIR)).sort();
const PS1 = FILES.filter((f) => f.endsWith('.ps1'));
const src = Object.fromEntries(FILES.map((f) => [f, read(`${DIR}/${f}`)]));
/** Isi tanpa baris komentar (# untuk PowerShell, ' untuk VBScript), supaya kata di komentar tidak memicu test. */
const code = (f) =>
  src[f]
    .split(/\r?\n/)
    .filter((l) => !/^\s*(#|')/.test(l))
    .join('\n');
const ALL_CODE = FILES.map(code).join('\n');
const COMMON = code('ai-office-common.ps1');
const SUP = code('ai-office-supervisor.ps1');
const INSTALL = code('install-autostart.ps1');
const PKG = JSON.parse(read('package.json'));

function findPowerShell() {
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
    if (r.status === 0) return exe;
  }
  return null;
}
const PWSH = process.platform === 'win32' ? findPowerShell() : null;

describe('autostart: file', () => {
  it('semua file yang diharapkan ada di scripts/windows/', () => {
    for (const f of EXPECTED) expect(FILES, f).toContain(f);
  });

  it.each(FILES)('%s hanya ASCII (aman untuk PowerShell 5.1 dan wscript tanpa BOM)', (f) => {
    const bytes = readFileSync(join(ROOT, DIR, f));
    const bad = [...bytes].findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d));
    expect(bad, `byte non-ASCII di offset ${bad}`).toBe(-1);
  });

  it('.gitignore memuat logs/', () => {
    expect(read('.gitignore').split(/\r?\n/).map((l) => l.trim())).toContain('logs/');
  });
});

describe('autostart: sintaks PowerShell', () => {
  it.skipIf(!PWSH)(
    `setiap .ps1 lolos Parser::ParseFile${PWSH ? '' : ' (DILEWATI: powershell.exe/pwsh.exe tidak tersedia)'}`,
    () => {
      const list = PS1.map((f) => `'${join(ROOT, DIR, f).replace(/'/g, "''")}'`).join(',');
      const script =
        `$out = foreach ($p in @(${list})) { $t = $null; $e = $null; ` +
        `[void][System.Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e); ` +
        `[pscustomobject]@{ file = [IO.Path]::GetFileName($p); errors = @($e | ForEach-Object { "L$($_.Extent.StartLineNumber): $($_.Message)" }) } }; ` +
        `ConvertTo-Json -InputObject @($out) -Depth 4 -Compress`;
      const r = spawnSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        timeout: 60000,
        windowsHide: true,
      });
      expect(r.status, r.stderr).toBe(0);
      const res = JSON.parse(r.stdout.trim());
      expect(res.map((x) => x.file).sort()).toEqual(PS1);
      for (const x of res) expect(x.errors, x.file).toEqual([]);
    },
    90000,
  );
  if (!PWSH) it.skip('parse PowerShell dilewati: powershell.exe tidak tersedia di mesin ini', () => {});
});

describe('autostart: supervisor', () => {
  it('memaksa HOST=127.0.0.1 dan tidak pernah memakai 0.0.0.0', () => {
    expect(SUP).toMatch(/\$env:HOST\s*=\s*'127\.0\.0\.1'/);
    expect(ALL_CODE).not.toContain('0.0.0.0');
    expect(ALL_CODE).not.toMatch(/\$env:HOST\s*=\s*(?!\s|'127\.0\.0\.1')/);
    // Cek health dan cek port juga hanya ke loopback.
    expect(COMMON).toMatch(/AiHealthUrl\s*=\s*"http:\/\/127\.0\.0\.1:/);
    expect(COMMON).toMatch(/BeginConnect\('127\.0\.0\.1'/);
  });

  it('PORT default 3000; AI_OFFICE_AUTOSTART_PORT hanya diterima bila berupa angka', () => {
    expect(COMMON).toMatch(/\$env:AI_OFFICE_AUTOSTART_PORT -match '\^\\d\+\$'/);
    expect(COMMON).toMatch(/else \{ 3000 \}/);
    expect(SUP).toMatch(/\$env:PORT\s*=\s*"\$\(\$script:AiPort\)"/);
  });

  it('menjalankan server\\index.js proyek ini dan log ke logs\\server.log', () => {
    expect(COMMON).toMatch(/AiServerJs\s*=\s*Join-Path \$script:AiProjectDir 'server\\index\.js'/);
    expect(COMMON).toMatch(/AiLogFile\s*=\s*Join-Path \$script:AiLogDir 'server\.log'/);
    expect(SUP).toContain('>> "\' + $script:AiLogFile');
  });

  it('restart dibatasi: jeda bertahap, batas crash beruntun, sleep sebelum restart', () => {
    const delays = SUP.match(/\$Delays\s*=\s*@\(([^)]*)\)/);
    expect(delays).not.toBeNull();
    const nums = delays[1].split(',').map((s) => Number(s.trim()));
    expect(nums).toEqual([5, 10, 20, 40, 60]);
    for (let i = 1; i < nums.length; i++) expect(nums[i]).toBeGreaterThan(nums[i - 1]);
    expect(SUP).toMatch(/\$MaxFailures\s*=\s*8\b/);
    // Loop wajib punya jalan keluar saat batas crash tercapai, dan Start-Sleep dengan jeda dari tabel.
    const loop = SUP.slice(SUP.indexOf('while ($true)'));
    expect(loop).toMatch(/if \(\$failures -gt \$MaxFailures\) \{[\s\S]*?break/);
    expect(loop).toMatch(/\$delay = \$Delays\[/);
    expect(loop).toMatch(/Start-Sleep -Seconds \$delay/);
    expect(loop.indexOf('Start-Sleep -Seconds $delay')).toBeGreaterThan(loop.indexOf('WaitForExit()'));
  });

  it('satu instance: mutex per proyek + cek health sebelum start', () => {
    expect(SUP).toMatch(/New-Object System\.Threading\.Mutex\(\$false, \$mutexName\)/);
    expect(SUP).toMatch(/\$mutexName = 'Local\\AiOfficeSupervisor_'/);
    expect(SUP).toMatch(/if \(-not \$owned\) \{ exit 0 \}/);
    expect(SUP.indexOf('if (Test-AiHealth)')).toBeLessThan(SUP.indexOf('while ($true)'));
  });

  it('berhenti (bukan restart) bila port dipakai program lain', () => {
    expect(SUP).toMatch(/if \(Test-AiPortOpen\) \{[^}]*break\s*\}/);
  });
});

describe('autostart: stop/uninstall hanya menyentuh proses milik proyek', () => {
  it('tidak ada pembunuhan massal node.exe/powershell.exe', () => {
    expect(ALL_CODE).not.toMatch(/taskkill/i);
    expect(ALL_CODE).not.toMatch(/Stop-Process\s+-Name/i);
    expect(ALL_CODE).not.toMatch(/Get-Process[^\n|]*\|\s*Stop-Process/i);
    expect(ALL_CODE).not.toMatch(/\bkill\s+-Name/i);
    expect(ALL_CODE).not.toMatch(/\.Kill\(\)/);
    // Setiap Stop-Process memakai -Id dari daftar yang sudah disaring.
    const stops = ALL_CODE.match(/Stop-Process[^\n]*/g) ?? [];
    expect(stops.length).toBeGreaterThan(0);
    for (const s of stops) expect(s).toMatch(/Stop-Process -Id \$p\.ProcessId/);
  });

  it('proses disaring lewat path absolut proyek (supervisor .ps1 dan server\\index.js)', () => {
    expect(COMMON).toMatch(/AiProjectDir\s*=\s*\[System\.IO\.Path\]::GetFullPath\(\(Join-Path \$PSScriptRoot '\.\.\\\.\.'\)\)/);
    expect(COMMON).toMatch(/Test-AiContains \$_\.CommandLine \$script:AiSupervisor\)/);
    expect(COMMON).toMatch(/Test-AiContains \$_\.CommandLine \$script:AiServerJs/);
    expect(COMMON).toMatch(/-ne \$PID/);
  });

  it.each(['stop-ai-office.ps1', 'uninstall-autostart.ps1'])('%s memakai Stop-AiOffice dari common', (f) => {
    const c = code(f);
    expect(c).toContain(". (Join-Path $PSScriptRoot 'ai-office-common.ps1')");
    expect(c).toMatch(/\$n = Stop-AiOffice/);
    expect(c).not.toMatch(/Stop-Process|Get-CimInstance|Get-Process/);
  });

  it('uninstall hanya menghapus shortcut Startup milik AI Office', () => {
    const removes = code('uninstall-autostart.ps1').match(/Remove-Item[^\n]*/g) ?? [];
    expect(removes).toEqual(['Remove-Item -LiteralPath $script:AiShortcut -Force']);
  });
});

describe('autostart: installer', () => {
  it('shortcut hanya di folder Startup pengguna', () => {
    expect(COMMON).toMatch(/AiShortcut\s*=\s*Join-Path \(\[Environment\]::GetFolderPath\('Startup'\)\) 'AI Office\.lnk'/);
    expect(INSTALL).toMatch(/\$shell\.CreateShortcut\(\$script:AiShortcut\)/);
    expect(INSTALL.match(/CreateShortcut\(/g)).toHaveLength(1);
    expect(ALL_CODE).not.toMatch(/CommonStartup/i);
  });

  it('tanpa registry Run key, schtasks, service, atau perintah admin', () => {
    const forbidden = [
      /CurrentVersion\\Run/i,
      /\bHK(LM|CU)\b/i,
      /HKEY_/i,
      /Registry::/i,
      /New-ItemProperty|Set-ItemProperty/i,
      /\breg(\.exe)?\s+add\b/i,
      /schtasks/i,
      /Register-ScheduledTask|New-ScheduledTask/i,
      /New-Service|\bsc(\.exe)?\s+create\b/i,
      /-Verb\s+RunAs/i,
      /\bRunAs\b/i,
      /Set-ExecutionPolicy/i,
      /netsh/i,
      /New-NetFirewallRule/i,
      /RegWrite/i,
    ];
    for (const re of forbidden) expect(ALL_CODE, String(re)).not.toMatch(re);
  });

  it('installer hanya menulis shortcut dan folder logs (tidak menulis file lain)', () => {
    expect(INSTALL).not.toMatch(/Set-Content|Add-Content|Out-File|Copy-Item|Move-Item|Remove-Item|WriteAllText/);
    const newItems = INSTALL.match(/New-Item[^\n]*/g) ?? [];
    for (const n of newItems) expect(n).toContain('$script:AiLogDir');
  });
});

describe('autostart: script npm', () => {
  const scripts = Object.entries(PKG.scripts);

  it('autostart:install/uninstall/stop/status memanggil dispatcher Node lintas platform', () => {
    for (const c of ['install', 'uninstall', 'stop', 'status']) {
      expect(PKG.scripts[`autostart:${c}`]).toBe(`node scripts/autostart.mjs ${c}`);
    }
  });

  it('tidak ada script npm yang memakai PowerShell langsung (ExecutionPolicy hanya di dispatcher, dites di autostartCrossPlatform.test.js)', () => {
    for (const [k, v] of scripts) {
      expect(v, k).not.toMatch(/powershell|ExecutionPolicy|-Command|-EncodedCommand|\s-enc\s/i);
    }
  });
});

describe('autostart: rahasia', () => {
  it('tidak ada token, password, atau string rahasia di skrip', () => {
    for (const f of FILES) {
      const s = src[f];
      expect(s, f).not.toMatch(/AI_OFFICE_TOKEN/);
      expect(s, f).not.toMatch(/(token|password|passwd|secret|api[_-]?key)\s*[:=]/i);
      expect(s, f).not.toMatch(/Authorization|Bearer\s/i);
      // Tidak ada string mirip kunci: base64/base64url/hex panjang.
      const keyLike = (s.match(/[A-Za-z0-9_+/-]{32,}/g) ?? []).filter((m) => /[0-9]/.test(m) && /[A-Za-z]/.test(m));
      expect(keyLike, f).toEqual([]);
    }
  });
});
