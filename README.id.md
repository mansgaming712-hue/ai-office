# AI Office

Kantor pixel-art tempat manajer Claude Code dan 17 agen spesialisnya bekerja, terlihat langsung di layar Anda.

Dokumen ini adalah versi Bahasa Indonesia. Versi dua bahasa (Inggris dan Indonesia) ada di [README.md](README.md),
dan versi Inggris ada di [bagian English](README.md#english).

## Bahasa Indonesia

### Fitur

- **Kantor pixel-art** bergaya Jakarta, dengan meja manajer, meja spesialis, dan log kejadian langsung.
- **Tugas sungguhan:** ketik tugas di kotak perintah. Server menjalankan Claude Code sebagai manajer, di folder baru
  di dalam `output/`. Hasilnya dibuka dari panel **Tugas**.
- **Demo:** tombol **Demo** memutar tugas contoh (sekitar 54 detik) dari server, tanpa Claude Code. **▶ Simulasi**
  memutar animasi lokal, dan **↺ Reset** mengosongkan kantor dan log.
- **Hook langsung:** delegasi dari sesi Claude Code Anda muncul di dasbor setelah hook dipasang.
- **Panel Pemakaian Limit:** estimasi pemakaian token dari log Claude Code lokal. Ini bukan angka resmi.
- **Mode lokal atau token**, tema terang dan gelap, antarmuka Bahasa Indonesia dan Inggris.
- **Autostart** di Windows, macOS, dan Linux (opsional).
- **Divisi buatan pengguna:** tambahkan divisi sebagai data biasa (JSON dan Markdown), dari kerangka kosong atau starter pack. Maksimal 12 divisi. Lihat [Divisi buatan pengguna](#divisi-buatan-pengguna).
- **Kepribadian worker:** setiap worker bisa punya nama panggilan, gaya bicara dengan frasa di balon ucapan, kebiasaan idle, dan quirk kecil. Ini hanya untuk tampilan dasbor dan tidak pernah masuk ke prompt agen. Lihat [Kepribadian worker](docs/REFERENCE.id.md#kepribadian-worker).
- **Tema kantor dan pengaturan:** lima tema kantor (Jakarta sebagai bawaan) dan panel Pengaturan untuk tema kantor, mode waktu, gerak, dan hujan. Tema hanya berupa data; tidak ada kode dari tema yang dijalankan. Lihat [Tema kantor dan pengaturan](docs/REFERENCE.id.md#tema-kantor-dan-pengaturan) dan [Membuat tema](CONTRIBUTING.md#creating-a-theme) (berbahasa Inggris).

### Mulai cepat

Anda butuh Node.js 22.12 atau lebih baru. Claude Code hanya diperlukan untuk tugas sungguhan; demo berjalan tanpanya.

Buka terminal di folder tempat Anda ingin menyimpan proyek, lalu:

#### Windows (PowerShell)

Pasang Node.js bila belum ada: `winget install OpenJS.NodeJS.LTS` (buka terminal baru setelahnya).

```powershell
git clone https://github.com/mansgaming712-hue/ai-office.git
cd ai-office
npm run setup
npm start
```

#### macOS (Terminal)

Pasang Node.js bila belum ada: `brew install node` (atau installer dari https://nodejs.org/).

```bash
git clone https://github.com/mansgaming712-hue/ai-office.git
cd ai-office
npm run setup
npm start
```

#### Linux

Pasang Node.js 22 dengan [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`, lalu `nvm use 22`.

```bash
git clone https://github.com/mansgaming712-hue/ai-office.git
cd ai-office
npm run setup
npm start
```

Lalu buka tautan yang dicetak `npm start`. Bentuknya `http://localhost:3000/#key=...`. Bagian setelah `#key=` adalah
runner key, yang dibutuhkan tugas dan demo di mode lokal. Jika tautannya hilang, jalankan `npm run open` di terminal
kedua dari folder proyek.

### Instalasi dan pengaturan

- **Syarat:** Node.js 22.12 atau lebih baru, npm, dan (untuk tugas sungguhan) CLI Claude Code (`claude`) yang sudah
  terpasang dan sudah login. Pasang dengan `npm install -g @anthropic-ai/claude-code`.
- **`npm run setup`** memeriksa versi Node.js, menjalankan `npm ci` dan build, memasang agen ke `~/.claude/agents`,
  menambahkan hook ke `~/.claude/settings.json`, lalu memeriksa CLI Claude Code. Pakai `npm run setup -- --no-claude`
  bila belum memakai Claude Code, atau `npm run setup -- --dry-run` untuk hanya melihat langkahnya.
- **Cara manual:** `npm run agents:install` dan `npm run hooks:install-user`.
- Hook hanya berlaku untuk sesi Claude Code yang dimulai **setelah** pemasangan. Mulai ulang sesi yang sudah terbuka.
  Untuk menghapus hook: `npm run hooks:uninstall-user`.
- **Tugas pertama Anda:** jalankan server, buka tautannya, ketik satu kalimat biasa di kotak perintah, lalu tekan Enter.
  Panel **Tugas** menampilkan tugas sebagai berjalan. Saat selesai, klik **Hasil** untuk membaca `RESULT.md` dan file lain.
  File tersebut juga ada di `output/<tanggal-jam>-<slug>/`.
- Teks biasa dikirim ke runner sungguhan saat runner siap (jika tidak, hanya diputar sebagai animasi). `@nama-agen tugas`
  selalu hanya memutar animasi untuk agen itu.
- **Catatan keamanan (mode lokal):** mode lokal tanpa token bisa dijangkau oleh semua akun dan proses di komputer ini,
  dan hook mengirim event ke proses mana pun yang memegang port 3000. Di komputer bersama atau multi-pengguna, pakai mode
  token dengan mengisi `AI_OFFICE_TOKEN_FILE`. Rincian: [Autentikasi dan mode server](docs/REFERENCE.id.md#autentikasi-mode-server-dan-runner-key).
- Pengaturan (`.env`, `limit-config.json`, variabel runner): lihat [docs/REFERENCE.id.md](docs/REFERENCE.id.md#variabel-lingkungan).

### Contoh tugas

Tempel contoh ini ke kotak perintah. Setiap contoh berjalan sebagai tugas terpisah.

Konten untuk TikTok:

```text
Buatkan skrip TikTok 25 detik untuk promo es kopi susu gula aren, dengan hook di 3 detik pertama, dan caption untuk Instagram.
```

Riset pasar produk lokal:

```text
Riset harga kopi susu gula aren di kafe-kafe sekitar Jakarta Selatan. Berikan rentang harganya, sumber yang kamu pakai, dan batas dari data itu.
```

Caption jualan:

```text
Buatkan 3 caption jualan untuk kopi susu gula aren kemasan botol 250 ml, sasaran mahasiswa, gaya santai, masing-masing dengan satu ajakan membeli.
```

Audit website:

```text
Audit landing page https://example.com. Ambil halamannya dengan WebFetch, lalu nilai copy, struktur judul, dan ajakan tindakan. Tulis temuannya di RESULT.md.
```

Runner ini tidak punya Bash, PowerShell, maupun alat MCP, dan hanya membaca serta menulis di folder tugasnya sendiri. Jadi audit hanya membaca halaman lewat WebFetch dan tidak bisa menjalankan uji kecepatan dengan alat lokal.

### Agen

17 spesialis, didefinisikan di `agents/` dan didaftarkan di `shared/roster.js`. Aturan manajer ada di `CLAUDE.md`.

| Divisi | Agen |
| --- | --- |
| Dev | dev-frontend, dev-backend, dev-qa, dev-security, dev-ui-critic, dev-devops, dev-docs |
| Marketing & Sales | sales-copywriter, sales-research, sales-pricing |
| Konten | content-script, content-animator |
| Riset | research-analyst |
| 3D | 3d-modeler, 3d-materials, 3d-animator, 3d-render |

Periksa agen yang terpasang dengan `npm run agents:validate`.

### Divisi buatan pengguna

Tambahkan divisi dari starter pack (`dev-team`, `content-team`, `research-team`, atau `example-legal`) dalam tiga baris:

```bash
npm run division:add legal -- --from example-legal   # membuat divisions/legal/
npm run agents:install                                # menyalin file worker ke ~/.claude/agents
npm start                                             # mulai ulang server (hentikan yang lama dulu)
```

Tanpa `--from`, perintah membuat kerangka dengan satu worker dan dua meja. Tambahkan `--dry-run` untuk melihat hasilnya tanpa menulis apa pun. Server hanya membaca `divisions/` saat mulai, jadi mulai ulang setelah setiap perubahan. Jalankan `npm run agents:validate` untuk memeriksa hasilnya. Divisi yang tidak valid dilewati, server tetap jalan, dan alasannya tercantum di `GET /api/divisions`.

Divisi hanyalah data, bukan kode, dan AI Office tidak pernah menjalankannya. File worker hanya boleh memakai kunci frontmatter `name`, `description`, `tools`, dan `model`; setelah dipasang, Claude Code memuatnya sebagai subagen. Karena itu `npm run agents:install` melewati worker plugin yang memakai tool di luar daftar aman (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch`, `TodoWrite`) dan keluar dengan kode `3`. Periksa baris `tools:` dari paket apa pun yang tidak kamu tulis sebelum memakai `--allow-risky-tools`. `--force` hanya menimpa file yang dipasang AI Office dan belum kamu ubah. Aturan, batas, dan cara mengirim starter pack baru: [CONTRIBUTING.md](CONTRIBUTING.md#adding-a-division) (berbahasa Inggris).

### Pemecahan masalah

- **Port 3000 sudah dipakai.** Jalankan di port lain. macOS dan Linux: `PORT=3001 npm start`. Windows PowerShell:
  `$env:PORT=3001; npm start`. Lalu buka http://localhost:3001. Hook perlu `AI_OFFICE_URL=http://127.0.0.1:3001/api/events`.
- **Versi Node.js terlalu lama.** Server mencetak pesan lalu berhenti. Cek `node -v` dan pasang 22.12 atau lebih baru (lihat Mulai cepat).
- **`npm run build` atau `npm test` gagal.** Periksa versi Node.js dulu.
- **Dasbor kosong** ("Kantor masih sepi"). Klik **Demo** untuk melihat contoh. Untuk sesi sungguhan, jalankan
  `npm run hooks:install-user` lalu mulai sesi Claude Code baru.
- **"CLI Claude Code tidak ditemukan".** Pasang Claude Code dan jalankan `claude` sekali untuk login. Jika CLI ada di lokasi
  khusus, isi `AI_OFFICE_CLAUDE_BIN` dengan path lengkapnya sebelum `npm start`.
- **"Runner butuh key".** Buka tautan yang dicetak di terminal (berisinya `#key=`), atau jalankan `npm run open`.
  Jika server menjawab "Runner key salah.", halaman yang terbuka memakai key lama; jalankan `npm run open` lagi.
- **"Runner sedang sibuk".** Hanya satu tugas atau demo yang berjalan. Tunggu selesai, atau klik **Batalkan** di panel Tugas.
- **Masalah autostart atau layanan Windows:** lihat [docs/REFERENCE.id.md](docs/REFERENCE.id.md#autostart).

### Kontribusi dan lisensi

Baca [CONTRIBUTING.md](CONTRIBUTING.md) sebelum membuka pull request, dan ikuti [Kode Etik](CODE_OF_CONDUCT.md).
Laporkan masalah keamanan secara privat, seperti dijelaskan di [SECURITY.md](SECURITY.md). Jangan membuka issue publik untuk masalah itu.

Referensi teknis (hook, API, variabel lingkungan, autostart, test): [docs/REFERENCE.id.md](docs/REFERENCE.id.md).
Deployment ke VPS: [docs/DEPLOY.md](docs/DEPLOY.md).

AI Office dirilis di bawah Lisensi MIT. Lihat [LICENSE](LICENSE).
