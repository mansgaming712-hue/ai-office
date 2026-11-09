// Konfigurasi hook: .claude/settings.json proyek TIDAK lagi memasang hook (supaya sesi dari folder ini
// tidak mengirim event ganda); hook dipasang di level user oleh scripts/install-user-hooks.mjs. Bentuk
// hook yang dipasang (event, matcher, async, timeout) diuji di sini lewat desiredHooks().
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { desiredHooks, hookCommand, hookScriptPath, PROJECT_DIR } from '../scripts/user-hooks.mjs';

const projectSettings = JSON.parse(readFileSync(new URL('../.claude/settings.json', import.meta.url), 'utf8'));
const settings = { hooks: desiredHooks(hookCommand({ projectDir: PROJECT_DIR, nodePath: 'node' })) };
const HOOK_SCRIPT = 'hooks/send-event.mjs';

// Cara Claude Code memilih matcher: huruf/angka/_/-/spasi/,/| = daftar persis; selain itu regex.
function matches(matcher, toolName) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_\-\s,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((s) => s.trim()).includes(toolName);
  return new RegExp(matcher).test(toolName);
}

const commandsFor = (event, tool) =>
  (settings.hooks[event] ?? []).filter((g) => matches(g.matcher, tool)).flatMap((g) => g.hooks);

describe('.claude/settings.json proyek', () => {
  it('JSON valid tanpa blok hooks (hook dipasang di level user: npm run hooks:install-user)', () => {
    expect(projectSettings).toBeTypeOf('object');
    expect(projectSettings).not.toHaveProperty('hooks');
  });
});

describe('hook level user (desiredHooks)', () => {
  it('mendaftarkan SubagentStart, SubagentStop, PreToolUse, PostToolUse', () => {
    expect(Object.keys(settings.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SubagentStart', 'SubagentStop']);
  });

  it('semua perintah memanggil skrip hook yang ada lewat path absolut (forward slash), timeout 3 detik', () => {
    expect(existsSync(fileURLToPath(new URL(`../${HOOK_SCRIPT}`, import.meta.url)))).toBe(true);
    expect(hookScriptPath()).toMatch(/^[A-Za-z]:\/|^\//);
    expect(hookScriptPath()).not.toContain('\\');
    expect(hookScriptPath().endsWith(`/${HOOK_SCRIPT}`)).toBe(true);
    for (const groups of Object.values(settings.hooks)) {
      for (const g of groups) {
        for (const h of g.hooks) {
          expect(h.type).toBe('command');
          expect(h.command).toBe(`node "${hookScriptPath()}"`);
          expect(h.command).not.toContain('CLAUDE_PROJECT_DIR');
          expect(h.timeout).toBe(3);
        }
      }
    }
  });

  it('Agent memicu tepat satu hook sinkron per event; tool lain satu hook async', () => {
    for (const tool of ['Agent', 'Task']) {
      const pre = commandsFor('PreToolUse', tool);
      expect(pre).toHaveLength(1);
      expect(pre[0].async).toBeFalsy();
      expect(commandsFor('PostToolUse', tool)).toHaveLength(1);
    }
    for (const tool of ['Bash', 'Edit', 'Read', 'mcp__x__y', 'AgentX']) {
      const pre = commandsFor('PreToolUse', tool);
      expect(pre, tool).toHaveLength(1);
      expect(pre[0].async).toBe(true);
      expect(commandsFor('PostToolUse', tool)).toHaveLength(0);
    }
  });
});
