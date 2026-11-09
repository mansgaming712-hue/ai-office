# Supervisor AI Office: menjalankan server (node server\index.js) tanpa jendela, mencatat log ke
# logs\server.log, dan menyalakan ulang bila crash dengan jeda bertahap.
# Biasanya dipanggil oleh start-ai-office.vbs (tersembunyi), bukan langsung.
param(
    [string]$NodePath = ''
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ai-office-common.ps1')

$MaxLogBytes  = 5MB
$Delays       = @(5, 10, 20, 40, 60)   # jeda sebelum restart (detik), naik bertahap
$MaxFailures  = 8                      # berhenti setelah 8 crash beruntun
$StableSecs   = 120                    # server yang hidup >= 2 menit dianggap stabil, hitungan crash di-reset

function Write-SupLog([string]$msg) {
    $line = "{0} [supervisor] {1}`r`n" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    for ($i = 0; $i -lt 5; $i++) {
        try {
            [System.IO.File]::AppendAllText($script:AiLogFile, $line, (New-Object System.Text.UTF8Encoding($false)))
            return
        } catch { Start-Sleep -Milliseconds 200 }
    }
}

function Invoke-LogRotation {
    # Rotasi sederhana: bila server.log > 5 MB, ganti nama jadi server.log.1 (versi lama ditimpa).
    # Dilakukan sebelum setiap start, saat tidak ada proses yang memegang file log.
    try {
        if ((Test-Path -LiteralPath $script:AiLogFile) -and ((Get-Item -LiteralPath $script:AiLogFile).Length -gt $MaxLogBytes)) {
            $old = "$($script:AiLogFile).1"
            if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
            Rename-Item -LiteralPath $script:AiLogFile -NewName 'server.log.1'
            Write-SupLog 'Log lama (> 5 MB) dipindah ke server.log.1'
        }
    } catch {
        Write-SupLog "Rotasi log gagal: $($_.Exception.Message)"
    }
}

if (-not (Test-Path -LiteralPath $script:AiLogDir)) { New-Item -ItemType Directory -Path $script:AiLogDir | Out-Null }

# --- Satu instance -------------------------------------------------------------------------------
# 1) Mutex per pengguna: hanya satu supervisor boleh jalan.
$mutexName = 'Local\AiOfficeSupervisor_' + ([BitConverter]::ToString(
    [System.Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($script:AiProjectDir.ToLowerInvariant())))).Replace('-', '').Substring(0, 16)
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$owned = $false
try { $owned = $mutex.WaitOne(0) } catch [System.Threading.AbandonedMutexException] { $owned = $true }
if (-not $owned) { exit 0 }   # supervisor lain sudah jalan, diam saja

# 2) Server sudah menjawab di port 3000 (mis. dijalankan manual): jangan jalankan instance kedua.
if (Test-AiHealth) {
    Write-SupLog "Server AI Office sudah menjawab di port $($script:AiPort). Tidak menjalankan instance kedua."
    exit 0
}

# --- Cari node -----------------------------------------------------------------------------------
$node = $null
if ($NodePath -and (Test-Path -LiteralPath $NodePath)) { $node = $NodePath }
if (-not $node) {
    if ($NodePath) { Write-SupLog "node tidak ditemukan di '$NodePath' (path saat instalasi), mencari node lain." }
    $node = Find-AiNode
}
if (-not $node) {
    Write-SupLog 'GAGAL: node.exe tidak ditemukan (tidak ada di PATH maupun C:\Program Files\nodejs). Pasang Node.js lalu jalankan npm run autostart:install lagi.'
    exit 1
}
if (-not (Test-Path -LiteralPath $script:AiServerJs)) {
    Write-SupLog "GAGAL: $($script:AiServerJs) tidak ada."
    exit 1
}
if (-not (Test-Path -LiteralPath (Join-Path $script:AiProjectDir 'dist\index.html'))) {
    Write-SupLog 'Peringatan: dist\ belum di-build. Jalankan "npm run build" supaya halaman kantor tampil.'
}

# Paksa mode lokal: hanya loopback, port default 3000.
$env:HOST = '127.0.0.1'
$env:PORT = "$($script:AiPort)"

Write-SupLog "Supervisor mulai (PID $PID, node: $node)"

# --- Loop jalankan + restart ---------------------------------------------------------------------
$failures = 0
while ($true) {
    if (Test-AiHealth) {
        Write-SupLog "Server AI Office lain sudah menjawab di port $($script:AiPort). Supervisor berhenti."
        break
    }
    if (Test-AiPortOpen) {
        Write-SupLog "BERHENTI: port $($script:AiPort) dipakai program lain (bukan AI Office). Tutup program itu lalu login ulang atau jalankan start-ai-office.vbs."
        break
    }

    Invoke-LogRotation
    Write-SupLog 'Menjalankan server AI Office...'

    # cmd.exe dipakai hanya untuk mengalihkan stdout+stderr node ke file log (append, UTF-8 apa adanya).
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $env:ComSpec
    $psi.Arguments = '/d /s /c ""' + $node + '" "' + $script:AiServerJs + '" >> "' + $script:AiLogFile + '" 2>&1"'
    $psi.WorkingDirectory = $script:AiProjectDir
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $started = Get-Date
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        $proc.WaitForExit()
        $code = $proc.ExitCode
    } catch {
        $code = -1
        Write-SupLog "Gagal menjalankan node: $($_.Exception.Message)"
    }
    $ran = [int]((Get-Date) - $started).TotalSeconds
    Write-SupLog "Server berhenti (exit code $code) setelah $ran detik."

    if ($ran -ge $StableSecs) { $failures = 0 }
    $failures++
    if ($failures -gt $MaxFailures) {
        Write-SupLog "BERHENTI: server crash $MaxFailures kali beruntun. Periksa log di atas, perbaiki, lalu jalankan start-ai-office.vbs atau login ulang."
        break
    }
    $delay = $Delays[[Math]::Min($failures - 1, $Delays.Count - 1)]
    Write-SupLog "Menyalakan ulang dalam $delay detik (percobaan $failures dari $MaxFailures)."
    Start-Sleep -Seconds $delay
}

$mutex.ReleaseMutex()
exit 0
