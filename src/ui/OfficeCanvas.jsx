import { useEffect, useRef } from 'react';
import { H, W } from '../office/layout.js';
import { createRenderer } from '../office/render.js';

/** Canvas kantor: loop animasi + klik worker untuk mengisi kotak perintah. */
export default function OfficeCanvas({ office, onSelectWorker, limitWarning = false }) {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const selectRef = useRef(onSelectWorker);
  selectRef.current = onSelectWorker;

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    const renderer = createRenderer(canvas);
    document.fonts?.load('8px "VT323"').catch(() => {});

    const fit = () => {
      const { width, height } = wrap.getBoundingClientRect();
      const cssW = Math.max(240, Math.floor(Math.min(width, height * (W / H))));
      const cssH = Math.floor(cssW * (H / W));
      const dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      canvas.width = Math.round(cssW * dpr);
      canvas.height = Math.round(cssH * dpr);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(wrap);
    fit();

    let raf = 0;
    let last = performance.now();
    const frame = (now) => {
      office.update((now - last) / 1000);
      last = now;
      renderer.draw(office);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [office]);

  const onClick = (e) => {
    const r = canvasRef.current.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W;
    const y = ((e.clientY - r.top) / r.height) * H;
    const name = office.hitTest(x, y);
    if (name) selectRef.current?.(name);
  };

  return (
    <div className="office-wrap" ref={wrapRef} style={{ '--office-ratio': `${W} / ${H}` }}>
      <canvas
        ref={canvasRef}
        className="office-canvas"
        role="img"
        aria-label={`Denah kantor AI Office: meja manajer di depan, meja worker per divisi termasuk Divisi 3D. Status tiap agen juga tersedia di panel samping.${limitWarning ? ' Peringatan di manajer: limit hampir habis, hemat mode.' : ''}`}
        onClick={onClick}
      />
    </div>
  );
}
