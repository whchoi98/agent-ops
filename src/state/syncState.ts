import type { Bootstrap } from '../../shared/types';
import type { SyncStatus } from '../../shared/sync-control';

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const time = (value: unknown): boolean => typeof value === 'string' && value.length <= 64
  && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const nullableTime = (value: unknown): boolean => value === null || time(value);
const oneOf = (value: unknown, choices: string[]): boolean => typeof value === 'string' && choices.includes(value);

function attempt(value: unknown): value is Record<string, unknown> {
  return object(value) && typeof value.id === 'string' && value.id.length > 0 && value.id.length <= 200
    && (value.trigger === 'automatic' || value.trigger === 'manual') && time(value.startedAt)
    && integer(value.maxSeconds, 30, 1800);
}

export function readSyncState(event: unknown): SyncStatus | null {
  if (!object(event) || event.type !== 'sync-state' || !object(event.status)) return null;
  const value = event.status;
  if (!object(value.policy) || !oneOf(value.policy.mode, ['interval', 'idle', 'manual'])
    || !integer(value.policy.intervalSeconds, 15, 3600) || !integer(value.policy.maxSeconds, 30, 1800)
    || typeof value.demo !== 'boolean' || typeof value.autoEnabled !== 'boolean'
    || !oneOf(value.activity, ['idle', 'running', 'stopping'])
    || !oneOf(value.automaticState, ['scheduled', 'manual', 'waiting-for-idle', 'disabled'])
    || !nullableTime(value.nextCheckAt)) return null;
  if (value.activity === 'idle' ? value.currentAttempt !== null : !attempt(value.currentAttempt)) return null;
  if (value.lastAttempt !== null && (!attempt(value.lastAttempt)
    || !time(value.lastAttempt.finishedAt)
    || !oneOf(value.lastAttempt.outcome, ['completed', 'cancelled', 'timed-out', 'failed'])
    || !(value.lastAttempt.error === null || typeof value.lastAttempt.error === 'string'))) return null;
  return value as unknown as SyncStatus;
}

/** Progress updates never replace archive objects or imply that imported content changed. */
export function applySyncState(data: Bootstrap | null, status: SyncStatus): Bootstrap | null {
  if (!data) return null;
  let syncStatus = status;
  const previous = data.syncStatus?.lastAttempt;
  if (status.lastAttempt && previous?.id === status.lastAttempt.id
    && !status.lastAttempt.report && previous.report) {
    syncStatus = { ...status, lastAttempt: { ...status.lastAttempt, report: previous.report } };
  }
  return { ...data, syncing: status.activity !== 'idle', syncStatus };
}
