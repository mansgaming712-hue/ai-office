import { useCallback, useEffect, useState } from 'react';
import { prefersReducedMotion, watchReducedMotion } from '../motion.js';
import {
  appliedTheme, applyTheme, initialTheme, otherTheme, readStoredTheme, resolveTheme, storeTheme, systemPrefersDark,
} from '../theme.js';

const storage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Tema aktif. Nilai awal = yang sudah dipasang public/theme-init.js (tanpa kilatan);
 * tanpa pilihan tersimpan, tema ikut berubah mengikuti pengaturan sistem.
 */
export function useTheme() {
  const [theme, setThemeState] = useState(() => appliedTheme(document.documentElement) ?? initialTheme());

  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return undefined;
    const onChange = () => {
      if (readStoredTheme(storage())) return; // pilihan pengguna menang atas pengaturan sistem
      setThemeState(resolveTheme(null, systemPrefersDark()));
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  const toggle = useCallback(() => {
    setThemeState((cur) => {
      const next = otherTheme(cur);
      storeTheme(storage(), next);
      return next;
    });
  }, []);

  return { theme, toggle };
}

/** true bila pengguna meminta gerak dikurangi (ikut berubah saat pengaturan sistem diganti). */
export function useReducedMotion() {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => watchReducedMotion(setReduced), []);
  return reduced;
}
