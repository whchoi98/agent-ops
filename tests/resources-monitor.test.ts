import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResourceMonitor } from '../server/resources/monitor.js';
import { emptyOwnedSnapshot } from '../server/resources/processes.js';
import type { DiskSnapshot } from '../shared/resources.js';

const disk = (): DiskSnapshot => ({
  at: '2026-09-25T10:00:00.000Z', dataDirectory: '/synthetic', logicalBytes: 0,
  allocatedBytes: 0, fileCount: 0, entriesScanned: 0, skippedLinks: 0, complete: true,
  durationMs: 0, volume: { totalBytes: 1000000, availableBytes: 800000 },
  categories: {
    database: { logicalBytes: 0, allocatedBytes: 0, fileCount: 0 },
    wal: { logicalBytes: 0, allocatedBytes: 0, fileCount: 0 },
    backups: { logicalBytes: 0, allocatedBytes: 0, fileCount: 0 },
    other: { logicalBytes: 0, allocatedBytes: 0, fileCount: 0 },
  }, warnings: [],
});
const monitors: ResourceMonitor[] = [];
afterEach(() => { for (const monitor of monitors.splice(0)) monitor.stop(); vi.useRealTimers(); });
function fixture(overrides: Partial<ConstructorParameters<typeof ResourceMonitor>[0]> = {}) {
  let now = 0, cpu = 0;
  const readSelf = vi.fn(() => ({
    cpu: { user: cpu, system: 0 },
    memory: { rss: 1024 * 1024, heapUsed: 1234, heapTotal: 4096 },
  }));
  const readDisk = vi.fn(async () => disk());
  const monitor = new ResourceMonitor({
    dataDir: '/synthetic', now: () => now, readSelf, readDisk, ...overrides,
  });
  monitors.push(monitor);
  return { monitor, readSelf, readDisk, advance: (ms: number, microseconds: number) => { now += ms; cpu += microseconds; } };
}

describe('bounded resource monitor', () => {
  it('uses microsecond CPU deltas, reports warm-up unknown, and allows more than one core', async () => {
    const { monitor, advance } = fixture();
    await monitor.sample();
    expect(monitor.snapshot().current?.scopes.server.cpuPercent).toBeNull();
    advance(5000, 7_500_000);
    await monitor.sample();
    expect(monitor.snapshot().current).toMatchObject({
      cpuWindowMs: 5000, heapUsedBytes: 1234,
      scopes: { server: { cpuPercent: 150, rssBytes: 1024 * 1024, processCount: 1 } },
    });
    advance(5000, 0);
    await monitor.sample();
    expect(monitor.snapshot().current?.scopes.server.cpuPercent).toBe(0);
  });

  it('keeps history fixed and does not run disk scans or collectors when reading a snapshot', async () => {
    const { monitor, advance, readSelf, readDisk } = fixture({ historyLimit: 3 });
    for (let i = 0; i < 7; i++) { advance(5000, 1000); await monitor.sample(); }
    expect(monitor.snapshot().history).toHaveLength(3);
    expect(monitor.snapshot().retentionSeconds).toBe(15);
    for (let i = 0; i < 20; i++) monitor.snapshot();
    expect(readSelf).toHaveBeenCalledTimes(7);
    expect(readDisk).not.toHaveBeenCalled();
  });

  it('retains the hard history cap even if an embedder supplies an invalid limit', async () => {
    const { monitor, advance } = fixture({ historyLimit: Number.NaN });
    for (let i = 0; i < 200; i++) { advance(5000, 100); await monitor.sample(); }
    expect(monitor.snapshot().history).toHaveLength(180);
    expect(monitor.snapshot().retentionSeconds).toBe(900);
  });

  it('keeps CPU sampling responsive while one disk scan is pending', async () => {
    let finish!: (result: DiskSnapshot) => void;
    const readDisk = vi.fn(() => new Promise<DiskSnapshot>(resolve => { finish = resolve; }));
    const { monitor, advance } = fixture({ readDisk });
    const first = monitor.sampleDisk();
    void monitor.sampleDisk();
    await Promise.resolve();
    await monitor.sample();
    advance(5000, 5000);
    await monitor.sample();
    expect(readDisk).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().history).toHaveLength(2);
    expect(monitor.snapshot().collector.scanningDisk).toBe(true);
    finish(disk());
    await first;
    expect(monitor.snapshot().disk?.complete).toBe(true);
  });

  it('coalesces overlapping process samples and retains unknown counters after a reset', async () => {
    let finish!: (value: ReturnType<typeof emptyOwnedSnapshot>) => void;
    const readOwned = vi.fn(() => new Promise<ReturnType<typeof emptyOwnedSnapshot>>(resolve => { finish = resolve; }));
    const { monitor } = fixture({ readOwned });
    const first = monitor.sample();
    const second = monitor.sample();
    await Promise.resolve();
    expect(readOwned).toHaveBeenCalledTimes(1);
    finish(emptyOwnedSnapshot());
    await Promise.all([first, second]);
    expect(monitor.snapshot().history).toHaveLength(1);
    expect(monitor.snapshot().collector.skippedSamples).toBe(1);
  });

  it('cancels timers and signals pending collection without waiting indefinitely for a filesystem', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const { monitor, readSelf } = fixture({
      readDisk: async (_path, options) => {
        signals.push(options!.signal!);
        return new Promise<DiskSnapshot>(() => {});
      },
    });
    monitor.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(readSelf).toHaveBeenCalledTimes(1);
    monitor.stop();
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(120000);
    expect(readSelf).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('redacts collector failures and does not turn failed CPU or disk metrics into zero', async () => {
    const { monitor } = fixture({
      readSelf: () => { throw new Error('private detail'); },
      readDisk: async () => { throw new Error('private path'); },
    });
    await monitor.sample();
    await monitor.sampleDisk();
    const report = monitor.snapshot();
    expect(report.current?.scopes.server.cpuPercent).toBeNull();
    expect(report.current?.scopes.server.rssBytes).toBeNull();
    expect(report.disk?.logicalBytes).toBeNull();
    expect(JSON.stringify(report)).not.toContain('private');
  });
});
