// Canvas palsu untuk test renderer: mencatat SETIAP perintah gambar (nama, argumen) dan setiap pengubahan
// properti (fillStyle, globalAlpha, font, ...) sebagai teks, supaya hasil gambar bisa dibandingkan lewat hash.
import { createHash } from 'node:crypto';

const show = (v) => {
  if (v && typeof v === 'object' && 'width' in v && 'getContext' in v) return `canvas(${v.width}x${v.height})`;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
  return typeof v === 'string' ? JSON.stringify(v) : String(v);
};

/** Konteks pencatat: `log` diisi baris teks. `measureText` memberi lebar tetap (deterministik). */
export function recordingCtx(log) {
  const state = {};
  return new Proxy(state, {
    get(t, k) {
      if (typeof k === 'symbol') return undefined;
      if (k in t) return t[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 3.5 });
      return (...args) => void log.push(`${k}(${args.map(show).join(',')})`);
    },
    set(t, k, v) {
      t[k] = v;
      log.push(`set ${k}=${show(v)}`);
      return true;
    },
  });
}

/** Pabrik canvas palsu; setiap canvas punya `log`. `all` berisi semua canvas yang dibuat (berurutan). */
export function canvasFactory() {
  const all = [];
  const make = (w = 1, h = 1) => {
    const log = [];
    const ctx = recordingCtx(log);
    const c = { width: w, height: h, log, getContext: () => ctx };
    all.push(c);
    return c;
  };
  return { make, all };
}

export const sha = (lines) => createHash('sha256').update(lines.join('\n')).digest('hex');
