import type { SyncReport } from './types.js';

export type SyncMode = 'interval' | 'idle' | 'manual';

export interface SyncPolicy {
  mode: SyncMode;
  intervalSeconds: number;
  maxSeconds: number;
}

export const DEFAULT_SYNC_POLICY: Readonly<SyncPolicy> = Object.freeze({
  mode: 'interval', intervalSeconds: 60, maxSeconds: 1800,
});

export interface SyncAttempt {
  id: string;
  trigger: 'automatic' | 'manual';
  startedAt: string;
  maxSeconds: number;
}

export type SyncOutcome = 'completed' | 'cancelled' | 'timed-out' | 'failed';

export interface SyncLastAttempt extends SyncAttempt {
  finishedAt: string;
  outcome: SyncOutcome;
  error: string | null;
  report?: SyncReport;
}

export interface SyncStatus {
  policy: SyncPolicy;
  demo: boolean;
  autoEnabled: boolean;
  activity: 'idle' | 'running' | 'stopping';
  automaticState: 'scheduled' | 'manual' | 'waiting-for-idle' | 'disabled';
  nextCheckAt: string | null;
  currentAttempt: SyncAttempt | null;
  lastAttempt: SyncLastAttempt | null;
}
