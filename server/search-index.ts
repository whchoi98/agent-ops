import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { deflateRawSync, inflateRawSync } from 'node:zlib';

// Oversized or corrupt documents fail closed; migration must never truncate a body.
// Matches this SQLite build's MAX_LENGTH, allowing bodies derived from 512 MiB
// JSONL sources (including UTF-8 growth during the caller's JS lowercasing).
const MAX_BODY_BYTES = 1_000_000_000;
const MAX_DEFLATED_BYTES = MAX_BODY_BYTES + 1024 * 1024;
const MAX_ROWID = 9223372036854775807n;
const registered = new WeakSet<Database.Database>();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const LEGACY_INDEX_SQL = `CREATE VIRTUAL TABLE session_search
  USING fts5(session_id UNINDEXED, body, tokenize='trigram', detail=none)`;
const COMPRESSED_SOURCE_SQL = `
  CREATE TABLE session_search_documents (
    rowid INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    body_deflated BLOB NOT NULL CHECK(typeof(body_deflated) = 'blob'),
    body_bytes INTEGER NOT NULL CHECK(typeof(body_bytes) = 'integer' AND body_bytes BETWEEN 0 AND ${MAX_BODY_BYTES}),
    body_sha256 BLOB NOT NULL CHECK(typeof(body_sha256) = 'blob' AND length(body_sha256) = 32)
  );
  CREATE UNIQUE INDEX session_search_documents_session_id ON session_search_documents(session_id);
  CREATE VIEW session_search_source AS
    SELECT rowid, session_id,
      agent_ops_search_inflate(body_deflated, body_bytes, body_sha256) AS body
    FROM session_search_documents;
`;
const COMPRESSED_INDEX_SQL = `CREATE VIRTUAL TABLE session_search
  USING fts5(session_id UNINDEXED, body, content='session_search_source',
    content_rowid='rowid', tokenize='trigram', detail=none)`;
const REPLACEMENT_INDEX_SQL = `CREATE VIRTUAL TABLE session_search_replacement
  USING fts5(session_id UNINDEXED, body, content='session_search_source',
    content_rowid='rowid', tokenize='trigram', detail=none)`;

type Layout = 'missing' | 'legacy' | 'compressed';
interface SchemaObject { name: string; type: string; sql: string | null }
interface SearchDocument { rowid: number | bigint; session_id: string; body: string }
interface LegacyDocument {
  rowid: number | bigint; session_id: string; body_type: string;
  body_bytes: number | bigint | null; body_raw: Buffer | null;
}
interface EncodedDocument { bytes: number; deflated: Buffer; digest: Buffer }
export interface SearchMigrationResult { documents: number; originalBytes: number; compressedBytes: number }

function corrupt(): never { throw new Error('Invalid or corrupt compressed search document.'); }

function inflateDocument(packed: unknown, declaredBytes: unknown, digest: unknown): string {
  if (!Buffer.isBuffer(packed) || packed.length > MAX_DEFLATED_BYTES
    || typeof declaredBytes !== 'number' || !Number.isSafeInteger(declaredBytes)
    || declaredBytes < 0 || declaredBytes > MAX_BODY_BYTES
    || !Buffer.isBuffer(digest) || digest.length !== 32) return corrupt();
  try {
    // Node's typings do not distinguish the info:true result from the Buffer overload.
    const inflated = inflateRawSync(packed, {
      maxOutputLength: Math.max(1, declaredBytes), info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (inflated.buffer.length !== declaredBytes || inflated.engine.bytesWritten !== packed.length
      || !createHash('sha256').update(inflated.buffer).digest().equals(digest)) return corrupt();
    return decoder.decode(inflated.buffer);
  } catch { return corrupt(); }
}

/** Register on every opened connection before querying the compressed content view. */
export function registerSearchFunctions(db: Database.Database): void {
  if (registered.has(db)) return;
  db.function('agent_ops_search_inflate', { deterministic: true, safeIntegers: false }, inflateDocument);
  registered.add(db);
}

function layout(db: Database.Database): Layout {
  const objects = db.prepare(`SELECT name, type, sql FROM main.sqlite_schema
    WHERE name IN ('session_search', 'session_search_documents', 'session_search_source')`).all() as SchemaObject[];
  const index = objects.find(object => object.name === 'session_search');
  if (!index) return 'missing';
  if (index.type !== 'table' || !/\bUSING\s+fts5\s*\(/i.test(index.sql || '')) {
    throw new Error('Unsupported search index schema.');
  }
  const columns = db.prepare('PRAGMA main.table_info(session_search)').all() as { name: string }[];
  if (columns.map(column => column.name).join(',') !== 'session_id,body') {
    throw new Error('Unsupported search index columns.');
  }
  if (!/\bcontent\s*=/i.test(index.sql || '')) return 'legacy';
  if (!/\bcontent\s*=\s*['"]session_search_source['"]/i.test(index.sql || '')
    || !objects.some(object => object.name === 'session_search_source' && object.type === 'view')
    || !objects.some(object => object.name === 'session_search_documents' && object.type === 'table')) {
    throw new Error('Unsupported external-content search schema.');
  }
  const sourceColumns = db.prepare('PRAGMA main.table_info(session_search_documents)').all() as { name: string }[];
  if (sourceColumns.map(column => column.name).join(',') !== 'rowid,session_id,body_deflated,body_bytes,body_sha256') {
    throw new Error('Unsupported compressed search document schema.');
  }
  const indexes = db.prepare('PRAGMA main.index_list(session_search_documents)').safeIntegers(false).all() as {
    name: string; unique: number;
  }[];
  if (!indexes.some(index => index.name === 'session_search_documents_session_id' && index.unique === 1)) {
    throw new Error('Compressed search requires a unique session identity index.');
  }
  return 'compressed';
}

function encode(body: string): EncodedDocument {
  if (typeof body !== 'string') throw new Error('Search document body must be a string.');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > MAX_BODY_BYTES) throw new Error('Search document exceeds the 1,000,000,000-byte limit.');
  const raw = Buffer.from(body, 'utf8');
  if (raw.toString('utf8') !== body) throw new Error('Search document is not lossless UTF-8 text.');
  return encodeBytes(raw);
}

function encodeBytes(raw: Buffer): EncodedDocument {
  return { bytes: raw.length, deflated: deflateRawSync(raw), digest: createHash('sha256').update(raw).digest() };
}

/**
 * Create an absent index. An existing legacy/compressed layout is left intact,
 * regardless of the requested creation mode; conversion is explicitly separate.
 */
export function createSearchIndex(db: Database.Database, compressed: boolean): void {
  registerSearchFunctions(db);
  db.transaction(() => {
    if (layout(db) !== 'missing') return;
    if (compressed) {
      db.exec(COMPRESSED_SOURCE_SQL);
      db.exec(COMPRESSED_INDEX_SQL);
    } else db.exec(LEGACY_INDEX_SQL);
  })();
}

/**
 * The caller owns the transaction. An inner savepoint also preserves the old
 * document if a caller catches an insertion failure and continues its transaction.
 * Bodies are already JS-lowercased by the caller; never normalize them here.
 *
 * In compressed mode session_id is authoritative. Existing document rowids
 * survive sessions.rowid reassignment/VACUUM; a new session uses the proposed
 * rowid only if free. Callers must join compressed results by session_id.
 */
export function replaceSearchDocument(
  db: Database.Database, rowid: number, sessionId: string, body: string,
): boolean {
  if (!db.inTransaction) throw new Error('Search document replacement requires a caller transaction.');
  if (!Number.isSafeInteger(rowid) || typeof sessionId !== 'string' || typeof body !== 'string') {
    throw new Error('Invalid search document identity or body.');
  }
  registerSearchFunctions(db);
  const mode = layout(db);
  if (mode === 'missing') throw new Error('Search index has not been created.');
  let documentRowid: number | bigint = rowid;
  if (mode === 'compressed') {
    const known = db.prepare('SELECT rowid FROM session_search_documents WHERE session_id=?')
      .safeIntegers(true).get(sessionId) as { rowid: bigint } | undefined;
    if (known) documentRowid = known.rowid;
    else if (db.prepare('SELECT 1 FROM session_search_documents WHERE rowid=?').get(rowid)) {
      const maximum = db.prepare('SELECT MAX(rowid) AS rowid FROM session_search_documents')
        .safeIntegers(true).get() as { rowid: bigint };
      if (maximum.rowid === MAX_ROWID) throw new Error('No larger search document rowid is available.');
      documentRowid = maximum.rowid + 1n;
    }
  }
  const previous = db.prepare('SELECT rowid, session_id, body FROM session_search WHERE rowid=?')
    .safeIntegers(true).get(documentRowid) as SearchDocument | undefined;
  if (previous?.session_id === sessionId && previous.body === body) return false;
  const encoded = mode === 'compressed' ? encode(body) : null;
  db.transaction(() => {
    if (previous) {
      if (mode === 'compressed') {
        db.prepare(`INSERT INTO session_search(session_search, rowid, session_id, body)
          VALUES ('delete', ?, ?, ?)`).run(documentRowid, previous.session_id, previous.body);
      } else db.prepare('DELETE FROM session_search WHERE rowid=?').run(documentRowid);
    }
    if (encoded) {
      db.prepare(`INSERT INTO session_search_documents(rowid, session_id, body_deflated, body_bytes, body_sha256)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(rowid) DO UPDATE SET
        session_id=excluded.session_id, body_deflated=excluded.body_deflated,
        body_bytes=excluded.body_bytes, body_sha256=excluded.body_sha256`)
        .run(documentRowid, sessionId, encoded.deflated, encoded.bytes, encoded.digest);
    }
    db.prepare('INSERT INTO session_search(rowid, session_id, body) VALUES (?, ?, ?)').run(documentRowid, sessionId, body);
  })();
  return true;
}

/** Delete by stable session identity, removing postings before their source rows. */
export function deleteSearchDocument(db: Database.Database, sessionId: string): boolean {
  if (!db.inTransaction) throw new Error('Search document deletion requires a caller transaction.');
  if (typeof sessionId !== 'string') throw new Error('Invalid search document identity.');
  registerSearchFunctions(db);
  const mode = layout(db);
  if (mode === 'missing') throw new Error('Search index has not been created.');
  const findIdentity = (mode === 'compressed'
    ? db.prepare('SELECT rowid FROM session_search_documents WHERE session_id=? LIMIT 1')
    : db.prepare('SELECT rowid FROM session_search WHERE session_id=? LIMIT 1')).safeIntegers(true);
  let identity = findIdentity.get(sessionId) as { rowid: bigint } | undefined;
  if (!identity) return false;
  db.transaction(() => {
    while (identity) {
      const previous = db.prepare('SELECT session_id, body FROM session_search WHERE rowid=?')
        .get(identity.rowid) as SearchDocument;
      if (mode === 'compressed') {
        db.prepare(`INSERT INTO session_search(session_search, rowid, session_id, body)
          VALUES ('delete', ?, ?, ?)`).run(identity.rowid, previous.session_id, previous.body);
        db.prepare('DELETE FROM session_search_documents WHERE rowid=?').run(identity.rowid);
      } else db.prepare('DELETE FROM session_search WHERE rowid=?').run(identity.rowid);
      identity = findIdentity.get(sessionId) as { rowid: bigint } | undefined;
    }
  })();
  return true;
}

function compressedMetrics(db: Database.Database): SearchMigrationResult {
  const result = db.prepare(`SELECT COUNT(*) AS documents,
    COALESCE(SUM(body_bytes), 0) AS originalBytes,
    COALESCE(SUM(length(body_deflated)), 0) AS compressedBytes
    FROM session_search_documents`).safeIntegers(false).get() as SearchMigrationResult;
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('Invalid compressed search metrics.');
  }
  return result;
}

/**
 * Owns an immediate transaction (a savepoint when called inside one).
 * Each keyset read is materialized before writing (no active iterator). All old
 * rows are copied before DROP/RENAME. Callback exceptions
 * cancel and roll back the complete migration. No database version is changed.
 *
 * Metrics count UTF-8 body bytes and DEFLATE payload bytes, excluding index/page
 * overhead. An already compressed index is a no-write operation returning its
 * current totals, without calling onProgress.
 */
export function migrateCompressedSearch(
  db: Database.Database, onProgress?: (count: number) => void,
): SearchMigrationResult {
  registerSearchFunctions(db);
  return db.transaction(() => {
    const mode = layout(db);
    if (mode === 'compressed') return compressedMetrics(db);
    if (mode === 'missing') {
      createSearchIndex(db, true);
      return compressedMetrics(db);
    }
    db.exec(COMPRESSED_SOURCE_SQL);
    db.exec(REPLACEMENT_INDEX_SQL);
    const putSource = db.prepare(`INSERT INTO session_search_documents(
      rowid, session_id, body_deflated, body_bytes, body_sha256) VALUES (?, ?, ?, ?, ?)`);
    const putIndex = db.prepare('INSERT INTO session_search_replacement(rowid, session_id, body) VALUES (?, ?, ?)');
    // Do not let the driver's UTF-8 replacement decoding silently alter legacy
    // bytes. CASE also prevents an oversized body from being copied into JS.
    const legacyColumns = `rowid, session_id, typeof(body) AS body_type,
      length(CAST(body AS BLOB)) AS body_bytes,
      CASE WHEN length(CAST(body AS BLOB)) <= ${MAX_BODY_BYTES}
        THEN CAST(body AS BLOB) END AS body_raw`;
    const firstRow = db.prepare(`SELECT ${legacyColumns} FROM session_search ORDER BY rowid LIMIT 1`).safeIntegers(true);
    const nextRow = db.prepare(`SELECT ${legacyColumns} FROM session_search WHERE rowid>? ORDER BY rowid LIMIT 1`)
      .safeIntegers(true);
    const result: SearchMigrationResult = { documents: 0, originalBytes: 0, compressedBytes: 0 };
    let row = firstRow.get() as LegacyDocument | undefined;
    while (row) {
      if (typeof row.session_id !== 'string') throw new Error('Invalid legacy search document identity.');
      if (row.body_type !== 'text') throw new Error('Legacy search document body must be text.');
      if (Number(row.body_bytes) > MAX_BODY_BYTES) throw new Error('Search document exceeds the 1,000,000,000-byte limit.');
      if (!Buffer.isBuffer(row.body_raw)) throw new Error('Invalid legacy search document bytes.');
      let body: string;
      try { body = decoder.decode(row.body_raw); }
      catch { throw new Error('Invalid legacy search document UTF-8.'); }
      const encoded = encodeBytes(row.body_raw);
      putSource.run(row.rowid, row.session_id, encoded.deflated, encoded.bytes, encoded.digest);
      putIndex.run(row.rowid, row.session_id, body);
      result.documents++;
      result.originalBytes += encoded.bytes;
      result.compressedBytes += encoded.deflated.length;
      onProgress?.(result.documents);
      row = nextRow.get(row.rowid) as LegacyDocument | undefined;
    }
    db.exec(`DROP TABLE session_search;
      ALTER TABLE session_search_replacement RENAME TO session_search;`);
    return result;
  }).immediate();
}
