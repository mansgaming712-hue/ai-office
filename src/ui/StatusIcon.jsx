import { GLYPH_SIZE, STATUS_INFO, glyphPaths } from '../agentStatus.js';

/**
 * Ikon pixel status (bitmap yang sama dengan penanda di kanvas). Dekoratif: labelnya selalu
 * ditulis sebagai teks di sebelahnya, jadi ikon disembunyikan dari pembaca layar.
 */
export default function StatusIcon({ status, size = GLYPH_SIZE * 2, className = '' }) {
  const info = STATUS_INFO[status] ?? STATUS_INFO.idle;
  const paths = glyphPaths(STATUS_INFO[status] ? status : 'idle');
  return (
    <svg
      className={`status-icon si-${status} ${className}`.trim()}
      width={size}
      height={size}
      viewBox={`0 0 ${GLYPH_SIZE} ${GLYPH_SIZE}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <path className="gl-p" d={paths.p} />
      <path className="gl-k" d={paths.k} />
      <path d={paths.f} fill={info.fill} />
      <path d={paths.m} fill={info.mark} />
    </svg>
  );
}
