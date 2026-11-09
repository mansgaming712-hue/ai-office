// Tata letak kantor dalam koordinat logis (piksel pixel-art, 1 unit = 1 piksel art).
// Manajer di depan (atas), divisi di bawahnya. Semua karakter duduk di belakang meja menghadap ke bawah;
// titik "front" adalah tempat manajer berdiri saat memberi tugas (lorong di bawah meja).
//
//   baris 1: Divisi Dev (7) | Marketing & Sales (3)
//   baris 2: Konten (2) | Riset (1) | Divisi 3D (4, klaster 2x2)
//   baris 3: Tamu / Lainnya (5 meja, selebar kantor)
import { DIVISIONS, OTHER_DIVISION } from '../../shared/roster.js';

export const W = 480;
export const H = 408;
export const CELL = 8;
export const WALL_H = 28;

export const DOOR = { x: 18, y: 4, w: 24, h: 24, enter: { x: 30, y: 38 } };

export const MANAGER_SPOT = {
  seat: { x: 240, y: 50 },
  desk: { x: 212, y: 52, w: 56, h: 16 },
  inbox: { x: 258, y: 55 },
  rug: { x: 184, y: 30, w: 112, h: 52 },
};

export const ZONES = {
  dev: {
    rect: { x: 8, y: 100, w: 304, h: 116 },
    seats: [[44, 128], [116, 128], [188, 128], [260, 128], [80, 182], [152, 182], [224, 182]],
  },
  sales: {
    rect: { x: 320, y: 100, w: 152, h: 116 },
    seats: [[356, 128], [436, 128], [396, 182]],
  },
  content: {
    rect: { x: 8, y: 222, w: 152, h: 112 },
    seats: [[44, 250], [116, 250]],
  },
  research: {
    rect: { x: 168, y: 222, w: 144, h: 112 },
    seats: [[240, 250]],
  },
  // Klaster meja 3D (2x2). Kunci '3d' bukan identifier JS: akses lewat ZONES['3d'].
  '3d': {
    rect: { x: 320, y: 222, w: 152, h: 112 },
    seats: [[356, 250], [436, 250], [356, 300], [436, 300]],
  },
  other: {
    rect: { x: 8, y: 340, w: 464, h: 62 },
    seats: [[96, 368], [168, 368], [240, 368], [312, 368], [384, 368]],
  },
};

// Dekorasi yang juga menjadi penghalang jalan.
export const DECOR = [
  { kind: 'plant', x: 54, y: 30, w: 12, h: 16 },
  { kind: 'shelf', x: 110, y: 16, w: 44, h: 20 },
  { kind: 'printer', x: 330, y: 30, w: 22, h: 14 },
  { kind: 'cooler', x: 444, y: 28, w: 14, h: 22 },
  { kind: 'plant', x: 462, y: 78, w: 12, h: 16 },
  { kind: 'plant', x: 4, y: 78, w: 12, h: 16 },
];

export function workstation(sx, sy) {
  return {
    seat: { x: sx, y: sy },
    desk: { x: sx - 16, y: sy + 2, w: 32, h: 14 },
    front: { x: sx, y: sy + 28 },
    hit: { x: sx - 18, y: sy - 20, w: 36, h: 38 },
  };
}

/** Kursi untuk tiap agen roster: Map(name → { division, ...workstation }). */
export function rosterSeats() {
  const seats = new Map();
  for (const div of DIVISIONS) {
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
  return [...DIVISIONS, OTHER_DIVISION].map((d) => ({ division: d, rect: ZONES[d.id].rect }));
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
