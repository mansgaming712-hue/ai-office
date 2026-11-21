// Mesin animasi AI Office: logika murni tanpa DOM, sehingga bisa dites di Node.
// Event (lihat shared/events.js) diterjemahkan menjadi gerakan manajer, status worker, bubble, dan amplop.
import { CEO_ID, MANAGER_ID } from '../../shared/roster.js';
import { agentNames } from '../divisions.js';
import {
  CELL, DOOR, H, MANAGER_SPOT, PANTRY, W, obstacles, otherSeat, rosterSeats,
} from './layout.js';
import { createGrid, findPath } from './pathfinding.js';
import { t } from '../i18n.js';
import { advanceAlongPath, nextSpeed, remainingLength } from '../motion.js';
import { projectOf } from '../sessions.js';

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
};

// Obrolan santai di pantry (hanya agen yang benar-benar idle). Kunci office.chat.1..N di locales.
export const CHAT_LINES = 6;

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

export class Office {
  constructor() {
    this.reset();
  }

  reset() {
    this.seats = rosterSeats();
    this.time = 0;
    this.rng = makeRng(20241121);
    this.pantryTimer = this.#range(TUNING.pantryFirst);
    this.chatTimer = 0;
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
    };
    // CEO berdiri di dekat pintu: memberi perintah (amplop) dan menerima laporan manajer.
    this.ceo = { x: DOOR.enter.x, y: DOOR.enter.y, facing: 'down', bubble: null, giveUntil: -Infinity, cheerUntil: -Infinity };
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
    if (this.reducedMotion) for (const w of this.workers.values()) this.#snapToSeat(w); // tanpa jalan-jalan idle
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
          this.ceo.giveUntil = this.time + 0.9;
          this.#envelope(DOOR.enter, { x: MANAGER_SPOT.seat.x, y: MANAGER_SPOT.seat.y - 12 }, 'command', () => {
            this.manager.bubble = this.#bubble(message || t('office.bubble.newCommand'), 'command', 4, project);
          });
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
    this.#envelope({ x: m.x, y: m.y - 14 }, DOOR.enter, 'ceo', () => {
      this.popups.push({ x: DOOR.enter.x, y: DOOR.enter.y - 14, text: t('office.label.ceo'), born: this.time, until: this.time + 1.4 });
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
      !w.bubble &&
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
        this.pantryTimer = this.#range(TUNING.pantryGap);
        const calm = [...this.workers.values()].filter((w) => this.#isCalm(w) && !w.dynamic);
        if (calm.length && away.length < TUNING.maxAway) this.#startTrip(calm[Math.floor(this.rng() * calm.length)]);
      }
    }
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
