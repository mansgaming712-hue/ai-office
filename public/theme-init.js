/* Pasang tema sebelum render pertama (dimuat sinkron di <head>, jadi tidak ada kilatan tema salah).
   Skrip klasik dari 'self' (CSP: script-src 'self'). Logikanya harus sama dengan src/theme.js
   (resolveTheme); tests/theme.test.js menjalankan file ini dan membandingkannya. */
(function () {
  var theme = 'dark';
  try {
    var saved = window.localStorage.getItem('ai-office-theme');
    if (saved === 'dark' || saved === 'light') {
      theme = saved;
    } else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches === false) {
      theme = 'light';
    }
  } catch (e) {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches === false) theme = 'light';
    } catch (e2) {
      /* tetap gelap */
    }
  }
  document.documentElement.setAttribute('data-theme', theme);
})();
