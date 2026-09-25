import { expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';

it('serves health while the synchronization process waits on a database writer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-ops-sync-api-'));
  const sourceDir = join(dir, 'native');
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, 'one.jsonl'), [
    { type: 'session_meta', payload: { id: 'background-fixture', cwd: sourceDir, timestamp: '2026-09-25T00:00:00Z' } },
    { type: 'response_item', timestamp: '2026-09-25T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Inspect this synthetic project.' }] } },
  ].map(value => JSON.stringify(value)).join('\n'));
  const { app, store, sync } = await createApp({
    dataDir: join(dir, 'state'), autoSync: false, connectorProbe: async () => [],
  });
  store.saveSettings({ sourceRoots: { codex: [sourceDir], claude: [], kiro: [] } });
  store.db.pragma('busy_timeout = 400');
  const writer = new Database(join(dir, 'state/agent-ops.sqlite'));
  writer.exec('BEGIN IMMEDIATE');
  let work: Promise<unknown> | undefined;
  try {
    const start = performance.now();
    const accepted = await app.inject({ method: 'POST', url: '/api/sync/start', headers: { 'x-agent-ops': '1' }, payload: {} });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toEqual({ syncing: true });
    work = sync.run().catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 60));
    const response = await app.inject('/api/health');
    expect(response.statusCode).toBe(200);
    expect(performance.now() - start).toBeLessThan(500);
    expect(sync.active).toBe(true);
    writer.exec('ROLLBACK');
    const result = await work;
    expect(result).toMatchObject({ imported: 1 });
    expect(store.listSessions().total).toBe(1);
  } finally {
    if (writer.inTransaction) writer.exec('ROLLBACK');
    writer.close();
    sync.cancel();
    await work;
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps synchronization start behind the existing mutation and input guards', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-ops-sync-start-'));
  const { app } = await createApp({ dataDir: dir, demo: true, autoSync: false });
  try {
    expect((await app.inject({ method: 'POST', url: '/api/sync/start', payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/sync/start', headers: { 'x-agent-ops': '1' }, payload: { extra: true } })).statusCode).toBe(400);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it('keeps health responsive and saves pending settings after a background writer releases SQLite', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-ops-mutation-contention-'));
  const { app, store } = await createApp({ dataDir: dir, demo: true, autoSync: false });
  store.db.pragma('busy_timeout = 200');
  const writer = new Database(store.filename);
  writer.exec('BEGIN IMMEDIATE');
  let settled = false;
  const patch = app.inject({ method: 'PATCH', url: '/api/settings', headers: { 'x-agent-ops': '1' }, payload: { concurrency: 3 } })
    .then(response => { settled = true; return response; });
  try {
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(settled).toBe(false);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
    writer.exec('ROLLBACK');
    expect((await patch).statusCode).toBe(200);
    expect(store.getSettings().concurrency).toBe(3);
    expect(store.db.pragma('busy_timeout', { simple: true })).toBe(200);
  } finally {
    if (writer.inTransaction) writer.exec('ROLLBACK');
    await patch;
    writer.close();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
