import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomInt, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';

const contentionTimeoutMs = 250;
const busyTimeoutMs = 20;
const retryWait = new Int32Array(new SharedArrayBuffer(4));

export function acquireLock(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'server.lock');
  const databasePath = join(directory, 'server-lock.sqlite');
  const nonce = randomUUID();
  const deadline = performance.now() + contentionTimeoutMs;
  for (;;) {
    let lock: Database.Database | undefined;
    try {
      // A dedicated SQLite connection holds an OS-backed exclusive file lock.
      // The OS releases it on crash, including SIGKILL; diagnostic metadata
      // never determines ownership.
      const remaining = Math.max(0, Math.floor(deadline - performance.now()));
      lock = new Database(databasePath, { timeout: Math.min(busyTimeoutMs, remaining) });
      chmodSync(databasePath, 0o600);
      lock.exec('CREATE TABLE IF NOT EXISTS lock_marker(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
      writeFileSync(path, JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() }), { mode: 0o600 });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(readFileSync(path, 'utf8')) as { nonce?: string };
          if (owner.nonce === nonce) unlinkSync(path);
        } catch { /* Diagnostic metadata does not determine ownership. */ }
        finally { lock!.close(); }
      };
    } catch (err) {
      // Concurrent schema reads can make every immediate exclusive upgrade fail.
      // Drop any transaction/read lock before staggering a fresh attempt.
      lock?.close();
      if (!['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((err as { code?: string }).code || '')) throw err;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      Atomics.wait(retryWait, 0, 0, Math.min(remaining, randomInt(5, 21)));
    }
  }
  throw new Error('Agent Ops is already running for this data directory. Use a different port AND data directory for another instance.');
}
