# Contributing to AI Office

Thank you for helping. This guide covers how to set up the project, how to send a change, and the rules that
every change must follow. For a first contribution, look for issues labelled
[`good first issue`](https://github.com/mansgaming712-hue/ai-office/issues?q=is%3Aissue+label%3A%22good+first+issue%22).

Please also read the [Code of Conduct](CODE_OF_CONDUCT.md). For security problems, do not open a public issue; see
[SECURITY.md](SECURITY.md).

## Language

The UI text, the server messages, the agent definitions in `agents/`, and most code comments are in Indonesian.
Please keep that style for new text in the same area. Translations of the documentation are welcome, for example
`docs/DEPLOY.md`, which is still Indonesian only.

## Set up your environment

You need Node.js 22.12 or newer (see [Requirements](README.md#requirements)).

```bash
git clone https://github.com/<your-user>/ai-office.git
cd ai-office
npm ci
npm test
npm run build
```

PowerShell uses the same commands. Replace `<your-user>` with your GitHub user name.

Useful commands:

```bash
npm run serve          # run the server with the last build
npm run demo:hooks     # send a sample scenario to a running server
npm run agents:validate
```

## Workflow

1. Fork the repository on GitHub.
2. Create a branch from `main`, for example `fix/speech-bubble-overlap` or `docs/deploy-english`.
3. Make your change. Keep one topic per branch.
4. Run `npm test` and `npm run build`. Both must pass.
5. Open a pull request against `main`. Fill in the pull request template: summary, how to test, and the checklist.

A maintainer may ask for changes before a pull request is merged.

## Commit messages

- Write the subject in the imperative, in English or Indonesian, and keep it under about 72 characters.
- Optionally start the subject with a type: `feat:`, `fix:`, `docs:`, `test:`, `chore:`, or `refactor:`.
- Put the reason for the change in the body when it is not obvious from the diff.
- Do not commit generated files (`dist/`, `data/`, `logs/`) or local files (`.env`, `limit-config.json`).

Example: `fix: keep speech bubble inside the canvas`

## Test rules

- All tests must pass before a pull request is merged (`npm test`). CI runs them on Ubuntu, Windows, and macOS.
- A change in behaviour needs a new or updated test. A bug fix should come with a test that fails before the fix.
- Do not skip or delete a test to make the build pass. If a test is wrong, explain why in the pull request.
- Tests that start real processes (hooks, the server, autostart) must not use port 3000 or touch your real
  `~/.claude/settings.json`. Use the helpers in `tests/helpers/` and `AI_OFFICE_USER_SETTINGS` for that.

## Security rules

- **Never commit secrets.** That includes tokens, API keys, passwords, `.env`, token files, and private paths.
- Test data that looks like a secret must be built at runtime with `glue()` from `tests/helpers/testkit.js`, for
  example `glue('gh', 'p_', value)`. Do not write the complete string in a file. GitHub push protection rejects
  such strings even when they are fake. `tests/noSecretLiterals.test.js` scans every tracked file and fails when it
  finds a literal that matches a known secret pattern.
- Do not add code that calls an AI model or an AI API from the dashboard or from the hooks. The hooks and the
  dashboard only move events. The Usage Limit panel reads local log files and never calls a model.
- Do not put personal data (names, e-mail addresses, host names, or home-folder paths) in code, tests, fixtures,
  or documentation. Use generic examples such as `~/ai-office` or `C:\Users\<name>\ai-office`.
- Changes to authentication, the `Host` and `Origin` checks, or the token handling need a test in `tests/`.

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
5. Mention the new agent in the pull request. If it changes the list in `README.md` and `README.id.md`, update both.

## Good first issues

Issues labelled `good first issue` are small and self-contained. Each one lists the files involved and the
criteria for done. If an issue is unclear, ask in the issue before you start.

## Documentation

Keep `README.md` (English) and `README.id.md` (Indonesian) in the same structure and with the same content. When
you change one, change the other in the same pull request. Every command in the README must exist in `package.json`
or in a script that the README names.

## License

By contributing you agree that your contribution is released under the MIT License (see [LICENSE](LICENSE)).
