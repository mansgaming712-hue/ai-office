// Renderer canvas: lapisan pixel art digambar 1:1 di canvas kecil (W x H dari layout.js), lalu diperbesar
// tanpa smoothing. Teks (label, bubble, poster) digambar di atasnya pada resolusi layar supaya tetap tajam.
// Performa: latar kantor (scene.js) dan sprite karakter (sprites.js) di-cache ke canvas offscreen; latar digambar
// ulang hanya saat tema berganti. Setiap frame hanya menggambar bagian yang bergerak.
// Warna lingkungan mengikuti tema (palette.js); warna divisi dan status sama di kedua tema.
import { GLYPHS, GLYPH_SIZE, STATUS_INFO, uiStatusOf } from '../agentStatus.js';
import { divisionName, getLang, t } from '../i18n.js';
import { easeOutBack } from '../motion.js';
import { characterName, deskLabel, lookFor, shirtOf, SKINS } from './characters.js';
import { STATUS_LABEL } from './engine.js';
import {
  DOOR, FOOT, MANAGER_SPOT, MEETING, PANTRY, H, W, WALL_ITEMS, zoneList,
} from './layout.js';
import { paletteFor } from './palette.js';
import { drawBackground, drawClock, drawSkyFx, drawSteam } from './scene.js';
import { SIT_ROWS, SPR_H, SPR_W, createSpriteCache } from './sprites.js';
import { CEO_ID, MANAGER_ID } from '../../shared/roster.js';

const FONT = '"VT323", ui-monospace, monospace';

// Palet aktif. Diganti lewat renderer.setTheme(); fungsi gambar di bawah membacanya.
let P = paletteFor('light');

// Warna status per status internal engine (idle/working/done/blocked), dari model status UI.
export const STATUS_COLOR = Object.fromEntries(
  ['idle', 'working', 'done', 'blocked'].map((k) => [k, STATUS_INFO[uiStatusOf(k)].fill]),
);

const BUBBLE_ACCENT = {
  assign: '#e8b931',
  working: '#7f97bf',
  done: '#45a85a',
  blocked: '#e04848',
  report: '#3b78c4',
  command: '#2a9d8f',
  warning: '#e04848',
  chat: '#c98a3a',
  ceo: '#2a9d8f',
};

const ENVELOPE_COLORS = {
  done: ['#fff8e7', '#6b5a45'],
  report: ['#eef5ff', '#3b5f8f'],
  blocked: ['#ffd9d9', '#b03030'],
  command: ['#fff1b8', '#8a6d1f'],
  ceo: ['#e3f7ef', '#2f7d5b'],
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rect(ctx, x, y, w, h, color) {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
}

// ------------------------------------------------------------------ dynamic sprites

function drawShadow(ctx, x, y) {
  ctx.fillStyle = P.shadow;
  ctx.fillRect(Math.round(x) - 5, Math.round(y) - 1, 10, 2);
  ctx.fillRect(Math.round(x) - 4, Math.round(y) - 2, 8, 4);
}

function drawChair(ctx, x, y, big = false) {
  const w = big ? 18 : 14;
  const top = y - (big ? 17 : 14);
  rect(ctx, x - w / 2, top + 1, w, big ? 16 : 13, big ? P.chairBig : P.chairA);
  rect(ctx, x - w / 2 + 1, top, w - 2, 1, big ? P.chairBigHi : P.chairAHi);
  rect(ctx, x - w / 2 + 1, top + 2, 1, 8, big ? P.chairBigHi : P.chairAHi);
}

function drawDesk(ctx, d, { status, t: time, color, big = false, reduced = false, laptopX, seed = 0, flash = false }) {
  rect(ctx, d.x, d.y, d.w, d.h, P.deskTop);
  rect(ctx, d.x, d.y, d.w, 1, P.deskTopHi);
  rect(ctx, d.x, d.y + d.h - 4, d.w, 4, P.deskFront);
  rect(ctx, d.x, d.y + d.h - 4, d.w, 1, P.deskFrontLo);
  // Laptop (layar menghadap penonton; warna layar = status)
  const lx = laptopX ?? d.x + 3;
  const my = d.y - 4;
  rect(ctx, lx, my, 12, 7, P.monitorBody);
  let screen = P.screenIdle;
  if (flash) screen = '#ffffff';
  else if (status === 'working') screen = '#4cc3e8';
  else if (status === 'done') screen = '#62c46f';
  else if (status === 'blocked') screen = reduced || Math.floor(time * 3) % 2 ? '#e04848' : '#8f2b2b';
  rect(ctx, lx + 1, my + 1, 10, 4, screen);
  if (status === 'working' && !flash) {
    for (let i = 0; i < 2; i++) {
      const len = reduced ? 6 : 3 + ((Math.floor(time * 6) + i * 3) % 6);
      rect(ctx, lx + 2, my + 2 + i * 2, len, 1, '#eafaff');
    }
  }
  rect(ctx, lx - 1, my + 7, 14, 3, '#c9ced6'); // alas keyboard laptop
  rect(ctx, lx - 1, my + 7, 14, 1, '#e8ecef');
  rect(ctx, lx + 2, my + 8, 8, 1, '#8d949c');
  // Gelas kopi (warna divisi) dan satu benda kecil per meja
  const cx = d.x + d.w - 7;
  rect(ctx, cx, d.y + 2, 4, 4, color ?? '#e8ecef');
  rect(ctx, cx + 4, d.y + 3, 1, 2, color ?? '#e8ecef');
  rect(ctx, cx, d.y + 2, 4, 1, '#6b3f22');
  if (status !== 'working' && !reduced && status !== 'blocked') {
    const ph = (time * 0.7 + seed * 0.37) % 1;
    ctx.globalAlpha = (1 - ph) * 0.7;
    rect(ctx, cx + 1 + Math.round(Math.sin(ph * 5 + seed) * 1), d.y - Math.round(ph * 5), 1, 2, P.steam);
    ctx.globalAlpha = 1;
  }
  const extra = seed % 4;
  const ex = lx + 19;
  if (!big) {
    if (extra === 0) {
      rect(ctx, ex, d.y + 3, 5, 4, '#fffdf5');
      rect(ctx, ex, d.y + 3, 1, 4, '#c0392b');
      rect(ctx, ex + 2, d.y + 4, 2, 1, '#8d949c');
    } else if (extra === 1) {
      rect(ctx, ex + 1, d.y + 1, 3, 3, '#3f8a4a');
      rect(ctx, ex, d.y + 4, 5, 3, '#c0603a');
    } else if (extra === 2) {
      rect(ctx, ex, d.y + 3, 3, 3, '#ffd23f');
      rect(ctx, ex + 3, d.y + 4, 3, 3, '#ff8fb3');
    }
  }
  if (big) {
    // baki surat masuk
    rect(ctx, MANAGER_SPOT.inbox.x - 6, MANAGER_SPOT.inbox.y - 2, 12, 6, P.tray);
    rect(ctx, MANAGER_SPOT.inbox.x - 5, MANAGER_SPOT.inbox.y - 1, 10, 4, P.trayIn);
  }
  // LED status
  if (status) rect(ctx, d.x + d.w - 4, d.y + d.h - 3, 2, 2, STATUS_COLOR[status]);
}

function drawHands(ctx, x, deskY, skin, time, typing, reduced = false) {
  const k = typing && !reduced ? Math.floor(time * 8) % 2 : 0;
  rect(ctx, x - 8, deskY + 3 + k, 3, 2, skin);
  rect(ctx, x - 3, deskY + 4 - k, 3, 2, skin);
}

/**
 * Ikon pixel status (GLYPHS di agentStatus.js). (x, y) = tengah-atas ikon.
 * `tick` >= 0 menganimasikan titik "bekerja"; -1 = statis (idle, atau reduced motion).
 */
function drawGlyph(ctx, x, y, key, { alpha = 1, tick = -1 } = {}) {
  const rows = GLYPHS[key];
  if (!rows) return;
  const info = STATUS_INFO[key];
  const colors = { k: P.bubbleBorder, f: info.fill, m: info.mark, p: P.bubblePaper };
  const ox = Math.round(x) - Math.floor(GLYPH_SIZE / 2);
  const oy = Math.round(y);
  ctx.globalAlpha = alpha;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    for (let c = 0; c < row.length; c++) {
      const ch = row[c];
      if (ch === '.') continue;
      let color = colors[ch];
      // ikon bekerja: satu dari tiga titik bergantian "padam" (indikator mengetik)
      if (tick >= 0 && key === 'bekerja' && ch === 'm' && c === 2 + 2 * (tick % 3)) color = info.fill;
      ctx.fillStyle = color;
      ctx.fillRect(ox + c, oy + r, 1, 1);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Penanda status di samping kepala agen (kiri, setinggi kepala), supaya tidak menimpa label meja di
 * baris di atasnya pada klaster padat (Divisi 3D). Muncul dengan gerakan singkat saat status berubah.
 */
export const MARKER_OFFSET = { x: -14, y: -21 };
function drawStatusMarker(ctx, w, time, reduced) {
  const key = uiStatusOf(w.status);
  const age = time - (w.statusSince ?? -Infinity);
  let dy = 0;
  if (!reduced && age >= 0 && age < 0.4) dy = Math.round((1 - easeOutBack(age / 0.4)) * -7);
  if (!reduced && key === 'error' && age >= 0.4 && Math.floor(time * 2.5) % 2 === 0) dy -= 1;
  const tick = !reduced && key === 'bekerja' ? Math.floor(time * 3) : -1;
  drawGlyph(ctx, w.x + MARKER_OFFSET.x, w.y + MARKER_OFFSET.y + dy, key, { alpha: key === 'idle' ? 0.85 : 1, tick });
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
  ctx.fillStyle = P.shadowSoft;
  ctx.fillRect(x + 1, y + 9 + Math.round((1 - Math.sin(Math.PI * env.t)) * 2), 9, 2);
  rect(ctx, x, y, 11, 7, border);
  rect(ctx, x + 1, y + 1, 9, 5, body);
  for (let i = 0; i < 5; i++) {
    rect(ctx, x + 1 + i, y + 1 + Math.min(i, 3), 1, 1, border);
    rect(ctx, x + 9 - i, y + 1 + Math.min(i, 3), 1, 1, border);
  }
}

// ------------------------------------------------------------------ pose karakter (dari state engine + event nyata)

const walkFrame = (dist) => Math.floor(dist / 7);

/** Spesifikasi pose pekerja: hanya berasal dari status/mode engine (event nyata), bukan acak. */
function workerSpec(w, time, rm, seedMs) {
  const speaking = !rm && w.bubble && w.bubble.until > time && Math.floor(time * 8) % 2 === 0;
  if (w.mode !== 'seat') {
    const moving = (w.mode === 'out' && w.rise <= 0) || w.mode === 'back';
    const spec = { dir: w.facing, pose: 'stand', moving, frame: walkFrame(w.walkDist), mouth: speaking };
    if (w.mode === 'pantry' && w.stage === 'drink') {
      spec.act = rm || Math.floor(time * 0.7) % 2 === 0 ? 'sip' : null;
    }
    return spec;
  }
  const spec = { dir: 'down', pose: 'sit', frame: 0, mouth: speaking };
  spec.blink = !rm && (time * 1000 + seedMs) % 4300 < 140;
  const age = time - (w.statusSince ?? -Infinity);
  if (w.status === 'working') {
    spec.act = 'type';
    spec.typeFrame = !rm && Math.floor(time * 8 + seedMs) % 2 === 0;
  } else if (w.status === 'blocked') {
    spec.act = 'stress';
  } else if (w.status === 'done') {
    if (!rm && age >= 0 && age < 1.4) spec.act = 'celebrate';
  } else if (!rm && (time + seedMs / 1000) % 11 < 1.6) {
    spec.act = 'sip'; // ngopi di meja: hanya saat benar-benar idle
  }
  if (!rm && time < w.sendUntil) {
    spec.act = 'type';
    spec.typeFrame = Math.floor(time * 14) % 2 === 0;
  }
  return spec;
}

function managerSpec(m, office, time, rm) {
  const seated = m.state === 'sitting';
  const speaking = !rm && office.managerBubble() && (m.state === 'talking' || office.managerBubble().kind !== 'warning') && Math.floor(time * 8) % 2 === 0;
  if (seated) {
    const typing = m.typingUntil > time;
    return { dir: 'down', pose: 'sit', frame: 0, act: typing ? 'type' : null, typeFrame: !rm && typing && Math.floor(time * 8) % 2 === 0, mouth: speaking, blink: !rm && (time * 1000 + 777) % 4600 < 140 };
  }
  const moving = m.state === 'walking';
  const spec = { dir: m.facing, pose: 'stand', moving, frame: walkFrame(m.walkDist), mouth: speaking };
  if (m.state === 'talking' && !rm && Math.floor(time * 2.5) % 2 === 0) spec.act = 'wave';
  return spec;
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
  let s = text;
  while (s.length > 1 && ctx.measureText(`${s}…`).width > maxWidth) s = s.slice(0, -1);
  return `${s}…`;
}

function drawBubble(ctx, ax, ay, bubble, time, reduced) {
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
  // animasi muncul (ease-out dengan sedikit membal) dan memudar saat hilang; reduced motion: langsung tampil
  const age = time - bubble.born;
  const pop = reduced ? 1 : Math.min(1, age / 0.18);
  const rise = reduced ? 0 : (1 - easeOutBack(pop)) * 4;
  let x = Math.round(ax - w / 2);
  x = Math.max(2, Math.min(W - w - 2, x));
  const y = Math.round(ay - h - 5 + rise);
  const accent = BUBBLE_ACCENT[bubble.kind] ?? '#7f97bf';
  ctx.globalAlpha = reduced ? 1 : Math.min(1, pop * 1.5, Math.max(0, (bubble.until - time) / 0.3));
  const warn = bubble.kind === 'warning';
  const paper = warn ? P.bubbleWarn : P.bubblePaper;
  ctx.fillStyle = P.bubbleBorder;
  ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = paper;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = accent;
  ctx.fillRect(x, y, 2, h);
  // ekor
  const tx = Math.max(x + 4, Math.min(x + w - 5, Math.round(ax)));
  ctx.fillStyle = P.bubbleBorder;
  ctx.fillRect(tx - 2, y + h, 5, 1);
  ctx.fillRect(tx - 1, y + h + 1, 3, 2);
  ctx.fillStyle = paper;
  ctx.fillRect(tx - 1, y + h - 0.5, 3, 1.5);
  ctx.fillRect(tx, y + h + 1, 1, 1);
  ctx.textBaseline = 'top';
  if (tag) {
    ctx.font = `7px ${FONT}`;
    ctx.fillStyle = P.bubbleTag;
    ctx.fillText(tag, x + 5, y + 1.5);
    ctx.font = `${size}px ${FONT}`;
  }
  ctx.fillStyle = warn ? P.bubbleWarnInk : P.bubbleInk;
  lines.forEach((l, i) => ctx.fillText(l, x + 5, y + 2 + tagH + i * lh));
  ctx.globalAlpha = 1;
}

function drawLabels(ctx, office) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `8px ${FONT}`;
  // Judul divisi: kotak warna divisi + teks berwarna ink (kontras AA di atas lantai berwarna tipis).
  for (const { division, rect: r } of zoneList()) {
    ctx.fillStyle = P.bubbleBorder;
    ctx.fillRect(r.x + 3, r.y + 2.5, 6, 6);
    ctx.fillStyle = division.color;
    ctx.fillRect(r.x + 4, r.y + 3.5, 4, 4);
    ctx.fillStyle = P.ink;
    ctx.fillText(divisionName(division).toUpperCase(), r.x + 12, r.y + 8);
  }
  ctx.textAlign = 'center';
  for (const w of office.workers.values()) {
    const by = w.desk.y + w.desk.h;
    ctx.font = `7px ${FONT}`;
    ctx.fillStyle = P.ink;
    ctx.fillText(deskLabel(w.name), w.seat.x, by + 6);
    ctx.fillStyle = P.inkSoft;
    ctx.fillText(STATUS_LABEL[w.status], w.seat.x, by + 12);
  }
  // Poster motivasi, plakat pantry dan ruang rapat (teks lewat t())
  ctx.font = `7px ${FONT}`;
  ctx.fillStyle = P.posterInk;
  for (const p of WALL_ITEMS.posters) {
    const lines = wrapText(ctx, t(p.key), p.w - 5, 3);
    lines.forEach((l, i) => ctx.fillText(l, p.x + p.w / 2, p.y + 11 + i * 6));
  }
  ctx.fillStyle = P.signInk;
  ctx.fillText(t('office.label.pantry'), PANTRY.counter.x + 46, PANTRY.counter.y + 21);
  ctx.fillText(t('office.label.meeting'), MEETING.x + 73, MEETING.y + MEETING.h - 5);
  // Manajer dan CEO: nama (t()) + peran
  ctx.font = `8px ${FONT}`;
  ctx.fillStyle = P.onRug;
  ctx.fillText(`${characterName(MANAGER_ID)} · ${t('office.label.manager')}`, MANAGER_SPOT.seat.x, MANAGER_SPOT.desk.y + MANAGER_SPOT.desk.h + 8);
  ctx.fillStyle = P.onDoor;
  ctx.font = `7px ${FONT}`;
  ctx.fillText(t('office.label.ceo'), DOOR.x + DOOR.w / 2, DOOR.y + 9);
  ctx.fillStyle = P.ink;
  ctx.fillText(characterName(CEO_ID), office.ceo.x, office.ceo.y + FOOT + 9);
  if (office.inbox > 0) {
    ctx.fillStyle = P.onTray;
    ctx.font = `7px ${FONT}`;
    ctx.fillText(String(office.inbox), MANAGER_SPOT.inbox.x, MANAGER_SPOT.inbox.y + 3);
  }
  ctx.textAlign = 'left';
}

// ------------------------------------------------------------------ public API

export function createRenderer(canvas, { theme = 'dark' } = {}) {
  // Urutan pembuatan penting untuk test: pix, lalu bg. Canvas lain dibuat belakangan.
  const pix = document.createElement('canvas');
  pix.width = W;
  pix.height = H;
  const pctx = pix.getContext('2d');
  const bg = document.createElement('canvas');
  bg.width = W;
  bg.height = H;
  // Lapisan label (judul divisi, nama meja, status, poster): berubah jarang, jadi di-cache pada resolusi layar
  // dan digambar ulang hanya saat status/bahasa/tema/ukuran berubah.
  const labels = document.createElement('canvas');
  let labelKey = '';
  const ctx = canvas.getContext('2d');
  const sprites = createSpriteCache(() => document.createElement('canvas'));
  let themeName = theme;
  let prevBg = null; // latar tema sebelumnya, untuk transisi halus saat tema berganti
  let drawn = false;
  let fade = 0; // 1 → 0
  let fadeFrom = null;

  /** Ganti palet kanvas dan gambar ulang latarnya (satu-satunya saat latar digambar ulang). */
  function setTheme(name) {
    if (drawn && name !== themeName) {
      prevBg ??= document.createElement('canvas');
      prevBg.width = W;
      prevBg.height = H;
      prevBg.getContext('2d').drawImage(bg, 0, 0);
      fade = 1;
      fadeFrom = null;
    }
    themeName = name;
    P = paletteFor(name);
    drawBackground(bg.getContext('2d'), P);
    drawn = true;
  }
  setTheme(theme);

  const figure = (look, role, shirt, spec, x, feetY, seated) => {
    const spr = sprites.get(look, role, shirt, P.outline, spec);
    const dx = Math.round(x) - SPR_W / 2;
    if (seated) pctx.drawImage(spr, 0, 0, SPR_W, SIT_ROWS, dx, Math.round(feetY) - 17, SPR_W, SIT_ROWS);
    else {
      drawShadow(pctx, x, feetY + 0);
      pctx.drawImage(spr, dx, Math.round(feetY) - (SPR_H - 1));
    }
  };

  function drawPixels(office, now) {
    const time = office.time;
    const rm = Boolean(office.reducedMotion);
    pctx.imageSmoothingEnabled = false;
    pctx.drawImage(bg, 0, 0);
    if (fade > 0 && prevBg && !rm) {
      pctx.globalAlpha = fade;
      pctx.drawImage(prevBg, 0, 0);
      pctx.globalAlpha = 1;
    }
    drawSkyFx(pctx, P, time, { rain: rm ? 0 : office.rainLevel ?? 0, reduced: rm });
    drawClock(pctx, P, now, rm);
    if (!rm) drawSteam(pctx, P, time);

    const items = [];
    for (const w of office.workers.values()) {
      const look = lookFor(w.name);
      const shirt = w.division.color;
      const seedMs = (hash(w.name) % 4000) + 1;
      const seated = w.mode === 'seat';
      const spec = workerSpec(w, time, rm, seedMs);
      const skin = SKINS[look.skin % SKINS.length].s;
      const behind = !seated && Math.abs(w.x - w.seat.x) < 19 && w.y <= w.seat.y + 6;
      items.push({ y: w.seat.y - 0.1, draw: () => drawChair(pctx, w.seat.x, w.seat.y) });
      items.push({ y: seated || behind ? w.seat.y : w.y + FOOT, draw: () => figure(look, 'worker', shirt, spec, w.x, seated ? w.seat.y : w.y + FOOT, seated) });
      items.push({ y: w.desk.y + 0.5, draw: () => {
        drawDesk(pctx, w.desk, {
          status: w.status, t: time + w.seat.x * 0.01, color: w.division.color, reduced: rm, seed: seedMs % 97,
          flash: !rm && time < w.sendUntil && Math.floor(time * 14) % 2 === 0,
        });
        if (seated) drawHands(pctx, w.seat.x, w.desk.y, skin, time + w.seat.x, w.status === 'working' || time < w.sendUntil, rm);
      } });
    }
    const m = office.manager;
    const mLook = lookFor(MANAGER_ID);
    const mSeated = m.state === 'sitting';
    const mSpec = managerSpec(m, office, time, rm);
    const mBehind = !mSeated && Math.abs(m.x - MANAGER_SPOT.seat.x) < 31 && m.y <= MANAGER_SPOT.seat.y + 6;
    items.push({ y: MANAGER_SPOT.seat.y - 0.5, draw: () => drawChair(pctx, MANAGER_SPOT.seat.x, MANAGER_SPOT.seat.y, true) });
    items.push({ y: mSeated || mBehind ? MANAGER_SPOT.seat.y : m.y + FOOT, draw: () => figure(mLook, 'manager', '#3a4256', mSpec, m.x, mSeated ? m.y : m.y + FOOT, mSeated) });
    items.push({ y: MANAGER_SPOT.desk.y + 0.5, draw: () => {
      drawDesk(pctx, MANAGER_SPOT.desk, {
        status: office.manager.typingUntil > time ? 'working' : null,
        t: time,
        color: '#e8ecef',
        big: true,
        reduced: rm,
        laptopX: MANAGER_SPOT.desk.x + 22,
      });
      for (let i = 0; i < Math.min(office.inbox, 4); i++) {
        rect(pctx, MANAGER_SPOT.inbox.x - 4, MANAGER_SPOT.inbox.y - 1 - i, 8, 1, i % 2 ? '#fff8e7' : '#e9dfc9');
      }
      if (mSeated) drawHands(pctx, m.x, MANAGER_SPOT.desk.y, SKINS[mLook.skin].s, time, office.manager.typingUntil > time, rm);
    } });
    // CEO: berdiri di dekat pintu
    const c = office.ceo;
    const cLook = lookFor(CEO_ID);
    const cSpec = { dir: 'down', pose: 'stand', moving: false, frame: 0, mouth: !rm && Boolean(c.bubble) && Math.floor(time * 8) % 2 === 0 };
    if (!rm && time < c.giveUntil) cSpec.act = 'give';
    else if (!rm && time < c.cheerUntil) cSpec.act = 'wave';
    items.push({ y: c.y + FOOT, draw: () => figure(cLook, 'ceo', '#26304f', cSpec, c.x, c.y + FOOT, false) });
    items.sort((a, b) => a.y - b.y);
    for (const it of items) it.draw();

    for (const w of office.workers.values()) drawStatusMarker(pctx, w, time, rm);
    if (office.limitWarning) drawWarningIcon(pctx, m.x + 12, m.y - 21); // di samping kepala, di bawah ekor bubble
    for (const env of office.envelopes) drawEnvelope(pctx, env);
  }

  function draw(office, now = Date.now()) {
    if (fade > 0) {
      fadeFrom ??= office.time;
      fade = Math.max(0, 1 - (office.time - fadeFrom) / 0.35);
      if (!fade) fadeFrom = null;
    }
    drawPixels(office, now);
    const rm = Boolean(office.reducedMotion);
    const cw = canvas.width;
    const ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, cw, ch);
    ctx.drawImage(pix, 0, 0, cw, ch);
    const k = cw / W;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    const key = `${getLang()}|${themeName}|${cw}x${ch}|${office.inbox}|${[...office.workers.values()].map((w) => w.name + w.status[0]).join(',')}`;
    if (key !== labelKey) {
      labels.width = cw;
      labels.height = ch;
      const lctx = labels.getContext('2d');
      lctx.setTransform(k, 0, 0, k, 0, 0);
      drawLabels(lctx, office);
      labelKey = key;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(labels, 0, 0);
    ctx.setTransform(k, 0, 0, k, 0, 0);
    // popup (+1, CEO)
    ctx.textAlign = 'center';
    ctx.font = `8px ${FONT}`;
    for (const p of office.popups) {
      const age = office.time - p.born;
      const rise = rm ? 0 : age * 10;
      ctx.globalAlpha = rm ? 1 : Math.max(0, 1 - age / (p.until - p.born));
      ctx.fillStyle = P.popupShadow;
      ctx.fillText(p.text, p.x + 0.6, p.y - rise + 0.6);
      ctx.fillStyle = P.popup;
      ctx.fillText(p.text, p.x, p.y - rise);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';
    // bubble: urutkan menurut waktu muncul supaya yang terbaru di atas
    const bubbles = [];
    for (const w of office.workers.values()) if (w.bubble) bubbles.push([w.x, w.y - 26, w.bubble]);
    const m = office.manager;
    const mb = office.managerBubble();
    if (mb) bubbles.push([m.x, m.y - 21, mb]);
    if (office.ceo.bubble) bubbles.push([office.ceo.x, office.ceo.y - 21, office.ceo.bubble]);
    bubbles.sort((a, b) => a[2].born - b[2].born);
    for (const [x, y, b] of bubbles) drawBubble(ctx, x, y, b, office.time, rm);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  return { draw, setTheme };
}
