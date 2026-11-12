// Pembanding versi Node. SENGAJA hanya memakai sintaks lama (var, fungsi biasa, tanpa ?. atau ??),
// supaya modul ini tetap bisa dimuat di Node tua dan sempat mencetak pesan yang jelas.
export var MIN_NODE = '20.12.0';

/** "v20.12.0" / "20.12" / "22.x" -> [20, 12, 0]; null bila tidak bisa dibaca. Bagian yang hilang atau "x" dianggap 0. */
export function parseVersion(text) {
  var m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?/i.exec(String(text).trim());
  if (!m) return null;
  var num = function (s) {
    return s === undefined || !/^\d+$/.test(s) ? 0 : parseInt(s, 10);
  };
  return [parseInt(m[1], 10), num(m[2]), num(m[3])];
}

/** -1, 0, atau 1; null bila salah satu versi tidak bisa dibaca. */
export function compareVersions(a, b) {
  var x = parseVersion(a);
  var y = parseVersion(b);
  if (!x || !y) return null;
  for (var i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** True bila `version` >= `min`. Versi yang tidak bisa dibaca dianggap cukup (tidak memblokir). */
export function isNodeSupported(version, min) {
  var c = compareVersions(version, min || MIN_NODE);
  return c === null ? true : c >= 0;
}

/**
 * Toolchain dev lebih baru daripada runtime: build UI (vite 8) butuh Node ^20.19 atau >=22.12,
 * test (vitest 5) butuh Node >=22.12. `kind` = 'build' atau 'test'.
 * Versi yang tidak bisa dibaca dianggap cukup (tidak memblokir).
 */
export function isToolchainNodeSupported(version, kind) {
  var v = parseVersion(version);
  if (!v) return true;
  if (kind !== 'test' && v[0] === 20) return compareVersions(version, '20.19.0') >= 0;
  return compareVersions(version, '22.12.0') >= 0;
}

/** Pesan galat untuk `npm run build` / `npm test` di Node yang terlalu lama, atau null bila cukup. */
export function toolchainNodeProblem(version, kind) {
  if (isToolchainNodeSupported(version, kind)) return null;
  var what = kind === 'test' ? 'Menjalankan test (vitest)' : 'Build UI (vite)';
  var need = kind === 'test' ? 'Node.js 22.12 atau lebih baru' : 'Node.js 20.19 (seri 20) atau 22.12 dan lebih baru';
  return (
    what + ' membutuhkan ' + need + ', tetapi yang terpasang v' + String(version).replace(/^v/, '') + '.\n' +
    'Server dan hook AI Office sendiri cukup dengan Node.js 20.12, tetapi alat build dan test butuh versi lebih baru.\n' +
    'Pasang Node.js LTS terbaru dari https://nodejs.org (atau lewat nvm, fnm, Volta), lalu buka terminal baru.'
  );
}

/** Pesan galat untuk pengguna (bahasa Indonesia), atau null bila versinya cukup. */
export function nodeVersionProblem(version, min) {
  var need = min || MIN_NODE;
  if (isNodeSupported(version, need)) return null;
  return (
    'AI Office membutuhkan Node.js ' + need.replace(/\.0$/, '') + ' atau lebih baru, tetapi yang terpasang v' +
    String(version).replace(/^v/, '') + '.\n' +
    'Cara upgrade: pasang Node.js LTS terbaru dari https://nodejs.org, atau lewat pengelola versi ' +
    '(nvm, fnm, Volta; Windows: winget install OpenJS.NodeJS.LTS; macOS: brew install node), lalu buka terminal baru.'
  );
}
