import { randomUUID } from 'node:crypto';
import type { SyncReport } from '../shared/types.js';
import type { SyncAttempt, SyncLastAttempt, SyncOutcome, SyncPolicy, SyncStatus } from '../shared/sync-control.js';

export interface SyncDriver {
  readonly active: boolean;
  run(options?: { maxRuntimeMs?: number }): Promise<SyncReport>;
  stopCurrent?(): boolean;
  cancel(): void;
  wait(): Promise<void>;
}

export interface SyncManagerOptions {
  driver: SyncDriver;
  policy: SyncPolicy;
  autoEnabled: boolean;
  demo?: boolean;
  isBusy: () => boolean;
  /** Throttled status without report payloads; snapshot() retains the actual last report. */
  onChange?: (status: SyncStatus) => void;
  /** Called once per terminal attempt, including interrupted and failed attempts. */
  onFinished?: (attempt: SyncLastAttempt) => void;
  now?: () => number;
}

const IDLE_RECHECK_MS = 15_000;
const PROGRESS_INTERVAL_MS = 2000;

function validatePolicy(policy: SyncPolicy): SyncPolicy {
  if (!policy || !['interval', 'idle', 'manual'].includes(policy.mode)
    || !Number.isSafeInteger(policy.intervalSeconds) || policy.intervalSeconds < 15 || policy.intervalSeconds > 3600
    || !Number.isSafeInteger(policy.maxSeconds) || policy.maxSeconds < 30 || policy.maxSeconds > 1800) {
    throw new RangeError('Invalid synchronization policy.');
  }
  return { mode: policy.mode, intervalSeconds: policy.intervalSeconds, maxSeconds: policy.maxSeconds };
}

function copyReport(report: SyncReport): SyncReport {
  return { ...report, warnings: [...report.warnings] };
}

function copyAttempt(attempt: SyncLastAttempt, includeReport = true): SyncLastAttempt {
  const { report, ...metadata } = attempt;
  return { ...metadata, ...(includeReport && report ? { report: copyReport(report) } : {}) };
}

function namedError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function failureDetails(cause: unknown): { outcome: SyncOutcome; error: Error } {
  let name: unknown;
  try { name = cause && typeof cause === 'object' && 'name' in cause ? cause.name : undefined; }
  catch { /* Diagnostics are never read or included in public status. */ }
  if (name === 'AbortError') {
    return { outcome: 'cancelled', error: namedError('AbortError', 'Synchronization cancelled.') };
  }
  if (name === 'SyncTimeoutError') {
    return { outcome: 'timed-out', error: namedError('SyncTimeoutError', 'Synchronization time limit exceeded.') };
  }
  return { outcome: 'failed', error: new Error('Synchronization failed.') };
}

function notify(callback: () => void): void {
  try { void Promise.resolve(callback()).catch(() => {}); }
  catch { /* Notifications cannot change an attempt's result or interrupt cleanup. */ }
}

/** Owns one driver's attempts and keeps scheduling and the last result in memory. */
export class SyncManager {
  private readonly options: SyncManagerOptions;
  private policy: SyncPolicy;
  private readonly now: () => number;
  private started = false;
  private closed = false;
  private stopping = false;
  private automaticTimer: ReturnType<typeof setTimeout> | undefined;
  private progressTimer: ReturnType<typeof setTimeout> | undefined;
  private changePending = false;
  private lastChangeAt: number | null = null;
  private nextCheckAt: string | null = null;
  private waitingForIdle = false;
  private pending: Promise<SyncReport> | null = null;
  private currentAttempt: SyncAttempt | null = null;
  private lastAttempt: SyncLastAttempt | null = null;

  constructor(options: SyncManagerOptions) {
    this.options = { ...options };
    this.policy = validatePolicy(options.policy);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    this.checkAutomatic();
  }

  configure(policy: SyncPolicy): void {
    if (this.closed) return;
    this.policy = validatePolicy(policy);
    this.waitingForIdle = this.waitingForIdle && this.policy.mode === 'idle';
    this.schedule(this.waitingForIdle ? IDLE_RECHECK_MS : this.policy.intervalSeconds * 1000);
    this.changed();
  }

  snapshot(): SyncStatus {
    return this.status(true);
  }

  private status(includeReport: boolean): SyncStatus {
    const disabled = !this.started || this.closed || this.options.demo || !this.options.autoEnabled;
    return {
      policy: { ...this.policy },
      demo: this.options.demo ?? false,
      autoEnabled: this.options.autoEnabled,
      activity: this.pending ? this.stopping ? 'stopping' : 'running' : 'idle',
      automaticState: disabled ? 'disabled' : this.policy.mode === 'manual' ? 'manual'
        : this.waitingForIdle ? 'waiting-for-idle' : 'scheduled',
      nextCheckAt: this.nextCheckAt,
      currentAttempt: this.currentAttempt ? { ...this.currentAttempt } : null,
      lastAttempt: this.lastAttempt ? copyAttempt(this.lastAttempt, includeReport) : null,
    };
  }

  runManual(): Promise<SyncReport> {
    return this.run('manual');
  }

  stopCurrent(): boolean {
    if (this.closed || this.stopping || !this.pending || !this.options.driver.active) return false;
    if (!this.options.driver.stopCurrent?.()) return false;
    this.stopping = true;
    this.changed();
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopping = this.pending !== null;
    this.clearAutomatic();
    clearTimeout(this.progressTimer);
    this.progressTimer = undefined;
    this.changePending = false;
    this.options.driver.cancel();
  }

  async wait(): Promise<void> {
    await this.pending?.then(() => {}, () => {});
    try { await this.options.driver.wait(); }
    catch { /* A driver may also reject wait() for an import failure already recorded above. */ }
  }

  private automaticAllowed(): boolean {
    return this.started && !this.closed && !this.options.demo && this.options.autoEnabled && this.policy.mode !== 'manual';
  }

  private clearAutomatic(): void {
    clearTimeout(this.automaticTimer);
    this.automaticTimer = undefined;
    this.nextCheckAt = null;
  }

  private schedule(delayMs: number): void {
    this.clearAutomatic();
    if (!this.automaticAllowed() || this.pending) return;
    this.nextCheckAt = new Date(this.now() + delayMs).toISOString();
    this.automaticTimer = setTimeout(() => {
      this.automaticTimer = undefined;
      this.nextCheckAt = null;
      this.checkAutomatic();
    }, delayMs);
    this.automaticTimer.unref?.();
  }

  private checkAutomatic(): void {
    if (!this.automaticAllowed() || this.pending) { this.changed(); return; }
    let busy = false;
    if (this.policy.mode === 'idle') {
      try { busy = this.options.isBusy(); }
      catch { busy = true; }
    }
    if (busy) {
      this.waitingForIdle = true;
      this.schedule(IDLE_RECHECK_MS);
      this.changed();
      return;
    }
    void this.run('automatic').catch(() => {});
  }

  private changed(): void {
    if (this.closed || !this.options.onChange) return;
    this.changePending = true;
    if (this.progressTimer) return;
    const elapsed = this.lastChangeAt === null ? PROGRESS_INTERVAL_MS : Math.max(0, performance.now() - this.lastChangeAt);
    if (elapsed >= PROGRESS_INTERVAL_MS) this.emitChange();
    else this.armProgress(Math.ceil(PROGRESS_INTERVAL_MS - elapsed));
  }

  private armProgress(delayMs: number): void {
    if (this.closed || this.progressTimer || !this.options.onChange) return;
    this.progressTimer = setTimeout(() => {
      this.progressTimer = undefined;
      if (this.pending || this.changePending) this.emitChange();
    }, delayMs);
    this.progressTimer.unref?.();
  }

  private emitChange(): void {
    if (this.closed || !this.options.onChange) return;
    this.changePending = false;
    this.lastChangeAt = performance.now();
    notify(() => this.options.onChange?.(this.status(false)));
    if (this.pending || this.changePending) this.armProgress(PROGRESS_INTERVAL_MS);
  }

  private run(trigger: SyncAttempt['trigger']): Promise<SyncReport> {
    if (this.closed) return Promise.reject(namedError('AbortError', 'Synchronization is stopping.'));
    if (this.options.demo) return Promise.reject(new Error('Synchronization is unavailable in demo mode.'));
    if (this.pending) return this.pending;
    this.clearAutomatic();
    this.waitingForIdle = false;
    const attempt: SyncAttempt = {
      id: randomUUID(), trigger, startedAt: new Date(this.now()).toISOString(), maxSeconds: this.policy.maxSeconds,
    };
    this.currentAttempt = attempt;
    this.stopping = false;
    let resolveRun!: (report: SyncReport) => void;
    let rejectRun!: (error: unknown) => void;
    const pending = new Promise<SyncReport>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    this.pending = pending;
    void pending.catch(() => {});
    const finish = (result: { report: SyncReport } | { error: unknown }) => {
      const failure = 'error' in result ? failureDetails(result.error) : null;
      this.pending = null;
      this.currentAttempt = null;
      this.stopping = false;
      const last: SyncLastAttempt = {
        ...attempt, finishedAt: new Date(this.now()).toISOString(),
        ...('report' in result
          ? { outcome: 'completed' as const, error: null, report: copyReport(result.report) }
          : { outcome: failure!.outcome, error: failure!.error.message }),
      };
      this.lastAttempt = last;
      this.schedule(this.policy.intervalSeconds * 1000);
      if ('report' in result) resolveRun(copyReport(result.report));
      else rejectRun(failure!.error);
      this.changed();
      notify(() => this.options.onFinished?.(copyAttempt(last)));
    };
    try {
      void this.options.driver.run({ maxRuntimeMs: attempt.maxSeconds * 1000 }).then(
        report => finish({ report }),
        error => finish({ error }),
      );
      this.changed();
    } catch (error) {
      finish({ error });
    }
    return pending;
  }
}
