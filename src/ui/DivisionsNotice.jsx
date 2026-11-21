import { useId } from 'react';
import { t, useLang } from '../i18n.js';

/**
 * Peringatan kecil bila ada divisi plugin yang tidak dimuat. Detail ada di <details> (bisa dibuka dengan keyboard).
 * Semua teks dari server dirender sebagai teks biasa oleh React (di-escape), tidak pernah sebagai HTML.
 */
export default function DivisionsNotice({ errors }) {
  useLang();
  const id = useId();
  if (!errors || errors.length === 0) return null;
  return (
    <section className="div-notice" aria-labelledby={id}>
      <details>
        <summary id={id}>{t('ui.divisions.failed', { count: errors.length })}</summary>
        <ul>
          {errors.map((e, i) => (
            <li key={`${e.dir}:${i}`}>
              <code>{e.dir || '?'}</code>
              <span>{e.key ? `${t(e.key)}${e.message ? ` (${e.message})` : ''}` : e.message}</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
