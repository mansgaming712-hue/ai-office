// Renderer canvas: lapisan pixel art digambar 1:1 di canvas kecil (W x H dari layout.js), lalu diperbesar
// tanpa smoothing. Teks (label, bubble) digambar di atasnya pada resolusi layar supaya tetap tajam.
import { STATUS_LABEL } from './engine.js';
import { DECOR, DOOR, H, MANAGER_SPOT, W, WALL_H, zoneList } from './layout.js';

const FONT = '"VT323", ui-monospace, monospace';

export const STATUS_COLOR = {
  idle: '#8b93a1',
  working: '#e8b931',
  done: '#45a85a',
  blocked: '#e04848',
};

const BUBBLE_ACCENT = {
  assign: '#e8b931',
  working: '#7f97bf',
  done: '#45a85a',
  blocked: '#e04848',
  report: '#3b78c4',
  command: '#2a9d8f',
  warning: '#e04848',
};

const ENVELOPE_COLORS = {
  done: ['#fff8e7', '#6b5a45'],
  report: ['#eef5ff', '#3b5f8f'],
  blocked: ['#ffd9d9', '#b03030'],
  command: ['#fff1b8', '#8a6d1f'],
  ceo: ['#e3f7ef', '#2f7d5b'],
};

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const rgba = (hex, a) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};
function shade(hex, f) {
  const [r, g, b] = hexToRgb(hex).map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  return `rgb(${r},${g},${b})`;
}

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// ------------------------------------------------------------------ static background

function drawBackground(ctx) {
  // Lantai kayu
  rect(ctx, 0, 0, W, H, '#c9a57a');
  for (let y = WALL_H; y < H; y += 8) {
    rect(ctx, 0, y, W, 1, '#b8926a');
    const off = ((y / 8) % 2) * 24;
    for (let x = off; x < W; x += 48) rect(ctx, x, y + 1, 1, 7, '#bd986f');
  }
  // Karpet divisi
  for (const { division, rect: r } of zoneList()) {
    ctx.fillStyle = rgba(division.color, 0.16);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.fillStyle = rgba(division.color, 0.45);
    ctx.fillRect(r.x, r.y, r.w, 1);
    ctx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
    ctx.fillRect(r.x, r.y, 1, r.h);
    ctx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
  }
  // Karpet manajer
  const mr = MANAGER_SPOT.rug;
  rect(ctx, mr.x, mr.y, mr.w, mr.h, '#9b4a42');
  rect(ctx, mr.x + 2, mr.y + 2, mr.w - 4, mr.h - 4, '#ad5a4f');
  for (let x = mr.x + 6; x < mr.x + mr.w - 6; x += 6) rect(ctx, x, mr.y + 4, 2, 1, '#c9786a');

  // Dinding
  rect(ctx, 0, 0, W, WALL_H, '#e4d6bf');
  rect(ctx, 0, WALL_H - 3, W, 3, '#8f7a5f');
  rect(ctx, 0, WALL_H - 4, W, 1, '#b9a68a');
  for (const wx of [70, 180, 290, 390]) {
    if (wx === 180) continue; // ruang untuk jam
    rect(ctx, wx, 5, 34, 15, '#6f5b46');
    rect(ctx, wx + 1, 6, 32, 13, '#a9d6f2');
    rect(ctx, wx + 1, 6, 32, 4, '#c8e7fa');
    rect(ctx, wx + 16, 6, 1, 13, '#6f5b46');
    rect(ctx, wx + 1, 12, 32, 1, '#6f5b46');
  }
  // Papan tulis
  rect(ctx, 150, 4, 40, 18, '#6d6d6d');
  rect(ctx, 151, 5, 38, 16, '#f4f6f4');
  rect(ctx, 154, 9, 18, 1, '#3b78c4');
  rect(ctx, 154, 12, 26, 1, '#45a85a');
  rect(ctx, 154, 15, 12, 1, '#e04848');
  // Pintu CEO
  const d = DOOR;
  rect(ctx, d.x - 2, d.y - 2, d.w + 4, d.h + 2, '#5c4330');
  rect(ctx, d.x, d.y, d.w, d.h, '#8a5d3b');
  rect(ctx, d.x + 2, d.y + 2, d.w - 4, 8, '#9b6a45');
  rect(ctx, d.x + 2, d.y + 12, d.w - 4, 9, '#9b6a45');
  rect(ctx, d.x + d.w - 5, d.y + 12, 2, 2, '#e8c45a');

  for (const item of DECOR) drawDecor(ctx, item);
}

function drawDecor(ctx, { kind, x, y, w, h }) {
  if (kind === 'plant') {
    rect(ctx, x + 2, y + h - 6, w - 4, 6, '#9a5b3a');
    rect(ctx, x + 2, y + h - 6, w - 4, 1, '#b8734d');
    rect(ctx, x + 1, y + 2, w - 2, h - 8, '#3f8a4a');
    rect(ctx, x + 3, y, w - 6, 4, '#4fa35a');
    rect(ctx, x, y + 5, 3, 4, '#357a3f');
    rect(ctx, x + w - 3, y + 4, 3, 4, '#357a3f');
  } else if (kind === 'shelf') {
    rect(ctx, x, y, w, h, '#6e4b30');
    const books = ['#3b78c4', '#e8b931', '#45a85a', '#b8457f', '#d17b2f', '#7b7f87'];
    for (let r = 0; r < 2; r++) {
      rect(ctx, x + 1, y + 1 + r * 9, w - 2, 8, '#4d3220');
      for (let i = 0; i < 9; i++) rect(ctx, x + 2 + i * 4.5, y + 2 + r * 9 + (i % 3 === 0 ? 1 : 0), 3, 7 - (i % 3 === 0 ? 1 : 0), books[(i + r) % books.length]);
    }
  } else if (kind === 'printer') {
    rect(ctx, x, y + 4, w, h - 4, '#8d949c');
    rect(ctx, x + 2, y, w - 4, 5, '#b9c0c7');
    rect(ctx, x + 4, y + 1, w - 8, 2, '#ffffff');
    rect(ctx, x + w - 5, y + 7, 2, 2, '#45a85a');
  } else if (kind === 'cooler') {
    rect(ctx, x + 2, y, w - 4, 9, '#8fd0f0');
    rect(ctx, x + 3, y + 1, 2, 6, '#c6ecfb');
    rect(ctx, x, y + 9, w, h - 9, '#e8ecef');
    rect(ctx, x + 3, y + 12, 3, 2, '#e04848');
    rect(ctx, x + w - 6, y + 12, 3, 2, '#3b78c4');
  }
}

// ------------------------------------------------------------------ dynamic sprites

function drawClock(ctx, now) {
  const cx = 240;
  const cy = 13;
  rect(ctx, cx - 7, cy - 7, 14, 14, '#5d4a37');
  rect(ctx, cx - 6, cy - 6, 12, 12, '#fffdf5');
  const d = new Date(now);
  const hands = [
    [((d.getHours() % 12) + d.getMinutes() / 60) / 12, 3.5, '#2a2333'],
    [d.getMinutes() / 60, 5, '#2a2333'],
    [d.getSeconds() / 60, 5, '#e04848'],
  ];
  for (const [frac, len, color] of hands) {
    const a = frac * Math.PI * 2 - Math.PI / 2;
    for (let i = 0; i <= len; i++) rect(ctx, cx + Math.cos(a) * i - 0.5, cy + Math.sin(a) * i - 0.5, 1, 1, color);
  }
}

function drawShadow(ctx, x, y) {
  ctx.fillStyle = 'rgba(40,25,10,0.25)';
  ctx.fillRect(Math.round(x) - 5, Math.round(y) - 1, 10, 2);
  ctx.fillRect(Math.round(x) - 4, Math.round(y) - 2, 8, 4);
}

/** Karakter dengan titik jangkar di kaki (x, y). */
function drawPerson(ctx, x, y, look, { facing = 'down', seated = false, step = 0, manager = false }) {
  x = Math.round(x);
  y = Math.round(y);
  const shirt = manager ? '#2f3442' : look.shirt;
  if (!seated) drawShadow(ctx, x, y);
  // Kaki
  if (!seated) {
    const a = step % 2 === 0 ? 0 : 1;
    rect(ctx, x - 4, y - 4 + a, 3, 4 - a, '#2e3140');
    rect(ctx, x + 1, y - 4 + (1 - a), 3, 4 - (1 - a), '#2e3140');
  }
  // Badan
  rect(ctx, x - 5, y - 10, 10, 7, shirt);
  rect(ctx, x - 5, y - 10, 10, 1, shade(shirt, 1.2));
  if (manager) {
    rect(ctx, x - 1, y - 10, 2, 5, '#f4f4f4');
    rect(ctx, x, y - 9, 1, 4, '#c0392b');
  }
  // Lengan
  if (facing === 'left' || facing === 'right') {
    const ax = facing === 'left' ? x - 2 + (step % 2) : x - 1 - (step % 2);
    rect(ctx, ax, y - 9, 3, 5, shade(shirt, 0.85));
  } else {
    rect(ctx, x - 6, y - 9, 1, 5, shade(shirt, 0.85));
    rect(ctx, x + 5, y - 9, 1, 5, shade(shirt, 0.85));
  }
  // Kepala
  rect(ctx, x - 4, y - 17, 8, 7, look.skin);
  rect(ctx, x - 4, y - 18, 8, 3, look.hair);
  if (facing === 'up') {
    rect(ctx, x - 4, y - 17, 8, 6, look.hair);
  } else if (facing === 'left') {
    rect(ctx, x + 1, y - 17, 3, 5, look.hair);
    rect(ctx, x - 3, y - 14, 1, 1, '#1d1a22');
  } else if (facing === 'right') {
    rect(ctx, x - 4, y - 17, 3, 5, look.hair);
    rect(ctx, x + 2, y - 14, 1, 1, '#1d1a22');
  } else {
    rect(ctx, x - 4, y - 17, 1, 3, look.hair);
    rect(ctx, x + 3, y - 17, 1, 3, look.hair);
    rect(ctx, x - 2, y - 14, 1, 1, '#1d1a22');
    rect(ctx, x + 1, y - 14, 1, 1, '#1d1a22');
    if (manager) rect(ctx, x - 3, y - 19, 6, 1, '#8f8f99'); // uban sang manajer
  }
}

function drawChair(ctx, x, y, big = false) {
  const w = big ? 16 : 12;
  rect(ctx, x - w / 2, y - 14, w, 9, big ? '#2a2a33' : '#3d4152');
  rect(ctx, x - w / 2 + 1, y - 13, w - 2, 1, big ? '#45454f' : '#565b70');
}

function drawDesk(ctx, d, { status, t, color, big = false }) {
  rect(ctx, d.x, d.y, d.w, d.h, '#b07a4a');
  rect(ctx, d.x, d.y, d.w, 1, '#c8915c');
  rect(ctx, d.x, d.y + d.h - 4, d.w, 4, '#8a5a33');
  rect(ctx, d.x, d.y + d.h - 4, d.w, 1, '#7a4c2a');
  // Monitor (layar menghadap penonton, warna = status)
  const mx = d.x + 3;
  const my = d.y - 6;
  rect(ctx, mx, my, 13, 10, '#2c2f3a');
  let screen = '#3a4a5e';
  if (status === 'working') screen = '#4cc3e8';
  else if (status === 'done') screen = '#62c46f';
  else if (status === 'blocked') screen = Math.floor(t * 3) % 2 ? '#e04848' : '#8f2b2b';
  rect(ctx, mx + 1, my + 1, 11, 7, screen);
  if (status === 'working') {
    for (let i = 0; i < 3; i++) {
      const len = 3 + ((Math.floor(t * 6) + i * 3) % 6);
      rect(ctx, mx + 2, my + 2 + i * 2, len, 1, '#eafaff');
    }
  }
  rect(ctx, mx + 5, my + 10, 3, 2, '#2c2f3a');
  // Keyboard
  const kx = d.x + d.w / 2 - 4;
  rect(ctx, kx + 2, d.y + 3, 10, 3, '#d9dde3');
  rect(ctx, kx + 3, d.y + 4, 8, 1, '#aeb4bd');
  // Cangkir & kertas
  rect(ctx, d.x + d.w - 6, d.y + 2, 3, 4, color ?? '#e8ecef');
  if (big) {
    // baki surat masuk
    rect(ctx, MANAGER_SPOT.inbox.x - 6, MANAGER_SPOT.inbox.y - 2, 12, 6, '#6b5a45');
    rect(ctx, MANAGER_SPOT.inbox.x - 5, MANAGER_SPOT.inbox.y - 1, 10, 4, '#8b7558');
  }
  // LED status
  if (status) rect(ctx, d.x + d.w - 4, d.y + d.h - 3, 2, 2, STATUS_COLOR[status]);
}

function drawHands(ctx, x, deskY, skin, t, typing) {
  const k = typing ? Math.floor(t * 8) % 2 : 0;
  rect(ctx, x - 4, deskY + 2 + k, 3, 2, skin);
  rect(ctx, x + 1, deskY + 3 - k, 3, 2, skin);
}

function drawStatusIcon(ctx, x, y, status, t) {
  x = Math.round(x);
  y = Math.round(y);
  if (status === 'working') {
    const n = Math.floor(t * 3) % 4;
    for (let i = 0; i < 3; i++) rect(ctx, x - 4 + i * 3, y - (i < n ? 1 : 0), 2, 2, i < n ? '#e8b931' : 'rgba(232,185,49,0.35)');
  } else if (status === 'done') {
    rect(ctx, x - 4, y - 4, 9, 7, '#2f7d3d');
    const px = [[-3, -1], [-2, 0], [-1, 1], [0, 0], [1, -1], [2, -2], [3, -3]];
    for (const [dx, dy] of px) rect(ctx, x + dx, y + dy, 1, 1, '#ffffff');
  } else if (status === 'blocked') {
    if (Math.floor(t * 2.5) % 2 === 0) {
      rect(ctx, x - 3, y - 6, 7, 9, '#e04848');
      rect(ctx, x, y - 5, 1, 4, '#ffffff');
      rect(ctx, x, y + 1, 1, 1, '#ffffff');
    }
  }
}

/** Segitiga peringatan pixel-art dengan "!" (limit hampir habis). (x, y) = puncak segitiga. */
function drawWarningIcon(ctx, x, y) {
  x = Math.round(x);
  y = Math.round(y);
  const rows = 8;
  for (let r = 0; r < rows; r++) {
    const half = Math.floor(r * 0.75);
    rect(ctx, x - half - 1, y + r, half * 2 + 3, 1, '#2a2333');
  }
  rect(ctx, x - 7, y + rows, 15, 1, '#2a2333');
  for (let r = 1; r < rows; r++) {
    const half = Math.floor((r - 1) * 0.75);
    rect(ctx, x - half, y + r, half * 2 + 1, 1, '#ffd23f');
  }
  rect(ctx, x, y + 3, 1, 2, '#2a2333');
  rect(ctx, x, y + 6, 1, 1, '#2a2333');
}

function drawEnvelope(ctx, env) {
  const [body, border] = ENVELOPE_COLORS[env.kind] ?? ENVELOPE_COLORS.done;
  const x = Math.round(env.x) - 5;
  const y = Math.round(env.y) - 3;
  ctx.fillStyle = 'rgba(40,25,10,0.18)';
  ctx.fillRect(x + 1, y + 9 + Math.round((1 - Math.sin(Math.PI * env.t)) * 2), 9, 2);
  rect(ctx, x, y, 11, 7, border);
  rect(ctx, x + 1, y + 1, 9, 5, body);
  for (let i = 0; i < 5; i++) {
    rect(ctx, x + 1 + i, y + 1 + Math.min(i, 3), 1, 1, border);
    rect(ctx, x + 9 - i, y + 1 + Math.min(i, 3), 1, 1, border);
  }
}

// ------------------------------------------------------------------ text overlay

function wrapText(ctx, text, maxWidth, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth || !line) line = test;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxWidth) last = last.slice(0, -1);
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

/** Potong teks satu baris supaya muat `maxWidth` (diakhiri "…"). */
function fitText(ctx, text, maxWidth) {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

function drawBubble(ctx, ax, ay, bubble, time) {
  const size = 8;
  const maxW = 116;
  // Baris pertama (opsional): nama proyek sesi, kecil dan redup.
  let tag = null;
  let tagW = 0;
  if (bubble.project) {
    ctx.font = `7px ${FONT}`;
    tag = fitText(ctx, bubble.project, maxW - 8);
    tagW = ctx.measureText(tag).width;
  }
  ctx.font = `${size}px ${FONT}`;
  const lines = wrapText(ctx, bubble.text, maxW - 8, 3);
  const textW = Math.max(tagW, ...lines.map((l) => ctx.measureText(l).width));
  const w = Math.ceil(textW + 9);
  const lh = 7;
  const tagH = tag ? 6 : 0;
  const h = lines.length * lh + 5 + tagH;
  // animasi muncul
  const age = time - bubble.born;
  const pop = Math.min(1, age / 0.15);
  let x = Math.round(ax - w / 2);
  x = Math.max(2, Math.min(W - w - 2, x));
  const y = Math.round(ay - h - 5 + (1 - pop) * 3);
  const accent = BUBBLE_ACCENT[bubble.kind] ?? '#7f97bf';
  ctx.globalAlpha = Math.min(1, pop, Math.max(0, (bubble.until - time) / 0.3));
  const paper = bubble.kind === 'warning' ? '#fff1c9' : '#fffdf5';
  ctx.fillStyle = '#2a2333';
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = paper;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 2, h);
  // ekor
  const tx = Math.max(x + 4, Math.min(x + w - 5, Math.round(ax)));
  ctx.fillStyle = '#2a2333';
  ctx.fillRect(tx - 2, y + h, 5, 1);
  ctx.fillRect(tx - 1, y + h + 1, 3, 2);
  ctx.fillStyle = paper;
  ctx.fillRect(tx - 1, y + h - 0.5, 3, 1.5);
  ctx.fillRect(tx, y + h + 1, 1, 1);
  ctx.textBaseline = 'top';
  if (tag) {
    ctx.font = `7px ${FONT}`;
    ctx.fillStyle = '#5d4f70';
    ctx.fillText(tag, x + 5, y + 1.5);
    ctx.font = `${size}px ${FONT}`;
  }
  ctx.fillStyle = '#231c2b';
  lines.forEach((l, i) => ctx.fillText(l, x + 5, y + 2 + tagH + i * lh));
  ctx.globalAlpha = 1;
}

function drawLabels(ctx, office) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `8px ${FONT}`;
  for (const { division, rect: r } of zoneList()) {
    ctx.fillStyle = shade(division.color, 0.7);
    ctx.fillText(division.name.toUpperCase(), r.x + 4, r.y + 8);
  }
  ctx.textAlign = 'center';
  for (const w of office.workers.values()) {
    const by = w.desk.y + w.desk.h;
    ctx.font = `7px ${FONT}`;
    ctx.fillStyle = '#2a2333';
    ctx.fillText(w.name, w.seat.x, by + 6);
    ctx.fillStyle = shade(STATUS_COLOR[w.status], 0.75);
    ctx.fillText(STATUS_LABEL[w.status], w.seat.x, by + 12);
  }
  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = '#fff3e0';
  ctx.fillText('MANAJER', MANAGER_SPOT.seat.x, MANAGER_SPOT.desk.y + MANAGER_SPOT.desk.h + 8);
  ctx.fillStyle = '#f3e3c8';
  ctx.font = `7px ${FONT}`;
  ctx.fillText('CEO', DOOR.x + DOOR.w / 2, DOOR.y + 9);
  if (office.inbox > 0) {
    ctx.fillStyle = '#fffdf5';
    ctx.font = `7px ${FONT}`;
    ctx.fillText(String(office.inbox), MANAGER_SPOT.inbox.x, MANAGER_SPOT.inbox.y + 3);
  }
  ctx.textAlign = 'left';
}

// ------------------------------------------------------------------ public API

export function createRenderer(canvas) {
  const pix = document.createElement('canvas');
  pix.width = W;
  pix.height = H;
  const pctx = pix.getContext('2d');
  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  drawBackground(bg.getContext('2d'));
  const ctx = canvas.getContext('2d');

  function drawPixels(office, now) {
    const t = office.time;
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(bg, 0, 0);
    drawClock(pctx, now);

    const items = [];
    for (const w of office.workers.values()) {
      const look = { shirt: w.division.color, hair: w.hair, skin: w.skin };
      items.push({ y: w.seat.y, draw: () => {
        drawChair(pctx, w.seat.x, w.seat.y);
        drawPerson(pctx, w.seat.x, w.seat.y, look, { seated: true });
      } });
      items.push({ y: w.desk.y + 0.5, draw: () => {
        drawDesk(pctx, w.desk, { status: w.status, t: t + w.seat.x * 0.01, color: w.division.color });
        drawHands(pctx, w.seat.x, w.desk.y, w.skin, t + w.seat.x, w.status === 'working');
      } });
    }
    const m = office.manager;
    const mLook = { hair: '#3b3b45', skin: '#e9bf98' };
    const mSeated = m.state === 'sitting';
    items.push({ y: MANAGER_SPOT.seat.y - 0.5, draw: () => drawChair(pctx, MANAGER_SPOT.seat.x, MANAGER_SPOT.seat.y, true) });
    items.push({ y: mSeated ? MANAGER_SPOT.seat.y : m.y, draw: () => drawPerson(pctx, m.x, m.y - (m.state === 'standing' ? 1 : 0), mLook, {
      seated: mSeated,
      facing: m.facing,
      step: Math.floor(m.walkDist / 5),
      manager: true,
    }) });
    items.push({ y: MANAGER_SPOT.desk.y + 0.5, draw: () => {
      drawDesk(pctx, MANAGER_SPOT.desk, {
        status: office.manager.typingUntil > t ? 'working' : null,
        t,
        color: '#e8ecef',
        big: true,
      });
      for (let i = 0; i < Math.min(office.inbox, 4); i++) {
        rect(pctx, MANAGER_SPOT.inbox.x - 4, MANAGER_SPOT.inbox.y - 1 - i, 8, 1, i % 2 ? '#fff8e7' : '#e9dfc9');
      }
      if (mSeated) drawHands(pctx, m.x, MANAGER_SPOT.desk.y, mLook.skin, t, office.manager.typingUntil > t);
    } });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

    for (const w of office.workers.values()) drawStatusIcon(pctx, w.seat.x, w.seat.y - 23, w.status, t);
    if (office.limitWarning) drawWarningIcon(pctx, m.x + 12, m.y - 21); // di samping kepala, di bawah ekor bubble
    for (const env of office.envelopes) drawEnvelope(pctx, env);
  }

  function draw(office, now = Date.now()) {
    drawPixels(office, now);
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(pix, 0, 0, cw, ch);
    const k = cw / W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawLabels(ctx, office);
    // popup (+1, CEO)
    ctx.textAlign = 'center';
    ctx.font = `8px ${FONT}`;
    for (const p of office.popups) {
      const age = office.time - p.born;
      ctx.globalAlpha = Math.max(0, 1 - age / (p.until - p.born));
      ctx.fillStyle = '#2a2333';
      ctx.fillText(p.text, p.x + 0.6, p.y - age * 10 + 0.6);
      ctx.fillStyle = '#ffe27a';
      ctx.fillText(p.text, p.x, p.y - age * 10);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    // bubble: urutkan menurut waktu muncul supaya yang terbaru di atas
    const bubbles = [];
    for (const w of office.workers.values()) if (w.bubble) bubbles.push([w.seat.x, w.seat.y - 26, w.bubble]);
    const m = office.manager;
    const mb = office.managerBubble();
    if (mb) bubbles.push([m.x, m.y - 21, mb]);
    bubbles.sort((a, b) => a[2].born - b[2].born);
    for (const [x, y, b] of bubbles) drawBubble(ctx, x, y, b, office.time);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return { draw };
}
