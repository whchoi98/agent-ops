import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import type { SyncReport } from '../shared/types.js';

export interface BackgroundSyncOptions {
  dataDir: string;
  entry: string;
  onComplete?: (report: SyncReport) => void;
  onProgress?: () => void;
}

const STDOUT_LIMIT = 1024 * 1024;
const STDERR_LIMIT = 256 * 1024;
const RUN_LIMIT_MS = 30 * 60 * 1000;
const TERM_GRACE_MS = 1000;
const CLOSE_GRACE_MS = 1000;
const PROGRESS_INTERVAL_MS = 2000;

interface Job { promise: Promise<SyncReport>; stop: (reason: Error) => void }

function timestamp(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value));
}

function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseReport(bytes: Buffer): SyncReport {
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid report');
  const data = value as Record<string, unknown>;
  if (!timestamp(data.startedAt) || !timestamp(data.finishedAt)
    || Date.parse(data.finishedAt) < Date.parse(data.startedAt)
    || !count(data.imported) || !count(data.filesScanned) || !count(data.skipped)
    || !Array.isArray(data.warnings) || !data.warnings.every((warning): warning is string => typeof warning === 'string')) {
    throw new Error('Invalid report');
  }
  return {
    startedAt: data.startedAt, finishedAt: data.finishedAt,
    imported: data.imported, filesScanned: data.filesScanned, skipped: data.skipped,
    warnings: [...data.warnings],
  };
}

function notify(callback: (() => void) | undefined): void {
  try { void Promise.resolve(callback?.()).catch(() => {}); }
  catch { /* Notification failure cannot undo a completed import or escape an event handler. */ }
}

/** Runs only Agent Ops' own sync entry. Native parsing and SQLite writes stay in that child. */
export class BackgroundSync {
  private readonly options: BackgroundSyncOptions;
  private job: Job | null = null;
  private stopping = false;

  constructor(options: BackgroundSyncOptions) {
    this.options = { ...options, dataDir: resolve(options.dataDir), entry: resolve(options.entry) };
  }

  get active(): boolean { return this.job !== null; }

  run(): Promise<SyncReport> {
    if (this.stopping) return Promise.reject(new Error('Synchronization is stopping.'));
    if (this.job) return this.job.promise;
    let resolveRun!: (report: SyncReport) => void;
    let rejectRun!: (error: Error) => void;
    const promise = new Promise<SyncReport>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
    // Shutdown callers may only await wait(); run() still rejects for callers that await it.
    void promise.catch(() => {});
    let child: ChildProcess | null = null;
    let settled = false;
    let stoppingChild = false;
    let failure: Error | null = null;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let runtime: ReturnType<typeof setTimeout> | undefined;
    let escalate: ReturnType<typeof setTimeout> | undefined;
    let killedCleanup: ReturnType<typeof setTimeout> | undefined;
    let drain: ReturnType<typeof setTimeout> | undefined;
    let progress: ReturnType<typeof setInterval> | undefined;
    const job: Job = { promise, stop: reason => stop(reason) };
    this.job = job;

    const closeStreams = () => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    };
    const finish = (report?: SyncReport) => {
      if (settled) return;
      settled = true;
      clearTimeout(runtime);
      clearTimeout(escalate);
      clearTimeout(killedCleanup);
      clearTimeout(drain);
      clearInterval(progress);
      closeStreams();
      child?.unref();
      stdout.length = 0;
      if (this.job === job) this.job = null;
      if (failure || !report) rejectRun(failure ?? new Error('Background synchronization failed.'));
      else {
        notify(() => this.options.onComplete?.({ ...report, warnings: [...report.warnings] }));
        resolveRun(report);
      }
    };
    const signal = (name: NodeJS.Signals) => {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill(name); } catch { /* Only the ChildProcess owned by this run is signalled. */ }
      }
    };
    const stop = (reason: Error) => {
      if (settled) return;
      failure ??= reason;
      if (stoppingChild) return;
      stoppingChild = true;
      clearTimeout(runtime);
      clearInterval(progress);
      closeStreams();
      if (!child?.pid) { finish(); return; }
      signal('SIGTERM');
      escalate = setTimeout(() => {
        signal('SIGKILL');
        // A killed leader must not leave shutdown waiting indefinitely on inherited pipes.
        killedCleanup = setTimeout(() => { closeStreams(); finish(); }, CLOSE_GRACE_MS);
        killedCleanup.unref?.();
      }, TERM_GRACE_MS);
      escalate.unref?.();
    };

    try {
      const args = [
        ...(/\.[cm]?ts$/i.test(this.options.entry) ? ['--import', 'tsx'] : []),
        this.options.entry, 'sync', '--data-dir', this.options.dataDir,
      ];
      child = spawn(process.execPath, args, {
        shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout!.on('data', (chunk: Buffer) => {
        if (failure || settled) return;
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > STDOUT_LIMIT) { stop(new Error('Background synchronization output exceeded the safety limit.')); return; }
        stdout.push(chunk);
      });
      child.stderr!.on('data', (chunk: Buffer) => {
        if (failure || settled) return;
        // Drain and bound stderr without retaining or exposing private runtime diagnostics.
        stderrBytes += chunk.byteLength;
        if (stderrBytes > STDERR_LIMIT) stop(new Error('Background synchronization output exceeded the safety limit.'));
      });
      child.stdout!.on('error', () => stop(new Error('Background synchronization output failed.')));
      child.stderr!.on('error', () => stop(new Error('Background synchronization output failed.')));
      child.once('error', () => stop(new Error('Background synchronization failed to start.')));
      child.once('exit', () => {
        if (settled) return;
        drain = setTimeout(() => {
          failure ??= new Error('Background synchronization output pipes did not close.');
          closeStreams();
          finish();
        }, CLOSE_GRACE_MS);
        drain.unref?.();
      });
      child.once('close', (code, exitSignal) => {
        if (settled) return;
        if (failure) { finish(); return; }
        if (code !== 0 || exitSignal) {
          failure = new Error('Background synchronization failed.');
          finish();
          return;
        }
        let report: SyncReport;
        try { report = parseReport(Buffer.concat(stdout, stdoutBytes)); }
        catch {
          failure = new Error('Background synchronization returned an invalid report.');
          finish();
          return;
        }
        finish(report);
      });
      runtime = setTimeout(() => stop(new Error('Background synchronization time limit exceeded.')), RUN_LIMIT_MS);
      runtime.unref?.();
      if (this.options.onProgress) {
        progress = setInterval(() => {
          if (!settled && !stoppingChild && !this.stopping) notify(this.options.onProgress);
        }, PROGRESS_INTERVAL_MS);
        progress.unref?.();
      }
    } catch {
      stop(new Error('Background synchronization failed to start.'));
    }
    return promise;
  }

  cancel(): void {
    this.stopping = true;
    const error = new Error('Synchronization cancelled.');
    error.name = 'AbortError';
    this.job?.stop(error);
  }

  async wait(): Promise<void> {
    await this.job?.promise.then(() => {}, () => {});
  }
}
