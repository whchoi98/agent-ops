import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../server/store.js';
import { retryWrite } from '../server/write-retry.js';

it('yields while another writer owns SQLite and retries a metadata transaction without losing its update', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-ops-write-retry-'));
  const store = new Store(join(directory, 'cache.sqlite'));
  const other = new Database(store.filename);
  other.exec('BEGIN IMMEDIATE');
  let settled = false;
  const pending = retryWrite(store, () => store.saveSettings({ concurrency: 3 }))
    .then(value => { settled = true; return value; });
  try {
    await delay(35);
    expect(settled).toBe(false);
    expect(store.db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(store.getSettings().concurrency).not.toBe(3);
    other.exec('ROLLBACK');
    expect((await pending).concurrency).toBe(3);
  } finally {
    if (other.inTransaction) other.exec('ROLLBACK');
    await pending.catch(() => {});
    other.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('rolls back a partially executed attempt before retrying and preserves the original busy timeout', async () => {
  const store = new Store(':memory:');
  store.db.pragma('busy_timeout = 731');
  store.db.exec('CREATE TABLE attempts(value INTEGER)');
  let attempts = 0;
  try {
    await retryWrite(store, () => {
      store.db.prepare('INSERT INTO attempts VALUES (?)').run(++attempts);
      if (attempts === 1) throw Object.assign(new Error('Synthetic contention'), { code: 'SQLITE_BUSY' });
      return true;
    });
    expect(store.db.prepare('SELECT value FROM attempts').all()).toEqual([{ value: 2 }]);
    expect(store.db.pragma('busy_timeout', { simple: true })).toBe(731);
    expect(store.db.inTransaction).toBe(false);
  } finally { store.close(); }
});

it('stops pending writes on shutdown and does not retry unrelated failures', async () => {
  const store = new Store(':memory:');
  let cancelled = false;
  let attempts = 0;
  try {
    const pending = retryWrite(store, () => {
      attempts++;
      cancelled = true;
      throw Object.assign(new Error('Synthetic contention'), { code: 'SQLITE_BUSY' });
    }, () => cancelled);
    await expect(pending).rejects.toMatchObject({ statusCode: 503 });
    expect(attempts).toBe(1);
    await expect(retryWrite(store, () => { throw new Error('Synthetic non-lock failure'); })).rejects.toThrow('Synthetic non-lock failure');
  } finally { store.close(); }
});
