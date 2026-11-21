import { t, useLang } from '../i18n.js';
import { ago } from '../sessions.js';
import { isRunning } from '../tasks.js';
import StatusIcon from './StatusIcon.jsx';

// Ikon status tugas memakai bitmap status agen yang sudah ada; teks status selalu ditulis di sebelahnya.
const ICON = { running: 'bekerja', done: 'selesai', failed: 'error', cancelled: 'idle' };

/**
 * Daftar tugas runner. `tasks` sudah tervalidasi (src/tasks.js). Tombol "Batal" hanya untuk tugas yang
 * berjalan; "Hasil" membuka penampil. `busyIds` = id tugas yang sedang dibatalkan.
 */
export default function TaskPanel({ tasks, now, busyIds, error, onView, onCancel }) {
  useLang();
  return (
    <section className="tasks" aria-labelledby="tasks-title">
      <h2 id="tasks-title">{t('ui.tasks.title')}</h2>
      {error && (
        <p className="tasks-error" role="status">
          {error}
        </p>
      )}
      {tasks.length === 0 ? (
        <p className="tasks-empty">{t('ui.tasks.empty')}</p>
      ) : (
        <ul className="task-list" aria-label={t('ui.tasks.listAria')}>
          {tasks.map((task) => {
            const title = task.title || task.id;
            return (
              <li key={task.id} className={`task-item ts-${task.status}`}>
                <div className="task-main">
                  <StatusIcon status={ICON[task.status] ?? 'idle'} size={14} className="agent-icon" />
                  <span className={`task-status tk-${task.status}`}>{t(`ui.tasks.status.${task.status}`)}</span>
                  {task.kind === 'demo' && <span className="task-kind">{t('ui.tasks.kind.demo')}</span>}
                  <span className="task-ago">{ago(task.startedAt, now)}</span>
                </div>
                <p className="task-title">{title}</p>
                <div className="task-actions">
                  <button
                    type="button"
                    className="btn btn-small"
                    onClick={() => onView(task.id)}
                    aria-label={t('ui.tasks.viewAria', { title })}
                  >
                    {t('ui.tasks.view')}
                    {task.files > 0 ? ` · ${t('ui.tasks.files', { n: task.files })}` : ''}
                  </button>
                  {isRunning(task) && (
                    <button
                      type="button"
                      className="btn btn-small btn-stop"
                      onClick={() => onCancel(task.id)}
                      disabled={busyIds?.has(task.id)}
                      aria-label={t('ui.tasks.cancelAria', { title })}
                    >
                      {t('ui.tasks.cancel')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
