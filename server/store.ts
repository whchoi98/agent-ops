import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import { defaultSettings } from './config.js';
import type {
  ImportedSession, Session, SessionDetail, SessionQuery, SessionPage,
  Project, PromptTemplate, Run, RunEvent, Settings, SyncReport, Message, MessagePage, MessageQuery,
} from '../shared/types.js';

type Row = Record<string, unknown>;
const json = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const stableId = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 20);
export const projectId = (path: string) => `project-${stableId(path)}`;

export class Store {
  readonly db: Database.Database;
  private closed = false;
  constructor(readonly filename: string) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    const version = this.db.pragma('user_version', { simple: true }) as number;
    if (version > 3) {
      this.db.close();
      throw new Error(`Database schema ${version} is newer than this application supports.`);
    }
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, agent TEXT NOT NULL, project_path TEXT NOT NULL,
        started_at TEXT NOT NULL, updated_at TEXT NOT NULL, status TEXT NOT NULL,
        data TEXT NOT NULL, bookmarked INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '',
        title_override TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_recent ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_agent_project ON sessions(agent, project_path);
      CREATE TABLE IF NOT EXISTS messages (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, data TEXT NOT NULL, tool_name TEXT,
        PRIMARY KEY(session_id, ordinal)
      );
      CREATE INDEX IF NOT EXISTS messages_tool_calls ON messages(tool_name)
        WHERE tool_name IS NOT NULL AND json_extract(data,'$.role') = 'assistant';
      CREATE INDEX IF NOT EXISTS messages_session_role ON messages(session_id,json_extract(data,'$.role'));
      CREATE INDEX IF NOT EXISTS messages_identity ON messages(session_id,json_extract(data,'$.id'));
      CREATE VIRTUAL TABLE IF NOT EXISTS session_search
        USING fts5(session_id UNINDEXED, body, tokenize='trigram', detail=none);
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS runs_status ON runs(status, created_at);
      CREATE TABLE IF NOT EXISTS run_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        timestamp TEXT NOT NULL, stream TEXT NOT NULL, text TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_run ON run_events(run_id, id);
    `);
    if (version < 3) {
      this.db.transaction(() => {
        // An FTS row shares its session's integer rowid. Updating one conversation
        // must not scan the text of every previously imported conversation.
        this.db.exec(`DROP TABLE session_search;
          CREATE VIRTUAL TABLE session_search USING fts5(session_id UNINDEXED, body, tokenize='trigram', detail=none);`);
        for (const row of this.db.prepare('SELECT id FROM sessions').all() as Array<{ id: string }>) this.updateSearch(row.id);
        this.db.pragma('user_version = 3');
      })();
    }
  }
  close() {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
  private sessionFromRow(row: Row): Session {
    const base = json<Session>(row.data);
    return {
      ...base, title: row.title_override == null ? base.title : String(row.title_override),
      bookmarked: Boolean(row.bookmarked), tags: json<string[]>(row.tags), note: String(row.note),
    };
  }
  private updateSearch(id: string, importedMessages?: Message[]) {
    const row = this.db.prepare('SELECT rowid AS search_rowid,* FROM sessions WHERE id=?').get(id) as Row;
    const session = this.sessionFromRow(row);
    const messages = importedMessages || (this.db.prepare('SELECT data FROM messages WHERE session_id=? ORDER BY ordinal').all(id) as Row[])
      .map((message) => json<Message>(message.data));
    const body = [
      session.title, session.projectName, session.projectPath, session.model,
      session.tags.join(' '), session.note, ...messages.flatMap((message) => [message.toolName || '', message.content]),
    ].join('\n').toLowerCase();
    this.db.prepare('DELETE FROM session_search WHERE rowid = ?').run(row.search_rowid);
    this.db.prepare('INSERT INTO session_search(rowid, session_id, body) VALUES (?, ?, ?)').run(row.search_rowid, id, body);
  }
  upsertSession(session: ImportedSession) {
    this.db.transaction(() => {
      const { messages, ...data } = session;
      this.db.prepare(`
        INSERT INTO sessions(id,agent,project_path,started_at,updated_at,status,data) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET agent=excluded.agent, project_path=excluded.project_path,
          started_at=excluded.started_at, updated_at=excluded.updated_at, status=excluded.status, data=excluded.data
      `).run(data.id, data.agent, data.projectPath, data.startedAt, data.updatedAt, data.status,
        JSON.stringify({ ...data, messageCount: messages.length }));
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(data.id);
      const insert = this.db.prepare('INSERT INTO messages(session_id,ordinal,data,tool_name) VALUES (?,?,?,?)');
      messages.forEach((message, i) => insert.run(data.id, i, JSON.stringify(message), message.toolName || null));
      if (data.projectPath) this.ensureProject(data.projectPath, data.projectName);
      this.updateSearch(data.id, messages);
    })();
  }
  getSession(id: string, includeMessages = true): SessionDetail | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const messages = includeMessages
      ? (this.db.prepare('SELECT data FROM messages WHERE session_id = ? ORDER BY ordinal').all(id) as Row[]).map((m) => json<Message>(m.data))
      : [];
    return { ...this.sessionFromRow(row), messages };
  }
  getMessage(sessionId: string, messageId: string): Message | null {
    const row = this.db.prepare("SELECT data FROM messages WHERE session_id=? AND json_extract(data,'$.id')=? ORDER BY ordinal LIMIT 1")
      .get(sessionId, messageId) as Row | undefined;
    return row ? json<Message>(row.data) : null;
  }
  listMessages(sessionId: string, query: MessageQuery = {}): MessagePage {
    const roleCounts: MessagePage['roleCounts'] = { all: 0, user: 0, assistant: 0, tool: 0, system: 0 };
    const counts = this.db.prepare("SELECT json_extract(data,'$.role') AS role,COUNT(*) AS count FROM messages WHERE session_id=? GROUP BY json_extract(data,'$.role')")
      .all(sessionId) as Array<{ role: Message['role']; count: number }>;
    for (const item of counts) {
      if (Object.hasOwn(roleCounts, item.role)) roleCounts[item.role] = item.count;
      roleCounts.all += item.count;
    }
    const where = ['session_id=?'];
    const args: Array<string | number> = [sessionId];
    if (query.role) { where.push("json_extract(data,'$.role')=?"); args.push(query.role); }
    if (query.q) {
      where.push("json_extract(data,'$.content') LIKE ? ESCAPE '\\'");
      args.push(`%${query.q.replace(/[\\%_]/g, '\\$&')}%`);
    }
    const clause = where.join(' AND ');
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM messages WHERE ${clause}`).get(...args) as { count: number }).count;
    const offset = Math.max(0, query.offset ?? 0);
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const rows = this.db.prepare(`SELECT data FROM messages WHERE ${clause} ORDER BY ordinal LIMIT ? OFFSET ?`).all(...args, limit, offset) as Row[];
    const items = rows.map((row) => {
      const message = json<Message>(row.data);
      if (message.content.length <= 16000) return message;
      const match = query.q ? message.content.toLowerCase().indexOf(query.q.toLowerCase()) : -1;
      const start = match > 1000 ? match - 1000 : 0;
      return {
        ...message, content: message.content.slice(start, start + 16000),
        truncated: true, contentLength: message.content.length,
      };
    });
    return { items, total, offset, limit, roleCounts };
  }
  patchSession(id: string, patch: Partial<Pick<Session, 'bookmarked' | 'tags' | 'note' | 'title'>>, includeMessages = true): SessionDetail | null {
    const session = this.getSession(id, false);
    if (!session) return null;
    this.db.transaction(() => {
      if (patch.title !== undefined) this.db.prepare('UPDATE sessions SET title_override = ? WHERE id = ?').run(patch.title, id);
      this.db.prepare('UPDATE sessions SET bookmarked=?, tags=?, note=? WHERE id=?')
        .run(Number(patch.bookmarked ?? session.bookmarked), JSON.stringify(patch.tags ?? session.tags), patch.note ?? session.note, id);
      if (patch.title !== undefined || patch.tags !== undefined || patch.note !== undefined) this.updateSearch(id);
    })();
    return this.getSession(id, includeMessages);
  }
  listSessions(query: SessionQuery = {}): SessionPage {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (query.q) {
      if (query.q.includes('\0')) return { items: [], total: 0 };
      // GLOB can use a position-free trigram index; no expensive token positions
      // are needed for literal substring search. Escaped metacharacters remain
      // literal, and lowercase index/query text gives Unicode case folding.
      const literal = [...query.q.toLowerCase()].map((char) => '[]*?'.includes(char) ? `[${char}]` : char).join('');
      where.push('rowid IN (SELECT rowid FROM session_search WHERE body GLOB ?)');
      args.push(`*${literal}*`);
    }
    if (query.agent) { where.push('agent = ?'); args.push(query.agent); }
    if (query.project) { where.push('project_path = ?'); args.push(query.project); }
    if (query.status) { where.push('status = ?'); args.push(query.status); }
    if (query.bookmarked) where.push('bookmarked = 1');
    if (query.tag) { where.push('EXISTS (SELECT 1 FROM json_each(sessions.tags) WHERE value = ?)'); args.push(query.tag); }
    if (query.since) { where.push('updated_at >= ?'); args.push(new Date(query.since).toISOString()); }
    if (query.until) { where.push('started_at <= ?'); args.push(new Date(query.until.length === 10 ? `${query.until}T23:59:59.999Z` : query.until).toISOString()); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS count FROM sessions ${clause}`).get(...args) as { count: number }).count;
    const order = query.sort === 'oldest' ? 'updated_at ASC,id ASC' : query.sort === 'tokens'
      ? `(COALESCE(json_extract(data,'$.usage.inputTokens'),0)+COALESCE(json_extract(data,'$.usage.outputTokens'),0)) DESC, updated_at DESC`
      : 'updated_at DESC,id ASC';
    const rows = this.db.prepare(`SELECT * FROM sessions ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, Math.min(200, Math.max(1, query.limit ?? 60)), Math.max(0, query.offset ?? 0)) as Row[];
    return { items: rows.map((r) => this.sessionFromRow(r)), total };
  }
  allSessions(): Session[] {
    return (this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Row[]).map((r) => this.sessionFromRow(r));
  }
  toolCounts(): Array<{ name: string; count: number }> {
    return this.db.prepare("SELECT tool_name AS name, COUNT(*) AS count FROM messages WHERE tool_name IS NOT NULL AND json_extract(data,'$.role') = 'assistant' GROUP BY tool_name ORDER BY count DESC")
      .all() as Array<{ name: string; count: number }>;
  }
  ensureProject(path: string, name?: string): Project {
    const id = projectId(path);
    const existing = this.getProject(id);
    if (existing) return existing;
    const colors = ['#3564e8', '#0e9f8f', '#8b5cf6', '#d88756', '#527cbd'];
    const project: Project = {
      id, name: name || basename(path) || path, path, color: colors[parseInt(stableId(path).slice(0, 2), 16) % colors.length],
      executionEnabled: false, createdAt: new Date().toISOString(),
    };
    this.saveProject(project);
    return project;
  }
  saveProject(project: Project): Project {
    this.db.prepare('INSERT INTO projects(id,path,data) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,data=excluded.data')
      .run(project.id, project.path, JSON.stringify(project));
    return project;
  }
  getProject(id: string): Project | null {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id) as Row | undefined;
    return row ? json<Project>(row.data) : null;
  }
  listProjects(): Project[] {
    return (this.db.prepare('SELECT data FROM projects ORDER BY path').all() as Row[]).map((r) => json<Project>(r.data));
  }
  listTemplates(): PromptTemplate[] {
    return (this.db.prepare('SELECT data FROM templates ORDER BY rowid').all() as Row[]).map((r) => json<PromptTemplate>(r.data));
  }
  saveTemplate(template: PromptTemplate): PromptTemplate {
    this.db.prepare('INSERT INTO templates(id,data) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data')
      .run(template.id, JSON.stringify(template));
    return template;
  }
  deleteTemplate(id: string): boolean {
    return this.db.prepare('DELETE FROM templates WHERE id=?').run(id).changes > 0;
  }
  getMeta<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as Row | undefined;
    return row ? json<T>(row.value) : null;
  }
  setMeta(key: string, value: unknown) {
    this.db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, JSON.stringify(value));
  }
  getSettings(): Settings {
    return { ...defaultSettings(), ...this.getMeta<Settings>('config') };
  }
  saveSettings(patch: Partial<Settings>): Settings {
    const settings = { ...this.getSettings(), ...patch };
    this.setMeta('config', settings);
    return settings;
  }
  getFingerprint(path: string): string | null {
    const row = this.db.prepare('SELECT fingerprint FROM sources WHERE path=?').get(path) as Row | undefined;
    return row ? String(row.fingerprint) : null;
  }
  setFingerprint(path: string, fingerprint: string) {
    this.db.prepare('INSERT INTO sources(path,fingerprint) VALUES (?,?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint')
      .run(path, fingerprint);
  }
  lastSync(): SyncReport | null { return this.getMeta<SyncReport>('sync'); }
  insertRun(run: Run): Run {
    this.db.prepare('INSERT INTO runs(id,project_id,status,created_at,data) VALUES (?,?,?,?,?)')
      .run(run.id, run.projectId, run.status, run.createdAt, JSON.stringify(run));
    return run;
  }
  getRun(id: string): Run | null {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as Row | undefined;
    return row ? json<Run>(row.data) : null;
  }
  updateRun(id: string, patch: Partial<Run>): Run | null {
    const current = this.getRun(id);
    if (!current) return null;
    const run = { ...current, ...patch, id: current.id };
    this.db.prepare('UPDATE runs SET status=?,data=? WHERE id=?').run(run.status, JSON.stringify(run), id);
    return run;
  }
  listRuns(limit = 200): Run[] {
    return (this.db.prepare('SELECT data FROM runs ORDER BY created_at DESC,rowid DESC LIMIT ?').all(limit) as Row[]).map((r) => json<Run>(r.data));
  }
  queuedRuns(): Run[] {
    return (this.db.prepare("SELECT data FROM runs WHERE status='queued' ORDER BY created_at,rowid").all() as Row[]).map((r) => json<Run>(r.data));
  }
  appendEvent(runId: string, stream: RunEvent['stream'], text: string): RunEvent {
    const timestamp = new Date().toISOString();
    const result = this.db.prepare('INSERT INTO run_events(run_id,timestamp,stream,text) VALUES (?,?,?,?)').run(runId, timestamp, stream, text);
    return { id: Number(result.lastInsertRowid), runId, timestamp, stream, text };
  }
  getEvents(runId: string, after = 0, limit = 5000): RunEvent[] {
    return this.db.prepare('SELECT id,run_id AS runId,timestamp,stream,text FROM run_events WHERE run_id=? AND id>? ORDER BY id LIMIT ?')
      .all(runId, after, limit) as RunEvent[];
  }
  recoverRuns(): number {
    const interrupted = this.listRuns(100000).filter((r) => r.status === 'running' || r.status === 'queued');
    this.db.transaction(() => {
      for (const run of interrupted) {
        this.updateRun(run.id, { status: 'interrupted', finishedAt: new Date().toISOString(), error: 'Server restarted. Run was not automatically resumed.' });
        this.appendEvent(run.id, 'system', 'Previous application process ended. Review the workspace before retrying.');
      }
    })();
    return interrupted.length;
  }
}

export const newId = (prefix: string) => `${prefix}-${randomUUID()}`;
