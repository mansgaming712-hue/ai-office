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
  const toLight = theme === 'dark';
  const label = toLight ? 'Terang' : 'Gelap';
  return (
    <button
      type="button"
      className="btn btn-theme"
      onClick={onToggle}
      aria-label={`Ganti ke tema ${label.toLowerCase()}. Sekarang tema ${toLight ? 'gelap' : 'terang'}.`}
      title={`Ganti ke tema ${label.toLowerCase()}`}
    >
      <PixelIcon rows={toLight ? SUN : MOON} />
      <span>{label}</span>
    </button>
  );
}
