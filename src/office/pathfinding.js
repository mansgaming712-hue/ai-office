// A* di grid 8-arah (tanpa memotong sudut) + perataan jalur line-of-sight.

export function createGrid(width, height, cell, rects) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const blocked = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cx = c * cell + cell / 2;
      const cy = r * cell + cell / 2;
      for (const b of rects) {
        if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
          blocked[r * cols + c] = 1;
          break;
        }
      }
    }
  }
  return { cols, rows, cell, width, height, blocked };
}

const cellOf = (g, p) => ({
  c: Math.min(g.cols - 1, Math.max(0, Math.floor(p.x / g.cell))),
  r: Math.min(g.rows - 1, Math.max(0, Math.floor(p.y / g.cell))),
});

function isFree(g, c, r, allow) {
  if (c < 0 || r < 0 || c >= g.cols || r >= g.rows) return false;
  const i = r * g.cols + c;
  return !g.blocked[i] || allow.has(i);
}

/** Cari jalur dari `start` ke `goal` (titik logis). Sel awal & tujuan selalu boleh dilewati. */
export function findPath(g, start, goal) {
  const s = cellOf(g, start);
  const t = cellOf(g, goal);
  const si = s.r * g.cols + s.c;
  const ti = t.r * g.cols + t.c;
  const allow = new Set([si, ti]);
  if (si === ti) return [{ ...goal }];

  const n = g.cols * g.rows;
  const gScore = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const open = [si];
  const fScore = new Float64Array(n).fill(Infinity);
  const h = (i) => {
    const dc = Math.abs((i % g.cols) - t.c);
    const dr = Math.abs(Math.floor(i / g.cols) - t.r);
    return Math.max(dc, dr) + (Math.SQRT2 - 1) * Math.min(dc, dr);
  };
  gScore[si] = 0;
  fScore[si] = h(si);

  while (open.length) {
    let best = 0;
    for (let k = 1; k < open.length; k++) if (fScore[open[k]] < fScore[open[best]]) best = k;
    const cur = open.splice(best, 1)[0];
    if (cur === ti) break;
    closed[cur] = 1;
    const cc = cur % g.cols;
    const cr = Math.floor(cur / g.cols);
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const nc = cc + dc;
        const nr = cr + dr;
        if (!isFree(g, nc, nr, allow)) continue;
        if (dc && dr && (!isFree(g, cc + dc, cr, allow) || !isFree(g, cc, cr + dr, allow))) continue;
        const ni = nr * g.cols + nc;
        if (closed[ni]) continue;
        const tentative = gScore[cur] + (dc && dr ? Math.SQRT2 : 1);
        if (tentative < gScore[ni]) {
          came[ni] = cur;
          gScore[ni] = tentative;
          fScore[ni] = tentative + h(ni);
          if (!open.includes(ni)) open.push(ni);
        }
      }
    }
  }
  if (came[ti] === -1) return null;

  const cells = [];
  for (let i = ti; i !== -1; i = came[i]) cells.push(i);
  cells.reverse();
  const pts = cells.map((i) => ({
    x: (i % g.cols) * g.cell + g.cell / 2,
    y: Math.floor(i / g.cols) * g.cell + g.cell / 2,
  }));
  pts[0] = { ...start };
  pts[pts.length - 1] = { ...goal };
  return smooth(g, pts, allow);
}

function lineOfSight(g, a, b, allow) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(1, Math.ceil(dist / 2));
  for (let k = 0; k <= steps; k++) {
    const x = a.x + ((b.x - a.x) * k) / steps;
    const y = a.y + ((b.y - a.y) * k) / steps;
    const { c, r } = cellOf(g, { x, y });
    if (!isFree(g, c, r, allow)) return false;
  }
  return true;
}

function smooth(g, pts, allow) {
  if (pts.length <= 2) return pts.slice(1);
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineOfSight(g, pts[i], pts[j], allow)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out; // tanpa titik awal: daftar waypoint yang dituju berurutan
}

export function pathLength(start, waypoints) {
  let len = 0;
  let p = start;
  for (const q of waypoints) {
    len += Math.hypot(q.x - p.x, q.y - p.y);
    p = q;
  }
  return len;
}
