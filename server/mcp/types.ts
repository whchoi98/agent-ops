import type { McpClientState, McpFinding, McpScope, McpServerSummary, McpSource } from '../../shared/mcp.js';
import type { Agent, Project } from '../../shared/types.js';
import type { McpServiceOptions } from './service.js';

export type Dictionary = Record<string, unknown>;
export const object = (value: unknown): Dictionary =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Dictionary : {};
export const strings = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string') : [];
export const bounded = (value: number | undefined, fallback: number, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
export const finding = (code: string, message: string, level: McpFinding['level'] = 'warning'): McpFinding => ({ code, level, message });
export const fail = (statusCode: number, message: string, code = 'mcp-request'): never => {
  throw Object.assign(new Error(message), { statusCode, code });
};
export interface Locations {
  homeDir: string;
  codexHome: string;
  claudeHome: string;
  claudeConfigPath: string;
  claudeDesktopConfigPath: string | null;
  kiroHome: string;
}
export interface Declaration {
  key: string;
  agent: Agent;
  name: string;
  scope: McpScope;
  source: McpSource;
  ownerRoot: string;
  pluginRoot?: string;
  raw: Dictionary;
  status: McpServerSummary['status'];
  configuredStatus?: McpServerSummary['status'];
  statusReason: string;
  findings: McpFinding[];
  clientStates?: McpClientState[];
}
export interface McpTarget {
  transport: McpServerSummary['transport'];
  command: string | null;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  url: string | null;
  headers: Record<string, string>;
  executionIdentity: string;
}
export interface McpRecord {
  declaration: Declaration;
  item: McpServerSummary;
  target: McpTarget;
  fingerprint: string;
  secrets: string[];
}
export interface McpSnapshot {
  records: Map<string, McpRecord>;
  warnings: string[];
  scannedAt: string;
  projectId: string | null;
}
export interface DiscoveryOptions extends Locations {
  options: McpServiceOptions;
  env: NodeJS.ProcessEnv;
  project: Project | null;
  id: (key: string) => string;
}
