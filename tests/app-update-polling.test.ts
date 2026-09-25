import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateReport } from '../shared/app-update.js';
import { pollAppUpdate } from '../src/features/app-update/polling';

function report(overrides: Partial<AppUpdateReport> = {}): AppUpdateReport {
  return {
    currentVersion: '1.2.1', status: 'not-checked', demo: false, checking: true,
    latest: null, checkedAt: null, nextCheckAt: '2026-09-25T12:01:00.000Z', error: null,
    sourceUrl: 'https://api.github.com/repos/whchoi98/agent-ops/releases/latest',
    commands: { npm: null, git: null }, ...overrides,
  };
}

afterEach(() => { vi.useRealTimers(); });

describe('observing a check started by another browser tab', () => {
  it.each([
    { checking: false },
    { demo: true },
    { status: 'demo' as const },
  ])('does not poll idle or demo reports', overrides => {
    vi.useFakeTimers();
    let reads = 0;
    const stop = pollAppUpdate(report(overrides), {
      read: async () => { reads++; return report(); }, onResult: () => {}, onError: () => {},
    });
    expect(reads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it('reads only the cached report and stops immediately after observing completion', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const updates: AppUpdateReport[] = [];
    pollAppUpdate(report(), {
      read: async () => {
        reads++;
        return report({ checking: false, status: 'current', checkedAt: '2026-09-25T12:00:02.000Z' });
      },
      onResult: value => updates.push(value), onError: () => {},
    });
    expect(reads).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ checking: false, status: 'current', checkedAt: '2026-09-25T12:00:02.000Z' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never overlaps slow reads and ignores a late response after disposal', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let signal: AbortSignal | undefined;
    let finish!: (value: AppUpdateReport) => void;
    const updates: AppUpdateReport[] = [];
    const stop = pollAppUpdate(report(), {
      read: async ownSignal => {
        reads++;
        signal = ownSignal;
        return new Promise<AppUpdateReport>(resolve => { finish = resolve; });
      },
      onResult: value => updates.push(value), onError: () => {},
    });
    await vi.advanceTimersByTimeAsync(6000);
    expect(reads).toBe(1);
    stop();
    stop();
    expect(signal?.aborted).toBe(true);
    finish(report({ checking: false, status: 'current' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(updates).toEqual([]);
    expect(reads).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops within fifteen seconds even when a cached read never finishes', async () => {
    vi.useFakeTimers();
    let reads = 0;
    let signal: AbortSignal | undefined;
    const errors: string[] = [];
    pollAppUpdate(report(), {
      read: async ownSignal => {
        reads++;
        signal = ownSignal;
        return new Promise<AppUpdateReport>(() => {});
      },
      onResult: () => {}, onError: message => errors.push(message),
    });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(signal?.aborted).toBe(true);
    expect(reads).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('캐시 상태');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not automatically retry a failed cache read', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const errors: string[] = [];
    pollAppUpdate(report(), {
      read: async () => { reads++; throw new Error('fixture cache failure'); },
      onResult: () => {}, onError: message => errors.push(message),
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads).toBe(1);
    expect(errors).toEqual(['fixture cache failure']);
    expect(vi.getTimerCount()).toBe(0);
  });
});
