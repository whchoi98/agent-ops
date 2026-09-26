import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Project } from '../../shared/types.js';
import type { HarnessAuditSource, HarnessClient, HarnessPolicyDetail } from '../../shared/harness.js';

export const HARNESS_ENGINE_VERSION = '0.1.1';
export const HARNESS_ENGINE_COMMIT = '3561e468f9ca9f9bf282512e695bd32e4e90fef4';
export const HARNESS_MAX_POLICY_BYTES = 64 * 1024;
export const HARNESS_MAX_INPUT_BYTES = 64 * 1024;
export const HARNESS_MAX_OUTPUT_BYTES = 128 * 1024;
export const HARNESS_MAX_AUDIT_READ_BYTES = 1024 * 1024;
export const HARNESS_TIMEOUT_MS = 15000;

export function harnessPaths(dataDir: string, projectId: string | null) {
  const scope = projectId === null ? 'global' : createHash('sha256').update(projectId).digest('hex').slice(0, 32);
  const directory = join(dataDir, 'harness', 'scopes', scope);
  return {
    directory, policyPath: join(directory, 'constitution.yaml'),
    auditPath: join(directory, 'audit', 'events.jsonl'), bindingsDir: join(directory, 'bindings'),
  };
}
export function harnessError(statusCode: number, message: string) {
  return Object.assign(new Error(message), { statusCode });
}
/** Paths remain private; public consumers receive opaque IDs and redacted metadata. */
export interface HarnessAuditFile extends HarnessAuditSource { root: string }
export interface HarnessResolvedPolicy {
  detail: HarnessPolicyDetail;
  content: string;
  config: Record<string, unknown>;
}
export interface HarnessPolicySnapshot {
  policies: HarnessPolicyDetail[];
  auditSources: HarnessAuditFile[];
  warnings: string[];
}
/** Immutable bridge input saved before activating a native hook. */
export interface HarnessHookBindingFile {
  protocol: 1;
  client: HarnessClient | 'kiro';
  projectId: string;
  projectDir: string;
  policyId: string;
  policyRevision: string;
  policy: Record<string, unknown>;
  pythonPath: string;
  engineVersion: string;
  createdAt: string;
}
export interface HarnessProjectContext { project: Project | null }
