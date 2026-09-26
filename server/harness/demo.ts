import { createHash } from 'node:crypto';
import {
  HARNESS_CLIENTS, type HarnessAuditPage, type HarnessAuditQuery, type HarnessAuditRecord,
  type HarnessBinding, type HarnessHookPreview, type HarnessHookRequest, type HarnessPolicyDetail,
  type HarnessRuntime, type HarnessSettings, type HarnessStorage,
} from '../../shared/harness.js';
import { HARNESS_ENGINE_VERSION, harnessError } from './types.js';

export const DEMO_HARNESS_POLICY = `version: "1.0"
mode: standard
identity:
  name: Demo project protection
  description: Explicit local tool governance
rules:
  - id: protect-destructive-operations
    description: Review destructive shell commands
    severity: error
    enforcement: hook
    triggers:
      - tool: Bash
        pattern: 'rm\\s+-rf'
permissions:
  defaults:
    unknown_tool: ask
    unknown_path: deny
    on_error: deny
  tools:
    Read:
      policy: allow
    Bash:
      policy: restricted
      deny_patterns:
        - 'rm\\s+-rf'
risk:
  classifier: rules
  thresholds:
    low: allow
    medium: ask
    high: deny
    critical: deny
hooks:
  profile: standard
audit:
  enabled: true
  output: .autoharness/audit.jsonl
  retention_days: 30
`;
export const demoRuntime = (): HarnessRuntime => ({
  state: 'ready', pythonPath: '/demo/autoharness-venv/bin/python', pythonVersion: '3.12.0',
  engineVersion: HARNESS_ENGINE_VERSION, testedVersion: HARNESS_ENGINE_VERSION, checkedAt: null, error: null,
});
export function demoPolicy(projectId: string | null): HarnessPolicyDetail {
  return {
    id: 'demo-harness-standard', name: 'Demo project protection', scope: 'builtin', projectId,
    path: null, revision: createHash('sha256').update(DEMO_HARNESS_POLICY).digest('hex'),
    bytes: Buffer.byteLength(DEMO_HARNESS_POLICY), valid: true, mode: 'standard',
    ruleCount: 1, editable: false, redacted: false, warnings: [], content: DEMO_HARNESS_POLICY,
    rules: [{ id: 'protect-destructive-operations', description: 'Review destructive shell commands', severity: 'error', enforcement: 'hook' }],
  };
}
export function demoBindings(projectId: string | null): HarnessBinding[] {
  return HARNESS_CLIENTS.map(client => ({
    client, projectId, state: client === 'codex' ? 'needs-review' : 'configured',
    path: client.startsWith('kiro') ? '/demo/project/.kiro/hooks/agent-ops-autoharness.json'
      : client === 'codex' ? '/demo/project/.codex/hooks.json' : '/demo/project/.claude/settings.local.json',
    scope: 'project', managed: true, policyRevision: demoPolicy(projectId).revision,
    detectedVersion: null,
    requiredVersion: client === 'kiro-ide' ? '1.0.0' : client === 'kiro-cli' ? '3.0.0' : null,
    lastObservedAt: null, notices: ['데모 연결 상태이며 실제 훅을 설치하지 않습니다.'],
  }));
}
export function emptyHarnessStorage(settings: HarnessSettings): HarnessStorage {
  return {
    cachedRecords: 0, cacheLimit: settings.maxCacheRecords, retentionDays: settings.retentionDays,
    sourceBytes: 0, bytesRead: 0, truncated: false, invalidLines: 0,
  };
}
export function demoAudit(query: HarnessAuditQuery, settings: HarnessSettings): HarnessAuditPage {
  const projectId = query.projectId ?? null;
  const records: HarnessAuditRecord[] = [
    { action: 'deny', client: 'claude-code', toolName: 'Bash', reason: 'Destructive operation requires review.', risk: 'critical' },
    { action: 'ask', client: 'codex', toolName: 'Bash', reason: 'Review the requested repository change.', risk: 'medium' },
    { action: 'allow', client: 'kiro', toolName: 'Read', reason: 'Read access matches the selected policy.', risk: 'low' },
    { action: 'allow', client: 'claude-code', toolName: 'Read', reason: 'Read access matches the selected policy.', risk: 'low' },
    { action: 'error', client: null, toolName: 'Bash', reason: 'Synthetic engine timeout.', risk: null },
  ].map((item, index) => ({
    ...item, id: `demo-audit-${index}`, sourceId: 'demo-harness-audit', projectId,
    timestamp: new Date(Date.now() - (index + 1) * 60000).toISOString(), sessionId: `demo-session-${index % 2}`,
    runId: null, eventType: index === 1 ? 'check' : 'PreToolUse',
    origin: index === 1 ? 'agent-ops-test' : 'agent-ops-hook', status: null, durationMs: 12 + index,
  } as HarnessAuditRecord));
  const needle = query.q?.trim().toLocaleLowerCase();
  const filtered = records.filter(item => (!query.client || item.client === query.client)
    && (!query.action || item.action === query.action) && (!query.sessionId || item.sessionId === query.sessionId)
    && (!needle || [item.toolName, item.reason, item.sessionId].join(' ').toLocaleLowerCase().includes(needle)));
  const offset = query.offset ?? 0, limit = query.limit ?? 25;
  return {
    items: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit,
    counts: { allow: 2, ask: 1, deny: 1, error: 1 },
    storage: { ...emptyHarnessStorage(settings), cachedRecords: records.length },
    sources: [{ id: 'demo-harness-audit', path: '/demo/.autoharness/audit.jsonl', projectId, managed: true }],
    warnings: ['데모 감사 기록이며 실제 도구 실행 이력이 아닙니다.'],
  };
}
export function demoHookPreview(request: HarnessHookRequest): HarnessHookPreview {
  if (!request.projectId) throw harnessError(400, '프로젝트를 먼저 선택하세요.');
  return {
    id: 'harness-preview-demo', projectId: request.projectId, client: request.client, action: request.action,
    canApply: false, expiresAt: new Date(Date.now() + 60000).toISOString(),
    files: [], notices: ['데모에서는 실제 엔진 실행과 훅 설정 변경을 할 수 없습니다.'],
  };
}
