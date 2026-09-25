import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppContext } from '../server/app.js';
import { Store } from '../server/store.js';
import { Runner } from '../server/runner.js';
import type { SyncDriver } from '../server/sync-manager.js';
import type { SyncReport } from '../shared/types.js';

const contexts: AppContext[] = [];
const paths: string[] = [];
const headers = { 'x-agent-ops': '1' };
const report: SyncReport = {
  startedAt: '2026-09-25T00:00:00Z', finishedAt: '2026-09-25T00:00:01Z',
  imported: 1, skipped: 0, filesScanned: 1, warnings: [],
};
class Driver implements SyncDriver {
  active = false;
  calls: Array<{ maxRuntimeMs?: number }> = [];
  private pending: Promise<SyncReport> | null = null;
  private resolve?: (value: SyncReport) => void;
  private reject?: (error: Error) => void;
  run(options: { maxRuntimeMs?: number } = {}) {
    if (this.pending) return this.pending;
    this.active = true;
    this.calls.push(options);
    this.pending = new Promise<SyncReport>((resolve, reject) => { this.resolve = resolve; this.reject = reject; })
      .finally(() => { this.active = false; this.pending = null; });
    return this.pending;
  }
  complete() { this.resolve?.(report); }
  stopCurrent() {
    if (!this.active) return false;
    this.reject?.(Object.assign(new Error('fixture stopped'), { name: 'AbortError' }));
    return true;
  }
  cancel() { this.stopCurrent(); }
  async wait() { await this.pending?.catch(() => {}); }
}

async function setup(options: { autoSync?: boolean; mode?: 'interval' | 'idle' | 'manual'; demo?: boolean } = {}) {
  const path = await mkdtemp(join(tmpdir(), 'agent-ops-sync-control-api-'));
  paths.push(path);
  const seed = new Store(join(path, 'agent-ops.sqlite'));
  seed.saveSettings({
    sourceRoots: { codex: [], claude: [], kiro: [] },
    syncMode: options.mode ?? 'manual', syncMaxSeconds: 30, scanIntervalSeconds: 15,
  });
  seed.close();
  const driver = new Driver();
  const context = await createApp({
    dataDir: path, autoSync: options.autoSync ?? false, demo: options.demo,
    connectorProbe: async () => [], syncDriver: driver,
  });
  contexts.push(context);
  // A failed injection must never let this test start a real native-history import.
  expect(context.sync).toBe(driver);
  return { ...context, driver };
}

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.app.close()));
  vi.restoreAllMocks();
  await Promise.all(paths.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('synchronization control integration', () => {
  it('serves cached status without SQLite reads and exposes the same status in bootstrap', async () => {
    const context = await setup();
    const prepare = vi.spyOn(context.store.db, 'prepare');
    const response = await context.app.inject('/api/sync/status');
    expect(response.statusCode).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    prepare.mockRestore();
    expect(response.json()).toMatchObject({
      activity: 'idle', policy: { mode: 'manual', intervalSeconds: 15, maxSeconds: 30 },
    });
    expect((await context.app.inject('/api/bootstrap')).json().syncStatus).toEqual(response.json());
  });

  it('starts manually while automatic work is disabled, stops only that attempt and permits a retry', async () => {
    const context = await setup();
    const start = () => context.app.inject({ method: 'POST', url: '/api/sync/start', headers, payload: {} });
    expect((await start()).statusCode).toBe(202);
    expect(context.driver.calls).toEqual([{ maxRuntimeMs: 30_000 }]);
    const stopped = await context.app.inject({ method: 'POST', url: '/api/sync/cancel', headers, payload: {} });
    expect(stopped.statusCode).toBe(202);
    await context.syncManager.wait();
    const status = (await context.app.inject('/api/sync/status')).json();
    expect(status).toMatchObject({ activity: 'idle', lastAttempt: { outcome: 'cancelled' } });
    expect(status.lastAttempt).not.toHaveProperty('report');
    expect((await start()).statusCode).toBe(202);
    expect(context.driver.calls).toHaveLength(2);
    context.driver.complete();
    await context.syncManager.wait();
    expect((await context.app.inject('/api/sync/status')).json().lastAttempt)
      .toMatchObject({ outcome: 'completed', report: { imported: 1 } });
  });

  it('defers automatic work for busy workbench jobs while manual work can proceed', async () => {
    vi.spyOn(Runner.prototype, 'busy', 'get').mockReturnValue(true);
    const context = await setup({ autoSync: true, mode: 'idle' });
    expect(context.driver.calls).toHaveLength(0);
    expect((await context.app.inject('/api/sync/status')).json()).toMatchObject({ automaticState: 'waiting-for-idle' });
    expect((await context.app.inject({ method: 'POST', url: '/api/sync/start', headers, payload: {} })).statusCode).toBe(202);
    expect(context.driver.calls).toHaveLength(1);
    context.driver.complete();
    await context.syncManager.wait();
  });

  it('validates persisted mode and time budgets while leaving the active budget unchanged', async () => {
    const context = await setup();
    const patch = (payload: Record<string, unknown>) => context.app.inject({ method: 'PATCH', url: '/api/settings', headers, payload });
    for (const payload of [
      { syncMode: 'always' }, { syncMaxSeconds: 0 }, { syncMaxSeconds: 29 }, { syncMaxSeconds: 1801 }, { syncMaxSeconds: 30.5 },
    ]) expect((await patch(payload)).statusCode).toBe(400);
    await context.app.inject({ method: 'POST', url: '/api/sync/start', headers, payload: {} });
    expect((await patch({ syncMode: 'idle', syncMaxSeconds: 120 })).statusCode).toBe(200);
    expect(context.store.getSettings()).toMatchObject({ syncMode: 'idle', syncMaxSeconds: 120 });
    expect((await context.app.inject('/api/sync/status')).json()).toMatchObject({
      policy: { mode: 'idle', maxSeconds: 120 }, currentAttempt: { maxSeconds: 30 },
    });
    context.driver.complete();
    await context.syncManager.wait();
  });

  it('retains mutation and parameter guards for status and cancellation', async () => {
    const context = await setup();
    expect((await context.app.inject('/api/sync/status?path=/tmp')).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'POST', url: '/api/sync/cancel', payload: {} })).statusCode).toBe(403);
    expect((await context.app.inject({ method: 'POST', url: '/api/sync/cancel', headers, payload: { pid: 1 } })).statusCode).toBe(400);
    expect((await context.app.inject({ method: 'POST', url: '/api/sync/cancel?force=true', headers, payload: {} })).statusCode).toBe(400);
    expect(context.driver.calls).toHaveLength(0);
  });

  it('keeps demo control informational without invoking a native driver', async () => {
    const context = await setup({ demo: true, autoSync: true });
    expect((await context.app.inject('/api/sync/status')).json()).toMatchObject({
      demo: true, automaticState: 'disabled', activity: 'idle',
    });
    const refreshed = await context.app.inject({ method: 'POST', url: '/api/sync/start', headers, payload: {} });
    expect(refreshed.statusCode).toBe(202);
    expect(refreshed.json()).toEqual({ syncing: false });
    expect(context.driver.calls).toHaveLength(0);
  });

  it('emits only lightweight sync state during work and refreshes the archive at completion', async () => {
    const context = await setup();
    const base = await context.app.listen({ host: '127.0.0.1', port: 0 });
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${base}/api/events`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: Array<{ type: string; status?: { activity: string } }> = [];
    let buffer = '';
    async function until(predicate: () => boolean) {
      while (!predicate()) {
        const part = await reader.read();
        if (part.done) throw new Error('Event stream closed before the expected frame');
        buffer += decoder.decode(part.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const data = event.split('\n').find(line => line.startsWith('data: '));
          if (data) frames.push(JSON.parse(data.slice(6)));
        }
      }
    }
    try {
      await context.app.inject({ method: 'POST', url: '/api/sync/start', headers, payload: {} });
      await until(() => frames.some(frame => frame.type === 'sync-state' && frame.status?.activity === 'running'));
      expect(frames.every(frame => frame.type === 'sync-state')).toBe(true);
      context.driver.complete();
      await context.syncManager.wait();
      await until(() => frames.some(frame => frame.type === 'refresh'));
      expect(frames.filter(frame => frame.type === 'refresh')).toHaveLength(1);
    } finally {
      clearTimeout(deadline);
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});
