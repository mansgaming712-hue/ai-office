import { BANNER_TEXT, EMPTY_TEXT, LOADING_TEXT } from '../viewState.js';
import { OfficeSkeleton, PixelSpinner } from './Skeleton.jsx';

/** Menutupi kanvas selama belum pernah terhubung ke server (muncul setelah jeda singkat, lihat CSS). */
export function LoadingNotice() {
  return (
    <div className="stage-loading">
      <OfficeSkeleton />
      <div className="stage-loading-msg" role="status">
        <PixelSpinner />
        <p className="notice-title">{LOADING_TEXT.title}</p>
        <p className="notice-body">{LOADING_TEXT.body}</p>
      </div>
    </div>
  );
}

/** Kantor terhubung tapi belum ada kejadian: jelaskan dan beri dua jalan keluar. */
export function EmptyCard({ onSimulate }) {
  return (
    <section className="stage-card" aria-labelledby="empty-title">
      <h2 id="empty-title" className="notice-title">{EMPTY_TEXT.title}</h2>
      <p className="notice-body">{EMPTY_TEXT.body}</p>
      <div className="stage-card-row">
        <button type="button" className="btn btn-primary" onClick={onSimulate}>
          ▶ {EMPTY_TEXT.simulate}
        </button>
        <div className="stage-card-hooks">
          <p className="notice-body">{EMPTY_TEXT.hooksIntro}</p>
          <p className="notice-code">
            <code>{EMPTY_TEXT.hooksCommand}</code>
          </p>
        </div>
      </div>
    </section>
  );
}

/** Koneksi putus atau server tidak terjangkau; reconnect berjalan otomatis. */
export function ConnectionBanner({ kind }) {
  const text = BANNER_TEXT[kind];
  if (!text) return null;
  return (
    <div className={`conn-banner cb-${kind}`} role="status">
      <PixelSpinner />
      <p>
        <strong>{text.title}.</strong> {text.body}
      </p>
    </div>
  );
}
