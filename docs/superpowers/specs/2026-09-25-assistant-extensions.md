# Assistant skills and plugins

Add a Korean `스킬·플러그인` workspace to inspect Codex, Claude Code and Kiro
extensions on the machine running Agent Ops. Preserve existing application
behavior and the authenticated `/proxy/4327/` deployment.

## User flow

1. Choose an assistant, kind, configured status and optional registered project.
2. Search names/descriptions and page through local skills, installed plugins and
   Kiro powers. Show global, project and system scope with discovery paths.
3. Open an item to read its purpose, trigger declarations, tools, MCP servers,
   hooks, referenced files and configuration evidence. View redacted instruction
   text and bounded text files. Plugin details link to bundled skills.
4. Prepare an optional CLI analysis task from the inspected content. Use the
   existing new-run preview and explicit execution flow, defaulting to read-only.

## Truth and access boundaries

Installed, cached, available and explicitly enabled states differ. Unknown
activation remains unknown. Configuration inspection is not invocation evidence;
show this in the workspace. No frequency/last-used claims are inferred from names
appearing in conversation text. Kiro IDE powers do not imply Kiro CLI activation.

Only registered project IDs may select project scope. Discover known extension
directories and metadata files; never scan all HOME or read authentication
stores. Resolve previews only from opaque IDs in a server-owned inventory.
Reject path traversal, sensitive filenames, symlink escapes, binary previews,
excessive files/depth and oversized content; report bounded omissions.
Treat instructions as data and never execute referenced scripts during analysis.
Redact secret fields, environment values and credential-shaped text in responses.
Demo mode uses deterministic fixtures and never reads real extension directories.

## Architecture

Use `shared/extensions.ts` as the public contract and
`server/extensions/types.ts` for provider discovery. Provider adapters handle
their native configuration and precedence. A bounded reader, local analysis
module and inventory service provide on-demand results; avoid adding expensive
extension scanning to bootstrap or the session synchronization loop.

Routes:

- `GET /api/extensions`: filters and pagination from `ExtensionQuery`.
- `POST /api/extensions/refresh`: invalidate the selected project inventory.
- `GET /api/extensions/:id?projectId=…`: detail and analysis.
- `GET /api/extensions/:id/files/:fileId?projectId=…`: redacted text preview.
- `POST /api/extensions/:id/analyze`: return an editable analysis draft only.

The web client uses `apiUrl` for every route and inherits the existing origin,
mutation-header and authenticated proxy guards.

## Added user requirements

Use real official Kiro and Codex icons through the shared assistant mark.
Bundle the assets locally so icons work under the proxy and offline.

Show installed and latest public CLI versions for Codex, Claude Code and Kiro
with comparison status, check timestamp and official source. Latest checks query
fixed vendor distribution metadata only; local version strings, configurations
and account data are never included in requests. Keep the last/current installed
version visible on fetch failures, and never interpret an unavailable latest
version as up to date. Distinguish prereleases/other channels from upgrades.
No CLI or plugin updates are executed. Demo version data is explicitly sampled.

## Data size and response time (user addition)

Measure the actual cache tables, indexes and request costs before optimizing.
Preserve source Kiro databases and user annotations. No automatic historical
deletion is authorized by the request to improve efficiency.

Move expensive native parsing/indexing out of the HTTP event loop using an owned,
bounded invocation of Agent Ops' existing sync CLI. Retain source formats,
fingerprints and explicit synchronization behavior. Verify responsiveness and
shutdown without launching coding assistants. Use measured storage findings to
reduce redundant storage or avoid unnecessary rewrites while preserving search.

## Korean and English (user addition)

Add a language toggle directly beside the topbar theme control. Korean remains
the default; store the browser's explicit choice locally and update the document
language. Translate navigation, actions, settings, version and extension status,
dialogs, empty states and application notices. Switching language must preserve
the current page, filters and unsaved forms.

Keep conversations, skill instructions, user-authored names and notes, paths,
code and model identifiers in their original language. Use an explicit UI
dictionary and React state; do not mutate arbitrary document text or send
content to a translation service.

## Verification

Use real temporary directory trees for native config/manifest fixtures. Test
Codex TOML overrides, Claude install/enable scopes, Kiro agent resources and
powers, malformed files, cached versions, secret redaction and traversal.
Browser tests cover filtering, detail, file preview, analysis draft, responsive
layout and the proxy prefix. Run the full project checks before updating the
live service. Real model inference is outside the verification scope.
