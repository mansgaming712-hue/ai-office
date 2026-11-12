# Security Policy

## Supported versions

Only the `main` branch receives security fixes. AI Office has no versioned releases yet. Please test against the
latest `main` before you report a problem.

## Reporting a vulnerability

Report security problems privately:

1. Open the [Security tab](https://github.com/mansgaming712-hue/ai-office/security) of this repository.
2. Choose **Report a vulnerability**. This creates a private GitHub Security Advisory that only the maintainers can see.
3. Describe the problem, the steps to reproduce it, and the impact. Include the Node.js version and the operating system.

Do not open a public issue, a pull request, or a discussion for a security problem before the maintainers have
released a fix. Do not include real tokens, passwords, or personal data in the report. Replace them with placeholders
such as `<your-token>`.

The maintainers aim to reply within a reasonable time, but this is a small project and no response time is promised.

## Scope

In scope:

- The local server (`server/`): HTTP routes, the WebSocket, the `Host` and `Origin` checks, body limits, and the
  Content Security Policy.
- Token authentication and session cookies (`server/auth.js`, `server/tokenSource.js`), including open mode.
- The hooks (`hooks/`) and the user-level hook installer (`scripts/user-hooks.mjs`), including the masking of secrets
  before events are sent.
- The autostart scripts (`scripts/autostart.mjs`, `scripts/windows/`).
- The VPS kit in `deploy/` and the guide in `docs/DEPLOY.md`, as far as the scripts themselves are concerned.

Out of scope:

- Problems in Claude Code, Node.js, or third-party packages. Report those to their own projects. If a dependency
  of this project is affected, you may still tell us so that we can update it.
- Problems that need a computer where the attacker already has your user account or can edit your files.
- Settings that the documentation marks as unsafe, for example a token shorter than the minimum or a token stored in
  the project folder.
