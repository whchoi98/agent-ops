# Independent MCP backend

This module discovers local MCP declarations and performs explicit, independent
metadata probes. Configuration presence, `source.clients`, and an earlier probe
are not evidence that a native client is installed, running, or connected.
The module never changes native configuration or imports OAuth credentials.

## Integration

```ts
import { McpService, registerMcpRoutes } from './mcp/index.js';

const mcp = new McpService({ demo }, () => store.listProjects());
registerMcpRoutes(app, mcp);
// Include copies from mcp.resourceRoots in the resource sampler.
// registerMcpRoutes also installs an idempotent mcp.close() Fastify onClose hook.
```

The constructor is `new McpService(options: McpServiceOptions,
getProjects: () => Project[])`. `close(): Promise<void>` waits for owned probe
cleanup. `resourceRoots` returns copies of
`{ pid, ownerId, kind: 'mcp', processGroup }`; `ownerId` is the check ID.
The embedding app retains its Host, Origin, local-peer and configured-proxy
guards. All mutation routes additionally require `X-Agent-Ops: 1`.

| Method | Path | Query or JSON body | Response |
| --- | --- | --- | --- |
| GET | `/api/mcp` | `projectId?, agent?, scope?, status?, transport?, q?, offset?, limit?` | `McpCatalog` |
| GET | `/api/mcp/:id` | `projectId?` query | `McpDetail` |
| POST | `/api/mcp/refresh` | `{ projectId? }` | `{ ok: true }` |
| POST | `/api/mcp/:id/preview` | `{ projectId? }` | `McpCheckPreview` |
| POST | `/api/mcp/:id/check` | `{ previewId, projectId? }` | 202 `McpCheck` |
| GET | `/api/mcp/checks/:checkId` | None | `McpCheck` |
| POST | `/api/mcp/checks/:checkId/cancel` | `{}` | `McpCheck` |

Unknown keys, target URLs, commands, filesystem paths, and unregistered project
IDs are rejected. Preview IDs are short-lived, single-use, scope-bound, and
invalidated by refresh or changed configuration/execution settings. Every check
revalidates its configuration. GET, refresh, and preview never start a process or
network connection.

## Configuration sources and clients

`McpSource.clients` identifies the configuration source family and readers of
shared files. `McpServerSummary.clientStates` separately describes applicability
and precedence for each consuming client. Both fields are optional for existing
consumers. Neither reports actual client installation, activity or connectivity.

Each `clientStates` entry has `{ client, status, statusReason, shadowedBy }`.
`shadowedBy` is the higher-precedence declaration's opaque ID, or `null`.
Uniform consumer statuses become the row's `status`; differing statuses aggregate
to `unknown`. An absent consumer is not an assertion about that client's
installation; that source is not directly applicable to it in this adapter.

| Configuration family | Sources | Client identifiers |
| --- | --- | --- |
| Codex App / CLI | `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`); the selected project's `.codex/config.toml` | `codex-app`, `codex-cli` |
| Claude Code | `~/.claude.json`, including only the selected project's local entry; selected `.mcp.json`; applicable `.claude/settings*.json` controls | `claude-code-cli`; also `claude-code-desktop` on macOS/Windows |
| Claude Desktop Chat on macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` | `claude-desktop-chat` |
| Kiro IDE / shared MCP JSON | `~/.kiro/settings/mcp.json`; selected `.kiro/settings/mcp.json` | `kiro-ide`, `kiro-cli` |
| Kiro agent declarations | Bounded `.kiro/agents/*.json` and Markdown frontmatter | `kiro-cli` |
| Bundled plugin/Power declarations | Owned Codex cache manifests, Claude installed-plugin registry v2, Kiro installed Power manifests; inline `mcpServers` or owned JSON component files | Parent configuration family; Kiro Powers use `kiro-ide` |

Codex project trust must be evidenced in the supported user configuration.
Codex tables merge; Claude and Kiro shared-server entries replace lower scopes.
Agent selection, ambiguous plugin cache versions, active profiles, managed
policies, account connectors, and native client sessions are not inferred.
Unknown plugin/Power activation blocks execution of cached targets.

Claude Code Desktop and CLI share Code configuration, but local Desktop Code
sessions also read the Desktop Chat file. The catalog preserves Chat as the
source family and adds both Chat and Code Desktop consumer states. Standalone
CLI is not a consumer of the Chat file; this module never invokes its import
command.

For local Code Desktop sessions, a Chat declaration takes precedence over a
duplicate name in Code configuration. Without that Chat override, a re-delivered
user-scope stdio declaration can take precedence over a project declaration.
Standalone CLI keeps local > project > user precedence. Unknown Desktop
interactions with local overrides remain `unknown` rather than inventing a rule.

For example, with one Chat declaration and one Code user declaration of the
same name:

| Source | Standalone CLI | Desktop Code | Desktop Chat | Row status |
| --- | --- | --- | --- | --- |
| Code user file | enabled | shadowed by Chat declaration | Not a direct source | unknown |
| Desktop Chat file | Not a direct source | enabled | enabled | enabled |

An approved Code project declaration can shadow the user declaration in the
CLI while Chat shadows both Code declarations in Desktop. That user declaration
is then correctly `shadowed` for every applicable consumer. Disabled Code
settings remain effective for Code consumers without disabling the independent
Chat consumer. A probe is blocked if all observed consumers disable or shadow
its declaration. None of these configuration decisions proves live connectivity.

Tests can inject `homeDir`, `codexHome`, `claudeHome`, `claudeConfigPath`,
`claudeDesktopConfigPath`, `kiroHome`, `platform`, and an isolated `env`.
`platform` selects discovery paths only: subprocess ownership always uses the
real host platform. Desktop Chat configuration is discovered automatically on
macOS; other platforms can supply an explicit trusted configuration path.
No application bundle, plist, version metadata, private database or keychain is
read.

## Checks and public data

Supported probe transports are POSIX stdio, Streamable HTTP with JSON or SSE
responses, and explicitly declared legacy HTTP+SSE. The client initializes,
sends `notifications/initialized`, and requests advertised `tools/list`,
`resources/list` and `prompts/list` methods with bounded pagination. It never
requests `tools/call`, `resources/read`, `prompts/get`, sampling or inference.
Server-initiated operations are refused; ping responses are protocol control.

The offered protocol version is `2025-11-25`; negotiation also accepts
`2025-06-18`, `2025-03-26`, and `2024-11-05`. Other negotiated versions report
`unsupported`, rather than pretending a successful connection.

Stdio uses argument arrays and a detached process group. With a project selected,
the default working directory and execution gate belong to that registered
project, including for user-scope declarations. Without a project, the default
is the configured workbench home. Explicit cwd values are validated. The
environment contains a minimal operating-system set and explicitly configured
variables; it does not inherit unrelated model credentials or `NODE_OPTIONS`.
Every stdio preview says it starts a configured process, whose startup can have
side effects.

HTTP uses only the configured endpoint. Redirects are refused; legacy SSE
message endpoints must remain on the configured origin. Plain HTTP is limited
to loopback; HTTPS uses the host TLS trust configuration. Only a session ID
issued in this probe's initialization response can be used for best-effort
HTTP session deletion. Legacy SSE cleanup closes its own stream. There is no
automatic reconnect, fallback to a different endpoint, OAuth flow, native
credential reuse, or dynamic-header-helper execution.

Results are `running`, `reachable`, `failed`, `cancelled`, `timeout`, or
`unsupported`, with timestamps. No last result means the current configuration
has not been checked. Results contain only bounded metadata names, titles and
descriptions; schemas, resource URIs, response/error bodies, stdout/stderr,
environment values, header values, session IDs and argument values are not
published. Known credentials and their common encoded forms are redacted from
metadata and aliases in other summaries. The configured URL's path/query and
expanded environment-defined endpoint are hidden.

## Bounds and limits

Defaults are clamped by the implementation even when options override them:

- Eight cached selections, two simultaneous filesystem discoveries, a 60-second
  cache TTL, 256 configuration reads, 4 MiB total configuration input, 256 KiB per
  configuration, 4,096 directory entries, and 512 declarations.
- One probe across all service instances in the process; 64 previews with a
  60-second expiry; 64 retained results. Refresh invalidates previews, not an
  already running probe.
- A 10-second protocol deadline, followed by bounded owned cleanup. Default
  stdio cleanup has two waits of at most 250 ms; HTTP session deletion has a
  250 ms deadline.
- 256 KiB per protocol message, 2 MiB cumulative protocol/stderr bytes, 1,024
  received JSON-RPC messages, four pages and 100 observed entries per metadata
  family. Truncation is explicit; counts do not claim unseen totals.

Unsupported features include Windows stdio process-group cleanup, WebSocket and
remote-executor transports, native/account OAuth sessions, dynamic HTTP header
helpers, and remote Desktop Chat connectors stored outside the documented local
stdio file. Discovery does not walk project ancestors or unknown plugin roots.
Power activation and conflicting cache versions require better native evidence
before their commands can be probed. Cleanup does not reverse process startup
side effects or signal processes that escaped the owned group.

## Validation and source references

`tests/mcp-*.test.ts` use temporary homes, synthetic credentials, real fake local
MCP processes, loopback HTTP/SSE servers and controlled project records.
They cover client identity, scope precedence, redaction, opaque previews, stale
configuration, strict routes, bounded metadata/protocol errors, cancellation,
single-probe admission, owned descendants and unrelated-process survival.
The macOS path/client tests run through `platform: 'darwin'` on Linux; they are
not a native macOS application verification.

Official configuration and protocol documentation retrieved on **2026-09-25**
for this module (also consistent with the coordinator's desktop inventory
reference):

- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex configuration and CODEX_HOME](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [Claude Code MCP configuration](https://code.claude.com/docs/en/mcp)
- [Claude Code Desktop sharing and precedence](https://code.claude.com/docs/en/desktop)
- [Claude Desktop local MCP configuration](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Kiro IDE and CLI MCP configuration](https://kiro.dev/docs/mcp/configuration/)
- [MCP transport specification, 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
