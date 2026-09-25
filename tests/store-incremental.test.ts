import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.js';
import { emptyUsage, type ImportedSession } from '../shared/types.js';

const directories: string[] = [];
const stores: Store[] = [];

function database(filename?: string) {
  if (!filename) {
    const directory = mkdtempSync(join(tmpdir(), 'agent-ops-store-incremental-'));
    directories.push(directory);
    filename = join(directory, 'test.sqlite');
  }
  const store = new Store(filename);
  stores.push(store);
  return store;
}

function sample(id = 'claude:incremental'): ImportedSession {
  return {
    id, nativeId: id.split(':')[1], agent: 'claude', title: 'Native heading',
    projectPath: '/synthetic/project', projectName: 'sample-project', model: 'sample-model',
    startedAt: '2026-09-25T01:00:00.000Z', updatedAt: '2026-09-25T01:03:00.000Z',
    status: 'recorded', messageCount: 3, toolCallCount: 1, sourcePath: '/synthetic/history.jsonl',
    usage: emptyUsage(),
    messages: [
      { id: 'u1', role: 'user', content: '배포 원인 first-needle [x]?* at 100%', timestamp: '2026-09-25T01:00:00.000Z' },
      { id: 'a1', role: 'assistant', toolName: 'read_file', content: 'initial-answer-token', timestamp: '2026-09-25T01:01:00.000Z' },
      { id: 't1', role: 'tool', toolName: 'read_file', content: 'trailing-result-token', timestamp: '2026-09-25T01:02:00.000Z' },
    ],
  };
}

function totalChanges(store: Store): number {
  return (store.db.prepare('SELECT total_changes() AS count').get() as { count: number }).count;
}

function messageRows(store: Store, id: string) {
  return store.db.prepare('SELECT rowid,ordinal,data,tool_name FROM messages WHERE session_id=? ORDER BY ordinal')
    .all(id) as Array<{ rowid: number; ordinal: number; data: string; tool_name: string | null }>;
}

function searchIds(store: Store, q: string) {
  return store.listSessions({ q }).items.map(session => session.id);
}

function observeMessageWrites(store: Store) {
  store.db.exec(`
    CREATE TEMP TABLE message_writes(operation TEXT, session_id TEXT, ordinal INTEGER);
    CREATE TEMP TRIGGER observe_message_insert AFTER INSERT ON main.messages BEGIN
      INSERT INTO message_writes VALUES ('insert',NEW.session_id,NEW.ordinal);
    END;
    CREATE TEMP TRIGGER observe_message_update AFTER UPDATE ON main.messages BEGIN
      INSERT INTO message_writes VALUES ('update',NEW.session_id,NEW.ordinal);
    END;
    CREATE TEMP TRIGGER observe_message_delete AFTER DELETE ON main.messages BEGIN
      INSERT INTO message_writes VALUES ('delete',OLD.session_id,OLD.ordinal);
    END;
  `);
  return (id: string) => store.db.prepare(
    'SELECT operation,ordinal FROM message_writes WHERE session_id=? ORDER BY ordinal,operation',
  ).all(id);
}

function seedWithAnchor(store: Store) {
  const session = sample();
  store.upsertSession(session);
  // Higher rowids in another session prevent DELETE/INSERT from reusing this session's rowids.
  store.upsertSession({
    ...sample('claude:anchor'), title: 'Other conversation', messageCount: 1, toolCallCount: 0,
    messages: [{ id: 'anchor-message', role: 'user', content: 'anchor-only-token', timestamp: session.startedAt }],
  });
  return session;
}

afterEach(() => {
  stores.splice(0).forEach(store => store.close());
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

describe('lossless incremental session writes', () => {
  it('makes an identical import a zero-write operation after user annotations and reopening', () => {
    const store = database();
    const session = seedWithAnchor(store);
    store.patchSession(session.id, {
      title: 'Manual heading', tags: ['manual-tag-token'], note: 'manual-note-token', bookmarked: true,
    });
    const beforeRows = messageRows(store, session.id);
    const schema = store.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all();
    const before = totalChanges(store);
    store.upsertSession(structuredClone(session));
    expect(totalChanges(store)).toBe(before);
    expect(messageRows(store, session.id)).toEqual(beforeRows);
    expect(store.getSession(session.id)).toMatchObject({
      title: 'Manual heading', tags: ['manual-tag-token'], note: 'manual-note-token', bookmarked: true,
      usage: emptyUsage(), messages: session.messages,
    });
    expect(searchIds(store, 'manual-note-token')).toEqual([session.id]);
    expect(searchIds(store, 'Native heading')).toEqual([]);
    expect(store.db.prepare('SELECT type,name,sql FROM sqlite_schema ORDER BY type,name').all()).toEqual(schema);
    expect(store.db.pragma('user_version', { simple: true })).toBe(4);

    store.close();
    const reopened = database(store.filename);
    const reopenedChanges = totalChanges(reopened);
    reopened.upsertSession(structuredClone(session));
    expect(totalChanges(reopened)).toBe(reopenedChanges);
    expect(messageRows(reopened, session.id)).toEqual(beforeRows);
  });

  it('inserts only appended ordinals and preserves existing rowids and complete search text', () => {
    const store = database();
    const session = seedWithAnchor(store);
    const before = messageRows(store, session.id);
    const writes = observeMessageWrites(store);
    session.messages.push({
      id: 'a2', role: 'assistant', content: 'appended-needle 🙂한글', timestamp: '2026-09-25T01:04:00.000Z',
    });
    store.upsertSession(session);
    expect(writes(session.id)).toEqual([{ operation: 'insert', ordinal: 3 }]);
    expect(messageRows(store, session.id).slice(0, 3)).toEqual(before);
    expect(store.getSession(session.id)).toMatchObject({ messageCount: 4, messages: session.messages });
    for (const query of ['appended-needle', '한글', '원인', '[x]?*', '100%', 'trailing-result-token\n\nappended-needle']) {
      expect(searchIds(store, query)).toEqual([session.id]);
    }
    expect(searchIds(store, 'anchor-only-token')).toEqual(['claude:anchor']);
  });

  it('updates only an edited ordinal even when session timestamps and message count are unchanged', () => {
    const store = database();
    const session = seedWithAnchor(store);
    const before = messageRows(store, session.id);
    const writes = observeMessageWrites(store);
    session.messages[1] = { ...session.messages[1], id: 'a1-edited', toolName: 'grep', content: 'edited-answer-token' };
    store.upsertSession(session);
    const after = messageRows(store, session.id);
    expect(writes(session.id)).toEqual([{ operation: 'update', ordinal: 1 }]);
    expect(after.map(row => row.rowid)).toEqual(before.map(row => row.rowid));
    expect(after[0]).toEqual(before[0]);
    expect(after[2]).toEqual(before[2]);
    expect(store.getMessage(session.id, 'a1')).toBeNull();
    expect(store.getMessage(session.id, 'a1-edited')).toEqual(session.messages[1]);
    expect(store.toolCounts()).toEqual([{ name: 'grep', count: 1 }]);
    expect(searchIds(store, 'initial-answer-token')).toEqual([]);
    expect(searchIds(store, 'edited-answer-token')).toEqual([session.id]);
  });

  it('deletes only removed tails and preserves the surviving prefix', () => {
    const store = database();
    const session = seedWithAnchor(store);
    const before = messageRows(store, session.id);
    const writes = observeMessageWrites(store);
    session.messages = session.messages.slice(0, 1);
    store.upsertSession(session);
    expect(writes(session.id)).toEqual([
      { operation: 'delete', ordinal: 1 }, { operation: 'delete', ordinal: 2 },
    ]);
    expect(messageRows(store, session.id)).toEqual(before.slice(0, 1));
    expect(store.getSession(session.id)).toMatchObject({ messageCount: 1, messages: session.messages });
    expect(searchIds(store, 'trailing-result-token')).toEqual([]);
    expect(searchIds(store, 'first-needle')).toEqual([session.id]);
    expect(searchIds(store, 'anchor-only-token')).toEqual(['claude:anchor']);
    expect(store.getMessage(session.id, 't1')).toBeNull();
  });

  it('handles an empty transcript while retaining user metadata and its searchable fields', () => {
    const store = database();
    const session = seedWithAnchor(store);
    store.patchSession(session.id, {
      title: 'retained-heading-token', tags: ['retained-tag-token'], note: 'retained-note-token', bookmarked: true,
    });
    session.title = 'new-native-heading-token';
    session.messages = [];
    session.toolCallCount = 0;
    store.upsertSession(session);
    expect(store.getSession(session.id)).toMatchObject({
      title: 'retained-heading-token', tags: ['retained-tag-token'], note: 'retained-note-token',
      bookmarked: true, messageCount: 0, messages: [],
    });
    for (const query of ['retained-heading-token', 'retained-tag-token', 'retained-note-token']) {
      expect(searchIds(store, query)).toEqual([session.id]);
    }
    expect(searchIds(store, 'new-native-heading-token')).toEqual([]);
    expect(searchIds(store, 'first-needle')).toEqual([]);
    expect(messageRows(store, 'claude:anchor')).toHaveLength(1);
  });

  it.each(['usage', 'timestamp', 'status'] as const)('does not rewrite messages or FTS for a %s-only summary update', field => {
    const store = database();
    const session = sample();
    store.upsertSession(session);
    const rows = messageRows(store, session.id);
    const before = totalChanges(store);
    if (field === 'usage') session.usage = { ...emptyUsage(), inputTokens: 120, outputTokens: 0 };
    if (field === 'timestamp') session.updatedAt = '2026-09-25T02:00:00.000Z';
    if (field === 'status') session.status = 'completed';
    store.upsertSession(session);
    // One summary row changes; FTS shadow-table writes would increase this count.
    expect(totalChanges(store) - before).toBe(1);
    expect(messageRows(store, session.id)).toEqual(rows);
    expect(store.getSession(session.id)).toMatchObject({
      usage: session.usage, updatedAt: session.updatedAt, status: session.status,
    });
    expect(searchIds(store, 'initial-answer-token')).toEqual([session.id]);
  });

  it('updates message metadata and role indexes without rewriting an unchanged search body', () => {
    const store = database();
    const session = sample();
    store.upsertSession(session);
    const before = totalChanges(store);
    session.messages[1] = {
      ...session.messages[1], role: 'tool', timestamp: '2026-09-25T03:00:00.000Z', model: 'message-model', isError: true,
    };
    store.upsertSession(session);
    expect(totalChanges(store) - before).toBe(1);
    expect(store.getMessage(session.id, 'a1')).toEqual(session.messages[1]);
    expect(store.toolCounts()).toEqual([]);
    expect(store.listMessages(session.id).roleCounts).toEqual({ all: 3, user: 1, assistant: 0, tool: 2, system: 0 });
    expect(searchIds(store, 'initial-answer-token')).toEqual([session.id]);
  });

  it('compares the exact lowercased search body while preserving original message casing', () => {
    const store = database();
    const session = sample();
    store.upsertSession(session);
    const before = totalChanges(store);
    session.messages[1].content = 'INITIAL-ANSWER-TOKEN';
    store.upsertSession(session);
    expect(totalChanges(store) - before).toBe(1);
    expect(store.getMessage(session.id, 'a1')?.content).toBe('INITIAL-ANSWER-TOKEN');
    expect(searchIds(store, 'Initial-Answer-Token')).toEqual([session.id]);
  });

  it('compares persisted state after another connection changes annotations or messages', () => {
    const store = database();
    const session = sample();
    store.upsertSession(session);
    const other = database(store.filename);
    other.patchSession(session.id, { note: 'other-connection-note', title: 'Other connection title', bookmarked: true });
    const before = totalChanges(store);
    store.upsertSession(session);
    expect(totalChanges(store)).toBe(before);
    expect(store.getSession(session.id)).toMatchObject({
      note: 'other-connection-note', title: 'Other connection title', bookmarked: true,
    });
    const changed = structuredClone(session);
    changed.messages[0].content = 'other-connection-content';
    other.upsertSession(changed);
    store.upsertSession(session);
    expect(store.getSession(session.id)?.messages).toEqual(session.messages);
    expect(searchIds(store, 'other-connection-content')).toEqual([]);
    expect(searchIds(store, 'other-connection-note')).toEqual([session.id]);
  });

  it('rolls back summary, messages, and search together if a message write fails', () => {
    const store = database();
    const session = sample();
    store.upsertSession(session);
    const before = store.getSession(session.id);
    const rows = messageRows(store, session.id);
    store.db.exec(`
      CREATE TEMP TRIGGER reject_message_write BEFORE INSERT ON main.messages
      WHEN json_extract(NEW.data,'$.id')='rejected-message' BEGIN
        SELECT RAISE(ABORT, 'synthetic message failure');
      END;
    `);
    session.updatedAt = '2026-09-25T04:00:00.000Z';
    session.messages[1].content = 'uncommitted-search-token';
    session.messages.push({
      id: 'rejected-message', role: 'assistant', content: 'Rejected append.', timestamp: session.updatedAt,
    });
    expect(() => store.upsertSession(session)).toThrow('synthetic message failure');
    expect(store.getSession(session.id)).toEqual(before);
    expect(messageRows(store, session.id)).toEqual(rows);
    expect(searchIds(store, 'initial-answer-token')).toEqual([session.id]);
    expect(searchIds(store, 'uncommitted-search-token')).toEqual([]);
  });
});
