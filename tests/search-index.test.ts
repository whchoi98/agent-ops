import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  createSearchIndex, deleteSearchDocument, migrateCompressedSearch, registerSearchFunctions, replaceSearchDocument,
} from '../server/search-index.js';

const databases: Database.Database[] = [];
const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'agent-ops-search-index-'));
  directories.push(directory);
  const path = join(directory, 'search.sqlite');
  const db = new Database(path);
  databases.push(db);
  return { db, path };
}
afterEach(() => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function replace(db: Database.Database, rowid: number, sessionId: string, body: string) {
  return db.transaction(() => replaceSearchDocument(db, rowid, sessionId, body))();
}
function matches(db: Database.Database, pattern: string): number[] {
  return (db.prepare('SELECT rowid FROM session_search WHERE body GLOB ? ORDER BY rowid').all(pattern) as { rowid: number }[])
    .map(row => row.rowid);
}
function documents(db: Database.Database) {
  return db.prepare('SELECT rowid, session_id, body FROM session_search ORDER BY rowid').all();
}

describe.each([false, true])('search document storage (compressed=%s)', compressed => {
  it('preserves literal GLOB results and exact caller-lowercased Unicode text', () => {
    const { db } = fixture();
    registerSearchFunctions(db);
    createSearchIndex(db, compressed);
    const rows = [
      { rowid: 3, session_id: 'punctuation', body: 'keep foo_bar "or" 🙂한글수정 at 100% and literal [x]?* slash\\ final' },
      { rowid: 19, session_id: 'lookalike', body: 'fooXbar plain x ordinary words' },
      { rowid: 42, session_id: 'unicode', body: 'i\u0307stanbul straße σος café cafe\u0301' },
      { rowid: 81, session_id: 'boundaries', body: '\uFEFFleading bom\nline\tbreak\r\n🙂끝' },
    ];
    for (const row of rows) expect(replace(db, row.rowid, row.session_id, row.body)).toBe(true);
    expect(documents(db)).toEqual(rows);
    for (const [pattern, expected] of [
      ['*foo_bar*', [3]], ['*"or"*', [3]], ['*한글*', [3]], ['*100%*', [3]],
      ['*[[]x][?][*]*', [3]], ['*slash\\*', [3]], ['*i\u0307stanbul*', [42]], ['*istanbul*', []],
      ['*straße*', [42]], ['*strasse*', []], ['*σος*', [42]], ['*σοσ*', []],
      ['*cafe\u0301*', [42]], ['*\uFEFFleading*', [81]], ['*🙂끝*', [81]], ['*not present*', []],
    ] as const) expect(matches(db, pattern)).toEqual(expected);
  });

  it('skips identical documents without writing and respects the layout identity', () => {
    const { db } = fixture();
    createSearchIndex(db, compressed);
    expect(replace(db, 12, 'first-id', 'exactly the same body')).toBe(true);
    const before = db.prepare('SELECT total_changes() AS value').get();
    expect(replace(db, 12, 'first-id', 'exactly the same body')).toBe(false);
    expect(db.prepare('SELECT total_changes() AS value').get()).toEqual(before);
    expect(replace(db, 12, 'second-id', 'exactly the same body')).toBe(true);
    expect(documents(db)).toEqual(compressed ? [
      { rowid: 12, session_id: 'first-id', body: 'exactly the same body' },
      { rowid: 13, session_id: 'second-id', body: 'exactly the same body' },
    ] : [{ rowid: 12, session_id: 'second-id', body: 'exactly the same body' }]);
  });

  it('removes old postings before replacement and supports an empty body', () => {
    const { db } = fixture();
    createSearchIndex(db, compressed);
    replace(db, 7, 'changing', 'obsolete search term');
    replace(db, 7, 'changing', 'replacement search term');
    expect(matches(db, '*obsolete*')).toEqual([]);
    expect(matches(db, '*replacement*')).toEqual([7]);
    replace(db, 7, 'changing', '');
    expect(matches(db, '*replacement*')).toEqual([]);
    expect(documents(db)).toEqual([{ rowid: 7, session_id: 'changing', body: '' }]);
    expect(replace(db, 7, 'changing', '')).toBe(false);
  });

  it('participates in caller rollback and rejects replacement outside a transaction', () => {
    const { db } = fixture();
    createSearchIndex(db, compressed);
    replace(db, 1, 'rollback', 'original document');
    expect(() => db.transaction(() => {
      replaceSearchDocument(db, 1, 'rollback', 'discard this replacement');
      throw new Error('fixture rollback');
    })()).toThrow('fixture rollback');
    expect(matches(db, '*original*')).toEqual([1]);
    expect(matches(db, '*discard*')).toEqual([]);
    expect(() => replaceSearchDocument(db, 1, 'rollback', 'outside transaction')).toThrow(/transaction/i);
    expect(documents(db)).toEqual([{ rowid: 1, session_id: 'rollback', body: 'original document' }]);
  });

  it('detects the existing layout after reopening instead of trusting a creation flag', () => {
    const { db, path } = fixture();
    createSearchIndex(db, compressed);
    replace(db, 55, 'persisted', 'old persistent body');
    db.close();
    const reopened = new Database(path);
    databases.push(reopened);
    registerSearchFunctions(reopened);
    createSearchIndex(reopened, !compressed);
    expect(replace(reopened, 55, 'persisted', 'new persistent body')).toBe(true);
    expect(matches(reopened, '*old persistent*')).toEqual([]);
    expect(matches(reopened, '*new persistent*')).toEqual([55]);
  });

  it('deletes a document and its postings without affecting another row', () => {
    const { db } = fixture();
    createSearchIndex(db, compressed);
    replace(db, 2, 'deleted', 'remove this needle');
    replace(db, 8, 'preserved', 'preserve this needle');
    expect(db.transaction(() => deleteSearchDocument(db, 'deleted'))()).toBe(true);
    expect(db.transaction(() => deleteSearchDocument(db, 'deleted'))()).toBe(false);
    expect(matches(db, '*remove*')).toEqual([]);
    expect(matches(db, '*needle*')).toEqual([8]);
    expect(documents(db)).toEqual([{ rowid: 8, session_id: 'preserved', body: 'preserve this needle' }]);
  });
});

it('stores compressed source without a second uncompressed FTS content table', () => {
  const { db } = fixture();
  createSearchIndex(db, true);
  const body = '반복되는 한국어 검색 지침과 literal [x]?* / path.\n'.repeat(4000);
  replace(db, 90, 'compact', body);
  expect(documents(db)).toEqual([{ rowid: 90, session_id: 'compact', body }]);
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_search_source' AND type = 'view'").get()).toBeDefined();
  expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_search_content' AND type = 'table'").get()).toBeUndefined();
  const stored = db.prepare('SELECT body_bytes, length(body_deflated) AS compressed FROM session_search_documents').get() as {
    body_bytes: number; compressed: number;
  };
  expect(stored.body_bytes).toBe(Buffer.byteLength(body));
  expect(stored.compressed).toBeLessThan(stored.body_bytes / 10);
});

describe('compressed document integrity', () => {
  it.each(['invalid-deflate', 'wrong-length', 'wrong-digest', 'changed-text', 'trailing-data'])(
    'rejects %s without returning a corrupted search body', kind => {
      const { db } = fixture();
      createSearchIndex(db, true);
      replace(db, 1, 'corruptible', 'original body');
      const row = db.prepare('SELECT * FROM session_search_documents WHERE rowid=1').get() as {
        body_deflated: Buffer; body_bytes: number; body_sha256: Buffer;
      };
      if (kind === 'invalid-deflate') row.body_deflated = Buffer.from([0xff, 0xff]);
      if (kind === 'wrong-length') row.body_bytes++;
      if (kind === 'wrong-digest') row.body_sha256 = Buffer.alloc(32);
      if (kind === 'changed-text') row.body_deflated = deflateRawSync(Buffer.from('differentbody'));
      if (kind === 'trailing-data') row.body_deflated = Buffer.concat([row.body_deflated, Buffer.from('extra')]);
      db.prepare('UPDATE session_search_documents SET body_deflated=?, body_bytes=?, body_sha256=? WHERE rowid=1')
        .run(row.body_deflated, row.body_bytes, row.body_sha256);
      expect(() => db.prepare('SELECT body FROM session_search WHERE rowid=1').get()).toThrow(/compressed search/i);
      expect(() => replace(db, 1, 'corruptible', 'replacement')).toThrow(/compressed search/i);
    },
  );

  it('bounds declared decompression length before inflating and rejects invalid UTF-8', () => {
    const { db } = fixture();
    registerSearchFunctions(db);
    const raw = Buffer.from('fixture');
    const packed = deflateRawSync(raw);
    const digest = createHash('sha256').update(raw).digest();
    const inflate = db.prepare('SELECT agent_ops_search_inflate(?, ?, ?) AS body');
    for (const length of [-1, 0.5, 2 ** 31, '7', null]) {
      expect(() => inflate.get(packed, length, digest)).toThrow(/compressed search/i);
    }
    const invalid = Buffer.from([0xff]);
    expect(() => inflate.get(deflateRawSync(invalid), 1, createHash('sha256').update(invalid).digest()))
      .toThrow(/compressed search/i);
    expect(() => inflate.get(deflateRawSync(Buffer.alloc(1024 * 1024)), 1, digest)).toThrow(/compressed search/i);
  });
});

function legacyFixture() {
  const result = fixture();
  result.db.exec(`
    CREATE VIRTUAL TABLE session_search
      USING fts5(session_id UNINDEXED, body, tokenize='trigram', detail=none);
    CREATE TABLE unrelated (id INTEGER PRIMARY KEY, payload BLOB, note TEXT);
    INSERT INTO unrelated VALUES (31, X'001122FF', 'preserve exactly');
    PRAGMA user_version=3;
    PRAGMA application_id=1095716947;
  `);
  const rows = [
    { rowid: -7n, session_id: 'unicode', body: '\uFEFFi\u0307stanbul straße σος 한글 🙂 cafe\u0301' },
    { rowid: 0n, session_id: 'empty', body: '' },
    { rowid: 43n, session_id: 'literal', body: 'literal [x]?* 100% foo_bar "or" slash\\ keep\n'.repeat(3000) },
    { rowid: 9007199254740993n, session_id: 'wide-rowid', body: 'large exact row identity' },
  ];
  const insert = result.db.prepare('INSERT INTO session_search(rowid,session_id,body) VALUES (?,?,?)');
  result.db.transaction(() => { for (const row of rows) insert.run(row.rowid, row.session_id, row.body); })();
  return { ...result, rows };
}
function schema(db: Database.Database) {
  return db.prepare('SELECT name,type,sql FROM sqlite_schema ORDER BY name').all();
}
function exactDocuments(db: Database.Database) {
  return db.prepare('SELECT rowid,session_id,body FROM session_search ORDER BY rowid').safeIntegers(true).all();
}

describe('compressed search migration', () => {
  it('preserves every body, 64-bit rowid, literal match, unrelated table and database version', () => {
    const { db, rows } = legacyFixture();
    const before = exactDocuments(db);
    const unrelated = db.prepare('SELECT * FROM unrelated').all();
    const patterns = ['*한글*', '*[[]x][?][*]*', '*foo_bar*', '*100%*', '*"or"*', '*i\u0307stanbul*', '*istanbul*', '*σοσ*', '*identity*'];
    const expected = patterns.map(pattern => db.prepare('SELECT rowid FROM session_search WHERE body GLOB ? ORDER BY rowid')
      .safeIntegers(true).all(pattern));
    const progress: number[] = [];
    const report = migrateCompressedSearch(db, count => {
      progress.push(count);
      // The old virtual table remains queryable until its complete cursor is consumed.
      expect(exactDocuments(db)).toEqual(before);
    });
    expect(progress).toEqual([1, 2, 3, 4]);
    expect(exactDocuments(db)).toEqual(before);
    expect(exactDocuments(db)).toEqual(rows);
    patterns.forEach((pattern, index) => {
      expect(db.prepare('SELECT rowid FROM session_search WHERE body GLOB ? ORDER BY rowid').safeIntegers(true).all(pattern))
        .toEqual(expected[index]);
    });
    expect(db.prepare('SELECT * FROM unrelated').all()).toEqual(unrelated);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.pragma('application_id', { simple: true })).toBe(1095716947);
    expect(report.documents).toBe(4);
    expect(report.originalBytes).toBe(rows.reduce((bytes, row) => bytes + Buffer.byteLength(row.body), 0));
    expect(report.compressedBytes).toBeLessThan(report.originalBytes / 20);
    const payload = db.prepare('SELECT SUM(length(body_deflated)) AS bytes FROM session_search_documents').get() as { bytes: number };
    expect(report.compressedBytes).toBe(payload.bytes);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'session_search_replacement%'").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='session_search_content'").get()).toBeUndefined();
    db.prepare("INSERT INTO session_search(session_search, rank) VALUES('integrity-check', 1)").run();
  });

  it('rolls back all schema and data changes when progress reports cancellation', () => {
    const { db } = legacyFixture();
    const beforeSchema = schema(db);
    const before = exactDocuments(db);
    expect(() => migrateCompressedSearch(db, count => {
      if (count === 2) throw new Error('fixture cancellation');
    })).toThrow('fixture cancellation');
    expect(db.inTransaction).toBe(false);
    expect(schema(db)).toEqual(beforeSchema);
    expect(exactDocuments(db)).toEqual(before);
    expect(migrateCompressedSearch(db).documents).toBe(4);
  });

  it('is an idempotent no-write operation on an already compressed index', () => {
    const { db } = legacyFixture();
    const first = migrateCompressedSearch(db);
    const beforeSchema = schema(db);
    const changes = db.prepare('SELECT total_changes() AS value').get();
    expect(migrateCompressedSearch(db, () => { throw new Error('must not recopy'); })).toEqual(first);
    expect(db.prepare('SELECT total_changes() AS value').get()).toEqual(changes);
    expect(schema(db)).toEqual(beforeSchema);
  });

  it('creates an empty compressed index without changing other tables or user_version', () => {
    const { db } = fixture();
    db.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES('keep'); PRAGMA user_version=3;");
    expect(migrateCompressedSearch(db)).toEqual({ documents: 0, originalBytes: 0, compressedBytes: 0 });
    expect(replace(db, 1, 'new', 'newly searchable')).toBe(true);
    expect(matches(db, '*searchable*')).toEqual([1]);
    expect(db.prepare('SELECT * FROM unrelated').all()).toEqual([{ value: 'keep' }]);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });

  it('does not overwrite a reserved helper name that already belongs to another table', () => {
    const { db } = legacyFixture();
    db.exec("CREATE TABLE session_search_documents(value TEXT); INSERT INTO session_search_documents VALUES('unrelated owner');");
    const beforeSchema = schema(db);
    const before = exactDocuments(db);
    expect(() => migrateCompressedSearch(db)).toThrow();
    expect(schema(db)).toEqual(beforeSchema);
    expect(exactDocuments(db)).toEqual(before);
    expect(db.prepare('SELECT * FROM session_search_documents').all()).toEqual([{ value: 'unrelated owner' }]);
  });

  it('rolls back earlier rows when a legacy document is not text', () => {
    const { db } = legacyFixture();
    db.prepare('INSERT INTO session_search(rowid,session_id,body) VALUES(?,?,?)').run(100, 'invalid', null);
    const before = exactDocuments(db);
    const beforeSchema = schema(db);
    expect(() => migrateCompressedSearch(db)).toThrow(/search document/i);
    expect(exactDocuments(db)).toEqual(before);
    expect(schema(db)).toEqual(beforeSchema);
  });

  it('rejects invalid legacy UTF-8 instead of silently replacing its bytes during migration', () => {
    const { db } = legacyFixture();
    db.exec("INSERT INTO session_search(rowid,session_id,body) VALUES(100,'invalid-utf8',CAST(X'FF' AS TEXT));");
    const beforeSchema = schema(db);
    const before = db.prepare('SELECT rowid,session_id,CAST(body AS BLOB) AS body FROM session_search ORDER BY rowid')
      .safeIntegers(true).all();
    expect(() => migrateCompressedSearch(db)).toThrow(/search document.*UTF-8/i);
    expect(db.prepare('SELECT rowid,session_id,CAST(body AS BLOB) AS body FROM session_search ORDER BY rowid')
      .safeIntegers(true).all()).toEqual(before);
    expect(schema(db)).toEqual(beforeSchema);
  });

  it('keeps the caller transaction intact if its outer transaction rolls back migration', () => {
    const { db } = legacyFixture();
    const beforeSchema = schema(db);
    expect(() => db.transaction(() => {
      migrateCompressedSearch(db);
      throw new Error('outer rollback');
    })()).toThrow('outer rollback');
    expect(schema(db)).toEqual(beforeSchema);
    expect(db.pragma('user_version', { simple: true })).toBe(3);
  });
});

it('restores old postings if a compressed source update fails inside a caught caller transaction', () => {
  const { db } = fixture();
  createSearchIndex(db, true);
  replace(db, 5, 'guarded', 'previous preserved needle');
  db.exec(`CREATE TRIGGER fail_search_update BEFORE UPDATE ON session_search_documents BEGIN
    SELECT RAISE(ABORT, 'fixture source failure');
  END;`);
  db.transaction(() => {
    expect(() => replaceSearchDocument(db, 5, 'guarded', 'new rejected needle')).toThrow('fixture source failure');
  })();
  expect(matches(db, '*preserved*')).toEqual([5]);
  expect(matches(db, '*rejected*')).toEqual([]);
  expect(documents(db)).toEqual([{ rowid: 5, session_id: 'guarded', body: 'previous preserved needle' }]);
});

describe('stable compressed session identities', () => {
  it('retains a known session document rowid and allocates a new rowid for a collision', () => {
    const { db } = fixture();
    createSearchIndex(db, true);
    replace(db, 10, 'first', 'first original needle');
    replace(db, 20, 'second', 'second original needle');
    const before = db.prepare('SELECT total_changes() AS value').get();
    expect(replace(db, 20, 'first', 'first original needle')).toBe(false);
    expect(db.prepare('SELECT total_changes() AS value').get()).toEqual(before);
    expect(replace(db, 20, 'first', 'first updated needle')).toBe(true);
    expect(replace(db, 10, 'third', 'third added needle')).toBe(true);
    expect(documents(db)).toEqual([
      { rowid: 10, session_id: 'first', body: 'first updated needle' },
      { rowid: 20, session_id: 'second', body: 'second original needle' },
      { rowid: 21, session_id: 'third', body: 'third added needle' },
    ]);
    expect(matches(db, '*first original*')).toEqual([]);
    expect(matches(db, '*second original*')).toEqual([20]);
  });

  it('keeps ID-based results correct through session rowid reassignment and real VACUUM', () => {
    const { db } = fixture();
    db.exec("CREATE TABLE sessions(id TEXT PRIMARY KEY); INSERT INTO sessions(rowid,id) VALUES(10,'first'),(20,'second');");
    createSearchIndex(db, true);
    replace(db, 10, 'first', 'first old text');
    replace(db, 20, 'second', 'second retained text');
    // VACUUM is allowed to renumber implicit rowids. Explicitly exercise that
    // drift even on SQLite builds that preserve this particular fixture's IDs.
    db.exec("UPDATE sessions SET rowid=1 WHERE id='second'; UPDATE sessions SET rowid=2 WHERE id='first'; VACUUM;");
    const sessionRows = db.prepare('SELECT rowid,id FROM sessions').all() as { rowid: number; id: string }[];
    for (const row of sessionRows) replace(db, row.rowid, row.id, row.id === 'first' ? 'first updated text' : 'second retained text');
    expect(documents(db)).toEqual([
      { rowid: 10, session_id: 'first', body: 'first updated text' },
      { rowid: 20, session_id: 'second', body: 'second retained text' },
    ]);
    expect(db.prepare(`SELECT id FROM sessions
      WHERE id IN (SELECT session_id FROM session_search WHERE body GLOB ?) ORDER BY id`).all('*updated*'))
      .toEqual([{ id: 'first' }]);
    expect(db.transaction(() => deleteSearchDocument(db, 'second'))()).toBe(true);
    expect(matches(db, '*retained*')).toEqual([]);
    db.exec('VACUUM;');
    expect(documents(db)).toEqual([{ rowid: 10, session_id: 'first', body: 'first updated text' }]);
  });

  it('rolls back migration instead of silently collapsing duplicate legacy session IDs', () => {
    const { db } = legacyFixture();
    db.prepare('INSERT INTO session_search(rowid,session_id,body) VALUES(?,?,?)').run(5, 'unicode', 'duplicate identity');
    const before = exactDocuments(db);
    const beforeSchema = schema(db);
    expect(() => migrateCompressedSearch(db)).toThrow(/unique|session identity/i);
    expect(exactDocuments(db)).toEqual(before);
    expect(schema(db)).toEqual(beforeSchema);
  });

  it('refuses max+1 overflow without overwriting another session', () => {
    const { db } = legacyFixture();
    db.prepare('INSERT INTO session_search(rowid,session_id,body) VALUES(?,?,?)')
      .run(9223372036854775807n, 'maximum-rowid', 'maximum identity');
    migrateCompressedSearch(db);
    const before = exactDocuments(db);
    expect(() => replace(db, 0, 'new-session', 'must not overwrite the empty session')).toThrow(/rowid/i);
    expect(exactDocuments(db)).toEqual(before);
    expect(replace(db, 1, 'free-rowid', 'a free proposed rowid still works')).toBe(true);
  });
});
