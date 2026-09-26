# API contract

Base `/api`, same origin. JSON mutations require `Content-Type: application/json`
and `X-Agent-Ops: 1`. Errors are `{ error: string }` with a non-2xx status.
Timestamps are ISO UTC strings; work-item calendar dates and saved-view date
filters have the semantics described below. IDs are opaque and must be URL encoded.

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
| GET | `/templates` | no query | `PromptTemplate[]` |
| POST | `/templates` | `TemplateInput` | `201 TemplateRevision` |
| PATCH | `/templates/:id` | `TemplatePatch`, including optional `expectedRevision` | `TemplateRevision` |
| DELETE | `/templates/:id` | | `{ok:true}` |
| PATCH | `/settings` | partial `Settings` | `Settings` |
| GET | `/events` | SSE | default message with type `refresh`, `run-event`, `sync-state` or `productivity-change`; see below |
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
Message pages return at most 16,000 UTF-16 code units per message, with
`truncated`, `contentLength` and `contentOffset` when needed. `contentOffset` is
the zero-based offset of the returned preview in the original message, defaulting
to zero when absent. Search covers complete stored messages and returns an
excerpt around the match without splitting surrogate pairs. Context capture
uses original-message offsets, not offsets relative to that preview. The
single-message endpoint returns full content.
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

## Productivity workspace

Shared DTOs live in
`shared/work-items.ts`, `shared/context-packs.ts`, `shared/template-fields.ts`
and `shared/saved-views.ts`. The [productivity guide](reference/productivity.md#english)
covers the user flow and full limits. Input and prompt bounds use UTF-16 code units; the
source-capture byte limit applies to the serialized message.

The routes use the root application's Host, Origin, local-peer, proxy and
`X-Agent-Ops` guards, including POST operations that only prepare or compile.
The browser uses the shared typed request helper and `ApiError.status` to
distinguish conflicts. Mutations use `retryWrite` on the existing SQLite
connection. Stale versions return `409 { error }` without a partial write;
validation errors return 400, missing records 404 and size failures may return 413.
Capacity errors differ by feature: work items use 409, context packs 413
and saved views 400. The root body limit remains 256 KiB; saved-view create/edit
routes use 32 KiB and deletion uses 256 bytes.

### Work items

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/productivity/work-items` | `WorkItemQuery` | `WorkItemPage` |
| GET | `/productivity/work-items/:id` | no query | `WorkItemDetail` |
| POST | `/productivity/work-items` | `title` required; other `WorkItemFields` optional | `201 WorkItem` |
| PATCH | `/productivity/work-items/:id` | `{version, ...partial WorkItemFields, archived?}` | `WorkItem` |
| DELETE | `/productivity/work-items/:id` | `{version}` | `{ok:true}` |
| POST | `/productivity/work-items/:id/prepare` | `{version, agent?}` | `{workItem: WorkItem, draft: Partial<RunRequest> & Pick<RunRequest, "agent" \| "prompt" \| "policy">}` |

All routes except the list reject query parameters. Body fields are strict.
The stored shape is:

```typescript
interface WorkItemFields {
  title: string;
  description: string;
  nextAction: string;
  projectId: string | null;
  dueDate: string | null;
  status: 'todo' | 'in_progress' | 'blocked' | 'done';
  priority: 'low' | 'normal' | 'high';
  sessionIds: string[];
  contextPackIds: string[];
}
interface WorkItem extends WorkItemFields {
  id: string;
  lastRunId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
```

Creation defaults to empty description and next action, empty reference arrays, null
project/due date, `todo`, `normal` and version 1. Title is at most 200 characters;
description and next action are each at most 8,000. All three fields reject
NUL (`U+0000`) with 400. References must be unique:
20 sessions and 5 context packs. Newly added references must exist. The store
allows 10,000 work items, including archived records.

`WorkItemDetail` adds `sessions: {id,title,agent,available}[]` and
`packs: {id,name,available}[]`; an unavailable session has `agent: null`.
`WorkItemSummary` replaces description and next action with
`descriptionPreview` and `nextActionPreview` (up to 240 characters each) and adds
`lastRunStatus: RunStatus | null`.
`WorkItemPage` is `{items: WorkItemSummary[], total, counts, limit, offset}`.
`counts` maps all four statuses to counts after the other filters, before the
status filter; `total` includes that filter.

`WorkItemQuery` accepts `q` (at most 200), `projectId`, `status` (a stored status
or `open`, meaning any status except `done`), `priority`, `archived` (`true` or
`false`, default false), `due`, `today`, `sort`, `limit` and `offset`.
`sort` is `priority` (default), `recent` or `due`. `limit` is 1-100 (default 25);
`offset` is 0-1,000,000 (default 0). Unknown query keys are rejected.

`dueDate` and `today` are valid `YYYY-MM-DD` calendar dates. `due` accepts
`today`, `overdue`, `week` or `none`. All except `none` require `today` supplied
from the browser's local calendar. `week` includes today and the next six dates;
`none` selects undated items. `archived=true` selects the archive only.

Prepare checks the version and rejects done/archived work with 409. It returns
a read-only run draft containing the goal, next action, session references and
compiled attached context, capped at 64,000 characters. The assembled work-item
prompt also rejects NUL with 400, including NUL in source context. Prepare does
not save or start a run. The optional assistant defaults to the first available linked
session's assistant, then `codex`.

`RunRequest` adds optional `workItemId`, `workItemVersion` and `contextPackIds`.
The work-item ID/version must appear together; pack IDs must be unique and at
most five. `prompt` remains the supplied text, capped at 64,000 characters:
these IDs do not ask `/runs` to render templates or compile packs.

On run creation, the registered project and referenced packs must exist.
The run insert and work-item link occur in one transaction before launch.
Linking checks the current work-item version, rejects done/archived items and
project mismatches, sets `status: "in_progress"` and `lastRunId`, and increments
the version. An item without a project adopts the run's project.
`Run.workItemLinkedVersion` records the resulting version for guarded retries.
Two submissions using the same work-item version cannot create two linked runs.
Preview also checks the work-item version/status/project and pack availability,
but does not reserve them. Run completion or failure
does not mark the work item done; the operator updates its status.

### Context packs

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/productivity/context-packs` | `q?,projectId?,offset?,limit?` | `ContextPackPage` |
| POST | `/productivity/context-packs` | `{name,description?,projectId?,instructions?}` | `201 ContextPack` |
| GET | `/productivity/context-packs/:id` | no query | `ContextPack` |
| PATCH | `/productivity/context-packs/:id` | `{version,name?,description?,projectId?,instructions?}` | `ContextPack` |
| DELETE | `/productivity/context-packs/:id` | `{version}` | `{ok:true}` |
| POST | `/productivity/context-packs/:id/items` | `ContextPackItemInput` below | updated `ContextPack` |
| PATCH | `/productivity/context-packs/:id/items/:itemId` | `{version,title?,text?}` | updated `ContextPack` |
| DELETE | `/productivity/context-packs/:id/items/:itemId` | `{version}` | updated `ContextPack` |
| POST | `/productivity/context-packs/:id/reorder` | `{version,itemIds: string[]}` | updated `ContextPack` |
| POST | `/productivity/context-packs/:id/compile` | `{}` or no body; no query | `ContextPackCompilation` |
| GET | `/productivity/context-packs/:id/export` | `format=md\|json`, default `md` | attachment |

Only the list and export accept the documented query parameters. Creates default
to empty description/instructions, null project and version 1. Pack updates
require at least one editable field; all item mutations use the **pack's**
current version and increment it. Reorder must contain every current item ID
exactly once.

```typescript
type ContextPackItemInput =
  | { version: number; kind: 'message'; sessionId: string; messageId: string;
      offset: number; length: number }
  | { version: number; kind: 'note'; title: string; text: string };
interface ContextPackCompilation {
  packId: string;
  version: number;
  prompt: string;
  characters: number;
  itemCount: number;
  redacted: boolean;
}
```

Capture reads one existing message by ID, with a nonnegative UTF-16 `offset`
and `length` from 1 through 8,000. The range must fit the original content and
neither end may split a surrogate pair. The server rejects client-supplied
message text or provenance. An unavailable source returns 404; serialized source
data above 8 MiB returns 413 before the body is loaded into Node.

`ContextPackSummary` is
`{id,name,description,projectId,itemCount,totalChars,version,createdAt,updatedAt}`;
`ContextPackPage` is `{items: ContextPackSummary[],total,offset,limit}`.
Lists omit instructions and item bodies, accept `q` up to 500 characters,
`limit` 1-100 (default 25) and `offset` 0-200 (default 0), and sort by updated
time descending then ID. A full `ContextPack` adds `instructions` and `items`.
Each item has `{id,kind,title,text,createdAt,source,sourceAvailable}`.

For message items, `source` is
`{sessionId,messageId,agent,sessionTitle,role,messageTimestamp,capturedAt,offset,length}`.
Text and provenance are immutable after capture; PATCH may change the title
but accepts `text` only for a note. `sourceAvailable` tests current ID
availability, not equality with the saved excerpt. Notes have `source: null`
and `sourceAvailable: null`. Source edits or disappearance do not delete snapshots.

Compile assembles every saved item with provenance and instructions locally;
it does not mutate the pack or call a model. `characters` is the prompt's UTF-16
length. `redacted` means the current export rules changed at least one string,
not that all secrets have been detected. Compiled output above 64,000 characters
is rejected without omitting items. Markdown export returns that prompt; JSON
returns `{formatVersion: 1, pack: ContextPack}` with redacted strings. Both
formats apply the compile-size check. Stored excerpts remain unchanged.

### Template inputs and history

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/templates/:id/history` | none | `TemplateRevision[]`, newest revision first |
| POST | `/templates/:id/restore` | `{revision,expectedRevision}` | `TemplateRevision` |
| POST | `/templates/:id/render` | `{values: Record<string,string>}` | `{prompt: string}` |

`TemplateInput` requires `name`, `description`, `category`, `prompt`, `agent`
and `policy`, with optional `variables`. Categories remain
`review|build|debug|docs|custom`, assistants `codex|claude|kiro|any`, and policies
`read-only|workspace-write`. A variable is
`{name,label,type,required,description?,defaultValue?,options?}`; `type` is
`text|multiline|select`. Select variables require 1-50 unique, nonblank options.
Names match `[A-Za-z_][A-Za-z0-9_]{0,39}` and exclude `__proto__`, `constructor`
and `prototype`. Definitions and placeholders must match.

Templates allow 20 variables, 8,000 characters per value, a 32,000-character
stored prompt and a 64,000-character rendered prompt. Rendering substitutes
`{{name}}` once as literal text, checks required/select inputs and unknown
values, and never evaluates JavaScript, shell or nested expressions. Missing or
empty variable definitions preserve legacy prompt text, including braces.
The render API reads the currently saved template; the UI applies its selected
template snapshot locally.

`PromptTemplate` adds optional `variables` and `revision`; `TemplateRevision`
requires `revision`. New records start at 1, edits/restores increment it, and
legacy records are treated as revision 1 without rewriting them at startup.
PATCH accepts partial input fields and optional `expectedRevision`; omitting
it preserves compatibility with older clients. Restore requires both the
retained revision and current expected revision, and creates a new revision.
Stale expectations return 409. Missing/pruned revisions return 404.
History retains at most 20 entries per template and 1,000 overall, so a template
may have fewer than 20. Deleting a template also deletes its history; the
existing DELETE contract does not take a revision. None of these operations
launches a CLI.

### Saved session views

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/productivity/saved-views` | no query | `{items: SavedView[]}` |
| POST | `/productivity/saved-views` | `{name,query,period?,pinned?}` | `201 SavedView` |
| PATCH | `/productivity/saved-views/:id` | `{version,name?,query?,period?,pinned?}` | `SavedView` |
| DELETE | `/productivity/saved-views/:id` | `{version}` | `{ok:true}` |

`SavedView` is `{id,name,query,period,pinned,version,createdAt,updatedAt}`.
Create requires name and query, and defaults to `period: "all-time"`,
`pinned: false`, version 1. PATCH requires at least one change in addition to
version. All routes reject query parameters; there is no single-view GET route.
The list is bounded by the 50-view storage cap and ordered pinned first, then
updated time descending and ID. Names are nonblank and at most 120 characters.

The stored query accepts only `q`, `agent`, `project`, `status`, `bookmarked`,
`tag`, `since`, `until`, `sort` and `limit`, using `SessionQuery` values and a JSON
boolean for `bookmarked`. `project` is the session's project path.
`q`, `project`, `tag` and date strings are capped at
500, 4,096, 60 and 40 characters respectively; `limit` is an integer from 1
through 200. Unknown filters and `offset` are rejected.

`period` is `all-time|today|last7|last30|custom`. Only custom ranges accept fixed
`since`/`until`, with at least one boundary and a valid date order. A date-only
`until` retains the session API's inclusive UTC end-of-day semantics.
Timezone-free timestamps use the server host's timezone; the browser preserves
those filters without reinterpreting their range in its own timezone.
`resolveSavedView` in the browser recalculates relative periods when opened:
local midnight today, six or 29 calendar dates earlier through today's local
end of day, including daylight-saving transitions. Applying replaces the
session query, resets `offset: 0` and uses the existing session URL/API.
Fetching saved-view metadata does not execute its searches or calculate counts.

### Metadata events and drafts

The existing default SSE message types retain their shapes:
`{type:"refresh"}`, `{type:"run-event",runId,event}` and
`{type:"sync-state",status}`. A productivity mutation sends:

```json
{"type":"productivity-change","entity":"work-items"}
```

`entity` is `work-items`, `context-packs`, `saved-views` or `templates`.
The event carries no record bodies. Browser listeners refresh bounded feature
data; template changes use `GET /templates` and do not force an archive/bootstrap
reload. Normal reconnect, visibility and periodic refresh handling still applies.
Work-item linking follows the runner's existing refresh notification.

Open editors keep their draft's version or revision rather than silently
rebasing unsaved values onto new metadata. A 409 is surfaced for explicit
reconciliation, never automatically replayed with a newer version. In the run
dialog, preparation edits invalidate the accepted command preview; start uses
the exact accepted request. Applying a template replaces the prompt, retains
`contextPackIds` and clears the UI's applied-context state. Selected context must
be appended again before preview. Manual prompt edits remain as written, and
removing a pack reference leaves prompt text unchanged.

Each explicit new-run preparation has a fresh UI identity, so a template shortcut
in the palette replaces the previous form and command preview. This preparation
identity is not part of `RunRequest`. Template rendering and context attachment
prepare text only, and the operator still previews and starts the CLI explicitly.

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
