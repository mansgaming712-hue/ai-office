# Contributing to AI Office

Thank you for helping. This guide covers how to set up the project, how to test the runner without Claude Code,
how to send a change, and the rules that every change must follow. For a first contribution, look for issues labelled
[`good first issue`](https://github.com/mansgaming712-hue/ai-office/issues?q=is%3Aissue+label%3A%22good+first+issue%22).

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). For security problems, do not open a public issue; see
[SECURITY.md](SECURITY.md).

## Language

The UI is available in English and Indonesian (`locales/en.json` and `locales/id.json`). The code comments, the
server messages, the agent definitions in `agents/`, and most of the documentation are in Indonesian. Keep the style of
the area you change. English documentation lives in `README.md` (English section) and `docs/REFERENCE.md`.

## Set up your environment

You need Node.js 22.12 or newer (see [Requirements](README.md#quick-start)).

```bash
git clone https://github.com/<your-user>/ai-office.git
cd ai-office
npm run setup
npm test
```

`npm run setup` runs `npm ci`, the build, and installs the agents and the user-level hooks into `~/.claude`.
If you only work on the code and do not want to change your Claude Code settings, use `npm ci` and `npm run build`
instead, or `npm run setup -- --no-claude`.

PowerShell uses the same commands. Replace `<your-user>` with your GitHub user name.

Useful commands:

```bash
npm start                # build the UI, then run the server (http://localhost:3000)
npm run serve            # run the server with the last build
npm run demo:hooks       # send a sample scenario to a running server
npm run agents:validate  # check the agent files
npm run open             # open the dashboard with the runner key
```

## Testing the runner without Claude Code

The runner starts the Claude Code CLI (`claude`). For manual tests you can replace it with the fake CLI in
`tests/fixtures/fake-claude.mjs`. It prints the same stream-json lines and never calls a model. Point the server at it
with `AI_OFFICE_CLAUDE_BIN`, and choose the behaviour with `FAKE_CLAUDE_MODE`.

PowerShell:

```powershell
$env:AI_OFFICE_CLAUDE_BIN = "tests\fixtures\fake-claude.mjs"
$env:FAKE_CLAUDE_MODE = "agents"
npm start
```

bash, zsh:

```bash
AI_OFFICE_CLAUDE_BIN=tests/fixtures/fake-claude.mjs FAKE_CLAUDE_MODE=agents npm start
```

Open the dashboard (the link printed by `npm start`), type a plain sentence in the command box, and check the Tasks
panel and the `output/` folder. The modes are `success` (default), `agents` (two subagents, one reports blocked),
`writes-result`, `fail`, `error-result`, `hang`, `hang-tree`, and `flood`. The full list is in the comment at the top of
the file. Stop the server and unset the variables afterwards (`Remove-Item Env:AI_OFFICE_CLAUDE_BIN, Env:FAKE_CLAUDE_MODE`
in PowerShell; `unset` in bash). The automated tests in `tests/runner.test.js` already use this fake CLI, so `npm test`
needs no Claude Code.

## Adding a language

Adding a language needs a translation file and a few code changes. Today the list of languages is fixed in code, so a
new file alone is not enough.

1. Create `locales/<code>.json` (for example `locales/ms.json`) with the three namespaces that already exist in
   `locales/en.json`: `cli` (server, CLI, and scripts), `ui` (dashboard), and `office` (canvas labels). Copy every key
   from `locales/en.json` and translate the values. Keep the placeholders such as `{n}` and `{url}` unchanged.
2. Register the code:
   - `shared/i18n.js`: add it to `LANGS`, and extend `langFromLocale` and `detectLang` if the code should be detected
     from the system locale.
   - `src/i18n.js`: add it to `LANGS`, import its `ui` and `office` namespaces, and add it to `DICTS`.
   - `src/ui/LangToggle.jsx` shows every entry of `LANGS`, so it appears automatically.
3. Update the tests that pin the current list. `tests/i18n.test.js` checks `LANGS` against `['en', 'id']`; change
   that expectation with the new code. The key tests in `tests/i18n.test.js` and `tests/cliI18n.test.js` fail until every
   key of `en.json` also exists in the new file.
4. Run `npm test` and `npm run build`. Check the language switch in the dashboard in a browser.

## Workflow

1. Fork the repository on GitHub.
2. Create a branch from `main`, for example `fix/speech-bubble-overlap` or `docs/reference-update`.
3. Make your change. Keep one topic per branch.
4. Run `npm test` and `npm run build`. Both must pass.
5. Open a pull request against `main`. Fill in the pull request template: summary, how to test, and the checklist.

A maintainer may ask for changes before a pull request is merged.

## Commit messages

- Write the subject in the imperative, in English or Indonesian, and keep it under about 72 characters.
- Optionally start the subject with a type: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, or `refactor:`.
- Put the reason for the change in the body when it is not obvious from the diff.
- Do not commit generated files (`dist/`, `data/`, `logs/`, `output/`) or local files (`.env`, `limit-config.json`).

Example: `fix: keep speech bubble inside the canvas`

## Test rules

- All tests must pass before a pull request is merged (`npm test`). CI runs them on Ubuntu, Windows, and macOS.
- A change in behaviour needs a new or updated test. A bug fix should come with a test that fails before the fix.
- Do not skip or delete a test to make the build pass. If a test is wrong, explain why in the pull request.
- Tests that start real processes (hooks, the server, autostart, the runner) must not use port 3000 or touch your real
  `~/.claude/settings.json`. Use the helpers in `tests/helpers/` (for example `runnerkit.js` for the runner) and
  `AI_OFFICE_USER_SETTINGS` for the settings file.

## Security rules

- **Never commit secrets.** That includes tokens, API keys, passwords, `.env`, token files, runner keys, and private paths.
- Test data that looks like a secret must be built at runtime with `glue()` from `tests/helpers/testkit.js`, for
  example `glue('gh', 'p_', value)`. Do not write the complete string in a file. GitHub push protection rejects
  such strings even when they are fake. `tests/noSecretLiterals.test.js` scans every tracked file and fails when it
  finds a literal that matches a known secret pattern.
- Do not add code that calls an AI model or an AI API from the dashboard or from the hooks. The hooks and the
  dashboard only move events. The Usage Limit panel reads local log files and never calls a model.
- Do not put personal data (names, e-mail addresses, host names, or home-folder paths) in code, tests, fixtures,
  or documentation. Use generic examples such as `~/ai-office` or `C:\Users\<name>\ai-office`.
- Changes to authentication, the `Host` and `Origin` checks, the runner key, or the token handling need a test in `tests/`.

## Adding an agent

An agent is a Markdown file with frontmatter. The roster must list the same name.

1. Create `agents/<name>.md`. Use a lowercase kebab-case name. The file name and the `name:` field must match.
   Set `model:` to `haiku` or `sonnet`. Other models are rejected.
2. Add the name to the right division in `shared/roster.js`. `tests/agents.test.js` checks that the roster and the
   files match.
3. Run the validation:

   ```bash
   npm run agents:validate
   ```

   It checks the frontmatter, unique names, the allowed models, the specialist rules that every agent must include,
   and whether the agent is installed in `~/.claude/agents`.
4. Run `npm test`. Run `npm run agents:install` on your own machine to try the agent with Claude Code.
5. Mention the new agent in the pull request. If it changes the Agents table, update the English section of `README.md`,
   the Indonesian section of `README.md`, and `README.id.md` (both Indonesian copies must match).

## Good first issues

Issues labelled `good first issue` are small and self-contained. Each one lists the files involved and the
criteria for done. If an issue is unclear, ask in the issue before you start.

## Documentation

- `README.md` has two sections: English first, then Indonesian. `README.id.md` is the Indonesian section on its own.
  The two Indonesian texts must stay identical. When you change one, change the other in the same pull request.
  `tests/localModeOwner.test.js` checks that the local-mode warning is still in both files.
- Technical details (hooks, API, environment variables, autostart, tests, project structure) are in `docs/REFERENCE.md`
  (English) and `docs/REFERENCE.id.md` (Indonesian). Change both when a behaviour or a variable changes.
- Every command in the documentation must exist in `package.json` or in a script that the documentation names.
  Check the environment variables against the code (`server/`, `hooks/`, `scripts/`), not against memory.
- `docs/DEPLOY.md` (Indonesian) and `docs/DEPLOY.en.md` (English) describe the VPS deployment. Translations are welcome.

## License

By contributing you agree that your contribution is released under the MIT License (see [LICENSE](LICENSE)).
