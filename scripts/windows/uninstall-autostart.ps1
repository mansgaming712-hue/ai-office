# Cabut autostart AI Office: hapus shortcut di folder Startup lalu matikan server yang dijalankan peluncur.
# Hanya proses milik AI Office yang dihentikan, proses node lain tidak disentuh.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ai-office-common.ps1')

Write-Host 'Mencabut autostart AI Office...'
if (Test-Path -LiteralPath $script:AiShortcut) {
    Remove-Item -LiteralPath $script:AiShortcut -Force
    Write-Host "  shortcut dihapus: $($script:AiShortcut)"
} else {
    Write-Host '  shortcut tidak ada (sudah dicabut).'
}

$n = Stop-AiOffice
if ($n -eq 0) { Write-Host '  Tidak ada proses AI Office dari peluncur yang berjalan.' }

if (Wait-AiHealth $false 10) {
    Write-Host 'Autostart dicabut dan server AI Office sudah mati.' -ForegroundColor Green
    exit 0
}
Write-Host "Autostart dicabut, tetapi port $($script:AiPort) masih menjawab sebagai AI Office (kemungkinan dijalankan manual dari terminal lain)." -ForegroundColor Yellow
exit 1
