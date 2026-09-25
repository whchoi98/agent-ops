# Resource Monitoring Implementation Plan

> **For agentic workers:** Use $executing-plans to implement this plan task-by-task in this session. Steps use checkbox syntax for tracking.

User scope addition: MCP discovery/analysis and user-triggered connection checks
are an independent domain. A delegated worker owns `shared/mcp.ts`,
`server/mcp/`, and `tests/mcp-*`; the coordinator owns app/navigation wiring,
resource collection, UI integration, and final verification.

**Goal:** Add inexpensive CPU, memory, and disk monitoring with measured scope and a bounded history.

**Architecture:** A dedicated collector samples Node and owned process counters.
An independent disk scanner reads metadata. A cached API feeds a visible-only
React page; monitoring never persists samples or broadcasts archive refreshes.

**Tech Stack:** Node.js 20.19+, TypeScript, Fastify, React, Vitest, Playwright; no new dependency.

**Spec:** [Resource monitoring design](../specs/2026-09-25-resource-monitoring-design.md)

## Global Constraints

- Preserve application/history data, process ownership, loopback/proxy access, and Korean/English UI.
- CPU/memory interval: 5 seconds. Disk interval: 60 seconds. History: at most 180 samples.
- Disk limits: 10,000 entries, depth 12, 2 seconds between metadata operations; one scan in flight.
- Child metrics: one `/bin/ps` call, 2-second timeout, 1 MiB output cap, at most 512 owned processes.
- No new dependency, SQLite table, telemetry, automatic cleanup, billing request, or paid inference.
- Worktree: `/home/ec2-user/my-project/agent-ops-resources`, branch `feat/resource-monitoring`.
- Baseline: 636 tests passed using `npm test -- --maxWorkers=2` on the unchanged source.

## Task 1: Resource collection and scope

**Files:** create `shared/resources.ts`, `server/resources/processes.ts`,
`server/resources/disk.ts`, `server/resources/monitor.ts`,
`tests/resources-processes.test.ts`, `tests/resources-disk.test.ts`,
`tests/resources-monitor.test.ts`; modify `server/runner.ts`,
`server/background-sync.ts`.

**Interfaces:** `OwnedProcessRoot` contains `pid`, `ownerId`, `kind` (`sync`,
`agents`, or `mcp`), and `processGroup`. Runner/BackgroundSync expose immutable copies of
currently owned roots. `ResourceMonitor` provides `start()`, `sample()`,
`sampleDisk()`, `snapshot()`, and `stop()`. `snapshot()` returns a
`ResourceReport` with current/history scope counters, cached disk data, timestamps,
collection durations, and explicit warning codes.

- [x] Write failing tests for the cumulative CPU-time parser, owned descendants
  and process groups, PID-start identity, and unrelated process exclusion.

```ts
expect(parseCpuTime('01:02:03')).toBe(3723);
expect(parseCpuTime('2-01:02:03.50')).toBe(176523.5);
expect(parseCpuTime('not-a-time')).toBeNull();
```

- [x] Implement process sampling with fixed `/bin/ps` arguments and no shell.
  Keep server CPU from Node's microsecond counters; retain child baselines by
  PID/start identity. Unknown or reset counters remain null.
- [x] Write temporary-directory disk tests for actual metadata categories,
  symlinks outside the data root, hardlinks, empty/sparse files, and scan bounds.
  Implement an async metadata-only scanner with safe root checks and one scan
  in flight; return coverage rather than pretending limited scans are totals.
- [x] Write monitor tests using injected clock/counter/scan functions. Cover
  exact CPU deltas, 180-sample rollover, no process probe when idle, overlapping
  ticks, slow disk collection, failed probes, and shutdown without further work.
- [x] Run the affected tests:

```bash
npm test -- tests/resources-processes.test.ts tests/resources-disk.test.ts tests/resources-monitor.test.ts --maxWorkers=2
```

## Task 2: Cached API and browser view

**Files:** modify `server/app.ts`, `src/lib/api.ts`, `src/lib/navigation.ts`,
`src/components/Shell.tsx`, `src/App.tsx`, `src/i18n/en.ts`,
`src/styles/index.css`; create `tests/resources-api.test.ts`,
`src/hooks/useResources.ts`, `src/pages/Resources.tsx`,
`src/features/resources/ResourceTrend.tsx`, `src/styles/resources.css`,
`tests/e2e/resources.spec.ts`.

**Interfaces:** `GET /api/resources` takes no query fields and returns the
monitor's cached `ResourceReport`. `api.resources(signal)` uses the existing
same-origin API wrapper. `useResources()` owns one request/timer and exposes
data, error, paused state, refresh, and pause/resume controls.

- [x] Write route tests with injected monitoring dependencies to prove read-only
  cache responses, no scan per request, strict query/access guards, and teardown.
- [x] Register/start/stop the monitor with the app lifecycle; use the owned
  roots already tracked by Runner and BackgroundSync.
- [x] Add `resources` navigation and a lazy page. Reuse existing panels/buttons,
  provide explicit units and unknown states, show the server/import/agent split,
  storage categories, available space, recent trends, and collection cost.
- [x] Implement browser polling with an AbortController and one trailing request.
  Hide/unmount/pause clears timers and cancels requests; resume refreshes once.
- [x] Add translations and responsive styles. Add browser checks for both
  languages, mobile overflow, valid zero versus unknown, pause/resume, failure
  recovery, and the new navigation/command-palette entry.

```bash
npm test -- tests/resources-api.test.ts --maxWorkers=2
npm run build
npm run test:e2e -- tests/e2e/resources.spec.ts
```

## Task 3: MCP menu and analysis

**Files:** create `shared/mcp.ts`, `server/mcp/`, `tests/mcp-*.test.ts`,
`src/pages/Mcp.tsx`, `src/features/mcp/`, `src/styles/mcp.css`,
`tests/e2e/mcp.spec.ts`; update the existing app/navigation/API/translation entrypoints.

- [x] Discover Codex, Claude Code, and Kiro user/selected-project MCP declarations
  with bounded reads and cached results; distinguish disabled, configured, and
  check-result states. Return opaque server IDs and redacted configuration only.
- [x] Add explicit connection previews and bounded metadata-only probes with
  one probe at a time, deadline/output limits, changed-config detection, owned
  process cleanup, and no MCP tool invocation. Demo probes remain disabled.
- [x] Provide `/api/mcp` routes and an MCP menu under Analytics and management.
  Show server scope/transport/source, configuration analysis, tools/resources/
  prompts returned by an actual check, warnings, and last checked timestamps.
- [x] Test with temporary configurations and local fake MCP servers. Verify
  secrets do not appear in responses, configuration files stay unchanged, cached
  discovery does not execute anything, and probes terminate within their limits.
- [x] Include the probe's owned processes in the resource monitor and test the
  browser's discovery/filter/detail/check/error flow in both languages.

## Task 4: Measurement, documentation, delivery

User follow-up adds macOS desktop information: Codex App, Claude Desktop with
the Code-version distinction, and Kiro IDE. A separate worker owns
`shared/desktop-apps.ts`, `server/desktop-apps*`, its focused tests,
`src/features/versions/DesktopApps*`, and desktop translations. The coordinator
wires it below CLI version comparison in Settings. Read fixed app bundles with
bounded metadata conversion, cache results, and distinguish an unsupported host
from an absent app. Do not reuse CLI release versions for desktop apps. MCP
discovery must retain client provenance and must not merge Claude Code and
Claude Desktop Chat precedence merely because their provider matches.

**Files:** update `README.md`, `CHANGELOG.md`, `docs/design.md`, `docs/api.md`,
`docs/operations.md`, `docs/verification.md`, `docs/reference/INDEX.md`;
create `docs/reference/resources.md` and an isolated resource benchmark script
under `scripts/`.

- [x] Measure sampling duration, cached API latency, bounded history memory,
  metadata-only disk scanning, and behavior under synthetic owned CPU work.
  Include an idle/no-owned-child case and a large-file case whose contents
  must not be read. Record actual environment and results.
- [x] Document units, supported platforms, sampling/retention limits, allocation
  versus logical size, unknown/partial data, and the additional-feature assessment.
  Update both languages and Unreleased without inventing a release.
- [x] Integrate macOS app inventory and client-specific MCP provenance. Verify
  fixture-based path/parser/unsupported-host behavior and disclose that this EC2
  host cannot inspect another computer or establish native macOS runtime results.
- [x] Run required validation with bounded parallelism:

```bash
npm run typecheck
npm test -- --maxWorkers=2
npm run build
npm run test:e2e
git diff --check
```

The first three commands are the complete `npm run check` sequence, with bounded
test parallelism. Run the unchanged aggregate script when resources permit.

- [x] Build and smoke-test an npm archive in an isolated data directory.
  Review the complete diff and verification results. Integrate the verified
  change without losing unrelated work; inspect runtime state before any
  authorized service update.
- [x] Audit every design acceptance item against source, tests, browser output,
  benchmark evidence, packaged files, and runtime observations before declaring
  the goal complete.

## 한국어 실행 메모

설계의 수집 범위와 상한을 그대로 구현합니다. 수집기·저장 공간·API·화면 순서로
테스트를 먼저 추가하고, 마지막에 실제 수집 비용과 배포 파일을 검증합니다.
기존 검증 근거를 재사용하되 코드가 바뀐 범위는 다시 확인합니다.
설치 상태를 바꾸기 전 사용자 작업이 실행 중인지 확인하며, 표본 누락이나
플랫폼 제한은 숨기지 않고 문서와 화면에 표시합니다.
