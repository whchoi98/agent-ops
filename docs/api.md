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
