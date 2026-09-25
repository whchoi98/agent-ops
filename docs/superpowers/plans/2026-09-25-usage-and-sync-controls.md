# Usage and Operating Controls Implementation Plan

> **For agentic workers:** Use the normal TDD workflow. The coordinator owns shared integration; independent workers own the write sets named below. Track deliverables with the checkboxes.

**Goal:** Ship recorded Kiro credits, resource-aware synchronization controls and an explicit workbench update guide.

**Architecture:** Extend the existing JSON usage/settings payloads without a schema migration. Keep credit aggregation in the native parser, scheduling in one in-memory controller and update checks in an independent bounded service.

**Tech Stack:** Node.js 20.19+, TypeScript, Fastify, React, Vitest, Playwright; no new dependency.

**Spec:** [Usage and operating controls](../specs/2026-09-25-usage-and-sync-controls-design.md)

## Global constraints

- Preserve schema 4, native history, notes/tags/bookmarks, loopback/proxy guards and owned-process cleanup.
- Credit ledger: at most 20,000 turn groups and 40,000 message identities; numeric, finite, nonnegative credits; missing is not zero.
- Sync modes: `interval`, `idle`, `manual`; default `interval`.
- Sync interval: 15~3,600 seconds; budget: 30~1,800 seconds, default 1,800.
- One automatic timer, one import, one last-attempt record; progress events do not reload the archive.
- Update checks: fixed GitHub repository, one request, 8 seconds, 256 KiB, 60-second cooldown, RAM only.
- No paid inference, real MCP invocation, new dependency or automatic deletion/install/restart.
- Worktree: `/home/ec2-user/my-project/agent-ops-resources`; branch `feat/usage-and-sync-controls`.
- Baseline: `1b4cf77`; existing application code passed 871 unit tests before this change.

## Task 1: Recorded credits and efficient backfill

**Owner:** coordinator.

**Files:** `shared/types.ts`, new `server/providers/kiro-credits.ts`,
`server/providers/kiro.ts`, `server/providers/index.ts`, `server/sync.ts`,
`server/store.ts`, `server/analytics.ts`, `server/privacy.ts`, focused provider,
store, sync, analytics and export tests.

**Interfaces:** `Usage.credits?: number | null`, `Usage.creditsPartial?: boolean`.
`KiroCreditLedger.record(identity, metering, endedAt, snapshotAt)` retains bounded
turn snapshots; `finish()` resolves message/loop ownership before returning the
two credit fields. Provider fingerprint callbacks receive
the source agent as a third argument, preserving compatibility with callbacks
that only accept two. Kiro gets a distinct parser revision; other providers
retain `format-v3`.

- [x] Add failing native-parser tests using the real metadata envelope:

```typescript
const parsed = parseKiroRecords([
  { session_id: 'credit-fixture', session_state: { conversation_metadata: {
    user_turn_metadatas: [{ loop_id: { agent_id: 'fixture', rand: 1 },
      metering_usage: [{ unit: 'credit', value: 0.1 }, { unit: 'credit', value: 0.2 }] }],
  } } },
  { kind: 'Prompt', data: { message_id: 'u1', content: 'fixture prompt' } },
  { kind: 'AssistantMessage', data: { message_id: 'a1', content: 'fixture response' } },
], { sourcePath: '/fixture/credit.json', fallbackTimestamp: '2026-09-25T00:00:00Z' });
expect(parsed.session?.usage.credits).toBeCloseTo(0.3, 12);
```

- [x] Test zero, absent/invalid records, repeated and revised turn snapshots,
  reordered loop identity keys, equal-valued separate records, ledger limits
  and overflow. Keep tokens and USD independent.
- [x] Implement the bounded ledger and integrate it with validated Kiro imports.
- [x] Add targeted-backfill tests that seed old fingerprints for all providers;
  prove only Kiro is reread. Change callbacks and parser revision accordingly.
- [x] Make metadata-only session changes skip search reconstruction. Test changed
  text/title/model/project still updates search and user overrides survive.
- [x] Aggregate credits independently with coverage and partial-record counts;
  add credits sorting and JSON/Markdown/HTML export fields.

## Task 2: Credit presentation

**Owner:** credit UI worker; coordinator owns demo seed and global translations.

**Files:** `src/components/ui.tsx`, usage helpers, session cards/rows, session
summary/metadata/comparison, run views, Overview, Analytics, demo seed and
dedicated translations; related component/browser tests.

**Interfaces:** retain `TokenValue` for raw token details; introduce a
provider-aware usage summary and separate aggregate credit display. Analytics
credit fields report only Kiro records and their coverage.

- [x] Add component tests for fractional credit, recorded zero, missing and
  partial credit, and token display for other providers.
- [x] Wire all primary Kiro summaries to credit units without hiding raw token
  details or assigning a session's cumulative credit to a single run.
- [x] Add separate credit totals, agent/model/project coverage, session-start-date
  daily scope and session credit sorting.
- [x] Add bounded demo credit examples and verify both languages in browser
  session, detail, comparison and analytics flows.

## Task 3: Reusable import control

**Owner:** sync worker; coordinator owns `server/app.ts`, Settings schema/UI and
`server/sync.ts` integration.

**Worker write set:** new `shared/sync-control.ts`, `server/sync-manager.ts`,
`server/background-sync.ts`, focused sync-manager/background tests. No edits to
shared/types, app.ts, sync.ts, Settings or global translations.

**Interfaces:**

```typescript
type SyncMode = 'interval' | 'idle' | 'manual';
interface SyncPolicy { mode: SyncMode; intervalSeconds: number; maxSeconds: number }
interface SyncDriver {
  readonly active: boolean;
  run(options?: { maxRuntimeMs?: number }): Promise<SyncReport>;
  stopCurrent?(): boolean;
  cancel(): void;
  wait(): Promise<void>;
}
```

`SyncManager` receives driver, policy, `autoEnabled`, `demo`, `isBusy`, `onChange`,
`onFinished`, optional `now`. Export methods `start()`, `configure(policy)`,
`snapshot()`, `runManual()`, `stopCurrent()`, `close()`, `wait()`.
Status includes policy, demo, autoEnabled, `activity` (`idle`, `running`,
`stopping`), automatic state (`scheduled`, `manual`, `waiting-for-idle`,
`disabled`), `nextCheckAt`, current attempt and last attempt.
Attempts carry id, trigger, start time and budget; completed attempts additionally
carry finish time, outcome (`completed`, `cancelled`, `timed-out`, `failed`),
fixed error text and a report only when actually returned.

- [x] Test the reusable cancellation regression before implementation:

```typescript
const first = worker.run();
expect(worker.stopCurrent()).toBe(true);
await expect(first).rejects.toMatchObject({ name: 'AbortError' });
await worker.wait();
await expect(worker.run()).resolves.toMatchObject({ imported: 1 });
```

- [x] Add per-run time limits with the existing maximum and cleanup bounds.
  Keep `cancel()` permanent and `stopCurrent()` reusable.
- [x] Test and implement one-timer scheduling, interval/manual/idle policies,
  busy deferral, completion-based scheduling, manual bypass, coalescing,
  stop/timeout/failure outcomes and shutdown.
- [x] Emit only lightweight status while active, at most every two seconds;
  notify archive completion once per terminal attempt.

## Task 4: Synchronization API and Settings

**Owner:** coordinator.

**Files:** `shared/types.ts`, `server/config.ts`, `server/app.ts`,
`server/runner.ts`, `src/state/AppProvider.tsx`, `src/lib/api.ts`,
`src/pages/Settings.tsx`, new focused sync controls UI/translations and tests.

**Interfaces:** persist flat settings `syncMode`, `syncMaxSeconds` alongside
`scanIntervalSeconds`; map them to `SyncPolicy`. Add `GET /api/sync/status` and
`POST /api/sync/cancel`. Preserve `/api/sync` and `/api/sync/start`.
Include sync state in bootstrap and emit `{type: 'sync-state', status}` events.
Expose a cheap read-only Runner busy getter; never query unrelated processes.

- [x] Test mode/budget validation and inherited access guards, then register the
  manager with application startup, settings changes and shutdown.
- [x] Test status/cancel routes, manual starts while paused, repeated stops,
  idle deferral and the next successful attempt.
- [x] Teach AppProvider to consume sync-state events without an archive refresh;
  refresh bootstrap once after termination and on existing reconnect safeguards.
- [x] Add mode/budget controls, next-check and last-outcome information,
  elapsed time and stop/retry actions with Korean/English and visibility handling.

## Task 5: Workbench update guide

**Owner:** update worker; coordinator owns registration and Settings placement.

**Worker write set:** new `shared/app-update.ts`, `server/app-update.ts`,
`src/features/app-update/`, `src/i18n/app-update.en.ts`,
`tests/app-update*.test.ts`. No changes to app.ts, Settings, global translations
or version manifests.

**Interfaces:** export `AppUpdateService`, its options and route registrar.
Constructor receives currentVersion, demo, optional fetcher/clock. Methods
`snapshot()`, `check()`, `close()`. `GET /api/app-update` returns cached state;
`POST /api/app-update/check` triggers the bounded explicit check. Export a React
`AppUpdate` component and `APP_UPDATE_EN_MESSAGES` for coordinator wiring.
Report includes current version, validated latest metadata, checkedAt,
nextCheckAt, checking flag, demo flag and status.

- [x] Test no network on construction/GET/demo, stable SemVer comparison,
  invalid responses, missing assets, redirects, time/size limits and coalescing.
- [x] Implement strict fixed-repository release/asset validation and safe copied
  npm/Git instructions. Keep credentials and local data out of requests.
- [x] Test mutation guards, cooldown, shutdown, loading/error states and complete
  English translations. Use controlled fetch responses only.

## Task 6: Integrated validation and delivery

**Owner:** coordinator.

- [x] Integrate worker patches and review boundaries, parser correctness,
  lifecycle ownership, old stored data and error handling.
- [x] Run the complete required sequence with bounded test parallelism:

```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run test:e2e
```

- [x] Measure metadata-only credit updates, sync-state response overhead and
  bounded update-cache behavior using synthetic data. Verify real source credit
  shapes read-only without publishing conversations, identifiers or credentials.
- [x] Update README, bilingual changelog and feature/API/operating guides;
  replace stale follow-up labels and record actual verification.
- [x] Build and smoke-test an installation archive using production dependencies
  and temporary data. Verify version and released/runtime bytes.
- [ ] Commit and push the verified release, create its new version tag and GitHub
  release through the standing delivery authorization. Update the live service
  only while owned runs, imports and MCP checks are idle, with a runtime backup.
- [ ] Audit every spec requirement against source, tests, rendered UI, archive,
  remote metadata and runtime before completing the active goal.
