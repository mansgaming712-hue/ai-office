// Pemasang/pelepas hook level user (scripts/install-user-hooks.mjs, scripts/uninstall-user-hooks.mjs).
// SELALU memakai file sementara lewat AI_OFFICE_USER_SETTINGS, dan HOME/USERPROFILE juga diarahkan ke
// folder sementara: ~/.claude/settings.json asli tidak pernah disentuh.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  PROJECT_DIR, desiredHooks, hookCommand, hookScriptPath, installAiOfficeHooks, isAiOfficeCommand, nodeCommand, projectProblem,
  removeAiOfficeHooks,
} from '../scripts/user-hooks.mjs';
import { cleanEnv, runNode } from './helpers/testkit.js';

const TMP = mkdtempSync(join(tmpdir(), 'aio-userhooks-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let n = 0;
function sandbox(initial) {
  const dir = join(TMP, `s${++n}`);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  if (initial !== undefined) writeFileSync(file, typeof initial === 'string' ? initial : JSON.stringify(initial, null, 2));
  const env = cleanEnv({ AI_OFFICE_USER_SETTINGS: file, HOME: dir, USERPROFILE: dir });
  const run = (script) => runNode([`scripts/${script}`], { env });
  return {
    dir,
    file,
    install: () => run('install-user-hooks.mjs'),
    uninstall: () => run('uninstall-user-hooks.mjs'),
    read: () => JSON.parse(readFileSync(file, 'utf8')),
    raw: () => readFileSync(file, 'utf8'),
    backups: () => readdirSync(dir).filter((f) => /^settings\.json\.bak-\d{8}-\d{6}(-\d+)?$/.test(f)),
    leftovers: () => readdirSync(dir).filter((f) => f.includes('.tmp-')),
  };
}

const ours = (settings) =>
  Object.values(settings.hooks ?? {}).flatMap((groups) => groups.flatMap((g) => (g.hooks ?? []).filter((h) => isAiOfficeCommand(h.command))));

const USER_SETTINGS = {
  model: 'sonnet',
  permissions: { allow: ['Bash(npm test)'] },
  env: { FOO: 'bar' },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pengguna', timeout: 9 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'notify-send selesai' }] }],
  },
};

describe('logika merge (scripts/user-hooks.mjs)', () => {
  it('command: node absolut (bila ada) + path skrip absolut, forward slash, tanpa CLAUDE_PROJECT_DIR', () => {
    const cmd = hookCommand();
    expect(cmd).toContain(`"${hookScriptPath()}"`);
    expect(hookScriptPath()).not.toContain('\\');
    expect(cmd).not.toContain('CLAUDE_PROJECT_DIR');
    expect(nodeCommand()).toMatch(/node(\.exe)?$/i);
    if (nodeCommand() !== 'node') expect(cmd.startsWith(`"${nodeCommand()}" `)).toBe(true);
    expect(nodeCommand('C:/tidak/ada/node.exe')).toBe('node');
    expect(nodeCommand('C:/x/python.exe')).toBe('node');
    expect(hookCommand({ projectDir: 'C:\\Users\\alice\\ai-office', nodePath: 'node' })).toBe('node "C:/Users/alice/ai-office/hooks/send-event.mjs"');
  });

  it('menerima path proyek di drive mana pun dan path biasa', () => {
    expect(projectProblem('D:\\ai-office')).toBeNull();
    expect(projectProblem('d:/ai-office')).toBeNull();
    expect(projectProblem('D:')).toBeNull();
    expect(projectProblem('C:\\Users\\alice\\ai-office')).toBeNull();
    expect(projectProblem('/home/alice/ai-office')).toBeNull();
    expect(projectProblem('C:\\Users\\alice\\My Project (1)')).toBeNull();
    expect(projectProblem(PROJECT_DIR)).toBeNull(); // folder proyek ini sendiri
  });

  it.each([
    ['kutip ganda', 'C:\\a"b'],
    ['LF', '/home/alice/a\nb'],
    ['CR', '/home/alice/a\rb'],
    ['dolar', '/home/alice/$HOME/ai-office'],
    ['backtick', '/home/alice/`id`/ai-office'],
    ['persen', 'C:\\Users\\%USERNAME%\\ai-office'],
    ['tanda seru', 'C:\\Users\\alice\\ai-office!'],
  ])('menolak path proyek dengan %s', (_nama, path) => {
    expect(projectProblem(path)).toEqual(expect.any(String));
    expect(projectProblem(path)).not.toBe('');
  });

  it('entri AI Office dikenali dari path proyek ini saja (proyek lain tidak disentuh)', () => {
    expect(isAiOfficeCommand(hookCommand())).toBe(true);
    expect(isAiOfficeCommand(`node "${hookScriptPath().toUpperCase()}"`)).toBe(process.platform === 'win32');
    expect(isAiOfficeCommand('node "/home/alice/other/ai-office/hooks/send-event.mjs"')).toBe(false);
    expect(isAiOfficeCommand('node "${CLAUDE_PROJECT_DIR}/hooks/send-event.mjs"')).toBe(false);
    expect(isAiOfficeCommand(undefined)).toBe(false);
  });

  it('install idempoten; uninstall hanya membuang entri AI Office (grup campuran tetap menyimpan hook user)', () => {
    const cmd = hookCommand();
    const first = installAiOfficeHooks(USER_SETTINGS, { command: cmd });
    expect(first.changed).toBe(true);
    expect(ours(first.settings)).toHaveLength(5);
    const second = installAiOfficeHooks(first.settings, { command: cmd });
    expect(second.changed).toBe(false);
    expect(second.settings).toEqual(first.settings);
    // Hook user digabung ke grup AI Office.
    const mixed = structuredClone(first.settings);
    mixed.hooks.SubagentStop[0].hooks.push({ type: 'command', command: 'echo milik-user' });
    const { settings: removed, removed: count } = removeAiOfficeHooks(mixed);
    expect(count).toBe(5);
    expect(removed.hooks.SubagentStop).toEqual([{ hooks: [{ type: 'command', command: 'echo milik-user' }] }]);
    expect(removed.hooks.PreToolUse).toEqual(USER_SETTINGS.hooks.PreToolUse);
    expect(removed.hooks.Stop).toEqual(USER_SETTINGS.hooks.Stop);
    expect(removed.hooks).not.toHaveProperty('SubagentStart');
    // Hanya hook AI Office: objek hooks dihapus seluruhnya.
    expect(removeAiOfficeHooks({ hooks: desiredHooks(cmd) }).settings).toEqual({});
  });
});

describe('npm run hooks:install-user (proses sungguhan, file sementara)', () => {
  it('file belum ada → dibuat (tanpa backup), 5 hook, timeout 3, matcher sama dengan konfigurasi lama', async () => {
    const s = sandbox();
    const r = await s.install();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/dipasang/);
    const st = s.read();
    expect(Object.keys(st.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SubagentStart', 'SubagentStop']);
    expect(st.hooks.PreToolUse.map((g) => [g.matcher, g.hooks[0].async ?? false])).toEqual([['Agent|Task', false], ['^(?!(Agent|Task)$).*', true]]);
    expect(st.hooks.PostToolUse.map((g) => g.matcher)).toEqual(['Agent|Task']);
    for (const h of ours(st)) {
      expect(h).toMatchObject({ type: 'command', timeout: 3 });
      expect(h.command).toBe(hookCommand());
    }
    expect(s.backups()).toEqual([]);
    expect(s.leftovers()).toEqual([]);
  });

  it('settings user: backup dulu (isi sama persis), key dan hook lain utuh, lalu idempoten', async () => {
    const s = sandbox(USER_SETTINGS);
    const original = s.raw();
    const r = await s.install();
    expect(r.code).toBe(0);
    expect(s.backups()).toHaveLength(1);
    expect(readFileSync(join(s.dir, s.backups()[0]), 'utf8')).toBe(original);
    const st = s.read();
    expect(st).toMatchObject({ model: 'sonnet', permissions: USER_SETTINGS.permissions, env: USER_SETTINGS.env });
    expect(st.hooks.Stop).toEqual(USER_SETTINGS.hooks.Stop);
    expect(st.hooks.PreToolUse[0]).toEqual(USER_SETTINGS.hooks.PreToolUse[0]);
    expect(ours(st)).toHaveLength(5);
    const after = s.raw();
    const again = await s.install();
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/sudah terpasang/);
    expect(s.raw()).toBe(after); // tidak ditulis ulang
    expect(s.backups()).toHaveLength(1); // tidak ada backup baru
    expect(s.leftovers()).toEqual([]);
  });

  it('entri AI Office lama (timeout lain) diganti, tidak digandakan', async () => {
    const old = { hooks: { SubagentStop: [{ hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }] }, { hooks: [{ type: 'command', command: 'echo user' }] }] } };
    const s = sandbox(old);
    expect((await s.install()).code).toBe(0);
    const st = s.read();
    expect(ours(st)).toHaveLength(5);
    expect(ours(st).every((h) => h.timeout === 3)).toBe(true);
    expect(st.hooks.SubagentStop).toContainEqual({ hooks: [{ type: 'command', command: 'echo user' }] });
  });

  it.each([
    ['JSON rusak', '{ "model": "sonnet", '],
    ['bukan objek', '[1, 2]'],
    ['hooks bukan objek', '{ "hooks": [] }'],
    ['hooks.X bukan array', '{ "hooks": { "PreToolUse": {} } }'],
  ])('%s → kode 1, pesan jelas, file tidak diubah, tidak ada backup', async (_l, text) => {
    const s = sandbox(text);
    for (const run of [s.install, s.uninstall]) {
      const r = await run();
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/Gagal: .*Tidak ada yang ditulis/);
      expect(s.raw()).toBe(text);
      expect(s.backups()).toEqual([]);
    }
  });

  it('BOM di awal file diterima', async () => {
    const s = sandbox(`\uFEFF${JSON.stringify({ model: 'haiku' })}`);
    expect((await s.install()).code).toBe(0);
    expect(s.read().model).toBe('haiku');
  });
});

describe('npm run hooks:uninstall-user', () => {
  it('hanya entri AI Office yang dihapus, dengan backup; kedua kali tidak ada perubahan', async () => {
    const s = sandbox(USER_SETTINGS);
    await s.install();
    const installed = s.raw();
    const r = await s.uninstall();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/5 hook AI Office dilepas/);
    expect(s.read()).toEqual(USER_SETTINGS);
    expect(s.backups().length).toBeGreaterThanOrEqual(2);
    expect(s.backups().map((b) => readFileSync(join(s.dir, b), 'utf8'))).toContain(installed);
    const again = await s.uninstall();
    expect(again.code).toBe(0);
    expect(again.out).toMatch(/Tidak ada hook AI Office/);
    expect(s.leftovers()).toEqual([]);
  });

  it('file tidak ada → kode 0, tidak membuat file', async () => {
    const s = sandbox();
    const r = await s.uninstall();
    expect(r.code).toBe(0);
    expect(existsSync(s.file)).toBe(false);
  });
});
