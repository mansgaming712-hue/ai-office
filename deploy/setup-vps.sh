#!/usr/bin/env bash
# Pasang AI Office di VPS Ubuntu 22.04/24.04 yang masih baru.
#
# Pemakaian (di VPS, dari folder kode yang sudah disalin, mis. ~/ai-office):
#   sudo bash deploy/setup-vps.sh DOMAIN EMAIL
#   contoh: sudo bash deploy/setup-vps.sh office.example.com ceo@example.com
#
# Aman dijalankan ulang (idempoten). Yang dilakukan:
#   1. Paket sistem: nginx, certbot, ufw, rsync, curl, openssl, unattended-upgrades.
#   2. Pembaruan keamanan otomatis Ubuntu (unattended-upgrades) dipastikan aktif. Tanpa reboot otomatis.
#   3. Node.js LTS (default 24, minimal 22) dari repo resmi NodeSource, bila belum ada.
#      Fingerprint kunci GPG NodeSource dicek dulu; kalau beda, setup berhenti.
#   4. Firewall UFW: hanya port 22 (dibatasi laju, "ufw limit"), 80, 443 yang terbuka.
#      sshd_config TIDAK diubah (pengerasan SSH manual: docs/DEPLOY.md bagian 11).
#   5. User sistem "aioffice" (tanpa login) dan folder /opt/ai-office.
#   6. /etc/ai-office/ai-office.env (600, root). Token acak dibuat HANYA bila file belum ada;
#      file yang sudah ada tidak ditimpa (hanya AI_OFFICE_ALLOWED_HOSTS/TRUST_PROXY dilengkapi).
#   7. Service systemd ai-office (127.0.0.1:3000, restart otomatis, hardening, batas memori).
#   8. Build dan jalankan app lewat deploy/update.sh.
#   9. Nginx + sertifikat Let's Encrypt (webroot) + perpanjangan otomatis, HTTP -> HTTPS,
#      batas laju, dan penolakan Host tak dikenal.
#  10. Pemeriksaan akhir, lalu token baru (bila ada) ditampilkan SEKALI, hanya ke terminal.
#
# JANGAN menjalankan skrip ini dengan `| tee`, `script`, atau perekam terminal: token tampil di akhir.
#
# Variabel opsional:
#   NODE_MAJOR=24        versi mayor Node.js dari NodeSource (minimal 22)
#   SKIP_DNS_CHECK=1     lewati cek "domain sudah mengarah ke VPS ini" sebelum certbot
#   NODESOURCE_GPG_FPR=  fingerprint kunci NodeSource yang diharapkan (40 heksa). Hanya diisi bila
#                        NodeSource resmi mengganti kuncinya dan fingerprint baru sudah diverifikasi
#                        manual (docs/DEPLOY.md bagian 3).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
# shellcheck source=deploy/lib.sh
source "$SCRIPT_DIR/lib.sh"

NODE_MAJOR="${NODE_MAJOR:-24}"
# Fingerprint kunci utama repo apt NodeSource (deb.nodesource.com/gpgkey/nodesource-repo.gpg.key,
# kunci repo "nodistro"; RSA 2048, dibuat 2016-05-23, key ID 2F59B5F99B1BE0B4). Diperiksa
# 2026-11-08 terhadap kunci yang disajikan NodeSource. Cara cek manual: docs/DEPLOY.md bagian 3.
NODESOURCE_GPG_FPR_DEFAULT="6F71F525282841EEDAF851B42F59B5F99B1BE0B4"
NODESOURCE_KEY_URL="https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key"
DOMAIN=""
EMAIL=""
NEW_TOKEN=""
TOKEN_SHOWN=0
STEP=0
TOTAL_STEPS=10

usage() {
  cat <<EOF
Pemakaian: sudo bash deploy/setup-vps.sh DOMAIN EMAIL
  DOMAIN  domain/subdomain yang A record-nya sudah mengarah ke IP VPS ini, mis. office.example.com
  EMAIL   email untuk akun Let's Encrypt, mis. ceo@example.com
EOF
}

step() {
  STEP=$((STEP + 1))
  printf '\n'
  log "[$STEP/$TOTAL_STEPS] $*"
}

on_exit() {
  local rc=$?
  # Token baru harus selalu terlihat sekali, walau setup berhenti di tengah jalan.
  if [[ -n "$NEW_TOKEN" && "$TOKEN_SHOWN" -eq 0 ]]; then
    show_token_once "$NEW_TOKEN"
    TOKEN_SHOWN=1
  fi
  if [[ $rc -ne 0 ]]; then
    err "Setup berhenti di langkah $STEP (kode $rc). Perbaiki masalah di atas lalu jalankan ulang perintah yang sama; token yang sudah dibuat tidak akan diganti."
  fi
}

# ---------------------------------------------------------------------------
preflight() {
  require_root

  local os_id os_version arch
  [[ -r /etc/os-release ]] || die "/etc/os-release tidak ada. Skrip ini khusus Ubuntu 22.04/24.04."
  os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
  os_version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  [[ "$os_id" == "ubuntu" ]] || die "Skrip ini khusus Ubuntu 22.04/24.04 (terdeteksi: ${os_id:-tidak diketahui})."
  case "$os_version" in
    22.04|24.04) ;;
    *) warn "Diuji untuk Ubuntu 22.04/24.04; terdeteksi $os_version. Lanjut dengan hati-hati." ;;
  esac
  [[ -d /run/systemd/system ]] || die "systemd tidak aktif (container tanpa systemd?). Gunakan VPS KVM biasa."
  arch="$(dpkg --print-architecture)"
  case "$arch" in
    amd64|arm64) ;;
    *) die "Arsitektur $arch tidak didukung NodeSource. Gunakan VPS amd64 atau arm64." ;;
  esac

  [[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge "$NODE_MIN_MAJOR" ]] \
    || die "NODE_MAJOR=$NODE_MAJOR tidak valid (minimal $NODE_MIN_MAJOR)."

  valid_domain "$DOMAIN" || die "Domain '$DOMAIN' tidak valid. Tulis tanpa https:// dan tanpa garis miring, mis. office.example.com"
  case "$DOMAIN" in
    example.com|*.example.com|example.org|*.example.org|example.net|*.example.net)
      die "'$DOMAIN' adalah domain contoh. Ganti dengan domain asli milik Anda." ;;
  esac
  valid_email "$EMAIL" || die "Email '$EMAIL' tidak valid."

  local f
  for f in package.json package-lock.json server/index.js deploy/lib.sh deploy/update.sh \
    deploy/systemd/ai-office.service deploy/nginx/ai-office.conf deploy/nginx/ai-office-http-only.conf; do
    [[ -f "$SRC_DIR/$f" ]] || die "File $f tidak ada di $SRC_DIR. Jalankan dari folder kode AI Office yang sudah disalin."
  done
  case "$SRC_DIR/" in
    "$APP_ROOT"/*) die "Jangan menyalin kode langsung ke $APP_ROOT. Salin ke folder lain (mis. ~/ai-office) lalu jalankan dari sana." ;;
  esac

  ok "Ubuntu $os_version ($arch), domain $DOMAIN, sumber kode $SRC_DIR"
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    ca-certificates curl gnupg openssl rsync nginx certbot ufw iproute2 unattended-upgrades
  ok "Paket sistem terpasang."
}

# Nilai efektif satu opsi apt (setelah semua file /etc/apt/apt.conf.d/* digabung), tanpa kutip.
apt_config_value() {
  apt-config dump 2>/dev/null \
    | awk -v k="$1" '$1 == k { v = $2 } END { gsub(/[";]/, "", v); print v }'
}

auto_updates_enabled() {
  local lists upgrade
  lists="$(apt_config_value APT::Periodic::Update-Package-Lists)"
  upgrade="$(apt_config_value APT::Periodic::Unattended-Upgrade)"
  [[ "$lists" =~ ^[1-9][0-9]*$ && "$upgrade" =~ ^[1-9][0-9]*$ ]]
}

# Pembaruan keamanan Ubuntu dipasang otomatis tiap hari (hanya dari arsip security, pengaturan
# bawaan /etc/apt/apt.conf.d/50unattended-upgrades). Reboot TIDAK otomatis.
setup_auto_updates() {
  local conf=/etc/apt/apt.conf.d/20auto-upgrades
  local override=/etc/apt/apt.conf.d/52ai-office-auto-upgrades
  if ! auto_updates_enabled; then
    if [[ ! -f "$conf" ]]; then
      # Isi yang sama dengan `dpkg-reconfigure -plow unattended-upgrades` (jawab "Yes").
      printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";' >"$conf"
      chmod 644 "$conf"
      log "$conf dibuat."
    fi
    if ! auto_updates_enabled; then
      # Ada file lain yang mematikannya. File ini dibaca belakangan sehingga nilainya menang;
      # file milik admin tidak diubah.
      {
        printf '%s\n' '// Dipasang oleh AI Office deploy/setup-vps.sh: pastikan pembaruan keamanan otomatis aktif.'
        printf '%s\n' 'APT::Periodic::Update-Package-Lists "1";' 'APT::Periodic::Unattended-Upgrade "1";'
      } >"$override"
      chmod 644 "$override"
      warn "Pembaruan otomatis sebelumnya dimatikan oleh konfigurasi lain; diaktifkan lewat $override."
    fi
  fi
  auto_updates_enabled || die "unattended-upgrades tetap tidak aktif. Cek: apt-config dump | grep -i periodic"
  systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 \
    || warn "Timer apt-daily tidak bisa diaktifkan. Cek: systemctl list-timers | grep apt"
  ok "Pembaruan keamanan otomatis aktif (unattended-upgrades). Reboot tidak otomatis: cek /var/run/reboot-required."
}

node_major() {
  "$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || printf '0'
}

# Unduh kunci repo NodeSource, pastikan berisi tepat SATU kunci utama dengan fingerprint yang
# diharapkan, baru pasang file yang SAMA (bukan unduhan ulang) ke /etc/apt/keyrings.
# Kunci tidak diimpor ke keyring root: gpg memakai GNUPGHOME sementara.
install_nodesource_key() {
  local expected="${NODESOURCE_GPG_FPR:-$NODESOURCE_GPG_FPR_DEFAULT}" work got
  expected="${expected//[[:space:]]/}"
  expected="${expected^^}"
  [[ "$expected" =~ ^[0-9A-F]{40}$ ]] || die "NODESOURCE_GPG_FPR harus 40 karakter heksadesimal (sekarang: '$expected')."
  if [[ "$expected" != "$NODESOURCE_GPG_FPR_DEFAULT" ]]; then
    warn "Memakai NODESOURCE_GPG_FPR dari lingkungan ($expected), bukan nilai bawaan kit ($NODESOURCE_GPG_FPR_DEFAULT)."
  fi

  work="$(mktemp -d)"
  install -d -m 700 "$work/gnupg"
  if ! curl -fsSL --max-time 30 -o "$work/key.asc" "$NODESOURCE_KEY_URL"; then
    rm -rf -- "$work"
    die "Gagal mengunduh kunci NodeSource dari $NODESOURCE_KEY_URL."
  fi
  # Baris "fpr" tepat setelah "pub" = fingerprint kunci utama (baris "fpr" setelah "sub" diabaikan).
  got="$(GNUPGHOME="$work/gnupg" gpg --batch --quiet --show-keys --with-colons "$work/key.asc" 2>/dev/null \
    | awk -F: '$1 == "pub" { want = 1; next } $1 == "fpr" && want { print $10; want = 0 }')" || true
  if [[ "$got" != "$expected" ]]; then
    rm -rf -- "$work"
    err "Fingerprint kunci NodeSource TIDAK cocok. Node.js tidak dipasang."
    err "  diharapkan : $expected"
    err "  didapat    : ${got:-<tidak terbaca>}"
    die "Jangan lanjut sebelum diverifikasi manual (docs/DEPLOY.md bagian 3). Bisa jadi NodeSource mengganti kunci, atau unduhan dimanipulasi."
  fi
  ok "Kunci NodeSource terverifikasi: $(sed -E 's/(.{4})/\1 /g; s/ $//' <<<"$got")"

  install -d -m 755 /etc/apt/keyrings
  GNUPGHOME="$work/gnupg" gpg --batch --quiet --yes --dearmor -o "$work/nodesource.gpg" "$work/key.asc"
  install -m 644 -o root -g root "$work/nodesource.gpg" /etc/apt/keyrings/nodesource.gpg
  rm -rf -- "$work"
}

install_node() {
  if [[ -x "$NODE_BIN" && "$(node_major)" -ge "$NODE_MIN_MAJOR" ]]; then
    ok "Node.js $("$NODE_BIN" --version) sudah ada, tidak diubah."
    return 0
  fi
  log "Memasang Node.js ${NODE_MAJOR}.x dari NodeSource (repo apt bertanda tangan)."
  install_nodesource_key
  printf 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_%s.x nodistro main\n' \
    "$NODE_MAJOR" >/etc/apt/sources.list.d/nodesource.list
  # Utamakan paket nodejs dari NodeSource dibanding versi lama bawaan Ubuntu.
  cat >/etc/apt/preferences.d/nodesource <<'EOF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
  apt-get update -y
  apt-get install -y nodejs
  [[ -x "$NODE_BIN" && "$(node_major)" -ge "$NODE_MIN_MAJOR" ]] \
    || die "Node.js >= $NODE_MIN_MAJOR tidak terpasang di $NODE_BIN."
  ok "Node.js $("$NODE_BIN" --version), npm $(npm --version)"
}

setup_firewall() {
  # Jangan sampai SSH terkunci: kalau sshd tidak memakai port 22, UFW tidak diaktifkan.
  local ports
  ports="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2 }' | sort -u | tr '\n' ' ')" || true
  ports="${ports% }"
  if [[ -n "$ports" && "$ports" != "22" ]]; then
    warn "SSH memakai port '$ports', bukan 22. UFW TIDAK diaktifkan supaya akses SSH tidak terkunci."
    warn "Atur manual: ufw limit <port-ssh>/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw enable"
    return 0
  fi
  # SSH memakai "limit", bukan "allow": tetap diizinkan, tetapi IP yang membuka 6 koneksi baru atau
  # lebih dalam 30 detik ditolak sementara (memperlambat tebak kata sandi). Koneksi yang sudah
  # tersambung tidak terpengaruh, dan blokir hilang sendiri setelah 30 detik tanpa percobaan baru.
  # Aturan ini dibuat SEBELUM UFW diaktifkan, jadi sesi SSH yang menjalankan skrip ini tidak terputus.
  # Kalau dulu sudah ada "allow 22/tcp" (setup versi lama), ufw mengubahnya menjadi limit.
  ufw limit 22/tcp comment 'SSH (dibatasi laju)'
  ufw allow 80/tcp comment 'HTTP (redirect + Lets Encrypt)'
  ufw allow 443/tcp comment 'HTTPS'
  ufw default deny incoming
  ufw default allow outgoing
  ufw --force enable
  ufw status verbose

  local status ssh_allow extra
  status="$(ufw status)" || true
  # Aturan ALLOW lain untuk SSH (mis. "OpenSSH" bawaan image VPS) membuat batas laju tidak berlaku.
  # Tidak dihapus otomatis (risiko terkunci); cukup diberi tahu.
  ssh_allow="$(awk 'NR > 4 && ($1 == "22" || $1 == "22/tcp" || $1 == "OpenSSH") && $0 ~ /ALLOW/' <<<"$status")"
  if [[ -n "$ssh_allow" ]]; then
    warn "Masih ada aturan ALLOW untuk SSH, sehingga batas laju 22/tcp tidak berlaku:"
    printf '%s\n' "$ssh_allow" >&2
    warn "Setelah memastikan baris '22/tcp LIMIT' ada di 'sudo ufw status', hapus manual, mis.: sudo ufw delete allow OpenSSH"
  fi
  extra="$(awk 'NR > 4 && $1 !~ /^(22|80|443)(\/tcp)?$/ && $1 != "OpenSSH" && $0 ~ /ALLOW/' <<<"$status")"
  if [[ -n "$extra" ]]; then
    warn "Ada aturan UFW lain selain 22/80/443 (dibiarkan, tidak dihapus):"
    printf '%s\n' "$extra" >&2
  fi
  ok "Firewall aktif: 22 (limit), 80, 443."
}

create_user_and_dirs() {
  if id -u "$APP_USER" >/dev/null 2>&1; then
    ok "User $APP_USER sudah ada."
  else
    useradd --system --user-group --home-dir "$APP_HOME" --create-home --shell /usr/sbin/nologin "$APP_USER"
    ok "User sistem $APP_USER dibuat (tanpa login)."
  fi
  install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$APP_HOME"
  install -d -m 755 -o root -g root "$APP_ROOT" "$RELEASES_DIR"
}

create_env_file() {
  install -d -m 700 -o root -g root "$ENV_DIR"

  if [[ -f "$ENV_FILE" ]]; then
    chown root:root "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    local token hosts trust
    token="$(read_env_value "$ENV_FILE" AI_OFFICE_TOKEN)"
    if [[ ${#token} -lt $TOKEN_MIN_LEN ]]; then
      die "AI_OFFICE_TOKEN di $ENV_FILE kosong atau kurang dari $TOKEN_MIN_LEN karakter. Buat token baru: sudo bash $SCRIPT_DIR/rotate-token.sh"
    fi
    hosts="$(read_env_value "$ENV_FILE" AI_OFFICE_ALLOWED_HOSTS)"
    if [[ ",${hosts//[[:space:]]/}," != *",$DOMAIN,"* ]]; then
      env_set_key "$ENV_FILE" AI_OFFICE_ALLOWED_HOSTS "${hosts:+${hosts//[[:space:]]/},}$DOMAIN"
      warn "AI_OFFICE_ALLOWED_HOSTS dilengkapi dengan $DOMAIN."
    fi
    trust="$(read_env_value "$ENV_FILE" AI_OFFICE_TRUST_PROXY)"
    if [[ "$trust" != "1" ]]; then
      env_set_key "$ENV_FILE" AI_OFFICE_TRUST_PROXY 1
      warn "AI_OFFICE_TRUST_PROXY diset ke 1 (app berada di belakang Nginx)."
    fi
    ok "$ENV_FILE sudah ada: token TIDAK diubah."
    return 0
  fi

  local token tmp
  token="$(generate_token)"
  [[ ${#token} -ge $TOKEN_MIN_LEN ]] || die "Gagal membuat token acak."
  tmp="$(mktemp "$ENV_DIR/.ai-office.env.XXXXXX")"
  chmod 600 "$tmp"
  cat >"$tmp" <<EOF
# AI Office: dibuat oleh deploy/setup-vps.sh pada $(date -u '+%Y-%m-%d %H:%M UTC').
# RAHASIA. Izin 600, milik root. Jangan disalin ke repo, chat, atau email.
# HOST=127.0.0.1 dan PORT=3000 diatur di /etc/systemd/system/ai-office.service (jangan ditaruh di sini).
# Ganti token: sudo bash /opt/ai-office/current/deploy/rotate-token.sh
# Log app hanya berisi metadata event. Opsional, sementara untuk debugging: baris
# AI_OFFICE_LOG_MESSAGES=1 ikut mencatat ISI pesan (lihat docs/DEPLOY.md bagian 9).
AI_OFFICE_TOKEN=${token}
AI_OFFICE_ALLOWED_HOSTS=${DOMAIN}
AI_OFFICE_TRUST_PROXY=1
EOF
  chown root:root "$tmp"
  mv -f -- "$tmp" "$ENV_FILE"
  NEW_TOKEN="$token"
  ok "$ENV_FILE dibuat dengan token acak baru (ditampilkan di akhir)."
}

install_service() {
  local tmp
  tmp="$(mktemp)"
  sed 's/\r$//' "$SRC_DIR/deploy/systemd/ai-office.service" >"$tmp"
  install -m 644 -o root -g root "$tmp" "$UNIT_PATH"
  rm -f -- "$tmp"
  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME" >/dev/null
  ok "Service $SERVICE_NAME terpasang dan aktif saat boot."
}

deploy_app() {
  bash "$SRC_DIR/deploy/update.sh"
}

# 0 bila Nginx terpasang mengenal ssl_reject_handshake (>= 1.19.4). Ubuntu 22.04 memakai 1.18.
nginx_supports_reject_handshake() {
  local v
  v="$(nginx -v 2>&1 | sed -n 's|^nginx version: nginx/\([0-9][0-9.]*\).*|\1|p')"
  [[ -n "$v" ]] || return 1
  [[ "$(printf '%s\n' 1.19.4 "$v" | sort -V | sed -n 1p)" == "1.19.4" ]]
}

# render_nginx SUMBER -> pasang ke NGINX_SITE dengan __DOMAIN__ diganti, uji, reload.
# Kalau `nginx -t` gagal, konfigurasi lama dipulihkan.
render_nginx() {
  local src="$1" tmp backup=""
  local -a sed_args=(-e 's/\r$//')
  if grep -Eq '^[[:space:]]*ssl_reject_handshake on;' "$src" && ! nginx_supports_reject_handshake; then
    # Nginx lama: server default 443 memakai sertifikat domain ini, lalu "return 444" tetap
    # menutup koneksi untuk Host tak dikenal (handshake TLS-nya saja yang selesai).
    warn "Nginx $(nginx -v 2>&1 | sed -n 's|^nginx version: nginx/||p') belum mendukung ssl_reject_handshake; server default 443 memakai sertifikat domain + return 444."
    sed_args+=(-e 's|^\([[:space:]]*\)ssl_reject_handshake on;.*$|\1ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;\n\1ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;|')
  fi
  sed_args+=(-e "s/__DOMAIN__/${DOMAIN}/g")
  tmp="$(mktemp)"
  sed "${sed_args[@]}" "$src" >"$tmp"
  if grep -q '__DOMAIN__' "$tmp"; then
    rm -f -- "$tmp"
    die "Template $src masih berisi __DOMAIN__ setelah diganti."
  fi
  if [[ -f "$NGINX_SITE" ]]; then
    backup="$(mktemp)"
    cp -p -- "$NGINX_SITE" "$backup"
  fi
  install -m 644 -o root -g root "$tmp" "$NGINX_SITE"
  rm -f -- "$tmp"
  ln -sfn "$NGINX_SITE" "$NGINX_ENABLED"
  if ! nginx -t; then
    if [[ -n "$backup" ]]; then
      cp -p -- "$backup" "$NGINX_SITE"
      rm -f -- "$backup"
    else
      rm -f -- "$NGINX_ENABLED"
    fi
    err "nginx -t gagal untuk $src. Konfigurasi sebelumnya dipulihkan."
    err "Kalau pesannya 'duplicate default server': situs lain di /etc/nginx/sites-enabled atau"
    err "/etc/nginx/conf.d juga memakai default_server. Nonaktifkan situs itu, lalu ulangi setup."
    exit 1
  fi
  [[ -z "$backup" ]] || rm -f -- "$backup"
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl reload-or-restart nginx
}

# Pastikan http://DOMAIN/.well-known/acme-challenge/ sampai ke Nginx VPS ini sebelum certbot,
# supaya kesalahan DNS tidak menghabiskan batas percobaan Let's Encrypt.
check_domain_points_here() {
  local name file body
  if [[ "${SKIP_DNS_CHECK:-0}" == "1" ]]; then
    warn "SKIP_DNS_CHECK=1: cek DNS dilewati."
    return 0
  fi
  name="aioffice-check-$(openssl rand -hex 8 | tr -d '\r\n')"
  file="$ACME_ROOT/.well-known/acme-challenge/$name"
  install -d -m 755 "$ACME_ROOT/.well-known/acme-challenge"
  printf '%s' "$name" >"$file"
  chmod 644 "$file"
  body="$(curl -fsS --max-time 10 "http://$DOMAIN/.well-known/acme-challenge/$name" 2>/dev/null)" || true
  rm -f -- "$file"
  if [[ "$body" == "$name" ]]; then
    ok "http://$DOMAIN sampai ke VPS ini."
    return 0
  fi
  err "http://$DOMAIN belum sampai ke VPS ini."
  err "  IP domain menurut DNS : $(getent ahostsv4 "$DOMAIN" | awk '{ print $1 }' | sort -u | tr '\n' ' ')"
  err "  IP lokal VPS          : $(hostname -I 2>/dev/null)"
  err "Pastikan A record $DOMAIN mengarah ke IP publik VPS dan port 80 terbuka (juga firewall di panel penyedia VPS)."
  err "Perubahan DNS bisa butuh beberapa menit sampai beberapa jam. Kalau yakin sudah benar, ulangi dengan SKIP_DNS_CHECK=1."
  exit 1
}

setup_nginx_tls() {
  install -d -m 755 "$ACME_ROOT"
  # Situs bawaan Ubuntu ("Welcome to nginx") dimatikan; file aslinya di sites-available tetap ada.
  if [[ -L /etc/nginx/sites-enabled/default ]]; then
    rm -f -- /etc/nginx/sites-enabled/default
    log "Situs default Nginx dinonaktifkan."
  fi

  local cert="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
  if [[ -s "$cert" ]]; then
    ok "Sertifikat untuk $DOMAIN sudah ada; perpanjangan diurus certbot.timer."
  else
    log "Konfigurasi HTTP sementara untuk validasi Let's Encrypt."
    render_nginx "$SRC_DIR/deploy/nginx/ai-office-http-only.conf"
    check_domain_points_here
    log "Meminta sertifikat Let's Encrypt untuk $DOMAIN"
    certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" \
      --email "$EMAIL" --agree-tos --no-eff-email --non-interactive --keep-until-expiring
    [[ -s "$cert" ]] || die "Sertifikat tidak ditemukan di $cert setelah certbot."
    ok "Sertifikat terbit."
  fi

  # Setelah perpanjangan otomatis, Nginx perlu reload supaya memakai sertifikat baru.
  install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  cat >/etc/letsencrypt/renewal-hooks/deploy/ai-office-reload-nginx.sh <<'EOF'
#!/bin/sh
# Dipasang oleh AI Office deploy/setup-vps.sh: muat ulang Nginx setelah sertifikat diperpanjang.
systemctl reload nginx
EOF
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/ai-office-reload-nginx.sh
  systemctl enable --now certbot.timer >/dev/null 2>&1 \
    || warn "certbot.timer tidak ditemukan; cek perpanjangan otomatis: systemctl list-timers | grep certbot"

  log "Konfigurasi HTTPS penuh."
  render_nginx "$SRC_DIR/deploy/nginx/ai-office.conf"
  ok "Nginx aktif untuk https://$DOMAIN"
}

final_checks() {
  local code failed=0
  local -a here=(--resolve "$DOMAIN:443:127.0.0.1" --resolve "$DOMAIN:80:127.0.0.1" --max-time 10)

  if curl -fsS -o /dev/null "${here[@]}" "https://$DOMAIN/api/health"; then
    ok "https://$DOMAIN/api/health menjawab (lewat Nginx + TLS)."
  else
    err "https://$DOMAIN/api/health tidak menjawab lewat Nginx."
    failed=1
  fi

  code="$(curl -s -o /dev/null -w '%{http_code}' "${here[@]}" "https://$DOMAIN/api/events")" || true
  if [[ "$code" == "401" || "$code" == "403" ]]; then
    ok "/api/events tanpa token ditolak (HTTP $code)."
  else
    err "/api/events tanpa token menjawab HTTP $code (harus 401/403)."
    failed=1
  fi

  code="$(curl -s -o /dev/null -w '%{http_code}' "${here[@]}" "http://$DOMAIN/")" || true
  if [[ "$code" == "301" ]]; then ok "HTTP dialihkan ke HTTPS."; else warn "http://$DOMAIN/ menjawab $code (harap 301)."; fi

  # Output ditangkap dulu (bukan dipipe ke grep -q) supaya SIGPIPE + pipefail tidak membalik hasil.
  local headers listeners
  headers="$(curl -sSI "${here[@]}" "https://$DOMAIN/" 2>/dev/null)" || true
  if grep -qi '^strict-transport-security:' <<<"$headers"; then
    ok "Header HSTS ada."
  else
    warn "Header HSTS tidak terlihat."
  fi

  local api_headers
  api_headers="$(curl -sS -D - -o /dev/null "${here[@]}" "https://$DOMAIN/api/health" 2>/dev/null)" || true
  if grep -qi '^x-content-type-options: *nosniff' <<<"$api_headers" && grep -qi '^referrer-policy:' <<<"$api_headers"; then
    ok "Respons API membawa nosniff dan Referrer-Policy."
  else
    warn "Header nosniff/Referrer-Policy tidak terlihat di respons /api/health."
  fi

  # Host/SNI tak dikenal: Nginx menutup koneksi tanpa jawaban (curl melihat kode 000).
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H 'Host: host-tak-dikenal.invalid' http://127.0.0.1/)" || true
  if [[ "$code" == "000" ]]; then ok "Port 80: Host tak dikenal ditolak."; else warn "Port 80: Host tak dikenal menjawab HTTP $code (harap koneksi ditutup)."; fi
  code="$(curl -s -k -o /dev/null -w '%{http_code}' --max-time 10 --resolve host-tak-dikenal.invalid:443:127.0.0.1 https://host-tak-dikenal.invalid/)" || true
  if [[ "$code" == "000" ]]; then ok "Port 443: Host tak dikenal ditolak."; else warn "Port 443: Host tak dikenal menjawab HTTP $code (harap koneksi ditutup)."; fi

  listeners="$(ss -Htln 2>/dev/null | awk '{ print $4 }')" || true
  if grep -Eq "^(0\.0\.0\.0|\*|\[::\]):${APP_PORT}$" <<<"$listeners"; then
    err "Port ${APP_PORT} mendengar di semua alamat. App harus hanya di 127.0.0.1."
    failed=1
  elif grep -Eq "^127\.0\.0\.1:${APP_PORT}$" <<<"$listeners"; then
    ok "Port ${APP_PORT} hanya di 127.0.0.1."
  else
    warn "Tidak menemukan listener 127.0.0.1:${APP_PORT} di output ss."
  fi

  # Lewat DNS publik (bisa gagal di sebagian penyedia yang tidak mendukung hairpin NAT; hanya peringatan).
  if curl -fsS -o /dev/null --max-time 10 "https://$DOMAIN/api/health" 2>/dev/null; then
    ok "https://$DOMAIN terjangkau lewat DNS publik."
  else
    warn "https://$DOMAIN belum terjangkau lewat DNS publik dari VPS ini. Cek juga dari komputer Anda."
  fi

  [[ $failed -eq 0 ]] || die "Pemeriksaan akhir gagal. Lihat: journalctl -u ai-office -n 50 dan /var/log/nginx/ai-office.error.log"
}

print_summary() {
  cat <<EOF

=====================================================================
 AI Office terpasang: https://${DOMAIN}
=====================================================================
 Cek kesehatan : curl https://${DOMAIN}/api/health
 Status / log  : systemctl status ai-office   |   journalctl -u ai-office -f
 Update kode   : salin kode baru, lalu sudo bash <folder kode>/deploy/update.sh
 Rollback      : sudo bash ${CURRENT_LINK}/deploy/update.sh --rollback
 Ganti token   : sudo bash ${CURRENT_LINK}/deploy/rotate-token.sh

 Di komputer CEO:
   1. Simpan token ke file ~/.ai-office/token (hanya bisa dibaca user CEO),
      langkahnya di docs/DEPLOY.md bagian 5. Token TIDAK ditaruh di settings.
   2. Isi <folder proyek>/.claude/settings.local.json:
   {
     "env": {
       "AI_OFFICE_URL": "https://${DOMAIN}/api/events",
       "AI_OFFICE_TOKEN_FILE": "~/.ai-office/token",
       "AI_OFFICE_TIMEOUT_MS": "3000"
     }
   }
 Disarankan juga: pengerasan SSH manual (docs/DEPLOY.md bagian 11).
 Panduan lengkap: docs/DEPLOY.md
EOF
  if [[ -n "$NEW_TOKEN" ]]; then
    show_token_once "$NEW_TOKEN"
    TOKEN_SHOWN=1
  else
    printf '\n Token tidak diubah (file env sudah ada sebelumnya).\n\n'
  fi
}

main() {
  if [[ $# -ne 2 ]]; then
    usage >&2
    exit 2
  fi
  DOMAIN="$(to_lower "$1")"
  EMAIL="$2"
  trap on_exit EXIT

  step "Pemeriksaan awal";            preflight
  step "Paket sistem";                install_packages
  step "Pembaruan keamanan otomatis"; setup_auto_updates
  step "Node.js";                     install_node
  step "Firewall (UFW)";              setup_firewall
  step "User dan folder";             create_user_and_dirs
  step "File env (token)";            create_env_file
  step "Service systemd";             install_service
  step "Build dan jalankan app";      deploy_app
  step "Nginx + HTTPS (Let's Encrypt)"; setup_nginx_tls
  log "Pemeriksaan akhir"
  final_checks
  print_summary
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  main "$@"
fi
