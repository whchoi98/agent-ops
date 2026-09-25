import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import type { ImportedSession } from '../../shared/types.js';
import { firstString, object, string } from './common.js';
import { parseKiroSession } from './kiro.js';
import { MAX_SQLITE_ROW_BYTES, assertSourcePath, errorDescription, type Source, type Warn } from './files.js';

const YIELD_AFTER_ROWS = 128;
const YIELD_AFTER_BYTES = 16 * 1024 * 1024;

export interface KiroRowCheckpoint {
  fingerprint: string;
  sessionId: string;
}

export interface KiroRowCache {
  get(key: string): KiroRowCheckpoint | null;
  set(key: string, checkpoint: KiroRowCheckpoint): void;
}

export async function readKiroDatabase(
  source: Source,
  onSession: (session: ImportedSession) => void | false | Promise<void | false>,
  warn: Warn,
  rowCache?: KiroRowCache,
): Promise<boolean> {
  await assertSourcePath(source);
  let database: Database.Database | undefined;
  let ok = true;
  let rows = 0;
  let tables = 0;
  let rowsSinceYield = 0;
  let bytesSinceYield = 0;
  const emitted = new Set<string>();
  try {
    database = new Database(source.path, { readonly: true, fileMustExist: true, timeout: 1000 });
    database.pragma('query_only = ON');
    database.exec('BEGIN');
    // V2 is authoritative when an older table contains a copy of the same session.
    for (const table of ['conversations_v2', 'conversations'] as const) {
      const columns = new Set(database.prepare(`PRAGMA table_info("${table}")`).all()
        .map(column => string(object(column).name)));
      if (!columns.size) continue;
      tables++;
      if (!columns.has('key') || !columns.has('value') || (table === 'conversations_v2' && !columns.has('conversation_id'))) {
        warn(`${source.path}: Unsupported ${table} schema; its rows were not imported.`);
        ok = false;
        continue;
      }
      const optional = (name: string) => columns.has(name) ? `"${name}"` : `NULL AS "${name}"`;
      const query = `SELECT "key", ${optional('conversation_id')}, ${optional('created_at')}, ${optional('updated_at')},
        length(CAST("value" AS BLOB)) AS value_bytes,
        CASE WHEN length(CAST("value" AS BLOB)) <= ${MAX_SQLITE_ROW_BYTES} THEN "value" ELSE NULL END AS "value"
        FROM "${table}"`;
      for (const value of database.prepare(query).iterate()) {
        // Cache hits and rejected rows never await an import callback. Yield by
        // both row count and bytes so cancellation can run between work batches.
        if (rowsSinceYield >= YIELD_AFTER_ROWS || bytesSinceYield >= YIELD_AFTER_BYTES) {
          await setImmediate();
          rowsSinceYield = 0;
          bytesSinceYield = 0;
        }
        rows++;
        rowsSinceYield++;
        const row = object(value);
        if (typeof row.value_bytes === 'number') bytesSinceYield += Math.min(row.value_bytes, MAX_SQLITE_ROW_BYTES);
        if (typeof row.value_bytes === 'number' && row.value_bytes > MAX_SQLITE_ROW_BYTES) {
          warn(`${source.path}: A ${table} payload exceeds the 64 MiB size limit.`);
          ok = false;
          continue;
        }
        // Row identity stays stable as its body changes. Database/WAL timestamps
        // trigger a scan, but only payload bytes and row timestamps invalidate it.
        const checkpoint = rowCache ? {
          key: `kiro-row:${createHash('sha256')
            .update(JSON.stringify([source.path, table, row.key, row.conversation_id])).digest('hex')}`,
          fingerprint: createHash('sha256')
            .update(JSON.stringify([row.created_at, row.updated_at])).update('\0')
            .update(Buffer.isBuffer(row.value) ? row.value : string(row.value)).digest('hex'),
        } : null;
        if (checkpoint) {
          const cached = rowCache!.get(checkpoint.key);
          if (cached?.fingerprint === checkpoint.fingerprint && cached.sessionId) {
            if (!emitted.has(cached.sessionId) && emitted.size >= 100_000) {
              warn(`${source.path}: SQLite conversation limit reached; remaining rows were not imported.`);
              ok = false;
              break;
            }
            // A cached V2 row must still suppress its older V1 copy below.
            emitted.add(cached.sessionId);
            continue;
          }
        }
        let payload: unknown;
        try {
          const raw = Buffer.isBuffer(row.value)
            ? new TextDecoder('utf-8', { fatal: true }).decode(row.value)
            : string(row.value);
          payload = JSON.parse(raw);
        } catch {
          warn(`${source.path}: Malformed JSON in a ${table} row; its prior history was not replaced.`);
          ok = false;
          continue;
        }
        const key = string(row.key);
        const parsed = parseKiroSession(payload, {
          sourcePath: source.path,
          fallbackTimestamp: source.stat.mtimeMs,
          nativeId: firstString(row.conversation_id) || undefined,
          identityKey: `${table}\0${key}`,
          projectPath: isAbsolute(key) || /^[A-Za-z]:[\\/]/.test(key) ? key : undefined,
          createdAt: row.created_at, updatedAt: row.updated_at,
        });
        parsed.warnings.forEach(warn);
        if (!parsed.session) {
          ok = false;
          continue;
        }
        if (emitted.has(parsed.session.id)) continue;
        if (emitted.size >= 100_000) {
          warn(`${source.path}: SQLite conversation limit reached; remaining rows were not imported.`);
          ok = false;
          break;
        }
        emitted.add(parsed.session.id);
        try {
          await onSession(parsed.session);
          if (checkpoint) {
            rowCache!.set(checkpoint.key, { fingerprint: checkpoint.fingerprint, sessionId: parsed.session.id });
          }
        } catch (error) {
          warn(`${source.path}: Session import callback failed (${errorDescription(error)}).`);
          ok = false;
        }
      }
    }
    database.exec('ROLLBACK');
    if (!tables) {
      warn(`${source.path}: No supported Kiro conversation tables were found in this SQLite database.`);
      return false;
    }
    if (!rows) warn(`${source.path}: No recorded Kiro conversations were found.`);
    return ok;
  } finally {
    // Closing also releases an outstanding read transaction/iterator on any failure.
    database?.close();
  }
}
