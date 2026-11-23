import { useEffect, useState } from 'react';
import { phaseAt, watchPhase } from '../office/daycycle.js';

/**
 * Fase hari dari jam lokal browser, diperiksa sekali per menit (bukan per frame) dan saat tab kembali terlihat.
 * Render ulang hanya saat fase berganti. `enabled` false = pengamat berhenti (mode Mati/Manual). `clock` bisa disuntik.
 */
export function useAutoPhase(enabled, clock = Date.now) {
  const [phase, setPhase] = useState(() => phaseAt(clock()));
  useEffect(() => {
    if (!enabled) return undefined;
    const watcher = watchPhase({ clock, onChange: setPhase });
    const onVisible = () => {
      if (!document.hidden) watcher.check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      watcher.stop();
    };
  }, [enabled, clock]);
  return phase;
}
