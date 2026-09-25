import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { utimesSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { SyncService } from '../server/sync.js';

const createdAt = '2026-09-01T00:00:00.000Z';
const olderAt = '2026-09-20T00:00:00.000Z';
const newerAt = '2026-09-25T00:00:00.000Z';
const newestAt = '2026-09-25T00:30:00.000Z';
const id = 'kiro:freshness-fixture';
const roots: string[] = [];
const stores: Store[] = [];
const databases: Database.Database[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) if (database.open) database.close();
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-sync-freshness-'));
  roots.push(root);
  const storePath = join(root, 'state.sqlite');
  let store = new Store(storePath);
  stores.push(store);
  store.saveSettings({ sourceRoots: { codex: [], claude: [], kiro: [] } });
  const sources: string[] = [];

  function source(name: string, updatedAt: string, texts: string[]) {
    const path = join(root, `${name}.sqlite3`);
    const database = new Database(path);
    databases.push(database);
    sources.push(path);
    database.exec(`
      CREATE TABLE conversations_v2 (
        key TEXT, conversation_id TEXT PRIMARY KEY, value TEXT,
        created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE unrelated_metadata (value TEXT);
    `);
    const value = (contents: string[]) => JSON.stringify({
      messages: contents.map((content, index) => ({
        id: `message-${index}`, role: index ? 'assistant' : 'user', content,
      })),
    });
    database.prepare('INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)')
      .run('/synthetic/project', 'freshness-fixture', value(texts), Date.parse(createdAt), Date.parse(updatedAt));
    let revision = 0;
    function changed() {
      // Keep scan invalidation independent of coarse filesystem timestamp ticks.
      const time = new Date(Date.now() + ++revision * 2_000);
      utimesSync(path, time, time);
    }
    return {
      path,
      change(timestamp: string, contents: string[]) {
        database.prepare('UPDATE conversations_v2 SET value=?,updated_at=?')
          .run(value(contents), Date.parse(timestamp));
        changed();
      },
      touch() {
        database.prepare('INSERT INTO unrelated_metadata VALUES (?)').run('Synthetic metadata update');
        changed();
      },
    };
  }

  function select(paths: string[]) {
    store.saveSettings({ sourceRoots: { codex: [], claude: [], kiro: paths } });
  }

  async function run() {
    const before = await Promise.all(sources.map(path => readFile(path)));
    const report = await new SyncService(store).run();
    const after = await Promise.all(sources.map(path => readFile(path)));
    expect(after.every((bytes, index) => bytes.equals(before[index]))).toBe(true);
    return report;
  }

  function rowCheckpoints() {
    return new Map((store.db.prepare("SELECT path,fingerprint FROM sources WHERE path LIKE 'kiro-row:%' ORDER BY path")
      .all() as Array<{ path: string; fingerprint: string }>).map(row => [row.path, row.fingerprint]));
  }

  return {
    get store() { return store; }, source, select, run, rowCheckpoints,
    reopen() {
      store.close();
      store = new Store(storePath);
      stores.push(store);
    },
    storedTimestamp(timestamp: string) {
      const saved = store.getSession(id)!;
      const { bookmarked: _bookmarked, tags: _tags, note: _note, ...session } = saved;
      store.upsertSession({ ...session, updatedAt: timestamp });
    },
  };
}

describe('persisted cross-source synchronization freshness', () => {
  it.each(['newer first', 'older first'] as const)(
    'preserves a cached newer Kiro session when an older source changes, with %s',
    async order => {
      const f = await fixture();
      const newer = f.source('newer', newerAt, ['Newer request', 'Newer response']);
      const older = f.source('older', olderAt, ['Older request']);
      f.select(order === 'newer first' ? [newer.path, older.path] : [older.path, newer.path]);
      await f.run();
      expect(f.store.getSession(id)?.sourcePath).toBe(newer.path);
      f.store.patchSession(id, { bookmarked: true, tags: ['keep'], note: 'Keep my annotation', title: 'My title' });
      const kept = f.store.getSession(id)!;
      const checkpoints = f.rowCheckpoints();
      f.reopen();
      newer.touch();
      older.change(olderAt, ['Changed older request']);
      const prepare = vi.spyOn(f.store.db, 'prepare');

      const report = await f.run();
      expect(report).toMatchObject({ imported: 0, filesScanned: 2, skipped: 0, warnings: [] });
      expect(prepare.mock.calls.filter(([sql]) => /\bFROM\s+messages\b/i.test(sql)).length).toBe(0);
      prepare.mockRestore();
      expect(f.store.getSession(id)).toEqual(kept);
      const refreshed = f.rowCheckpoints();
      expect(refreshed.size).toBe(2);
      expect([...refreshed].filter(([key, value]) => value !== checkpoints.get(key))).toHaveLength(1);
      expect(f.store.getFingerprint(older.path)?.startsWith('format-v3:')).toBe(true);
      expect([...refreshed.values()].every(value => JSON.parse(value).format === 'format-v3')).toBe(true);
      older.touch();
      expect(await f.run()).toMatchObject({ imported: 0, warnings: [] });
      expect(f.store.getSession(id)).toEqual(kept);
    },
  );

  it.each([
    { label: 'older despite more messages', updatedAt: olderAt, texts: ['Old request', 'Old reply', 'Extra old reply'], accepted: false },
    { label: 'equal timestamp with fewer messages', updatedAt: newerAt, texts: ['Shorter copy'], accepted: false },
    { label: 'equal timestamp and equal message count', updatedAt: newerAt, texts: ['Replacement request', 'Replacement reply'], accepted: true },
    { label: 'equal timestamp with more messages', updatedAt: newerAt, texts: ['Longer request', 'Longer reply', 'New reply'], accepted: true },
    { label: 'newer timestamp with fewer messages', updatedAt: newestAt, texts: ['Latest source correction'], accepted: true },
  ])('handles a different source that has $label', async ({ updatedAt, texts, accepted }) => {
    const f = await fixture();
    const original = f.source('original', newerAt, ['Original request', 'Original response']);
    f.select([original.path]);
    expect((await f.run()).imported).toBe(1);
    const kept = f.store.getSession(id)!;
    const incoming = f.source('incoming', updatedAt, texts);
    f.select([incoming.path, original.path]);

    const report = await f.run();
    expect(report.imported).toBe(accepted ? 1 : 0);
    expect(report.warnings).toEqual([]);
    const saved = f.store.getSession(id)!;
    if (accepted) {
      expect(saved.sourcePath).toBe(incoming.path);
      expect(saved.updatedAt).toBe(updatedAt);
      expect(saved.messages.map(message => message.content)).toEqual(texts);
    } else {
      expect(saved).toEqual(kept);
    }
    expect((await f.run()).imported).toBe(0);
  });

  it.each([
    { label: 'offset timestamp', timestamp: '2026-09-25T09:00:00+09:00' },
    { label: 'unknown legacy timestamp', timestamp: 'unknown-time' },
  ])('compares normalized instants instead of the stored $label text', async ({ timestamp }) => {
    const f = await fixture();
    const original = f.source('original', newerAt, ['Original request', 'Original response']);
    f.select([original.path]);
    await f.run();
    f.storedTimestamp(timestamp);
    const incoming = f.source('incoming', newestAt, ['Latest request']);
    f.select([incoming.path]);

    expect((await f.run()).imported).toBe(1);
    expect(f.store.getSession(id)).toMatchObject({ sourcePath: incoming.path, updatedAt: newestAt, messageCount: 1 });
  });

  it('treats equivalent timezone representations as a message-count tie', async () => {
    const f = await fixture();
    const original = f.source('original', newerAt, ['Original request', 'Original response']);
    f.select([original.path]);
    await f.run();
    f.storedTimestamp('2026-09-25T09:00:00+09:00');
    const incoming = f.source('incoming', newerAt, ['Shorter copy']);
    f.select([incoming.path]);

    expect((await f.run()).imported).toBe(0);
    expect(f.store.getSession(id)).toMatchObject({ sourcePath: original.path, messageCount: 2 });
  });

  it.each([
    { label: 'timestamp rollback and shorter corpus', updatedAt: olderAt, texts: ['Corrected corpus'] },
    { label: 'body-only correction', updatedAt: newerAt, texts: ['Corrected request', 'Corrected reply'] },
  ])('accepts a same-source $label and preserves annotations', async ({ updatedAt, texts }) => {
    const f = await fixture();
    const source = f.source('same-source', newerAt, ['Original request', 'Original response']);
    f.select([source.path]);
    await f.run();
    f.store.patchSession(id, { bookmarked: true, note: 'Keep this note', tags: ['keep'] });
    source.change(updatedAt, texts);

    expect((await f.run()).imported).toBe(1);
    const saved = f.store.getSession(id)!;
    expect(saved).toMatchObject({
      sourcePath: source.path, updatedAt, bookmarked: true, note: 'Keep this note', tags: ['keep'],
    });
    expect(saved.messages.map(message => message.content)).toEqual(texts);
    expect((await f.run()).imported).toBe(0);
  });

  it('does not let an ignored competing source suppress a later same-source timestamp repair', async () => {
    const f = await fixture();
    const owner = f.source('owner', newerAt, ['Original owner corpus']);
    const duplicate = f.source('duplicate', olderAt, ['Older duplicate corpus']);
    f.select([owner.path]);
    await f.run();
    f.select([duplicate.path, owner.path]);
    const correctedAt = '2026-09-15T00:00:00.000Z';
    owner.change(correctedAt, ['Corrected owner corpus']);

    expect((await f.run()).imported).toBe(1);
    const saved = f.store.getSession(id)!;
    expect(saved).toMatchObject({ sourcePath: owner.path, updatedAt: correctedAt });
    expect(saved.messages.map(message => message.content)).toEqual(['Corrected owner corpus']);
    expect((await f.run()).imported).toBe(0);
  });

  it('reparses an unchanged same-source file when upgrading old checkpoints to format-v3', async () => {
    const f = await fixture();
    const source = f.source('same-source', olderAt, ['Native request']);
    f.select([source.path]);
    await f.run();
    f.storedTimestamp(newerAt);
    f.store.setFingerprint(source.path, f.store.getFingerprint(source.path)!.replace(/^format-v3:/, 'format-v2:'));
    for (const [key, value] of f.rowCheckpoints()) {
      f.store.setFingerprint(key, JSON.stringify({ ...JSON.parse(value), format: 'format-v2' }));
    }
    f.reopen();

    expect((await f.run()).imported).toBe(1);
    expect(f.store.getSession(id)).toMatchObject({ sourcePath: source.path, updatedAt: olderAt, messageCount: 1 });
    expect(f.store.getFingerprint(source.path)?.startsWith('format-v3:')).toBe(true);
    expect([...f.rowCheckpoints().values()].every(value => JSON.parse(value).format === 'format-v3')).toBe(true);
    expect((await f.run()).imported).toBe(0);
  });
});
