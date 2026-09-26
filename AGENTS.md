# my-agent-ops contributor guidance

my-agent-ops is a local TypeScript workbench for Codex, Claude Code and Kiro CLI.
Use the existing npm scripts and preserve both Korean and English interfaces.
The npm package is `agent-ops-local`; the CLI and existing data paths use `agent-ops`.

## Code map

- `server/index.ts`: CLI commands, process lock and HTTP startup.
- `server/app.ts`, `server/access.ts`: API, static UI, SSE and request guards.
- `server/store.ts`: SQLite persistence, migrations and FTS search.
- `server/search-index.ts`, `server/maintenance.ts`: compressed search documents
  and explicit offline backup/compaction.
- `server/background-sync.ts`: bounded, owned `agent-ops sync` subprocess.
- `server/productivity/`: versioned work items, context snapshots, saved views
  and parameterized template history; keep native history and schema 4 intact.
- `server/providers/`, `server/sync.ts`: bounded, read-only native history import.
- `server/commands.ts`, `server/runner.ts`: CLI arguments and owned process queue.
- `server/extensions/`: bounded skill/plugin discovery, local analysis and previews;
  `shared/extensions.ts`: public extension contracts.
- `src/`: React UI; `shared/types.ts`: API and persistence contracts.
- `shared/work-items.ts`, `shared/context-packs.ts`, `shared/saved-views.ts`,
  `shared/template-fields.ts`: productivity contracts and bounded local rendering.
- `src/features/runs/RunContext*`: frozen preparation state, context application
  and cancellation; keep explicit command preview and process start separate.
- `src/i18n/`, `src/state/refreshQueue.ts`: explicit UI translations and
  coalesced refresh with one trailing update.
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
- Preserve original transcripts and user text when translating interface labels.
- Offline storage optimization must back up and verify the cache before mutation;
  never migrate a large existing search index during HTTP startup.
- Extension status describes configuration evidence, not invocation. Preserve
  opaque file IDs, owner-root checks, redaction and explicit analysis-run preview.
- Keep application data, credentials, exports, dependencies and generated
  artifacts out of Git. Do not publish real conversation screenshots.
- Update relevant README, API and operating docs when behavior changes. Add
  user-visible changes under Unreleased in `CHANGELOG.md`; do not invent releases.
- Follow `.editorconfig` for touched files; avoid unrelated formatting changes.
- Preserve existing document languages and historical verification. New bilingual
  docs must agree across languages; update indexes and the package's `files`
  manifest when adding linked public documents.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the change workflow and
[the documentation index](docs/README.md) for architecture and operation.
