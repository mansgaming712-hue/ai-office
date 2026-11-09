// Helper host/alamat tanpa dependensi (dipakai server dan hooks/send-event.mjs).
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isLoopbackHost(host) {
  return LOOPBACK.has(String(host).toLowerCase());
}

/**
 * Ambil hostname dari nilai URL-ish ("localhost:3000" → "localhost", "https://a.example" → "a.example").
 * Longgar (memakai parser URL: "user@host" dan "host/path" ikut diterima), jadi hanya untuk Origin dan
 * konfigurasi. Header Host divalidasi dengan parseHostHeader.
 */
export function hostnameOf(value) {
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

// Header Host yang sah: nama domain / IPv4 (huruf, angka, - _ .) atau IPv6 dalam kurung siku,
// opsional diikuti :port. Karakter lain (mis. ";" atau spasi) ditolak, supaya nilainya aman
// disisipkan ke header lain (CSP) dan dibandingkan dengan Origin.
const HOST_HEADER_RE = /^(?:([a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?)|\[([0-9a-f:.]+)\])(?::(\d{1,5}))?$/i;

/**
 * Validasi ketat header Host. Hasil: { hostname, port, host } (huruf kecil; `host` = hostname
 * dengan kurung siku untuk IPv6 + ":port" bila ada) atau null bila tidak sah.
 */
export function parseHostHeader(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  const m = HOST_HEADER_RE.exec(value);
  if (!m) return null;
  const port = m[3] ?? '';
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  const hostname = (m[1] ?? m[2]).toLowerCase();
  const bracketed = m[2] !== undefined ? `[${hostname}]` : hostname;
  return { hostname, port, host: port ? `${bracketed}:${port}` : bracketed };
}

/**
 * Pathname dari target request (req.url), atau null bila bentuknya ditolak (server menjawab 400).
 * Tujuannya: Node dan Nginx harus melihat path yang sama, supaya location / limit_req /api/ dan /ws
 * di Nginx tidak bisa dilewati. "Bagian path" = sebelum "?" atau "#" pertama (Node dan Nginx sepakat).
 *   - Wajib origin-form: diawali "/". Bentuk lain (absolute-form "http://h/x", "*") ditolak.
 *   - Tanpa "//" di bagian path (termasuk di awal). Nginx (merge_slashes on) menggabungkan "//" menjadi
 *     "/" SEBELUM menyelesaikan "..", sedangkan Node tidak: "/api//../events" bagi Node = /api/events,
 *     bagi Nginx = /events (di luar location /api/, jadi limit_req terlewati). Di awal, "//host/x" juga
 *     diartikan Node sebagai URL protocol-relative ("//evil/api/events" → /api/events) dan "//[" dulu
 *     melempar error (500 + stack trace di log).
 *   - Tanpa "%2f" (huruf besar/kecil) di bagian path: Nginx mendekode "%2F" menjadi "/" lalu
 *     menyelesaikan ".." ("/a%2fb/../api/events" → Nginx /a/api/events), Node tidak (→ /api/events).
 *   - Tanpa "\" di mana pun (termasuk query) dan tanpa "%5c" di bagian path: parser URL Node mengartikan
 *     "\" sebagai "/" ("/api\events" → /api/events), sedangkan di Nginx Linux "\" karakter biasa dan
 *     "%5c" didekode menjadi "\". "\" di query sebenarnya tidak memengaruhi pathname, tetapi tetap
 *     ditolak: UI dan hook AI Office tidak pernah mengirimnya, dan aturan "tidak ada \ sama sekali"
 *     lebih mudah diaudit (test regresi B3 mengunci perilaku ini).
 *   - Tanpa karakter kontrol, spasi, atau DEL (0x00-0x20, 0x7f) di mana pun: parser URL WHATWG diam-diam
 *     membuang tab/CR/LF ("/api/ev<TAB>ents" → /api/events), jadi pemeriksaan di atas bisa dilewati dengan
 *     menyisipkan karakter itu ("/<TAB>/evil", "%<TAB>2f"). Parser HTTP Node sudah menolaknya, ini lapisan kedua.
 *   - URL yang tidak bisa diurai juga ditolak.
 */
export function requestPathname(url) {
  if (typeof url !== 'string' || /[\x00-\x20\x7f]/.test(url)) return null;
  if (url[0] !== '/' || url.includes('\\')) return null;
  const q = url.search(/[?#]/);
  const path = q < 0 ? url : url.slice(0, q);
  if (path.includes('//') || /%(?:5c|2f)/i.test(path)) return null;
  try {
    return new URL(url, 'http://x').pathname;
  } catch {
    return null;
  }
}
