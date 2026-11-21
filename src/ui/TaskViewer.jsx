import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { t, useLang } from '../i18n.js';
import { getTask, getTaskFile } from '../net.js';
import { FILE_VIEW_MAX, bytesParts, isMarkdownPath, parseMarkdown, sortTaskFiles } from '../tasks.js';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function Inline({ parts }) {
  return parts.map((p, i) => {
    if (p.code) return <code key={i}>{p.text}</code>;
    return p.bold ? <strong key={i}>{p.text}</strong> : <Fragment key={i}>{p.text}</Fragment>;
  });
}

/** Markdown sederhana sebagai elemen React dari teks (React yang meng-escape): tanpa HTML mentah. */
function Markdown({ text }) {
  const blocks = parseMarkdown(text);
  return (
    <div className="md">
      {blocks.map((b, i) => {
        if (b.type === 'h') {
          const H = `h${Math.min(6, b.level + 2)}`; // h1 markdown jadi h3 (judul dialog = h2)
          return (
            <H key={i}>
              <Inline parts={b.parts} />
            </H>
          );
        }
        if (b.type === 'ul' || b.type === 'ol') {
          const L = b.type;
          return (
            <L key={i} start={b.type === 'ol' && b.start !== 1 ? b.start : undefined}>
              {b.items.map((it, j) => (
                <li key={j}>
                  <Inline parts={it} />
                </li>
              ))}
            </L>
          );
        }
        if (b.type === 'table') {
          const al = (k) => (b.align[k] ? { textAlign: b.align[k] } : undefined);
          return (
            <div key={i} className="md-table-wrap" tabIndex={0} role="region" aria-label={t('ui.viewer.table')}>
              <table className="md-table">
                <thead>
                  <tr>
                    {b.head.map((c, k) => (
                      <th key={k} scope="col" style={al(k)}>
                        <Inline parts={c} />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((r, j) => (
                    <tr key={j}>
                      {r.map((c, k) => (
                        <td key={k} style={al(k)}>
                          <Inline parts={c} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        }
        if (b.type === 'code') {
          return (
            <pre key={i} className="md-code">
              {b.text}
            </pre>
          );
        }
        return (
          <p key={i}>
            <Inline parts={b.parts} />
          </p>
        );
      })}
    </div>
  );
}

/**
 * Penampil hasil tugas (dialog modal): daftar file dari GET /api/tasks/<id> dan isi file dari
 * GET /api/tasks/<id>/files/<path>. Isi file hanya ditampilkan sebagai teks.
 * `live` = tugas dari daftar (status/jumlah file terbaru) supaya tampilan ikut diperbarui.
 */
export default function TaskViewer({ taskId, live, onClose }) {
  useLang();
  const uid = useId();
  const dialogRef = useRef(null);
  const closeRef = useRef(null);
  const [detail, setDetail] = useState({ status: 'loading' });
  const [selected, setSelected] = useState(null);
  const [file, setFile] = useState({ status: 'idle' });
  const [raw, setRaw] = useState(false);

  // Fokus: masuk ke dialog saat dibuka, kembali ke pemicu saat ditutup.
  useEffect(() => {
    const opener = document.activeElement;
    closeRef.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && document.contains(opener)) opener.focus();
    };
  }, []);

  const liveKey = `${live?.status ?? ''}:${live?.files ?? ''}`;
  useEffect(() => {
    let alive = true;
    getTask(taskId).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setDetail((d) => (d.status === 'ok' ? d : { status: 'error' }));
        return;
      }
      const files = sortTaskFiles(r.files);
      setDetail({ status: 'ok', task: r.task, files });
      setSelected((cur) => (cur && files.some((f) => f.path === cur) ? cur : (files[0]?.path ?? null)));
    });
    return () => {
      alive = false;
    };
  }, [taskId, liveKey]);

  useEffect(() => {
    if (!selected) {
      setFile({ status: 'idle' });
      return undefined;
    }
    let alive = true;
    setFile({ status: 'loading' });
    getTaskFile(taskId, selected).then((r) => {
      if (!alive) return;
      if (!r.ok) setFile({ status: 'error' });
      else setFile({ status: 'ok', text: r.text.slice(0, FILE_VIEW_MAX), truncated: r.text.length > FILE_VIEW_MAX });
    });
    return () => {
      alive = false;
    };
  }, [taskId, selected, liveKey]);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...dialogRef.current.querySelectorAll(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const task = detail.task ?? live;
  const title = task?.title || taskId;
  const status = live?.status ?? detail.task?.status;
  const md = selected && isMarkdownPath(selected);

  return (
    <div className="viewer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} className="viewer" role="dialog" aria-modal="true" aria-labelledby={`${uid}-title`} onKeyDown={onKeyDown}>
        <header className="viewer-head">
          <div className="viewer-heading">
            <h2 id={`${uid}-title`}>{t('ui.viewer.title')}</h2>
            <p className="viewer-task">
              {title}
              {status && <span className={`task-status tk-${status}`}>{t(`ui.tasks.status.${status}`)}</span>}
            </p>
          </div>
          <button type="button" className="btn btn-small" ref={closeRef} onClick={onClose}>
            {t('ui.viewer.close')}
          </button>
        </header>

        <div className="viewer-body" aria-busy={detail.status === 'loading'}>
          {detail.status === 'loading' && (
            <p className="viewer-note" role="status">
              {t('ui.viewer.loading')}
            </p>
          )}
          {detail.status === 'error' && (
            <p className="viewer-note viewer-bad" role="alert">
              {t('ui.viewer.error')}
            </p>
          )}
          {detail.status === 'ok' && (
            <>
              {detail.task.summary && (
                <section aria-labelledby={`${uid}-sum`}>
                  <h3 id={`${uid}-sum`}>{t('ui.viewer.summary')}</h3>
                  <p className="viewer-summary">{detail.task.summary}</p>
                </section>
              )}
              <section className="viewer-files" aria-labelledby={`${uid}-files`}>
                <h3 id={`${uid}-files`}>{t('ui.viewer.files')}</h3>
                {detail.files.length === 0 ? (
                  <p className="viewer-note">{t('ui.viewer.noFiles')}</p>
                ) : (
                  <ul>
                    {detail.files.map((f) => {
                      const size = bytesParts(f.bytes);
                      return (
                        <li key={f.path}>
                          <button
                            type="button"
                            className={`file-btn${f.path === selected ? ' is-selected' : ''}`}
                            aria-current={f.path === selected ? 'true' : undefined}
                            onClick={() => {
                              setSelected(f.path);
                              setRaw(false);
                            }}
                          >
                            <span className="file-name">{f.path}</span>
                            {size && <span className="file-size">{t(size.key, { n: size.n })}</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              {selected && (
                <section className="viewer-content" aria-label={t('ui.viewer.fileContent', { path: selected })} aria-busy={file.status === 'loading'}>
                  <div className="viewer-content-head">
                    <h3>{selected}</h3>
                    {md && file.status === 'ok' && (
                      <button type="button" className="btn btn-small" aria-pressed={raw} onClick={() => setRaw((v) => !v)}>
                        {raw ? t('ui.viewer.formatted') : t('ui.viewer.raw')}
                      </button>
                    )}
                  </div>
                  {file.status === 'loading' && (
                    <p className="viewer-note" role="status">
                      {t('ui.viewer.fileLoading')}
                    </p>
                  )}
                  {file.status === 'error' && (
                    <p className="viewer-note viewer-bad" role="alert">
                      {t('ui.viewer.fileError')}
                    </p>
                  )}
                  {file.status === 'ok' && (
                    <>
                      {file.truncated && <p className="viewer-note">{t('ui.viewer.truncated', { n: FILE_VIEW_MAX })}</p>}
                      {md && !raw ? (
                        <div className="viewer-scroll" tabIndex={0} role="region" aria-label={t('ui.viewer.fileContent', { path: selected })}>
                          <Markdown text={file.text} />
                        </div>
                      ) : (
                        <pre className="viewer-pre" tabIndex={0}>
                          {file.text}
                        </pre>
                      )}
                    </>
                  )}
                </section>
              )}
              {!selected && detail.files.length > 0 && <p className="viewer-note">{t('ui.viewer.pickFile')}</p>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
