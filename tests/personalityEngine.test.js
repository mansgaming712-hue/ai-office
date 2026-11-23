// Kepribadian di engine dan renderer: RNG dan jam deterministik, frasa bubble, kebiasaan idle, reduced motion,
// layout bawaan tidak berubah, dan waktu frame dengan 19 karakter.
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { DEFAULT_PERSONALITIES, NEUTRAL_PERSONALITY, resolvePersonality } from '../shared/personalities.js';
import { AGENT_NAMES, CEO_ID, MANAGER_ID } from '../shared/roster.js';
import { applyDivisionsResponse, resetDivisions } from '../src/divisions.js';
import { setLang } from '../src/i18n.js';
import { Office, TUNING } from '../src/office/engine.js';
import * as layout from '../src/office/layout.js';
import { IDLE_BEHAVIORS, QUIRKS, quirkPhase } from '../src/office/quirks.js';
import { createRenderer, workerSpec } from '../src/office/render.js';
import { personalityOf } from '../src/personality.js';

const { BASE_H, W, ZONES, otherSeat, rosterSeats, zoneList } = layout;
const FIX = JSON.parse(readFileSync(new URL('./fixtures/layout-builtin.json', import.meta.url), 'utf8'));
const plain = (v) => JSON.parse(JSON.stringify(v));
const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;
const DT = 1 / 60;
const run = (o, seconds, each) => {
  for (let t0 = 0; t0 < seconds; t0 += DT) {
    o.update(DT);
    each?.(o);
  }
};
const all = (pers) => () => pers;
const phrasey = (tone = 'cheerful', extra = {}) => resolvePersonality({ speech: { tone, phrases: [{ en: 'Phrase EN', id: 'Frasa ID' }] }, ...extra });

beforeEach(() => setLang('en', { persist: false })); // di Node bahasa awal = id
afterEach(() => {
  resetDivisions();
  setLang('en', { persist: false });
});

/** Rekam teks bubble tiap worker dari detik ke detik. */
function trace(o, seconds) {
  const log = [];
  let next = 0;
  run(o, seconds, (x) => {
    if (x.time < next) return;
    next = x.time + 0.5;
    log.push(JSON.stringify([
      Number(x.time.toFixed(1)),
      [...x.workers.values()].map((w) => [w.name, w.mode, w.bubble?.text ?? null, Math.round(w.x), Math.round(w.y)]),
      x.manager.bubble?.text ?? null,
      x.ceo.bubble?.text ?? null,
    ]));
  });
  return log;
}

describe('RNG dan jam dapat disuntik: hasil deterministik', () => {
  it('biji sama + dt sama = jejak identik (bubble, mode, posisi) selama 5 menit; biji lain berbeda', () => {
    setLang('en', { persist: false });
    const a = trace(new Office({ seed: 7 }), 300);
    const b = trace(new Office({ seed: 7 }), 300);
    expect(a).toEqual(b);
    expect(trace(new Office({ seed: 8 }), 300)).not.toEqual(a);
    const phrases = Object.values(DEFAULT_PERSONALITIES).flatMap((p) => p.speech.phrases.map((x) => JSON.stringify(x.en).slice(1, -1)));
    expect(a.some((l) => phrases.some((p) => l.includes(p)))).toBe(true); // frasa kepribadian muncul di jejak
  });

  it('bawaan (tanpa opsi) = biji 20241121 yang lama', () => {
    expect(trace(new Office(), 120)).toEqual(trace(new Office({ seed: 20241121 }), 120));
  });

  it('rng suntikan dipakai: dua rng yang menghasilkan deret sama memberi jejak sama; reset memakai ulang biji', () => {
    const seq = () => {
      let i = 0;
      const vals = [0.11, 0.52, 0.93, 0.27, 0.68, 0.4];
      return () => vals[i++ % vals.length];
    };
    expect(trace(new Office({ rng: seq() }), 90)).toEqual(trace(new Office({ rng: seq() }), 90));
    const o = new Office({ seed: 3 });
    const first = trace(o, 60);
    o.reset();
    expect(trace(o, 60)).toEqual(first);
  });

  it('jam engine = jumlah dt: potongan dt berbeda menghasilkan waktu yang sama; kepribadian dapat disuntik', () => {
    const o1 = new Office({ seed: 1, personalityFor: all(phrasey()) });
    const o2 = new Office({ seed: 1, personalityFor: all(phrasey()) });
    for (let i = 0; i < 600; i++) o1.update(0.05);
    for (let i = 0; i < 1800; i++) o2.update(1 / 60);
    expect(o1.time).toBeCloseTo(30, 6);
    expect(o2.time).toBeCloseTo(30, 6);
  });

  it('aliran acak kepribadian terpisah: jadwal pantry sama dengan atau tanpa frasa', () => {
    const modes = (pers) => {
      const o = new Office({ seed: 11, personalityFor: all(pers) });
      const out = [];
      run(o, 200, (x) => out.push([...x.workers.values()].map((w) => w.mode[0]).join('')));
      return out;
    };
    const neutral = modes(NEUTRAL_PERSONALITY);
    const talkative = modes(phrasey('dry', { idle: 'coffee' }));
    expect(talkative).toEqual(neutral);
    expect(neutral.some((m) => /[^s]/.test(m))).toBe(true); // ada yang berjalan ke pantry
  });
});

describe('frasa bubble sesuai kepribadian', () => {
  const speakers = (o, seconds, name) => {
    const seen = new Set();
    run(o, seconds, (x) => {
      const b = x.workers.get(name).bubble;
      if (b?.kind === 'chat') seen.add(b.text);
    });
    return seen;
  };
  const only = (name, pers) => (id) => (id === name ? pers : NEUTRAL_PERSONALITY);

  it('worker dengan frasa sesekali berbicara memakai frasanya; bahasa mengikuti pilihan; status tidak berubah', () => {
    const o = new Office({ seed: 5, personalityFor: only('dev-qa', phrasey()) });
    const en = speakers(o, 150, 'dev-qa');
    expect([...en].filter((s) => s !== 'Ahh, fresh!')).toEqual(['Phrase EN']);
    expect(o.workers.get('dev-qa').status).toBe('idle');
    setLang('id', { persist: false });
    const id = speakers(new Office({ seed: 5, personalityFor: only('dev-qa', phrasey()) }), 150, 'dev-qa');
    expect([...id].filter((s) => s !== 'Ahh, segar!')).toEqual(['Frasa ID']);
  });

  it('sesekali, bukan terus-menerus: jedanya mengikuti TUNING.phraseEvery', () => {
    const o = new Office({ seed: 5, personalityFor: only('dev-qa', phrasey('calm', { idle: 'stretch' })) });
    const starts = [];
    let prev = null;
    run(o, 400, (x) => {
      const b = x.workers.get('dev-qa').bubble;
      if (b && b !== prev && b.text === 'Phrase EN') starts.push(b.born);
      prev = b;
    });
    expect(starts.length).toBeGreaterThanOrEqual(5);
    expect(starts[0]).toBeGreaterThanOrEqual(TUNING.phraseFirst[0] - 0.1);
    for (let i = 1; i < starts.length; i++) expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(TUNING.phraseEvery[0] - 0.1);
  });

  it('tanpa frasa sendiri: memakai kalimat cadangan sesuai tone (office.tone.<tone>.N)', () => {
    const pers = resolvePersonality({ speech: { tone: 'dry' }, idle: 'stretch' });
    const seen = speakers(new Office({ seed: 2, personalityFor: only('dev-qa', pers) }), 300, 'dev-qa');
    expect(seen.size).toBeGreaterThan(0);
    for (const s of seen) expect(['Another day, another ticket.', 'Fascinating. Truly.', 'Coffee is not optional.']).toContain(s);
  });

  it('netral: tidak ada bubble frasa sama sekali (hanya obrolan pantry lama)', () => {
    const o = new Office({ seed: 5, personalityFor: all(NEUTRAL_PERSONALITY) });
    const texts = new Set();
    run(o, 300, (x) => {
      for (const w of x.workers.values()) if (w.bubble) texts.add(w.bubble.text);
      if (x.manager.bubble) texts.add(x.manager.bubble.text);
      if (x.ceo.bubble) texts.add(x.ceo.bubble.text);
    });
    const legacy = new Set(['Ahh, fresh!', 'Coffee first, yuk!', 'Rain again today...', 'These fritters are great', 'Traffic was crazy', 'Almost lunchtime', 'One more sachet?']);
    for (const s of texts) expect(legacy.has(s), s).toBe(true);
  });

  it('tidak berbicara saat ada tugas masuk atau sedang diserahkan, dan tidak mengubah status', () => {
    // rng = 0: frasa pertama tepat pada detik ke-20 (batas bawah phraseFirst)
    const o = new Office({ rng: () => 0, personalityFor: only('dev-qa', phrasey()) });
    run(o, 19.5);
    o.handleEvent(ev('assign', 'manager', 'dev-qa', 'Uji dulu'));
    const texts = new Set();
    run(o, 12, (x) => {
      const b = x.workers.get('dev-qa').bubble;
      if (b) texts.add(b.text);
    });
    expect(texts.has('Phrase EN')).toBe(false); // timer lewat saat tugas menunggu: frasa ditunda
    expect(o.workers.get('dev-qa').status).toBe('working');
  });

  it('manajer dan CEO ikut berbicara memakai frasa bawaan mereka', () => {
    const o = new Office({ seed: 4 });
    const mgr = new Set();
    const ceo = new Set();
    run(o, 240, (x) => {
      if (x.manager.bubble) mgr.add(x.manager.bubble.text);
      if (x.ceo.bubble) ceo.add(x.ceo.bubble.text);
    });
    expect([...mgr].some((s) => DEFAULT_PERSONALITIES[MANAGER_ID].speech.phrases.some((p) => p.en === s))).toBe(true);
    expect([...ceo].some((s) => DEFAULT_PERSONALITIES[CEO_ID].speech.phrases.some((p) => p.en === s))).toBe(true);
  });
});

describe('kebiasaan idle menentukan siapa yang berjalan ke pantry', () => {
  const leaves = (pers, seconds = 300) => {
    const o = new Office({ seed: 9, personalityFor: all(pers) });
    let left = 0;
    run(o, seconds, (x) => {
      for (const w of x.workers.values()) if (w.mode !== 'seat') left++;
    });
    return left;
  };

  it('kopi, air, camilan, tanaman, ngobrol: berjalan; peregangan, telepon, jendela: tetap di meja', () => {
    for (const idle of ['coffee', 'water', 'snack', 'plant', 'chat']) expect(leaves(resolvePersonality({ idle })), idle).toBeGreaterThan(0);
    for (const idle of ['stretch', 'phone', 'window']) expect(leaves(resolvePersonality({ idle })), idle).toBe(0);
  });

  it('batas maxAway tetap berlaku', () => {
    const o = new Office({ seed: 9, personalityFor: all(resolvePersonality({ idle: 'water' })) });
    let max = 0;
    run(o, 300, (x) => {
      max = Math.max(max, [...x.workers.values()].filter((w) => w.mode !== 'seat').length);
    });
    expect(max).toBeGreaterThan(0);
    expect(max).toBeLessThanOrEqual(TUNING.maxAway);
  });
});

describe('reduced motion: tanpa jalan-jalan, quirk statis atau mati', () => {
  const seatWorker = (name) => ({ name, mode: 'seat', status: 'idle', statusSince: -Infinity, sendUntil: -Infinity, bubble: null, facing: 'down', walkDist: 0, x: 0, y: 0 });
  const WORKERS = AGENT_NAMES;

  it('engine: dalam 10 menit tidak ada worker yang meninggalkan meja', () => {
    const o = new Office({ seed: 21 });
    o.setReducedMotion(true);
    let away = 0;
    run(o, 600, (x) => {
      for (const w of x.workers.values()) if (w.mode !== 'seat') away++;
    });
    expect(away).toBe(0);
  });

  it('spec sprite: tanpa gerakan (tidak ada pose idle, menoleh, mulut menguap, atau lengan quirk); hanya headphones statis', () => {
    for (const name of WORKERS) {
      const pers = personalityOf(name);
      for (let tt = 0; tt < 90; tt += 0.07) {
        const spec = workerSpec(seatWorker(name), tt, true, 1234, pers);
        expect(spec.act ?? null, `${name} ${tt}`).toBeNull();
        expect(spec.dir).toBe('down');
        expect(Boolean(spec.mouth)).toBe(false);
        expect(spec.blink).toBe(false);
        expect(spec.phones, name).toBe(Boolean(QUIRKS[pers.quirk]?.phones));
      }
    }
    expect(WORKERS.filter((n) => personalityOf(n).quirk === 'headphones')).toEqual(['dev-security', '3d-modeler']);
  });

  it('tanpa reduced motion: kebiasaan idle dan quirk tiap worker bawaan benar-benar muncul pada suatu saat', () => {
    for (const name of WORKERS) {
      const pers = personalityOf(name);
      const beh = IDLE_BEHAVIORS[pers.idle];
      const q = QUIRKS[pers.quirk];
      let idleSeen = false;
      let quirkSeen = q.phones || Boolean(q.draw && !q.act && !q.mouth && !q.tap); // quirk gambar murni dicek lewat quirkPhase
      for (let tt = 0; tt < 120; tt += 0.05) {
        const spec = workerSpec(seatWorker(name), tt, false, 1234, pers);
        if (beh.seat === 'turn' ? spec.dir === 'up' : spec.act === beh.seat) idleSeen = true;
        if ((q.act && spec.act === q.act) || (q.mouth && spec.mouth)) quirkSeen = true;
        if (q.draw && quirkPhase(tt, 1234, false) >= 0) quirkSeen = true;
      }
      expect(idleSeen, `${name} idle ${pers.idle}`).toBe(true);
      expect(quirkSeen, `${name} quirk ${pers.quirk}`).toBe(true);
    }
  });

  it('spec deterministik: masukan sama memberi spesifikasi sama', () => {
    const w = seatWorker('dev-ui-critic');
    for (let tt = 0; tt < 60; tt += 0.3) {
      expect(workerSpec(w, tt, false, 99, personalityOf(w.name))).toEqual(workerSpec(w, tt, false, 99, personalityOf(w.name)));
    }
  });

  it('quirk tidak berjalan saat worker blocked, done, atau sedang mengetik', () => {
    const pers = resolvePersonality({ quirk: 'glasses' });
    for (const status of ['blocked', 'done']) {
      for (let tt = 0; tt < 40; tt += 0.1) {
        const spec = workerSpec({ ...seatWorker('x'), status, statusSince: -Infinity }, tt, false, 5, pers);
        expect(spec.act === 'glasses').toBe(false);
      }
    }
    for (let tt = 0; tt < 40; tt += 0.1) {
      const spec = workerSpec({ ...seatWorker('x'), status: 'working' }, tt, false, 5, pers);
      expect(spec.act).toBe('type');
    }
  });
});

describe('tata letak bawaan tetap identik dengan fixture', () => {
  const check = () => {
    expect(W).toBe(FIX.W);
    expect(layout.H).toBe(FIX.H);
    expect(BASE_H).toBe(FIX.H);
    expect(plain(ZONES)).toEqual(FIX.ZONES);
    expect(zoneList().map((z) => ({ id: z.division.id, rect: z.rect }))).toEqual(FIX.zones);
    expect(plain([...rosterSeats()].map(([n, s]) => [n, s.division.id, s.seat, s.desk, s.front, s.exit, s.hit]))).toEqual(FIX.seats);
    expect(plain([0, 1, 2, 3, 4, 5].map((i) => {
      const s = otherSeat(i);
      return [s.division.id, s.seat, s.desk];
    }))).toEqual(FIX.other);
  };

  it('dengan kepribadian bawaan aktif', () => {
    new Office();
    check();
  });

  it('setelah divisi plugin ber-personalities dimuat lalu dikosongkan', () => {
    applyDivisionsResponse(200, {
      ok: true,
      errors: [],
      divisions: [{ id: 'lay', name: { en: 'L', id: 'L' }, color: '#112233', desks: 2, workers: ['lay-a', 'lay-b'], source: 'plugin', personalities: { 'lay-a': { nickname: 'Panjang Sekali Nama', idle: 'chat' } } }],
    });
    resetDivisions();
    check();
  });

  it('nama panggilan hanya dirender sebagai teks label, tidak mengubah ukuran meja atau zona', () => {
    const before = plain([...rosterSeats()]);
    applyDivisionsResponse(200, {
      ok: true,
      errors: [],
      divisions: [{ id: 'lay', name: { en: 'L', id: 'L' }, color: '#112233', desks: 1, workers: ['lay-a'], source: 'plugin', personalities: { 'lay-a': { nickname: 'Nick' } } }],
    });
    const after = plain([...rosterSeats()].filter(([n]) => AGENT_NAMES.includes(n)));
    expect(after).toEqual(before.filter(([n]) => AGENT_NAMES.includes(n)));
  });
});

// ------------------------------------------------------------------ waktu frame

describe('waktu frame (update + draw) dengan 19 karakter', () => {
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

  function measure(reduced) {
    globalThis.document = { createElement: () => stubCanvas(layout.W, layout.H) };
    try {
      const r = createRenderer(stubCanvas(layout.W * 2, layout.H * 2), { theme: 'dark' });
      const o = new Office({ seed: 4 });
      o.setReducedMotion(reduced);
      expect(o.workers.size + 2).toBe(19); // 17 worker + manajer + CEO
      const names = [...o.workers.keys()];
      // campuran status supaya semua jalur gambar terpakai: bekerja, selesai, blokir, antrean tugas, bubble
      o.handleEvent(ev('assign', 'manager', names[0], 'Kerjakan'));
      o.handleEvent(ev('working', names[1], 'manager', 'Sedang jalan'), { instant: true });
      o.handleEvent(ev('blocked', names[2], 'manager', 'Butuh bantuan'), { instant: true });
      o.handleEvent(ev('done', names[3], 'manager', 'Beres'), { instant: true });
      const frame = (i) => {
        o.update(DT);
        r.draw(o, 1_700_000_000_000 + i * 16);
      };
      for (let i = 0; i < 600; i++) frame(i); // pemanasan: cache sprite terisi
      const N = 3000;
      const times = new Array(N);
      for (let i = 0; i < N; i++) {
        const t0 = performance.now();
        frame(600 + i);
        times[i] = performance.now() - t0;
      }
      times.sort((a, b) => a - b);
      const mean = times.reduce((s, v) => s + v, 0) / N;
      return { mean, p95: times[Math.floor(N * 0.95)], p99: times[Math.floor(N * 0.99)], max: times[N - 1] };
    } finally {
      delete globalThis.document;
    }
  }

  it('rata-rata di bawah 1 ms per frame (normal dan reduced motion)', () => {
    const normal = measure(false);
    const reduced = measure(true);
    // eslint-disable-next-line no-console
    console.info(`waktu frame ms (19 karakter, kanvas tiruan): normal mean=${normal.mean.toFixed(3)} p95=${normal.p95.toFixed(3)} p99=${normal.p99.toFixed(3)} max=${normal.max.toFixed(3)} | reduced mean=${reduced.mean.toFixed(3)} p95=${reduced.p95.toFixed(3)}`);
    expect(normal.mean).toBeLessThan(1);
    expect(reduced.mean).toBeLessThan(1);
  });

  it('cache sprite: kepribadian hanya menambah sedikit varian dibanding netral, dan jumlahnya terbatas', () => {
    const count = (personalityFor) => {
      const created = [];
      globalThis.document = { createElement: () => { const c = stubCanvas(layout.W, layout.H); created.push(c); return c; } };
      try {
        const r = createRenderer(stubCanvas(layout.W * 2, layout.H * 2), { theme: 'dark' });
        const o = new Office({ seed: 4, personalityFor });
        for (let i = 0; i < 60 * 240; i++) {
          o.update(DT);
          r.draw(o, i * 16);
        }
        return created.length;
      } finally {
        delete globalThis.document;
      }
    };
    const withPersonality = count(undefined);
    const neutral = count(() => NEUTRAL_PERSONALITY);
    expect(withPersonality).toBeLessThan(neutral * 1.6);
    expect(withPersonality).toBeLessThan(700); // canvas 16x24 kecil; 19 karakter x pose
  }, 60_000); // 2 x 14.400 frame: ini menghitung varian cache, bukan mengukur waktu; 15 dtk bawaan terlalu ketat di mesin sibuk
});
