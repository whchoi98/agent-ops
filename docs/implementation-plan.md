# Agent Ops Implementation Plan

> Execute independent provider and interface work in parallel; keep persistence,
> API, scheduling, and integration under the coordinating implementation.

**Goal:** Deliver a working local operations application for three coding agents.
**Architecture:** Native-source readers normalize history into SQLite. A local
Fastify server serves a React interface and owns a bounded child-process queue.
**Tech stack:** TypeScript, Node 20.19+, React, Vite, Fastify, better-sqlite3,
Vitest, Playwright.
**Spec:** `docs/design.md`

## Global constraints

- No cloud dependency or telemetry.
- Only the three named providers; no arbitrary executable or shell API.
- No live CLI inference during development checks; use controlled executable
  fixtures to prove launching, streaming, cancellation, and recovery.
- Shared interfaces are declared once in `shared/types.ts`.
- Never conflate missing token/cost records with measured zero.
- Original product/source documentation only.
- Keep application data, local history, screenshots of real data, dependencies,
  and test output out of the distributable.

## Task 1: Durable state and search

Files: `server/store.ts`, `server/privacy.ts`, `server/analytics.ts`,
`tests/store.test.ts`.

- [x] Prove upsert, metadata preservation, content/Korean filtering, pagination,
      parameter safety, missing usage handling, and credential redaction with
      temporary SQLite databases.
- [x] Implement schema migrations, indexed sessions/messages, run/events,
      projects, templates, settings, and source fingerprint storage.
- [x] Verify persistence after reopen and reject unsupported future schemas.

## Task 2: Native provider adapters

Files: `server/providers/*`, `tests/providers.test.ts`.
Consumes `ImportedSession` and `Message` from `shared/types.ts`.
Produces `discoverSessions(roots, onSession)` and pure per-provider parsers.

- [x] Test realistic sanitized Codex, Claude, Kiro V1/V2 and JSON fixtures,
      including malformed/truncated records and token deduplication.
- [x] Implement bounded, read-only scanning without symlink traversal.
- [x] Report skipped files/records and maintain stable native session identities.

## Task 3: Execution and API

Files: `server/commands.ts`, `server/runner.ts`, `server/app.ts`,
`server/index.ts`, `tests/commands.test.ts`, `tests/runner.test.ts`,
`tests/api.test.ts`.

- [x] Prove shell-free arguments, read-only policy, resume validation, project
      allowlisting, same-project serialization, concurrency, timeouts,
      cancellation, failure outcomes, and interrupted-process recovery.
- [x] Implement preview/create/cancel/retry/events and contextual handoff APIs.
- [x] Test origin/host/header guards, validation, exports, and demo isolation.
- [x] Build CLI `serve`, `demo`, `sync`, `doctor`, `export` entry points.

## Task 4: Operator interface

Files: `src/*`, `public/*`.
Consumes the shared API contract documented in `docs/api.md`.

- [x] Build overview, sessions/detail/search/filter/compare, runs/logs/new-run,
      projects, analytics, templates, and settings.
- [x] Connect all forms and actions to API results with errors and pending state.
- [x] Add keyboard palette, themes, accessible dialogs and mobile navigation.
- [x] Build and inspect browser views with deterministic isolated demo data.

## Task 5: Integration and delivery

Files: `tests/e2e/*`, `README.md`, `docs/operations.md`, `scripts/*`,
`package.json`.

- [x] Run typecheck, unit/integration suite, production build, browser workflows,
      accessibility/overflow checks, and npm pack/install/start smoke test.
- [x] Run read-only discovery against real installed sources using an isolated
      temporary app database; record only aggregate validation, never transcripts.
- [x] Review requirements and code independently; resolve material findings.
- [x] Document exact supported commands, policies, limitations, and troubleshooting.
- [x] Publish local source and npm archives; no remote publishing or git changes
      are required in this non-repository workspace.
