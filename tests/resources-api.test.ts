import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp, type AppContext } from '../server/app.js';

const contexts: AppContext[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.app.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function setup(publicUrl?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-ops-resources-api-'));
  dirs.push(dataDir);
  const self = vi.fn(() => ({
    cpu: { user: 1000, system: 1000 },
    memory: { rss: 1000000, heapUsed: 40000, heapTotal: 80000 },
  }));
  const disk = vi.fn(async () => { throw new Error('synthetic unavailable filesystem'); });
  const context = await createApp({
    dataDir, demo: true, autoSync: false, publicUrl, connectorProbe: async () => [],
    resourceOptions: { readSelf: self, readDisk: disk },
  });
  contexts.push(context);
  return { ...context, self, disk };
}

describe('resource snapshot API', () => {
  it('returns cached counters without scanning, executing, or changing stored history per request', async () => {
    const { app, store, self, disk, resources, runner } = await setup();
    await resources.sample();
    await resources.sampleDisk();
    const beforeSelf = self.mock.calls.length, beforeDisk = disk.mock.calls.length;
    const sessions = store.allSessions();
    const archiveRead = vi.spyOn(store, 'allSessions');
    for (let i = 0; i < 20; i++) {
      const response = await app.inject('/api/resources');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({
        sampleIntervalSeconds: 5, diskIntervalSeconds: 60, retentionSeconds: 900,
        current: { scopes: { server: { rssBytes: 1000000, processCount: 1 }, agents: { processCount: 0 } } },
      });
    }
    expect(self).toHaveBeenCalledTimes(beforeSelf);
    expect(disk).toHaveBeenCalledTimes(beforeDisk);
    expect(archiveRead).not.toHaveBeenCalled();
    expect(store.allSessions()).toEqual(sessions);
    expect(runner.resourceRoots).toEqual([]);
  });

  it('inherits proxy and local access guards and rejects user-supplied paths or PIDs', async () => {
    const { app } = await setup('https://workspace.example/proxy/4327/');
    const headers = { host: 'workspace.example' };
    expect((await app.inject({ url: '/proxy/4327/api/resources', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/resources?path=/etc', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/resources?pid=1', headers })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/resources', headers: { host: 'attacker.example' } })).statusCode).toBe(403);
  });

  it('stops collection on app shutdown', async () => {
    const { app, resources, self } = await setup();
    await resources.sample();
    await app.close();
    const count = self.mock.calls.length;
    await resources.sample();
    expect(self).toHaveBeenCalledTimes(count);
  });
});
