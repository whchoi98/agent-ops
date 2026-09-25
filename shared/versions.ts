import type { Agent } from './types.js';

export type VersionStatus = 'current' | 'update-available' | 'ahead' | 'not-installed' | 'unknown' | 'check-failed';
export interface ConnectorVersion {
  agent: Agent;
  /** null means the local probe did not establish presence or absence. */
  installed: boolean | null;
  currentVersion: string | null;
  currentRaw: string | null;
  latestVersion: string | null;
  status: VersionStatus;
  checkedAt: string | null;
  sourceUrl: string;
  releaseUrl: string;
  channel: string;
  error: string | null;
}
export interface VersionReport {
  items: ConnectorVersion[];
  demo: boolean;
  notice: string;
}
