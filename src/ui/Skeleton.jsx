// Kerangka loading bergaya pixel. Murni dekoratif (aria-hidden); pesan loading ditulis sebagai teks
// terpisah dengan role="status". Animasi berkedip dimatikan saat reduced motion (lihat styles.css).

// Jumlah meja per zona, per baris, mengikuti denah kantor (lebar zona = lebar sebenarnya di layout.js).
const ROWS = [
  [{ w: 304, n: 7 }, { w: 152, n: 3 }],
  [{ w: 152, n: 2 }, { w: 144, n: 1 }, { w: 152, n: 4 }],
  [{ w: 464, n: 5 }],
];

export function OfficeSkeleton() {
  return (
    <div className="skel-office" aria-hidden="true">
      <div className="skel-wall">
        <span className="skel skel-door" />
        <span className="skel skel-mgr" />
      </div>
      {ROWS.map((row, i) => (
        <div className="skel-row" key={i}>
          {row.map((z, j) => (
            <div className="skel-zone" style={{ flexGrow: z.w }} key={j}>
              <span className="skel skel-title" />
              <div className="skel-desks">
                {Array.from({ length: z.n }, (_, k) => (
                  <span className="skel skel-desk" key={k} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function PanelSkeleton({ rows = 6 }) {
  return (
    <div className="skel-panel" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <span className="skel skel-line" key={i} style={{ width: `${92 - ((i * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

/** Tiga kotak pixel yang menyala bergantian (statis saat reduced motion). */
export function PixelSpinner() {
  return (
    <span className="spinner" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  );
}
