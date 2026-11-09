# Matikan sementara server AI Office yang dijalankan peluncur (autostart tetap terpasang;
# server menyala lagi saat login berikutnya atau bila start-ai-office.vbs dijalankan).
# Hanya proses milik AI Office yang dihentikan, proses node lain tidak disentuh.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ai-office-common.ps1')

Write-Host 'Mematikan server AI Office...'
$n = Stop-AiOffice
if ($n -eq 0) { Write-Host '  Tidak ada proses AI Office dari peluncur yang berjalan.' }

if (Wait-AiHealth $false 10) {
    Write-Host 'Server AI Office sudah mati.' -ForegroundColor Green
    exit 0
}
Write-Host "Port $($script:AiPort) masih menjawab sebagai AI Office. Kemungkinan server itu dijalankan manual (npm start) dari terminal lain; tutup terminal itu." -ForegroundColor Yellow
exit 1
