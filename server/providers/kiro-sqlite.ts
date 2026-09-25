import Database from 'better-sqlite3';
import { isAbsolute } from 'node:path';
import type { ImportedSession } from '../../shared/types.js';
import { firstString, object, string } from './common.js';
import { parseKiroSession } from './kiro.js';
import { MAX_SQLITE_ROW_BYTES, assertSourcePath, errorDescription, type Source, type Warn } from './files.js';

export async function readKiroDatabase(
  source: Source,
  onSession: (session: ImportedSession) => void | Promise<void>,
  warn: Warn,
): Promise<boolean> {
  await assertSourcePath(source);
  let database: Database.Database | undefined;
  let ok = true;
  let rows = 0;
  let tables = 0;
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
        rows++;
        const row = object(value);
        if (typeof row.value_bytes === 'number' && row.value_bytes > MAX_SQLITE_ROW_BYTES) {
          warn(`${source.path}: A ${table} payload exceeds the 64 MiB size limit.`);
          ok = false;
          continue;
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
