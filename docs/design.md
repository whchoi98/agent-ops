# my-agent-ops

## Product

A local operations console for people who use Codex, Claude Code, and Kiro CLI
across multiple projects. One interface connects conversation history with work
that can be launched, observed, stopped, resumed, and handed to another agent.
The application is original implementation, with no telemetry or hosted service.

## Requirements and acceptance evidence

1. Discover native Codex JSONL, Claude Code JSONL, and Kiro JSON/JSONL and SQLite
   conversations. Read sources without modifying them. Repeated imports are
   idempotent, malformed records produce diagnostics, and changed files refresh.
2. Persist sessions, normalized messages, native IDs, projects, usage, bookmarks,
   tags, and notes in local SQLite. Search conversation content, including Korean;
   filter by agent, project, date, status, and bookmark. Paginate results.
3. Show a responsive operations overview, session explorer and conversation reader,
   execution board and log viewer, project workspace, usage analytics, reusable
   prompt library, and connector/settings screen. All controls have real behavior.
4. Launch all three installed CLIs as child processes, without a command shell.
   Preview the command first. Only explicitly enabled, existing project directories
   can run. Select model and either read-only or workspace-write tool policy.
   Never emit an approval/sandbox bypass option. Queue with a concurrency limit
   and serialize runs for the same project. Enforce timeout and bounded log storage.
   Claude/Kiro may additionally enable terminal commands through an explicit
   workspace-write-only option; show that this grants CLI shell tools, not an OS
   sandbox. Codex commands remain governed by its selected sandbox.
5. Stream stdout/stderr events, persist run outcomes, cancel only owned processes,
   retry a failed run, resume a native session when the installed CLI supports it,
   and prepare an editable context handoff to another agent without launching it.
   Recovery marks old running/queued work interrupted; restarting never repeats work.
6. Report recorded token counts and recorded USD costs separately from missing data.
   Do not invent pricing, billable usage, live activity, authentication, or success.
   Analytics include daily activity, agent/model/project breakdown, tool usage,
   cache share, run outcomes, and a session comparison.
7. Export selected conversations as redacted JSON, Markdown, or standalone HTML.
   Notes and handoff/export content are redacted for common credential patterns.
   Rendering never executes transcript HTML. The UI/API serves selected history
   to the connecting browser. Explicit CLI execution and exports are additional
   sharing paths; the app has no telemetry or cloud account synchronization.
8. Provide keyboard search (Ctrl/Cmd+K), accessible dialogs, reduced motion,
   mobile layouts, light/dark themes, clear loading/error/empty states, and a
   Korean/English interface with a browser-persisted language choice and familiar
   CLI/product names. Keep user text, skill instructions and unsaved input intact.
9. Ship deterministic sample data behind an explicit demo mode. Demo data is
   isolated from real history, visibly labeled, and cannot execute agents.
10. Bind to loopback only, validate Host and Origin, and protect mutations with
    a same-origin header. Store application files with restrictive permissions.
    No arbitrary shell command, process-ID kill, or source-file deletion API.
11. Deliver install/start/dev/demo commands, a distributable npm archive, operating
    and architecture documentation, meaningful unit/integration tests, browser
    workflow tests, and inspected desktop/mobile screenshots.
12. Inspect assistant-specific skills, plugins and Kiro Powers with bounded,
    redacted previews. Configuration evidence is not proof of invocation.
    Optional analysis produces an editable run draft before execution.
13. Compare installed and latest public CLI versions through fixed vendor sources.
    Keep missing, unknown, failed and other-channel results distinct; no updater
    or billing lookup is part of this feature.
14. Keep native import in an owned subprocess. Persist file/row checkpoints and
    avoid rewriting unchanged messages. New caches use compressed search bodies;
    existing caches convert through explicit offline maintenance with a verified
    backup, atomic schema/version updates and stable session-ID search links.

## Architecture

Node.js 20.19+ runs a Fastify API and process scheduler. SQLite (better-sqlite3)
stores durable state and FTS5 search. Independent provider parsers yield the
shared `ImportedSession` contract. A sync service fingerprints sources and
upserts normalized records. React, TypeScript, and Vite build a static UI served
by the same local server. Server-sent events notify the UI about imports and
execution events. CLI credentials remain owned by the installed CLIs.

`shared/types.ts` is the API contract. Server files have no browser dependencies.
Provider parsing and execution policies are separate modules: parsing imported
history must never accidentally execute it.

Additional public contracts are in `shared/extensions.ts` and `shared/versions.ts`.
The browser's `src/i18n/` dictionaries localize application copy without changing
source content. Decisions are recorded in [the ADR index](decisions/README.md);
[implementation references](reference/INDEX.md) point to the relevant modules.

## Visual direction

An operator's workbench: quiet pale blue-gray canvas, deep ink sidebar, cobalt
focus, and three distinct provider marks. The signature element is a three-lane
agent activity strip that connects a provider to its recorded sessions and owned
running work. It conveys state rather than decorative animation.

Tokens: ink `#172b4d`, canvas `#f3f6fb`, surface `#ffffff`, cobalt `#3564e8`,
teal `#0e9f8f`, violet `#8b5cf6`, muted `#718198`. Use a locally bundled Korean
sans for the body, a compact geometric Latin face for the brand, and system
monospace for commands/times. Hairline borders, modest 10–14 px radius, generous
main-column whitespace, dense but readable rows. Dark mode maps the same semantic
tokens. Navigation remains usable on mobile without horizontal document overflow.

## Operational defaults

- HTTP: `127.0.0.1:4317`; configurable loopback port.
- An explicit `--public-url` supports an authenticated proxy on the same machine.
  UI, API and SSE share its subpath; forwarded headers never define allowed origins.
- Data: `~/.local/share/agent-ops`, overridable with `AGENT_OPS_DATA_DIR`.
- Demo uses a separate directory and a persistent demo flag.
- Concurrency: 2. Run timeout: 30 minutes. Refresh interval: 60 seconds.
- Discover configured agent source roots only; do not recursively scan all HOME.
- Imported projects are not executable until the user enables them in Projects.
- Imported incomplete sessions are labeled recorded/unknown, not running.
- Source format or permission problems are visible and do not erase history.
- Default policies request no interactive approvals; denied tools remain denied.
- UI language defaults to Korean and persists per browser.
- No automatic history retention/deletion is enabled. Optimization backups remain
  separate from the active cache and require their own disk space.

## Out of scope

Hosted accounts, external publishing, billing integration, manipulating unrelated
CLI processes, editing agent authentication, and desktop binary auto-update.
The distributable is a local web application with CLI entry points.
