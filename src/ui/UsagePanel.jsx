import { useId, useState } from 'react';
import { t, useLang } from '../i18n.js';
import {
  LEVEL_INFO, chartBars, configHint, formatFull, formatPercent, formatTokens, isLimitWarning,
  unavailableText, usageLabel, warningText,
} from '../usage.js';
import { PanelSkeleton } from './Skeleton.jsx';

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/** Blok keterangan yang seragam untuk semua keadaan tanpa angka (memuat, tidak tersedia, limit kosong). */
function Notice({ kind, title, children }) {
  return (
    <div className={`usage-state us-${kind}`}>
      <span className="usage-state-icon" aria-hidden="true">{kind === 'config' ? '…' : 'i'}</span>
      <div className="usage-state-text">
        <p className="usage-state-title">{title}</p>
        {children}
      </div>
    </div>
  );
}

// Rincian terbuka dari awal hanya bila layar cukup lebar dan tinggi; kalau tidak, ruangnya dipakai kanvas.
const wide = () =>
  typeof window !== 'undefined' && Boolean(window.matchMedia?.('(min-width: 961px) and (min-height: 1500px)').matches);

function Tokens({ value, className }) {
  return (
    <span className={className} title={t('ui.usage.tokenTitle', { n: formatFull(value) })}>
      {formatTokens(value)}
    </span>
  );
}

function WeeklyBar({ weekly }) {
  if (!weekly.configured) {
    return (
      <Notice kind="config" title={t('ui.usage.weeklyUnset')}>
        <p className="usage-state-body">
          {t('ui.usage.usedThisWeek')} <Tokens value={weekly.used} /> {t('ui.usage.tokens')}.
        </p>
        <p className="usage-state-body usage-state-hint">{configHint()}</p>
      </Notice>
    );
  }
  const info = LEVEL_INFO[weekly.level] ?? LEVEL_INFO.green;
  const pct = formatPercent(weekly.percent);
  const now = Math.min(100, Math.max(0, Math.round(weekly.percent)));
  return (
    <div className="usage-weekly">
      <div className="usage-weekly-row">
        <span className="usage-k">{t('ui.usage.weekly')}</span>
        <span className={`usage-level lv-${weekly.level}`}>
          {pct} · {info.label}
        </span>
      </div>
      <div
        className="usage-bar"
        role="progressbar"
        aria-label={t('ui.usage.weeklyAria')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={now}
        aria-valuetext={t('ui.usage.weeklyValueText', { pct, level: info.label })}
      >
        <span className="usage-fill" style={{ width: `${Math.min(100, weekly.percent)}%`, backgroundColor: info.color }} />
      </div>
      <p className="usage-sub">
        <Tokens value={weekly.used} /> {t('ui.usage.of')} <Tokens value={weekly.limit} /> {t('ui.usage.tokens')}
      </p>
    </div>
  );
}

function Details({ usage, id, hidden }) {
  const { today } = usage;
  const cache = today.cacheRead + today.cacheCreation;
  const bars = chartBars(usage.days);
  return (
    <div className="usage-details" id={id} hidden={hidden}>
      <dl className="usage-breakdown" aria-label={t('ui.usage.breakdownAria')}>
        <div>
          <dt>{t('ui.usage.input')}</dt>
          <dd><Tokens value={today.input} /></dd>
        </div>
        <div>
          <dt>{t('ui.usage.output')}</dt>
          <dd><Tokens value={today.output} /></dd>
        </div>
        <div>
          <dt>{t('ui.usage.cache')}</dt>
          <dd>
            <span title={t('ui.usage.cacheTitle', { read: formatFull(today.cacheRead), write: formatFull(today.cacheCreation) })}>
              {formatTokens(cache)}
            </span>
          </dd>
        </div>
      </dl>

      <figure className="usage-chart">
        <figcaption>{t('ui.usage.last7')}</figcaption>
        {bars.length ? (
          <ol className="usage-bars">
            {bars.map((b) => (
              <li key={b.date} title={`${b.short}: ${t('ui.usage.tokenTitle', { n: formatFull(b.total) })}`}>
                <span className="usage-col" aria-hidden="true">
                  <span className="usage-col-fill" style={{ height: `${Math.max(b.total > 0 ? 4 : 0, b.height)}%` }} />
                </span>
                <span className="usage-day" aria-hidden="true">{b.weekday}</span>
                <span className="sr-only">
                  {b.weekday} {b.short}: {formatTokens(b.total)} {t('ui.usage.tokens')}
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="usage-muted">{t('ui.usage.noDaily')}</p>
        )}
      </figure>

      <div className="usage-agents">
        <h3>{usage.topAgents.length ? t('ui.usage.topAgents', { n: usage.topAgents.length }) : t('ui.usage.topAgentsNone')}</h3>
        {usage.topAgents.length ? (
          <ol>
            {usage.topAgents.map((a) => (
              <li key={a.agent}>
                <span className="usage-agent-name" title={a.agent}>{a.agent}</span>
                <Tokens value={a.total} className="usage-agent-val" />
              </li>
            ))}
          </ol>
        ) : (
          <p className="usage-muted">{t('ui.usage.noAgents')}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Panel "Pemakaian Limit" yang menempel di meja manajer (di atas denah kantor).
 * state: { status: 'loading' } | { status: 'ok', usage, sim? } | { status: 'unavailable', reason }
 */
export default function UsagePanel({ state }) {
  useLang();
  const [open, setOpen] = useState(wide);
  const detailsId = useId();
  const ok = state?.status === 'ok';
  const warning = isLimitWarning(state);
  const level = ok && state.usage.weekly.configured ? state.usage.weekly.level : 'none';

  return (
    <section className={`usage-panel lvl-${level}${warning ? ' is-warning' : ''}`} aria-labelledby={`${detailsId}-title`}>
      <div className="usage-head">
        <h2 id={`${detailsId}-title`}>{t('ui.usage.title')}</h2>
        {state?.sim && <span className="usage-sim">{t('ui.usage.sim')}</span>}
        <span className="usage-note">{usageLabel()}</span>
        {ok && (
          <button
            type="button"
            className="usage-toggle"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? t('ui.usage.collapse') : t('ui.usage.expand')}
          </button>
        )}
      </div>

      {state?.status === 'loading' && (
        <div className="usage-state us-loading" role="status">
          <PanelSkeleton rows={2} />
          <p className="usage-state-body">{t('ui.usage.loading')}</p>
        </div>
      )}
      {!ok && state?.status !== 'loading' && (
        <Notice kind="unavailable" title={cap(unavailableText())}>
          {state?.reason && state.reason !== unavailableText() && <p className="usage-state-body">{state.reason}</p>}
          <p className="usage-state-body usage-state-hint">{t('ui.usage.hint')}</p>
        </Notice>
      )}

      {ok && (
        <>
          <div className="usage-summary">
            <p className="usage-today">
              <span className="usage-k">{t('ui.usage.today')}</span>
              <Tokens value={state.usage.today.total} className="usage-big" />
              <span className="usage-unit">{t('ui.usage.tokens')}</span>
            </p>
            <WeeklyBar weekly={state.usage.weekly} />
          </div>
          {warning && (
            <p className="usage-alert" role="alert">
              <span className="usage-alert-icon" aria-hidden="true">!</span>
              {warningText()}
            </p>
          )}
          <Details usage={state.usage} id={detailsId} hidden={!open} />
        </>
      )}
    </section>
  );
}
