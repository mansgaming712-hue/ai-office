// Rasio kontras WCAG 2.x. Dipakai test untuk menjaga palet kanvas dan token CSS tetap AA.

function parse(hex) {
  const h = String(hex).trim().replace('#', '');
  const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function luminance(hex) {
  const [r, g, b] = parse(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Campur `fg` di atas `bg` dengan opasitas `alpha` → hex. */
export function blend(fg, bg, alpha) {
  const f = parse(fg);
  const b = parse(bg);
  const out = f.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
