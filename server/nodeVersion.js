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

/**
 * Kode bahasa pengguna: 'id' atau 'en'. Sintaks lama dan tanpa impor (modul ini harus tetap bisa dimuat di Node tua).
 * Urutan sama dengan shared/i18n.js: AI_OFFICE_LANG, LC_ALL, LC_MESSAGES, LANG, lalu Intl; nilai kosong, C, dan POSIX dilewati.
 */
export function pickLang(env) {
  var keys = ['AI_OFFICE_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG'];
  var value = '';
  for (var i = 0; i < keys.length && !value; i++) {
    var v = env && typeof env[keys[i]] === 'string' ? env[keys[i]].trim() : '';
    if (v && v !== 'C' && v !== 'POSIX') value = v;
  }
  if (!value) {
    try {
      value = Intl.DateTimeFormat().resolvedOptions().locale;
    } catch (e) {
      value = '';
    }
  }
  var m = /^([a-z]{2,3})(?:[-_.@]|$)/i.exec(String(value).trim());
  var code = m ? m[1].toLowerCase() : '';
  return code === 'id' || code === 'in' || code === 'ind' ? 'id' : 'en';
}

/** Pesan galat untuk pengguna (Indonesia atau Inggris menurut pickLang), atau null bila versinya cukup. */
export function nodeVersionProblem(version, min, lang) {
  var need = min || MIN_NODE;
  if (isNodeSupported(version, need)) return null;
  var shortNeed = need.replace(/\.0$/, '');
  var have = String(version).replace(/^v/, '');
  if ((lang || pickLang(process.env)) === 'id') {
    return (
      'AI Office membutuhkan Node.js ' + shortNeed + ' atau lebih baru, tetapi yang terpasang v' + have + '.\n' +
      'Cara upgrade: pasang Node.js LTS terbaru dari https://nodejs.org, atau lewat pengelola versi ' +
      '(nvm, fnm, Volta; Windows: winget install OpenJS.NodeJS.LTS; macOS: brew install node), lalu buka terminal baru.'
    );
  }
  return (
    'AI Office needs Node.js ' + shortNeed + ' or newer, but v' + have + ' is installed.\n' +
    'How to upgrade: install the latest Node.js LTS from https://nodejs.org, or use a version manager ' +
    '(nvm, fnm, Volta; Windows: winget install OpenJS.NodeJS.LTS; macOS: brew install node), then open a new terminal.'
  );
}
