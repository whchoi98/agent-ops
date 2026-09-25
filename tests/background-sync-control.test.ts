import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { BackgroundSync } from '../server/background-sync.js';
import { SyncManager } from '../server/sync-manager.js';
import type { SyncLastAttempt } from '../shared/sync-control.js';

const fixture = fileURLToPath(new URL('./fixtures/background-sync.mjs', import.meta.url));
const report = {
  startedAt: '2026-09-25T00:00:00.000Z',
  finishedAt: '2026-09-25T00:00:01.000Z',
  imported: 1, filesScanned: 2, skipped: 1, warnings: [],
};
const directories: string[] = [];
const workers: BackgroundSync[] = [];
const managers: SyncManager[] = [];

async function worker(config: Record<string, unknown> = { mode: 'hold' }) {
  const dataDir = await mkdtemp(join(tmpdir(), 'agent-ops-sync-control-'));
  directories.push(dataDir);
  await writeFile(join(dataDir, 'fixture.json'), JSON.stringify(config));
  const sync = new BackgroundSync({ dataDir, entry: fixture });
  workers.push(sync);
  return { sync, dataDir };
}

async function ready(dataDir: string): Promise<{ pid: number }> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(join(dataDir, 'ready.json'), 'utf8')) as { pid: number }; }
    catch { await delay(10); }
  }
  throw new Error('Controlled sync fixture did not become ready.');
}

afterEach(async () => {
  const controllers = managers.splice(0);
  controllers.forEach(manager => manager.close());
  const owned = workers.splice(0);
  owned.forEach(sync => sync.cancel());
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await Promise.all(owned.map(sync => sync.wait()));
  await Promise.all(controllers.map(manager => manager.wait()));
  vi.useRealTimers();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('BackgroundSync reusable control', () => {
  it('stops the current attempt immediately and permits a new run after cleanup', async () => {
    const { sync, dataDir } = await worker();
    expect(sync.stopCurrent()).toBe(false);
    const first = sync.run();
    expect(sync.stopCurrent()).toBe(true);
    expect(sync.stopCurrent()).toBe(false);
    expect(sync.run()).toBe(first);
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await sync.wait();
    expect(sync.active).toBe(false);
    expect(sync.resourceRoots).toEqual([]);
    expect(sync.stopCurrent()).toBe(false);

    await writeFile(join(dataDir, 'fixture.json'), JSON.stringify({ report }));
    await expect(sync.run()).resolves.toEqual(report);
    await sync.wait();
    expect(sync.active).toBe(false);
  });

  it('retains SIGTERM/SIGKILL escalation and signals only the current owned child', async () => {
    const { sync, dataDir } = await worker({ mode: 'ignore-term' });
    const { sync: other, dataDir: otherDir } = await worker();
    const first = sync.run().catch(error => error);
    const otherRun = other.run().catch(error => error);
    const [child, unrelated] = await Promise.all([ready(dataDir), ready(otherDir)]);
    const startedAt = Date.now();

    expect(sync.stopCurrent()).toBe(true);
    expect(sync.stopCurrent()).toBe(false);
    await sync.wait();
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(await first).toMatchObject({ name: 'AbortError' });
    expect(await readFile(join(dataDir, 'terminated'), 'utf8')).toBe('SIGTERM');
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(() => process.kill(unrelated.pid, 0)).not.toThrow();
    expect(other.active).toBe(true);

    await writeFile(join(dataDir, 'fixture.json'), JSON.stringify({ report }));
    await expect(sync.run()).resolves.toEqual(report);
    other.cancel();
    await other.wait();
    expect(await otherRun).toMatchObject({ name: 'AbortError' });
  });

  it('keeps shutdown cancellation permanent after a reusable stop', async () => {
    const { sync, dataDir } = await worker();
    const first = sync.run();
    await ready(dataDir);
    expect(sync.stopCurrent()).toBe(true);
    sync.cancel();
    sync.cancel();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await sync.wait();
    expect(sync.stopCurrent()).toBe(false);
    await expect(sync.run()).rejects.toThrow(/stopping|cancel/i);
    expect(sync.active).toBe(false);
  });
});

describe('BackgroundSync per-attempt runtime budget', () => {
  it('times out at an injected millisecond deadline and can run again with a fresh budget', async () => {
    const { sync, dataDir } = await worker();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = sync.run({ maxRuntimeMs: 37 }).catch(error => error);
    const child = await ready(dataDir);

    await vi.advanceTimersByTimeAsync(36);
    expect(sync.active).toBe(true);
    await expect(readFile(join(dataDir, 'terminated'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.stopCurrent()).toBe(false);
    expect(await first).toMatchObject({
      name: 'SyncTimeoutError', message: 'Background synchronization time limit exceeded.',
    });
    await sync.wait();
    expect(sync.active).toBe(false);
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(vi.getTimerCount()).toBe(0);

    await writeFile(join(dataDir, 'fixture.json'), JSON.stringify({ report }));
    await expect(sync.run()).resolves.toEqual(report);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([undefined, 1_800_001, Number.MAX_VALUE])('keeps the default and maximum deadline at 30 minutes (%s)', async maxRuntimeMs => {
    const { sync, dataDir } = await worker();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outcome = sync.run({ maxRuntimeMs }).catch(error => error);
    await ready(dataDir);

    await vi.advanceTimersByTimeAsync(1_799_999);
    expect(sync.active).toBe(true);
    await expect(readFile(join(dataDir, 'terminated'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.stopCurrent()).toBe(false);
    expect(await outcome).toMatchObject({ name: 'SyncTimeoutError' });
    await sync.wait();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces requests without replacing the current attempt budget', async () => {
    const { sync, dataDir } = await worker();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = sync.run({ maxRuntimeMs: 74 });
    const outcome = first.catch(error => error);
    await ready(dataDir);
    expect(sync.run({ maxRuntimeMs: 1 })).toBe(first);

    await vi.advanceTimersByTimeAsync(73);
    expect(sync.active).toBe(true);
    await expect(readFile(join(dataDir, 'terminated'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.stopCurrent()).toBe(false);
    expect(await outcome).toMatchObject({ name: 'SyncTimeoutError' });
    await sync.wait();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps manual cancellation distinct from an impending timeout', async () => {
    const { sync, dataDir } = await worker();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const outcome = sync.run({ maxRuntimeMs: 50 }).catch(error => error);
    await ready(dataDir);
    await vi.advanceTimersByTimeAsync(49);
    expect(sync.stopCurrent()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ name: 'AbortError' });
    await sync.wait();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([0, -1, NaN, Infinity, -Infinity])('rejects an invalid budget before spawning (%s)', async maxRuntimeMs => {
    const { sync, dataDir } = await worker({ report });
    await expect(sync.run({ maxRuntimeMs })).rejects.toThrow(/positive finite/i);
    expect(sync.active).toBe(false);
    await expect(readFile(join(dataDir, 'starts.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(sync.run()).resolves.toEqual(report);
  });
});

describe('SyncManager with the owned background process', () => {
  it.each(['stop', 'timeout'])('classifies a real child %s and keeps a later import usable', async interruption => {
    const { sync, dataDir } = await worker();
    const finished: SyncLastAttempt[] = [];
    const manager = new SyncManager({
      driver: sync, policy: { mode: 'manual', intervalSeconds: 15, maxSeconds: 30 },
      autoEnabled: false, isBusy: () => false,
      onFinished: attempt => { finished.push(attempt); },
    });
    managers.push(manager);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = manager.runManual();
    const outcome = pending.catch(error => error);
    const child = await ready(dataDir);
    expect(manager.runManual()).toBe(pending);
    if (interruption === 'stop') {
      expect(manager.stopCurrent()).toBe(true);
      expect(manager.snapshot().activity).toBe('stopping');
    } else {
      await vi.advanceTimersByTimeAsync(30_000);
      expect(manager.stopCurrent()).toBe(false);
    }
    await manager.wait();
    expect(await outcome).toMatchObject({ name: interruption === 'stop' ? 'AbortError' : 'SyncTimeoutError' });
    expect(manager.snapshot()).toMatchObject({
      activity: 'idle', currentAttempt: null, nextCheckAt: null,
      lastAttempt: { outcome: interruption === 'stop' ? 'cancelled' : 'timed-out' },
    });
    expect(manager.snapshot().lastAttempt).not.toHaveProperty('report');
    expect(finished).toHaveLength(1);
    expect(() => process.kill(child.pid, 0)).toThrow();
    expect(sync.active).toBe(false);

    await writeFile(join(dataDir, 'fixture.json'), JSON.stringify({ report }));
    await expect(manager.runManual()).resolves.toEqual(report);
    await manager.wait();
    expect(finished).toHaveLength(2);
    expect(finished[1]).toMatchObject({ outcome: 'completed', error: null, report });
    expect(vi.getTimerCount()).toBe(0);
    manager.close();
    await manager.wait();
    await expect(sync.run()).rejects.toThrow(/stopping/i);
  });
});
