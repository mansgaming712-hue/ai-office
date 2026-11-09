#!/usr/bin/env bash
# Ganti AI_OFFICE_TOKEN di VPS dengan token acak baru, lalu restart AI Office.
#
# Pemakaian (di VPS):  sudo bash /opt/ai-office/current/deploy/rotate-token.sh
#
# - Hanya baris AI_OFFICE_TOKEN di /etc/ai-office/ai-office.env yang diubah.
# - Token lama langsung tidak berlaku. Cookie sesi diturunkan dari token, jadi SEMUA sesi browser
#   (termasuk di laptop yang hilang) ikut tercabut dan harus login ulang. File token hooks di
#   komputer CEO (~/.ai-office/token) harus diisi token baru.
# - Kalau app gagal start dengan token baru, file env lama dipulihkan otomatis.
# - Token baru ditampilkan SEKALI di akhir, hanya ke terminal. Jangan menjalankan skrip ini dengan
#   `| tee`, `script`, atau perekam terminal, dan jangan menyalin output ke log atau chat.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$SCRIPT_DIR/lib.sh"

BACKUP=""

cleanup() {
  # Salinan berisi token lama: selalu dihapus.
  if [[ -n "$BACKUP" && -f "$BACKUP" ]]; then rm -f -- "$BACKUP"; fi
}

main() {
  if [[ $# -gt 0 ]]; then
    echo "Pemakaian: sudo bash $0   (tanpa argumen; token TIDAK boleh diketik di baris perintah)" >&2
    exit 2
  fi
  require_root
  [[ -f "$ENV_FILE" ]] || die "$ENV_FILE belum ada. Jalankan deploy/setup-vps.sh dulu."
  require_cmd systemctl curl

  local token host
  host="$(primary_domain)"
  token="$(generate_token)"
  [[ ${#token} -ge $TOKEN_MIN_LEN ]] || die "Gagal membuat token acak."

  trap cleanup EXIT
  BACKUP="$(mktemp "$ENV_DIR/.ai-office.env.bak.XXXXXX")"
  cp -p -- "$ENV_FILE" "$BACKUP"

  log "Menulis token baru ke $ENV_FILE"
  env_set_key "$ENV_FILE" AI_OFFICE_TOKEN "$token"
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"

  log "Restart ai-office"
  restart_app
  if ! app_health "$host" 30; then
    err "App tidak sehat dengan token baru. Log terakhir:"
    show_app_logs 30
    warn "Memulihkan file env lama dan restart."
    cp -p -- "$BACKUP" "$ENV_FILE"
    restart_app
    die "Rotasi dibatalkan. Token lama masih berlaku."
  fi
  ok "Token baru aktif. Token lama dan semua sesi browser sudah tidak berlaku."

  show_token_once "$token"
  cat <<EOF
Langkah berikutnya:
  1. Di komputer CEO, tulis token baru ke file token hooks (~/.ai-office/token) dengan langkah
     di docs/DEPLOY.md bagian 5, lalu buka ulang sesi Claude Code.
  2. Di browser, buka https://${host} dan login dengan token baru (semua perangkat).
EOF
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
