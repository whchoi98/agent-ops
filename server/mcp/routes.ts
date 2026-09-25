import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AGENTS } from '../../shared/types.js';
import type { McpService } from './service.js';
import { fail } from './types.js';

const selection = z.object({ projectId: z.string().trim().min(1).max(200).optional() }).strict();
const empty = z.object({}).strict();
const query = selection.extend({
  agent: z.enum(AGENTS).optional(),
  scope: z.enum(['user', 'project', 'local']).optional(),
  status: z.enum(['enabled', 'disabled', 'unknown', 'shadowed']).optional(),
  transport: z.enum(['stdio', 'http', 'sse', 'unsupported']).optional(),
  q: z.string().max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const id = z.object({ id: z.string().regex(/^mcp-[a-f0-9]{24}$/) }).strict();
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const checkId = z.object({ checkId: z.string().regex(new RegExp(`^mcp-check-${uuid}$`)) }).strict();
const check = selection.extend({ previewId: z.string().regex(new RegExp(`^mcp-preview-${uuid}$`)) }).strict();
const mutation = async (request: FastifyRequest) => {
  if (request.headers['x-agent-ops'] !== '1') fail(403, 'X-Agent-Ops: 1 header required.');
};
const mutationOptions = { onRequest: mutation, bodyLimit: 4096 };

/** The embedding app retains its existing Host/Origin/local-peer/proxy checks and error handler. */
export function registerMcpRoutes(app: FastifyInstance, service: McpService) {
  app.get('/api/mcp', async request => service.list(query.parse(request.query)));
  app.post('/api/mcp/refresh', mutationOptions, async request => {
    empty.parse(request.query);
    return service.refresh(selection.parse(request.body ?? {}).projectId);
  });
  app.get('/api/mcp/:id', async request =>
    service.detail(id.parse(request.params).id, selection.parse(request.query).projectId));
  app.post('/api/mcp/:id/preview', mutationOptions, async request => {
    empty.parse(request.query);
    return service.preview(id.parse(request.params).id, selection.parse(request.body ?? {}).projectId);
  });
  app.post('/api/mcp/:id/check', mutationOptions, async (request, reply) => {
    empty.parse(request.query);
    const body = check.parse(request.body);
    const result = await service.check(id.parse(request.params).id, body.previewId, body.projectId);
    return reply.code(202).send(result);
  });
  app.get('/api/mcp/checks/:checkId', async request => {
    empty.parse(request.query);
    return service.getCheck(checkId.parse(request.params).checkId);
  });
  app.post('/api/mcp/checks/:checkId/cancel', mutationOptions, async request => {
    empty.parse(request.query);
    empty.parse(request.body ?? {});
    return service.cancel(checkId.parse(request.params).checkId);
  });
  app.addHook('onClose', async () => service.close());
}
