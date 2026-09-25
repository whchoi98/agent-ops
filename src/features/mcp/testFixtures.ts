import type {
  McpCatalog, McpCheck, McpCheckPreview, McpConfiguration, McpDetail, McpServerSummary,
} from '../../../shared/mcp';
import type { Project } from '../../../shared/types';

/** Synthetic DTOs only; these helpers never discover or read local configuration. */
export const fixtureProject: Project = {
  id: 'fixture-project', name: '합성 프로젝트', path: '/fixture/project',
  color: '#3564e8', executionEnabled: true, createdAt: '2026-09-25T00:00:00Z',
};
export const fixtureServerId = 'mcp-0123456789abcdef01234567';
export const fixtureCheckId = 'mcp-check-01234567-89ab-4cde-8fab-0123456789ab';

export function mcpConfiguration(patch: Partial<McpConfiguration> = {}): McpConfiguration {
  return {
    command: 'fixture-mcp', args: ['[redacted]'], cwd: '/fixture/project', url: null,
    environmentNames: ['MCP_ACCESS_KEY'], inheritedEnvironmentNames: ['MCP_REGION'],
    headerNames: [], missingEnvironmentNames: [], hasOAuth: false, hasHeadersHelper: false,
    enabledTools: null, disabledTools: [], redacted: true, ...patch,
  };
}

export function mcpServer(patch: Partial<McpServerSummary> = {}): McpServerSummary {
  return {
    id: fixtureServerId, agent: 'codex', name: '원문 서버', scope: 'user', projectId: null,
    transport: 'stdio', status: 'enabled',
    statusReason: 'Declared in local configuration; native client connectivity is unknown.',
    source: { path: '/fixture/config.toml', format: 'toml', kind: 'config', pluginName: null, agentName: null },
    configuration: mcpConfiguration(), findings: [], checkSupport: 'supported', lastCheck: null, ...patch,
  };
}

export function mcpCheck(patch: Partial<McpCheck> = {}): McpCheck {
  return {
    id: fixtureCheckId, serverId: fixtureServerId, projectId: null, transport: 'stdio',
    status: 'running', startedAt: '2026-09-25T10:00:00Z', finishedAt: null,
    durationMs: null, protocolVersion: null, serverInfo: null, capabilities: null,
    tools: { status: 'not-requested', items: [], count: 0, truncated: false },
    resources: { status: 'not-requested', items: [], count: 0, truncated: false },
    prompts: { status: 'not-requested', items: [], count: 0, truncated: false },
    error: null, warnings: [], usageNotice: '', ...patch,
  };
}

export function mcpDetail(patch: Partial<McpDetail> = {}): McpDetail {
  return { ...mcpServer(), lastResult: null, usageNotice: '', demo: false, ...patch };
}

export function mcpPreview(patch: Partial<McpCheckPreview> = {}): McpCheckPreview {
  return {
    serverId: fixtureServerId, projectId: null,
    previewId: 'mcp-preview-01234567-89ab-4cde-8fab-0123456789ab',
    expiresAt: '2099-01-01T00:00:00Z', canCheck: true, startsProcess: true, transport: 'stdio',
    configuration: mcpConfiguration(), blockedReasons: [], notices: [], timeoutMs: 10000,
    methods: ['initialize', 'notifications/initialized', 'tools/list', 'resources/list', 'prompts/list'],
    demo: false, ...patch,
  };
}

export function mcpCatalog(patch: Partial<McpCatalog> = {}): McpCatalog {
  return {
    items: [mcpServer()], total: 1, offset: 0, limit: 20, scannedAt: '2026-09-25T09:00:00Z',
    projectId: null, warnings: [], usageNotice: '', demo: false, activeCheck: null, ...patch,
  };
}
