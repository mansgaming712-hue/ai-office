# AI Office: referensi teknis

Ini referensi lengkapnya. Untuk gambaran umum dan mulai cepat, lihat [README.id.md](../README.id.md).
Versi Inggris: [REFERENCE.md](REFERENCE.md).

Isi:

- [Variabel lingkungan](#variabel-lingkungan)
- [Runner dan API tugas](#runner-dan-api-tugas)
- [Format event dan WebSocket](#format-event-dan-websocket)
- [Hook Claude Code](#hook-claude-code)
- [Panel Pemakaian Limit](#panel-pemakaian-limit)
- [Autentikasi, mode server, dan runner key](#autentikasi-mode-server-dan-runner-key)
- [Autostart](#autostart)
- [Divisi buatan pengguna](#divisi-buatan-pengguna)
- [Tema kantor dan pengaturan](#tema-kantor-dan-pengaturan)
- [Test dan pemeriksaan](#test-dan-pemeriksaan)
- [Struktur folder](#struktur-folder)

Setiap nilai di bawah diambil dari kode. Nama file dalam kurung menunjukkan tempat melihatnya.

## Variabel lingkungan

Variabel bisa diisi di shell, di `.env` (lihat `.env.example`; dimuat oleh `server/loadEnv.js` tanpa menimpa variabel
yang sudah ada), atau di bagian `env` pada pengaturan Claude Code untuk variabel hook.

### Server (`server/index.js`)

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `PORT` | `3000` | Port HTTP. Juga dipakai `npm run open` dan runner untuk membangun alamat event. |
| `HOST` | `127.0.0.1` | Alamat listen. Selain alamat loopback (`127.0.0.1`, `localhost`, `::1`) memulai mode terbuka. |
| `AI_OFFICE_TOKEN` | kosong | Rahasia bersama. Mengaktifkan mode token. Dipakai lebih dulu bila diisi. |
| `AI_OFFICE_TOKEN_FILE` | kosong | Path file berisi token (`~` = folder home). Dibaca hanya bila `AI_OFFICE_TOKEN` kosong. File yang bermasalah menampilkan peringatan, lalu server jalan seperti tanpa token. |
| `AI_OFFICE_ALLOWED_HOSTS` | kosong | Nama host dipisah koma yang boleh muncul di header `Host` dan `Origin`. Jika diisi, mode terbuka dimulai. |
| `AI_OFFICE_TRUST_PROXY` | kosong | Hanya bila `1`: pakai `X-Real-IP` dan `X-Forwarded-Proto` dari Nginx. Wajib `HOST` loopback. Dihitung sebagai mode terbuka. Login butuh `X-Real-IP` yang valid (kalau tidak, `503`). |
| `AI_OFFICE_DEV_ORIGINS` | kosong | Origin dev server dipisah koma (misalnya `http://localhost:5173`) yang diizinkan di mode lokal. Di mode lokal, `Origin` loopback hanya diterima untuk port server sendiri; port lain (termasuk 5173 milik Vite) tidak diterima otomatis. Isi untuk port localhost tambahan (port-forward, SSH tunnel, dev server lain). `npm run dev` mengisinya dengan `http://localhost:5173,http://127.0.0.1:5173` (digabung dengan nilai Anda) untuk pengembangan UI. |
| `AI_OFFICE_LOG_MESSAGES` | kosong | Hanya bila `1`: isi pesan event ikut dicatat di log. Default: hanya metadata. |
| `AI_OFFICE_CLAUDE_DIR` | `~/.claude` | Folder dasar log Claude Code untuk [panel Pemakaian Limit](#panel-pemakaian-limit). Bila tidak ada subfolder `projects/`, folder itu sendiri yang dipindai. |
| `AI_OFFICE_LIMIT_CONFIG` | `limit-config.json` di root proyek | Path file konfigurasi limit. |
| `AI_OFFICE_DIVISIONS_DIR` | `divisions/` di root proyek | Folder yang dipindai sekali, saat server mulai, untuk divisi buatan pengguna (`<id>/division.json` dan `<id>/agents/<worker>.md`). Path relatif dihitung dari folder tempat server dijalankan. Juga dipakai `npm run agents:install` dan `npm run agents:validate`. Rincian: [Divisi buatan pengguna](#divisi-buatan-pengguna). |
| `AI_OFFICE_LANG` | dari `LC_ALL`, `LC_MESSAGES`, `LANG`, lalu sistem | `id` (atau `in`, `ind`) untuk Indonesia; selain itu Inggris. Mengatur bahasa pesan server dan CLI, serta bahasa default tugas runner bila permintaan tidak membawa `lang`. |
| `AI_OFFICE_RUNNER` | kosong | Isi `1` untuk mengaktifkan runner dan demo di mode terbuka (VPS). Di luar mode terbuka, runner aktif tanpa variabel ini. |
| `AI_OFFICE_PRINT_KEY` | kosong | Isi `1` untuk mencetak URL dasbor dengan runner key meskipun stdout bukan terminal. Tanpa ini, key hanya dicetak di terminal supaya log layanan tidak memuatnya. |
| `AI_OFFICE_RUNNER_KEY_FILE` | `~/.ai-office/runner-key` | Path file runner key lokal (mode lokal). Terutama untuk test. |
| `AI_OFFICE_AUTOSTART_PORT` | `3000` | Port yang dipakai skrip autostart. Hanya angka yang diterima; selain itu kembali ke `3000`. Samakan dengan `PORT` bila server autostart harus memakai port lain. |

### Runner (`server/runner.js`, `server/tasks.js`)

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `AI_OFFICE_CLAUDE_BIN` | kosong | Path ke CLI Claude Code. Bila diisi, hanya ini yang dipakai: jika filenya tidak ada, CLI dianggap tidak ditemukan (tidak kembali ke `PATH`). Path relatif dihitung dari folder kerja saat ini. |
| `AI_OFFICE_RUNNER_ALLOWED_TOOLS` | `Agent,WebSearch,WebFetch,TodoWrite` | Nama alat dipisah koma untuk `--allowedTools`. Tiap nama harus cocok `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (jadi tanpa specifier seperti `Read(...)`); maksimal 40 nama. `Bash`, `PowerShell`, dan `mcp__*` selalu masuk `--disallowedTools`, apa pun isi variabel ini. Menambah `Read`, `Write`, `Edit`, `Glob`, atau `Grep` di sini membuka seluruh disk untuk sesi; server mencetak peringatan saat mulai bila Anda melakukannya. |
| `AI_OFFICE_RUNNER_EXTRA_ARGS` | kosong | Argumen CLI tambahan, dipisah spasi (maksimal 20). Tiap token diperiksa dengan pola. Flag yang melemahkan batas runner ditolak (lihat [Runner dan API tugas](#runner-dan-api-tugas)). Nilai yang salah membuat permintaan tugas gagal dengan `503`. |
| `AI_OFFICE_RUNNER_TIMEOUT_MS` | `1800000` (30 menit) | Batas waktu satu tugas, dalam milidetik. Rentang sah `100` sampai `86400000`. Nilai lain memakai default. |

Proses anak tidak menerima variabel `AI_OFFICE_RUNNER*` apa pun, dan tidak menerima `CLAUDE_PROJECT_DIR`.
Server mengatur `AI_OFFICE_URL` untuk proses anak supaya hook-nya mengirim event ke server ini.

**Alat default dan alasannya.** Runner membaca halaman web, jadi halaman bisa membawa prompt injection. Aturan allow tanpa
path (`Read`, `Write`, `Edit`, `Glob`, `Grep`) akan membiarkan halaman seperti itu membaca `~/.ssh`, `.env`, atau runner
key, atau menulis ke `hooks/`, `server/`, atau folder Startup. Karena itu daftar default hanya `Agent`, `WebSearch`,
`WebFetch`, dan `TodoWrite`. Baca dan tulis di dalam folder tugas tetap jalan: Claude Code membaca (`Read`, `Grep`,
`Glob`) di dalam direktori kerja tanpa bertanya, dan `--permission-mode acceptEdits` menyetujui `Write` dan `Edit` di
sana. Akses di luar folder ditolak di `claude -p` karena tidak ada yang bisa menyetujuinya. `Bash`, `PowerShell`, dan
semua alat MCP (`mcp__*`) selalu ditolak; aturan deny menang atas aturan allow.

**Pengaturan Claude Code Anda tetap berlaku.** Runner menjalankan CLI Claude Code milik Anda, jadi aturan
`permissions.allow` di `~/.claude/settings.json` (dan settings proyek) tetap berlaku untuk sesi runner. Aturan yang
lebar di sana, misalnya `Read` atau `Write` tanpa path, memperluas jangkauan runner. Jaga aturan itu tetap sempit.

**Peringatan mode VPS.** Dengan `AI_OFFICE_RUNNER=1` di mode terbuka, `WebFetch` berjalan di server dan bisa menjangkau
jaringan server, termasuk alamat internal dan layanan metadata cloud (SSRF), dan halaman yang diambil bisa menyuntikkan
prompt. Biarkan runner nonaktif di VPS kecuali Anda menerima risiko ini.

**Pembersihan.** Folder `output/` tidak pernah dibersihkan otomatis. Hapus folder tugas lama sendiri.

### Hook (`hooks/send-event.mjs`)

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `AI_OFFICE_URL` | `http://127.0.0.1:3000/api/events` | Tujuan pengiriman event. `http://` hanya boleh untuk loopback. Host lain wajib `https://`, jika tidak event tidak dikirim. |
| `AI_OFFICE_TOKEN` | kosong | Dikirim sebagai `Authorization: Bearer`. |
| `AI_OFFICE_TOKEN_FILE` | kosong | Path file token, dibaca bila `AI_OFFICE_TOKEN` kosong. File tidak diteruskan ke setiap subproses, jadi ini pilihan yang dianjurkan. |
| `AI_OFFICE_TIMEOUT_MS` | `800` | Batas waktu permintaan (maksimal 60000). |
| `AI_OFFICE_DEBUG` | kosong | `1` menampilkan error di stderr. Token tidak pernah dicetak. |

### Pemasang dan skrip bantu

| Variabel | Default | Fungsi |
| --- | --- | --- |
| `AI_OFFICE_USER_SETTINGS` | `~/.claude/settings.json` | File pengaturan yang ditulis atau dihapus oleh pemasang hook (`scripts/user-hooks.mjs`). Hanya untuk test. |

Semua variabel server juga bisa ditulis di `.env`.

## Runner dan API tugas

Runner membuat dasbor bisa menjalankan sesi Claude Code sungguhan (`claude -p`) sebagai manajer, dengan satu folder
baru untuk setiap tugas. Implementasinya ada di `server/runner.js` (deteksi CLI, argumen, penanganan proses, parser
stream-json), `server/tasks.js` (siklus hidup tugas, satu slot), `server/outputStore.js` (folder tugas dan pembacaan
file yang aman), `server/runnerKey.js` (runner key), dan `server/demo.js` (pemutaran demo).

### Yang terjadi saat tugas dimulai

1. Server memeriksa permintaan, konfigurasi runner, bahwa tidak ada tugas atau demo lain yang berjalan, dan bahwa CLI
   menjawab `--version` (hasilnya disimpan 30 detik).
2. Server membuat folder `output/<YYYYMMDD-HHMMSS>-<slug>/` di root proyek. Slug dibuat dari judul (ASCII, huruf kecil,
   maksimal 40 karakter). Folder output diabaikan oleh git.
3. Server menulis `CLAUDE.md` (salinan `server/templates/task-claude.en.md` untuk `lang` `en`, atau `server/templates/task-claude.md` untuk `id`, dengan bahasa yang sudah diisi) dan `task.md`
   (judul, tanggal, bahasa, dan teks tugas). Aturan manajer di `CLAUDE.md` berlaku untuk proses ini.
4. Server menjalankan CLI dengan folder tugas sebagai direktori kerja:

   ```text
   claude -p --output-format stream-json --verbose --permission-mode acceptEdits \
          --allowedTools <AI_OFFICE_RUNNER_ALLOWED_TOOLS atau default> --disallowedTools Bash,PowerShell,mcp__* \
          [AI_OFFICE_RUNNER_EXTRA_ARGS]
   ```

   Teks tugas hanya dikirim lewat stdin, setelah satu instruksi singkat. Teks itu tidak pernah muncul di baris perintah.
   Proses dijalankan tanpa shell. Di Windows, file `.cmd` dijalankan lewat `cmd.exe` dengan baris perintah tetap, dan
   file `.ps1` lewat `powershell -File`.
5. Server mengirim event `assign` (dari CEO ke manajer) dan pesan tugas lewat WebSocket.

Fakta lain tentang satu proses:

- **Satu tugas dalam satu waktu.** Memulai tugas atau demo saat ada yang berjalan menghasilkan `409`.
- **Batas waktu.** Setelah `AI_OFFICE_RUNNER_TIMEOUT_MS`, seluruh pohon proses dihentikan dan tugas berstatus `failed`.
- **Batalkan.** `POST /api/tasks/<id>/cancel` menghentikan pohon proses dan mengubah status menjadi `cancelled`.
- **Berhenti.** Saat server berhenti, tugas yang berjalan dibatalkan dan pohon prosesnya dibunuh.
- **Log.** `run.log` di folder tugas menyimpan keluaran CLI (stdout, dan stderr dengan awalan `[stderr]`). Pencatatan
  berhenti di 5 MB lalu menulis baris pemotongan.
- **Hasil.** Jika proses selesai dengan kode keluar `0`, server membaca `RESULT.md`. Bila Claude Code tidak menulis file
  itu, server menulis teks hasil proses ke sana. Ringkasan diambil dari baris berisi pertama pada hasil.
- **Hasil bertanda bantuan.** Jika teks hasil memuat `STATUS: BUTUH BANTUAN` (atau alias Inggris `STATUS: NEEDS HELP`),
  tugas tetap `done`, tetapi event akhirnya `blocked`, bukan `report`.
- **Gagal.** Kode keluar bukan `0`, atau hasil bertanda `is_error`, membuat tugas `failed` dengan event `blocked`.
  Pesannya memuat kode keluar dan potongan keluaran stderr atau teks hasil bila ada.
- **Restart.** Tugas yang masih `running` saat server berhenti ditampilkan sebagai `failed` setelah server nyala lagi.
- **Berkas meta tersembunyi.** Setiap folder tugas punya `.ai-office-task.json` (status dan ringkasan). File ini tidak
  ditampilkan dalam daftar dan tidak bisa dibaca lewat API.

Isi folder tugas, contohnya:

```text
output/20261121-093015-kopi-susu-tiktok/
  CLAUDE.md          aturan manajer (disalin dari server/templates/task-claude.md)
  task.md            judul, tanggal, bahasa, teks tugas
  run.log            keluaran CLI (maksimal 5 MB)
  RESULT.md          laporan akhir untuk CEO
  ...                file lain yang ditulis agen
```

### Event yang dikirim tugas

Setiap event tugas membawa `"task": "<id>"` dan `"source": "api"` (atau `"sim"` untuk demo).

| Saat | Event |
| --- | --- |
| Tugas mulai | `assign` dari `ceo` ke `manager`, pesan = judul |
| Subagen mulai | `assign` dari manajer ke agen, lalu `working` (dari stream, hanya bila hook AI Office belum terpasang) |
| Subagen selesai | `done` atau `blocked` ke `manager` (dari stream, hanya bila hook belum terpasang) |
| Tugas selesai baik | `report` dari `manager` ke `ceo`, pesan = ringkasan |
| Tugas gagal, dibatalkan, atau timeout | `blocked` dari `manager` ke `ceo`, dengan alasan |

Bila hook AI Office terpasang (lihat [Hook Claude Code](#hook-claude-code)), hook yang mengirim event subagen, dan server
tidak mengirimnya lagi. Event awal dan akhir tugas dari server selalu dikirim.

### Status runner

`GET /api/runner` menjawab `{ ok, available, reason, keyRequired, version, active }`.

- `available`: `true` bila tugas baru bisa dimulai sekarang.
- `reason`: `null` bila tersedia; selain itu `disabled` (runner mati, atau konfigurasi `AI_OFFICE_RUNNER_*` tidak sah),
  `cli-not-found`, atau `busy`. Di mode token dan mode terbuka, permintaan tanpa otorisasi mendapat `null` sebagai ganti `busy`.
- `keyRequired`: `true` di mode lokal (runner key dibutuhkan untuk endpoint lain).
- `version`: teks versi CLI, atau `null`. Di mode token dan mode terbuka, permintaan tanpa otorisasi selalu mendapat `null`. Mode lokal tidak berubah.
- `active`: tugas yang sedang berjalan `{ id, title, startedAt, kind }`, atau `null`. Hanya ditampilkan untuk permintaan yang sudah berwenang.

Endpoint ini bisa dipanggil tanpa key. Dasbor memakainya untuk memutuskan apakah teks biasa bisa dikirim sebagai tugas.

### Endpoint

Semua endpoint di bawah membutuhkan otorisasi seperti dijelaskan di
[Autentikasi, mode server, dan runner key](#autentikasi-mode-server-dan-runner-key), kecuali `GET /api/runner` yang menjawab
tanpa key (tanpa detail `active`). Galat berbentuk `{ "ok": false, "error": "..." }`.

| Metode dan path | Body | Sukses | Galat |
| --- | --- | --- | --- |
| `GET /api/runner` | tidak ada | `200` objek status (lihat di atas) | tidak ada |
| `POST /api/tasks` | `{ "text": "...", "lang": "en" \| "id" }` (`lang` opsional) | `202 { ok, task: { id, title, status: "running" } }` | `400` teks tidak sah, teks lebih dari 2000 karakter, `lang` tidak sah; `403` runner mati; `409` sibuk; `503` CLI tidak ditemukan atau konfigurasi runner tidak sah; `500` folder tidak bisa dibuat |
| `POST /api/demo` | `{ "lang": "en" \| "id" }` (opsional) | `202 { ok, task }` | `400` `lang` tidak sah; `403` runner mati; `409` sibuk |
| `GET /api/tasks` | tidak ada | `200 { ok, tasks: [...] }`, terbaru dulu, maksimal 50 | tidak ada |
| `GET /api/tasks/<id>` | tidak ada | `200 { ok, task }` dengan `files: [{ path, bytes }]` dan `summary` | `404` tidak ditemukan |
| `GET /api/tasks/<id>/files/<path>` | tidak ada | `200` isi file sebagai teks biasa (`text/plain`, sandbox, `nosniff`) | `400` path tidak sah; `404` tidak ditemukan (juga untuk symlink dan berkas meta tersembunyi); `413` lebih dari 1 MB; `415` bukan teks |
| `POST /api/tasks/<id>/cancel` | tidak ada | `200 { ok: true }` | `404` tugas tidak sedang berjalan; `405` metode salah |

Catatan:

- `<id>` adalah nama folder, misalnya `20261121-093015-kopi-susu-tiktok`. Harus cocok `^[a-z0-9][a-z0-9-]{0,63}$`.
- `<path>` adalah path relatif di dalam folder tugas. Setiap segmen di-encode persen. `..`, `.`, segmen kosong, backslash,
  titik dua, karakter kontrol, dan nama perangkat Windows ditolak. File harus file biasa dengan path asli yang sama dengan
  path yang diminta, sehingga symlink di rantai path ditolak.
- Body `POST` harus `application/json` dan maksimal 64 KB.
- `POST /api/tasks` juga menolak teks yang berisi byte NUL atau kosong setelah dipangkas.

### Demo

`POST /api/demo` memutar tugas contoh dari server, sekitar 54 detik, tanpa Claude Code. Server menulis file contoh dari
`server/demo/<lang>/` ke folder tugas baru dan mengirim jenis event yang sama seperti tugas sungguhan, dengan
`source: "sim"`. Contohnya tentang es kopi susu gula aren: skrip TikTok, caption jualan, dan riset harga pesaing. File
yang dibuat adalah `tiktok-script.md`, `caption.md`, `riset-harga.md` (Indonesia) atau `price-research.md` (Inggris),
serta `RESULT.md`. Tombol **Demo** di dasbor memakai endpoint ini. Bila runner key tidak ada atau server tidak mendukung
endpoint ini, dasbor kembali ke simulasi lokal.

### Field event tambahan untuk tugas

- `task`: id tugas (opsional, pola yang sama dengan nama folder). Dasbor memakainya untuk tautan **Lihat hasil**.
- `source`: `hook`, `sim`, `ui`, atau `api`.

### Pesan WebSocket untuk tugas

Setiap kali status tugas berubah (mulai, selesai), semua klien WebSocket menerima:

```json
{ "kind": "task", "task": { "id": "20261121-093015-kopi-susu-tiktok", "title": "...", "status": "running", "kind": "task" } }
```

`status` berisi `running`, `done`, `failed`, atau `cancelled`. `kind` berisi `task` atau `demo`. `summary` ada setelah
tugas berakhir. Panel **Tugas** di dasbor menampilkan daftar ini dan membuka penampil hasil.

## Format event dan WebSocket

Semua event (simulasi, kotak perintah, hook, dan runner) memakai satu format:

```json
{ "type": "assign", "from": "manager", "to": "dev-frontend", "message": "Bangun navbar", "time": "2026-11-21T02:30:00.000Z" }
```

- `type`: `assign` | `working` | `done` | `blocked` | `report`.
- Kunci Indonesia `tipe`, `dari`, `ke`, `pesan`, `waktu`, dan `sumber` juga diterima.
- `time` boleh dihilangkan; server yang mengisinya. Nama khusus: `manager` dan `ceo`.
- Nama: huruf kecil, angka, dan `- _ . :`, maksimal 64 karakter. `manajer` dan `orchestrator` dibaca sebagai `manager`.
- `message`: satu baris, maksimal 500 karakter. Karakter kontrol dan karakter tak terlihat dibuang.
- `project` (opsional): nama folder sesi Claude Code, sampai 64 karakter. Diisi oleh hook.
- `tokens` (opsional): `{ input, output, cacheRead, cacheCreation }`, hanya dikirim pada `SubagentStop`.
- `task` (opsional): lihat [Runner dan API tugas](#runner-dan-api-tugas).
- Maksimal 50 event per permintaan.

Mengirim satu event dengan tangan:

```bash
curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{"type":"done","from":"dev-qa","to":"manager","message":"9 test lulus"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/events -ContentType 'application/json' `
  -Body '{"type":"done","from":"dev-qa","to":"manager","message":"9 test lulus"}'
```

Di mode token, tambahkan `Authorization: Bearer <your-token>` (bash: `-H "Authorization: Bearer $AI_OFFICE_TOKEN"`;
PowerShell: `-Headers @{ Authorization = "Bearer $env:AI_OFFICE_TOKEN" }`).

Event yang identik (type, from, to, message, project, dan tokens sama) yang datang dalam 3 detik akan dibuang server.
Respons tetap `202`, dengan jumlah `duplicates`.

### Ringkasan endpoint

| Endpoint | Fungsi | Mode token |
| --- | --- | --- |
| `POST /api/events` | Satu event atau array sampai 50. Wajib `Content-Type: application/json`. Mengembalikan `202 { ok, accepted, ids }`. | Header Bearer atau cookie sesi, selain itu `401` |
| `GET /api/events` | 300 event terakhir. | Header Bearer atau cookie sesi, selain itu `401` |
| `GET /api/usage` | `{ ok, usage }`: statistik pemakaian token (estimasi lokal). | Header Bearer atau cookie sesi, selain itu `401` |
| `GET /api/divisions` | `{ ok, divisions, errors }`: divisi plugin yang ditemukan saat server mulai (`id`, `name`, `color`, `desks`, `workers`, `source`, dan `personalities` bila ada). `errors` memuat folder yang dilewati dan kepribadian yang diabaikan sebagai teks biasa. Tanpa path file atau teks agen. | Header Bearer atau cookie sesi, selain itu `401` |
| `GET /api/health` | `{ ok: true }`. Di mode lokal juga mengembalikan jumlah `clients` dan `events`. | terbuka |
| `GET /api/session` | `{ ok, authRequired, authenticated }`. | terbuka |
| `POST /api/login` | Body `{"token":"..."}`. Mengatur cookie `aio_session`. Token salah: `401`. Terlalu banyak percobaan: `429`. | terbuka (mode lokal selalu `{ ok: true }`) |
| `POST /api/logout` | Menghapus cookie sesi di browser ini. Wajib `Content-Type: application/json` (body boleh `{}`). | terbuka |
| Endpoint runner dan tugas | Lihat [Runner dan API tugas](#runner-dan-api-tugas). | Header Bearer atau cookie sesi |
| `WS /ws` | Mengirim `{kind:"hello", events}`, lalu `{kind:"usage", usage}`, lalu `{kind:"event", event}`, `{kind:"usage", usage}`, dan `{kind:"task", task}` saat ada perubahan. | Header Bearer atau cookie sesi, selain itu `401`. Ditutup dengan kode `4401` saat sesi habis. |

Permintaan ditolak dengan `403` bila header `Host` atau `Origin` tidak sesuai dengan server (lihat
[Autentikasi, mode server, dan runner key](#autentikasi-mode-server-dan-runner-key)).

## Hook Claude Code

Hook dipasang di level **user** (`~/.claude/settings.json`), jadi berlaku untuk sesi dari folder mana pun.
File proyek `.claude/settings.json` berisi `{}` dan tidak memasang hook.

```bash
npm run hooks:install-user     # pasang hook AI Office ke ~/.claude/settings.json
npm run hooks:uninstall-user   # hapus hook AI Office dari ~/.claude/settings.json
```

Di Windows, file pengaturan user adalah `%USERPROFILE%\.claude\settings.json`.

Pemasang (`scripts/install-user-hooks.mjs`, logika bersama di `scripts/user-hooks.mjs`):

- **Menggabung, tidak menimpa.** Kunci dan hook lain dipertahankan. Menjalankannya berkali-kali tidak menambah duplikat.
- **Membuat cadangan.** Sebelum menulis, file lama disalin ke `settings.json.bak-YYYYMMDD-HHMMSS` di folder yang sama
  (ditambah `-1`, `-2`, dan seterusnya bila nama itu sudah ada). Bila `settings.json` belum ada, tidak ada cadangan.
- **Menulis atomik** (file sementara, lalu rename). Bila JSON yang ada rusak atau bentuknya tidak sesuai, tidak ada yang
  ditulis dan kode keluarnya `1`.
- **Memeriksa path proyek.** Path yang berisi `"`, baris baru, `$`, backtick, `%`, atau `!` ditolak, karena perintah hook
  dijalankan lewat shell.
- **Memakai path absolut.** Perintah hook menunjuk ke path absolut `hooks/send-event.mjs`. Bila proyek dipindah, jalankan
  `npm run hooks:uninstall-user` dari folder lama dulu, lalu pasang lagi dari lokasi baru.
- **Berlaku untuk sesi baru.** Sesi yang sudah berjalan perlu dimulai ulang.
- Untuk menguji tanpa menyentuh pengaturan asli, isi `AI_OFFICE_USER_SETTINGS` dengan file lain.

Hook yang dipasang (event dan matcher sama dengan `desiredHooks` di `scripts/user-hooks.mjs`):

| Hook | Event AI Office |
| --- | --- |
| `PreToolUse` dengan alat `Agent` atau `Task` | `assign` dari manajer ke subagen (pesan = deskripsi tugas) |
| `SubagentStart` | `working` untuk subagen |
| `PreToolUse` dengan alat lain (async) | `working` dari subagen (atau manajer), misalnya `Edit · App.jsx` |
| `SubagentStop` | `done` atau `blocked`, dibaca dari baris `STATUS:` laporan |
| `PostToolUse` dengan alat `Agent` atau `Task` | `report` atau `blocked`, dengan ringkasan laporan |

Perilaku saat berjalan:

- Claude Code menunggu hook paling lama **3 detik** (timeout yang ditulis pemasang).
- Hook mengirim event dengan batas **800 ms** (`AI_OFFICE_TIMEOUT_MS`). Event tidak diulang.
- Bila server mati, hook keluar diam-diam dengan kode 0 dan tidak mencetak apa pun, sehingga Claude Code tidak terpengaruh.
  Event yang gagal tidak dicatat di mana pun, kecuali `AI_OFFICE_DEBUG=1` diisi.
- Setiap event membawa `project`: nama folder sesi (basename dari `CLAUDE_PROJECT_DIR`, atau folder kerja bila variabel itu
  kosong). Daftar **Sesi aktif** menampilkan sesi yang punya event dalam 10 menit terakhir.
- Event `SubagentStop` juga membawa `tokens`, dibaca dari transkrip subagen, untuk statistik per agen.
- Pola rahasia umum (token, kunci API, password) disamarkan sebelum dikirim.
- Bila event yang sama (type, from, to, message, dan project) datang lagi dalam 3 detik, server membuangnya.

Uji tanpa Claude Code (server harus berjalan):

```bash
npm run demo:hooks              # skenario contoh, jeda sekitar 1,8 detik per langkah
npm run demo:hooks -- --fast    # tanpa jeda
npm run demo:hooks -- --asli    # bentuk payload Claude Code terbaru: agen latar belakang, dan laporan
                                # dibaca dari file transkrip lewat SubagentHandback
```

Untuk mengirim event hook ke server lain: `AI_OFFICE_URL=http://127.0.0.1:3001/api/events`. Keluaran debug: `AI_OFFICE_DEBUG=1`.

Belum diuji di basis kode ini: apakah bagian `"env"` di `~/.claude/settings.json` meneruskan variabel ke hook level user.
Untuk sementara, simpan variabel hook di `.env` atau di environment sistem.

## Panel Pemakaian Limit

Panel "Pemakaian Limit" di atas kantor menampilkan **estimasi** pemakaian token Claude Code. Angka resmi ada di
`/usage` di dalam Claude Code. Panel ini tidak memanggil model atau API apa pun.

- **Sumber:** log lokal di `~/.claude/projects/**/*.jsonl` (termasuk `subagents/`). Token dibaca dari `message.usage`,
  dihilangkan duplikatnya berdasarkan `message.id`, lalu dikelompokkan per jam lokal. Token per agen berasal dari event
  `SubagentStop` (jendela 7 hari).
- **Kapan dihitung ulang:** tiap 60 detik, dan sekitar 2 detik setelah event `SubagentStop` yang membawa `tokens`.
- **Rumus mingguan:** input + output + cache write, ditambah cache read bila `countCacheRead` bernilai `true`.
- **Warna bar:** hijau di bawah 60%, kuning 60% sampai 85%, merah di atas 85%. Di atas 85%, panel menampilkan peringatan.
  Bar hanya muncul bila `weeklyTokenLimit` lebih dari 0.
- **Tanpa data:** bila log tidak bisa dibaca (folder hilang, kosong, atau formatnya tidak dikenal), panel menyebutkannya
  beserta alasannya.
- **Privasi:** hasil dan log hanya berisi angka dan nama agen. Tidak ada path, isi pesan, atau nama sesi.
- **Cache:** `data/usage-cache.json` dan `data/usage-agents.json` dibuat otomatis. `data/` diabaikan git.

### Konfigurasi limit

Letakkan `limit-config.json` di root proyek (contohnya ada di `limit-config.example.json`):

```json
{
  "weeklyTokenLimit": 5000000,
  "weekResetDay": 1,
  "weekResetHour": 0,
  "countCacheRead": false
}
```

| Kunci | Nilai | Catatan |
| --- | --- | --- |
| `weeklyTokenLimit` | angka di atas 0, atau `0` | Perkiraan batas token mingguan. `0` berarti tanpa batas, dan bar disembunyikan. |
| `weekResetDay` | `0`–`6` atau `null` | Hari reset (0 = Minggu, 1 = Senin, ..., 6 = Sabtu). `null` = jendela 7 hari bergulir. |
| `weekResetHour` | `0`–`23` | Jam reset, waktu lokal komputer. Default `0`. |
| `countCacheRead` | `true` / `false` | `true` = token cache-read ikut dihitung. Default `false`. |

File dibaca ulang di setiap siklus, jadi server tidak perlu di-restart. Lokasi lain bisa diatur dengan
`AI_OFFICE_LIMIT_CONFIG`. JSON yang rusak diperlakukan seperti file yang tidak ada.

### CLI dan data contoh

```bash
npm run usage                 # ringkasan di terminal (estimasi)
npm run usage -- --json       # keluaran JSON, bentuk sama dengan GET /api/usage -> usage
```

`npm run usage` tidak butuh server. Kode keluarnya selalu `0`, termasuk saat tidak ada data.

Data contoh, saat belum ada log Claude Code sungguhan:

```bash
npm run usage:sample                                             # menulis tests/fixtures/usage-sample/
AI_OFFICE_CLAUDE_DIR=tests/fixtures/usage-sample npm run usage   # bash, zsh
```

```powershell
npm run usage:sample
$env:AI_OFFICE_CLAUDE_DIR = "tests\fixtures\usage-sample"; npm run usage; Remove-Item Env:AI_OFFICE_CLAUDE_DIR
```

`npm run usage:sample` menghapus folder `projects/` di dalam folder tujuan sebelum menulis data baru. Jangan arahkan ke
folder log Claude Code yang asli.

## Autentikasi, mode server, dan runner key

Selalu aktif: header `Host` diperiksa (perlindungan dari DNS rebinding), header `Origin` dari situs lain ditolak untuk API
dan WebSocket, body permintaan dibatasi 64 KB, halaman dikirim dengan Content Security Policy yang ketat, dan log server
hanya mencatat metadata event (tipe, pengirim, penerima, dan panjang pesan) kecuali `AI_OFFICE_LOG_MESSAGES=1`.

Server punya tiga mode.

1. **Mode lokal** (default, tanpa token). Server hanya mendengarkan di `127.0.0.1` dan hanya bisa dibuka dari komputer ini.
   Tidak ada login, tetapi endpoint runner membutuhkan **runner key** (di bawah).
   - Mode lokal tanpa token bisa dijangkau oleh setiap akun dan setiap proses di komputer ini, dan hook mengirim event ke
     proses mana pun yang memegang port 3000. Di komputer bersama atau multi-pengguna, pakai mode token
     (atur `AI_OFFICE_TOKEN_FILE`). Server mencetak peringatan saat start, dan supervisor autostart Windows menolak
     menganggap listener port 3000 milik akun lain (atau pemiliknya tidak terbaca) sebagai AI Office.
2. **Mode token.** Aktif bila `AI_OFFICE_TOKEN` atau `AI_OFFICE_TOKEN_FILE` diisi.
   - Browser menampilkan layar token. Setelah token benar, server mengatur cookie `aio_session` (HttpOnly,
     SameSite=Strict, dan `Secure` bila dilayani lewat HTTPS atau di mode terbuka), berlaku 24 jam. Bentuk cookie:
     `v2.<exp>.<sid>.<sig>` (id sesi acak yang ditandatangani). Tombol **Keluar** menghapus cookie dan mencabut id sesi itu
     di memori server (hilang saat restart). Mengganti token mengakhiri semua sesi.
   - Hook dan curl mengirim header `Authorization: Bearer <token>`.
   - Sepuluh kali gagal login dari satu alamat IP (IPv6: satu prefix /64) dalam jendela 15 menit memblokir alamat itu sampai jendela berakhir (`429`).
   - Token tidak pernah ditulis ke log, respons, atau URL.
   - Runner tidak memerlukan runner key di mode ini. Header Bearer atau cookie sesi sudah cukup.
3. **Mode terbuka.** Terjadi bila `HOST` bukan alamat loopback, bila `AI_OFFICE_ALLOWED_HOSTS` diisi, atau bila
   `AI_OFFICE_TRUST_PROXY=1`. Token minimal 32 karakter wajib ada. Tanpa itu, server menolak start (kode keluar 1).
   `AI_OFFICE_TRUST_PROXY=1` hanya boleh dengan `HOST` loopback (Nginx di mesin yang sama).
   Runner dan demo nonaktif di mode terbuka kecuali `AI_OFFICE_RUNNER=1`. Untuk akses internet, ikuti
   [`docs/DEPLOY.md`](DEPLOY.md) (Nginx dan HTTPS).

### Runner key (mode lokal)

- Saat pertama kali start, server membuat kunci acak (32 byte, base64url, 43 karakter) di `~/.ai-office/runner-key`
  (di Windows: `%USERPROFILE%\.ai-office\runner-key`). Isi `AI_OFFICE_RUNNER_KEY_FILE` untuk memakai path lain.
- Setiap permintaan ke endpoint runner, demo, dan file tugas harus mengirim header `X-AI-Office-Key: <key>`.
  Tanpa header, respons `401`; dengan key yang salah, `403`.
- `npm start` mencetak `http://localhost:3000/#key=...` bila stdout adalah terminal. Browser menyimpan key di
  `sessionStorage` dan menghapusnya dari address bar. `npm run open` membuka URL yang sama, atau mencetaknya dengan `--print`. Di macOS dan Linux, key tidak dikirim lewat baris perintah (akun lain bisa membacanya dengan `ps`): perintah ini menulis berkas HTML sementara (mode `0600`, nama acak `aio-open-*.html`) di `output/`, membuka berkas itu, lalu menghapusnya setelah sekitar 20 detik (sisa yang lama dibersihkan pada pemanggilan berikutnya). `--print` dan `--dry-run` tidak pernah membuat runner key.
- Key tidak dicetak ke log dan tidak pernah diteruskan ke proses anak tugas.
- Tanpa key, dasbor tetap bisa dibuka dan simulasi tetap jalan. Hanya tugas dan demo yang membutuhkan key.
- Di sistem POSIX, folder key `0700` dan file `0600`. Di Windows, file berada di profil pengguna.

Buat token yang kuat (32 byte acak, 43 karakter) dan jalankan mode token di komputer sendiri.

Bash, zsh (Linux, macOS, Git Bash):

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

Flag `-s` wajib supaya npm tidak menambahkan baris judul ke file. File token harus berisi satu baris, maksimal 4 KB, dalam
UTF-8 (dengan atau tanpa BOM) atau UTF-16 dengan BOM (hasil `>` di Windows PowerShell 5.1). Simpan file token di luar folder
proyek dan jangan pernah di-commit.

## Autostart

Autostart menjalankan server AI Office saat Anda login. Fitur ini opsional. Server mendengarkan di `127.0.0.1:3000` pada
pengaturan ini. Jalankan perintah dari folder proyek. Perintahnya sama di bash, zsh, dan PowerShell.

```bash
npm run autostart:install      # pasang autostart dan jalankan server
npm run autostart:status       # tampilkan status autostart dan server (hanya baca)
npm run autostart:stop         # hentikan server sekarang; autostart tetap terpasang
npm run autostart:uninstall    # hapus autostart dan hentikan server
```

Untuk melihat apa yang akan ditulis pemasangan tanpa mengubah apa pun:

```bash
node scripts/autostart.mjs install --dry-run
```

### Windows

- Membuat pintasan bernama "AI Office" di folder Startup pengguna Anda. Tidak perlu hak admin.
- Peluncur tersembunyi (`scripts/windows/start-ai-office.vbs`) menjalankan supervisor. Supervisor menyalakan ulang server
  setelah crash, dengan jeda 5, 10, 20, 40, lalu 60 detik. Setelah 8 crash berturut-turut, supervisor berhenti.
- Log server: `logs/server.log`. Bila lebih dari 5 MB, file dipindah ke `logs/server.log.1`.
- Jika server sudah berjalan dari `npm start` di port 3000, autostart tidak menjalankan salinan kedua.

### macOS

- Membuat LaunchAgent di `~/Library/LaunchAgents/com.ai-office.server.plist` dan memuatnya dengan `launchctl`.
  Tidak perlu hak admin.
- Log server: `logs/server.log` di folder proyek.

### Linux

- Membuat unit systemd user di `~/.config/systemd/user/ai-office.service`. Perlu `systemctl --user`, jadi sesi login biasa
  diperlukan.
- Untuk menjaga server tetap berjalan tanpa login (misalnya di mesin tanpa layar), jalankan sendiri. Pemasang tidak
  menjalankannya:

  ```bash
  sudo loginctl enable-linger "$USER"
  ```

- Log: `journalctl --user -u ai-office.service -f`.

### Catatan untuk semua platform

- Pemasang mencatat path executable Node.js yang dipakainya. Jika Anda berganti versi Node.js dengan nvm, fnm, asdf, atau
  Volta, jalankan `npm run autostart:install` lagi. Path lama mungkin sudah tidak ada.
- Autostart menjalankan `server/index.js` dari folder proyek setiap kali Anda login, dan hook level user menjalankan
  `hooks/send-event.mjs` di setiap sesi Claude Code. Simpan proyek di folder yang hanya bisa ditulis akun Anda sendiri.

## Divisi buatan pengguna

Divisi berada di folder `divisions/`, atau di folder yang diisi `AI_OFFICE_DIVISIONS_DIR`. Aturan file dan batasnya ada di
[CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-division) (berbahasa Inggris). Bagian ini mencatat apa yang ditegakkan oleh
server dan skrip pemasangan.

- **Penemuan.** Server membaca folder itu sekali, saat mulai (`server/divisions.js`). Divisi yang tidak valid dilewati, dan
  alasannya tercantum di `GET /api/divisions` pada `errors`. Batasnya: 12 divisi plugin, dan 1 sampai 8 worker serta 1
  sampai 8 meja per divisi.
- **Frontmatter.** File worker hanya boleh berisi `name`, `description`, `tools`, dan `model`. Kunci lain, misalnya `hooks`,
  `mcpServers`, atau `permissionMode`, ditolak. Aturan ini juga berlaku untuk agen bawaan, dan `npm run agents:validate`
  memeriksanya.
- **Tool aman.** Worker plugin yang hanya memakai `Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch`, dan `TodoWrite`
  terpasang tanpa flag. Tool lain, misalnya `Bash`, `PowerShell`, `WebFetch`, atau `NotebookEdit`, berisiko.
- **`npm run agents:install`** memasang worker plugin yang aman. Worker yang tidak lolos validasi dilewati dan keluar dengan
  kode `3`. Worker berisiko (memakai tool di luar daftar aman) yang baru, atau yang isinya berubah sejak disetujui, dilewati
  dengan peringatan dan juga keluar dengan kode `3`. File worker itu tetap berada di folder divisinya.
- **Persetujuan** (`--allow-risky-tools`) terikat ke hash SHA-256 file, bukan ke nama. Perintah mencetak tiap worker berisiko
  dengan 12 karakter awal hash, lalu mencatat hash lengkapnya di `approvedRisky` pada
  `~/.claude/agents/.ai-office-installed.json`. Baca lebih dulu baris `tools:` dari paket pihak ketiga.
- **Memperbarui worker yang sudah disetujui.** File yang berubah dilewati lagi sampai kamu menyetujuinya. Jalankan
  `--allow-risky-tools --force` setelah membaca file barunya.
- **`--force`** hanya menimpa file yang tercatat di `~/.claude/agents/.ai-office-installed.json` dan isinya di disk masih
  cocok dengan hash yang dicatat AI Office. File yang kamu tulis atau ubah tidak pernah ditimpa.
- **`npm run setup`** menjalankan semua langkah. Bila `agents:install` keluar dengan kode `3`, setup ikut keluar dengan kode
  `3` dan menyebut worker berisiko yang bisa dikenali di akhir.
- **Nama tercadang.** Id divisi atau nama worker tidak boleh berupa nama perangkat Windows: `con`, `nul`, `prn`, `aux`,
  `com0` sampai `com9`, atau `lpt0` sampai `lpt9`.
- **`npm run division:add --from`** mencetak peringatan bila starter memakai tool berisiko. Starter `dev-team` memakai
  `Bash`, dan `research-team` memakai `WebFetch`.

```bash
npm run agents:install                                  # memasang worker aman; melewati worker berisiko yang baru atau berubah (kode keluar 3)
npm run agents:install -- --allow-risky-tools           # menyetujui dan memasang worker berisiko yang tercantum
npm run agents:install -- --allow-risky-tools --force   # juga memperbarui worker berisiko yang sudah disetujui dan berubah
npm run agents:install -- --force                       # hanya menimpa file yang belum diubah dan dipasang AI Office
npm run agents:validate                                 # memeriksa frontmatter, tool, dan frasa aturan; memberi label worker berisiko
```

## Kepribadian worker

Kepribadian adalah data tampilan opsional di `division.json` divisi. Aturan file dan batasnya ada di
[CONTRIBUTING.md](../CONTRIBUTING.md#worker-personalities) (berbahasa Inggris). Bagian ini mencatat apa yang dikembalikan
server dan apa yang dilakukan dasbor dengannya.

- **Cakupan.** Kepribadian hanya mengubah tampilan worker di dasbor: nama panggilan, balon ucapan, kebiasaan idle, dan quirk.
  Data ini tidak pernah masuk ke prompt agen, file agen, template tugas, argumen runner, atau hook
  (`tests/personalityNoLeak.test.js`).
- **`GET /api/divisions`.** Divisi plugin dengan kepribadian yang valid punya objek `personalities`, dengan kunci nama worker,
  berisi nilai yang sudah dibersihkan. Setiap teks berbentuk `{ "en", "id" }`. Divisi tanpa kepribadian tidak punya kunci
  `personalities`. Kepribadian yang diabaikan tercantum di `errors` sebagai `{ dir, message }`, dengan `dir` adalah nama
  folder, dan divisinya tetap tercantum. Karakter bawaan tidak termasuk dalam respons ini. Dasbor memakai default bawaannya
  sendiri untuk karakter tersebut (`shared/personalities.js`).
- **Default netral.** Worker tanpa kepribadian yang valid tidak punya nama panggilan, frasa, gaya bicara, quirk, dan
  kebiasaan idle-nya adalah `coffee`.
- **Gerak dikurangi.** Dengan `prefers-reduced-motion: reduce`, jalan-jalan idle dan animasi kebiasaan idle dimatikan, quirk
  yang bergerak tidak berjalan, dan quirk `headphones` tetap tampil.

Identifier yang sama dipakai di setiap bahasa. Hanya deskripsi di bawah yang diterjemahkan.

| Field | Identifier |
| --- | --- |
| `speech.tone` | `formal`, `casual`, `cheerful`, `calm`, `dry` |
| `idle` | `coffee`, `stretch`, `phone`, `water`, `snack`, `plant`, `window`, `chat` |
| `quirk` | `hum`, `pen-spin`, `desk-tap`, `yawn`, `glasses`, `headphones`, `plant-talk`, `doodle` |

Kebiasaan idle. "Ke pantry" berarti worker juga pergi ke pantry saat idle; yang lain tetap di meja.

| Identifier | Perilaku |
| --- | --- |
| `coffee` | Menyeruput cangkir. Ke pantry. |
| `water` | Minum dari botol. Ke pantry. |
| `snack` | Makan camilan. Ke pantry. |
| `plant` | Menyiram tanaman. Ke pantry. |
| `chat` | Melambaikan tangan. Ke pantry. |
| `stretch` | Meregangkan badan di meja. |
| `phone` | Melihat ponsel di meja. |
| `window` | Menghadap jendela. |

Quirk. Quirk hanya tampil saat worker sedang idle atau bekerja. Quirk bertanda "butuh meja" hanya digambar untuk karakter
yang punya meja.

| Identifier | Gambar |
| --- | --- |
| `hum` | Not kecil di atas kepala. |
| `pen-spin` | Pena merah berputar di meja. Butuh meja. |
| `desk-tap` | Tangan mengetuk meja. Butuh meja. |
| `yawn` | Menguap di atas kepala. |
| `glasses` | Pose kacamata. |
| `headphones` | Headphone di sprite. Statis, jadi tetap tampil saat gerak dikurangi. |
| `plant-talk` | Tanda hijau kecil di dekat tanaman. Butuh meja. |
| `doodle` | Coretan kecil di meja. Butuh meja. |

## Tema kantor dan pengaturan

Latar kantor punya lima tema bawaan, dan dialog **Pengaturan** memilih tema, mode waktu, pengaturan gerak, dan hujan.
Tema berupa berkas `themes/<id>/theme.json`: hanya data, tanpa kode. Cara menulisnya ada di
[Membuat tema](../CONTRIBUTING.md#creating-a-theme) (berbahasa Inggris).

Lokasi kodenya:

- `themes/` (data), `shared/themes.js` (validator dan batasnya)
- `src/office/themeRegistry.js` (memuat tema saat build), `src/office/decor.js` (menggambar dekorasi), `src/office/palette.js` (palet dan `CONTRAST_PAIRS`)
- `src/office/daycycle.js` (fase dan tampilannya), `src/settings.js` (penyimpanan pengaturan), `src/ui/SettingsDialog.jsx` (dialog)

### Tema

| Id | Catatan |
| --- | --- |
| `jakarta` | Bawaan. Tampilan asli. `theme.json`-nya mendefinisikan semua kunci palet, dan tema lain jatuh ke nilainya. |
| `startup-cozy` | Tema bawaan. |
| `cyberpunk` | Tema bawaan. |
| `kafe` | Tema bawaan. |
| `stasiun-luar-angkasa` | Tema bawaan. |

Id sama dengan nama folder. Tema yang tidak valid dilewati dengan peringatan, dan dialog Pengaturan menampilkannya. Bila
id tema yang tersimpan tidak ada, dasbor menampilkan `jakarta`, dan nilai yang tersimpan tetap dibiarkan.

### Pengaturan

Pengaturan berupa satu objek JSON di `localStorage` dengan kunci `ai-office-settings` (lihat [Kunci localStorage](#kunci-localstorage)).

| Kolom | Nilai | Bawaan | Arti |
| --- | --- | --- | --- |
| `officeTheme` | id tema | `jakarta` | Tema kantor. |
| `timeMode` | `off`, `auto`, `subuh`, `pagi`, `siang`, `sore`, `malam` | `off` | `off` (Mati) adalah perilaku lama: kantor mengikuti tema antarmuka terang atau gelap (terang = day, gelap = night), tanpa tint atau lampu. `auto` (Otomatis) mengambil fase dari jam lokal browser. Nama fase (Manual) mengunci fase itu. Lihat [Siklus siang-malam](#siklus-siang-malam). Nilai lama `follow`, `day`, dan `night` tetap dibaca dan menjadi `off`, `siang`, dan `malam`. |
| `motion` | `system`, `reduce`, `full` | `system` | `system` mengikuti `prefers-reduced-motion`. `reduce` dan `full` menimpanya. |
| `rain` | `true`, `false` | `false` | Hujan di kantor. Kotak centang mati dan tidak bisa diubah saat gerak dikurangi. Nilai tersimpan tetap dipertahankan. |

Elemen akar mendapat `data-motion="reduce"` atau `data-motion="full"`, dan atribut dihapus untuk `system`.

### Tata letak kantor dan ruang CEO

Kanvas logis berukuran 640 x 498 piksel (dulu 480 x 456; `W`, `BASE_H` di `src/office/layout.js`) dan `fitCanvas` menyesuaikannya dengan
lebar yang tersedia (termasuk ponsel 360 px). Dari atas ke bawah:

| Pita | Isi |
| --- | --- |
| Pita atas (y 34 sampai 152) | Pintu masuk, pantry, karpet manajer, ruang rapat kaca, dan **ruang CEO** (kanan) |
| Baris 1 (y 162) | Dev (7 meja), Marketing & Sales (3) |
| Baris 2 (y 298) | Konten (2), Riset (1), 3D (4, klaster 2x2) |
| Baris 3 (y 430) | Tamu / Lainnya (5 meja, selebar kantor) |
| Baris 4 ke bawah | Divisi buatan pengguna (dua zona per baris, maksimal 3 meja per baris di dalam zona), hanya bila ada |

`ROOMS` di `src/office/layout.js` memuat kotak pembatas tiap ruangan, dan `tests/ceoRoom.test.js` memeriksa bahwa tidak ada ruangan yang
menimpa zona atau ruangan lain, dengan 0, 1, 2, 6, dan 12 divisi pengguna. Divisi pengguna selalu mendapat zona di bawah semua ruangan dan zona bawaan.

Ruang CEO adalah ruangan tertutup berdinding kaca dengan satu pintu. CEO duduk di meja besar dengan papan nama "CEO" (dan plakat "CEO" di
kaca), rak buku, meja kopi dengan mesin kopi, tanaman, dan jendela di dinding belakang. Warnanya diturunkan dari palet tema, jadi ikut tema dan
siklus siang-malam (cahaya lampu dan tint) tanpa field tema baru. Perilaku (hanya tampilan; tidak mengubah status, antrean, atau event):

- Tugas dari CEO (`assign` dari `ceo` ke `manager`): CEO berdiri, berjalan keluar pintu ke depan meja manajer (atau ke depan ruang rapat bila
  manajer sedang pergi), menyerahkan amplop, lalu kembali. Manajer bereaksi saat amplop tiba, sekitar tiga detik setelah event.
- Laporan ke CEO (`report`/`blocked` dari `manager` ke `ceo`): amplop mendarat di meja CEO dan CEO bereaksi di sana.
- Idle: sesekali CEO berdiri untuk minum kopi di meja kopi atau melihat jendela, lalu duduk lagi. Ini memakai aliran acak berbiji
  tersendiri, jadi tidak menggeser perjalanan pantry atau frasa kepribadian para pekerja.
- Reduced motion: CEO tidak berjalan. Amplop terbang langsung dari meja ke manajer, dan semua teks tetap tampil.

### Siklus siang-malam

Mode waktu bisa mewarnai kantor menurut waktu. Fase diambil dari **jam lokal browser** (zona waktu perangkat), diperiksa
sekali per menit (dan saat tab terlihat lagi), tidak pernah per frame.

| Fase (nilai `timeMode`) | Jam lokal | Palet | Tint | Cahaya jendela | Lampu | Tim |
| --- | --- | --- | --- | --- | --- | --- |
| `subuh` | 04:00-05:59 | night | indigo, 10% | kaca merah muda-oranye | nyala (90%) | ngantuk (60%) |
| `pagi` | 06:00-10:59 | day | kuning pucat, 3% | kaca kuning pucat | mati | normal |
| `siang` | 11:00-14:59 | day | tanpa tint | tanpa cahaya kaca (berkas cahaya siang netral) | mati | normal |
| `sore` | 15:00-17:59 | day | oranye, 5% | kaca oranye | nyala (50%) | normal |
| `malam` | 18:00-03:59 (melewati tengah malam) | night | biru tua, 8% | berkas cahaya bulan yang sejuk | nyala (100%) | ngantuk (100%) |

Dialog Pengaturan menawarkan tiga pilihan: **Mati** (bawaan, tampilan lama), **Otomatis** (jam real-time, fase saat ini
ditampilkan), dan **Manual** (daftar untuk memilih salah satu dari lima fase). Catatan:

- Semua tema langsung bisa dipakai tanpa perubahan. Fase memilih palet `day` atau `night` milik tema (kolom palet) lalu
  menambah lapisan warna tipis, cahaya jendela, dan lampu di atasnya; warnanya berasal dari fase, bukan dari `theme.json`.
  Tema tidak butuh field baru, dan tema buatan pengguna yang sudah ada tetap jalan.
- Tint fase dibuat tipis supaya setiap label tetap punya kontras minimal 4,5:1 di semua tema; test memeriksanya.
- Saat fase aktif, latar di-cache per tema, varian, dan fase. Latar digambar ulang hanya bila salah satunya berubah.
  Tint hanya satu persegi per frame.
- Saat malam dan subuh, worker idle sesekali menguap di mejanya, sesekali bergumam ngantuk, dan lebih sering ke pantry
  untuk ngopi. Ini hanya tampilan: tidak pernah mengubah status, antrean, atau event, dan memakai keacakan berbiji. Dengan
  gerak dikurangi tidak ada jalan-jalan atau menguap; kalimat ngantuk (teks) tetap muncul.
- Nilai tersimpan lama tetap berlaku: `follow` menjadi `off`, `day` menjadi `siang`, `night` menjadi `malam`. Versi
  pengaturan tetap `1`. Pengguna yang tadinya memilih `night` kini juga melihat tint malam dan lampu.
- Untuk test, jam disuntik: `phaseAt(now)` dan `watchPhase({ clock })` di `src/office/daycycle.js`, serta
  `resolvePhase(timeMode, { now })` dan `resolveVariant(timeMode, { uiTheme, now })` di `src/settings.js`.

### Kunci localStorage

| Kunci | Nilai | Dikelola oleh | Catatan |
| --- | --- | --- | --- |
| `ai-office-settings` | JSON, misalnya `{"v":1,"officeTheme":"jakarta","timeMode":"off","motion":"system","rain":false}` | `src/settings.js` | `v` harus `1`. Kolom yang tidak dikenal dibuang saat disimpan. Nilai lebih dari 4096 karakter, JSON yang rusak, atau `v` lain dianggap rusak, dan bawaan dipakai. |
| `ai-office-rain` | `"1"` untuk hujan aktif, selain itu nonaktif | `src/settings.js` (lama) | Hanya dibaca bila `ai-office-settings` belum ada. Nilainya lalu disalin ke kunci baru. Kode tidak menghapusnya. Bila `ai-office-settings` ada tetapi rusak, bawaan dipakai, `rain` tetap membaca kunci ini, dan tidak ada yang ditulis. |
| `ai-office-lang` | `en` atau `id` | `src/i18n.js` | Bahasa antarmuka. Dibaca sebelum render pertama. Bukan bagian objek pengaturan. |
| `ai-office-theme` | `dark` atau `light` | `src/theme.js` dan `public/theme-init.js` | Mode terang atau gelap antarmuka, terpisah dari tema kantor. Bila kosong atau tidak valid, preferensi sistem dipakai, dan preferensi yang tidak diketahui berarti `dark`. |

Semua akses storage dibungkus `try`/`catch`. Bila storage diblokir atau penuh, perubahan tetap berlaku di memori sampai
halaman dimuat ulang.

Identifier di bagian ini (id tema, `off`, `auto`, `subuh`, `pagi`, `siang`, `sore`, `malam`, `system`, `reduce`, `full`, dan nama kunci) sama dengan
referensi bahasa Inggris.

## Test dan pemeriksaan

```bash
npm test                       # suite Vitest (menjalankan cek versi Node dulu)
npm run build                  # bangun UI ke dalam dist/
npm run smoke                  # jalankan server di port bebas dan cek GET /api/health
npm run agents:validate        # periksa file agen
```

`npm test` mencakup antara lain: format event, pemetaan hook, server HTTP dan WebSocket, skrip hook (proses sungguhan),
mesin animasi dan skenario simulasi, file agen (termasuk model yang diizinkan), konfigurasi dan pemasang hook, autentikasi
token, runner (`tests/runner.test.js`, yang memakai CLI tiruan `tests/fixtures/fake-claude.mjs` lewat `AI_OFFICE_CLAUDE_BIN`,
bukan `claude` sungguhan), runner key, demo, terjemahan (setiap kunci di `locales/en.json` dan `locales/id.json`), statistik
pemakaian, regresi keamanan, skrip autostart, supervisor Windows (pemeriksaan statis, plus pemeriksaan PowerShell bila
`powershell.exe` ada), dan pemeriksaan statis kit deploy (`deploy/` dan `docs/DEPLOY.md`). Pemeriksaan sintaks shell skrip
deploy (`bash -n`) dilewati bila `bash` tidak ada di `PATH`.

CI (`.github/workflows/ci.yml`) menjalankan `npm ci`, `npm run build`, dan `npm test` di Ubuntu, Windows, dan macOS, dengan
Node 22.12 dan LTS terbaru. `agents:validate` tidak dijalankan di CI karena memeriksa `~/.claude/agents`.

## Struktur folder

```text
agents/                    17 definisi subagen (sumber), termasuk divisi 3D (3d-*.md)
divisions/                divisi buatanmu, satu folder per divisi (hanya README.md yang dikirim); lihat CONTRIBUTING.md
division-packs/           starter pack untuk npm run division:add (dev-team, content-team, research-team, example-legal)
locales/                   terjemahan: en.json dan id.json (namespace cli, ui, office)
themes/                    tema kantor, satu folder per tema dengan theme.json (jakarta bawaan); lihat CONTRIBUTING.md
CLAUDE.md                  aturan manajer (dipakai Claude Code saat berjalan di folder ini)
output/                    hasil tugas dan demo, satu folder per proses (dibuat otomatis, diabaikan git)
data/                      cache statistik pemakaian (dibuat otomatis, diabaikan git)
logs/                      log server dari autostart (dibuat otomatis, diabaikan git)
dist/                      keluaran build UI (npm run build)
docs/                      referensi ini, DEPLOY.md / DEPLOY.en.md, dan gambar untuk README
server/                    server HTTP dan WebSocket (app.js, index.js), autentikasi (auth.js, tokenSource.js),
                           runner (runner.js, tasks.js, runnerKey.js), folder tugas (outputStore.js), demo
                           (demo.js, demo/<lang>/), template tugas (templates/task-claude.md), pemakaian (usage.js),
                           pemuat .env (loadEnv.js), pemeriksaan versi Node (requireNode.js, nodeVersion.js)
shared/                    format event, roster, pemetaan hook, terjemahan (i18n.js), pemakaian token; dipakai server, hook, dan UI
hooks/                     skrip hook Claude Code (send-event.mjs, transcript-tokens.mjs)
src/                       UI React dan kanvas (src/office/ animasi dan kanvas, src/sim/ simulasi, src/ui/ komponen)
scripts/                   setup, pasang dan validasi agen, pemasang dan penghapus hook user, open,
                           laporan pemakaian, demo hook, pembuat token, autostart, smoke test
scripts/windows/           autostart Windows (peluncur, supervisor, pasang, hapus, hentikan)
deploy/                    kit VPS: setup-vps.sh, update.sh, rotate-token.sh, lib.sh, unit systemd, konfigurasi Nginx
tests/                     test Vitest dan helper (tests/helpers/), fixture (tests/fixtures/)
.github/                   workflow CI, template issue, dan template pull request
reports/                   laporan internal manajer (diabaikan git, kecuali .gitkeep)
```

File di root: `README.md` dan `README.id.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
`LICENSE` (MIT), `package.json`, `vite.config.js`, `.env.example`, `limit-config.example.json`.
