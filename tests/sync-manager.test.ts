import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SyncReport } from '../shared/types.js';
import { DEFAULT_SYNC_POLICY, type SyncLastAttempt, type SyncPolicy, type SyncStatus } from '../shared/sync-control.js';
import { SyncManager, type SyncDriver, type SyncManagerOptions } from '../server/sync-manager.js';

const policy: SyncPolicy = { mode: 'interval', intervalSeconds: 60, maxSeconds: 1800 };
const report: SyncReport = {
  startedAt: '2026-09-25T00:00:00.000Z',
  finishedAt: '2026-09-25T00:00:01.000Z',
  imported: 2, filesScanned: 3, skipped: 1, warnings: ['Synthetic warning.'],
};

class ControlledDriver implements SyncDriver {
  readonly calls: { maxRuntimeMs?: number }[] = [];
  cancellations = 0;
  stops = 0;
  waits = 0;
  closed = false;
  private job: {
    promise: Promise<SyncReport>;
    resolve: (report: SyncReport) => void;
    reject: (error: unknown) => void;
    stopping: boolean;
  } | null = null;

  get active(): boolean { return this.job !== null; }

  run(options: { maxRuntimeMs?: number } = {}): Promise<SyncReport> {
    if (this.closed) throw new Error('Synthetic driver is closed.');
    if (this.job) return this.job.promise;
    let resolve!: (report: SyncReport) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<SyncReport>((yes, no) => { resolve = yes; reject = no; });
    void promise.catch(() => {});
    this.job = { promise, resolve, reject, stopping: false };
    this.calls.push({ ...options });
    return promise;
  }

  complete(value: SyncReport = report): void {
    if (!this.job) throw new Error('No synthetic attempt to finish.');
    const job = this.job;
    this.job = null;
    job.resolve(value);
  }

  fail(error: unknown): void {
    if (!this.job) throw new Error('No synthetic attempt to fail.');
    const job = this.job;
    this.job = null;
    job.reject(error);
  }

  stopCurrent(): boolean {
    if (!this.job || this.job.stopping) return false;
    this.stops++;
    this.job.stopping = true;
    return true;
  }

  cancel(): void {
    this.cancellations++;
    this.closed = true;
    if (this.job) this.fail(Object.assign(new Error('Synthetic shutdown.'), { name: 'AbortError' }));
  }

  async wait(): Promise<void> {
    this.waits++;
    await this.job?.promise.then(() => {}, () => {});
  }
}

const managers: SyncManager[] = [];

function setup(options: Partial<Omit<SyncManagerOptions, 'driver'>> = {}, driver = new ControlledDriver()) {
  const manager = new SyncManager({ driver, policy, autoEnabled: true, isBusy: () => false, ...options });
  managers.push(manager);
  return { manager, driver };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime('2026-09-25T00:00:00.000Z');
});

afterEach(async () => {
  const owned = managers.splice(0);
  owned.forEach(manager => manager.close());
  await Promise.all(owned.map(manager => manager.wait()));
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('SyncManager automatic scheduling', () => {
  it('starts once and schedules one interval from completion without overlapping an import', async () => {
    const { manager, driver } = setup();
    expect(driver.calls).toEqual([]);
    manager.start();
    manager.start();
    expect(driver.calls).toEqual([{ maxRuntimeMs: 1_800_000 }]);
    expect(manager.snapshot()).toMatchObject({
      policy, demo: false, autoEnabled: true, activity: 'running',
      automaticState: 'scheduled', nextCheckAt: null, lastAttempt: null,
      currentAttempt: {
        id: expect.any(String), trigger: 'automatic',
        startedAt: '2026-09-25T00:00:00.000Z', maxSeconds: 1800,
      },
    });
    const firstId = manager.snapshot().currentAttempt!.id;
    await vi.advanceTimersByTimeAsync(90_000);
    expect(driver.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);

    driver.complete();
    await manager.wait();
    expect(manager.snapshot()).toMatchObject({
      activity: 'idle', currentAttempt: null, nextCheckAt: '2026-09-25T00:02:30.000Z',
      lastAttempt: {
        id: firstId, trigger: 'automatic', startedAt: '2026-09-25T00:00:00.000Z',
        finishedAt: '2026-09-25T00:01:30.000Z', outcome: 'completed', error: null, report,
      },
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(driver.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(driver.calls).toHaveLength(2);
    expect(manager.snapshot().currentAttempt!.id).not.toBe(firstId);
    expect(manager.snapshot().nextCheckAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defers idle-mode checks for 15 seconds while this workbench is busy', async () => {
    let busy = true;
    const { manager, driver } = setup({
      policy: { mode: 'idle', intervalSeconds: 120, maxSeconds: 45 },
      isBusy: () => busy,
    });
    manager.start();
    expect(driver.calls).toEqual([]);
    expect(manager.snapshot()).toMatchObject({
      activity: 'idle', automaticState: 'waiting-for-idle', nextCheckAt: '2026-09-25T00:00:15.000Z',
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(driver.calls).toEqual([]);
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:00:30.000Z');
    expect(vi.getTimerCount()).toBe(1);

    busy = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(driver.calls).toEqual([{ maxRuntimeMs: 45_000 }]);
    expect(manager.snapshot()).toMatchObject({ activity: 'running', automaticState: 'scheduled', nextCheckAt: null });
    driver.complete();
    await manager.wait();
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:02:30.000Z');
  });

  it('coalesces manual requests and bypasses idle gating while retaining the budget', async () => {
    const { manager, driver } = setup({
      policy: { mode: 'idle', intervalSeconds: 60, maxSeconds: 30 }, isBusy: () => true,
    });
    manager.start();
    const first = manager.runManual();
    const second = manager.runManual();
    expect(second).toBe(first);
    expect(driver.calls).toEqual([{ maxRuntimeMs: 30_000 }]);
    expect(manager.snapshot()).toMatchObject({
      activity: 'running', nextCheckAt: null, automaticState: 'scheduled',
      currentAttempt: { trigger: 'manual', maxSeconds: 30 },
    });
    await vi.advanceTimersByTimeAsync(10_000);
    driver.complete();
    await expect(first).resolves.toEqual(report);
    await manager.wait();
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:01:10.000Z');
    expect(driver.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it.each([
    { autoEnabled: true, mode: 'manual' as const, state: 'manual' },
    { autoEnabled: false, mode: 'interval' as const, state: 'disabled' },
  ])('preserves manual synchronization with automatic state $state', async ({ autoEnabled, mode, state }) => {
    const isBusy = vi.fn(() => true);
    const { manager, driver } = setup({ autoEnabled, policy: { ...policy, mode }, isBusy });
    manager.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(driver.calls).toEqual([]);
    expect(isBusy).not.toHaveBeenCalled();
    expect(manager.snapshot()).toMatchObject({ automaticState: state, nextCheckAt: null });
    expect(vi.getTimerCount()).toBe(0);

    const manual = manager.runManual();
    expect(manager.snapshot().currentAttempt!.trigger).toBe('manual');
    expect(driver.calls).toEqual([{ maxRuntimeMs: 1_800_000 }]);
    driver.complete();
    await expect(manual).resolves.toEqual(report);
    expect(manager.snapshot()).toMatchObject({ automaticState: state, nextCheckAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins an automatic attempt without changing its trigger or adding a trailing manual import', async () => {
    const { manager, driver } = setup();
    manager.start();
    const automatic = manager.snapshot().currentAttempt;
    const manual = manager.runManual();
    expect(manager.runManual()).toBe(manual);
    expect(manager.snapshot().currentAttempt).toEqual(automatic);
    expect(driver.calls).toHaveLength(1);
    driver.complete();
    await expect(manual).resolves.toEqual(report);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(driver.calls).toHaveLength(1);
  });

  it('treats a failing idle callback as busy and retries without starting an attempt', async () => {
    let broken = true;
    const { manager, driver } = setup({
      policy: { ...policy, mode: 'idle' },
      isBusy: () => { if (broken) throw new Error('private busy diagnostic'); return false; },
    });
    expect(() => manager.start()).not.toThrow();
    expect(driver.calls).toEqual([]);
    expect(manager.snapshot()).toMatchObject({
      automaticState: 'waiting-for-idle', nextCheckAt: '2026-09-25T00:00:15.000Z', lastAttempt: null,
    });
    broken = false;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(driver.calls).toHaveLength(1);
    expect(manager.snapshot().currentAttempt!.trigger).toBe('automatic');
  });
});

describe('SyncManager attempt lifecycle', () => {
  it('keeps a stopped attempt coalesced until cleanup, then permits another manual import', async () => {
    const finished: SyncLastAttempt[] = [];
    const { manager, driver } = setup({ onFinished: attempt => { finished.push(attempt); } });
    manager.start();
    const first = manager.runManual();
    const outcome = first.catch(error => error);
    expect(manager.stopCurrent()).toBe(true);
    expect(manager.stopCurrent()).toBe(false);
    expect(driver.stops).toBe(1);
    expect(driver.cancellations).toBe(0);
    expect(manager.snapshot()).toMatchObject({ activity: 'stopping', nextCheckAt: null });
    expect(manager.runManual()).toBe(first);
    await vi.advanceTimersByTimeAsync(2000);
    expect(driver.calls).toHaveLength(1);
    expect(finished).toEqual([]);

    driver.fail(Object.assign(new Error('private stop diagnostic'), { name: 'AbortError' }));
    await manager.wait();
    expect(await outcome).toMatchObject({ name: 'AbortError', message: 'Synchronization cancelled.' });
    expect(manager.snapshot()).toMatchObject({
      activity: 'idle', currentAttempt: null, nextCheckAt: '2026-09-25T00:01:02.000Z',
      lastAttempt: { outcome: 'cancelled', error: 'Synchronization cancelled.' },
    });
    expect(manager.snapshot().lastAttempt).not.toHaveProperty('report');
    expect(finished).toHaveLength(1);
    expect(manager.stopCurrent()).toBe(false);

    const next = manager.runManual();
    expect(driver.calls).toHaveLength(2);
    expect(manager.snapshot().currentAttempt!.trigger).toBe('manual');
    driver.complete();
    await expect(next).resolves.toEqual(report);
    expect(finished).toHaveLength(2);
    expect(finished.map(attempt => attempt.outcome)).toEqual(['cancelled', 'completed']);
  });

  it('does not substitute permanent cancellation when a driver cannot stop its current attempt', async () => {
    const driver = new ControlledDriver();
    (driver as SyncDriver).stopCurrent = undefined;
    const { manager } = setup({}, driver);
    const first = manager.runManual();
    expect(manager.stopCurrent()).toBe(false);
    expect(manager.snapshot().activity).toBe('running');
    expect(driver.cancellations).toBe(0);
    driver.complete();
    await expect(first).resolves.toEqual(report);
    expect(manager.snapshot().nextCheckAt).toBeNull();
  });

  it.each([
    { name: 'AbortError', outcome: 'cancelled', error: 'Synchronization cancelled.' },
    { name: 'SyncTimeoutError', outcome: 'timed-out', error: 'Synchronization time limit exceeded.' },
    { name: 'Error', outcome: 'failed', error: 'Synchronization failed.' },
  ])('classifies $name without exposing private diagnostics or fabricating a report', async ({ name, outcome, error }) => {
    const finished: SyncLastAttempt[] = [];
    const { manager, driver } = setup({ onFinished: attempt => { finished.push(attempt); } });
    manager.start();
    const pending = manager.runManual().catch(value => value);
    const current = manager.snapshot().currentAttempt;
    await vi.advanceTimersByTimeAsync(3210);
    driver.fail(Object.assign(new Error('private stderr and source paths'), { name, report }));
    await manager.wait();

    expect(await pending).toMatchObject({ name, message: error });
    expect(manager.snapshot()).toMatchObject({
      activity: 'idle', currentAttempt: null, nextCheckAt: '2026-09-25T00:01:03.210Z',
      lastAttempt: { ...current, finishedAt: '2026-09-25T00:00:03.210Z', outcome, error },
    });
    expect(manager.snapshot().lastAttempt).not.toHaveProperty('report');
    expect(JSON.stringify(manager.snapshot())).not.toContain('private');
    expect(finished).toEqual([manager.snapshot().lastAttempt]);
    manager.close();
    await manager.wait();
    expect(finished).toHaveLength(1);
  });

  it('replaces the previous report after a failed attempt instead of reusing its counts', async () => {
    const { manager, driver } = setup({ autoEnabled: false });
    const first = manager.runManual();
    driver.complete();
    await first;
    const last = manager.snapshot().lastAttempt;

    const second = manager.runManual().catch(error => error);
    expect(manager.snapshot().lastAttempt).toEqual(last);
    driver.fail('private non-Error rejection');
    await second;
    expect(manager.snapshot().lastAttempt).toMatchObject({ outcome: 'failed', error: 'Synchronization failed.' });
    expect(manager.snapshot().lastAttempt).not.toHaveProperty('report');
    expect(manager.snapshot().lastAttempt!.id).not.toBe(last!.id);
  });

  it('settles synchronous driver errors and notifies once before a later successful attempt', async () => {
    const finished: SyncLastAttempt[] = [];
    const { manager, driver } = setup({ onFinished: attempt => { finished.push(attempt); } });
    vi.spyOn(driver, 'run').mockImplementationOnce(() => { throw new Error('private launch failure'); });
    const failed = manager.runManual();
    await expect(failed).rejects.toThrow('Synchronization failed.');
    expect(manager.snapshot()).toMatchObject({ activity: 'idle', lastAttempt: { outcome: 'failed' } });
    expect(finished).toHaveLength(1);

    const next = manager.runManual();
    driver.complete();
    await expect(next).resolves.toEqual(report);
    expect(finished.map(attempt => attempt.outcome)).toEqual(['failed', 'completed']);
  });

  it.each(['sync', 'async'])('isolates %s terminal callback errors from results and future scheduling', async kind => {
    const callback = vi.fn(kind === 'sync'
      ? () => { throw new Error('private callback failure'); }
      : async () => { throw new Error('private callback failure'); });
    const { manager, driver } = setup({ onFinished: callback });
    manager.start();
    const first = manager.runManual();
    driver.complete();
    await expect(first).resolves.toEqual(report);
    await manager.wait();
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(driver.calls).toHaveLength(2);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('allows a terminal callback to start the next attempt without losing its state', async () => {
    let next: Promise<SyncReport> | undefined;
    let finished = 0;
    const { manager, driver } = setup({
      onFinished: () => { if (++finished === 1) next = manager.runManual(); },
    });
    manager.start();
    const first = manager.runManual();
    const firstId = manager.snapshot().currentAttempt!.id;
    driver.complete();
    await first;
    expect(next).toBeDefined();
    expect(driver.calls).toHaveLength(2);
    expect(manager.snapshot()).toMatchObject({
      activity: 'running', nextCheckAt: null, currentAttempt: { trigger: 'manual' },
      lastAttempt: { id: firstId, outcome: 'completed' },
    });
    driver.complete();
    await next;
    expect(finished).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('closes permanently, waits for cancellation, and notifies termination exactly once', async () => {
    const finished: SyncLastAttempt[] = [];
    const { manager, driver } = setup({ onFinished: attempt => { finished.push(attempt); } });
    manager.start();
    const first = manager.runManual().catch(error => error);
    manager.close();
    manager.close();
    expect(manager.snapshot()).toMatchObject({ activity: 'stopping', automaticState: 'disabled', nextCheckAt: null });
    expect(driver.cancellations).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    manager.start();
    await expect(manager.runManual()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(manager.wait()).resolves.toBeUndefined();
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(driver.active).toBe(false);
    expect(driver.waits).toBeGreaterThan(0);
    expect(manager.stopCurrent()).toBe(false);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(driver.calls).toHaveLength(1);
    expect(finished).toHaveLength(1);
    expect(manager.snapshot()).toMatchObject({ activity: 'idle', lastAttempt: { outcome: 'cancelled' } });
  });

  it('closes before start without allowing any native attempt', async () => {
    const finished = vi.fn();
    const { manager, driver } = setup({ onFinished: finished });
    manager.close();
    manager.start();
    await expect(manager.runManual()).rejects.toMatchObject({ name: 'AbortError' });
    await manager.wait();
    expect(driver.calls).toEqual([]);
    expect(finished).not.toHaveBeenCalled();
    expect(manager.snapshot()).toMatchObject({
      activity: 'idle', automaticState: 'disabled', currentAttempt: null, lastAttempt: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('drains a driver whose wait also rejects the failed import without exposing that rejection', async () => {
    const { manager, driver } = setup({ autoEnabled: false });
    const pending = manager.runManual().catch(error => error);
    const driverPending = driver.run();
    const wait = vi.spyOn(driver, 'wait').mockImplementation(async () => { await driverPending; });
    driver.fail(new Error('private import failure'));
    await expect(manager.wait()).resolves.toBeUndefined();
    expect(wait).toHaveBeenCalledTimes(1);
    expect(await pending).toMatchObject({ message: 'Synchronization failed.' });
    expect(manager.snapshot().lastAttempt).toMatchObject({ outcome: 'failed', error: 'Synchronization failed.' });
  });

  it('never delegates demo synchronization to a potentially native driver', async () => {
    const isBusy = vi.fn(() => false);
    const finished = vi.fn();
    const { manager, driver } = setup({ demo: true, isBusy, onFinished: finished });
    manager.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    const manual = manager.runManual();
    if (driver.active) driver.complete();
    await expect(manual).rejects.toThrow(/demo/i);
    expect(driver.calls).toEqual([]);
    expect(isBusy).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    expect(manager.snapshot()).toMatchObject({
      demo: true, activity: 'idle', automaticState: 'disabled', nextCheckAt: null,
      currentAttempt: null, lastAttempt: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('SyncManager policy and cached status', () => {
  it('provides interval defaults with the existing 60-second interval and 30-minute budget', async () => {
    const { manager, driver } = setup({ policy: DEFAULT_SYNC_POLICY });
    manager.start();
    expect(driver.calls).toEqual([{ maxRuntimeMs: 1_800_000 }]);
    expect(manager.snapshot().policy).toEqual({ mode: 'interval', intervalSeconds: 60, maxSeconds: 1800 });
    driver.complete();
    await manager.wait();
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:01:00.000Z');
  });

  it.each([
    { mode: 'interval', intervalSeconds: 15, maxSeconds: 30 },
    { mode: 'idle', intervalSeconds: 3600, maxSeconds: 1800 },
  ] satisfies SyncPolicy[])('accepts policy boundaries $intervalSeconds/$maxSeconds', async nextPolicy => {
    const { manager, driver } = setup({ policy: nextPolicy });
    manager.start();
    expect(driver.calls).toEqual([{ maxRuntimeMs: nextPolicy.maxSeconds * 1000 }]);
    driver.complete();
    await manager.wait();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(nextPolicy.intervalSeconds * 1000 - 1);
    expect(driver.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(driver.calls).toHaveLength(2);
  });

  const invalidPolicies = [
    { ...policy, mode: 'unknown' },
    ...[14, 3601, 15.5, NaN, Infinity].map(intervalSeconds => ({ ...policy, intervalSeconds })),
    ...[29, 1801, 30.5, NaN, Infinity].map(maxSeconds => ({ ...policy, maxSeconds })),
  ] as SyncPolicy[];

  it.each(invalidPolicies)('rejects invalid policy without creating timers or work (%j)', invalid => {
    const driver = new ControlledDriver();
    expect(() => setup({ policy: invalid }, driver)).toThrow(RangeError);
    expect(driver.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an invalid reconfiguration atomically without losing the existing timer', async () => {
    const { manager, driver } = setup();
    manager.start();
    driver.complete();
    await manager.wait();
    const before = manager.snapshot();
    for (const invalid of invalidPolicies) {
      expect(() => manager.configure(invalid)).toThrow(RangeError);
      expect(manager.snapshot()).toEqual(before);
      expect(vi.getTimerCount()).toBe(1);
    }
    await vi.advanceTimersByTimeAsync(60_000);
    expect(driver.calls).toHaveLength(2);
  });

  it('applies a new policy after the current attempt without altering its captured budget', async () => {
    const { manager, driver } = setup();
    manager.start();
    const current = manager.snapshot().currentAttempt;
    const nextPolicy: SyncPolicy = { mode: 'interval', intervalSeconds: 15, maxSeconds: 45 };
    manager.configure(nextPolicy);
    nextPolicy.intervalSeconds = 3600;
    nextPolicy.maxSeconds = 1800;
    expect(manager.snapshot().currentAttempt).toEqual(current);
    expect(manager.snapshot().policy).toEqual({ mode: 'interval', intervalSeconds: 15, maxSeconds: 45 });
    expect(driver.calls).toEqual([{ maxRuntimeMs: 1_800_000 }]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    driver.complete();
    await manager.wait();
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:00:35.000Z');
    await vi.advanceTimersByTimeAsync(15_000);
    expect(driver.calls).toEqual([{ maxRuntimeMs: 1_800_000 }, { maxRuntimeMs: 45_000 }]);
  });

  it('replaces the automatic timer on configuration changes and honors a switch to manual mode', async () => {
    const { manager, driver } = setup();
    manager.start();
    driver.complete();
    await manager.wait();
    await vi.advanceTimersByTimeAsync(10_000);
    manager.configure({ ...policy, intervalSeconds: 15 });
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:00:25.000Z');
    manager.configure({ ...policy, intervalSeconds: 120 });
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:02:10.000Z');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(driver.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(driver.calls).toHaveLength(2);

    manager.configure({ ...policy, mode: 'manual' });
    driver.complete();
    await manager.wait();
    expect(manager.snapshot()).toMatchObject({ automaticState: 'manual', nextCheckAt: null });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(driver.calls).toHaveLength(2);
    manager.configure({ ...policy, intervalSeconds: 15 });
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T01:02:25.000Z');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(driver.calls).toHaveLength(3);
  });

  it('retains the short idle recheck when a deferred policy is changed', async () => {
    const { manager, driver } = setup({ policy: { ...policy, mode: 'idle' }, isBusy: () => true });
    manager.start();
    await vi.advanceTimersByTimeAsync(5000);
    manager.configure({ mode: 'idle', intervalSeconds: 3600, maxSeconds: 30 });
    expect(manager.snapshot()).toMatchObject({
      automaticState: 'waiting-for-idle', nextCheckAt: '2026-09-25T00:00:20.000Z',
    });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(driver.calls).toEqual([]);
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:00:35.000Z');
  });

  it('cannot restart a closed manager through reconfiguration', async () => {
    const { manager, driver } = setup();
    manager.start();
    manager.close();
    await manager.wait();
    manager.configure({ mode: 'interval', intervalSeconds: 15, maxSeconds: 30 });
    manager.start();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(driver.calls).toHaveLength(1);
    expect(manager.snapshot()).toMatchObject({ activity: 'idle', automaticState: 'disabled', nextCheckAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps policy, attempts and returned reports isolated from caller mutation', async () => {
    const inputPolicy = { ...policy };
    const returned = { ...report, warnings: [...report.warnings] };
    const { manager, driver } = setup({
      policy: inputPolicy,
      onFinished: attempt => {
        attempt.maxSeconds = 1;
        attempt.report!.warnings.push('mutated by callback');
        attempt.report!.imported = 999;
      },
    });
    inputPolicy.maxSeconds = 30;
    manager.start();
    const current = manager.snapshot();
    current.policy.intervalSeconds = 1;
    current.currentAttempt!.maxSeconds = 1;
    expect(manager.snapshot().currentAttempt!.maxSeconds).toBe(1800);
    const pending = manager.runManual();
    driver.complete(returned);
    const received = await pending;
    returned.warnings.push('mutated by driver');
    received.imported = 999;
    received.warnings.push('mutated by caller');
    const last = manager.snapshot();
    last.lastAttempt!.report!.warnings.push('mutated snapshot');
    last.lastAttempt!.report!.imported = 999;
    expect(manager.snapshot().policy).toEqual(policy);
    expect(manager.snapshot().lastAttempt).toMatchObject({ maxSeconds: 1800, report });
    expect(manager.snapshot().nextCheckAt).toBe('2026-09-25T00:01:00.000Z');
  });

  it('reads cached status without querying busy state, invoking the driver, or changing timers', () => {
    const isBusy = vi.fn(() => true);
    const { manager, driver } = setup({ policy: { ...policy, mode: 'idle' }, isBusy });
    manager.start();
    for (let i = 0; i < 100; i++) expect(manager.snapshot().automaticState).toBe('waiting-for-idle');
    expect(isBusy).toHaveBeenCalledTimes(1);
    expect(driver.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('uses the injected clock for attempt and next-check timestamps', async () => {
    let time = Date.parse('2027-01-02T03:04:00.000Z');
    const { manager, driver } = setup({ now: () => time });
    manager.start();
    expect(manager.snapshot().currentAttempt!.startedAt).toBe('2027-01-02T03:04:00.000Z');
    await vi.advanceTimersByTimeAsync(1000);
    time += 54_321;
    driver.complete();
    await manager.wait();
    expect(manager.snapshot()).toMatchObject({
      lastAttempt: { finishedAt: '2027-01-02T03:04:54.321Z' },
      nextCheckAt: '2027-01-02T03:05:54.321Z',
    });
  });
});

describe('SyncManager lightweight notifications', () => {
  it('emits progress at most every two seconds through stopping, with one immediate terminal notification', async () => {
    const events: { time: number; status: SyncStatus }[] = [];
    const finished: SyncLastAttempt[] = [];
    const began = Date.now();
    const { manager, driver } = setup({
      onChange: status => { events.push({ time: Date.now() - began, status }); },
      onFinished: attempt => { finished.push(attempt); },
    });
    const pending = manager.runManual().catch(error => error);
    expect(events.map(event => event.time)).toEqual([0]);
    expect(events[0].status.activity).toBe('running');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(5999);
    expect(events.map(event => event.time)).toEqual([0, 2000, 4000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.map(event => event.time)).toEqual([0, 2000, 4000, 6000]);
    expect(finished).toEqual([]);

    expect(manager.stopCurrent()).toBe(true);
    expect(events).toHaveLength(4);
    expect(manager.snapshot().activity).toBe('stopping');
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.at(-1)!.status.activity).toBe('stopping');
    driver.fail(Object.assign(new Error('private shutdown'), { name: 'AbortError' }));
    await pending;
    expect(finished).toHaveLength(1);
    expect(finished[0].finishedAt).toBe('2026-09-25T00:00:08.000Z');
    expect(events).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1999);
    expect(events).toHaveLength(5);
    await vi.advanceTimersByTimeAsync(1);
    expect(events.at(-1)).toMatchObject({
      time: 10_000, status: { activity: 'idle', currentAttempt: null, lastAttempt: { outcome: 'cancelled' } },
    });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(events).toHaveLength(6);
    expect(finished).toHaveLength(1);
  });

  it('coalesces rapid configuration changes into one latest status update', async () => {
    const events: SyncStatus[] = [];
    const { manager, driver } = setup({ onChange: status => { events.push(status); } });
    manager.runManual();
    await vi.advanceTimersByTimeAsync(250);
    for (let i = 0; i < 100; i++) {
      manager.configure({ mode: 'manual', intervalSeconds: 15 + i, maxSeconds: 30 + i });
    }
    expect(events).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(1);
    expect(driver.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1750);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      policy: { mode: 'manual', intervalSeconds: 114, maxSeconds: 129 },
      currentAttempt: { maxSeconds: 1800 }, activity: 'running',
    });
  });

  it('keeps the notification rate bounded when the wall clock jumps forward', async () => {
    const events: SyncStatus[] = [];
    const { manager } = setup({ policy: { ...policy, mode: 'manual' }, onChange: status => { events.push(status); } });
    manager.start();
    expect(events).toHaveLength(1);
    vi.setSystemTime('2026-09-25T01:00:00.000Z');
    manager.configure({ mode: 'manual', intervalSeconds: 15, maxSeconds: 30 });
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(2);
    expect(events[1].policy.maxSeconds).toBe(30);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('omits reports from state events while preserving actual reports in snapshots and terminal callbacks', async () => {
    const events: SyncStatus[] = [];
    const finished: SyncLastAttempt[] = [];
    const largeReport = { ...report, warnings: ['Synthetic recorded report. '.repeat(1000)] };
    const { manager, driver } = setup({
      onChange: status => { events.push(status); },
      onFinished: attempt => { finished.push(attempt); },
    });
    const first = manager.runManual();
    driver.complete(largeReport);
    await first;
    expect(finished[0].report).toEqual(largeReport);
    expect(manager.snapshot().lastAttempt!.report).toEqual(largeReport);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ activity: 'idle', lastAttempt: { outcome: 'completed', error: null } });
    expect(events[1].lastAttempt).not.toHaveProperty('report');

    manager.runManual();
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.at(-1)!.activity).toBe('running');
    for (const event of events) {
      expect(event.lastAttempt ?? {}).not.toHaveProperty('report');
      expect(JSON.stringify(event).length).toBeLessThan(1500);
    }
    expect(finished).toHaveLength(1);
  });

  it('isolates state callback mutations from policy, attempt metadata and the last result', async () => {
    const { manager, driver } = setup({
      onChange: status => {
        status.policy.maxSeconds = 1;
        if (status.currentAttempt) status.currentAttempt.maxSeconds = 1;
        if (status.lastAttempt) status.lastAttempt.error = 'mutated by callback';
      },
    });
    manager.start();
    expect(manager.snapshot().currentAttempt!.maxSeconds).toBe(1800);
    driver.complete();
    await manager.wait();
    await vi.advanceTimersByTimeAsync(2000);
    expect(manager.snapshot()).toMatchObject({ policy, lastAttempt: { outcome: 'completed', error: null } });
    await vi.advanceTimersByTimeAsync(58_000);
    expect(driver.calls).toEqual([{ maxRuntimeMs: 1_800_000 }, { maxRuntimeMs: 1_800_000 }]);
  });

  it.each(['sync', 'async'])('guards %s state callback failures without disrupting progress or scheduling', async kind => {
    const callback = vi.fn(kind === 'sync'
      ? () => { throw new Error('private progress failure'); }
      : async () => { throw new Error('private progress failure'); });
    const { manager, driver } = setup({ onChange: callback });
    expect(() => manager.start()).not.toThrow();
    expect(callback).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(callback).toHaveBeenCalledTimes(2);
    driver.complete();
    await manager.wait();
    await vi.advanceTimersByTimeAsync(2000);
    expect(callback).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(58_000);
    expect(driver.calls).toHaveLength(2);
    expect(callback).toHaveBeenCalledTimes(4);
  });

  it('supports closing from a state callback without leaving work or progress timers behind', async () => {
    const finished = vi.fn();
    const changes = vi.fn((status: SyncStatus) => { if (status.activity === 'running') manager.close(); });
    const { manager, driver } = setup({ onChange: changes, onFinished: finished });
    expect(() => manager.start()).not.toThrow();
    expect(driver.cancellations).toBe(1);
    await manager.wait();
    expect(manager.snapshot()).toMatchObject({ activity: 'idle', automaticState: 'disabled' });
    expect(finished).toHaveBeenCalledTimes(1);
    expect(finished.mock.calls[0][0].outcome).toBe('cancelled');
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(driver.calls).toHaveLength(1);
  });

  it('clears both the automatic check and a trailing state notification on close', async () => {
    const changes = vi.fn();
    const finished = vi.fn();
    const { manager, driver } = setup({ onChange: changes, onFinished: finished });
    manager.start();
    driver.complete();
    await manager.wait();
    expect(changes).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(2);
    manager.close();
    await manager.wait();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(driver.calls).toHaveLength(1);
    expect(changes).toHaveBeenCalledTimes(1);
    expect(finished).toHaveBeenCalledTimes(1);
  });

  it('emits idle deferrals when their check changes without adding idle progress polling', async () => {
    const events: SyncStatus[] = [];
    const { manager, driver } = setup({
      policy: { ...policy, mode: 'idle' }, isBusy: () => true,
      onChange: status => { events.push(status); },
    });
    manager.start();
    expect(events).toHaveLength(1);
    expect(events[0].automaticState).toBe('waiting-for-idle');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(events).toHaveLength(2);
    expect(events[1].nextCheckAt).toBe('2026-09-25T00:00:30.000Z');
    expect(vi.getTimerCount()).toBe(1);
    manager.configure({ ...policy, mode: 'manual' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(events.at(-1)!.automaticState).toBe('manual');
    expect(driver.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not wait for an asynchronous terminal subscriber to finish before cleanup or the next check', async () => {
    const { manager, driver } = setup({ onFinished: () => new Promise<void>(() => {}) });
    manager.start();
    driver.complete();
    await expect(manager.wait()).resolves.toBeUndefined();
    expect(manager.snapshot().activity).toBe('idle');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(driver.calls).toHaveLength(2);
  });
});
