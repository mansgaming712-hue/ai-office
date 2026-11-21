import { t, useLang } from '../i18n.js';

const SUN = [
  '....#....',
  '.#..#..#.',
  '..#####..',
  '..#####..',
  '#.#####.#',
  '..#####..',
  '..#####..',
  '.#..#..#.',
  '....#....',
];
const MOON = [
  '...####..',
  '..###....',
  '.###.....',
  '.###.....',
  '.###.....',
  '.###.....',
  '..###..#.',
  '...######',
  '.....###.',
];

function PixelIcon({ rows }) {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  return (
    <svg className="theme-icon" width="18" height="18" viewBox="0 0 9 9" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/** Tombol ganti tema. Teks menyebut tema tujuan; bisa dipakai dengan keyboard (Enter/Spasi). */
export default function ThemeToggle({ theme, onToggle }) {
  useLang();
  const toLight = theme === 'dark';
  const label = t(toLight ? 'ui.theme.light' : 'ui.theme.dark');
  const current = t(toLight ? 'ui.theme.dark' : 'ui.theme.light');
  return (
    <button
      type="button"
      className="btn btn-theme"
      onClick={onToggle}
      aria-label={t('ui.theme.switch', { target: label.toLowerCase(), current: current.toLowerCase() })}
      title={t('ui.theme.switchTitle', { target: label.toLowerCase() })}
    >
      <PixelIcon rows={toLight ? SUN : MOON} />
      <span>{label}</span>
    </button>
  );
}
