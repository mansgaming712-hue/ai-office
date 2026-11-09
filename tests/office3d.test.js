// Divisi 3D (roster + klaster meja), nama proyek sesi di engine, dan peringatan limit di manajer.
import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { AGENT_NAMES, DIVISIONS, OTHER_DIVISION, divisionOf } from '../shared/roster.js';
import { Office, STATUS_LABEL } from '../src/office/engine.js';
import {
  CELL, DECOR, DOOR, H, MANAGER_SPOT, W, WALL_H, ZONES, obstacles, otherSeat, rosterSeats, workstation, zoneList,
} from '../src/office/layout.js';
import { createGrid, findPath } from '../src/office/pathfinding.js';
import { WARNING_TEXT } from '../src/usage.js';

const NAMES_3D = ['3d-modeler', '3d-materials', '3d-animator', '3d-render'];
const ev = (type, from, to, message = '', extra = {}) => normalizeEvent({ type, from, to, message, ...extra }).event;

function run(office, seconds, each) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    office.update(dt);
    each?.(office);
  }
}

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const inside = (r, o) => r.x >= o.x && r.y >= o.y && r.x + r.w <= o.x + o.w && r.y + r.h <= o.y + o.h;
const cellBlocked = (g, p) => g.blocked[Math.floor(p.y / g.cell) * g.cols + Math.floor(p.x / g.cell)] === 1;

describe('roster: Divisi 3D', () => {
  it('divisi "3d" dengan 4 agen dalam urutan yang ditentukan', () => {
    const d = DIVISIONS.find((x) => x.id === '3d');
    expect(d).toMatchObject({ id: '3d', name: 'Divisi 3D' });
    expect(d.agents).toEqual(NAMES_3D);
    expect(AGENT_NAMES.slice(-4)).toEqual(NAMES_3D);
    for (const n of NAMES_3D) expect(divisionOf(n).id).toBe('3d');
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length);
  });

  it('warna 3D berbeda jelas dari divisi lain dan dari Tamu', () => {
    const d3 = DIVISIONS.find((x) => x.id === '3d');
    expect(d3.color).toMatch(/^#[0-9a-f]{6}$/i);
    for (const other of [...DIVISIONS.filter((x) => x !== d3), OTHER_DIVISION]) {
      const [a, b] = [rgb(d3.color), rgb(other.color)];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      expect(dist, `${d3.color} vs ${other.id} ${other.color}`).toBeGreaterThan(90);
    }
  });
});

describe('layout: klaster meja 3D', () => {
  const seats = rosterSeats();
  const stations = [...seats.values()];

  it("ZONES['3d'] punya 4 kursi unik di dalam zonanya dan di dalam kanvas", () => {
    const zone = ZONES['3d'];
    expect(zone.seats).toHaveLength(4);
    expect(new Set(zone.seats.map(([x, y]) => `${x},${y}`)).size).toBe(4);
    for (const [x, y] of zone.seats) {
      const ws = workstation(x, y);
      expect(inside(ws.hit, zone.rect), `kursi ${x},${y}`).toBe(true);
      expect(inside(zone.rect, { x: 0, y: 0, w: W, h: H })).toBe(true);
    }
    NAMES_3D.forEach((n, i) => {
      const [x, y] = zone.seats[i];
      expect(seats.get(n).seat).toEqual({ x, y });
      expect(seats.get(n).division.id).toBe('3d');
    });
  });

  it('semua kursi roster + tamu unik dan area kliknya tidak saling tumpang tindih', () => {
    const all = [...stations, ...ZONES.other.seats.map(([x, y]) => workstation(x, y))];
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(intersects(all[i].hit, all[j].hit), `${JSON.stringify(all[i].seat)} vs ${JSON.stringify(all[j].seat)}`).toBe(false);
      }
    }
  });

  it('zona tidak saling tumpang tindih, berada di bawah dinding, dan zona Tamu / Lainnya tetap ada', () => {
    const zones = zoneList();
    expect(zones.map((z) => z.division.id)).toEqual([...DIVISIONS.map((d) => d.id), 'other']);
    expect(zones.find((z) => z.division.id === 'other').division.name).toBe('Tamu / Lainnya');
    for (let i = 0; i < zones.length; i++) {
      expect(zones[i].rect.y).toBeGreaterThan(WALL_H);
      expect(inside(zones[i].rect, { x: 0, y: 0, w: W, h: H })).toBe(true);
      for (let j = i + 1; j < zones.length; j++) {
        expect(intersects(zones[i].rect, zones[j].rect), `${zones[i].division.id} vs ${zones[j].division.id}`).toBe(false);
      }
    }
    expect(ZONES.other.seats.length).toBeGreaterThanOrEqual(4);
    expect(otherSeat(0).division).toBe(OTHER_DIVISION);
  });

  it('meja & kursi 3D tidak bertabrakan dengan penghalang lain (dinding, meja manajer, dekorasi, meja lain)', () => {
    for (const n of NAMES_3D) {
      const me = seats.get(n);
      const others = obstacles(stations.filter((s) => s !== me));
      const mine = [me.desk, { x: me.seat.x - 7, y: me.seat.y - 10, w: 14, h: 12 }];
      for (const r of mine) for (const o of others) expect(intersects(r, o), `${n} ${JSON.stringify(r)} vs ${JSON.stringify(o)}`).toBe(false);
      for (const d of DECOR) expect(intersects(me.hit, d)).toBe(false);
      expect(intersects(me.hit, MANAGER_SPOT.desk)).toBe(false);
    }
  });

  it('titik "front" tiap meja 3D bebas, dan bisa dijangkau dari pintu tanpa menembus penghalang', () => {
    const o = new Office();
    const g = o.grid;
    expect(cellBlocked(g, DOOR.enter)).toBe(false);
    for (const n of NAMES_3D) {
      const w = o.workers.get(n);
      expect(cellBlocked(g, w.front), `front ${n}`).toBe(false);
      const path = findPath(g, DOOR.enter, w.front);
      expect(path, `jalur pintu → ${n}`).not.toBeNull();
      expect(path.at(-1)).toEqual(w.front);
      // sampel tiap 2 px di sepanjang jalur: tidak pernah masuk sel yang diblokir
      let p = DOOR.enter;
      for (const q of path) {
        const steps = Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 2);
        for (let k = 0; k <= steps; k++) {
          const pt = { x: p.x + ((q.x - p.x) * k) / Math.max(1, steps), y: p.y + ((q.y - p.y) * k) / Math.max(1, steps) };
          expect(cellBlocked(g, pt), `${n} titik ${pt.x.toFixed(1)},${pt.y.toFixed(1)}`).toBe(false);
        }
        p = q;
      }
      expect(findPath(g, w.front, MANAGER_SPOT.seat), `kembali dari ${n}`).not.toBeNull();
    }
  });

  it('meja tamu (zona baru) juga bisa dijangkau', () => {
    const g = createGrid(W, H, CELL, obstacles([...stations, ...ZONES.other.seats.map(([x, y]) => workstation(x, y))]));
    for (const [x, y] of ZONES.other.seats) {
      expect(findPath(g, MANAGER_SPOT.seat, workstation(x, y).front), `tamu ${x},${y}`).not.toBeNull();
    }
  });
});

describe('engine: event untuk agen 3D sama seperti agen lain', () => {
  it('assign → manajer berjalan ke meja 3d-render, bubble tugas, status bekerja', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', '3d-render', 'Render 1080x1920'));
    let talked = false;
    run(o, 20, (x) => {
      if (x.manager.state === 'talking' && x.manager.job?.to === '3d-render' && x.manager.bubble?.text === 'Render 1080x1920') talked = true;
    });
    expect(talked).toBe(true);
    expect(o.workers.get('3d-render').status).toBe('working');
    expect(STATUS_LABEL[o.workers.get('3d-render').status]).toBe('bekerja');
    expect(o.manager.state).toBe('sitting');
  });

  it.each(NAMES_3D)('%s: working / done / blocked / report → status, bubble, amplop', (name) => {
    const o = new Office();
    const w = o.workers.get(name);
    expect(w.dynamic).toBe(false);
    expect(w.division.name).toBe('Divisi 3D');
    o.handleEvent(ev('working', name, 'manager', 'proses'));
    expect(w).toMatchObject({ status: 'working', bubble: { text: 'proses', kind: 'working' } });
    o.handleEvent(ev('done', name, 'manager', 'beres'));
    expect(w).toMatchObject({ status: 'done', bubble: { text: 'beres', kind: 'done' } });
    expect(o.envelopes.at(-1).kind).toBe('done');
    run(o, 4);
    o.handleEvent(ev('blocked', name, 'manager', 'butuh aset'));
    expect(w.status).toBe('blocked');
    expect(o.envelopes.at(-1).kind).toBe('blocked');
    run(o, 4);
    o.handleEvent(ev('report', name, 'manager', 'laporan'));
    expect(w.bubble.text).toBe('laporan');
    expect(o.hitTest(w.seat.x, w.seat.y - 5)).toBe(name);
  });

  it('riwayat instant untuk agen 3D', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', '3d-modeler', 'x'), { instant: true });
    o.handleEvent(ev('report', '3d-materials', 'manager', 'x'), { instant: true });
    expect(o.workers.get('3d-modeler').status).toBe('working');
    expect(o.workers.get('3d-materials').status).toBe('done');
  });
});

describe('engine: nama proyek sesi', () => {
  it('event dengan project → bubble membawa nama proyek; tanpa project tetap normal', () => {
    const o = new Office();
    o.handleEvent(ev('working', 'dev-qa', 'manager', 'uji', { project: 'toko-online' }));
    expect(o.workers.get('dev-qa').bubble).toMatchObject({ text: 'uji', project: 'toko-online' });
    expect(o.snapshot().workers['dev-qa'].project).toBe('toko-online');
    o.handleEvent(ev('working', 'dev-docs', 'manager', 'tulis'));
    expect(o.workers.get('dev-docs').bubble).toEqual(expect.objectContaining({ text: 'tulis', kind: 'working' }));
    expect(o.workers.get('dev-docs').bubble.project).toBeUndefined();
  });

  it('project ikut ke bubble tugas manajer dan ke bubble perintah CEO', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', '3d-modeler', 'Model kemasan', { project: 'kopiku-3d' }));
    let seen = null;
    run(o, 20, (x) => {
      if (x.manager.state === 'talking') seen = x.manager.bubble;
    });
    expect(seen).toMatchObject({ text: 'Model kemasan', project: 'kopiku-3d' });
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Proyek baru', { project: 'ai-office' }));
    run(o, 2.5);
    expect(o.manager.bubble).toMatchObject({ text: 'Proyek baru', kind: 'command', project: 'ai-office' });
  });
});

describe('engine: peringatan limit di manajer', () => {
  it('aktif → bubble tetap "Limit hampir habis, hemat mode" yang tidak kedaluwarsa', () => {
    const o = new Office();
    expect(o.managerBubble()).toBeNull();
    o.setLimitWarning(true);
    expect(o.managerBubble()).toMatchObject({ text: WARNING_TEXT, kind: 'warning', sticky: true });
    run(o, 30);
    expect(o.managerBubble()?.text).toBe(WARNING_TEXT);
    expect(o.snapshot().manager).toMatchObject({ limitWarning: true, shownBubble: WARNING_TEXT, bubble: null });
  });

  it('bubble tugas biasa didahulukan, lalu peringatan muncul lagi', () => {
    const o = new Office();
    o.setLimitWarning(true);
    o.handleEvent(ev('report', 'manager', 'ceo', 'Laporan siap'));
    expect(o.managerBubble().text).toBe('Laporan siap');
    run(o, 6);
    expect(o.managerBubble().text).toBe(WARNING_TEXT);
  });

  it('hilang begitu nilainya turun (setLimitWarning(false)); bertahan saat reset()', () => {
    const o = new Office();
    o.setLimitWarning(true);
    o.reset();
    expect(o.limitWarning).toBe(true);
    o.setLimitWarning(false);
    expect(o.managerBubble()).toBeNull();
    expect(o.snapshot().manager.limitWarning).toBe(false);
  });
});
