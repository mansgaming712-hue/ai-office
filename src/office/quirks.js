// Animasi kecil untuk kepribadian worker (HANYA tampilan): kebiasaan idle dan quirk.
// Murni dan ringan: hanya fillRect kecil di kanvas piksel 1:1, tanpa alokasi per frame yang berarti.
// Setiap nilai enum `idle` dan `quirk` di shared/personalities.js WAJIB punya entri di sini (dijaga oleh test).
// Reduced motion: tidak ada quirk bergerak (quirkPhase = -1); hanya quirk statis (headphones) yang tetap tampil.

/**
 * Kebiasaan idle. trip: berjalan ke pantry saat idle (perilaku lama); seat/pantry: nama `act` sprite
 * (sprites.js) di meja / di pantry; 'turn' = menghadap jendela (membelakangi penonton).
 */
export const IDLE_BEHAVIORS = Object.freeze({
  coffee: { trip: true, seat: 'sip', pantry: 'sip' },
  water: { trip: true, seat: 'bottle', pantry: 'bottle' },
  snack: { trip: true, seat: 'snack', pantry: 'snack' },
  plant: { trip: true, seat: 'pour', pantry: 'pour' },
  chat: { trip: true, seat: 'wave', pantry: 'wave' },
  stretch: { trip: false, seat: 'stretch', pantry: 'sip' },
  phone: { trip: false, seat: 'phone', pantry: 'sip' },
  window: { trip: false, seat: 'turn', pantry: 'sip' },
});

/** Perilaku idle untuk nama enum; nilai tak dikenal jatuh ke 'coffee' (netral). */
export const idleBehavior = (kind) => IDLE_BEHAVIORS[kind] ?? IDLE_BEHAVIORS.coffee;

/** Berapa detik kebiasaan idle di meja aktif dalam siklus 11 detik. */
export const idleSeatSeconds = (behavior) => (behavior.seat === 'turn' ? 3.4 : 1.6);

export const QUIRK_CYCLE = 9; // detik per siklus quirk
export const QUIRK_ON = 2.4; // detik aktif dalam siklus

/**
 * Fase quirk 0..1 saat aktif, atau -1 (mati). Hanya bergantung pada `time` (jam engine, dapat disuntik) dan
 * seedMs per karakter, jadi deterministik. Reduced motion selalu -1.
 */
export function quirkPhase(time, seedMs, reduced = false) {
  if (reduced) return -1;
  const c = (time + (seedMs / 1000) * 1.7) % QUIRK_CYCLE;
  return c >= 0 && c < QUIRK_ON ? c / QUIRK_ON : -1;
}

export const YAWN_CYCLE = 13; // detik per jendela peluang menguap (malam/subuh)
export const YAWN_ON = 2.2; // detik menguap bila jendela itu "terpilih"
export const YAWN_CHANCE = 0.35; // peluang per jendela pada tingkat ngantuk 1 (malam); subuh = 0.6 dari itu

/** Satu langkah mulberry32 tanpa state (biji + nomor jendela → 0..1): deterministik, tanpa alokasi. */
function roll(seed, n) {
  let a = (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(n | 0, 0x6d2b79f5)) >>> 0;
  a = (a + 0x6d2b79f5) >>> 0;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Fase menguap 0..1 (atau -1 = tidak) untuk worker idle di fase ngantuk (`sleepy` 0..1, daycycle.js). Waktu dibagi jadi
 * jendela YAWN_CYCLE detik per worker (digeser oleh seedMs); tiap jendela "terpilih" dengan peluang YAWN_CHANCE * sleepy,
 * ditentukan deterministik dari seedMs dan nomor jendela. Hanya bergantung pada `time` (jam engine) jadi dapat dites.
 * Reduced motion atau sleepy 0: selalu -1.
 */
export function yawnPhase(time, seedMs, sleepy, reduced = false) {
  if (reduced || !(sleepy > 0)) return -1;
  const c = (time + (seedMs / 1000) * 2.3) / YAWN_CYCLE;
  const n = Math.floor(c);
  const within = (c - n) * YAWN_CYCLE;
  if (within >= YAWN_ON || roll(seedMs, n) >= YAWN_CHANCE * sleepy) return -1;
  return within / YAWN_ON;
}

const px = (ctx, x, y, w, h, color) => {
  ctx.fillStyle = color;
  ctx.fillRect(Math.round(x), Math.round(y), w, h);
};

// a = { x, headY, desk, phase, time, ink, soft }. headY = baris atas sprite duduk.
function drawHum(ctx, a) {
  const y = a.headY - 3 - a.phase * 6;
  ctx.globalAlpha = Math.sin(Math.PI * a.phase);
  px(ctx, a.x + 11, y, 1, 4, a.ink);
  px(ctx, a.x + 9, y + 3, 2, 2, a.ink);
  px(ctx, a.x + 12, y, 2, 1, a.ink);
  ctx.globalAlpha = 1;
}

function drawPenSpin(ctx, a) {
  const f = Math.floor(a.time * 10) % 4;
  const x = a.x + 6;
  const y = a.desk.y + 1;
  if (f === 0) px(ctx, x, y + 2, 5, 1, '#c0392b');
  else if (f === 2) px(ctx, x + 2, y, 1, 5, '#c0392b');
  else for (let i = 0; i < 4; i++) px(ctx, f === 1 ? x + 1 + i : x + 4 - i, y + 3 - i, 1, 1, '#c0392b');
  px(ctx, x + 2, y + 2, 1, 1, '#f4f4f4');
}

function drawDeskTap(ctx, a) {
  const on = Math.floor(a.time * 8) % 2 === 0;
  px(ctx, a.x + 5, a.desk.y - 1, 1, 1, a.soft);
  if (on) px(ctx, a.x + 8, a.desk.y - 2, 1, 1, a.soft);
  else px(ctx, a.x + 3, a.desk.y - 2, 1, 1, a.soft);
}

function drawYawn(ctx, a) {
  const y = a.headY - 1 - a.phase * 3;
  ctx.globalAlpha = Math.sin(Math.PI * a.phase);
  px(ctx, a.x + 9, y, 3, 1, a.ink);
  px(ctx, a.x + 10, y + 1, 1, 1, a.ink);
  px(ctx, a.x + 9, y + 2, 3, 1, a.ink);
  ctx.globalAlpha = 1;
}

function drawPlantTalk(ctx, a) {
  const n = 1 + (Math.floor(a.phase * 6) % 3);
  const x = a.desk.x + a.desk.w - 20;
  for (let i = 0; i < n; i++) px(ctx, x + i * 3, a.desk.y - 6 - (i % 2), 2, 1, '#3f8a4a');
}

function drawDoodle(ctx, a) {
  const x = a.x + 7;
  const y = a.desk.y + 1;
  px(ctx, x, y, 7, 5, '#fffdf5');
  const lines = 1 + Math.min(2, Math.floor(a.phase * 3));
  for (let i = 0; i < lines; i++) px(ctx, x + 1, y + 1 + i * 2, 3 + ((i * 2) % 3), 1, a.ink);
}

/**
 * Quirk. act: pose lengan sprite saat fase aktif dan tidak ada pose lain; mouth: mulut terbuka;
 * phones: aksesori statis di sprite (tetap tampil saat reduced motion); tap: tangan mengetuk meja;
 * needsDesk: hanya digambar bila karakter punya meja;
 * draw: hiasan kecil di kanvas piksel.
 */
export const QUIRKS = Object.freeze({
  hum: { draw: drawHum },
  'pen-spin': { needsDesk: true, draw: drawPenSpin },
  'desk-tap': { needsDesk: true, tap: true, draw: drawDeskTap },
  yawn: { mouth: true, draw: drawYawn },
  glasses: { act: 'glasses' },
  headphones: { phones: true },
  'plant-talk': { needsDesk: true, draw: drawPlantTalk },
  doodle: { needsDesk: true, draw: drawDoodle },
});
