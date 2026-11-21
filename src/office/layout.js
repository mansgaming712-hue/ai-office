// Tata letak kantor dalam koordinat logis (piksel pixel-art, 1 unit = 1 piksel art).
// Kantor lantai atas di kawasan SCBD/Sudirman, Jakarta. Dinding atas berisi jendela kaca besar (skyline), pintu CEO,
// papan tulis, jam, poster, dan AC split. Di bawahnya: pantry (kiri), karpet manajer (tengah), ruang rapat kaca (kanan),
// lalu divisi. Semua karakter duduk di belakang meja menghadap ke bawah; titik "front" adalah tempat manajer berdiri
// saat memberi tugas (lorong di bawah meja).
//
//   baris 1: Divisi Dev (7) | Marketing & Sales (3)
//   baris 2: Konten (2) | Riset (1) | Divisi 3D (4, klaster 2x2)
//   baris 3: Tamu / Lainnya (5 meja, selebar kantor)
//   baris 4+: divisi plugin (dua zona per baris, maks. 3 meja per baris zona), hanya bila ada. Tanpa plugin,
//             seluruh denah dan H persis seperti di atas.
import { DIVISIONS, OTHER_DIVISION } from '../../shared/roster.js';
import { getPluginDivisions, subscribe } from '../divisions.js';

export const W = 480;
/** Tinggi kanvas logis. `let` + live binding: berubah hanya lewat applyLayout() saat roster plugin berubah. */
export let H = 456;
export const BASE_H = 456;
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

export const ZONES = {
  dev: {
    rect: { x: 8, y: 132, w: 304, h: 124 },
    seats: [[44, 166], [116, 166], [188, 166], [260, 166], [80, 222], [152, 222], [224, 222]],
  },
  sales: {
    rect: { x: 320, y: 132, w: 152, h: 124 },
    seats: [[356, 166], [436, 166], [396, 222]],
  },
  content: {
    rect: { x: 8, y: 262, w: 152, h: 120 },
    seats: [[44, 296], [116, 296]],
  },
  research: {
    rect: { x: 168, y: 262, w: 144, h: 120 },
    seats: [[240, 296]],
  },
  // Klaster meja 3D (2x2). Kunci '3d' bukan identifier JS: akses lewat ZONES['3d'].
  '3d': {
    rect: { x: 320, y: 262, w: 152, h: 120 },
    seats: [[356, 296], [436, 296], [356, 346], [436, 346]],
  },
  other: {
    rect: { x: 8, y: 388, w: 464, h: 62 },
    seats: [[96, 416], [168, 416], [240, 416], [312, 416], [384, 416]],
  },
};

// ------------------------------------------------------------------ zona divisi plugin (dinamis)

export const PLUGIN_LAYOUT = {
  top: 456, // 6 di bawah zona Tamu (berakhir di y=450)
  gap: 6,
  zoneW: 228,
  colX: [8, 244],
  cols: 3, // meja per baris di dalam zona
  seatDx: 72,
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
        seats.push([x + 36 + (k % L.cols) * L.seatDx, y + L.headerH + Math.floor(k / L.cols) * L.seatDy]);
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
  for (const d of DECOR) rects.push(pad(d, 2, 2));
  for (const s of stations) {
    rects.push(pad(s.desk, 3, 3));
    rects.push({ x: s.seat.x - 7, y: s.seat.y - 10, w: 14, h: 12 });
  }
  return rects;
}
