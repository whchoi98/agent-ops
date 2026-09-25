import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../server/store.js';
import { SyncService } from '../server/sync.js';
import Database from 'better-sqlite3';
import { setImmediate as nextTurn } from 'node:timers/promises';

it('stops an import without checkpointing unread sessions, so the next sync can resume', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-sync-'));
  const store = new Store(':memory:');
  let pending: Promise<unknown> | null = null;
  try {
    const source = join(dir, 'session.jsonl');
    writeFileSync(source, [
      { type: 'session_meta', payload: { id: 'cancel-fixture', cwd: dir, timestamp: '2026-09-24T10:00:00Z' } },
      { type: 'response_item', timestamp: '2026-09-24T10:00:01Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Review cancellation behavior' }] } },
    ].map((value) => JSON.stringify(value)).join('\n'));
    store.saveSettings({ sourceRoots: { codex: [source], claude: [], kiro: [] } });
    const sync = new SyncService(store);
    const first = sync.run();
    pending = first;
    sync.cancel();
    expect((await first).imported).toBe(0);
    expect(store.listSessions().total).toBe(0);
    expect((await new SyncService(store).run()).imported).toBe(1);
    expect(store.listSessions().items[0].nativeId).toBe('cancel-fixture');
  } finally {
    await pending?.catch(() => {});
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('lets socket and timer work run between committed SQLite conversation imports', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-sync-yield-'));
  const store = new Store(':memory:');
  try {
    const source = join(dir, 'data.sqlite3');
    const database = new Database(source);
    database.exec('CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT PRIMARY KEY, value TEXT)');
    const insert = database.prepare('INSERT INTO conversations_v2 VALUES (?,?,?)');
    for (let index = 0; index < 30; index++) insert.run('/fixture/project', `yield-${index}`, JSON.stringify({
      messages: [{ id: `message-${index}`, role: 'user', content: `Synthetic import ${index}`, timestamp: '2026-09-25T00:00:00Z' }],
    }));
    database.close();
    store.saveSettings({ sourceRoots: { codex: [], claude: [], kiro: [source] } });
    const original = store.upsertSession.bind(store);
    let imported = 0;
    let observedAtYield = -1;
    store.upsertSession = session => {
      original(session);
      imported++;
      if (imported === 1) void nextTurn().then(() => { observedAtYield = imported; });
    };
    const report = await new SyncService(store).run();
    await nextTurn();
    expect(report.imported).toBe(30);
    expect(observedAtYield).toBeGreaterThan(0);
    expect(observedAtYield).toBeLessThan(30);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('persists Kiro row checkpoints across restarts and only imports the changed conversation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-sync-rows-'));
  const filename = join(dir, 'cache.sqlite');
  const source = join(dir, 'data.sqlite3');
  let store = new Store(filename);
  const database = new Database(source);
  const payload = (id: string, content: string) => JSON.stringify({
    messages: [{ id, role: 'user', content, timestamp: '2026-09-25T00:00:00Z' }],
  });
  try {
    database.exec('CREATE TABLE conversations_v2 (key TEXT, conversation_id TEXT PRIMARY KEY, value TEXT); CREATE TABLE unrelated (value TEXT)');
    const insert = database.prepare('INSERT INTO conversations_v2 VALUES (?,?,?)');
    insert.run('/fixture/project', 'cached-one', payload('one', 'Original one'));
    insert.run('/fixture/project', 'cached-two', payload('two', 'Original two'));
    store.saveSettings({ sourceRoots: { codex: [], claude: [], kiro: [source] } });
    expect((await new SyncService(store).run()).imported).toBe(2);
    const kept = store.allSessions().find(session => session.nativeId === 'cached-two')!;
    store.patchSession(kept.id, { bookmarked: true, note: 'Keep this annotation' });
    store.close();
    store = new Store(filename);

    database.prepare('INSERT INTO unrelated VALUES (?)').run('metadata change');
    utimesSync(source, new Date(), new Date(Date.now() + 2000));
    expect((await new SyncService(store).run()).imported).toBe(0);
    expect(store.getSession(kept.id)).toMatchObject({ bookmarked: true, note: 'Keep this annotation' });

    database.prepare('UPDATE conversations_v2 SET value=? WHERE conversation_id=?')
      .run(payload('one', 'Changed conversation text'), 'cached-one');
    utimesSync(source, new Date(), new Date(Date.now() + 4000));
    expect((await new SyncService(store).run()).imported).toBe(1);
    expect(store.listSessions({ q: 'Changed conversation text' }).total).toBe(1);
    expect(store.listSessions({ q: 'Original one' }).total).toBe(0);
    expect(store.listSessions({ q: 'Original two' }).total).toBe(1);
  } finally {
    database.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
