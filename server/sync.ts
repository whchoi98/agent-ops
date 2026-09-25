import { discoverSessions, type KiroRowCheckpoint } from './providers/index.js';
import { timestamp } from './providers/common.js';
import type { Store } from './store.js';
import type { Agent, SyncReport } from '../shared/types.js';
import { setImmediate as yieldToIO } from 'node:timers/promises';

// Parser identity changes require unchanged native files to be read once again.
const parserFormat = (agent?: Agent) => agent === 'kiro' ? 'format-v4-kiro-credits' : 'format-v3';
const importFingerprint = (fingerprint: string, agent?: Agent) => `${parserFormat(agent)}:${fingerprint}`;

export interface SyncController {
  readonly active: boolean;
  run(): Promise<SyncReport>;
  wait(): Promise<void>;
  cancel(): void;
}

export class SyncService implements SyncController {
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
      : await discoverSessions(this.store.getSettings().sourceRoots, async (session) => {
        if (this.stopping) throw new Error('Synchronization cancelled.');
        const stored = this.store.getSession(session.id, false);
        if (stored && stored.sourcePath !== session.sourcePath) {
          const storedAt = Date.parse(timestamp(stored.updatedAt) ?? '');
          const incomingAt = Date.parse(timestamp(session.updatedAt) ?? '');
          // Competing copies must not regress persisted history. The same source
          // may legitimately revise its corpus or parser-derived timestamps.
          if (storedAt > incomingAt || (storedAt === incomingAt && stored.messageCount > session.messageCount)) return false;
        }
        this.store.upsertSession(session);
        imported++;
        if (Date.now() - lastProgress >= 2000) {
          lastProgress = Date.now();
          this.onProgress(imported);
        }
        // SQLite rows otherwise resolve through microtasks without polling sockets.
        await yieldToIO();
      }, {
        shouldRead: (path, fingerprint, agent) => !this.stopping && this.store.getFingerprint(path) !== importFingerprint(fingerprint, agent),
        onRead: (path, fingerprint, agent) => { if (!this.stopping) this.store.setFingerprint(path, importFingerprint(fingerprint, agent)); },
        kiroRows: {
          get: (key) => {
            if (this.stopping) throw new Error('Synchronization cancelled.');
            const saved = this.store.getFingerprint(key);
            if (!saved) return null;
            try {
              const value = JSON.parse(saved) as Partial<KiroRowCheckpoint> & { format?: string };
              if (value.format !== parserFormat('kiro') || typeof value.fingerprint !== 'string' || typeof value.sessionId !== 'string') return null;
              if (!this.store.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(value.sessionId)) return null;
              return { fingerprint: value.fingerprint, sessionId: value.sessionId };
            } catch { return null; }
          },
          set: (key, checkpoint) => {
            if (!this.stopping) this.store.setFingerprint(key, JSON.stringify({ format: parserFormat('kiro'), ...checkpoint }));
          },
        },
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
