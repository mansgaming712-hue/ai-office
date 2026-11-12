// Ukuran kanvas kantor: muat di ruang yang tersedia dengan rasio tetap. Di layar besar, skala dibulatkan
// ke kelipatan bulat piksel perangkat (piksel pixel-art sama besar, tajam) selama kehilangan ruangnya kecil.
import { H, W } from './layout.js';

/** Ruang yang dipakai bingkai (border + bayangan) di sekeliling kanvas, per sumbu, dalam px CSS. */
export const FRAME_PAD = 24;
export const FRAME_PAD_COMPACT = 12; // layar sempit (satu kolom): bingkai lebih tipis
export const COMPACT_QUERY = '(max-width: 960px)';
export const MIN_CANVAS_CSS = 240;
export const SNAP_FROM_SCALE = 2; // di bawah 2x tidak dibulatkan (layar kecil: pakai semua ruang)
export const SNAP_MIN_CSS = 900; // lebar kanvas di bawah ini (ponsel, tablet) tidak pernah dibulatkan
export const MAX_SNAP_LOSS = 0.12; // dibulatkan hanya jika kanvas menyusut ≤ 12%

/**
 * @param {{availW:number, availH:number, dpr?:number, logicalW?:number, logicalH?:number}} o
 * @returns {{cssW:number, cssH:number, scale:number, snapped:boolean}} scale = piksel perangkat per piksel logis
 */
export function fitCanvas({ availW, availH, dpr = 1, logicalW = W, logicalH = H }) {
  const d = dpr > 0 ? dpr : 1;
  const fitW = Math.max(MIN_CANVAS_CSS, Math.min(availW, (availH * logicalW) / logicalH));
  const rawScale = (fitW * d) / logicalW;
  if (fitW >= SNAP_MIN_CSS && rawScale >= SNAP_FROM_SCALE) {
    const whole = Math.floor(rawScale);
    if ((rawScale - whole) / rawScale <= MAX_SNAP_LOSS) {
      return { cssW: (logicalW * whole) / d, cssH: (logicalH * whole) / d, scale: whole, snapped: true };
    }
  }
  const cssW = Math.floor(fitW);
  return { cssW, cssH: Math.floor((cssW * logicalH) / logicalW), scale: rawScale, snapped: false };
}
