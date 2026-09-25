import type { Agent } from './types.js';

/** These states describe local declarations, never a native CLI's live connection. */
export type McpScope = 'user' | 'project' | 'local';
export type McpConfigStatus = 'enabled' | 'disabled' | 'unknown' | 'shadowed';
export type McpTransport = 'stdio' | 'http' | 'sse' | 'unsupported';
export type McpCheckStatus = 'running' | 'reachable' | 'failed' | 'cancelled' | 'timeout' | 'unsupported';
export type McpClient = 'codex-app' | 'codex-cli' | 'claude-code-desktop' | 'claude-code-cli'
  | 'claude-desktop-chat' | 'kiro-ide' | 'kiro-cli';
export interface McpClientState {
  client: McpClient;
  status: McpConfigStatus;
  statusReason: string;
  /** Opaque ID of the higher-precedence declaration for this consumer, if known. */
  shadowedBy: string | null;
}
export interface McpFinding {
  code: string;
  level: 'info' | 'warning' | 'error';
  message: string;
}
export interface McpSource {
  /** A display path only. No API accepts a path or a replacement target. */
  path: string;
  format: 'toml' | 'json' | 'yaml';
  kind: 'config' | 'plugin' | 'agent' | 'power';
  pluginName: string | null;
  agentName: string | null;
  /** Configuration family/shared-file readers, never installed or live-client evidence.
   * Cross-imports (Desktop Chat into Code Desktop) are explained separately in findings. */
  clients?: McpClient[];
}
export interface McpConfiguration {
  command: string | null;
  /** Argument values are always redacted, including positional arguments. */
  args: string[];
  cwd: string | null;
  /** Only the unexpanded origin is displayed; URL credentials, path and query are hidden. */
  url: string | null;
  environmentNames: string[];
  inheritedEnvironmentNames: string[];
  headerNames: string[];
  missingEnvironmentNames: string[];
  hasOAuth: boolean;
  hasHeadersHelper: boolean;
  enabledTools: string[] | null;
  disabledTools: string[];
  redacted: true;
}
export interface McpCheckSummary {
  id: string;
  status: McpCheckStatus;
  startedAt: string;
  finishedAt: string | null;
}
export interface McpServerSummary {
  id: string;
  agent: Agent;
  name: string;
  scope: McpScope;
  projectId: string | null;
  transport: McpTransport;
  status: McpConfigStatus;
  statusReason: string;
  source: McpSource;
  configuration: McpConfiguration;
  findings: McpFinding[];
  /** Per-consumer configuration evidence. Mixed states aggregate to status=unknown. */
  clientStates?: McpClientState[];
  checkSupport: 'supported' | 'blocked' | 'unsupported';
  /** null means not checked; these are independent workbench probes. */
  lastCheck: McpCheckSummary | null;
}
export interface McpQuery {
  projectId?: string;
  agent?: Agent;
  scope?: McpScope;
  status?: McpConfigStatus;
  transport?: McpTransport;
  q?: string;
  offset?: number;
  limit?: number;
}
export interface McpCatalog {
  items: McpServerSummary[];
  total: number;
  offset: number;
  limit: number;
  scannedAt: string;
  projectId: string | null;
  warnings: string[];
  usageNotice: string;
  demo: boolean;
  activeCheck: McpCheckSummary | null;
}
export interface McpDetail extends McpServerSummary {
  lastResult: McpCheck | null;
  usageNotice: string;
  demo: boolean;
}
export interface McpCheckPreview {
  serverId: string;
  projectId: string | null;
  previewId: string;
  expiresAt: string;
  canCheck: boolean;
  startsProcess: boolean;
  transport: McpTransport;
  configuration: McpConfiguration;
  blockedReasons: McpFinding[];
  notices: string[];
  timeoutMs: number;
  methods: ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list'];
  demo: boolean;
}
export interface McpMetadataItem {
  name: string;
  title: string | null;
  description: string | null;
}
export interface McpMetadataList {
  status: 'not-requested' | 'ok' | 'unsupported' | 'failed';
  items: McpMetadataItem[];
  /** Count actually returned, not the unobserved total on the remote server. */
  count: number;
  truncated: boolean;
}
export interface McpCheck extends McpCheckSummary {
  serverId: string;
  projectId: string | null;
  transport: McpTransport;
  durationMs: number | null;
  protocolVersion: string | null;
  serverInfo: { name: string; version: string } | null;
  capabilities: { tools: boolean; resources: boolean; prompts: boolean } | null;
  tools: McpMetadataList;
  resources: McpMetadataList;
  prompts: McpMetadataList;
  error: { code: string; message: string } | null;
  warnings: string[];
  usageNotice: string;
}
export interface McpResourceRoot {
  pid: number;
  ownerId: string;
  kind: 'mcp';
  processGroup: boolean;
}
export interface McpSelection { projectId?: string }
export interface McpCheckRequest extends McpSelection { previewId: string }
