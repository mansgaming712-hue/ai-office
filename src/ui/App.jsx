import { useCallback, useEffect, useReducer, useRef, useState, useSyncExternalStore } from 'react';
import { divisionName, getLang, intlLocale, t, useLang } from '../i18n.js';
import { DIVISIONS, OTHER_DIVISION } from '../../shared/roster.js';
import { applyDivisionsResponse, getState as getDivisionsState, subscribe as subscribeDivisions } from '../divisions.js';
import { STATUS_INFO, STATUS_LABEL, UI_STATUSES, countStatuses, summaryText, uiStatusOf } from '../agentStatus.js';
import { parseCommand } from '../command.js';
import { Office } from '../office/engine.js';
import { cancelTask, connect, getDivisions, getRunner, getUsage, listTasks, postDemo, postEvents, postTask } from '../net.js';
import { ACTIVE_WINDOW_MS, activeSessions, ago, dropSimSessions, projectOf, trackSession } from '../sessions.js';
import { playScenario } from '../sim/scenario.js';
import { isTaskId, reasonNotice, tasksReducer } from '../tasks.js';
import { POLL_MS, displayUsage, isLimitWarning, parseUsageResponse, usageState, validateUsage } from '../usage.js';
import { CONN_LABEL, initialLink, linkReducer, stageState } from '../viewState.js';
import OfficeCanvas from './OfficeCanvas.jsx';
import { PanelSkeleton } from './Skeleton.jsx';
import { ConnectionBanner, EmptyCard, LoadingNotice } from './StageNotices.jsx';
import DivisionsNotice from './DivisionsNotice.jsx';
import LangToggle from './LangToggle.jsx';
import StatusIcon from './StatusIcon.jsx';
import TaskPanel from './TaskPanel.jsx';
import TaskViewer from './TaskViewer.jsx';
import ThemeToggle from './ThemeToggle.jsx';
import UsagePanel from './UsagePanel.jsx';
import { useReducedMotion, useTheme } from './useTheme.js';

const LOG_LIMIT = 300;

const fmtTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '--:--:--' : d.toLocaleTimeString(intlLocale(), { hour12: false });
};

/** Teks status runner di bawah kotak perintah (menurut bahasa aktif). */
function runnerText(runner) {
  if (runner.state === 'checking') return t('ui.runner.checking');
  if (runner.state === 'ready') return t('ui.runner.ready');
  return t(reasonNotice(runner.reason).textKey);
}

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
  useLang();
  const officeRef = useRef(null);
  if (!officeRef.current) officeRef.current = new Office();
  const office = officeRef.current;

  const rosterState = useSyncExternalStore(subscribeDivisions, getDivisionsState, getDivisionsState);
  const [log, setLog] = useState([]);
  const [link, dispatchLink] = useReducer(linkReducer, initialLink);
  const { theme, toggle: toggleTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const [simRunning, setSimRunning] = useState(false);
  const [statuses, setStatuses] = useState(() => statusesOf(office));
  const [command, setCommand] = useState('');
  // feedback / controlNote: { kind, key, vars, reasonKey, command, raw }. Teks dihitung saat render (mengikuti bahasa).
  const [feedback, setFeedback] = useState(null);
  const [controlNote, setControlNote] = useState(null);
  const [tasks, dispatchTasks] = useReducer(tasksReducer, []);
  const [runner, setRunner] = useState({ state: 'checking' });
  const [viewerId, setViewerId] = useState(null);
  const [cancelling, setCancelling] = useState(() => new Set());
  const [tasksError, setTasksError] = useState(null);
  const [sending, setSending] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const lastRunnerLoad = useRef(0);
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

  const refreshRunner = useCallback(async () => {
    const r = await getRunner();
    setRunner(r);
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

  // Runner tugas + daftar tugas: dimuat saat dibuka dan setiap kali koneksi pulih (tanpa muat ganda berdekatan).
  useEffect(() => {
    if (link.conn === 'offline') return undefined;
    const stamp = Date.now();
    if (stamp - lastRunnerLoad.current < 1500) return undefined;
    lastRunnerLoad.current = stamp;
    // Daftar tugas hanya diminta bila runner ada dan key tidak kurang (menghindari 401/404 yang sia-sia).
    getRunner().then(async (r) => {
      setRunner(r);
      if (r.state === 'unsupported' || r.reason === 'key') return;
      const list = await listTasks();
      if (list.ok) dispatchTasks({ type: 'load', tasks: list.tasks });
    });
    return undefined;
  }, [link.conn]);

  // Divisi plugin dari server. Gagal (server lama, jaringan, simulasi) → roster bawaan tetap persis seperti sekarang.
  useEffect(() => {
    if (link.conn === 'offline') return undefined;
    let alive = true;
    getDivisions().then(({ status, body }) => {
      if (alive) applyDivisionsResponse(status, body);
    });
    return () => {
      alive = false;
    };
  }, [link.conn]);

  // Roster berubah: hitung ulang meja di engine dan segarkan daftar status.
  useEffect(() => {
    const sync = () => {
      office.syncRoster();
      setStatuses(statusesOf(office));
    };
    if (rosterState.version > 0) sync();
    return subscribeDivisions(sync);
  }, [office]);

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
      onTask: (raw) => {
        dispatchTasks({ type: 'upsert', task: raw, now: Date.now() });
        refreshRunner();
      },
      // Ditolak sebelum hello: mungkin sesi habis. false → berhenti reconnect.
      onClosedBeforeHello: onRecheckSession,
    });
    netRef.current = net;
    return () => net.close();
  }, [office, dispatch, addToLog, onRecheckSession, refreshSessions, refreshRunner]);

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
    setControlNote(null);
  };

  /** Jalur animasi/event (perilaku lama): kirim ke server bila online, kalau tidak putar lokal. Mengembalikan false bila sesi habis. */
  const sendEvents = async (events, note) => {
    if (netRef.current?.isOnline()) {
      try {
        await postEvents(events);
        setFeedback(note ?? { kind: 'ok', key: 'ui.cmd.fb.sent' });
      } catch (err) {
        // 401: sesi habis? Kalau ya, induk sudah pindah ke layar login.
        if (err.status === 401 && onRecheckSession && !(await onRecheckSession())) return false;
        events.forEach((ev) => dispatch(ev));
        setFeedback({ kind: 'error', key: 'ui.cmd.fb.rejected', vars: { error: err.message } });
      }
    } else {
      events.forEach((ev) => dispatch(ev));
      setFeedback(note ?? { kind: 'ok', key: 'ui.cmd.fb.offline' });
    }
    return true;
  };

  const submit = async (e) => {
    e.preventDefault();
    if (sending) return;
    const parsed = parseCommand(command);
    if (!parsed.ok) {
      setFeedback({ kind: 'error', raw: parsed.error });
      return;
    }
    if (parsed.kind === 'text') {
      // Teks biasa: tugas nyata ke runner bila tersedia.
      setSending(true);
      // Cek runner dulu: kalau jelas tidak tersedia, tidak perlu POST yang pasti ditolak.
      const status = await getRunner();
      setRunner(status);
      const r =
        status.state === 'ready'
          ? await postTask(parsed.text, getLang())
          : { ok: false, reason: status.state === 'unsupported' ? 'unsupported' : status.reason };
      setSending(false);
      if (r.ok) {
        dispatchTasks({ type: 'upsert', task: r.task, now: Date.now() });
        setFeedback({ kind: 'ok', key: 'ui.cmd.fb.taskStarted', vars: { title: r.task.title || r.task.id } });
        setCommand('');
        refreshRunner();
        return;
      }
      if (r.reason === 'busy' || r.reason === 'invalid' || r.reason === 'error') {
        // Perintah dipertahankan di kotak supaya bisa dicoba lagi; tidak diputar sebagai animasi.
        setFeedback(
          r.reason === 'busy'
            ? { kind: 'error', key: 'ui.runner.busy' }
            : { kind: 'error', key: 'ui.cmd.fb.taskFailed', vars: { error: r.error || 'HTTP' } },
        );
        refreshRunner();
        return;
      }
      // Runner tidak ada / ditolak (key, CLI, mati): jelaskan alasannya lalu tetap putar sebagai animasi.
      const notice = reasonNotice(r.reason);
      refreshRunner();
      const note =
        r.reason === 'unsupported' ? undefined : { kind: 'error', key: 'ui.cmd.fb.animationOnly', reasonKey: notice.textKey, command: notice.command };
      if (!(await sendEvents(parsed.events, note))) return;
      setCommand('');
      return;
    }
    if (!(await sendEvents(parsed.events))) return;
    setCommand('');
  };

  const startDemo = async () => {
    if (demoBusy) return;
    setDemoBusy(true);
    // Tanpa key atau server lama: langsung simulasi lokal tanpa request yang pasti ditolak.
    const status = await getRunner();
    setRunner(status);
    const r =
      status.state === 'unsupported' || status.reason === 'key'
        ? { ok: false, reason: status.state === 'unsupported' ? 'unsupported' : 'key' }
        : status.reason === 'busy'
          ? { ok: false, reason: 'busy' }
          : await postDemo(getLang());
    setDemoBusy(false);
    if (r.ok) {
      endSim();
      dispatchTasks({ type: 'upsert', task: r.task, now: Date.now() });
      setControlNote({ kind: 'ok', key: 'ui.demo.started' });
      refreshRunner();
      return;
    }
    if (r.reason === 'busy') {
      setControlNote({ kind: 'error', key: 'ui.demo.busy' });
      return;
    }
    // Tanpa key, server lama, atau runner mati: jatuh ke simulasi lokal.
    setControlNote({ kind: 'ok', key: 'ui.demo.fallback' });
    if (!sim.current) toggleSim();
  };

  const cancel = async (id) => {
    setCancelling((prev) => new Set(prev).add(id));
    setTasksError(null);
    const ok = await cancelTask(id);
    if (!ok) setTasksError('ui.tasks.cancelFailed');
    setCancelling((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    refreshRunner();
  };

  const noteText = (f) =>
    f?.raw ?? (f?.key ? t(f.key, { ...f.vars, ...(f.reasonKey ? { reason: t(f.reasonKey) } : {}) }) : '');

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

  const groups = [...DIVISIONS, ...rosterState.plugin, OTHER_DIVISION]
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

      <aside className="panel" aria-label={t('ui.panel.aria')}>
        <header className="panel-head">
          <h1>AI&nbsp;Office</h1>
          <span className={`conn conn-${view.view}`} role="status">
            <span className="dot" aria-hidden="true" />
            {CONN_LABEL[view.view]}
          </span>
        </header>

        <div className="controls">
          <button type="button" className={`btn ${simRunning ? 'btn-stop' : 'btn-primary'}`} onClick={toggleSim} aria-pressed={simRunning}>
            {simRunning ? t('ui.btn.stop') : t('ui.btn.simulate')}
          </button>
          <button type="button" className="btn" onClick={startDemo} disabled={demoBusy}>
            {t('ui.btn.demo')}
          </button>
          <button type="button" className="btn" onClick={resetAll}>
            {t('ui.btn.reset')}
          </button>
          <LangToggle />
          <ThemeToggle theme={theme} onToggle={toggleTheme} />
          {authRequired && (
            <button type="button" className="btn btn-logout" onClick={logout} disabled={leaving}>
              {leaving ? t('ui.btn.loggingOut') : t('ui.btn.logout')}
            </button>
          )}
        </div>
        <p className={`control-note ${controlNote?.kind ?? ''}`} role="status" aria-live="polite">
          {noteText(controlNote)}
        </p>

        <section className="sessions" aria-labelledby="sessions-title">
          <h2 id="sessions-title">{t('ui.sessions.title')}</h2>
          {sessions.length === 0 ? (
            <p className="sessions-empty">{t('ui.sessions.empty', { minutes: ACTIVE_WINDOW_MS / 60000 })}</p>
          ) : (
            <ul>
              {sessions.map((s) => (
                <li key={`${s.sim ? 'sim' : 'real'}:${s.project}`} title={t('ui.sessions.tip', { project: s.project, count: s.count, ago: ago(s.lastAt, now) })}>
                  <span className="sess-name">{s.project}</span>
                  {s.sim && <span className="sess-sim">{t('ui.sessions.sim')}</span>}
                  <span className="sess-ago">{ago(s.lastAt, now)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <TaskPanel
          tasks={tasks}
          now={now}
          busyIds={cancelling}
          error={tasksError ? t(tasksError) : null}
          onView={setViewerId}
          onCancel={cancel}
        />

        <DivisionsNotice errors={rosterState.errors} />

        <section className="roster" aria-label={t('ui.roster.aria')} aria-busy={loading}>
          {loading ? (
            <>
              <p className="sr-only" role="status">{t('ui.roster.loading')}</p>
              <PanelSkeleton rows={9} />
            </>
          ) : (
            <>
              <div className="status-summary">
                <p className="summary-text" role="status">{summaryText(counts)}</p>
                <ul className="summary-chips" aria-label={t('ui.roster.countsAria')}>
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
                    {divisionName(g)}
                  </h2>
                  <ul>
                    {g.members.map(([name, s]) => (
                      <li key={name}>
                        <button
                          type="button"
                          className={`agent-chip ac-${s.status}`}
                          onClick={() => selectWorker(name)}
                          title={t('ui.roster.assign', { name, status: STATUS_INFO[s.status].title })}
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
          <h2 id="log-title">{t('ui.log.title')}</h2>
          {loading ? (
            <PanelSkeleton rows={4} />
          ) : (
            <ol className="log" role="log" aria-live="polite">
              {log.length === 0 && <li className="log-empty">{t('ui.log.empty')}</li>}
              {log.map((e) => (
                <li key={e.key} className={`log-item t-${e.type}`}>
                  <time dateTime={e.time}>{fmtTime(e.time)}</time>
                  <span className={`badge b-${e.type}`}>{t(`ui.log.type.${e.type}`)}</span>
                  <span className="route">
                    {e.from} → {e.to}
                  </span>
                  {e.proj && (
                    <span className="proj" title={t('ui.log.projectTitle', { project: e.proj })}>
                      {e.proj}
                    </span>
                  )}
                  {e.source && <span className="src">{e.source}</span>}
                  {e.message && <p className="msg">{e.message}</p>}
                  {isTaskId(e.task) && (
                    <button type="button" className="btn btn-small log-view" onClick={() => setViewerId(e.task)} aria-label={t('ui.log.viewResultAria')}>
                      {t('ui.log.viewResult')}
                    </button>
                  )}
                </li>
              ))}
            </ol>
          )}
        </section>

        <form className="command" onSubmit={submit}>
          <label htmlFor="cmd">{t('ui.cmd.label')}</label>
          <div className="command-row">
            <textarea
              id="cmd"
              ref={inputRef}
              rows={2}
              value={command}
              placeholder={t('ui.cmd.placeholder')}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form.requestSubmit();
                }
              }}
              aria-describedby="cmd-help cmd-runner cmd-feedback"
            />
            <button type="submit" className="btn btn-primary" disabled={sending}>
              {t('ui.cmd.send')}
            </button>
          </div>
          <p id="cmd-help" className="hint">
            {t('ui.cmd.helpPlain')} <code>{t('ui.cmd.helpMentionSyntax')}</code> {t('ui.cmd.helpMention')} {t('ui.cmd.helpJson')}
          </p>
          <p id="cmd-runner" className={`runner-line rl-${runner.state}${runner.reason ? ` rl-${runner.reason}` : ''}`}>
            {runnerText(runner)}
            {runner.state === 'unavailable' && reasonNotice(runner.reason).command && (
              <>
                {' '}
                <code>{reasonNotice(runner.reason).command}</code>
              </>
            )}
          </p>
          <p id="cmd-feedback" className={`feedback ${feedback?.kind ?? ''}`} aria-live="polite">
            {noteText(feedback)}
            {feedback?.command && (
              <>
                {' '}
                <code>{feedback.command}</code>
              </>
            )}
          </p>
        </form>
      </aside>
      {viewerId && <TaskViewer taskId={viewerId} live={tasks.find((x) => x.id === viewerId)} onClose={() => setViewerId(null)} />}
    </div>
  );
}
