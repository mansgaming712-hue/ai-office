// Kantor Jakarta: karakter Indonesia, sprite 16x24 dengan 4 arah jalan, perilaku idle (pantry) yang hanya untuk agen
// idle, CEO, hujan, layout pantry/ruang rapat, dan cache renderer (latar tidak digambar ulang tiap frame).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { AGENT_NAMES, CEO_ID, DIVISIONS, MANAGER_ID } from '../shared/roster.js';
import { getLang, hasKey, setLang, t } from '../src/i18n.js';
import {
  HAIRS, LOOKS, characterName, deskLabel, lookFor, roleOf, shirtOf,
} from '../src/office/characters.js';
import { CHAT_LINES, Office, TUNING } from '../src/office/engine.js';
import {
  CEO_ROOM, CELL, DECOR, DOOR, H, MEETING, PANTRY, W, WALL_H, WALL_ITEMS, WINDOWS, ZONES, obstacles, rosterSeats, zoneList,
} from '../src/office/layout.js';
import { PALETTES } from '../src/office/palette.js';
import { createGrid, findPath } from '../src/office/pathfinding.js';
import { createRenderer } from '../src/office/render.js';
import { paneRects } from '../src/office/scene.js';
import {
  SIT_ROWS, SPR_H, SPR_W, WALK_FRAMES, buildGrid, createSpriteCache,
} from '../src/office/sprites.js';

const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;
const run = (o, seconds, each) => {
  const dt = 1 / 60;
  for (let t0 = 0; t0 < seconds; t0 += dt) {
    o.update(dt);
    each?.(o);
  }
};
const intersects = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const blocked = (g, p) => g.blocked[Math.floor(p.y / g.cell) * g.cols + Math.floor(p.x / g.cell)] === 1;

// ------------------------------------------------------------------ karakter

describe('karakter: nama dan penampilan', () => {
  it('manajer, CEO, dan semua 17 agen roster punya penampilan sendiri', () => {
    const ids = [...AGENT_NAMES, MANAGER_ID, CEO_ID];
    expect(ids).toHaveLength(19);
    for (const id of ids) expect(LOOKS[id], id).toBeTruthy();
    const keys = ids.map((id) => JSON.stringify({ ...LOOKS[id] }));
    expect(new Set(keys).size).toBe(ids.length); // tidak ada dua penampilan yang persis sama
  });

  it('nama orang Indonesia unik lewat t(), ada di EN dan ID, dan label meja berbentuk "Nama · peran"', () => {
    const original = getLang();
    try {
      for (const lang of ['en', 'id']) {
        setLang(lang, { persist: false });
        const names = [...AGENT_NAMES, MANAGER_ID, CEO_ID].map((id) => {
          expect(hasKey(`office.char.${id}`), `${lang} ${id}`).toBe(true);
          return characterName(id);
        });
        expect(new Set(names).size).toBe(names.length);
        for (const n of names) expect(n).toMatch(/^[A-Z][a-z]+(\.? [A-Z][a-z]+)?$/);
      }
    } finally {
      setLang(original, { persist: false });
    }
    expect(roleOf('dev-frontend')).toBe('frontend');
    expect(roleOf('3d-render')).toBe('render');
    expect(roleOf('dev-ui-critic')).toBe('ui-critic');
    expect(deskLabel('dev-frontend')).toBe(`${characterName('dev-frontend')} · frontend`);
    expect(deskLabel('Explore')).toBe('Explore'); // agen tamu: nama agennya apa adanya
  });

  it('aksesori beragam: hijab, kacamata, topi, janggut; warna baju mengikuti divisi', () => {
    const looks = AGENT_NAMES.map((n) => LOOKS[n]);
    expect(looks.filter((l) => l.acc === 'hijab').length).toBeGreaterThanOrEqual(3);
    expect(looks.filter((l) => l.acc === 'cap' || l.acc === 'beanie').length).toBeGreaterThanOrEqual(3);
    expect(looks.filter((l) => l.glasses).length).toBeGreaterThanOrEqual(4);
    expect(looks.filter((l) => l.beard).length).toBeGreaterThanOrEqual(2);
    expect(new Set(looks.map((l) => l.style)).size).toBeGreaterThanOrEqual(5);
    for (const l of [...looks, LOOKS[MANAGER_ID], LOOKS[CEO_ID]]) expect(HAIRS[l.hair]).toBeTruthy();
    for (const d of DIVISIONS) for (const a of d.agents) expect(shirtOf(a)).toBe(d.color);
  });

  it('agen tamu mendapat penampilan stabil turunan dari namanya', () => {
    expect(lookFor('Explore')).toEqual(lookFor('Explore'));
    expect(lookFor('Explore').id).toBe('Explore');
  });
});

// ------------------------------------------------------------------ sprite

describe('sprite 16x24: 4 arah, frame jalan, pose', () => {
  const look = lookFor('dev-frontend');
  const filled = (g) => g.filter(Boolean).length;
  const base = { pose: 'stand', moving: true };

  it('setiap arah dan frame menghasilkan grid 16x24 yang terisi dan tetap di dalam kanvas', () => {
    for (const dir of ['down', 'up', 'left', 'right']) {
      for (let f = 0; f < 4; f++) {
        const g = buildGrid(look, 'worker', { ...base, dir, frame: f });
        expect(g).toHaveLength(SPR_W * SPR_H);
        expect(filled(g), `${dir} ${f}`).toBeGreaterThan(80);
        // baris paling atas dan bawah dibiarkan kosong untuk garis tepi
        expect(g.slice(0, SPR_W).some(Boolean)).toBe(false);
        expect(g.slice(-SPR_W).some(Boolean)).toBe(false);
      }
    }
  });

  it('animasi jalan: frame berbeda menghasilkan gambar berbeda di tiap arah (4 frame, siklus netral-A-netral-B)', () => {
    expect(WALK_FRAMES).toEqual([0, 1, 0, 2]);
    for (const dir of ['down', 'up', 'left', 'right']) {
      const g = [0, 1, 2, 3].map((f) => JSON.stringify(buildGrid(look, 'worker', { ...base, dir, frame: f })));
      expect(g[0]).toBe(g[2]); // dua frame netral sama
      expect(g[1]).not.toBe(g[0]);
      expect(g[3]).not.toBe(g[0]);
      expect(g[1]).not.toBe(g[3]);
    }
  });

  it('arah kanan = cermin arah kiri; atas (punggung) berbeda dari bawah (wajah)', () => {
    const l = buildGrid(look, 'worker', { ...base, dir: 'left', frame: 0 });
    const r = buildGrid(look, 'worker', { ...base, dir: 'right', frame: 0 });
    for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x++) expect(r[y * SPR_W + x]).toBe(l[y * SPR_W + (SPR_W - 1 - x)]);
    const down = buildGrid(look, 'worker', { ...base, dir: 'down', frame: 0 });
    const up = buildGrid(look, 'worker', { ...base, dir: 'up', frame: 0 });
    expect(JSON.stringify(down)).not.toBe(JSON.stringify(up));
    expect(down.includes('e')).toBe(true); // mata terlihat dari depan
    expect(up.includes('e')).toBe(false); // tidak dari belakang
  });

  it('pose: duduk mengetik, minum kopi, merayakan, stres, dan mengobrol berbeda satu sama lain', () => {
    const poses = [
      { pose: 'sit', act: 'type', typeFrame: false },
      { pose: 'sit', act: 'type', typeFrame: true },
      { pose: 'sit', act: 'sip' },
      { pose: 'sit', act: 'celebrate' },
      { pose: 'sit', act: 'stress' },
      { pose: 'sit', mouth: true },
      { pose: 'sit', blink: true },
      { pose: 'sit' },
    ].map((p) => JSON.stringify(buildGrid(look, 'worker', { dir: 'down', ...p })));
    expect(new Set(poses).size).toBe(poses.length);
    expect(SIT_ROWS).toBeLessThan(SPR_H);
  });

  it('cache sprite: spesifikasi sama memakai canvas yang sama; garis tepi mengikuti tema', () => {
    const made = [];
    const cache = createSpriteCache(() => {
      const log = [];
      let fill = null;
      const ctx = { set fillStyle(v) { fill = v; }, fillRect: (...a) => log.push([fill, ...a]) };
      const c = { log, getContext: () => ctx };
      made.push(c);
      return c;
    });
    const spec = { dir: 'down', pose: 'stand', frame: 0 };
    const a = cache.get(look, 'worker', '#3b6fb6', PALETTES.light.outline, spec);
    expect(cache.get(look, 'worker', '#3b6fb6', PALETTES.light.outline, spec)).toBe(a);
    expect(made).toHaveLength(1);
    const b = cache.get(look, 'worker', '#3b6fb6', PALETTES.dark.outline, spec);
    expect(b).not.toBe(a);
    expect(a.log.some((e) => e[0] === PALETTES.light.outline)).toBe(true);
    expect(b.log.some((e) => e[0] === PALETTES.dark.outline)).toBe(true);
    expect(a.log.some((e) => e[0] === '#3b6fb6')).toBe(true); // baju = warna divisi
    expect(a.width).toBe(SPR_W);
    expect(a.height).toBe(SPR_H);
  });
});

// ------------------------------------------------------------------ layout Jakarta

describe('layout kantor Jakarta: pantry, ruang rapat, jendela', () => {
  const o = new Office();
  const g = o.grid;

  it('jendela, papan tulis, jam, poster, dan AC berada di dinding atas', () => {
    for (const w of WINDOWS) expect(w.y + w.h).toBeLessThanOrEqual(WALL_H);
    expect(WINDOWS).toHaveLength(3); // dua jendela kantor + jendela ruang CEO
    expect(paneRects()).toHaveLength(9);
    for (const p of paneRects()) expect(WINDOWS.some((w) => p.x >= w.x && p.x + p.w <= w.x + w.w)).toBe(true);
    for (const r of [WALL_ITEMS.ac, WALL_ITEMS.board, ...WALL_ITEMS.posters, WALL_ITEMS.meetBoard]) {
      expect(r.y + r.h).toBeLessThanOrEqual(WALL_H);
      expect(r.x + r.w).toBeLessThanOrEqual(W);
    }
    // benda dinding tidak saling menimpa (jendela, papan, poster, AC, pintu, jam)
    const boxes = [...WINDOWS, WALL_ITEMS.board, ...WALL_ITEMS.posters, WALL_ITEMS.meetBoard, { x: DOOR.x, y: DOOR.y, w: DOOR.w, h: DOOR.h },
      { x: WALL_ITEMS.clock.x - 7, y: WALL_ITEMS.clock.y - 7, w: 14, h: 14 }];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) expect(intersects(boxes[i], boxes[j]), `${i} vs ${j}`).toBe(false);
  });

  it('pantry dan ruang rapat tidak menimpa zona divisi, dan menjadi penghalang jalan', () => {
    for (const z of zoneList()) {
      expect(intersects(MEETING, z.rect), z.division.id).toBe(false);
      expect(intersects(PANTRY.counter, z.rect)).toBe(false);
    }
    const blockedRects = obstacles([]);
    for (const r of [MEETING, PANTRY.counter, PANTRY.dispenser]) {
      expect(blockedRects.some((b) => b.x <= r.x && b.y <= r.y && b.x + b.w >= r.x + r.w && b.y + b.h >= r.y + r.h)).toBe(true);
    }
    expect(DECOR.map((d) => d.kind)).toEqual(expect.arrayContaining(['counter', 'dispenser', 'meeting', 'plant']));
    expect(ZONES.dev.seats.length + ZONES.sales.seats.length + ZONES.content.seats.length + ZONES.research.seats.length + ZONES['3d'].seats.length).toBe(17);
  });

  it('titik berdiri pantry bebas, dan setiap meja punya titik bangun yang bebas dengan jalur ke semua titik pantry dan kembali', () => {
    for (const s of PANTRY.slots) {
      expect(blocked(g, s), `slot ${s.x},${s.y}`).toBe(false);
      expect(findPath(g, DOOR.enter, s)).not.toBeNull();
    }
    for (const [name, st] of rosterSeats()) {
      expect(blocked(g, st.exit), `exit ${name}`).toBe(false);
      expect(st.exit.x).toBeGreaterThan(st.desk.x + st.desk.w);
      for (const s of PANTRY.slots) {
        expect(findPath(g, st.exit, s), `${name} → pantry`).not.toBeNull();
        expect(findPath(g, s, st.exit), `pantry → ${name}`).not.toBeNull();
      }
    }
  });

  it('tinggi kanvas memuat zona terbawah dan label mejanya', () => {
    const lowest = zoneList().map((z) => z.rect.y + z.rect.h);
    expect(Math.max(...lowest)).toBeLessThanOrEqual(H);
    expect(CELL).toBe(8);
  });

  it('palet gelap = malam (lampu gedung), terang = siang; kedua tema punya kunci suasana Jakarta yang sama', () => {
    for (const k of ['skyTop', 'skyLow', 'nearBldg', 'bldgLit', 'cloud', 'rain', 'counterTop', 'meetFloor', 'acBody', 'posterPaper', 'outline']) {
      expect(PALETTES.light[k], k).toBeTruthy();
      expect(PALETTES.dark[k], k).toBeTruthy();
      expect(PALETTES.light[k]).not.toBe(PALETTES.dark[k]);
    }
    expect(PALETTES.dark.night).toBe(true);
    expect(PALETTES.light.night).toBe(false);
  });
});

// ------------------------------------------------------------------ perilaku idle (hanya agen idle)

describe('engine: pantry, obrolan, dan ngopi hanya saat agen benar-benar idle', () => {
  it('agen idle sesekali berjalan ke pantry, ngopi, lalu kembali duduk', () => {
    const o = new Office();
    const modes = new Set();
    const facings = new Set();
    let maxAway = 0;
    run(o, 150, (x) => {
      let away = 0;
      for (const w of x.workers.values()) {
        modes.add(w.mode);
        if (w.mode === 'out' || w.mode === 'back') facings.add(w.facing);
        if (w.mode !== 'seat') away++;
        expect(w.status).toBe('idle');
      }
      maxAway = Math.max(maxAway, away);
    });
    expect([...modes]).toEqual(expect.arrayContaining(['seat', 'out', 'pantry', 'back']));
    expect(facings.size).toBeGreaterThanOrEqual(2); // berjalan ke lebih dari satu arah
    expect(maxAway).toBeLessThanOrEqual(TUNING.maxAway);
    run(o, 40);
    // tidak ada yang tersangkut: dalam rentang waktu panjang selalu ada yang kembali duduk
    expect([...o.workers.values()].filter((w) => w.mode === 'seat').length).toBeGreaterThan(10);
  });

  it('perilaku idle deterministik (biji acak tetap): dua kantor menghasilkan urutan yang sama', () => {
    const trace = () => {
      const o = new Office();
      const out = [];
      run(o, 90, (x) => {
        for (const w of x.workers.values()) if (w.mode === 'pantry' && !out.includes(w.name)) out.push(w.name);
      });
      return out;
    };
    const a = trace();
    expect(a.length).toBeGreaterThan(0);
    expect(trace()).toEqual(a);
  });

  it('agen yang bekerja, selesai, atau error tidak pernah pergi ke pantry', () => {
    const o = new Office();
    for (const n of AGENT_NAMES) o.handleEvent(ev('assign', 'manager', n), { instant: true });
    o.handleEvent(ev('done', 'dev-qa', 'manager'), { instant: true });
    o.handleEvent(ev('blocked', 'dev-docs', 'manager'), { instant: true });
    run(o, 150, (x) => {
      for (const w of x.workers.values()) expect(w.mode, w.name).toBe('seat');
    });
  });

  it('event untuk agen yang sedang ke pantry: segera kembali ke meja, lalu bekerja', () => {
    const o = new Office();
    let target = null;
    run(o, 60, (x) => {
      if (!target) target = [...x.workers.values()].find((w) => w.mode === 'pantry') ?? null;
    });
    expect(target).not.toBeNull();
    // cari saat ada agen di pantry lagi, lalu beri tugas
    const o2 = new Office();
    let w2 = null;
    for (let i = 0; i < 60 * 80 && !w2; i++) {
      o2.update(1 / 60);
      w2 = [...o2.workers.values()].find((w) => w.mode === 'pantry' && w.stage === 'drink') ?? null;
    }
    expect(w2).not.toBeNull();
    o2.handleEvent(ev('assign', 'manager', w2.name, 'Kerjakan ini'));
    expect(w2.mode).toBe('back');
    expect(w2.recalled).toBe(true);
    const seen = [];
    run(o2, 20, (x) => {
      if (seen.at(-1) !== w2.mode) seen.push(w2.mode);
    });
    expect(seen.at(-1)).toBe('seat');
    expect(w2.status).toBe('working');
    expect({ x: w2.x, y: w2.y }).toEqual(w2.seat);
  });

  it('reduced motion: tidak ada jalan-jalan idle, dan agen yang sedang pergi langsung duduk', () => {
    const o = new Office();
    let away = null;
    for (let i = 0; i < 60 * 60 && !away; i++) {
      o.update(1 / 60);
      away = [...o.workers.values()].find((w) => w.mode !== 'seat') ?? null;
    }
    expect(away).not.toBeNull();
    o.setReducedMotion(true);
    expect(away.mode).toBe('seat');
    run(o, 150, (x) => {
      for (const w of x.workers.values()) expect(w.mode).toBe('seat');
    });
  });

  it('agen tamu (di luar roster) tidak ikut jalan ke pantry', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'Explore'), { instant: true });
    o.workers.get('explore').status = 'idle';
    run(o, 200, (x) => expect(x.workers.get('explore').mode).toBe('seat'));
  });

  it('obrolan di pantry memakai kunci terjemahan yang ada, dan bubble bertipe chat', () => {
    for (let i = 1; i <= CHAT_LINES; i++) expect(hasKey(`office.chat.${i}`)).toBe(true);
    const o = new Office();
    const kinds = new Set();
    run(o, 200, (x) => {
      for (const w of x.workers.values()) if (w.bubble) kinds.add(w.bubble.kind);
    });
    expect(kinds.has('chat')).toBe(true);
    expect([...kinds].every((k) => k === 'chat')).toBe(true); // saat semua idle, hanya bubble santai
  });
});

describe('engine: kirim hasil, CEO, dan hujan', () => {
  it('done: pose kirim sebentar, amplop terbang ke manajer', () => {
    const o = new Office();
    o.handleEvent(ev('done', 'dev-qa', 'manager', 'selesai'));
    const w = o.workers.get('dev-qa');
    expect(w.sendUntil).toBeGreaterThan(o.time);
    expect(w.sendUntil - o.time).toBeCloseTo(TUNING.sendPose, 5);
    expect(o.envelopes).toHaveLength(1);
    run(o, 3);
    expect(o.inbox).toBe(1);
  });

  it('CEO: memberi perintah (pose beri), lalu bereaksi saat laporan manajer tiba', () => {
    const o = new Office();
    expect(o.ceo).toMatchObject({ x: CEO_ROOM.seat.x, y: CEO_ROOM.seat.y, state: 'sitting' });
    o.handleEvent(ev('assign', 'ceo', 'manager', 'Luncurkan'));
    expect(o.ceo.giveUntil).toBeGreaterThan(o.time); // pose beri langsung (t=0)
    run(o, 3);
    expect(o.manager.bubble?.kind).toBe('command');
    o.handleEvent(ev('report', 'manager', 'ceo', 'Beres'));
    run(o, 3);
    expect(o.ceo.cheerUntil).toBeGreaterThan(0);
    expect(o.ceo.bubble).toMatchObject({ kind: 'ceo', text: t('office.bubble.ceoThanks') });
    run(o, 4);
    expect(o.ceo.bubble).toBeNull();
  });

  it('hujan: berfade naik dan turun, pilihan dipertahankan saat reset', () => {
    const o = new Office();
    expect(o.rainLevel).toBe(0);
    o.setRain(true);
    run(o, 0.5);
    expect(o.rainLevel).toBeGreaterThan(0);
    expect(o.rainLevel).toBeLessThan(1);
    run(o, 4);
    expect(o.rainLevel).toBe(1);
    o.reset();
    expect(o.rainOn).toBe(true);
    o.setRain(false);
    run(o, 4);
    expect(o.rainLevel).toBe(0);
  });

  it('alur event nyata tetap: assign → manajer berjalan dengan arah → worker bekerja', () => {
    const o = new Office();
    o.handleEvent(ev('assign', 'manager', 'dev-qa', 'Uji'));
    const dirs = new Set();
    run(o, 14, (x) => {
      if (x.manager.state === 'walking') dirs.add(x.manager.facing);
    });
    expect(dirs.size).toBeGreaterThanOrEqual(2);
    expect(o.workers.get('dev-qa').status).toBe('working');
  });
});

// ------------------------------------------------------------------ renderer: cache dan sprite

function fakeCtx(log) {
  const state = { fillStyle: '#000000', globalAlpha: 1, font: '', textAlign: 'left', textBaseline: 'alphabetic' };
  return new Proxy(state, {
    get(t0, k) {
      if (k in t0) return t0[k];
      if (k === 'measureText') return (s) => ({ width: String(s).length * 3.5 });
      if (k === 'fillRect') return (...a) => log.push({ op: 'rect', fill: t0.fillStyle, args: a });
      if (k === 'fillText') return (text) => log.push({ op: 'text', text: String(text) });
      if (k === 'drawImage') return (...a) => log.push({ op: 'image', args: a });
      return () => {};
    },
    set(t0, k, v) {
      t0[k] = v;
      return true;
    },
  });
}

describe('renderer: latar dan label di-cache', () => {
  let created;
  const makeCanvas = (w = W, h = H) => {
    const log = [];
    const ctx = fakeCtx(log);
    const c = { width: w, height: h, log, getContext: () => ctx };
    created.push(c);
    return c;
  };
  beforeEach(() => {
    created = [];
    globalThis.document = { createElement: () => makeCanvas() };
  });
  afterEach(() => {
    delete globalThis.document;
  });

  function setup(theme = 'dark') {
    const base = created.length;
    const main = makeCanvas(W * 2, H * 2);
    const r = createRenderer(main, { theme });
    const [pix, bg, labels] = created.slice(base + 1);
    return { r, main, pix, bg, labels };
  }

  it('latar tidak digambar ulang per frame; hanya saat tema berganti', () => {
    const { r, bg } = setup('light');
    const o = new Office();
    const n = bg.log.length;
    for (let i = 0; i < 30; i++) {
      o.update(1 / 60);
      r.draw(o, 0);
    }
    expect(bg.log.length).toBe(n); // 30 frame: latar tidak disentuh
    r.setTheme('dark');
    expect(bg.log.length).toBeGreaterThan(n);
    const m = bg.log.length;
    r.setTheme('dark');
    for (let i = 0; i < 5; i++) r.draw(o, 0);
    expect(bg.log.length).toBeGreaterThanOrEqual(m);
  });

  it('label hanya digambar ulang saat status berubah (bukan tiap frame)', () => {
    const { r, labels } = setup('dark');
    const o = new Office();
    r.draw(o, 0);
    const n = labels.log.length;
    expect(n).toBeGreaterThan(40); // judul divisi + nama meja + poster + plakat
    for (let i = 0; i < 20; i++) {
      o.update(1 / 60);
      r.draw(o, 0);
    }
    expect(labels.log.length).toBe(n);
    o.handleEvent(ev('blocked', 'dev-qa', 'manager'), { instant: true });
    r.draw(o, 0);
    expect(labels.log.length).toBeGreaterThan(n);
  });

  it('label memuat nama karakter, poster, plakat pantry/ruang rapat, dan nama manajer/CEO (lewat t())', () => {
    const { r, labels } = setup('light');
    const o = new Office();
    r.draw(o, 0);
    const texts = labels.log.filter((e) => e.op === 'text').map((e) => e.text);
    for (const n of AGENT_NAMES) expect(texts, n).toContain(deskLabel(n));
    expect(texts).toContain(`${characterName(MANAGER_ID)} · ${t('office.label.manager')}`);
    expect(texts).toContain(`${characterName(CEO_ID)} · ${t('office.label.ceo')}`);
    expect(texts.filter((x) => x === t('office.label.ceo'))).toHaveLength(2); // plakat kaca + papan nama meja
    expect(texts).toContain(t('office.label.pantry'));
    expect(texts).toContain(t('office.label.meeting'));
    expect(texts.some((x) => t('office.poster.1').startsWith(x))).toBe(true);
    expect(texts.some((x) => t('office.poster.2').startsWith(x))).toBe(true);
  });

  it('sprite karakter diambil dari cache offscreen dan digambar dengan drawImage (bukan per piksel tiap frame)', () => {
    const { r, pix } = setup('dark');
    const o = new Office();
    r.draw(o, 0);
    const first = created.length;
    pix.log.length = 0;
    r.draw(o, 0);
    expect(created.length).toBe(first); // frame kedua tidak membuat canvas sprite baru
    const images = pix.log.filter((e) => e.op === 'image');
    expect(images.length).toBeGreaterThanOrEqual(AGENT_NAMES.length + 3); // latar + 17 agen + manajer + CEO
  });

  it('hujan hanya digambar tanpa reduced motion', () => {
    const rainFills = (reduced) => {
      created = [];
      const { r, pix } = setup('dark');
      const o = new Office();
      o.setReducedMotion(reduced);
      o.setRain(true);
      run(o, 3);
      pix.log.length = 0;
      r.draw(o, 0);
      return pix.log.filter((e) => e.op === 'rect' && e.fill === PALETTES.dark.rain).length;
    };
    expect(rainFills(false)).toBeGreaterThan(20);
    expect(rainFills(true)).toBe(0);
  });
});

describe('OfficeCanvas: satu rAF dan jeda saat tab tersembunyi', () => {
  const src = readFileSync(new URL('../src/ui/OfficeCanvas.jsx', import.meta.url), 'utf8');

  it('loop berhenti saat document.hidden dan dilanjutkan saat terlihat; tidak ada rAF kedua', () => {
    expect(src).toMatch(/document\.hidden/);
    expect(src).toMatch(/visibilitychange/);
    expect(src).toMatch(/cancelAnimationFrame\(raf\)/);
    const calls = src.match(/requestAnimationFrame\(/g) ?? [];
    expect(calls.length).toBe(2); // mulai + jadwalkan frame berikutnya, keduanya mengisi variabel `raf` yang sama
    expect(src).not.toMatch(/setInterval|setTimeout/);
  });

  it('tombol hujan: label lewat t(), aria-pressed, nonaktif saat reduced motion', () => {
    expect(src).toMatch(/aria-pressed=\{rain && !reducedMotion\}/);
    expect(src).toMatch(/disabled=\{reducedMotion\}/);
    expect(src).toMatch(/t\('office\.rain\.label'\)/);
  });
});
