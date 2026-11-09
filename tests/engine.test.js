import { describe, expect, it } from 'vitest';
import { AGENT_NAMES } from '../shared/roster.js';
import { normalizeEvent } from '../shared/events.js';
import { Office } from '../src/office/engine.js';
import { MANAGER_SPOT } from '../src/office/layout.js';
import { findPath, pathLength } from '../src/office/pathfinding.js';
import { SCENARIO, SCENARIO_DURATION, playScenario } from '../src/sim/scenario.js';

const ev = (type, from, to, message = '') => normalizeEvent({ type, from, to, message }).event;

/** Majukan waktu engine; panggil `each` tiap frame. */
function run(office, seconds, each) {
  const dt = 1 / 60;
  for (let t = 0; t < seconds; t += dt) {
    office.update(dt);
    each?.(office);
  }
}

describe('denah & pathfinding', () => {
  it('semua agen roster (17, termasuk Divisi 3D) punya meja', () => {
    const o = new Office();
    for (const name of AGENT_NAMES) expect(o.workers.has(name)).toBe(true);
    expect(o.workers.size).toBe(AGENT_NAMES.length);
    expect(AGENT_NAMES).toHaveLength(17);
  });

  it('manajer bisa berjalan ke depan setiap meja worker dan kembali', () => {
    const o = new Office();
    for (const w of o.workers.values()) {
      const go = findPath(o.grid, MANAGER_SPOT.seat, w.front);
      expect(go, `jalur ke ${w.name}`).not.toBeNull();
      expect(go.at(-1)).toEqual(w.front);
      const back = findPath(o.grid, w.front, MANAGER_SPOT.seat);
      expect(back, `jalur kembali dari ${w.name}`).not.toBeNull();
      // jalur wajar: tidak lebih dari 3x jarak lurus
      const direct = Math.hypot(w.front.x - MANAGER_SPOT.seat.x, w.front.y - MANAGER_SPOT.seat.y);
      expect(pathLength(MANAGER_SPOT.seat, go)).toBeLessThan(direct * 3);
    }
  });
});

describe('alur assign → working → done', () => {
  it('manajer berdiri, berjalan ke worker, memberi bubble perintah, lalu kembali duduk', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-qa', 'Uji form login'));
    expect(o.manager.state).toBe('sitting');
    const states = new Set();
    let sawBubbleAtDesk = false;
    const front = o.workers.get('dev-qa').front;
    run(o, 12, (x) => {
      states.add(x.manager.state);
      if (x.manager.state === 'talking') {
        expect(Math.round(x.manager.x)).toBe(front.x);
        expect(Math.round(x.manager.y)).toBe(front.y);
        if (x.manager.bubble?.text === 'Uji form login' && x.manager.bubble.kind === 'assign') sawBubbleAtDesk = true;
      }
    });
    expect([...states]).toEqual(expect.arrayContaining(['sitting', 'standing', 'walking', 'talking']));
    expect(sawBubbleAtDesk).toBe(true);
    expect(o.workers.get('dev-qa').status).toBe('working');
    expect(o.manager.state).toBe('sitting');
    expect({ x: o.manager.x, y: o.manager.y }).toEqual(MANAGER_SPOT.seat);
    expect(o.stats).toMatchObject({ trips: 1, deliveries: 1 });
  });

  it('done → status selesai, bubble laporan, amplop terbang dan tiba di meja manajer', () => {
    const o = new Office();
    o.handleEvent(ev('done', 'dev-qa', 'manager', '9 test lulus'));
    const w = o.workers.get('dev-qa');
    expect(w.status).toBe('done');
    expect(w.bubble).toMatchObject({ text: '9 test lulus', kind: 'done' });
    expect(o.envelopes).toHaveLength(1);
    const start = { x: o.envelopes[0].x, y: o.envelopes[0].y };
    let minY = Infinity;
    run(o, 0.5, (x) => {
      if (x.envelopes[0]) minY = Math.min(minY, x.envelopes[0].y);
    });
    expect(minY).toBeLessThan(start.y); // melengkung ke atas
    run(o, 2);
    expect(o.envelopes).toHaveLength(0);
    expect(o.inbox).toBe(1);
    expect(o.stats.envelopesArrived).toBe(1);
  });

  it('blocked → butuh bantuan + amplop merah; report → selesai', () => {
    const o = new Office();
    o.handleEvent(ev('blocked', 'content-script', 'manager', 'butuh harga'));
    expect(o.workers.get('content-script').status).toBe('blocked');
    expect(o.envelopes[0].kind).toBe('blocked');
    o.handleEvent(ev('report', 'sales-pricing', 'manager', '3 paket'));
    expect(o.workers.get('sales-pricing').status).toBe('done');
    expect(o.envelopes[1].kind).toBe('report');
  });

  it('done lalu report beruntun dari worker yang sama hanya mengirim satu amplop', () => {
    const o = new Office();
    o.handleEvent(ev('done', 'dev-qa', 'manager', 'a'));
    o.handleEvent(ev('report', 'dev-qa', 'manager', 'b'));
    expect(o.envelopes).toHaveLength(1);
    expect(o.workers.get('dev-qa').bubble.text).toBe('b');
  });

  it('event worker ditahan sampai manajer selesai menyerahkan tugas, urutannya tetap', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-docs', 'Tulis README'));
    o.handleEvent(ev('working', 'dev-docs', 'manager', 'menulis'));
    o.handleEvent(ev('done', 'dev-docs', 'manager', 'README jadi'));
    expect(o.workers.get('dev-docs').status).toBe('idle');
    const order = [];
    run(o, 15, (x) => {
      const s = x.workers.get('dev-docs').status;
      if (order.at(-1) !== s) order.push(s);
    });
    expect(order).toEqual(['idle', 'working', 'done']);
  });

  it('beberapa tugas paralel dikirim berurutan dalam satu perjalanan', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-frontend', 'a'));
    o.handleEvent(ev('assign', 'manager', 'dev-qa', 'b'));
    o.handleEvent(ev('assign', 'manager', 'dev-security', 'c'));
    const visited = [];
    run(o, 30, (x) => {
      if (x.manager.state === 'talking' && visited.at(-1) !== x.manager.job.to) visited.push(x.manager.job.to);
    });
    expect(visited).toEqual(['dev-frontend', 'dev-qa', 'dev-security']);
    expect(o.isIdle()).toBe(true);
    for (const n of ['dev-frontend', 'dev-qa', 'dev-security']) expect(o.workers.get(n).status).toBe('working');
  });

  it('agen di luar roster mendapat meja tamu', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'Explore', 'cari file'));
    expect(o.workers.get('explore')).toMatchObject({ dynamic: true });
    run(o, 15);
    expect(o.workers.get('explore').status).toBe('working');
  });

  it('perintah CEO: amplop dari pintu, lalu bubble di manajer', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Luncurkan produk'));
    expect(o.envelopes[0].kind).toBe('command');
    run(o, 2.5);
    expect(o.manager.bubble).toMatchObject({ text: 'Luncurkan produk', kind: 'command' });
  });

  it('mode instant (riwayat) hanya mengubah status tanpa animasi', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-qa', 'x'), { instant: true });
    o.handleEvent(ev('blocked', 'dev-docs', 'manager', 'x'), { instant: true });
    expect(o.workers.get('dev-qa').status).toBe('working');
    expect(o.workers.get('dev-docs').status).toBe('blocked');
    expect(o.queue).toHaveLength(0);
    expect(o.envelopes).toHaveLength(0);
  });

  it('hitTest mengenali worker yang diklik', () => {
    const o = new Office();
    const w = o.workers.get('sales-pricing');
    expect(o.hitTest(w.seat.x, w.seat.y - 5)).toBe('sales-pricing');
    expect(o.hitTest(1, 1)).toBeNull();
  });
});

describe('skenario Simulasi', () => {
  it('memakai format event yang valid dan nama agen yang ada', () => {
    for (const { event } of SCENARIO) {
      const r = normalizeEvent(event);
      expect(r.ok, JSON.stringify(event)).toBe(true);
      for (const n of [r.event.from, r.event.to]) {
        expect(['ceo', 'manager', ...AGENT_NAMES]).toContain(n);
      }
    }
    expect(new Set(SCENARIO.map((s) => s.event.type))).toEqual(new Set(['assign', 'working', 'done', 'blocked', 'report']));
  });

  it('diputar penuh: manajer berjalan, status berubah, amplop muncul, semuanya beres', () => {
    // Jalankan player dengan jam palsu yang terikat ke waktu engine
    const o = new Office();
    const timers = [];
    playScenario((e) => o.handleEvent(e), {
      schedule: (fn, ms) => timers.push({ at: ms / 1000, fn }),
      cancel: () => {},
    });
    const seen = new Map();
    let walked = false;
    let maxEnvelopes = 0;
    let t = 0;
    const dt = 1 / 60;
    while (t < SCENARIO_DURATION + 40) {
      timers.filter((x) => !x.done && x.at <= t).forEach((x) => {
        x.done = true;
        x.fn();
      });
      o.update(dt);
      t += dt;
      if (o.manager.state === 'walking') walked = true;
      maxEnvelopes = Math.max(maxEnvelopes, o.envelopes.length);
      for (const w of o.workers.values()) {
        if (!seen.has(w.name)) seen.set(w.name, new Set());
        seen.get(w.name).add(w.status);
      }
      if (timers.every((x) => x.done) && o.isIdle()) break;
    }
    expect(walked).toBe(true);
    expect(maxEnvelopes).toBeGreaterThan(0);
    expect(seen.get('content-script')).toEqual(new Set(['idle', 'working', 'blocked', 'done']));
    expect(seen.get('dev-frontend')).toEqual(new Set(['idle', 'working', 'done']));
    // Satu perjalanan per tugas manajer → worker (7 alur web + 4 alur 3D).
    const workerAssigns = SCENARIO.filter(({ event: e }) => e.type === 'assign' && e.from === 'manager').length;
    expect(workerAssigns).toBe(11);
    expect(o.stats.trips).toBe(workerAssigns);
    for (const n of ['3d-modeler', '3d-materials', '3d-animator', '3d-render']) {
      expect(seen.get(n), n).toEqual(new Set(['idle', 'working', 'done']));
    }
    expect(o.stats.envelopesArrived).toBe(o.stats.envelopesSpawned);
    expect(o.inbox).toBeGreaterThanOrEqual(6);
    expect(o.isIdle()).toBe(true);
    expect(o.manager.state).toBe('sitting');
    expect(t).toBeLessThan(SCENARIO_DURATION + 20);
  });
});
