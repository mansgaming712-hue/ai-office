*Indonesian version: [`docs/DEPLOY.md`](DEPLOY.md).*

# Deploy AI Office to a VPS (Part 4)

This guide moves the AI Office animation from `localhost:3000` onto your own server (a VPS) with an
address like `https://office.example.com`, so it can be opened from anywhere and still receive
events from Claude Code on the CEO's computer.

> **Requires the CEO's approval.** Renting a VPS, buying a domain, and running `setup-vps.sh` on the
> server are risky and/or paid steps. Do not run them before the CEO has approved the
> [Costs and decisions](#0-costs-and-ceo-decisions) section.

Throughout this guide, replace:

- `office.example.com` with your domain/subdomain,
- `203.0.113.10` with your VPS IP,
- `root` with your SSH username if it is not root (e.g. `ubuntu`, or the sudo user from section 11).

## At a glance

```
CEO's computer                             VPS (Ubuntu)
-------------                              ----------------------------------------------
Claude Code + hooks  --HTTPS + token-->    Nginx :443 (TLS Let's Encrypt, HSTS, rate limit)
Browser (login token) --HTTPS-->              |  /ws (WebSocket), /api/*, UI
                                              v
                                           Node app 127.0.0.1:3000 (user aioffice, systemd)
                                           Secret: /etc/ai-office/ai-office.env (root only)
UFW firewall: only ports 22 (SSH, rate limited), 80 (HTTP -> HTTPS), 443 (HTTPS) are open.
```

- The app can never be reached directly from the internet: it only listens on `127.0.0.1:3000`.
  All traffic goes through Nginx over HTTPS.
- Requests to the VPS IP directly or with any other domain name are closed by Nginx without a reply.
- Events (`/api/events`) and the WebSocket (`/ws`) require a token (a browser login, or the
  `Authorization: Bearer` header from the hooks). The only things open without a token are
  `/api/health` (without client/event counts), `/api/session`, `/api/login`, and `/api/logout`.
- There is no database. Event history lives only in memory and is lost every time the app restarts or
  is updated. Logs do stay on the server's disk (their contents are explained in section 9).

## 0. Costs and CEO decisions

| Item | Required? | Cost type | Notes |
| --- | --- | --- | --- |
| VPS | Yes | Monthly | The smallest plan is enough: 1 vCPU, 1 GB RAM, 20 GB disk, Ubuntu 22.04/24.04, **KVM** type (not OpenVZ/LXC). Prices differ per provider and location; check current prices on the provider's site. |
| Domain | Yes | Yearly | If you already have a domain, just create a subdomain (e.g. `office.domainanda.com`), **at no extra cost**. If not, buy a new domain; the price depends on the extension (.com, .id, etc.). |
| HTTPS certificate | Yes | Free | Let's Encrypt, renewed automatically. |
| Ubuntu security updates | Yes | Free | Installed automatically every day (`unattended-upgrades`). |
| VPS backup/snapshot | No | Usually an extra paid add-on | Not required: there is no data that needs backing up (see section 9). |
| Uptime monitor | No | Some are free | Optional, monitors `https://office.example.com/api/health`. |

Decisions needed:

1. The VPS provider, server location, and plan.
2. The domain/subdomain to use.
3. Permission to run `setup-vps.sh` on the VPS (it changes the server configuration, see section 3).
4. Who holds the SSH access and the token.
5. Agreement that events (agent task titles, names of touched files) are sent to a server on the
   internet. What is kept on the server:
   - **Event history** (the last 300) lives only in the app's memory and is lost on restart.
   - **App logs** (journald) by default contain only event metadata: type, sender, recipient, and
     message length. The **message content** is only logged as well when `AI_OFFICE_LOG_MESSAGES=1`
     is enabled in the env file (for temporary debugging).
   - journald logs and the Nginx access logs are **written to the VPS disk** and kept for some time
     (section 9).
6. Optional: a log age limit on the server (journald retention, section 9). It applies to all system logs.
7. Recommended: manual SSH hardening (section 11), by the person who holds the SSH access.

## 1. Prerequisites

1. **A VPS** running Ubuntu 22.04 or 24.04, amd64 or arm64 architecture, at least 1 GB RAM.
2. **SSH access** as `root` or a user allowed to `sudo`. It is recommended to log in with an SSH key
   and turn off password login (section 11). SSH must be on port 22 (otherwise the script does not
   enable the firewall so you do not lock yourself out; see section 12).
3. A **DNS A record** in your domain manager:

   | Type | Name | Value |
   | --- | --- | --- |
   | A | `office` | `203.0.113.10` (VPS IP) |

   Do not add an AAAA record unless the VPS actually has active IPv6; a wrong AAAA makes certificate
   issuance fail.
4. Check DNS from a Windows computer (PowerShell). The result must be the VPS IP:

   ```powershell
   nslookup office.example.com
   ```

   DNS changes can take a few minutes to a few hours.
5. If your VPS provider has a firewall in its panel, open ports 22, 80, and 443.

## 2. Copying the code to the VPS

What gets copied is the project folder **without** `node_modules`, `dist`, `.git`, and
`.claude/settings.local.json` (a private file). The code on the VPS is rebuilt there.

### Option A: from Windows (PowerShell, nothing to install)

```powershell
cd "C:\lokasi\folder\ai-office"
tar -czf ..\ai-office.tgz --exclude=node_modules --exclude=dist --exclude=.git --exclude=settings.local.json .
scp ..\ai-office.tgz root@203.0.113.10:~/
```

Then on the VPS (`ssh root@203.0.113.10`):

```bash
rm -rf ~/ai-office && mkdir ~/ai-office && tar -xzf ~/ai-office.tgz -C ~/ai-office
```

`~/ai-office` is only a copy of the upload; it is safe to delete and recreate. The running app lives
in `/opt/ai-office`.

### Option B: rsync (macOS, Linux, or WSL)

```bash
rsync -az --delete --exclude node_modules --exclude dist --exclude .git \
  --exclude .claude/settings.local.json ./ root@203.0.113.10:~/ai-office/
```

### Option C: git (if the project later uses git)

```bash
git clone <alamat-repo> ~/ai-office     # first time
git -C ~/ai-office pull                 # subsequent updates
```

A private repo needs a deploy key on the VPS. Make sure `.claude/settings.local.json` is in
`.gitignore`.

## 3. Setup (once, requires the CEO's approval)

```bash
ssh root@203.0.113.10
cd ~/ai-office
sudo bash deploy/setup-vps.sh office.example.com email@domainanda.com
```

> **Do not record the setup output.** A secret token is shown at the end. Do not run the script with
> `| tee file.log`, `> file`, `script`, asciinema, or a screen recorder, and do not copy terminal
> output into a chat or email. If the output is redirected, the script writes the token to the
> terminal only; with no terminal (e.g. `ssh` without an interactive session), the token is not shown
> at all.

The email is used for the Let's Encrypt account. The process takes a few minutes. What the script does:

1. Installs packages: nginx, certbot, ufw, rsync, curl, openssl, unattended-upgrades.
2. Ensures Ubuntu security updates are installed automatically every day (`unattended-upgrades`).
   The VPS is **not** rebooted automatically (section 9).
3. Installs Node.js LTS (24) from the official NodeSource repo, if Node 22+ is not already present.
   The NodeSource GPG key fingerprint is checked first; if it differs, setup stops (see below).
4. Enables the UFW firewall: only ports 22, 80, 443. Port 22 uses `ufw limit`: an IP that opens
   6 or more new SSH connections within 30 seconds is temporarily refused. The SSH configuration
   (`sshd_config`) is **not** changed; that is a manual step in section 11.
5. Creates the system user `aioffice` (cannot log in) and the folder `/opt/ai-office`.
6. Creates `/etc/ai-office/ai-office.env` (readable by root only) containing a new random token.
   If that file already exists, its token is **not** replaced.
7. Installs the `ai-office` service (starts automatically at boot, restarts itself if it dies, limited
   to 384 MB RAM and 64 processes/threads).
8. Builds the app (`npm ci`, `npm run build`) and runs it.
9. Turns off the default Nginx page, obtains the HTTPS certificate, installs the Nginx configuration
   (login/API/WebSocket rate limits, refusal of unknown domains, security headers), and automatic
   certificate renewal.
10. Checks the result, then **shows the token once**.

> **Save the token** shown in the `TOKEN AI OFFICE` box to a password manager. If you miss it, root
> can see it again:
> `sudo grep AI_OFFICE_TOKEN /etc/ai-office/ai-office.env`.

The script is safe to run again with the same command, e.g. after fixing DNS.

### Verifying the NodeSource key (recommended, before the first setup)

The script only installs the NodeSource repo key if its primary key fingerprint matches the value in
`deploy/setup-vps.sh` (`NODESOURCE_GPG_FPR_DEFAULT`):

```
6F71 F525 2828 41EE DAF8  51B4 2F59 B5F9 9B1B E0B4
```

This value was checked on 2026-11-08 against the key served at
`https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key` (RSA 2048, created 2016-05-23,
key ID `2F59B5F99B1BE0B4`, named `NSolid <nsolid-gpg@nodesource.com>`). To check it
yourself, compare it with the official NodeSource documentation
(`https://github.com/nodesource/distributions`) and with the key served now
(on the VPS or any Linux machine; the key is not imported):

```bash
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /tmp/nodesource.key
gpg --show-keys --with-fingerprint /tmp/nodesource.key
# the line below "pub" must match the fingerprint above exactly
```

If setup stops with `Fingerprint kunci NodeSource TIDAK cocok`, **do not skip it**.
NodeSource may have changed the key, or the download was tampered with. Check NodeSource's official
announcements. Only after the new fingerprint is verified from an official source, run again with
`sudo NODESOURCE_GPG_FPR=<fingerprint baru> bash deploy/setup-vps.sh ...`, then ask
`dev-devops` to update the default value in the kit.

## 4. Check whether it worked

From a Windows computer (PowerShell; use `curl.exe`, not `curl`):

```powershell
curl.exe https://office.example.com/api/health
# must be: {"ok":true,...}

curl.exe -s -o NUL -w "%{http_code}`n" https://office.example.com/api/events
# must be: 401 (rejected without a token)

curl.exe -s -o NUL -w "%{http_code}`n" http://office.example.com/
# must be: 301 (redirected to HTTPS)

curl.exe -s -o NUL -w "%{http_code}`n" http://203.0.113.10/
curl.exe -sk -o NUL -w "%{http_code}`n" https://203.0.113.10/
# both must be: 000 (direct IP access is closed by Nginx without a reply)
```

In the browser:

1. Open `https://office.example.com`. There must be a padlock icon (valid HTTPS).
2. The page asks for a token: paste the token, then sign in.
3. The pixel office appears and the connection status is online. Click **Simulasi** to try it.

## 5. Pointing the Claude Code hooks at the VPS

The hooks on the CEO's computer read the token from a **file** via `AI_OFFICE_TOKEN_FILE`, not from
`AI_OFFICE_TOKEN` in `.claude/settings.local.json`. The reason: everything in the `"env"` section of
the settings file is inherited by **every** process Claude Code runs (agent shell commands, npm
scripts, MCP servers). A token there could end up printed in logs, command output, or error reports.
The token file is only opened by the hook when it sends an event.

An honest note: another program running under the same Windows/macOS account can still read that
file. This approach prevents the token from leaking by accident, not from malware on the computer.

### 5a. Save the token to a file (once, and on every token rotation)

**Windows (PowerShell).** The token is prompted hidden; the folder is created readable only by your
account:

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

The `icacls` result must be a single line with your account name (`...\nama:(I)(F)`), and the token
length 43 (a token made by `setup-vps.sh`/`rotate-token.sh`).

**macOS / Linux (Terminal, bash or zsh):**

```bash
mkdir -p ~/.ai-office && chmod 700 ~/.ai-office
printf 'Tempel token: '; IFS= read -rs t; echo
(umask 077 && printf '%s' "$t" > ~/.ai-office/token); unset t
ls -l ~/.ai-office/token       # must be -rw------- owned by you
wc -c < ~/.ai-office/token     # must be 43
```

Do not store the token file inside the project folder (it could be copied to the VPS or committed).

Token file format:

- **A single line** containing only the token. A blank line and surrounding whitespace are ignored; a
  file with more than one non-empty line is rejected.
- UTF-8 encoding (with or without BOM) or UTF-16 **with** a BOM (e.g. the result of `>` in Windows
  PowerShell 5.1) is supported. UTF-16 without a BOM is rejected.
- At most 4 KB (4096 bytes), and it must be a regular file (not a folder or FIFO).

A file that is rejected, empty, or not found is treated as having no token: the hook still sends, but
without the `Authorization` header, so the server on the VPS refuses with `401`.

### 5b. Fill in `.claude\settings.local.json`

In the AI Office project folder, create or edit the file `.claude\settings.local.json`. If the file
already exists (e.g. with `permissions`), add the `"env"` section alongside it; do not remove other content.

```json
{
  "env": {
    "AI_OFFICE_URL": "https://office.example.com/api/events",
    "AI_OFFICE_TOKEN_FILE": "~/.ai-office/token",
    "AI_OFFICE_TIMEOUT_MS": "3000"
  }
}
```

- `~` means your user folder (on Windows `C:\Users\<nama>`). This path is not a secret.
- **Remove `AI_OFFICE_TOKEN`** from that `"env"` section if it was ever filled in, and make sure there
  is no `AI_OFFICE_TOKEN` environment variable on the system. As long as `AI_OFFICE_TOKEN` is set, the
  hook uses that value and the token file is ignored.
- Close and reopen Claude Code from the project folder so the settings are read.
- The address **must** be `https://`. The hook refuses to send **any event** (with or without a token)
  over `http://` to a host other than loopback (`127.0.0.1`, `localhost`, `::1`), because event content
  (task titles, file names) could also be intercepted. Such an event is dropped silently; the reason is
  only shown with `AI_OFFICE_DEBUG=1`. So the VPS must use HTTPS.
- This settings file is private. Do not share it and do not commit it to git.
- While the hooks point at the VPS, the local animation at `localhost:3000` does not receive events.
- Back to local: remove that `"env"` section, then reopen Claude Code.

### 5c. Test without Claude Code

PowerShell, from the project folder (the token is not typed; it is read from the file):

```powershell
$env:AI_OFFICE_URL = "https://office.example.com/api/events"
$env:AI_OFFICE_TOKEN_FILE = "~/.ai-office/token"
npm run demo:hooks
Remove-Item Env:AI_OFFICE_URL, Env:AI_OFFICE_TOKEN_FILE
```

Open `https://office.example.com` in the browser while the demo runs: the manager should start walking
to the agents' desks. If there is an error, the message from the hook is shown in the terminal.

## 6. Updating the application

1. Copy the new code to the VPS as in section 2 (the `~/ai-office` folder is recreated).
2. Run:

   ```bash
   sudo bash ~/ai-office/deploy/update.sh
   ```

- The token and the env file are not touched.
- If the build fails, the old version keeps running without interruption.
- If the new version is not healthy, or `/api/events` turns out to be openable without a token, the
  script automatically returns to the previous version.
- The event history on screen is empty again after an update (it is only in memory, after all).
- If the file `deploy/systemd/ai-office.service` or `deploy/nginx/ai-office.conf` also changed, run
  `setup-vps.sh` again (section 3); `update.sh` only replaces the code.

## 7. Rollback

Return to the previous version (the last 3 versions are kept in `/opt/ai-office/releases`):

```bash
sudo bash /opt/ai-office/current/deploy/update.sh --rollback
ls /opt/ai-office/releases          # list of versions
readlink -f /opt/ai-office/current  # the active version
```

Running `--rollback` again goes back one more version.

The hooks return to the local animation: remove the `"env"` section in `.claude\settings.local.json`
(section 5).

Temporarily stopping without deleting anything:

```bash
sudo systemctl stop ai-office       # the site shows 502 until it is started again
sudo systemctl start ai-office      # start it again
```

Disabling fully (can still be re-enabled):

```bash
sudo systemctl disable --now ai-office
sudo rm /etc/nginx/sites-enabled/ai-office.conf && sudo systemctl reload nginx
```

Re-enabling: run `setup-vps.sh` again with the same domain.

## 8. Rotating (changing) the token and revoking sessions

Change the token if it may have leaked, a laptop or phone that had logged in is lost, someone is no
longer allowed access, or periodically (e.g. every 3 to 6 months).

```bash
sudo bash /opt/ai-office/current/deploy/rotate-token.sh
```

Same as setup: do not run it with `| tee`, `script`, or a terminal recorder.

The new token is shown once. The old token **and all browser sessions** immediately stop working
(session cookies are derived from the token). After that:

1. Write the new token to the token file on the CEO's computer (step 5a), then reopen Claude Code.
2. Log in again in the browser with the new token, on every device still in use.

If the app fails to start with the new token, the script restores the old token automatically.

> **Sign out revokes that session on the server, but only in memory.** Session cookies (`v2.<exp>.<sid>.<sig>`)
> are valid for 24 hours, and Sign out adds the session id to a revocation list in the server's memory
> (up to 10,000 entries). The list is lost when the app restarts, so a copied cookie only stays dead until
> then. To revoke **all** sessions at once (e.g. a laptop is lost or a cookie may have been copied), run
> `rotate-token.sh`.
>
> **Nginx must send `X-Real-IP`.** With `AI_OFFICE_TRUST_PROXY=1` the login rate limit is keyed by
> `X-Real-IP` (IPv6 by /64 prefix). If the header is missing or invalid, login is rejected with `503`
> (misconfiguration) instead of falling back to the socket address. Keep
> `proxy_set_header X-Real-IP $remote_addr;` in the Nginx config.

The manual way (if needed): create a token with `openssl rand -base64 32` or
`node scripts/gen-token.mjs`, set it into `AI_OFFICE_TOKEN=` via `sudo nano /etc/ai-office/ai-office.env`,
then `sudo systemctl restart ai-office`. The token must be at least 32 characters; if it is shorter, the app refuses to start.

## 9. Logs, monitoring, and backups

```bash
systemctl status ai-office                      # running or not, Memory/Tasks usage
journalctl -u ai-office -f                      # live app log (Ctrl+C to exit)
journalctl -u ai-office --since "1 hour ago"    # the last hour's log
sudo tail -f /var/log/nginx/ai-office.access.log
sudo tail -f /var/log/nginx/ai-office.error.log
sudo certbot certificates                       # certificate expiry dates
```

### What is kept on the server's disk

| Data | Location | Contents | How long |
| --- | --- | --- | --- |
| Event history | app memory (not disk) | the last 300 events | until the app restarts/updates |
| App logs | journald (`/var/log/journal`) | by default event **metadata** (type, sender, recipient, message length), failed logins with their IP, errors. **Message content** only when `AI_OFFICE_LOG_MESSAGES=1` | Ubuntu default: limited by size (about 10% of disk, max 4 GB), **not** by age |
| Nginx access logs | `/var/log/nginx/ai-office.access.log` | IP, time, method + address, status, user agent. No request body and no token | rotated daily, 14 days (Ubuntu default) |
| Token | `/etc/ai-office/ai-office.env` | secret, root only | until rotated |

`AI_OFFICE_LOG_MESSAGES=1` should only be used temporarily to track down a problem: add its line to
`/etc/ai-office/ai-office.env`, `sudo systemctl restart ai-office`, then remove it again and
restart. Message content that has already been logged stays in journald until removed by retention.

### journald log retention (recommended, requires approval)

So that logs are not kept indefinitely, limit the age and size of journald. This setting applies to
**all** system logs on the VPS (including the SSH logs in journald; `/var/log/auth.log` still follows
logrotate), so it is not installed automatically by `setup-vps.sh`:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nMaxRetentionSec=14day\nSystemMaxUse=500M\n' \
  | sudo tee /etc/systemd/journald.conf.d/50-retensi.conf >/dev/null
sudo systemctl restart systemd-journald
sudo journalctl --vacuum-time=14d               # delete logs older than 14 days
journalctl --disk-usage
```

14 days matches the Nginx logs. A limit specific to the `ai-office` service alone would need
`LogNamespace=` in systemd, which changes how the logs are read (`journalctl --namespace=...`); it is
not used so that the log commands in this guide stay the same.

### Other

- **Health:** `https://office.example.com/api/health` (public) can be plugged into an uptime
  monitoring service. The API rate limit (10 per second per IP) is far above a monitor's needs.
- **Certificates** are renewed automatically by `certbot.timer`. Let's Encrypt no longer sends
  expiry reminder emails, so check `sudo certbot certificates` from time to time.
- **Backups:** there is no database or data file. The only secret on the server is
  `/etc/ai-office/ai-office.env`, and it can be recreated by rotating the token. The source code is on
  the CEO's computer.
- **Ubuntu security updates** are installed automatically every day by `unattended-upgrades` (the
  Ubuntu security archive only). What stays manual:
  - **Reboot.** A new kernel update only takes effect after a reboot. Check `cat /var/run/reboot-required`;
    if present, `sudo reboot` during quiet hours (the app starts itself, the on-screen event history is empty).
  - **Node.js** from NodeSource is not updated automatically. Once a month:
    `sudo apt update && sudo apt upgrade`, then `sudo systemctl restart ai-office`.
  - The automatic-update log: `/var/log/unattended-upgrades/unattended-upgrades.log`.

## 10. Technical verification on the VPS

These commands are for technical people, after `setup-vps.sh` finishes:

| Command | Expected result |
| --- | --- |
| `sudo nginx -t` | `syntax is ok` and `test is successful` |
| `nginx -v` | 1.18 (Ubuntu 22.04) or 1.24 (Ubuntu 24.04). On 1.18, the default 443 server uses the domain certificate, not `ssl_reject_handshake` |
| `sudo systemd-analyze verify /etc/systemd/system/ai-office.service` | no error output |
| `sudo systemd-analyze security ai-office` | a low exposure label (`OK` or better), well below an un-hardened service labelled `UNSAFE` |
| `systemctl show ai-office -p MemoryHigh -p MemoryMax -p TasksMax` | `MemoryHigh=268435456`, `MemoryMax=402653184`, `TasksMax=64` |
| `systemctl is-active ai-office nginx` | `active` twice |
| `sudo certbot renew --dry-run` | `Congratulations, all simulated renewals succeeded` |
| `systemctl list-timers \| grep -E 'certbot\|apt-daily'` | `certbot.timer`, `apt-daily.timer`, `apt-daily-upgrade.timer` scheduled |
| `apt-config dump \| grep -E 'Periodic::(Update-Package-Lists\|Unattended-Upgrade) '` | both `"1"` |
| `sudo ufw status verbose` | default deny incoming; `22/tcp LIMIT IN`; ALLOW only 80, 443 (no `OpenSSH ALLOW`) |
| `sudo ss -tlnp \| grep -E ':(80\|443\|3000)\b'` | 80/443 belong to nginx; 3000 is `127.0.0.1` only |
| `sudo stat -c '%a %U' /etc/ai-office/ai-office.env` | `600 root` |
| `curl -sI https://office.example.com \| grep -i strict-transport` | `max-age=31536000` |
| `curl -s -D - -o /dev/null https://office.example.com/api/health \| grep -iE '^(x-content-type-options\|referrer-policy)'` | `nosniff` and `no-referrer`, one line each |
| `curl -s -o /dev/null -w '%{http_code}\n' https://office.example.com/api/events` | `401` |
| `curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: contoh.invalid' http://127.0.0.1/` | `000` (connection closed) |
| `curl -sk -o /dev/null -w '%{http_code}\n' --resolve contoh.invalid:443:127.0.0.1 https://contoh.invalid/` | `000` |
| 12x `POST /api/login` quickly (see below) | some reply `429` |
| 200 `GET /api/health` in parallel (see below) | most `200`, the rest `429` |

Run these tests from the VPS, **not** from the CEO's computer: after 10 failed logins, the app blocks
logins from the sender's IP for 15 minutes (on top of the 5-per-minute limit from Nginx).

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code} ' -X POST -H 'Content-Type: application/json' \
    -d '{"token":"salah"}' https://office.example.com/api/login
done; echo
```

API rate limit (10 per second per IP, burst 100). The testing IP only gets 429 for a few seconds:

```bash
seq 200 | xargs -P 50 -I{} curl -s -o /dev/null -w '%{http_code}\n' \
  https://office.example.com/api/health | sort | uniq -c
```

A WebSocket without login must be rejected, and in the browser after login it must connect (online status):

```bash
curl -s -o /dev/null -w '%{http_code}\n' --http1.1 -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  https://office.example.com/ws
# must be 401 or 403
```

## 11. SSH hardening (manual, recommended)

`setup-vps.sh` intentionally does **not** change the SSH configuration, because a wrong step could
lock everyone out of the server. Do these steps yourself, slowly, with **two SSH sessions**: the first
session stays open until the second is proven able to get in.

The goal: log in only with an SSH key (no password), root cannot log in with a password, and day-to-day
work uses a normal user with `sudo`.

**1. Prepare an SSH key on the CEO's computer** (skip if you already have `~/.ssh/id_ed25519.pub`).
Windows 10/11 (PowerShell) and macOS/Linux are the same:

```powershell
ssh-keygen -t ed25519
```

Give a passphrase when asked. The file `id_ed25519` (without `.pub`) is the private key: do not share it.

**2. Create a sudo user** (first session, as root on the VPS; replace `ceo` with the name you choose):

```bash
adduser ceo                 # set a password: still used for sudo, not for SSH login
usermod -aG sudo ceo
```

**3. Install the public key for that user.** If root already logs in with a key (common on a VPS),
copy the same key:

```bash
install -d -m 700 -o ceo -g ceo /home/ceo/.ssh
install -m 600 -o ceo -g ceo /root/.ssh/authorized_keys /home/ceo/.ssh/authorized_keys
```

Or send it from the CEO's computer (PowerShell):

```powershell
type $HOME\.ssh\id_ed25519.pub | ssh root@203.0.113.10 "install -d -m 700 -o ceo -g ceo /home/ceo/.ssh && tr -d '\r' >> /home/ceo/.ssh/authorized_keys && chown ceo:ceo /home/ceo/.ssh/authorized_keys && chmod 600 /home/ceo/.ssh/authorized_keys"
```

**4. Test in a second session** (a new terminal; do NOT close the first session):

```bash
ssh ceo@203.0.113.10
sudo whoami                 # must be: root
```

If it fails, fix step 2 or 3 first from the first session. Do not continue.

**5. Turn off password login** (from the second session, as `ceo`):

```bash
printf '%s\n' '# Pengerasan SSH AI Office (manual, docs/DEPLOY.md bagian 11)' \
  'PasswordAuthentication no' 'KbdInteractiveAuthentication no' 'PermitRootLogin prohibit-password' \
  | sudo tee /etc/ssh/sshd_config.d/00-ai-office-hardening.conf >/dev/null
sudo sshd -t && sudo systemctl reload ssh
sudo sshd -T | grep -Ei '^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin) '
```

The result must be `passwordauthentication no`, `kbdinteractiveauthentication no`, and
`permitrootlogin prohibit-password` (older versions write it as `without-password`; the meaning is the
same). The filename is prefixed `00-` because SSH uses the **first** value it finds, and some VPS
images have a `50-cloud-init.conf` with `PasswordAuthentication yes`. A failed `sshd -t` means a
typo: the reload is not run, so SSH keeps using the old configuration.

**6. Test again in a third session** before closing any session:

```bash
ssh ceo@203.0.113.10                                             # must succeed (key)
ssh -o PubkeyAuthentication=no -o PreferredAuthentications=password,keyboard-interactive ceo@203.0.113.10
# must be rejected: "Permission denied (publickey)"
```

**If anything goes wrong**, from a session that is still open:

```bash
sudo rm /etc/ssh/sshd_config.d/00-ai-office-hardening.conf && sudo systemctl reload ssh
```

If all sessions are already closed, get in through the web console (VNC/serial) in the VPS provider's panel.

Notes:

- From now on use `ssh ceo@203.0.113.10` then `sudo ...` for all commands in this guide.
- The `ufw limit` on port 22: 6 or more new connections within 30 seconds from the same IP are
  temporarily refused. If `ssh`/`scp` suddenly times out after many connections in a row, wait
  30 seconds.
- After a few smooth weeks, root can be turned off entirely with `PermitRootLogin no` (same method
  and testing).

## 12. Common problems

| Symptom | Cause and fix |
| --- | --- |
| `$'\r': command not found` or `invalid option name` | The script file changed to Windows format (CRLF). On the VPS: `sed -i 's/\r$//' ~/ai-office/deploy/*.sh`, then retry. |
| `http://... belum sampai ke VPS ini` | DNS does not point to the VPS yet or port 80 is closed. Check the A record and the provider panel firewall, wait, then retry setup. |
| certbot fails repeatedly / `too many failed authorizations` | Let's Encrypt attempt limit. Fix DNS, wait about 1 hour, then retry. |
| `nginx -t` fails with `duplicate default server` | Another site in `/etc/nginx/sites-enabled` or `/etc/nginx/conf.d` also uses `default_server`. Disable that site (remove its symlink in `sites-enabled`), then retry setup. |
| `Fingerprint kunci NodeSource TIDAK cocok` | Do not skip it. See "Verifying the NodeSource key" in section 3. |
| Browser shows `502 Bad Gateway` | The app is not running. See `journalctl -u ai-office -n 50`. |
| Service fails with `226/NAMESPACE` | The VPS is a container type (OpenVZ/LXC) that does not support systemd sandboxing. Use a KVM VPS, or ask `dev-devops` to adjust the hardening. |
| App dies repeatedly, logs `oom-kill` / `status=9/KILL` | Exceeding the `MemoryMax=384M` limit. Report to `dev-backend` (likely a memory leak); for now it can be raised via `sudo systemctl edit ai-office` (`[Service]` then `MemoryMax=512M`). |
| `token ... kurang dari 32 karakter` | Run `rotate-token.sh` (section 8). |
| App refuses to start due to `AI_OFFICE_TRUST_PROXY=1` with a non-loopback HOST | There is a `HOST=` in `/etc/ai-office/ai-office.env`. Remove that line (HOST is set by the systemd unit), then `sudo systemctl restart ai-office`. |
| `versi server ini belum memakai autentikasi` | The copied code does not yet contain the Part 4 token authentication. Copy the latest version. The script intentionally refuses to install a version without a token. |
| Login replies `429` | Too many login attempts. Wait 1 minute (the Nginx limit), or up to 15 minutes if the token was wrong 10 times (the app limit). |
| Some events are lost when many agents work, Nginx logs contain `limiting requests` | Exceeding the API limit (10 per second, burst 100). Report to `dev-devops` to raise the `rate`/`burst` of the `aioffice_api` zone. |
| `SSH memakai port ..., bukan 22` | The script did not enable UFW so SSH is not locked out. Set it manually: `ufw limit <port>/tcp`, `ufw allow 80/tcp`, `ufw allow 443/tcp`, `ufw enable`. |
| `Masih ada aturan ALLOW untuk SSH` | The VPS image already has an `OpenSSH ALLOW` rule, so the rate limit does not apply. Make sure `22/tcp LIMIT` is in `sudo ufw status`, then `sudo ufw delete allow OpenSSH`. |
| `ssh` times out after many connections in a row | The `ufw limit` (section 11). Wait 30 seconds. |
| Events from Claude Code do not appear | Check that `AI_OFFICE_URL` uses `https://` and ends with `/api/events`, the token file exists and its content matches the token on the server exactly, `AI_OFFICE_TOKEN` is not set elsewhere, then run the test in section 5c. |
| `AI_OFFICE_TOKEN_FILE (...) tidak valid: file token harus berisi satu baris` | The token file has more than one line (e.g. an npm title line because `-s` was forgotten). Rewrite the file to contain only the token (section 5a). |
| `AI_OFFICE_TOKEN_FILE (nilainya tidak ditampilkan karena tidak berbentuk path; ...)` | For safety, the path is not printed to the log if its value looks like a token: not starting with `~` and without `/` or `\`, or entirely 24 or more characters of letters, digits, `+ / = _ -` only, with no dot (e.g. `/etc/ai-office/token-file`). The reason for the problem is still shown. Make sure the variable holds a file path, not the token; a path starting with `~` or using a dot (e.g. `token.txt`) will be shown. |

## 13. Contents of the deploy kit

| File in the project | Installed on the VPS as |
| --- | --- |
| `deploy/setup-vps.sh` | run once from `~/ai-office` |
| `deploy/update.sh` | update and `--rollback` |
| `deploy/rotate-token.sh` | change the token |
| `deploy/lib.sh` | shared functions of the three scripts above |
| `deploy/systemd/ai-office.service` | `/etc/systemd/system/ai-office.service` |
| `deploy/nginx/ai-office.conf` | `/etc/nginx/sites-available/ai-office.conf` (+ a symlink in `sites-enabled`) |
| `deploy/nginx/ai-office-http-only.conf` | temporary, only before the first certificate is issued |
| `deploy/ai-office.env.example` | an example of `/etc/ai-office/ai-office.env` content (without a token) |

Other locations on the VPS: the code in `/opt/ai-office/releases/<waktu>` with `/opt/ai-office/current`
pointing to the active version; the build cache in `/var/lib/ai-office`; certificates in
`/etc/letsencrypt/live/office.example.com/`; the renewal hook in
`/etc/letsencrypt/renewal-hooks/deploy/ai-office-reload-nginx.sh`; the NodeSource repo key in
`/etc/apt/keyrings/nodesource.gpg`; automatic updates in `/etc/apt/apt.conf.d/20auto-upgrades`
(created only if it does not exist yet) and, if another configuration turns it off,
`/etc/apt/apt.conf.d/52ai-office-auto-upgrades`.
