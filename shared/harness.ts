export const HARNESS_CLIENTS = ['codex', 'claude-code', 'kiro-ide', 'kiro-cli'] as const;
export type HarnessClient = typeof HARNESS_CLIENTS[number];
export const HARNESS_AUDIT_CLIENTS = [...HARNESS_CLIENTS, 'kiro'] as const;
export type HarnessAuditClient = typeof HARNESS_AUDIT_CLIENTS[number];
export type HarnessMode = 'core' | 'standard' | 'enhanced';
export type HarnessAction = 'allow' | 'ask' | 'deny' | 'error';
export type HarnessRisk = 'low' | 'medium' | 'high' | 'critical';
export type HarnessScope = 'builtin' | 'user' | 'project' | 'local' | 'managed';

export interface HarnessSettings {
  revision: number;
  pythonPath: string | null;
  retentionDays: number;
  maxCacheRecords: number;
}
export interface HarnessRuntime {
  state: 'unchecked' | 'ready' | 'missing' | 'unsupported' | 'error';
  pythonPath: string | null;
  pythonVersion: string | null;
  engineVersion: string | null;
  testedVersion: string;
  checkedAt: string | null;
  error: string | null;
}
export interface HarnessPolicySummary {
  id: string;
  name: string;
  scope: HarnessScope;
  projectId: string | null;
  path: string | null;
  revision: string;
  bytes: number;
  valid: boolean;
  mode: HarnessMode | null;
  ruleCount: number;
  editable: boolean;
  redacted: boolean;
  warnings: string[];
}
export interface HarnessPolicyDetail extends HarnessPolicySummary {
  content: string;
  rules: Array<{ id: string; description: string; severity: string; enforcement: string }>;
}
export interface HarnessValidation {
  valid: boolean;
  engineValidated: boolean;
  mode: HarnessMode | null;
  ruleCount: number;
  errors: string[];
  warnings: string[];
}
export interface HarnessBinding {
  client: HarnessClient;
  projectId: string | null;
  state: 'unconfigured' | 'configured' | 'needs-review' | 'changed' | 'unsupported' | 'unknown';
  path: string | null;
  scope: 'user' | 'project' | null;
  managed: boolean;
  policyRevision: string | null;
  detectedVersion: string | null;
  requiredVersion: string | null;
  lastObservedAt: string | null;
  notices: string[];
}
export interface HarnessStorage {
  cachedRecords: number;
  cacheLimit: number;
  retentionDays: number;
  sourceBytes: number;
  bytesRead: number;
  truncated: boolean;
  invalidLines: number;
}
export interface HarnessAuditSource {
  id: string;
  path: string;
  projectId: string | null;
  managed: boolean;
}
export interface HarnessCatalog {
  projectId: string | null;
  scannedAt: string;
  demo: boolean;
  runtime: HarnessRuntime;
  settings: HarnessSettings;
  policies: HarnessPolicySummary[];
  bindings: HarnessBinding[];
  auditSources: HarnessAuditSource[];
  storage: HarnessStorage;
  warnings: string[];
}
export interface HarnessEvaluationRequest {
  projectId?: string;
  policyId: string;
  revision: string;
  client: HarnessClient;
  toolName: string;
  toolInput: Record<string, unknown>;
}
export interface HarnessDecision {
  client: HarnessClient;
  projectId: string | null;
  policyId: string;
  policyRevision: string;
  toolName: string;
  action: HarnessAction;
  risk: HarnessRisk | null;
  reason: string;
  matchedRules: string[];
  engineVersion: string;
  checkedAt: string;
  durationMs: number;
  executed: false;
}
export interface HarnessHookRequest {
  projectId: string;
  client: HarnessClient;
  action: 'install' | 'remove';
  policyId?: string;
  revision?: string;
}
export interface HarnessHookPreview {
  id: string;
  projectId: string;
  client: HarnessClient;
  action: 'install' | 'remove';
  canApply: boolean;
  expiresAt: string;
  files: Array<{ path: string; existed: boolean; before: string; after: string }>;
  notices: string[];
}
export interface HarnessAuditRecord {
  id: string;
  sourceId: string;
  timestamp: string;
  client: HarnessAuditClient | null;
  projectId: string | null;
  sessionId: string | null;
  runId: string | null;
  toolName: string;
  action: HarnessAction;
  risk: HarnessRisk | null;
  reason: string;
  eventType: string;
  origin: 'autoharness' | 'agent-ops-test' | 'agent-ops-hook';
  status: string | null;
  durationMs: number | null;
}
export interface HarnessAuditQuery {
  projectId?: string;
  client?: HarnessAuditClient;
  action?: HarnessAction;
  sessionId?: string;
  q?: string;
  offset?: number;
  limit?: number;
}
export interface HarnessAuditPage {
  items: HarnessAuditRecord[];
  /** Matching records in the retained window, never the unobserved source total. */
  total: number;
  offset: number;
  limit: number;
  counts: Record<HarnessAction, number>;
  storage: HarnessStorage;
  sources: HarnessAuditSource[];
  /** Latest app-hook event per client in this exact retained source window. */
  observed?: Partial<Record<HarnessAuditClient, string>>;
  warnings: string[];
}
