import { describe, expect, it } from 'vitest';
import type { Bootstrap } from '../../shared/types';
import type { SyncStatus } from '../../shared/sync-control';
import { applySyncState, readSyncState } from './syncState';

const status: SyncStatus = {
  policy: { mode: 'interval', intervalSeconds: 60, maxSeconds: 1800 }, demo: false, autoEnabled: true,
  activity: 'running', automaticState: 'scheduled', nextCheckAt: null,
  currentAttempt: { id: 'attempt', trigger: 'manual', startedAt: '2026-09-25T00:00:00Z', maxSeconds: 1800 },
  lastAttempt: null,
};

describe('lightweight synchronization events', () => {
  it('updates only sync state while retaining the archive and analytics objects', () => {
    const before = { sessions: [], analytics: {}, syncing: false } as unknown as Bootstrap;
    const next = applySyncState(before, status)!;
    expect(next.syncing).toBe(true);
    expect(next.syncStatus).toEqual(status);
    expect(next.sessions).toBe(before.sessions);
    expect(next.analytics).toBe(before.analytics);
    expect(before.syncing).toBe(false);
  });

  it('does not construct an incomplete bootstrap when an event arrives before initial data', () => {
    expect(applySyncState(null, status)).toBeNull();
  });

  it('accepts a valid status frame and ignores other event types or malformed status', () => {
    expect(readSyncState({ type: 'sync-state', status })).toEqual(status);
    for (const event of [
      null, { type: 'refresh' }, { type: 'sync-state' },
      { type: 'sync-state', status: { ...status, activity: 'other' } },
      { type: 'sync-state', status: { ...status, activity: ['running'] } },
      { type: 'sync-state', status: { ...status, policy: { mode: 'unknown' } } },
      { type: 'sync-state', status: { ...status, policy: { ...status.policy, mode: ['interval'] } } },
      { type: 'sync-state', status: { ...status, currentAttempt: { ...status.currentAttempt, startedAt: 'broken' } } },
    ]) expect(readSyncState(event)).toBeNull();
  });

  it('retains an already fetched report only for the same last attempt', () => {
    const last = {
      id: 'old', trigger: 'manual' as const, startedAt: '2026-09-25T00:00:00Z',
      finishedAt: '2026-09-25T00:00:01Z', maxSeconds: 30, outcome: 'completed' as const, error: null,
    };
    const report = { startedAt: last.startedAt, finishedAt: last.finishedAt, imported: 3, skipped: 0, filesScanned: 3, warnings: [] };
    const before = { syncStatus: { ...status, lastAttempt: { ...last, report } } } as unknown as Bootstrap;
    expect(applySyncState(before, { ...status, lastAttempt: last })?.syncStatus?.lastAttempt?.report).toEqual(report);
    expect(applySyncState(before, { ...status, lastAttempt: { ...last, id: 'new', outcome: 'cancelled' } })
      ?.syncStatus?.lastAttempt?.report).toBeUndefined();
  });
});
