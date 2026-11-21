# divisions/

**English.** Put your own divisions here, one folder per division: `divisions/<id>/division.json` plus
`divisions/<id>/agents/<worker>.md` for every worker. Divisions are plain data (JSON and Markdown); AI Office never
executes them. Create one with `npm run division:add <id>` (add `-- --from dev-team` to copy a starter from
`division-packs/`, `--dry-run` to preview). Then run `npm run agents:install`, then `npm run agents:validate` (it labels
risky workers `[RISKY: ...]`), and restart the server. A worker that uses a tool outside the safe list (`Read`, `Glob`,
`Grep`, `Write`, `Edit`, `WebSearch`, `TodoWrite`) is skipped with exit code 3 until you approve it with
`npm run agents:install -- --allow-risky-tools`. Read its `tools:` line first. Approval is tied to the file's content: a
changed file is skipped again until you approve it, and `npm run agents:install -- --allow-risky-tools --force` updates an
approved worker. Rules: [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-division). This repository ships with no active
division; you may commit yours in your fork.

**Indonesia.** Taruh divisi buatanmu di sini, satu folder per divisi: `divisions/<id>/division.json` dan
`divisions/<id>/agents/<worker>.md` untuk setiap worker. Divisi hanyalah data (JSON dan Markdown); AI Office tidak pernah
menjalankannya. Buat dengan `npm run division:add <id>` (tambahkan `-- --from dev-team` untuk menyalin starter dari
`division-packs/`, atau `--dry-run` untuk pratinjau). Lalu jalankan `npm run agents:install`, kemudian
`npm run agents:validate` (memberi label worker berisiko `[RISKY: ...]`), dan mulai ulang server. Worker yang memakai tool
di luar daftar aman (`Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch`, `TodoWrite`) dilewati dengan kode keluar 3 sampai
kamu menyetujuinya dengan `npm run agents:install -- --allow-risky-tools`. Periksa dulu baris `tools:`-nya. Persetujuan
terikat ke isi file: file yang berubah dilewati lagi sampai kamu menyetujuinya, dan
`npm run agents:install -- --allow-risky-tools --force` memperbarui worker yang sudah disetujui. Aturan:
[CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-division) (berbahasa Inggris). Repo ini tidak membawa divisi aktif; kamu boleh
meng-commit divisimu di fork-mu.
