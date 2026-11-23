// QA Fase 4b (tambahan): layout dinamis sampai 20 divisi plugin (banyak worker), jangkauan kursi, perilaku CEO
// pada kondisi tepi (tugas beruntun, tugas saat kopi/jendela/pulang, laporan saat CEO berjalan, reset, reduced motion,
// tidak menembus kaca, antrean tidak macet), dan kontras teks ruang CEO di semua tema dan fase.
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { applyDivisionsResponse, resetDivisions } from '../src/divisions.js';
import { blend, contrast } from '../src/contrast.js';
import { LAMP_COLOR, PHASES, PHASE_LOOK } from '../src/office/daycycle.js';
import { Office } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { findPath } from '../src/office/pathfinding.js';
import { paletteForTheme } from '../src/office/palette.js';
import { registry } from '../src/office/themeRegistry.js';

const { CEO_ROOM, ROOMS, W, rosterSeats, zoneList } = layout;
const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;
const DT = 1 / 60;
const run = (o, s, each) => {
  for (let t0 = 0; t0 < s; t0 += DT) {
    o.update(DT);
    each?.(o);
  }
};
const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const blockedAt = (g, p) => g.blocked[Math.floor(p.y / g.cell) * g.cols + Math.floor(p.x / g.cell)] === 1;
const plugin = (i, desks) => ({
  id: `q${i}`,
  name: { en: `Q ${i}`, id: `Q ${i}` },
  color: '#0ea5e9',
  desks,
  workers: Array.from({ length: desks }, (_, k) => `q${i}-w${k}`),
  source: 'plugin',
});
const load = (n, desks) => applyDivisionsResponse(200, {
  ok: true,
  errors: [],
  divisions: Array.from({ length: n }, (_, i) => plugin(i + 1, desks ?? (i % 8) + 1)),
});

afterEach(() => resetDivisions());

describe('QA layout dinamis: 0/1/6/12/20 divisi, banyak worker', () => {
  it.each([[0, null], [1, 3], [6, 8], [12, 8], [20, 8], [20, 1]])('%i divisi (meja/divisi %s): H tumbuh, tanpa tumpang tindih, semua kursi terjangkau dari ruang CEO', (n, desks) => {
    if (n) load(n, desks ?? undefined);
    const zones = zoneList();
    expect(zones.slice(6)).toHaveLength(Math.min(n, 12)); // batas MAX_PLUGIN_DIVISIONS = 12
    if (n === 0) expect(layout.H).toBe(layout.BASE_H);
    else {
      expect(layout.H).toBeGreaterThan(layout.BASE_H);
      expect(layout.H).toBeGreaterThanOrEqual(Math.max(...zones.map((z) => z.rect.y + z.rect.h)));
    }
    for (const z of zones) {
      for (const r of Object.values(ROOMS)) expect(overlap(r, z.rect)).toBe(false);
      expect(z.rect.x + z.rect.w).toBeLessThanOrEqual(W);
      expect(z.rect.y + z.rect.h).toBeLessThanOrEqual(layout.H);
    }
    for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) expect(overlap(zones[i].rect, zones[j].rect)).toBe(false);
    const seats = [...rosterSeats()];
    const seen = new Set();
    for (const [name, st] of seats) {
      const key = `${st.desk.x},${st.desk.y}`;
      expect(seen.has(key), `meja ganda ${name}`).toBe(false);
      seen.add(key);
      for (const r of Object.values(ROOMS)) expect(overlap(r, st.desk), name).toBe(false);
    }
    const o = new Office();
    for (const [name, st] of seats) {
      expect(blockedAt(o.grid, st.front), `front ${name}`).toBe(false);
      expect(findPath(o.grid, CEO_ROOM.exit, st.front), `jalur ${name}`).not.toBeNull();
    }
    expect(o.grid.rows * o.grid.cell).toBeGreaterThanOrEqual(layout.H - o.grid.cell);
  });
});

describe('QA perilaku CEO: kondisi tepi', () => {
  const collect = (seen) => (x) => {
    for (const e of x.envelopes) if (e.kind === 'command') seen.add(e);
  };

  it('banjir tugas (30 perintah, tiap 0,2 dtk): semua amplop terkirim, CEO kembali duduk, isIdle akhirnya true', () => {
    const o = new Office({ seed: 3 });
    const seen = new Set();
    for (let i = 0; i < 30; i++) {
      o.handleEvent(ev('assign', 'ceo', 'manager', `T${i}`));
      run(o, 0.2, collect(seen));
    }
    run(o, 90, collect(seen));
    expect(seen.size).toBe(30);
    expect(o.ceo.state).toBe('sitting');
    expect(o.isIdle()).toBe(true);
  });

  it('tugas masuk pada banyak titik waktu idle CEO (bangkit, kopi/jendela, pulang): selalu terkirim, tidak macet', () => {
    for (let phase = 0; phase < 400; phase += 7) {
      const o = new Office({ seed: 7 });
      run(o, 9 + phase * 0.05);
      o.handleEvent(ev('assign', 'ceo', 'manager', 'Mendadak'));
      const seen = new Set();
      run(o, 40, collect(seen));
      expect(seen.size, `offset ${phase}`).toBe(1);
      run(o, 60);
      expect(o.isIdle()).toBe(true);
    }
  });

  it('tugas kedua disisipkan tiap 0,25 dtk selama siklus penuh: CEO selalu pulang, kantor idle', () => {
    for (let off = 0; off < 14; off += 0.25) {
      const o = new Office({ seed: 5 });
      o.handleEvent(ev('assign', 'ceo', 'manager', 'A'));
      run(o, off);
      o.handleEvent(ev('assign', 'ceo', 'manager', 'B'));
      run(o, 60);
      expect(o.ceo.state, `off ${off}`).toBe('sitting');
      expect(o.isIdle()).toBe(true);
    }
  });

  it('laporan manajer ke CEO saat CEO sedang berjalan: CEO bereaksi, lalu tetap pulang ke kursi', () => {
    const o = new Office({ seed: 2 });
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Jalan'));
    run(o, 1.5);
    expect(o.ceo.state).toBe('walking');
    o.handleEvent(ev('report', 'manager', 'ceo', 'Laporan'));
    run(o, 3);
    expect(o.ceo.cheerUntil).toBeGreaterThan(0);
    run(o, 40);
    expect(o.ceo).toMatchObject({ state: 'sitting', x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y });
  });

  it('reset() di tengah perjalanan: CEO duduk lagi, jalur kosong, kantor idle', () => {
    for (const at of [0.2, 1, 2.5, 4, 6]) {
      const o = new Office({ seed: 4 });
      o.handleEvent(ev('assign', 'ceo', 'manager', 'x'));
      run(o, at);
      o.reset();
      expect(o.ceo).toMatchObject({ state: 'sitting', x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y });
      expect(o.ceo.path).toHaveLength(0);
      expect(o.isIdle()).toBe(true);
      run(o, 30);
      expect(Number.isFinite(o.ceo.x)).toBe(true);
    }
  });

  it('reduced motion di tengah perjalanan, lalu dimatikan lagi: CEO normal kembali dan tugas baru terantar', () => {
    const o = new Office({ seed: 4 });
    o.handleEvent(ev('assign', 'ceo', 'manager', 'x'));
    run(o, 2);
    o.setReducedMotion(true);
    run(o, 10);
    expect(o.ceo).toMatchObject({ state: 'sitting', x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y });
    o.setReducedMotion(false);
    o.handleEvent(ev('assign', 'ceo', 'manager', 'y'));
    const seen = new Set();
    run(o, 30, collect(seen));
    expect(seen.size).toBe(1);
    expect(o.isIdle()).toBe(true);
  });

  it('CEO tidak menembus kaca atau meja (dipantau tiap frame: idle 5 menit + tugas berkala); kaca depan hanya lewat pintu', () => {
    const o = new Office({ seed: 9 });
    const g = o.grid;
    const { door, rect: R } = CEO_ROOM;
    const corridor = { x: CEO_ROOM.seat.x - 1, y: CEO_ROOM.exit.y - 8, w: CEO_ROOM.exit.x - CEO_ROOM.seat.x + 2, h: 16 };
    let moving = 0;
    for (let i = 0; i < 300 * 60; i++) {
      if (i % 1500 === 600) o.handleEvent(ev('assign', 'ceo', 'manager', `t${i}`));
      o.update(DT);
      const c = o.ceo;
      if (c.state !== 'walking') continue;
      moving++;
      if (overlap({ x: c.x, y: c.y, w: 0.1, h: 0.1 }, corridor)) continue;
      expect(blockedAt(g, c), `${c.x.toFixed(1)},${c.y.toFixed(1)}`).toBe(false);
      if (c.y > door.y - 1 && c.y < door.y + door.h + 1 && c.x > R.x && c.x < R.x + R.w) {
        expect(c.x >= door.x && c.x <= door.x + door.w, `kaca ${c.x.toFixed(1)},${c.y.toFixed(1)}`).toBe(true);
      }
    }
    expect(moving).toBeGreaterThan(500);
  });

  it('dengan 20 divisi plugin penuh (160 worker) CEO tetap mengantar dan pulang', () => {
    load(20, 8);
    const o = new Office({ seed: 1 });
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Besar'));
    const seen = new Set();
    run(o, 40, collect(seen));
    expect(seen.size).toBe(1);
    expect(o.ceo.state).toBe('sitting');
    expect(o.isIdle()).toBe(true);
  });
});

describe('QA kontras teks ruang CEO (semua tema x fase)', () => {
  it('plakat dan papan nama CEO (signInk/signPaper) dan label karpet CEO (onRug/rugA, rugB, juga di bawah tiga lapis cahaya lampu) >= 4,5:1 setelah tint fase', () => {
    for (const theme of registry.themes) {
      for (const phase of PHASES) {
        const look = PHASE_LOOK[phase];
        const P = paletteForTheme(theme, look.variant);
        const tint = (c) => (look.tint.alpha > 0 ? blend(look.tint.color, c, look.tint.alpha) : c);
        const lit = (c) => {
          let r = c;
          for (const al of [0.035, 0.04, 0.05]) r = blend(LAMP_COLOR, r, al * look.lamps); // skenario terburuk: tiga lapis kolam cahaya (scene.js) menutupi label
          return r;
        };
        for (const [fg, bg, why] of [['signInk', 'signPaper', 'plakat CEO'], ['onRug', 'rugA', 'label CEO di karpet'], ['onRug', 'rugB', 'label CEO di karpet']]) {
          expect(contrast(P[fg], tint(P[bg])), `${theme.id}/${phase} ${why}`).toBeGreaterThanOrEqual(4.5);
          if (bg !== 'signPaper') expect(contrast(P[fg], tint(lit(P[bg]))), `${theme.id}/${phase} ${why} + lampu`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
