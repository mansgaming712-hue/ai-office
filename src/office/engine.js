// Mesin animasi AI Office: logika murni tanpa DOM, sehingga bisa dites di Node.
// Event (lihat shared/events.js) diterjemahkan menjadi gerakan manajer, status worker, bubble, dan amplop.
import { AGENT_NAMES, CEO_ID, MANAGER_ID } from '../../shared/roster.js';
import {
  CELL, DOOR, H, MANAGER_SPOT, W, obstacles, otherSeat, rosterSeats,
} from './layout.js';
import { createGrid, findPath } from './pathfinding.js';
import { STATUS_LABEL as UI_LABEL, uiStatusOf } from '../agentStatus.js';
import { advanceAlongPath, nextSpeed, remainingLength } from '../motion.js';
import { projectOf } from '../sessions.js';
import { WARNING_TEXT } from '../usage.js';

// Label per status internal engine (idle/working/done/blocked), memakai model status UI
// (idle/bekerja/selesai/error) dari src/agentStatus.js.
export const STATUS_LABEL = Object.fromEntries(
  ['idle', 'working', 'done', 'blocked'].map((k) => [k, UI_LABEL[uiStatusOf(k)]]),
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
};

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const HAIR = ['#2b1d14', '#5a3a22', '#1c1c24', '#8a5a2b', '#c9a36b', '#6b2f2f', '#3a3f58'];
const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#9c6a48', '#f6d7bd'];

export class Office {
  constructor() {
    this.seats = rosterSeats();
    this.reset();
  }

  reset() {
    this.time = 0;
    this.reducedMotion = this.reducedMotion ?? false;
    this.workers = new Map();
    this.otherCount = 0;
    for (const name of AGENT_NAMES) this.#addWorker(name, this.seats.get(name), false);
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

  #addWorker(name, station, dynamic) {
    const h = hash(name);
    const office = this;
    let status = 'idle';
    this.workers.set(name, {
      name,
      division: station.division,
      seat: station.seat,
      desk: station.desk,
      front: station.front,
      hit: station.hit,
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
      hair: HAIR[h % HAIR.length],
      skin: SKIN[(h >>> 8) % SKIN.length],
    });
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
    return { text: WARNING_TEXT, kind: 'warning', born, until: Infinity, sticky: true };
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
          this.#envelope(DOOR.enter, { x: MANAGER_SPOT.seat.x, y: MANAGER_SPOT.seat.y - 12 }, 'command', () => {
            this.manager.bubble = this.#bubble(message || 'Perintah baru dari CEO', 'command', 4, project);
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
        return;
      }
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
        w.bubble = this.#bubble(message || 'Tugas selesai!', 'done', 4.5, project);
        this.#workerEnvelope(w, 'done');
        break;
      case 'blocked':
        w.status = 'blocked';
        w.bubble = this.#bubble(message || 'Butuh bantuan!', 'blocked', 5.5, project);
        this.#workerEnvelope(w, 'blocked');
        break;
      case 'report':
        if (w.status !== 'blocked') w.status = 'done';
        w.bubble = this.#bubble(message || 'Laporan terkirim', w.status === 'blocked' ? 'blocked' : 'report', 4.5, project);
        this.#workerEnvelope(w, w.status === 'blocked' ? 'blocked' : 'report');
        break;
      default:
        break;
    }
  }

  #workerEnvelope(w, kind) {
    if (this.time - w.lastEnvelopeAt < TUNING.envelopeDedupe) return;
    w.lastEnvelopeAt = this.time;
    this.#envelope({ x: w.seat.x, y: w.seat.y - 14 }, MANAGER_SPOT.inbox, kind, () => {
      this.inbox++;
      this.popups.push({ x: MANAGER_SPOT.inbox.x, y: MANAGER_SPOT.inbox.y - 6, text: '+1', born: this.time, until: this.time + 1.2 });
    });
  }

  #managerToCeo(message, kind, project = null) {
    const m = this.manager;
    m.bubble = this.#bubble(message || 'Laporan untuk CEO', kind === 'blocked' ? 'blocked' : 'report', 4.5, project);
    this.#envelope({ x: m.x, y: m.y - 14 }, DOOR.enter, 'ceo', () => {
      this.popups.push({ x: DOOR.enter.x, y: DOOR.enter.y - 14, text: 'CEO', born: this.time, until: this.time + 1.4 });
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
    for (const w of this.workers.values()) if (expired(w.bubble)) w.bubble = null;
    this.popups = this.popups.filter((p) => p.until > this.time);
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
    w.bubble = this.#bubble('Siap!', 'working', 1.2, job.project);
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
            m.bubble = this.#bubble(m.job.message || `Tugas untuk ${m.job.to}`, 'assign', m.timer + 0.2, m.job.project);
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
          { status: w.status, bubble: w.bubble?.text ?? null, project: w.project ?? null, pending: w.pending, dynamic: w.dynamic },
        ]),
      ),
      queue: this.queue.length,
      envelopes: this.envelopes.map((e) => ({ kind: e.kind, t: Number(e.t.toFixed(2)) })),
      inbox: this.inbox,
      stats: { ...this.stats },
    };
  }
}
