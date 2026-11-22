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

## Adding a division

A division is a folder of plain data that adds a group of worker agents to the office. The server reads it once, when
it starts. This repository ships with no active division. Your own divisions live in `divisions/`, and you commit them
only in your fork if you choose to.

### Folder structure

```text
divisions/
  legal/                      folder name = division id
    division.json             manifest (required)
    agents/
      legal-reviewer.md       one file per worker: <worker>.md
      legal-drafter.md
```

Plain files directly in `divisions/` (such as `README.md`) and folders whose names start with a dot are ignored.

### division.json

```json
{
  "id": "legal",
  "name": { "en": "Legal", "id": "Hukum" },
  "color": "#8a5a44",
  "desks": 3,
  "workers": ["legal-reviewer", "legal-drafter"],
  "description": "Optional, at most 200 characters"
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `id` | yes | 2 to 32 characters: a lowercase letter first, then lowercase letters, digits, or hyphens (`^[a-z][a-z0-9-]{1,31}$`). Must equal the folder name. Must not be a built-in id: `dev`, `sales`, `content`, `research`, `3d`, `other`, `manager`, `ceo`. Must not be a Windows device name (see below). |
| `name` | yes | Either a string (used in both languages) or an object `{ "en": "...", "id": "..." }`. In the object form, `id` is optional and defaults to `en`. Each text is 1 to 40 characters after trimming, with no control, invisible, or bidirectional characters. No other keys are allowed. |
| `color` | yes | Hex colour `#rrggbb` (six hex digits). Stored in lowercase. |
| `desks` | yes | Whole number from 1 to 8. Must not be less than the number of workers. |
| `workers` | yes | List of 1 to 8 worker names. See the worker rules below. |
| `description` | no | Text of at most 200 characters, with no control or invisible characters. |

The file is at most 16 KB and must contain a JSON object. A field that is not in the table makes the division invalid.
One problem anywhere in the division (the manifest or any worker file) makes the whole division invalid, and the server
skips it. It never loads half of a division.

### Worker names and worker files

Worker names:

- Lowercase letters, digits, and hyphens, starting with a letter or digit (`^[a-z0-9][a-z0-9-]*$`), at most 64 characters.
- Unique inside the division and across all divisions. Divisions are read in folder-name order. A name already used by
  an earlier division is rejected (`workerTaken`).
- Not a built-in agent name from `shared/roster.js`, and not `other`, `manager`, or `ceo`.
- Not a Windows device name: `con`, `nul`, `prn`, `aux`, `com0` to `com9`, or `lpt0` to `lpt9`. The same rule applies to
  division ids.
- A convention that the server does not enforce: start each name with the division id (`legal-reviewer`).

Worker files `agents/<worker>.md`:

- The file name is `<worker>.md`, and the `name` field in the frontmatter must be the same worker name.
- The frontmatter may contain only `name`, `description`, `tools`, and `model`. Any other key (for example `hooks`,
  `mcpServers`, or `permissionMode`) is rejected, because it could install hooks or permissions in `~/.claude`. The same
  rule applies to the built-in agents in `agents/`; `npm run agents:validate` and the test suite check it.
- The frontmatter fields `name`, `description`, `tools`, and `model` are required. `description` is at least 80 characters.
- `model` is `haiku` or `sonnet`.
- `tools` is a comma-separated list with no duplicates, taken from `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`,
  `PowerShell`, `WebSearch`, `WebFetch`, `NotebookEdit`, and `TodoWrite`. `Agent` and `Task` are not allowed, so a worker
  cannot call another agent.
- Tool risk: `Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch`, and `TodoWrite` are the safe tools for plugin workers.
  Any other tool (`Bash`, `PowerShell`, `WebFetch`, `NotebookEdit`, and so on) is risky. See "Installing plugin workers".
- The body must contain these phrases exactly: `Fokus hanya pada keahlianmu`,
  `berhenti dan laporkan ke manajer apa yang kurang dan agen siapa yang dibutuhkan`, `Jangan mencoba memanggil agen lain`,
  `STATUS: SELESAI`, and `STATUS: BUTUH BANTUAN`. The easiest way is to copy the rules sections from any file in `agents/`.
- The file is at most 64 KB.

### Limits

| Limit | Value | What happens above it |
| --- | --- | --- |
| Plugin divisions | 12 | The extra valid divisions are reported as an error and not loaded. Built-in divisions are not counted. |
| Workers per division | 1 to 8 | The division is invalid. |
| Desks per division | 1 to 8 | The division is invalid. |
| `division.json` | 16 KB | The division is invalid. |
| `agents/<worker>.md` | 64 KB | The division is invalid. |
| Folders examined per scan | 100 | The remaining folders are reported as one error. |

The dashboard places the desks three per row. Two plugin divisions sit side by side below the Guest zone.

### Worker personalities

A division may add a `personalities` object to `division.json`. It gives a worker a look on the dashboard: a nickname, a
speech tone with phrases for the speech bubble, an idle habit, and a small quirk. The object is keyed by worker name, and
every key must also appear in `workers`:

```json
"personalities": {
  "legal-reviewer": { "nickname": { "en": "Lena", "id": "Lena" }, "speech": { "tone": "formal" }, "idle": "water" }
}
```

| Field | Required | Rules |
| --- | --- | --- |
| `nickname` | no | Text of at most 16 characters. Used as the worker's name on the dashboard. |
| `traits` | no | List of 0 to 3 texts, each at most 20 characters. The data is validated and stored, but no dashboard element shows it yet. |
| `speech` | no | Object. Only `tone` and `phrases` are allowed. |
| `speech.tone` | no | One of `formal`, `casual`, `cheerful`, `calm`, `dry`. |
| `speech.phrases` | no | List of 0 to 6 texts, each at most 40 characters. When the list is empty, the bubble uses the tone lines from `locales/*.json` (`office.tone.<tone>.1` to `.3`). |
| `idle` | no | One of `coffee`, `stretch`, `phone`, `water`, `snack`, `plant`, `window`, `chat`. Default `coffee`. |
| `quirk` | no | One of `hum`, `pen-spin`, `desk-tap`, `yawn`, `glasses`, `headphones`, `plant-talk`, `doodle`. Default: no quirk. |

Only the fields in this table are allowed. An unknown key, at the top level or inside `speech`, makes that worker's
personality invalid.

Texts:

- A text is either a string, used in both languages, or an object `{ "en": "...", "id": "..." }`. If one language is
  missing, the other one is used for it. Only the keys `en` and `id` are allowed.
- After trimming, a text must not be empty, must not contain control, invisible, or bidirectional characters, and is
  measured in characters (code points).

Invalid data:

- An invalid personality is ignored for that worker only, with a warning. The worker and the division still load, and
  the worker shows the neutral look. The other workers keep their personalities. The server lists each ignored
  personality in the `errors` array of `GET /api/divisions` (as `{ dir, message }`) and writes the same message to the
  server log.
- Two problems still make the whole division invalid: `personalities` that is not an object, and a key that is not
  listed in `workers`. This is the exception to the rule that one problem invalidates the whole division.

Display only:

- Personalities are for the dashboard only. They never enter agent prompts, the worker `.md` files, the task templates,
  the runner arguments, or the hooks. `tests/personalityNoLeak.test.js` checks this. Do not write instructions or
  behaviour rules in a nickname, trait, or phrase. They change how the office looks, not how the agent works.
- A worker without a `personalities` entry looks neutral: its worker name is shown, it has no phrases and no tone, its
  idle habit is `coffee`, and it has no quirk. The 19 built-in characters always have their own defaults.
- With `prefers-reduced-motion: reduce`, idle walks and idle habit animations are off, the moving quirks do not run, and
  the `headphones` quirk stays because it is static.

Worked example: `example-legal`. The starter pack has one full entry and one short entry:

```json
"personalities": {
  "example-legal-reviewer": {
    "nickname": { "en": "Lena", "id": "Lena" },
    "traits": [{ "en": "thorough", "id": "teliti" }, { "en": "cautious", "id": "hati-hati" }],
    "speech": {
      "tone": "formal",
      "phrases": [
        { "en": "Let me read the fine print.", "id": "Saya baca pasal kecilnya dulu." },
        { "en": "Noted, pending review.", "id": "Dicatat, menunggu tinjauan." }
      ]
    },
    "idle": "water",
    "quirk": "glasses"
  },
  "example-legal-drafter": {
    "nickname": "Dito",
    "speech": { "tone": "calm" },
    "idle": "window",
    "quirk": "pen-spin"
  }
}
```

The drafter has no phrases, so its bubble uses the `calm` tone lines. `npm run division:add -- --from <starter>` copies the
`personalities` too, and renames the keys to the new worker names, the same way it renames `workers`. After
`division:add legal -- --from example-legal`, the new `divisions/legal/division.json` has the block with the keys
`legal-reviewer` and `legal-drafter`.

Changing the built-in defaults:

The defaults are in `RAW_DEFAULTS` in `shared/personalities.js`. The exported `DEFAULT_PERSONALITIES` is the same object,
frozen with `deepFreeze`, so change the source and not the export. To change one character:

1. Edit its entry in `RAW_DEFAULTS`. The keys must stay the same 19 ids: the 17 workers, `manager`, and `ceo`.
2. If you change a nickname, change `office.char.<id>` to the same text in both `locales/en.json` and `locales/id.json`.
   `tests/personalities.test.js` checks that they match.
3. Use only existing values. Each tone must be in `TONES`, each `idle` in `IDLE_KINDS`, and each `quirk` in `QUIRKS`
   (`shared/personalities.js`). Each idle and quirk value also needs an entry in `src/office/quirks.js`. Adding a new
   value therefore means writing its animation as well.
4. Keep each built-in character at 1 to 3 traits and 3 to 6 phrases. Phrases must be unique across all characters, and
   nicknames must be unique in each language. Do not copy agent instructions into phrases.
5. Run `npm test`. The checks are in `tests/personalities.test.js` and `tests/personalityNoLeak.test.js`.

### Packs are data, not code

The server reads `division.json` and the agent files as text. It parses the JSON and validates it (`shared/divisions.js`
and `server/divisions.js`). AI Office never imports, requires, evaluates, or executes anything from a division. Symbolic
links and junctions are refused, and every file must resolve inside its own division folder.

Worker files do have an effect outside AI Office. `npm run agents:install` copies them to `~/.claude/agents`, where Claude
Code loads them as subagents with the tools listed in `tools:`. The validator allows `Bash` and `PowerShell`, so the
install step is the place where risky tools are checked. Read every worker file before you install it, and review a pack
written by someone else the way you would review code.

### Installing plugin workers

```bash
npm run agents:install                                    # installs safe workers; skips new or changed risky workers (exit code 3)
npm run agents:install -- --allow-risky-tools             # approves and installs the risky workers it lists
npm run agents:install -- --allow-risky-tools --force     # also updates an approved risky worker whose file changed
npm run agents:install -- --force                         # overwrites only files that AI Office installed and you have not changed
```

- A plugin worker that uses only safe tools is installed without a flag.
- A plugin worker that fails validation is never treated as safe. It is skipped with a warning, and the command exits
  with code `3`.
- A risky worker is one that uses any tool outside the safe list. Approval is tied to the content of the file, not to its
  name. With `--allow-risky-tools`, the command prints each risky worker with the first 12 characters of its SHA-256 hash
  before it writes anything, then records the full hash under `approvedRisky` in
  `~/.claude/agents/.ai-office-installed.json`.
- Without the flag, a risky worker is installed only if its current hash matches an approval. A risky worker that is new,
  or whose file changed after approval, is skipped with a warning, its file stays in the division folder, and the command
  exits with code `3`.
- To update an approved risky worker whose file changed, read the new file, then run `--allow-risky-tools --force`. Force
  still never overwrites a file that you changed yourself.
- `npm run agents:validate` labels each risky plugin worker with `[RISKY: ...]`.
- Built-in agents are not affected by the tool policy.
- `--force` overwrites a file only when `~/.claude/agents/.ai-office-installed.json` lists it and the file on disk still
  has the hash that AI Office recorded. Files you wrote or changed yourself are never overwritten; the command reports
  them and skips them.
- `npm run setup` runs every step. When `agents:install` exits with code `3`, setup finishes and exits with code `3` too,
  and it names the risky workers it could identify at the end. Check the `agents:install` output for the full list.

### Worked example: `example-legal`

The starter pack `division-packs/example-legal` has two workers and works as a template. It is not legal advice.

1. Preview the result. Nothing is written:

   ```bash
   npm run division:add legal -- --from example-legal --dry-run
   ```

   The output lists `divisions/legal/division.json`, `divisions/legal/agents/legal-reviewer.md`, and
   `divisions/legal/agents/legal-drafter.md`.

2. Create the division. The command refuses to write into a folder that already exists:

   ```bash
   npm run division:add legal -- --from example-legal
   ```

   The copy takes its colour, desk count, and description from the starter, and renames the workers to `legal-*`.
   The name is set to `Legal` in both languages.

3. Optional: edit `divisions/legal/division.json` to set your own names, colour, or desks, for example
   `"name": { "en": "Legal", "id": "Hukum" }`.

4. Install the worker files. Both files use only safe tools, so no flag is needed and the command exits with code 0:

   ```bash
   npm run agents:install
   ```

5. Validate. The output ends with a summary line when every agent is valid, unique, and installed:

   ```bash
   npm run agents:validate
   ```

6. Restart the server. Stop the running server first, then start it again:

   ```bash
   npm start
   ```

7. Check the API and the dashboard. In local mode:

   ```bash
   curl http://localhost:3000/api/divisions
   ```

   ```powershell
   Invoke-RestMethod http://localhost:3000/api/divisions
   ```

   In token mode, add the header `Authorization: Bearer <your-token>`. The response contains a `legal` entry with
   `"source": "plugin"`, three desks, the two workers, and an empty `errors` list. On the dashboard, the Legal zone
   appears below the Guest zone.

To remove a division, delete its folder and restart the server. The files already installed in `~/.claude/agents` stay
there. Delete the matching `<worker>.md` files yourself.

### How to test

```bash
npm run division:add <id> -- --from <starter> --dry-run   # preview, writes nothing
npm run agents:install                                     # copy the worker files (exit code 3 if a risky tool was skipped)
npm run agents:validate                                    # check the repo and installed agent files; exit code 1 on problems
npm test                                                   # full suite, including the division tests
```

Run `npm run agents:install` before `npm run agents:validate`. The validator also checks that each plugin agent is
installed, so it exits with code 1 until the install is done. Then restart the server (`npm start`) and check
`GET /api/divisions` and the dashboard, as in step 7 of the example.

### Sending a new starter pack

Starter packs live in `division-packs/`. A pack uses the same format as a division, so `--from` copies it directly.

1. Create `division-packs/<id>/division.json` and `division-packs/<id>/agents/<worker>.md`, following the rules above.
   The folder name is the id.
2. Start every worker name with the id, for example `<id>-<role>`. The existing tests require this, and `--from` renames
   workers based on this prefix.
3. Give each pack 2 to 3 workers. The tests check this range. Declare only the tools a worker needs. A pack with a risky
   tool is still valid, but `division:add --from` prints a warning, and its risky workers install only after approval
   with `--allow-risky-tools`. The `dev-team` pack (Bash) and the `research-team` pack (WebFetch) are current examples.
4. Check the pack with a dry run under a test id:
   `npm run division:add <test-id> -- --from <id> --dry-run`. If the pack is invalid, the command prints the reason.
5. Add the new id to the test lists that name the packs: the list in `tests/divisions.test.js` (the test that checks
   that exactly four packs exist, which you also rename) and the `it.each` list in `tests/divisionAdd.test.js`.
   Without this change, `npm test` fails.
6. Run `npm test`, then open a pull request that describes the pack and what it is for.

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
