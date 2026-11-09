import { useId, useState } from 'react';
import {
  CONFIG_HINT, LEVEL_INFO, UNAVAILABLE_TEXT, USAGE_LABEL, WARNING_TEXT,
  chartBars, formatFull, formatPercent, formatTokens, isLimitWarning,
} from '../usage.js';

const wide = () => typeof window !== 'undefined' && window.matchMedia?.('(min-width: 961px)').matches;

function Tokens({ value, className }) {
  return (
    <span className={className} title={`${formatFull(value)} token`}>
      {formatTokens(value)}
    </span>
  );
}

function WeeklyBar({ weekly }) {
  if (!weekly.configured) {
    return (
      <p className="usage-config">
        <span className="usage-k">Mingguan</span>
        <span>
          <Tokens value={weekly.used} /> token. {CONFIG_HINT}
        </span>
      </p>
    );
  }
  const info = LEVEL_INFO[weekly.level] ?? LEVEL_INFO.green;
  const pct = formatPercent(weekly.percent);
  const now = Math.min(100, Math.max(0, Math.round(weekly.percent)));
  return (
    <div className="usage-weekly">
      <div className="usage-weekly-row">
        <span className="usage-k">Mingguan</span>
        <span className={`usage-level lv-${weekly.level}`}>
          {pct} · {info.label}
        </span>
      </div>
      <div
        className="usage-bar"
        role="progressbar"
        aria-label="Pemakaian limit mingguan"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={now}
        aria-valuetext={`${pct} dari limit mingguan, status ${info.label}`}
      >
        <span className="usage-fill" style={{ width: `${Math.min(100, weekly.percent)}%`, backgroundColor: info.color }} />
      </div>
      <p className="usage-sub">
        <Tokens value={weekly.used} /> dari <Tokens value={weekly.limit} /> token
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
      <dl className="usage-breakdown" aria-label="Rincian token hari ini">
        <div>
          <dt>Input</dt>
          <dd><Tokens value={today.input} /></dd>
        </div>
        <div>
          <dt>Output</dt>
          <dd><Tokens value={today.output} /></dd>
        </div>
        <div>
          <dt>Cache</dt>
          <dd>
            <span title={`baca ${formatFull(today.cacheRead)} · tulis ${formatFull(today.cacheCreation)} token`}>
              {formatTokens(cache)}
            </span>
          </dd>
        </div>
      </dl>

      <figure className="usage-chart">
        <figcaption>7 hari terakhir</figcaption>
        {bars.length ? (
          <ol className="usage-bars">
            {bars.map((b) => (
              <li key={b.date} title={`${b.short}: ${formatFull(b.total)} token`}>
                <span className="usage-col" aria-hidden="true">
                  <span className="usage-col-fill" style={{ height: `${Math.max(b.total > 0 ? 4 : 0, b.height)}%` }} />
                </span>
                <span className="usage-day" aria-hidden="true">{b.weekday}</span>
                <span className="sr-only">
                  {b.weekday} {b.short}: {formatTokens(b.total)} token
                </span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="usage-muted">Belum ada data harian.</p>
        )}
      </figure>

      <div className="usage-agents">
        <h3>Top {usage.topAgents.length || ''} agen</h3>
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
          <p className="usage-muted">Belum ada pemakaian agen.</p>
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
  const [open, setOpen] = useState(wide);
  const detailsId = useId();
  const ok = state?.status === 'ok';
  const warning = isLimitWarning(state);
  const level = ok && state.usage.weekly.configured ? state.usage.weekly.level : 'none';

  return (
    <section className={`usage-panel lvl-${level}${warning ? ' is-warning' : ''}`} aria-labelledby={`${detailsId}-title`}>
      <div className="usage-head">
        <h2 id={`${detailsId}-title`}>Pemakaian Limit</h2>
        {state?.sim && <span className="usage-sim">Simulasi</span>}
        <span className="usage-note">{USAGE_LABEL}</span>
        {ok && (
          <button
            type="button"
            className="usage-toggle"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Ringkas' : 'Rincian'}
          </button>
        )}
      </div>

      {state?.status === 'loading' && <p className="usage-empty">Memuat data pemakaian…</p>}
      {!ok && state?.status !== 'loading' && (
        <p className="usage-empty">
          {UNAVAILABLE_TEXT}
          {state?.reason && state.reason !== UNAVAILABLE_TEXT && <span className="usage-reason"> ({state.reason})</span>}
        </p>
      )}

      {ok && (
        <>
          <div className="usage-summary">
            <p className="usage-today">
              <span className="usage-k">Hari ini</span>
              <Tokens value={state.usage.today.total} className="usage-big" />
              <span className="usage-unit">token</span>
            </p>
            <WeeklyBar weekly={state.usage.weekly} />
          </div>
          {warning && (
            <p className="usage-alert" role="alert">
              <span className="usage-alert-icon" aria-hidden="true">!</span>
              {WARNING_TEXT}
            </p>
          )}
          <Details usage={state.usage} id={detailsId} hidden={!open} />
        </>
      )}
    </section>
  );
}
