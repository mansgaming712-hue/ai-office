# AI Office

AI Office adalah kantor pixel art untuk tim subagent Claude Code. Sesi Claude Code utama bertindak sebagai
manajer dan mendelegasikan pekerjaan ke 17 spesialis (Dev, Marketing & Sales, Konten, Riset, dan 3D). Dashboard
di browser menampilkan delegasi itu secara langsung: manajer berjalan ke meja worker, worker mengetik, lalu
laporan kembali ke meja manajer sebagai amplop.

Repo ini berisi tiga hal: definisi agen (`agents/`), aturan manajer (`CLAUDE.md`), dan dashboard beserta
server yang menerima kejadian dari hook Claude Code.

## Fitur

- **Animasi kantor pixel art** di canvas: manajer, meja worker, dan amplop laporan.
- **Simulasi**: tombol ▶ Simulasi memutar skenario contoh (±60 detik) tanpa Claude Code.
- **Kotak perintah**: teks biasa dikirim sebagai perintah ke manajer, `@nama-agen` menugaskan agen, atau
  tempel event JSON.
- **Hooks Claude Code**: delegasi dari sesi Claude Code sungguhan dikirim otomatis ke dashboard.
- **Sesi aktif**: daftar proyek yang punya event dalam 10 menit terakhir.
- **Panel Pemakaian Limit**: estimasi pemakaian token dari log lokal Claude Code. Ini bukan angka resmi.
- **Mode lokal atau mode token**: lokal hanya bisa diakses dari komputer sendiri, mode token untuk akses
  jarak jauh di belakang HTTPS (lihat [Deploy ke VPS](#deploy-ke-vps)).
- **Autostart Windows** (opsional): server menyala otomatis saat login.
- **Validasi dan test**: `npm run agents:validate` dan `npm test`.

## Persyaratan

- **Node.js ≥ 20** (lihat `engines` di `package.json`). Pemuatan `.env` memakai `process.loadEnvFile`
  yang tersedia mulai Node 20.12. Di Node yang lebih lama, `.env` dilewati diam-diam.
- **npm** (ikut terpasang bersama Node.js).
- **Claude Code** (CLI `claude`) untuk delegasi sungguhan. Mode Simulasi tidak membutuhkannya.
- Proyek ini dikembangkan di Windows. Skrip autostart hanya untuk Windows. Platform lain belum diuji.

## Cara install

```bash
git clone https://github.com/mansgaming712-hue/ai-office.git
cd ai-office
npm ci
npm run agents:install
npm run hooks:install-user
```

- `npm run agents:install` menyalin `agents/*.md` ke `~/.claude/agents/`. File yang sudah ada dan berbeda
  tidak ditimpa. Tambahkan `-- --force` untuk menimpanya.
- `npm run hooks:install-user` memasang hook ke `~/.claude/settings.json`. Pemasang menggabungkan dengan
  pengaturan yang ada, membuat backup sebelum menulis, dan aman dijalankan berulang.
  Pemasang menolak path folder proyek yang memuat `"`, baris baru, `$`, backtick, `%`, atau `!`
  (lihat `projectProblem` di `scripts/user-hooks.mjs`), karena command hook dijalankan lewat shell.
- Hook hanya aktif untuk sesi Claude Code yang dimulai **sesudah** pemasangan. Sesi yang sudah berjalan
  perlu dibuka ulang.
- Untuk melepas hook: `npm run hooks:uninstall-user`.

## Cara menjalankan

```bash
npm start
```

Buka **http://localhost:3000**. `npm start` otomatis membangun UI (`prestart`) lalu menjalankan server.

- Kalau sudah pernah membangun UI, pakai `npm run serve` (lebih cepat).
- Port lain: `PORT=3001 npm run serve` (bash) atau `$env:PORT=3001; npm run serve` (PowerShell).
- **▶ Simulasi** memutar skenario contoh tanpa Claude Code. Tombol **↺ Reset** mengosongkan kantor dan log.
- **Kotak perintah**: teks biasa = perintah ke manajer; `@dev-qa jalankan test` = manajer menugaskan agen.
  Klik meja atau nama agen untuk mengisi `@nama`.
- Untuk delegasi sungguhan: jalankan `claude` di folder proyek ini. Aturan manajer di `CLAUDE.md` berlaku
  untuk sesi yang dibuka dari folder ini.

## Konfigurasi

### `.env`

```bash
cp .env.example .env
```

- Semua isi `.env.example` boleh kosong. Tanpa isi, server berjalan di mode lokal (`127.0.0.1:3000`,
  tanpa login).
- File `.env` **tidak ikut ke git** (sudah ada di `.gitignore`). Jangan pernah commit `.env`.
- Variabel yang sudah ada di environment (shell, systemd, atau `env` di `settings.json` Claude Code) **tidak
  ditimpa** oleh `.env` (lihat `server/loadEnv.js`).
- `.env` dibaca oleh server dan oleh hook (`hooks/send-event.mjs`) dari folder proyek ini.
- Daftar lengkap variabel ada di [Variabel lingkungan](#variabel-lingkungan).

### `limit-config.json` (opsional)

```bash
cp limit-config.example.json limit-config.json
```

Isi `weeklyTokenLimit` dengan perkiraan batas token per minggu. Bar batas di panel hanya muncul bila angkanya
lebih dari 0. File ini ada di `.gitignore`. Penjelasan setiap kunci ada di
[Konfigurasi limit](#konfigurasi-limit).

## Agen

17 spesialis ada di `agents/` (sumber) dan dipasang ke `~/.claude/agents/` lewat `npm run agents:install`.

| Divisi | Agen |
| --- | --- |
| Dev | dev-frontend, dev-backend, dev-qa, dev-security, dev-ui-critic, dev-devops, dev-docs |
| Marketing & Sales | sales-copywriter, sales-research, sales-pricing |
| Konten | content-script, content-animator |
| Riset | research-analyst |
| Divisi 3D | 3d-modeler, 3d-materials, 3d-animator, 3d-render |

Model per agen ditulis di frontmatter `model:`: `haiku` untuk dev-docs, research-analyst, dan 3d-render;
`sonnet` untuk sisanya. Hanya `haiku` dan `sonnet` yang diizinkan. Validasi di `scripts/agent-files.mjs`
menolak model lain (mis. `opus`).

Aturan manajer ada di `CLAUDE.md`.

```bash
npm run agents:validate        # cek frontmatter, nama unik, model, aturan spesialis, salinan terpasang
npm run agents:install         # pasang/perbarui ke ~/.claude/agents (tidak menimpa file berbeda)
npm run agents:install -- --force
```

Setelah menarik perubahan yang menambah agen, jalankan `npm run agents:install`. Sebelum itu,
`npm run agents:validate` melaporkan agen yang belum terpasang.

## Format event

Semua kejadian (simulasi, kotak perintah, hooks) memakai satu format:

```json
{ "type": "assign", "from": "manager", "to": "dev-frontend", "message": "Bangun navbar", "time": "2026-11-08T02:30:00.000Z" }
```

- `type`: `assign` | `working` | `done` | `blocked` | `report`
- Kunci bahasa Indonesia juga diterima: `tipe`, `dari`, `ke`, `pesan`, `waktu`.
- `time` boleh dikosongkan (diisi server). Nama khusus: `manager`, `ceo`.
- `project` (opsional): nama folder sesi Claude Code, maks 64 karakter. Diisi oleh hook.
- `tokens` (opsional): `{ input, output, cacheRead, cacheCreation }`, hanya dari SubagentStop. Dipakai untuk
  statistik pemakaian per agen.

Kirim event manual:

```bash
curl -X POST http://localhost:3000/api/events -H "Content-Type: application/json" -d "{\"type\":\"done\",\"from\":\"dev-qa\",\"to\":\"manager\",\"message\":\"9 test lulus\"}"
```

Dalam mode token, tambahkan header `-H "Authorization: Bearer $AI_OFFICE_TOKEN"` (lihat
[Autentikasi dan mode server](#autentikasi-dan-mode-server)).

| Endpoint | Fungsi | Mode token |
| --- | --- | --- |
| `POST /api/events` | satu event atau array (maks 50), wajib `Content-Type: application/json` | wajib Bearer atau cookie sesi, tanpa itu `401` |
| `GET /api/events` | 300 event terakhir | wajib Bearer atau cookie sesi, tanpa itu `401` |
| `GET /api/usage` | `{ok, usage}`: statistik pemakaian token (estimasi lokal) | wajib Bearer atau cookie sesi, tanpa itu `401` |
| `GET /api/health` | status server | terbuka, hanya menjawab `{ok:true}` (tanpa jumlah klien/event) |
| `GET /api/session` | `{ok, authRequired, authenticated}` | terbuka |
| `POST /api/login` | body `{"token":"..."}` (JSON) → cookie sesi `aio_session`; salah `401`, terlalu sering `429` | terbuka (mode lokal selalu `{ok:true}`) |
| `POST /api/logout` | hapus cookie sesi di browser itu, wajib `Content-Type: application/json` (body boleh `{}`) | terbuka |
| `WS /ws` | `{kind:"hello", events}`, `{kind:"usage", usage}`, lalu `{kind:"event", event}` dan `{kind:"usage", usage}` saat berubah | wajib Bearer atau cookie sesi, tanpa itu `401`; koneksi ditutup (kode `4401`) saat sesi kedaluwarsa |

## Hooks Claude Code

Hook Claude Code dipasang di **level user** (`~/.claude/settings.json`), sehingga berlaku untuk sesi dari
folder mana pun. `.claude/settings.json` proyek berisi `{}` dan tidak memasang hook apa pun.

### Pasang dan lepas

```bash
npm run hooks:install-user     # pasang hook AI Office ke ~/.claude/settings.json
npm run hooks:uninstall-user   # lepas hook AI Office dari ~/.claude/settings.json
```

Pemasang (`scripts/install-user-hooks.mjs`, logika bersama di `scripts/user-hooks.mjs`):

- **Merge, tidak menimpa.** Key dan hook lain di settings dibiarkan. Dijalankan berkali-kali tidak
  menambah entri ganda (idempoten).
- **Backup.** Sebelum menulis, file lama disalin ke `~/.claude/settings.json.bak-YYYYMMDD-HHMMSS`
  (kalau nama itu sudah ada, ditambah `-1`, `-2`, dst.). Kalau `settings.json` belum ada, tidak ada backup.
- **Tulis atomik** (file sementara lalu rename). JSON settings yang rusak: tidak ada yang ditulis,
  kode keluar `1`.
- **Path proyek dicek.** Pemasang menolak folder proyek yang path-nya memuat `"`, baris baru, `$`,
  backtick, `%`, atau `!` (karakter yang bisa diekspansi shell). Pindahkan proyek ke folder lain bila
  ditolak. Pastikan folder proyek hanya bisa ditulis akunmu sendiri, karena hook ini berjalan di setiap
  sesi Claude Code. Perintah `hooks:uninstall-user` tidak punya pengecekan ini.
- **Path absolut.** Command hook memakai path absolut `hooks/send-event.mjs` dari folder tempat
  pemasang dijalankan. Entri dikenali dari path itu. Kalau folder proyek dipindah, pasang ulang dari
  lokasi baru. Entri dari lokasi lama tidak dikenali oleh pemasang di lokasi baru: lepas dulu
  dengan `npm run hooks:uninstall-user` dari folder lama, atau hapus entri `send-event.mjs` lama
  dari `settings.json` secara manual (setelah backup).
- **Berlaku untuk sesi baru.** Hook hanya aktif untuk sesi Claude Code yang dimulai sesudah
  pemasangan. Sesi yang sudah berjalan perlu dibuka ulang.
- Untuk uji tanpa menyentuh settings asli, arahkan ke file lain lewat `AI_OFFICE_USER_SETTINGS`
  (lihat [Variabel lingkungan](#variabel-lingkungan)).

Hook yang dipasang (event dan matcher sama dengan `desiredHooks` di `scripts/user-hooks.mjs`):

| Hook | Event AI Office |
| --- | --- |
| `PreToolUse` tool `Agent`/`Task` | `assign` manager → subagent (pesan = description) |
| `SubagentStart` | `working` subagent |
| `PreToolUse` tool lain (async) | `working` dari subagent (atau manajer), mis. `Edit · App.jsx` |
| `SubagentStop` | `done` / `blocked` dari baris `STATUS:` laporan |
| `PostToolUse` tool `Agent`/`Task` | `report` / `blocked` dengan ringkasan laporan |

Perilaku saat berjalan:

- Claude Code menunggu hook paling lama **3 detik** (timeout yang ditulis pemasang).
- Hook mengirim event ke server dengan batas **800 ms** (`AI_OFFICE_TIMEOUT_MS`, default di
  `hooks/send-event.mjs`). Event tidak dikirim ulang.
- Kalau server mati, hook diam-diam keluar dengan kode 0 dan tanpa output, jadi Claude Code tidak
  terganggu. Event yang gagal terkirim tidak tercatat di mana pun, kecuali dengan `AI_OFFICE_DEBUG=1`.
- Setiap event membawa `project`: nama folder sesi (basename `CLAUDE_PROJECT_DIR`, atau cwd bila
  variabel itu kosong). Halaman animasi menampilkan daftar **Sesi aktif**, yaitu sesi dengan event
  dalam 10 menit terakhir.
- Event SubagentStop juga membawa `tokens` dari transkrip subagent untuk statistik per agen.
- Pola rahasia umum (token, API key, password) disembunyikan sebelum dikirim.
- Kalau event identik (type, from, to, message, project) datang lagi dalam 3 detik, server membuangnya
  supaya animasi tidak dobel.

Uji tanpa Claude Code (server harus jalan):

```bash
npm run demo:hooks              # skenario contoh, jeda ±1,8 detik antar langkah
npm run demo:hooks -- --fast    # tanpa jeda
npm run demo:hooks -- --asli    # bentuk payload Claude Code terbaru: agen latar belakang dan
                                # laporan lewat SubagentHandback yang dibaca dari file transkrip
```

Tujuan lain: `AI_OFFICE_URL=http://127.0.0.1:3001/api/events`. Debug: `AI_OFFICE_DEBUG=1`. Daftar lengkap
ada di [Variabel lingkungan](#variabel-lingkungan).

Catatan: cara mengisi variabel hook lewat bagian `"env"` di `~/.claude/settings.json` belum diuji di kode
ini (lihat [Variabel lingkungan](#variabel-lingkungan)).

## Panel Pemakaian Limit

Panel "Pemakaian Limit" di atas kantor menampilkan **estimasi** pemakaian token Claude Code. Angka resmi ada
di `/usage` di Claude Code. Panel tidak memanggil model atau API apa pun.

- **Sumber:** log lokal `~/.claude/projects/**/*.jsonl` (termasuk `subagents/`). Token dihitung dari
  `message.usage`, dedup per `message.id`, dan dikelompokkan per jam lokal. Token per agen berasal
  dari event SubagentStop (window 7 hari).
- **Kapan dihitung ulang:** tiap 60 detik, dan sekitar 2 detik setelah event SubagentStop yang
  membawa `tokens`.
- **Rumus mingguan:** input + output + cache tulis, ditambah cache baca bila `countCacheRead` true.
- **Warna bar:** hijau di bawah 60%, kuning 60–85%, merah di atas 85%. Di atas 85%, panel menampilkan
  peringatan "Limit hampir habis, hemat mode". Bar hanya muncul bila `weeklyTokenLimit` diisi.
- **Data tidak tersedia:** kalau log tidak bisa dibaca (folder tidak ada, kosong, atau format tidak
  dikenali), panel menampilkan "data tidak tersedia" beserta alasannya.
- **Privasi:** hasil dan log hanya berisi angka dan nama agen. Tidak ada path, isi pesan, atau nama sesi.
- **Cache:** `data/usage-cache.json` dan `data/usage-agents.json`, dibuat otomatis. Folder `data/`
  ada di `.gitignore`.

### Konfigurasi limit

Isi `limit-config.json` di root proyek. Contoh referensi ada di `limit-config.example.json`. Angka di bawah
hanya contoh:

```json
{
  "weeklyTokenLimit": 5000000,
  "weekResetDay": 1,
  "weekResetHour": 0,
  "countCacheRead": false
}
```

| Kunci | Isi | Keterangan |
| --- | --- | --- |
| `weeklyTokenLimit` | angka > 0, atau `0` | perkiraan batas token per minggu. `0` = tanpa batas (bar tidak tampil) |
| `weekResetDay` | `0`–`6` atau `null` | hari reset (0 = Minggu, 1 = Senin, ..., 6 = Sabtu). `null` = window bergulir 7 hari |
| `weekResetHour` | `0`–`23` | jam reset, waktu lokal komputer. Default `0` |
| `countCacheRead` | `true` / `false` | `true` = token cache baca ikut dihitung. Default `false` |

File dibaca ulang tiap siklus, jadi server tidak perlu di-restart. Lokasi lain bisa diatur dengan
`AI_OFFICE_LIMIT_CONFIG`. JSON yang rusak dianggap tidak ada.

### CLI dan data contoh

```bash
npm run usage                 # ringkasan di terminal (estimasi)
npm run usage -- --json       # keluaran JSON, bentuk sama dengan GET /api/usage → usage
```

`npm run usage` tidak butuh server. Kode keluarnya selalu `0`, termasuk saat data tidak tersedia.

Data contoh, tanpa log Claude Code asli:

```bash
npm run usage:sample                                             # tulis tests/fixtures/usage-sample/
AI_OFFICE_CLAUDE_DIR=tests/fixtures/usage-sample npm run usage   # bash
```

```powershell
npm run usage:sample
$env:AI_OFFICE_CLAUDE_DIR = "tests\fixtures\usage-sample"; npm run usage; Remove-Item Env:AI_OFFICE_CLAUDE_DIR
```

`npm run usage:sample` menghapus folder `projects/` di dalam folder tujuan sebelum menulis ulang.
Jangan arahkan ke folder log Claude Code yang asli.

`AI_OFFICE_CLAUDE_DIR` menunjuk folder dasar log (default `~/.claude`). Kalau folder itu tidak punya
subfolder `projects/`, folder itu sendiri yang dipindai.

## Autostart Windows

Autostart membuat server AI Office menyala saat login Windows. Semua perintah dijalankan dari folder proyek.
Autostart memakai port 3000 dan hanya mendengar di `127.0.0.1`.

```powershell
npm run autostart:install     # buat shortcut "AI Office" di folder Startup pengguna, lalu nyalakan server
npm run autostart:stop        # hentikan supervisor dan server AI Office yang dijalankan peluncur
npm run autostart:uninstall   # hapus shortcut Startup, lalu hentikan server dari peluncur
```

- Tidak butuh hak admin. Perintah install aman dijalankan berulang.
- Peluncur (`scripts/windows/start-ai-office.vbs`) menjalankan supervisor tanpa jendela. Supervisor menyalakan
  ulang server bila crash, dengan jeda 5, 10, 20, 40, lalu 60 detik. Setelah 8 crash beruntun, supervisor
  berhenti.
- Log server ada di `logs/server.log` (dibuat otomatis, tidak di-commit). Saat lebih dari 5 MB, log dipindah
  ke `logs/server.log.1`.
- Kalau server sudah berjalan dari `npm start` di port 3000, autostart tidak menjalankan instance kedua.

## Autentikasi dan mode server

Perlindungan yang selalu aktif: header `Host` diperiksa (melindungi dari DNS rebinding), `Origin`
situs lain ditolak untuk API dan WebSocket, body dibatasi 64 KB, halaman dikirim dengan CSP ketat,
dan log server default hanya mencatat metadata event (tipe, pengirim, penerima, panjang pesan).
Server punya tiga mode:

1. **Mode lokal** (default). Tanpa token, server hanya mendengar di `127.0.0.1` dan hanya bisa
   dibuka dari komputer ini. Tidak ada login.
2. **Mode token**. Aktif bila `AI_OFFICE_TOKEN` atau `AI_OFFICE_TOKEN_FILE` terisi.
   - Browser menampilkan layar token. Setelah token benar, server memasang cookie `aio_session`
     (HttpOnly, SameSite=Strict, `Secure` bila lewat HTTPS) yang berlaku 7 hari. Tombol **Keluar**
     hanya menghapus cookie di browser itu; mengganti token membatalkan semua sesi.
   - Hooks dan curl mengirim header `Authorization: Bearer <token>`.
   - Login gagal 10 kali dari satu IP diblokir 15 menit (`429`).
   - Token tidak pernah ditulis ke log, respons, atau URL.
3. **Mode terbuka**. Terjadi bila `HOST` bukan loopback, `AI_OFFICE_ALLOWED_HOSTS` terisi, atau
   `AI_OFFICE_TRUST_PROXY=1`. Wajib token minimal 32 karakter; tanpa itu server menolak start
   (exit 1). `AI_OFFICE_TRUST_PROXY=1` juga hanya boleh dengan `HOST` loopback (Nginx di mesin
   yang sama). Untuk internet, pakai panduan [Deploy ke VPS](#deploy-ke-vps) (Nginx + HTTPS).

Buat token kuat (32 byte acak, 43 karakter) dan jalankan mode token di komputer sendiri.

Bash (Linux, macOS, Git Bash):

```bash
mkdir -p ~/.ai-office
(umask 077 && npm run -s token > ~/.ai-office/token)
AI_OFFICE_TOKEN_FILE="~/.ai-office/token" npm run serve
```

PowerShell (belum diuji):

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.ai-office" | Out-Null
npm run -s token > "$HOME\.ai-office\token"
$env:AI_OFFICE_TOKEN_FILE = "$HOME\.ai-office\token"
npm run serve
```

`-s` wajib supaya npm tidak menambah baris judul ke file. File token harus berisi satu baris,
maksimal 4 KB, UTF-8 (dengan atau tanpa BOM) atau UTF-16 dengan BOM (hasil `>` di PowerShell 5.1).
Simpan token di luar folder proyek dan jangan commit.

## Variabel lingkungan

Server (`server/index.js`):

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | alamat dengar. Selain loopback (`127.0.0.1`, `localhost`, `::1`) = mode terbuka |
| `PORT` | `3000` | port HTTP |
| `AI_OFFICE_TOKEN` | kosong | rahasia bersama; mengaktifkan mode token. Diutamakan bila terisi |
| `AI_OFFICE_TOKEN_FILE` | kosong | path file berisi token (`~` = folder home), dibaca bila `AI_OFFICE_TOKEN` kosong. File bermasalah = peringatan, server berjalan seperti tanpa token |
| `AI_OFFICE_ALLOWED_HOSTS` | kosong | hostname dipisah koma yang boleh muncul di header `Host`/`Origin`. Terisi = mode terbuka |
| `AI_OFFICE_TRUST_PROXY` | kosong | hanya aktif bila `1`: pakai `X-Real-IP` dan `X-Forwarded-Proto` dari Nginx. Wajib `HOST` loopback; = mode terbuka |
| `AI_OFFICE_DEV_ORIGINS` | kosong | Origin dev server dipisah koma (mis. `http://localhost:5173`) yang diizinkan di mode lokal. Dipakai saat mengembangkan UI dengan `npx vite` |
| `AI_OFFICE_LOG_MESSAGES` | kosong | hanya aktif bila `1`: isi pesan event ikut ditulis ke log (untuk debugging sementara) |
| `AI_OFFICE_CLAUDE_DIR` | `~/.claude` | folder dasar log Claude Code untuk [Panel Pemakaian Limit](#panel-pemakaian-limit) |
| `AI_OFFICE_LIMIT_CONFIG` | `limit-config.json` di root proyek | path file konfigurasi limit |

Hook (`hooks/send-event.mjs`):

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `AI_OFFICE_URL` | `http://127.0.0.1:3000/api/events` | tujuan event. `http://` hanya ke loopback; host lain wajib `https://`, kalau tidak event apa pun tidak dikirim |
| `AI_OFFICE_TOKEN` | kosong | dikirim sebagai `Authorization: Bearer` |
| `AI_OFFICE_TOKEN_FILE` | kosong | path file token, dibaca bila `AI_OFFICE_TOKEN` kosong. Dianjurkan: nilai di `"env"` diwariskan ke semua subprocess Claude Code, file tidak |
| `AI_OFFICE_TIMEOUT_MS` | `800` | batas waktu request (maks 60000) |
| `AI_OFFICE_DEBUG` | kosong | `1` = tampilkan error di stderr (token tidak pernah dicetak) |

Cara mengisi variabel hook: karena hook dipasang di level user, nilainya bisa ditaruh di bagian `"env"`
`~/.claude/settings.json` (berlaku untuk semua sesi), di environment sistem, atau di `.env` proyek.
Catatan: perilaku `"env"` untuk hook level user belum diuji di kode ini.

Pemasang hook (`scripts/user-hooks.mjs`):

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `AI_OFFICE_USER_SETTINGS` | `~/.claude/settings.json` | file settings yang dipasang/dilepas. Untuk uji saja: arahkan ke file lain, jangan ke settings asli |

Semua variabel di atas boleh juga ditulis di `.env` (lihat [Konfigurasi](#konfigurasi)).

## Deploy ke VPS

Panduan lengkap ada di [`docs/DEPLOY.md`](docs/DEPLOY.md): biaya, setup sekali dengan
`deploy/setup-vps.sh` (Nginx + HTTPS Let's Encrypt, firewall, systemd), mengarahkan hooks ke VPS,
update, rollback, dan rotasi token. Baca dulu biaya dan langkahnya sebelum menyewa VPS, membeli domain,
atau menjalankan skrip di server.

## Test

```bash
npm test
```

Mencakup format event, pemetaan hooks, server HTTP + WebSocket, skrip hook (proses sungguhan),
engine animasi + skenario simulasi, validasi file agen (termasuk model yang diizinkan), konfigurasi
hooks, pemasang hook level user, autentikasi token (login, cookie sesi, Bearer, sumber token dari
file), statistik pemakaian (`usage`, `/api/usage`, dan panel), regresi keamanan, skrip autostart, dan
pemeriksaan statis kit deploy (`deploy/` dan `docs/DEPLOY.md`). Cek sintaks skrip deploy (`bash -n`)
dilewati bila `bash` tidak ada di PATH.

## Struktur proyek

```
agents/                    17 file subagent (sumber), termasuk divisi 3D (3d-*.md)
CLAUDE.md                  aturan manajer
.env.example               contoh konfigurasi (salin ke .env)
limit-config.example.json  contoh batas mingguan (salin ke limit-config.json)
data/                      cache statistik pemakaian (dibuat otomatis, di-gitignore)
logs/                      log server dari autostart Windows (dibuat otomatis, di-gitignore)
dist/                      hasil build UI (npm run build)
shared/                    format event, roster, pemetaan hooks, tokenUsage (dipakai server, hook, UI)
server/                    server HTTP + WebSocket, autentikasi token, sumber token, loadEnv.js, usage.js
hooks/                     skrip hook Claude Code (send-event.mjs, transcript-tokens.mjs)
src/                       UI React + canvas
src/office/                engine animasi, denah, pathfinding, renderer canvas
src/sim/                   skenario Simulasi
src/ui/                    komponen React (layar token, panel Pemakaian Limit)
src/usage.js               validasi dan format data pemakaian untuk UI
src/sessions.js            nama proyek dan daftar Sesi aktif
scripts/                   install/validasi agen, pemasang dan pelepas hook level user, laporan pemakaian,
                           demo hooks, pembuat token
scripts/windows/           autostart Windows (peluncur, supervisor, pasang, cabut, stop)
deploy/                    kit VPS: setup-vps.sh, update.sh, rotate-token.sh, lib.sh, systemd, Nginx, contoh env
docs/DEPLOY.md             panduan deploy ke VPS
tests/                     vitest
```

## Keamanan

- **Jangan commit `.env`**, `limit-config.json`, file token, atau isi folder `data/` dan `logs/`. Simpan
  token di luar folder proyek (mis. `~/.ai-office/token`).
- **Laporkan celah keamanan secara privat.** Pakai *Report a vulnerability* di
  [tab Security](https://github.com/mansgaming712-hue/ai-office/security) repo ini (Security Advisory).
  Jangan buka issue publik untuk celah keamanan.

Detail mode server dan autentikasi ada di [Autentikasi dan mode server](#autentikasi-dan-mode-server).

## Lisensi

Proyek ini dirilis di bawah lisensi MIT. Lihat [LICENSE](LICENSE).
