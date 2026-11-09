# Pasang autostart AI Office untuk akun Windows yang sedang login (tanpa hak admin).
# Membuat shortcut "AI Office.lnk" di folder Startup pengguna yang memanggil start-ai-office.vbs,
# lalu langsung menyalakan server sekali. Aman dijalankan berulang (shortcut ditimpa).
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ai-office-common.ps1')

Write-Host 'Memasang autostart AI Office...'

$node = Find-AiNode
if (-not $node) {
    Write-Host 'GAGAL: node.exe tidak ditemukan. Pasang Node.js (https://nodejs.org) lalu ulangi.' -ForegroundColor Red
    exit 1
}
$nodeVersion = (& $node -v)
Write-Host "  node     : $node ($nodeVersion)"
Write-Host "  proyek   : $($script:AiProjectDir)"

if (-not (Test-Path -LiteralPath (Join-Path $script:AiProjectDir 'dist\index.html'))) {
    Write-Host '  Peringatan: dist\ belum ada. Jalankan "npm run build" supaya halaman kantor tampil.' -ForegroundColor Yellow
}
if (-not (Test-Path -LiteralPath $script:AiLogDir)) { New-Item -ItemType Directory -Path $script:AiLogDir | Out-Null }

$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($script:AiShortcut)
$lnk.TargetPath = $wscript
$lnk.Arguments = '"' + $script:AiLauncher + '" "' + $node + '"'
$lnk.WorkingDirectory = $script:AiProjectDir
$lnk.Description = 'Menyalakan server AI Office (http://localhost:3000) saat login Windows'
$lnk.IconLocation = "$node,0"
$lnk.Save()
Write-Host "  shortcut : $($script:AiShortcut)"
Write-Host "  target   : $wscript $($lnk.Arguments)"

$url = "http://localhost:$($script:AiPort)"
if (Test-AiHealth) {
    if (@(Get-AiSupervisorProcesses).Count -gt 0) {
        Write-Host "Server AI Office sudah jalan di $url dari peluncur (tidak dijalankan ulang)." -ForegroundColor Green
    } else {
        Write-Host "Server AI Office sudah jalan di $url, tetapi BUKAN dari peluncur (mis. npm start atau preview editor)." -ForegroundColor Yellow
        Write-Host '  Server itu tidak dinyalakan ulang bila crash. Autostart mengambil alih pada login berikutnya,'
        Write-Host '  atau tutup server itu lalu jalankan: npm run autostart:install'
    }
    exit 0
}

Write-Host 'Menyalakan server sekarang...'
Start-Process -FilePath $wscript -ArgumentList $lnk.Arguments -WorkingDirectory $script:AiProjectDir
if (Wait-AiHealth $true 30) {
    Write-Host "Selesai. Server AI Office jalan di $url dan akan menyala otomatis setiap login." -ForegroundColor Green
    exit 0
}
Write-Host "Shortcut terpasang, tetapi server belum menjawab dalam 30 detik. Lihat log: $($script:AiLogFile)" -ForegroundColor Yellow
exit 1
