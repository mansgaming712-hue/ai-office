# Fungsi bersama untuk skrip autostart AI Office di Windows (di-dot-source, bukan dijalankan langsung).
# Semua path diturunkan dari lokasi folder ini, jadi proyek tetap jalan bila foldernya dipindah.

$script:AiProjectDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:AiServerJs   = Join-Path $script:AiProjectDir 'server\index.js'
$script:AiLogDir     = Join-Path $script:AiProjectDir 'logs'
$script:AiLogFile    = Join-Path $script:AiLogDir 'server.log'
# Port default 3000. AI_OFFICE_AUTOSTART_PORT hanya untuk uji (mis. saat port 3000 dipakai server lain).
$script:AiPort       = if ($env:AI_OFFICE_AUTOSTART_PORT -match '^\d+$') { [int]$env:AI_OFFICE_AUTOSTART_PORT } else { 3000 }
$script:AiHealthUrl  = "http://127.0.0.1:$($script:AiPort)/api/health"
$script:AiShortcut   = Join-Path ([Environment]::GetFolderPath('Startup')) 'AI Office.lnk'
$script:AiLauncher   = Join-Path $PSScriptRoot 'start-ai-office.vbs'
$script:AiSupervisor = Join-Path $PSScriptRoot 'ai-office-supervisor.ps1'

function Test-AiHealth {
    # True bila server AI Office di port 3000 menjawab {"ok":true}.
    try {
        $req = [System.Net.HttpWebRequest]::Create($script:AiHealthUrl)
        $req.Proxy = $null
        $req.Timeout = 2000
        $req.ReadWriteTimeout = 2000
        $resp = $req.GetResponse()
        try {
            $reader = New-Object System.IO.StreamReader($resp.GetResponseStream())
            $body = $reader.ReadToEnd()
        } finally { $resp.Close() }
        $json = $body | ConvertFrom-Json
        return ($json.ok -eq $true)
    } catch {
        return $false
    }
}

function Test-AiPortOpen {
    # True bila ada program apa pun yang mendengar di 127.0.0.1:3000.
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect('127.0.0.1', $script:AiPort, $null, $null)
        if (-not $ar.AsyncWaitHandle.WaitOne(1000)) { return $false }
        $client.EndConnect($ar)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-AiContains([string]$text, [string]$needle) {
    if (-not $text) { return $false }
    return ($text.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
}

function Get-AiSupervisorProcesses {
    # Supervisor = powershell.exe yang menjalankan ai-office-supervisor.ps1 milik proyek ini.
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" |
        Where-Object { (Test-AiContains $_.CommandLine $script:AiSupervisor) -and $_.ProcessId -ne $PID }
}

function Get-AiServerProcesses {
    # Hanya proses yang dijalankan peluncur: node.exe (dan cmd.exe pembungkus log) yang command line-nya
    # memuat path absolut server\index.js proyek ini. Proses node lain tidak disentuh.
    Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='cmd.exe'" |
        Where-Object { Test-AiContains $_.CommandLine $script:AiServerJs }
}

function Stop-AiOffice {
    # Matikan supervisor dulu (supaya tidak menyalakan ulang), lalu server. Mengembalikan jumlah proses.
    $count = 0
    foreach ($p in @(Get-AiSupervisorProcesses)) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  dihentikan: supervisor PID $($p.ProcessId)"
        $count++
    }
    foreach ($p in @(Get-AiServerProcesses)) {
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
        Write-Host "  dihentikan: $($p.Name) PID $($p.ProcessId)"
        $count++
    }
    return $count
}

function Wait-AiHealth([bool]$wantUp, [int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        if ((Test-AiHealth) -eq $wantUp) { return $true }
        Start-Sleep -Milliseconds 500
    }
    return ((Test-AiHealth) -eq $wantUp)
}

function Find-AiNode {
    # Cari node.exe: dari PATH dulu, lalu lokasi standar installer Node.js.
    $cmd = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
    foreach ($c in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:LOCALAPPDATA\Programs\nodejs\node.exe")) {
        if ($c -and (Test-Path -LiteralPath $c)) { return $c }
    }
    return $null
}
