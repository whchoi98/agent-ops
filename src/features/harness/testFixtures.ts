import type {
  HarnessAuditPage, HarnessAuditRecord, HarnessBinding, HarnessCatalog, HarnessDecision, HarnessHookPreview,
  HarnessPolicyDetail, HarnessRuntime, HarnessSettings, HarnessStorage,
} from '../../../shared/harness';
import type { Project } from '../../../shared/types';

export const harnessProject: Project = {
  id: 'project-synthetic', name: 'Synthetic project', path: '/tmp/harness-synthetic',
  color: '#3564e8', executionEnabled: true, createdAt: '2026-09-26T00:00:00.000Z',
};
export const settings = (patch: Partial<HarnessSettings> = {}): HarnessSettings => ({
  revision: 1, pythonPath: null, retentionDays: 30, maxCacheRecords: 2000, ...patch,
});
export const runtime = (patch: Partial<HarnessRuntime> = {}): HarnessRuntime => ({
  state: 'ready', pythonPath: '/opt/synthetic/bin/python3', pythonVersion: '3.12.1',
  engineVersion: '0.1.1', testedVersion: '0.1.1', checkedAt: '2026-09-26T01:00:00.000Z', error: null, ...patch,
});
export const policy = (patch: Partial<HarnessPolicyDetail> = {}): HarnessPolicyDetail => ({
  id: 'policy:managed', name: '원문 정책 <script>', scope: 'managed', projectId: harnessProject.id,
  path: '/tmp/synthetic/constitution.yaml', revision: 'revision-1', bytes: 30, valid: true,
  mode: 'standard', ruleCount: 0, editable: true, redacted: false, warnings: [],
  content: 'version: "1.0"\nrules: []\n', rules: [], ...patch,
});
export const binding = (patch: Partial<HarnessBinding> = {}): HarnessBinding => ({
  client: 'codex', projectId: harnessProject.id, state: 'unconfigured', path: null, scope: 'project',
  managed: false, policyRevision: null, detectedVersion: null, requiredVersion: null,
  lastObservedAt: null, notices: [], ...patch,
});
export const storage = (patch: Partial<HarnessStorage> = {}): HarnessStorage => ({
  cachedRecords: 32, cacheLimit: 2000, retentionDays: 30, sourceBytes: 6000, bytesRead: 5000,
  truncated: false, invalidLines: 0, ...patch,
});
export const catalog = (patch: Partial<HarnessCatalog> = {}): HarnessCatalog => ({
  projectId: harnessProject.id, scannedAt: '2026-09-26T01:00:00.000Z', demo: false,
  runtime: runtime(), settings: settings(), policies: [policy()], bindings: [binding()],
  auditSources: [], storage: storage(), warnings: [], ...patch,
});
export const decision = (patch: Partial<HarnessDecision> = {}): HarnessDecision => ({
  client: 'codex', projectId: harnessProject.id, policyId: policy().id, policyRevision: 'revision-1',
  toolName: 'Bash', action: 'ask', risk: 'high', reason: '정책 원문 이유 <script>',
  matchedRules: ['rule-literal'], engineVersion: '0.1.1', checkedAt: '2026-09-26T01:00:00.000Z',
  durationMs: 35, executed: false, ...patch,
});
export const hookPreview = (patch: Partial<HarnessHookPreview> = {}): HarnessHookPreview => ({
  id: 'preview-synthetic', projectId: harnessProject.id, client: 'codex', action: 'install',
  canApply: true, expiresAt: '2099-01-01T00:00:00.000Z',
  files: [{ path: '/tmp/synthetic/.codex/config.toml', existed: true, before: 'token = "[REDACTED]"', after: 'hooks = "[managed]"' }],
  notices: [], ...patch,
});
export const auditRecord = (patch: Partial<HarnessAuditRecord> = {}): HarnessAuditRecord => ({
  id: 'audit-synthetic', sourceId: 'source-synthetic', timestamp: '2026-09-26T01:00:00.000Z',
  client: 'kiro', projectId: harnessProject.id, sessionId: 'session-synthetic', runId: null,
  toolName: 'execute_bash', action: 'deny', risk: 'critical', reason: '원문 사유 <script>',
  eventType: 'preToolUse', origin: 'agent-ops-hook', status: null, durationMs: 22, ...patch,
});
export const auditPage = (patch: Partial<HarnessAuditPage> = {}): HarnessAuditPage => ({
  items: [auditRecord()], total: 32, offset: 0, limit: 20,
  counts: { allow: 20, ask: 2, deny: 9, error: 1 }, storage: storage(),
  sources: [{ id: 'source-synthetic', path: '/tmp/synthetic/events.jsonl', projectId: harnessProject.id, managed: true }],
  warnings: [], ...patch,
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
