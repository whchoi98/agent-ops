import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { chmod, lstat, mkdtemp, readFile, readdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImportedSession } from '../shared/types.js';
import { discoverSessions, type KiroRowCache, type KiroRowCheckpoint } from '../server/providers/index.js';
import { readKiroDatabase } from '../server/providers/kiro-sqlite.js';
import type { Source } from '../server/providers/files.js';

const directories: string[] = [];
const databases: Database.Database[] = [];
const firstTime = '2026-09-01T10:00:00.000Z';
const secondTime = '2026-09-01T10:01:00.000Z';
const earlierTime = '2026-09-01T09:59:00.000Z';
const laterTime = '2026-09-01T10:02:00.000Z';

afterEach(async () => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) if (database.open) database.close();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

function body(id: string, prompt = `Synthetic request for ${id}`) {
  return JSON.stringify({
    conversation_id: id,
    messages: [
      { id: 'user', role: 'user', content: prompt },
      { id: 'assistant', role: 'assistant', content: 'Synthetic answer' },
    ],
  });
}

function rowCache() {
  const checkpoints = new Map<string, KiroRowCheckpoint>();
  const cache: KiroRowCache = {
    get: key => checkpoints.get(key) ?? null,
    set: (key, checkpoint) => { checkpoints.set(key, { ...checkpoint }); },
  };
  return { checkpoints, cache };
}

async function fixture(wal = false) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-ops-kiro-incremental-'));
  directories.push(directory);
  const path = join(directory, 'data.sqlite3');
  const database = new Database(path);
  databases.push(database);
  if (wal) {
    database.pragma('journal_mode = WAL');
    database.pragma('wal_autocheckpoint = 0');
  }
  database.exec(`
    CREATE TABLE conversations_v2 (
      key TEXT NOT NULL, conversation_id TEXT PRIMARY KEY, value BLOB NOT NULL,
      created_at, updated_at
    );
    CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT);
  `);
  const insert = database.prepare('INSERT INTO conversations_v2 VALUES (?, ?, ?, ?, ?)');
  function put(id: string, value: string | Buffer = body(id), key = '/work/kiro-incremental') {
    insert.run(key, id, value, Date.parse(firstTime), Date.parse(secondTime));
  }
  async function source(): Promise<Source> {
    return { agent: 'kiro', kind: 'sqlite', path, stat: await lstat(path) };
  }
  return { directory, path, database, put, source };
}

async function read(
  input: Awaited<ReturnType<typeof fixture>>,
  cache?: KiroRowCache,
  consume?: (session: ImportedSession) => void | Promise<void>,
) {
  const sessions: ImportedSession[] = [];
  const warnings: string[] = [];
  const ok = await readKiroDatabase(await input.source(), async session => {
    await consume?.(session);
    sessions.push(session);
  }, warning => warnings.push(warning), cache);
  return { ok, sessions, warnings };
}

describe('incremental Kiro SQLite rows', () => {
  it('emits nothing when only unrelated database data and mtime change', async () => {
    const f = await fixture();
    f.put('one');
    f.put('two');
    const { cache, checkpoints } = rowCache();
    expect((await read(f, cache)).sessions.map(session => session.id)).toEqual(['kiro:one', 'kiro:two']);
    const initial = [...checkpoints.entries()];
    const before = await lstat(f.path);
    f.database.prepare('INSERT INTO app_metadata VALUES (?, ?)').run('window-layout', 'wide');
    await utimes(f.path, before.atime, new Date(before.mtimeMs + 5_000));
    expect((await lstat(f.path)).mtimeMs).not.toBe(before.mtimeMs);

    expect(await read(f, cache)).toMatchObject({ ok: true, sessions: [], warnings: [] });
    expect([...checkpoints.entries()]).toEqual(initial);
    expect(checkpoints.size).toBe(2);
  });

  it('skips JSON parsing on an identical cached row', async () => {
    const f = await fixture();
    const raw = body('unchanged');
    f.put('unchanged', raw);
    const { cache } = rowCache();
    await read(f, cache);
    const parse = vi.spyOn(JSON, 'parse');

    const result = await read(f, cache);
    expect(parse.mock.calls.filter(([input]) => input === raw).length).toBe(0);
    expect(result).toMatchObject({ ok: true, sessions: [], warnings: [] });
  });

  it.each([
    { label: 'many small rows', count: 512, paddingBytes: 0 },
    { label: 'a few large rows', count: 6, paddingBytes: 9 * 1024 * 1024 },
  ])('yields during cache-only hashing of $label so pending cancellation can run', async ({ count, paddingBytes }) => {
    const f = await fixture();
    const raw = JSON.stringify({
      messages: [{ id: 'prompt', role: 'user', content: 'Synthetic yield fixture' }],
      padding: 'x'.repeat(paddingBytes),
    });
    f.database.transaction(() => {
      for (let index = 0; index < count; index++) f.put(`yield-${index}`, raw);
    })();
    const { cache, checkpoints } = rowCache();
    expect((await read(f, cache)).sessions).toHaveLength(count);

    const cancellation = new Error('Synthetic cancellation');
    cancellation.name = 'AbortError';
    let heartbeat: NodeJS.Immediate | undefined;
    let turns = 0;
    let cancelled = false;
    let lookups = 0;
    let writes = 0;
    let imports = 0;
    function pulse() {
      if (++turns === 2) cancelled = true;
      else heartbeat = setImmediate(pulse);
    }
    const cancellable: KiroRowCache = {
      get(key) {
        if (++lookups === 1) heartbeat = setImmediate(pulse);
        if (cancelled) throw cancellation;
        return cache.get(key);
      },
      set(key, checkpoint) {
        writes++;
        cache.set(key, checkpoint);
      },
    };
    try {
      await expect(read(f, cancellable, () => { imports++; })).rejects.toBe(cancellation);
    } finally {
      if (heartbeat) clearImmediate(heartbeat);
    }

    expect(turns).toBe(2);
    expect(lookups).toBeLessThan(count);
    expect(imports).toBe(0);
    expect(writes).toBe(0);
    expect(checkpoints.size).toBe(count);
    expect(await read(f, cache)).toMatchObject({ ok: true, sessions: [], warnings: [] });
  }, 15_000);

  it('reimports only an edited conversation and keeps its cache key independent of its body', async () => {
    const f = await fixture();
    f.put('one');
    f.put('two');
    const { cache, checkpoints } = rowCache();
    await read(f, cache);
    const before = new Map(checkpoints);
    f.database.prepare('UPDATE conversations_v2 SET value = ? WHERE conversation_id = ?')
      .run(body('two', 'Changed request'), 'two');

    const result = await read(f, cache);
    expect(result.sessions.map(session => session.id)).toEqual(['kiro:two']);
    expect(result.sessions[0].messages[0].content).toBe('Changed request');
    expect([...checkpoints.keys()].sort()).toEqual([...before.keys()].sort());
    expect(checkpoints.size).toBe(2);
    for (const [key, checkpoint] of checkpoints) {
      expect(key).toMatch(/^kiro-row:[a-f0-9]{64}$/);
      expect(checkpoint.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(key.includes(f.path) || key.includes('Changed request')).toBe(false);
      expect(checkpoint.fingerprint === before.get(key)?.fingerprint).toBe(checkpoint.sessionId === 'kiro:one');
    }
  });

  it('checkpoints successful callbacks only and retries failed rows without reimporting healthy rows', async () => {
    const f = await fixture();
    f.put('healthy');
    f.put('retry');
    const { cache, checkpoints } = rowCache();
    const failed = await read(f, cache, async session => {
      await Promise.resolve();
      if (session.id === 'kiro:retry') throw new Error('Synthetic import failure');
    });
    expect(failed.ok).toBe(false);
    expect(failed.sessions.map(session => session.id)).toEqual(['kiro:healthy']);
    expect([...checkpoints.values()].map(value => value.sessionId)).toEqual(['kiro:healthy']);
    expect(failed.warnings.some(warning => /callback failed/i.test(warning))).toBe(true);

    const retried = await read(f, cache);
    expect(retried.sessions.map(session => session.id)).toEqual(['kiro:retry']);
    expect(retried.ok).toBe(true);
    expect((await read(f, cache)).sessions).toEqual([]);
  });

  it('does not checkpoint while an asynchronous import callback is still pending', async () => {
    const f = await fixture();
    f.put('pending');
    const { cache, checkpoints } = rowCache();
    let entered!: () => void;
    let complete!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const release = new Promise<void>(resolve => { complete = resolve; });
    const running = read(f, cache, async () => {
      entered();
      await release;
    });
    await started;
    const beforeCompletion = checkpoints.size;
    complete();
    const result = await running;

    expect(beforeCompletion).toBe(0);
    expect(result.ok).toBe(true);
    expect([...checkpoints.values()].map(value => value.sessionId)).toEqual(['kiro:pending']);
  });

  it.each(['malformed JSON', 'unsupported history'])('leaves %s rows retryable while retaining healthy checkpoints', async failure => {
    const f = await fixture();
    f.put('healthy');
    f.put('repair', failure === 'malformed JSON' ? '{"history":' : '{"unrecognized":true}');
    const { cache, checkpoints } = rowCache();
    const initial = await read(f, cache);
    expect(initial.ok).toBe(false);
    expect([...checkpoints.values()].map(value => value.sessionId)).toEqual(['kiro:healthy']);
    const unchanged = await read(f, cache);
    expect(unchanged.sessions).toEqual([]);
    expect(unchanged.ok).toBe(false);
    expect(unchanged.warnings.length).toBeGreaterThan(0);
    f.database.prepare('UPDATE conversations_v2 SET value = ? WHERE conversation_id = ?')
      .run(body('repair'), 'repair');

    const repaired = await read(f, cache);
    expect(repaired.sessions.map(session => session.id)).toEqual(['kiro:repair']);
    expect(repaired.ok).toBe(true);
    expect(checkpoints.size).toBe(2);
  });

  it('keeps a cached V2 session authoritative over an uncached older V1 copy', async () => {
    const f = await fixture();
    f.put('shared', body('shared', 'V2 authoritative request'));
    f.database.exec('CREATE TABLE conversations (key TEXT PRIMARY KEY, value TEXT)');
    f.database.prepare('INSERT INTO conversations VALUES (?, ?)').run('/work/legacy', body('shared', 'Older V1 request'));
    const { cache, checkpoints } = rowCache();
    const first = await read(f, cache);
    expect(first.sessions).toHaveLength(1);
    expect(first.sessions[0].messages[0].content).toBe('V2 authoritative request');
    expect(checkpoints.size).toBe(1);

    expect(await read(f, cache)).toMatchObject({ ok: true, sessions: [], warnings: [] });
    expect(checkpoints.size).toBe(1);
  });

  it.each([
    ['created_at', earlierTime, 'startedAt'],
    ['updated_at', laterTime, 'updatedAt'],
  ] as const)('invalidates a row when only %s changes', async (column, timestamp, sessionField) => {
    const f = await fixture();
    f.put('timestamp');
    const { cache, checkpoints } = rowCache();
    await read(f, cache);
    const before = new Map(checkpoints);
    expect(before.size).toBe(1);
    const raw = f.database.prepare('SELECT value FROM conversations_v2').get();
    f.database.prepare(`UPDATE conversations_v2 SET "${column}" = ?`).run(Date.parse(timestamp));

    const result = await read(f, cache);
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0][sessionField]).toBe(timestamp);
    expect(f.database.prepare('SELECT value FROM conversations_v2').get()).toEqual(raw);
    expect([...checkpoints.keys()]).toEqual([...before.keys()]);
    expect([...checkpoints.values()][0].fingerprint).not.toBe([...before.values()][0].fingerprint);
    expect((await read(f, cache)).sessions).toEqual([]);
  });

  it('namespaces checkpoints by database path, table, workspace key and conversation ID', async () => {
    const first = await fixture();
    const second = await fixture();
    const raw = body('payload-id');
    first.put('one', raw);
    first.put('two', raw);
    second.put('one', raw);
    const { cache, checkpoints } = rowCache();
    expect((await read(first, cache)).sessions.map(session => session.id)).toEqual(['kiro:one', 'kiro:two']);
    expect((await read(second, cache)).sessions.map(session => session.id)).toEqual(['kiro:one']);
    expect(checkpoints.size).toBe(3);
    second.database.prepare('UPDATE conversations_v2 SET key = ?').run('/work/moved');
    expect((await read(second, cache)).sessions[0].projectPath).toBe('/work/moved');
    expect(checkpoints.size).toBe(4);
    second.database.exec('ALTER TABLE conversations_v2 RENAME TO conversations');

    expect((await read(second, cache)).sessions.map(session => session.id)).toEqual(['kiro:one']);
    expect(checkpoints.size).toBe(5);
    expect(new Set([...checkpoints.values()].map(value => value.fingerprint)).size).toBe(1);
  });

  it('hashes raw BLOB bytes without normalizing their JSON representation', async () => {
    const f = await fixture();
    const raw = body('blob');
    f.put('blob', Buffer.from(raw));
    const { cache, checkpoints } = rowCache();
    await read(f, cache);
    expect((await read(f, cache)).sessions).toEqual([]);
    const before = new Map(checkpoints);
    f.database.prepare('UPDATE conversations_v2 SET value = ?').run(Buffer.from(` \n${raw}\n`));

    expect((await read(f, cache)).sessions.map(session => session.id)).toEqual(['kiro:blob']);
    expect([...checkpoints.keys()]).toEqual([...before.keys()]);
    expect([...checkpoints.values()][0].fingerprint).not.toBe([...before.values()][0].fingerprint);
  });

  it('passes the optional row cache through discovery when an unrelated WAL write changes the source fingerprint', async () => {
    const f = await fixture(true);
    f.put('one');
    f.put('two');
    f.database.pragma('wal_checkpoint(TRUNCATE)');
    const { cache } = rowCache();
    const fingerprints = new Map<string, string>();
    const options = {
      kiroRows: cache,
      shouldRead: (path: string, fingerprint: string) => fingerprints.get(path) !== fingerprint,
      onRead: (path: string, fingerprint: string) => { fingerprints.set(path, fingerprint); },
    };
    async function scan() {
      const sessions: ImportedSession[] = [];
      const report = await discoverSessions({ codex: [], claude: [], kiro: [f.path] },
        session => { sessions.push(session); }, options);
      return { sessions, ...report };
    }
    expect((await scan()).sessions).toHaveLength(2);
    const before = fingerprints.get(f.path);
    const mainBefore = await lstat(f.path);
    f.database.prepare('INSERT INTO app_metadata VALUES (?, ?)').run('layout', 'updated');
    const mainAfter = await lstat(f.path);
    expect([mainAfter.size, mainAfter.mtimeMs]).toEqual([mainBefore.size, mainBefore.mtimeMs]);

    expect(await scan()).toMatchObject({ sessions: [], filesScanned: 1, skipped: 0, warnings: [] });
    expect(fingerprints.get(f.path)).not.toBe(before);
    expect(await scan()).toMatchObject({ sessions: [], filesScanned: 1, skipped: 1, warnings: [] });
    f.database.prepare('UPDATE conversations_v2 SET value = ? WHERE conversation_id = ?').run(body('two', 'Edited in WAL'), 'two');
    expect((await scan()).sessions.map(session => session.id)).toEqual(['kiro:two']);
  });

  it('preserves source bytes, timestamps, permissions and tables during cold and cached read-only imports', async () => {
    const f = await fixture();
    f.put('preserved');
    f.database.close();
    await chmod(f.path, 0o444);
    const bytes = await readFile(f.path);
    const before = await lstat(f.path);
    const files = await readdir(f.directory);
    const { cache } = rowCache();
    expect((await read(f, cache)).sessions).toHaveLength(1);
    expect((await read(f, cache)).sessions).toEqual([]);

    expect(await readFile(f.path)).toEqual(bytes);
    const after = await lstat(f.path);
    expect([after.size, after.mtimeMs, after.mode, after.ino]).toEqual([before.size, before.mtimeMs, before.mode, before.ino]);
    expect(await readdir(f.directory)).toEqual(files);
  });

  it('retains the previous import behavior when no row cache is supplied', async () => {
    const f = await fixture();
    f.put('uncached');
    expect((await read(f)).sessions.map(session => session.id)).toEqual(['kiro:uncached']);
    expect((await read(f)).sessions.map(session => session.id)).toEqual(['kiro:uncached']);
  });
});
