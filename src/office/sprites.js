// Sprite karakter 16x24 piksel, dirakit dari bagian-bagian (kepala, rambut, baju, aksesori) ke grid token,
// diberi garis tepi otomatis, lalu di-cache ke canvas kecil. Arah: down, up, left, right (right = cermin left).
// Pose: stand (berdiri/berjalan, 4 frame jalan) dan sit (duduk di meja; hanya baris atas yang dipakai).
// Semua desain asli buatan sendiri; warna dari characters.js (palet terbatas) dan garis tepi dari palet tema.
import { HAIRS, HATS, HIJABS, PANTS, SKINS } from './characters.js';

export const SPR_W = 16;
export const SPR_H = 24;
/** Baris terakhir yang terlihat saat duduk (pinggang); sisanya tertutup meja. */
export const SIT_ROWS = 19;
/** Urutan frame jalan: netral, langkah A, netral, langkah B. */
export const WALK_FRAMES = [0, 1, 0, 2];

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * f))));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function colorsFor(look, role, shirt, outline) {
  const skin = SKINS[look.skin % SKINS.length];
  const hair = HAIRS[look.hair] ?? HAIRS.black;
  const hijab = HIJABS[look.hijab % HIJABS.length];
  const hat = HATS[look.hat % HATS.length];
  const acc = look.acc === 'hijab' ? hijab : hat;
  let t = shirt;
  let T = shade(shirt, 0.78);
  let u = shade(shirt, 1.3);
  if (role === 'manager') [t, T, u] = ['#3a4256', '#2a3040', '#f2f2f2'];
  if (role === 'ceo') [t, T, u] = ['#26304f', '#1a2140', '#f2f2f2'];
  const p = PANTS[look.pants % PANTS.length];
  return {
    o: outline, s: skin.s, S: skin.S, h: hair.h, H: hair.H, t, T, u, p, P: shade(p, 0.7), k: '#1d1a22',
    e: '#1d1a22', m: '#9a4a45', g: '#2a2633', a: acc.a, A: acc.A, w: '#f4f4f4', z: '#e8e8f0', r: '#c0392b',
    q: '#7fc8f8', c: '#f4f1ea', d: '#6b3f22', n: '#fff8e7',
  };
}

// ------------------------------------------------------------------ grid

function makeGrid() {
  const g = new Array(SPR_W * SPR_H).fill('');
  const put = (x, y, w, h, tok) => {
    for (let j = y; j < y + h; j++) {
      if (j < 0 || j >= SPR_H) continue;
      for (let i = x; i < x + w; i++) if (i >= 0 && i < SPR_W) g[j * SPR_W + i] = tok;
    }
  };
  return { g, put };
}

function mirror(g) {
  const out = new Array(g.length);
  for (let y = 0; y < SPR_H; y++) for (let x = 0; x < SPR_W; x++) out[y * SPR_W + x] = g[y * SPR_W + (SPR_W - 1 - x)];
  return out;
}

function addOutline(g) {
  const out = g.slice();
  for (let y = 0; y < SPR_H; y++) {
    for (let x = 0; x < SPR_W; x++) {
      if (g[y * SPR_W + x]) continue;
      const n = (xx, yy) => xx >= 0 && yy >= 0 && xx < SPR_W && yy < SPR_H && g[yy * SPR_W + xx];
      if (n(x - 1, y) || n(x + 1, y) || n(x, y - 1) || n(x, y + 1)) out[y * SPR_W + x] = 'o';
    }
  }
  return out;
}

// ------------------------------------------------------------------ bagian tubuh

function legsFront(put, s) {
  for (const [x, raised] of [[5, s.legL], [8, s.legR]]) {
    put(x, 19, 3, raised ? 2 : 3, 'p');
    put(x + 2, 19, 1, raised ? 2 : 3, 'P');
    put(x === 5 ? 4 : 8, raised ? 21 : 22, 4, 1, 'k');
  }
}

function armFront(put, side, s, dy) {
  const x = side === 'L' ? (s.sit ? 3 : 2) : (s.sit ? 11 : 12);
  const top = 12 + s.bob + dy;
  put(x, top, 2, 3, 't');
  put(x + (side === 'L' ? 0 : 1), top, 1, 3, 'T');
  put(x, top + 3, 2, 2, 's');
}

function raisedArm(put, side, s, hand) {
  const x = side === 'L' ? 2 : 12;
  put(x, 12 + s.bob, 2, 2, 't'); // bahu
  put(x, 9 + s.bob, 2, 3, 't'); // lengan atas ke atas
  if (hand) put(x, 7 + s.bob, 2, 2, 's');
}

function hairFront(put, look, hr, back) {
  const st = look.style;
  if (look.acc === 'hijab' || look.acc === 'beanie') return; // tertutup aksesori
  if (look.acc === 'cap') {
    if (back) put(4, hr + 3, 8, 4, 'h');
    else {
      put(4, hr + 3, 1, 2, 'h');
      put(11, hr + 3, 1, 2, 'h');
    }
    return;
  }
  if (st === 'bald') return;
  if (back) {
    put(4, hr, 8, 8, 'h');
    put(6, hr + 1, 3, 1, 'H');
    if (st === 'long') put(4, hr + 8, 8, 4, 'h');
    if (st === 'bob') put(4, hr + 8, 8, 1, 'h');
    if (st === 'bun') put(6, hr - 2, 4, 2, 'h');
    if (st === 'ponytail') put(7, hr + 8, 2, 6, 'h');
    if (st === 'curly') put(3, hr, 10, 7, 'h');
    return;
  }
  const top = st === 'buzz' ? 1 : 3;
  put(5, hr, 6, 1, 'h');
  put(4, hr + 1, 8, top, 'h');
  if (st === 'buzz') {
    put(4, hr + 1, 8, 1, 'h');
    put(4, hr + 2, 8, 1, 'H');
    put(4, hr + 3, 8, 1, 'h'); // garis rambut tipis
    put(5, hr + 3, 6, 1, 's');
    return;
  }
  put(6, hr + 1, 3, 1, 'H');
  if (st === 'side') {
    put(4, hr + 4, 2, 1, 'h');
    put(9, hr + 3, 3, 1, 's'); // belahan: sisi kanan terbuka
    put(4, hr + 3, 5, 1, 'h');
  } else if (st === 'curly') {
    put(3, hr + 1, 10, 3, 'h');
    put(4, hr - 1, 8, 1, 'h');
    put(5, hr, 2, 1, 'H');
    put(3, hr + 4, 1, 2, 'h');
    put(12, hr + 4, 1, 2, 'h');
  } else {
    put(4, hr + 4, 1, 2, 'h');
    put(11, hr + 4, 1, 2, 'h');
  }
  if (st === 'bun') put(6, hr - 2, 4, 2, 'h'), put(7, hr - 2, 1, 1, 'H');
  if (st === 'long') {
    put(3, hr + 3, 2, 8, 'h');
    put(11, hr + 3, 2, 8, 'h');
  }
  if (st === 'bob') {
    put(3, hr + 3, 2, 6, 'h');
    put(11, hr + 3, 2, 6, 'h');
  }
  if (st === 'ponytail') put(12, hr + 5, 2, 5, 'h');
}

function headFront(put, look, s, back) {
  const hr = 2 + s.bob;
  put(7, hr + 9, 2, 1, 'S'); // leher
  put(5, hr + 8, 6, 1, back ? 'S' : 's');
  put(4, hr + 3, 8, 5, 's');
  put(3, hr + 5, 1, 2, 'S'); // telinga
  put(12, hr + 5, 1, 2, 'S');
  if (!back) {
    put(6, hr + 5, 1, 1, s.blink ? 'S' : 'e');
    put(9, hr + 5, 1, 1, s.blink ? 'S' : 'e');
    put(8, hr + 6, 1, 1, 'S'); // hidung
    if (s.mouth) put(7, hr + 7, 2, 2, 'm');
    else put(7, hr + 7, 2, 1, 'm');
    if (look.beard) {
      put(5, hr + 7, 6, 2, 'h');
      put(7, hr + 7, 2, 1, 'm');
    }
  }
  hairFront(put, look, hr, back);
  if (look.glasses && !back) {
    put(5, hr + 4, 2, 1, 'g'); put(9, hr + 4, 2, 1, 'g');
    put(5, hr + 5, 1, 1, 'g'); put(7, hr + 5, 2, 1, 'g'); put(10, hr + 5, 1, 1, 'g');
  }
  if (look.acc === 'cap') {
    put(4, hr - 1, 8, 4, 'a');
    put(5, hr - 1, 3, 1, 'A');
    if (!back) put(3, hr + 3, 10, 1, 'A');
    else put(4, hr + 3, 8, 1, 'A');
  } else if (look.acc === 'beanie') {
    put(4, hr - 1, 8, 5, 'a');
    put(4, hr + 3, 8, 2, 'A');
    put(5, hr, 3, 1, 'A');
  }
}

function hijabFront(put, look, s, back) {
  if (look.acc !== 'hijab') return;
  const hr = 2 + s.bob;
  put(5, hr - 1, 6, 1, 'a');
  put(4, hr, 8, 4, 'a');
  put(3, hr + 3, 10, 9, 'a');
  put(4, hr + 12, 8, 1, 'a');
  put(5, hr + 13, 6, 1, 'A');
  put(5, hr + 1, 3, 1, 'A');
  if (!back) {
    put(5, hr + 4, 6, 5, 's'); // wajah di dalam hijab
    put(6, hr + 5, 1, 1, s.blink ? 'S' : 'e');
    put(9, hr + 5, 1, 1, s.blink ? 'S' : 'e');
    put(8, hr + 6, 1, 1, 'S');
    put(7, hr + 7, 2, s.mouth ? 2 : 1, 'm');
    if (look.glasses) {
      put(5, hr + 4, 2, 1, 'g'); put(9, hr + 4, 2, 1, 'g');
      put(5, hr + 5, 1, 1, 'g'); put(7, hr + 5, 2, 1, 'g'); put(10, hr + 5, 1, 1, 'g');
    }
    put(3, hr + 9, 10, 1, 'A'); // lipatan di bawah dagu
  }
}

function frontFigure(put, look, s, role, back) {
  const hr = 2 + s.bob;
  legsFront(put, s);
  // badan
  put(4, 12 + s.bob, 8, 6 - s.bob, 't');
  put(11, 12 + s.bob, 1, 6 - s.bob, 'T');
  put(4, 18, 8, 1, 'P');
  if (!back) {
    if (role === 'worker') {
      put(6, 12 + s.bob, 4, 1, 'u');
      put(7, 13 + s.bob, 1, 3, 'z'); // tali ID card
      put(7, 16 + s.bob, 2, 2, 'w');
    } else {
      put(6, 12 + s.bob, 4, 1, 'u');
      put(7, 13 + s.bob, 2, 3, 'u');
      if (role === 'ceo') put(7, 13 + s.bob, 2, 5, 'r'); // dasi
      else put(7, 16 + s.bob, 2, 1, 'T');
    }
  }
  // lengan
  const act = s.act;
  const dyL = s.armL;
  const dyR = s.armR;
  if (act === 'celebrate') {
    raisedArm(put, 'L', s, true);
    raisedArm(put, 'R', s, true);
  } else {
    if (act === 'stress' || act === 'sip' || act === 'wave' || act === 'give') armFront(put, 'L', s, dyL);
    else armFront(put, 'L', s, dyL);
    if (act === 'sip') {
      put(12, 12 + s.bob, 2, 2, 't');
      put(11, 9 + s.bob, 3, 3, 't');
      put(10, 8 + s.bob, 2, 2, 's');
      put(10, 5 + s.bob, 3, 3, 'c');
      put(10, 5 + s.bob, 3, 1, 'd');
    } else if (act === 'stress') {
      put(12, 12 + s.bob, 2, 2, 't');
      put(12, 9 + s.bob, 2, 3, 't');
      put(11, hr + 3, 2, 2, 's');
      put(13, hr - 1, 1, 2, 'q');
    } else if (act === 'wave') {
      raisedArm(put, 'R', s, true);
    } else if (act === 'give') {
      put(12, 12 + s.bob, 2, 2, 't');
      put(13, 10 + s.bob, 2, 2, 't');
      put(13, 8 + s.bob, 2, 2, 's');
      put(12, 6 + s.bob, 4, 3, 'n');
      put(12, 6 + s.bob, 4, 1, 'u');
    } else armFront(put, 'R', s, dyR);
  }
  headFront(put, look, s, back);
  hijabFront(put, look, s, back);
  if (look.style === 'long' && look.acc === 'none' && !back) {
    put(3, 12, 2, 4, 'h');
    put(11, 12, 2, 4, 'h');
  }
}

function sideFigure(put, look, s, role) {
  const hr = 2 + s.bob;
  const f = s.frame; // 0 netral, 1 langkah A, 2 langkah B
  // kaki
  const front = f === 1 ? -1 : f === 2 ? 1 : 0;
  const rear = f === 1 ? 2 : f === 2 ? -2 : 0;
  put(6 + front, 19, 2, 3, 'p');
  put(5 + front, 22, 3, 1, 'k');
  put(8 + rear, 19, 2, 3, 'P');
  put(8 + rear, 22, 3, 1, 'k');
  // badan
  put(5, 12 + s.bob, 6, 6 - s.bob, 't');
  put(9, 12 + s.bob, 2, 6 - s.bob, 'T');
  put(5, 18, 6, 1, 'P');
  if (role === 'ceo') put(5, 13 + s.bob, 1, 5, 'r');
  if (role === 'manager') put(5, 13 + s.bob, 1, 3, 'u');
  // lengan dekat penonton (berayun)
  const ax = 6 + (f === 1 ? -1 : f === 2 ? 1 : 0);
  put(ax, 12 + s.bob, 3, 3, 't');
  put(ax, 15 + s.bob, 3, 2, 's');
  // kepala
  put(7, hr + 9, 2, 1, 'S');
  put(5, hr + 3, 5, 5, 's');
  put(5, hr + 8, 4, 1, 's');
  put(4, hr + 6, 1, 1, 's'); // hidung
  put(9, hr + 5, 1, 2, 'S'); // telinga
  put(6, hr + 5, 1, 1, s.blink ? 'S' : 'e');
  put(5, hr + 7, 1, 1, 'm');
  if (look.beard) put(5, hr + 7, 4, 2, 'h'), put(5, hr + 7, 1, 1, 'm');
  const covered = look.acc === 'hijab' || look.acc === 'beanie';
  if (!covered) {
    put(5, hr, 7, 3, 'h');
    put(5, hr + 3, 4, 1, look.style === 'buzz' ? 's' : 'h');
    put(9, hr + 3, 3, 5, 'h');
    put(7, hr + 1, 3, 1, 'H');
    if (look.style === 'long') put(9, hr + 8, 4, 4, 'h');
    if (look.style === 'bob') put(9, hr + 8, 3, 1, 'h');
    if (look.style === 'bun') put(9, hr - 2, 3, 2, 'h');
    if (look.style === 'ponytail') put(11, hr + 4, 2, 6, 'h');
    if (look.style === 'curly') put(5, hr - 1, 8, 2, 'h'), put(11, hr + 3, 2, 4, 'h');
  }
  if (look.glasses) {
    put(5, hr + 4, 2, 1, 'g');
    put(5, hr + 5, 1, 1, 'g');
    put(7, hr + 5, 3, 1, 'g');
  }
  if (look.acc === 'cap') {
    put(5, hr - 1, 7, 4, 'a');
    put(5, hr - 1, 3, 1, 'A');
    put(2, hr + 3, 7, 1, 'A');
  } else if (look.acc === 'beanie') {
    put(5, hr - 1, 7, 5, 'a');
    put(5, hr + 3, 7, 2, 'A');
  } else if (look.acc === 'hijab') {
    put(5, hr - 1, 7, 1, 'a');
    put(5, hr, 8, 4, 'a');
    put(8, hr + 4, 5, 8, 'a');
    put(6, hr + 9, 7, 4, 'a');
    put(7, hr + 13, 5, 1, 'A');
    put(5, hr + 3, 4, 1, 'A');
    put(5, hr + 4, 3, 5, 's');
    put(6, hr + 5, 1, 1, s.blink ? 'S' : 'e');
    put(5, hr + 7, 1, 1, 'm');
    if (look.glasses) put(5, hr + 4, 2, 1, 'g'), put(5, hr + 5, 1, 1, 'g'), put(7, hr + 5, 1, 1, 'g');
  }
}

/**
 * Susun grid token sebuah figur.
 * spec: { dir, pose: 'stand'|'sit', frame: 0..3 (indeks WALK_FRAMES), act, mouth, blink }.
 */
export function buildGrid(look, role, spec) {
  const walking = spec.pose === 'stand' && spec.moving;
  const step = walking ? WALK_FRAMES[spec.frame & 3] : 0; // 0 netral, 1 langkah A, 2 langkah B
  const s = {
    sit: spec.pose === 'sit',
    bob: walking && step ? 1 : 0,
    legL: step === 1,
    legR: step === 2,
    armL: step === 1 ? 1 : step === 2 ? -1 : 0,
    armR: step === 1 ? -1 : step === 2 ? 1 : 0,
    frame: step,
    act: spec.act ?? null,
    mouth: Boolean(spec.mouth),
    blink: Boolean(spec.blink),
  };
  if (spec.act === 'type') {
    s.armL = spec.typeFrame ? 0 : 1;
    s.armR = spec.typeFrame ? 1 : 0;
  }
  const { g, put } = makeGrid();
  if (spec.dir === 'left' || spec.dir === 'right') {
    sideFigure(put, look, s, role);
    return spec.dir === 'right' ? mirror(g) : g;
  }
  frontFigure(put, look, s, role, spec.dir === 'up');
  return g;
}

// ------------------------------------------------------------------ cache canvas

/** Gambar grid token ke canvas SPR_W x SPR_H (per baris, lari warna yang sama digabung). */
export function paintGrid(canvas, grid, colors) {
  canvas.width = SPR_W;
  canvas.height = SPR_H;
  const c = canvas.getContext('2d');
  for (let y = 0; y < SPR_H; y++) {
    let x = 0;
    while (x < SPR_W) {
      const tok = grid[y * SPR_W + x];
      let e = x + 1;
      while (e < SPR_W && grid[y * SPR_W + e] === tok) e++;
      if (tok && colors[tok]) {
        c.fillStyle = colors[tok];
        c.fillRect(x, y, e - x, 1);
      }
      x = e;
    }
  }
}

/** Cache sprite: key = (karakter, tema, spesifikasi). `createCanvas` disuntik supaya bisa dites tanpa DOM. */
export function createSpriteCache(createCanvas) {
  const cache = new Map();
  return {
    get size() {
      return cache.size;
    },
    clear: () => cache.clear(),
    get(look, role, shirt, outline, spec) {
      const key = `${look.id}|${role}|${shirt}|${outline}|${spec.dir}|${spec.pose}|${spec.moving ? 1 : 0}|${spec.frame & 3}|${spec.act ?? ''}|${spec.typeFrame ? 1 : 0}|${spec.mouth ? 1 : 0}|${spec.blink ? 1 : 0}`;
      let c = cache.get(key);
      if (!c) {
        c = createCanvas();
        paintGrid(c, addOutline(buildGrid(look, role, spec)), colorsFor(look, role, shirt, outline));
        cache.set(key, c);
      }
      return c;
    },
  };
}
