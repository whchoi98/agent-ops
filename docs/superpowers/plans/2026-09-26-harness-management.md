# Harness Management Implementation Plan

> **For agentic workers:** Use $subagent-driven-development or $executing-plans to implement the tasks. Keep each write scope separate and use the shared contract.

**Goal:** Integrate usable AutoHarness management under Analysis and management.

**Architecture:** A bounded local service reads policy and audit evidence and invokes
an optional Python engine only for explicit actions. A packaged bridge adapts
native hook protocols, while the React page keeps discovery, evaluation and
observed events separate.

**Tech Stack:** TypeScript, Node.js 20.19+, Fastify, React, existing YAML parser,
optional Python 3.10+ and AutoHarness 0.1.1.

**Spec:** [Harness management](../specs/2026-09-26-harness-management.md)

## Global Constraints

- Preserve SQLite schema 4, native history, existing CLI policies and proxy guards.
- No new npm dependency, model inference, automatic native hook activation or hook-trust bypass.
- Use `shared/harness.ts` for all public interfaces.
- Keep original policy text and user input out of translation and redact secrets.
- Bound policy bytes, process lifetime and output, audit reads and retained records.
- Verify with synthetic stores and controlled processes; keep real data out of Git.
- Maintain Korean/English copy, both themes, keyboard support and phone layouts.

## Task 1: Policies and audit evidence

**Files:** `server/harness/io.ts`, `policy.ts`, `audit.ts`,
`tests/harness-policy.test.ts`, `tests/harness-audit.test.ts`.

**Interfaces:** Export `HarnessPolicyStore` and `HarnessAuditReader` using the exact
internal signatures documented in the implementation handoff and the shared public types.

- [x] Write failing cases for scope escapes, aliases, invalid YAML, source redaction,
  expected-revision conflicts and app-owned policy creation.
- [x] Implement source discovery, immutable reads and atomic managed-policy writes with backups.
- [x] Write failing cases for appended/partial JSONL, rotation, truncation, invalid
  lines, filters, bounded retention and original-source preservation.
- [x] Implement incremental audit queries with explicit retained-window totals.
- [x] Run `npm test -- --maxWorkers=2 tests/harness-policy.test.ts tests/harness-audit.test.ts`.

## Task 2: Optional engine and native hooks

**Files:** `server/harness/runtime.ts`, `bridge.py`, `hooks.ts`,
`tests/harness-runtime.test.ts`, `tests/harness-hooks.test.ts`.

**Interfaces:** Export runtime probe/evaluate/validate operations and
`HarnessHookManager` preview/apply/list operations. Return the shared result shapes.

- [x] Write failing tests that prove requests never execute the supplied command,
  time out boundedly and clean up only owned processes.
- [x] Implement the optional Python bridge and verify allow, ask and deny against
  the pinned upstream engine in an isolated Python environment.
- [x] Write failing tests for three native client protocols, preservation of ask,
  unattended denial, audit provenance and bounded log rotation.
- [x] Implement previewed project-scoped hook edits with exact-file fingerprints,
  backups, idempotence and removal of only app-owned entries.
- [x] Run focused runtime and hook tests, including cancellation and concurrent edits.

## Task 3: Management page

**Files:** `src/pages/Harness.tsx`, `src/features/harness/`,
`src/i18n/harness.en.ts`, focused component/request tests.

**Interfaces:** Consume `/api/harness` and the public contract. Use project IDs and
opaque policy/preview IDs, not browser-provided filesystem paths.

- [x] Add failing component/request cases for missing runtime, invalid input,
  stale responses after project selection, draft preservation and mutation failure.
- [x] Implement installation state, policy reader/editor and validation, actual
  decision test, hook preview/apply/remove and filtered audit table.
- [x] Keep mutation retries explicit and distinguish cached-window totals.
- [x] Verify keyboard access, bilingual content and responsive layouts.

## Task 4: Application integration and delivery

**Files:** `server/harness/service.ts`, `routes.ts`, `demo.ts`, `server/app.ts`,
`scripts/build.ts`, navigation/i18n, `tests/harness-api.test.ts`,
`tests/e2e/harness.spec.ts`, package smoke script and project documents.

- [x] Wire settings, project revalidation, services, request guards and lifecycle.
- [x] Package the Python bridge and expose the menu, page title and deep link.
- [x] Verify APIs, missing-engine behavior, demo isolation and complete browser flows.
- [x] Add the bilingual guide and synchronize README, CHANGELOG and version.
- [x] Run typecheck, full tests with two workers, build and relevant browser tests.
- [x] Review the completed diff independently and resolve material findings.
- [ ] Verify the installation archive, commit/push, publish the matching tag/release,
  deploy only after owned work is idle, and verify served assets and health.
