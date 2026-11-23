// QA Fase 4b: fuzz acak banjir perintah + toggle reduced motion + reset di tengah.
// Invarian: tidak ada antrean tersembunyi (reaksi manajer tetap t=0 + 1,235 dtk), tidak ada state macet:
// setelah event berhenti, CEO selalu akhirnya duduk, tidak ada amplop tersisa, dan isIdle() true.
import { describe, expect, it } from 'vitest';
import { normalizeEvent } from '../shared/events.js';
import { Office, TUNING } from '../src/office/engine.js';
import { CEO_ROOM } from '../src/office/layout.js';

const DT = 1 / 60;
const cmd = (m) => normalizeEvent({ type: 'assign', from: 'ceo', to: 'manager', message: m }).event;
const task = (to, m) => normalizeEvent({ type: 'assign', from: 'manager', to, message: m }).event;
const lcg = (s) => () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);

describe('fuzz perintah CEO (acak, deterministik)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    it(`seed ${seed}: akhirnya CEO duduk di meja, idle, tanpa amplop tersisa`, () => {
      const r = lcg(seed);
      const o = new Office({ seed });
      let pendingCmds = 0;
      let arrived = 0;
      for (let i = 0; i < 60 * 40; i++) {
        const x = r();
        if (x < 0.04) {
          o.handleEvent(cmd(`c${i}`));
          pendingCmds++;
        } else if (x < 0.05) o.handleEvent(task(['dev-frontend', 'dev-backend', 'dev-qa'][Math.floor(r() * 3)], `t${i}`));
        else if (x < 0.055) o.setReducedMotion(r() < 0.5);
        else if (x < 0.0565) {
          o.reset();
          pendingCmds = 0;
        }
        const before = o.manager.bubble;
        o.update(DT);
        if (o.manager.bubble !== before && o.manager.bubble?.kind === 'command') arrived++;
        expect(o.envelopes.length).toBeLessThanOrEqual(60 * 4); // tidak tumbuh tak terbatas
      }
      for (let i = 0; i < 60 * 120 && !(o.isIdle() && o.ceo.state === 'sitting'); i++) o.update(DT);
      expect(o.isIdle()).toBe(true);
      expect(o.envelopes).toHaveLength(0);
      expect(o.ceo.state).toBe('sitting');
      expect(o.ceo.x).toBeCloseTo(CEO_ROOM.seat.x, 0);
      expect(o.ceo.y).toBeCloseTo(CEO_ROOM.seat.y, 0);
      expect(o.queue).toHaveLength(0);
      expect(arrived).toBeLessThanOrEqual(pendingCmds + 400);
    });
  }

  it('reset di tengah perjalanan CEO: CEO kembali duduk dan perintah baru tetap bereaksi t=0', () => {
    const o = new Office({ seed: 7 });
    o.handleEvent(cmd('a'));
    for (let i = 0; i < 90; i++) o.update(DT);
    expect(['rising', 'walking']).toContain(o.ceo.state);
    o.reset();
    expect(o.ceo.state).toBe('sitting');
    const n = o.stats.envelopesSpawned;
    o.handleEvent(cmd('b'));
    expect(o.stats.envelopesSpawned).toBe(n + 1);
    expect(o.envelopes.at(-1).dur).toBe(TUNING.commandFlight);
    let at = null;
    for (let i = 0; i < 60 * 5 && at === null; i++) {
      o.update(DT);
      if (o.manager.bubble?.kind === 'command') at = o.time;
    }
    expect(at).toBeGreaterThan(TUNING.commandFlight - DT);
    expect(at).toBeLessThan(TUNING.commandFlight + 2 * DT);
  });
});
