// Data karakter kantor: nama orang Indonesia dan penampilan tiap agen (kulit, rambut, aksesori).
// Warna baju mengikuti warna divisi (shared/roster.js). Nama tampil lewat t() (`office.char.<id>`),
// jadi bisa dibedakan per bahasa; saat ini sama di EN dan ID. Semua desain dibuat sendiri.
import { CEO_ID, MANAGER_ID } from '../../shared/roster.js';
import { divisionOf } from '../divisions.js';
import { hasKey, t } from '../i18n.js';

// Palet karakter terbatas (sama di kedua tema; hanya garis tepi yang mengikuti tema).
export const SKINS = [
  { s: '#f4d3b6', S: '#dcae8c' },
  { s: '#e6b98f', S: '#c99870' },
  { s: '#c98f64', S: '#a8714a' },
  { s: '#9b6a46', S: '#7d5236' },
];
export const HAIRS = {
  black: { h: '#1f1b24', H: '#3a3441' },
  brown: { h: '#4b2f1c', H: '#6b4630' },
  auburn: { h: '#7a3b25', H: '#9a5238' },
  grey: { h: '#8e8f9c', H: '#b3b4c0' },
};
export const HIJABS = [
  { a: '#f0e4d2', A: '#cfbfa6' }, // krem
  { a: '#7fb8a4', A: '#5c9684' }, // hijau mint
  { a: '#c97b9b', A: '#a45c7c' }, // mawar
  { a: '#5c6f9c', A: '#44547c' }, // biru dongker
];
export const HATS = [
  { a: '#2b2f3a', A: '#1a1d26' }, // hitam
  { a: '#c0392b', A: '#8f2a20' }, // merah
  { a: '#e8c45a', A: '#b8962f' }, // kuning
  { a: '#3f6b5a', A: '#2b4c3f' }, // hijau tua
];
export const PANTS = ['#2f3a54', '#4a4f5c', '#5b4a3a'];

/**
 * hair: black|brown|auburn|grey; style: short|side|long|bob|bun|ponytail|curly|buzz;
 * acc: none|hijab|cap|beanie; hijab/hat = indeks warna; glasses, beard = boolean; pants = indeks.
 */
const L = (skin, hair, style, extra = {}) => ({ skin, hair, style, acc: 'none', hijab: 0, hat: 0, glasses: false, beard: false, pants: 0, ...extra });

export const LOOKS = {
  'dev-frontend': L(1, 'black', 'ponytail', { glasses: true, pants: 0 }),
  'dev-backend': L(2, 'black', 'short', { beard: true, pants: 1 }),
  'dev-qa': L(0, 'black', 'short', { acc: 'hijab', hijab: 1, glasses: true, pants: 2 }),
  'dev-security': L(3, 'black', 'short', { acc: 'cap', hat: 0, beard: true, pants: 0 }),
  'dev-ui-critic': L(1, 'auburn', 'bob', { glasses: true, pants: 1 }),
  'dev-devops': L(2, 'brown', 'buzz', { acc: 'beanie', hat: 3, pants: 2 }),
  'dev-docs': L(0, 'black', 'short', { acc: 'hijab', hijab: 0, pants: 0 }),
  'sales-copywriter': L(1, 'black', 'short', { acc: 'hijab', hijab: 2, pants: 1 }),
  'sales-research': L(2, 'brown', 'side', { glasses: true, pants: 0 }),
  'sales-pricing': L(0, 'brown', 'bun', { pants: 2 }),
  'content-script': L(2, 'black', 'curly', { acc: 'cap', hat: 1, pants: 0 }),
  'content-animator': L(1, 'black', 'bun', { glasses: true, pants: 1 }),
  'research-analyst': L(1, 'grey', 'side', { glasses: true, beard: true, pants: 1 }),
  '3d-modeler': L(3, 'black', 'buzz', { glasses: true, pants: 0 }),
  '3d-materials': L(2, 'brown', 'long', { pants: 2 }),
  '3d-animator': L(1, 'black', 'curly', { acc: 'cap', hat: 2, pants: 1 }),
  '3d-render': L(0, 'black', 'short', { acc: 'hijab', hijab: 3, pants: 0 }),
  [MANAGER_ID]: L(2, 'black', 'bun', { glasses: true, pants: 0 }),
  [CEO_ID]: L(1, 'grey', 'side', { pants: 0 }),
};

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const GUEST_STYLES = ['short', 'side', 'curly', 'buzz', 'bob', 'bun'];
const GUEST_HAIR = ['black', 'brown', 'auburn'];

/** Penampilan lengkap untuk agen/peran: dari LOOKS, atau diturunkan dari nama untuk agen tamu. */
export function lookFor(id) {
  const key = String(id);
  const base = LOOKS[key];
  if (base) return { ...base, id: key };
  const h = hash(key);
  return L(h % SKINS.length, GUEST_HAIR[(h >>> 4) % GUEST_HAIR.length], GUEST_STYLES[(h >>> 8) % GUEST_STYLES.length], {
    glasses: (h >>> 12) % 3 === 0,
    pants: (h >>> 14) % PANTS.length,
    id: key,
  });
}

/** Warna baju: warna divisi agen (manajer dan CEO punya setelan sendiri di sprite). */
export function shirtOf(id) {
  return divisionOf(String(id)).color;
}

/** Nama orang untuk agen/peran (lewat t()); agen tamu memakai nama agennya apa adanya. */
export function characterName(id) {
  const key = `office.char.${id}`;
  return hasKey(key) ? t(key) : String(id);
}

/** Peran singkat dari nama agen: "dev-frontend" → "frontend", "3d-render" → "render". */
export function roleOf(id) {
  const s = String(id);
  const i = s.indexOf('-');
  return i > 0 && divisionOf(s).id !== 'other' ? s.slice(i + 1) : s;
}

/** Teks label meja: "Sari · frontend" (agen tamu: nama agennya saja). */
export function deskLabel(id) {
  const name = characterName(id);
  return name === String(id) ? name : `${name} · ${roleOf(id)}`;
}
