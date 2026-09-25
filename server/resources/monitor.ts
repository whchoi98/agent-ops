import { availableParallelism, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import type { DiskSnapshot, ResourceReport, ResourceSample } from '../../shared/resources.js';
import { scanDisk, type DiskScanOptions } from './disk.js';
import { emptyOwnedSnapshot, OwnedProcessSampler, type OwnedProcessRoot, type OwnedProcessSnapshot } from './processes.js';

const SAMPLE_MS = 5000;
const DISK_MS = 60_000;
const HISTORY_LIMIT = 180;
type SelfCounters = {
  cpu: { user: number; system: number };
  memory: { rss: number; heapUsed: number; heapTotal: number };
};
export interface ResourceMonitorOptions {
  dataDir: string;
  roots?: () => readonly OwnedProcessRoot[];
  now?: () => number;
  time?: () => string;
  historyLimit?: number;
  readSelf?: () => SelfCounters;
  readOwned?: (roots: readonly OwnedProcessRoot[], signal: AbortSignal) => Promise<OwnedProcessSnapshot>;
  readDisk?: (path: string, options?: DiskScanOptions) => Promise<DiskSnapshot>;
}
const finite = (value: number): number | null => Number.isFinite(value) && value >= 0 ? value : null;
const bytes = (value: number): number | null => Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Bounded volatile samples, independent of SQLite and the application's refresh bus. */
export class ResourceMonitor {
  private readonly options: ResourceMonitorOptions;
  private readonly now: () => number;
  private readonly time: () => string;
  private readonly limit: number;
  private readonly ownerSampler: OwnedProcessSampler;
  private readonly abort = new AbortController();
  private readonly server: ResourceReport['server'];
  private history: ResourceSample[] = [];
  private disk: DiskSnapshot | null = null;
  private previous: { cpu: SelfCounters['cpu']; at: number } | null = null;
  private processTask: Promise<void> | null = null;
  private diskTask: Promise<void> | null = null;
  private sampleTimer?: NodeJS.Timeout;
  private diskTimer?: NodeJS.Timeout;
  private stopped = false;
  private started = false;
  private skippedSamples = 0;
  private maxDurationMs = 0;

  constructor(options: ResourceMonitorOptions) {
    this.options = { ...options, dataDir: resolve(options.dataDir) };
    this.now = options.now ?? (() => performance.now());
    this.time = options.time ?? (() => new Date().toISOString());
    this.limit = Math.max(1, Math.min(HISTORY_LIMIT, Math.floor(
      Number.isFinite(options.historyLimit) ? options.historyLimit! : HISTORY_LIMIT,
    )));
    this.ownerSampler = new OwnedProcessSampler({ now: this.now });
    this.server = {
      pid: process.pid, platform: process.platform, logicalCpuCount: availableParallelism(),
      totalMemoryBytes: totalmem(), startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    };
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.sample();
    void this.sampleDisk();
    this.sampleTimer = setInterval(() => { void this.sample(); }, SAMPLE_MS);
    this.diskTimer = setInterval(() => { void this.sampleDisk(); }, DISK_MS);
    this.sampleTimer.unref();
    this.diskTimer.unref();
  }

  sample(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.processTask) { this.skippedSamples++; return this.processTask; }
    const task = Promise.resolve().then(async () => {
      const started = this.now();
      let owned = emptyOwnedSnapshot();
      try {
        const roots = this.options.roots?.() ?? [];
        owned = await (this.options.readOwned
          ? this.options.readOwned(roots, this.abort.signal)
          : this.ownerSampler.sample(roots, this.abort.signal));
      } catch {
        owned.warnings.push('owned_processes_unavailable');
        for (const root of this.options.roots?.() ?? []) {
          owned.scopes[root.kind] = { cpuPercent: null, rssBytes: null, processCount: null };
        }
      }
      if (this.stopped) return;
      const sample: ResourceSample = {
        at: this.time(), scopes: {
          server: { cpuPercent: null, rssBytes: null, processCount: 1 }, ...owned.scopes,
        },
        heapUsedBytes: null, heapTotalBytes: null, cpuWindowMs: null,
        durationMs: 0, warnings: [...owned.warnings],
      };
      try {
        const current = this.options.readSelf?.() ?? { cpu: process.cpuUsage(), memory: process.memoryUsage() };
        const at = this.now();
        sample.scopes.server.rssBytes = bytes(current.memory.rss);
        sample.heapUsedBytes = bytes(current.memory.heapUsed);
        sample.heapTotalBytes = bytes(current.memory.heapTotal);
        const cpu = current.cpu;
        if (finite(cpu.user) === null || finite(cpu.system) === null) throw new Error('Invalid CPU counters');
        if (this.previous && at > this.previous.at && cpu.user >= this.previous.cpu.user && cpu.system >= this.previous.cpu.system) {
          const elapsed = at - this.previous.at;
          sample.cpuWindowMs = elapsed;
          sample.scopes.server.cpuPercent = finite(
            ((cpu.user - this.previous.cpu.user) + (cpu.system - this.previous.cpu.system)) / (elapsed * 10),
          );
        }
        this.previous = { cpu: { ...cpu }, at };
      } catch {
        this.previous = null;
        sample.warnings.push('sampling_failed');
      }
      sample.durationMs = Math.max(0, this.now() - started);
      this.maxDurationMs = Math.max(this.maxDurationMs, sample.durationMs);
      this.history.push(sample);
      if (this.history.length > this.limit) this.history.splice(0, this.history.length - this.limit);
    }).catch(() => {
      // Metrics must never fail an import, a run, or the server's timer callback.
      this.previous = null;
    }).finally(() => { if (this.processTask === task) this.processTask = null; });
    this.processTask = task;
    return task;
  }

  sampleDisk(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.diskTask) return this.diskTask;
    const task = Promise.resolve().then(async () => {
      try {
        const result = await (this.options.readDisk ?? scanDisk)(this.options.dataDir, { signal: this.abort.signal });
        if (!this.stopped) this.disk = result;
      } catch {
        if (!this.stopped) this.disk = {
          at: this.time(), dataDirectory: this.options.dataDir, logicalBytes: null,
          allocatedBytes: null, fileCount: 0, entriesScanned: 0, skippedLinks: 0,
          complete: false, durationMs: 0, volume: null, warnings: ['disk_unavailable'],
          categories: {
            database: { logicalBytes: 0, allocatedBytes: null, fileCount: 0 },
            wal: { logicalBytes: 0, allocatedBytes: null, fileCount: 0 },
            backups: { logicalBytes: 0, allocatedBytes: null, fileCount: 0 },
            other: { logicalBytes: 0, allocatedBytes: null, fileCount: 0 },
          },
        };
      }
    }).finally(() => { if (this.diskTask === task) this.diskTask = null; });
    this.diskTask = task;
    return task;
  }

  snapshot(): ResourceReport {
    // No scan, SQL access, counter read, or subprocess launch on the read path.
    return {
      server: { ...this.server }, sampleIntervalSeconds: SAMPLE_MS / 1000,
      diskIntervalSeconds: DISK_MS / 1000, retentionSeconds: this.limit * SAMPLE_MS / 1000,
      current: this.history.at(-1) ?? null, history: [...this.history], disk: this.disk,
      collector: {
        sampling: this.processTask !== null, scanningDisk: this.diskTask !== null,
        skippedSamples: this.skippedSamples, maxDurationMs: this.maxDurationMs,
      },
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.sampleTimer);
    clearInterval(this.diskTimer);
    this.abort.abort();
  }
}
