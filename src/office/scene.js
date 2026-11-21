// Latar kantor Jakarta: digambar SEKALI ke canvas offscreen (di-cache oleh render.js) dan digambar ulang hanya saat
// tema atau ukuran berubah. Efek yang bergerak (awan, bintang, lalu lintas, hujan, uap kopi) ada di drawSkyFx/drawSteam
// dan digambar tiap frame di atas latar yang sudah jadi, hanya di area kaca jendela.
import {
  DECOR, DOOR, MANAGER_SPOT, MEETING, PANTRY, W, H, WALL_H, WALL_ITEMS, WINDOWS, zoneList,
} from './layout.js';

const rect = (ctx, x, y, w, h, color) => {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

/** Pseudo-acak deterministik 0..1 dari bilangan bulat (supaya latar sama setiap digambar). */
const rnd = (n) => {
  let x = Math.imul(n + 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
};

// ------------------------------------------------------------------ jendela dan skyline

/** Kaca per panel (jendela dibagi tiga oleh dua kusen vertikal). */
export function paneRects() {
  const out = [];
  for (const win of WINDOWS) {
    const pw = Math.floor((win.w - 4 - 4) / 3);
    for (let i = 0; i < 3; i++) out.push({ x: win.x + 2 + i * (pw + 2), y: win.y + 2, w: pw, h: win.h - 6 });
  }
  return out;
}

const GROUND = WINDOWS[0].y + WINDOWS[0].h - 4; // garis cakrawala (bawah kaca)

// Gedung penanda skyline (x absolut). Gaya: box, wisma (menara bertingkat + antena), slant/slantR (menara kembar
// beratap miring), round (puncak membulat), pyramid, stepped, antenna.
const TOWERS = [
  { x: 58, w: 12, h: 22, s: 'box' },
  { x: 74, w: 11, h: 31, s: 'wisma' },
  { x: 97, w: 9, h: 25, s: 'slant' },
  { x: 108, w: 9, h: 25, s: 'slantR' },
  { x: 127, w: 10, h: 21, s: 'round' },
  { x: 144, w: 12, h: 27, s: 'pyramid' },
  { x: 160, w: 9, h: 16, s: 'box' },
  { x: 312, w: 10, h: 24, s: 'round' },
  { x: 325, w: 11, h: 29, s: 'stepped' },
  { x: 340, w: 9, h: 19, s: 'box' },
  { x: 353, w: 12, h: 30, s: 'antenna' },
  { x: 392, w: 9, h: 25, s: 'slant' },
  { x: 403, w: 9, h: 25, s: 'slantR' },
  { x: 417, w: 12, h: 20, s: 'box' },
];

/** Posisi lampu merah di puncak gedung (kedip di malam hari), diisi saat skyline digambar. */
export const BEACONS = [];

function towerShape(ctx, t, color, hi) {
  const top = GROUND - t.h;
  const body = (x, y, w, h) => rect(ctx, x, y, w, h, color);
  switch (t.s) {
    case 'wisma': {
      body(t.x, top + 9, t.w, t.h - 9);
      body(t.x + 2, top + 5, t.w - 4, 4);
      body(t.x + 4, top + 2, t.w - 8, 3);
      rect(ctx, t.x + 5, top - 4, 1, 6, color);
      rect(ctx, t.x + 5, top - 4, 1, 1, hi);
      break;
    }
    case 'slant':
      body(t.x, top + 3, t.w, t.h - 3);
      for (let i = 0; i < 3; i++) body(t.x, top + i, t.w - 3 * (2 - i) - 1 + (i === 2 ? 1 : 0), 1);
      break;
    case 'slantR':
      body(t.x, top + 3, t.w, t.h - 3);
      for (let i = 0; i < 3; i++) body(t.x + 3 * (2 - i), top + i, t.w - 3 * (2 - i), 1);
      break;
    case 'round':
      body(t.x, top + 4, t.w, t.h - 4);
      body(t.x + 1, top + 2, t.w - 2, 2);
      body(t.x + 3, top, t.w - 6, 2);
      break;
    case 'pyramid':
      body(t.x, top + 6, t.w, t.h - 6);
      body(t.x + 2, top + 4, t.w - 4, 2);
      body(t.x + 4, top + 2, t.w - 8, 2);
      rect(ctx, t.x + 5, top - 2, 2, 4, color);
      break;
    case 'stepped':
      body(t.x, top + 10, t.w, t.h - 10);
      body(t.x + 1, top + 6, t.w - 2, 4);
      body(t.x + 3, top + 2, t.w - 6, 4);
      break;
    case 'antenna':
      body(t.x, top + 3, t.w, t.h - 3);
      body(t.x + 2, top, t.w - 4, 3);
      rect(ctx, t.x + 5, top - 5, 1, 5, color);
      break;
    default:
      body(t.x, top, t.w, t.h);
      rect(ctx, t.x + 2, top - 2, 3, 2, color);
  }
  rect(ctx, t.x, top + (t.s === 'box' ? 0 : 3), 1, t.h - 3, hi); // sisi terang
}

function facadeLights(ctx, P, t, seed) {
  const top = GROUND - t.h + 5;
  for (let y = top; y < GROUND - 1; y += 3) {
    for (let x = t.x + 2; x < t.x + t.w - 1; x += 2) {
      const r = rnd(seed + x * 31 + y * 7);
      if (P.night) {
        if (r < 0.42) rect(ctx, x, y, 1, 1, r < 0.08 ? '#bfe3ff' : P.bldgLit);
      } else if (r < 0.5) rect(ctx, x, y, 1, 1, P.bldgWin);
    }
  }
}

function drawCrane(ctx, P) {
  const x = 372;
  const c = P.night ? '#2a3170' : '#86a3be';
  rect(ctx, x, GROUND - 14, 8, 14, P.night ? '#171d46' : '#7d9bb6'); // gedung yang sedang dibangun
  for (let y = GROUND - 13; y < GROUND; y += 3) rect(ctx, x, y, 8, 1, c);
  rect(ctx, x + 4, GROUND - 31, 1, 17, c);
  rect(ctx, x - 6, GROUND - 31, 20, 1, c);
  rect(ctx, x + 10, GROUND - 30, 1, 5, c);
  rect(ctx, x - 6, GROUND - 30, 3, 2, c);
  BEACONS.push({ x: x + 4, y: GROUND - 33 });
}

function drawSkyline(ctx, P) {
  BEACONS.length = 0;
  ctx.save();
  ctx.beginPath();
  for (const win of WINDOWS) ctx.rect(win.x, win.y, win.w, win.h);
  ctx.clip();
  for (const win of WINDOWS) rect(ctx, win.x, win.y, win.w, win.h, P.winGlass);
  const x0 = WINDOWS[0].x;
  const x1 = WINDOWS[1].x + WINDOWS[1].w;
  const top = WINDOWS[0].y;
  // langit berlapis (dithering di batas)
  const bands = [[top, 14, P.skyTop], [top + 14, 12, P.skyMid], [top + 26, 20, P.skyLow]];
  for (const [by, bh, color] of bands) rect(ctx, x0, by, x1 - x0, bh, color);
  for (let x = x0; x < x1; x += 2) {
    rect(ctx, x, top + 13, 1, 1, P.skyMid);
    rect(ctx, x + 1, top + 14, 1, 1, P.skyTop);
    rect(ctx, x, top + 25, 1, 1, P.skyLow);
    rect(ctx, x + 1, top + 26, 1, 1, P.skyMid);
  }
  if (P.night) {
    for (let i = 0; i < 46; i++) {
      const sx = x0 + Math.floor(rnd(i * 5 + 1) * (x1 - x0));
      const sy = top + Math.floor(rnd(i * 5 + 2) * 20);
      rect(ctx, sx, sy, 1, 1, i % 4 === 0 ? '#e9e4ff' : '#9aa4e8');
    }
    // bulan sabit
    rect(ctx, 138, top + 5, 4, 1, '#f3e9b8');
    rect(ctx, 137, top + 6, 2, 3, '#f3e9b8');
    rect(ctx, 138, top + 9, 4, 1, '#f3e9b8');
  } else {
    rect(ctx, 394, top + 4, 6, 6, '#fff4c2'); // matahari pucat
    rect(ctx, 395, top + 3, 4, 8, '#fff4c2');
  }
  // gedung jauh (berkabut)
  for (let x = x0 - 2, i = 0; x < x1; i++) {
    const w = 5 + Math.floor(rnd(i * 3 + 11) * 7);
    const h = 8 + Math.floor(rnd(i * 3 + 12) * 14);
    rect(ctx, x, GROUND - h, w, h, P.farBldg);
    rect(ctx, x, GROUND - h, 1, h, P.farBldgHi);
    if (P.night) for (let y = GROUND - h + 2; y < GROUND - 1; y += 4) if (rnd(x * 13 + y) < 0.35) rect(ctx, x + 2, y, 1, 1, P.bldgLit);
    x += w + 1 + Math.floor(rnd(i * 3 + 13) * 2);
  }
  // gedung dekat dan menara penanda
  TOWERS.forEach((t, i) => {
    towerShape(ctx, t, P.nearBldg, P.nearBldgHi);
    facadeLights(ctx, P, t, i * 977);
    if (t.s === 'wisma' || t.s === 'antenna') BEACONS.push({ x: t.x + (t.s === 'wisma' ? 5 : 5), y: GROUND - t.h - (t.s === 'wisma' ? 5 : 6) });
  });
  drawCrane(ctx, P);
  // jalan layang / jalan raya di bawah
  rect(ctx, x0, GROUND - 2, x1 - x0, 2, P.roadDim);
  ctx.restore();
}

function drawWindowFrames(ctx, P) {
  for (const win of WINDOWS) {
    const pw = Math.floor((win.w - 8) / 3);
    // bingkai luar, kusen vertikal, dan ambang bawah
    rect(ctx, win.x, win.y, win.w, 2, P.winFrame);
    rect(ctx, win.x, win.y + win.h - 4, win.w, 4, P.winFrame);
    rect(ctx, win.x, win.y, 2, win.h, P.winFrame);
    rect(ctx, win.x + win.w - 2, win.y, 2, win.h, P.winFrame);
    for (let i = 1; i < 3; i++) rect(ctx, win.x + 2 + i * (pw + 2) - 2, win.y, 2, win.h - 2, P.winFrame);
    rect(ctx, win.x, win.y + win.h - 4, win.w, 1, P.glassEdge);
  }
  // kilau diagonal di kaca
  ctx.fillStyle = P.glassSheen;
  for (const pane of paneRects()) {
    for (let i = 0; i < 9; i++) ctx.fillRect(pane.x + 6 + i, pane.y + 2 + i * 2 - (i > 5 ? 0 : 0), 2, 2);
    for (let i = 0; i < 6; i++) ctx.fillRect(pane.x + 14 + i, pane.y + 3 + i * 2, 1, 2);
  }
}

// ------------------------------------------------------------------ elemen dinding

function drawAc(ctx, P) {
  const a = WALL_ITEMS.ac;
  rect(ctx, a.x, a.y + a.h, a.w, 1, P.shadow);
  rect(ctx, a.x, a.y, a.w, a.h, P.acBody);
  rect(ctx, a.x, a.y, a.w, 1, '#ffffff');
  rect(ctx, a.x, a.y + 5, a.w, 4, P.acShade); // lubang hembusan
  for (let x = a.x + 2; x < a.x + a.w - 2; x += 3) rect(ctx, x, a.y + 6, 2, 1, P.acBody);
  rect(ctx, a.x + a.w - 6, a.y + 2, 2, 1, P.acLed);
  rect(ctx, a.x + 3, a.y + 2, 8, 1, P.acShade);
}

function drawBoard(ctx, P) {
  const b = WALL_ITEMS.board;
  rect(ctx, b.x, b.y, b.w, b.h, P.boardFrame);
  rect(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 4, P.boardFace);
  rect(ctx, b.x + 4, b.y + 5, 20, 1, '#3b78c4');
  rect(ctx, b.x + 4, b.y + 9, 28, 1, '#45a85a');
  rect(ctx, b.x + 4, b.y + 13, 14, 1, '#e04848');
  rect(ctx, b.x + 30, b.y + 4, 8, 8, '#ffd23f'); // sticky note
  rect(ctx, b.x + 32, b.y + 6, 4, 1, '#b58a00');
  rect(ctx, b.x + 36, b.y + 14, 6, 6, '#ff8fb3');
  rect(ctx, b.x + 2, b.y + b.h - 3, b.w - 4, 2, '#8d949c'); // rak spidol
  rect(ctx, b.x + 6, b.y + b.h - 4, 4, 1, '#e04848');
  rect(ctx, b.x + 12, b.y + b.h - 4, 4, 1, '#3b78c4');
}

function drawPosterFrame(ctx, P, p, i) {
  rect(ctx, p.x, p.y, p.w, p.h, P.posterFrame);
  rect(ctx, p.x + 1, p.y + 1, p.w - 2, p.h - 2, P.posterPaper);
  rect(ctx, p.x + 1, p.y + 1, p.w - 2, 4, i === 0 ? '#e04848' : '#2a9d8f');
  rect(ctx, p.x + 1, p.y + p.h - 5, p.w - 2, 1, i === 0 ? '#e04848' : '#2a9d8f');
  rect(ctx, p.x + 2, p.y + p.h - 3, p.w - 4, 1, P.posterFrame);
}

function drawDoor(ctx, P) {
  const d = DOOR;
  rect(ctx, d.x - 2, d.y - 2, d.w + 4, d.h + 2, P.doorFrame);
  rect(ctx, d.x, d.y, d.w, d.h, P.door);
  rect(ctx, d.x + 2, d.y + 2, d.w - 4, 8, P.doorPanel);
  rect(ctx, d.x + 2, d.y + 12, d.w - 4, 9, P.doorPanel);
  rect(ctx, d.x + d.w - 5, d.y + 12, 2, 2, P.doorKnob);
  rect(ctx, d.x - 4, d.y + d.h + 4, d.w + 8, 10, rgba('#000000', P.night ? 0.35 : 0.22)); // keset di depan pintu
  rect(ctx, d.x - 3, d.y + d.h + 5, d.w + 6, 8, P.night ? '#3a2f3f' : '#7b5a43');
  rect(ctx, d.x - 1, d.y + d.h + 7, d.w + 2, 1, P.night ? '#4a3d52' : '#a07a5c');
}

// ------------------------------------------------------------------ pantry

function drawPantry(ctx, P) {
  const c = PANTRY.counter;
  const dsp = PANTRY.dispenser;
  // dispenser galon
  rect(ctx, dsp.x + 5, dsp.y - 2, 6, 2, '#2f78b5');
  rect(ctx, dsp.x + 1, dsp.y, 14, 15, '#5fb0e6');
  rect(ctx, dsp.x + 2, dsp.y + 1, 2, 12, '#a8dcf6');
  rect(ctx, dsp.x + 8, dsp.y + 8, 5, 4, '#4a9ad4');
  rect(ctx, dsp.x + 1, dsp.y + 15, 14, 1, '#3b86c4');
  rect(ctx, dsp.x, dsp.y + 16, dsp.w, dsp.h - 16, '#e8ecef');
  rect(ctx, dsp.x + dsp.w - 3, dsp.y + 16, 3, dsp.h - 16, '#c4cbd2');
  rect(ctx, dsp.x + 2, dsp.y + 20, 12, 7, '#cfd5db');
  rect(ctx, dsp.x + 4, dsp.y + 22, 3, 3, '#e04848'); // keran panas
  rect(ctx, dsp.x + 9, dsp.y + 22, 3, 3, '#3b78c4'); // keran dingin
  rect(ctx, dsp.x + 3, dsp.y + 29, 10, 2, '#8d949c'); // nampan tetesan
  rect(ctx, dsp.x + 1, dsp.y + 33, dsp.w - 2, 5, '#aab2ba');
  // meja counter
  rect(ctx, c.x, c.y, c.w, 4, P.counterTop);
  rect(ctx, c.x, c.y, c.w, 1, P.counterTopHi);
  rect(ctx, c.x, c.y + 4, c.w, c.h - 4, P.counterFront);
  rect(ctx, c.x, c.y + 4, c.w, 1, P.counterFrontLo);
  for (const dx of [0, 31, 62]) {
    rect(ctx, c.x + 2 + dx, c.y + 7, 28, c.h - 10, P.counterFrontLo);
    rect(ctx, c.x + 3 + dx, c.y + 8, 26, c.h - 12, P.counterFront);
    rect(ctx, c.x + 24 + dx, c.y + 12, 2, 3, P.counterKnob);
  }
  // toples kopi sachet
  rect(ctx, 81, 33, 10, 2, '#d1a13a');
  rect(ctx, 80, 35, 12, 11, '#cfe8f2');
  rect(ctx, 80, 35, 1, 11, '#ffffff');
  const sach = ['#c0392b', '#e8b931', '#6b3f22', '#2a9d8f', '#e8e8e8', '#c0392b'];
  sach.forEach((col, i) => rect(ctx, 82 + (i % 2) * 4, 37 + Math.floor(i / 2) * 3, 3, 2, col));
  // gelas
  for (let i = 0; i < 3; i++) {
    rect(ctx, 95 + i * 3, 40, 3, 6, '#f4f1ea');
    rect(ctx, 95 + i * 3, 42, 3, 1, ['#e04848', '#3b78c4', '#e8b931'][i]);
  }
  // teko listrik
  rect(ctx, 104, 38, 9, 8, '#c9ced6');
  rect(ctx, 104, 38, 1, 8, '#ffffff');
  rect(ctx, 106, 36, 5, 2, '#8d949c');
  rect(ctx, 113, 39, 2, 5, '#2b2f3a');
  rect(ctx, 105, 44, 2, 1, '#e04848');
  // piring gorengan
  rect(ctx, 119, 43, 24, 3, '#f4f4f4');
  rect(ctx, 120, 44, 22, 1, '#d9dde3');
  rect(ctx, 121, 39, 6, 4, '#c8812c'); // bakwan
  rect(ctx, 122, 40, 1, 1, '#4fa35a');
  rect(ctx, 125, 41, 1, 1, '#e8b931');
  rect(ctx, 128, 38, 8, 3, '#d99a3d'); // pisang goreng
  rect(ctx, 129, 38, 6, 1, '#f0b85a');
  rect(ctx, 128, 40, 8, 1, '#b87423');
  rect(ctx, 130, 41, 7, 3, '#e0a84a'); // tahu isi
  rect(ctx, 131, 42, 2, 1, '#a35f1a');
  rect(ctx, 138, 40, 4, 3, '#c8812c');
  rect(ctx, 138, 39, 1, 1, '#e04848'); // cabai rawit
  rect(ctx, 140, 39, 1, 1, '#4fa35a');
  // renceng kopi sachet
  ['#c0392b', '#e8b931', '#2a9d8f', '#3b78c4', '#c0392b'].forEach((col, i) => {
    rect(ctx, 148 + i * 4, 40, 4, 6, '#2b2f3a');
    rect(ctx, 149 + i * 4, 41, 2, 4, col);
  });
  // plakat Pantry
  rect(ctx, c.x + 33, c.y + 14, 26, 9, P.signPaper);
  rect(ctx, c.x + 33, c.y + 14, 26, 1, P.posterFrame);
  rect(ctx, c.x + 33, c.y + 22, 26, 1, P.posterFrame);
}

// ------------------------------------------------------------------ ruang rapat berdinding kaca

function drawMeeting(ctx, P) {
  const m = MEETING;
  rect(ctx, m.x + 2, m.y + 4, m.w - 4, m.h - 12, P.meetFloor);
  for (let y = m.y + 8; y < m.y + m.h - 8; y += 6) rect(ctx, m.x + 2, y, m.w - 4, 1, P.meetFloorLine);
  // meja dan kursi
  const tx = m.x + 32;
  const ty = m.y + 24;
  const chair = (x, y) => {
    rect(ctx, x, y, 9, 6, P.chairA);
    rect(ctx, x + 1, y, 7, 1, P.chairAHi);
  };
  for (let i = 0; i < 4; i++) chair(tx + 6 + i * 22, ty - 9);
  for (let i = 0; i < 4; i++) chair(tx + 6 + i * 22, ty + 20);
  rect(ctx, tx, ty + 15, 96, 4, rgba('#000000', 0.2));
  rect(ctx, tx, ty, 96, 15, P.tableTop);
  rect(ctx, tx, ty, 96, 1, P.deskTopHi);
  rect(ctx, tx, ty + 12, 96, 3, P.tableEdge);
  rect(ctx, tx + 10, ty + 3, 9, 6, '#d9dde3'); // laptop
  rect(ctx, tx + 11, ty + 4, 7, 3, '#4cc3e8');
  rect(ctx, tx + 40, ty + 4, 7, 5, '#fffdf5'); // kertas
  rect(ctx, tx + 41, ty + 5, 5, 1, '#8d949c');
  rect(ctx, tx + 60, ty + 5, 3, 4, '#f4f1ea');
  rect(ctx, tx + 60, ty + 5, 3, 1, '#6b3f22');
  rect(ctx, tx + 78, ty + 3, 9, 6, '#d9dde3');
  rect(ctx, tx + 79, ty + 4, 7, 3, '#62c46f');
  // tanaman di sudut
  rect(ctx, m.x + m.w - 20, m.y + 40, 12, 12, '#9a5b3a');
  rect(ctx, m.x + m.w - 19, m.y + 28, 10, 13, '#3f8a4a');
  rect(ctx, m.x + m.w - 17, m.y + 26, 6, 4, '#4fa35a');
  // dinding kaca depan dan kiri
  const gy = m.y + m.h - 14;
  rect(ctx, m.x + 2, gy, m.w - 4, 12, P.glassWall);
  ctx.fillStyle = P.glassSheen;
  for (let x = m.x + 10; x < m.x + m.w - 12; x += 38) {
    for (let i = 0; i < 9; i++) ctx.fillRect(x + i, gy + 1 + i, 3, 1);
    for (let i = 0; i < 5; i++) ctx.fillRect(x + 14 + i, gy + 1 + i * 2, 2, 1);
  }
  rect(ctx, m.x, gy - 1, m.w, 2, P.glassFrame);
  rect(ctx, m.x, m.y + m.h - 3, m.w, 3, P.glassFrame);
  for (const px of [0, 50, 106, 154]) rect(ctx, m.x + px, gy - 1, 4, 14, P.glassFrame);
  rect(ctx, m.x, m.y + 4, 3, m.h - 6, P.glassFrame);
  rect(ctx, m.x + 3, m.y + 4, 2, m.h - 18, P.glassWall);
  rect(ctx, m.x + 73, gy + 3, 1, 6, P.deskFrontLo); // gagang pintu kaca
  rect(ctx, m.x + 76, gy + 3, 1, 6, P.deskFrontLo);
  // plakat ruang rapat
  rect(ctx, m.x + 58, gy + 1, 30, 9, P.signPaper);
  rect(ctx, m.x + 58, gy + 1, 30, 1, P.posterFrame);
  rect(ctx, m.x + 58, gy + 9, 30, 1, P.posterFrame);
}

function drawMeetBoard(ctx, P) {
  const b = WALL_ITEMS.meetBoard;
  rect(ctx, b.x, b.y, b.w, b.h, P.boardFrame);
  rect(ctx, b.x + 1, b.y + 1, b.w - 2, b.h - 4, P.boardFace);
  // diagram sederhana: kotak dan panah
  rect(ctx, b.x + 3, b.y + 4, 8, 6, '#3b78c4');
  rect(ctx, b.x + 4, b.y + 5, 6, 4, P.boardFace);
  rect(ctx, b.x + 11, b.y + 7, 5, 1, '#e04848');
  rect(ctx, b.x + 16, b.y + 4, 8, 6, '#45a85a');
  rect(ctx, b.x + 17, b.y + 5, 6, 4, P.boardFace);
  rect(ctx, b.x + 3, b.y + 14, 22, 1, '#3b78c4');
  rect(ctx, b.x + 3, b.y + 17, 14, 1, '#d17b2f');
  rect(ctx, b.x + 2, b.y + b.h - 3, b.w - 4, 2, '#8d949c');
}

// ------------------------------------------------------------------ dekorasi

function drawPlant(ctx, { x, y, w, h }) {
  rect(ctx, x + 2, y + h - 6, w - 4, 6, '#9a5b3a');
  rect(ctx, x + 2, y + h - 6, w - 4, 1, '#b8734d');
  rect(ctx, x + 1, y + 2, w - 2, h - 8, '#3f8a4a');
  rect(ctx, x + 3, y, w - 6, 4, '#4fa35a');
  rect(ctx, x, y + 5, 3, 4, '#357a3f');
  rect(ctx, x + w - 3, y + 4, 3, 4, '#357a3f');
  rect(ctx, x + 5, y + 4, 1, 4, '#2c6a36');
  rect(ctx, x + 4, y + 1, 2, 1, '#6bbf74');
}

/** Latar statis lengkap. Dipanggil sekali per tema/ukuran; hasilnya di-cache di canvas offscreen. */
export function drawBackground(ctx, P) {
  rect(ctx, 0, 0, W, H, P.floor);
  for (let y = WALL_H; y < H; y += 8) {
    rect(ctx, 0, y, W, 1, P.floorLine);
    const off = ((y / 8) % 2) * 24;
    for (let x = off; x < W; x += 48) rect(ctx, x, y + 1, 1, 7, P.floorTick);
  }
  // bayangan dinding di lantai
  rect(ctx, 0, WALL_H, W, 3, P.shadowSoft);
  // karpet divisi
  for (const { division, rect: r } of zoneList()) {
    ctx.fillStyle = rgba(division.color, P.zoneFill);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = rgba(division.color, P.zoneEdge);
    ctx.fillRect(r.x, r.y, r.w, 1);
    ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
    ctx.fillRect(r.x, r.y, 1, r.h);
    ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
  }
  // karpet manajer
  const mr = MANAGER_SPOT.rug;
  rect(ctx, mr.x, mr.y, mr.w, mr.h, P.rugA);
  rect(ctx, mr.x + 2, mr.y + 2, mr.w - 4, mr.h - 4, P.rugB);
  for (let x = mr.x + 6; x < mr.x + mr.w - 6; x += 6) rect(ctx, x, mr.y + 4, 2, 1, P.rugStitch);

  // dinding
  rect(ctx, 0, 0, W, WALL_H, P.wall);
  for (let x = 0; x < W; x += 24) rect(ctx, x, 0, 1, WALL_H - 4, rgba('#000000', 0.06));
  rect(ctx, 0, WALL_H - 3, W, 3, P.wallBase);
  rect(ctx, 0, WALL_H - 4, W, 1, P.wallBaseHi);

  drawSkyline(ctx, P);
  drawWindowFrames(ctx, P);
  drawDoor(ctx, P);
  drawAc(ctx, P);
  drawBoard(ctx, P);
  WALL_ITEMS.posters.forEach((p, i) => drawPosterFrame(ctx, P, p, i));
  drawMeetBoard(ctx, P);
  drawPantry(ctx, P);
  drawMeeting(ctx, P);
  for (const item of DECOR) if (item.kind === 'plant') drawPlant(ctx, item);
}

// ------------------------------------------------------------------ efek bergerak (di atas latar)

function clipToPanes(ctx) {
  ctx.save();
  ctx.beginPath();
  for (const p of paneRects()) ctx.rect(p.x, p.y, p.w, p.h);
  ctx.clip();
}

/**
 * Langit yang bergerak: awan (siang), bintang berkelip (malam), lampu merah di puncak gedung, lalu lintas,
 * dan hujan di kaca. `rain` 0..1. Reduced motion: statis (tanpa awan bergerak, tanpa hujan).
 */
export function drawSkyFx(ctx, P, t, { rain = 0, reduced = false } = {}) {
  clipToPanes(ctx);
  const x0 = WINDOWS[0].x;
  const span = WINDOWS[1].x + WINDOWS[1].w - x0 + 60;
  const k = reduced ? 0 : t;
  if (!P.night) {
    for (let i = 0; i < 4; i++) {
      const cx = x0 - 30 + ((rnd(i + 90) * span + k * (1.2 + i * 0.35)) % span);
      const cy = 11 + i * 4 + Math.floor(rnd(i + 70) * 3);
      rect(ctx, cx, cy, 16, 3, P.cloud);
      rect(ctx, cx + 3, cy - 2, 9, 2, P.cloud);
      rect(ctx, cx + 1, cy + 3, 14, 1, P.cloudLo);
    }
  } else {
    for (let i = 0; i < 8; i++) {
      const on = reduced ? i % 2 === 0 : Math.floor(t * 0.9 + i * 1.7) % 3 !== 0;
      if (on) rect(ctx, x0 + Math.floor(rnd(i * 17 + 3) * (span - 60)), 10 + Math.floor(rnd(i * 17 + 4) * 14), 1, 1, '#ffffff');
    }
  }
  const blink = reduced || Math.floor(t * 1.1) % 2 === 0;
  if (blink) for (const b of BEACONS) rect(ctx, b.x, b.y, 1, 1, P.beacon);
  // lalu lintas (macet pelan): titik lampu/mobil di jalan layang
  for (let i = 0; i < 14; i++) {
    const dir = i % 2 ? 1 : -1;
    const sp = 2.2 + (i % 3) * 0.8;
    const cx = x0 + ((rnd(i + 200) * span + (reduced ? 0 : k * sp * dir) + span * 4) % span);
    rect(ctx, cx, GROUND - 2 + (i % 2), P.night ? 1 : 2, 1, i % 3 === 0 ? P.carA : P.carB);
  }
  if (rain > 0.01) {
    for (const p of paneRects()) {
      ctx.fillStyle = P.rainTint;
      ctx.globalAlpha = Math.min(1, rain);
      ctx.fillRect(p.x, p.y, p.w, p.h);
      ctx.globalAlpha = Math.min(1, 0.25 + rain * 0.65);
      const n = Math.round(26 * rain);
      for (let i = 0; i < n; i++) {
        const sp = 70 + rnd(i * 7 + p.x) * 50;
        const yy = ((t * sp + rnd(i * 11 + p.x * 3) * 100) % (p.h + 8)) - 4;
        const xx = p.x + Math.floor(rnd(i * 13 + p.x) * p.w) + Math.floor(yy * 0.12);
        rect(ctx, xx, p.y + yy, 1, 4, P.rain);
      }
      // tetesan yang merayap di kaca
      for (let i = 0; i < 3; i++) {
        const yy = ((t * (4 + i) + rnd(i * 5 + p.x) * 60) % (p.h + 4));
        rect(ctx, p.x + 3 + Math.floor(rnd(i * 3 + p.x * 7) * (p.w - 6)), p.y + yy, 1, 2, P.glassEdge);
      }
      ctx.globalAlpha = 1;
    }
  }
  ctx.restore();
}

/** Uap dari teko dan dispenser di pantry. */
export function drawSteam(ctx, P, t) {
  for (let i = 0; i < 3; i++) {
    const ph = (t * 0.8 + i * 0.33) % 1;
    ctx.globalAlpha = (1 - ph) * 0.8;
    rect(ctx, 107 + Math.round(Math.sin(ph * 6 + i) * 1.5), 35 - Math.round(ph * 8), 1, 2, '#ffffff');
  }
  ctx.globalAlpha = 1;
}

/** Jam dinding (jarum asli dari waktu perangkat; jarum detik hanya tanpa reduced motion). */
export function drawClock(ctx, P, now, reduced) {
  const { x: cx, y: cy } = WALL_ITEMS.clock;
  rect(ctx, cx - 7, cy - 7, 14, 14, P.winFrame);
  rect(ctx, cx - 6, cy - 6, 12, 12, P.clockFace);
  for (const [dx, dy] of [[0, -5], [5, 0], [0, 5], [-5, 0]]) rect(ctx, cx + dx, cy + dy, 1, 1, P.clockHand);
  const d = new Date(now);
  const hands = [
    [((d.getHours() % 12) + d.getMinutes() / 60) / 12, 3, P.clockHand],
    [d.getMinutes() / 60, 4, P.clockHand],
  ];
  if (!reduced) hands.push([d.getSeconds() / 60, 4, '#e04848']);
  for (const [frac, len, color] of hands) {
    const a = frac * Math.PI * 2 - Math.PI / 2;
    for (let i = 0; i <= len; i++) rect(ctx, cx + Math.cos(a) * i - 0.5, cy + Math.sin(a) * i - 0.5, 1, 1, color);
  }
}
