import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getState, subscribe } from '../divisions.js';
import { t, useLang } from '../i18n.js';
import { frameDelta } from '../motion.js';
import { COMPACT_QUERY, FRAME_PAD, FRAME_PAD_COMPACT, fitCanvas } from '../office/fit.js';
import { sleepinessOf } from '../office/daycycle.js';
import { BASE_H, H, W } from '../office/layout.js';
import { createRenderer } from '../office/render.js';

/**
 * Canvas kantor: loop animasi berbasis delta time + klik worker untuk mengisi kotak perintah.
 * `overlay` menutupi kanvas persis (loading); `children` dirender di area kanvas, di luar bingkai (kartu kosong).
 * Tema kantor (`officeTheme` = objek dari themeRegistry) dan varian waktu (`variant` 'day'|'night'); tanpa itu, `theme`
 * ('light'|'dark') memilih tema Jakarta siang/malam. Pergantian mereset cache latar renderer.
 * `phase` (Fase 4, 'subuh'|'pagi'|'siang'|'sore'|'malam' atau null = mati) menambah tint, cahaya jendela, lampu, dan
 * perilaku ngantuk worker di atas varian; null = tampilan lama.
 * Tombol kecil di pojok kanvas menyalakan hujan di jendela (dekoratif; pilihan disimpan oleh induk lewat
 * `onToggleRain`; mati saat reduced motion).
 */
export default function OfficeCanvas({
  office,
  onSelectWorker,
  limitWarning = false,
  theme = 'dark',
  officeTheme = null,
  variant = undefined,
  phase = null,
  rain = false,
  onToggleRain = undefined,
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
  const sceneRef = useRef(null);
  sceneRef.current = { arg: officeTheme ?? theme, variant, phase };
  // Roster plugin berubah → tinggi kanvas berubah: render ulang (rasio) dan hitung ulang ukuran.
  const rosterVersion = useSyncExternalStore(subscribe, () => getState().version, () => 0);
  const fitRef = useRef(null);
  const tall = H > BASE_H;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const renderer = createRenderer(canvas, { theme: sceneRef.current.arg, variant: sceneRef.current.variant, phase: sceneRef.current.phase });
    rendererRef.current = renderer;
    document.fonts?.load('8px "VT323"').catch(() => {});

    const fit = () => {
      const rect = wrap.getBoundingClientRect();
      const compact = window.matchMedia?.(COMPACT_QUERY).matches ?? false;
      const pad = compact ? FRAME_PAD_COMPACT : FRAME_PAD;
      const dpr = window.devicePixelRatio || 1;
      // Satu kolom: tinggi mengikuti lebar (tidak membatasi). Dua kolom: muat di tinggi yang tersedia.
      // Kanvas lebih tinggi dari bawaan (divisi plugin): lebar penuh, panggung boleh digulir.
      const { cssW, cssH } = fitCanvas({
        availW: rect.width - pad,
        availH: compact || H > BASE_H ? Infinity : rect.height - pad,
        dpr,
      });
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    fitRef.current = fit;
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
      fitRef.current = null;
    };
  }, [office]);

  useEffect(() => {
    fitRef.current?.();
  }, [rosterVersion]);

  useEffect(() => {
    rendererRef.current?.setTheme(officeTheme ?? theme, variant, phase);
  }, [officeTheme, theme, variant, phase]);

  useEffect(() => {
    office.setSleepy(sleepinessOf(phase));
  }, [office, phase]);

  useEffect(() => {
    office.setReducedMotion(reducedMotion);
  }, [office, reducedMotion]);

  useEffect(() => {
    office.setRain(rain);
  }, [office, rain]);

  const onClick = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const name = office.hitTest(x, y);
    if (name) selectRef.current?.(name);
  };

  return (
    <div className={`office-wrap${tall ? ' is-tall' : ''}`} ref={wrapRef} style={{ '--office-ratio': `${W} / ${H}` }}>
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
          onClick={() => onToggleRain?.(!rain)}
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
