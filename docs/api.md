# API contract

Base `/api`, same origin. JSON mutations require `Content-Type: application/json`
and `X-Agent-Ops: 1`. Errors are `{ error: string }` with a non-2xx status.
All timestamps are ISO UTC strings. IDs are opaque and must be URL encoded.

With `--public-url https://YOUR_DOMAIN/proxy/4327/`, the browser-facing API base is
`/proxy/4327/api`. The authenticated local proxy may strip or preserve that prefix.
See [operations](operations.md) for the proxy configuration.

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/bootstrap` | | `Bootstrap` |
| GET | `/sessions` | query `SessionQuery` (booleans as `true`) | `SessionPage` |
| GET | `/sessions/:id` | | `SessionDetail` |
| GET | `/sessions/:id` | `includeMessages=false` | `SessionDetail` with `messages: []` and full `messageCount` |
| GET | `/sessions/:id/messages` | `role?,q?,offset?,limit?` (default 50, max 100) | `MessagePage` |
| GET | `/sessions/:id/messages/:messageId` | | complete `Message` |
| PATCH | `/sessions/:id` | `{bookmarked?,tags?,note?,title?}` | `SessionDetail` |
| GET | `/sessions/:id/export` | `format=json\|md\|html` | attachment |
| POST | `/handoff` | `{sessionId,targetAgent,instruction?}` | `Handoff` |
| POST | `/sync` | `{}` | `SyncReport` |
| POST | `/sync/start` | `{}` | `202 { syncing: boolean }`; progress through bootstrap/SSE |
| GET | `/sync/status` | none | cached `SyncStatus`; no import |
| POST | `/sync/cancel` | `{}` or no body; no query | `202 { stopping: boolean, status: SyncStatus }` |
| GET | `/runs/:id` | | `RunDetail` |
| POST | `/runs/preview` | `RunRequest` | `CommandPreview` |
| POST | `/runs` | `RunRequest` | `Run` |
| POST | `/runs/:id/cancel` | `{}` | `Run` |
| POST | `/runs/:id/retry` | `{}` | `Run` |
| GET | `/runs/:id/events` | `after=integer` | `RunDetail` |
| POST | `/projects` | `{name,path,color?,executionEnabled?}` | `Project` |
| PATCH | `/projects/:id` | `{name?,color?,executionEnabled?}` | `Project` |
| POST | `/templates` | template fields excluding id/updatedAt | `PromptTemplate` |
| PATCH | `/templates/:id` | template fields excluding id/updatedAt | `PromptTemplate` |
| DELETE | `/templates/:id` | | `{ok:true}` |
| PATCH | `/settings` | partial `Settings` | `Settings` |
| GET | `/events` | SSE | default message `{type:"refresh"}`, `{type:"run-event",runId,event}` or `{type:"sync-state",status}` |
| GET | `/health` | | `{ok:true,version,demo}` |
| GET | `/extensions` | `agent?,kind?,status?,scope?,projectId?,q?,offset?,limit?` | `ExtensionCatalog` |
| POST | `/extensions/refresh` | `{projectId?}` | `{ok:true}` |
| GET | `/extensions/:id` | `projectId?` | `ExtensionDetail` |
| GET | `/extensions/:id/files/:fileId` | `projectId?` | redacted `ExtensionContent` |
| POST | `/extensions/:id/analyze` | `{projectId?}` | `ExtensionAnalysisDraft`; does not execute a CLI |
| GET | `/connector-versions` | none | `VersionReport` with installed/latest versions and source status |
| POST | `/connector-versions/check` | `{}` | `VersionReport` after a bounded explicit refresh |
| GET | `/resources` | none | cached `ResourceReport` with CPU/RSS history and disk coverage |
| GET | `/mcp` | `agent?,scope?,status?,transport?,projectId?,q?,offset?,limit?` | `McpCatalog` |
| POST | `/mcp/refresh` | `{projectId?}` | `{ok:true}`; invalidates declarations without connecting |
| GET | `/mcp/:id` | `projectId?` | redacted `McpDetail` |
| POST | `/mcp/:id/preview` | `{projectId?}` | expiring `McpCheckPreview`; no connection |
| POST | `/mcp/:id/check` | `{projectId?,previewId}` | `202 McpCheck`; explicit initialization and metadata-only probe |
| GET | `/mcp/checks/:checkId` | none | `McpCheck` with progress/result |
| POST | `/mcp/checks/:checkId/cancel` | `{}` | cancellation of an owned probe |
| GET | `/desktop-apps` | none | cached server-host `DesktopAppReport` |
| POST | `/desktop-apps/refresh` | `{}` or no body | refreshed `DesktopAppReport` |
| GET | `/app-update` | no query/body | cached `AppUpdateReport`; no external request |
| POST | `/app-update/check` | `{}` or no body; no query | `AppUpdateReport` after an explicit bounded check |

`Bootstrap.sessions` is the most recent 60 sessions. Use `/sessions` for full search
and pagination. `Bootstrap.analytics` is computed from the entire local archive.
Message pages return at most 16,000 characters per message, with `truncated` and
`contentLength` when needed. Search covers complete stored messages and returns
an excerpt around the match. The single-message endpoint returns full content.
`PATCH /sessions/:id?includeMessages=false` also avoids returning the transcript.
Demo rejects run creation/retry; preview and all local organization actions work.
No endpoint executes a handoff, export, prompt template, or imported session on read.
Project creation verifies an existing directory except in demo mode. Projects
discovered through session import default to execution disabled.

Extension contracts are in `shared/extensions.ts`. `kind` is `skill`, `plugin` or
`power`; `status` is `enabled`, `disabled`, `available`, `unknown` or `cached`.
These statuses describe local configuration evidence, not observed invocation.
`scope` is `user`, `project` or `system`; a project ID must already be registered.
Extension IDs are scoped to the selected project inventory, and file IDs are
opaque references to that inventory's bounded file list. Arbitrary paths are
not accepted. Lists default to 50 items, accept 1–100 items and are cached for
up to 60 seconds. Refresh invalidates the cached inventories.

Version contracts are in `shared/versions.ts`. Only fixed public vendor release
metadata endpoints are queried; the API accepts no caller-supplied source URL.
Lookup failures remain distinct from an up-to-date result. The installed raw
version and normalized version remain available when latest metadata fails.
`installed: null` means local detection was inconclusive; only `false` together
with `status: "not-installed"` represents a confirmed missing CLI.
Version checks do not upgrade a CLI or launch model inference. Demo reports use
clearly marked, deterministic sample versions without host or network probes.

Resource contracts are in `shared/resources.ts`. CPU and memory are sampled every
5 seconds; at most 180 samples remain in memory. Disk metadata refreshes every
60 seconds. The resource endpoint takes no path/PID inputs and starts no scan,
SQL query, process probe, or SSE refresh. Unknown counters are null, not zero.
CPU 100% means one logical core, RSS sums include per-process shared pages,
and incomplete disk scans are partial observations. Demo resource readings are
real measurements of the isolated demo server. See [resources](reference/resources.md).

MCP contracts are in `shared/mcp.ts`. Discovery reads bounded local configuration
and client provenance; it does not establish another app's current connection.
An explicit preview/check uses the selected, unchanged declaration and only MCP
initialization plus tools/resources/prompts listing. It never invokes MCP tools.
Configured authentication may be sent to that selected server; conversations
are not sent. Probes are bounded, separately timestamped and cancellable; demo
probes are disabled. No route edits native configuration or accepts a replacement
command/URL. Inaccessible native OAuth/helper state remains unverified/unsupported.

Desktop contracts are in `shared/desktop-apps.ts`. Only fixed macOS bundle
candidates on the server host are inspected. Other hosts report `unsupported-host`
with unknown installation state. App/container/IDE versions and builds come from
Info.plist and are not compared to CLI release versions. Authentication and full
private/cloud histories remain unverified. See [desktop apps](reference/desktop-apps.md).
The `ChatGPT.app` Codex candidate requires bundle identifier `com.openai.codex`;
a mismatch uses diagnostic code `bundle-identifier-mismatch` and contributes no installation.

## Recorded credits

`Usage.credits?: number | null` and `Usage.creditsPartial?: boolean` describe
recorded Kiro credit usage. Missing legacy fields and null remain unrecorded;
zero and fractional values are preserved. These fields are independent of token
counts and `costUsd`. Never assign a resumed session's total to a single run.
`SessionQuery.sort` additionally accepts `credits`, ordering recorded Kiro values
descending. JSON, Markdown and HTML session exports include recorded credits.

`Analytics` and its daily/agent/model/project groups add `recordedCredits`,
`knownCreditSessions`, `partialCreditSessions` and `kiroSessions`. Read the sum
with its coverage: zero covered sessions is not evidence of zero consumption.
`partialCreditSessions` counts covered sessions marked partial, and numeric
overflow leaves `recordedCredits: null`. Daily groups use the UTC session start
date, not individual turn or charge times.

## Import policy and status

`PATCH /settings` accepts `syncMode: "interval" | "idle" | "manual"` (default
`interval`) and integer `syncMaxSeconds` from 30 through 1800 (default 1800).
`scanIntervalSeconds` remains an integer from 15 through 3600, default 60.
The fields use existing settings JSON; no schema migration is added.

`SyncStatus` is defined in `shared/sync-control.ts` and is also returned as
`Bootstrap.syncStatus`:

- `policy`: `{ mode, intervalSeconds, maxSeconds }`.
- `demo`, `autoEnabled`.
- `activity`: `idle`, `running` or `stopping`.
- `automaticState`: `scheduled`, `manual`, `waiting-for-idle` or `disabled`.
- `nextCheckAt`: ISO timestamp or null.
- `currentAttempt`: null or `{ id, trigger, startedAt, maxSeconds }`, where
  `trigger` is `automatic` or `manual`.
- `lastAttempt`: null or the attempt plus `finishedAt`, `outcome`, `error` and
  an optional `report` only when the import returned one. Outcomes are
  `completed`, `cancelled`, `timed-out` and `failed`.

Status reads do not initiate imports. Manual starts bypass automatic/idle gating
and coalesce with active work while retaining the starting budget. Idle gating
uses this workbench's queued/running CLI jobs, not machine-wide activity.
Settings changes affect later budgets; the next interval starts after termination.
Schedule/attempt state is in RAM, while the existing persisted import report is
retained separately. Interrupted attempts retain already committed sessions.

`POST /sync` still waits for a `SyncReport`; cancellation returns 409 and budget
expiry returns 408. `POST /sync/start` still returns 202 immediately. A cancel
response with `stopping: false` means no new stop was initiated, including a
repeated request. Shutdown uses permanent cancellation, while ordinary stop is
reusable. These controls do not affect independently started `agent-ops sync`
commands. In demo mode, `/sync` returns a zero-count no-op report, `/sync/start`
returns `{ syncing: false }` and cancel returns `stopping: false`; no native
history driver starts.

`sync-state` SSE messages carry lightweight status on a 2-second cadence while
active, omitting `lastAttempt.report`. They do not trigger archive/bootstrap
reloads per tick. A terminal attempt triggers one archive refresh. Use the cached
status route when the full available last-attempt report is needed.

## Workbench update checks

`AppUpdateReport` from `shared/app-update.ts` contains `currentVersion`, `demo`,
`status`, `checking`, `latest`, `checkedAt`, `nextCheckAt`, `sourceUrl`, `error`
and `{ npm, git }` in `commands`. Status is `not-checked`, `current`,
`update-available`, `ahead`, `unavailable` or `demo`.

`latest` is null or `{ version, tag, publishedAt, releaseUrl, archive }`;
`archive` is null or `{ name, url }`. `checkedAt` is the last explicit attempt's
completion time, including failure. `nextCheckAt` is the earliest allowed check,
not an automatic schedule. Both timestamps are null before the first attempt.
External failures return an unavailable report with a fixed error code, rather
than exposing remote response or exception text. Error codes are
`invalid-current-version`, `invalid-release`, `request-failed`,
`redirect-rejected`, `response-too-large`, `timeout` and `closed`.

Only explicit checks contact the fixed public
`https://api.github.com/repos/whchoi98/agent-ops/releases/latest` source. There is
one in-flight request, an 8-second total deadline, a 256 KiB body limit and a
60-second minimum interval between attempts, including failures. Construction,
GET and demo make no external request. Metadata is held only in bounded RAM.
Requests include no credentials, local data or current-version query and reject
redirects, drafts, prereleases and malformed metadata.

Release and archive URLs must match the exact repository, stable SemVer tag and
`agent-ops-local-<version>.tgz` filename. Only a validated newer release supplies
commands. Without a validated archive, release information and Git instructions
may remain available but `commands.npm` is null. A failed check clears stale
release metadata and commands. The API never installs or restarts the app;
shutdown aborts owned checks.

Read [usage, import controls and updates](reference/usage-and-sync.md#english)
for user flows, source boundaries and upgrade instructions.
