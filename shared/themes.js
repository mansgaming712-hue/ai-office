// Tema kantor sebagai data (themes/<id>/theme.json). Validator murni, tanpa DOM dan tanpa kode dari tema:
// tema hanya berisi warna, pilihan dari kosakata dekorasi yang tetap, dan sprite kecil (grid teks + peta warna).
// Semua teks tema dirender sebagai teks biasa; warna di-regex ketat (#rrggbb) supaya tidak ada injeksi CSS.
// Dipakai browser (src/office/themeRegistry.js, dimuat saat build) dan test.

export const THEME_LIMITS = Object.freeze({
  maxBytes: 65536, // ukuran JSON tema (setelah di-stringify)
  maxName: 40,
  maxDescription: 200,
  maxSprites: 8,
  maxSpriteSize: 32, // lebar dan tinggi maksimum sprite (piksel art)
  maxSpriteColors: 16,
  maxProps: 8,
});

export const VARIANTS = Object.freeze(['day', 'night']);

/** Kunci palet berwarna solid: nilainya "#rrggbb". */
export const COLOR_KEYS = Object.freeze([
  'floor', 'floorLine', 'floorTick', 'wall', 'wallBase', 'wallBaseHi',
  'winFrame', 'winGlass', 'winHi', 'boardFrame', 'boardFace',
  'doorFrame', 'door', 'doorPanel', 'doorKnob', 'rugA', 'rugB', 'rugStitch',
  'deskTop', 'deskTopHi', 'deskFront', 'deskFrontLo', 'monitorBody', 'screenIdle',
  'chairA', 'chairAHi', 'chairBig', 'chairBigHi', 'tray', 'trayIn',
  'ink', 'inkSoft', 'onRug', 'onDoor', 'onTray',
  'bubbleBorder', 'bubblePaper', 'bubbleWarn', 'bubbleInk', 'bubbleTag', 'bubbleWarnInk',
  'popup', 'popupShadow', 'clockFace', 'clockHand', 'outline',
  'skyTop', 'skyMid', 'skyLow', 'farBldg', 'farBldgHi', 'nearBldg', 'nearBldgHi', 'nearBldgLo', 'bldgWin', 'bldgLit',
  'cloud', 'cloudLo', 'rain', 'beacon', 'glassEdge', 'roadDim', 'carA', 'carB',
  'counterTop', 'counterTopHi', 'counterFront', 'counterFrontLo', 'counterKnob',
  'meetFloor', 'meetFloorLine', 'glassFrame', 'tableTop', 'tableEdge', 'acBody', 'acShade', 'acLed',
  'posterPaper', 'posterInk', 'posterFrame', 'signPaper', 'signInk',
  // dipakai dekorasi tema (neon, lampu, planet, bintang, matahari/bulan)
  'accentA', 'accentB', 'accentC', 'star', 'sun',
]);
/** Kunci palet berwarna transparan: nilainya { "color": "#rrggbb", "alpha": 0..1 }. */
export const ALPHA_KEYS = Object.freeze(['shadow', 'shadowSoft', 'glassWall', 'glassSheen', 'rainTint', 'steam']);
/** Kunci palet berupa bilangan 0..1. */
export const NUMBER_KEYS = Object.freeze(['zoneFill', 'zoneEdge']);
export const PALETTE_KEYS = Object.freeze([...COLOR_KEYS, ...ALPHA_KEYS, ...NUMBER_KEYS]);

/** Kosakata dekorasi: hanya nilai-nilai ini yang bisa digambar renderer (src/office/scene.js). */
export const DECOR_VOCAB = Object.freeze({
  skyline: Object.freeze(['city', 'neon', 'stars', 'hills', 'none']),
  windowStyle: Object.freeze(['classic', 'plain', 'blinds']),
  floor: Object.freeze(['wood', 'tile', 'metal', 'carpet', 'checker']),
  wall: Object.freeze(['plain', 'brick', 'panel', 'stripe', 'circuit']),
  plants: Object.freeze(['leafy', 'cactus', 'crystal', 'none']),
  posters: Object.freeze(['classic', 'neon', 'art', 'none']),
  pantry: Object.freeze(['kopi', 'bar', 'espresso', 'galley']),
  lights: Object.freeze(['none', 'fairy', 'neon', 'pendant', 'strip']),
});
/** Titik pasang sprite (props). Koordinat ada di src/office/scene.js (PROP_SLOTS). */
export const PROP_SLOTS = Object.freeze(['wall-left', 'floor-left', 'floor-center']);
export const SEED_MAX = 9999;

/** Tampilan Jakarta (tampilan asli). Dekorasi yang tidak ditulis tema memakai nilai ini. */
export const DECOR_DEFAULTS = Object.freeze({
  skyline: 'city', windowStyle: 'classic', floor: 'wood', wall: 'plain', plants: 'leafy',
  posters: 'classic', pantry: 'kopi', lights: 'none', seed: 0, props: Object.freeze([]),
});

const TOP_KEYS = ['id', 'name', 'description', 'palette', 'decor', 'sprites'];
const DECOR_KEYS = [...Object.keys(DECOR_VOCAB), 'seed', 'props'];
const HEX = /^#[0-9a-fA-F]{6}$/;
const THEME_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SPRITE_ID = /^[a-z][a-z0-9-]{0,15}$/;
const SPRITE_CHAR = /^[!-~]$/; // satu karakter ASCII tercetak, bukan spasi
const hasControl = (s) => [...s].some((ch) => { const c = ch.codePointAt(0); return c < 32 || (c >= 127 && c <= 159) || c === 8232 || c === 8233; });
const LANG_KEYS = ['en', 'id'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
/** Nama kunci buatan penulis tema dipangkas di pesan error (pesan tidak boleh membengkak). */
const K = (k) => String(k).slice(0, 40);
const own = (o, k) => Object.hasOwn(o, k);
const isHex = (v) => typeof v === 'string' && HEX.test(v);

function checkText(errors, path, v, max) {
  if (typeof v !== 'string') return errors.push(`${path}: harus teks`);
  if (!v.trim()) return errors.push(`${path}: tidak boleh kosong`);
  if (v.trim().length > max) return errors.push(`${path}: maksimal ${max} karakter`);
  if (hasControl(v)) return errors.push(`${path}: tidak boleh berisi karakter kontrol`);
  return undefined;
}

function checkLocalized(errors, path, v, max, required) {
  if (!isObj(v)) return errors.push(`${path}: harus objek {en, id}`);
  for (const k of Object.keys(v)) if (!LANG_KEYS.includes(k)) errors.push(`${path}.${K(k)}: field tidak dikenal`);
  for (const k of LANG_KEYS) {
    if (!own(v, k)) {
      if (required) errors.push(`${path}.${k}: wajib ada`);
      continue;
    }
    checkText(errors, `${path}.${k}`, v[k], max);
  }
  return undefined;
}

function checkPaletteVariant(errors, path, v, complete) {
  if (!isObj(v)) return errors.push(`${path}: harus objek`);
  for (const k of Object.keys(v)) if (!PALETTE_KEYS.includes(k)) errors.push(`${path}.${K(k)}: kunci palet tidak dikenal`);
  for (const k of COLOR_KEYS) if (own(v, k) && !isHex(v[k])) errors.push(`${path}.${k}: harus #rrggbb`);
  for (const k of ALPHA_KEYS) {
    if (!own(v, k)) continue;
    const a = v[k];
    if (!isObj(a)) {
      errors.push(`${path}.${k}: harus objek {color, alpha}`);
      continue;
    }
    for (const kk of Object.keys(a)) if (kk !== 'color' && kk !== 'alpha') errors.push(`${path}.${K(k)}.${K(kk)}: field tidak dikenal`);
    if (!isHex(a.color)) errors.push(`${path}.${k}.color: harus #rrggbb`);
    if (typeof a.alpha !== 'number' || !Number.isFinite(a.alpha) || a.alpha < 0 || a.alpha > 1) errors.push(`${path}.${k}.alpha: harus bilangan 0..1`);
  }
  for (const k of NUMBER_KEYS) {
    if (own(v, k) && (typeof v[k] !== 'number' || !Number.isFinite(v[k]) || v[k] < 0 || v[k] > 1)) errors.push(`${path}.${k}: harus bilangan 0..1`);
  }
  if (complete) for (const k of PALETTE_KEYS) if (!own(v, k)) errors.push(`${path}.${k}: wajib ada (tema lengkap)`);
  return undefined;
}

function checkSprite(errors, path, s) {
  if (!isObj(s)) return errors.push(`${path}: harus objek {colors, rows}`);
  for (const k of Object.keys(s)) if (k !== 'colors' && k !== 'rows') errors.push(`${path}.${K(k)}: field tidak dikenal`);
  const L = THEME_LIMITS;
  let colors = null;
  if (!isObj(s.colors)) errors.push(`${path}.colors: harus objek karakter → #rrggbb atau null`);
  else {
    colors = s.colors;
    const keys = Object.keys(colors);
    if (keys.length === 0 || keys.length > L.maxSpriteColors) errors.push(`${path}.colors: 1 sampai ${L.maxSpriteColors} entri`);
    for (const k of keys) {
      if (!SPRITE_CHAR.test(k)) errors.push(`${path}.colors["${K(k)}"]: kunci harus satu karakter ASCII tercetak`);
      else if (colors[k] !== null && !isHex(colors[k])) errors.push(`${path}.colors["${K(k)}"]: harus #rrggbb atau null (transparan)`);
    }
  }
  if (!Array.isArray(s.rows)) return errors.push(`${path}.rows: harus daftar teks`);
  if (s.rows.length < 1 || s.rows.length > L.maxSpriteSize) return errors.push(`${path}.rows: 1 sampai ${L.maxSpriteSize} baris`);
  if (s.rows.some((row) => typeof row !== 'string')) return errors.push(`${path}.rows: setiap baris harus teks`);
  const width = [...s.rows[0]].length;
  if (width < 1 || width > L.maxSpriteSize) return errors.push(`${path}.rows: lebar 1 sampai ${L.maxSpriteSize}`);
  s.rows.forEach((row, y) => {
    if (typeof row !== 'string') return errors.push(`${path}.rows[${y}]: harus teks`);
    const chars = [...row];
    if (chars.length !== width) return errors.push(`${path}.rows[${y}]: lebar ${chars.length}, harus sama (${width})`);
    for (const ch of chars) {
      if (colors && !own(colors, ch)) {
        errors.push(`${path}.rows[${y}]: karakter "${ch}" tidak ada di peta warna`);
        break;
      }
    }
    return undefined;
  });
  return undefined;
}

/**
 * Validasi tema mentah (hasil JSON.parse). Tidak pernah melempar.
 * @param {unknown} raw
 * @param {{complete?: boolean}} [opts] complete: kedua palet harus memuat SEMUA kunci (tema dasar Jakarta).
 * @returns {{ok: boolean, theme: object|null, errors: string[]}}
 */
export function validateTheme(raw, { complete = false } = {}) {
  const errors = [];
  const L = THEME_LIMITS;
  try {
    if (!isObj(raw)) return { ok: false, theme: null, errors: ['tema harus berupa objek'] };
    let size = 0;
    try {
      size = JSON.stringify(raw).length;
    } catch {
      return { ok: false, theme: null, errors: ['tema tidak bisa diserialisasi'] };
    }
    if (size > L.maxBytes) return { ok: false, theme: null, errors: [`tema terlalu besar (${size} > ${L.maxBytes} karakter)`] };
    for (const k of Object.keys(raw)) if (!TOP_KEYS.includes(k)) errors.push(`${K(k)}: field tidak dikenal`);

    if (typeof raw.id !== 'string' || !THEME_ID.test(raw.id)) errors.push('id: harus huruf kecil/angka/strip, 1-32 karakter');
    checkLocalized(errors, 'name', raw.name, L.maxName, true);
    if (own(raw, 'description')) checkLocalized(errors, 'description', raw.description, L.maxDescription, false);

    if (!isObj(raw.palette)) errors.push('palette: wajib, objek {day, night}');
    else {
      for (const k of Object.keys(raw.palette)) if (!VARIANTS.includes(k)) errors.push(`palette.${K(k)}: field tidak dikenal (day atau night)`);
      for (const v of VARIANTS) {
        if (own(raw.palette, v)) checkPaletteVariant(errors, `palette.${v}`, raw.palette[v], complete);
        else if (complete) errors.push(`palette.${v}: wajib ada`);
      }
    }

    const sprites = {};
    if (own(raw, 'sprites')) {
      if (!isObj(raw.sprites)) errors.push('sprites: harus objek');
      else {
        const ids = Object.keys(raw.sprites);
        if (ids.length > L.maxSprites) errors.push(`sprites: maksimal ${L.maxSprites}`);
        for (const id of ids.slice(0, L.maxSprites + 1)) {
          if (!SPRITE_ID.test(id)) {
            errors.push(`sprites.${K(id)}: id tidak valid`);
            continue;
          }
          const before = errors.length;
          checkSprite(errors, `sprites.${K(id)}`, raw.sprites[id]);
          if (errors.length === before) {
            const s = raw.sprites[id];
            sprites[id] = { w: [...s.rows[0]].length, h: s.rows.length, rows: [...s.rows], colors: { ...s.colors } };
          }
        }
      }
    }

    const decor = { ...DECOR_DEFAULTS, props: [] };
    if (own(raw, 'decor')) {
      const d = raw.decor;
      if (!isObj(d)) errors.push('decor: harus objek');
      else {
        for (const k of Object.keys(d)) if (!DECOR_KEYS.includes(k)) errors.push(`decor.${K(k)}: dekorasi tidak dikenal`);
        for (const [k, allowed] of Object.entries(DECOR_VOCAB)) {
          if (!own(d, k)) continue;
          if (typeof d[k] === 'string' && allowed.includes(d[k])) decor[k] = d[k];
          else errors.push(`decor.${k}: pilih salah satu dari ${allowed.join('|')}`);
        }
        if (own(d, 'seed')) {
          if (Number.isInteger(d.seed) && d.seed >= 0 && d.seed <= SEED_MAX) decor.seed = d.seed;
          else errors.push(`decor.seed: bilangan bulat 0..${SEED_MAX}`);
        }
        if (own(d, 'props')) {
          if (!Array.isArray(d.props)) errors.push('decor.props: harus daftar');
          else if (d.props.length > L.maxProps) errors.push(`decor.props: maksimal ${L.maxProps}`);
          else {
            const used = new Set();
            d.props.forEach((p, i) => {
              const path = `decor.props[${i}]`;
              if (!isObj(p)) return errors.push(`${path}: harus objek {sprite, slot}`);
              for (const k of Object.keys(p)) if (k !== 'sprite' && k !== 'slot') errors.push(`${path}.${K(k)}: field tidak dikenal`);
              const spriteOk = typeof p.sprite === 'string' && own(sprites, p.sprite);
              if (!spriteOk) errors.push(`${path}.sprite: harus id sprite yang valid di "sprites"`);
              const slotOk = typeof p.slot === 'string' && PROP_SLOTS.includes(p.slot);
              if (!slotOk) errors.push(`${path}.slot: pilih ${PROP_SLOTS.join('|')}`);
              else if (used.has(p.slot)) errors.push(`${path}.slot: titik "${p.slot}" sudah dipakai`);
              else used.add(p.slot);
              if (spriteOk && slotOk) decor.props.push({ sprite: p.sprite, slot: p.slot });
              return undefined;
            });
          }
        }
      }
    }

    if (errors.length) return { ok: false, theme: null, errors };
    const theme = {
      id: raw.id,
      name: { en: raw.name.en.trim(), id: raw.name.id.trim() },
      palette: { day: { ...(raw.palette.day ?? {}) }, night: { ...(raw.palette.night ?? {}) } },
      decor,
      sprites,
    };
    if (own(raw, 'description')) {
      const dsc = {};
      for (const k of LANG_KEYS) if (own(raw.description, k)) dsc[k] = raw.description[k].trim();
      theme.description = dsc;
    }
    return { ok: true, theme, errors: [] };
  } catch (e) {
    return { ok: false, theme: null, errors: [`tema tidak bisa diperiksa: ${e?.message ?? e}`] };
  }
}

const hex2 = (n) => n.toString(16).padStart(2, '0');
/** "#rrggbb" + alpha → "rgba(r,g,b,a)". */
export const toRgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
/** "rgba(r,g,b,a)" → {color, alpha} (dipakai untuk membuat theme.json dari palet lama). */
export function fromRgba(str) {
  const m = /^rgba\((\d+),(\d+),(\d+),([\d.]+)\)$/.exec(str);
  if (!m) return null;
  return { color: `#${hex2(+m[1])}${hex2(+m[2])}${hex2(+m[3])}`, alpha: Number(m[4]) };
}

/**
 * Palet siap pakai renderer untuk satu varian: kunci yang tidak ditulis tema diambil dari `base`
 * (palet Jakarta yang sudah diselesaikan). Warna transparan menjadi string rgba(); `night` ikut varian.
 */
export function resolvePalette(theme, variant, base = null) {
  const src = theme.palette?.[variant] ?? {};
  const out = { night: variant === 'night' };
  for (const k of PALETTE_KEYS) {
    if (!own(src, k)) {
      if (!base || !own(base, k)) throw new Error(`palet ${variant}: kunci "${k}" tidak ada`);
      out[k] = base[k];
    } else out[k] = ALPHA_KEYS.includes(k) ? toRgba(src[k].color, src[k].alpha) : src[k];
  }
  return out;
}

/**
 * Muat banyak tema sekaligus. `modules` = hasil import.meta.glob eager: { '/themes/<id>/theme.json': teks JSON mentah | json }.
 * Teks mentah di-parse di sini (try/catch), jadi satu file JSON rusak hanya melewati tema itu dan tidak menggagalkan build.
 * Tema tidak valid dilewati dan dicatat di `problems` ({ file, errors }). Urutan hasil: `defaultId` dulu, lalu menurut id.
 */
export function loadThemes(modules, { defaultId = 'jakarta' } = {}) {
  const themes = [];
  const problems = [];
  const seen = new Set();
  for (const [file, mod] of Object.entries(modules ?? {})) {
    const folder = /\/themes\/([^/]+)\/theme\.json$/.exec(file)?.[1] ?? file;
    let parsed = mod;
    if (typeof mod === 'string') {
      try {
        parsed = JSON.parse(mod);
      } catch (e) {
        problems.push({ file, errors: [`JSON rusak: ${String(e?.message ?? e).slice(0, 120)}`] });
        continue;
      }
    }
    const raw = parsed && typeof parsed === 'object' && 'default' in parsed && !('id' in parsed) ? parsed.default : parsed;
    const res = validateTheme(raw, { complete: folder === defaultId });
    if (!res.ok) {
      problems.push({ file, errors: res.errors });
      continue;
    }
    if (res.theme.id !== folder) {
      problems.push({ file, errors: [`id "${res.theme.id}" tidak sama dengan nama folder "${folder}"`] });
      continue;
    }
    if (seen.has(res.theme.id)) {
      problems.push({ file, errors: [`id "${res.theme.id}" ganda`] });
      continue;
    }
    seen.add(res.theme.id);
    themes.push(res.theme);
  }
  themes.sort((a, b) => (a.id === defaultId ? -1 : b.id === defaultId ? 1 : a.id.localeCompare(b.id)));
  return { themes, problems };
}
