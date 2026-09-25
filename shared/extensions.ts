import type { Agent, RunRequest } from './types.js';

export type ExtensionKind = 'skill' | 'plugin' | 'power';
export type ExtensionScope = 'user' | 'project' | 'system';
export type ExtensionStatus = 'enabled' | 'disabled' | 'available' | 'unknown' | 'cached';
export type ExtensionFileKind = 'instructions' | 'manifest' | 'script' | 'reference' | 'hook' | 'mcp' | 'agent' | 'other';
export interface ExtensionEvidence { source: string; detail: string }
export interface ExtensionFinding { level: 'info' | 'warning'; title: string; detail: string }
export interface ExtensionSummary {
  id: string;
  agent: Agent;
  kind: ExtensionKind;
  name: string;
  description: string;
  version: string | null;
  scope: ExtensionScope;
  path: string;
  status: ExtensionStatus;
  statusReason: string;
  evidence: ExtensionEvidence[];
  pluginId: string | null;
  pluginName: string | null;
  childCount: number;
  warnings: string[];
}
export interface ExtensionRoot {
  agent: Agent;
  path: string;
  scope: ExtensionScope;
  exists: boolean;
  description: string;
}
export interface ExtensionCounts {
  total: number; skills: number; plugins: number; powers: number;
  enabled: number; disabled: number; available: number; unknown: number; cached: number;
}
export interface ExtensionQuery {
  agent?: Agent;
  kind?: ExtensionKind;
  status?: ExtensionStatus;
  scope?: ExtensionScope;
  projectId?: string;
  q?: string;
  offset?: number;
  limit?: number;
}
export interface ExtensionCatalog {
  items: ExtensionSummary[];
  total: number;
  offset: number;
  limit: number;
  scannedAt: string;
  projectId: string | null;
  counts: Record<Agent, ExtensionCounts>;
  roots: ExtensionRoot[];
  warnings: string[];
  usageNotice: string;
  demo: boolean;
}
export interface ExtensionFile {
  id: string;
  path: string;
  kind: ExtensionFileKind;
  bytes: number;
  readable: boolean;
}
export interface ExtensionContent {
  fileId: string;
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
  redacted: boolean;
  language: string;
}
export interface ExtensionAnalysis {
  purpose: string;
  triggers: string[];
  tools: string[];
  mcpServers: string[];
  hooks: string[];
  resources: string[];
  sections: string[];
  links: string[];
  usedBy: string[];
  findings: ExtensionFinding[];
  lineCount: number;
}
export interface ExtensionDetail extends ExtensionSummary {
  entry: ExtensionContent | null;
  metadata: Record<string, unknown>;
  files: ExtensionFile[];
  analysis: ExtensionAnalysis;
  children: ExtensionSummary[];
}
export interface ExtensionAnalysisDraft {
  draft: Pick<RunRequest, 'agent' | 'title' | 'prompt' | 'policy'> & { projectId?: string };
  notice: string;
}
