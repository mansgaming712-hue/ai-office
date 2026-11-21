// Terjemahan antarmuka (src/i18n.js + locales/*.json): deteksi bahasa, fallback, penyimpanan pilihan,
// kelengkapan kunci ui/office (dibandingkan dinamis EN vs ID), dan teks yang mengikuti bahasa aktif.
// Berjalan di Node (tanpa DOM; window/document distub). Namespace cli diuji di tests/cliI18n.test.js.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUS_INFO, STATUS_LABEL, summaryText } from '../src/agentStatus.js';
import { MESSAGES, loginResult } from '../src/auth.js';
import { parseCommand } from '../src/command.js';
import {
  LANG_STORAGE_KEY, LANGS, detectLang, dictionaries, divisionName, getLang, hasKey, onLangChange,
  readStoredLang, resolveInitialLang, setLang, t, validLang,
} from '../src/i18n.js';
import { Office, STATUS_LABEL as ENGINE_LABEL } from '../src/office/engine.js';
import { ago } from '../src/sessions.js';
import { SCENARIO, SCENARIO_EN, playScenario, scenarioMessage } from '../src/sim/scenario.js';
import { chartBars, formatTokens, warningText } from '../src/usage.js';
import { BANNER_TEXT, CONN_LABEL } from '../src/viewState.js';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const LOCALES_DIR = fileURLToPath(new URL('../locales', import.meta.url));

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v);
    },
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  setLang('id', { persist: false });
});

describe('detectLang', () => {
  it.each([
    [['id-ID', 'en'], 'id'],
    [['id'], 'id'],
    [['in'], 'id'],
    [['in-ID'], 'id'],
    [['ID_id'], 'id'],
    [['en-US', 'id'], 'en'], // entri pertama menentukan
    [['en-US'], 'en'],
    [['fr-FR'], 'en'],
    [['zh-Hant-TW'], 'en'],
    [['ind'], 'en'], // bukan awalan id/in yang sebenarnya
    [[], 'en'],
    [undefined, 'en'],
    [null, 'en'],
    [[null, '', 5, 'id-ID'], 'id'],
    ['id-ID', 'id'],
    ['en-GB', 'en'],
    [42, 'en'],
  ])('%j -> %s', (input, expected) => expect(detectLang(input)).toBe(expected));
});

describe('bahasa awal dan pilihan tersimpan', () => {
  it('browser id-ID -> Indonesia, en-US -> Inggris, tak dikenal -> Inggris', () => {
    const base = { storage: fakeStorage(), browser: true };
    expect(resolveInitialLang({ ...base, languages: ['id-ID'] })).toBe('id');
    expect(resolveInitialLang({ ...base, languages: ['en-US'] })).toBe('en');
    expect(resolveInitialLang({ ...base, languages: ['xx-YY'] })).toBe('en');
  });

  it('pilihan manual di localStorage menang atas deteksi', () => {
    const storage = fakeStorage({ [LANG_STORAGE_KEY]: 'en' });
    expect(resolveInitialLang({ storage, languages: ['id-ID'], browser: true })).toBe('en');
    const storage2 = fakeStorage({ [LANG_STORAGE_KEY]: 'id' });
    expect(resolveInitialLang({ storage: storage2, languages: ['en-US'], browser: true })).toBe('id');
  });

  it('nilai tersimpan yang tidak sah diabaikan', () => {
    for (const bad of ['fr', 'EN', '', 'id-ID', '{}']) {
      expect(readStoredLang(fakeStorage({ [LANG_STORAGE_KEY]: bad }))).toBeNull();
    }
    const storage = fakeStorage({ [LANG_STORAGE_KEY]: 'xx' });
    expect(resolveInitialLang({ storage, languages: ['id'], browser: true })).toBe('id');
  });

  it('penyimpanan yang melempar tidak merusak apa pun', () => {
    const broken = {
      getItem() {
        throw new Error('blocked');
      },
    };
    expect(readStoredLang(broken)).toBeNull();
    expect(resolveInitialLang({ storage: broken, languages: ['en'], browser: true })).toBe('en');
  });

  it('di luar browser (Node/test): Indonesia, kecuali AI_OFFICE_LANG=en', () => {
    const prev = process.env.AI_OFFICE_LANG;
    try {
      delete process.env.AI_OFFICE_LANG;
      expect(resolveInitialLang({ storage: null, languages: ['en-US'], browser: false })).toBe('id');
      process.env.AI_OFFICE_LANG = 'en';
      expect(resolveInitialLang({ storage: null, languages: ['id'], browser: false })).toBe('en');
      process.env.AI_OFFICE_LANG = 'zz';
      expect(resolveInitialLang({ storage: null, languages: ['en'], browser: false })).toBe('id');
    } finally {
      if (prev === undefined) delete process.env.AI_OFFICE_LANG;
      else process.env.AI_OFFICE_LANG = prev;
    }
  });

  it('setLang menyimpan pilihan di kunci ai-office-lang dan mengatur document.documentElement.lang', () => {
    const storage = fakeStorage();
    const doc = { documentElement: { lang: '' } };
    vi.stubGlobal('window', { localStorage: storage });
    vi.stubGlobal('document', doc);
    expect(LANG_STORAGE_KEY).toBe('ai-office-lang');
    expect(setLang('en')).toBe(true);
    expect(getLang()).toBe('en');
    expect(storage.data['ai-office-lang']).toBe('en');
    expect(doc.documentElement.lang).toBe('en');
    expect(setLang('id')).toBe(true);
    expect(storage.data['ai-office-lang']).toBe('id');
    expect(doc.documentElement.lang).toBe('id');
    expect(readStoredLang(storage)).toBe('id');
  });

  it('setLang menolak bahasa tak dikenal dan persist:false tidak menulis', () => {
    const storage = fakeStorage();
    vi.stubGlobal('window', { localStorage: storage });
    expect(setLang('fr')).toBe(false);
    expect(setLang(undefined)).toBe(false);
    expect(getLang()).toBe('id');
    setLang('en', { persist: false });
    expect(storage.data).toEqual({});
  });

  it('setLang tetap jalan saat localStorage melempar', () => {
    vi.stubGlobal('window', {
      get localStorage() {
        throw new Error('blocked');
      },
    });
    expect(setLang('en')).toBe(true);
    expect(getLang()).toBe('en');
  });

  it('onLangChange: dipanggil hanya saat berubah, bisa berhenti, pendengar rusak tidak mengganggu', () => {
    const calls = [];
    const off = onLangChange((l) => calls.push(l));
    onLangChange(() => {
      throw new Error('rusak');
    });
    setLang('en', { persist: false });
    setLang('en', { persist: false });
    setLang('id', { persist: false });
    expect(calls).toEqual(['en', 'id']);
    off();
    setLang('en', { persist: false });
    expect(calls).toEqual(['en', 'id']);
  });

  it('validLang', () => {
    expect(LANGS).toEqual(['en', 'id']);
    expect(validLang('en')).toBe('en');
    expect(validLang('id')).toBe('id');
    expect(validLang('in')).toBeNull();
    expect(validLang(null)).toBeNull();
  });
});

describe('t(): interpolasi dan fallback', () => {
  it('mengikuti bahasa aktif dan bisa dipaksa lewat argumen', () => {
    expect(t('ui.btn.simulate')).toBe('▶ Simulasi');
    expect(t('ui.btn.reset')).toBe('↺ Reset');
    setLang('en', { persist: false });
    expect(t('ui.btn.simulate')).toBe('▶ Simulation');
    expect(t('ui.btn.reset')).toBe('↺ Reset');
    expect(t('ui.btn.simulate', undefined, 'id')).toBe('▶ Simulasi');
  });

  it('interpolasi {nama}; variabel hilang dibiarkan; nilai disisipkan sebagai teks', () => {
    expect(t('ui.cmd.err.mention', { to: 'dev-qa' })).toBe('Tulis tugas untuk @dev-qa.');
    expect(t('ui.cmd.err.mention')).toBe('Tulis tugas untuk @{to}.');
    expect(t('ui.cmd.err.mention', { to: '<b>x</b>' })).toBe('Tulis tugas untuk @<b>x</b>.');
    expect(t('ui.time.minAgo', { n: 0 })).toBe('0 mnt lalu');
  });

  it('kunci tak dikenal: kembali ke kunci itu sendiri; tanpa namespace juga aman', () => {
    expect(t('ui.tidak.ada')).toBe('ui.tidak.ada');
    expect(t('zzz.satu')).toBe('zzz.satu');
    expect(t('polos')).toBe('polos');
    expect(t('')).toBe('');
    expect(t('ui.__proto__')).toBe('ui.__proto__');
    expect(t('ui.constructor')).toBe('ui.constructor');
    expect(hasKey('ui.btn.reset')).toBe(true);
    expect(hasKey('ui.tidak.ada')).toBe(false);
  });

  it('kunci yang hanya ada di Inggris jatuh ke Inggris, lalu ke kunci', () => {
    const name = '__uji_fallback';
    const KEY = `ui.${name}`;
    dictionaries.en.ui[name] = 'English only {x}';
    try {
      expect(t(KEY, { x: 1 }, 'id')).toBe('English only 1');
      expect(t(KEY, { x: 1 }, 'en')).toBe('English only 1');
    } finally {
      delete dictionaries.en.ui[name];
    }
    expect(t(KEY, undefined, 'id')).toBe(KEY);
  });

  it('divisionName: terjemahan zona, cadangan nama roster', () => {
    expect(divisionName({ id: 'dev', name: 'Divisi Dev' })).toBe('Divisi Dev');
    setLang('en', { persist: false });
    expect(divisionName({ id: 'dev', name: 'Divisi Dev' })).toBe('Dev Division');
    expect(divisionName({ id: '3d', name: 'Divisi 3D' })).toBe('3D Division');
    expect(divisionName({ id: 'tak-ada', name: 'Nama Asli' })).toBe('Nama Asli');
  });
});

// ------------------------------------------------------------------ kelengkapan kunci (dinamis)

const keysOf = (dict, ns) => Object.keys(dict[ns] ?? {}).sort();
const varsOf = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('kelengkapan kunci terjemahan (ui dan office, EN vs ID)', () => {
  for (const ns of ['ui', 'office']) {
    it(`setiap kunci en.${ns} ada di id.${ns} dan sebaliknya`, () => {
      const en = keysOf(dictionaries.en, ns);
      const id = keysOf(dictionaries.id, ns);
      expect(en.length).toBeGreaterThan(0);
      expect(en.filter((k) => !id.includes(k))).toEqual([]);
      expect(id.filter((k) => !en.includes(k))).toEqual([]);
    });

    it(`nilai ${ns} berupa teks tidak kosong dan variabel {x} sama di kedua bahasa`, () => {
      for (const k of keysOf(dictionaries.en, ns)) {
        const a = dictionaries.en[ns][k];
        const b = dictionaries.id[ns][k];
        expect(typeof a, `${ns}.${k} en`).toBe('string');
        expect(typeof b, `${ns}.${k} id`).toBe('string');
        expect(a.trim().length, `${ns}.${k} en kosong`).toBeGreaterThan(0);
        expect(b.trim().length, `${ns}.${k} id kosong`).toBeGreaterThan(0);
        expect(varsOf(b), `${ns}.${k}`).toEqual(varsOf(a));
      }
    });

    it(`file locales/*.json: kunci ${ns} sama dengan yang dimuat modul`, () => {
      for (const lang of LANGS) {
        const file = JSON.parse(readFileSync(join(LOCALES_DIR, `${lang}.json`), 'utf8'));
        expect(keysOf(file, ns)).toEqual(keysOf(dictionaries[lang], ns));
      }
    });
  }

  it('label status kanvas (office.status) sama dengan label status UI di setiap bahasa', () => {
    for (const lang of LANGS) {
      const d = dictionaries[lang];
      expect(d.office['status.idle']).toBe(d.ui['status.idle']);
      expect(d.office['status.working']).toBe(d.ui['status.bekerja']);
      expect(d.office['status.done']).toBe(d.ui['status.selesai']);
      expect(d.office['status.blocked']).toBe(d.ui['status.error']);
      expect(d.office['bubble.limitWarning']).toBe(d.ui['usage.warning']);
    }
  });

  it("semua kunci t('ui.…') / t('office.…') yang tertulis di src ada di kamus", () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    const used = new Set();
    for (const f of walk(SRC_DIR).filter((p) => /\.(jsx?|mjs)$/.test(p))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"`]((?:ui|office)\.[A-Za-z0-9_.-]+)['"`]/g)) used.add(m[1]);
    }
    const missing = [...used].filter((k) => !k.endsWith('.') && !hasKey(k, 'id') && !hasKey(k, 'en'));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(0);
  });
});

describe('bundel browser tidak memuat namespace cli', () => {
  it('kamus yang dimuat src/i18n.js hanya berisi ui dan office', () => {
    for (const lang of LANGS) expect(Object.keys(dictionaries[lang]).sort()).toEqual(['office', 'ui']);
    expect(hasKey('cli.apa-saja')).toBe(false);
    expect(t('cli.apa-saja')).toBe('cli.apa-saja');
  });

  it('src/i18n.js mengimpor JSON dengan nama (ui, office), bukan seluruh file', () => {
    const code = readFileSync(join(SRC_DIR, 'i18n.js'), 'utf8');
    expect(code).toMatch(/import \{[^}]*\bui as \w+[^}]*\} from '\.\.\/locales\/en\.json'/);
    expect(code).toMatch(/import \{[^}]*\bui as \w+[^}]*\} from '\.\.\/locales\/id\.json'/);
    expect(code).not.toMatch(/import \w+ from '\.\.\/locales\//);
    expect(code).not.toMatch(/\bcli\b\s+as\b/);
  });

  it('tidak ada modul src yang mengimpor namespace cli atau shared/i18n.js milik server', () => {
    const walk = (dir) =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    for (const f of walk(SRC_DIR).filter((p) => /\.(jsx?|mjs)$/.test(p))) {
      const code = readFileSync(f, 'utf8');
      expect(code, f).not.toMatch(/shared\/i18n/);
      expect(code, f).not.toMatch(/\{[^}]*\bcli\b[^}]*\} from '[^']*locales/);
    }
  });
});

// ------------------------------------------------------------------ teks yang mengikuti bahasa

describe('teks mengikuti bahasa aktif', () => {
  it('label status, ringkasan, koneksi, banner', () => {
    expect(STATUS_LABEL.bekerja).toBe('bekerja');
    expect(summaryText({ idle: 13, bekerja: 3, selesai: 0, error: 1 })).toBe('3 bekerja, 1 error');
    setLang('en', { persist: false });
    expect({ ...STATUS_LABEL }).toEqual({ idle: 'idle', bekerja: 'working', selesai: 'done', error: 'error' });
    expect(STATUS_INFO.selesai.title).toBe('Task done');
    expect(summaryText({ idle: 13, bekerja: 3, selesai: 0, error: 1 })).toBe('3 working, 1 error');
    expect(summaryText({ idle: 17, bekerja: 0, selesai: 0, error: 0 })).toBe('All agents idle');
    expect(summaryText({ idle: 0, bekerja: 0, selesai: 0, error: 0 })).toBe('No agents yet');
    expect(CONN_LABEL.online).toBe('Connected to server');
    expect(BANNER_TEXT.unreachable.title).toBe('Server unreachable');
  });

  it('label kanvas dan bubble engine', () => {
    expect(ENGINE_LABEL.working).toBe('bekerja');
    setLang('en', { persist: false });
    expect({ ...ENGINE_LABEL }).toEqual({ idle: 'idle', working: 'working', done: 'done', blocked: 'error' });
    const o = new Office();
    o.setLimitWarning(true);
    expect(o.managerBubble().text).toBe('Limit almost used up, saving mode');
    expect(o.managerBubble().text).toBe(warningText());
    setLang('id', { persist: false });
    expect(o.managerBubble().text).toBe('Limit hampir habis, hemat mode');
  });

  it('pesan parseCommand, ago, auth, angka dan hari grafik', () => {
    expect(parseCommand('   ').error).toBe('Perintah masih kosong.');
    expect(ago(0, 3 * 60000)).toBe('3 mnt lalu');
    expect(formatTokens(1_234_567)).toBe('1,2 jt');
    expect(chartBars([{ date: '2026-11-09', total: 1 }])[0].weekday).toBe('Sen');
    expect(loginResult(500, {}).error).toBe('Gagal masuk (HTTP 500). Coba lagi.');
    setLang('en', { persist: false });
    expect(parseCommand('   ').error).toBe('The command is empty.');
    expect(parseCommand('@dev-qa').error).toBe('Write a task for @dev-qa.');
    expect(parseCommand('{rusak').error).toBe('Invalid JSON.');
    expect(ago(0, 3 * 60000)).toBe('3 min ago');
    expect(ago(0, 1000)).toBe('just now');
    expect(formatTokens(1_234_567)).toBe('1.2M');
    expect(formatTokens(12_345)).toBe('12.3K');
    expect(formatTokens(845)).toBe('845');
    expect(formatTokens(3_000_000_000)).toBe('3B');
    expect(chartBars([{ date: '2026-11-09', total: 1 }])[0].weekday).toBe('Mon');
    expect(MESSAGES.wrongToken).toBe('Wrong token.');
    expect(loginResult(401, {})).toEqual({ ok: false, error: 'Wrong token.' });
    expect(loginResult(500, {}).error).toBe('Sign-in failed (HTTP 500). Try again.');
    expect(Object.isFrozen(MESSAGES)).toBe(true);
  });

  it('parseCommand menandai jenis perintah (teks / mention / json)', () => {
    expect(parseCommand('Buat landing page')).toMatchObject({ ok: true, kind: 'text', text: 'Buat landing page' });
    expect(parseCommand('@dev-qa tes').kind).toBe('mention');
    expect(parseCommand('{"type":"done","from":"dev-qa","to":"manager"}').kind).toBe('json');
  });
});

describe('skenario simulasi dua bahasa', () => {
  it('SCENARIO_EN punya satu pesan per entri dan tidak sama dengan teks Indonesia', () => {
    expect(SCENARIO_EN).toHaveLength(SCENARIO.length);
    SCENARIO_EN.forEach((m, i) => {
      expect(typeof m).toBe('string');
      expect(m.length).toBeGreaterThan(5);
      expect(m).not.toBe(SCENARIO[i].event.message);
    });
    expect(scenarioMessage(0, 'id')).toBe(SCENARIO[0].event.message);
    expect(scenarioMessage(0, 'en')).toBe(SCENARIO_EN[0]);
  });

  const run = (opts) => {
    const timers = [];
    const events = [];
    playScenario((e) => events.push(e), {
      ...opts,
      schedule: (fn) => timers.push(fn) - 1,
      cancel: () => {},
    });
    timers.forEach((fn) => fn());
    return events;
  };

  it('pesan event dipilih menurut bahasa aktif atau opsi lang', () => {
    expect(run({})[0].message).toBe(SCENARIO[0].event.message);
    setLang('en', { persist: false });
    const en = run({});
    expect(en[0].message).toBe(SCENARIO_EN[0]);
    expect(en).toHaveLength(SCENARIO.length);
    expect(en.every((e) => e.source === 'sim')).toBe(true);
    expect(run({ lang: 'id' })[0].message).toBe(SCENARIO[0].event.message);
  });
});
