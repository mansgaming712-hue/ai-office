// Kit deploy (deploy/ + docs/DEPLOY.md): pemeriksaan statis. Tidak ada skrip deploy yang dijalankan;
// bash hanya dipakai untuk `bash -n` (cek sintaks, isi dikirim lewat stdin, tidak dieksekusi).
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIN_OPEN_TOKEN_LENGTH } from '../server/auth.js';
import { ROOT } from './helpers/testkit.js';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const walk = (dir) =>
  readdirSync(join(ROOT, dir)).flatMap((n) => {
    const rel = `${dir}/${n}`;
    return statSync(join(ROOT, rel)).isDirectory() ? walk(rel) : [rel];
  });

const DEPLOY_FILES = walk('deploy');
const SCRIPTS = DEPLOY_FILES.filter((f) => f.endsWith('.sh'));
const NGINX = read('deploy/nginx/ai-office.conf');
const NGINX_HTTP_ONLY = read('deploy/nginx/ai-office-http-only.conf');
const UNIT = read('deploy/systemd/ai-office.service');
const ENV_EXAMPLE = read('deploy/ai-office.env.example');
const DOC = read('docs/DEPLOY.md');
const LIB = read('deploy/lib.sh');

/** Nama variabel lingkungan yang benar-benar dibaca kode (process.env.X). */
const envReadBy = (file) => new Set([...read(file).matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1]));
const SERVER_ENV = envReadBy('server/index.js');
const HOOK_ENV = envReadBy('hooks/send-event.mjs');
const KNOWN = new Set([...SERVER_ENV, ...HOOK_ENV]);

/** Komentar nginx dibuang, lalu blok location (tanpa kurung kurawal bersarang) diambil. */
const nginxCode = (text) => text.split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
function locations(text) {
  const out = {};
  for (const m of nginxCode(text).matchAll(/location\s+(?:=|\^~|~\*?)?\s*(\S+)\s*\{([^{}]*)\}/g)) out[m[1]] = m[2];
  return out;
}
const directives = (block) => block.split(';').map((d) => d.trim().replace(/\s+/g, ' ')).filter(Boolean);

/** Isi blok `server { ... }` tingkat atas (kurung kurawal bersarang dihitung), komentar sudah dibuang. */
function serverBlocks(text) {
  const code = nginxCode(text);
  const out = [];
  const re = /(?:^|[\n;}])\s*server\s*\{/g;
  let m;
  while ((m = re.exec(code))) {
    let depth = 1;
    let i = re.lastIndex;
    for (; i < code.length && depth > 0; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') depth--;
    }
    const body = code.slice(re.lastIndex, i - 1);
    // Direktif tingkat server saja (isi location bersarang dibuang).
    out.push({ body, top: directives(body.replace(/\{[^{}]*\}/g, ';')) });
    re.lastIndex = i;
  }
  return out;
}

/**
 * Blok "env" settings.local.json di teks → [{ KUNCI: nilai }]. Blok berakhir di baris yang hanya
 * berisi "}" (nilai seperti ${DOMAIN} memuat kurung kurawal).
 */
const envBlocks = (text) =>
  [...text.matchAll(/"env"\s*:\s*\{([\s\S]*?)\n\s*\}/g)].map((m) =>
    Object.fromEntries([...m[1].matchAll(/"([A-Z0-9_]+)"\s*:\s*"([^"]*)"/g)].map((k) => [k[1], k[2]])),
  );

/** Teks satu bagian markdown: dari judul yang cocok `startRe` sampai judul ## / ### berikutnya. */
function sectionOf(text, startRe) {
  const m = startRe.exec(text);
  if (!m) return '';
  const rest = text.slice(m.index + m[0].length);
  const next = /^#{2,3} /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** Isi fungsi bash `name() { ... }` sampai baris "}" pertama di kolom 0. */
function functionBody(text, name) {
  const start = text.indexOf(`${name}() {`);
  if (start < 0) return '';
  const end = text.indexOf('\n}\n', start);
  return text.slice(start, end < 0 ? undefined : end);
}

/** Baris kode bash tanpa komentar (baris yang diawali # dibuang). */
const bashCode = (text) => text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

function hasBash() {
  const r = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  return r.status === 0 && r.stdout.trim() === 'ok';
}
const BASH = hasBash();

describe('skrip shell deploy/*.sh', () => {
  it('ada 4 skrip yang diharapkan', () => {
    expect(SCRIPTS.sort()).toEqual(['deploy/lib.sh', 'deploy/rotate-token.sh', 'deploy/setup-vps.sh', 'deploy/update.sh']);
  });

  if (!BASH) console.warn('[deploy.test] bash tidak ditemukan di PATH: pemeriksaan "bash -n" DILEWATI (jalankan dari Git Bash / Linux).');
  it.skipIf(!BASH).each(SCRIPTS)(`bash -n %s (sintaks valid)${BASH ? '' : ' [DILEWATI: bash tidak tersedia]'}`, (f) => {
    const r = spawnSync('bash', ['-n'], { input: read(f), encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });

  it.skipIf(!BASH)('bash -n benar-benar mendeteksi sintaks rusak (kontrol)', () => {
    const r = spawnSync('bash', ['-n'], { input: 'if [[ 1 ]]; then\n  echo x\n', encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(r.status).not.toBe(0);
  });

  it.each(SCRIPTS.filter((f) => f !== 'deploy/lib.sh'))('%s: shebang bash, set -euo pipefail, memuat lib.sh', (f) => {
    const t = read(f);
    expect(t.startsWith('#!/usr/bin/env bash\n')).toBe(true);
    expect(t).toMatch(/^set -euo pipefail$/m);
    expect(t).toMatch(/^source "\$SCRIPT_DIR\/lib\.sh"$/m);
  });

  it('lib.sh hanya definisi (tanpa shebang), konstanta selaras dengan server/systemd/nginx', () => {
    expect(LIB.startsWith('#!')).toBe(false);
    expect(LIB).toMatch(new RegExp(`^TOKEN_MIN_LEN=${MIN_OPEN_TOKEN_LENGTH}$`, 'm'));
    expect(LIB).toMatch(/^APP_PORT="3000"/m);
    expect(LIB).toMatch(/^ENV_FILE="\/etc\/ai-office\/ai-office\.env"$/m);
  });
});

describe('semua file deploy/', () => {
  it('ditemukan (sanity)', () => {
    expect(DEPLOY_FILES.length).toBeGreaterThanOrEqual(8);
  });

  it.each(DEPLOY_FILES)('%s: tanpa CRLF, tanpa BOM', (f) => {
    const buf = readFileSync(join(ROOT, f));
    expect(buf.includes(0x0d), `${f} memuat \\r`).toBe(false);
    expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
  });

  it('tidak ada string mirip token asli (≥ 40 karakter base64url campuran) di deploy/ dan docs/DEPLOY.md', () => {
    const looksLikeToken = (s) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /[0-9]/.test(s);
    for (const f of [...DEPLOY_FILES, 'docs/DEPLOY.md']) {
      const hits = [...read(f).matchAll(/(?<![\w/.-])[A-Za-z0-9_-]{40,}(?![\w/.-])/g)].map((m) => m[0]).filter(looksLikeToken);
      expect(hits, f).toEqual([]);
    }
  });
});

describe('Nginx deploy/nginx/ai-office.conf', () => {
  const locs = locations(NGINX);
  const code = nginxCode(NGINX);

  it('punya location /ws, /api/login, /, dan acme-challenge', () => {
    expect(Object.keys(locs).sort()).toEqual(['/', '/.well-known/acme-challenge/', '/api/login', '/ws']);
  });

  it.each(['/ws', '/api/login', '/'])('location %s: proxy ke app + Host / X-Real-IP / X-Forwarded-Proto ditimpa Nginx', (path) => {
    // location / muncul dua kali (server :80 redirect dan server :443); ambil yang mem-proxy.
    const blocks = [...nginxCode(NGINX).matchAll(/location\s+(?:=|\^~)?\s*(\S+)\s*\{([^{}]*)\}/g)].filter((m) => m[1] === path).map((m) => directives(m[2]));
    const d = blocks.find((b) => b.includes('proxy_pass http://aioffice_app'));
    expect(d, `location ${path} tanpa proxy_pass`).toBeDefined();
    expect(d).toContain('proxy_set_header Host $host');
    expect(d).toContain('proxy_set_header X-Real-IP $remote_addr');
    expect(d).toContain('proxy_set_header X-Forwarded-Proto $scheme');
    expect(d).toContain('proxy_http_version 1.1');
  });

  it('header IP tidak pernah diteruskan dari klien ($http_x_real_ip / $proxy_add_x_forwarded_for)', () => {
    expect(code).not.toMatch(/\$http_x_real_ip|\$proxy_add_x_forwarded_for|\$http_x_forwarded_proto/);
  });

  it('/ws: upgrade WebSocket (Upgrade + Connection dari map) dan timeout panjang', () => {
    const d = directives(locs['/ws']);
    expect(d).toContain('proxy_set_header Upgrade $http_upgrade');
    expect(d).toContain('proxy_set_header Connection $aioffice_connection_upgrade');
    expect(code).toMatch(/map \$http_upgrade \$aioffice_connection_upgrade \{\s*default upgrade;\s*'' {6}close;\s*\}/);
    expect(d.some((x) => /^proxy_read_timeout (\d+h|\d{3,}s?)$/.test(x))).toBe(true);
  });

  it('/api/login: limit_req ke zona yang didefinisikan, status 429', () => {
    const d = directives(locs['/api/login']);
    expect(d.some((x) => /^limit_req zone=aioffice_login\b/.test(x))).toBe(true);
    expect(d).toContain('limit_req_status 429');
    expect(code).toMatch(/limit_req_zone \$binary_remote_addr zone=aioffice_login:\d+m rate=\d+r\/[sm];/);
  });

  it('client_max_body_size 64k (sama dengan batas body server 64 KB)', () => {
    expect(code).toMatch(/^\s*client_max_body_size 64k;$/m);
    expect(read('server/app.js')).toMatch(/maxBodyBytes = 64 \* 1024/);
  });

  it('HSTS ≥ 1 tahun dengan "always"; TLS 1.2+; HTTP :80 redirect ke HTTPS', () => {
    const m = /add_header Strict-Transport-Security "max-age=(\d+)[^"]*" always;/.exec(code);
    expect(m).not.toBeNull();
    expect(Number(m[1])).toBeGreaterThanOrEqual(31536000);
    expect(code).toMatch(/listen 443 ssl/);
    expect(code).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3;/);
    expect(code).toMatch(/return 301 https:\/\/__DOMAIN__\$request_uri;/);
  });

  it('upstream ke 127.0.0.1:3000 (sama dengan PORT di unit systemd)', () => {
    expect(code).toMatch(/upstream aioffice_app \{\s*server 127\.0\.0\.1:3000;/);
    expect(UNIT).toMatch(/^Environment=PORT=3000$/m);
  });

  it('domain hanya placeholder __DOMAIN__ (diganti setup-vps.sh)', () => {
    expect(code).toMatch(/server_name __DOMAIN__;/);
    expect(code).toMatch(/\/etc\/letsencrypt\/live\/__DOMAIN__\/fullchain\.pem/);
    expect(code).not.toMatch(/server_name (?!__DOMAIN__)/);
  });

  it('konfigurasi sementara http-only tidak pernah mem-proxy app lewat HTTP biasa', () => {
    const c = nginxCode(NGINX_HTTP_ONLY);
    expect(c).not.toMatch(/proxy_pass/);
    expect(c).toMatch(/return 503/);
    expect(c).toMatch(/acme-challenge/);
  });
});

describe('systemd deploy/systemd/ai-office.service', () => {
  const lines = UNIT.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  it('HOST=127.0.0.1, EnvironmentFile wajib (tanpa "-") di /etc/ai-office/ai-office.env', () => {
    expect(lines).toContain('Environment=HOST=127.0.0.1');
    expect(lines).toContain('EnvironmentFile=/etc/ai-office/ai-office.env');
    expect(lines.some((l) => l.startsWith('EnvironmentFile=-'))).toBe(false);
  });

  it('hardening: NoNewPrivileges, user bukan root, filesystem read-only, tanpa capability', () => {
    expect(lines).toContain('NoNewPrivileges=yes');
    expect(lines).toContain('ProtectSystem=strict');
    expect(lines).toContain('CapabilityBoundingSet=');
    const user = lines.find((l) => l.startsWith('User='));
    expect(user).toBeDefined();
    expect(user).not.toBe('User=root');
  });

  it('menjalankan server/index.js dan restart otomatis', () => {
    expect(lines.find((l) => l.startsWith('ExecStart='))).toMatch(/node \/opt\/ai-office\/current\/server\/index\.js$/);
    expect(lines.some((l) => /^Restart=(always|on-failure)$/.test(l))).toBe(true);
  });

  it('Environment= hanya variabel yang dikenal server (plus NODE_ENV)', () => {
    const keys = lines.filter((l) => l.startsWith('Environment=')).map((l) => l.slice('Environment='.length).split('=')[0]);
    for (const k of keys) expect([...SERVER_ENV, 'NODE_ENV'], k).toContain(k);
  });
});

describe('deploy/ai-office.env.example', () => {
  const entries = ENV_EXAMPLE.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l)).map((l) => {
    const i = l.indexOf('=');
    return [l.slice(0, i), l.slice(i + 1)];
  });

  it('AI_OFFICE_TOKEN ada tetapi KOSONG (tidak ada token di contoh)', () => {
    const tok = entries.filter(([k]) => k === 'AI_OFFICE_TOKEN');
    expect(tok).toEqual([['AI_OFFICE_TOKEN', '']]);
  });

  it('kunci hanya yang dikenal server; HOST/PORT tidak ada (diatur unit systemd)', () => {
    const keys = entries.map(([k]) => k);
    expect(keys.sort()).toEqual(['AI_OFFICE_ALLOWED_HOSTS', 'AI_OFFICE_TOKEN', 'AI_OFFICE_TRUST_PROXY']);
    for (const k of keys) expect([...SERVER_ENV]).toContain(k);
    expect(keys).not.toContain('HOST');
    expect(keys).not.toContain('PORT');
  });

  it('format systemd: tanpa spasi di sekitar "=" dan TRUST_PROXY bernilai 1', () => {
    for (const line of ENV_EXAMPLE.split('\n').filter((l) => l && !l.startsWith('#'))) expect(line).toMatch(/^[A-Z0-9_]+=\S*$/);
    expect(entries).toContainEqual(['AI_OFFICE_TRUST_PROXY', '1']);
  });
});

describe('nama variabel lingkungan di deploy/ dan docs/DEPLOY.md', () => {
  it('daftar yang dikenal (dibaca dari kode) sesuai kontrak', () => {
    expect([...SERVER_ENV].sort()).toEqual([
      'AI_OFFICE_ALLOWED_HOSTS', 'AI_OFFICE_DEV_ORIGINS', 'AI_OFFICE_LOG_MESSAGES', 'AI_OFFICE_TOKEN', 'AI_OFFICE_TOKEN_FILE', 'AI_OFFICE_TRUST_PROXY', 'HOST', 'PORT',
    ]);
    // CLAUDE_PROJECT_DIR: diisi Claude Code sendiri (nama proyek di event), bukan konfigurasi deploy.
    expect([...HOOK_ENV].sort()).toEqual(['AI_OFFICE_DEBUG', 'AI_OFFICE_TIMEOUT_MS', 'AI_OFFICE_TOKEN', 'AI_OFFICE_TOKEN_FILE', 'AI_OFFICE_URL', 'CLAUDE_PROJECT_DIR']);
  });

  it.each([...DEPLOY_FILES, 'docs/DEPLOY.md'])('%s: semua AI_OFFICE_* dikenal server/hook', (f) => {
    const names = new Set([...read(f).matchAll(/AI_OFFICE_[A-Z0-9_]*[A-Z0-9]/g)].map((m) => m[0]));
    for (const n of names) expect([...KNOWN], `${f}: ${n}`).toContain(n);
  });

  it('blok "env" settings.local.json (docs dan setup-vps.sh) hanya berisi variabel hook, dengan URL dan sumber token', () => {
    for (const f of ['docs/DEPLOY.md', 'deploy/setup-vps.sh']) {
      const blocks = envBlocks(read(f));
      expect(blocks.length, f).toBeGreaterThan(0);
      for (const b of blocks) {
        const keys = Object.keys(b);
        expect(keys.length).toBeGreaterThan(0);
        for (const k of keys) expect([...HOOK_ENV], `${f}: ${k}`).toContain(k);
        expect(keys).toContain('AI_OFFICE_URL');
        // Boleh AI_OFFICE_TOKEN atau AI_OFFICE_TOKEN_FILE (lihat test "disarankan" di bawah).
        expect(keys.some((k) => k === 'AI_OFFICE_TOKEN' || k === 'AI_OFFICE_TOKEN_FILE'), `${f}: blok tanpa sumber token`).toBe(true);
      }
    }
  });

  it('blok "env" yang DISARANKAN (DEPLOY.md 5b, ringkasan akhir setup-vps.sh) memakai AI_OFFICE_TOKEN_FILE, bukan AI_OFFICE_TOKEN', () => {
    const recommended = [
      ['docs/DEPLOY.md bagian 5b', sectionOf(DOC, /^### 5b\b/m)],
      ['deploy/setup-vps.sh print_summary', functionBody(read('deploy/setup-vps.sh'), 'print_summary')],
    ];
    for (const [name, text] of recommended) {
      const blocks = envBlocks(text);
      expect(blocks, name).toHaveLength(1);
      expect(Object.keys(blocks[0]), name).toContain('AI_OFFICE_TOKEN_FILE');
      expect(Object.keys(blocks[0]), name).not.toContain('AI_OFFICE_TOKEN');
      // Path file token sama di docs dan skrip, dan berada di home (bukan di folder proyek).
      expect(blocks[0].AI_OFFICE_TOKEN_FILE, name).toBe('~/.ai-office/token');
    }
  });

  it('contoh AI_OFFICE_URL di docs/skrip memakai https:// untuk domain publik (token tidak lewat http)', () => {
    for (const f of ['docs/DEPLOY.md', 'deploy/setup-vps.sh']) {
      for (const m of read(f).matchAll(/AI_OFFICE_URL["']?\s*[:=]\s*["']?([^"'\s,]+)/g)) {
        const u = m[1];
        if (/^https?:\/\/(127\.0\.0\.1|localhost)/.test(u) || u.startsWith('(') || u.startsWith('<')) continue;
        expect(u, `${f}: ${u}`).toMatch(/^https:\/\//);
      }
    }
  });

  it('file env yang ditulis setup-vps.sh hanya berisi variabel server', () => {
    const writes = [...read('deploy/setup-vps.sh').matchAll(/^(AI_OFFICE_[A-Z_]+|HOST|PORT)=/gm)].map((m) => m[1]);
    expect(writes.sort()).toEqual(['AI_OFFICE_ALLOWED_HOSTS', 'AI_OFFICE_TOKEN', 'AI_OFFICE_TRUST_PROXY']);
    for (const k of writes) expect([...SERVER_ENV]).toContain(k);
  });

  it('PowerShell $env: di docs hanya variabel hook', () => {
    const names = [...DOC.matchAll(/\$env:([A-Z0-9_]+)/g)].map((m) => m[1]);
    for (const n of names) expect([...HOOK_ENV], n).toContain(n);
  });
});

// ------------------------------------------------------------------ regresi pengerasan kit deploy
describe('Nginx: server default menolak Host/SNI tak dikenal (return 444)', () => {
  const blocks = serverBlocks(NGINX);
  const isDefault = (b, port) => b.top.some((d) => new RegExp(`^listen (\\[::\\]:)?${port}\\b.*\\bdefault_server$`).test(d));

  it('ai-office.conf punya 4 blok server: default 80, default 443, app 80, app 443', () => {
    expect(blocks).toHaveLength(4);
    expect(blocks.filter((b) => isDefault(b, 80))).toHaveLength(1);
    expect(blocks.filter((b) => isDefault(b, 443))).toHaveLength(1);
    expect(blocks.filter((b) => b.top.includes('server_name __DOMAIN__'))).toHaveLength(2);
  });

  it.each([80, 443])('default_server :%i (IPv4 + IPv6) → return 444, tanpa server_name/proxy/location', (port) => {
    const b = blocks.find((x) => isDefault(x, port));
    expect(b).toBeDefined();
    const listens = b.top.filter((d) => d.startsWith('listen '));
    expect(listens.some((d) => d.startsWith(`listen ${port} `)), 'IPv4').toBe(true);
    expect(listens.some((d) => d.startsWith(`listen [::]:${port} `)), 'IPv6').toBe(true);
    expect(listens.every((d) => d.endsWith('default_server'))).toBe(true);
    expect(b.top).toContain('return 444');
    expect(b.body).not.toMatch(/proxy_pass|server_name|location/);
  });

  it('default_server :443 menolak handshake TLS (ssl_reject_handshake on) dengan TLS sama seperti app', () => {
    const b = blocks.find((x) => isDefault(x, 443));
    const app = blocks.find((x) => x.top.includes('server_name __DOMAIN__') && x.top.some((d) => d.startsWith('listen 443')));
    expect(b.top).toContain('ssl_reject_handshake on');
    for (const key of ['ssl_protocols', 'ssl_ciphers', 'ssl_session_cache', 'ssl_session_tickets']) {
      expect(b.top.find((d) => d.startsWith(`${key} `)), key).toBe(app.top.find((d) => d.startsWith(`${key} `)));
    }
  });

  it('server aplikasi (server_name __DOMAIN__) tidak memakai default_server', () => {
    for (const b of blocks.filter((x) => x.top.includes('server_name __DOMAIN__'))) {
      expect(b.top.filter((d) => d.startsWith('listen ')).some((d) => d.includes('default_server'))).toBe(false);
    }
  });

  it('konfigurasi http-only juga punya default_server :80 → 444', () => {
    const hb = serverBlocks(NGINX_HTTP_ONLY);
    const def = hb.filter((b) => isDefault(b, 80));
    expect(def).toHaveLength(1);
    expect(def[0].top).toContain('return 444');
  });

  it.each([
    ['ai-office.conf', () => serverBlocks(NGINX)],
    ['ai-office-http-only.conf', () => serverBlocks(NGINX_HTTP_ONLY)],
  ])('%s: setiap blok server memakai server_tokens off', (_f, get) => {
    const bs = get();
    expect(bs.length).toBeGreaterThanOrEqual(2);
    for (const b of bs) expect(b.top).toContain('server_tokens off');
  });
});

describe('Nginx: batas laju /api/ (lewat map) dan /ws (limit_req + limit_conn)', () => {
  const code = nginxCode(NGINX).replace(/[ \t]+/g, ' ');
  const locs = locations(NGINX);
  const proxyRoot = [...nginxCode(NGINX).matchAll(/location\s+\/\s*\{([^{}]*)\}/g)].map((m) => directives(m[1])).find((d) => d.includes('proxy_pass http://aioffice_app'));

  it('map $uri → kunci hanya untuk /api/* (UI dan aset tidak dihitung)', () => {
    expect(code).toMatch(/map \$uri \$aioffice_api_limit_key \{\s*default "";\s*~\^\/api\/ \$binary_remote_addr;\s*\}/);
    expect(code).toMatch(/limit_req_zone \$aioffice_api_limit_key zone=aioffice_api:\d+m rate=\d+r\/s;/);
  });

  it('location / (proxy) memakai zona aioffice_api', () => {
    expect(proxyRoot).toBeDefined();
    expect(proxyRoot.some((d) => /^limit_req zone=aioffice_api\b/.test(d))).toBe(true);
  });

  it('/ws: limit_req zona aioffice_ws dan limit_conn aioffice_ws_conn', () => {
    const d = directives(locs['/ws']);
    expect(d.some((x) => /^limit_req zone=aioffice_ws\b/.test(x))).toBe(true);
    const conn = d.find((x) => x.startsWith('limit_conn '));
    expect(conn).toMatch(/^limit_conn aioffice_ws_conn \d+$/);
    expect(Number(conn.split(' ').at(-1))).toBeGreaterThanOrEqual(1);
    expect(code).toMatch(/limit_req_zone \$binary_remote_addr zone=aioffice_ws:\d+m rate=\d+r\/[sm];/);
    expect(code).toMatch(/limit_conn_zone \$binary_remote_addr zone=aioffice_ws_conn:\d+m;/);
  });

  it('status 429 untuk limit_req dan limit_conn di server HTTPS', () => {
    const app = serverBlocks(NGINX).find((x) => x.top.includes('server_name __DOMAIN__') && x.top.some((d) => d.startsWith('listen 443')));
    expect(app.top).toContain('limit_req_status 429');
    expect(app.top).toContain('limit_conn_status 429');
  });

  it('setiap zona yang dipakai didefinisikan, dan setiap zona yang didefinisikan dipakai', () => {
    const defined = new Set([...code.matchAll(/limit_(?:req|conn)_zone \S+ zone=(\w+):/g)].map((m) => m[1]));
    const used = new Set([
      ...[...code.matchAll(/limit_req zone=(\w+)/g)].map((m) => m[1]),
      ...[...code.matchAll(/limit_conn (\w+) \d+;/g)].map((m) => m[1]),
    ]);
    expect([...used].sort()).toEqual([...defined].sort());
    expect([...defined].sort()).toEqual(['aioffice_api', 'aioffice_login', 'aioffice_ws', 'aioffice_ws_conn']);
  });
});

describe('systemd: batas sumber daya', () => {
  const lines = UNIT.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const value = (key) => lines.find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);
  const mb = (v) => {
    const m = /^(\d+)([KMG])$/.exec(v ?? '');
    return m ? Number(m[1]) * { K: 1 / 1024, M: 1, G: 1024 }[m[2]] : NaN;
  };

  it('MemoryMax dan TasksMax ada dengan nilai wajar untuk VPS 1 GB; MemoryHigh < MemoryMax', () => {
    expect(value('MemoryMax')).toMatch(/^\d+[KMG]$/);
    expect(mb(value('MemoryMax'))).toBeGreaterThanOrEqual(128);
    expect(mb(value('MemoryMax'))).toBeLessThanOrEqual(768);
    expect(mb(value('MemoryHigh'))).toBeLessThan(mb(value('MemoryMax')));
    expect(value('TasksMax')).toMatch(/^\d+$/);
    expect(Number(value('TasksMax'))).toBeGreaterThanOrEqual(32); // Node butuh ~10-15 thread
    expect(Number(value('TasksMax'))).toBeLessThanOrEqual(512);
  });

  it('batas ada di bagian [Service]', () => {
    const service = UNIT.slice(UNIT.indexOf('[Service]'), UNIT.indexOf('[Install]'));
    expect(service).toMatch(/^MemoryMax=/m);
    expect(service).toMatch(/^TasksMax=/m);
  });
});

describe('setup-vps.sh: UFW dan kunci NodeSource', () => {
  const SETUP = read('deploy/setup-vps.sh');
  const code = bashCode(SETUP);

  it('SSH memakai "ufw limit 22/tcp" (dibatasi laju), bukan allow; diatur sebelum ufw diaktifkan', () => {
    expect(code).toMatch(/^\s*ufw limit 22\/tcp\b/m);
    expect(code).not.toMatch(/\bufw\s+allow\s+(?:22\b|ssh\b|openssh\b)/i);
    expect(code.indexOf('ufw limit 22/tcp')).toBeLessThan(code.indexOf('ufw --force enable'));
    expect(code).toMatch(/^\s*ufw allow 80\/tcp\b/m);
    expect(code).toMatch(/^\s*ufw allow 443\/tcp\b/m);
    expect(code).toMatch(/^\s*ufw default deny incoming$/m);
  });

  it('fingerprint NodeSource bawaan: 40 heksadesimal huruf besar, divalidasi, sama dengan docs', () => {
    const m = /^NODESOURCE_GPG_FPR_DEFAULT="([^"]*)"$/m.exec(SETUP);
    expect(m).not.toBeNull();
    expect(m[1]).toMatch(/^[0-9A-F]{40}$/);
    expect(code).toContain('[[ "$expected" =~ ^[0-9A-F]{40}$ ]]');
    expect(code).toMatch(/NODESOURCE_KEY_URL="https:\/\//);
    const docFpr = [...DOC.matchAll(/^([0-9A-F]{4}(?: {1,2}[0-9A-F]{4}){9})$/gm)].map((x) => x[1].replace(/\s+/g, ''));
    expect(docFpr).toEqual([m[1]]);
  });
});

describe('docs/DEPLOY.md: klaim log sesuai perilaku', () => {
  it('tidak lagi memuat "tidak ditulis ke disk"', () => {
    expect(DOC).not.toMatch(/tidak ditulis ke disk/i);
  });

  it('menjelaskan log default metadata dan AI_OFFICE_LOG_MESSAGES=1 untuk isi pesan', () => {
    expect(DOC).toMatch(/AI_OFFICE_LOG_MESSAGES=1/);
    expect(DOC).toMatch(/metadata/);
  });
});
