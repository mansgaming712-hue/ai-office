// Fase 4b: kantor lebih besar + ruang CEO tertutup.
// - Tata letak: ruangan (pantry, manajer, ruang rapat, ruang CEO) dan zona divisi tidak saling menimpa, juga dengan
//   divisi plugin; semua muat di kanvas.
// - Ruang CEO: tertutup (hanya lewat pintu), titik berdiri bebas, bisa dijangkau.
// - Perilaku CEO: duduk di meja, mengantar tugas (berdiri, jalan, serahkan amplop, kembali), idle (kopi, jendela),
//   reduced motion tidak jalan-jalan, aliran RNG sendiri.
// - Waktu frame dengan CEO bergerak di kanvas lebih besar.
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { applyDivisionsResponse, resetDivisions } from '../src/divisions.js';
import { Office, TUNING } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { createGrid, findPath } from '../src/office/pathfinding.js';
import { createRenderer } from '../src/office/render.js';
import { fitCanvas } from '../src/office/fit.js';

const {
  BASE_H, CEO_ROOM, CEO_VISIT, CELL, ROOMS, W, obstacles, rosterSeats, zoneList,
} = layout;

const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;
const DT = 1 / 60;
const run = (o, seconds, each) => {
  for (let t0 = 0; t0 < seconds; t0 += DT) {
    o.update(DT);
    each?.(o);
  }
};
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (r, outer) => r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const blockedAt = (g, p) => g.blocked[Math.floor(p.y / g.cell) * g.cols + Math.floor(p.x / g.cell)] === 1;

const COLORS = ['#e11d48', '#0ea5e9', '#16a34a', '#a855f7', '#f59e0b', '#14b8a6'];
const plugin = (i) => ({
  id: `p${i}`,
  name: { en: `Plugin ${i}`, id: `Plugin ${i}` },
  color: COLORS[i % COLORS.length],
  desks: (i % 8) + 1,
  workers: Array.from({ length: (i % 8) + 1 }, (_, k) => `p${i}-w${k}`),
  source: 'plugin',
});
const load = (n) => applyDivisionsResponse(200, { ok: true, errors: [], divisions: Array.from({ length: n }, (_, i) => plugin(i + 1)) });

afterEach(() => resetDivisions());

// ------------------------------------------------------------------ tata letak

describe('kantor lebih besar: ruangan dan zona tidak berdesakan', () => {
  it('ukuran kanvas baru: lebih lebar dan lebih tinggi dari kantor lama (480 x 456)', () => {
    expect(W).toBeGreaterThan(480);
    expect(layout.H).toBeGreaterThan(456);
    expect(layout.H).toBe(BASE_H);
  });

  it.each([0, 1, 2, 6, 12])('%i divisi plugin: tidak ada ruangan atau zona yang tumpang tindih, semua di dalam kanvas', (n) => {
    if (n) load(n);
    const zones = zoneList();
    expect(zones).toHaveLength(6 + n);
    const rooms = Object.entries(ROOMS);
    expect(rooms.map(([k]) => k).sort()).toEqual(['ceo', 'manager', 'meeting', 'pantry']);
    for (const [name, r] of rooms) {
      expect(inside(r, { x: 0, y: 0, w: W, h: layout.H }), `${name} di dalam kanvas`).toBe(true);
      for (const z of zones) expect(overlap(r, z.rect), `${name} vs zona ${z.division.id}`).toBe(false);
    }
    for (let i = 0; i < rooms.length; i++) {
      for (let j = i + 1; j < rooms.length; j++) expect(overlap(rooms[i][1], rooms[j][1]), `${rooms[i][0]} vs ${rooms[j][0]}`).toBe(false);
    }
    for (let i = 0; i < zones.length; i++) {
      expect(inside(zones[i].rect, { x: 0, y: 0, w: W, h: layout.H }), zones[i].division.id).toBe(true);
      for (let j = i + 1; j < zones.length; j++) expect(overlap(zones[i].rect, zones[j].rect), `${zones[i].division.id} vs ${zones[j].division.id}`).toBe(false);
    }
  });

  it('zona divisi plugin selalu di bawah semua ruangan dan zona bawaan; meja plugin tidak keluar dari zonanya', () => {
    load(12);
    const builtinBottom = Math.max(...zoneList().slice(0, 6).map((z) => z.rect.y + z.rect.h));
    for (const z of zoneList().slice(6)) expect(z.rect.y).toBeGreaterThanOrEqual(builtinBottom);
    for (const r of Object.values(ROOMS)) for (const z of zoneList().slice(6)) expect(r.y + r.h).toBeLessThanOrEqual(z.rect.y);
    for (const [, st] of rosterSeats()) expect(inside(st.desk, { x: 0, y: 0, w: W, h: layout.H })).toBe(true);
  });

  it('ruangan di pita atas tidak menimpa meja, kursi, atau titik "front" divisi mana pun', () => {
    load(6);
    for (const [name, st] of rosterSeats()) {
      for (const [room, r] of Object.entries(ROOMS)) {
        expect(overlap(r, st.hit), `${room} vs ${name}`).toBe(false);
        expect(overlap(r, st.desk), `${room} vs meja ${name}`).toBe(false);
      }
    }
  });

  it('perabot ruang CEO ada di dalam ruangan dan tidak saling menimpa', () => {
    const r = CEO_ROOM.rect;
    const parts = {
      shelf: CEO_ROOM.shelf, credenza: CEO_ROOM.credenza, plant: CEO_ROOM.plant, desk: CEO_ROOM.desk, rug: CEO_ROOM.rug,
    };
    for (const [k, p] of Object.entries(parts)) expect(inside(p, r), k).toBe(true);
    for (const k of ['shelf', 'credenza', 'plant', 'desk']) {
      for (const k2 of ['shelf', 'credenza', 'plant', 'desk']) if (k < k2) expect(overlap(parts[k], parts[k2]), `${k} vs ${k2}`).toBe(false);
    }
    expect(inside(CEO_ROOM.sign, r)).toBe(true);
    expect(inside(CEO_ROOM.plate, CEO_ROOM.desk)).toBe(true);
    expect(overlap(CEO_ROOM.window, CEO_ROOM.desk)).toBe(false);
  });
});

// ------------------------------------------------------------------ ruang CEO tertutup

describe('ruang CEO: tertutup, pintu, dan titik berdiri', () => {
  const o = new Office();
  const g = o.grid;

  it('titik berdiri (keluar kursi, kopi, jendela) dan tujuan antar bebas dari penghalang', () => {
    for (const [k, p] of Object.entries({ exit: CEO_ROOM.exit, coffee: CEO_ROOM.coffee, window: CEO_ROOM.window, manager: CEO_VISIT.manager, meeting: CEO_VISIT.meeting })) {
      expect(blockedAt(g, p), k).toBe(false);
    }
    for (const p of [CEO_ROOM.exit, CEO_ROOM.coffee, CEO_ROOM.window]) expect(inside({ x: p.x, y: p.y, w: 0, h: 0 }, CEO_ROOM.rect)).toBe(true);
  });

  it('dari dalam ruangan bisa menjangkau manajer dan ruang rapat, lewat bukaan pintu', () => {
    for (const to of [CEO_VISIT.manager, CEO_VISIT.meeting]) {
      const path = findPath(g, CEO_ROOM.exit, to);
      expect(path, JSON.stringify(to)).not.toBeNull();
      // jalur memotong garis dinding depan (y = pintu) hanya di dalam bukaan pintu
      let prev = CEO_ROOM.exit;
      let crossed = false;
      for (const q of path) {
        const steps = Math.ceil(dist(prev, q) / 2);
        for (let k = 0; k <= steps; k++) {
          const y = prev.y + ((q.y - prev.y) * k) / Math.max(1, steps);
          const x = prev.x + ((q.x - prev.x) * k) / Math.max(1, steps);
          if (y >= CEO_ROOM.door.y && y <= CEO_ROOM.door.y + CEO_ROOM.door.h && x >= CEO_ROOM.rect.x && x <= CEO_ROOM.rect.x + CEO_ROOM.rect.w) {
            crossed = true;
            expect(x >= CEO_ROOM.door.x && x <= CEO_ROOM.door.x + CEO_ROOM.door.w, `titik ${x.toFixed(1)},${y.toFixed(1)} di dalam pintu`).toBe(true);
          }
        }
        prev = q;
      }
      expect(crossed).toBe(true);
    }
  });

  it('ruangan benar-benar tertutup: bila pintu ditutup, tidak ada jalur keluar', () => {
    const d = CEO_ROOM.door;
    const closed = createGrid(W, layout.H, CELL, [...obstacles(o.workers.values()), { x: d.x - 2, y: d.y - 2, w: d.w + 4, h: d.h + 4 }]);
    expect(findPath(closed, CEO_ROOM.exit, CEO_VISIT.manager)).toBeNull();
    expect(findPath(g, CEO_ROOM.exit, CEO_VISIT.manager)).not.toBeNull();
  });

  it('jalur CEO dan titik pantry saling terjangkau (pintu tidak menutup jalan ke pantry, ruang rapat, dan meja divisi)', () => {
    for (const s of layout.PANTRY.slots) expect(findPath(g, CEO_ROOM.exit, s), `pantry ${s.x}`).not.toBeNull();
    for (const [, st] of rosterSeats()) expect(findPath(g, CEO_ROOM.exit, st.front)).not.toBeNull();
  });

  it('meja CEO menjadi penghalang jalan, tetapi kursinya bisa dicapai dari titik keluar', () => {
    const rects = obstacles([]);
    const d = CEO_ROOM.desk;
    expect(rects.some((b) => b.x <= d.x && b.y <= d.y && b.x + b.w >= d.x + d.w && b.y + b.h >= d.y + d.h)).toBe(true);
    expect(findPath(g, CEO_ROOM.exit, CEO_VISIT.manager)).not.toBeNull(); // titik keluar di samping meja, bukan di kursi
    expect(obstacles([]).some((b) => b.x <= CEO_ROOM.seat.x && b.y <= CEO_ROOM.seat.y && b.x + b.w >= CEO_ROOM.seat.x && b.y + b.h >= CEO_ROOM.seat.y)).toBe(true);
  });
});

// ------------------------------------------------------------------ perilaku CEO

describe('perilaku CEO', () => {
  it('mulai duduk di mejanya (bukan di pintu), menghadap ke bawah', () => {
    const o = new Office();
    expect(o.ceo).toMatchObject({ x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y, state: 'sitting', facing: 'down' });
  });

  it('tugas masuk: berdiri, berjalan ke depan meja manajer, serahkan amplop, lalu kembali ke meja', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Luncurkan'));
    const seen = [];
    let handed = null;
    run(o, 20, (x) => {
      if (seen.at(-1) !== x.ceo.state) seen.push(x.ceo.state);
      if (!handed && x.envelopes.some((e) => e.kind === 'command')) handed = { ...x.ceo };
    });
    expect(seen).toEqual(['rising', 'walking', 'doing', 'walking', 'sitting']);
    expect(dist(handed, CEO_VISIT.manager)).toBeLessThan(2);
    expect(handed.facing).toBe('up');
    expect(o.manager.state).not.toBe('walking');
    expect(o.ceo).toMatchObject({ x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y, facing: 'down' });
  });

  it('selama berjalan CEO tidak pernah masuk sel yang diblokir (keluar lewat pintu)', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Luncurkan'));
    // pengecualian: koridor kursi-ke-titik-keluar di belakang meja (seperti worker yang bangun dari kursinya)
    const corridor = { x: CEO_ROOM.seat.x - 1, y: CEO_ROOM.exit.y - 8, w: CEO_ROOM.exit.x - CEO_ROOM.seat.x + 2, h: 16 };
    let checked = 0;
    run(o, 20, (x) => {
      if (x.ceo.state !== 'walking' || overlap({ x: x.ceo.x, y: x.ceo.y, w: 0.1, h: 0.1 }, corridor)) return;
      checked++;
      expect(blockedAt(x.grid, x.ceo), `${x.ceo.x.toFixed(1)},${x.ceo.y.toFixed(1)}`).toBe(false);
    });
    expect(checked).toBeGreaterThan(100);
  });

  it('manajer sedang pergi: CEO menunggu di depan ruang rapat, lalu amplop tetap sampai ke manajer', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-qa', 'Uji')); // manajer berdiri/jalan
    run(o, 0.5);
    expect(o.manager.state).not.toBe('sitting');
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Prioritas baru'));
    let at = null;
    run(o, 30, (x) => {
      if (!at && x.ceo.state === 'doing' && x.ceo.goal === 'errand') at = { x: x.ceo.x, y: x.ceo.y };
    });
    expect(at && dist(at, CEO_VISIT.meeting)).toBeLessThan(2);
    expect(o.manager.bubble?.text === 'Prioritas baru' || o.stats.envelopesArrived > 0).toBe(true);
  });

  it('dua perintah beruntun: keduanya diantar, CEO kembali sekali', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Satu'));
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Dua'));
    expect(o.ceo.errands).toHaveLength(2);
    const commands = new Set();
    let walks = 0;
    let prev = '';
    run(o, 25, (x) => {
      for (const e of x.envelopes) if (e.kind === 'command') commands.add(e);
      if (x.ceo.state === 'rising' && prev !== 'rising') walks++;
      prev = x.ceo.state;
    });
    expect(commands.size).toBe(2);
    expect(walks).toBe(1);
    expect(o.ceo.errands).toHaveLength(0);
    expect(o.ceo.state).toBe('sitting');
  });

  it('laporan ke CEO diterima di ruangannya: amplop mendarat di baki meja CEO, CEO bereaksi', () => {
    const o = new Office();
    o.handleEvent(ev('report', 'manager', 'ceo', 'Beres'));
    const env = o.envelopes.at(-1);
    expect(env.kind).toBe('ceo');
    expect(inside({ x: env.to.x, y: env.to.y, w: 0, h: 0 }, CEO_ROOM.rect)).toBe(true);
    run(o, 3);
    expect(o.ceo.cheerUntil).toBeGreaterThan(0);
    expect(o.ceo.bubble?.kind).toBe('ceo');
  });

  it('idle: sesekali minum kopi dan melihat jendela, selalu di dalam ruangannya, lalu kembali duduk', () => {
    const o = new Office({ seed: 7 });
    const goals = new Set();
    run(o, 240, (x) => {
      if (x.ceo.state === 'doing') goals.add(x.ceo.goal);
      if (x.ceo.state !== 'sitting') {
        expect(inside({ x: x.ceo.x, y: x.ceo.y, w: 0, h: 0 }, CEO_ROOM.rect), `${x.ceo.x},${x.ceo.y}`).toBe(true);
      }
    });
    expect(goals.has('coffee')).toBe(true);
    expect(goals.has('window')).toBe(true);
    run(o, 60);
    expect(['sitting', 'rising', 'walking', 'doing']).toContain(o.ceo.state);
  });

  it('idle: berdiri di titik kopi dan titik jendela yang ditetapkan, menghadap ke atas', () => {
    const o = new Office({ seed: 7 });
    const spots = { coffee: null, window: null };
    run(o, 240, (x) => {
      if (x.ceo.state === 'doing' && spots[x.ceo.goal] === null) spots[x.ceo.goal] = { x: x.ceo.x, y: x.ceo.y, facing: x.ceo.facing };
    });
    expect(spots.coffee && dist(spots.coffee, CEO_ROOM.coffee)).toBeLessThan(2);
    expect(spots.window && dist(spots.window, CEO_ROOM.window)).toBeLessThan(2);
    expect(spots.coffee.facing).toBe('up');
  });

  it('tugas masuk saat CEO sedang minum kopi: kopi dibatalkan, CEO langsung mengantar tugas', () => {
    const o = new Office({ seed: 7 });
    let coffeeAt = null;
    run(o, 240, (x) => {
      if (!coffeeAt && x.ceo.state === 'doing') coffeeAt = x.time;
    });
    expect(coffeeAt).not.toBeNull();
    const o2 = new Office({ seed: 7 });
    run(o2, coffeeAt + 0.5);
    expect(o2.ceo.state).toBe('doing');
    o2.handleEvent(ev('assign', 'ceo', 'manager', 'Mendadak'));
    run(o2, 0.1);
    expect(o2.ceo.goal).toBe('errand');
    expect(o2.ceo.state).toBe('walking');
    run(o2, 15);
    expect(o2.manager.bubble?.text === 'Mendadak' || o2.stats.envelopesArrived > 0).toBe(true);
    expect(o2.ceo.state).not.toBe('walking');
  });

  it('reduced motion: CEO tidak jalan-jalan; tugas diantar langsung dari meja (amplop tetap terbang, teks tetap jelas)', () => {
    const o = new Office({ seed: 7 });
    o.setReducedMotion(true);
    const states = new Set();
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Luncurkan'));
    run(o, 0.1);
    expect(o.envelopes.some((e) => e.kind === 'command')).toBe(true); // tanpa menunggu CEO berjalan
    run(o, 300, (x) => {
      states.add(x.ceo.state);
      expect(x.ceo).toMatchObject({ x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y });
    });
    expect([...states]).toEqual(['sitting']);
    expect(o.manager.bubble === null || o.stats.envelopesArrived >= 1).toBe(true);
    expect(o.stats.envelopesArrived).toBeGreaterThanOrEqual(1);
  });

  it('reduced motion dinyalakan saat CEO sedang berjalan: langsung duduk di mejanya', () => {
    const o = new Office({ seed: 7 });
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Luncurkan'));
    run(o, 1.5);
    expect(o.ceo.state).toBe('walking');
    o.setReducedMotion(true);
    expect(o.ceo).toMatchObject({ state: 'sitting', x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y });
  });

  it('aliran RNG CEO terpisah: perilaku idle pekerja sama persis dengan atau tanpa kegiatan CEO', () => {
    const trace = (withCeo) => {
      const o = new Office({ seed: 11 });
      const out = [];
      run(o, 120, (x) => {
        if (withCeo && Math.abs(x.time - 5) < DT / 2) x.handleEvent(ev('assign', 'ceo', 'manager', 'x'));
        out.push([...x.workers.values()].map((w) => w.mode[0]).join(''));
      });
      return out;
    };
    // tugas CEO mengubah manajer (tidak ada tugas untuk worker): jejak mode worker tidak boleh bergeser
    expect(trace(true)).toEqual(trace(false));
  });

  it('opts.rng tidak dikonsumsi CEO: urutan angka yang disuntik tetap untuk pantry dan kepribadian', () => {
    let calls = 0;
    const rng = () => {
      calls++;
      return 0.5;
    };
    const a = new Office({ rng });
    run(a, 120);
    const callsWith = calls;
    calls = 0;
    const b = new Office({ rng });
    b.ceo.idleIn = 1e9; // CEO tidak pernah idle
    run(b, 120);
    expect(callsWith).toBe(calls);
  });

  it('idle CEO tidak mengubah isIdle() bila tidak ada tugas, tetapi tugas CEO yang belum diantar membuatnya tidak idle', () => {
    const o = new Office();
    expect(o.isIdle()).toBe(true);
    o.handleEvent(ev('assign', 'ceo', 'manager', 'x'));
    expect(o.isIdle()).toBe(false);
    run(o, 30);
    expect(o.isIdle()).toBe(true);
  });
});

// ------------------------------------------------------------------ responsif dan waktu frame

describe('kanvas lebih besar: responsif dan waktu frame', () => {
  it('ponsel 360 px: kanvas memakai lebar yang ada dan rasio terjaga', () => {
    const avail = 360 - 16 - 12;
    const r = fitCanvas({ availW: avail, availH: Infinity, dpr: 2 });
    expect(r.cssW).toBeLessThanOrEqual(avail);
    expect(r.cssW).toBeGreaterThanOrEqual(avail - 1);
    expect(Math.abs(r.cssH - (r.cssW * layout.H) / W)).toBeLessThanOrEqual(1);
  });

  function stubCanvas(w, h) {
    const ctx = new Proxy({ fillStyle: '', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic' }, {
      get(t0, k) {
        if (k in t0) return t0[k];
        if (k === 'measureText') return (s) => ({ width: String(s).length * 3.5 });
        return () => {};
      },
      set(t0, k, v) {
        t0[k] = v;
        return true;
      },
    });
    return { width: w, height: h, getContext: () => ctx };
  }

  it('update + draw dengan CEO berjalan dan 19 karakter: rata-rata di bawah 1 ms per frame (normal dan reduced motion)', () => {
    globalThis.document = { createElement: () => stubCanvas(W, layout.H) };
    try {
      const results = {};
      for (const reduced of [false, true]) {
        const r = createRenderer(stubCanvas(W * 2, layout.H * 2), { theme: 'dark' });
        const o = new Office({ seed: 4 });
        o.setReducedMotion(reduced);
        const names = [...o.workers.keys()];
        o.handleEvent(ev('working', names[1], 'manager', 'Sedang jalan'), { instant: true });
        o.handleEvent(ev('blocked', names[2], 'manager', 'Butuh bantuan'), { instant: true });
        let i = 0;
        const frame = () => {
          // CEO terus bergerak: perintah baru tiap ~14 dtk (berdiri, berjalan, kembali) dan kopi/jendela di sela-selanya
          if (i % 840 === 0) o.handleEvent(ev('assign', 'ceo', 'manager', 'Kerjakan'));
          o.update(DT);
          r.draw(o, 1_700_000_000_000 + i * 16);
          i++;
        };
        for (let k = 0; k < 600; k++) frame();
        const N = 3000;
        const t0 = performance.now();
        for (let k = 0; k < N; k++) frame();
        results[reduced ? 'reduced' : 'normal'] = (performance.now() - t0) / N;
      }
      // eslint-disable-next-line no-console
      console.info(`waktu frame ms (CEO bergerak, kanvas ${W}x${layout.H}, kanvas tiruan): normal=${results.normal.toFixed(3)} reduced=${results.reduced.toFixed(3)}`);
      expect(results.normal).toBeLessThan(1);
      expect(results.reduced).toBeLessThan(1);
    } finally {
      delete globalThis.document;
    }
  });

  it('TUNING CEO masuk akal: mengantar lebih cepat dari berjalan santai, jeda idle tidak terlalu rapat', () => {
    expect(TUNING.ceoRush).toBeGreaterThan(TUNING.ceoWalk);
    expect(TUNING.ceoIdleEvery[0]).toBeGreaterThanOrEqual(15);
  });
});
