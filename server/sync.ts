import { discoverSessions } from './providers/index.js';
import type { Store } from './store.js';
import type { SyncReport } from '../shared/types.js';

// Parser identity changes require unchanged native files to be read once again.
const importFingerprint = (fingerprint: string) => `format-v2:${fingerprint}`;

export class SyncService {
  private pending: Promise<SyncReport> | null = null;
  private stopping = false;
  constructor(
    private store: Store, private onComplete = () => {}, private demo = false,
    private onProgress: (imported: number) => void = () => {},
  ) {}
  get active(): boolean { return this.pending !== null; }
  run(): Promise<SyncReport> {
    if (this.stopping) return Promise.reject(new Error('Synchronization is stopping.'));
    if (this.pending) return this.pending;
    this.pending = this.collect().finally(() => { this.pending = null; });
    return this.pending;
  }
  async wait(): Promise<void> { await this.pending; }
  cancel(): void { this.stopping = true; }
  private async collect(): Promise<SyncReport> {
    const startedAt = new Date().toISOString();
    let imported = 0;
    let lastProgress = Date.now();
    const summary = this.demo ? { filesScanned: 0, skipped: 0, warnings: [] as string[] }
      : await discoverSessions(this.store.getSettings().sourceRoots, (session) => {
        if (this.stopping) throw new Error('Synchronization cancelled.');
        this.store.upsertSession(session);
        imported++;
        if (Date.now() - lastProgress >= 2000) {
          lastProgress = Date.now();
          this.onProgress(imported);
        }
      }, {
        shouldRead: (path, fingerprint) => !this.stopping && this.store.getFingerprint(path) !== importFingerprint(fingerprint),
        onRead: (path, fingerprint) => { if (!this.stopping) this.store.setFingerprint(path, importFingerprint(fingerprint)); },
        maxFiles: 20000,
      });
    const report: SyncReport = {
      startedAt, finishedAt: new Date().toISOString(), imported,
      filesScanned: summary.filesScanned, skipped: summary.skipped,
      warnings: summary.warnings.slice(0, 100),
    };
    if (summary.warnings.length > 100) report.warnings.push(`${summary.warnings.length - 100} additional diagnostics omitted.`);
    if (this.stopping) report.warnings.push('Synchronization stopped. Unread sources will be retried on the next sync.');
    this.store.setMeta('sync', report);
    this.onComplete();
    return report;
  }
}
