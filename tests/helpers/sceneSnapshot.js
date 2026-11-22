// Rekam perintah gambar renderer untuk skenario tetap, lalu ringkas jadi hash. Dipakai test "jakarta identik
// dengan renderer lama": fixture tests/fixtures/jakarta-golden.json dibuat dari renderer SEBELUM sistem tema.
import { normalizeEvent } from '../../shared/events.js';
import { Office } from '../../src/office/engine.js';
import { H, W } from '../../src/office/layout.js';
import { drawBackground, drawClock, drawSkyFx, drawSteam } from '../../src/office/scene.js';
import { createRenderer } from '../../src/office/render.js';
import { canvasFactory, recordingCtx, sha } from './recordCanvas.js';

export const FIXED_NOW = Date.UTC(2026, 0, 15, 9, 41, 27);
const ev = (type, from, to, message = 'x') => normalizeEvent({ type, from, to, message }).event;

/** Kantor dengan beberapa kejadian, dimajukan deterministik. */
export function scenarioOffice(steps = 40) {
  const o = new Office();
  o.handleEvent(ev('assign', 'manager', 'dev-qa', 'cek'));
  o.handleEvent(ev('working', 'dev-qa', 'dev-qa'));
  o.handleEvent(ev('blocked', 'dev-backend', 'manager', 'gagal'));
  for (let i = 0; i < steps; i++) o.update(0.05);
  return o;
}

const hashOf = (fn) => {
  const log = [];
  fn(recordingCtx(log));
  return { n: log.length, sha: sha(log) };
};

/**
 * @param {object} api  { palette(variantKey), backdrop(ctx, palette), themeArg(variantKey), skyOpts?, extra? }
 * variantKey: 'light' | 'dark'. Kunci hasil sama untuk renderer lama dan baru.
 */
export function snapshot(api, variantKey) {
  const P = api.palette(variantKey);
  const out = {};
  out.background = hashOf((c) => api.background(c, P));
  out.skyDay = hashOf((c) => drawSkyFx(c, P, 3.7, { rain: 0, reduced: false, ...api.fxOpts }));
  out.skyRain = hashOf((c) => drawSkyFx(c, P, 8.2, { rain: 0.6, reduced: false, ...api.fxOpts }));
  out.skyReduced = hashOf((c) => drawSkyFx(c, P, 5, { rain: 0, reduced: true, ...api.fxOpts }));
  out.clock = hashOf((c) => drawClock(c, P, FIXED_NOW, false));
  out.clockReduced = hashOf((c) => drawClock(c, P, FIXED_NOW, true));
  out.steam = hashOf((c) => drawSteam(c, P, 2.5));

  const saved = globalThis.document;
  const f = canvasFactory();
  globalThis.document = { createElement: () => f.make() };
  try {
    const main = f.make(W * 2, H * 2);
    const r = createRenderer(main, { theme: api.themeArg(variantKey), variant: api.variantArg?.(variantKey) });
    const office = scenarioOffice();
    r.draw(office, FIXED_NOW);
    office.setReducedMotion(true);
    r.draw(office, FIXED_NOW);
    out.frames = { n: f.all.reduce((a, c) => a + c.log.length, 0), sha: sha(f.all.flatMap((c) => c.log)) };
  } finally {
    if (saved === undefined) delete globalThis.document;
    else globalThis.document = saved;
  }
  return out;
}
