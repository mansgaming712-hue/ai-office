// Daftar tema kantor. Tema dimuat saat build lewat import.meta.glob (eager), jadi ikut ke bundel statis dan tidak
// butuh server. Tema yang tidak valid dilewati: peringatan di konsol, dan daftar `problems` ditampilkan di panel pengaturan.
import { loadThemes } from '../../shared/themes.js';

export const DEFAULT_THEME_ID = 'jakarta';

/**
 * @param {Record<string, unknown>} modules  { '/themes/<id>/theme.json': json }
 * @param {{warn?: (msg: string) => void}} [opts]
 */
export function createRegistry(modules, { warn = (m) => console.warn(m) } = {}) {
  const { themes, problems } = loadThemes(modules, { defaultId: DEFAULT_THEME_ID });
  for (const p of problems) warn(`[tema kantor] ${p.file} dilewati: ${p.errors.join('; ')}`);
  const byId = new Map(themes.map((t) => [t.id, t]));
  const defaultTheme = byId.get(DEFAULT_THEME_ID);
  if (!defaultTheme) throw new Error(`Tema bawaan "${DEFAULT_THEME_ID}" hilang atau tidak valid`);
  return {
    themes,
    problems,
    defaultTheme,
    has: (id) => byId.has(id),
    /** Tema menurut id; id tidak dikenal (mis. tema dihapus) jatuh ke tema bawaan. */
    get: (id) => byId.get(id) ?? defaultTheme,
  };
}

export const registry = createRegistry(import.meta.glob('/themes/*/theme.json', { query: '?raw', import: 'default', eager: true }));
