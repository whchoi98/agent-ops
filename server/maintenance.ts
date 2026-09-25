import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, createReadStream, createWriteStream, existsSync, fsyncSync,
  mkdirSync, openSync, renameSync, rmSync, statfsSync, statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { acquireLock } from './lock.js';
import { migrateCompressedSearch, registerSearchFunctions } from './search-index.js';
import { Store } from './store.js';
import { assertDatabaseFile } from './database-file.js';

export interface StorageOptimization {
  beforeBytes: number;
  afterBytes: number;
  backupPath: string;
  backupBytes: number;
  documents: number;
  originalSearchBytes: number;
  compressedSearchBytes: number;
}

function databaseBytes(filename: string): number {
  return [filename, `${filename}-wal`].reduce((bytes, path) => bytes + (existsSync(path) ? statSync(path).size : 0), 0);
}

function quickCheck(db: Database.Database): void {
  // FTS5 ignores the quick-check flag and rechecks its complete inverted index.
  // Check ordinary/shadow B-trees (including sqlite_schema/free pages) directly;
  // migration validates every source body and rebuilds the derived FTS postings.
  const tables = db.pragma('main.table_list') as Array<{ name: string; type: string }>;
  for (const table of tables) {
    if (table.type !== 'table' && table.type !== 'shadow') continue;
    const result = db.pragma(`quick_check('${table.name.replaceAll("'", "''")}')`) as Array<{ quick_check: string }>;
    if (result.length !== 1 || result[0].quick_check !== 'ok') throw new Error('Database integrity check failed.');
  }
}

function counts(db: Database.Database): string {
  const tables = ['sessions', 'messages', 'projects', 'templates', 'runs', 'run_events'];
  return JSON.stringify(tables.map(table => {
    const exists = db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table);
    return exists ? (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count : 0;
  }));
}

/** Explicit, offline maintenance of Agent Ops' cache. Native assistant data is never opened. */
export async function optimizeStorage(
  dataDir: string,
  onProgress: (message: string) => void = () => {},
): Promise<StorageOptimization> {
  const directory = resolve(dataDir);
  const filename = join(directory, 'agent-ops.sqlite');
  if (!existsSync(filename)) throw new Error('No Agent Ops database exists in this data directory.');
  assertDatabaseFile(filename, true);
  const releaseServer = acquireLock(directory);
  let releaseSync: (() => void) | undefined;
  let reader: Database.Database | undefined;
  let store: Store | undefined;
  let snapshot: string | undefined;
  let partial: string | undefined;
  try {
    // A manually started CLI sync may be running while the HTTP server is stopped.
    releaseSync = acquireLock(join(directory, 'sync-lock'));
    const beforeBytes = databaseBytes(filename);
    const space = statfsSync(directory);
    if (space.bavail * space.bsize < beforeBytes * 3 + 128 * 1024 * 1024) {
      throw new Error('Insufficient free space for a verified backup and database compaction. Free at least three times the database size plus 128 MiB.');
    }
    reader = new Database(filename, { readonly: true, fileMustExist: true });
    registerSearchFunctions(reader);
    const version = reader.pragma('user_version', { simple: true }) as number;
    if (version > 4) throw new Error(`Database schema ${version} is newer than this application supports.`);
    onProgress('Checking database structure and stored history…');
    quickCheck(reader);
    const beforeCounts = counts(reader);
    const backups = join(directory, 'backups');
    mkdirSync(backups, { recursive: true, mode: 0o700 });
    chmodSync(backups, 0o700);
    const token = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
    snapshot = join(backups, `.snapshot-${token}.sqlite`);
    partial = join(backups, `.backup-${token}.partial`);
    const backupPath = join(backups, `agent-ops-before-optimize-${token}.sqlite.gz`);
    // Reserve a private file before SQLite opens its backup destination.
    closeSync(openSync(snapshot, 'wx', 0o600));
    onProgress('Creating a consistent database backup…');
    await reader.backup(snapshot, { progress: () => 1024 });
    reader.close();
    reader = undefined;
    const snapshotBytes = statSync(snapshot).size;
    const sourceHash = createHash('sha256');
    await pipeline(
      createReadStream(snapshot),
      new Transform({ transform(chunk: Buffer, _encoding, done) { sourceHash.update(chunk); done(null, chunk); } }),
      createGzip({ level: 3 }),
      createWriteStream(partial, { flags: 'wx', mode: 0o600 }),
    );
    onProgress('Verifying the compressed backup…');
    const backupHash = createHash('sha256');
    let restoredBytes = 0;
    await pipeline(
      createReadStream(partial),
      createGunzip(),
      new Writable({ write(chunk: Buffer, _encoding, done) {
        restoredBytes += chunk.byteLength;
        if (restoredBytes > snapshotBytes) { done(new Error('Backup verification failed. The database was not changed.')); return; }
        backupHash.update(chunk);
        done();
      } }),
    );
    if (restoredBytes !== snapshotBytes || sourceHash.digest('hex') !== backupHash.digest('hex')) {
      throw new Error('Backup verification failed. The database was not changed.');
    }
    const archive = openSync(partial, 'r');
    try { fsyncSync(archive); } finally { closeSync(archive); }
    renameSync(partial, backupPath);
    partial = undefined;
    const backupDirectory = openSync(backups, 'r');
    try { fsyncSync(backupDirectory); } finally { closeSync(backupDirectory); }
    rmSync(snapshot);
    snapshot = undefined;

    onProgress('Compressing the search document cache…');
    assertDatabaseFile(filename, true);
    store = new Store(filename);
    const database = store.db;
    const result = database.transaction(() => {
      const metrics = migrateCompressedSearch(database, count => {
        if (count % 500 === 0) onProgress(`Compressed ${count} search documents…`);
      });
      if (counts(database) !== beforeCounts) throw new Error('Database row counts changed unexpectedly. The backup was retained.');
      database.pragma('user_version = 4');
      return metrics;
    }).immediate();
    onProgress('Reclaiming unused database pages…');
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    store.db.exec('VACUUM');
    onProgress('Checking the compacted database…');
    quickCheck(store.db);
    if (counts(store.db) !== beforeCounts) throw new Error('Database row counts changed unexpectedly. The backup was retained.');
    store.db.pragma('wal_checkpoint(TRUNCATE)');
    store.close();
    store = undefined;
    return {
      beforeBytes, afterBytes: databaseBytes(filename),
      backupPath, backupBytes: statSync(backupPath).size,
      documents: result.documents, originalSearchBytes: result.originalBytes,
      compressedSearchBytes: result.compressedBytes,
    };
  } finally {
    reader?.close();
    store?.close();
    if (snapshot) rmSync(snapshot, { force: true });
    if (partial) rmSync(partial, { force: true });
    releaseSync?.();
    releaseServer();
  }
}
