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
| GET | `/events` | SSE | default message `{type:"refresh"}` or `{type:"run-event",runId,event}` |
| GET | `/health` | | `{ok:true,version,demo}` |
| GET | `/extensions` | `agent?,kind?,status?,scope?,projectId?,q?,offset?,limit?` | `ExtensionCatalog` |
| POST | `/extensions/refresh` | `{projectId?}` | `{ok:true}` |
| GET | `/extensions/:id` | `projectId?` | `ExtensionDetail` |
| GET | `/extensions/:id/files/:fileId` | `projectId?` | redacted `ExtensionContent` |
| POST | `/extensions/:id/analyze` | `{projectId?}` | `ExtensionAnalysisDraft`; does not execute a CLI |
| GET | `/connector-versions` | none | `VersionReport` with installed/latest versions and source status |
| POST | `/connector-versions/check` | `{}` | `VersionReport` after a bounded explicit refresh |

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
