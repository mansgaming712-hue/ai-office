// Aksesibilitas dialog modal: fokus terjebak di dalam dialog (Tab/Shift+Tab berputar), Esc menutup, fokus awal masuk
// ke dialog, dan fokus kembali ke tombol pembuka saat ditutup. Bagian murni (trapTarget, isEscape, focusableIn) dites
// di Node tanpa DOM; hook useDialogFocus memakainya di peramban.
import { useEffect, useMemo, useRef } from 'react';

export const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled])', 'select:not([disabled])', 'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Elemen yang bisa difokus di dalam `container` (urutan dokumen), tanpa yang tersembunyi. */
export function focusableIn(container) {
  if (!container?.querySelectorAll) return [];
  return [...container.querySelectorAll(FOCUSABLE)].filter((el) => !el.hidden && el.getAttribute?.('aria-hidden') !== 'true');
}

/**
 * Ke mana fokus harus pindah saat Tab ditekan? Mengembalikan elemen tujuan, 'container' (tidak ada yang bisa difokus),
 * atau null (biarkan peramban bergerak normal karena fokus ada di tengah daftar).
 */
export function trapTarget(list, active, shift) {
  if (!list.length) return 'container';
  const i = list.indexOf(active);
  if (shift) return i <= 0 ? list[list.length - 1] : null;
  return i === -1 || i === list.length - 1 ? list[0] : null;
}

export const isEscape = (e) => e?.key === 'Escape' || e?.key === 'Esc';
export const isTab = (e) => e?.key === 'Tab';

/**
 * Penangan keydown dialog (murni; elemen dan fokus disuntik): Esc menutup, Tab/Shift+Tab berputar di dalam dialog.
 * @param {{getBox: () => any, getActive: () => any, onClose: () => void}} deps
 */
export function createKeyHandler({ getBox, getActive, onClose }) {
  return (e) => {
    if (isEscape(e)) {
      e.stopPropagation?.();
      e.preventDefault?.();
      onClose();
      return;
    }
    if (!isTab(e)) return;
    const box = getBox();
    const target = trapTarget(focusableIn(box), getActive(), Boolean(e.shiftKey));
    if (target === null) return;
    e.preventDefault?.();
    (target === 'container' ? box : target)?.focus?.();
  };
}

/**
 * Pasang perilaku dialog. Mengembalikan `onKeyDown` untuk elemen dialog.
 * @param {boolean} open
 * @param {{current: HTMLElement|null}} containerRef
 * @param {() => void} onClose
 */
export function useDialogFocus(open, containerRef, onClose) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    const box = containerRef.current;
    const first = focusableIn(box)[0] ?? box;
    first?.focus?.();
    return () => {
      // kembalikan fokus ke pembuka bila masih ada di dokumen
      if (opener && opener !== document.body && document.contains(opener)) opener.focus?.();
    };
  }, [open, containerRef]);

  return useMemo(
    () => createKeyHandler({ getBox: () => containerRef.current, getActive: () => document.activeElement, onClose: () => closeRef.current?.() }),
    [containerRef],
  );
}
