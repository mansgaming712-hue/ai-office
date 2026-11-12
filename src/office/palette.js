// Palet kanvas per tema. Terang = kantor siang (palet asli); gelap = kantor malam.
// Hanya warna lingkungan (lantai, dinding, meja, bubble, label); warna divisi, status, dan
// karakter tetap sama di kedua tema supaya maknanya konsisten.
// CONTRAST_PAIRS dipakai tests/theme.test.js: semua teks di kanvas harus lolos WCAG AA (4,5:1).

export const PALETTES = {
  light: {
    night: false,
    floor: '#c9a57a', floorLine: '#b8926a', floorTick: '#bd986f',
    wall: '#e4d6bf', wallBase: '#8f7a5f', wallBaseHi: '#b9a68a',
    winFrame: '#6f5b46', winGlass: '#a9d6f2', winHi: '#c8e7fa',
    boardFrame: '#6d6d6d', boardFace: '#f4f6f4',
    doorFrame: '#5c4330', door: '#7a4f30', doorPanel: '#8a5d3b', doorKnob: '#e8c45a',
    rugA: '#8f3f38', rugB: '#a24d44', rugStitch: '#c9786a',
    deskTop: '#b07a4a', deskTopHi: '#c8915c', deskFront: '#8a5a33', deskFrontLo: '#7a4c2a',
    monitorBody: '#2c2f3a', screenIdle: '#3a4a5e',
    chairA: '#3d4152', chairAHi: '#565b70', chairBig: '#2a2a33', chairBigHi: '#45454f',
    tray: '#6b5a45', trayIn: '#76624a',
    shadow: 'rgba(40,25,10,0.25)', shadowSoft: 'rgba(40,25,10,0.18)',
    ink: '#231c2b', inkSoft: '#3b2f49', onRug: '#fff3e0', onDoor: '#fff6e6', onTray: '#fffdf5',
    zoneFill: 0.16, zoneEdge: 0.45,
    bubbleBorder: '#2a2333', bubblePaper: '#fffdf5', bubbleWarn: '#fff1c9',
    bubbleInk: '#231c2b', bubbleTag: '#5d4f70', bubbleWarnInk: '#3a2a00',
    popup: '#ffe27a', popupShadow: '#2a2333',
    clockFace: '#fffdf5', clockHand: '#2a2333',
  },
  dark: {
    night: true,
    floor: '#3a2f33', floorLine: '#2f2629', floorTick: '#33292d',
    wall: '#2d2a3f', wallBase: '#17141f', wallBaseHi: '#4a4262',
    winFrame: '#15121c', winGlass: '#1b2650', winHi: '#2c3b78',
    boardFrame: '#4a4a55', boardFace: '#d7dbe0',
    doorFrame: '#1d1510', door: '#5a3a24', doorPanel: '#6b4630', doorKnob: '#e8c45a',
    rugA: '#6b2e2c', rugB: '#7d3a35', rugStitch: '#a85d52',
    deskTop: '#8a5f3c', deskTopHi: '#a3774f', deskFront: '#6a4628', deskFrontLo: '#573a20',
    monitorBody: '#15161d', screenIdle: '#2a3446',
    chairA: '#5d6280', chairAHi: '#7a80a0', chairBig: '#4a4a5c', chairBigHi: '#66667c',
    tray: '#4d4034', trayIn: '#5a4a3a',
    shadow: 'rgba(0,0,0,0.35)', shadowSoft: 'rgba(0,0,0,0.28)',
    ink: '#f1e6d2', inkSoft: '#cfc2ad', onRug: '#fff3e0', onDoor: '#fff6e6', onTray: '#fffdf5',
    zoneFill: 0.18, zoneEdge: 0.55,
    bubbleBorder: '#a79bc0', bubblePaper: '#2a2436', bubbleWarn: '#4a2a22',
    bubbleInk: '#f4ecdc', bubbleTag: '#c3b8da', bubbleWarnInk: '#ffe9c9',
    popup: '#ffe27a', popupShadow: '#0f0c14',
    clockFace: '#e9e4d6', clockHand: '#2a2333',
  },
};

export const paletteFor = (theme) => PALETTES[theme] ?? PALETTES.dark;

/** [teks, latar, keterangan]: pasangan warna teks di kanvas yang wajib minimal 4,5:1. */
export const CONTRAST_PAIRS = [
  ['ink', 'floor', 'nama agen di lantai'],
  ['inkSoft', 'floor', 'label status di lantai'],
  ['onRug', 'rugB', 'label manajer di karpet'],
  ['onRug', 'rugA', 'label manajer di karpet (tepi)'],
  ['onDoor', 'doorPanel', 'label CEO di pintu'],
  ['onTray', 'trayIn', 'jumlah surat di baki'],
  ['bubbleInk', 'bubblePaper', 'teks bubble'],
  ['bubbleTag', 'bubblePaper', 'nama proyek di bubble'],
  ['bubbleWarnInk', 'bubbleWarn', 'teks bubble peringatan'],
];
