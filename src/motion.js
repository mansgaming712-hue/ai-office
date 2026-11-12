// Gerak berbasis waktu: easing, kecepatan dengan percepatan/pengereman, langkah di sepanjang jalur,
// dan preferensi reduced motion. Fungsi murni tanpa DOM supaya bisa dites di Node.

export const clamp = (v, a, b) => (Number.isNaN(v) ? a : Math.max(a, Math.min(b, v)));
export const clamp01 = (v) => clamp(v, 0, 1);

export const easeOutCubic = (t) => 1 - (1 - clamp01(t)) ** 3;
export const easeInOutQuad = (t) => {
  const x = clamp01(t);
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
};
/** Muncul dengan sedikit membal (untuk bubble dan penanda status). Nilai bisa sedikit > 1. */
export const easeOutBack = (t) => {
  const x = clamp01(t);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2;
};

/**
 * Kecepatan berikutnya untuk gerak dengan ease-in di awal dan ease-out di akhir.
 * Batas atas = min(target, kecepatan terbesar yang masih bisa berhenti dalam `remaining`),
 * jadi karakter melambat menjelang tujuan. `minSpeed` mencegah macet sebelum sampai.
 */
export function nextSpeed({ speed, target, remaining, dt, accel = 520, decel = 520, minSpeed = 14 }) {
  const brakeCap = Math.sqrt(2 * decel * Math.max(0, remaining));
  const cap = Math.min(target, Math.max(minSpeed, brakeCap));
  const s = Math.max(0, speed);
  return s < cap ? Math.min(cap, s + accel * dt) : Math.max(cap, s - decel * dt);
}

/** Panjang jalur dari `from` melewati semua titik `path`. */
export function remainingLength(from, path) {
  let len = 0;
  let x = from.x;
  let y = from.y;
  for (const p of path) {
    len += Math.hypot(p.x - x, p.y - y);
    x = p.x;
    y = p.y;
  }
  return len;
}

/**
 * Maju sejauh `budget` piksel menyusuri `path` (titik-titik tujuan berurutan). Tidak pernah melewati
 * titik terakhir, berapa pun besar `budget`. Mengembalikan posisi baru, sisa jalur, jarak yang
 * ditempuh, dan arah hadap terakhir (null bila tidak bergerak).
 */
export function advanceAlongPath(from, path, budget) {
  let { x, y } = from;
  let moved = 0;
  let facing = null;
  let left = Math.max(0, budget);
  let i = 0;
  while (left > 0 && i < path.length) {
    const p = path[i];
    const dx = p.x - x;
    const dy = p.y - y;
    const d = Math.hypot(dx, dy);
    if (d > 0.01) facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
    if (d <= left) {
      x = p.x;
      y = p.y;
      moved += d;
      left -= d;
      i++;
    } else {
      x += (dx / d) * left;
      y += (dy / d) * left;
      moved += left;
      left = 0;
    }
  }
  return { x, y, path: path.slice(i), moved, facing };
}

/** Batas langkah waktu satu frame (detik): tab yang tertidur tidak menghasilkan lompatan besar. */
export const MAX_FRAME_DT = 0.1;
export const frameDelta = (nowMs, lastMs) => clamp((nowMs - lastMs) / 1000, 0, MAX_FRAME_DT);

// ------------------------------------------------------------------ reduced motion

const QUERY = '(prefers-reduced-motion: reduce)';

/** true bila pengguna meminta gerak dikurangi. Tanpa matchMedia: false. */
export function prefersReducedMotion(win = globalThis.window) {
  try {
    return Boolean(win?.matchMedia?.(QUERY).matches);
  } catch {
    return false;
  }
}

/** Pantau perubahan preferensi. Mengembalikan fungsi untuk berhenti. */
export function watchReducedMotion(callback, win = globalThis.window) {
  let mq = null;
  try {
    mq = win?.matchMedia?.(QUERY) ?? null;
  } catch {
    mq = null;
  }
  if (!mq) return () => {};
  const handler = (e) => callback(Boolean(e.matches));
  mq.addEventListener?.('change', handler);
  return () => mq.removeEventListener?.('change', handler);
}
