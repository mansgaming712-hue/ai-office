#!/usr/bin/env bash
# Perbarui AI Office di VPS tanpa menyentuh file env (/etc/ai-office/ai-office.env).
#
# Pemakaian (di VPS, sebagai root):
#   sudo bash ~/ai-office/deploy/update.sh                       pasang kode dari folder ini
#   sudo bash /opt/ai-office/current/deploy/update.sh --rollback kembali ke versi sebelumnya
#
# Cara kerja:
#   1. Salin kode ke rilis baru /opt/ai-office/releases/<waktu UTC> (tanpa node_modules, dist, .git, .claude).
#   2. npm ci, npm run build, npm prune --omit=dev (sebagai user aioffice), lalu kode dibuat milik root.
#   3. Arahkan /opt/ai-office/current ke rilis baru, restart service, cek /api/health dan
#      pastikan /api/events menolak permintaan tanpa token.
#   4. Gagal di langkah 2: versi yang sedang jalan tidak tersentuh sama sekali.
#      Gagal di langkah 3: otomatis kembali ke rilis sebelumnya.
#   5. Simpan KEEP_RELEASES rilis terakhir (default 3), sisanya dihapus.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$SCRIPT_DIR/lib.sh"

PENDING_RELEASE=""

usage() {
  cat <<EOF
Pemakaian:
  sudo bash $0             pasang kode dari folder $(dirname "$SCRIPT_DIR")
  sudo bash $0 --rollback  kembali ke rilis sebelumnya
EOF
}

on_exit() {
  local rc=$?
  if [[ -n "$PENDING_RELEASE" ]]; then
    warn "Membersihkan rilis yang gagal: $PENDING_RELEASE"
    remove_release_dir "$PENDING_RELEASE"
  fi
  if [[ $rc -ne 0 ]]; then
    err "Update tidak selesai (kode $rc). Lihat pesan di atas."
  fi
}

require_installed() {
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE belum ada. Jalankan deploy/setup-vps.sh dulu."
  [[ -f "$UNIT_PATH" ]] || die "$UNIT_PATH belum ada. Jalankan deploy/setup-vps.sh dulu."
  id -u "$APP_USER" >/dev/null 2>&1 || die "User $APP_USER belum ada. Jalankan deploy/setup-vps.sh dulu."
  require_cmd rsync curl npm systemctl runuser
  [[ -x "$NODE_BIN" ]] || die "$NODE_BIN tidak ada. Jalankan deploy/setup-vps.sh dulu."
}

validate_source() {
  local src="$1" f
  for f in package.json package-lock.json server/index.js deploy/lib.sh; do
    [[ -f "$src/$f" ]] || die "File $f tidak ada di $src. Jalankan skrip dari folder kode AI Office yang sudah disalin."
  done
  case "$src/" in
    "$RELEASES_DIR"/*) warn "Sumber adalah rilis yang sudah terpasang ($src): kode yang sama akan di-build ulang." ;;
    "$APP_ROOT"/*) die "Jangan menyalin kode langsung ke $APP_ROOT. Salin ke folder lain (mis. ~/ai-office) lalu jalankan dari sana." ;;
  esac
}

# Jalankan perintah sebagai user aioffice di folder tertentu (npm tidak pernah jalan sebagai root).
as_app_user() {
  local dir="$1"
  shift
  (
    cd "$dir"
    runuser -u "$APP_USER" -- env \
      HOME="$APP_HOME" \
      npm_config_cache="$APP_HOME/.npm" \
      npm_config_update_notifier=false \
      npm_config_fund=false \
      npm_config_audit=false \
      "$@"
  )
}

# 0 = sehat dan terlindungi, 1 = health gagal, 2 = /api/events terbuka tanpa token.
verify_app() {
  local host="$1"
  app_health "$host" 30 || return 1
  app_events_protected "$host" || return 2
  return 0
}

prune_old_releases() {
  local keep="$KEEP_RELEASES" current name count=0
  [[ "$keep" =~ ^[0-9]+$ && "$keep" -ge 2 ]] || keep=3
  current="$(basename "$(current_release)")"
  # Dari yang terbaru: simpan $keep rilis, rilis aktif tidak pernah dihapus.
  while IFS= read -r name; do
    count=$((count + 1))
    if [[ $count -gt $keep && "$name" != "$current" ]]; then
      log "Menghapus rilis lama $name"
      remove_release_dir "$RELEASES_DIR/$name"
    fi
  done < <(list_releases | sort -r)
}

deploy_from() {
  local src="$1" host name rel prev rc
  host="$(primary_domain)"
  name="$(date -u +%Y%m%d-%H%M%S)"
  rel="$RELEASES_DIR/$name"
  [[ ! -e "$rel" ]] || die "Rilis $rel sudah ada. Tunggu satu detik lalu ulangi."

  install -d -m 755 -o root -g root "$APP_ROOT" "$RELEASES_DIR"
  install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$APP_HOME"

  log "Menyalin kode dari $src ke $rel"
  PENDING_RELEASE="$rel"
  install -d -m 755 "$rel"
  rsync -rlpt --safe-links --chmod=D755,F644 \
    --exclude='node_modules/' --exclude='dist/' --exclude='.git/' --exclude='.claude/' \
    --exclude='.env' --exclude='.env.*' --exclude='*.log' \
    "$src/" "$rel/"
  chown -R "$APP_USER:$APP_USER" "$rel"

  # --ignore-scripts: skrip install paket pihak ketiga tidak dijalankan di server.
  # Dependensi saat ini tidak membutuhkannya di Linux (satu-satunya, fsevents, khusus macOS).
  log "npm ci (dependensi sesuai package-lock.json)"
  as_app_user "$rel" npm ci --ignore-scripts
  log "npm run build (UI ke dist/)"
  as_app_user "$rel" npm run build
  log "npm prune --omit=dev (buang dependensi build)"
  as_app_user "$rel" npm prune --omit=dev --ignore-scripts
  [[ -f "$rel/dist/index.html" ]] || die "Build tidak menghasilkan dist/index.html."

  # Kode dibuat milik root: user aioffice (yang menjalankan app) tidak bisa mengubahnya.
  chown -R root:root "$rel"

  prev="$(current_release)"
  log "Mengaktifkan rilis $name"
  switch_current "$rel"
  restart_app

  rc=0
  verify_app "$host" || rc=$?
  if [[ $rc -eq 0 ]]; then
    PENDING_RELEASE=""
    ok "Rilis $name aktif: /api/health sehat dan /api/events menolak permintaan tanpa token."
    prune_old_releases
    return 0
  fi

  if [[ $rc -eq 2 ]]; then
    err "Rilis baru menjawab GET /api/events TANPA token. Versi server ini belum memakai autentikasi dan tidak boleh dibuka ke internet."
  else
    err "Rilis baru tidak sehat (GET /api/health gagal). Log terakhir:"
    show_app_logs 40
  fi

  if [[ -n "$prev" && -d "$prev" && "$prev" != "$rel" ]]; then
    warn "Mengembalikan ke rilis sebelumnya: $prev"
    switch_current "$prev"
    restart_app
    if verify_app "$host"; then
      warn "Versi sebelumnya aktif lagi dan sehat."
    else
      err "Versi sebelumnya juga tidak sehat. Periksa: journalctl -u ai-office -n 100"
    fi
  else
    # Deploy pertama: tidak ada versi sebelumnya. Hentikan app supaya tidak ada versi rusak
    # atau tanpa autentikasi yang tetap berjalan, dan simpan rilisnya untuk diperiksa.
    systemctl stop "$SERVICE_NAME" || true
    PENDING_RELEASE=""
    warn "Belum ada versi sebelumnya. Service dihentikan; rilis disimpan di $rel untuk diperiksa."
  fi
  exit 1
}

rollback() {
  local cur cur_name target="" name
  cur="$(current_release)"
  [[ -n "$cur" ]] || die "Belum ada rilis aktif ($CURRENT_LINK)."
  cur_name="$(basename "$cur")"
  while IFS= read -r name; do
    [[ "$name" == "$cur_name" ]] && break
    target="$name"
  done < <(list_releases)
  [[ -n "$target" ]] || die "Tidak ada rilis yang lebih lama dari $cur_name. Rilis tersedia: $(list_releases | tr '\n' ' ')"

  log "Rollback: $cur_name -> $target"
  switch_current "$RELEASES_DIR/$target"
  restart_app
  local host rc=0
  host="$(primary_domain)"
  verify_app "$host" || rc=$?
  if [[ $rc -ne 0 ]]; then
    err "Rilis $target tidak sehat setelah rollback (kode $rc). Log terakhir:"
    show_app_logs 40
    warn "Kembali ke $cur_name."
    switch_current "$cur"
    restart_app
    exit 1
  fi
  ok "Rollback selesai. Rilis aktif: $target. (Rilis $cur_name tetap disimpan.)"
}

main() {
  local mode="deploy"
  case "${1:-}" in
    "") ;;
    --rollback) mode="rollback" ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  [[ $# -le 1 ]] || { usage >&2; exit 2; }

  require_root
  require_installed
  trap on_exit EXIT

  if [[ "$mode" == "rollback" ]]; then
    rollback
  else
    local src
    src="$(cd "$SCRIPT_DIR/.." && pwd -P)"
    validate_source "$src"
    deploy_from "$src"
  fi
  log "Status: systemctl status ai-office --no-pager | Log: journalctl -u ai-office -f"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
