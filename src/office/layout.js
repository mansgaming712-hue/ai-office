// Tata letak kantor dalam koordinat logis (piksel pixel-art, 1 unit = 1 piksel art).
// Kantor lantai atas di kawasan SCBD/Sudirman, Jakarta. Dinding atas berisi jendela kaca besar (skyline), pintu masuk,
// papan tulis, jam, poster, dan AC split. Di bawahnya (pita atas): pantry (kiri), karpet manajer (tengah), ruang rapat
// kaca, dan RUANG CEO tertutup (kanan, partisi kaca + pintu), lalu divisi. Semua karakter duduk di belakang meja
// menghadap ke bawah; titik "front" adalah tempat manajer berdiri saat memberi tugas (lorong di bawah meja).
//
//   pita atas: Pantry | Manajer | Ruang rapat | Ruang CEO (y 34..152)
//   baris 1: Divisi Dev (7) | Marketing & Sales (3)
//   baris 2: Konten (2) | Riset (1) | Divisi 3D (4, klaster 2x2)
//   baris 3: Tamu / Lainnya (5 meja, selebar kantor)
//   baris 4+: divisi plugin (dua zona per baris, maks. 3 meja per baris zona), hanya bila ada. Tanpa plugin,
//             seluruh denah dan H persis seperti di atas. Zona plugin selalu di bawah semua ruangan di atas.
import { DIVISIONS, OTHER_DIVISION } from '../../shared/roster.js';
import { getPluginDivisions, subscribe } from '../divisions.js';

export const W = 640;
/** Tinggi kanvas logis. `let` + live binding: berubah hanya lewat applyLayout() saat roster plugin berubah. */
export let H = 498;
export const BASE_H = 498;
export const CELL = 8;
export const WALL_H = 60;
/** Selisih vertikal antara titik logis karakter (pinggang) dan telapak kaki sprite 16x24. */
export const FOOT = 7;

export const DOOR = { x: 18, y: 34, w: 24, h: 24, enter: { x: 30, y: 72 } };

export const MANAGER_SPOT = {
  seat: { x: 240, y: 82 },
  desk: { x: 212, y: 84, w: 56, h: 16 },
  inbox: { x: 258, y: 87 },
  rug: { x: 184, y: 62, w: 112, h: 52 },
};

// Jendela kaca besar (kiri di atas pantry, kanan di atas ruang rapat) dan elemen dinding. Dipakai renderer.
export const WINDOWS = [
  { x: 52, y: 7, w: 120, h: 38 },
  { x: 308, y: 7, w: 126, h: 38 },
  { x: 498, y: 7, w: 126, h: 38 }, // jendela ruang CEO
];
export const WALL_ITEMS = {
  ac: { x: 186, y: 3, w: 44, h: 9 },
  board: { x: 180, y: 15, w: 46, h: 26 },
  clock: { x: 240, y: 25 },
  posters: [
    { x: 256, y: 12, w: 24, h: 32, key: 'office.poster.1' },
    { x: 284, y: 12, w: 24, h: 32, key: 'office.poster.2' },
  ],
  meetBoard: { x: 440, y: 12, w: 30, h: 28 },
};

// Pantry: dispenser galon + meja counter. Titik berdiri (pinggang) untuk agen yang ngopi.
export const PANTRY = {
  counter: { x: 76, y: 46, w: 92, h: 26 },
  dispenser: { x: 58, y: 34, w: 16, h: 38 },
  slots: [{ x: 98, y: 80 }, { x: 120, y: 80 }, { x: 142, y: 80 }],
};

export const MEETING = { x: 316, y: 58, w: 158, h: 68 };

// Ruang CEO: ruangan tertutup (partisi kaca + pintu) di kanan pita atas. Punggung ruangan = dinding utama (jendela di atasnya).
// `seat`/`desk` mengikuti pola meja manajer (desk.y = seat.y + 2). Titik berdiri (`exit`, `coffee`, `window`) bebas dari penghalang.
export const CEO_ROOM = {
  rect: { x: 484, y: 62, w: 152, h: 90 },
  door: { x: 492, y: 138, w: 32, h: 14 }, // bukaan di dinding kaca depan
  seat: { x: 576, y: 100 },
  desk: { x: 541, y: 102, w: 70, h: 16 },
  tray: { x: 592, y: 105 }, // baki masuk di meja (tujuan amplop laporan)
  sign: { x: 584, y: 140, w: 34, h: 8 }, // plakat "CEO" di kaca depan
  plate: { x: 545, y: 105, w: 16, h: 6 }, // papan nama di meja
  rug: { x: 530, y: 82, w: 96, h: 54 },
  shelf: { x: 490, y: 64, w: 36, h: 30 },
  credenza: { x: 586, y: 64, w: 32, h: 18 }, // meja kopi (mesin kopi) di dinding belakang
  plant: { x: 620, y: 64, w: 12, h: 16 },
  // titik berdiri (pinggang)
  exit: { x: 618, y: 100 }, // samping meja (sejajar kursi: CEO berjalan di belakang meja), tempat CEO bangun dari kursi
  coffee: { x: 606, y: 92 },
  window: { x: 538, y: 82 },
  // dinding kaca: kiri, kanan, dan depan (dua potong di kiri/kanan pintu)
  walls: [
    { x: 484, y: 62, w: 4, h: 90 },
    { x: 632, y: 62, w: 4, h: 90 },
    { x: 484, y: 138, w: 8, h: 14 },
    { x: 524, y: 138, w: 112, h: 14 },
  ],
};

// Tujuan CEO saat mengantar tugas (di luar ruangannya): depan meja manajer, atau depan ruang rapat bila manajer sedang pergi.
export const CEO_VISIT = {
  manager: { x: 258, y: 112 },
  meeting: { x: 394, y: 134 },
};

/** Kotak pembatas tiap ruangan di pita atas (dipakai test tumpang-tindih terhadap zona divisi). */
export const ROOMS = {
  pantry: { x: 56, y: 34, w: 114, h: 62 },
  manager: MANAGER_SPOT.rug,
  meeting: MEETING,
  ceo: CEO_ROOM.rect,
};

export const ZONES = {
  dev: {
    rect: { x: 8, y: 162, w: 372, h: 124 },
    seats: [[52, 196], [140, 196], [228, 196], [316, 196], [96, 252], [184, 252], [272, 252]],
  },
  sales: {
    rect: { x: 388, y: 162, w: 244, h: 124 },
    seats: [[436, 196], [520, 196], [478, 252]],
  },
  content: {
    rect: { x: 8, y: 298, w: 200, h: 120 },
    seats: [[52, 332], [140, 332]],
  },
  research: {
    rect: { x: 216, y: 298, w: 200, h: 120 },
    seats: [[316, 332]],
  },
  // Klaster meja 3D (2x2). Kunci '3d' bukan identifier JS: akses lewat ZONES['3d'].
  '3d': {
    rect: { x: 424, y: 298, w: 208, h: 120 },
    seats: [[468, 332], [556, 332], [468, 382], [556, 382]],
  },
  other: {
    rect: { x: 8, y: 430, w: 624, h: 62 },
    seats: [[120, 458], [220, 458], [320, 458], [420, 458], [520, 458]],
  },
};

// ------------------------------------------------------------------ zona divisi plugin (dinamis)

export const PLUGIN_LAYOUT = {
  top: 498, // 6 di bawah zona Tamu (berakhir di y=492)
  gap: 6,
  zoneW: 308,
  colX: [8, 324],
  cols: 3, // meja per baris di dalam zona
  seatDx: 88,
  seatDy: 50,
  headerH: 28, // jarak zona ke baris meja pertama (sama dengan zona Tamu)
  footH: 34,
};

/** Hitung zona plugin secara deterministik (murni). → { zones: {id: {rect, seats}}, height }. */
export function computePluginLayout(plugins) {
  const L = PLUGIN_LAYOUT;
  const zones = {};
  let y = L.top;
  for (let i = 0; i < plugins.length; i += 2) {
    const pair = plugins.slice(i, i + 2);
    const heights = pair.map((d) => L.headerH + (Math.ceil(d.desks / L.cols) - 1) * L.seatDy + L.footH);
    const rowH = Math.max(...heights);
    pair.forEach((d, c) => {
      const x = L.colX[c];
      const seats = [];
      for (let k = 0; k < d.desks; k++) {
        seats.push([x + 66 + (k % L.cols) * L.seatDx, y + L.headerH + Math.floor(k / L.cols) * L.seatDy]);
      }
      zones[d.id] = { rect: { x, y, w: L.zoneW, h: rowH }, seats };
    });
    y += rowH + L.gap;
  }
  return { zones, height: plugins.length ? y : BASE_H };
}

let pluginIds = [];

/** Terapkan roster plugin ke ZONES dan H. Dipanggil otomatis saat src/divisions.js berubah. */
export function applyLayout(plugins = getPluginDivisions()) {
  for (const id of pluginIds) delete ZONES[id];
  const { zones, height } = computePluginLayout(plugins);
  pluginIds = Object.keys(zones);
  for (const id of pluginIds) ZONES[id] = zones[id];
  H = height;
}
subscribe(() => applyLayout());
applyLayout();

// Dekorasi yang juga menjadi penghalang jalan.
export const DECOR = [
  { kind: 'dispenser', ...PANTRY.dispenser },
  { kind: 'counter', ...PANTRY.counter },
  { kind: 'meeting', ...MEETING },
  { kind: 'plant', x: 4, y: 100, w: 12, h: 16 },
  { kind: 'plant', x: 172, y: 98, w: 12, h: 16 },
  { kind: 'plant', x: 300, y: 100, w: 12, h: 16 },
  // ruang CEO: rak buku, meja kopi, tanaman, dan dinding kaca (bukaan pintu dibiarkan kosong)
  { kind: 'ceoShelf', ...CEO_ROOM.shelf },
  { kind: 'ceoCredenza', ...CEO_ROOM.credenza },
  { kind: 'plant', ...CEO_ROOM.plant },
  ...CEO_ROOM.walls.map((w) => ({ kind: 'ceoWall', ...w })),
];

export function workstation(sx, sy) {
  return {
    seat: { x: sx, y: sy },
    desk: { x: sx - 16, y: sy + 2, w: 32, h: 14 },
    front: { x: sx, y: sy + 28 },
    exit: { x: sx + 24, y: sy + 4 }, // titik bangun dari kursi (di samping meja) saat agen berjalan ke pantry
    hit: { x: sx - 18, y: sy - 20, w: 36, h: 38 },
  };
}

/** Kursi untuk tiap agen roster: Map(name → { division, ...workstation }). */
export function rosterSeats() {
  const seats = new Map();
  for (const div of [...DIVISIONS, ...getPluginDivisions()]) {
    const zone = ZONES[div.id];
    div.agents.forEach((name, i) => {
      const [sx, sy] = zone.seats[i];
      seats.set(name, { division: div, ...workstation(sx, sy) });
    });
  }
  return seats;
}

/** Kursi untuk agen tamu ke-n (bukan anggota roster). */
export function otherSeat(index) {
  const seats = ZONES.other.seats;
  const [sx, sy] = seats[index % seats.length];
  return { division: OTHER_DIVISION, ...workstation(sx, sy) };
}

export function zoneList() {
  return [...DIVISIONS, OTHER_DIVISION, ...getPluginDivisions()].map((d) => ({ division: d, rect: ZONES[d.id].rect }));
}

/** Persegi penghalang untuk pathfinding. `stations` = iterable workstation. */
export function obstacles(stations) {
  const rects = [];
  const pad = (r, px, py) => ({ x: r.x - px, y: r.y - py, w: r.w + px * 2, h: r.h + py * 2 });
  rects.push({ x: 0, y: 0, w: W, h: WALL_H + 4 });
  rects.push(pad(MANAGER_SPOT.desk, 3, 3));
  rects.push(pad(CEO_ROOM.desk, 3, 3));
  rects.push({ x: CEO_ROOM.seat.x - 7, y: CEO_ROOM.seat.y - 10, w: 14, h: 12 });
  for (const d of DECOR) rects.push(pad(d, 2, 2));
  for (const s of stations) {
    rects.push(pad(s.desk, 3, 3));
    rects.push({ x: s.seat.x - 7, y: s.seat.y - 10, w: 14, h: 12 });
  }
  return rects;
}
