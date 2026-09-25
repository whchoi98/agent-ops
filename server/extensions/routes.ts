import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AGENTS } from '../../shared/types.js';
import type { ExtensionService } from './service.js';

const projectId = z.string().trim().min(1).max(200).optional();
const selection = z.object({ projectId }).strict();
const query = selection.extend({
  agent: z.enum(AGENTS).optional(),
  kind: z.enum(['skill', 'plugin', 'power']).optional(),
  status: z.enum(['enabled', 'disabled', 'available', 'unknown', 'cached']).optional(),
  scope: z.enum(['user', 'project', 'system']).optional(),
  q: z.string().max(500).optional(),
  offset: z.coerce.number().int().min(0).max(100000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
}).strict();
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const itemParams = z.object({ id: identifier });

export function registerExtensionRoutes(app: FastifyInstance, service: ExtensionService) {
  app.get('/api/extensions', async request => service.list(query.parse(request.query)));
  app.post('/api/extensions/refresh', async request => service.refresh(selection.parse(request.body ?? {}).projectId));
  app.get('/api/extensions/:id', async request => service.detail(itemParams.parse(request.params).id, selection.parse(request.query).projectId));
  app.get('/api/extensions/:id/files/:fileId', async request => {
    const params = itemParams.extend({ fileId: identifier }).parse(request.params);
    return service.file(params.id, params.fileId, selection.parse(request.query).projectId);
  });
  app.post('/api/extensions/:id/analyze', async request =>
    service.prepareAnalysis(itemParams.parse(request.params).id, selection.parse(request.body ?? {}).projectId));
}
