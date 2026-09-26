import { randomUUID } from 'node:crypto';
import type { Store } from '../store.js';
import {
  CONTEXT_PACK_LIMITS as limits, type ContextPack, type ContextPackSummary, type ContextPackItem,
  type ContextPackSource, type ContextPackQuery, type ContextPackPage, type CreateContextPackInput,
  type UpdateContextPackInput, type ContextPackVersion, type ContextPackItemInput,
  type UpdateContextPackItemInput, type ReorderContextPackInput, type ContextPackCompilation,
  type ContextPackExportFormat, type ContextPackExport, type ContextPackExportDocument,
} from '../../shared/context-packs.js';
import { problem } from './common.js';
import {
  parse, packIdSchema, createSchema, updateSchema, versionSchema, itemSchema, itemUpdateSchema,
  reorderSchema, querySchema, exportFormatSchema,
} from './context-packs/validation.js';
import { captureMessage } from './context-packs/source.js';
import { cleanPack, compilePack } from './context-packs/compile.js';

const summaryColumns = `id,name,description,project_id AS projectId,item_count AS itemCount,
  total_chars AS totalChars,version,created_at AS createdAt,updated_at AS updatedAt`;
type PackRow = ContextPackSummary & { instructions: string };
interface ItemRow {
  id: string; kind: 'message' | 'note'; title: string; text: string; source: string | null; createdAt: string;
}

/** Owns only extension tables on Store.db. All methods are synchronous and local. */
export class ContextPackService {
  constructor(private readonly store: Store) {
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS productivity_context_packs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL,
        project_id TEXT, instructions TEXT NOT NULL, item_count INTEGER NOT NULL DEFAULT 0,
        total_chars INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS productivity_context_packs_recent
        ON productivity_context_packs(updated_at DESC,id);
      CREATE INDEX IF NOT EXISTS productivity_context_packs_project
        ON productivity_context_packs(project_id,updated_at DESC,id);
      CREATE TABLE IF NOT EXISTS productivity_context_pack_items (
        id TEXT PRIMARY KEY, pack_id TEXT NOT NULL REFERENCES productivity_context_packs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL,
        source TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS productivity_context_pack_items_order
        ON productivity_context_pack_items(pack_id,ordinal,id);
    `);
  }

  private row(id: string): PackRow {
    parse(packIdSchema, id);
    const row = this.store.db.prepare(`SELECT ${summaryColumns},instructions FROM productivity_context_packs WHERE id=?`)
      .get(id) as PackRow | undefined;
    if (!row) throw problem(404, 'Context pack not found.');
    return row;
  }
  private current(id: string, version: number): PackRow {
    const row = this.row(id);
    if (row.version !== version || row.version >= Number.MAX_SAFE_INTEGER) {
      throw problem(409, 'This context pack changed. Reload it before editing.');
    }
    return row;
  }
  private checkProject(id: string | null | undefined) {
    if (id && !this.store.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id)) {
      throw problem(400, 'The selected project is unavailable.');
    }
  }
  private itemRows(id: string): ItemRow[] {
    return this.store.db.prepare(`SELECT id,kind,title,text,source,created_at AS createdAt
      FROM productivity_context_pack_items WHERE pack_id=? ORDER BY ordinal,id`).all(id) as ItemRow[];
  }
  private item(packId: string, itemId: string): ItemRow {
    parse(packIdSchema, itemId);
    const item = this.store.db.prepare(`SELECT id,kind,title,text,source,created_at AS createdAt
      FROM productivity_context_pack_items WHERE pack_id=? AND id=?`).get(packId, itemId) as ItemRow | undefined;
    if (!item) throw problem(404, 'Context pack item not found.');
    return item;
  }
  private touch(row: PackRow, itemCount = row.itemCount, totalChars = row.totalChars) {
    if (totalChars > limits.totalChars) throw problem(413, 'Context pack item text exceeds 48,000 characters.');
    const result = this.store.db.prepare(`UPDATE productivity_context_packs SET item_count=?,total_chars=?,
      version=version+1,updated_at=? WHERE id=? AND version=?`)
      .run(itemCount, totalChars, new Date().toISOString(), row.id, row.version);
    if (result.changes !== 1) throw problem(409, 'This context pack changed. Reload it before editing.');
  }

  create(input: CreateContextPackInput): ContextPack {
    const fields = parse(createSchema, input);
    return this.store.db.transaction(() => {
      this.checkProject(fields.projectId);
      const count = this.store.db.prepare('SELECT COUNT(*) AS total FROM productivity_context_packs').get() as { total: number };
      if (count.total >= limits.packs) throw problem(413, 'At most 200 context packs can be stored. Remove a pack first.');
      const id = `pack-${randomUUID()}`;
      const now = new Date().toISOString();
      this.store.db.prepare(`INSERT INTO productivity_context_packs
        (id,name,description,project_id,instructions,version,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?)`)
        .run(id, fields.name, fields.description, fields.projectId, fields.instructions, now, now);
      return this.get(id);
    }).immediate();
  }

  /** Cheap callback for work-item references; never hydrates excerpts. */
  info(id: string): Pick<ContextPackSummary, 'name'> | null {
    parse(packIdSchema, id);
    return this.store.db.prepare('SELECT name FROM productivity_context_packs WHERE id=?')
      .get(id) as Pick<ContextPackSummary, 'name'> | undefined ?? null;
  }

  get(id: string): ContextPack {
    // One read transaction keeps pack version, order and availability consistent.
    return this.store.db.transaction(() => {
      const row = this.row(id);
      const items = this.itemRows(id).map((item): ContextPackItem => {
        if (item.kind === 'note') return { ...item, kind: 'note', source: null, sourceAvailable: null };
        const source = JSON.parse(item.source!) as ContextPackSource;
        const available = this.store.db.prepare(`SELECT 1 FROM messages
          WHERE session_id=? AND json_extract(data,'$.id')=? LIMIT 1`).get(source.sessionId, source.messageId);
        return { ...item, kind: 'message', source, sourceAvailable: Boolean(available) };
      });
      return { ...row, items };
    })();
  }

  list(query: ContextPackQuery = {}): ContextPackPage {
    const fields = parse(querySchema, query);
    return this.store.db.transaction(() => {
      const conditions: string[] = [];
      const values: Array<string | number> = [];
      if (fields.projectId) { conditions.push('project_id=?'); values.push(fields.projectId); }
      if (fields.q) {
        conditions.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
        const literal = `%${fields.q.replace(/[\\%_]/g, '\\$&')}%`;
        values.push(literal, literal);
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const total = (this.store.db.prepare(`SELECT COUNT(*) AS total FROM productivity_context_packs ${where}`)
        .get(...values) as { total: number }).total;
      const items = this.store.db.prepare(`SELECT ${summaryColumns} FROM productivity_context_packs ${where}
        ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`).all(...values, fields.limit, fields.offset) as ContextPackSummary[];
      return { items, total, offset: fields.offset, limit: fields.limit };
    })();
  }

  update(id: string, input: UpdateContextPackInput): ContextPack {
    const patch = parse(updateSchema, input);
    return this.store.db.transaction(() => {
      const row = this.current(id, patch.version);
      this.checkProject(patch.projectId);
      this.store.db.prepare(`UPDATE productivity_context_packs SET name=?,description=?,project_id=?,instructions=? WHERE id=?`)
        .run(patch.name ?? row.name, patch.description ?? row.description,
          patch.projectId === undefined ? row.projectId : patch.projectId, patch.instructions ?? row.instructions, id);
      this.touch(row);
      return this.get(id);
    }).immediate();
  }

  remove(id: string, input: ContextPackVersion): void {
    const { version } = parse(versionSchema, input);
    this.store.db.transaction(() => {
      this.current(id, version);
      this.store.db.prepare('DELETE FROM productivity_context_packs WHERE id=? AND version=?').run(id, version);
    }).immediate();
  }

  addItem(id: string, input: ContextPackItemInput): ContextPack {
    const fields = parse(itemSchema, input);
    return this.store.db.transaction(() => {
      const row = this.current(id, fields.version);
      if (row.itemCount >= limits.items) throw problem(413, 'A context pack can contain at most 20 items.');
      const itemId = `pack-item-${randomUUID()}`;
      const now = new Date().toISOString();
      const item: ContextPackItem = fields.kind === 'message' ? captureMessage(this.store, fields, itemId, now) : {
        id: itemId, kind: 'note', title: fields.title, text: fields.text, source: null, sourceAvailable: null, createdAt: now,
      };
      const ordinal = (this.store.db.prepare(`SELECT COALESCE(MAX(ordinal),-1)+1 AS next
        FROM productivity_context_pack_items WHERE pack_id=?`).get(id) as { next: number }).next;
      this.touch(row, row.itemCount + 1, row.totalChars + item.text.length);
      this.store.db.prepare(`INSERT INTO productivity_context_pack_items
        (id,pack_id,ordinal,kind,title,text,source,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(item.id, id, ordinal, item.kind, item.title, item.text, item.source ? JSON.stringify(item.source) : null, now);
      return this.get(id);
    }).immediate();
  }

  updateItem(id: string, itemId: string, input: UpdateContextPackItemInput): ContextPack {
    const patch = parse(itemUpdateSchema, input);
    return this.store.db.transaction(() => {
      const row = this.current(id, patch.version);
      const item = this.item(id, itemId);
      if (item.kind === 'message' && patch.text !== undefined) {
        throw problem(400, 'Captured message text is read-only. Add an operator note instead.');
      }
      const text = patch.text ?? item.text;
      this.touch(row, row.itemCount, row.totalChars - item.text.length + text.length);
      this.store.db.prepare('UPDATE productivity_context_pack_items SET title=?,text=? WHERE pack_id=? AND id=?')
        .run(patch.title ?? item.title, text, id, itemId);
      return this.get(id);
    }).immediate();
  }

  removeItem(id: string, itemId: string, input: ContextPackVersion): ContextPack {
    const { version } = parse(versionSchema, input);
    return this.store.db.transaction(() => {
      const row = this.current(id, version);
      const item = this.item(id, itemId);
      this.store.db.prepare('DELETE FROM productivity_context_pack_items WHERE pack_id=? AND id=?').run(id, itemId);
      this.touch(row, row.itemCount - 1, row.totalChars - item.text.length);
      return this.get(id);
    }).immediate();
  }

  reorder(id: string, input: ReorderContextPackInput): ContextPack {
    const { version, itemIds } = parse(reorderSchema, input);
    return this.store.db.transaction(() => {
      const row = this.current(id, version);
      const items = this.itemRows(id);
      if (itemIds.length !== items.length || new Set(itemIds).size !== items.length
        || items.some(item => !itemIds.includes(item.id))) {
        throw problem(400, 'The new order must contain every current item exactly once.');
      }
      const reorder = this.store.db.prepare('UPDATE productivity_context_pack_items SET ordinal=? WHERE pack_id=? AND id=?');
      itemIds.forEach((itemId, index) => reorder.run(index, id, itemId));
      this.touch(row);
      return this.get(id);
    }).immediate();
  }

  compile(id: string): ContextPackCompilation {
    return compilePack(this.get(id));
  }

  export(id: string, format: ContextPackExportFormat = 'md'): ContextPackExport {
    parse(exportFormatSchema, format);
    const original = this.get(id);
    const pack = cleanPack(original);
    const compiled = compilePack(original, pack);
    const document: ContextPackExportDocument = { formatVersion: 1, pack };
    return {
      type: format === 'json' ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8',
      extension: format, filename: `agent-ops-${pack.id}.${format}`,
      body: format === 'json' ? JSON.stringify(document, null, 2) : compiled.prompt,
    };
  }
}
