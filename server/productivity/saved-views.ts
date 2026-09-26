import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import {
  isSavedViewDate, savedViewRangeError, SAVED_VIEW_LIMIT, SAVED_VIEW_NAME_LIMIT, SAVED_VIEW_PERIODS,
  type SavedView, type SavedViewQuery,
} from '../../shared/saved-views.js';
import { AGENTS } from '../../shared/types.js';
import { newId, type Store } from '../store.js';
import { problem, type ProductivityRouteHooks } from './common.js';

const identifier = z.string().regex(/^saved-view-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const versionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const text = (max: number) => z.string().max(max).refine(value => !value.includes('\0'), 'Invalid text');
const date = z.string().max(40).refine(isSavedViewDate, 'Invalid date');
const querySchema = z.object({
  q: text(500).optional(),
  agent: z.enum(AGENTS).optional(),
  project: text(4096).optional(),
  status: z.enum(['completed', 'failed', 'recorded']).optional(),
  bookmarked: z.boolean().optional(),
  tag: text(60).optional(),
  since: date.optional(),
  until: date.optional(),
  sort: z.enum(['recent', 'oldest', 'tokens', 'credits']).optional(),
  limit: z.number().int().min(1).max(200).optional(),
}).strict();
const fields = z.object({
  name: z.string().max(SAVED_VIEW_NAME_LIMIT).regex(/^[^\u0000-\u001f\u007f]*$/, 'Invalid name').trim().min(1),
  query: querySchema,
  period: z.enum(SAVED_VIEW_PERIODS),
  pinned: z.boolean(),
}).strict();
const createSchema = fields.extend({
  period: fields.shape.period.default('all-time'), pinned: fields.shape.pinned.default(false),
}).superRefine((input, context) => {
  const invalid = savedViewRangeError(input.query, input.period, true);
  if (invalid) context.addIssue({ code: 'custom', path: ['query'], message: invalid });
});
const updateSchema = fields.partial().extend({ version: versionSchema }).strict()
  .refine(patch => Object.entries(patch).some(([key, value]) => key !== 'version' && value !== undefined), 'No changes supplied');

interface SavedViewRow {
  id: string; name: string; query: string; period: SavedView['period']; pinned: number;
  version: number; created_at: string; updated_at: string;
}

function fromRow(row: SavedViewRow): SavedView {
  return {
    id: row.id, name: row.name, query: JSON.parse(row.query) as SavedViewQuery,
    period: row.period, pinned: Boolean(row.pinned), version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

/** Owns only filter metadata on the existing Store connection, never the archive or its lifecycle. */
export class SavedViewService {
  constructor(private readonly store: Store) {
    store.db.transaction(() => store.db.exec(`
      CREATE TABLE IF NOT EXISTS productivity_saved_views (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
        query TEXT NOT NULL,
        period TEXT NOT NULL CHECK(period IN ('all-time','today','last7','last30','custom')),
        pinned INTEGER NOT NULL CHECK(pinned IN (0,1)),
        version INTEGER NOT NULL CHECK(version BETWEEN 1 AND 9007199254740991),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS productivity_saved_views_order
        ON productivity_saved_views(pinned DESC, updated_at DESC, id);
    `))();
  }

  list(): SavedView[] {
    return (this.store.db.prepare(`
      SELECT * FROM productivity_saved_views ORDER BY pinned DESC, updated_at DESC, id LIMIT ?
    `).all(SAVED_VIEW_LIMIT) as SavedViewRow[]).map(fromRow);
  }

  get(id: string): SavedView {
    identifier.parse(id);
    const row = this.store.db.prepare('SELECT * FROM productivity_saved_views WHERE id=?').get(id) as SavedViewRow | undefined;
    if (!row) throw problem(404, '저장 검색을 찾을 수 없습니다.');
    return fromRow(row);
  }

  create(input: unknown): SavedView {
    const fields = createSchema.parse(input);
    return this.store.db.transaction(() => {
      const { count } = this.store.db.prepare('SELECT COUNT(*) AS count FROM productivity_saved_views').get() as { count: number };
      if (count >= SAVED_VIEW_LIMIT) throw problem(400, '저장 검색은 최대 50개까지 만들 수 있습니다.');
      const timestamp = new Date().toISOString();
      const id = newId('saved-view');
      this.store.db.prepare(`
        INSERT INTO productivity_saved_views(id,name,query,period,pinned,version,created_at,updated_at)
        VALUES (?,?,?,?,?,1,?,?)
      `).run(id, fields.name, JSON.stringify(fields.query), fields.period, Number(fields.pinned), timestamp, timestamp);
      return this.get(id);
    }).immediate();
  }

  update(id: string, input: unknown): SavedView {
    identifier.parse(id);
    const patch = updateSchema.parse(input);
    return this.store.db.transaction(() => {
      const current = this.get(id);
      if (current.version !== patch.version || current.version >= Number.MAX_SAFE_INTEGER) {
        throw problem(409, '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.');
      }
      const fields = createSchema.parse({
        name: patch.name ?? current.name, query: patch.query ?? current.query,
        period: patch.period ?? current.period, pinned: patch.pinned ?? current.pinned,
      });
      this.store.db.prepare(`
        UPDATE productivity_saved_views SET name=?,query=?,period=?,pinned=?,version=version+1,updated_at=?
        WHERE id=? AND version=?
      `).run(fields.name, JSON.stringify(fields.query), fields.period, Number(fields.pinned), new Date().toISOString(), id, patch.version);
      return this.get(id);
    }).immediate();
  }

  remove(id: string, version: number): void {
    identifier.parse(id);
    versionSchema.parse(version);
    this.store.db.transaction(() => {
      if (this.get(id).version !== version) throw problem(409, '저장 검색이 변경되었습니다. 새로고침 후 다시 시도하세요.');
      this.store.db.prepare('DELETE FROM productivity_saved_views WHERE id=? AND version=?').run(id, version);
    }).immediate();
  }
}

export function registerSavedViewRoutes(
  app: FastifyInstance, service: SavedViewService, hooks: ProductivityRouteHooks,
): void {
  const base = '/api/productivity/saved-views';
  const emptyQuery = z.object({}).strict();
  const params = z.object({ id: identifier }).strict();
  const removal = z.object({ version: versionSchema }).strict();
  app.get(base, async request => {
    emptyQuery.parse(request.query);
    return { items: service.list() };
  });
  app.post(base, { bodyLimit: 32 * 1024 }, async (request, reply) => {
    emptyQuery.parse(request.query);
    const body = createSchema.parse(request.body);
    const view = await hooks.write(() => service.create(body));
    hooks.onChange();
    return reply.code(201).send(view);
  });
  app.patch(`${base}/:id`, { bodyLimit: 32 * 1024 }, async request => {
    emptyQuery.parse(request.query);
    const { id } = params.parse(request.params);
    const body = updateSchema.parse(request.body);
    const view = await hooks.write(() => service.update(id, body));
    hooks.onChange();
    return view;
  });
  app.delete(`${base}/:id`, { bodyLimit: 256 }, async request => {
    emptyQuery.parse(request.query);
    const { id } = params.parse(request.params);
    const { version } = removal.parse(request.body);
    await hooks.write(() => service.remove(id, version));
    hooks.onChange();
    return { ok: true };
  });
}
