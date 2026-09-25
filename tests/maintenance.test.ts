import { afterEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, symlinkSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { optimizeStorage } from '../server/maintenance.js';
import { acquireLock } from '../server/lock.js';
import { Store } from '../server/store.js';

const dirs: string[] = [];
function legacy() {
  const dir = mkdtempSync(join(tmpdir(), 'agent-ops-maintenance-'));
  dirs.push(dir);
  const filename = join(dir, 'agent-ops.sqlite');
  const db = new Database(filename);
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_path TEXT NOT NULL,
      started_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL,
      data TEXT NOT NULL, bookmarked INTEGER NOT NULL DEFAULT 0,
      tags TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', title_override TEXT
    );
    CREATE TABLE messages (session_id TEXT NOT NULL REFERENCES sessions(id), ordinal INTEGER NOT NULL, data TEXT NOT NULL, tool_name TEXT, PRIMARY KEY(session_id,ordinal));
    CREATE VIRTUAL TABLE session_search USING fts5(session_id UNINDEXED,body,tokenize='trigram',detail=none);
    PRAGMA user_version=3;
  `);
  const body = '고유검색문장 alpha[meta]*? 반복되는 검증 본문입니다.\n'.repeat(3000);
  const session = {
    id: 'codex:kept', nativeId: 'kept', agent: 'codex', title: 'Original title', projectPath: '/fixture/project',
    projectName: 'Fixture', model: 'fixture', startedAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:01Z',
    status: 'recorded', messageCount: 1, toolCallCount: 0,
    usage: { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null },
    sourcePath: '/fixture/native.jsonl',
  };
  db.prepare('INSERT INTO sessions(id,agent,project_path,started_at,updated_at,status,data,bookmarked,tags,note,title_override) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(session.id, session.agent, session.projectPath, session.startedAt, session.updatedAt, session.status, JSON.stringify(session), 1, '["kept-tag"]', 'Keep my note', 'User title');
  db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(session.id, 0,
    JSON.stringify({ id: 'message', role: 'user', content: body, timestamp: session.startedAt }), null);
  const rowid = db.prepare('SELECT rowid FROM sessions').get() as { rowid: number };
  db.prepare('INSERT INTO session_search(rowid,session_id,body) VALUES(?,?,?)').run(rowid.rowid, session.id, body.toLowerCase());
  db.close();
  return { dir, filename, body };
}
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

it('backs up the old database, compresses search storage and preserves history and annotations', async () => {
  const { dir, body } = legacy();
  const result = await optimizeStorage(dir);
  expect(result.afterBytes).toBeLessThan(result.beforeBytes);
  expect(result.documents).toBe(1);
  expect(existsSync(result.backupPath)).toBe(true);
  const restored = join(dir, 'restored.sqlite');
  writeFileSync(restored, gunzipSync(readFileSync(result.backupPath)));
  const backup = new Database(restored, { readonly: true });
  expect(backup.pragma('user_version', { simple: true })).toBe(3);
  expect((backup.prepare('SELECT note FROM sessions').get() as { note: string }).note).toBe('Keep my note');
  backup.close();
  const store = new Store(join(dir, 'agent-ops.sqlite'));
  try {
    expect(store.db.pragma('user_version', { simple: true })).toBe(4);
    expect(store.getSession('codex:kept')).toMatchObject({ title: 'User title', bookmarked: true, tags: ['kept-tag'], note: 'Keep my note' });
    expect(store.getSession('codex:kept')!.messages[0].content).toBe(body);
    expect(store.listSessions({ q: '고유검색문장' }).total).toBe(1);
    expect(store.listSessions({ q: 'alpha[meta]*?' }).total).toBe(1);
  } finally { store.close(); }
});

it('refuses maintenance while another server owns the data directory', async () => {
  const { dir, filename } = legacy();
  const before = readFileSync(filename);
  const release = acquireLock(dir);
  try {
    await expect(optimizeStorage(dir)).rejects.toThrow(/already running/i);
    expect(readFileSync(filename)).toEqual(before);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  } finally { release(); }
});

it('also refuses maintenance while a standalone sync owns the writer lock', async () => {
  const { dir, filename } = legacy();
  const before = readFileSync(filename);
  const release = acquireLock(join(dir, 'sync-lock'));
  try {
    await expect(optimizeStorage(dir)).rejects.toThrow(/already running/i);
    expect(readFileSync(filename)).toEqual(before);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  } finally { release(); }
});

it.each(['symbolic', 'hard'] as const)('rejects a %s database-file alias that would bypass the server directory lock', async kind => {
  const { dir, filename } = legacy();
  const alias = mkdtempSync(join(tmpdir(), 'agent-ops-maintenance-alias-'));
  dirs.push(alias);
  const aliasFile = join(alias, 'agent-ops.sqlite');
  if (kind === 'symbolic') symlinkSync(filename, aliasFile);
  else linkSync(filename, aliasFile);
  const before = readFileSync(filename);
  const release = acquireLock(dir);
  try {
    await expect(optimizeStorage(alias)).rejects.toThrow(/symbolic|hard|regular file/i);
    expect(readFileSync(filename)).toEqual(before);
    expect(existsSync(join(alias, 'backups'))).toBe(false);
  } finally { release(); }
});

it('rolls back compressed schema conversion if writing its version marker fails', async () => {
  const { dir, filename } = legacy();
  const original = Database.prototype.pragma;
  const spy = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, source: string, options?: Database.PragmaOptions) {
    if (/^\s*user_version\s*=\s*4\s*$/i.test(source)) throw new Error('Synthetic version-write failure');
    return original.call(this, source, options);
  });
  try {
    await expect(optimizeStorage(dir)).rejects.toThrow('Synthetic version-write failure');
  } finally { spy.mockRestore(); }
  const db = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(3);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name='session_search_documents'").get()).toBeUndefined();
    expect((db.prepare('SELECT body FROM session_search').get() as { body: string }).body).toContain('고유검색문장');
    expect(existsSync(join(dir, 'backups'))).toBe(true);
  } finally { db.close(); }
});

it('rebuilds obsolete derived postings from preserved content without a redundant full FTS integrity pass', async () => {
  const { dir, filename, body } = legacy();
  const db = new Database(filename);
  // Remove only derived postings; the canonical history and search content remain.
  db.unsafeMode(true);
  db.prepare('DELETE FROM session_search_data WHERE id > 10').run();
  db.close();
  const result = await optimizeStorage(dir);
  expect(result.documents).toBe(1);
  const store = new Store(filename);
  try {
    expect(store.getSession('codex:kept')!.messages[0].content).toBe(body);
    expect(store.listSessions({ q: '고유검색문장' }).total).toBe(1);
    expect(store.listSessions({ q: 'alpha[meta]*?' }).total).toBe(1);
  } finally { store.close(); }
});
