import { LANGS, setLang, t, useLang } from '../i18n.js';

/**
 * Pilihan bahasa EN / ID: dua tombol dalam satu grup. Tombol aktif memakai aria-pressed;
 * bisa dipakai dengan keyboard (Tab, Enter/Spasi). Pilihan disimpan oleh setLang().
 */
export default function LangToggle() {
  const lang = useLang();
  return (
    <div className="lang-toggle" role="group" aria-label={t('ui.lang.group')}>
      {LANGS.map((code) => (
        <button
          key={code}
          type="button"
          className="btn btn-lang"
          lang={code}
          aria-pressed={lang === code}
          aria-label={t('ui.lang.switchTo', { name: t(`ui.lang.${code}`) })}
          title={t(`ui.lang.${code}`)}
          onClick={() => setLang(code)}
        >
          {code.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
