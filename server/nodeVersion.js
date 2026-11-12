// Pembanding versi Node. SENGAJA hanya memakai sintaks lama (var, fungsi biasa, tanpa ?. atau ??),
// supaya modul ini tetap bisa dimuat di Node tua dan sempat mencetak pesan yang jelas.
export var MIN_NODE = '22.12.0';

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
