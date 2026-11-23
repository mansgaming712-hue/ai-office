import { useId, useRef } from 'react';
import { LANGS, t } from '../i18n.js';
import { paletteForTheme } from '../office/palette.js';
import { DEFAULT_THEME_ID } from '../office/themeRegistry.js';
import { PHASES, PHASE_START, isPhase } from '../office/daycycle.js';
import { MOTION_MODES } from '../settings.js';
import { useDialogFocus } from './dialogA11y.js';

const GEAR = [
  '...#.#...',
  '.#######.',
  '..##.##..',
  '###...###',
  '#.#...#.#',
  '###...###',
  '..##.##..',
  '.#######.',
  '...#.#...',
];

/** Ikon roda gigi pixel-art (dekoratif). */
export function GearIcon() {
  let d = '';
  GEAR.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === '#') d += `M${x} ${y}h1v1h-1z`;
  });
  return (
    <svg className="theme-icon" width="18" height="18" viewBox="0 0 9 9" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <path d={d} fill="currentColor" />
    </svg>
  );
}

/** Dua kotak warna (siang dan malam) pratinjau tema; teksnya hanya untuk pembaca layar. */
function Swatches({ theme }) {
  return (
    <span className="set-swatches">
      {['day', 'night'].map((v) => {
        const P = paletteForTheme(theme, v);
        return (
          <span className="set-sw" key={v}>
            <span className="sr-only">{t(`office.theme.${v}`)}</span>
            <span className="set-sw-box" aria-hidden="true">
              {[P.wall, P.floor, P.accentA, P.accentB].map((c, i) => <i key={i} style={{ background: c }} />)}
            </span>
          </span>
        );
      })}
    </span>
  );
}

function RadioGroup({ legend, name, value, options, onChange, hint = null }) {
  return (
    <fieldset className="set-group">
      <legend>{legend}</legend>
      {options.map((o) => (
        <label className={`set-opt${o.swatches ? ' set-opt-theme' : ''}`} key={o.value}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          <span className="set-opt-text">
            <span className="set-opt-label" lang={o.lang}>{o.label}</span>
            {o.desc && <span className="set-opt-desc">{o.desc}</span>}
          </span>
          {o.swatches}
        </label>
      ))}
      {hint}
    </fieldset>
  );
}

/** Pilihan mode waktu di UI: Mati, Otomatis, Manual (fasenya dipilih di daftar di bawahnya). */
export const TIME_CHOICES = Object.freeze(['off', 'auto', 'manual']);

/** Mode tersimpan → pilihan di UI ('off' | 'auto' | 'manual'). */
export const timeChoiceOf = (timeMode) => (isPhase(timeMode) ? 'manual' : timeMode === 'auto' ? 'auto' : 'off');

/** Pilihan UI → nilai timeMode yang disimpan. Manual mulai dari fase yang sedang tampil (livePhase) atau 'siang'. */
export const timeModeForChoice = (choice, livePhase = null) => (choice === 'manual' ? (isPhase(livePhase) ? livePhase : 'siang') : choice);

/** Jam mulai-selesai tiap fase, mis. "06:00-10:59" (teks bantuan, bukan terjemahan). */
const pad = (h) => String(h).padStart(2, '0');
export const phaseRange = (p) => {
  const i = PHASES.indexOf(p);
  const end = PHASE_START[PHASES[(i + 1) % PHASES.length]];
  return `${pad(PHASE_START[p])}:00-${pad((end + 23) % 24)}:59`;
};

/**
 * Dialog pengaturan (modal aksesibel): role="dialog" aria-modal, judul dan deskripsi berlabel, fokus terjebak,
 * Esc menutup, klik latar menutup. Presentasional: semua nilai dan perubahan datang lewat props.
 */
export default function SettingsDialog({
  open, onClose, settings, onChange, onReset, themes, problems = [], lang, onLangChange, reducedMotion = false, livePhase = null,
}) {
  const boxRef = useRef(null);
  const phaseId = useId();
  const onKeyDown = useDialogFocus(open, boxRef, onClose);
  if (!open) return null;
  const timeChoice = timeChoiceOf(settings.timeMode);
  const pick = (th, key) => th[key]?.[lang] ?? th[key]?.en ?? '';
  const themeOptions = themes.map((th) => ({
    value: th.id,
    label: `${pick(th, 'name')}${th.id === DEFAULT_THEME_ID ? ` (${t('office.theme.default')})` : ''}`,
    desc: pick(th, 'description'),
    swatches: <Swatches theme={th} />,
  }));
  return (
    <div className="dlg-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        aria-describedby="settings-desc"
        tabIndex={-1}
        ref={boxRef}
        onKeyDown={onKeyDown}
      >
        <header className="dlg-head">
          <h2 id="settings-title">{t('ui.settings.title')}</h2>
          <button type="button" className="btn btn-small dlg-close" onClick={onClose} aria-label={t('ui.settings.close')} title={t('ui.settings.close')}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        <p id="settings-desc" className="dlg-desc">{t('ui.settings.intro')}</p>
        <div className="dlg-body">
          <RadioGroup
            legend={t('ui.settings.theme')}
            name="office-theme"
            value={settings.officeTheme}
            options={themeOptions}
            onChange={(v) => onChange({ officeTheme: v })}
          />
          <RadioGroup
            legend={t('ui.settings.lang')}
            name="ui-lang"
            value={lang}
            options={LANGS.map((code) => ({ value: code, lang: code, label: t(`ui.lang.${code}`) }))}
            onChange={onLangChange}
          />
          <RadioGroup
            legend={t('ui.settings.time')}
            name="time-mode"
            value={timeChoice}
            options={TIME_CHOICES.map((m) => ({ value: m, label: t(`ui.settings.time.${m}`) }))}
            onChange={(v) => onChange({ timeMode: timeModeForChoice(v, livePhase) })}
            hint={timeChoice === 'off' ? null : (
              <div className="set-phase">
                {timeChoice === 'auto' && (
                  <p className="set-note" role="status">{t('ui.settings.time.now', { phase: t(`ui.settings.phase.${livePhase ?? 'siang'}`) })}</p>
                )}
                {timeChoice === 'manual' && (
                  <label className="set-select" htmlFor={phaseId}>
                    <span>{t('ui.settings.time.phase')}</span>
                    <select id={phaseId} value={settings.timeMode} onChange={(e) => onChange({ timeMode: e.target.value })}>
                      {PHASES.map((p) => <option key={p} value={p}>{`${t(`ui.settings.phase.${p}`)} (${phaseRange(p)})`}</option>)}
                    </select>
                  </label>
                )}
                <p className="set-note">{t('ui.settings.time.hours')}</p>
              </div>
            )}
          />
          <RadioGroup
            legend={t('ui.settings.motion')}
            name="motion-mode"
            value={settings.motion}
            options={MOTION_MODES.map((m) => ({ value: m, label: t(`ui.settings.motion.${m}`) }))}
            onChange={(v) => onChange({ motion: v })}
          />
          <div className="set-group set-rain">
            <label className="set-opt">
              <input
                type="checkbox"
                checked={settings.rain && !reducedMotion}
                disabled={reducedMotion}
                aria-describedby={reducedMotion ? 'settings-rain-note' : undefined}
                onChange={(e) => onChange({ rain: e.target.checked })}
              />
              <span className="set-opt-text"><span className="set-opt-label">{t('ui.settings.rain')}</span></span>
            </label>
            {reducedMotion && <p id="settings-rain-note" className="set-note">{t('ui.settings.rainOff')}</p>}
          </div>
          {problems.length > 0 && (
            <section className="set-problems" aria-labelledby="settings-skipped">
              <h3 id="settings-skipped">{t('ui.settings.skipped')}</h3>
              <p className="set-note">{t('ui.settings.skippedNote')}</p>
              <ul>
                {problems.map((p) => (
                  <li key={p.file}><code>{p.file}</code>: {p.errors.slice(0, 3).join('; ')}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <footer className="dlg-foot">
          <button type="button" className="btn" onClick={onReset}>{t('ui.settings.reset')}</button>
          <button type="button" className="btn btn-primary" onClick={onClose}>{t('ui.settings.done')}</button>
        </footer>
      </div>
    </div>
  );
}
