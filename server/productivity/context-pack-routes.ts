import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CONTEXT_PACK_LIMITS as limits } from '../../shared/context-packs.js';
import type { ContextPackService } from './context-packs.js';
import type { ProductivityRouteHooks } from './common.js';
import {
  parse, packIdSchema, querySchema, createSchema, updateSchema, versionSchema, itemSchema,
  itemUpdateSchema, reorderSchema, exportFormatSchema,
} from './context-packs/validation.js';

const base = '/api/productivity/context-packs';
const paramsSchema = z.object({ id: packIdSchema }).strict();
const itemParamsSchema = paramsSchema.extend({ itemId: packIdSchema }).strict();
const empty = z.object({}).strict();
const listQuery = querySchema.extend({
  offset: z.coerce.number().int().min(0).max(limits.packs).default(0),
  limit: z.coerce.number().int().min(1).max(limits.maxPageSize).default(limits.defaultPageSize),
}).strict();
const exportQuery = z.object({ format: exportFormatSchema.default('md') }).strict();

/** Register under the root application's existing access and error handlers. */
export function registerContextPackRoutes(
  app: FastifyInstance, service: ContextPackService, hooks: ProductivityRouteHooks,
): void {
  async function mutate<T>(action: () => T): Promise<T> {
    const result = await hooks.write(action);
    hooks.onChange();
    return result;
  }
  app.get(base, async request => service.list(parse(listQuery, request.query)));
  app.post(base, async (request, reply) => {
    parse(empty, request.query);
    const input = parse(createSchema, request.body);
    const result = await mutate(() => service.create(input));
    return reply.code(201).send(result);
  });
  app.get(`${base}/:id`, async request => {
    parse(empty, request.query);
    return service.get(parse(paramsSchema, request.params).id);
  });
  app.patch(`${base}/:id`, async request => {
    parse(empty, request.query);
    const { id } = parse(paramsSchema, request.params);
    const input = parse(updateSchema, request.body);
    return mutate(() => service.update(id, input));
  });
  app.delete(`${base}/:id`, async request => {
    parse(empty, request.query);
    const { id } = parse(paramsSchema, request.params);
    const input = parse(versionSchema, request.body);
    await mutate(() => service.remove(id, input));
    return { ok: true };
  });
  app.post(`${base}/:id/items`, async request => {
    parse(empty, request.query);
    const { id } = parse(paramsSchema, request.params);
    const input = parse(itemSchema, request.body);
    return mutate(() => service.addItem(id, input));
  });
  app.patch(`${base}/:id/items/:itemId`, async request => {
    parse(empty, request.query);
    const { id, itemId } = parse(itemParamsSchema, request.params);
    const input = parse(itemUpdateSchema, request.body);
    return mutate(() => service.updateItem(id, itemId, input));
  });
  app.delete(`${base}/:id/items/:itemId`, async request => {
    parse(empty, request.query);
    const { id, itemId } = parse(itemParamsSchema, request.params);
    const input = parse(versionSchema, request.body);
    return mutate(() => service.removeItem(id, itemId, input));
  });
  app.post(`${base}/:id/reorder`, async request => {
    parse(empty, request.query);
    const { id } = parse(paramsSchema, request.params);
    const input = parse(reorderSchema, request.body);
    return mutate(() => service.reorder(id, input));
  });
  app.post(`${base}/:id/compile`, async request => {
    parse(empty, request.query);
    parse(empty, request.body ?? {});
    return service.compile(parse(paramsSchema, request.params).id);
  });
  app.get(`${base}/:id/export`, async (request, reply) => {
    const { id } = parse(paramsSchema, request.params);
    const { format } = parse(exportQuery, request.query);
    const result = service.export(id, format);
    return reply.type(result.type).header('Content-Disposition', `attachment; filename="${result.filename}"`).send(result.body);
  });
}
