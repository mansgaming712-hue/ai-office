# Deploy AI Office ke VPS (Bagian 4)

Panduan ini memindahkan animasi AI Office dari `localhost:3000` ke server sendiri (VPS) dengan
alamat seperti `https://office.example.com`, supaya bisa dibuka dari mana saja dan tetap menerima
event dari Claude Code di komputer CEO.

> **Butuh izin CEO.** Menyewa VPS, membeli domain, dan menjalankan `setup-vps.sh` di server
> adalah langkah berisiko dan/atau berbayar. Jangan dijalankan sebelum CEO menyetujui bagian
> [Biaya dan keputusan](#0-biaya-dan-keputusan-ceo).

Di seluruh panduan ini, ganti:

- `office.example.com` dengan domain/subdomain Anda,
- `203.0.113.10` dengan IP VPS Anda,
- `root` dengan nama user SSH Anda bila bukan root (mis. `ubuntu`, atau user sudo dari bagian 11).

## Gambaran singkat

```
Komputer CEO                               VPS (Ubuntu)
-------------                              ----------------------------------------------
Claude Code + hooks  --HTTPS + token-->    Nginx :443 (TLS Let's Encrypt, HSTS, batas laju)
Browser (login token) --HTTPS-->              |  /ws (WebSocket), /api/*, UI
                                              v
                                           App Node 127.0.0.1:3000 (user aioffice, systemd)
                                           Rahasia: /etc/ai-office/ai-office.env (hanya root)
Firewall UFW: hanya port 22 (SSH, dibatasi laju), 80 (HTTP -> HTTPS), 443 (HTTPS) yang terbuka.
```

- App tidak pernah bisa diakses langsung dari internet: ia hanya mendengar di `127.0.0.1:3000`.
  Semua lalu lintas lewat Nginx dengan HTTPS.
- Permintaan ke IP VPS langsung atau dengan nama domain lain ditutup Nginx tanpa jawaban.
- Event (`/api/events`) dan WebSocket (`/ws`) butuh token (login di browser, atau header
  `Authorization: Bearer` dari hooks). Yang terbuka tanpa token hanya `/api/health` (tanpa jumlah
  klien/event), `/api/session`, `/api/login`, dan `/api/logout`.
- Tidak ada database. Riwayat event hanya di memori dan hilang setiap app di-restart atau diupdate.
  Log tetap ada di disk server (isinya dijelaskan di bagian 9).

## 0. Biaya dan keputusan CEO

| Item | Wajib? | Jenis biaya | Catatan |
| --- | --- | --- | --- |
| VPS | Ya | Bulanan | Paket terkecil sudah cukup: 1 vCPU, 1 GB RAM, 20 GB disk, Ubuntu 22.04/24.04, jenis **KVM** (bukan OpenVZ/LXC). Harga berbeda per penyedia dan lokasi; cek harga terkini di situs penyedia. |
| Domain | Ya | Tahunan | Kalau sudah punya domain, cukup buat subdomain (mis. `office.domainanda.com`), **tanpa biaya tambahan**. Kalau belum, beli domain baru; harga tergantung ekstensi (.com, .id, dll.). |
| Sertifikat HTTPS | Ya | Gratis | Let's Encrypt, diperpanjang otomatis. |
| Pembaruan keamanan Ubuntu | Ya | Gratis | Dipasang otomatis tiap hari (`unattended-upgrades`). |
| Backup/snapshot VPS | Tidak | Biasanya berbayar tambahan | Tidak wajib: tidak ada data yang perlu dicadangkan (lihat bagian 9). |
| Pemantau uptime | Tidak | Ada yang gratis | Opsional, memantau `https://office.example.com/api/health`. |

Keputusan yang dibutuhkan:

1. Penyedia VPS, lokasi server, dan paket.
2. Domain/subdomain yang dipakai.
3. Izin menjalankan `setup-vps.sh` di VPS (mengubah konfigurasi server, lihat bagian 3).
4. Siapa yang memegang akses SSH dan token.
5. Persetujuan bahwa event (judul tugas agen, nama file yang disentuh) dikirim ke server di
   internet. Yang tersimpan di server:
   - **Riwayat event** (300 terakhir) hanya di memori app, hilang saat restart.
   - **Log app** (journald) secara default hanya berisi metadata event: tipe, pengirim, penerima,
     dan panjang pesan. **Isi pesan** hanya ikut dicatat bila `AI_OFFICE_LOG_MESSAGES=1`
     diaktifkan di file env (untuk debugging sementara).
   - Log journald dan log akses Nginx **ditulis ke disk** VPS dan disimpan beberapa waktu
     (bagian 9).
6. Opsional: batas umur log di server (retensi journald, bagian 9). Berlaku untuk semua log sistem.
7. Disarankan: pengerasan SSH manual (bagian 11), oleh orang yang memegang akses SSH.

## 1. Prasyarat

1. **VPS** Ubuntu 22.04 atau 24.04, arsitektur amd64 atau arm64, minimal 1 GB RAM.
2. **Akses SSH** sebagai `root` atau user yang boleh `sudo`. Disarankan login dengan kunci SSH
   dan mematikan login kata sandi (bagian 11). SSH harus di port 22 (kalau tidak, skrip tidak
   mengaktifkan firewall supaya Anda tidak terkunci; lihat bagian 12).
3. **DNS A record** di pengelola domain:

   | Tipe | Nama | Nilai |
   | --- | --- | --- |
   | A | `office` | `203.0.113.10` (IP VPS) |

   Jangan menambah record AAAA kecuali VPS memang punya IPv6 yang aktif; AAAA yang salah membuat
   penerbitan sertifikat gagal.
4. Cek DNS dari komputer Windows (PowerShell). Hasilnya harus IP VPS:

   ```powershell
   nslookup office.example.com
   ```

   Perubahan DNS bisa butuh beberapa menit sampai beberapa jam.
5. Kalau penyedia VPS punya firewall di panelnya, buka port 22, 80, dan 443.

## 2. Menyalin kode ke VPS

Yang disalin adalah folder proyek **tanpa** `node_modules`, `dist`, `.git`, dan
`.claude/settings.local.json` (file pribadi). Kode di VPS di-build ulang di sana.

### Opsi A: dari Windows (PowerShell, tanpa instal apa pun)

```powershell
cd "C:\lokasi\folder\ai-office"
tar -czf ..\ai-office.tgz --exclude=node_modules --exclude=dist --exclude=.git --exclude=settings.local.json .
scp ..\ai-office.tgz root@203.0.113.10:~/
```

Lalu di VPS (`ssh root@203.0.113.10`):

```bash
rm -rf ~/ai-office && mkdir ~/ai-office && tar -xzf ~/ai-office.tgz -C ~/ai-office
```

`~/ai-office` hanya salinan unggahan, aman dihapus dan dibuat ulang. App yang berjalan ada di
`/opt/ai-office`.

### Opsi B: rsync (macOS, Linux, atau WSL)

```bash
rsync -az --delete --exclude node_modules --exclude dist --exclude .git \
  --exclude .claude/settings.local.json ./ root@203.0.113.10:~/ai-office/
```

### Opsi C: git (kalau nanti proyek sudah memakai git)

```bash
git clone <alamat-repo> ~/ai-office     # pertama kali
git -C ~/ai-office pull                 # update berikutnya
```

Repo privat butuh deploy key di VPS. Pastikan `.claude/settings.local.json` ada di `.gitignore`.

## 3. Setup (sekali, butuh izin CEO)

```bash
ssh root@203.0.113.10
cd ~/ai-office
sudo bash deploy/setup-vps.sh office.example.com email@domainanda.com
```

> **Jangan merekam output setup.** Token rahasia tampil di akhir. Jangan menjalankan skrip dengan
> `| tee file.log`, `> file`, `script`, asciinema, atau perekam layar, dan jangan menyalin output
> terminal ke chat atau email. Kalau output dialihkan, skrip menulis token langsung ke terminal
> saja; tanpa terminal (mis. `ssh` tanpa sesi interaktif), token tidak ditampilkan sama sekali.

Email dipakai untuk akun Let's Encrypt. Prosesnya beberapa menit. Yang dilakukan skrip:

1. Memasang paket: nginx, certbot, ufw, rsync, curl, openssl, unattended-upgrades.
2. Memastikan pembaruan keamanan Ubuntu terpasang otomatis tiap hari (`unattended-upgrades`).
   VPS **tidak** di-reboot otomatis (bagian 9).
3. Memasang Node.js LTS (24) dari repo resmi NodeSource, kalau Node 22+ belum ada. Fingerprint
   kunci GPG NodeSource dicek dulu; kalau berbeda, setup berhenti (lihat di bawah).
4. Mengaktifkan firewall UFW: hanya port 22, 80, 443. Port 22 memakai `ufw limit`: IP yang membuka
   6 koneksi SSH baru atau lebih dalam 30 detik ditolak sementara. Konfigurasi SSH (`sshd_config`)
   **tidak** diubah; itu langkah manual di bagian 11.
5. Membuat user sistem `aioffice` (tidak bisa login) dan folder `/opt/ai-office`.
6. Membuat `/etc/ai-office/ai-office.env` (hanya bisa dibaca root) berisi token acak baru.
   Kalau file itu sudah ada, tokennya **tidak** diganti.
7. Memasang service `ai-office` (jalan otomatis saat boot, restart sendiri bila mati, dibatasi
   384 MB RAM dan 64 proses/thread).
8. Build app (`npm ci`, `npm run build`) dan menjalankannya.
9. Mematikan halaman bawaan Nginx, mengambil sertifikat HTTPS, memasang konfigurasi Nginx
   (batas laju login/API/WebSocket, penolakan domain tak dikenal, header keamanan), dan
   perpanjangan sertifikat otomatis.
10. Memeriksa hasilnya, lalu **menampilkan token sekali**.

> **Simpan token** yang muncul di kotak `TOKEN AI OFFICE` ke pengelola kata sandi (password
> manager). Kalau terlewat, root bisa melihatnya lagi:
> `sudo grep AI_OFFICE_TOKEN /etc/ai-office/ai-office.env`.

Skrip aman dijalankan ulang dengan perintah yang sama, mis. setelah memperbaiki DNS.

### Verifikasi kunci NodeSource (disarankan, sebelum setup pertama)

Skrip hanya memasang kunci repo NodeSource bila fingerprint kunci utamanya sama dengan nilai di
`deploy/setup-vps.sh` (`NODESOURCE_GPG_FPR_DEFAULT`):

```
6F71 F525 2828 41EE DAF8  51B4 2F59 B5F9 9B1B E0B4
```

Nilai ini dicek pada 2026-11-08 terhadap kunci yang disajikan di
`https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key` (RSA 2048, dibuat 2016-05-23,
key ID `2F59B5F99B1BE0B4`, nama `NSolid <nsolid-gpg@nodesource.com>`). Untuk memeriksanya
sendiri, cocokkan dengan dokumentasi resmi NodeSource
(`https://github.com/nodesource/distributions`) dan dengan kunci yang disajikan sekarang
(di VPS atau Linux mana pun; kunci tidak diimpor):

```bash
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.key
gpg --show-keys --with-fingerprint /tmp/nodesource.key
# baris di bawah "pub" harus sama persis dengan fingerprint di atas
```

Kalau setup berhenti dengan `Fingerprint kunci NodeSource TIDAK cocok`, **jangan dilewati**.
Kemungkinan NodeSource mengganti kunci, atau unduhan dimanipulasi. Cek pengumuman resmi
NodeSource. Hanya setelah fingerprint baru terverifikasi dari sumber resmi, jalankan ulang dengan
`sudo NODESOURCE_GPG_FPR=<fingerprint baru> bash deploy/setup-vps.sh ...`, lalu minta
`dev-devops` memperbarui nilai bawaan di kit.

## 4. Cek apakah berhasil

Dari komputer Windows (PowerShell; pakai `curl.exe`, bukan `curl`):

```powershell
curl.exe https://office.example.com/api/health
# harus: {"ok":true,...}

curl.exe -s -o NUL -w "%{http_code}`n" https://office.example.com/api/events
# harus: 401 (ditolak tanpa token)

curl.exe -s -o NUL -w "%{http_code}`n" http://office.example.com/
# harus: 301 (dialihkan ke HTTPS)

curl.exe -s -o NUL -w "%{http_code}`n" http://203.0.113.10/
curl.exe -sk -o NUL -w "%{http_code}`n" https://203.0.113.10/
# keduanya harus: 000 (akses lewat IP langsung ditutup Nginx tanpa jawaban)
```

Di browser:

1. Buka `https://office.example.com`. Harus ada ikon gembok (HTTPS valid).
2. Halaman meminta token: tempel token, lalu masuk.
3. Kantor pixel tampil dan status koneksi online. Klik **Simulasi** untuk mencoba.

## 5. Mengarahkan hooks Claude Code ke VPS

Hooks di komputer CEO membaca token dari **file** lewat `AI_OFFICE_TOKEN_FILE`, bukan dari
`AI_OFFICE_TOKEN` di `.claude/settings.local.json`. Alasannya: semua isi bagian `"env"` di file
settings diwariskan ke **setiap** proses yang dijalankan Claude Code (perintah shell agen, skrip
npm, server MCP). Token di sana bisa ikut tercetak di log, output perintah, atau laporan error.
File token hanya dibuka oleh hook saat mengirim event.

Catatan jujur: program lain yang berjalan dengan akun Windows/macOS yang sama tetap bisa membaca
file itu. Cara ini mencegah token bocor tanpa sengaja, bukan melindungi dari malware di komputer.

### 5a. Simpan token ke file (sekali, dan setiap rotasi token)

**Windows (PowerShell).** Token diminta tersembunyi; folder dibuat hanya bisa dibuka akun Anda:

```powershell
$dir = Join-Path $HOME ".ai-office"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
icacls $dir /inheritance:r /grant:r "$(whoami):(OI)(CI)F" | Out-Null
$s = Read-Host "Tempel token" -AsSecureString
[IO.File]::WriteAllText((Join-Path $dir "token"), [Net.NetworkCredential]::new("", $s).Password.Trim())
Remove-Variable s
icacls (Join-Path $dir "token")
(Get-Content (Join-Path $dir "token") -Raw).Length
```

Hasil `icacls` harus hanya satu baris berisi nama akun Anda (`...\nama:(I)(F)`), dan panjang
token 43 (token buatan `setup-vps.sh`/`rotate-token.sh`).

**macOS / Linux (Terminal, bash atau zsh):**

```bash
mkdir -p ~/.ai-office && chmod 700 ~/.ai-office
printf 'Tempel token: '; IFS= read -rs t; echo
(umask 077 && printf '%s' "$t" > ~/.ai-office/token); unset t
ls -l ~/.ai-office/token       # harus -rw------- milik Anda
wc -c < ~/.ai-office/token     # harus 43
```

Jangan menyimpan file token di dalam folder proyek (bisa ikut tersalin ke VPS atau ter-commit).

Format file token:

- **Satu baris** berisi token saja. Baris kosong dan spasi di tepi diabaikan; file dengan lebih dari
  satu baris berisi ditolak.
- Encoding UTF-8 (dengan atau tanpa BOM) atau UTF-16 **dengan** BOM (mis. hasil `>` di Windows
  PowerShell 5.1) didukung. UTF-16 tanpa BOM ditolak.
- Maksimal 4 KB (4096 byte), dan harus file biasa (bukan folder atau FIFO).

File yang ditolak, kosong, atau tidak ditemukan diperlakukan seperti tanpa token: hook tetap
mengirim, tetapi tanpa header `Authorization`, sehingga server di VPS menolak dengan `401`.

### 5b. Isi `.claude\settings.local.json`

Di folder proyek AI Office, buat atau edit file `.claude\settings.local.json`. Kalau file sudah
ada (mis. berisi `permissions`), tambahkan bagian `"env"` di sebelahnya; jangan menghapus isi lain.

```json
{
  "env": {
    "AI_OFFICE_URL": "https://office.example.com/api/events",
    "AI_OFFICE_TOKEN_FILE": "~/.ai-office/token",
    "AI_OFFICE_TIMEOUT_MS": "3000"
  }
}
```

- `~` berarti folder user Anda (di Windows `C:\Users\<nama>`). Path ini bukan rahasia.
- **Hapus `AI_OFFICE_TOKEN`** dari bagian `"env"` itu kalau dulu pernah diisi, dan pastikan tidak
  ada variabel lingkungan `AI_OFFICE_TOKEN` di sistem. Selama `AI_OFFICE_TOKEN` terisi, hook
  memakai nilai itu dan file token diabaikan.
- Tutup lalu buka lagi Claude Code dari folder proyek supaya pengaturan terbaca.
- Alamat **wajib** `https://`. Hook menolak mengirim **event apa pun** (dengan atau tanpa token)
  lewat `http://` ke host selain loopback (`127.0.0.1`, `localhost`, `::1`), karena isi event
  (judul tugas, nama file) juga bisa disadap. Event itu dibuang diam-diam; alasannya hanya tampil
  dengan `AI_OFFICE_DEBUG=1`. Jadi VPS wajib memakai HTTPS.
- File settings ini pribadi. Jangan dibagikan dan jangan di-commit ke git.
- Selama hooks diarahkan ke VPS, animasi lokal di `localhost:3000` tidak menerima event.
- Kembali ke lokal: hapus bagian `"env"` itu, lalu buka ulang Claude Code.

### 5c. Uji tanpa Claude Code

PowerShell, dari folder proyek (token tidak diketik; dibaca dari file):

```powershell
$env:AI_OFFICE_URL = "https://office.example.com/api/events"
$env:AI_OFFICE_TOKEN_FILE = "~/.ai-office/token"
npm run demo:hooks
Remove-Item Env:AI_OFFICE_URL, Env:AI_OFFICE_TOKEN_FILE
```

Buka `https://office.example.com` di browser saat demo berjalan: manajer harus mulai berjalan
ke meja agen. Kalau ada error, pesan dari hook tampil di terminal.

## 6. Update aplikasi

1. Salin kode baru ke VPS seperti di bagian 2 (folder `~/ai-office` dibuat ulang).
2. Jalankan:

   ```bash
   sudo bash ~/ai-office/deploy/update.sh
   ```

- Token dan file env tidak disentuh.
- Kalau build gagal, versi lama tetap berjalan tanpa gangguan.
- Kalau versi baru tidak sehat, atau `/api/events` ternyata bisa dibuka tanpa token, skrip
  otomatis kembali ke versi sebelumnya.
- Riwayat event di layar kosong lagi setelah update (memang hanya di memori).
- Kalau file `deploy/systemd/ai-office.service` atau `deploy/nginx/ai-office.conf` ikut berubah,
  jalankan ulang `setup-vps.sh` (bagian 3); `update.sh` hanya mengganti kode.

## 7. Rollback

Kembali ke versi sebelumnya (3 versi terakhir disimpan di `/opt/ai-office/releases`):

```bash
sudo bash /opt/ai-office/current/deploy/update.sh --rollback
ls /opt/ai-office/releases          # daftar versi
readlink -f /opt/ai-office/current  # versi yang aktif
```

Menjalankan `--rollback` lagi mundur satu versi lagi.

Hooks kembali ke animasi lokal: hapus bagian `"env"` di `.claude\settings.local.json` (bagian 5).

Mematikan sementara tanpa menghapus apa pun:

```bash
sudo systemctl stop ai-office       # situs menampilkan 502 sampai dijalankan lagi
sudo systemctl start ai-office      # nyalakan lagi
```

Menonaktifkan sepenuhnya (masih bisa diaktifkan kembali):

```bash
sudo systemctl disable --now ai-office
sudo rm /etc/nginx/sites-enabled/ai-office.conf && sudo systemctl reload nginx
```

Mengaktifkan lagi: jalankan ulang `setup-vps.sh` dengan domain yang sama.

## 8. Rotasi (ganti) token dan mencabut sesi

Ganti token kalau token mungkin bocor, laptop atau ponsel yang pernah login hilang, ada orang yang
tidak lagi boleh mengakses, atau secara berkala (mis. tiap 3 sampai 6 bulan).

```bash
sudo bash /opt/ai-office/current/deploy/rotate-token.sh
```

Sama seperti setup: jangan menjalankannya dengan `| tee`, `script`, atau perekam terminal.

Token baru ditampilkan sekali. Token lama **dan semua sesi browser** langsung tidak berlaku
(cookie sesi diturunkan dari token). Setelah itu:

1. Tulis token baru ke file token di komputer CEO (langkah 5a), lalu buka ulang Claude Code.
2. Login ulang di browser dengan token baru, di setiap perangkat yang masih dipakai.

Kalau app gagal start dengan token baru, skrip memulihkan token lama secara otomatis.

> **Tombol Keluar hanya menghapus cookie di browser itu.** Cookie sesi berlaku 7 hari dan tidak
> dicatat di server, jadi tidak bisa dicabut satu per satu. Untuk mencabut **semua** sesi
> (mis. laptop hilang atau cookie mungkin tersalin), jalankan `rotate-token.sh`.

Cara manual (kalau perlu): buat token dengan `openssl rand -base64 32` atau
`node scripts/gen-token.mjs`, isi ke `AI_OFFICE_TOKEN=` lewat `sudo nano /etc/ai-office/ai-office.env`,
lalu `sudo systemctl restart ai-office`. Token minimal 32 karakter; kalau kurang, app menolak start.

## 9. Log, pemantauan, dan backup

```bash
systemctl status ai-office                      # jalan atau tidak, pemakaian Memory/Tasks
journalctl -u ai-office -f                      # log app langsung (Ctrl+C untuk keluar)
journalctl -u ai-office --since "1 hour ago"    # log 1 jam terakhir
sudo tail -f /var/log/nginx/ai-office.access.log
sudo tail -f /var/log/nginx/ai-office.error.log
sudo certbot certificates                       # tanggal kedaluwarsa sertifikat
```

### Apa yang tersimpan di disk server

| Data | Lokasi | Isi | Berapa lama |
| --- | --- | --- | --- |
| Riwayat event | memori app (bukan disk) | 300 event terakhir | sampai app restart/update |
| Log app | journald (`/var/log/journal`) | default **metadata** event (tipe, pengirim, penerima, panjang pesan), login gagal beserta IP, error. **Isi pesan** hanya bila `AI_OFFICE_LOG_MESSAGES=1` | bawaan Ubuntu: dibatasi ukuran (sekitar 10% disk, maks. 4 GB), **bukan** umur |
| Log akses Nginx | `/var/log/nginx/ai-office.access.log` | IP, waktu, metode + alamat, status, user agent. Tanpa isi permintaan dan tanpa token | dirotasi harian, 14 hari (bawaan Ubuntu) |
| Token | `/etc/ai-office/ai-office.env` | rahasia, hanya root | sampai dirotasi |

`AI_OFFICE_LOG_MESSAGES=1` sebaiknya hanya dipakai sementara untuk mencari masalah: tambahkan
barisnya ke `/etc/ai-office/ai-office.env`, `sudo systemctl restart ai-office`, lalu hapus lagi
dan restart. Isi pesan yang sudah tercatat tetap ada di journald sampai terhapus oleh retensi.

### Retensi log journald (disarankan, butuh persetujuan)

Supaya log tidak disimpan tanpa batas waktu, batasi umur dan ukuran journald. Pengaturan ini
berlaku untuk **semua** log sistem di VPS (termasuk log SSH di journald; `/var/log/auth.log`
tetap mengikuti logrotate), jadi tidak dipasang otomatis oleh `setup-vps.sh`:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nMaxRetentionSec=14day\nSystemMaxUse=500M\n' \
  | sudo tee /etc/systemd/journald.conf.d/50-retensi.conf >/dev/null
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-time=14d               # hapus log yang sudah lebih tua dari 14 hari
journalctl --disk-usage
```

14 hari disamakan dengan log Nginx. Batas khusus untuk service `ai-office` saja butuh
`LogNamespace=` di systemd, yang mengubah cara membaca log (`journalctl --namespace=...`); tidak
dipakai supaya perintah log di panduan ini tetap sama.

### Lainnya

- **Kesehatan:** `https://office.example.com/api/health` (publik) bisa dipasang di layanan
  pemantau uptime. Batas laju API (10 per detik per IP) jauh di atas kebutuhan pemantau.
- **Sertifikat** diperpanjang otomatis oleh `certbot.timer`. Let's Encrypt tidak lagi mengirim
  email pengingat kedaluwarsa, jadi sesekali cek `sudo certbot certificates`.
- **Backup:** tidak ada database atau file data. Satu-satunya rahasia di server adalah
  `/etc/ai-office/ai-office.env`, dan bisa dibuat ulang dengan rotasi token. Kode sumber ada di
  komputer CEO.
- **Pembaruan keamanan Ubuntu** dipasang otomatis tiap hari oleh `unattended-upgrades` (hanya
  arsip keamanan Ubuntu). Yang tetap manual:
  - **Reboot.** Pembaruan kernel baru aktif setelah reboot. Cek `cat /var/run/reboot-required`;
    kalau ada, `sudo reboot` di jam sepi (app menyala sendiri, riwayat event di layar kosong).
  - **Node.js** dari NodeSource tidak ikut diperbarui otomatis. Sebulan sekali:
    `sudo apt update && sudo apt upgrade`, lalu `sudo systemctl restart ai-office`.
  - Log pembaruan otomatis: `/var/log/unattended-upgrades/unattended-upgrades.log`.

## 10. Verifikasi teknis di VPS

Perintah ini untuk orang teknis, setelah `setup-vps.sh` selesai:

| Perintah | Hasil yang diharapkan |
| --- | --- |
| `sudo nginx -t` | `syntax is ok` dan `test is successful` |
| `nginx -v` | 1.18 (Ubuntu 22.04) atau 1.24 (Ubuntu 24.04). Di 1.18, server default 443 memakai sertifikat domain, bukan `ssl_reject_handshake` |
| `sudo systemd-analyze verify /etc/systemd/system/ai-office.service` | tanpa output error |
| `sudo systemd-analyze security ai-office` | label eksposur rendah (`OK` atau lebih baik), jauh di bawah service tanpa hardening yang berlabel `UNSAFE` |
| `systemctl show ai-office -p MemoryHigh -p MemoryMax -p TasksMax` | `MemoryHigh=268435456`, `MemoryMax=402653184`, `TasksMax=64` |
| `systemctl is-active ai-office nginx` | `active` dua kali |
| `sudo certbot renew --dry-run` | `Congratulations, all simulated renewals succeeded` |
| `systemctl list-timers \| grep -E 'certbot\|apt-daily'` | `certbot.timer`, `apt-daily.timer`, `apt-daily-upgrade.timer` terjadwal |
| `apt-config dump \| grep -E 'Periodic::(Update-Package-Lists\|Unattended-Upgrade) '` | keduanya `"1"` |
| `sudo ufw status verbose` | default deny incoming; `22/tcp LIMIT IN`; ALLOW hanya 80, 443 (tanpa `OpenSSH ALLOW`) |
| `sudo ss -tlnp \| grep -E ':(80\|443\|3000)\b'` | 80/443 milik nginx; 3000 hanya `127.0.0.1` |
| `sudo stat -c '%a %U' /etc/ai-office/ai-office.env` | `600 root` |
| `curl -sI https://office.example.com \| grep -i strict-transport` | `max-age=31536000` |
| `curl -s -D - -o /dev/null https://office.example.com/api/health \| grep -iE '^(x-content-type-options\|referrer-policy)'` | `nosniff` dan `no-referrer`, masing-masing satu baris |
| `curl -s -o /dev/null -w '%{http_code}\n' https://office.example.com/api/events` | `401` |
| `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: contoh.invalid' http://127.0.0.1/` | `000` (koneksi ditutup) |
| `curl -sk -o /dev/null -w '%{http_code}\n' --resolve contoh.invalid:443:127.0.0.1 https://contoh.invalid/` | `000` |
| 12x `POST /api/login` cepat (lihat bawah) | sebagian menjawab `429` |
| 200 `GET /api/health` paralel (lihat bawah) | sebagian besar `200`, sisanya `429` |

Uji ini dari VPS, **bukan** dari komputer CEO: setelah 10 login gagal, app memblokir login dari
IP pengirim selama 15 menit (selain batas 5 per menit dari Nginx).

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'Content-Type: application/json' \
    -d '{"token":"salah"}' https://office.example.com/api/login
done; echo
```

Batas laju API (10 per detik per IP, lonjakan 100). IP penguji hanya kena 429 beberapa detik:

```bash
seq 200 | xargs -P 50 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  https://office.example.com/api/health | sort | uniq -c
```

WebSocket tanpa login harus ditolak, dan di browser setelah login harus tersambung (status online):

```bash
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://office.example.com/ws
# harus 401 atau 403
```

## 11. Pengerasan SSH (manual, disarankan)

`setup-vps.sh` sengaja **tidak** mengubah konfigurasi SSH, karena salah langkah bisa mengunci
semua orang dari server. Lakukan langkah ini sendiri, pelan-pelan, dengan **dua sesi SSH**:
sesi pertama tetap terbuka sampai sesi kedua terbukti bisa masuk.

Tujuannya: login hanya dengan kunci SSH (tanpa kata sandi), root tidak bisa login dengan kata
sandi, dan pekerjaan sehari-hari memakai user biasa dengan `sudo`.

**1. Siapkan kunci SSH di komputer CEO** (lewati kalau sudah punya `~/.ssh/id_ed25519.pub`).
Windows 10/11 (PowerShell) dan macOS/Linux sama:

```powershell
ssh-keygen -t ed25519
```

Beri passphrase saat diminta. File `id_ed25519` (tanpa `.pub`) adalah kunci pribadi: jangan
dibagikan.

**2. Buat user sudo** (sesi pertama, sebagai root di VPS; ganti `ceo` dengan nama pilihan):

```bash
adduser ceo                 # isi kata sandi: masih dipakai untuk sudo, bukan untuk login SSH
usermod -aG sudo ceo
```

**3. Pasang kunci publik untuk user itu.** Kalau root sudah login dengan kunci (umum di VPS),
salin kunci yang sama:

```bash
install -d -m 700 -o ceo -g ceo /home/ceo/.ssh
install -m 600 -o ceo -g ceo /root/.ssh/authorized_keys /home/ceo/.ssh/authorized_keys
```

Atau kirim dari komputer CEO (PowerShell):

```powershell
type $HOME\.ssh\id_ed25519.pub | ssh root@203.0.113.10 "install -d -m 700 -o ceo -g ceo /home/ceo/.ssh && tr -d '\r' >> /home/ceo/.ssh/authorized_keys && chown ceo:ceo /home/ceo/.ssh/authorized_keys && chmod 600 /home/ceo/.ssh/authorized_keys"
```

**4. Uji di sesi kedua** (terminal baru; sesi pertama JANGAN ditutup):

```bash
ssh ceo@203.0.113.10
sudo whoami                 # harus: root
```

Kalau gagal, perbaiki dulu langkah 2 atau 3 dari sesi pertama. Jangan lanjut.

**5. Matikan login kata sandi** (dari sesi kedua, sebagai `ceo`):

```bash
printf '%s\n' '# Pengerasan SSH AI Office (manual, docs/DEPLOY.md bagian 11)' \
  'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin prohibit-password' \
  | sudo tee /etc/ssh/sshd_config.d/00-ai-office-hardening.conf >/dev/null
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
```

Hasil harus `passwordauthentication no`, `kbdinteractiveauthentication no`, dan
`permitrootlogin prohibit-password` (versi lama menulisnya `without-password`; artinya sama).
Nama file berawalan `00-` karena SSH memakai nilai **pertama** yang ditemukan, dan sebagian image
VPS punya `50-cloud-init.conf` berisi `PasswordAuthentication yes`. `sshd -t` yang gagal berarti
salah ketik: reload tidak dijalankan, jadi SSH tetap memakai konfigurasi lama.

**6. Uji lagi di sesi ketiga** sebelum menutup sesi mana pun:

```bash
ssh ceo@203.0.113.10                                             # harus berhasil (kunci)
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive ceo@203.0.113.10
# harus ditolak: "Permission denied (publickey)"
```

**Kalau ada yang salah**, dari sesi yang masih terbuka:

```bash
sudo rm /etc/ssh/sshd_config.d/00-ai-office-hardening.conf && sudo systemctl reload ssh
```

Kalau semua sesi terlanjur tertutup, masuk lewat konsol web (VNC/serial) di panel penyedia VPS.

Catatan:

- Mulai sekarang pakai `ssh ceo@203.0.113.10` lalu `sudo ...` untuk semua perintah di panduan ini.
- Batas `ufw limit` di port 22: 6 koneksi baru atau lebih dalam 30 detik dari IP yang sama
  ditolak sementara. Kalau `ssh`/`scp` tiba-tiba timeout setelah banyak koneksi beruntun, tunggu
  30 detik.
- Setelah beberapa minggu lancar, root bisa dimatikan total dengan `PermitRootLogin no` (cara
  dan pengujian yang sama).

## 12. Masalah umum

| Gejala | Penyebab dan solusi |
| --- | --- |
| `$'\r': command not found` atau `invalid option name` | File skrip berubah ke format Windows (CRLF). Di VPS: `sed -i 's/\r$//' ~/ai-office/deploy/*.sh`, lalu ulangi. |
| `http://... belum sampai ke VPS ini` | DNS belum mengarah ke VPS atau port 80 tertutup. Cek A record dan firewall panel penyedia, tunggu, lalu ulangi setup. |
| certbot gagal berulang / `too many failed authorizations` | Batas percobaan Let's Encrypt. Perbaiki DNS, tunggu sekitar 1 jam, lalu ulangi. |
| `nginx -t` gagal dengan `duplicate default server` | Situs lain di `/etc/nginx/sites-enabled` atau `/etc/nginx/conf.d` juga memakai `default_server`. Nonaktifkan situs itu (hapus symlink-nya di `sites-enabled`), lalu ulangi setup. |
| `Fingerprint kunci NodeSource TIDAK cocok` | Jangan dilewati. Lihat "Verifikasi kunci NodeSource" di bagian 3. |
| Browser menampilkan `502 Bad Gateway` | App tidak jalan. Lihat `journalctl -u ai-office -n 50`. |
| Service gagal dengan `226/NAMESPACE` | VPS berjenis container (OpenVZ/LXC) yang tidak mendukung sandbox systemd. Pakai VPS KVM, atau minta `dev-devops` menyesuaikan hardening. |
| App mati berulang, log `oom-kill` / `status=9/KILL` | Melewati batas `MemoryMax=384M`. Laporkan ke `dev-backend` (kemungkinan kebocoran memori); sementara bisa dinaikkan lewat `sudo systemctl edit ai-office` (`[Service]` lalu `MemoryMax=512M`). |
| `token ... kurang dari 32 karakter` | Jalankan `rotate-token.sh` (bagian 8). |
| App menolak start karena `AI_OFFICE_TRUST_PROXY=1` dengan HOST bukan loopback | Ada `HOST=` di `/etc/ai-office/ai-office.env`. Hapus baris itu (HOST diatur unit systemd), lalu `sudo systemctl restart ai-office`. |
| `versi server ini belum memakai autentikasi` | Kode yang disalin belum berisi autentikasi token Bagian 4. Salin versi terbaru. Skrip sengaja menolak memasang versi tanpa token. |
| Login menjawab `429` | Terlalu banyak percobaan login. Tunggu 1 menit (batas Nginx), atau sampai 15 menit bila sudah 10 kali salah token (batas app). |
| Sebagian event hilang saat banyak agen bekerja, log Nginx berisi `limiting requests` | Melewati batas API (10 per detik, lonjakan 100). Laporkan ke `dev-devops` untuk menaikkan `rate`/`burst` zona `aioffice_api`. |
| `SSH memakai port ..., bukan 22` | Skrip tidak mengaktifkan UFW supaya SSH tidak terkunci. Atur manual: `ufw limit <port>/tcp`, `ufw allow 80/tcp`, `ufw allow 443/tcp`, `ufw enable`. |
| `Masih ada aturan ALLOW untuk SSH` | Image VPS sudah punya aturan `OpenSSH ALLOW`, sehingga batas laju tidak berlaku. Pastikan `22/tcp LIMIT` ada di `sudo ufw status`, lalu `sudo ufw delete allow OpenSSH`. |
| `ssh` timeout setelah banyak koneksi beruntun | Batas `ufw limit` (bagian 11). Tunggu 30 detik. |
| Event dari Claude Code tidak muncul | Cek `AI_OFFICE_URL` memakai `https://` dan diakhiri `/api/events`, file token ada dan isinya sama persis dengan token di server, `AI_OFFICE_TOKEN` tidak terisi di tempat lain, lalu jalankan uji di bagian 5c. |
| `AI_OFFICE_TOKEN_FILE (...) tidak valid: file token harus berisi satu baris` | File token berisi lebih dari satu baris (mis. ada baris judul npm karena lupa `-s`). Tulis ulang file berisi token saja (bagian 5a). |
| `AI_OFFICE_TOKEN_FILE (nilainya tidak ditampilkan karena tidak berbentuk path; ...)` | Demi keamanan, path tidak dicetak ke log bila nilainya mirip token: tidak diawali `~` dan tanpa `/` atau `\`, atau seluruhnya berupa 24 karakter lebih dari huruf, angka, `+ / = _ -` saja, tanpa titik (mis. `/etc/ai-office/token-file`). Alasan masalahnya tetap tampil. Pastikan variabel berisi path file, bukan tokennya; path yang diawali `~` atau memakai titik (mis. `token.txt`) akan ditampilkan. |

## 13. Isi kit deploy

| File di proyek | Terpasang di VPS sebagai |
| --- | --- |
| `deploy/setup-vps.sh` | dijalankan sekali dari `~/ai-office` |
| `deploy/update.sh` | update dan `--rollback` |
| `deploy/rotate-token.sh` | ganti token |
| `deploy/lib.sh` | fungsi bersama ketiga skrip di atas |
| `deploy/systemd/ai-office.service` | `/etc/systemd/system/ai-office.service` |
| `deploy/nginx/ai-office.conf` | `/etc/nginx/sites-available/ai-office.conf` (+ symlink di `sites-enabled`) |
| `deploy/nginx/ai-office-http-only.conf` | sementara, hanya sebelum sertifikat pertama terbit |
| `deploy/ai-office.env.example` | contoh isi `/etc/ai-office/ai-office.env` (tanpa token) |

Lokasi lain di VPS: kode di `/opt/ai-office/releases/<waktu>` dengan `/opt/ai-office/current`
menunjuk ke versi aktif; cache build di `/var/lib/ai-office`; sertifikat di
`/etc/letsencrypt/live/office.example.com/`; hook perpanjangan di
`/etc/letsencrypt/renewal-hooks/deploy/ai-office-reload-nginx.sh`; kunci repo NodeSource di
`/etc/apt/keyrings/nodesource.gpg`; pembaruan otomatis di `/etc/apt/apt.conf.d/20auto-upgrades`
(dibuat hanya bila belum ada) dan, bila konfigurasi lain mematikannya,
`/etc/apt/apt.conf.d/52ai-office-auto-upgrades`.
