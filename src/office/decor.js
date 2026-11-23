// Dekorasi latar dari kosakata tetap tema (shared/themes.js DECOR_VOCAB): lantai, dinding, lampu, langit non-kota,
// tanaman, poster, isi pantry, dan sprite props. Semua digambar sekali ke latar yang di-cache (scene.js drawBackground).
// Tema Jakarta memakai gaya bawaan (wood/plain/city/leafy/classic/kopi/none) yang digambar langsung di scene.js
// supaya hasilnya tidak berubah; modul ini hanya untuk gaya lain.
import { H, MEETING, W, WALL_H, WINDOWS } from './layout.js';

const rect = (ctx, x, y, w, h, color) => {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
};
const rgbaOf = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const disc = (ctx, cx, cy, r, color) => {
  for (let dy = -r; dy <= r; dy++) {
    const w = Math.floor(Math.sqrt(r * r - dy * dy));
    rect(ctx, cx - w, cy + dy, 2 * w + 1, 1, color);
  }
};

const WALL_BODY = WALL_H - 4; // tinggi dinding di atas lis bawah
const SKY_X0 = WINDOWS[0].x;
const SKY_X1 = WINDOWS.at(-1).x + WINDOWS.at(-1).w;
const SKY_TOP = WINDOWS[0].y;
const GROUND = WINDOWS[0].y + WINDOWS[0].h - 4;

/** Titik pasang sprite props: pusat (center) atau tengah-bawah (bottom). Harus sama dengan PROP_SLOTS di shared/themes.js. */
export const PROP_ANCHORS = Object.freeze({
  'wall-left': { x: 26, y: 16, anchor: 'center' }, // dinding di atas pintu masuk
  'floor-left': { x: 30, y: 126, anchor: 'bottom' }, // lantai kiri, di bawah pintu
  'floor-center': { x: 240, y: 128, anchor: 'bottom' }, // lantai di bawah karpet manajer
});

// ------------------------------------------------------------------ lantai (selain kayu)

export function drawFloorStyle(ctx, P, style, rnd) {
  const h = H - WALL_H;
  if (style === 'tile') {
    for (let y = WALL_H; y < H; y += 16) rect(ctx, 0, y, W, 1, P.floorLine);
    for (let x = 0; x < W; x += 16) rect(ctx, x, WALL_H, 1, h, P.floorLine);
    for (let y = WALL_H; y < H; y += 16) for (let x = 0; x < W; x += 16) rect(ctx, x + 2, y + 2, 3, 1, P.floorTick);
  } else if (style === 'checker') {
    for (let y = WALL_H, cy = 0; y < H; y += 8, cy++) {
      for (let x = (cy % 2) * 8; x < W; x += 16) rect(ctx, x, y, 8, 8, P.floorLine);
    }
  } else if (style === 'metal') {
    for (let y = WALL_H, row = 0; y < H; y += 16, row++) {
      rect(ctx, 0, y, W, 1, P.floorLine);
      for (let x = (row % 2) * 16; x < W; x += 32) {
        rect(ctx, x, y, 1, 16, P.floorLine);
        rect(ctx, x + 2, y + 2, 2, 2, P.floorTick); // paku keling
        rect(ctx, x + 28, y + 12, 2, 2, P.floorTick);
      }
    }
  } else if (style === 'carpet') {
    for (let y = WALL_H; y < H; y += 3) {
      for (let x = 0; x < W; x += 3) {
        const r = rnd(x * 131 + y * 17);
        if (r < 0.34) rect(ctx, x + Math.floor(r * 9), y, 1, 1, P.floorTick);
        else if (r > 0.96) rect(ctx, x, y, 2, 1, P.floorLine);
      }
    }
  }
}

// ------------------------------------------------------------------ dinding

export function drawWallStyle(ctx, P, style, rnd) {
  if (style === 'stripe') {
    for (let x = 0; x < W; x += 16) rect(ctx, x, 0, 8, WALL_BODY, rgbaOf('#ffffff', 0.1));
    for (let x = 8; x < W; x += 16) rect(ctx, x, 0, 1, WALL_BODY, rgbaOf('#000000', 0.07));
  } else if (style === 'brick') {
    for (let y = 0, row = 0; y < WALL_BODY; y += 4, row++) {
      rect(ctx, 0, y, W, 1, rgbaOf('#000000', 0.16));
      for (let x = (row % 2) * 6; x < W; x += 12) {
        rect(ctx, x, y, 1, 4, rgbaOf('#000000', 0.16));
        const r = rnd(x * 7 + y * 13);
        if (r < 0.25) rect(ctx, x + 1, y + 1, 11, 3, rgbaOf('#ffffff', 0.07));
        else if (r > 0.85) rect(ctx, x + 1, y + 1, 11, 3, rgbaOf('#000000', 0.08));
      }
    }
  } else if (style === 'panel') {
    for (let x = 0; x < W; x += 40) {
      rect(ctx, x, 0, 1, WALL_BODY, rgbaOf('#000000', 0.2));
      rect(ctx, x + 1, 0, 1, WALL_BODY, rgbaOf('#ffffff', 0.09));
      rect(ctx, x + 5, 3, 1, 1, rgbaOf('#ffffff', 0.28));
      rect(ctx, x + 5, WALL_BODY - 5, 1, 1, rgbaOf('#ffffff', 0.28));
    }
    rect(ctx, 0, WALL_BODY - 14, W, 1, rgbaOf('#000000', 0.15));
  } else if (style === 'circuit') {
    for (let x = 0; x < W; x += 24) rect(ctx, x, 0, 1, WALL_BODY, rgbaOf('#000000', 0.12));
    for (let i = 0; i < 30; i++) {
      const x = Math.floor(rnd(i * 5 + 1) * (W - 50));
      const y = 4 + Math.floor(rnd(i * 5 + 2) * (WALL_BODY - 14));
      const len = 8 + Math.floor(rnd(i * 5 + 3) * 34);
      const dv = 4 + Math.floor(rnd(i * 5 + 4) * 10);
      rect(ctx, x, y, len, 1, rgbaOf(P.accentA, 0.42));
      rect(ctx, x + len, y, 1, dv, rgbaOf(P.accentA, 0.42));
      rect(ctx, x - 1, y - 1, 3, 3, rgbaOf(P.accentB, 0.7));
      rect(ctx, x + len - 1, y + dv - 1, 3, 3, rgbaOf(P.accentB, 0.7));
    }
  }
}

// ------------------------------------------------------------------ lampu

export function drawLights(ctx, P, style) {
  if (style === 'fairy') {
    const cols = [P.accentA, P.accentB, P.accentC];
    const wire = (x) => 1 + Math.round(1.5 + 1.5 * Math.sin((x / 10) * Math.PI));
    for (let x = 0; x < W; x++) rect(ctx, x, wire(x), 1, 1, rgbaOf('#000000', 0.4));
    for (let x = 5, i = 0; x < W; x += 10, i++) {
      const y = wire(x);
      rect(ctx, x - 1, y, 4, 4, rgbaOf(cols[i % 3], 0.28));
      rect(ctx, x, y + 1, 2, 2, cols[i % 3]);
    }
  } else if (style === 'neon') {
    rect(ctx, 0, 0, W, 2, P.accentB);
    rect(ctx, 0, 2, W, 2, rgbaOf(P.accentB, 0.3));
    rect(ctx, 0, WALL_H - 10, W, 1, P.accentA);
    rect(ctx, 0, WALL_H - 9, W, 1, rgbaOf(P.accentA, 0.3));
    rect(ctx, 0, WALL_H - 11, W, 1, rgbaOf(P.accentA, 0.3));
  } else if (style === 'pendant') {
    for (const x of [46, 178, 238, 304, 438, 560]) {
      rect(ctx, x, 0, 1, 3, P.outline);
      rect(ctx, x - 4, 3, 9, 2, P.accentA);
      rect(ctx, x - 3, 5, 7, 1, P.accentC);
      rect(ctx, x - 6, 6, 13, 2, rgbaOf(P.accentC, 0.25));
    }
  } else if (style === 'strip') {
    rect(ctx, 0, 0, W, 1, P.accentA);
    rect(ctx, 0, 1, W, 1, rgbaOf(P.accentA, 0.45));
    rect(ctx, 0, 2, W, 2, rgbaOf(P.accentA, 0.14));
    rect(ctx, 0, WALL_H - 5, W, 1, rgbaOf(P.accentA, 0.5));
  }
}

// ------------------------------------------------------------------ langit (di dalam klip jendela)

/** Matahari (siang) atau bulan (malam) untuk langit non-kota. */
function celestial(ctx, P, bx, bxNight) {
  if (P.night) {
    rect(ctx, bxNight, SKY_TOP + 5, 5, 5, P.sun);
    rect(ctx, bxNight - 1, SKY_TOP + 6, 7, 3, P.sun);
    rect(ctx, bxNight + 2, SKY_TOP + 5, 3, 4, P.skyTop); // sabit
  } else {
    rect(ctx, bx - 3, SKY_TOP + 1, 12, 12, rgbaOf(P.sun, 0.3));
    rect(ctx, bx, SKY_TOP + 4, 6, 6, P.sun);
    rect(ctx, bx + 1, SKY_TOP + 3, 4, 8, P.sun);
  }
}

function sprinkleStars(ctx, P, rnd, n, spread = 20) {
  for (let i = 0; i < n; i++) {
    const sx = SKY_X0 + Math.floor(rnd(i * 5 + 1) * (SKY_X1 - SKY_X0));
    const sy = SKY_TOP + Math.floor(rnd(i * 5 + 2) * spread);
    rect(ctx, sx, sy, 1, 1, i % 4 === 0 ? P.accentC : P.star);
  }
}

export function drawHillsSky(ctx, P, rnd) {
  if (P.night) sprinkleStars(ctx, P, rnd, 34);
  celestial(ctx, P, 394, 150);
  const far = (x) => 7 + Math.round(5 * Math.sin(x * 0.045 + 1) + 3 * Math.sin(x * 0.11));
  const near = (x) => 3 + Math.round(4 * Math.sin(x * 0.03 + 2) + 2 * Math.sin(x * 0.09));
  for (let x = SKY_X0; x < SKY_X1; x++) {
    rect(ctx, x, GROUND - far(x), 1, far(x), P.farBldg);
    rect(ctx, x, GROUND - far(x), 1, 1, P.farBldgHi);
  }
  for (let x = SKY_X0; x < SKY_X1; x++) {
    rect(ctx, x, GROUND - near(x), 1, near(x), P.nearBldg);
    rect(ctx, x, GROUND - near(x), 1, 1, P.nearBldgHi);
  }
  for (let i = 0; i < 26; i++) {
    const tx = SKY_X0 + 4 + Math.floor(rnd(i * 3 + 7) * (SKY_X1 - SKY_X0 - 8));
    const ty = GROUND - near(tx);
    rect(ctx, tx, ty - 2, 1, 2, P.nearBldgLo);
    rect(ctx, tx - 1, ty - 5, 3, 3, P.nearBldgHi);
    rect(ctx, tx, ty - 6, 1, 1, P.nearBldgHi);
  }
  rect(ctx, SKY_X0, GROUND - 1, SKY_X1 - SKY_X0, 1, P.roadDim);
}

export function drawOpenSky(ctx, P, rnd) {
  if (P.night) sprinkleStars(ctx, P, rnd, 40);
  celestial(ctx, P, 380, 330);
  rect(ctx, SKY_X0, GROUND - 4, SKY_X1 - SKY_X0, 4, P.farBldg);
  rect(ctx, SKY_X0, GROUND - 4, SKY_X1 - SKY_X0, 1, P.farBldgHi);
  rect(ctx, SKY_X0, GROUND - 2, SKY_X1 - SKY_X0, 2, P.roadDim);
}

export function drawSpaceSky(ctx, P, rnd) {
  sprinkleStars(ctx, P, rnd, 120, 34);
  // planet bercincin di jendela kiri, bulan kecil dan stasiun di jendela kanan
  disc(ctx, 134, 22, 10, P.accentA);
  for (let dy = -8; dy <= 8; dy += 4) rect(ctx, 134 - 9, 22 + dy, 19, 1, rgbaOf('#000000', 0.2));
  rect(ctx, 134 - 4, 22 - 8, 4, 3, rgbaOf('#ffffff', 0.25));
  rect(ctx, 134 - 17, 22 + 1, 35, 1, P.accentC);
  rect(ctx, 134 - 15, 22 + 2, 31, 1, rgbaOf(P.accentC, 0.5));
  disc(ctx, 372, 17, 3, P.sun);
  rect(ctx, 400, 28, 10, 3, P.nearBldgHi);
  rect(ctx, 392, 27, 6, 5, P.accentB);
  rect(ctx, 412, 27, 6, 5, P.accentB);
  rect(ctx, 404, 24, 1, 4, P.nearBldgHi);
  // cakrawala planet di bawah
  const mid = (SKY_X0 + SKY_X1) / 2;
  for (let x = SKY_X0; x < SKY_X1; x++) {
    const h = Math.round(4 - (((x - mid) / 190) ** 2) * 5);
    if (h > 0) {
      rect(ctx, x, GROUND - h, 1, h, P.nearBldg);
      rect(ctx, x, GROUND - h, 1, 1, P.nearBldgHi);
    }
  }
}

// ------------------------------------------------------------------ tanaman

/** Tanaman gaya lain selain 'leafy' (leafy digambar di scene.js). */
export function drawPlantStyle(ctx, P, { x, y, w, h }, style) {
  if (style === 'cactus') {
    rect(ctx, x + 2, y + h - 6, w - 4, 6, '#b5653f');
    rect(ctx, x + 2, y + h - 6, w - 4, 1, '#cf8059');
    rect(ctx, x + 4, y + 3, 4, h - 9, '#4f9a55');
    rect(ctx, x + 5, y + 4, 1, h - 12, '#7bc27f');
    rect(ctx, x + 1, y + 7, 3, 2, '#4f9a55');
    rect(ctx, x + 1, y + 5, 2, 3, '#4f9a55');
    rect(ctx, x + 8, y + 5, 3, 2, '#4f9a55');
    rect(ctx, x + 9, y + 3, 2, 3, '#4f9a55');
    rect(ctx, x + 5, y + 2, 2, 1, P.accentC);
  } else if (style === 'crystal') {
    rect(ctx, x + 1, y + 2, w - 2, h - 8, rgbaOf(P.accentB, 0.22));
    rect(ctx, x + 2, y + h - 6, w - 4, 6, P.nearBldgLo);
    rect(ctx, x + 2, y + h - 6, w - 4, 1, P.nearBldgHi);
    rect(ctx, x + 5, y, 2, h - 6, P.accentB);
    rect(ctx, x + 3, y + 4, 2, h - 10, P.accentA);
    rect(ctx, x + 7, y + 6, 2, h - 12, P.accentC);
    rect(ctx, x + 5, y, 1, 3, '#ffffff');
  }
}

/** Tanaman sudut ruang rapat untuk gaya selain 'leafy'. */
export function drawMeetingPlant(ctx, P, style) {
  drawPlantStyle(ctx, P, { x: MEETING.x + MEETING.w - 20, y: MEETING.y + 26, w: 12, h: 26 }, style);
}

// ------------------------------------------------------------------ poster

export function drawPosterStyle(ctx, P, p, i, style) {
  const a = i === 0 ? P.accentA : P.accentB;
  rect(ctx, p.x, p.y, p.w, p.h, P.posterFrame);
  rect(ctx, p.x + 1, p.y + 1, p.w - 2, p.h - 2, P.posterPaper);
  if (style === 'neon') {
    rect(ctx, p.x - 1, p.y - 1, p.w + 2, 1, rgbaOf(a, 0.35));
    rect(ctx, p.x - 1, p.y + p.h, p.w + 2, 1, rgbaOf(a, 0.35));
    rect(ctx, p.x, p.y, p.w, 1, a);
    rect(ctx, p.x, p.y + p.h - 1, p.w, 1, a);
    rect(ctx, p.x, p.y, 1, p.h, a);
    rect(ctx, p.x + p.w - 1, p.y, 1, p.h, a);
    rect(ctx, p.x + 3, p.y + p.h - 4, p.w - 6, 1, P.accentC);
  } else {
    rect(ctx, p.x + 1, p.y + 1, p.w - 2, 3, a);
    rect(ctx, p.x + 3, p.y + p.h - 6, 5, 4, P.accentA);
    rect(ctx, p.x + 9, p.y + p.h - 6, 5, 4, P.accentB);
    rect(ctx, p.x + 15, p.y + p.h - 6, 5, 4, P.accentC);
  }
}

// ------------------------------------------------------------------ isi pantry (di atas meja counter, y 30-46)

export function drawPantryItems(ctx, P, style) {
  if (style === 'bar') {
    rect(ctx, 100, 29, 34, 1, P.accentA);
    rect(ctx, 100, 30, 34, 1, rgbaOf(P.accentA, 0.3));
    const cols = [P.accentA, P.accentB, P.accentC, '#2a9d8f', '#e04848'];
    for (let i = 0; i < 8; i++) {
      const x = 82 + i * 8;
      const h = 8 + (i % 3) * 2;
      rect(ctx, x, 46 - h, 4, h, cols[i % cols.length]);
      rect(ctx, x + 1, 46 - h - 3, 2, 3, '#cfd5db');
      rect(ctx, x, 46 - h, 1, h, rgbaOf('#ffffff', 0.35));
    }
    for (let i = 0; i < 3; i++) {
      rect(ctx, 150 + i * 6, 40, 4, 6, rgbaOf('#ffffff', 0.55));
      rect(ctx, 151 + i * 6, 43, 2, 3, P.accentB);
    }
  } else if (style === 'espresso') {
    rect(ctx, 86, 31, 28, 2, '#c9ced6');
    rect(ctx, 86, 33, 28, 13, '#9aa3ad');
    rect(ctx, 86, 33, 1, 13, '#e8ecef');
    rect(ctx, 88, 44, 24, 2, '#2b2f3a');
    rect(ctx, 92, 38, 3, 5, '#2b2f3a');
    rect(ctx, 104, 38, 3, 5, '#2b2f3a');
    rect(ctx, 98, 35, 4, 4, '#e8ecef');
    rect(ctx, 99, 36, 2, 1, '#e04848');
    rect(ctx, 118, 41, 5, 5, '#fffdf5');
    rect(ctx, 125, 42, 5, 4, '#fffdf5');
    rect(ctx, 120, 37, 5, 4, '#fffdf5');
    rect(ctx, 134, 34, 8, 12, '#2b2f3a');
    rect(ctx, 135, 31, 6, 3, '#6b3f22');
    rect(ctx, 137, 40, 4, 2, '#e04848');
    rect(ctx, 148, 40, 18, 6, 'rgba(190,226,245,0.5)');
    rect(ctx, 148, 45, 18, 1, '#f4f4f4');
    rect(ctx, 152, 42, 8, 3, '#d99a3d');
    rect(ctx, 153, 42, 6, 1, '#f0b85a');
  } else if (style === 'galley') {
    const cols = [P.accentA, P.accentB, P.accentC];
    for (let i = 0; i < 5; i++) {
      rect(ctx, 82 + i * 7, 38, 6, 8, '#e8e8e8');
      rect(ctx, 82 + i * 7, 41, 6, 2, cols[i % 3]);
      rect(ctx, 83 + i * 7, 38, 4, 1, '#8d949c');
    }
    rect(ctx, 122, 38, 6, 8, P.accentB);
    rect(ctx, 125, 33, 1, 6, '#e04848');
    rect(ctx, 124, 33, 2, 1, '#e04848');
    rect(ctx, 132, 43, 26, 3, '#8d949c');
    rect(ctx, 134, 41, 6, 2, P.accentC);
    rect(ctx, 142, 41, 6, 2, P.accentA);
    rect(ctx, 150, 41, 6, 2, P.accentB);
    rect(ctx, 162, 38, 3, 8, '#cfd5db');
    rect(ctx, 162, 38, 3, 2, P.accentA);
  }
}

// ------------------------------------------------------------------ sprite props

/** Gambar sprite (hasil validasi: { w, h, rows, colors }) per baris sebagai garis horizontal sewarna. */
export function drawSprite(ctx, sprite, left, top) {
  sprite.rows.forEach((row, y) => {
    const chars = [...row];
    let x = 0;
    while (x < chars.length) {
      const color = sprite.colors[chars[x]];
      let run = 1;
      while (x + run < chars.length && sprite.colors[chars[x + run]] === color) run++;
      if (color) rect(ctx, left + x, top + y, run, 1, color);
      x += run;
    }
  });
}

export function drawProps(ctx, decor, sprites) {
  for (const prop of decor.props ?? []) {
    const sprite = sprites?.[prop.sprite];
    const at = PROP_ANCHORS[prop.slot];
    if (!sprite || !at) continue;
    const left = Math.round(at.x - sprite.w / 2);
    const top = Math.round(at.anchor === 'bottom' ? at.y - sprite.h : at.y - sprite.h / 2);
    drawSprite(ctx, sprite, left, top);
  }
}
