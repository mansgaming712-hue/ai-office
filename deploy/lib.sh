# shellcheck shell=bash
# Fungsi dan konstanta bersama untuk skrip deploy AI Office.
# Di-source oleh setup-vps.sh, update.sh, dan rotate-token.sh.
# File ini TIDAK menjalankan apa pun saat di-source: hanya mendefinisikan konstanta dan fungsi.

# ---------------------------------------------------------------------------
# Konstanta (harus sama dengan deploy/systemd/ai-office.service dan deploy/nginx/ai-office.conf)
# ---------------------------------------------------------------------------
# shellcheck disable=SC2034  # sebagian konstanta hanya dipakai oleh skrip yang men-source file ini
APP_USER="aioffice"
APP_ROOT="/opt/ai-office"
RELEASES_DIR="/opt/ai-office/releases"
CURRENT_LINK="/opt/ai-office/current"
APP_HOME="/var/lib/ai-office"              # home user sistem (cache npm saat build)
APP_PORT="3000"                            # HOST=127.0.0.1 PORT=3000 diatur di file service
ENV_DIR="/etc/ai-office"
ENV_FILE="/etc/ai-office/ai-office.env"
SERVICE_NAME="ai-office.service"
UNIT_PATH="/etc/systemd/system/ai-office.service"
NGINX_SITE="/etc/nginx/sites-available/ai-office.conf"
NGINX_ENABLED="/etc/nginx/sites-enabled/ai-office.conf"
ACME_ROOT="/var/www/certbot"
NODE_BIN="/usr/bin/node"
NODE_MIN_MAJOR=22
TOKEN_MIN_LEN=32
KEEP_RELEASES="${KEEP_RELEASES:-3}"

# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------
if [[ -t 1 ]]; then
  _C_BLUE=$'\033[1;34m' _C_GREEN=$'\033[1;32m' _C_YELLOW=$'\033[1;33m' _C_RED=$'\033[1;31m' _C_OFF=$'\033[0m'
else
  _C_BLUE='' _C_GREEN='' _C_YELLOW='' _C_RED='' _C_OFF=''
fi

log()  { printf '%s==>%s %s\n' "$_C_BLUE" "$_C_OFF" "$*"; }
ok()   { printf '%s OK%s %s\n' "$_C_GREEN" "$_C_OFF" "$*"; }
warn() { printf '%sPERINGATAN:%s %s\n' "$_C_YELLOW" "$_C_OFF" "$*" >&2; }
err()  { printf '%sGAGAL:%s %s\n' "$_C_RED" "$_C_OFF" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ---------------------------------------------------------------------------
# Pemeriksaan dasar
# ---------------------------------------------------------------------------
require_root() {
  [[ "${EUID:-$(id -u)}" -eq 0 ]] || die "Skrip ini harus dijalankan sebagai root. Contoh: sudo bash $0 ..."
}

require_cmd() {
  local c
  for c in "$@"; do
    command -v "$c" >/dev/null 2>&1 || die "Perintah '$c' tidak ditemukan. Jalankan deploy/setup-vps.sh dulu."
  done
}

to_lower() { printf '%s' "${1,,}"; }

# Domain: huruf kecil, angka, titik, tanda hubung. Juga mencegah karakter aneh masuk ke sed/nginx.
valid_domain() {
  local d="$1"
  [[ ${#d} -ge 4 && ${#d} -le 253 ]] || return 1
  [[ "$d" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])$ ]]
}

valid_email() {
  [[ "$1" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]
}

# ---------------------------------------------------------------------------
# File env (format systemd EnvironmentFile: KEY=value per baris, # untuk komentar)
# ---------------------------------------------------------------------------

# read_env_value FILE KEY -> nilai terakhir KEY (tanpa kutip/spasi), kosong bila tidak ada.
read_env_value() {
  local file="$1" key="$2" line val
  line="$(grep -E "^[[:space:]]*${key}=" "$file" 2>/dev/null | tail -n 1)" || true
  [[ -n "$line" ]] || return 0
  val="${line#*=}"
  val="${val%$'\r'}"
  val="${val#"${val%%[![:space:]]*}"}"
  val="${val%"${val##*[![:space:]]}"}"
  if [[ "$val" =~ ^\"(.*)\"$ ]] || [[ "$val" =~ ^\'(.*)\'$ ]]; then
    val="${BASH_REMATCH[1]}"
  fi
  printf '%s' "$val"
}

# env_set_key FILE KEY VALUE -> ganti (atau tambahkan) satu baris KEY=VALUE secara atomik.
# Nilai dikirim lewat variabel lingkungan, bukan argumen, supaya token tidak terlihat di `ps`.
env_set_key() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "$(dirname "$file")/.ai-office.env.XXXXXX")"
  chmod 600 "$tmp"
  ENV_KEY="$key" ENV_VALUE="$value" awk '
    BEGIN { k = ENVIRON["ENV_KEY"]; v = ENVIRON["ENV_VALUE"]; done = 0 }
    $0 ~ ("^[[:space:]]*" k "=") { if (!done) { print k "=" v; done = 1 } ; next }
    { print }
    END { if (!done) print k "=" v }
  ' "$file" >"$tmp" || { rm -f -- "$tmp"; return 1; }
  chown root:root "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$file"
}

# Token acak 256 bit, base64url tanpa padding (43 karakter: A-Z a-z 0-9 - _).
# Aman ditaruh di file env, header Authorization, JSON, dan form login tanpa perlu kutip.
generate_token() {
  local t
  if command -v openssl >/dev/null 2>&1; then
    t="$(openssl rand -base64 32 | tr -d '\r\n=' | tr '+/' '-_')"
  else
    t="$(head -c 32 /dev/urandom | base64 | tr -d '\r\n=' | tr '+/' '-_')"
  fi
  # Hanya karakter base64url yang boleh lolos; selain itu dianggap gagal (token kosong).
  [[ "$t" =~ ^[A-Za-z0-9_-]+$ ]] || t=""
  printf '%s' "$t"
}

# Domain utama = entri pertama AI_OFFICE_ALLOWED_HOSTS (dipakai sebagai header Host saat cek kesehatan).
primary_domain() {
  local hosts
  hosts="$(read_env_value "$ENV_FILE" AI_OFFICE_ALLOWED_HOSTS)"
  hosts="${hosts%%,*}"
  hosts="${hosts//[[:space:]]/}"
  printf '%s' "${hosts:-localhost}"
}

_token_box() {
  cat <<EOF

=====================================================================
 TOKEN AI OFFICE (RAHASIA) - DITAMPILKAN SEKALI SAJA
=====================================================================

 $1

---------------------------------------------------------------------
 SIMPAN SEKARANG di pengelola kata sandi (password manager).
 Token ini dipakai untuk:
   1. login di https://<domain> (browser)
   2. file token hooks di komputer CEO (~/.ai-office/token, dibaca
      lewat AI_OFFICE_TOKEN_FILE; lihat docs/DEPLOY.md bagian 5)
 Jangan kirim lewat chat/email, jangan di-screenshot, jangan commit.
 Jangan merekam terminal ini (tee, script, asciinema, rekam layar).
 Lupa?  sudo grep AI_OFFICE_TOKEN ${ENV_FILE}
 Ganti: sudo bash ${CURRENT_LINK}/deploy/rotate-token.sh
=====================================================================

EOF
}

# show_token_once TOKEN -> tampilkan token HANYA ke terminal.
# Kalau stdout dialihkan (mis. `| tee setup.log` atau `> out.txt`), token ditulis langsung ke
# /dev/tty supaya tidak ikut tersimpan di file itu. Tanpa terminal sama sekali (ssh tanpa -t,
# cron), token tidak ditampilkan; root tetap bisa membacanya dari file env.
# Catatan: perekam terminal (`script`, asciinema) tetap menangkap /dev/tty. Jangan dipakai.
show_token_once() {
  if [[ -t 1 ]]; then
    _token_box "$1"
  elif { : >/dev/tty; } 2>/dev/null; then
    warn "Output skrip ini dialihkan (tee/redirect). Token ditampilkan di terminal saja, tidak ikut ke output itu."
    _token_box "$1" >/dev/tty
  else
    warn "Tidak ada terminal: token TIDAK ditampilkan supaya tidak tercatat di log."
    warn "Lihat dari sesi SSH interaktif: sudo grep AI_OFFICE_TOKEN ${ENV_FILE}"
  fi
}

# ---------------------------------------------------------------------------
# Aplikasi (systemd + cek kesehatan)
# ---------------------------------------------------------------------------
restart_app() {
  systemctl reset-failed "$SERVICE_NAME" >/dev/null 2>&1 || true
  systemctl restart "$SERVICE_NAME"
}

show_app_logs() {
  journalctl -u "$SERVICE_NAME" -n "${1:-40}" --no-pager 2>/dev/null || true
}

# Kirim header yang sama seperti Nginx, langsung ke 127.0.0.1:3000.
_app_curl() {
  local host="$1" path="$2"
  shift 2
  curl -s --max-time 5 \
    -H "Host: ${host}" -H "X-Forwarded-Proto: https" -H "X-Real-IP: 127.0.0.1" \
    "$@" "http://127.0.0.1:${APP_PORT}${path}"
}

# app_health HOST [PERCOBAAN] -> 0 bila GET /api/health menjawab 2xx.
app_health() {
  local host="$1" tries="${2:-20}" i
  for ((i = 0; i < tries; i++)); do
    if systemctl is-active --quiet "$SERVICE_NAME" \
      && _app_curl "$host" /api/health -f -o /dev/null 2>/dev/null; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# app_events_protected HOST -> 0 bila GET /api/events tanpa token DITOLAK (401/403).
# Mencegah versi tanpa autentikasi terbuka ke internet.
app_events_protected() {
  local code
  code="$(_app_curl "$1" /api/events -o /dev/null -w '%{http_code}' 2>/dev/null)" || true
  [[ "$code" == "401" || "$code" == "403" ]]
}

# ---------------------------------------------------------------------------
# Rilis (/opt/ai-office/releases/<waktu UTC>, /opt/ai-office/current -> rilis aktif)
# ---------------------------------------------------------------------------
valid_release_name() { [[ "$1" =~ ^[0-9]{8}-[0-9]{6}$ ]]; }

# Daftar nama rilis, urut dari yang terlama.
list_releases() {
  [[ -d "$RELEASES_DIR" ]] || return 0
  local d name
  for d in "$RELEASES_DIR"/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    valid_release_name "$name" && printf '%s\n' "$name"
  done | sort
}

# Path absolut rilis aktif, kosong bila belum ada.
current_release() {
  [[ -L "$CURRENT_LINK" ]] || return 0
  readlink -f "$CURRENT_LINK" || true
}

# Ganti symlink current secara atomik.
switch_current() {
  local target="$1"
  [[ -d "$target" ]] || die "Rilis $target tidak ada."
  if [[ -e "$CURRENT_LINK" && ! -L "$CURRENT_LINK" ]]; then
    die "$CURRENT_LINK ada tapi bukan symlink. Pindahkan manual dulu (jangan salin kode langsung ke sana)."
  fi
  ln -sfn "$target" "${CURRENT_LINK}.tmp"
  mv -Tf "${CURRENT_LINK}.tmp" "$CURRENT_LINK"
}

# Hapus satu folder rilis, hanya bila path-nya benar-benar di dalam RELEASES_DIR.
remove_release_dir() {
  local dir="$1" name
  name="$(basename "$dir")"
  if [[ "$dir" == "$RELEASES_DIR/$name" ]] && valid_release_name "$name" && [[ -d "$dir" ]]; then
    rm -rf -- "$dir"
  fi
}
