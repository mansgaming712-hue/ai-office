import { useEffect, useRef } from 'react';
import { frameDelta } from '../motion.js';
import { COMPACT_QUERY, FRAME_PAD, FRAME_PAD_COMPACT, fitCanvas } from '../office/fit.js';
import { H, W } from '../office/layout.js';
import { createRenderer } from '../office/render.js';

/**
 * Canvas kantor: loop animasi berbasis delta time + klik worker untuk mengisi kotak perintah.
 * `overlay` menutupi kanvas persis (loading); `children` dirender di area kanvas, di luar bingkai (kartu kosong).
 */
export default function OfficeCanvas({
  office,
  onSelectWorker,
  limitWarning = false,
  theme = 'dark',
  reducedMotion = false,
  overlay = null,
  children,
}) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const selectRef = useRef(onSelectWorker);
  selectRef.current = onSelectWorker;
  const themeRef = useRef(theme);
  themeRef.current = theme;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const renderer = createRenderer(canvas, { theme: themeRef.current });
    rendererRef.current = renderer;
    document.fonts?.load('8px "VT323"').catch(() => {});

    const fit = () => {
      const rect = wrap.getBoundingClientRect();
      const compact = window.matchMedia?.(COMPACT_QUERY).matches ?? false;
      const pad = compact ? FRAME_PAD_COMPACT : FRAME_PAD;
      const dpr = window.devicePixelRatio || 1;
      // Satu kolom: tinggi mengikuti lebar (tidak membatasi). Dua kolom: muat di tinggi yang tersedia.
      const { cssW, cssH } = fitCanvas({
        availW: rect.width - pad,
        availH: compact ? Infinity : rect.height - pad,
        dpr,
      });
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    window.addEventListener('resize', fit);
    fit();

    // Gerak berbasis waktu: setiap frame memakai selisih waktu nyata (dibatasi), bukan jumlah frame.
    // Saat tab kembali aktif, penanda waktu direset supaya tidak ada langkah besar yang menumpuk.
    let raf = 0;
    let last = performance.now();
    const frame = (now) => {
      office.update(frameDelta(now, last));
      last = now;
      renderer.draw(office);
      raf = requestAnimationFrame(frame);
    };
    const onVisible = () => {
      if (!document.hidden) last = performance.now();
    };
    document.addEventListener('visibilitychange', onVisible);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('resize', fit);
      ro.disconnect();
      rendererRef.current = null;
    };
  }, [office]);

  useEffect(() => {
    rendererRef.current?.setTheme(theme);
  }, [theme]);

  useEffect(() => {
    office.setReducedMotion(reducedMotion);
  }, [office, reducedMotion]);

  const onClick = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const name = office.hitTest(x, y);
    if (name) selectRef.current?.(name);
  };

  return (
    <div className="office-wrap" ref={wrapRef} style={{ '--office-ratio': `${W} / ${H}` }}>
      <div className="office-frame">
        <canvas
          ref={canvasRef}
          className="office-canvas"
          role="img"
          aria-label={`Denah kantor AI Office: meja manajer di depan, meja worker per divisi termasuk Divisi 3D. Status tiap agen (idle, bekerja, selesai, error) juga tersedia di panel samping.${limitWarning ? ' Peringatan di manajer: limit hampir habis, hemat mode.' : ''}`}
          onClick={onClick}
        />
        {overlay}
      </div>
      {children}
    </div>
  );
}
