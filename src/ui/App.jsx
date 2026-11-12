import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { DIVISIONS, OTHER_DIVISION } from '../../shared/roster.js';
import { STATUS_INFO, STATUS_LABEL, UI_STATUSES, countStatuses, summaryText, uiStatusOf } from '../agentStatus.js';
import { parseCommand } from '../command.js';
import { Office } from '../office/engine.js';
import { connect, getUsage, postEvents } from '../net.js';
import { ACTIVE_WINDOW_MS, activeSessions, ago, dropSimSessions, projectOf, trackSession } from '../sessions.js';
import { playScenario } from '../sim/scenario.js';
import { POLL_MS, displayUsage, isLimitWarning, parseUsageResponse, usageState, validateUsage } from '../usage.js';
import { CONN_LABEL, initialLink, linkReducer, stageState } from '../viewState.js';
import OfficeCanvas from './OfficeCanvas.jsx';
import { PanelSkeleton } from './Skeleton.jsx';
import { ConnectionBanner, EmptyCard, LoadingNotice } from './StageNotices.jsx';
import StatusIcon from './StatusIcon.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import UsagePanel from './UsagePanel.jsx';
import { useReducedMotion, useTheme } from './useTheme.js';

const LOG_LIMIT = 300;
const TYPE_LABEL = { assign: 'TUGAS', working: 'KERJA', done: 'SELESAI', blocked: 'ERROR', report: 'LAPOR' };

const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString('id-ID', { hour12: false });
};

function statusesOf(office) {
  const out = {};
  for (const w of office.workers.values()) out[w.name] = { status: uiStatusOf(w.status), division: w.division.id };
  return out;
}

/**
 * Kantor + panel. Props sesi (dari AuthGate, semuanya opsional):
 * - authRequired: tampilkan tombol Keluar.
 * - onRecheckSession(): Promise<boolean>, cek ulang sesi; false = sesi habis (induk pindah ke login).
 * - onLogout(): Promise, keluar lalu induk pindah ke login.
 */
export default function App({ authRequired = false, onRecheckSession, onLogout }) {
  const officeRef = useRef(null);
  if (!officeRef.current) officeRef.current = new Office();
  const office = officeRef.current;

  const [log, setLog] = useState([]);
  const [link, dispatchLink] = useReducer(linkReducer, initialLink);
  const { theme, toggle: toggleTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const [simRunning, setSimRunning] = useState(false);
  const [statuses, setStatuses] = useState(() => statusesOf(office));
  const [command, setCommand] = useState('');
  const [feedback, setFeedback] = useState(null);
  const [leaving, setLeaving] = useState(false);
  const seen = useRef(new Set());
  const localId = useRef(0);
  const sim = useRef(null);
  const netRef = useRef(null);
  const inputRef = useRef(null);
  const sessionsRef = useRef(new Map());
  const [sessions, setSessions] = useState([]);
  const [now, setNow] = useState(() => Date.now());
  // Data usage asli (server) dan simulasi disimpan terpisah: simulasi tidak pernah menimpa data asli.
  const [realUsage, setRealUsage] = useState({ status: 'loading' });
  const [simUsage, setSimUsage] = useState(null);
  const shownUsage = displayUsage(realUsage, simUsage);
  const limitWarning = isLimitWarning(shownUsage);

  const refreshSessions = useCallback(() => {
    const t = Date.now();
    setNow(t);
    setSessions(activeSessions(sessionsRef.current, t));
  }, []);

  const addToLog = useCallback((events) => {
    setLog((prev) => {
      const fresh = events.map((e) => ({ ...e, proj: projectOf(e), key: e.id ? `s${e.id}` : `l${++localId.current}` }));
      return [...fresh.reverse(), ...prev].slice(0, LOG_LIMIT);
    });
  }, []);

  const dispatch = useCallback(
    (event, { instant = false } = {}) => {
      if (event.id) {
        if (seen.current.has(event.id)) return;
        seen.current.add(event.id);
      }
      office.handleEvent(event, { instant });
      addToLog([event]);
      if (trackSession(sessionsRef.current, event)) refreshSessions();
    },
    [office, addToLog, refreshSessions],
  );

  // Koneksi ke server event (hooks Claude Code)
  useEffect(() => {
    const net = connect({
      onStatus: (status) => dispatchLink({ type: 'status', status }),
      onEvent: (e) => dispatch(e),
      onHistory: (events) => {
        dispatchLink({ type: 'hello' });
        const fresh = events.filter((e) => e.id && !seen.current.has(e.id));
        let tracked = false;
        fresh.forEach((e) => {
          seen.current.add(e.id);
          office.handleEvent(e, { instant: true });
          tracked = trackSession(sessionsRef.current, e) || tracked;
        });
        if (fresh.length) addToLog(fresh);
        if (tracked) refreshSessions();
      },
      onUsage: (raw) => setRealUsage(usageState(validateUsage(raw))),
      // Ditolak sebelum hello: mungkin sesi habis. false → berhenti reconnect.
      onClosedBeforeHello: onRecheckSession,
    });
    netRef.current = net;
    return () => net.close();
  }, [office, dispatch, addToLog, onRecheckSession, refreshSessions]);

  // Pemakaian limit: GET /api/usage saat dimuat + polling cadangan tiap 60 detik (WebSocket = jalur utama).
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { status, body } = await getUsage();
      if (alive) setRealUsage(usageState(parseUsageResponse(status, body)));
    };
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  // Ikon + bubble peringatan di karakter manajer mengikuti data yang sedang tampil.
  useEffect(() => {
    office.setLimitWarning(limitWarning);
  }, [office, limitWarning]);

  // "Sesi aktif" = event dalam 10 menit terakhir: hitung ulang berkala supaya sesi lama hilang sendiri.
  useEffect(() => {
    const id = setInterval(refreshSessions, 30_000);
    return () => clearInterval(id);
  }, [refreshSessions]);

  // Status ringkas untuk panel (teks alternatif dari canvas)
  useEffect(() => {
    let prev = '';
    const id = setInterval(() => {
      const next = statusesOf(office);
      const key = JSON.stringify(next);
      if (key !== prev) {
        prev = key;
        setStatuses(next);
      }
    }, 300);
    return () => clearInterval(id);
  }, [office]);

  // Akses debug dari konsol: window.__aiOffice.snapshot()
  useEffect(() => {
    window.__aiOffice = { office, snapshot: () => office.snapshot(), dispatch };
    return () => {
      delete window.__aiOffice;
    };
  }, [office, dispatch]);

  useEffect(() => () => sim.current?.stop(), []);

  /** Akhiri simulasi: buang data usage & sesi simulasi, kembali ke data server. */
  const endSim = useCallback(() => {
    sim.current?.stop();
    sim.current = null;
    setSimRunning(false);
    setSimUsage(null);
    if (dropSimSessions(sessionsRef.current)) refreshSessions();
  }, [refreshSessions]);

  const toggleSim = () => {
    if (sim.current) {
      endSim();
      return;
    }
    office.reset();
    setSimRunning(true);
    sim.current = playScenario((e) => dispatch(e), {
      onUsage: (raw) => {
        const r = validateUsage(raw);
        if (r.ok) setSimUsage(r.usage);
      },
      onFinish: () => {
        sim.current = null;
        endSim();
      },
    });
  };

  const resetAll = () => {
    endSim();
    office.reset();
    setLog([]);
    setFeedback(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    const parsed = parseCommand(command);
    if (!parsed.ok) {
      setFeedback({ kind: 'error', text: parsed.error });
      return;
    }
    if (netRef.current?.isOnline()) {
      try {
        await postEvents(parsed.events);
        setFeedback({ kind: 'ok', text: 'Terkirim ke server.' });
      } catch (err) {
        // 401: sesi habis? Kalau ya, induk sudah pindah ke layar login.
        if (err.status === 401 && onRecheckSession && !(await onRecheckSession())) return;
        parsed.events.forEach((ev) => dispatch(ev));
        setFeedback({ kind: 'error', text: `Server menolak (${err.message}). Diputar lokal saja.` });
      }
    } else {
      parsed.events.forEach((ev) => dispatch(ev));
      setFeedback({ kind: 'ok', text: 'Server offline: perintah diputar lokal.' });
    }
    setCommand('');
  };

  const logout = async () => {
    if (leaving || !onLogout) return;
    setLeaving(true);
    endSim();
    // Tutup WebSocket dulu supaya tidak ada reconnect yang berebut dengan proses keluar.
    netRef.current?.close();
    await onLogout();
  };

  const selectWorker = (name) => {
    setCommand(`@${name} `);
    inputRef.current?.focus();
  };

  const groups = [...DIVISIONS, OTHER_DIVISION]
    .map((d) => ({ ...d, members: Object.entries(statuses).filter(([, s]) => s.division === d.id) }))
    .filter((g) => g.members.length);
  const counts = countStatuses(statuses);
  const view = stageState({ link, hasEvents: log.length > 0, simRunning });
  const loading = view.stage === 'loading';

  return (
    <div className="app">
      <main className="stage">
        <UsagePanel state={shownUsage} />
        {view.banner && <ConnectionBanner kind={view.banner} />}
        <OfficeCanvas
          office={office}
          onSelectWorker={selectWorker}
          limitWarning={limitWarning}
          theme={theme}
          reducedMotion={reducedMotion}
          overlay={loading ? <LoadingNotice /> : null}
        >
          {view.stage === 'empty' && <EmptyCard onSimulate={toggleSim} />}
        </OfficeCanvas>
      </main>

      <aside className="panel" aria-label="Panel kendali AI Office">
        <header className="panel-head">
          <h1>AI&nbsp;Office</h1>
          <span className={`conn conn-${view.view}`} role="status">
            <span className="dot" aria-hidden="true" />
            {CONN_LABEL[view.view]}
          </span>
        </header>

        <div className="controls">
          <button type="button" className={`btn ${simRunning ? 'btn-stop' : 'btn-primary'}`} onClick={toggleSim} aria-pressed={simRunning}>
            {simRunning ? '■ Hentikan' : '▶ Simulasi'}
          </button>
          <button type="button" className="btn" onClick={resetAll}>
            ↺ Reset
          </button>
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          {authRequired && (
            <button type="button" className="btn btn-logout" onClick={logout} disabled={leaving}>
              {leaving ? 'Keluar…' : 'Keluar'}
            </button>
          )}
        </div>

        <section className="sessions" aria-labelledby="sessions-title">
          <h2 id="sessions-title">Sesi aktif</h2>
          {sessions.length === 0 ? (
            <p className="sessions-empty">Belum ada sesi aktif dalam {ACTIVE_WINDOW_MS / 60000} menit terakhir.</p>
          ) : (
            <ul>
              {sessions.map((s) => (
                <li key={`${s.sim ? 'sim' : 'real'}:${s.project}`} title={`Proyek ${s.project}: ${s.count} kejadian, terakhir ${ago(s.lastAt, now)}`}>
                  <span className="sess-name">{s.project}</span>
                  {s.sim && <span className="sess-sim">sim</span>}
                  <span className="sess-ago">{ago(s.lastAt, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="roster" aria-label="Status agen" aria-busy={loading}>
          {loading ? (
            <>
              <p className="sr-only" role="status">Memuat daftar agen…</p>
              <PanelSkeleton rows={9} />
            </>
          ) : (
            <>
              <div className="status-summary">
                <p className="summary-text" role="status">{summaryText(counts)}</p>
                <ul className="summary-chips" aria-label="Jumlah agen per status">
                  {UI_STATUSES.map((st) => (
                    <li key={st} className={`chip-${st}${counts[st] === 0 ? ' is-zero' : ''}`}>
                      <StatusIcon status={st} size={14} />
                      <span className="chip-count">{counts[st]}</span>
                      <span className="chip-label">{STATUS_LABEL[st]}</span>
                    </li>
                  ))}
                </ul>
              </div>
              {groups.map((g) => (
                <div key={g.id} className="roster-group">
                  <h2>
                    <span className="div-swatch" style={{ background: g.color }} aria-hidden="true" />
                    {g.name}
                  </h2>
                  <ul>
                    {g.members.map(([name, s]) => (
                      <li key={name}>
                        <button
                          type="button"
                          className={`agent-chip ac-${s.status}`}
                          onClick={() => selectWorker(name)}
                          title={`Tugaskan ${name}. Status: ${STATUS_INFO[s.status].title}`}
                        >
                          <StatusIcon key={s.status} status={s.status} size={14} className="agent-icon" />
                          <span className="agent-name">{name}</span>
                          <span className={`agent-status st-${s.status}`}>{STATUS_LABEL[s.status]}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </section>

        <section className="log-section" aria-labelledby="log-title">
          <h2 id="log-title">Log kejadian</h2>
          {loading ? (
            <PanelSkeleton rows={4} />
          ) : (
            <ol className="log" role="log" aria-live="polite">
              {log.length === 0 && <li className="log-empty">Belum ada kejadian. Tekan Simulasi atau jalankan Claude Code.</li>}
              {log.map((e) => (
                <li key={e.key} className={`log-item t-${e.type}`}>
                  <time dateTime={e.time}>{fmtTime(e.time)}</time>
                  <span className={`badge b-${e.type}`}>{TYPE_LABEL[e.type]}</span>
                  <span className="route">
                    {e.from} → {e.to}
                  </span>
                  {e.proj && (
                    <span className="proj" title={`Proyek sesi: ${e.proj}`}>
                      {e.proj}
                    </span>
                  )}
                  {e.source && <span className="src">{e.source}</span>}
                  {e.message && <p className="msg">{e.message}</p>}
                </li>
              ))}
            </ol>
          )}
        </section>

        <form className="command" onSubmit={submit}>
          <label htmlFor="cmd">Perintah untuk manajer</label>
          <div className="command-row">
            <textarea
              id="cmd"
              ref={inputRef}
              rows={2}
              value={command}
              placeholder="Contoh: @dev-qa jalankan semua test"
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form.requestSubmit();
                }
              }}
              aria-describedby="cmd-help cmd-feedback"
            />
            <button type="submit" className="btn btn-primary">
              Kirim
            </button>
          </div>
          <p id="cmd-help" className="hint">
            Teks biasa = perintah CEO ke manajer. <code>@nama-agen tugas</code> = manajer menugaskan agen. Bisa juga
            tempel event JSON. Enter kirim, Shift+Enter baris baru.
          </p>
          <p id="cmd-feedback" className={`feedback ${feedback?.kind ?? ''}`} aria-live="polite">
            {feedback?.text ?? ''}
          </p>
        </form>
      </aside>
    </div>
  );
}
