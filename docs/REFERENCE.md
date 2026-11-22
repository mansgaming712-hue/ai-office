# AI Office: technical reference

This is the detailed reference. For the overview and the quick start, see [README.md](../README.md).
Indonesian version: [REFERENCE.id.md](REFERENCE.id.md).

Contents:

- [Environment variables](#environment-variables)
- [Runner and task API](#runner-and-task-api)
- [Event format and WebSocket](#event-format-and-websocket)
- [Claude Code hooks](#claude-code-hooks)
- [Usage Limit panel](#usage-limit-panel)
- [Authentication, server modes, and the runner key](#authentication-server-modes-and-the-runner-key)
- [Autostart](#autostart)
- [User-made divisions](#user-made-divisions)
- [Office themes and settings](#office-themes-and-settings)
- [Tests and checks](#tests-and-checks)
- [Project structure](#project-structure)

Every value below was taken from the code. File names in parentheses show where to look.

## Environment variables

Variables can be set in the shell, in `.env` (see `.env.example`, loaded by `server/loadEnv.js` without overwriting
variables that already exist), or in the `env` section of Claude Code's settings for hook variables.

### Server (`server/index.js`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. Also used by `npm run open` and by the runner to build the events URL. |
| `HOST` | `127.0.0.1` | Listen address. Anything other than a loopback address (`127.0.0.1`, `localhost`, `::1`) starts open mode. |
| `AI_OFFICE_TOKEN` | empty | Shared secret. Enables token mode. Used first when set. |
| `AI_OFFICE_TOKEN_FILE` | empty | Path to a file with the token (`~` = home folder). Read only when `AI_OFFICE_TOKEN` is empty. A bad file prints a warning and the server runs as if there were no token. |
| `AI_OFFICE_ALLOWED_HOSTS` | empty | Comma-separated host names allowed in the `Host` and `Origin` headers. Setting it starts open mode. |
| `AI_OFFICE_TRUST_PROXY` | empty | Only when `1`: use `X-Real-IP` and `X-Forwarded-Proto` from Nginx. Requires a loopback `HOST`. Counts as open mode. Login needs a valid `X-Real-IP` (otherwise `503`). |
| `AI_OFFICE_DEV_ORIGINS` | empty | Comma-separated dev server origins (for example `http://localhost:5173`) allowed in local mode. In local mode a loopback `Origin` is accepted only for the server's own port or the Vite dev port (5173). Used when developing the UI with `npx vite`. |
| `AI_OFFICE_LOG_MESSAGES` | empty | Only when `1`: event message text is also written to the log. Default: metadata only. |
| `AI_OFFICE_CLAUDE_DIR` | `~/.claude` | Base folder of the Claude Code logs for the [Usage Limit panel](#usage-limit-panel). If it has no `projects/` subfolder, the folder itself is scanned. |
| `AI_OFFICE_LIMIT_CONFIG` | `limit-config.json` in the project root | Path to the limit configuration file. |
| `AI_OFFICE_DIVISIONS_DIR` | `divisions/` in the project root | Folder scanned once, at server start, for user-made divisions (`<id>/division.json` and `<id>/agents/<worker>.md`). A relative path is resolved from the folder where the server starts. Also used by `npm run agents:install` and `npm run agents:validate`. Details: [User-made divisions](#user-made-divisions). |
| `AI_OFFICE_LANG` | from `LC_ALL`, `LC_MESSAGES`, `LANG`, then the system | `id` (or `in`, `ind`) for Indonesian; anything else is English. Sets the language of server and CLI messages, and the default language of runner tasks when the request has no `lang`. |
| `AI_OFFICE_RUNNER` | empty | Set to `1` to enable the runner and the demo in open mode (VPS). Outside open mode the runner is enabled without this variable. |
| `AI_OFFICE_PRINT_KEY` | empty | Set to `1` to print the dashboard URL with the runner key even when stdout is not a terminal. Without it the key is printed only in a terminal, so service logs do not contain it. |
| `AI_OFFICE_RUNNER_KEY_FILE` | `~/.ai-office/runner-key` | Path of the local runner key file (local mode). Mainly for tests. |
| `AI_OFFICE_AUTOSTART_PORT` | `3000` | Port used by the autostart scripts. Only digits are accepted; anything else falls back to `3000`. Set it to the same value as `PORT` when the autostart server must listen on another port. |

### Runner (`server/runner.js`, `server/tasks.js`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_OFFICE_CLAUDE_BIN` | empty | Path to the Claude Code CLI. When set, it is used alone: if the file does not exist, the CLI counts as not found (no fallback to `PATH`). Relative paths are resolved from the current folder. |
| `AI_OFFICE_RUNNER_ALLOWED_TOOLS` | `Agent,WebSearch,WebFetch,TodoWrite` | Comma-separated tool names passed to `--allowedTools`. Each name must match `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (so no specifier such as `Read(...)`); at most 40 names. `Bash`, `PowerShell`, and `mcp__*` are always passed to `--disallowedTools`, whatever this variable says. Adding `Read`, `Write`, `Edit`, `Glob`, or `Grep` here opens the whole disk to the session; the server prints a warning at start when you do. |
| `AI_OFFICE_RUNNER_EXTRA_ARGS` | empty | Extra CLI arguments, separated by spaces (at most 20). Each token is checked against a pattern. Flags that weaken the runner's limits are refused (see [Runner and task API](#runner-and-task-api)). A bad value makes task requests fail with `503`. |
| `AI_OFFICE_RUNNER_TIMEOUT_MS` | `1800000` (30 minutes) | Time limit for one task, in milliseconds. Valid range `100` to `86400000`. Other values use the default. |

The child process does not receive any `AI_OFFICE_RUNNER*` variable, and it does not receive `CLAUDE_PROJECT_DIR`.
The server sets `AI_OFFICE_URL` for the child so that its hooks send events to this server.

**Default tools and why.** The runner reads web pages, so a page can carry a prompt injection. Allow rules without a path
(`Read`, `Write`, `Edit`, `Glob`, `Grep`) would let such a page read `~/.ssh`, `.env`, or the runner key, or write into
`hooks/`, `server/`, or the Startup folder. The default list therefore has only `Agent`, `WebSearch`, `WebFetch`, and
`TodoWrite`. Reading and writing inside the task folder still works: Claude Code reads (`Read`, `Grep`, `Glob`) inside
the working directory without asking, and `--permission-mode acceptEdits` approves `Write` and `Edit` there. Access
outside the folder is refused in `claude -p` because nobody can approve it. `Bash`, `PowerShell`, and every MCP tool
(`mcp__*`) are always denied; a deny rule wins over an allow rule.

**Your own Claude Code settings still apply.** The runner starts your Claude Code CLI, so `permissions.allow` rules in
`~/.claude/settings.json` (and project settings) are still in force for runner sessions. A broad rule there, such as a
bare `Read` or `Write`, widens what the runner can reach. Keep those rules narrow.

**VPS mode warning.** With `AI_OFFICE_RUNNER=1` in open mode, `WebFetch` runs on the server and can reach the server's
network, including internal addresses and the cloud metadata service (SSRF), and a fetched page can inject prompts.
Keep the runner off on a VPS unless you accept this risk.

**Cleanup.** The `output/` folder is never cleaned automatically. Delete old task folders yourself.

### Hook (`hooks/send-event.mjs`)

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_OFFICE_URL` | `http://127.0.0.1:3000/api/events` | Where events are sent. `http://` is allowed only for loopback. Other hosts must use `https://`, otherwise no events are sent. |
| `AI_OFFICE_TOKEN` | empty | Sent as `Authorization: Bearer`. |
| `AI_OFFICE_TOKEN_FILE` | empty | Path to the token file, read when `AI_OFFICE_TOKEN` is empty. A file is not passed to every subprocess, so it is the recommended option. |
| `AI_OFFICE_TIMEOUT_MS` | `800` | Request timeout (maximum 60000). |
| `AI_OFFICE_DEBUG` | empty | `1` shows errors on stderr. The token is never printed. |

### Installer and helper scripts

| Variable | Default | Purpose |
| --- | --- | --- |
| `AI_OFFICE_USER_SETTINGS` | `~/.claude/settings.json` | Settings file that the hook installer writes to or removes from (`scripts/user-hooks.mjs`). For testing only. |
| `AI_OFFICE_URL` | see above | Also used by `npm run demo:hooks`. |

All server variables can also be written in `.env`.

## Runner and task API

The runner lets the dashboard start a real Claude Code session (`claude -p`) as the manager, in a new folder for
each task. The implementation is in `server/runner.js` (CLI detection, arguments, process handling, the stream-json
parser), `server/tasks.js` (task lifecycle, one slot), `server/outputStore.js` (task folders and safe file reads),
`server/runnerKey.js` (runner key), and `server/demo.js` (demo playback).

### What happens when a task starts

1. The server checks the request, the runner configuration, that no other task or demo is running, and that the CLI
   answers `--version` (the result is cached for 30 seconds).
2. It creates the folder `output/<YYYYMMDD-HHMMSS>-<slug>/` in the project root. The slug is built from the title
   (ASCII, lowercase, at most 40 characters). Output folders are ignored by git.
3. It writes `CLAUDE.md` (a copy of `server/templates/task-claude.en.md` for `lang` `en`, or `server/templates/task-claude.md` for `id`, with the language filled in) and `task.md`
   (title, date, language, and the task text). The manager rules in `CLAUDE.md` apply to the run.
4. It starts the CLI with the folder as the working directory:

   ```text
   claude -p --output-format stream-json --verbose --permission-mode acceptEdits \
          --allowedTools <AI_OFFICE_RUNNER_ALLOWED_TOOLS or default> --disallowedTools Bash,PowerShell,mcp__* \
          [AI_OFFICE_RUNNER_EXTRA_ARGS]
   ```

   The task text is sent only through stdin, after a short instruction. It never appears in the command line.
   The process runs without a shell. On Windows, `.cmd` files are started through `cmd.exe` with a fixed command line,
   and `.ps1` files through `powershell -File`.
5. It sends the `assign` event (CEO to manager) and the task message on the WebSocket.

Other facts about a run:

- **One task at a time.** Starting a task or a demo while another runs returns `409`.
- **Timeout.** After `AI_OFFICE_RUNNER_TIMEOUT_MS`, the whole process tree is stopped and the task is `failed`.
- **Cancel.** `POST /api/tasks/<id>/cancel` stops the process tree and sets the task to `cancelled`.
- **Shutdown.** When the server stops, a running task is cancelled and its process tree is killed.
- **Log.** `run.log` in the task folder keeps the CLI's output (stdout, and stderr with a `[stderr]` prefix). It stops at
  5 MB and then writes a truncation line.
- **Result.** When the run ends with exit code `0`, the server reads `RESULT.md`. If Claude Code did not write that file,
  the server writes the result text of the run into it. The summary is the first useful line of the result. A `RESULT.md` larger than 1 MB is not read; the summary then comes from the result text of the run.
- **Blocked result.** If the result text contains `STATUS: BUTUH BANTUAN` (or the English alias `STATUS: NEEDS HELP`),
  the task is still `done`, but the final event is `blocked`, not `report`.
- **Failure.** A non-zero exit code, or a result marked `is_error`, sets the task to `failed` with a `blocked` event.
  The message includes the exit code and a short piece of the stderr output or the result text when there is one.
- **Restart.** A task that was still `running` when the server stopped is shown as `failed` after the restart.
- **Hidden meta file.** Each task folder has `.ai-office-task.json` (status and summary). It is not listed and cannot
  be read through the API.

Task folder contents, for example:

```text
output/20261121-093015-kopi-susu-tiktok/
  CLAUDE.md          manager rules (copied from server/templates/task-claude.md)
  task.md            title, date, language, task text
  run.log            CLI output (at most 5 MB)
  RESULT.md          final report for the CEO
  ...                other files written by the agents
```

### Which events a task sends

Every task event has `"task": "<id>"` and `"source": "api"` (or `"sim"` for the demo).

| When | Event |
| --- | --- |
| Task starts | `assign` from `ceo` to `manager`, message = title |
| Subagent starts | `assign` manager to the agent, then `working` (from the stream, only when the AI Office hooks are not installed) |
| Subagent ends | `done` or `blocked` to `manager` (from the stream, only when the hooks are not installed) |
| Task ends well | `report` from `manager` to `ceo`, message = summary |
| Task ends badly (failed, cancelled, timeout) | `blocked` from `manager` to `ceo`, with the reason |

When the AI Office hooks are installed (see [Claude Code hooks](#claude-code-hooks)), the hooks send the subagent
events, and the server does not send them again. The server's own events (start, end) are always sent.

### Runner status

`GET /api/runner` answers `{ ok, available, reason, keyRequired, version, active }`.

- `available`: `true` when a new task can start now.
- `reason`: `null` when available, otherwise `disabled` (runner off, or invalid `AI_OFFICE_RUNNER_*` configuration),
  `cli-not-found`, or `busy`. In token mode and open mode, a request without authorization gets `null` instead of `busy`.
- `keyRequired`: `true` in local mode (the runner key is needed for the other endpoints).
- `version`: the CLI version string, or `null`. In token mode and open mode, a request without authorization always gets `null`. Local mode is unchanged.
- `active`: the running task `{ id, title, startedAt, kind }`, or `null`. It is shown only to an authorized request.

This endpoint works without the key. The dashboard uses it to decide whether plain text can be sent as a task.

### Endpoints

All endpoints below need the authorization described in
[Authentication, server modes, and the runner key](#authentication-server-modes-and-the-runner-key), except `GET /api/runner`,
which answers without it (without the `active` details). Errors have the form `{ "ok": false, "error": "..." }`.

| Method and path | Body | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/runner` | none | `200` status object (see above) | none |
| `POST /api/tasks` | `{ "text": "...", "lang": "en" \| "id" }` (`lang` optional) | `202 { ok, task: { id, title, status: "running" } }` | `400` bad text, text longer than 2000 characters, bad `lang`; `403` runner disabled; `409` busy; `503` CLI not found or bad runner configuration; `500` folder could not be created |
| `POST /api/demo` | `{ "lang": "en" \| "id" }` (optional) | `202 { ok, task }` | `400` bad `lang`; `403` runner disabled; `409` busy |
| `GET /api/tasks` | none | `200 { ok, tasks: [...] }`, newest first, at most 50 | none |
| `GET /api/tasks/<id>` | none | `200 { ok, task }` with `files: [{ path, bytes }]` and `summary` | `404` not found |
| `GET /api/tasks/<id>/files/<path>` | none | `200` the file as plain text (`text/plain`, sandboxed, `nosniff`) | `400` bad path; `404` not found (also for symbolic links and the hidden meta file); `413` larger than 1 MB; `415` not text |
| `POST /api/tasks/<id>/cancel` | none | `200 { ok: true }` | `404` task not running; `405` wrong method |

Notes:

- `<id>` is the folder name, for example `20261121-093015-kopi-susu-tiktok`. It must match `^[a-z0-9][a-z0-9-]{0,63}$`.
- `<path>` is a relative path inside the task folder. Each segment is percent-encoded. `..`, `.`, empty segments,
  backslashes, colons, control characters, and Windows device names are refused. The file must be a regular file
  whose real path matches the requested path, so symbolic links in the chain are refused.
- `POST` bodies must be `application/json` and at most 64 KB.
- `POST /api/tasks` also refuses text that contains a NUL byte or is empty after trimming.

### Demo

`POST /api/demo` plays a sample task from the server, for about 54 seconds, without Claude Code. It writes the sample
files from `server/demo/<lang>/` into a new task folder and sends the same kind of events as a real task, with
`source: "sim"`. The sample is about a palm sugar iced latte: a TikTok script, a sales caption, and a competitor price
research. The files are `tiktok-script.md`, `caption.md`, `price-research.md` (English) or `riset-harga.md` (Indonesian),
and `RESULT.md`. The dashboard's **Demo** button uses this endpoint. If the runner key is missing or the server does not
support the endpoint, the dashboard falls back to the local simulation.

### Event fields added for tasks

- `task`: the task id (optional, same pattern as the folder name). The dashboard uses it for the **View result** link.
- `source`: `hook`, `sim`, `ui`, or `api`.

### WebSocket message for tasks

Each time a task changes status (start, finish), every WebSocket client receives:

```json
{ "kind": "task", "task": { "id": "20261121-093015-kopi-susu-tiktok", "title": "...", "status": "running", "kind": "task" } }
```

`status` is `running`, `done`, `failed`, or `cancelled`. `kind` is `task` or `demo`. `summary` is present after the
task ends. The dashboard's **Tasks** panel lists these and opens the result viewer.

## Event format and WebSocket

All events (simulation, command box, hooks, and the runner) use one format:

```json
{ "type": "assign", "from": "manager", "to": "dev-frontend", "message": "Build the navbar", "time": "2026-11-21T02:30:00.000Z" }
```

- `type`: `assign` | `working` | `done` | `blocked` | `report`.
- The Indonesian keys `tipe`, `dari`, `ke`, `pesan`, `waktu`, and `sumber` are also accepted.
- `time` may be omitted; the server fills it in. Special names: `manager` and `ceo`.
- Names: lowercase letters, digits, and `- _ . :`, at most 64 characters. `manajer` and `orchestrator` are read as `manager`.
- `message`: one line, at most 500 characters. Control and invisible characters are removed.
- `project` (optional): the name of the Claude Code session folder, up to 64 characters. Set by the hook.
- `tokens` (optional): `{ input, output, cacheRead, cacheCreation }`, only sent with `SubagentStop`.
- `task` (optional): see [Runner and task API](#runner-and-task-api).
- At most 50 events per request.

Send one event by hand:

```bash
curl -X POST http://localhost:3000/api/events \
  -H "Content-Type: application/json" \
  -d '{"type":"done","from":"dev-qa","to":"manager","message":"9 tests passed"}'
```

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/events -ContentType 'application/json' `
  -Body '{"type":"done","from":"dev-qa","to":"manager","message":"9 tests passed"}'
```

In token mode, add `Authorization: Bearer <your-token>` (bash: `-H "Authorization: Bearer $AI_OFFICE_TOKEN"`;
PowerShell: `-Headers @{ Authorization = "Bearer $env:AI_OFFICE_TOKEN" }`).

Identical events (same type, from, to, message, project, and tokens) that arrive within 3 seconds are dropped
by the server. The response is still `202`, with a `duplicates` count.

### Endpoint overview

| Endpoint | Purpose | Token mode |
| --- | --- | --- |
| `POST /api/events` | One event or an array of up to 50. Requires `Content-Type: application/json`. Returns `202 { ok, accepted, ids }`. | Bearer header or session cookie, otherwise `401` |
| `GET /api/events` | The last 300 events. | Bearer header or session cookie, otherwise `401` |
| `GET /api/usage` | `{ ok, usage }`: token usage statistics (local estimate). | Bearer header or session cookie, otherwise `401` |
| `GET /api/divisions` | `{ ok, divisions, errors }`: plugin divisions found at server start (`id`, `name`, `color`, `desks`, `workers`, `source`, and `personalities` when present). `errors` lists skipped folders and ignored personalities as plain text. No file paths or agent text. | Bearer header or session cookie, otherwise `401` |
| `GET /api/health` | `{ ok: true }`. In local mode it also returns `clients` and `events` counts. | open |
| `GET /api/session` | `{ ok, authRequired, authenticated }`. | open |
| `POST /api/login` | Body `{"token":"..."}`. Sets the `aio_session` cookie. Wrong token: `401`. Too many tries: `429`. | open (local mode always returns `{ ok: true }`) |
| `POST /api/logout` | Clears the session cookie in this browser. Requires `Content-Type: application/json` (body may be `{}`). | open |
| Runner and task endpoints | See [Runner and task API](#runner-and-task-api). | Bearer header or session cookie |
| `WS /ws` | Sends `{kind:"hello", events}`, then `{kind:"usage", usage}`, then `{kind:"event", event}`, `{kind:"usage", usage}`, and `{kind:"task", task}` when things change. | Bearer header or session cookie, otherwise `401`. Closed with code `4401` when the session expires. |

Requests are refused with `403` when the `Host` or `Origin` header does not match the server (see
[Authentication, server modes, and the runner key](#authentication-server-modes-and-the-runner-key)).

## Claude Code hooks

The hooks are installed at **user level** (`~/.claude/settings.json`), so they apply to sessions from any folder.
The project file `.claude/settings.json` contains `{}` and installs no hooks.

```bash
npm run hooks:install-user     # install the AI Office hooks into ~/.claude/settings.json
npm run hooks:uninstall-user   # remove the AI Office hooks from ~/.claude/settings.json
```

On Windows, the user settings file is `%USERPROFILE%\.claude\settings.json`.

The installer (`scripts/install-user-hooks.mjs`, shared logic in `scripts/user-hooks.mjs`):

- **Merges, does not overwrite.** Other keys and hooks are kept. Running it several times does not add duplicates.
- **Backs up.** Before writing, the old file is copied to `settings.json.bak-YYYYMMDD-HHMMSS` in the same folder (with `-1`,
  `-2`, and so on added if the name exists). If `settings.json` does not exist yet, no backup is made.
- **Writes atomically** (temporary file, then rename). If the existing JSON is broken or has an unexpected shape, nothing
  is written and the exit code is `1`.
- **Checks the project path.** It refuses a path that contains `"`, a line break, `$`, a backtick, `%`, or `!`,
  because hook commands run through a shell.
- **Uses absolute paths.** The hook command points to the absolute path of `hooks/send-event.mjs`. If you move the
  project, run `npm run hooks:uninstall-user` from the old folder first, then install again from the new one.
- **Applies to new sessions.** Sessions that were already running need to be restarted.
- To test without touching your real settings, set `AI_OFFICE_USER_SETTINGS` to another file.

Hooks that are installed (events and matchers match `desiredHooks` in `scripts/user-hooks.mjs`):

| Hook | AI Office event |
| --- | --- |
| `PreToolUse` with tool `Agent` or `Task` | `assign` from manager to subagent (message = the task description) |
| `SubagentStart` | `working` for the subagent |
| `PreToolUse` with any other tool (async) | `working` from the subagent (or manager), for example `Edit · App.jsx` |
| `SubagentStop` | `done` or `blocked`, read from the `STATUS:` line of the report |
| `PostToolUse` with tool `Agent` or `Task` | `report` or `blocked`, with a summary of the report |

Runtime behaviour:

- Claude Code waits for a hook for at most **3 seconds** (the timeout written by the installer).
- The hook sends the event with an **800 ms** limit (`AI_OFFICE_TIMEOUT_MS`). Events are not retried.
- If the server is down, the hook exits silently with code 0 and prints nothing, so Claude Code is not affected.
  A failed event is not recorded anywhere, unless `AI_OFFICE_DEBUG=1` is set.
- Every event carries `project`: the session folder name (the basename of `CLAUDE_PROJECT_DIR`, or the working
  directory when that variable is empty). The **Active sessions** list shows sessions with an event in the last 10 minutes.
- `SubagentStop` events also carry `tokens`, read from the subagent transcript, for per-agent statistics.
- Common secret patterns (tokens, API keys, passwords) are masked before sending.
- If an identical event (same type, from, to, message, and project) arrives again within 3 seconds, the server drops it.

Test without Claude Code (the server must be running):

```bash
npm run demo:hooks              # sample scenario with about 1.8 s between steps
npm run demo:hooks -- --fast    # no delay
npm run demo:hooks -- --asli    # payload shape of recent Claude Code: background agents, and reports
                                # read from the transcript file through SubagentHandback
```

To send hook events to another server: `AI_OFFICE_URL=http://127.0.0.1:3001/api/events`. Debug output: `AI_OFFICE_DEBUG=1`.

Not tested in this code base: whether the `"env"` section of `~/.claude/settings.json` passes variables to user-level
hooks. Store hook variables in `.env` or in the system environment for now.

## Usage Limit panel

The "Usage limit" panel above the office shows an **estimate** of Claude Code token usage. Official numbers are in
`/usage` inside Claude Code. The panel does not call any model or API.

- **Source:** local logs in `~/.claude/projects/**/*.jsonl` (including `subagents/`). Tokens are read from
  `message.usage`, de-duplicated by `message.id`, and grouped by local hour. Per-agent tokens come from
  `SubagentStop` events (a 7-day window).
- **When it is recalculated:** every 60 seconds, and about 2 seconds after a `SubagentStop` event that carries `tokens`.
- **Weekly formula:** input + output + cache write, plus cache read when `countCacheRead` is `true`.
- **Bar colours:** green below 60%, yellow from 60% to 85%, red above 85%. Above 85%, the panel shows a warning.
  The bar only appears when `weeklyTokenLimit` is above 0.
- **No data:** if the logs cannot be read (folder missing, empty, or in an unknown format), the panel says so and gives the reason.
- **Privacy:** the results and the logs contain only numbers and agent names. No paths, message text, or session names.
- **Cache:** `data/usage-cache.json` and `data/usage-agents.json` are created automatically. `data/` is git-ignored.

### Limit configuration

Put `limit-config.json` in the project root (an example is in `limit-config.example.json`):

```json
{
  "weeklyTokenLimit": 5000000,
  "weekResetDay": 1,
  "weekResetHour": 0,
  "countCacheRead": false
}
```

| Key | Value | Notes |
| --- | --- | --- |
| `weeklyTokenLimit` | a number above 0, or `0` | Estimated weekly token limit. `0` means no limit, and the bar is hidden. |
| `weekResetDay` | `0`–`6` or `null` | Reset day (0 = Sunday, 1 = Monday, ..., 6 = Saturday). `null` = rolling 7-day window. |
| `weekResetHour` | `0`–`23` | Reset hour, local time of the computer. Default `0`. |
| `countCacheRead` | `true` / `false` | `true` = cache-read tokens are counted too. Default `false`. |

The file is read again on every cycle, so the server does not need a restart. Another location can be set with
`AI_OFFICE_LIMIT_CONFIG`. Broken JSON is treated as if the file does not exist.

### CLI and sample data

```bash
npm run usage                 # summary in the terminal (estimate)
npm run usage -- --json       # JSON output, same shape as GET /api/usage -> usage
```

`npm run usage` does not need the server. Its exit code is always `0`, including when no data is available.

Sample data, when there are no real Claude Code logs:

```bash
npm run usage:sample                                             # writes tests/fixtures/usage-sample/
AI_OFFICE_CLAUDE_DIR=tests/fixtures/usage-sample npm run usage   # bash, zsh
```

```powershell
npm run usage:sample
$env:AI_OFFICE_CLAUDE_DIR = "tests\fixtures\usage-sample"; npm run usage; Remove-Item Env:AI_OFFICE_CLAUDE_DIR
```

`npm run usage:sample` deletes the `projects/` folder inside the target folder before it writes new data. Do not
point it at a real Claude Code log folder.

## Authentication, server modes, and the runner key

Always on: the `Host` header is checked (protection against DNS rebinding), `Origin` headers from other sites are
rejected for the API and the WebSocket, request bodies are limited to 64 KB, the page is sent with a strict
Content Security Policy, and the server log records only event metadata (type, sender, recipient, and message length)
unless `AI_OFFICE_LOG_MESSAGES=1`.

The server has three modes.

1. **Local mode** (default, no token). The server listens only on `127.0.0.1` and can be opened only from this computer.
   There is no login, but the runner endpoints need the **runner key** (below).
   - Local mode without a token can be reached by every account and every process on this computer, and the hooks
     send events to whatever process holds port 3000. On a shared or multi-user computer, use token mode
     (set `AI_OFFICE_TOKEN_FILE`). The server prints a warning at start, and the Windows autostart supervisor
     refuses to treat a port 3000 listener owned by another account (or with an unreadable owner) as AI Office.
2. **Token mode.** Active when `AI_OFFICE_TOKEN` or `AI_OFFICE_TOKEN_FILE` is set.
   - The browser shows a token screen. After a correct token, the server sets the `aio_session` cookie (HttpOnly,
     SameSite=Strict, and `Secure` when served over HTTPS or in open mode), valid for 24 hours. The cookie has the form
     `v2.<exp>.<sid>.<sig>` (random signed session id). **Log out** clears the cookie and revokes that session id in
     server memory (lost on restart). Changing the token ends all sessions.
   - Hooks and curl send the header `Authorization: Bearer <token>`.
   - Ten failed logins from one IP address (IPv6: one /64 prefix) within the 15-minute window block that address until the window ends (`429`). With `AI_OFFICE_TRUST_PROXY=1`, a missing or invalid `X-Real-IP` makes login fail with `503` (proxy misconfiguration).
   - The token is never written to logs, responses, or URLs.
   - The runner needs no runner key in this mode. The Bearer header or the session cookie is enough.
3. **Open mode.** Happens when `HOST` is not a loopback address, when `AI_OFFICE_ALLOWED_HOSTS` is set, or when
   `AI_OFFICE_TRUST_PROXY=1`. A token of at least 32 characters is required. Without it, the server refuses to start
   (exit code 1). `AI_OFFICE_TRUST_PROXY=1` is also allowed only with a loopback `HOST` (Nginx on the same machine).
   The runner and the demo are disabled in open mode unless `AI_OFFICE_RUNNER=1`. For internet access, follow
   [`docs/DEPLOY.en.md`](DEPLOY.en.md) (Nginx and HTTPS).

### Runner key (local mode)

- On first start, the server creates a random key (32 bytes, base64url, 43 characters) in `~/.ai-office/runner-key`
  (on Windows: `%USERPROFILE%\.ai-office\runner-key`). Set `AI_OFFICE_RUNNER_KEY_FILE` to use another path.
- Every request to the runner, demo, and task file endpoints must send the header `X-AI-Office-Key: <key>`.
  Without it the response is `401`; with a wrong key it is `403`.
- `npm start` prints `http://localhost:3000/#key=...` when stdout is a terminal. The browser stores the key in
  `sessionStorage` and removes it from the address bar. `npm run open` opens the same URL, or prints it with `--print`. On macOS and Linux it does not pass the key in the command line (other accounts could read it with `ps`): it writes a temporary HTML file (mode `0600`, random name `aio-open-*.html`) in `output/`, opens that file, and deletes it after about 20 seconds (old leftovers are removed on the next run). `--print` and `--dry-run` never create the runner key.
- The key is not printed to logs and is never passed to the child process of a task.
- Without a key, the dashboard still loads and the simulation still works. Only tasks and the demo need the key.
- On POSIX systems the key folder is `0700` and the file is `0600`. On Windows the file lives in the user profile.

Create a strong token (32 random bytes, 43 characters) and run token mode on your own computer.

Bash, zsh (Linux, macOS, Git Bash):

```bash
mkdir -p ~/.ai-office
(umask 077 && npm run -s token > ~/.ai-office/token)
AI_OFFICE_TOKEN_FILE="~/.ai-office/token" npm run serve
```

PowerShell (not tested yet):

```powershell
New-Item -ItemType Directory -Force -Path "$HOME\.ai-office" | Out-Null
npm run -s token > "$HOME\.ai-office\token"
$env:AI_OFFICE_TOKEN_FILE = "$HOME\.ai-office\token"
npm run serve
```

The `-s` flag is required so npm does not add a title line to the file. The token file must contain one line, at most
4 KB, in UTF-8 (with or without BOM) or in UTF-16 with BOM (what `>` produces in Windows PowerShell 5.1). Keep the token
file outside the project folder and never commit it.

## Autostart

Autostart starts the AI Office server when you log in. It is optional. The server listens on `127.0.0.1:3000` in this
setup. Run these commands from the project folder. They work the same in bash, zsh, and PowerShell.

```bash
npm run autostart:install      # install autostart and start the server
npm run autostart:status       # show autostart and server state (read only)
npm run autostart:stop         # stop the server now; autostart stays installed
npm run autostart:uninstall    # remove autostart and stop the server
```

To see what the install would write without changing anything:

```bash
node scripts/autostart.mjs install --dry-run
```

### Windows

- Creates a shortcut named "AI Office" in your user Startup folder. No admin rights needed.
- A hidden launcher (`scripts/windows/start-ai-office.vbs`) runs a supervisor. The supervisor restarts the server
  after a crash, waiting 5, 10, 20, 40, and then 60 seconds. After 8 crashes in a row it stops.
- Server log: `logs/server.log`. When it grows above 5 MB, it moves to `logs/server.log.1`.
- If the server is already running from `npm start` on port 3000, autostart does not start a second copy.

### macOS

- Creates a LaunchAgent at `~/Library/LaunchAgents/com.ai-office.server.plist` and loads it with `launchctl`.
  No admin rights needed.
- Server log: `logs/server.log` in the project folder.

### Linux

- Creates a systemd user unit at `~/.config/systemd/user/ai-office.service`. It needs `systemctl --user`, so a normal
  login session is required.
- To keep the server running without a login (for example on a headless machine), run this yourself. The installer
  does not run it:

  ```bash
  sudo loginctl enable-linger "$USER"
  ```

- Logs: `journalctl --user -u ai-office.service -f`.

### Notes for all platforms

- The installer records the path of the Node.js executable it runs with. If you switch Node.js versions with nvm,
  fnm, asdf, or Volta, run `npm run autostart:install` again. The old path may no longer exist.
- Autostart runs `server/index.js` from the project folder every time you log in, and the user-level hooks run
  `hooks/send-event.mjs` in every Claude Code session. Keep the project in a folder that only your own account can
  write to.

## User-made divisions

Divisions are folders under `divisions/`, or under the folder set in `AI_OFFICE_DIVISIONS_DIR`. The file rules and limits
are in [CONTRIBUTING.md](../CONTRIBUTING.md#adding-a-division). This section lists what the server and the install
scripts enforce.

- **Discovery.** The server reads the folders once, at start (`server/divisions.js`). An invalid division is skipped, and
  its reason is listed in `GET /api/divisions` under `errors`. Limits: 12 plugin divisions, and 1 to 8 workers and 1 to 8
  desks per division.
- **Frontmatter.** A worker file may contain only `name`, `description`, `tools`, and `model`. Other keys, such as `hooks`,
  `mcpServers`, or `permissionMode`, are rejected. The rule also applies to the built-in agents, and `npm run agents:validate`
  checks it.
- **Safe tools.** Plugin workers that use only `Read`, `Glob`, `Grep`, `Write`, `Edit`, `WebSearch`, and `TodoWrite` install
  without a flag. Any other tool, such as `Bash`, `PowerShell`, `WebFetch`, or `NotebookEdit`, is risky.
- **`npm run agents:install`** installs safe plugin workers. A worker that fails validation is skipped and exits with code `3`.
  A risky worker (any tool outside the safe list) that is new, or whose file changed since approval, is skipped with a warning
  and also exits with code `3`. Its file stays in its division folder.
- **Approval** (`--allow-risky-tools`) is tied to the SHA-256 hash of the file, not its name. The command prints each risky
  worker with the first 12 characters of the hash, then records the full hash under `approvedRisky` in
  `~/.claude/agents/.ai-office-installed.json`. Read the `tools:` line of any third-party pack first.
- **Updating an approved worker.** A changed file is skipped again until you approve it. Run `--allow-risky-tools --force`
  after you have read the new file.
- **`--force`** overwrites a file only when `~/.claude/agents/.ai-office-installed.json` lists it and the file on disk still
  has the hash that AI Office recorded. Files you wrote or changed are never overwritten.
- **`npm run setup`** runs every step. When `agents:install` exits with code `3`, setup exits with code `3` too, and names
  the risky workers it could identify at the end.
- **Reserved names.** A division id or a worker name cannot be a Windows device name: `con`, `nul`, `prn`, `aux`, `com0` to
  `com9`, or `lpt0` to `lpt9`.
- **`npm run division:add --from`** prints a warning when the starter uses a risky tool. The `dev-team` starter uses `Bash`,
  and `research-team` uses `WebFetch`.

```bash
npm run agents:install                                  # installs safe workers; skips new or changed risky workers (exit code 3)
npm run agents:install -- --allow-risky-tools           # approves and installs the risky workers it lists
npm run agents:install -- --allow-risky-tools --force   # also updates an approved risky worker whose file changed
npm run agents:install -- --force                       # overwrites only unchanged files that AI Office installed
npm run agents:validate                                 # checks frontmatter, tools, and rule phrases; labels risky workers
```

## Worker personalities

Personalities are optional display data in a division's `division.json`. The file rules and limits are in
[CONTRIBUTING.md](../CONTRIBUTING.md#worker-personalities). This section describes what the server returns and what the
dashboard does with it.

- **Scope.** A personality changes only how a worker looks on the dashboard: nickname, speech bubble, idle habit, and quirk.
  It never enters agent prompts, agent files, task templates, runner arguments, or hooks (`tests/personalityNoLeak.test.js`).
- **`GET /api/divisions`.** A plugin division with valid personalities has a `personalities` object, keyed by worker name,
  with the cleaned values. Every text is `{ "en", "id" }`. A division without personalities has no `personalities` key.
  An ignored personality is listed in `errors` as `{ dir, message }`, where `dir` is the folder name, and the division is
  still listed. The built-in characters are not part of this response. The dashboard uses its own defaults for them
  (`shared/personalities.js`).
- **Neutral default.** A worker without a valid personality has no nickname, no phrases, no tone, no quirk, and the idle
  habit `coffee`.
- **Reduced motion.** With `prefers-reduced-motion: reduce`, idle walks and idle habit animations are off, the moving quirks
  do not run, and the `headphones` quirk stays.

The same identifiers are used in every language. Only the descriptions below are translated.

| Field | Identifiers |
| --- | --- |
| `speech.tone` | `formal`, `casual`, `cheerful`, `calm`, `dry` |
| `idle` | `coffee`, `stretch`, `phone`, `water`, `snack`, `plant`, `window`, `chat` |
| `quirk` | `hum`, `pen-spin`, `desk-tap`, `yawn`, `glasses`, `headphones`, `plant-talk`, `doodle` |

Idle habits. "Walks to pantry" means the worker also goes to the pantry during idle time; the others stay at the desk.

| Identifier | Behaviour |
| --- | --- |
| `coffee` | Sips from a cup. Walks to the pantry. |
| `water` | Drinks from a bottle. Walks to the pantry. |
| `snack` | Eats a snack. Walks to the pantry. |
| `plant` | Waters a plant. Walks to the pantry. |
| `chat` | Waves. Walks to the pantry. |
| `stretch` | Stretches at the desk. |
| `phone` | Looks at a phone at the desk. |
| `window` | Turns to face the window. |

Quirks. A quirk is shown only while the worker is idle or working. Quirks marked "needs a desk" are drawn only for a
character that has a desk.

| Identifier | Drawing |
| --- | --- |
| `hum` | Small notes above the head. |
| `pen-spin` | A red pen spins on the desk. Needs a desk. |
| `desk-tap` | A hand taps the desk. Needs a desk. |
| `yawn` | A yawn above the head. |
| `glasses` | Glasses pose. |
| `headphones` | Headphones on the sprite. Static, so it stays with reduced motion. |
| `plant-talk` | Small green marks by the plant. Needs a desk. |
| `doodle` | A small doodle on the desk. Needs a desk. |

## Office themes and settings

The office background has five built-in themes, and a **Settings** dialog picks the theme, the time mode, the motion
setting, and rain. A theme is a `themes/<id>/theme.json` file: data only, with no code. To write one, see
[Creating a theme](../CONTRIBUTING.md#creating-a-theme).

Where the code is:

- `themes/` (data), `shared/themes.js` (validator and limits)
- `src/office/themeRegistry.js` (loads the themes at build time), `src/office/decor.js` (decoration drawing), `src/office/palette.js` (palettes and `CONTRAST_PAIRS`)
- `src/settings.js` (settings store), `src/ui/SettingsDialog.jsx` (dialog)

### Themes

| Id | Notes |
| --- | --- |
| `jakarta` | Default. The original look. Its `theme.json` defines every palette key, and the other themes fall back to it. |
| `startup-cozy` | Built-in theme. |
| `cyberpunk` | Built-in theme. |
| `kafe` | Built-in theme. |
| `stasiun-luar-angkasa` | Built-in theme. |

The id is the folder name. An invalid theme is skipped with a warning, and the Settings dialog lists it. If the stored
theme id does not match an installed theme, the dashboard shows `jakarta`, and the stored value is kept.

### Settings

The settings are one JSON object in `localStorage` under `ai-office-settings` (see [localStorage keys](#localstorage-keys)).

| Field | Values | Default | Meaning |
| --- | --- | --- | --- |
| `officeTheme` | a theme id | `jakarta` | The office theme. |
| `timeMode` | `follow`, `day`, `night` | `follow` | `follow` uses the light or dark interface theme (light = day, dark = night). `day` and `night` fix the look. |
| `motion` | `system`, `reduce`, `full` | `system` | `system` follows `prefers-reduced-motion`. `reduce` and `full` override it. |
| `rain` | `true`, `false` | `false` | Rain in the office. The checkbox is off and disabled while reduced motion is on. The saved value is kept. |

The root element gets `data-motion="reduce"` or `data-motion="full"`, and the attribute is removed for `system`.

### localStorage keys

| Key | Value | Owner | Notes |
| --- | --- | --- | --- |
| `ai-office-settings` | JSON, for example `{"v":1,"officeTheme":"jakarta","timeMode":"follow","motion":"system","rain":false}` | `src/settings.js` | `v` must be `1`. Unknown fields are dropped when saved. Values longer than 4096 characters, invalid JSON, or another `v` count as corrupt, and the defaults are used. |
| `ai-office-rain` | `"1"` for rain on, anything else for off | `src/settings.js` (legacy) | Read only when `ai-office-settings` does not exist. It is then copied into the new key. The code does not delete it. If `ai-office-settings` exists but is corrupt, the defaults are used, `rain` still reads this key, and nothing is written. |
| `ai-office-lang` | `en` or `id` | `src/i18n.js` | Interface language. Read before the first render. Not part of the settings object. |
| `ai-office-theme` | `dark` or `light` | `src/theme.js` and `public/theme-init.js` | Light or dark interface theme, separate from the office theme. If it is missing or invalid, the system preference is used, and an unknown preference means `dark`. |

All storage access is wrapped in `try`/`catch`. If storage is blocked or full, changes still apply in memory until the
page is reloaded.

Identifiers in this section (theme ids, `follow`, `day`, `night`, `system`, `reduce`, `full`, and the key names) are the
same in the English and Indonesian reference.

## Tests and checks

```bash
npm test                       # Vitest suite (runs the Node version check first)
npm run build                  # build the UI into dist/
npm run smoke                  # start the server on a free port and check GET /api/health
npm run agents:validate        # check the agent files
```

`npm test` covers, among other things: the event format, the hook mapping, the HTTP server and WebSocket, the hook
scripts (real processes), the animation engine and the simulation scenario, agent files (including allowed models),
the hook configuration and installer, token authentication, the runner (`tests/runner.test.js`, which uses the fake
CLI `tests/fixtures/fake-claude.mjs` through `AI_OFFICE_CLAUDE_BIN`, never the real `claude`), the runner key, the
demo, the translations (every key in `locales/en.json` and `locales/id.json`), usage statistics, security regressions,
the autostart script, the Windows supervisor (static checks, plus PowerShell checks when `powershell.exe` exists), and a
static check of the deploy kit (`deploy/` and `docs/DEPLOY.md`). Shell syntax checks of the deploy scripts (`bash -n`)
are skipped when `bash` is not in `PATH`.

CI (`.github/workflows/ci.yml`) runs `npm ci`, `npm run build`, and `npm test` on Ubuntu, Windows, and macOS, with
Node 22.12 and the current LTS. `agents:validate` is not run in CI because it checks `~/.claude/agents`.

## Project structure

```text
agents/                    17 subagent definitions (source), including the 3D division (3d-*.md)
divisions/                your own divisions, one folder each (only README.md ships); see CONTRIBUTING.md
division-packs/           starter packs for npm run division:add (dev-team, content-team, research-team, example-legal)
locales/                   translations: en.json and id.json (namespaces cli, ui, office)
themes/                    office themes, one folder each with theme.json (jakarta is the default); see CONTRIBUTING.md
CLAUDE.md                  manager rules (used by Claude Code when it runs in this folder)
output/                    task and demo results, one folder per run (created automatically, git-ignored)
data/                      usage statistics cache (created automatically, git-ignored)
logs/                      server log from autostart (created automatically, git-ignored)
dist/                      UI build output (npm run build)
docs/                      this reference, DEPLOY.md / DEPLOY.en.md, and images for the README
server/                    HTTP and WebSocket server (app.js, index.js), authentication (auth.js, tokenSource.js),
                           runner (runner.js, tasks.js, runnerKey.js), task folders (outputStore.js), demo
                           (demo.js, demo/<lang>/), task template (templates/task-claude.md), usage (usage.js),
                           .env loader (loadEnv.js), Node version checks (requireNode.js, nodeVersion.js)
shared/                    event format, roster, hook mapping, translations (i18n.js), token usage; used by server, hooks, and UI
hooks/                     Claude Code hook scripts (send-event.mjs, transcript-tokens.mjs)
src/                       React and canvas UI (src/office/ animation and canvas, src/sim/ simulation, src/ui/ components)
scripts/                   setup, agent install and validation, user-level hook installer and remover, open,
                           usage report, hook demo, token generator, autostart, smoke test
scripts/windows/           Windows autostart (launcher, supervisor, install, uninstall, stop)
deploy/                    VPS kit: setup-vps.sh, update.sh, rotate-token.sh, lib.sh, systemd unit, Nginx configs
tests/                     Vitest tests and helpers (tests/helpers/), fixtures (tests/fixtures/)
.github/                   CI workflow, issue templates, and pull request template
reports/                   internal manager reports (git-ignored, except .gitkeep)
```

Top-level files: `README.md` and `README.id.md`, `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`,
`LICENSE` (MIT), `package.json`, `vite.config.js`, `.env.example`, `limit-config.example.json`.
