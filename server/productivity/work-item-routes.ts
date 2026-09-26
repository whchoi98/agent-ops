import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WorkItemService } from './work-items.js';
import type { ProductivityRouteHooks } from './common.js';

const params = (value: unknown) => z.object({ id: z.string().min(1).max(200) }).strict().parse(value).id;
const empty = (value: unknown) => z.object({}).strict().parse(value);

export function registerWorkItemRoutes(app: FastifyInstance, service: WorkItemService, hooks: ProductivityRouteHooks) {
  const base = '/api/productivity/work-items';
  app.get(base, async request => service.list(request.query));
  app.get(`${base}/:id`, async request => {
    empty(request.query);
    return service.detail(params(request.params));
  });
  app.post(base, async (request, reply) => {
    empty(request.query);
    const item = await hooks.write(() => service.create(request.body));
    hooks.onChange();
    return reply.code(201).send(item);
  });
  app.patch(`${base}/:id`, async request => {
    empty(request.query);
    const item = await hooks.write(() => service.update(params(request.params), request.body));
    hooks.onChange();
    return item;
  });
  app.delete(`${base}/:id`, async request => {
    empty(request.query);
    const { version } = z.object({ version: z.number().int().positive().safe() }).strict().parse(request.body);
    await hooks.write(() => service.remove(params(request.params), version));
    hooks.onChange();
    return { ok: true };
  });
  app.post(`${base}/:id/prepare`, async request => {
    empty(request.query);
    return service.prepare(params(request.params), request.body);
  });
}
