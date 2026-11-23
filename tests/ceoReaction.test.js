// Revisi Fase 4b: perintah CEO -> reaksi manajer harus t=0, sama persis seperti sebelum animasi CEO (commit b6f8e22).
// Animasi CEO (berdiri, jalan, pose beri) hanya kosmetik paralel: tidak menahan status, antrean, bubble, atau amplop,
// dan dipotong (tidak diantre) bila event baru masuk.
//
// Angka rujukan (detik simulasi sejak event masuk, dt 1/60) direkam dengan menjalankan skenario identik pada engine
// b6f8e22 (`git archive b6f8e22`, CEO berdiri di pintu) pada empat waktu awal berbeda (0,5/14/25/40 dtk):
//   - amplop perintah muncul pada saat event (t=0) dan terbang 1,235 dtk
//   - bubble 'command' manajer muncul 1,235 dtk setelah event (terukur 1,25 setelah tick); perintah ke-2 dan ke-3
//     (event pada 0,25 dan 0,50 dtk) muncul pada 1,485 dan 1,735 dtk sejak event pertama
//   - state manajer tidak berubah, antrean manajer kosong; isIdle() false selama amplop terbang, true setelahnya
import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { Office } from '../src/office/engine.js';
import { CEO_ROOM, MANAGER_SPOT } from '../src/office/layout.js';

const ev = (m) => normalizeEvent({ type: 'assign', from: 'ceo', to: 'manager', message: m }).event;
const DT = 1 / 60;
const TOL = DT * 1.01 + 0.0001; // toleransi satu tick
const OLD_FLIGHT = 1.235; // dari b6f8e22
const OLD_ARRIVE = { single: [1.235], rapid: [1.235, 1.485, 1.735] }; // dari b6f8e22 (event pada 0, 0,25, 0,5 dtk)
const run = (o, s, each) => {
  for (let t0 = 0; t0 < s - 1e-9; t0 += DT) {
    o.update(DT);
    each?.(o);
  }
};

/** Kirim event pada offset (detik) dari sekarang; kembalikan saat envelope muncul dan bubble 'command' tiba. */
function react(o, offsets) {
  const t0 = o.time;
  const out = { spawn: [], bubble: [], managerStates: new Set(), queue: 0, idleAt: null };
  const todo = offsets.map((at) => ({ at, done: false }));
  let seen = o.stats.envelopesSpawned;
  let last = o.manager.bubble;
  for (let i = 0; i < 60 * 8; i++) {
    for (const p of todo) {
      if (!p.done && o.time - t0 >= p.at - 1e-9) {
        p.done = true;
        o.handleEvent(ev(`m${p.at}`));
        if (o.stats.envelopesSpawned > seen) {
          out.spawn.push(p.at); // envelope sudah ada tepat saat event masuk
          seen = o.stats.envelopesSpawned;
        }
        out.queue = Math.max(out.queue, o.queue.length);
      }
    }
    o.update(DT);
    const b = o.manager.bubble;
    if (b && b !== last && b.kind === 'command') out.bubble.push(o.time - t0);
    last = b;
    out.managerStates.add(o.manager.state);
    if (out.idleAt === null && todo.every((p) => p.done) && o.isIdle()) out.idleAt = o.time - t0;
  }
  return out;
}

// jalankan CEO (seed idle 7) sampai kondisi pick() terpenuhi: kopi, jendela, berdiri, berjalan
const officeAt = (pick) => {
  const o = new Office({ seed: 7 });
  for (let i = 0; i < 60 * 300; i++) {
    o.update(DT);
    if (pick(o)) return o;
  }
  throw new Error('kondisi CEO tidak tercapai');
};

const CASES = {
  'CEO duduk': () => new Office({ seed: 7 }),
  'CEO sedang kopi': () => officeAt((o) => o.ceo.state === 'doing' && o.ceo.goal === 'coffee'),
  'CEO sedang lihat jendela': () => officeAt((o) => o.ceo.state === 'doing' && o.ceo.goal === 'window'),
  'CEO berdiri (rising)': () => officeAt((o) => o.ceo.state === 'rising'),
  'CEO berjalan pulang': () => officeAt((o) => o.ceo.state === 'walking' && o.ceo.goal === 'home'),
  'CEO berjalan ke kopi': () => officeAt((o) => o.ceo.state === 'walking' && o.ceo.goal === 'coffee'),
};

describe('waktu reaksi manajer sama dengan sebelum Fase 4b', () => {
  for (const [name, make] of Object.entries(CASES)) {
    it(`${name}: satu perintah`, () => {
      const r = react(make(), [0]);
      expect(r.spawn).toEqual([0]); // amplop terbang pada saat event
      expect(r.bubble).toHaveLength(1);
      expect(Math.abs(r.bubble[0] - OLD_ARRIVE.single[0])).toBeLessThanOrEqual(TOL);
      expect([...r.managerStates]).toEqual(['sitting']); // status manajer tidak tertunda/berubah
      expect(r.queue).toBe(0);
      expect(r.idleAt).toBeLessThanOrEqual(OLD_ARRIVE.single[0] + 2 * DT); // isIdle tidak menunggu animasi CEO
    });

    it(`${name}: tiga perintah beruntun cepat (0 / 0,25 / 0,5 dtk)`, () => {
      const r = react(make(), [0, 0.25, 0.5]);
      expect(r.spawn).toEqual([0, 0.25, 0.5]);
      expect(r.bubble).toHaveLength(3);
      r.bubble.forEach((b, i) => expect(Math.abs(b - OLD_ARRIVE.rapid[i])).toBeLessThanOrEqual(TOL));
      expect(r.queue).toBe(0);
      expect(r.idleAt).toBeLessThanOrEqual(OLD_ARRIVE.rapid[2] + 2 * DT);
    });
  }
});

describe('amplop dari posisi CEO saat itu', () => {
  it('CEO duduk: dari mejanya; CEO di tengah jalan: dari posisinya, durasi terbang sama', () => {
    const a = new Office();
    a.handleEvent(ev('x'));
    expect(a.envelopes[0]).toMatchObject({
      from: { x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y - 14 },
      to: { x: MANAGER_SPOT.seat.x, y: MANAGER_SPOT.seat.y - 12 },
      dur: OLD_FLIGHT,
    });
    const b = officeAt((o) => o.ceo.state === 'walking' && o.ceo.goal === 'coffee');
    const { x, y } = b.ceo;
    b.handleEvent(ev('y'));
    expect(b.envelopes.at(-1)).toMatchObject({ from: { x, y: y - 14 }, dur: OLD_FLIGHT });
  });
});

describe('animasi CEO dipotong, tidak diantre', () => {
  const states = (o, s) => {
    const seq = [];
    run(o, s, (x) => {
      const k = `${x.ceo.state}:${x.ceo.goal}`;
      if (seq.at(-1) !== k) seq.push(k);
    });
    return seq;
  };

  it('event saat kopi: kopi dipotong, CEO langsung jalan ke manajer dari posisinya, lalu pulang', () => {
    const o = officeAt((x) => x.ceo.state === 'doing' && x.ceo.goal === 'coffee');
    o.handleEvent(ev('a'));
    const seq = states(o, 25);
    expect(seq[0]).toBe('walking:errand');
    expect(seq).not.toContain('doing:coffee');
    expect(seq.at(-1)).toBe('sitting:null');
  });

  it('event saat CEO sudah berjalan ke manajer: tidak mulai ulang dan tidak mengantre perjalanan kedua', () => {
    const o = new Office({ seed: 7 });
    o.handleEvent(ev('a'));
    run(o, 1.5);
    expect({ state: o.ceo.state, goal: o.ceo.goal }).toEqual({ state: 'walking', goal: 'errand' });
    o.handleEvent(ev('b'));
    expect(o.ceo).toMatchObject({ state: 'walking', goal: 'errand' });
    const seq = states(o, 14);
    expect(seq.filter((k) => k === 'doing:errand')).toHaveLength(1);
    expect(seq.filter((k) => k === 'rising:errand')).toHaveLength(0);
    expect(seq.filter((k) => k === 'walking:errand')).toHaveLength(1); // tanpa jalan ke manajer kedua
  });

  it('event saat CEO berjalan pulang: dipotong, CEO berbalik ke manajer dari posisinya', () => {
    const o = officeAt((x) => x.ceo.state === 'walking' && x.ceo.goal === 'home');
    o.handleEvent(ev('a'));
    expect(o.ceo).toMatchObject({ state: 'walking', goal: 'errand' });
    run(o, 30);
    expect(o.ceo.state).toBe('sitting');
  });

  it('banjir perintah: tidak ada yang menumpuk; kantor idle dan CEO duduk setelahnya', () => {
    const o = new Office({ seed: 3 });
    for (let i = 0; i < 30; i++) {
      o.handleEvent(ev(`T${i}`));
      run(o, 0.2);
    }
    expect(o.stats.envelopesSpawned).toBe(30);
    run(o, 30);
    expect(o.ceo.goal).not.toBe('errand'); // tidak ada perjalanan antar yang tersisa
    expect(o.isIdle()).toBe(true);
  });
});

describe('reduced motion', () => {
  it('CEO tetap duduk dan amplop terbang dari mejanya pada t=0 (juga bila dinyalakan saat CEO berjalan)', () => {
    const o = officeAt((x) => x.ceo.state === 'walking');
    o.setReducedMotion(true);
    expect(o.ceo).toMatchObject({ state: 'sitting', x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y });
    const t0 = o.time;
    o.handleEvent(ev('a'));
    expect(o.envelopes.at(-1)).toMatchObject({ kind: 'command', from: { x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y - 14 }, dur: OLD_FLIGHT });
    let at = null;
    run(o, 3, (x) => {
      expect(x.ceo.state).toBe('sitting');
      if (at === null && x.manager.bubble?.kind === 'command') at = x.time - t0;
    });
    expect(Math.abs(at - OLD_ARRIVE.single[0])).toBeLessThanOrEqual(TOL);
  });
});
