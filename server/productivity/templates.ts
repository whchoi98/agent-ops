import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { AGENTS, type PromptTemplate } from '../../shared/types.js';
import {
  renderTemplate, TEMPLATE_FIELD_LIMITS, validateTemplateVariables,
  type TemplateContent, type TemplateInput, type TemplateRevision,
} from '../../shared/template-fields.js';
import { newId, type Store } from '../store.js';
import { problem, type ProductivityRouteHooks } from './common.js';

const revisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const templateSchema = z.object({
  name: z.string().min(1).max(200).refine(value => !!value.trim()),
  description: z.string().max(500),
  category: z.enum(['review', 'build', 'debug', 'docs', 'custom']),
  prompt: z.string().min(1).max(TEMPLATE_FIELD_LIMITS.sourcePrompt).refine(value => !!value.trim()),
  agent: z.enum([...AGENTS, 'any']),
  policy: z.enum(['read-only', 'workspace-write']),
  variables: z.unknown().optional(),
}).strict();
const patchSchema = templateSchema.partial().extend({ expectedRevision: revisionSchema.optional() });
const restoreSchema = z.object({ revision: revisionSchema, expectedRevision: revisionSchema }).strict();
const renderSchema = z.object({ values: z.unknown().refine(value => value !== undefined) }).strict();
type StoredTemplate = PromptTemplate & TemplateContent & { revision?: number };

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw problem(400, '템플릿 입력 형식을 확인하세요.');
  return result.data;
}

function templateId(id: string): string {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) {
    throw problem(400, '템플릿 ID가 올바르지 않습니다.');
  }
  return id;
}

function fields(input: unknown): TemplateInput {
  const { variables: definitions, ...inputFields } = parse(templateSchema, input);
  const variables = validateTemplateVariables(inputFields.prompt, definitions);
  return { ...inputFields, ...(variables !== undefined ? { variables } : {}) };
}

function editable(template: StoredTemplate): TemplateInput {
  return {
    name: template.name, description: template.description, category: template.category,
    agent: template.agent, policy: template.policy, prompt: template.prompt,
    ...(template.variables !== undefined ? { variables: template.variables } : {}),
  };
}

function snapshot(template: StoredTemplate): TemplateRevision {
  return { ...template, revision: template.revision ?? 1 };
}

function checkRevision(current: StoredTemplate, expectedRevision: number | undefined) {
  if (expectedRevision !== undefined && (current.revision ?? 1) !== expectedRevision) {
    throw problem(409, '템플릿이 변경되었습니다. 최신 내용을 다시 불러온 뒤 시도하세요.');
  }
}

export class TemplateService {
  constructor(private readonly store: Store) {
    // Only feature metadata is initialized here. Legacy templates are captured
    // lazily on their first edit, without a startup rewrite or corpus scan.
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS productivity_template_revisions (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        data TEXT NOT NULL,
        UNIQUE(template_id, revision)
      );
    `);
  }

  create(input: unknown): TemplateRevision {
    const validated = fields(input);
    return this.store.db.transaction(() => {
      const template: TemplateRevision = {
        ...validated, id: newId('template'), revision: 1, updatedAt: new Date().toISOString(),
      };
      this.store.saveTemplate(template);
      this.record(template);
      this.prune(template.id);
      return template;
    }).immediate();
  }

  update(id: string, input: unknown): TemplateRevision {
    templateId(id);
    const { expectedRevision, ...patch } = parse(patchSchema, input);
    return this.store.db.transaction(() => {
      const current = this.get(id);
      checkRevision(current, expectedRevision);
      return this.replace(current, fields({ ...editable(current), ...patch }));
    }).immediate();
  }

  remove(id: string): boolean {
    templateId(id);
    // The feature's foreign key deletes history in the same transaction.
    return this.store.db.transaction(() => this.store.deleteTemplate(id)).immediate();
  }

  history(id: string): TemplateRevision[] {
    const current = this.get(id);
    const rows = this.store.db.prepare(`
      SELECT data FROM productivity_template_revisions
      WHERE template_id=? ORDER BY revision DESC LIMIT ?
    `).all(id, TEMPLATE_FIELD_LIMITS.historyPerTemplate) as Array<{ data: string }>;
    if (!rows.length && current.revision === undefined) return [snapshot(current)];
    return rows.map(row => JSON.parse(row.data) as TemplateRevision);
  }

  restore(id: string, revision: number, expectedRevision: number): TemplateRevision {
    templateId(id);
    parse(revisionSchema, revision);
    parse(revisionSchema, expectedRevision);
    return this.store.db.transaction(() => {
      const current = this.get(id);
      checkRevision(current, expectedRevision);
      const row = this.store.db.prepare(`
        SELECT data FROM productivity_template_revisions WHERE template_id=? AND revision=?
      `).get(id, revision) as { data: string } | undefined;
      const previous = row ? JSON.parse(row.data) as StoredTemplate
        : current.revision === undefined && revision === 1 ? current : null;
      if (!previous) throw problem(404, '보관된 템플릿 개정을 찾을 수 없습니다.');
      return this.replace(current, fields(editable(previous)));
    }).immediate();
  }

  render(id: string, values: unknown): string {
    return renderTemplate(this.get(id), values);
  }

  private get(id: string): StoredTemplate {
    const row = this.store.db.prepare('SELECT data FROM templates WHERE id=?').get(templateId(id)) as { data: string } | undefined;
    if (!row) throw problem(404, '템플릿을 찾을 수 없습니다.');
    const template = JSON.parse(row.data) as StoredTemplate;
    if (template.revision !== undefined) parse(revisionSchema, template.revision);
    return template;
  }

  private replace(current: StoredTemplate, input: TemplateInput): TemplateRevision {
    const revision = current.revision ?? 1;
    if (revision >= Number.MAX_SAFE_INTEGER) throw problem(409, '템플릿 개정 번호 한도에 도달했습니다.');
    const next: TemplateRevision = {
      ...input, id: current.id, revision: revision + 1, updatedAt: new Date().toISOString(),
    };
    this.record(snapshot(current));
    this.store.saveTemplate(next);
    this.record(next);
    this.prune(current.id);
    return next;
  }

  private record(template: TemplateRevision) {
    this.store.db.prepare(`
      INSERT OR IGNORE INTO productivity_template_revisions(template_id,revision,data) VALUES (?,?,?)
    `).run(template.id, template.revision, JSON.stringify(template));
  }

  private prune(id: string) {
    this.store.db.prepare(`
      DELETE FROM productivity_template_revisions WHERE sequence IN (
        SELECT sequence FROM productivity_template_revisions WHERE template_id=?
        ORDER BY revision DESC LIMIT -1 OFFSET ?
      )
    `).run(id, TEMPLATE_FIELD_LIMITS.historyPerTemplate);
    this.store.db.prepare(`
      DELETE FROM productivity_template_revisions WHERE sequence IN (
        SELECT sequence FROM productivity_template_revisions ORDER BY sequence DESC LIMIT -1 OFFSET ?
      )
    `).run(TEMPLATE_FIELD_LIMITS.historyTotal);
  }
}

export function registerTemplateFieldRoutes(
  app: FastifyInstance, service: TemplateService, hooks: ProductivityRouteHooks,
): void {
  app.get<{ Params: { id: string } }>('/api/templates/:id/history', async request =>
    service.history(request.params.id));
  app.post<{ Params: { id: string } }>('/api/templates/:id/restore', async request => {
    const body = parse(restoreSchema, request.body);
    const restored = await hooks.write(() => service.restore(request.params.id, body.revision, body.expectedRevision));
    hooks.onChange();
    return restored;
  });
  app.post<{ Params: { id: string } }>('/api/templates/:id/render', async request => {
    const body = parse(renderSchema, request.body);
    return { prompt: service.render(request.params.id, body.values) };
  });
}
