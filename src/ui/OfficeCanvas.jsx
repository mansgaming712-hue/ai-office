import { useEffect, useRef, useState } from 'react';
import { t, useLang } from '../i18n.js';
import { frameDelta } from '../motion.js';
import { COMPACT_QUERY, FRAME_PAD, FRAME_PAD_COMPACT, fitCanvas } from '../office/fit.js';
import { H, W } from '../office/layout.js';
import { createRenderer } from '../office/render.js';

const RAIN_KEY = 'ai-office-rain';

function readRain() {
  try {
    return window.localStorage.getItem(RAIN_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Canvas kantor: loop animasi berbasis delta time + klik worker untuk mengisi kotak perintah.
 * `overlay` menutupi kanvas persis (loading); `children` dirender di area kanvas, di luar bingkai (kartu kosong).
 * Tombol kecil di pojok kanvas menyalakan hujan di jendela (dekoratif, tersimpan; mati saat reduced motion).
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
  useLang();
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const rendererRef = useRef(null);
  const selectRef = useRef(onSelectWorker);
  selectRef.current = onSelectWorker;
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const [rain, setRain] = useState(readRain);

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

    // Satu requestAnimationFrame. Gerak berbasis waktu: setiap frame memakai selisih waktu nyata (dibatasi),
    // bukan jumlah frame. Tab tersembunyi: loop berhenti total; saat kembali, penanda waktu direset
    // supaya tidak ada langkah besar yang menumpuk.
    let raf = 0;
    let last = performance.now();
    const frame = (now) => {
      raf = 0;
      if (document.hidden) return;
      office.update(frameDelta(now, last));
      last = now;
      renderer.draw(office);
      raf = requestAnimationFrame(frame);
    };
    const start = () => {
      if (raf || document.hidden) return;
      last = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const onVisible = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else start();
    };
    document.addEventListener('visibilitychange', onVisible);
    start();
    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
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

  useEffect(() => {
    office.setRain(rain);
  }, [office, rain]);

  const toggleRain = () => {
    const next = !rain;
    setRain(next);
    try {
      window.localStorage.setItem(RAIN_KEY, next ? '1' : '0');
    } catch {
      // penyimpanan diblokir: pilihan tetap berlaku selama halaman terbuka
    }
  };

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
          aria-label={t('ui.canvas.aria') + (limitWarning ? t('ui.canvas.ariaWarning') : '')}
          onClick={onClick}
        />
        <button
          type="button"
          className="rain-toggle"
          aria-pressed={rain && !reducedMotion}
          aria-label={t('office.rain.label')}
          title={t('office.rain.label')}
          disabled={reducedMotion}
          onClick={toggleRain}
        >
          <svg viewBox="0 0 16 12" width="16" height="12" aria-hidden="true" focusable="false">
            <path className="rain-cloud" d="M3 7h10V5h-1V3H9V2H6v1H5v2H3z" />
            <path className="rain-drops" d="M4 9h1v2H4zM7 9h1v2H7zM10 9h1v2h-1z" />
          </svg>
        </button>
        {overlay}
      </div>
      {children}
    </div>
  );
}
