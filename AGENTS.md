# Agent Ops contributor guidance

Agent Ops is a local TypeScript workbench for Codex, Claude Code and Kiro CLI.
Use the existing npm scripts and preserve the Korean interface.

## Code map

- `server/index.ts`: CLI commands, process lock and HTTP startup.
- `server/app.ts`, `server/access.ts`: API, static UI, SSE and request guards.
- `server/store.ts`: SQLite persistence, migrations and FTS search.
- `server/providers/`, `server/sync.ts`: bounded, read-only native history import.
- `server/commands.ts`, `server/runner.ts`: CLI arguments and owned process queue.
- `src/`: React UI; `shared/types.ts`: API and persistence contracts.
- `deploy/agent-ops.service`: example systemd service; customize paths locally.

## Development and validation

Node.js 20.19 or later is required. Install with `npm ci`.
Use `npm run dev -- --demo` for isolated sample data.

For application changes, run `npm run check` and relevant browser tests with
`npm run test:e2e`. Install Chromium with `npx playwright install chromium` when
needed. Tests use temporary stores and controlled CLI fixtures, never paid model
inference. Documentation-only changes require link and `git diff --check` review.
Record actual verification results in `docs/verification.md`.

## Invariants

- Keep the listener on loopback. Proxy access requires explicit `--public-url`;
  preserve Host, Origin, local-peer and mutation-header checks.
- Native history is read-only. Preserve session identity, user metadata and
  diagnostics; missing token or cost records must remain unknown.
- Parse history independently of execution. Spawn only supported CLIs with
  argument arrays; cancel only processes owned by this application.
- Keep demo state separate and prevent demo agent execution.
- Keep application data, credentials, exports, dependencies and generated
  artifacts out of Git. Do not publish real conversation screenshots.
- Update relevant README, API and operating docs when behavior changes. Add
  user-visible changes under Unreleased in `CHANGELOG.md`; do not invent releases.

See [the documentation index](docs/README.md) for architecture and operation.
