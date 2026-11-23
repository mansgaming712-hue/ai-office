// Mesin animasi AI Office: logika murni tanpa DOM, sehingga bisa dites di Node.
// Event (lihat shared/events.js) diterjemahkan menjadi gerakan manajer, status worker, bubble, dan amplop.
import { CEO_ID, MANAGER_ID } from '../../shared/roster.js';
import { agentNames } from '../divisions.js';
import {
  CEO_ROOM, CEO_VISIT, CELL, H, MANAGER_SPOT, PANTRY, W, obstacles, otherSeat, rosterSeats,
} from './layout.js';
import { createGrid, findPath } from './pathfinding.js';
import { getLang, t } from '../i18n.js';
import { advanceAlongPath, nextSpeed, remainingLength } from '../motion.js';
import { personalityOf, speechLines } from '../personality.js';
import { projectOf } from '../sessions.js';
import { idleBehavior } from './quirks.js';

// Label per status internal engine (idle/working/done/blocked) untuk kanvas, menurut bahasa aktif
// (getter, namespace `office` di locales/*.json). Nilainya sama dengan label status UI (idle/bekerja/selesai/error).
export const STATUS_LABEL = Object.defineProperties(
  {},
  Object.fromEntries(
    ['idle', 'working', 'done', 'blocked'].map((k) => [k, { enumerable: true, get: () => t(`office.status.${k}`) }]),
  ),
);

export const TUNING = {
  walkSpeed: 105, // piksel logis per detik
  rushSpeed: 140, // saat antrean tugas panjang
  accel: 520, // piksel/detik^2: ease-in saat mulai berjalan
  decel: 620, // ease-out menjelang tujuan
  minSpeed: 16,
  standUp: 0.3,
  envelopeDedupe: 3, // detik: done+report beruntun dari worker yang sama = satu amplop
  deferredGap: 0.6,
  workerSpeed: 58, // agen berjalan ke pantry lebih santai daripada manajer
  workerRush: 95, // kembali ke meja saat ada tugas atau event untuknya
  rise: 0.3, // detik berdiri di belakang meja sebelum berjalan
  pantryFirst: [5, 11], // jeda sebelum perjalanan pantry pertama (detik, acak deterministik)
  pantryGap: [12, 26], // jeda antar perjalanan pantry
  makeCoffee: 1.6,
  drinkFor: [5, 9],
  chatEvery: 2.6,
  maxAway: 2,
  sendPose: 0.7, // detik pose "kirim" saat amplop hasil keluar dari meja worker
  rainFade: 0.7, // per detik
  phraseFirst: [20, 40], // jeda sebelum frasa kepribadian pertama (detik, acak deterministik)
  phraseEvery: [25, 55], // jeda antar frasa kepribadian
  phraseFor: 3, // lama bubble frasa
  sleepyEvery: [30, 60], // jeda antar celetukan ngantuk saat malam (detik, dibagi tingkat ngantuk)
  sleepyGapCut: 0.4, // pada ngantuk penuh, jeda perjalanan pantry (kopi) dipotong sebesar ini
  ceoRise: 0.35, // detik CEO berdiri dari kursi sebelum berjalan
  ceoWalk: 70, // CEO berjalan santai (kopi, lihat jendela, kembali)
  ceoRush: 160, // CEO mengantar tugas
  ceoGive: 0.9, // detik CEO berdiri menyerahkan amplop
  ceoIdleFirst: [9, 18], // jeda sebelum kebiasaan idle CEO pertama (detik, aliran RNG khusus CEO)
  ceoIdleEvery: [22, 45], // jeda antar kebiasaan idle CEO
  ceoCoffee: [5, 8], // lama minum kopi berdiri
  ceoWindow: [5, 9], // lama berdiri melihat jendela
};

// Obrolan santai di pantry (hanya agen yang benar-benar idle). Kunci office.chat.1..N di locales.
export const CHAT_LINES = 6;
// Celetukan ngantuk di malam/subuh (hanya agen idle). Kunci office.sleepy.1..N di locales.
export const SLEEPY_LINES = 4;

/** Pengacak kecil berbiji tetap (mulberry32): perilaku idle dapat diulang dan dites. */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * opts (semuanya opsional; untuk test deterministik):
 *  - seed: biji RNG mulberry32 (bawaan 20241121)
 *  - rng: fungsi () => [0,1) pengganti RNG (dipakai untuk perilaku pantry dan kepribadian)
 *  - personalityFor: (id) => kepribadian lengkap (bawaan: src/personality.js). Jam engine = jumlah dt yang diberikan ke update().
 */
export class Office {
  constructor(opts = {}) {
    this.opts = opts;
    this.reset();
  }

  reset() {
    this.seats = rosterSeats();
    this.time = 0;
    const seed = this.opts.seed ?? 20241121;
    this.rng = this.opts.rng ?? makeRng(seed);
    this.prng = this.opts.rng ?? makeRng(seed ^ 0x9e3779b9); // aliran terpisah: kepribadian tidak mengubah urutan perilaku pantry
    this.pantryTimer = this.#range(TUNING.pantryFirst);
    this.srng = this.opts.rng ?? makeRng(seed ^ 0x2545f491); // aliran ketiga: celetukan ngantuk tidak menggeser aliran lain
    this.chatTimer = 0;
    this.sleepy = this.sleepy ?? 0; // 0..1, dari fase hari (setSleepy); dipertahankan saat reset
    this.sleepyIn = null;
    this.rainOn = this.rainOn ?? false; // pilihan pengguna (tombol hujan) dipertahankan saat reset
    this.rainLevel = this.rainLevel ?? 0;
    this.reducedMotion = this.reducedMotion ?? false;
    this.workers = new Map();
    this.otherCount = 0;
    for (const name of agentNames()) this.#addWorker(name, this.seats.get(name), false);
    const { seat } = MANAGER_SPOT;
    this.manager = {
      id: MANAGER_ID,
      x: seat.x,
      y: seat.y,
      state: 'sitting',
      facing: 'down',
      path: [],
      job: null,
      timer: 0,
      walkDist: 0,
      speed: 0,
      bubble: null,
      typingUntil: 0,
      phraseIn: null,
    };
    // CEO duduk di mejanya (ruang CEO). Aliran RNG sendiri (tidak menggeser aliran lain, juga saat opts.rng diberikan).
    // Tugas masuk: berdiri, berjalan mengantar amplop ke manajer, lalu kembali; idle: sesekali kopi atau lihat jendela.
    this.crng = makeRng(seed ^ 0x7f4a7c15);
    this.ceo = {
      x: CEO_ROOM.seat.x,
      y: CEO_ROOM.seat.y,
      state: 'sitting', // sitting | rising | walking | doing
      goal: null, // errand | coffee | window | home
      facing: 'down',
      path: [],
      speed: 0,
      walkDist: 0,
      timer: 0,
      errands: [], // perintah CEO yang menunggu diantar
      idleIn: null,
      bubble: null,
      giveUntil: -Infinity,
      cheerUntil: -Infinity,
      phraseIn: null,
    };
    this.queue = [];
    this.envelopes = [];
    this.popups = [];
    this.scheduled = [];
    this.inbox = 0;
    // Peringatan limit (> 85%) dipertahankan saat reset: sumbernya data usage, bukan event.
    this.limitWarning = this.limitWarning ?? false;
    this.stats = { trips: 0, deliveries: 0, envelopesSpawned: 0, envelopesArrived: 0, events: 0 };
    this.#rebuildGrid();
  }

  #range([a, b]) {
    return a + this.rng() * (b - a);
  }

  /** Kepribadian lengkap (hanya tampilan) untuk id worker/manajer/CEO; tanpa data = default netral. */
  personality(id) {
    return (this.opts.personalityFor ?? personalityOf)(id);
  }

  #addWorker(name, station, dynamic) {
    const office = this;
    let status = 'idle';
    this.workers.set(name, {
      name,
      division: station.division,
      seat: station.seat,
      desk: station.desk,
      front: station.front,
      exit: station.exit,
      hit: station.hit,
      // gerak: duduk di meja (seat), bangun lalu berjalan ke pantry (out), ngopi (pantry), atau kembali (back)
      mode: 'seat',
      x: station.seat.x,
      y: station.seat.y,
      facing: 'down',
      path: [],
      speed: 0,
      walkDist: 0,
      timer: 0,
      rise: 0,
      stage: '',
      slot: null,
      recalled: false,
      sendUntil: -Infinity,
      dynamic,
      // Setiap perubahan status mencatat waktunya (statusSince) supaya renderer bisa menganimasikan penandanya.
      get status() {
        return status;
      },
      set status(next) {
        if (next === status) return;
        status = next;
        this.statusSince = office.time;
      },
      statusSince: -Infinity,
      bubble: null,
      phraseIn: null,
      pending: 0,
      deferred: [],
      lastEnvelopeAt: -Infinity,
      project: null,
    });
  }

  /**
   * Roster berubah (divisi plugin dimuat/berubah): hitung ulang meja. Worker yang sudah ada dipindah ke meja
   * barunya (bawaan, plugin, atau tamu), worker plugin baru ditambahkan, worker plugin yang hilang dan idle dibuang.
   * Tanpa perubahan roster, tidak ada yang berubah.
   */
  syncRoster() {
    this.seats = rosterSeats();
    for (const [name, w] of [...this.workers]) {
      if (!this.seats.has(name) && !w.dynamic && w.status === 'idle') this.workers.delete(name);
    }
    for (const name of agentNames()) {
      if (!this.workers.has(name)) this.#addWorker(name, this.seats.get(name), false);
    }
    this.otherCount = 0;
    for (const [name, w] of this.workers) {
      const known = this.seats.has(name);
      const st = known ? this.seats.get(name) : otherSeat(this.otherCount++);
      w.dynamic = !known;
      w.division = st.division;
      w.seat = st.seat;
      w.desk = st.desk;
      w.front = st.front;
      w.exit = st.exit;
      w.hit = st.hit;
      w.mode = 'seat';
      w.x = st.seat.x;
      w.y = st.seat.y;
      w.path = [];
      w.speed = 0;
      w.slot = null;
      w.stage = '';
    }
    this.#rebuildGrid();
  }

  #rebuildGrid() {
    this.grid = createGrid(W, H, CELL, obstacles([...this.workers.values()]));
  }

  /** Worker untuk nama agen; agen di luar roster mendapat meja tamu. */
  ensureWorker(name) {
    let w = this.workers.get(name);
    if (!w) {
      this.#addWorker(name, otherSeat(this.otherCount++), true);
      this.#rebuildGrid();
      w = this.workers.get(name);
    }
    return w;
  }

  #bubble(text, kind, seconds, project = null) {
    if (!text) return null;
    const b = { text, kind, born: this.time, until: this.time + seconds };
    if (project) b.project = project;
    return b;
  }

  /** Preferensi reduced motion: amplop terbang lurus (tanpa lengkung). Info tetap sama. */
  setReducedMotion(on) {
    this.reducedMotion = Boolean(on);
    if (this.reducedMotion) {
      for (const w of this.workers.values()) this.#snapToSeat(w); // tanpa jalan-jalan idle
      this.#ceoSnapHome();
    }
  }

  /**
   * Tingkat ngantuk 0..1 dari fase hari (malam/subuh). HANYA tampilan: idle lebih sering ke pantry (kopi), sesekali
   * menguap (renderer) dan bergumam ngantuk (bubble ambient). Tidak mengubah status, antrean, atau event.
   * 0 = tidak ada efek (aliran RNG persis seperti sebelum fitur ini).
   */
  setSleepy(level) {
    const v = Number.isFinite(level) ? clamp(level, 0, 1) : 0;
    if (v !== this.sleepy) this.sleepyIn = null;
    this.sleepy = v;
  }

  /** Hujan di jendela (dekoratif, pilihan pengguna). Berfade halus; reduced motion = tidak digambar. */
  setRain(on) {
    this.rainOn = Boolean(on);
  }

  /** Nyalakan/matikan peringatan "limit hampir habis" di karakter manajer. */
  setLimitWarning(on) {
    const next = Boolean(on);
    if (next === this.limitWarning) return;
    this.limitWarning = next;
    this.limitWarningSince = this.time;
  }

  /**
   * Bubble manajer yang tampil: bubble biasa (tugas, laporan) didahulukan; saat tidak ada,
   * peringatan limit tampil sebagai bubble tetap (tidak kedaluwarsa) selama peringatan aktif.
   */
  managerBubble() {
    if (this.manager.bubble) return this.manager.bubble;
    if (!this.limitWarning) return null;
    const born = this.limitWarningSince ?? 0;
    return { text: t('office.bubble.limitWarning'), kind: 'warning', born, until: Infinity, sticky: true };
  }

  /**
   * Terapkan satu event yang sudah dinormalisasi.
   * instant=true: hanya ubah status tanpa animasi (dipakai untuk riwayat saat halaman dibuka).
   */
  handleEvent(e, { instant = false } = {}) {
    this.stats.events++;
    const { type, from, to, message } = e;
    const project = projectOf(e);

    if (type === 'assign') {
      if (to === MANAGER_ID) {
        if (instant) return;
        if (from !== CEO_ID && from !== MANAGER_ID && this.workers.has(from)) {
          this.#workerEvent(this.workers.get(from), { ...e, type: 'report' });
        } else {
          this.ceo.errands.push({ message, project });
        }
        return;
      }
      if (to === CEO_ID) {
        if (!instant) this.#managerToCeo(message, 'report', project);
        return;
      }
      const w = this.ensureWorker(to);
      if (instant) {
        w.status = 'working';
        this.#snapToSeat(w);
        return;
      }
      this.#recall(w);
      w.pending++;
      this.queue.push({ to: w.name, message, project });
      return;
    }

    if (from === MANAGER_ID) {
      if (instant) return;
      if (type === 'working') {
        this.manager.typingUntil = this.time + 2.5;
        if (message && this.manager.state === 'sitting') this.manager.bubble = this.#bubble(message, 'working', 2.2, project);
      } else {
        this.#managerToCeo(message, type, project);
      }
      return;
    }
    if (from === CEO_ID) return; // CEO bukan karakter di kantor; cukup tercatat di log.

    const w = this.ensureWorker(from);
    if (project) w.project = project;
    if (instant) this.#snapToSeat(w);
    else this.#recall(w);
    if (instant) {
      if (type === 'report') w.status = w.status === 'blocked' ? 'blocked' : 'done';
      else w.status = type;
      return;
    }
    if (w.pending > 0) {
      w.deferred.push(e); // tunggu manajer selesai menyerahkan tugas ke worker ini
      return;
    }
    const queued = this.scheduled.filter((s) => s.worker === w.name);
    if (queued.length) {
      // Masih ada event tertunda yang sedang diputar: jaga urutannya.
      const last = Math.max(...queued.map((s) => s.at));
      this.scheduled.push({ at: last + TUNING.deferredGap, worker: w.name, event: e });
      return;
    }
    this.#workerEvent(w, e);
  }

  #workerEvent(w, e) {
    const { type, message } = e;
    const project = projectOf(e);
    switch (type) {
      case 'working':
        w.status = 'working';
        if (message) w.bubble = this.#bubble(message, 'working', 2.4, project);
        break;
      case 'done':
        w.status = 'done';
        w.bubble = this.#bubble(message || t('office.bubble.done'), 'done', 4.5, project);
        this.#workerEnvelope(w, 'done');
        break;
      case 'blocked':
        w.status = 'blocked';
        w.bubble = this.#bubble(message || t('office.bubble.blocked'), 'blocked', 5.5, project);
        this.#workerEnvelope(w, 'blocked');
        break;
      case 'report':
        if (w.status !== 'blocked') w.status = 'done';
        w.bubble = this.#bubble(message || t('office.bubble.report'), w.status === 'blocked' ? 'blocked' : 'report', 4.5, project);
        this.#workerEnvelope(w, w.status === 'blocked' ? 'blocked' : 'report');
        break;
      default:
        break;
    }
  }

  #workerEnvelope(w, kind) {
    if (this.time - w.lastEnvelopeAt < TUNING.envelopeDedupe) return;
    w.lastEnvelopeAt = this.time;
    w.sendUntil = this.time + TUNING.sendPose;
    this.#envelope({ x: w.seat.x, y: w.seat.y - 14 }, MANAGER_SPOT.inbox, kind, () => {
      this.inbox++;
      this.popups.push({ x: MANAGER_SPOT.inbox.x, y: MANAGER_SPOT.inbox.y - 6, text: '+1', born: this.time, until: this.time + 1.2 });
    });
  }

  #managerToCeo(message, kind, project = null) {
    const m = this.manager;
    m.bubble = this.#bubble(message || t('office.bubble.reportCeo'), kind === 'blocked' ? 'blocked' : 'report', 4.5, project);
    this.#envelope({ x: m.x, y: m.y - 14 }, { x: CEO_ROOM.tray.x, y: CEO_ROOM.tray.y - 8 }, 'ceo', () => {
      this.popups.push({ x: this.ceo.x, y: this.ceo.y - 14, text: t('office.label.ceo'), born: this.time, until: this.time + 1.4 });
      this.ceo.cheerUntil = this.time + 1.3;
      this.ceo.bubble = this.#bubble(t('office.bubble.ceoThanks'), 'ceo', 2.6);
    });
  }

  #envelope(from, to, kind, onArrive) {
    const dist = Math.hypot(to.x - from.x, to.y - from.y);
    this.envelopes.push({
      from: { ...from },
      to: { ...to },
      kind,
      t: 0,
      dur: clamp(dist / 170, 0.8, 1.7),
      arc: 14 + dist * 0.12,
      x: from.x,
      y: from.y,
      onArrive,
    });
    this.stats.envelopesSpawned++;
  }

  // ---------------------------------------------------------------- update

  update(dt) {
    dt = Number.isFinite(dt) ? clamp(dt, 0, 0.1) : 0; // tab yang tertidur tidak membuat lompatan besar; NaN diabaikan
    this.time += dt;
    this.#updateManager(dt);
    this.#updateCeo(dt);
    this.#updateEnvelopes(dt);
    this.#updateIdleLife(dt);
    const rainGoal = this.rainOn ? 1 : 0;
    const rainStep = TUNING.rainFade * dt; // fade linear: penuh dalam ±1,4 detik
    this.rainLevel += Math.max(-rainStep, Math.min(rainStep, rainGoal - this.rainLevel));

    const due = this.scheduled.filter((s) => s.at <= this.time);
    if (due.length) {
      this.scheduled = this.scheduled.filter((s) => s.at > this.time);
      for (const s of due) {
        const w = this.workers.get(s.worker);
        if (w) this.#workerEvent(w, s.event);
      }
    }

    const expired = (b) => b && b.until <= this.time;
    if (expired(this.manager.bubble)) this.manager.bubble = null;
    if (expired(this.ceo.bubble)) this.ceo.bubble = null;
    for (const w of this.workers.values()) if (expired(w.bubble)) w.bubble = null;
    this.popups = this.popups.filter((p) => p.until > this.time);
  }

  // ---------------------------------------------------------------- hidup di kantor (hanya agen idle)

  /** Agen yang benar-benar idle: tanpa tugas, event tertunda, atau antrean manajer. */
  #isCalm(w) {
    return (
      w.mode === 'seat' &&
      w.status === 'idle' &&
      w.pending === 0 &&
      !w.deferred.length &&
      (!w.bubble || w.bubble.ambient) && // frasa kepribadian tidak menghalangi jadwal pantry
      !this.queue.some((j) => j.to === w.name) &&
      !this.scheduled.some((s) => s.worker === w.name)
    );
  }

  #snapToSeat(w) {
    if (w.mode === 'seat') return;
    w.mode = 'seat';
    w.x = w.seat.x;
    w.y = w.seat.y;
    w.facing = 'down';
    w.path = [];
    w.speed = 0;
    w.slot = null;
    w.recalled = false;
  }

  /** Event atau tugas untuk worker: segera kembali ke meja (animasi hanya mengikuti event nyata). */
  #recall(w) {
    if (w.mode === 'seat') return;
    if (this.reducedMotion) return this.#snapToSeat(w);
    if (w.mode === 'out' && w.rise > 0) return this.#snapToSeat(w); // baru bangun: duduk lagi
    w.slot = null;
    w.recalled = true;
    this.#sendBack(w);
  }

  #sendBack(w) {
    const back = findPath(this.grid, { x: w.x, y: w.y }, w.exit) ?? [{ ...w.exit }];
    w.path = [...back, { ...w.seat }];
    w.mode = 'back';
    w.speed = 0;
    w.stage = '';
  }

  #startTrip(w) {
    const taken = new Set([...this.workers.values()].map((o) => o.slot).filter(Boolean));
    const slot = PANTRY.slots.find((s) => !taken.has(s));
    if (!slot) return false;
    const walk = findPath(this.grid, w.exit, slot);
    if (!walk) return false;
    w.slot = slot;
    w.path = [{ ...w.exit }, ...walk];
    w.mode = 'out';
    w.rise = TUNING.rise;
    w.speed = 0;
    w.recalled = false;
    return true;
  }

  #updateIdleLife(dt) {
    const reduced = this.reducedMotion;
    const away = [...this.workers.values()].filter((w) => w.mode !== 'seat');
    if (!reduced) {
      this.pantryTimer -= dt;
      if (this.pantryTimer <= 0) {
        const gap = this.#range(TUNING.pantryGap);
        this.pantryTimer = this.sleepy > 0 ? gap * (1 - TUNING.sleepyGapCut * this.sleepy) : gap; // ngantuk: lebih sering ngopi
        // hanya yang kebiasaan idle-nya berjalan ke pantry (kopi, air, camilan, tanaman, ngobrol); netral = kopi.
        // Saat ngantuk semua agen idle butuh kopi.
        const calm = [...this.workers.values()].filter((w) => this.#isCalm(w) && !w.dynamic && (this.sleepy > 0 || idleBehavior(this.personality(w.name).idle).trip));
        if (calm.length && away.length < TUNING.maxAway) this.#startTrip(calm[Math.floor(this.rng() * calm.length)]);
      }
    }
    this.#updatePhrases(dt);
    this.#updateSleepy(dt);
    for (const w of away) {
      if (w.mode === 'out' || w.mode === 'back') {
        if (w.mode === 'out' && w.rise > 0) {
          w.rise -= dt;
          continue;
        }
        const target = w.recalled ? TUNING.workerRush : TUNING.workerSpeed;
        w.speed = nextSpeed({
          speed: Math.max(w.speed, 0),
          target,
          remaining: remainingLength(w, w.path),
          dt,
          accel: TUNING.accel,
          decel: TUNING.decel,
          minSpeed: TUNING.minSpeed,
        });
        const step = advanceAlongPath(w, w.path, w.speed * dt);
        w.x = step.x;
        w.y = step.y;
        w.path = step.path;
        w.walkDist += step.moved;
        if (step.facing) w.facing = step.facing;
        if (!w.path.length) {
          w.speed = 0;
          if (w.mode === 'out') {
            w.mode = 'pantry';
            w.stage = 'make';
            w.timer = TUNING.makeCoffee;
            w.facing = 'up';
          } else this.#snapToSeat(w);
        }
      } else if (w.mode === 'pantry') {
        w.timer -= dt;
        if (w.timer <= 0) {
          if (w.stage === 'make') {
            w.stage = 'drink';
            w.timer = this.#range(TUNING.drinkFor);
            w.facing = 'down';
            w.bubble = this.#bubble(t('office.chat.sip'), 'chat', 1.8);
          } else {
            this.#sendBack(w);
          }
        }
      }
    }
    // dua agen ngopi bersamaan: mengobrol bergantian
    const drinking = away.filter((w) => w.mode === 'pantry' && w.stage === 'drink');
    if (drinking.length >= 2) {
      this.chatTimer -= dt;
      if (this.chatTimer <= 0) {
        this.chatTimer = TUNING.chatEvery;
        const speaker = drinking[Math.floor(this.rng() * drinking.length)];
        const n = 1 + Math.floor(this.rng() * CHAT_LINES);
        if (!speaker.bubble) speaker.bubble = this.#bubble(t(`office.chat.${n}`), 'chat', 2.2);
      }
    }
  }

  #updateSleepy(dt) {
    if (!(this.sleepy > 0)) return;
    const next = () => (TUNING.sleepyEvery[0] + this.srng() * (TUNING.sleepyEvery[1] - TUNING.sleepyEvery[0])) / this.sleepy;
    this.sleepyIn ??= next();
    this.sleepyIn -= dt;
    if (this.sleepyIn > 0) return;
    this.sleepyIn = next();
    const calm = [...this.workers.values()].filter((w) => this.#isCalm(w) && !w.bubble && !w.dynamic);
    if (!calm.length) return;
    const w = calm[Math.floor(this.srng() * calm.length)];
    const n = 1 + Math.floor(this.srng() * SLEEPY_LINES);
    w.bubble = this.#bubble(t(`office.sleepy.${n}`), 'chat', 2.4);
    if (w.bubble) w.bubble.ambient = true;
  }

  #prange([a, b]) {
    return a + this.prng() * (b - a);
  }

  /**
   * Frasa kepribadian di bubble saat idle atau bekerja (sesekali). Hanya teks: tidak mengubah status, antrean,
   * atau event. Tanpa frasa/tone (netral) tidak ada bubble.
   */
  #tickPhrase(e, id, can, dt) {
    if (e.phraseIn === null || e.phraseIn === undefined) e.phraseIn = this.#prange(TUNING.phraseFirst);
    e.phraseIn -= dt;
    if (e.phraseIn > 0) return;
    e.phraseIn = this.#prange(TUNING.phraseEvery);
    if (!can) return;
    const lines = speechLines(this.personality(id), getLang());
    if (!lines.length) return;
    const text = lines[Math.min(lines.length - 1, Math.floor(this.prng() * lines.length))];
    e.bubble = this.#bubble(text, 'chat', TUNING.phraseFor);
    if (e.bubble) e.bubble.ambient = true;
  }

  #updatePhrases(dt) {
    for (const w of this.workers.values()) {
      const can =
        w.mode === 'seat' &&
        (w.status === 'idle' || w.status === 'working') &&
        !w.bubble &&
        w.pending === 0 &&
        !w.deferred.length &&
        !this.queue.length &&
        !this.scheduled.some((s) => s.worker === w.name);
      this.#tickPhrase(w, w.name, can && !w.dynamic, dt);
    }
    const m = this.manager;
    this.#tickPhrase(m, MANAGER_ID, m.state === 'sitting' && !m.bubble && !this.limitWarning && !this.queue.length && m.typingUntil <= this.time, dt);
    const c = this.ceo;
    this.#tickPhrase(c, CEO_ID, !c.bubble && this.time >= c.giveUntil && this.time >= c.cheerUntil && !this.envelopes.length, dt);
  }

  // ---------------------------------------------------------------- CEO

  #crange([a, b]) {
    return a + this.crng() * (b - a);
  }

  #ceoSnapHome() {
    const c = this.ceo;
    c.state = 'sitting';
    c.goal = null;
    c.x = CEO_ROOM.seat.x;
    c.y = CEO_ROOM.seat.y;
    c.facing = 'down';
    c.path = [];
    c.speed = 0;
  }

  /** Antar semua perintah yang menunggu: amplop terbang dari tangan CEO ke baki manajer. */
  #ceoDeliver() {
    const c = this.ceo;
    const jobs = c.errands;
    c.errands = [];
    c.giveUntil = this.time + TUNING.ceoGive;
    for (const { message, project } of jobs) {
      this.#envelope({ x: c.x, y: c.y - 14 }, { x: MANAGER_SPOT.seat.x, y: MANAGER_SPOT.seat.y - 12 }, 'command', () => {
        this.manager.bubble = this.#bubble(message || t('office.bubble.newCommand'), 'command', 4, project);
      });
    }
  }

  /** Mulai berjalan ke tujuan: 'errand' (manajer, atau ruang rapat bila manajer sedang pergi), 'coffee', 'window', atau 'home'. */
  #ceoGo(goal) {
    const c = this.ceo;
    const exit = CEO_ROOM.exit;
    const target = {
      errand: this.manager.state === 'sitting' ? CEO_VISIT.manager : CEO_VISIT.meeting,
      coffee: CEO_ROOM.coffee,
      window: CEO_ROOM.window,
      home: exit,
    }[goal];
    const atSeat = Math.hypot(c.x - CEO_ROOM.seat.x, c.y - CEO_ROOM.seat.y) < 2;
    const from = atSeat ? exit : { x: c.x, y: c.y };
    const walk = findPath(this.grid, from, target) ?? [{ ...target }];
    c.path = [...(atSeat ? [{ ...exit }] : []), ...walk];
    if (goal === 'home') c.path.push({ ...CEO_ROOM.seat });
    c.goal = goal;
    c.state = 'walking';
    c.speed = 0;
  }

  #updateCeo(dt) {
    const c = this.ceo;
    if (this.reducedMotion) {
      // tanpa jalan-jalan: perintah langsung diantar dari meja (amplop terbang dan teks tetap jelas)
      if (c.state !== 'sitting') this.#ceoSnapHome();
      if (c.errands.length) this.#ceoDeliver();
      return;
    }
    if (c.errands.length && c.state !== 'sitting' && c.state !== 'rising' && c.goal !== 'errand') {
      this.#ceoGo('errand'); // ada tugas masuk: batalkan kopi/jendela/kembali, langsung mengantar
    }
    switch (c.state) {
      case 'sitting': {
        if (c.errands.length) {
          c.state = 'rising';
          c.goal = 'errand';
          c.timer = TUNING.ceoRise;
          break;
        }
        c.idleIn ??= this.#crange(TUNING.ceoIdleFirst);
        c.idleIn -= dt;
        if (c.idleIn > 0) break;
        const calm = this.time >= c.giveUntil && this.time >= c.cheerUntil && (!c.bubble || c.bubble.ambient) && !this.envelopes.length;
        if (!calm) {
          c.idleIn = 3;
          break;
        }
        c.idleIn = this.#crange(TUNING.ceoIdleEvery);
        c.state = 'rising';
        c.goal = this.crng() < 0.55 ? 'coffee' : 'window';
        c.timer = TUNING.ceoRise;
        break;
      }
      case 'rising':
        c.timer -= dt;
        if (c.timer <= 0) this.#ceoGo(c.goal);
        break;
      case 'walking': {
        const target = c.goal === 'errand' ? TUNING.ceoRush : TUNING.ceoWalk;
        c.speed = nextSpeed({
          speed: Math.max(c.speed, 0),
          target,
          remaining: remainingLength(c, c.path),
          dt,
          accel: TUNING.accel,
          decel: TUNING.decel,
          minSpeed: TUNING.minSpeed,
        });
        const step = advanceAlongPath(c, c.path, c.speed * dt);
        c.x = step.x;
        c.y = step.y;
        c.path = step.path;
        c.walkDist += step.moved;
        if (step.facing) c.facing = step.facing;
        if (c.path.length) break;
        c.speed = 0;
        if (c.goal === 'home') {
          this.#ceoSnapHome();
          break;
        }
        c.state = 'doing';
        c.facing = 'up';
        if (c.goal === 'errand') {
          c.timer = TUNING.ceoGive;
          this.#ceoDeliver();
        } else c.timer = this.#crange(c.goal === 'coffee' ? TUNING.ceoCoffee : TUNING.ceoWindow);
        break;
      }
      case 'doing':
        c.timer -= dt;
        if (c.goal === 'errand' && c.errands.length) {
          this.#ceoDeliver();
          c.timer = TUNING.ceoGive;
        }
        if (c.timer <= 0) this.#ceoGo('home');
        break;
      default:
        break;
    }
  }

  #walkTo(target) {
    const m = this.manager;
    m.path = findPath(this.grid, { x: m.x, y: m.y }, target) ?? [{ ...target }];
    if (m.state !== 'walking') m.speed = 0; // ganti tujuan saat berjalan: kecepatan dipertahankan
    m.state = 'walking';
  }

  #startNextJob() {
    const m = this.manager;
    m.job = this.queue.shift();
    const w = this.workers.get(m.job.to);
    this.stats.trips++;
    this.#walkTo(w.front);
  }

  #deliver(job) {
    const w = this.workers.get(job.to);
    if (!w) return;
    w.pending = Math.max(0, w.pending - 1);
    w.status = 'working';
    if (job.project) w.project = job.project;
    w.bubble = this.#bubble(t('office.bubble.ready'), 'working', 1.2, job.project);
    this.stats.deliveries++;
    if (w.pending === 0 && w.deferred.length) {
      w.deferred.forEach((event, i) => {
        this.scheduled.push({ at: this.time + TUNING.deferredGap * (i + 1), worker: w.name, event });
      });
      w.deferred = [];
    }
  }

  #updateManager(dt) {
    const m = this.manager;
    switch (m.state) {
      case 'sitting':
        if (this.queue.length) {
          m.state = 'standing';
          m.timer = TUNING.standUp;
        }
        break;
      case 'standing':
        m.timer -= dt;
        if (m.timer <= 0) this.#startNextJob();
        break;
      case 'walking': {
        if (!m.job && this.queue.length) {
          // Sedang kembali ke meja tapi ada tugas baru: langsung berangkat lagi.
          this.#startNextJob();
        }
        const target = this.queue.length >= 2 ? TUNING.rushSpeed : TUNING.walkSpeed;
        // Ease-in di awal, ease-out menjelang tujuan; langkah dibatasi sisa jalur (tidak pernah melompati tujuan).
        m.speed = nextSpeed({
          speed: Math.max(m.speed, 0),
          target,
          remaining: remainingLength(m, m.path),
          dt,
          accel: TUNING.accel,
          decel: TUNING.decel,
          minSpeed: TUNING.minSpeed,
        });
        const step = advanceAlongPath(m, m.path, m.speed * dt);
        m.x = step.x;
        m.y = step.y;
        m.path = step.path;
        m.walkDist += step.moved;
        if (step.facing) m.facing = step.facing;
        if (!m.path.length) {
          m.speed = 0;
          if (m.job) {
            m.state = 'talking';
            m.facing = 'up';
            const rush = this.queue.length >= 2 ? 0.75 : 1;
            m.timer = clamp(1.2 + m.job.message.length * 0.02, 1.5, 2.6) * rush;
            m.bubble = this.#bubble(m.job.message || t('office.bubble.assignTo', { to: m.job.to }), 'assign', m.timer + 0.2, m.job.project);
          } else {
            m.state = 'sitting';
            m.facing = 'down';
          }
        }
        break;
      }
      case 'talking':
        m.timer -= dt;
        if (m.timer <= 0) {
          this.#deliver(m.job);
          m.job = null;
          if (this.queue.length) this.#startNextJob();
          else this.#walkTo(MANAGER_SPOT.seat);
        }
        break;
      default:
        break;
    }
  }

  #updateEnvelopes(dt) {
    const arrived = [];
    for (const env of this.envelopes) {
      env.t = Math.min(1, env.t + dt / env.dur);
      const k = env.t;
      env.x = env.from.x + (env.to.x - env.from.x) * k;
      env.y = env.from.y + (env.to.y - env.from.y) * k - (this.reducedMotion ? 0 : Math.sin(Math.PI * k) * env.arc);
      if (env.t >= 1) arrived.push(env);
    }
    if (arrived.length) {
      this.envelopes = this.envelopes.filter((e) => e.t < 1);
      for (const env of arrived) {
        this.stats.envelopesArrived++;
        env.onArrive?.();
      }
    }
  }

  // ---------------------------------------------------------------- query

  /** Nama worker di titik logis (x, y), atau null. */
  hitTest(x, y) {
    for (const w of this.workers.values()) {
      const r = w.hit;
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return w.name;
    }
    return null;
  }

  isIdle() {
    return (
      this.manager.state === 'sitting' &&
      !this.ceo.errands.length &&
      this.ceo.goal !== 'errand' &&
      !this.queue.length &&
      !this.envelopes.length &&
      !this.scheduled.length
    );
  }

  /** Ringkasan state yang aman di-serialisasi (debug & test). */
  snapshot() {
    const m = this.manager;
    return {
      time: Number(this.time.toFixed(2)),
      manager: {
        x: Math.round(m.x),
        y: Math.round(m.y),
        state: m.state,
        facing: m.facing,
        job: m.job?.to ?? null,
        bubble: m.bubble?.text ?? null,
        shownBubble: this.managerBubble()?.text ?? null,
        limitWarning: this.limitWarning,
      },
      workers: Object.fromEntries(
        [...this.workers.values()].map((w) => [
          w.name,
          { status: w.status, bubble: w.bubble?.text ?? null, project: w.project ?? null, pending: w.pending, dynamic: w.dynamic, mode: w.mode },
        ]),
      ),
      queue: this.queue.length,
      envelopes: this.envelopes.map((e) => ({ kind: e.kind, t: Number(e.t.toFixed(2)) })),
      inbox: this.inbox,
      stats: { ...this.stats },
    };
  }
}
